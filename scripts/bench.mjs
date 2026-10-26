#!/usr/bin/env node
// Benchmark harness: acctmux vs stock stdio, mcp-proxy, supergateway and taylorwilsdon's workspace-mcp.
// Read-only MCP calls only. Methodology, prerequisites and results: docs/benchmarks/.
//
//   node scripts/bench.mjs setup --work-dir DIR [--accounts-file FILE]
//   node scripts/bench.mjs run   --work-dir DIR --suite fake|google [--configs a,b] [--sessions 1,2,4,8] [--accounts 1,2]
//                                [--reps 3] [--warm 5] [--base-port 18720] [--accounts-file FILE] --out results.json
//   node scripts/bench.mjs summarize results.json [more.json ...]
//
// DIR is a scratch directory owned by the benchmark (tools, generated configs, converted taylor credentials, logs).
// Nothing secret is written to --out: accounts appear by label, error texts are scrubbed of e-mail addresses.
import { spawn, execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import readline from "node:readline";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expand = (p) => (typeof p === "string" ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);
const PINS = { "mcp-proxy": "6.7.21", supergateway: "4.2.0", "workspace-mcp": "2.1.2", python: "3.12" };
const PROTOCOL = "2025-06-18";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "work-dir": { type: "string" },
    "accounts-file": { type: "string" },
    suite: { type: "string", default: "fake" },
    configs: { type: "string" },
    sessions: { type: "string", default: "1,2,4,8" },
    accounts: { type: "string", default: "1,2" },
    reps: { type: "string", default: "3" },
    warm: { type: "string" },
    "base-port": { type: "string", default: "18720" },
    "taylor-reset": { type: "boolean", default: false },
    "gw-root": { type: "string", default: "~/.local/share/mcp-servers/google-workspace" },
    timeout: { type: "string", default: "90000" },
    out: { type: "string" },
  },
});
const [cmd, ...rest] = positionals;

// ---------- accounts ----------
// accounts file (local, never committed): {"clientSecret": "...credentials.json", "accounts": [{"label","profile","email","source"}]}
function loadAccounts() {
  if (opt.suite === "fake") return [{ label: "default", profile: null }, { label: "ai", profile: "ai" }];
  const f = expand(opt["accounts-file"] || "");
  if (!f || !fs.existsSync(f)) die("--accounts-file is required for the google suite (see scripts/bench/accounts.example.json)");
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  return j.accounts.map((a) => ({ ...a, source: expand(a.source), clientSecret: expand(j.clientSecret) }));
}
let EMAILS = [];
const scrub = (s) => {
  let t = String(s ?? "");
  for (const { email, label } of EMAILS) if (email) t = t.split(email).join(`<${label}>`);
  return t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>").replace(/(https?:\/\/[^\s?"]+)\?[^\s"]*/g, "$1?<redacted>").slice(0, 300);
};
function die(m) { console.error(m); process.exit(2); }
// Which account answered? The primary calendar's id is the account's address, so a calendar listing must name the
// requested account and no other configured one. "mixup" = answered with another account's data.
function identity(acct, result) {
  if (!acct.email || !EMAILS.length) return undefined;
  const text = JSON.stringify(result ?? {});
  const mine = text.includes(acct.email);
  const other = EMAILS.some((e) => e.email !== acct.email && text.includes(e.email));
  return mine && !other ? "match" : other && !mine ? "mixup" : other ? "both" : "none";
}

// ---------- process bookkeeping ----------
const owned = new Set(); // ChildProcess objects we spawned (each is its own process-group leader)

function baseEnv(extra = {}) {
  const keep = /^(PATH|HOME|USER|LANG|LC_.*|TZ|XDG_CONFIG_HOME|XDG_CACHE_HOME|XDG_DATA_HOME|XDG_RUNTIME_DIR|UV_.*)$/;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => keep.test(k)));
  return { ...env, BROWSER: "true", ...extra }; // no DISPLAY/WAYLAND_DISPLAY: nothing may open a login window
}

