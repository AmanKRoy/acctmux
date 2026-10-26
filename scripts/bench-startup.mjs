// Supplementary measurements for the 2026-10-25 re-run: router start-to-listening, start-to-tools,
// cold account first call, idle-kill timing, kill-not-mid-call. Run inside `unshare -rn` (no external network).
//   node startup.mjs --kind fake|gw --reps 5 --port 19300 --work DIR --out file.json
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const REPO = "/home/Roy/Claude/Projects/gw-mcp-router";
const FAKE = path.join(REPO, "tests/fake-upstream.mjs");
const { values: o } = parseArgs({ options: { kind: { type: "string" }, reps: { type: "string", default: "5" }, port: { type: "string" }, work: { type: "string" }, out: { type: "string" }, idle: { type: "string", default: "2000" } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const PROTOCOL = "2025-06-18";
fs.mkdirSync(o.work, { recursive: true });

function procs() {
  const m = new Map();
  for (const d of fs.readdirSync("/proc")) if (/^\d+$/.test(d)) try { const st = fs.readFileSync(`/proc/${d}/stat`, "utf8"); m.set(+d, +st.slice(st.lastIndexOf(") ") + 2).split(" ")[1]); } catch { /* ignore */ }
  return m;
}
const kids = (pid) => [...procs()].filter(([, pp]) => pp === pid).map(([p]) => p);
const pss = (pid) => { try { return +/Pss:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))[1] / 1024; } catch { return null; } };
const envOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; } };
const workerFor = (rpid, acct) => kids(rpid).find((p) => { const e = envOf(p); const prof = e.find((x) => /^(FAKE_PROFILE|GOOGLE_WORKSPACE_MCP_PROFILE)=/.test(x)); return acct === "default" ? !prof : prof?.endsWith("=" + acct); });

function portOpen(port) { return new Promise((r) => { const c = net.connect(port, "::1"); c.once("connect", () => { c.destroy(); r(true); }); c.once("error", () => r(false)); }); }

class Http {
  constructor(url) { this.url = url; this.sid = null; this.id = 1; }
  async rpc(method, params, timeout = 60000) {
    const h = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL };
    if (this.sid) h["mcp-session-id"] = this.sid;
    const id = this.id++;
    const res = await fetch(this.url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeout) });
    this.sid = res.headers.get("mcp-session-id") || this.sid;
    const t = await res.text();
    if (!res.ok) return { status: res.status, error: { message: `HTTP ${res.status} ${t.slice(0, 120)}` } };
    if ((res.headers.get("content-type") || "").includes("event-stream")) {
      for (const l of t.split("\n")) if (l.startsWith("data:")) { try { const m = JSON.parse(l.slice(5)); if (m.id === id) return m; } catch { /* ignore */ } }
      return { error: { message: "no response in stream" } };
    }
    return JSON.parse(t);
  }
  async init() { const r = await this.rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "startup-bench", version: "1" } }); try { await fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": PROTOCOL, ...(this.sid ? { "mcp-session-id": this.sid } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((r) => r.text()); } catch { /* ignore */ } return r; }
}

function config(port, idle) {
  const cfg = o.kind === "fake"
    ? { port, idleMs: idle, upstreams: [{ name: "fake", command: process.execPath, args: [FAKE], profileEnv: "FAKE_PROFILE", accounts: ["default", "ai"] }] }
    : { port, idleMs: idle, upstreams: [{ preset: "google-workspace", command: `${process.env.HOME}/.local/share/mcp-servers/google-workspace/node_modules/.bin/google-workspace-mcp` }] };
  const f = path.join(o.work, `startup-${o.kind}-${port}.json`);
  fs.writeFileSync(f, JSON.stringify(cfg));
  return f;
}

