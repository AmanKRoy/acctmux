import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { backoffMs } from "../lib/util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUTER = path.join(HERE, "..", "router.mjs");
const FAKE = path.join(HERE, "fake-upstream.mjs");
const SDK_ROOT = process.env.TEST_SDK_ROOT || path.join(HERE, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "acctmux-test-"));
const running = [];

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, "::1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const fake = (name, extra = {}) => ({
  name,
  command: process.execPath,
  args: [FAKE],
  envPass: "^(PATH|HOME)$",
  profileEnv: "FAKE_PROFILE",
  defaultAccount: "a",
  accounts: ["a", "b"],
  ...extra,
});

// The SDK answers with a JSON body or one SSE event, depending on the protocol era; both carry one message.
const parseMessage = (text) => {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : text);
};

async function startRouter(config, { expectReady = true, token, headers = {}, env = {}, configMode = 0o600 } = {}) {
  const port = await freePort();
  const file = path.join(TMP, `cfg-${port}.json`);
  fs.writeFileSync(file, JSON.stringify({ port, sdkRoot: SDK_ROOT, ...config }));
  fs.chmodSync(file, configMode);
  const proc = spawn(process.execPath, [ROUTER], { env: { PATH: process.env.PATH, HOME: TMP, ACCTMUX_CONFIG: file, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  proc.stderr.on("data", (d) => { log += d; });
  const exited = Promise.race([
    new Promise((r) => proc.on("exit", (code) => r(code))),
    new Promise((_, rej) => setTimeout(() => rej(new Error("router did not exit")), 8000).unref()),
  ]);
  exited.catch(() => {});
  running.push(proc);
  const t0 = Date.now();
  const want = (config.tcp === false ? 0 : 1) + (config.socket ? 1 : 0);
  const ready = () => (log.match(/router listening/g) ?? []).length >= want;
  while (expectReady && !ready()) {
    if (proc.exitCode !== null) throw new Error("router exited early: " + log);
    if (Date.now() - t0 > 10000) throw new Error("router did not start: " + log);
    await new Promise((r) => setTimeout(r, 25));
  }
  const url = `http://[::1]:${port}/mcp`;
  let id = 0;
  const rpc = async (method, params = {}) => {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    return parseMessage(await r.text());
  };
  const call = async (name, args = {}) => {
    const body = await rpc("tools/call", { name, arguments: args });
    return body;
  };
  const who = async (name, args = {}) => JSON.parse((await call(name, args)).result.content[0].text);
  return { port, url, proc, exited, rpc, call, who, log: () => log, tools: async () => (await rpc("tools/list")).result.tools };
}

after(() => { for (const p of running) p.kill("SIGKILL"); fs.rmSync(TMP, { recursive: true, force: true }); });

const unixPost = (socketPath, { headers = {}, body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ socketPath, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers } }, (res) => {
    let data = "";
    res.on("data", (d) => { data += d; });
    res.on("end", () => resolve({ status: res.statusCode, body: data }));
  });
  req.on("error", reject);
  req.end(body);
});

const sockPath = (name) => path.join(TMP, `${name}.sock`);

const rawRequest = (port, { method = "POST", headers = {}, body = "" } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: "::1", port, path: "/mcp", method, headers }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
  req.on("error", (e) => (e.code === "ECONNRESET" || e.code === "EPIPE" ? resolve(0) : reject(e)));
  req.end(body);
});

describe("tool surface", () => {
  let r;
  before(async () => { r = await startRouter({ upstreams: [fake("fk")] }); });

  test("selector is added to every tool with enum and default", async () => {
    const tools = await r.tools();
    assert.equal(tools.length, 6);
    for (const t of tools) {
      const sel = t.inputSchema.properties.account;
      assert.deepEqual(sel.enum, ["a", "b"]);
      assert.equal(sel.default, "a");
      assert.ok(!(t.inputSchema.required ?? []).includes("account"));
    }
  });

  test("original schema fields survive", async () => {
    const echo = (await r.tools()).find((t) => t.name === "echo");
    assert.deepEqual(echo.inputSchema.required, ["text"]);
    assert.equal(echo.inputSchema.properties.text.type, "string");
  });

  test("each account gets its own env and its own child", async () => {
    const a = await r.who("whoami", { account: "a" });
    const b = await r.who("whoami", { account: "b" });
    assert.equal(a.profile, null);
    assert.equal(b.profile, "b");
    assert.notEqual(a.pid, b.pid);
  });

  test("omitted selector uses the default account", async () => {
    assert.equal((await r.who("whoami")).profile, null);
  });

  test("selector is stripped before forwarding", async () => {
    const res = await r.call("echo", { account: "a", text: "hi" });
    assert.equal(res.result.content[0].text, "hi");
  });

  test("unknown account and unknown tool are rejected", async () => {
    const bad = await r.call("whoami", { account: "zzz" });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /Unknown account "zzz". Available: a, b/);
    const none = await r.call("nope");
    assert.equal(none.result.isError, true);
  });
});

