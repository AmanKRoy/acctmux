import crypto from "node:crypto";
import fs from "node:fs";
import { PRESETS } from "./presets.mjs";
import { PKG, ROOT, ownSdk, envVar, expand, ACCOUNT_NAME, readableByOthers } from "./util.mjs";

const UPSTREAM_DEFAULTS = {
  args: [],
  env: {},
  envPass: "^(PATH|HOME|USER|LANG|LC_.*|TZ|XDG_.*)$",
  profileEnv: null,
  defaultAccount: "default",
  requireAccount: false,
  callTimeoutMs: 300000,
  warmup: null,
  authRequired: null,
  policy: {},
};

export function loadConfig() {
  const file = expand(envVar("CONFIG") || "~/.config/acctmux/config.json");
  let user = {};
  if (fs.existsSync(file)) {
    try { user = JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (e) { console.error(`bad config ${file}: ${e.message}`); process.exit(1); }
    if (readableByOthers(file)) console.error(`warning: ${file} is readable by other users and may hold tokens; run chmod 600 ${file}`);
  } else {
    console.error(envVar("CONFIG") ? `config not found: ${file}` : `${PKG.name}: no config file at ${file}.
Create it (or point ACCTMUX_CONFIG at one) with at least one upstream, for example:
${JSON.stringify({ upstreams: [{ name: "notion", command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], accounts: { work: { env: { NOTION_TOKEN: "ntn_..." } }, personal: { env: { NOTION_TOKEN: "ntn_..." } } }, defaultAccount: "work" }] }, null, 2)}
More examples: config.example.json and docs/CONFIG.md. For Google use {"preset": "google-workspace"}.`);
    process.exit(1);
  }
  const cfg = {
    port: Number(envVar("PORT") || 18704),
    idleMs: Number(envVar("IDLE_MS") || 150000),
    maxBody: Number(envVar("MAX_BODY") || 32 * 1024 * 1024),
    connectTimeoutMs: 15000,
    loadWaitMs: 20000,
    failTtlMs: 30000,
    host: "::1",
    selector: "account",
    tcp: true,
    accountPollMs: 5000,
    socket: envVar("SOCKET") || null,
    sdkRoot: ownSdk() ? ROOT : null,
    ...user,
  };
  for (const k of ["port", "idleMs", "maxBody", "connectTimeoutMs", "loadWaitMs", "failTtlMs", "accountPollMs"]) {
    if (typeof cfg[k] !== "number" || !Number.isFinite(cfg[k]) || cfg[k] <= 0) { console.error(`${k} must be a positive number, got ${JSON.stringify(cfg[k])}`); process.exit(1); }
  }
  for (const k of ["stateful", "sessionTtlMs", "maxSessions"]) if (user[k] !== undefined) console.error(`warning: "${k}" is no longer supported and is ignored (the MCP SDK v2 front end has no protocol sessions; clients that listen get list_changed through subscriptions/listen)`);
  if (!cfg.sdkRoot) { console.error('the MCP SDK is not installed next to router.mjs: run npm install there, or set "sdkRoot" to a directory whose node_modules has @modelcontextprotocol/server, /client and /node'); process.exit(1); }
  if (user.upstreams !== undefined && (!Array.isArray(user.upstreams) || !user.upstreams.length)) { console.error(`"upstreams" must be a non-empty list`); process.exit(1); }
  if (user.upstreams === undefined) { console.error('"upstreams" is required: list at least one MCP server (see config.example.json)'); process.exit(1); }
  user.upstreams = user.upstreams.map((u, i) => {
    if (typeof u?.preset !== "string") return u;
    if (!Object.hasOwn(PRESETS, u.preset)) { console.error(`upstreams[${i}]: unknown preset ${JSON.stringify(u.preset)}; known: ${Object.keys(PRESETS).join(", ")}`); process.exit(1); }
    const { preset, ...rest } = u;
    return { ...structuredClone(PRESETS[preset]), name: preset, ...rest };
  });
  user.upstreams.forEach((u, i) => {
    const bad = (why) => { console.error(`upstreams[${i}]${typeof u?.name === "string" ? ` (${u.name})` : ""}: ${why}`); process.exit(1); };
    if (typeof u !== "object" || u === null || Array.isArray(u)) bad("must be an object");
    if (typeof u.name !== "string" || !u.name) bad('"name" is required');
    if (typeof u.command !== "string" || !u.command) bad('"command" is required');
    if (u.accounts === undefined || typeof u.accounts !== "object" || u.accounts === null) bad('"accounts" is required (a list, an object of per-account env, or {root, marker, profilesDir})');
    if (Array.isArray(u.accounts)) {
      if (!u.accounts.length || u.accounts.some((x) => typeof x !== "string" || !x)) bad('"accounts" as a list must hold non-empty account names');
    } else if (typeof u.accounts.root === "string") {
      for (const k of ["marker", "profilesDir"]) if (typeof u.accounts[k] !== "string" || !u.accounts[k]) bad(`"accounts.${k}" is required with "accounts.root"`);
    } else if (u.accounts.root !== undefined) bad('"accounts.root" must be a string');
    const names = Array.isArray(u.accounts) ? u.accounts : typeof u.accounts.root === "string" ? [] : Object.keys(u.accounts);
    for (const n of [...names, ...(typeof u.defaultAccount === "string" ? [u.defaultAccount] : [])]) {
      if (typeof n !== "string" || !ACCOUNT_NAME.test(n)) bad(`account name ${JSON.stringify(n)} must match ${ACCOUNT_NAME} (letters, digits, dot, underscore, hyphen; it is used in file paths and command templates)`);
    }
    if (u.authRequired !== undefined && u.authRequired !== null && (typeof u.authRequired !== "object" || Array.isArray(u.authRequired))) bad('"authRequired" must be an object with match and message');
    if (u.callTimeoutMs !== undefined && (typeof u.callTimeoutMs !== "number" || !Number.isFinite(u.callTimeoutMs) || u.callTimeoutMs <= 0)) bad(`"callTimeoutMs" must be a positive number, got ${JSON.stringify(u.callTimeoutMs)}`);
    if (u.requireAccount !== undefined && typeof u.requireAccount !== "boolean") bad('"requireAccount" must be true or false');
    if (u.args !== undefined && (!Array.isArray(u.args) || u.args.some((x) => typeof x !== "string"))) bad('"args" must be a list of strings');
    for (const [k, v] of [["envPass", u.envPass], ["authRequired.match", u.authRequired?.match], ["authRequired.resultMatch", u.authRequired?.resultMatch]]) {
      if (v === undefined) continue;
      try { new RegExp(v); } catch (e) { bad(`${k} is not a valid regular expression: ${e.message}`); }
    }
  });
  if (cfg.host !== "::1" && cfg.host !== "127.0.0.1") { console.error(`host must be "::1" or "127.0.0.1", got ${JSON.stringify(cfg.host)}`); process.exit(1); }
  for (const sel of [cfg.selector, ...user.upstreams.map((u) => u.selector).filter((x) => x !== undefined)]) {
    if (typeof sel !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(sel)) { console.error(`selector must be an identifier like "account", got ${JSON.stringify(sel)}`); process.exit(1); }
  }
  cfg.upstreams = user.upstreams.map((u) => ({ ...UPSTREAM_DEFAULTS, selector: cfg.selector, selectorDescription: `${u.name} account to use`, ...u }));
  for (const u of cfg.upstreams) {
    const bad = (where, why) => { console.error(`upstream ${u.name}: policy${where}: ${why}`); process.exit(1); };
    if (typeof u.policy !== "object" || u.policy === null || Array.isArray(u.policy)) bad("", "must be an object");
    for (const [who, entry] of Object.entries(u.policy)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) bad(` "${who}"`, "must be an object with allow and/or deny");
      for (const k of ["allow", "deny"]) {
        if (entry[k] !== undefined && (!Array.isArray(entry[k]) || entry[k].some((x) => typeof x !== "string"))) bad(` "${who}".${k}`, "must be a list of tool names");
      }
    }
  }
  if (!cfg.tcp && !cfg.socket) { console.error("nothing to listen on: tcp is false and no socket is set"); process.exit(1); }
  const names = cfg.upstreams.map((u) => u.name);
  if (!names.length || names.some((n) => !n || !/^[A-Za-z0-9_-]+$/.test(n)) || new Set(names).size !== names.length) {
    console.error("upstreams need unique names matching [A-Za-z0-9_-]+");
    process.exit(1);
  }
  return cfg;
}

// Optional bearer auth. Token comes from ACCTMUX_TOKEN, auth.token or auth.tokenFile (must not be group/world readable).
export function loadToken(cfg) {
  let token = envVar("TOKEN") ?? cfg.auth?.token;
  if (!token && cfg.auth?.tokenFile) {
    const file = expand(cfg.auth.tokenFile);
    try {
      if (fs.statSync(file).mode & 0o077) throw new Error(`${file} is readable by others; run chmod 600`);
      token = fs.readFileSync(file, "utf8").trim();
    } catch (e) { console.error(`auth.tokenFile: ${e.message}`); process.exit(1); }
  }
  if (token === undefined) return null;
  if (typeof token !== "string" || token.length < 16) { console.error("auth token must be a string of at least 16 characters"); process.exit(1); }
  return crypto.createHash("sha256").update(token).digest();
}
