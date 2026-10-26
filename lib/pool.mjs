import fs from "node:fs";
import { expand, log, errorResult, readableByOthers, backoffMs } from "./util.mjs";
import { accountNames, allowed } from "./accounts.mjs";

// Optional usage lookup for a pool: one HTTP GET per member, refreshed lazily (only when a pool call finds the data older than ttlMs).
export function loadUsage(raw, at, fail) {
  if (raw === undefined) return null;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(`${at}: usage must be an object`);
  if (typeof raw.url !== "string" || !/^https?:\/\//.test(raw.url)) fail(`${at}: usage.url must be an http(s) URL`);
  if (typeof raw.keyFile !== "string" || !raw.keyFile) fail(`${at}: usage.keyFile must name a file holding the member's key ({account} is replaced)`);
  for (const k of ["used", "limit"]) if (typeof raw[k] !== "string" || !raw[k]) fail(`${at}: usage.${k} must be a dot path into the JSON response`);
  const headers = raw.headers ?? { Authorization: "Bearer {key}" };
  if (typeof headers !== "object" || headers === null || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== "string")) fail(`${at}: usage.headers must map header names to strings ({key} is replaced)`);
  const num = (k, d, ok) => { const v = raw[k] ?? d; if (typeof v !== "number" || !Number.isFinite(v) || !ok(v)) fail(`${at}: usage.${k} is out of range`); return v; };
  return {
    url: raw.url, keyFile: raw.keyFile, used: raw.used, limit: raw.limit, headers,
    ttlMs: num("ttlMs", 1800000, (v) => v >= 1000),
    skipAbovePct: num("skipAbovePct", 95, (v) => v > 0 && v <= 100),
    cost: num("cost", 1, (v) => v >= 0),
  };
}

// Account pools: a selector value that rotates over member accounts and fails over on quota errors (opt-in per upstream).
export function loadPools(u) {
  const raw = u.pools ?? {};
  const fail = (m) => { console.error(`upstream ${u.name}: ${m}`); process.exit(1); };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail("pools must be an object");
  const accounts = accountNames(u);
  const scan = !Array.isArray(u.accounts) && !!u.accounts?.root;
  const pools = new Map();
  for (const [name, p] of Object.entries(raw)) {
    const at = `pool "${name}"`;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`${at}: name must match [A-Za-z0-9_-]+`);
    if (accounts.includes(name)) fail(`${at}: name collides with an account of the same name`);
    const members = p?.members;
    if (!Array.isArray(members) || !members.length || members.some((m) => typeof m !== "string") || new Set(members).size !== members.length)
      fail(`${at}: members must be a non-empty list of distinct account names`);
    for (const m of members) {
      if (Object.hasOwn(raw, m)) fail(`${at}: member "${m}" is a pool; pools cannot be nested`);
      if (!accounts.includes(m)) {
        if (!scan) fail(`${at}: unknown member account "${m}"`);
        log("warning:", at, "member", m, "is not a discovered account yet; skipped until it appears");
      }
    }
    const strategy = p.strategy ?? "round-robin";
    if (!["round-robin", "sticky", "most-remaining"].includes(strategy)) fail(`${at}: strategy must be "round-robin", "sticky" or "most-remaining"`);
    const usage = loadUsage(p.usage, at, fail);
    if (strategy === "most-remaining" && !usage) fail(`${at}: strategy "most-remaining" needs a usage block`);
    if (typeof p.failoverMatch !== "string" || !p.failoverMatch) fail(`${at}: failoverMatch (regex for the quota error text) is required`);
    let re;
    try { re = new RegExp(p.failoverMatch); } catch (e) { fail(`${at}: failoverMatch is not a valid regex: ${e.message}`); }
    if (!Array.isArray(p.tools) || !p.tools.length || p.tools.some((t) => typeof t !== "string" || !t))
      fail(`${at}: tools must list the tool names that may be retried on another member (there is no default, for safety)`);
    const cooldownMs = p.cooldownMs ?? 3600000;
    if (typeof cooldownMs !== "number" || !Number.isFinite(cooldownMs) || cooldownMs <= 0) fail(`${at}: cooldownMs must be a positive number`);
    pools.set(name, { name, members, strategy, re, cooldownMs, tools: new Set(p.tools), cursor: 0, usage, inflight: null });
  }
  return pools;
}