describe("policy", () => {
  test("deny blocks the call; per-account denies add to the * deny", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { policy: { "*": { deny: ["echo"] }, b: { deny: ["crash"] } } })] });
    const crash = await r.call("crash", { account: "b" });
    assert.match(crash.result.content[0].text, /Unknown tool|not permitted/);
    for (const account of ["a", "b"]) {
      const echo = await r.call("echo", { account, text: "x" });
      assert.match(echo.result.content[0].text, /Unknown tool|not permitted/, `echo stays denied for ${account}`);
    }
    assert.ok(await r.who("whoami", { account: "b" }), "child survived, so the denied calls never reached it");
  });

  test("an account allow list replaces the * allow list; a * deny still wins", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { policy: { "*": { allow: ["whoami", "echo"], deny: ["echo"] }, b: { allow: ["whoami", "echo"] } } })] });
    assert.ok(await r.who("whoami", { account: "a" }));
    for (const account of ["a", "b"]) {
      const echo = await r.call("echo", { account, text: "x" });
      assert.match(echo.result.content[0].text, /Unknown tool|not permitted/, `* deny wins for ${account}`);
    }
  });

  test("an account allow list can widen the * allow list (documented asymmetry with deny)", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { policy: { "*": { allow: ["whoami"] }, b: { allow: ["echo"] } } })] });
    assert.equal((await r.call("echo", { account: "b", text: "x" })).result.content[0].text, "x");
    assert.match((await r.call("whoami", { account: "b" })).result.content[0].text, /not permitted/);
  });

  test("router starts from another account when the default account cannot start", async () => {
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("fk", { defaultAccount: "a", accounts: { a: { env: { FAKE_FAIL_START: "1" } }, b: { env: {} } } })] });
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
  });

  test("a tool with its own account argument is refused until the selector is renamed", async () => {
    const clash = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("fk", { env: { FAKE_ACCT_TOOL: "1" } })] }, { expectReady: false });
    assert.notEqual(await clash.exited, 0);
    assert.match(clash.log(), /tool "acctool" already has an argument named "account"; set "selector"/);
    assert.equal((clash.log().match(/base load failed/g) ?? []).length, 1, "a selector clash is not account specific, so no other account is tried");
    const ok = await startRouter({ upstreams: [fake("fk", { selector: "acct", env: { FAKE_ACCT_TOOL: "1" } })] });
    const tool = (await ok.tools()).find((x) => x.name === "acctool");
    assert.deepEqual(tool.inputSchema.properties.acct.enum, ["a", "b"]);
    assert.equal(tool.inputSchema.properties.account.type, "string", "the upstream's own argument is untouched");
    assert.equal((await ok.call("acctool", { acct: "b", account: "mine" })).result.content[0].text, "acct=mine");
  });

  test("retrying a failed upstream never delays calls to a working one", async () => {
    const r = await startRouter({ connectTimeoutMs: 1500, failTtlMs: 1000, upstreams: [fake("good"), fake("bad", { env: { FAKE_START_DELAY: "10000" } })] });
    await r.who("whoami", { account: "a" });
    assert.match(r.log(), /upstream unavailable bad/);
    await new Promise((res) => setTimeout(res, 1200));
    const t0 = Date.now();
    assert.ok(await r.who("whoami", { account: "a" }));
    assert.ok(Date.now() - t0 < 1000, `call took ${Date.now() - t0} ms while bad was retrying`);
  });

  test("host 127.0.0.1 listens on IPv4 loopback; other hosts are refused", async () => {
    const r = await startRouter({ host: "127.0.0.1", upstreams: [fake("fk")] });
    assert.match(r.log(), /router listening 127\.0\.0\.1:/);
    const res = await fetch(`http://127.0.0.1:${r.port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(res.status, 200);
    const bad = await startRouter({ host: "0.0.0.0", upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await bad.exited, 0);
    assert.match(bad.log(), /host must be/);
  });

  test("the SDK defaults to the package's own dependency when sdkRoot is not set", async () => {
    const r = await startRouter({ sdkRoot: undefined, upstreams: [fake("fk")] });
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
  });

  const startFromHome = async (relConfig) => {
    const home = fs.mkdtempSync(path.join(TMP, "home-"));
    const port = await freePort();
    const file = path.join(home, relConfig);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ port, upstreams: [fake("fk")] }));
    const proc = spawn(process.execPath, [ROUTER], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    running.push(proc);
    let log = "";
    proc.stderr.on("data", (d) => { log += d; });
    for (let i = 0; i < 400 && !/router listening/.test(log); i++) await new Promise((res) => setTimeout(res, 25));
    return { log, port };
  };

  test("config is found at ~/.config/acctmux/config.json", async () => {
    const { log, port } = await startFromHome(".config/acctmux/config.json");
    assert.match(log, new RegExp(`router listening \\[::1\\]:${port}`));
  });

  test("the pre-0.1 config path and GW_ROUTER_* variables are not read", async () => {
    const legacy = await startFromHome(".config/gw-mcp-router/config.json");
    assert.doesNotMatch(legacy.log, /router listening/);
  });

  test("with no config file the router explains what to create and exits", async () => {
    const home = fs.mkdtempSync(path.join(TMP, "home-"));
    const proc = spawn(process.execPath, [ROUTER], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
    running.push(proc);
    let log = "";
    proc.stderr.on("data", (d) => { log += d; });
    assert.notEqual(await new Promise((res) => proc.on("exit", res)), 0);
    assert.match(log, /no config file at .*acctmux\/config\.json/);
    assert.match(log, /"upstreams"/);
    assert.match(log, /preset": "google-workspace"/);
  });

  test("the google-workspace preset fills in the Google defaults and accepts overrides", async () => {
    const r = await startRouter({ upstreams: [{ preset: "google-workspace", command: process.execPath, args: [FAKE], accounts: ["a", "b"], defaultAccount: "a", envPass: "^(PATH|HOME)$", profileEnv: "FAKE_PROFILE" }] });
    const t = (await r.tools()).find((x) => x.name === "whoami");
    assert.deepEqual(t.inputSchema.properties.account.enum, ["a", "b"]);
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
    const bad = await startRouter({ upstreams: [{ preset: "nope" }] }, { expectReady: false });
    assert.notEqual(await bad.exited, 0);
    assert.match(bad.log(), /unknown preset "nope"; known: google-workspace/);
  });

  test("requireAccount makes the selector required and refuses calls without it", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { requireAccount: true })] });
    const t = (await r.tools()).find((x) => x.name === "whoami");
    assert.ok(t.inputSchema.required.includes("account"));
    assert.equal(t.inputSchema.properties.account.default, undefined);
    assert.match((await r.call("whoami")).result.content[0].text, /Argument "account" is required for fk\. Available: a, b/);
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
    const open = await startRouter({ upstreams: [fake("fk")] });
    assert.equal((await open.call("whoami")).result.isError, undefined, "the default account still answers without the selector");
  });

  test("callTimeoutMs ends a slow call with a timeout error and rejects bad values", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { callTimeoutMs: 300 })] });
    const t0 = Date.now();
    const slow = await r.call("sleep", { ms: 3000 });
    assert.ok(Date.now() - t0 < 2500, "the call ended before the upstream replied");
    assert.match(JSON.stringify(slow), /timed out|timeout/i);
    assert.equal((await r.call("echo", { text: "still up" })).result.content[0].text, "still up");
    for (const bad of ["5000", 0, -1, null]) {
      const b = await startRouter({ upstreams: [fake("fk", { callTimeoutMs: bad })] }, { expectReady: false });
      assert.notEqual(await b.exited, 0);
      assert.match(b.log(), /callTimeoutMs" must be a positive number/);
    }
  });

  test("a broken account is retried with exponential backoff and recovers when the fault clears", async () => {
    const flag = path.join(TMP, "bad-start-" + process.pid);
    fs.writeFileSync(flag, "");
    const r = await startRouter({
      failTtlMs: 200,
      upstreams: [fake("fk", { accounts: { a: {}, b: { env: { FAKE_FAIL_FILE: flag } } } })],
    });
    const spawns = () => (r.log().match(/spawn fk b/g) ?? []).length;
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    await r.call("whoami", { account: "b" });
    assert.equal(spawns(), 1);
    await r.call("whoami", { account: "b" });
    assert.equal(spawns(), 1, "cached inside failTtlMs");
    await wait(260);
    await r.call("whoami", { account: "b" });
    assert.equal(spawns(), 2, "retried after failTtlMs");
    await wait(260);
    await r.call("whoami", { account: "b" });
    assert.equal(spawns(), 2, "the second failure is cached for twice as long");
    await wait(200);
    await r.call("whoami", { account: "b" });
    assert.equal(spawns(), 3, "retried after 2 x failTtlMs");
    fs.rmSync(flag);
    await wait(850);
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b", "recovers once the cache expires");
  });

  test("numeric options must be positive numbers", async () => {
    for (const bad of ["5000", 0, -1, null]) {
      const r = await startRouter({ connectTimeoutMs: bad, upstreams: [fake("fk")] }, { expectReady: false });
      assert.notEqual(await r.exited, 0);
      assert.match(r.log(), /connectTimeoutMs must be a positive number/);
    }
  });

  test("stderr is logged when the child starts but tools/list fails", async () => {
    const r = await startRouter({ connectTimeoutMs: 800, upstreams: [fake("fk", { env: { FAKE_STDERR: "fake: missing API key", FAKE_LIST_DELAY: "20000" } })] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /child stderr fk a "fake: missing API key"/);
  });

  test("malformed accounts and authRequired are refused at load", async () => {
    const cases = [
      [{ accounts: { root: "/x", marker: "t.json" } }, /accounts\.profilesDir" is required/],
      [{ accounts: [{ name: "a" }] }, /non-empty account names/],
      [{ accounts: ["a"], authRequired: "AUTH" }, /"authRequired" must be an object/],
      [{ accounts: ["a"], authRequired: { match: "x", resultMatch: "(" } }, /authRequired\.resultMatch is not a valid regular expression/],
    ];
    for (const [extra, re] of cases) {
      const r = await startRouter({ upstreams: [{ name: "x", command: process.execPath, ...extra }] }, { expectReady: false });
      assert.notEqual(await r.exited, 0);
      assert.match(r.log(), re);
    }
  });

  test("account names with path or shell characters are refused at load", async () => {
    const cases = [
      [{ accounts: ["ok", "a b"] }, /account name "a b" must match/],
      [{ accounts: { "x;touch pwned": { env: {} } } }, /account name "x;touch pwned" must match/],
      [{ accounts: ["../etc"] }, /account name "\.\.\/etc" must match/],
      [{ accounts: ["$(id)"] }, /account name "\$\(id\)" must match/],
      [{ accounts: ["ok"], defaultAccount: "bad name" }, /account name "bad name" must match/],
    ];
    for (const [extra, re] of cases) {
      const r = await startRouter({ upstreams: [{ name: "x", command: process.execPath, ...extra }] }, { expectReady: false });
      assert.notEqual(await r.exited, 0);
      assert.match(r.log(), re);
    }
  });

  test("a discovered profile directory with an unsafe name is ignored and logged", async () => {
    const root = fs.mkdtempSync(path.join(TMP, "scan-"));
    fs.writeFileSync(path.join(root, "tokens.json"), "{}");
    for (const d of ["good", "bad name;x"]) {
      fs.mkdirSync(path.join(root, "profiles", d), { recursive: true });
      fs.writeFileSync(path.join(root, "profiles", d, "tokens.json"), "{}");
    }
    const r = await startRouter({ upstreams: [fake("fk", { accounts: { root, marker: "tokens.json", profilesDir: "profiles" } })] });
    assert.deepEqual((await r.tools())[0].inputSchema.properties.account.enum, ["a", "good"]);
    assert.match(r.log(), /ignoring account directory "bad name;x"/);
  });

  test("a config file readable by other users gets a warning, a private one does not", async () => {
    const loose = await startRouter({ upstreams: [fake("fk")] }, { configMode: 0o644 });
    assert.match(loose.log(), /warning: .*cfg-\d+\.json is readable by other users/);
    const tight = await startRouter({ upstreams: [fake("fk")] });
    assert.doesNotMatch(tight.log(), /readable by other users/);
  });

  test("a child that fails to start has its stderr logged", async () => {
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("fk", { defaultAccount: "a", accounts: { a: { env: {} }, b: { env: { FAKE_FAIL_START: "1" } } } })] });
    assert.match((await r.call("whoami", { account: "b" })).result.content[0].text, /Failed to start/);
    await new Promise((res) => setTimeout(res, 500));
    assert.match(r.log(), /child stderr fk b "fake: cannot start, bad config"/);
  });

  test("startup falls through any number of fast failures to a healthy account", async () => {
    const acc = Object.fromEntries(["a", "b", "c", "d"].map((n) => [n, { env: n === "d" ? {} : { FAKE_FAIL_START: "1" } }]));
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("fk", { accounts: acc })] });
    assert.equal((await r.who("whoami", { account: "d" })).profile, "d");
    assert.equal((r.log().match(/base load failed/g) ?? []).length, 3);
  });

  test("startup stops trying further accounts after a time budget of three connect timeouts", async () => {
    const acc = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((n) => [n, { env: { FAKE_START_DELAY: "10000" } }]));
    const t0 = Date.now();
    const r = await startRouter({ connectTimeoutMs: 500, upstreams: [fake("fk", { accounts: acc })] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.ok(Date.now() - t0 < 4500, `took ${Date.now() - t0} ms`);
    assert.ok((r.log().match(/base load failed/g) ?? []).length <= 4);
  });

  test("an upstream that connects and then hangs on tools/list is cut off at the connect timeout", async () => {
    const t0 = Date.now();
    const r = await startRouter({ connectTimeoutMs: 800, upstreams: [fake("fk", { accounts: ["a"], env: { FAKE_LIST_DELAY: "20000" } })] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  });

  test("shipped examples have the required shape", () => {
    for (const f of fs.readdirSync(path.join(HERE, "..")).filter((x) => /^config\..*json$/.test(x))) {
      const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "..", f), "utf8"));
      assert.ok(Array.isArray(cfg.upstreams) && cfg.upstreams.length, `${f}: upstreams`);
      for (const u of cfg.upstreams) {
        assert.ok(u.preset || (u.name && u.command && u.accounts), `${f}: ${u.name} needs name, command and accounts (or a preset)`);
      }
    }
  });

  test("shipped examples keep the fast login failure for the Google upstream", () => {
    for (const f of ["config.google.example.json", "config.multi.example.json"]) {
      const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "..", f), "utf8"));
      for (const u of cfg.upstreams.filter((x) => /google-workspace-mcp/.test(x.command ?? ""))) {
        assert.ok(u.authRequired?.match, `${f}: ${u.name} needs authRequired`);
        assert.equal(u.env?.BROWSER, "true", `${f}: ${u.name} needs BROWSER=true`);
        assert.equal(u.env?.XDG_CURRENT_DESKTOP, "X-Generic", `${f}: ${u.name} needs XDG_CURRENT_DESKTOP=X-Generic so xdg-open ignores desktop-specific openers`);
      }
    }
  });

  test("env values and args starting with ~ are expanded", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { env: { FAKE_USER: "~/x" } })] });
    assert.equal((await r.who("whoami", { account: "a" })).user, path.join(TMP, "x"));
  });

  test("args entries starting with ~ are expanded", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { args: [FAKE, "~/y", "z~/w"] })] });
    assert.deepEqual((await r.who("whoami", { account: "a" })).argv, [path.join(TMP, "y"), "z~/w"]);
  });

  test("a bad selector name and a policy entry that matches nothing are reported", async () => {
    const bad = await startRouter({ selector: "", upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await bad.exited, 0);
    assert.match(bad.log(), /selector must be an identifier/);
    const typo = await startRouter({ upstreams: [fake("fk", { policy: { bb: { deny: ["echo"] } } })] });
    assert.match(typo.log(), /warning: policy entry "bb" of upstream fk matches no account or pool/);
  });

  test("policy shape is validated and unknown tool names in a policy are reported", async () => {
    const str = await startRouter({ upstreams: [fake("fk", { policy: { "*": { allow: "whoami_status" } } })] }, { expectReady: false });
    assert.notEqual(await str.exited, 0);
    assert.match(str.log(), /policy "\*"\.allow: must be a list of tool names/);
    const obj = await startRouter({ upstreams: { name: "fk" } }, { expectReady: false });
    assert.notEqual(await obj.exited, 0);
    assert.match(obj.log(), /"upstreams" must be a non-empty list/);
    const typo = await startRouter({ upstreams: [fake("fk", { policy: { "*": { deny: ["ech0", "prompts/get"] } } })] });
    await typo.tools();
    assert.match(typo.log(), /warning: policy "\*" of upstream fk names unknown tool "ech0"/);
    assert.doesNotMatch(typo.log(), /unknown tool "prompts\/get"/);
  });

  test("stderr of a single failing upstream is logged before the router exits", async () => {
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("fk", { env: { FAKE_FAIL_START: "1" } })] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /child stderr fk a "fake: cannot start, bad config"/);
  });

  test("an upstream whose tools/list never ends is cut off at the page cap", async () => {
    const r = await startRouter({ connectTimeoutMs: 5000, upstreams: [fake("fk", { accounts: ["a"], env: { FAKE_INFINITE_CURSOR: "1" } })] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /tools\/list returned more than 100 pages/);
  });

  test("an upstream whose prompts/list hangs is not half loaded", async () => {
    const r = await startRouter({ connectTimeoutMs: 800, upstreams: [fake("good"), fake("slow", { env: { FAKE_RESOURCES: "1", FAKE_PROMPTS_DELAY: "20000" } })] });
    const names = (await r.tools()).map((x) => x.name);
    assert.match(r.log(), /upstream unavailable slow/);
    assert.deepEqual(names.filter((n) => n.startsWith("slow__")), [], "slow's tools are not served while it is marked unavailable");
    assert.ok(names.includes("whoami"));
  });

  test("an upstream without command or accounts is refused with a clear message", async () => {
    const noAcc = await startRouter({ upstreams: [{ name: "x", command: process.execPath }] }, { expectReady: false });
    assert.notEqual(await noAcc.exited, 0);
    assert.match(noAcc.log(), /upstreams\[0\] \(x\): "accounts" is required/);
    const noCmd = await startRouter({ upstreams: [{ name: "x", accounts: ["a"] }] }, { expectReady: false });
    await noCmd.exited;
    assert.match(noCmd.log(), /"command" is required/);
    const nul = await startRouter({ upstreams: [null] }, { expectReady: false });
    await nul.exited;
    assert.match(nul.log(), /upstreams\[0\]: must be an object/);
  });

  test("allow list restricts and hides tools denied for every account", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { policy: { "*": { allow: ["whoami", "echo"] } } })] });
    assert.deepEqual((await r.tools()).map((t) => t.name).sort(), ["echo", "whoami"]);
    assert.match((await r.call("sleep", { ms: 1 })).result.content[0].text, /Unknown tool/);
  });

  test("tool allowed for one account stays listed", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { policy: { a: { deny: ["echo"] } } })] });
    assert.ok((await r.tools()).some((t) => t.name === "echo"));
    assert.match((await r.call("echo", { account: "a", text: "x" })).result.content[0].text, /not permitted/);
    assert.equal((await r.call("echo", { account: "b", text: "x" })).result.content[0].text, "x");
  });
});

describe("warmup", () => {
  test("without warmup a cold child reports not initialized", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    assert.equal((await r.call("status", { account: "b" })).result.isError, true);
  });

  test("with warmup a cold child is ready for the first forwarded call", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { warmup: { tool: "warm" } })] });
    const res = await r.call("status", { account: "b" });
    assert.equal(res.result.isError, undefined);
    assert.equal(res.result.content[0].text, "ok");
  });

  test("failing warmup is logged and does not block the account", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { warmup: { tool: "does_not_exist" } })] });
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
  });
});

describe("interactive-login detection", () => {
  const auth = { match: "Starting authentication flow", message: 'Account "{account}" needs re-authentication.' };

  test("an upstream that wants a login fails the call fast with an actionable message", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: auth, accounts: { a: { env: {} }, b: { env: { FAKE_AUTH_HANG: "1" } } } })] });
    const t0 = Date.now();
    const res = await r.call("echo", { account: "b", text: "x" });
    assert.ok(Date.now() - t0 < 4000, "no 5 minute hang");
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'Account "b" needs re-authentication.');
    const again = Date.now();
    const second = await r.call("echo", { account: "b", text: "x" });
    assert.ok(Date.now() - again < 1000, "failure is cached");
    assert.equal(second.result.content[0].text, 'Account "b" needs re-authentication.');
    assert.equal((await r.call("echo", { account: "a", text: "ok" })).result.content[0].text, "ok", "other accounts unaffected");
  });

  test("detection also covers the warmup call", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: auth, warmup: { tool: "whoami" }, accounts: { a: { env: {} }, b: { env: { FAKE_AUTH_HANG: "1" } } } })] });
    const t0 = Date.now();
    const res = await r.call("echo", { account: "b", text: "x" });
    assert.ok(Date.now() - t0 < 4000);
    assert.match(res.result.content[0].text, /needs re-authentication/);
  });

  test("an account whose token the upstream deleted keeps the actionable message instead of 'Unknown account'", async () => {
    const root = fs.mkdtempSync(path.join(TMP, "scan-"));
    fs.writeFileSync(path.join(root, "tokens.json"), "{}");
    fs.mkdirSync(path.join(root, "profiles", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "profiles", "b", "tokens.json"), "{}");
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: auth, env: { FAKE_AUTH_HANG: "1", FAKE_CLEAR_ROOT: root }, accounts: { root, marker: "tokens.json", profilesDir: "profiles" } })] });
    assert.deepEqual((await r.tools())[0].inputSchema.properties.account.enum, ["a", "b"]);
    const first = await r.call("echo", { account: "b", text: "x" });
    assert.match(first.result.content[0].text, /needs re-authentication/);
    assert.ok(!fs.existsSync(path.join(root, "profiles", "b", "tokens.json")), "fake upstream removed the token file");
    const second = await r.call("echo", { account: "b", text: "x" });
    assert.match(second.result.content[0].text, /needs re-authentication/);
  });

  test("a login request reported inside the tool result (resultMatch) is turned into the actionable message", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: { resultMatch: "ACTION REQUIRED", message: 'Account "{account}" needs a login.' }, accounts: { a: { env: {} }, b: { env: { FAKE_AUTH_RESULT: "1" } } } })] });
    const first = await r.call("echo", { account: "b", text: "x" });
    assert.equal(first.result.isError, true);
    assert.equal(first.result.content[0].text, 'Account "b" needs a login.');
    const t0 = Date.now();
    const second = await r.call("echo", { account: "b", text: "x" });
    assert.equal(second.result.content[0].text, 'Account "b" needs a login.');
    assert.ok(Date.now() - t0 < 500, "cached, no respawn");
    assert.match(r.log(), /auth required fk b/);
    assert.equal((await r.call("echo", { account: "a", text: "ok" })).result.content[0].text, "ok");
  });

  test("a successful result that mentions the phrase is left alone", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: { resultMatch: "ACTION REQUIRED", message: "login" } })] });
    assert.equal((await r.call("echo", { account: "a", text: "ACTION REQUIRED in a document" })).result.content[0].text, "ACTION REQUIRED in a document");
  });

  test("ordinary stderr output does not trigger it", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: auth })] });
    assert.equal((await r.call("echo", { account: "b", text: "fine" })).result.content[0].text, "fine");
  });
});

describe("multiple upstreams", () => {
  test("colliding names are prefixed, unique names are not", async () => {
    const r = await startRouter({ upstreams: [fake("one", { env: { FAKE_EXTRA: "only_one" } }), fake("two", { accounts: ["x"], defaultAccount: "x", env: { FAKE_EXTRA: "only_two" } })] });
    const names = (await r.tools()).map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(names.includes("one__whoami") && names.includes("two__whoami"));
    assert.ok(!names.includes("whoami"));
    assert.ok(names.includes("only_one") && names.includes("only_two"));
  });

  test("selector enum and routing follow the owning upstream", async () => {
    const r = await startRouter({ upstreams: [fake("one"), fake("two", { accounts: ["x"], defaultAccount: "x", env: { FAKE_USER: "two-user" } })] });
    const tools = await r.tools();
    assert.deepEqual(tools.find((t) => t.name === "one__echo").inputSchema.properties.account.enum, ["a", "b"]);
    assert.deepEqual(tools.find((t) => t.name === "two__echo").inputSchema.properties.account.enum, ["x"]);
    assert.equal((await r.who("two__whoami")).user, "two-user");
    assert.equal((await r.who("one__whoami", { account: "b" })).profile, "b");
    assert.match((await r.call("two__whoami", { account: "a" })).result.content[0].text, /Unknown account "a". Available: x/);
  });

  test("policy applies per upstream using the upstream's own tool name", async () => {
    const r = await startRouter({ upstreams: [fake("one", { policy: { a: { deny: ["echo"] } } }), fake("two")] });
    assert.match((await r.call("one__echo", { account: "a", text: "x" })).result.content[0].text, /not permitted/);
    assert.equal((await r.call("one__echo", { account: "b", text: "x" })).result.content[0].text, "x");
    assert.equal((await r.call("two__echo", { account: "a", text: "x" })).result.content[0].text, "x");
  });

  test("duplicate or invalid upstream names fail fast", async () => {
    const r = await startRouter({ upstreams: [fake("same"), fake("same")] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /unique names/);
  });

  test("per-account env and {account} substitution reach the child", async () => {
    const r = await startRouter({ upstreams: [fake("fk", { profileEnv: null, accounts: { a: { env: { FAKE_USER: "ua-{account}" } }, b: { env: { FAKE_USER: "ub-{account}" } } } })] });
    assert.equal((await r.who("whoami", { account: "b" })).user, "ub-b");
    assert.equal((await r.who("whoami", { account: "a" })).user, "ua-a");
  });
});

describe("failure handling", () => {
  test("an upstream that cannot start does not take the others down", async () => {
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("good"), fake("bad", { env: { FAKE_FAIL_START: "1" } })] });
    const names = (await r.tools()).map((t) => t.name);
    assert.ok(names.includes("whoami"), "good upstream tools are served unprefixed");
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
    assert.match(r.log(), /upstream unavailable bad/);
  });

  test("router exits when no upstream is available", async () => {
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [fake("bad", { env: { FAKE_FAIL_START: "1" } })] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /no upstream available/);
  });

  test("child crash mid-call errors out fast and the account recovers", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    const before = await r.who("whoami", { account: "b" });
    const t0 = Date.now();
    const res = await r.call("crash", { account: "b" });
    assert.ok(Date.now() - t0 < 5000, "no hang");
    assert.ok(res.error || res.result?.isError, "caller sees an error");
    const after = await r.who("whoami", { account: "b" });
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.profile, "b");
  });

  test("slow start beyond the connect timeout fails the call, then recovers after the failure TTL", async () => {
    const r = await startRouter({ connectTimeoutMs: 500, failTtlMs: 600, upstreams: [fake("fk", { accounts: { a: { env: {} }, b: { env: { FAKE_START_DELAY: "1500" } } } })] });
    const first = await r.call("whoami", { account: "b" });
    assert.equal(first.result.isError, true);
    assert.match(first.result.content[0].text, /Failed to start account "b"/);
    const cached = await r.call("whoami", { account: "b" });
    assert.equal(cached.result.isError, true, "failure is cached for the TTL");
    assert.equal((await r.who("whoami", { account: "a" })).profile, null, "other accounts unaffected");
  });

  test("concurrent first calls share one child", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    const results = await Promise.all(Array.from({ length: 6 }, () => r.who("whoami", { account: "b" })));
    assert.equal(new Set(results.map((x) => x.pid)).size, 1);
  });

  test("a long call keeps its child alive past the idle timeout", async () => {
    const r = await startRouter({ idleMs: 300, upstreams: [fake("fk")] });
    const pid = (await r.who("whoami", { account: "b" })).pid;
    const slow = await r.call("sleep", { account: "b", ms: 900 });
    assert.equal(slow.result.content[0].text, "sleep");
    assert.equal((await r.who("whoami", { account: "b" })).pid, pid, "not killed while busy");
  });

  test("idle child is killed and respawned on the next call", async () => {
    const r = await startRouter({ idleMs: 300, upstreams: [fake("fk")] });
    const first = await r.who("whoami", { account: "b" });
    await new Promise((res) => setTimeout(res, 1000));
    assert.match(r.log(), /idle-kill fk b/);
    const second = await r.who("whoami", { account: "b" });
    assert.notEqual(second.pid, first.pid);
  });
});

describe("bearer auth", () => {
  const TOKEN = "t0ken-0123456789-abcdef-0123456789";
  const cfgFile = (mode, content = TOKEN + "\n") => { const f = path.join(TMP, `tok-${Math.random().toString(36).slice(2)}`); fs.writeFileSync(f, content, { mode }); fs.chmodSync(f, mode); return f; };
  const post = (r, authorization) => rawRequest(r.port, { headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Host: `[::1]:${r.port}`, ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });

  test("no token configured: requests need no Authorization header", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    assert.equal(await post(r), 200);
    assert.match(r.log(), /auth: none/);
  });

  test("token from tokenFile: missing, wrong and malformed credentials get 401", async () => {
    const r = await startRouter({ auth: { tokenFile: cfgFile(0o600) }, upstreams: [fake("fk")] });
    assert.match(r.log(), /auth: bearer/);
    assert.equal(await post(r), 401);
    assert.equal(await post(r, "Bearer wrong"), 401);
    assert.equal(await post(r, `Bearer ${TOKEN}x`), 401);
    assert.equal(await post(r, `Basic ${TOKEN}`), 401);
    assert.equal(await post(r, TOKEN), 401);
    assert.equal(await post(r, `Bearer ${TOKEN}`), 200);
    assert.equal(await post(r, `bearer ${TOKEN}`), 200, "scheme is case-insensitive");
  });

  test("401 carries WWW-Authenticate and does not reach the upstream", async () => {
    const r = await startRouter({ auth: { token: TOKEN }, upstreams: [fake("fk")] });
    const res = await fetch(r.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo", arguments: { text: "x" } } }) });
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /^Bearer/);
    assert.equal((await r.who("whoami", { account: "b" }).catch(() => null)), null, "unauthenticated helper cannot call either");
  });

  test("authenticated client works end to end", async () => {
    const r = await startRouter({ auth: { token: TOKEN }, upstreams: [fake("fk")] }, { token: TOKEN });
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b");
  });

  test("the legacy GW_ROUTER_TOKEN is ignored", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] }, { env: { GW_ROUTER_TOKEN: "old-token-0123456789abcdef" } });
    assert.equal(await post(r, "Bearer old-token-0123456789abcdef"), 200, "no auth is configured, so the legacy token changes nothing");
  });

  test("ACCTMUX_TOKEN overrides the config", async () => {
    const r = await startRouter({ auth: { token: TOKEN }, upstreams: [fake("fk")] }, { env: { ACCTMUX_TOKEN: "another-token-0123456789" } });
    assert.equal(await post(r, `Bearer ${TOKEN}`), 401);
    assert.equal(await post(r, "Bearer another-token-0123456789"), 200);
  });

  test("a token file readable by others is refused", async () => {
    const r = await startRouter({ auth: { tokenFile: cfgFile(0o644) }, upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /readable by others/);
  });

  test("a missing token file or a short token is refused", async () => {
    const missing = await startRouter({ auth: { tokenFile: path.join(TMP, "nope") }, upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await missing.exited, 0);
    const short = await startRouter({ auth: { token: "short" }, upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await short.exited, 0);
    assert.match(short.log(), /at least 16/);
  });
});

describe("unix socket listener", () => {
  test("serves alongside TCP, with mode 600", async () => {
    const socket = sockPath("both");
    const r = await startRouter({ socket, upstreams: [fake("fk")] });
    assert.equal((fs.statSync(socket).mode & 0o777), 0o600);
    const res = await unixPost(socket);
    assert.equal(res.status, 200);
    assert.equal(parseMessage(res.body).result.tools.length, 6);
    assert.equal((await r.tools()).length, 6, "TCP still works");
  });

  test("tcp:false serves only the socket", async () => {
    const socket = sockPath("only");
    const r = await startRouter({ tcp: false, socket, upstreams: [fake("fk")] });
    const call = await unixPost(socket, { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: { account: "b" } } }) });
    assert.equal(JSON.parse(parseMessage(call.body).result.content[0].text).profile, "b");
    await assert.rejects(new Promise((res, rej) => net.connect(r.port, "::1").once("connect", res).once("error", rej)), /ECONNREFUSED/);
  });

  test("Host header is not required on the socket, Origin and content type still are", async () => {
    const socket = sockPath("hdr");
    await startRouter({ tcp: false, socket, upstreams: [fake("fk")] });
    assert.equal((await unixPost(socket, { headers: { Host: "localhost" } })).status, 200);
    assert.equal((await unixPost(socket, { headers: { Origin: "http://evil.example" } })).status, 403);
    assert.equal((await unixPost(socket, { headers: { "Content-Type": "text/plain" } })).status, 403);
  });

  test("bearer auth applies on the socket too", async () => {
    const socket = sockPath("auth");
    await startRouter({ tcp: false, socket, auth: { token: "socket-token-0123456789" }, upstreams: [fake("fk")] });
    assert.equal((await unixPost(socket)).status, 401);
    assert.equal((await unixPost(socket, { headers: { Authorization: "Bearer socket-token-0123456789" } })).status, 200);
  });

  test("a stale socket file from a killed router is reclaimed", async () => {
    const socket = sockPath("stale");
    const first = await startRouter({ tcp: false, socket, upstreams: [fake("fk")] });
    first.proc.kill("SIGKILL");
    await first.exited;
    assert.ok(fs.existsSync(socket), "SIGKILL leaves the file behind");
    await startRouter({ tcp: false, socket, upstreams: [fake("fk")] });
    assert.equal((await unixPost(socket)).status, 200);
  });

  test("a socket held by a live router is not taken over", async () => {
    const socket = sockPath("busy");
    await startRouter({ tcp: false, socket, upstreams: [fake("fk")] });
    const second = await startRouter({ tcp: false, socket, upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await second.exited, 0);
    assert.match(second.log(), /in use by another process/);
    assert.equal((await unixPost(socket)).status, 200, "first router unaffected");
  });

  test("a regular file at the socket path is never deleted", async () => {
    const socket = sockPath("file");
    fs.writeFileSync(socket, "precious");
    const r = await startRouter({ tcp: false, socket, upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /not a socket/);
    assert.equal(fs.readFileSync(socket, "utf8"), "precious");
  });

  test("SIGTERM removes the socket file", async () => {
    const socket = sockPath("term");
    const r = await startRouter({ tcp: false, socket, upstreams: [fake("fk")] });
    r.proc.kill("SIGTERM");
    assert.equal(await r.exited, 0);
    assert.ok(!fs.existsSync(socket));
  });

  test("tcp:false without a socket is refused", async () => {
    const r = await startRouter({ tcp: false, upstreams: [fake("fk")] }, { expectReady: false });
    assert.notEqual(await r.exited, 0);
    assert.match(r.log(), /nothing to listen on/);
  });
});

describe("prompts and resources", () => {
  const withRes = (name, extra = {}) => fake(name, { env: { FAKE_RESOURCES: "1" }, ...extra });
  const wrap = (up, account, uri) => `acctmux://${up}/${account}/${encodeURIComponent(uri)}`;

  test("nothing is advertised when no upstream has them", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    const init = await r.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.result.capabilities.prompts, undefined);
    assert.equal(init.result.capabilities.resources, undefined);
    assert.ok((await r.rpc("resources/list")).error);
  });

  test("capabilities are advertised and prompts are forwarded", async () => {
    const r = await startRouter({ upstreams: [withRes("fk")] });
    const init = await r.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.ok(init.result.capabilities.prompts && init.result.capabilities.resources);
    const prompts = (await r.rpc("prompts/list")).result.prompts;
    assert.deepEqual(prompts.map((p) => p.name), ["greet"]);
    const got = await r.rpc("prompts/get", { name: "greet", arguments: { who: "Roy" } });
    assert.equal(got.result.messages[0].content.text, "hi Roy from default");
  });

  test("a child started by resources/list is idle-killed like any other", async () => {
    const r = await startRouter({ idleMs: 300, upstreams: [withRes("fk")] });
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal((r.log().match(/idle-kill fk a/g) ?? []).length, 1, "startup child is killed once");
    await r.rpc("resources/list");
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal((r.log().match(/idle-kill fk a/g) ?? []).length, 2, "the respawned child is killed again");
    await r.rpc("prompts/get", { name: "greet" });
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal((r.log().match(/idle-kill fk a/g) ?? []).length, 3, "the child respawned by prompts/get is killed too");
  });

  test("colliding prompt names are prefixed per upstream", async () => {
    const r = await startRouter({ upstreams: [withRes("one"), withRes("two", { profileEnv: null, defaultAccount: "x", accounts: { x: { env: { FAKE_PROFILE: "x" } } } })] });
    const names = (await r.rpc("prompts/list")).result.prompts.map((p) => p.name).sort();
    assert.deepEqual(names, ["one__greet", "two__greet"]);
    assert.match((await r.rpc("prompts/get", { name: "two__greet" })).result.messages[0].content.text, /from x$/);
    assert.ok((await r.rpc("prompts/get", { name: "greet" })).error);
  });

  test("resources/list shows the default account with namespaced URIs and pages through cursors", async () => {
    const r = await startRouter({ upstreams: [withRes("fk")] });
    const first = (await r.rpc("resources/list")).result;
    assert.deepEqual(first.resources.map((x) => x.uri), [wrap("fk", "a", "fake:///default/doc1")]);
    assert.ok(first.nextCursor);
    const second = (await r.rpc("resources/list", { cursor: first.nextCursor })).result;
    assert.deepEqual(second.resources.map((x) => x.uri), [wrap("fk", "a", "fake:///default/doc2")]);
    assert.equal(second.nextCursor, undefined);
    assert.ok((await r.rpc("resources/list", { cursor: "!!!" })).error, "bad cursor rejected");
  });

  test("resources/read routes to the account named in the URI", async () => {
    const r = await startRouter({ upstreams: [withRes("fk")] });
    const uri = wrap("fk", "b", "fake:///b/doc1");
    const res = (await r.rpc("resources/read", { uri })).result;
    assert.equal(res.contents[0].uri, uri);
    assert.equal(res.contents[0].text, "body of fake:///b/doc1 read by b");
    assert.match((await r.rpc("resources/read", { uri: wrap("fk", "zzz", "fake:///x") })).error.message, /Unknown account "zzz"/);
    assert.match((await r.rpc("resources/read", { uri: "file:///etc/passwd" })).error.message, /Unknown resource/);
    assert.match((await r.rpc("resources/read", { uri: wrap("nope", "a", "fake:///x") })).error.message, /Unknown resource/);
  });

  test("policy gates prompts and resources like tools", async () => {
    const r = await startRouter({ upstreams: [withRes("fk", { policy: { "*": { allow: ["whoami"] }, a: { allow: ["whoami", "resources/list"] } } })] });
    assert.equal((await r.rpc("resources/list")).result.resources.length, 1, "explicitly allowed for the default account");
    assert.match((await r.rpc("resources/read", { uri: wrap("fk", "b", "fake:///b/doc1") })).error.message, /not permitted/);
    assert.match((await r.rpc("resources/read", { uri: wrap("fk", "a", "fake:///a/doc1") })).error.message, /not permitted/, "resources/read is not in a's allow list");
    assert.deepEqual((await r.rpc("prompts/list")).result.prompts, [], "prompts/get not allowed for the default account");
    const deny = await startRouter({ upstreams: [withRes("fk", { policy: { "*": { deny: ["resources/read"] } } })] });
    assert.match((await deny.rpc("resources/read", { uri: wrap("fk", "a", "fake:///a") })).error.message, /not permitted/);
    assert.equal((await deny.rpc("resources/list")).result.resources.length, 1);
  });

  test("an upstream without resources is skipped while others are listed", async () => {
    const r = await startRouter({ upstreams: [fake("plain"), withRes("fk")] });
    const uris = (await r.rpc("resources/list")).result.resources.map((x) => x.uri);
    assert.deepEqual(uris, [wrap("fk", "a", "fake:///default/doc1")]);
  });
});

