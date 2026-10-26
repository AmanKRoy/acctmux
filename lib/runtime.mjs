import path from "node:path";
import { createRequire } from "node:module";
import { expand, log } from "./util.mjs";
import { loadConfig, loadToken } from "./config.mjs";
import { loadPools } from "./pool.mjs";
import { accountNames } from "./accounts.mjs";

export const CONFIG = loadConfig();
export const TOKEN_HASH = loadToken(CONFIG);
const require = createRequire(path.join(expand(CONFIG.sdkRoot), "package.json"));
const sdk = (p) => import(require.resolve(p));
export const { Server, createMcpHandler } = await sdk("@modelcontextprotocol/server");
export const { Client } = await sdk("@modelcontextprotocol/client");
export const { StdioClientTransport } = await sdk("@modelcontextprotocol/client/stdio");
export const { toNodeHandler } = await sdk("@modelcontextprotocol/node");

export const { accountPollMs: POLL_MS, port: PORT, tcp: TCP, socket: SOCKET, idleMs: IDLE_MS, maxBody: MAX_BODY, connectTimeoutMs: CONNECT_TIMEOUT_MS, loadWaitMs: LOAD_WAIT_MS, failTtlMs: FAIL_TTL_MS } = CONFIG;

export const state = new Map(
  CONFIG.upstreams.map((u) => [u.name, { u, children: new Map(), failures: new Map(), authBroken: new Map(), pools: loadPools(u), cool: new Map(), usage: new Map(), usageTry: new Map(), baseTools: null, prompts: [], caps: {}, loadFail: 0, serverInfo: { name: u.name, version: "router" }, instructions: undefined }]),
);

for (const s of state.values()) {
  const known = new Set(["*", ...accountNames(s.u), ...s.pools.keys()]);
  for (const k of Object.keys(s.u.policy)) if (!known.has(k)) log("warning: policy entry", JSON.stringify(k), "of upstream", s.u.name, "matches no account or pool at startup");
}

// Set by the HTTP front end: tell clients that listen for changes that the tool list changed.
export const hooks = { toolsChanged: () => {} };
