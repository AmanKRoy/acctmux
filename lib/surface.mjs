import { PKG, log, errorResult } from "./util.mjs";
import { accountNames, pickDefault, allowed } from "./accounts.mjs";
import { Server, state, FAIL_TTL_MS } from "./runtime.mjs";
import { callPool } from "./pool.mjs";
import { forward, withChild, ensureLoaded } from "./workers.mjs";

export function selectorDescription(s) {
  if (!s.pools.size) return s.u.selectorDescription;
  const pools = [...s.pools.values()].map((p) => `"${p.name}" (${p.strategy} over ${p.members.join(", ")})`).join("; ");
  return `${s.u.selectorDescription}. Pools pick a member account for you and switch to the next one when an account's quota is exhausted: ${pools}`;
}

export function withSelector(tool, s, choices) {
  const schema = structuredClone(tool.inputSchema ?? { type: "object", properties: {} });
  const prop = { type: "string", enum: choices, description: selectorDescription(s) };
  if (!s.u.requireAccount) prop.default = pickDefault(s.u, choices);
  schema.properties = { [s.u.selector]: prop, ...(schema.properties ?? {}) };
  if (s.u.requireAccount) schema.required = [s.u.selector, ...(schema.required ?? []).filter((k) => k !== s.u.selector)];
  return schema;
}

// Exposed tool name -> { s, tool }. A name offered by more than one upstream is prefixed "<upstream>__".
export function surface() {
  const loaded = [...state.values()].filter((s) => s.baseTools);
  const count = new Map();
  for (const s of loaded) for (const t of s.baseTools) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  const out = new Map();
  for (const s of loaded) {
    const names = accountNames(s.u);
    const choices = s.pools.size ? [...names, ...[...s.pools.keys()].filter((p) => !names.includes(p))] : names;
    for (const t of s.baseTools) {
      if (!names.some((n) => allowed(s.u, n, t.name))) continue;
      const exposed = count.get(t.name) > 1 ? `${s.u.name}__${t.name}` : t.name;
      out.set(exposed, { s, tool: t, names, choices, exposed });
    }
  }
  return out;
}

// Prompts are account-independent templates: served from each upstream's default account, prefixed "<upstream>__" on name collisions.
export function promptSurface() {
  const loaded = [...state.values()].filter((s) => s.baseTools && s.caps.prompts);
  const count = new Map();
  for (const s of loaded) for (const p of s.prompts) count.set(p.name, (count.get(p.name) ?? 0) + 1);
  const out = new Map();
  for (const s of loaded) {
    if (!allowed(s.u, pickDefault(s.u, accountNames(s.u)), "prompts/get")) continue;
    for (const p of s.prompts) out.set(count.get(p.name) > 1 ? `${s.u.name}__${p.name}` : p.name, { s, prompt: p });
  }
  return out;
}

// Resources are account-specific, so their URIs are namespaced: acctmux://<upstream>/<account>/<encoded original uri>.
// resources/list shows each upstream's default account; resources/read accepts any account's URI.
export const wrapUri = (s, account, uri) => `acctmux://${s.u.name}/${account}/${encodeURIComponent(uri)}`;
export const unwrapUri = (uri) => { const m = /^acctmux:\/\/([^/]+)\/([^/]+)\/(.+)$/.exec(uri); return m && { upstream: m[1], account: m[2], uri: decodeURIComponent(m[3]) }; };

export const poolCtx = { forward, failTtlMs: FAIL_TTL_MS };