describe("http hardening", () => {
  let r;
  before(async () => { r = await startRouter({ maxBody: 2048, upstreams: [fake("fk")] }); });
  const json = { "Content-Type": "application/json" };
  const ok = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  test("only POST /mcp is served", async () => {
    assert.equal(await rawRequest(r.port, { method: "GET", headers: { Host: `[::1]:${r.port}` } }), 405);
    const code = await new Promise((res) => http.get({ host: "::1", port: r.port, path: "/other" }, (x) => { x.resume(); res(x.statusCode); }));
    assert.equal(code, 404);
  });

  test("browser Origin header is refused", async () => {
    assert.equal(await rawRequest(r.port, { headers: { ...json, Origin: "http://evil.example" }, body: ok }), 403);
  });

  test("foreign Host header is refused (DNS rebinding)", async () => {
    assert.equal(await rawRequest(r.port, { headers: { ...json, Host: "evil.example:80" }, body: ok }), 403);
  });

  test("non-JSON content type is refused", async () => {
    assert.equal(await rawRequest(r.port, { headers: { "Content-Type": "text/plain" }, body: ok }), 403);
  });

  test("invalid JSON gets 400", async () => {
    assert.equal(await rawRequest(r.port, { headers: json, body: "{nope" }), 400);
  });

  test("oversized body gets 413 and the router survives", async () => {
    const code = await rawRequest(r.port, { headers: json, body: "x".repeat(8192) });
    assert.ok(code === 413 || code === 0);
    assert.equal((await r.tools()).length, 6);
  });
});