function launch(command, args, env, logStream, tag) {
  const cp = spawn(command, args, { env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  owned.add(cp);
  cp.spawnedAt = null;
  cp.once("spawn", () => { cp.spawnedAt = now(); });
  cp.once("exit", () => owned.delete(cp));
  cp.on("error", (e) => logStream?.write(`[${tag}] spawn error ${e.message}\n`));
  cp.stderr.on("data", (d) => logStream?.write(`[${tag}] ${d}`));
  return cp;
}

const pgidOf = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ")[2]); } catch { return null; } };

async function killGroup(cp) {
  const pid = cp.pid;
  if (!pid) return;
  const members = () => fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(Number).filter((p) => pgidOf(p) === pid);
  if (!members().length) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* gone */ }
  for (let i = 0; i < 40 && members().length; i++) await sleep(100);
  if (members().length) { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }
  for (let i = 0; i < 20 && members().length; i++) await sleep(100);
}
async function killAll() { await Promise.all([...owned].map(killGroup)); }
process.on("SIGINT", () => killAll().then(() => process.exit(130)));
process.on("SIGTERM", () => killAll().then(() => process.exit(143)));

// ---------- memory ----------
function procTable() {
  const out = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, "utf8");
      const after = st.slice(st.lastIndexOf(") ") + 2).split(" ");
      out.set(Number(d), { ppid: Number(after[1]), comm: st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")) });
    } catch { /* raced */ }
  }
  return out;
}
function rollup(pid) {
  const r = {};
  for (const line of fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").split("\n")) {
    const m = /^(\w+):\s+(\d+) kB/.exec(line);
    if (m) r[m[1]] = Number(m[2]);
  }
  return { rss_kb: r.Rss ?? 0, pss_kb: r.Pss ?? 0, uss_kb: (r.Private_Clean ?? 0) + (r.Private_Dirty ?? 0), swap_pss_kb: r.SwapPss ?? 0 };
}
function label(pid, comm) {
  try {
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
    const script = argv.slice(1).find((a) => /\.(m?js|py)$|\/bin\/|google-workspace-mcp|workspace-mcp|mcp-proxy|supergateway/.test(a));
    const name = script ? path.basename(script) : "";
    return `${path.basename(argv[0] || comm)}${name ? " " + name : ""}`;
  } catch { return comm; }
}
// Tree = every process we spawned plus all descendants (ppid walk over /proc). The harness (client side) is excluded.
function memSnapshot(roles) {
  const table = procTable();
  const kids = new Map();
  for (const [pid, p] of table) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(pid); }
  const procs = [];
  for (const [rootPid, role] of roles) {
    const stack = [[rootPid, role, 0]];
    while (stack.length) {
      const [pid, r, depth] = stack.pop();
      if (!table.has(pid)) continue;
      try { procs.push({ role: r, depth, comm: table.get(pid).comm, cmd: label(pid, table.get(pid).comm), ...rollup(pid) }); } catch { continue; }
      for (const c of kids.get(pid) ?? []) stack.push([c, r, depth + 1]);
    }
  }
  const sum = (k) => procs.reduce((a, p) => a + p[k], 0);
  return { nprocs: procs.length, pss_kb: sum("pss_kb"), uss_kb: sum("uss_kb"), rss_kb: sum("rss_kb"), procs };
}

// ---------- MCP clients (hand-rolled, identical for every implementation) ----------
class StdioEndpoint {
  constructor(command, args, env, log, tag) { this.spec = { command, args, env }; this.log = log; this.tag = tag; this.next = 1; this.pending = new Map(); }
  async open() {
    const t0 = now();
    this.cp = launch(this.spec.command, this.spec.args, this.spec.env, this.log, this.tag);
    readline.createInterface({ input: this.cp.stdout }).on("line", (l) => {
      let m; try { m = JSON.parse(l); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
    this.cp.once("exit", () => { for (const r of this.pending.values()) r({ error: { message: "process exited" } }); this.pending.clear(); });
    await new Promise((r) => { if (this.cp.spawnedAt) r(); else { this.cp.once("spawn", r); this.cp.once("error", r); } });
    this.spawnMs = (this.cp.spawnedAt ?? now()) - t0;
    return t0;
  }
  rpc(method, params, timeout) {
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: { message: "timeout" } }); }, timeout);
      this.pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
      this.cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method) { this.cp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"); }
  async close() { try { this.cp.stdin.end(); } catch { /* closed */ } await Promise.race([new Promise((r) => this.cp.once("exit", r)), sleep(2000)]); await killGroup(this.cp); }
  get pid() { return this.cp?.pid; }
}

