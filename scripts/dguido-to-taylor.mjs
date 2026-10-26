#!/usr/bin/env node
// Copy a google-workspace-mcp (dguido) login into the credential file format of taylorwilsdon's workspace-mcp,
// so the same Google account can be served by both upstreams without a second consent screen.
// usage: dguido-to-taylor.mjs --source <dir with tokens.json + credentials.json> --email <address> --out <dir>
import fs from "node:fs";
import path from "node:path";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const [source, email, out] = ["source", "email", "out"].map(arg);
if (!source || !email || !out) {
  console.error("usage: dguido-to-taylor.mjs --source <dir> --email <address> --out <dir>");
  process.exit(2);
}

const read = (f) => JSON.parse(fs.readFileSync(path.join(source, f), "utf8"));
const tokens = read("tokens.json");
const client = read("credentials.json").installed ?? read("credentials.json").web;
if (!tokens.refresh_token || !client?.client_id || !client?.client_secret) {
  console.error("source lacks a refresh_token or an OAuth client id/secret");
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const file = path.join(out, `${email}.json`);
fs.writeFileSync(file, JSON.stringify({
  token: tokens.access_token ?? null,
  refresh_token: tokens.refresh_token,
  token_uri: client.token_uri ?? "https://oauth2.googleapis.com/token",
  client_id: client.client_id,
  client_secret: client.client_secret,
  scopes: String(tokens.scope ?? "").split(/\s+/).filter(Boolean),
  expiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString().replace("Z", "") : null,
}), { mode: 0o600 });
fs.chmodSync(file, 0o600);
console.log(`wrote ${file}`);