describe("account pools", () => {
  const QUOTA = "Error: usage limit exceeded for this API key";
  const P = (o = {}) => ({ members: ["a", "b", "c"], failoverMatch: "usage limit exceeded", tools: ["whoami", "echo", "sleep", "crash"], ...o });
  const files = () => { const d = fs.mkdtempSync(path.join(TMP, "pool-")); return { a: path.join(d, "a"), b: path.join(d, "b"), c: path.join(d, "c") }; };
  const up = (f, pools, extra = {}) => fake("fk", { accounts: { a: { env: { FAKE_ERROR_FILE: f.a } }, b: { env: { FAKE_ERROR_FILE: f.b } }, c: { env: { FAKE_ERROR_FILE: f.c } } }, pools, ...extra });
  const prof = async (r, args = {}) => (await r.who("whoami", { account: "p", ...args })).profile ?? "a";
  const pause = (ms) => new Promise((res) => setTimeout(res, ms));
  const served = async (r, pool = "p") => { await pause(100); return [...r.log().matchAll(new RegExp(`pool fk ${pool} -> (\\w+)`, "g"))].map((m) => m[1]); };
  const count = (list, m) => list.filter((x) => x === m).length;

  test("a member that cannot start is skipped within the same call", async () => {
    const f = files();
    const r = await startRouter({ connectTimeoutMs: 3000, upstreams: [up(f, { p: P({ members: ["b", "c"] }) }, { accounts: { a: { env: {} }, b: { env: { FAKE_FAIL_START: "1" } }, c: { env: { FAKE_ERROR_FILE: f.c } } } })] });
    assert.equal(await prof(r), "c");
    assert.deepEqual(await served(r), ["b", "c"], "b was tried first, never reached upstream, then c served");
  });

  test("a login failure that happens mid-call is not rotated to another member", async () => {
    const f = files();
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: { resultMatch: "ACTION REQUIRED", message: 'Account "{account}" needs a login.' }, defaultAccount: "a", accounts: { a: { env: {} }, b: { env: { FAKE_AUTH_RESULT: "1" } }, c: { env: { FAKE_ERROR_FILE: f.c } } }, pools: { p: P({ members: ["b", "c"], tools: ["whoami"] }) } })] });
    const res = await r.call("echo", { account: "p", text: "x" });
    assert.equal(res.result.isError, true);
    assert.equal(res.result.content[0].text, 'Account "b" needs a login.');
    assert.deepEqual(await served(r), ["b"], "echo is not in pool.tools, so it must not run on c after reaching b");
  });

  test("a login failure mid-call moves on to the next member when the tool is in pool.tools", async () => {
    const f = files();
    const r = await startRouter({ upstreams: [fake("fk", { authRequired: { resultMatch: "ACTION REQUIRED", message: 'Account "{account}" needs a login.' }, defaultAccount: "a", accounts: { a: { env: {} }, b: { env: { FAKE_AUTH_RESULT: "1" } }, c: { env: { FAKE_ERROR_FILE: f.c } } }, pools: { p: P({ members: ["b", "c"], tools: ["whoami"] }) } })] });
    assert.equal(await prof(r), "c");
    assert.equal(await prof(r), "c", "b stays out while its failure is cached");
  });

  test("selector enum lists pool names after accounts, described, and a pool can be the default", async () => {
    const r = await startRouter({ upstreams: [up(files(), { p: P() }, { defaultAccount: "p" })] });
    const sel = (await r.tools())[0].inputSchema.properties.account;
    assert.deepEqual(sel.enum, ["a", "b", "c", "p"]);
    assert.equal(sel.default, "p");
    assert.match(sel.description, /"p" \(round-robin over a, b, c\)/);
    const seq = [];
    for (let i = 0; i < 3; i++) seq.push((await r.who("whoami")).profile ?? "a");
    assert.deepEqual(seq, ["a", "b", "c"], "omitted selector goes through the pool");
    assert.equal((await r.who("whoami", { account: "b" })).profile, "b", "plain accounts still route directly");
  });

  test("round-robin spreads calls over the members", async () => {
    const r = await startRouter({ upstreams: [up(files(), { p: P() })] });
    const seq = [];
    for (let i = 0; i < 6; i++) seq.push(await prof(r));
    assert.deepEqual(seq, ["a", "b", "c", "a", "b", "c"]);
  });

  test("sticky stays on one member until it fails over, then stays on the next", async () => {
    const f = files();
    const r = await startRouter({ upstreams: [up(f, { p: P({ strategy: "sticky" }) })] });
    assert.deepEqual([await prof(r), await prof(r), await prof(r)], ["a", "a", "a"]);
    fs.writeFileSync(f.a, QUOTA);
    assert.equal(await prof(r), "b");
    fs.rmSync(f.a);
    assert.deepEqual([await prof(r), await prof(r)], ["b", "b"]);
  });

  test("a matching quota error cools the member and the call is retried on the next one", async () => {
    const f = files();
    fs.writeFileSync(f.a, QUOTA);
    const r = await startRouter({ upstreams: [up(f, { p: P() })] });
    const first = await r.call("whoami", { account: "p" });
    assert.equal(first.result.isError, undefined);
    assert.equal(JSON.parse(first.result.content[0].text).profile, "b");
    assert.deepEqual([await prof(r), await prof(r), await prof(r)], ["b", "c", "b"], "a is skipped while cooling");
    assert.equal(count(await served(r), "a"), 1, "the cooling member is not called again");
    assert.match(r.log(), /pool fk p a quota exhausted, cooling down until \S+ - rotating/);
  });

  test("a non-matching error is returned as is, not retried, and does not cool the member", async () => {
    const f = files();
    fs.writeFileSync(f.a, "Drive exploded");
    const r = await startRouter({ upstreams: [up(f, { p: P() })] });
    const first = await r.call("whoami", { account: "p" });
    assert.equal(first.result.isError, true);
    assert.equal(first.result.content[0].text, "Drive exploded");
    assert.deepEqual(await served(r), ["a"]);
    assert.deepEqual([await prof(r), await prof(r)], ["b", "c"]);
    assert.equal((await r.call("whoami", { account: "p" })).result.content[0].text, "Drive exploded", "a is still in rotation");
    assert.doesNotMatch(r.log(), /cooling/);
  });

  test("a tool outside the pool's tools list is not retried, but the member still cools", async () => {
    const f = files();
    fs.writeFileSync(f.a, QUOTA);
    const r = await startRouter({ upstreams: [up(f, { p: P({ tools: ["whoami"] }) })] });
    const first = await r.call("echo", { account: "p", text: "x" });
    assert.equal(first.result.isError, true);
    assert.equal(first.result.content[0].text, QUOTA);
    assert.deepEqual(await served(r), ["a"]);
    assert.match(r.log(), /a quota exhausted, cooling down until \S+ - not retried/);
    assert.equal((await r.call("echo", { account: "p", text: "x" })).result.content[0].text, "x");
    assert.deepEqual([await prof(r), await prof(r)], ["c", "b"], "a skipped while cooling");
  });

  test("when every member is exhausted the error says so and when the earliest recovers", async () => {
    const f = files();
    for (const k of ["a", "b", "c"]) fs.writeFileSync(f[k], QUOTA);
    const r = await startRouter({ upstreams: [up(f, { p: P({ cooldownMs: 120000 }) })] });
    const res = await r.call("whoami", { account: "p" });
    assert.equal(res.result.isError, true);
    const text = res.result.content[0].text;
    assert.match(text, /^All members of pool "p" \(a, b, c\) are cooling down after quota errors\. The earliest, "a", recovers at \d{4}-\d\d-\d\dT[\d:.]+Z \(in 1[12]\d s\)\./);
    assert.match(text, /Last error \(from "c"\): Error: usage limit exceeded/);
    assert.deepEqual(await served(r), ["a", "b", "c"]);
    const t0 = Date.now();
    const again = await r.call("whoami", { account: "p" });
    assert.ok(Date.now() - t0 < 500);
    assert.match(again.result.content[0].text, /^All members of pool "p"/);
    assert.equal((await served(r)).length, 3, "no member is called while all are cooling");
  });

  test("after the cooldown exactly one call probes the member (half-open); success closes it", async () => {
    const f = files();
    fs.writeFileSync(f.a, QUOTA);
    const r = await startRouter({ upstreams: [up(f, { p: P({ members: ["a", "b"], cooldownMs: 300 }) })] });
    assert.equal(await prof(r), "b");
    fs.rmSync(f.a);
    await pause(400);
    const results = await Promise.all(Array.from({ length: 4 }, () => r.call("sleep", { account: "p", ms: 600 })));
    assert.ok(results.every((x) => x.result.content[0].text === "sleep"));
    const after = (await served(r)).slice(2);
    assert.equal(count(after, "a"), 1, "one probe only");
    assert.equal(count(after, "b"), 3);
    assert.match(r.log(), /pool fk p -> a sleep \(half-open probe\)/);
    assert.match(r.log(), /pool fk p a recovered/);
    assert.deepEqual([await prof(r), await prof(r)], ["b", "a"], "a is back in normal rotation");
  });

  test("a failed half-open probe cools the member again and the call moves on", async () => {
    const f = files();
    fs.writeFileSync(f.a, QUOTA);
    const r = await startRouter({ upstreams: [up(f, { p: P({ members: ["a", "b"], cooldownMs: 300 }) })] });
    assert.equal(await prof(r), "b");
    await pause(400);
    assert.equal(await prof(r), "b", "start index b");
    assert.equal(await prof(r), "b", "probe of a failed, retried on b");
    assert.match(r.log(), /-> a whoami \(half-open probe\)/);
    assert.equal(count(await served(r), "a"), 2);
    assert.equal(await prof(r), "b");
    assert.equal(await prof(r), "b", "a cooling again, not called");
    assert.equal(count(await served(r), "a"), 2);
  });

  test("policy applies to the pool name (falling back to *) and to each member", async () => {
    const f = files();
    const r = await startRouter({ upstreams: [up(f, { p: P(), q: P({ members: ["a", "b"] }) }, {
      policy: { "*": { deny: ["sleep"] }, p: { deny: ["echo"] }, a: { deny: ["whoami", "status"] }, b: { deny: ["status"] } },
    })] });
    assert.match((await r.call("echo", { account: "p", text: "x" })).result.content[0].text, /not permitted for pool "p"/);
    assert.equal((await r.call("echo", { account: "q", text: "x" })).result.content[0].text, "x", "q has no echo deny");
    assert.equal((await r.call("echo", { account: "a", text: "x" })).result.content[0].text, "x");
    for (const pool of ["p", "q"]) {
      assert.match((await r.call("sleep", { account: pool, ms: 1 })).result.content[0].text, /Unknown tool|not permitted/, `* deny applies to pool ${pool}, also when the pool has its own entry`);
    }
    assert.deepEqual([await prof(r), await prof(r), await prof(r)], ["b", "b", "c"], "the counter starts at a, which denies whoami and is skipped; denied calls do not advance it");
    assert.match((await r.call("status", { account: "q" })).result.content[0].text, /not permitted for any member of pool "q"/);
  });

  test("invalid pool configs are refused at startup", async () => {
    const bad = [
      [{ a: P() }, /pool "a": name collides with an account/],
      [{ p: P({ tools: undefined }) }, /pool "p": tools must list/],
      [{ p: P({ tools: [] }) }, /pool "p": tools must list/],
      [{ p: P({ members: ["a", "zzz"] }) }, /unknown member account "zzz"/],
      [{ p: P({ members: [] }) }, /members must be a non-empty list/],
      [{ p: P({ members: ["a", "q"] }), q: P() }, /member "q" is a pool; pools cannot be nested/],
      [{ p: P({ strategy: "random" }) }, /strategy must be/],
      [{ p: P({ failoverMatch: undefined }) }, /failoverMatch .*is required/],
      [{ p: P({ failoverMatch: "(" }) }, /failoverMatch is not a valid regex/],
      [{ p: P({ cooldownMs: -1 }) }, /cooldownMs must be a positive number/],
    ];
    await Promise.all(bad.map(async ([pools, re]) => {
      const r = await startRouter({ upstreams: [up(files(), pools)] }, { expectReady: false });
      assert.notEqual(await r.exited, 0, String(re));
      assert.match(r.log(), re);
    }));
  });

  test("concurrent calls: per-pool counters spread evenly and a cooling member is never stampeded", async () => {
    const f = files();
    const r = await startRouter({ upstreams: [up(f, { p: P(), q: P({ members: ["a", "b"] }) })] });
    const nine = await Promise.all(Array.from({ length: 9 }, () => prof(r)));
    for (const m of ["a", "b", "c"]) assert.equal(count(nine, m), 3);
    assert.equal(await prof(r, { account: "q" }), "a", "q keeps its own counter");
    fs.writeFileSync(f.a, QUOTA);
    assert.equal(await prof(r), "b", "a's turn, failed over to b");
    const before = count(await served(r), "a");
    const many = await Promise.all(Array.from({ length: 12 }, () => prof(r)));
    assert.equal(count(many, "a"), 0);
    assert.equal(count(await served(r), "a"), before, "no call reached the cooling member");
  });

  test("timeouts and crashes are not retried; a member that fails to start is skipped by later calls", async () => {
    const f = files();
    const r = await startRouter({ upstreams: [up(f, { p: P() })] });
    const res = await r.call("crash", { account: "p" });
    assert.ok(res.error || res.result?.isError);
    assert.deepEqual(await served(r), ["a"], "crash was not retried on b");
    const r2 = await startRouter({ connectTimeoutMs: 2000, upstreams: [fake("fk", { accounts: { a: { env: {} }, b: { env: { FAKE_FAIL_START: "1" } }, c: { env: {} } }, pools: { p: P() } })] });
    assert.equal(await prof(r2), "a");
    assert.equal(await prof(r2), "c", "b's start failure never reached upstream, so the call moves on to c");
    assert.deepEqual([await prof(r2), await prof(r2), await prof(r2)], ["c", "a", "c"], "b skipped while its failure is cached");
  });
});