class HttpEndpoint {
  constructor(url) { this.url = url; this.sid = null; this.next = 1; this.spawnMs = 0; }
  async open() { return now(); }
  headers() {
    const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL };
    if (this.sid) h["mcp-session-id"] = this.sid;
    return h;
  }
  async rpc(method, params, timeout) {
    const id = this.next++;
    try {
      const res = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeout) });
      this.sid = res.headers.get("mcp-session-id") || this.sid;
      if (!res.ok) { await res.body?.cancel(); return { error: { message: `HTTP ${res.status}` } }; }
      if (!(res.headers.get("content-type") || "").includes("text/event-stream")) return await res.json();
      // SSE: read until the response with our id arrives, then drop the stream.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          let m; try { m = JSON.parse(line.slice(5)); } catch { continue; }
          if (m.id === id) { reader.cancel().catch(() => {}); return m; }
        }
      }
      return { error: { message: "stream ended without response" } };
    } catch (e) { return { error: { message: e.name === "TimeoutError" ? "timeout" : e.message } }; }
  }
  async notify(method) {
    try { const r = await fetch(this.url, { method: "POST", headers: this.headers(), body: JSON.stringify({ jsonrpc: "2.0", method }) }); await r.body?.cancel(); } catch { /* ignore */ }
  }
  async close() {
    if (!this.sid) return;
    try { const r = await fetch(this.url, { method: "DELETE", headers: this.headers(), signal: AbortSignal.timeout(5000) }); await r.body?.cancel(); } catch { /* ignore */ }
  }
}

// ---------- configurations ----------
const gwBin = () => path.join(expand(opt["gw-root"]), "node_modules/.bin/google-workspace-mcp");
const toolsBin = (n) => path.join(WORK, "tools/node_modules/.bin", n);
const FAKE = path.join(REPO, "tests/fake-upstream.mjs");
const uvxArgs = (...a) => ["--python", PINS.python, `workspace-mcp@${PINS["workspace-mcp"]}`, ...a];
// "-direct" variants run the cached environment's own entrypoint, without the resident uv wrapper process.
let DIRECT = null;
function taylorCmd(direct, ...a) {
  if (!direct) return { command: "uvx", args: uvxArgs(...a) };
  DIRECT ??= sh("uvx", ["--python", PINS.python, "--from", `workspace-mcp==${PINS["workspace-mcp"]}`, "python", "-c", "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'workspace-mcp'))"]);
  if (!DIRECT || !fs.existsSync(DIRECT)) throw new Error("cannot resolve the workspace-mcp entrypoint");
  return { command: DIRECT, args: a };
}
const TAYLOR_TOOLS = ["--tools", "gmail", "drive", "calendar"];

// upstream = how to start one stdio server for one account (dguido or fake)
function upstreamFor(suite, acct) {
  if (suite === "fake") return { command: process.execPath, args: [FAKE], env: acct.profile ? { FAKE_PROFILE: acct.profile } : {} };
  return { command: gwBin(), args: [], env: { GOOGLE_WORKSPACE_SERVICES: "drive,gmail,calendar", ...(acct.profile ? { GOOGLE_WORKSPACE_MCP_PROFILE: acct.profile } : {}) } };
}

// workload: tool keys -> concrete call for a family
const WORKLOAD = {
  fake: { tools: ["echo"], call: () => ({ name: "echo", arguments: { text: "x" } }) },
  dguido: { tools: ["calendars", "labels"], call: (k) => ({ name: k === "calendars" ? "list_calendars" : "list_labels", arguments: {} }) },
  taylor: { tools: ["calendars", "labels"], call: (k) => ({ name: k === "calendars" ? "list_calendars" : "list_gmail_labels", arguments: {} }) },
};