// Why a member cannot take a call right now, or null if it can. A member whose cooldown has expired is half-open:
// exactly one call may probe it, concurrent calls skip it until the probe finishes.
export function memberState(s, m, toolName, now, pool, failTtlMs) {
  if (!accountNames(s.u).includes(m)) return { why: "missing" };
  if (!allowed(s.u, m, toolName)) return { why: "denied" };
  const f = s.failures.get(m);
  if (f && now - f.at < backoffMs(failTtlMs, f.n)) return { why: "failed", until: f.at + backoffMs(failTtlMs, f.n) };
  const c = s.cool.get(m);
  if (c && (c.until > now || c.probing)) return { why: "cooling", until: c.until, probing: c.probing };
  const u = pool?.usage && s.usage.get(m);
  if (u && u.limit > 0 && (u.used / u.limit) * 100 >= pool.usage.skipAbovePct) return { why: "low", used: u.used, limit: u.limit };
  return null;
}

const dig = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const USAGE_RETRY_MS = 60000;
const keyWarned = new Set();

export async function fetchUsage(s, pool, m) {
  const cfg = pool.usage;
  try {
    const keyFile = expand(cfg.keyFile.replaceAll("{account}", m));
    if (!keyWarned.has(keyFile) && readableByOthers(keyFile)) { keyWarned.add(keyFile); log(`warning: ${keyFile} is readable by other users; run chmod 600`); }
    const key = fs.readFileSync(keyFile, "utf8").trim();
    const headers = Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, v.replaceAll("{key}", key)]));
    const r = await fetch(cfg.url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    const used = Number(dig(body, cfg.used)), limit = Number(dig(body, cfg.limit));
    if (!Number.isFinite(used) || !Number.isFinite(limit)) throw new Error("used/limit not found in the response");
    s.usage.set(m, { used, limit, at: Date.now() });
    log("pool", s.u.name, pool.name, m, "usage", `${used}/${limit}`);
  } catch (e) {
    s.usageTry.set(m, Date.now());
    log("pool", s.u.name, pool.name, m, "usage lookup failed:", e.message === "fetch failed" ? "network error" : e.message);
  }
}

// Lazy and shared by all callers: nothing runs while the pool is idle, and concurrent calls wait on one refresh.
export function refreshUsage(s, pool) {
  if (!pool.usage) return null;
  if (pool.inflight) return pool.inflight;
  const now = Date.now();
  const names = accountNames(s.u);
  const stale = pool.members.filter((m) => names.includes(m) && now - (s.usage.get(m)?.at ?? 0) > pool.usage.ttlMs && now - (s.usageTry.get(m) ?? 0) > USAGE_RETRY_MS);
  if (!stale.length) return null;
  pool.inflight = Promise.all(stale.map((m) => fetchUsage(s, pool, m))).finally(() => { pool.inflight = null; });
  return pool.inflight;
}

export function pickMember(s, pool, toolName, order, tried, failTtlMs) {
  const now = Date.now();
  for (const m of order) {
    if (tried.has(m) || memberState(s, m, toolName, now, pool, failTtlMs)) continue;
    const c = s.cool.get(m);
    if (c) c.probing = true;
    return { member: m, probe: !!c };
  }
  return null;
}

const at = (t) => `${new Date(t).toISOString()} (in ${Math.max(0, Math.ceil((t - Date.now()) / 1000))} s)`;