describe("usage-aware pools", () => {
  const pause = (ms) => new Promise((res) => setTimeout(res, ms));
  async function usageServer(used, { status = 200 } = {}) {
    const hits = [];
    const srv = http.createServer((req, res) => {
      const key = (req.headers.authorization ?? "").replace("Bearer ", "");
      hits.push(key);
      if (status !== 200) { res.writeHead(status).end("{}"); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ account: { plan_usage: used[key] ?? 0, plan_limit: 100 } }));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    running.push({ kill: () => srv.close() });
    return { url: `http://127.0.0.1:${srv.address().port}/usage`, hits };
  }
  const setup = (used) => {
    const d = fs.mkdtempSync(path.join(TMP, "usage-"));
    for (const m of ["a", "b", "c"]) fs.writeFileSync(path.join(d, `k-${m}.key`), `key-${m}`);
    return { d, used };
  };
  const pool = (d, url, o = {}, uo = {}) => fake("fk", {
    accounts: ["a", "b", "c"],
    pools: { p: { members: ["a", "b", "c"], failoverMatch: "never", tools: ["whoami"], usage: { url, keyFile: path.join(d, "k-{account}.key"), used: "account.plan_usage", limit: "account.plan_limit", ...uo }, ...o } },
  });
  const prof = async (r) => (await r.who("whoami", { account: "p" })).profile ?? "a";

  test("a pool key file readable by other users is warned about, without printing the key", async () => {
    const { d } = setup();
    fs.chmodSync(path.join(d, "k-a.key"), 0o644);
    for (const m of ["b", "c"]) fs.chmodSync(path.join(d, `k-${m}.key`), 0o600);
    const u = await usageServer({});
    const r = await startRouter({ upstreams: [pool(d, u.url, { strategy: "most-remaining" })] });
    await prof(r);
    await pause(100);
    assert.match(r.log(), /warning: .*k-a\.key is readable by other users/);
    assert.doesNotMatch(r.log(), /k-[bc]\.key is readable/);
    assert.doesNotMatch(r.log(), /key-a/);
  });

  test("most-remaining picks the member with the most credits left", async () => {
    const { d } = setup();
    const u = await usageServer({ "key-a": 60, "key-b": 10, "key-c": 40 });
    const r = await startRouter({ upstreams: [pool(d, u.url, { strategy: "most-remaining" })] });
    assert.equal(await prof(r), "b");
  });

  test("members at or above skipAbovePct are skipped by round-robin", async () => {
    const { d } = setup();
    const u = await usageServer({ "key-a": 96, "key-b": 0, "key-c": 0 });
    const r = await startRouter({ upstreams: [pool(d, u.url)] });
    const seq = [];
    for (let i = 0; i < 4; i++) seq.push(await prof(r));
    assert.ok(!seq.includes("a"), `a is above 95%: ${seq}`);
    assert.ok(seq.includes("b") && seq.includes("c"));
  });

  test("usage is looked up lazily and shared: nothing before the first pool call, one request per member, none again within ttlMs", async () => {
    const { d } = setup();
    const u = await usageServer({});
    const r = await startRouter({ upstreams: [pool(d, u.url)] });
    await pause(200);
    assert.equal(u.hits.length, 0, "no requests while idle");
    for (let i = 0; i < 6; i++) await prof(r);
    assert.deepEqual([...u.hits].sort(), ["key-a", "key-b", "key-c"]);
  });

  test("an expired ttlMs triggers a refresh on the next pool call only", async () => {
    const { d } = setup();
    const u = await usageServer({});
    const r = await startRouter({ upstreams: [pool(d, u.url, {}, { ttlMs: 1000 })] });
    await prof(r);
    assert.equal(u.hits.length, 3);
    await pause(1200);
    assert.equal(u.hits.length, 3, "nothing happens without a call");
    await prof(r);
    assert.equal(u.hits.length, 6);
  });

  test("calls add the estimated cost locally, so a member is skipped once it crosses the threshold", async () => {
    const { d } = setup();
    const u = await usageServer({ "key-a": 93, "key-b": 0, "key-c": 0 });
    const r = await startRouter({ upstreams: [pool(d, u.url, {}, { cost: 1, skipAbovePct: 95 })] });
    const seq = [];
    for (let i = 0; i < 15; i++) seq.push(await prof(r));
    assert.equal(seq.filter((x) => x === "a").length, 2, `a serves until it reaches 95: ${seq}`);
  });

  test("a failing usage endpoint does not block calls (fail open)", async () => {
    const { d } = setup();
    const u = await usageServer({}, { status: 500 });
    const r = await startRouter({ upstreams: [pool(d, u.url)] });
    assert.deepEqual([await prof(r), await prof(r), await prof(r)], ["a", "b", "c"]);
    assert.match(r.log(), /usage lookup failed: HTTP 500/);
  });

  test("the key never appears in the router log", async () => {
    const { d } = setup();
    const u = await usageServer({ "key-a": 1 });
    const r = await startRouter({ upstreams: [pool(d, u.url)] });
    await prof(r);
    assert.ok(!r.log().includes("key-a"), "no key in logs");
  });

  test("config validation: most-remaining needs usage, usage fields are checked", async () => {
    const { d } = setup();
    const base = (p) => ({ upstreams: [fake("fk", { accounts: ["a", "b", "c"], pools: { p: { members: ["a", "b"], failoverMatch: "x", tools: ["whoami"], ...p } } })] });
    const bad = async (p, re) => { const r = await startRouter(base(p), { expectReady: false }); assert.notEqual(await r.exited, 0); assert.match(r.log(), re); };
    await bad({ strategy: "most-remaining" }, /needs a usage block/);
    await bad({ usage: { url: "ftp://x", keyFile: "k", used: "a", limit: "b" } }, /usage\.url must be an http/);
    await bad({ usage: { url: "http://x", keyFile: "k", used: "a" } }, /usage\.limit must be a dot path/);
    await bad({ usage: { url: "http://x", keyFile: path.join(d, "k"), used: "a", limit: "b", skipAbovePct: 0 } }, /skipAbovePct is out of range/);
  });
});