async function rep(i, port) {
  const idle = Number(o.idle);
  const file = config(port, idle);
  const log = [];
  const t0 = now();
  const cp = spawn(process.execPath, [path.join(REPO, "router.mjs")], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ACCTMUX_CONFIG: file, GOOGLE_WORKSPACE_SERVICES: "drive,gmail,calendar" }, stdio: ["ignore", "pipe", "pipe"] });
  let cachedAt = null;
  const onLine = (d) => { const s = String(d); log.push(`${(now() - t0).toFixed(0)} ${s.trim()}`); if (cachedAt == null && /cached \d+ tools/.test(s)) cachedAt = now() - t0; };
  cp.stdout.on("data", onLine); cp.stderr.on("data", onLine);
  const r = { rep: i };
  try {
    while (!(await portOpen(port))) { if (cp.exitCode !== null) throw new Error("router exited"); await sleep(5); }
    r.listen_ms = +(now() - t0).toFixed(1);
    const c = new Http(`http://[::1]:${port}/mcp`);
    const ti = now();
    const init = await c.init();
    r.init_ok = !init.error;
    const l = await c.rpc("tools/list", {});
    r.first_list_tools = l.result?.tools?.length ?? null;
    r.first_list_ms = +(now() - ti).toFixed(1);
    r.start_to_tools_ms = +(now() - t0).toFixed(1);
    while (cachedAt == null && now() - t0 < 30000) await sleep(10);
    r.start_to_cached_log_ms = cachedAt != null ? +cachedAt.toFixed(1) : null;
    await sleep(1000);
    r.router_pss_idle_mb = +pss(cp.pid).toFixed(1);
    const dw = workerFor(cp.pid, "default");
    r.default_worker_pss_mb = dw ? +pss(dw).toFixed(1) : null;
    const call = o.kind === "fake" ? (a) => ({ name: "echo", arguments: { text: "x", account: a } }) : (a) => ({ name: "list_calendars", arguments: { account: a } });
    let t = now(); let res = await c.rpc("tools/call", call("default"));
    r.first_call_default_ms = +(now() - t).toFixed(1);
    r.first_call_default_err = res.error?.message ?? (res.result?.isError ? res.result.content?.[0]?.text?.slice(0, 120) : null);
    t = now(); res = await c.rpc("tools/call", call("ai"));
    const tEnd = now();
    r.cold_account_ms = +(tEnd - t).toFixed(1);
    r.cold_account_err = res.error?.message ?? (res.result?.isError ? res.result.content?.[0]?.text?.slice(0, 120) : null);
    t = now(); res = await c.rpc("tools/call", call("ai"));
    r.second_call_ai_ms = +(now() - t).toFixed(1);
    const aiPid = workerFor(cp.pid, "ai");
    r.ai_worker_seen = !!aiPid;
    const tLast = now();
    // idle-kill: worker should disappear about idleMs after the last call ends
    while (aiPid && kids(cp.pid).includes(aiPid) && now() - tLast < idle + 15000) await sleep(20);
    r.idle_kill_after_last_call_ms = aiPid && !kids(cp.pid).includes(aiPid) ? +(now() - tLast).toFixed(0) : null;
    if (o.kind === "fake") {
      // not killed mid-call: a call twice as long as idleMs must complete on the same worker
      const sl = now();
      const p = c.rpc("tools/call", { name: "sleep", arguments: { ms: idle * 2, account: "ai" } });
      await sleep(300);
      const w = workerFor(cp.pid, "ai");
      const sr = await p;
      r.long_call_ms = +(now() - sl).toFixed(0);
      r.long_call_ok = !sr.error && !sr.result?.isError;
      r.long_call_same_worker_alive_at_end = !!w && kids(cp.pid).includes(w);
      const te = now();
      while (w && kids(cp.pid).includes(w) && now() - te < idle + 15000) await sleep(20);
      r.idle_kill_after_long_call_ms = w && !kids(cp.pid).includes(w) ? +(now() - te).toFixed(0) : null;
    }
  } catch (e) { r.error = e.message; }
  finally {
    cp.kill("SIGTERM");
    await Promise.race([new Promise((x) => cp.once("exit", x)), sleep(4000)]);
    if (cp.exitCode === null) cp.kill("SIGKILL");
    await sleep(300);
  }
  r.log = log.slice(0, 40);
  return r;
}

const out = { kind: o.kind, idleMs: +o.idle, date: new Date().toISOString(), node: process.version, reps: [] };
for (let i = 0; i < +o.reps; i++) { out.reps.push(await rep(i, +o.port + i)); console.error(JSON.stringify({ ...out.reps.at(-1), log: undefined })); }
fs.writeFileSync(o.out, JSON.stringify(out, null, 1));
