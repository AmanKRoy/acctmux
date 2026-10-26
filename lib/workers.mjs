import { PKG, expand, log, AuthError, ConfigError, errorResult, backoffMs } from "./util.mjs";
import { subst, accountList, accountNames, pickDefault } from "./accounts.mjs";
import { Client, StdioClientTransport, IDLE_MS, CONNECT_TIMEOUT_MS, LOAD_WAIT_MS, FAIL_TTL_MS, state, hooks } from "./runtime.mjs";

export function spawnChild(s, account) {
  const { u } = s;
  const extra = accountList(u).find((a) => a.name === account)?.env ?? {};
  const re = new RegExp(u.envPass);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => re.test(k)));
  for (const [k, v] of Object.entries({ ...u.env, ...extra })) env[k] = expand(subst(v, account));
  if (u.profileEnv) {
    delete env[u.profileEnv];
    if (account !== u.defaultAccount) env[u.profileEnv] = account;
  }
  const args = u.args.map((a) => expand(subst(a, account)));
  const transport = new StdioClientTransport({ command: expand(u.command), args, env, stderr: "pipe" });
  const client = new Client({ name: "acctmux", version: PKG.version }, { capabilities: {} });
  const entry = { client, timer: null, busy: 0, authFailed: null, errTail: "" };
  transport.stderr?.on("data", (d) => { entry.errTail = (entry.errTail + d).slice(-1000); });
  if (u.authRequired) {
    // An upstream that wants interactive login blocks its call for minutes; spot that on stderr and fail fast instead.
    const re = u.authRequired.match && new RegExp(u.authRequired.match);
    let tail = "";
    transport.stderr?.on("data", (d) => {
      if (!re || entry.authFailed) return;
      tail = (tail + d).slice(-2000);
      if (re.test(tail)) markAuthFailed(s, account, entry);
    });
  }
  const showStderr = entry.showStderr = () => { if (entry.errTail.trim()) log("child stderr", u.name, account, JSON.stringify(entry.errTail.trim())); entry.errTail = ""; };
  entry.ready = client.connect(transport, { timeout: CONNECT_TIMEOUT_MS }).then(async () => {
    if (u.warmup) {
      try {
        await client.request(
          { method: "tools/call", params: { name: u.warmup.tool, arguments: u.warmup.arguments ?? {} } },
          { timeout: CONNECT_TIMEOUT_MS },
        );
      } catch (e) { log("warmup failed", u.name, account, e.message); }
    }
    return entry;
  });
  entry.ready.catch(() => { setTimeout(showStderr, 200).unref(); });
  client.onclose = () => {
    clearTimeout(entry.timer);
    if (s.children.get(account) === entry) s.children.delete(account);
  };
  return entry;
}

export function markAuthFailed(s, account, entry) {
  entry.authFailed = subst(s.u.authRequired.message, account);
  s.authBroken.set(account, entry.authFailed);
  s.failures.set(account, { at: Date.now(), n: (s.failures.get(account)?.n ?? 0) + 1, err: new AuthError(entry.authFailed) });
  log("auth required", s.u.name, account);
  entry.client.close().catch(() => {});
}

export function arm(s, account, entry) {
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entry.busy) return arm(s, account, entry);
    log("idle-kill", s.u.name, account);
    if (s.children.get(account) === entry) s.children.delete(account);
    entry.client.close().catch(() => {});
  }, IDLE_MS);
  entry.timer.unref?.();
}

export async function child(s, account) {
  const failed = s.failures.get(account);
  if (failed && Date.now() - failed.at < backoffMs(FAIL_TTL_MS, failed.n)) throw failed.err;
  let entry = s.children.get(account);
  if (!entry) { entry = spawnChild(s, account); s.children.set(account, entry); log("spawn", s.u.name, account); }
  try {
    await entry.ready;
    if (entry.authFailed) throw new AuthError(entry.authFailed);
  } catch (e) {
    const err = entry.authFailed ? new AuthError(entry.authFailed) : e;
    s.failures.set(account, { at: Date.now(), n: (failed?.n ?? 0) + 1, err });
    if (s.children.get(account) === entry) s.children.delete(account);
    entry.client.close().catch(() => {});
    throw err;
  }
  s.failures.delete(account);
  s.authBroken.delete(account);
  return entry;
}

// Startup waits for the first load, so the fallback over other accounts is bounded by time (fast failures cost nothing).
export const BASE_LOAD_BUDGET_FACTOR = 3;
export const MAX_LIST_PAGES = 100;

export async function loadBase(s) {
  const names = accountNames(s.u);
  if (!names.length) throw new Error(`no accounts found for ${s.u.name}`);
  const first = pickDefault(s.u, names);
  let lastErr;
  const started = Date.now();
  for (const account of [first, ...names.filter((n) => n !== first)]) {
    if (lastErr && Date.now() - started >= BASE_LOAD_BUDGET_FACTOR * CONNECT_TIMEOUT_MS) break;
    try { await loadBaseFrom(s, account); return; }
    catch (e) {
      lastErr = e;
      log("base load failed", s.u.name, account, e.message);
      if (e instanceof ConfigError) break;
    }
  }
  throw lastErr;
}