// Each config returns { family, daemons: [{role, command, args, env, url, port}], session(i) -> [{endpoint, accounts}], args(acct, call) }
const CONFIGS = {
  router: (suite, accts, port) => {
    const file = path.join(WORK, `router-${port}.json`);
    const cfg = suite === "fake"
      ? { port, sdkRoot: REPO, upstreams: [{ name: "fake", command: process.execPath, args: [FAKE], profileEnv: "FAKE_PROFILE", accounts: accts.map((a) => a.label) }] }
      : expand(opt["gw-root"]) === expand("~/.local/share/mcp-servers/google-workspace") ? { port, sdkRoot: REPO, upstreams: [{ preset: "google-workspace", command: `${expand(opt["gw-root"])}/node_modules/.bin/google-workspace-mcp` }] }
        : die("router with a non-default --gw-root is not supported; install google-workspace-mcp at the default path");
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    const url = `http://[::1]:${port}/mcp`;
    return {
      family: suite === "fake" ? "fake" : "dguido",
      daemons: [{ role: "router", command: process.execPath, args: [path.join(REPO, "router.mjs")], env: baseEnv({ ACCTMUX_CONFIG: file, GOOGLE_WORKSPACE_SERVICES: "drive,gmail,calendar" }), port }],
      session: () => [{ endpoint: new HttpEndpoint(url), accounts: accts }],
      args: (a, c) => ({ ...c, arguments: { ...c.arguments, account: a.label } }),
    };
  },
  stdio: (suite, accts) => ({
    family: suite === "fake" ? "fake" : "dguido",
    daemons: [],
    session: (i, log) => accts.map((a) => { const u = upstreamFor(suite, a); return { endpoint: new StdioEndpoint(u.command, u.args, baseEnv(u.env), log, `s${i}-${a.label}`), accounts: [a] }; }),
    args: (_a, c) => c,
  }),
  "mcp-proxy": (suite, accts, port) => {
    const daemons = accts.map((a, k) => { const u = upstreamFor(suite, a); return { role: `mcp-proxy:${a.label}`, command: toolsBin("mcp-proxy"), args: ["--port", String(port + k), "--host", "::1", "--server", "stream", "--", u.command, ...u.args], env: baseEnv(u.env), port: port + k }; });
    return {
      family: suite === "fake" ? "fake" : "dguido", daemons,
      session: () => accts.map((a, k) => ({ endpoint: new HttpEndpoint(`http://[::1]:${port + k}/mcp`), accounts: [a] })),
      args: (_a, c) => c,
    };
  },
  supergateway: (suite, accts, port, stateless = false) => {
    const daemons = accts.map((a, k) => {
      const u = upstreamFor(suite, a);
      const args = ["--stdio", [u.command, ...u.args].join(" "), "--outputTransport", "streamableHttp", "--port", String(port + k), "--host", "::1", "--logLevel", "none"];
      if (!stateless) args.push("--stateful");
      return { role: `supergateway:${a.label}`, command: toolsBin("supergateway"), args, env: baseEnv(u.env), port: port + k };
    });
    return {
      family: suite === "fake" ? "fake" : "dguido", daemons,
      session: () => accts.map((a, k) => ({ endpoint: new HttpEndpoint(`http://[::1]:${port + k}/mcp`), accounts: [a] })),
      args: (_a, c) => c,
    };
  },
  "supergateway-stateless": (suite, accts, port) => CONFIGS.supergateway(suite, accts, port, true),
  // taylorwilsdon/google_workspace_mcp natively multi-account: one creds dir with every account, user_google_email per call
  "taylor-stdio": (suite, accts, _port, direct = false) => ({
    family: "taylor", daemons: [],
    session: (i, log) => { const t = taylorCmd(direct, ...TAYLOR_TOOLS); return [{ endpoint: new StdioEndpoint(t.command, t.args, baseEnv(taylorEnv(accts)), log, `s${i}-taylor`), accounts: accts }]; },
    args: (a, c) => ({ ...c, arguments: { ...c.arguments, user_google_email: a.email } }),
  }),
  "taylor-http": (suite, accts, port, direct = false) => ({
    family: "taylor",
    daemons: [{ role: "workspace-mcp", ...taylorCmd(direct, ...TAYLOR_TOOLS, "--transport", "streamable-http"), env: baseEnv({ ...taylorEnv(accts), WORKSPACE_MCP_PORT: String(port), WORKSPACE_MCP_HOST: "127.0.0.1" }), port, host: "127.0.0.1" }],
    session: () => [{ endpoint: new HttpEndpoint(`http://127.0.0.1:${port}/mcp`), accounts: accts }],
    args: (a, c) => ({ ...c, arguments: { ...c.arguments, user_google_email: a.email } }),
  }),
  "router-taylor": (suite, accts, port, direct = false) => {
    const t = taylorCmd(direct, "--single-user", ...TAYLOR_TOOLS);
    const file = path.join(WORK, `router-taylor-${port}.json`);
    const cfg = {
      port, sdkRoot: REPO,
      upstreams: [{
        name: "taylor", command: t.command, args: t.args,
        env: { GOOGLE_CLIENT_SECRET_PATH: accts[0].clientSecret, BROWSER: "true" },
        envPass: "^(PATH|HOME|USER|LANG|XDG_.*|UV_.*)$",
        accounts: Object.fromEntries(accts.map((a) => [a.label, { env: { WORKSPACE_MCP_CREDENTIALS_DIR: path.join(WORK, "taylor", a.label), USER_GOOGLE_EMAIL: a.email } }])),
        defaultAccount: "default",
        authRequired: { resultMatch: "ACTION REQUIRED: Google Authentication Needed", message: "Account {account} needs a Google login for the taylor upstream." },
      }],
    };
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    const url = `http://[::1]:${port}/mcp`;
    return {
      family: "taylor",
      daemons: [{ role: "router", command: process.execPath, args: [path.join(REPO, "router.mjs")], env: baseEnv({ ACCTMUX_CONFIG: file }), port }],
      session: () => [{ endpoint: new HttpEndpoint(url), accounts: accts }],
      args: (a, c) => ({ ...c, arguments: { ...c.arguments, account: a.label } }),
    };
  },
};
for (const n of ["taylor-stdio", "taylor-http", "router-taylor"]) CONFIGS[`${n}-direct`] = (suite, accts, port) => CONFIGS[n](suite, accts, port, true);
function taylorEnv(accts) {
  return { GOOGLE_CLIENT_SECRET_PATH: accts[0].clientSecret, WORKSPACE_MCP_CREDENTIALS_DIR: path.join(WORK, "taylor", accts.length > 1 ? "all" : accts[0].label) };
}
const SUITE_CONFIGS = {
  fake: ["router", "stdio", "mcp-proxy", "supergateway", "supergateway-stateless"],
  google: ["router", "stdio", "mcp-proxy", "supergateway", "supergateway-stateless", "taylor-stdio", "taylor-http", "router-taylor", "taylor-stdio-direct", "taylor-http-direct", "router-taylor-direct"],
};

