# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [0.1.0] - 2026-10-26

First tagged version. Earlier work was done under the working name `gw-mcp-router`.

### Added
- HTTP (Streamable) front end with lazy per-account stdio workers, idle kill, and one shared tool list with an optional `account` argument.
- JSON config file: several upstreams per router, account discovery, `{account}` templating, per-account tool policy (`allow`/`deny`), warmup call, prompts/resources forwarding.
- Security options: loopback-only binding, bearer token, Unix socket (mode 600), Origin/Host checks, body cap.
- Opt-in account pools: round-robin, sticky and usage-aware `most-remaining` strategies, quota failover with an explicit retry tool allowlist, per-account cooldown.
- `acctmux init`: writes a starter config from presets, a 600-mode bearer token file (opt out with `--no-auth`), refuses to overwrite a config, prints Claude Code, OpenCode and Codex snippets.
- Presets for Tavily, Notion and GitHub (versions pinned) next to the Google one; `docs/SETUP-FOR-AGENTS.md`.
- A startup warning when bearer auth is off.
- Exponential backoff for accounts and upstreams that fail to start: `failTtlMs`, then doubling per failure up to 10 minutes, reset on success.
- Per-upstream `callTimeoutMs` (default 300000) for the forward timeout.
- Benchmark harness (`scripts/bench.mjs`, `bench-startup.mjs`, `bench-parity.mjs`) and reports in `docs/benchmarks/` (2026-10-23 with real accounts, 2026-10-25 re-run after the SDK v2 migration, credential-free).
- 155 tests against a fake upstream, ESLint, CI on Node 22 and 24, against the newest published MCP SDK, and on macOS.
- `acctmux` executable (`--help`, `--version`), Apache-2.0 licence, launchd and Docker examples (untested).

### Changed
- Renamed to `acctmux`. `ACCTMUX_*` environment variables and `~/.config/acctmux/config.json` are preferred.
- The MCP SDK is now a runtime dependency and is resolved from the package itself when present.

### Fixed (independent review 02)
- Per-account `deny` lists no longer replace the `*` deny list (they add to it).
- A default account that cannot start no longer takes the router down while another account loads in time: other accounts are tried to load the tool list, within a time budget of three connect timeouts.
- Children started by `prompts/get` and `resources/list` are idle-killed.
- A tool that already has an argument named like the selector is refused with a clear message; the selector name can be set per upstream.
- A failed upstream is retried in the background instead of delaying calls to working ones.
- A pool moves on to the next member when one cannot start.
- New `host` option (`::1` or `127.0.0.1`).

### Fixed (independent review 03)
- A pool re-ran a call on another member after a login failure that surfaced mid-call, even for tools outside the retry list. It now moves on only when the call never ran.
- A selector clash no longer retries other accounts, and startup bounds the fallback by time.
- `~` is expanded in `env` values and `args`; `selector` is validated; policy entries that match no account or pool are logged as warnings.
- Docs: bind address, credential-reading claim, pool retry rules, cancellation caveat. The package no longer ships the raw benchmark JSON; the Tavily example pins `tavily-mcp`.

### Fixed (independent review 04)
- Fallback over accounts at startup is bounded by time, not by a count of three (this replaced the review 03 count cap); `tools/list` and `prompts/list` use the connect timeout (an upstream that connects and hangs no longer holds startup for 60 s).
- The shipped examples keep `authRequired` and `BROWSER` for the Google upstream (fast login failure, no browser).
- A child that fails to start has its last stderr logged.
- A login failure surfacing mid-call moves a pool call to the next member for tools in the pool's `tools` list.
- Policy shape is validated; policy tool names that the upstream does not have are logged as warnings; `upstreams` must be a non-empty list.

### Fixed (independent review 05)
- A single upstream that fails to start now logs the child's stderr before the router exits.
- The Google defaults and examples set `XDG_CURRENT_DESKTOP=X-Generic`, so `xdg-open` no longer launches a browser on GNOME, KDE and similar desktops.
- `tools/list` and `prompts/list` share one deadline and are capped at 100 pages; an upstream that never ends the list no longer hangs startup.
- An upstream is marked loaded only after its tools and prompts both loaded.
- Upstream entries are validated (object, `command`, `accounts`, `args`, regular expressions) with a clear message.

### Changed (listen-first startup)
- The router opens its port before upstreams load and loads them in the background. A request waits for upstreams on their first load for at most `loadWaitMs` (default 20 s), then is served from the loaded ones, or gets `503` with `Retry-After` when none has loaded. Listening clients receive `tools/list_changed` when a late upstream finishes loading. The router still exits 1 when every upstream has failed.

