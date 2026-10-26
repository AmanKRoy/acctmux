import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// A failure is cached for failTtlMs, then for twice as long after each further failure in a row, up to this cap.
export const MAX_BACKOFF_MS = 600000;
export const backoffMs = (ttl, n) => Math.min(ttl * 2 ** (Math.max(1, n ?? 1) - 1), Math.max(ttl, MAX_BACKOFF_MS));

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export let PKG = { name: "acctmux", version: "unknown" };
try { PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")); } catch { /* copied without package.json */ }
export const ownSdk = () => {
  try { createRequire(path.join(ROOT, "package.json")).resolve("@modelcontextprotocol/server"); return true; } catch { return false; }
};

export const envVar = (n) => process.env[`ACCTMUX_${n}`];

export const expand = (p) => (typeof p === "string" ? p.replace(/^~(?=$|\/)/, os.homedir()) : p);

// Account names end up in file paths and in "{account}" templates (often inside sh -c), so they are restricted.
export const ACCOUNT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// True when group or others can read the file (it may hold tokens).
export const readableByOthers = (file) => { try { return (fs.statSync(file).mode & 0o044) !== 0; } catch { return false; } };

export const log = (...a) => console.error(new Date().toISOString(), ...a);

export class AuthError extends Error {}
export class ConfigError extends Error {}

export const errorResult = (text) => ({ isError: true, content: [{ type: "text", text }] });