describe("listen first", () => {
  const slow = (name, ms, extra = {}) => fake(name, { env: { FAKE_START_DELAY: String(ms), FAKE_EXTRA: `${name}_tool` }, ...extra });
  const post = (r, method, params = {}) => fetch(r.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

  test("the port opens before a slow upstream has loaded", async () => {
    const r = await startRouter({ upstreams: [slow("slow", 1500)] });
    assert.doesNotMatch(r.log(), /cached/);
    assert.ok((await r.tools()).length > 0);
    assert.match(r.log(), /cached \d+ tools from slow/);
  });

  test("after loadWaitMs a request is served from the upstreams that loaded, and the rest join later", async () => {
    const r = await startRouter({ loadWaitMs: 300, upstreams: [fake("fast"), slow("slow", 1500)] });
    const early = (await r.tools()).map((t) => t.name);
    assert.ok(early.includes("whoami") && !early.includes("slow_tool"), early.join());
    await new Promise((res) => setTimeout(res, 1800));
    const later = (await r.tools()).map((t) => t.name);
    assert.ok(later.includes("slow_tool") && later.includes("fast__whoami"), later.join());
  });

  test("with nothing loaded after loadWaitMs a request gets 503 with Retry-After, then works", async () => {
    const r = await startRouter({ loadWaitMs: 200, upstreams: [slow("slow", 1500)] });
    const res = await post(r, "tools/list");
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    await new Promise((res2) => setTimeout(res2, 1800));
    assert.equal((await post(r, "tools/list")).status, 200);
  });

  test("the router exits 1 only when every upstream has failed", async () => {
    const r = await startRouter({ upstreams: [fake("a", { env: { FAKE_FAIL_START: "1" } }), fake("b", { env: { FAKE_FAIL_START: "1" } })] });
    assert.equal(await r.exited, 1);
    assert.match(r.log(), /no upstream available/);
    const ok = await startRouter({ upstreams: [fake("a", { env: { FAKE_FAIL_START: "1" } }), fake("b")] });
    assert.ok((await ok.tools()).length > 0);
    assert.equal(ok.proc.exitCode, null);
  });
});

describe("protocol eras", () => {
  const slow = (name, ms) => fake(name, { env: { FAKE_START_DELAY: String(ms), FAKE_EXTRA: `${name}_tool` } });
  const connect = async (r, options = {}) => {
    const client = new Client({ name: "t", version: "1" }, options);
    await client.connect(new StreamableHTTPClientTransport(new URL(r.url)));
    running.push({ kill: () => client.close().catch(() => {}) });
    return client;
  };
  const text = (res) => JSON.parse(res.content[0].text);

  test("a 2026-07-28 client negotiates the modern era and lists and calls tools", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    const client = await connect(r, { versionNegotiation: { mode: "auto" } });
    assert.equal(client.getProtocolEra(), "modern");
    assert.equal((await client.listTools()).tools.length, 6);
    assert.equal(text(await client.callTool({ name: "whoami", arguments: { account: "b" } })).profile, "b");
  });

  test("a 2025-era client still works through the stateless fallback", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    const client = await connect(r);
    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal((await client.listTools()).tools.length, 6);
    assert.equal(text(await client.callTool({ name: "whoami", arguments: { account: "a" } })).profile, null);
  });

  test("a listening 2026 client is told when a slow upstream finishes loading", async () => {
    const r = await startRouter({ loadWaitMs: 300, upstreams: [fake("fast"), slow("slow", 1500)] });
    let changed;
    const arrived = new Promise((res) => { changed = res; });
    const client = await connect(r, { versionNegotiation: { mode: "auto" }, listChanged: { tools: { onChanged: (err, tools) => { if (!err && tools?.some((t) => t.name === "slow_tool")) changed(tools); } } } });
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === "slow_tool"), "not loaded yet");
    const tools = await Promise.race([arrived, new Promise((_, rej) => setTimeout(() => rej(new Error("no list_changed")), 6000))]);
    assert.ok(tools.some((t) => t.name === "slow_tool"));
  });

  test("a client that gives up on a slow call cancels it in the child, in both eras", async () => {
    const file = path.join(TMP, "cancel.txt");
    fs.writeFileSync(file, "");
    const r = await startRouter({ upstreams: [fake("fk", { env: { FAKE_CANCEL_FILE: file } })] });
    const seen = () => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    const until = async (n) => { for (let i = 0; i < 60 && seen() < n; i++) await new Promise((res) => setTimeout(res, 50)); return seen(); };
    // 2025 era: the client drops the connection (a separate notifications/cancelled is a documented gap)
    const ac = new AbortController();
    const slow = fetch(r.url, { method: "POST", signal: ac.signal, headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sleep", arguments: { account: "a", ms: 20000 } } }) }).catch(() => "aborted");
    await new Promise((res) => setTimeout(res, 500));
    ac.abort();
    assert.equal(await slow, "aborted");
    assert.equal(await until(1), 1, "2025 era: the child saw the cancellation");
    // 2026-07-28 era: aborting the request closes its stream
    const client = await connect(r, { versionNegotiation: { mode: "auto" } });
    const ac2 = new AbortController();
    const slow2 = client.callTool({ name: "sleep", arguments: { account: "a", ms: 20000 } }, { signal: ac2.signal }).catch(() => "aborted");
    await new Promise((res) => setTimeout(res, 500));
    ac2.abort();
    assert.equal(await slow2, "aborted");
    assert.equal(await until(2), 2, "2026 era: the child saw the cancellation");
  });

  test("the removed stateful options are reported and ignored", async () => {
    const r = await startRouter({ stateful: true, upstreams: [fake("fk")] });
    assert.match(r.log(), /"stateful" is no longer supported/);
    assert.equal((await r.tools()).length, 6);
  });

  test("only POST is served on /mcp", async () => {
    const r = await startRouter({ upstreams: [fake("fk")] });
    const res = await fetch(r.url, { method: "GET", headers: { Accept: "text/event-stream" } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });
});

describe("packaging files", () => {
  const ROOT = path.join(HERE, "..");
  const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

  test("the launchd plist is well-formed and uses only documented launchd.plist keys", () => {
    const xml = read("packaging/dev.acctmux.plist");
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1.0\/\/EN" "http:\/\/www.apple.com\/DTDs\/PropertyList-1.0.dtd">/);
    const body = xml.replace(/<!--[\s\S]*?-->/g, "");
    const tokens = [...body.matchAll(/<(\/?)(plist|dict|array|key|string|true|false)\b[^>]*?(\/?)>/g)];
    const stack = [];
    for (const [, close, tag, self] of tokens) {
      if (self || tag === "true" || tag === "false") continue;
      if (!close) stack.push(tag);
      else assert.equal(stack.pop(), tag, `unbalanced </${tag}>`);
    }
    assert.deepEqual(stack, []);
    const keys = [...body.matchAll(/<key>([^<]+)<\/key>/g)].map((m) => m[1]);
    const documented = new Set(["Label", "ProgramArguments", "EnvironmentVariables", "PATH", "RunAtLoad", "KeepAlive", "StandardErrorPath", "StandardOutPath", "WorkingDirectory", "ThrottleInterval"]);
    for (const k of keys) assert.ok(documented.has(k), `unknown launchd key ${k}`);
    for (const k of ["Label", "ProgramArguments", "RunAtLoad", "KeepAlive"]) assert.ok(keys.includes(k), `missing ${k}`);
    assert.match(body, /<key>Label<\/key><string>dev\.acctmux<\/string>/);
    const args = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(body)[1];
    assert.match(args, /node<\/string>\s*<string>[^<]*router\.mjs<\/string>/);
  });

  test("the Dockerfile copies files that exist, runs as non-root and starts the router in exec form", () => {
    const lines = read("packaging/Dockerfile").split("\n").filter((l) => l && !l.startsWith("#"));
    const nodeMajor = Number(/^FROM node:(\d+)/.exec(lines[0])?.[1]);
    assert.ok(nodeMajor >= Number(/>=\s*(\d+)/.exec(JSON.parse(read("package.json")).engines.node)[1]), "base image older than engines.node");
    for (const l of lines.filter((x) => x.startsWith("COPY "))) {
      const parts = l.split(/\s+/).slice(1, -1);
      for (const f of parts) assert.ok(fs.existsSync(path.join(ROOT, f)), `COPY source ${f} is missing`);
    }
    const copied = lines.filter((x) => x.startsWith("COPY ")).join(" ");
    assert.match(copied, /router\.mjs/);
    assert.match(copied, /package-lock\.json/);
    assert.ok(lines.some((l) => l === "USER node"));
    assert.ok(lines.some((l) => l === 'ENTRYPOINT ["node", "router.mjs"]'));
    assert.ok(lines.findIndex((l) => l.startsWith("USER")) < lines.findIndex((l) => l.startsWith("ENTRYPOINT")));
  });
});

describe("example configs", () => {
  test("the Tavily pool example's failoverMatch matches Tavily's documented quota errors as tavily-mcp wraps them, and not rate-limit or auth errors", () => {
    const ex = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.pool.example.json"), "utf8"));
    const re = new RegExp(ex.upstreams[0].pools.auto.failoverMatch);
    const wrap = (m) => `Tavily API error: ${JSON.stringify({ error: m })}\nDocumentation: https://docs.tavily.com/`;
    assert.match(wrap("This request exceeds your plan's set usage limit. Please upgrade your plan or contact support@tavily.com"), re);
    assert.match(wrap("This request exceeds the pay-as-you-go limit. You can increase your limit on the Tavily dashboard."), re);
    assert.doesNotMatch(wrap("Your request has been blocked due to excessive requests. Please reduce the rate of requests."), re);
    assert.doesNotMatch(wrap("Unauthorized: missing or invalid API key."), re);
  });

  test("the Tavily pool example's failoverMatch and tool list move a call to the next member when a key hits its plan limit", async () => {
    const ex = JSON.parse(fs.readFileSync(path.join(HERE, "..", "config.pool.example.json"), "utf8"));
    const { failoverMatch, tools } = ex.upstreams[0].pools.auto;
    assert.ok(tools.includes("tavily_search"));
    const d = fs.mkdtempSync(path.join(TMP, "tavily-"));
    const quota = path.join(d, "a");
    fs.writeFileSync(quota, `Tavily API error: ${JSON.stringify({ error: "This request exceeds your plan's set usage limit. Please upgrade your plan or contact support@tavily.com" })}\nDocumentation: https://docs.tavily.com/`);
    const r = await startRouter({ upstreams: [fake("fk", { accounts: { a: { env: { FAKE_ERROR_FILE: quota } }, b: { env: { FAKE_ERROR_FILE: path.join(d, "b") } } }, pools: { p: { members: ["a", "b"], failoverMatch, tools: ["whoami"] } } })] });
    assert.equal((await r.who("whoami", { account: "p" })).profile, "b");
  });
});

describe("backoffMs", () => {
  test("starts at the ttl, doubles per failure and stops at ten minutes", () => {
    assert.deepEqual([1, 2, 3, 4].map((n) => backoffMs(30000, n)), [30000, 60000, 120000, 240000]);
    assert.equal(backoffMs(30000, 6), 600000);
    assert.equal(backoffMs(30000, 40), 600000);
    assert.equal(backoffMs(900000, 3), 900000, "a ttl above the cap is never shortened");
    assert.equal(backoffMs(30000, undefined), 30000);
  });
});

describe("acctmux init", () => {
  const initRun = (args, home = fs.mkdtempSync(path.join(TMP, "init-"))) => {
    const r = spawnSync(process.execPath, [ROUTER, "init", ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
    return { ...r, home, cfg: path.join(home, ".config", "acctmux", "config.json"), tok: path.join(home, ".config", "acctmux", "token") };
  };
  const mode = (f) => fs.statSync(f).mode & 0o777;

  test("writes a 600 config and a 600 token file by default and prints client snippets", () => {
    const r = initRun([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(mode(r.cfg), 0o600);
    assert.equal(mode(r.tok), 0o600);
    assert.match(fs.readFileSync(r.tok, "utf8").trim(), /^[0-9a-f]{64}$/);
    const cfg = JSON.parse(fs.readFileSync(r.cfg, "utf8"));
    assert.deepEqual(cfg, { auth: { tokenFile: "~/.config/acctmux/token" }, upstreams: [{ preset: "google-workspace" }] });
    for (const needle of ["headersHelper", "claude mcp add", "{file:~/.config/acctmux/token}", "bearer_token_env_var", "http://[::1]:18704/mcp"]) assert.ok(r.stdout.includes(needle), needle);
    assert.ok(!r.stdout.includes(fs.readFileSync(r.tok, "utf8").trim()), "the token itself is never printed");
  });

  test("--no-auth writes no token and no auth section", () => {
    const r = initRun(["--no-auth", "--port", "19000"]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(r.tok), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(r.cfg, "utf8")), { port: 19000, upstreams: [{ preset: "google-workspace" }] });
    assert.match(r.stdout, /Auth is OFF/);
    assert.ok(!r.stdout.includes("Bearer"));
    assert.ok(r.stdout.includes("http://[::1]:19000/mcp"));
  });

  test("refuses to overwrite an existing config and leaves it untouched", () => {
    const first = initRun([]);
    const before = fs.readFileSync(first.cfg, "utf8");
    const again = initRun([], first.home);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists; not overwriting/);
    assert.equal(fs.readFileSync(first.cfg, "utf8"), before);
  });

  test("credential presets need --accounts and list the credential files; an existing token is kept", () => {
    const no = initRun(["--preset", "tavily,notion"]);
    assert.equal(no.status, 2);
    assert.match(no.stderr, /tavily, notion needs --accounts/);
    assert.equal(fs.existsSync(no.cfg), false, "nothing is written on a usage error");
    const home = fs.mkdtempSync(path.join(TMP, "init-"));
    fs.mkdirSync(path.join(home, ".config", "acctmux"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "acctmux", "token"), "x".repeat(40) + "\n", { mode: 0o600 });
    const r = initRun(["--preset", "tavily,github", "--accounts", "work,home"], home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(r.tok, "utf8"), "x".repeat(40) + "\n");
    const cfg = JSON.parse(fs.readFileSync(r.cfg, "utf8"));
    assert.deepEqual(cfg.upstreams, [{ preset: "tavily", accounts: ["work", "home"], defaultAccount: "work" }, { preset: "github", accounts: ["work", "home"], defaultAccount: "work" }]);
    assert.match(r.stdout, /creds\/tavily-\{account\}\.key/);
    assert.match(r.stdout, /creds\/github-\{account\}\.token/);
  });

  test("rejects unknown presets and bad account names", () => {
    assert.match(initRun(["--preset", "nope"]).stderr, /unknown preset "nope"/);
    assert.match(initRun(["--preset", "notion", "--accounts", "../x"]).stderr, /account name/);
    assert.match(initRun(["--bogus"]).stderr, /unknown option --bogus/);
  });

  test("the config init writes starts the router (credential presets load through the preset values)", async () => {
    const home = fs.mkdtempSync(path.join(TMP, "init-"));
    const r = initRun(["--preset", "github", "--accounts", "main", "--no-auth"], home);
    const cfg = JSON.parse(fs.readFileSync(r.cfg, "utf8"));
    const bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "github-mcp-server"), `#!/bin/sh\nexec ${process.execPath} ${FAKE}\n`, { mode: 0o755 });
    fs.mkdirSync(path.join(home, ".config", "acctmux", "creds"), { recursive: true });
    fs.writeFileSync(path.join(home, ".config", "acctmux", "creds", "github-main.token"), "ghp_fake\n", { mode: 0o600 });
    const router = await startRouter({ ...cfg, upstreams: cfg.upstreams }, { env: { HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    assert.ok((await router.tools()).some((t) => t.name === "whoami"));
    assert.match(router.log(), /warning: auth is off/);
  });
});

describe("presets", () => {
  test("credential presets pin their upstream version and read one file per account", async () => {
    const { PRESETS } = await import("../lib/presets.mjs");
    assert.match(PRESETS.tavily.args[1], /npx -y tavily-mcp@\d+\.\d+\.\d+$/);
    assert.match(PRESETS.notion.args[1], /npx -y @notionhq\/notion-mcp-server@\d+\.\d+\.\d+$/);
    for (const p of ["tavily", "notion", "github"]) assert.match(PRESETS[p].args[1], /creds\/\w+-\{account\}\./, p);
  });
});
