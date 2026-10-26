import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadUsage, loadPools, memberState, pickMember, noMemberMessage, callPool } from "../lib/pool.mjs";

const TTL = 1000;
const upstream = (pools) => ({ name: "up", accounts: ["a", "b", "c"], defaultAccount: "a", policy: {}, pools });
const raw = { members: ["a", "b", "c"], failoverMatch: "quota", tools: ["search"] };
const pool = (extra = {}) => loadPools(upstream({ p: { ...raw, ...extra } })).get("p");
const st = () => ({ u: upstream({}), failures: new Map(), cool: new Map(), usage: new Map(), usageTry: new Map() });
const ok = (text) => ({ content: [{ type: "text", text }] });
const quota = { isError: true, content: [{ type: "text", text: "quota exceeded" }] };

describe("pool selection", () => {
  test("memberState reports why a member cannot take a call", () => {
    const s = st(), p = pool(), now = 10000;
    assert.equal(memberState(s, "a", "search", now, p, TTL), null);
    assert.equal(memberState(s, "zz", "search", now, p, TTL).why, "missing");
    s.u.policy = { b: { deny: ["search"] } };
    assert.equal(memberState(s, "b", "search", now, p, TTL).why, "denied");
    s.failures.set("c", { at: now - 10 });
    assert.equal(memberState(s, "c", "search", now, p, TTL).why, "failed");
    assert.equal(memberState(s, "c", "search", now + TTL, p, TTL), null, "failure expires after failTtlMs");
    s.cool.set("a", { until: now + 5, probing: false });
    assert.equal(memberState(s, "a", "search", now, p, TTL).why, "cooling");
    assert.equal(memberState(s, "a", "search", now + 6, p, TTL), null, "cooldown over means half-open, not blocked");
  });

  test("a half-open member admits exactly one probe", () => {
    const s = st(), p = pool(), now = 10000;
    s.cool.set("a", { until: now - 1, probing: false });
    const first = pickMember(s, p, "search", ["a"], new Set(), TTL);
    assert.deepEqual(first, { member: "a", probe: true });
    assert.equal(pickMember(s, p, "search", ["a"], new Set(), TTL), null, "concurrent call skips the probing member");
  });

  test("a member at or above skipAbovePct of its quota is skipped", () => {
    const s = st(), p = pool({ usage: { url: "https://x.test/u", keyFile: "/k/{account}", used: "u", limit: "l", skipAbovePct: 90 } });
    s.usage.set("a", { used: 91, limit: 100, at: 0 });
    s.usage.set("b", { used: 89, limit: 100, at: 0 });
    assert.equal(memberState(s, "a", "search", Date.now(), p, TTL).why, "low");
    assert.equal(memberState(s, "b", "search", Date.now(), p, TTL), null);
  });

  test("noMemberMessage names the earliest recovery when every member is cooling", () => {
    const s = st(), p = pool(), now = Date.now();
    for (const [m, d] of [["a", 60000], ["b", 30000], ["c", 90000]]) s.cool.set(m, { until: now + d, probing: false });
    const msg = noMemberMessage(s, p, "search", null, TTL);
    assert.match(msg, /All members of pool "p" \(a, b, c\) are cooling down/);
    assert.match(msg, /The earliest, "b"/);
  });
});

describe("pool config validation", () => {
  const rejects = (cfg, re) => {
    const exit = process.exit, err = console.error;
    let msg = "";
    process.exit = () => { throw new Error("exit"); };
    console.error = (m) => { msg += m; };
    try { assert.throws(() => loadPools(upstream({ p: { ...raw, ...cfg } })), /exit/); } finally { process.exit = exit; console.error = err; }
    assert.match(msg, re);
  };
  test("rejects a missing failoverMatch, an empty retry list, an unknown strategy and a member that is not an account", () => {
    rejects({ failoverMatch: undefined }, /failoverMatch .* is required/);
    rejects({ tools: [] }, /tools must list/);
    rejects({ strategy: "random" }, /strategy must be/);
    rejects({ members: ["a", "nope"] }, /unknown member account "nope"/);
    rejects({ strategy: "most-remaining" }, /needs a usage block/);
  });
  test("loadUsage fills defaults and refuses a bad URL", () => {
    const u = loadUsage({ url: "https://x.test/u", keyFile: "/k", used: "a.b", limit: "c" }, "pool", (m) => { throw new Error(m); });
    assert.deepEqual([u.ttlMs, u.skipAbovePct, u.cost], [1800000, 95, 1]);
    assert.throws(() => loadUsage({ url: "ftp://x", keyFile: "/k", used: "a", limit: "c" }, "pool", (m) => { throw new Error(m); }), /http\(s\) URL/);
  });
});

describe("callPool", () => {
  const run = async (s, p, results, tool = { name: "search" }, extra = {}) => {
    const calls = [];
    const forward = async (_s, member) => { calls.push(member); const r = results[member]; return typeof r === "function" ? r() : r; };
    const out = await callPool({ forward, failTtlMs: TTL }, s, p, tool, {}, extra);
    return { out, calls };
  };

  test("round-robin advances one member per call", async () => {
    const s = st(), p = pool();
    const all = { a: { upstream: true, result: ok("a") }, b: { upstream: true, result: ok("b") }, c: { upstream: true, result: ok("c") } };
    const seen = [];
    for (let i = 0; i < 4; i++) seen.push((await run(s, p, all)).calls[0]);
    assert.deepEqual(seen, ["a", "b", "c", "a"]);
  });

  test("a quota error cools the member down and a retry-listed tool moves on to the next", async () => {
    const s = st(), p = pool();
    const { out, calls } = await run(s, p, { a: { upstream: true, result: quota }, b: { upstream: true, result: ok("from b") } });
    assert.deepEqual(calls, ["a", "b"]);
    assert.equal(out.content[0].text, "from b");
    assert.ok(s.cool.get("a").until > Date.now());
  });

  test("a tool outside the retry list returns the quota error without a second member", async () => {
    const s = st(), p = pool();
    const { out, calls } = await run(s, p, { a: { upstream: true, result: quota }, b: { upstream: true, result: ok("b") } }, { name: "write" });
    assert.deepEqual(calls, ["a"]);
    assert.equal(out, quota);
  });

  test("a member that could not start is skipped for any tool, and the error mentions the last one when nobody is left", async () => {
    const s = st(), p = pool({ members: ["a", "b"] });
    const fail = { upstream: false, started: false, result: { isError: true, content: [{ type: "text", text: "Failed to start" }] } };
    const { out, calls } = await run(s, p, { a: fail, b: fail }, { name: "write" });
    assert.deepEqual(calls, ["a", "b"]);
    assert.match(out.content[0].text, /No member of pool "p" can take this call/);
    assert.match(out.content[0].text, /Last error \(from "b"\): Failed to start/);
  });

  test("a tool denied for the pool is refused without calling anyone", async () => {
    const s = st(), p = pool();
    s.u.policy = { p: { deny: ["search"] } };
    const { out, calls } = await run(s, p, {});
    assert.deepEqual(calls, []);
    assert.match(out.content[0].text, /not permitted for pool "p"/);
  });
});
