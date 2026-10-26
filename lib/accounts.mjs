import fs from "node:fs";
import path from "node:path";
import { expand, log, ACCOUNT_NAME } from "./util.mjs";

const skipped = new Set();

export const subst = (v, account) => String(v).replaceAll("{account}", account);

export function accountList(u) {
  const a = u.accounts;
  if (Array.isArray(a)) return a.map((name) => ({ name, env: {} }));
  if (!a.root) return Object.entries(a).map(([name, v]) => ({ name, env: v?.env ?? {} }));
  const base = expand(a.root);
  const out = [];
  if (fs.existsSync(path.join(base, a.marker))) out.push({ name: u.defaultAccount, env: {} });
  const dir = path.join(base, a.profilesDir);
  if (fs.existsSync(dir))
    for (const d of fs.readdirSync(dir).sort())
      if (fs.existsSync(path.join(dir, d, a.marker))) {
        if (ACCOUNT_NAME.test(d)) out.push({ name: d, env: {} });
        else if (!skipped.has(d)) { skipped.add(d); log(`ignoring account directory ${JSON.stringify(d)}: names must match ${ACCOUNT_NAME}`); }
      }
  return out;
}

export const accountNames = (u) => accountList(u).map((a) => a.name);
export const pickDefault = (u, names) => (names.includes(u.defaultAccount) ? u.defaultAccount : names[0]);

export function allowed(u, account, tool) {
  const g = u.policy["*"] ?? {}, a = u.policy[account] ?? {};
  if (g.deny?.includes(tool) || a.deny?.includes(tool)) return false;
  const allow = a.allow ?? g.allow;
  return !allow || allow.includes(tool);
}
