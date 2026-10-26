import http from "node:http";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { expand, log } from "./util.mjs";
import { accountNames } from "./accounts.mjs";
import { CONFIG, TOKEN_HASH, createMcpHandler, toNodeHandler, POLL_MS, PORT, TCP, SOCKET, MAX_BODY, state, hooks } from "./runtime.mjs";
import { makeServer } from "./surface.mjs";
import { loadedOrRetry } from "./workers.mjs";

let lastAuthLog = 0;

async function readBody(req, res) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) { res.writeHead(413).end(); req.destroy(); return undefined; }
    chunks.push(c);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString() || "null"); }
  catch { res.writeHead(400).end(); return undefined; }
}

// One server per request: 2026-07-28 traffic is served natively, 2025-era traffic through the SDK's stateless fallback.
const mcpHandler = createMcpHandler(() => makeServer(), { onerror: (e) => log("mcp error", e.message) });
const serveMcp = toNodeHandler(mcpHandler, { onerror: (e) => log("request error", e.message) });
hooks.toolsChanged = () => mcpHandler.notify.toolsChanged();

const handler = (unix) => async (req, res) => {
  if (req.url?.split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
  if (TOKEN_HASH) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
    const ok = m && crypto.timingSafeEqual(crypto.createHash("sha256").update(m[1]).digest(), TOKEN_HASH);
    if (!ok) {
      if (Date.now() - lastAuthLog > 10000) { lastAuthLog = Date.now(); log("rejected request without a valid bearer token"); }
      res.writeHead(401, { "WWW-Authenticate": 'Bearer realm="acctmux"' }).end();
      return;
    }
  }
  const mime = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  // Host is only checked on TCP: a filesystem socket cannot be reached by DNS rebinding.
  const hostOk = unix || /^(\[::1\]|localhost|127\.0\.0\.1):\d+$/.test(req.headers.host || "");
  if (req.headers.origin || !hostOk || (req.method === "POST" && mime !== "application/json")) {
    res.writeHead(403).end();
    return;
  }
  const body = await readBody(req, res);
  if (body === undefined) return;
  try {
    if (!(await loadedOrRetry(res))) return;
    await serveMcp(req, res, body);
  } catch (e) {
    log("request error", e.message);
    if (!res.headersSent) res.writeHead(500).end();
  }
};

function listen(server, ...args) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, () => { server.off("error", reject); resolve(); });
  });
}

async function claimSocket(file) {
  if (fs.existsSync(file)) {
    if (!fs.lstatSync(file).isSocket()) throw new Error(`${file} exists and is not a socket`);
    const alive = await new Promise((resolve) => {
      const c = net.connect(file);
      c.once("connect", () => { c.destroy(); resolve(true); });
      c.once("error", () => resolve(false));
    });
    if (alive) throw new Error(`${file} is in use by another process`);
    fs.unlinkSync(file);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

// `servers` is filled as listeners open, so the caller can close them on a signal that arrives mid-startup.
export async function serve(servers) {
  const signature = () => JSON.stringify([...state.values()].map((s) => accountNames(s.u)));
  let known = signature();
  setInterval(() => {
    const now = signature();
    if (now === known) return;
    known = now;
    log("accounts changed, notifying listening clients");
    hooks.toolsChanged();
  }, POLL_MS).unref();
  const summary = ["mode:", "per-request", "auth:", TOKEN_HASH ? "bearer" : "none", "upstreams:", [...state.keys()].join(",")];

  if (!TOKEN_HASH) log("warning: auth is off, so any local process can call every account on this endpoint; set auth.tokenFile (acctmux init creates one)");

  try {
    if (TCP) {
      const server = http.createServer(handler(false));
      await listen(server, PORT, CONFIG.host);
      servers.push(server);
      log("router listening " + (CONFIG.host.includes(":") ? `[${CONFIG.host}]` : CONFIG.host) + ":" + PORT, ...summary);
    }
    if (SOCKET) {
      const file = path.resolve(expand(SOCKET));
      await claimSocket(file);
      const server = http.createServer(handler(true));
      const old = process.umask(0o177);
      try { await listen(server, file); } finally { process.umask(old); }
      servers.push(server);
      log("router listening unix:" + file, ...summary);
    }
  } catch (e) { log("listen error", e.message); process.exit(1); }

}