### Changed (MCP SDK v2, protocol 2026-07-28)
- The front end moved from `@modelcontextprotocol/sdk` 1.x to the v2 packages (`server`, `client`, `node`). `createMcpHandler` serves spec revision 2026-07-28 natively (no handshake, no session) and 2025-era clients through the SDK's stateless fallback, from one endpoint. 2025-era answers are now one SSE event instead of a JSON body.
- `tools/list_changed` reaches 2026-07-28 clients that open `subscriptions/listen`, when an account appears or a late upstream loads.
- **Removed:** `stateful`, `sessionTtlMs` and `maxSessions` (no protocol sessions in v2). Setting them logs a warning and is ignored. Only POST is served on `/mcp`.
- `sdkRoot` must now provide `@modelcontextprotocol/server`, `/client` and `/node`.

### Changed (modules)
- `router.mjs` is now a thin entry point; the code lives in `lib/` (`util`, `config`, `accounts`, `pool`, `runtime`, `workers`, `surface`, `http`) with no behaviour change. A copy of `router.mjs` needs its `lib/` directory beside it. `lib/pool.mjs` and `lib/accounts.mjs` can be imported without starting a server and have direct unit tests (`tests/pool.test.mjs`).

### Fixed (modules)
- `noMemberMessage` built every reason text eagerly, so a pool member in the "already tried" state (no recovery time) made it throw `RangeError: Invalid time value` instead of returning the "No member of pool can take this call" message.

### Added (security audit, live hardening)
- The shipped examples now carry a policy that denies the irreversible or exposing tools: the Google example denies deletes, `create_filter` (a mail filter can forward mail), `remove_permission`, `share_file` and `batch_share`; the new `config.github.example.json` denies `delete_file` and `merge_pull_request`. The README's Security section already shows how to enable the bearer token.

### Fixed (security audit, workflow)
- GitHub Actions are pinned to commit SHAs (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, which also removes the Node 20 deprecation warning), the workflow token is read-only, and Dependabot proposes weekly updates to the pins.

### Fixed (security audit, low findings)
- Account names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`: they are used in file paths and `{account}` command templates, so a name such as `x;rm` or `../y` is refused at load, and a scanned profile directory with such a name is ignored and logged.
- The router warns when the config file or a pool `usage.keyFile` is readable by other users.

### Added (untested paths)
- The Docker image was built and run on a real daemon: it starts as the non-root `node` user, serves requests over a Unix socket (mode 600) and exits 0 with the socket removed on `SIGTERM`. CI now does the same in a `docker` job. The Dockerfile comment and README say so.
- The macOS CI job runs `plutil -lint` on the launchd plist. Loading it under launchd is still untested.
- A test sends Tavily's documented plan-limit error, wrapped as `tavily-mcp` wraps it, through the pool settings of `config.pool.example.json` and checks the call moves to the next member.
- Verified against the live router: GitHub, Notion and Tavily calls from a 2026-07-28 client (`versionNegotiation: auto`), a legacy SDK client, Claude Code and OpenCode 2.1.2.

### Added (contributing)
- Issue templates (bug report, feature request) and `CONTRIBUTING.md`.

### Added (packaging checks)
- Tests check the launchd plist (well-formed, documented keys only) and the Dockerfile (existing `COPY` sources, non-root user, exec-form entrypoint). Neither has been run under launchd or `docker build` (the Docker daemon was down); both stay labelled untested. The plist gained an `EnvironmentVariables` `PATH`, and `.dockerignore` keeps `node_modules` out of the build context.

### Added (pre-release polish)
- `requireAccount` (per upstream): the selector becomes a required argument and a call without it is refused instead of using the default account.
- `"preset": "google-workspace"` replaces the built-in Google default. With no config file the router now prints an example config and exits.
- Numeric options, `accounts` shape, `authRequired` and `resultMatch` are validated at load; the child's stderr is logged when `tools/list` or `prompts/list` fails.

### Removed
- Built-in Google upstream (use the preset), the `GW_ROUTER_*` variables and the `~/.config/gw-mcp-router/` path, `main` in `package.json`, and `docs/reviews/` from the npm package.
- Upgrade note: an existing config that sets its own `env` for the Google upstream replaces the preset's, so add `BROWSER=true` and `XDG_CURRENT_DESKTOP=X-Generic` by hand (otherwise GNOME and KDE can open a login browser).

### Known gaps
- The startup time budget for the account fallback is checked before each attempt, not during one.
- A child's stderr tail is logged verbatim on a failed start and may contain secrets the upstream prints.
- Prompts and resources come from the default account only, and `sh -c "... npx ..."` upstreams may leave a grandchild process behind on shutdown (untested).
- Explicit `notifications/cancelled` is not honoured for 2025-era clients (client disconnects and 2026-07-28 stream closes are); no progress forwarding.
- Tool names can change at runtime when an upstream that was slow or down at start loads later; a session's `prompts`/`resources` capabilities and instructions reflect only the upstreams loaded when it was created.
- Omitting `account` uses the default account, also for destructive tools, unless the upstream sets `requireAccount`.
- Without auth, any local process can fill the SDK's cap on open `subscriptions/listen` streams.
- Only Google (two servers), Tavily, Notion and GitHub have been run through it.
- The real Tavily quota-exhausted error has not been observed; the failover regex comes from Tavily's API docs.
