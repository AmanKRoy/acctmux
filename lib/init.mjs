import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PRESETS, CRED_FILES } from "./presets.mjs";
import { envVar, ACCOUNT_NAME } from "./util.mjs";

const USAGE = `Usage: acctmux init [--preset NAME[,NAME...]] [--accounts a,b] [--no-auth] [--port N] [--config FILE] [--token-file FILE]
Writes a starter config (mode 600) and, unless --no-auth, a random bearer token file (mode 600), then prints client snippets.
  --preset      ${Object.keys(PRESETS).join(", ")} (default google-workspace)
  --accounts    account names for the non-Google presets, for example work,personal (Google accounts are discovered)
  --no-auth     do not create a token; the router then accepts any local process
Refuses to overwrite an existing config.`;

function parse(argv) {
  const o = { presets: [], accounts: [], auth: true };
  const need = (i, a) => { if (i >= argv.length || argv[i].startsWith("--")) throw new Error(`${a} needs a value`); return argv[i]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--no-auth") o.auth = false;
    else if (a === "--preset") o.presets.push(...need(++i, a).split(",").filter(Boolean));
    else if (a === "--accounts") o.accounts.push(...need(++i, a).split(",").filter(Boolean));
    else if (a === "--port") o.port = Number(need(++i, a));
    else if (a === "--config") o.config = need(++i, a);
    else if (a === "--token-file") o.tokenFile = need(++i, a);
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

const tilde = (p) => (p.startsWith(os.homedir() + path.sep) ? "~" + p.slice(os.homedir().length) : p);

export function init(argv) {
  let o;
  try { o = parse(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  if (!o.presets.length) o.presets.push("google-workspace");
  const fail = (m) => { console.error(`acctmux init: ${m}`); return 2; };
  if (o.port !== undefined && (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535)) return fail("--port must be an integer between 1 and 65535");
  for (const p of o.presets) if (!Object.hasOwn(PRESETS, p)) return fail(`unknown preset ${JSON.stringify(p)}; known: ${Object.keys(PRESETS).join(", ")}`);
  if (new Set(o.presets).size !== o.presets.length) return fail("a preset is listed twice");
  for (const a of o.accounts) if (!ACCOUNT_NAME.test(a)) return fail(`account name ${JSON.stringify(a)} must match ${ACCOUNT_NAME}`);
  const needAccounts = o.presets.filter((p) => !PRESETS[p].accounts);
  if (needAccounts.length && !o.accounts.length) return fail(`${needAccounts.join(", ")} needs --accounts (for example --accounts work,personal)`);

  const configFile = path.resolve(o.config ?? envVar("CONFIG") ?? path.join(os.homedir(), ".config", "acctmux", "config.json"));
  const tokenFile = path.resolve(o.tokenFile ?? path.join(path.dirname(configFile), "token"));
  if (fs.existsSync(configFile)) return fail(`${configFile} already exists; not overwriting it (edit it by hand or pass --config for another file)`);

  const cfg = {};
  if (o.port !== undefined) cfg.port = o.port;
  if (o.auth) cfg.auth = { tokenFile: tilde(tokenFile) };
  cfg.upstreams = o.presets.map((p) => PRESETS[p].accounts ? { preset: p } : { preset: p, accounts: o.accounts, defaultAccount: o.accounts[0] });

  fs.mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  let tokenNote = "";
  if (o.auth) {
    if (fs.existsSync(tokenFile)) tokenNote = ` (kept the existing token file ${tokenFile})`;
    else {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tokenFile, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
    }
  }

  const url = `http://[::1]:${o.port ?? 18704}/mcp`;
  const out = [`Wrote ${configFile}`];
  out.push(o.auth ? `Token file: ${tokenFile}${tokenNote}` : "Auth is OFF (--no-auth): any local process can use the endpoint, including its logged-in accounts.");
  const hints = o.presets.filter((p) => CRED_FILES[p]).map((p) => `  ~/.config/acctmux/creds/${CRED_FILES[p]}  (${p}; one file per account in ${o.accounts.join(", ")}, mode 600)`);
  if (hints.length) out.push("", "Put each account's credential in a file (plain text, mode 600):", ...hints);
  if (o.presets.includes("google-workspace")) out.push("", "Google accounts: install @dguido/google-workspace-mcp (npm i -g), then run `google-workspace-mcp auth` and `google-workspace-mcp auth --profile NAME` per extra account.");
  const tok = tilde(tokenFile);
  out.push("", "Start it:  acctmux          (or install the user unit in systemd/)", "", `Endpoint: ${url}`, "", "Client snippets", "");
  if (o.auth) {
    out.push(
      "Claude Code (headersHelper). Save as ~/.local/bin/acctmux-headers, chmod +x:",
      `  #!/bin/sh`,
      `  printf '{"Authorization":"Bearer %s"}' "$(cat ${tok.replace("~", "$HOME")})"`,
      "then add to ~/.claude.json under mcpServers:",
      `  "acctmux": { "type": "http", "url": "${url}", "headersHelper": "~/.local/bin/acctmux-headers" }`,
      `or without a script: claude mcp add --transport http acctmux ${url} --header "Authorization: Bearer $(cat ${tok})"`,
      "",
      "OpenCode (opencode.jsonc):",
      `  "mcp": { "acctmux": { "type": "remote", "url": "${url}", "headers": { "Authorization": "Bearer {file:${tok}}" } } }`,
      "",
      "Codex (~/.codex/config.toml):",
      `  [mcp_servers.acctmux]`,
      `  url = "${url}"`,
      `  bearer_token_env_var = "ACCTMUX_TOKEN"`,
      `  # and in your shell profile: export ACCTMUX_TOKEN="$(cat ${tok})"`,
    );
  } else {
    out.push(
      `Claude Code:  claude mcp add --transport http acctmux ${url}`,
      "",
      "OpenCode (opencode.jsonc):",
      `  "mcp": { "acctmux": { "type": "remote", "url": "${url}" } }`,
      "",
      "Codex (~/.codex/config.toml):",
      `  [mcp_servers.acctmux]`,
      `  url = "${url}"`,
    );
  }
  console.log(out.join("\n"));
  return 0;
}
