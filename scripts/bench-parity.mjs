import { spawn } from "node:child_process"; import fs from "node:fs";
const GW = `${process.env.HOME}/.local/share/mcp-servers/google-workspace/node_modules/.bin/google-workspace-mcp`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, BROWSER: "true", GOOGLE_WORKSPACE_SERVICES: "drive,gmail,calendar" };
const up = spawn(GW, [], { env, stdio: ["pipe", "pipe", "ignore"] }); let buf = ""; const got = new Map();
up.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); got.set(m.id, m); } });
const w = (m) => up.stdin.write(JSON.stringify(m) + "\n");
w({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "p", version: "1" } } });
while (!got.has(1)) await sleep(20); w({ jsonrpc: "2.0", method: "notifications/initialized" }); w({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
while (!got.has(2)) await sleep(20); up.kill();
const upTools = got.get(2).result.tools;
fs.writeFileSync(process.argv[2] + "/cfg-parity.json", JSON.stringify({ port: 19600, upstreams: [{ preset: "google-workspace", command: GW }] }));
const r = spawn(process.execPath, ["/home/Roy/Claude/Projects/gw-mcp-router/router.mjs"], { env: { ...env, ACCTMUX_CONFIG: process.argv[2] + "/cfg-parity.json" }, stdio: "ignore" });
const H = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" };
let list; for (let k = 0; k < 100 && !list; k++) { await sleep(200); try { const res = await fetch("http://[::1]:19600/mcp", { method: "POST", headers: H, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }); const t = await res.text(); const line = t.split("\n").find((l) => l.startsWith("data:")); const m = JSON.parse(line ? line.slice(5) : t); if (m.result?.tools?.length) list = m.result.tools; } catch { /* ignore */ } }
r.kill("SIGTERM");
const strip = (t) => { const s = structuredClone(t); delete s.inputSchema?.properties?.account; return s; };
let same = 0, diff = [];
for (const t of upTools) { const rt = list.find((x) => x.name === t.name); if (rt && JSON.stringify(strip(rt).inputSchema) === JSON.stringify(t.inputSchema) && rt.description === t.description) same++; else diff.push(t.name); }
console.log(JSON.stringify({ upstream: upTools.length, router: list.length, identical_except_account: same, diff: diff.slice(0, 5), accountEnum: list[0].inputSchema.properties.account, bytes_router: JSON.stringify(list).length, bytes_upstream: JSON.stringify(upTools).length }));
await sleep(500);