// Copy each account's google-workspace-mcp login into workspace-mcp's format under WORK/taylor/{label,all}.
// expire=true marks the access token as expired so the first call of every account takes the refresh path.
function convertTaylor(accts, expire = false) {
  for (const a of accts) for (const dir of [a.label, "all"]) {
    const out = path.join(WORK, "taylor", dir);
    execFileSync(process.execPath, [path.join(REPO, "scripts/dguido-to-taylor.mjs"), "--source", a.source, "--email", a.email, "--out", out], { stdio: "ignore" });
    if (expire) {
      const f = path.join(out, `${a.email}.json`);
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, "utf8")), expiry: "1970-01-01T00:00:00" }), { mode: 0o600 });
    }
  }
}

// ---------- one cell ----------
function portFree(port, host = "::1") {
  return new Promise((r) => { const c = net.connect(port, host); c.once("connect", () => { c.destroy(); r(false); }); c.once("error", () => r(true)); });
}
async function waitPort(port, host, cp, limit) {
  const t0 = now();
  while (now() - t0 < limit) {
    if (cp.exitCode !== null) return { ok: false, err: `exited ${cp.exitCode}` };
    if (!(await portFree(port, host))) return { ok: true };
    await sleep(10);
  }
  return { ok: false, err: "port timeout" };
}

async function runCell(suite, name, N, accts, rep, warm, port, timeout) {
  const log = fs.createWriteStream(path.join(WORK, "logs", `${suite}-${name}-N${N}-M${accts.length}-r${rep}.log`));
  const cell = { suite, config: name, N, M: accts.length, rep, loadavg_before: os.loadavg().map((x) => +x.toFixed(2)), daemons: [], sessions: [], samples: [], errors: [] };
  const spec = CONFIGS[name](suite, accts, port);
  const work = WORKLOAD[spec.family];
  const roles = [];
  const sessions = [];
  if (opt["taylor-reset"] && spec.family === "taylor") convertTaylor(accts, true);
  try {
    for (const d of spec.daemons) {
      if (!(await portFree(d.port, d.host ?? "::1"))) throw new Error(`port ${d.port} busy`);
      const t0 = now();
      const cp = launch(d.command, d.args, d.env, log, d.role);
      const w = await waitPort(d.port, d.host ?? "::1", cp, 120000);
      cell.daemons.push({ role: d.role, ready_ms: +(now() - t0).toFixed(1), ok: w.ok, err: w.err && scrub(w.err) });
      if (!w.ok) throw new Error(`${d.role} not ready: ${w.err}`);
      roles.push([cp.pid, d.role]);
    }
    if (roles.length) { await sleep(1000); cell.mem_idle = memSnapshot(roles); }

    // open sessions one after another (startup timing without self-inflicted contention)
    for (let i = 0; i < N; i++) {
      const eps = spec.session(i, log);
      const sess = { s: i, eps, t: {} };
      sessions.push(sess);
      const t0 = now();
      const inits = await Promise.all(eps.map(async (e) => {
        const ts = await e.endpoint.open();
        const r = await e.endpoint.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "gw-bench", version: "1" } }, timeout);
        const init = now() - ts;
        if (!r.error) await e.endpoint.notify("notifications/initialized");
        return { spawn_ms: +e.endpoint.spawnMs.toFixed(1), init_ms: +init.toFixed(1), ok: !r.error, err: r.error && scrub(r.error.message) };
      }));
      const tInit = now();
      let tools = 0, bytes = 0, listOk = true;
      await Promise.all(eps.map(async (e) => {
        if (!inits[eps.indexOf(e)].ok) { listOk = false; return; }
        const r = await e.endpoint.rpc("tools/list", {}, timeout);
        if (r.error) { listOk = false; cell.errors.push(scrub(`tools/list: ${r.error.message}`)); return; }
        tools += r.result.tools.length;
        bytes += JSON.stringify(r.result.tools).length;
      }));
      const tList = now();
      cell.sessions.push({ s: i, endpoints: inits, ready_ms: +(tInit - t0).toFixed(1), first_list_ms: +(tList - tInit).toFixed(1), ok: inits.every((x) => x.ok) && listOk, tools, tools_bytes: bytes });
      for (const e of eps) if (e.endpoint.pid) roles.push([e.endpoint.pid, `session-${e.accounts.map((a) => a.label).join("+")}`]);
    }

    // workload: all sessions concurrently, calls sequential within a session
    const call = async (sess, a, key, phase) => {
      const ep = sess.eps.find((e) => e.accounts.includes(a));
      if (!cell.sessions[sess.s].ok) { cell.samples.push([sess.s, phase, a.label, key, null, 0, "session not ready"]); return; }
      const c = spec.args(a, work.call(key));
      const t0 = now();
      const r = await ep.endpoint.rpc("tools/call", c, timeout);
      const ms = +(now() - t0).toFixed(2);
      const bad = r.error ? r.error.message : r.result?.isError ? (r.result.content?.[0]?.text ?? "isError") : null;
      cell.samples.push([sess.s, phase, a.label, key, ms, bad ? 0 : 1, bad ? scrub(bad) : undefined, bad ? undefined : identity(a, r.result)]);
    };
    await Promise.all(sessions.map(async (sess) => {
      for (const a of accts) await call(sess, a, work.tools[0], "first");
      for (const a of accts) for (const k of work.tools.slice(1)) await call(sess, a, k, "warmup");
      for (let k = 0; k < warm; k++) for (const a of accts) for (const t of work.tools) await call(sess, a, t, "warm");
      for (let k = 0; k < warm; k++) for (const e of sess.eps) {
        if (!cell.sessions[sess.s].ok) break;
        const t0 = now();
        const r = await e.endpoint.rpc("tools/list", {}, timeout);
        cell.samples.push([sess.s, "list", e.accounts.map((x) => x.label).join("+"), "tools/list", +(now() - t0).toFixed(2), r.error ? 0 : 1, r.error && scrub(r.error.message)]);
      }
    }));
    await sleep(500);
    cell.mem = memSnapshot(roles);
  } catch (e) {
    cell.errors.push(scrub(e.message));
  } finally {
    await Promise.all(sessions.flatMap((s) => s.eps.map((e) => e.endpoint.close())));
    await killAll();
    log.end();
  }
  return cell;
}

