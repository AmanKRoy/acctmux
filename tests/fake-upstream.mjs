// Minimal stdio MCP server for router tests. Newline-delimited JSON-RPC, no SDK.
// Behaviour via env: FAKE_START_DELAY (ms), FAKE_LIST_DELAY (ms, delays tools/list), FAKE_PROMPTS_DELAY (ms, delays prompts/list), FAKE_INFINITE_CURSOR=1 (tools/list never ends), FAKE_STDERR (printed to stderr at start), FAKE_FAIL_START=1, FAKE_FAIL_FILE (fail at start while that file exists), FAKE_EXTRA (extra tool name), FAKE_PROFILE (set by the router),
// FAKE_RESOURCES=1 (resources + prompts, two resource pages, profile-specific URIs), FAKE_AUTH_RESULT=1 (tool calls answer with an isError result that asks for a login, no hang), FAKE_AUTH_HANG=1 (tool calls print an interactive-login banner on stderr and never reply), FAKE_CLEAR_ROOT (on auth hang delete <root>/profiles/<profile>/tokens.json like the real upstream),
// FAKE_CANCEL_FILE (append a line when the child receives notifications/cancelled), FAKE_ERROR_FILE (while that file exists, tool calls other than warm/crash answer with an isError result carrying the file's text, e.g. a quota error).
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

if (process.env.FAKE_STDERR) process.stderr.write(process.env.FAKE_STDERR + "\n");
if (process.env.FAKE_FAIL_START || (process.env.FAKE_FAIL_FILE && fs.existsSync(process.env.FAKE_FAIL_FILE))) { process.stderr.write("fake: cannot start, bad config\n"); process.exit(1); }

const delay = Number(process.env.FAKE_START_DELAY || 0);
let warmed = false;
let calls = 0;

const obj = (properties = {}, required = []) => ({ type: "object", properties, required });
const tools = [
  { name: "whoami", description: "identity of this child", inputSchema: obj() },
  { name: "warm", description: "mark child authenticated", inputSchema: obj() },
  { name: "status", description: "fails until warm was called", inputSchema: obj() },
  { name: "crash", description: "exit without replying", inputSchema: obj() },
  { name: "sleep", description: "reply after ms", inputSchema: obj({ ms: { type: "number" } }, ["ms"]) },
  { name: "echo", description: "echo text", inputSchema: obj({ text: { type: "string" } }, ["text"]) },
];
if (process.env.FAKE_ACCT_TOOL) tools.push({ name: "acctool", description: "has its own account argument", inputSchema: obj({ account: { type: "string" } }) });
if (process.env.FAKE_EXTRA) tools.push({ name: process.env.FAKE_EXTRA, description: "extra", inputSchema: obj() });

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");

function call(name, args) {
  calls++;
  if (name === "whoami") return text(JSON.stringify({ profile: process.env.FAKE_PROFILE ?? null, user: process.env.FAKE_USER ?? null, pid: process.pid, argv: process.argv.slice(2), warmed, calls }));
  if (name === "warm") { warmed = true; return text("warm"); }
  if (name === "status") return warmed ? text("ok") : text("Drive service not initialized", true);
  if (name === "echo") return text(args.text);
  if (name === "acctool") return text("acct=" + args.account);
  return text(name);
}

async function handle(m) {
  if (m.method === "initialize") {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, ...(process.env.FAKE_RESOURCES ? { resources: {}, prompts: {} } : {}) }, serverInfo: { name: "fake", version: "1.0.0" } } });
  }
  if (m.method === "notifications/cancelled" && process.env.FAKE_CANCEL_FILE) fs.appendFileSync(process.env.FAKE_CANCEL_FILE, "cancelled\n");
  if (m.id === undefined) return;
  if (m.method === "tools/list" && process.env.FAKE_LIST_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_LIST_DELAY)));
  if (m.method === "tools/list" && process.env.FAKE_INFINITE_CURSOR) return send({ jsonrpc: "2.0", id: m.id, result: { tools, nextCursor: "again" } });
  if (m.method === "prompts/list" && process.env.FAKE_PROMPTS_DELAY) await new Promise((r) => setTimeout(r, Number(process.env.FAKE_PROMPTS_DELAY)));
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  const prof = process.env.FAKE_PROFILE ?? "default";
  if (m.method === "resources/list" && process.env.FAKE_RESOURCES) {
    const page2 = m.params?.cursor === "p2";
    const r = page2 ? [{ uri: `fake:///${prof}/doc2`, name: "doc2" }] : [{ uri: `fake:///${prof}/doc1`, name: "doc1" }];
    return send({ jsonrpc: "2.0", id: m.id, result: { resources: r, ...(page2 ? {} : { nextCursor: "p2" }) } });
  }
  if (m.method === "resources/read" && process.env.FAKE_RESOURCES)
    return send({ jsonrpc: "2.0", id: m.id, result: { contents: [{ uri: m.params.uri, mimeType: "text/plain", text: `body of ${m.params.uri} read by ${prof}` }] } });
  if (m.method === "prompts/list" && process.env.FAKE_RESOURCES)
    return send({ jsonrpc: "2.0", id: m.id, result: { prompts: [{ name: "greet", description: "say hi", arguments: [{ name: "who", required: false }] }] } });
  if (m.method === "prompts/get" && process.env.FAKE_RESOURCES)
    return send({ jsonrpc: "2.0", id: m.id, result: { messages: [{ role: "user", content: { type: "text", text: `hi ${m.params.arguments?.who ?? "you"} from ${prof}` } }] } });
  if (m.method === "tools/call") {
    const { name, arguments: args = {} } = m.params;
    if (name === "crash") process.exit(1);
    const errFile = process.env.FAKE_ERROR_FILE;
    if (errFile && name !== "warm" && fs.existsSync(errFile)) { calls++; return send({ jsonrpc: "2.0", id: m.id, result: text(fs.readFileSync(errFile, "utf8"), true) }); }
    if (process.env.FAKE_AUTH_RESULT && name !== "warm")
      return send({ jsonrpc: "2.0", id: m.id, result: text("**ACTION REQUIRED: Google Authentication Needed** open https://example.test/auth", true) });
    if (process.env.FAKE_AUTH_HANG && name !== "warm") {
      if (process.env.FAKE_CLEAR_ROOT) fs.rmSync(path.join(process.env.FAKE_CLEAR_ROOT, "profiles", process.env.FAKE_PROFILE ?? "", "tokens.json"), { force: true });
      process.stderr.write("noise before\n[x] No valid authentication tokens found. Starting authentication flow...\n");
      return;
    }
    if (name === "sleep") await new Promise((r) => setTimeout(r, args.ms));
    return send({ jsonrpc: "2.0", id: m.id, result: call(name, args) });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } });
}

readline.createInterface({ input: process.stdin }).on("line", (l) => { if (l.trim()) handle(JSON.parse(l)); }).on("close", () => process.exit(0));