export async function loadBaseFrom(s, account) {
  const entry = spawnChild(s, account);
  s.children.set(account, entry);
  try {
    await entry.ready;
    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    const listAll = async (method, key) => {
      const out = [];
      let cursor;
      for (let page = 0; ; page++) {
        if (page >= MAX_LIST_PAGES) throw new Error(`${method} returned more than ${MAX_LIST_PAGES} pages`);
        const r = await entry.client.request({ method, params: cursor ? { cursor } : {} }, { timeout: Math.max(1, deadline - Date.now()) });
        out.push(...r[key]);
        cursor = r.nextCursor;
        if (!cursor) return out;
      }
    };
    const tools = await listAll("tools/list", "tools");
    const clash = tools.find((t) => t.inputSchema?.properties && Object.hasOwn(t.inputSchema.properties, s.u.selector));
    if (clash) throw new ConfigError(`tool "${clash.name}" already has an argument named "${s.u.selector}"; set "selector" (globally or on upstream "${s.u.name}") to another name`);
    const caps = entry.client.getServerCapabilities() ?? {};
    const prompts = caps.prompts ? await listAll("prompts/list", "prompts") : undefined;
    const toolNames = new Set([...tools.map((t) => t.name), "prompts/get", "resources/list", "resources/read"]);
    for (const [who, pol] of Object.entries(s.u.policy)) {
      for (const n of [...(pol.allow ?? []), ...(pol.deny ?? [])]) if (!toolNames.has(n)) log("warning: policy", JSON.stringify(who), "of upstream", s.u.name, "names unknown tool", JSON.stringify(n));
    }
    s.caps = caps;
    if (prompts) s.prompts = prompts;
    s.serverInfo = entry.client.getServerVersion() ?? s.serverInfo;
    s.instructions = entry.client.getInstructions();
    s.baseTools = tools;
  } catch (e) {
    setTimeout(entry.showStderr, 200).unref();
    if (s.children.get(account) === entry) s.children.delete(account);
    entry.client.close().catch(() => {});
    throw e;
  }
  arm(s, account, entry);
  log("cached", s.baseTools.length, "tools from", s.u.name, account);
}

// Loads start in the background right after the port opens. A request waits for upstreams that have not finished their
// first attempt, but only up to loadWaitMs; later retries of a failed upstream never delay anyone.
export const loadAttempt = (s) => (s.loading ??= loadBase(s)
  .then(() => hooks.toolsChanged())
  .catch((e) => { s.loadFail = Date.now(); s.loadFails = (s.loadFails ?? 0) + 1; log("upstream unavailable", s.u.name, e.message); })
  .finally(() => { s.loading = null; }));

export async function ensureLoaded() {
  const waits = [];
  for (const s of state.values()) {
    if (s.baseTools) continue;
    const first = !s.loadFail;
    if (s.loading) { if (first) waits.push(s.loading); continue; }
    if (Date.now() - s.loadFail >= backoffMs(FAIL_TTL_MS, s.loadFails)) { const p = loadAttempt(s); if (first) waits.push(p); }
  }
  if (!waits.length) return;
  let timer;
  await Promise.race([Promise.all(waits), new Promise((r) => { timer = setTimeout(r, LOAD_WAIT_MS); })]);
  clearTimeout(timer);
}

export const anyLoaded = () => [...state.values()].some((s) => s.baseTools);

// A server is built from what has loaded, so a request that finds nothing loaded after the wait is told to retry.
export async function loadedOrRetry(res) {
  await ensureLoaded();
  if (anyLoaded()) return true;
  res.writeHead(503, { "Retry-After": "5" }).end();
  return false;
}

export async function withChild(s, account, fn) {
  const entry = await resourceChild(s, account);
  entry.busy++;
  try { return await fn(entry); }
  finally { entry.busy--; arm(s, account, entry); }
}

export async function resourceChild(s, account) {
  try { return await child(s, account); }
  catch (e) { throw new Error(e instanceof AuthError ? e.message : `Failed to start account "${account}": ${e.message}`); }
}

// One tools/call on one account. `upstream` is false when the result was made by the router (start failure, login needed).
export async function forward(s, account, tool, args, extra) {
  let entry;
  try { entry = await child(s, account); }
  catch (e) { return { upstream: false, started: false, result: errorResult(e instanceof AuthError ? e.message : `Failed to start account "${account}": ${e.message}`) }; }
  entry.busy++;
  try {
    const result = await entry.client.request(
      { method: "tools/call", params: { name: tool.name, arguments: args } },
      { timeout: s.u.callTimeoutMs, signal: extra.signal },
    );
    const rm = s.u.authRequired?.resultMatch;
    if (rm && result.isError && result.content?.some((c) => c.type === "text" && new RegExp(rm).test(c.text))) {
      markAuthFailed(s, account, entry);
      return { upstream: false, result: errorResult(entry.authFailed) };
    }
    return { upstream: true, result };
  } catch (e) {
    if (entry.authFailed) return { upstream: false, result: errorResult(entry.authFailed) };
    throw e;
  } finally {
    entry.busy--;
    arm(s, account, entry);
  }
}