export function noMemberMessage(s, pool, toolName, last, failTtlMs) {
  const now = Date.now();
  const st = pool.members.map((m) => ({ m, ...(memberState(s, m, toolName, now, pool, failTtlMs) ?? { why: "free" }) }));
  if (st.every((x) => x.why === "denied")) return `Tool "${toolName}" is not permitted for any member of pool "${pool.name}"`;
  const live = st.filter((x) => x.why !== "denied");
  let text;
  if (live.every((x) => x.why === "cooling")) {
    const first = live.reduce((a, b) => (b.until < a.until ? b : a));
    text = `All members of pool "${pool.name}" (${live.map((x) => x.m).join(", ")}) are cooling down after quota errors. ` +
      (first.until > now ? `The earliest, "${first.m}", recovers at ${at(first.until)}.` : `A recovery probe of "${first.m}" is in progress; retry shortly.`);
  } else {
    const why = (x) => ({ cooling: () => `cooling down until ${at(x.until)}`, failed: () => `failed to start, retried after ${at(x.until)}`, missing: () => "not a current account", low: () => `usage ${x.used}/${x.limit}, at or above the skip threshold`, free: () => "already tried for this call" })[x.why]();
    text = `No member of pool "${pool.name}" can take this call: ${live.map((x) => `${x.m} ${why(x)}`).join("; ")}.`;
  }
  const lastText = last?.result.content?.find((c) => c.type === "text")?.text;
  return lastText ? `${text}\nLast error (from "${last.member}"): ${lastText}` : text;
}

// ctx = { forward, failTtlMs }: the router injects the call path so this module needs no server or SDK.
export async function callPool(ctx, s, pool, tool, args, extra) {
  if (!allowed(s.u, pool.name, tool.name)) return errorResult(`Tool "${tool.name}" is not permitted for pool "${pool.name}"`);
  const n = pool.members.length;
  await refreshUsage(s, pool);
  const start = pool.cursor;
  if (pool.strategy === "round-robin") pool.cursor = (start + 1) % n;
  const rotated = pool.members.map((_, i) => pool.members[(start + i) % n]);
  const left = (m) => { const u = s.usage.get(m); return u && u.limit > 0 ? u.limit - u.used : Infinity; };
  const order = pool.strategy === "most-remaining" ? [...pool.members].sort((a, b) => left(b) - left(a)) : rotated;
  const retry = pool.tools.has(tool.name);
  const tried = new Set();
  let last = null;
  for (;;) {
    const pick = pickMember(s, pool, tool.name, order, tried, ctx.failTtlMs);
    if (!pick) return errorResult(noMemberMessage(s, pool, tool.name, last, ctx.failTtlMs));
    const { member, probe } = pick;
    tried.add(member);
    if (pool.strategy === "sticky") pool.cursor = pool.members.indexOf(member);
    log("pool", s.u.name, pool.name, "->", member, tool.name, ...(probe ? ["(half-open probe)"] : []));
    let out;
    try { out = await ctx.forward(s, member, tool, args, extra); }
    catch (e) { if (probe) s.cool.get(member).probing = false; throw e; }
    const { upstream, result } = out;
    if (!upstream && result.isError && (out.started === false || retry) && !extra.signal?.aborted) {
      if (probe) s.cool.get(member).probing = false;
      last = { member, result };
      continue;
    }
    const exhausted = upstream && result.isError && result.content?.some((c) => c.type === "text" && pool.re.test(c.text));
    if (!exhausted) {
      const u = pool.usage && !result.isError && s.usage.get(member);
      if (u) u.used += pool.usage.cost;
      const c = probe && s.cool.get(member);
      if (c) {
        c.probing = false;
        if (upstream && c.until <= Date.now()) { s.cool.delete(member); log("pool", s.u.name, pool.name, member, "recovered"); }
      }
      return result;
    }
    const stale = s.usage.get(member);
    if (stale) stale.at = 0;
    s.usageTry.delete(member);
    const until = Date.now() + pool.cooldownMs;
    s.cool.set(member, { until: Math.max(until, s.cool.get(member)?.until ?? 0), probing: false });
    last = { member, result };
    const again = retry && !extra.signal?.aborted;
    log("pool", s.u.name, pool.name, member, "quota exhausted, cooling down until", new Date(until).toISOString(), again ? "- rotating" : "- not retried");
    if (!again) return result;
  }
}
