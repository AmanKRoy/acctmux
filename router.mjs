#!/usr/bin/env node
import { PKG, log } from "./lib/util.mjs";

if (process.argv[2] === "init") {
  const { init } = await import("./lib/init.mjs");
  process.exit(init(process.argv.slice(3)));
}
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(PKG.version);
  process.exit(0);
}
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`${PKG.name} ${PKG.version}
Usage: ${PKG.name} [--help] [--version]
       ${PKG.name} init [--preset NAME] [--accounts a,b] [--no-auth]   (write a starter config and token; see docs/SETUP-FOR-AGENTS.md)
Config: $ACCTMUX_CONFIG or ~/.config/acctmux/config.json (see config.example.json)
Env: ACCTMUX_{CONFIG,PORT,IDLE_MS,MAX_BODY,SOCKET,TOKEN}`);
  process.exit(0);
}

const { state } = await import("./lib/runtime.mjs");
const { loadAttempt, anyLoaded } = await import("./lib/workers.mjs");
const { serve } = await import("./lib/http.mjs");

const servers = [];
const shutdown = () => {
  for (const s of state.values()) for (const e of s.children.values()) e.client.close().catch(() => {});
  Promise.all(servers.map((sv) => new Promise((r) => sv.close(r)))).then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await serve(servers);

const initial = [...state.values()].map(loadAttempt);
Promise.all(initial).then(async () => {
  if (anyLoaded()) return;
  log("no upstream available");
  await new Promise((r) => setTimeout(r, 300));
  process.exit(1);
});
