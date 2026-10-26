# Plan: MCP SDK v2 and protocol revision 2026-07-28

Status: approved 2026-10-24 and implemented. Decisions: go now; both protocol eras; `stateful` dropped (the live setup never used it, and listening 2026 clients get `list_changed` through `subscriptions/listen`). 2025 answers now arrive as one SSE event instead of a JSON body, which the spec allows and every client must accept. Sources: the SDK v2 docs (ts.sdk.modelcontextprotocol.io/v2, "Upgrading from v1.x" and "Supporting protocol revision 2026-07-28"), the 2026-07-28 release posts, the SDK's Context7 index. Checked 2026-10-24.

## What changed upstream
- **Spec 2026-07-28 is stateless.** No `initialize` handshake, no `Mcp-Session-Id`. Every request carries the protocol version, client capabilities and client info in `_meta`; new headers `Mcp-Method` and `Mcp-Name`. List responses can carry cache hints. Server-initiated requests are replaced by multi-round-trip requests (`input_required`, `requestState`). `subscriptions/listen` is the only way a client receives `list_changed`. Roots, sampling, logging and the HTTP+SSE transport are deprecated (still work for 12 months).
- **SDK v2 is the stable line** (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, `@modelcontextprotocol/core` for the Zod schemas, `@modelcontextprotocol/node` for Node `http`). `@modelcontextprotocol/sdk` stays at 1.x (latest 1.32.2).
- Nothing 2026-era goes on the wire unless opted in: a hand-built `Client`/`Server` keeps speaking 2025. `createMcpHandler(factory)` serves 2026-07-28 and, by default (`legacy: 'stateless'`), also serves 2025 traffic per request. `legacy: 'reject'` makes a strict modern endpoint. The `Client` takes `versionNegotiation: { mode: 'auto' }` to probe with `server/discover` and fall back to `initialize`.

## What this touches in acctmux
| Area | Today (SDK 1.x) | v2 |
|---|---|---|
| Front end (`lib/http.mjs`, `lib/surface.mjs`) | low-level `Server` + `StreamableHTTPServerTransport`, fresh pair per POST | `createMcpHandler(() => makeServer())` wrapped with `toNodeHandler` from `@modelcontextprotocol/node`; our Origin/Host/bearer/body-cap checks stay in front (the handler is validation-free by design) |
| Handlers | `setRequestHandler(ListToolsRequestSchema, (req, extra) => ...)` | `setRequestHandler('tools/list', (req, ctx) => ...)`; `extra.signal` becomes a field of `ctx` (exact name to confirm in the API reference) |
| Children (`lib/workers.mjs`) | `Client` + `StdioClientTransport`, `request(req, Schema, opts)` | `request(req)` without a schema for spec methods; schemas from `core` where still needed; children are third-party servers speaking 2025, so keep the default legacy negotiation (no probe, no extra spawn) |
| Schema imports (`lib/runtime.mjs`) | one dynamic import per SDK subpath from `sdkRoot` | new package set; `sdkRoot` must resolve three or four packages instead of one |
| Stateful mode (`stateful: true`) | per-session servers, GET stream, `tools/list_changed` push, session cap and TTL | the protocol-level session is gone; the 2026 equivalent is `subscriptions/listen` served by the handler, with `handler.notify.toolsChanged()` |
| Cancellation | stateless mode already ignores an explicit `notifications/cancelled` | on 2026 HTTP, aborting a request closes its stream, which is the spec cancellation signal; this likely removes the known gap for 2026 clients |
| `--version`/CLI, config, pools, policy | independent of the SDK | unchanged |

## Options
1. **Stay on SDK 1.x until clients move (do nothing).** Cost zero. Risk: clients that send `MCP-Protocol-Version: 2026-07-28` get HTTP 400 today (README says so) and must fall back; as clients adopt the new revision this becomes a hard failure. 1.x is the legacy line, security fixes only.
2. **Move to v2 and serve both eras with `createMcpHandler` default.** One factory, 2025 clients keep working through the stateless fallback, 2026 clients work natively. This is the recommended path.
3. **Dual build (1.x and v2 behind a flag).** Doubles the test matrix. Only worth it if v2 cannot run on Node 22; it can, but confirm.

## Recommended plan (option 2), in order
1. Spike on a branch: install v2 packages in a temp dir, port `makeServer` to `createMcpHandler` against the fake upstream, run the existing suite unchanged except for imports. Exit criterion: all 145 tests green on 2025-style requests (our tests speak 2025 JSON-RPC).
2. Port the child side (`Client`/`StdioClientTransport`) separately, one commit, e2e against the real Google/Tavily/Notion/GitHub upstreams, because their servers are the part we cannot fake.
3. Add 2026-era tests: a request with the `_meta` envelope and `MCP-Protocol-Version: 2026-07-28`, `server/discover`, header validation, `subscriptions/listen` receiving `tools/list_changed` when a late upstream finishes loading (replaces the stateful-mode push).
4. Decide the fate of `stateful: true` (see risks). Keep it only for 2025 clients or deprecate it.
5. Update `sdkRoot`, `package.json` dependencies and `engines`, CI matrix (newest-SDK job tracks v2; keep a 1.x job only if option 3), README protocol line, CHANGELOG, ARCHITECTURE.
6. Live: deploy with a backup of `router.mjs` and `lib/`, run e2e, verify Claude Code and OpenCode still connect (both are 2025 clients today).

## Risks
- **Stateful mode has no direct v2 equivalent.** Sessions, the 256-session cap and the GET stream are 2025 constructs. Options: drop the mode (breaking change, acceptable before 0.1.0 is published), or route 2025 session traffic to a retained v1-style handler behind `isLegacyRequest` (the SDK docs show this pattern). The second keeps the v1 transport code alive, which defeats part of the point.
- **`sdkRoot` semantics.** Today one directory provides one package. With several packages (`server`, `client`, `core`, `node`) the lookup and the error message change; users with a custom `sdkRoot` break.
- **Child compatibility.** Legacy default negotiation keeps today's behaviour. Turning on `auto` costs one extra spawn per child on stdio and gains nothing until upstream servers speak 2026. Do not enable it.
- **Handler context differences.** `extra.signal`, progress and `sendRequest` become `ctx.mcpReq.*`; cancellation forwarding to children (`signal` in `forward`) must be re-tested, including the idle-kill busy guard.
- **Validation is ours.** `createMcpHandler` performs no Origin/Host/auth checks. The existing checks must run before it; the 403/401 tests must stay green.
- **Alpha-to-stable drift.** The docs mention differences from earlier v2 alphas and a codemod (`npx @modelcontextprotocol/codemod@latest v1-to-v2 .`). Run it on a copy; its `@mcp-codemod-error` markers list what it could not rewrite. Our dynamic-import-by-path pattern is unusual and the codemod will probably miss it.
- **Single-maintainer, pre-publication timing.** Doing this before the first publish avoids shipping a package whose public API (`stateful`, `sdkRoot`) changes in 0.2.

## Effort estimate
Spike plus child port plus tests: about one focused session. The unknown is the stateful-mode decision, which is a product choice, not a technical one.

## Decisions needed from the maintainer
1. Go or stay on 1.x until the first publish?
2. `stateful: true`: drop it, or keep it for 2025 clients through the legacy router?
3. Support both eras (recommended) or 2026-only (`legacy: 'reject'`)?