export function makeServer() {
  const first = [...state.values()].find((s) => s.baseTools) ?? [...state.values()][0];
  const multi = state.size > 1;
  const instructions = multi
    ? [...state.values()].filter((s) => s.instructions).map((s) => `[${s.u.name}] ${s.instructions}`).join("\n\n") || undefined
    : first.instructions;
  const loaded = [...state.values()].filter((s) => s.baseTools);
  const capabilities = { tools: { listChanged: true } };
  if (loaded.some((s) => s.caps.prompts)) capabilities.prompts = {};
  if (loaded.some((s) => s.caps.resources)) capabilities.resources = {};
  const server = new Server(multi ? { name: "acctmux", version: PKG.version } : first.serverInfo, { capabilities, instructions });
  if (capabilities.prompts) {
    server.setRequestHandler("prompts/list", async () => {
      await ensureLoaded();
      return { prompts: [...promptSurface()].map(([name, { prompt }]) => ({ ...prompt, name })) };
    });
    server.setRequestHandler("prompts/get", async (req) => {
      await ensureLoaded();
      const hit = promptSurface().get(req.params.name);
      if (!hit) throw new Error(`Unknown prompt "${req.params.name}"`);
      return withChild(hit.s, pickDefault(hit.s.u, accountNames(hit.s.u)), (entry) =>
        entry.client.request({ method: "prompts/get", params: { ...req.params, name: hit.prompt.name } } ));
    });
  }
  if (capabilities.resources) {
    server.setRequestHandler("resources/list", async (req) => {
      await ensureLoaded();
      let pending;
      try { pending = req.params?.cursor ? JSON.parse(Buffer.from(req.params.cursor, "base64url").toString()) : null; }
      catch { throw new Error("Invalid cursor"); }
      const targets = (pending ?? loaded.filter((x) => x.caps.resources).map((x) => ({ u: x.u.name, c: undefined })))
        .map((t) => ({ ...t, s: state.get(t.u) }))
        .filter((t) => t.s?.baseTools && t.s.caps.resources && allowed(t.s.u, pickDefault(t.s.u, accountNames(t.s.u)), "resources/list"));
      const resources = [];
      const next = [];
      await Promise.all(targets.map(async (t) => {
        const account = pickDefault(t.s.u, accountNames(t.s.u));
        try {
          const r = await withChild(t.s, account, (entry) =>
            entry.client.request({ method: "resources/list", params: t.c ? { cursor: t.c } : {} }));
          resources.push(...r.resources.map((x) => ({ ...x, uri: wrapUri(t.s, account, x.uri) })));
          if (r.nextCursor) next.push({ u: t.u, c: r.nextCursor });
        } catch (e) { log("resources/list failed", t.u, e.message); }
      }));
      return { resources, ...(next.length ? { nextCursor: Buffer.from(JSON.stringify(next)).toString("base64url") } : {}) };
    });
    server.setRequestHandler("resources/read", async (req) => {
      await ensureLoaded();
      const w = unwrapUri(req.params.uri);
      const s = w && state.get(w.upstream);
      if (!s?.baseTools || !s.caps.resources) throw new Error(`Unknown resource "${req.params.uri}"`);
      const names = accountNames(s.u);
      if (!names.includes(w.account)) throw new Error(`Unknown account "${w.account}". Available: ${names.join(", ")}`);
      if (!allowed(s.u, w.account, "resources/read")) throw new Error(`Reading resources is not permitted for account "${w.account}"`);
      const r = await withChild(s, w.account, (entry) =>
        entry.client.request({ method: "resources/read", params: { uri: w.uri } }));
      return { ...r, contents: r.contents.map((c) => ({ ...c, uri: wrapUri(s, w.account, c.uri) })) };
    });
  }
  server.setRequestHandler("tools/list", async () => {
    await ensureLoaded();
    return { tools: [...surface().values()].map((e) => ({ ...e.tool, name: e.exposed, inputSchema: withSelector(e.tool, e.s, e.choices) })) };
  });
  server.setRequestHandler("tools/call", async (req, ctx) => {
    const extra = { signal: ctx.mcpReq.signal };
    await ensureLoaded();
    const hit = surface().get(req.params.name);
    if (!hit) return errorResult(`Unknown tool "${req.params.name}"`);
    const { s, tool, names, choices } = hit;
    const { [s.u.selector]: picked, ...args } = req.params.arguments ?? {};
    if (picked === undefined && s.u.requireAccount) return errorResult(`Argument "${s.u.selector}" is required for ${s.u.name}. Available: ${choices.join(", ")}`);
    const account = picked ?? pickDefault(s.u, choices);
    const pool = s.pools.get(account);
    if (pool) return callPool(poolCtx, s, pool, tool, args, extra);
    if (!names.includes(account) && s.authBroken.has(account)) return errorResult(s.authBroken.get(account));
    if (!names.includes(account))
      return errorResult(`Unknown account "${account}". Available: ${names.join(", ")}`);
    if (!allowed(s.u, account, tool.name))
      return errorResult(`Tool "${tool.name}" is not permitted for account "${account}"`);
    return (await forward(s, account, tool, args, extra)).result;
  });
  return server;
}