// ---------- stats / summary ----------
function stats(xs) {
  const v = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  const n = v.length;
  if (!n) return { n: 0 };
  const q = (p) => { const i = (n - 1) * p; const lo = Math.floor(i); return v[lo] + (v[Math.min(lo + 1, n - 1)] - v[lo]) * (i - lo); };
  return { n, median: +q(0.5).toFixed(1), p95: n >= 20 ? +q(0.95).toFixed(1) : null, iqr: [+q(0.25).toFixed(1), +q(0.75).toFixed(1)], min: +v[0].toFixed(1), max: +v[n - 1].toFixed(1) };
}
function summarize(cells) {
  const groups = new Map();
  for (const c of cells) {
    const k = `${c.suite}|${c.config}|${c.N}|${c.M}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const rows = [];
  for (const [k, cs] of groups) {
    const [suite, config, N, M] = k.split("|");
    const samples = cs.flatMap((c) => c.samples);
    const pick = (f) => samples.filter(f);
    const okv = (xs) => xs.filter((s) => s[5]).map((s) => s[4]);
    const fails = samples.filter((s) => !s[5]).length;
    const first = pick((s) => s[1] === "first");
    rows.push({
      suite, config, N: +N, M: +M, reps: cs.length,
      cell_errors: cs.flatMap((c) => c.errors).length,
      calls: samples.length, failures: fails, failure_rate: samples.length ? +(fails / samples.length).toFixed(3) : null,
      daemon_ready_ms: stats(cs.flatMap((c) => c.daemons.map((d) => d.ready_ms))),
      session_ready_ms: stats(cs.flatMap((c) => c.sessions.filter((s) => s.ok).map((s) => s.ready_ms))),
      session_spawn_ms: stats(cs.flatMap((c) => c.sessions.flatMap((s) => s.endpoints.filter((e) => e.spawn_ms).map((e) => e.spawn_ms)))),
      first_list_ms: stats(cs.flatMap((c) => c.sessions.filter((s) => s.ok).map((s) => s.first_list_ms))),
      tools_per_session: cs[0]?.sessions[0]?.tools ?? null,
      tools_bytes_per_session: cs[0]?.sessions[0]?.tools_bytes ?? null,
      first_call_s0_ms: stats(okv(first.filter((s) => s[0] === 0))),
      first_call_later_ms: stats(okv(first.filter((s) => s[0] > 0))),
      warm_ms: stats(okv(pick((s) => s[1] === "warm"))),
      list_ms: stats(okv(pick((s) => s[1] === "list"))),
      pss_total_mb: stats(cs.filter((c) => c.mem).map((c) => c.mem.pss_kb / 1024)),
      uss_total_mb: stats(cs.filter((c) => c.mem).map((c) => c.mem.uss_kb / 1024)),
      rss_total_mb: stats(cs.filter((c) => c.mem).map((c) => c.mem.rss_kb / 1024)),
      nprocs: cs.find((c) => c.mem)?.mem.nprocs ?? null,
      pss_idle_mb: stats(cs.filter((c) => c.mem_idle).map((c) => c.mem_idle.pss_kb / 1024)),
      first_by_account: Object.fromEntries([...new Set(first.map((s) => s[2]))].map((a) => [a, stats(okv(first.filter((s) => s[2] === a)))])),
      identity: samples.filter((s) => s[3] === "calendars" && s[7]).reduce((o, s) => ({ ...o, [s[7]]: (o[s[7]] ?? 0) + 1 }), {}),
      error_examples: [...new Set(samples.filter((s) => !s[5]).map((s) => s[6]).concat(cs.flatMap((c) => c.errors)))].slice(0, 3),
    });
  }
  return rows;
}
const fmt = (s, unit = "") => (!s || !s.n ? "-" : `${s.median}${unit}${s.p95 != null ? ` / ${s.p95}` : ""} (n=${s.n})`);
function printTable(rows) {
  console.log("| suite | config | N | M | ok/calls | session ready ms | first call s0 ms | first call later ms | warm ms med / p95 | tools/list ms | PSS MB (procs) | USS MB |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of rows)
    console.log(`| ${r.suite} | ${r.config} | ${r.N} | ${r.M} | ${r.calls - r.failures}/${r.calls} | ${fmt(r.session_ready_ms)} | ${fmt(r.first_call_s0_ms)} | ${fmt(r.first_call_later_ms)} | ${fmt(r.warm_ms)} | ${fmt(r.list_ms)} | ${r.pss_total_mb.n ? r.pss_total_mb.median.toFixed(0) + ` (${r.nprocs})` : "-"} | ${r.uss_total_mb.n ? r.uss_total_mb.median.toFixed(0) : "-"} |`);
}

// ---------- environment record ----------
function sh(c, a) { try { return execFileSync(c, a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 120000 }).trim(); } catch { return null; } }
function pkgVersion(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")).version; } catch { return null; } }
function environment() {
  const cpu = os.cpus();
  return {
    date: new Date().toISOString(),
    host: { cpu: cpu[0]?.model, logical_cpus: cpu.length, mem_total_mb: Math.round(os.totalmem() / 2 ** 20), kernel: os.release(), os: sh("sh", ["-c", ". /etc/os-release; echo $PRETTY_NAME"]) },
    versions: {
      node: process.version, python_system: sh("python3", ["--version"]), uv: sh("uv", ["--version"]),
      router_commit: sh("git", ["-C", REPO, "rev-parse", "--short", "HEAD"]),
      "google-workspace-mcp": pkgVersion(path.join(expand(opt["gw-root"]), "node_modules/@dguido/google-workspace-mcp/package.json")),
      "mcp-sdk(router)": pkgVersion(path.join(expand(opt["gw-root"]), "node_modules/@modelcontextprotocol/server/package.json")),
      "mcp-proxy": pkgVersion(path.join(WORK, "tools/node_modules/mcp-proxy/package.json")),
      supergateway: pkgVersion(path.join(WORK, "tools/node_modules/supergateway/package.json")),
      "workspace-mcp": opt.suite === "google" ? sh("uvx", ["--python", PINS.python, "--from", `workspace-mcp==${PINS["workspace-mcp"]}`, "python", "-c", "import importlib.metadata as m;print(m.version('workspace-mcp'),'fastmcp',m.version('fastmcp'),'mcp',m.version('mcp'))"]) : null,
    },
  };
}

// ---------- commands ----------
const WORK = opt["work-dir"] ? path.resolve(expand(opt["work-dir"])) : null;

function printMatrix(rows) {
  const cols = [...new Set(rows.map((r) => `${r.N}x${r.M}`))].sort((a, b) => a.split("x")[1] - b.split("x")[1] || a.split("x")[0] - b.split("x")[0]);
  const configs = [...new Set(rows.map((r) => r.config))];
  console.log(`\nAggregate PSS in MB, median over reps [min-max], N sessions x M accounts\n\n| config | ${cols.join(" | ")} |\n|---|${cols.map(() => "---:").join("|")}|`);
  for (const c of configs) {
    const cell = (k) => { const r = rows.find((x) => x.config === c && `${x.N}x${x.M}` === k); const s = r?.pss_total_mb; return s?.n ? `${s.median.toFixed(0)} [${s.min.toFixed(0)}-${s.max.toFixed(0)}]` : "-"; };
    console.log(`| ${c} | ${cols.map(cell).join(" | ")} |`);
  }
  console.log("\nFirst tools/call per session, by account: median ms (n)\n\n| config | N | M | " + [...new Set(rows.flatMap((r) => Object.keys(r.first_by_account)))].join(" | ") + " |");
  const accts = [...new Set(rows.flatMap((r) => Object.keys(r.first_by_account)))];
  console.log(`|---|---:|---:|${accts.map(() => "---:").join("|")}|`);
  for (const r of rows) console.log(`| ${r.config} | ${r.N} | ${r.M} | ${accts.map((a) => (r.first_by_account[a]?.n ? `${r.first_by_account[a].median} (${r.first_by_account[a].n})` : "-")).join(" | ")} |`);
}

if (cmd === "summarize") {
  const cells = rest.flatMap((f) => JSON.parse(fs.readFileSync(f, "utf8")).cells);
  const rows = summarize(cells);
  printTable(rows);
  printMatrix(rows);
} else if (cmd === "setup") {
  if (!WORK) die("--work-dir required");
  fs.mkdirSync(path.join(WORK, "tools"), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(path.join(WORK, "tools/package.json"))) fs.writeFileSync(path.join(WORK, "tools/package.json"), '{"private":true}');
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", path.join(WORK, "tools"), `mcp-proxy@${PINS["mcp-proxy"]}`, `supergateway@${PINS.supergateway}`], { stdio: "inherit" });
  if (opt["accounts-file"]) {
    opt.suite = "google";
    const accts = loadAccounts();
    sh("uvx", uvxArgs("--help")); // pre-fetch into the uv cache so first-run download time is not measured
    convertTaylor(accts);
    console.log(`converted ${accts.length} account(s) for workspace-mcp into ${path.join(WORK, "taylor")} (mode 600)`);
  }
  console.log("setup done");
} else if (cmd === "run") {
  if (!WORK || !opt.out) die("--work-dir and --out are required");
  fs.mkdirSync(path.join(WORK, "logs"), { recursive: true });
  const suite = opt.suite;
  if (!SUITE_CONFIGS[suite]) die("--suite must be fake or google");
  const accounts = loadAccounts();
  EMAILS = accounts.filter((a) => a.email).map(({ email, label }) => ({ email, label }));
  const configs = opt.configs ? opt.configs.split(",") : SUITE_CONFIGS[suite];
  for (const c of configs) if (!CONFIGS[c]) die(`unknown config ${c}`);
  const Ns = opt.sessions.split(",").map(Number), Ms = opt.accounts.split(",").map(Number);
  const reps = Number(opt.reps), warm = Number(opt.warm ?? (suite === "fake" ? 30 : 5)), timeout = Number(opt.timeout), port = Number(opt["base-port"]);
  const out = { meta: { ...environment(), suite, params: { configs, sessions: Ns, accounts: Ms, reps, warm, timeout_ms: timeout, protocol: PROTOCOL, pins: PINS } }, cells: [] };
  const save = () => fs.writeFileSync(opt.out, JSON.stringify(out, null, 1));
  // rep-major order spreads time-of-day / network drift across configurations instead of bunching one config together
  for (let rep = 0; rep < reps; rep++)
    for (const name of configs) for (const M of Ms) for (const N of Ns) {
      // rotate through 50 port blocks of 4 so no cell reuses a port still in TIME_WAIT (workspace-mcp refuses to start then)
      const cell = await runCell(suite, name, N, accounts.slice(0, M), rep, warm, port + (out.cells.length % 50) * 4, timeout);
      out.cells.push(cell);
      save();
      const ok = cell.samples.filter((s) => s[5]).length;
      console.error(`${suite} ${name} N=${N} M=${M} rep=${rep}: ${ok}/${cell.samples.length} ok, pss=${cell.mem ? (cell.mem.pss_kb / 1024).toFixed(0) : "-"}MB${cell.errors.length ? " errors: " + cell.errors.join("; ") : ""}`);
    }
  out.summary = summarize(out.cells);
  save();
  printTable(out.summary);
} else {
  console.error("usage: bench.mjs setup|run|summarize (see header)");
  process.exit(2);
}
