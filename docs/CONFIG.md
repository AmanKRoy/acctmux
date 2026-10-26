# Configuration

The router reads `$ACCTMUX_CONFIG`, or `~/.config/acctmux/config.json`. With no file it prints an example and exits; there are no built-in upstreams. See `config.example.json` (generic), `config.google.example.json`, `config.multi.example.json` and `config.pool.example.json`. A given key replaces the default; omitted keys keep it. Numeric options (`port`, `idleMs`, `maxBody`, `connectTimeoutMs`, `loadWaitMs`, `failTtlMs`, `accountPollMs`, `sessionTtlMs`, `maxSessions`) must be positive numbers.

| Key | Meaning |
|---|---|
| `connectTimeoutMs`, `failTtlMs` | Child start timeout (default 15000 ms; one shared deadline bounds the first `tools/list` and `prompts/list`, 100 pages at most; warm-up has its own timeout) and how long a start failure is cached (default 30000 ms; each further failure in a row doubles the time, up to 10 minutes, and a success resets it). |
| `loadWaitMs` | The router opens its port first and loads upstreams in the background. A request waits at most this long (default 20000 ms) for upstreams that have not finished their first load, then is served from those that have; if none has loaded it gets `503` with `Retry-After`. |
| `host` | Loopback address to bind: `::1` (default) or `127.0.0.1` for hosts without IPv6. Other values are refused. |
| `port`, `idleMs`, `maxBody` | Listener port, idle-kill timeout, request body cap. Env vars `ACCTMUX_PORT`, `ACCTMUX_IDLE_MS`, `ACCTMUX_MAX_BODY` set the defaults. |
| `accountPollMs` | The router checks the account lists every `accountPollMs` (default 5000) and publishes `tools/list_changed` to clients that opened a `subscriptions/listen` stream (protocol revision 2026-07-28) when an account appears or disappears, and when a late upstream finishes loading. 2025-era clients are served per request and see the change on their next `tools/list`. The former `stateful`, `sessionTtlMs` and `maxSessions` options are gone (the SDK v2 front end has no protocol sessions); setting them logs a warning and is otherwise ignored. |
| `socket`, `tcp` | `socket` (or env `ACCTMUX_SOCKET`) adds a Unix-socket listener created with mode 600; `tcp: false` turns the loopback TCP listener off. A stale socket file is replaced, a socket held by a live process or a regular file at that path is refused. The `Host` check is skipped on the socket (no DNS rebinding over a filesystem socket); `Origin`, content type, size cap and bearer auth still apply. Try it: `curl --unix-socket PATH -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{...}' http://localhost/mcp`. Many MCP clients cannot speak HTTP over a Unix socket yet, so check yours before switching TCP off. |
| `auth` | `{tokenFile}` or `{token}`: require `Authorization: Bearer <token>` on every request. Env `ACCTMUX_TOKEN` overrides. Token files must be mode 600; tokens need 16+ characters. Default: no auth. |
| `selector` | Name of the added tool argument (default `account`); must be an identifier (letters, digits, `_`, not starting with a digit). Also settable per upstream; an upstream whose tools already have an argument with that name is refused at load, with a message telling you to rename the selector. |
| `sdkRoot` | Directory whose `node_modules` provides `@modelcontextprotocol/server`, `/client` and `/node` (SDK v2). Default: acctmux's own dependency. Needed only for a copy of `router.mjs` and `lib/` that has no `node_modules` next to it; the router refuses to start if it finds no SDK. |
| `upstreams` | List of upstream MCP servers. Each is an object and needs a unique `name` matching `[A-Za-z0-9_-]+`, a `command` and `accounts`, or `"preset": "google-workspace"` to start from the Google values (any key you set replaces the preset's; `env` is replaced as a whole, not merged, so keep `BROWSER` and `XDG_CURRENT_DESKTOP` if you override it). |

## Presets
`{"preset": "<name>"}` starts an upstream from built-in values; any key you set replaces the preset's. The upstream is named after the preset unless you set `name`. `acctmux init --preset <name>` writes such a config.

| Preset | Runs | Accounts | Credential |
|---|---|---|---|
| `google-workspace` | `google-workspace-mcp` on the `PATH` | discovered from `~/.config/google-workspace-mcp` | the upstream's own OAuth login |
| `tavily` | `tavily-mcp@0.2.22` through `npx` | you list them in `accounts` | `~/.config/acctmux/creds/tavily-{account}.key` |
| `notion` | `@notionhq/notion-mcp-server@2.5.2` through `npx` | you list them in `accounts` | `~/.config/acctmux/creds/notion-{account}.token` |
| `github` | `github-mcp-server stdio` on the `PATH` | you list them in `accounts` | `~/.config/acctmux/creds/github-{account}.token` |

The `github` preset also denies `delete_file` and `merge_pull_request`; set `policy` to change that. Credential files are plain text, one per account, mode 600. The versions are pinned on purpose; override `args` to move.

## Upstream keys
- `command`, `args`, `env`: how to launch the stdio server. `env` is added to the child's environment. `~` at the start of an `env` value or an `args` entry is expanded to the home directory.
- `envPass`: regex of parent environment variables passed through. The MCP SDK always adds `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER`; everything else is dropped.
- `requireAccount`: `true` makes the selector a required argument with no default, so a call without it is refused instead of using `defaultAccount`. Recommended for upstreams where acting on the wrong account is costly (mail, calendar). Prompts and resources still use `defaultAccount`.
- `callTimeoutMs`: how long one tool call may run before the router gives up on it and returns a timeout error (default `300000`, positive number). The child keeps running; only the call is abandoned.
- `profileEnv`: environment variable the upstream reads to pick a credential set. Set to the account name for every account except `defaultAccount`, where it is unset.
- `accounts`, one of three forms:
  - array of names: `["work", "home"]`
  - object with per-account env: `{"ai": {"env": {"USER_GOOGLE_EMAIL": "..."}}}`
  - scan: `{root, marker, profilesDir}`. Lists `defaultAccount` if `root/marker` exists, plus each `root/profilesDir/<name>/` that contains `marker`.
- `{account}` inside `env` values and `args` is replaced with the account name. Use it for per-account credential directories. Account names (and `defaultAccount`) must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, because they end up in file paths and often inside `sh -c` templates. A configured name outside that set stops the router at load; a scanned profile directory outside it is ignored and logged.
- The router warns on stderr when the config file, or a pool `usage.keyFile`, is readable by other users (`chmod 600`). The token file is stricter: a group- or world-readable `auth.tokenFile` is refused.
- `defaultAccount`: account used when the caller omits the selector, and the one that runs without `profileEnv` (default `"default"`). Falls back to the first account.
- `profileEnv`: optional. Omit it for upstreams that select the account through `env` instead.
- `selectorDescription`: description text on the added argument.
- `warmup`: `{tool, arguments?}`. Called once after a child starts and before the first forwarded call. Use a cheap tool that forces the upstream to authenticate.
  Needed for google-workspace-mcp, whose `get_status` reports a false error on a cold child. Failure is logged and ignored.
- `authRequired`: `{match?, resultMatch?, message}`. `resultMatch` is a regex tested against the text of an `isError` tool result, for upstreams that report a missing login in the result
  instead of blocking (taylorwilsdon's `workspace-mcp` answers `ACTION REQUIRED: Google Authentication Needed`). A hit is handled like a stderr hit: child killed (it would keep a login callback port open), failure cached 30 s, `message` returned.
  The rest of this item describes `match`: Some upstreams answer an expired login by opening a browser and blocking the call for minutes. When the child's stderr matches the
  `match` regex, the router kills the child and returns `message` (`{account}` is substituted) at once; repeats are answered from cache for 30 s.
  If the upstream also deletes the account's token (google-workspace-mcp does), the account drops out of the scan, and the router keeps returning the same message instead of "Unknown account" until the account is back.
  The `google-workspace` preset sets this and sets `BROWSER=true` and `XDG_CURRENT_DESKTOP=X-Generic`. The first is read by the `open` package the upstream uses; the second makes `xdg-open` ignore GNOME, KDE and XFCE specific openers (`gio`, `kde-open`, `exo-open`) that do not look at `$BROWSER`. Note that `envPass` includes `XDG_.*`, which would pass the real desktop name through, so the preset's `env` value is what overrides it. If you write your own Google upstream, set both, or a login window can still open on those desktops.
- `policy`: `{ "<account>" | "*": { allow?: [tools], deny?: [tools] } }`. `deny` lists add up (a `*` deny can never be lifted for one account); an account's `allow` replaces the `*` allow. Denied calls return an error and never reach the upstream. A tool denied for every account is hidden from `tools/list`.
- `pools`: optional account pools, see below.

## Account pools

Pools are meant for failover between credentials you are entitled to use (for example several keys of your own plan or team). Check the provider's terms before rotating keys to get around a free-tier limit.
For upstreams whose accounts are interchangeable (several API keys for the same search service, each with its own monthly quota), an upstream can define
pools. A pool name is a selector value like an account name: it is listed in the selector `enum` after the accounts and described in the selector
description, and it can be the upstream's `defaultAccount`. A call with `account=<pool>` picks a member, and when that member's quota is exhausted it
moves on to the next one. Google accounts are not interchangeable (each has its own mailbox and Drive), so do not pool them.

```json
"pools": {
  "auto": {
    "members": ["sunny", "product", "ai"],
    "strategy": "round-robin",
    "failoverMatch": "<regex for the upstream's quota error text>",
    "cooldownMs": 3600000,
    "tools": ["tavily_search", "tavily_extract"]
  }
}
```

| Key | Meaning |
|---|---|
| `members` | Required. Distinct account names of the same upstream, tried in this order. Pools cannot contain pools. |
| `strategy` | `round-robin` (default): each call starts at the next member (one counter per pool). `sticky`: calls stay on one member until it is exhausted, then stay on the member that took over. `most-remaining`: always tries the member with the most credits left first (needs `usage`). |
| `failoverMatch` | Required. Regex tested against the text items of an `isError` tool result. A match marks the member as exhausted. |
| `cooldownMs` | How long an exhausted member is skipped (default 3600000, 1 h). |
| `tools` | Required, non-empty. Upstream tool names (not the `<upstream>__` prefixed names) that may be **retried** on the next member after a quota error. There is deliberately no default and no wildcard: a retry runs the call a second time on another account, which is only safe for read-only, idempotent tools. |
| `usage` | Optional. Looks up each member's quota so the pool can avoid nearly-exhausted members before they fail. Keys: `url` (http/https GET endpoint), `keyFile` (file holding the member's key, `{account}` is replaced, `~` expanded), `used` and `limit` (dot paths into the JSON response, e.g. `account.plan_usage`), `headers` (default `{"Authorization": "Bearer {key}"}`, `{key}` is replaced), `ttlMs` (default 1800000), `skipAbovePct` (default 95), `cost` (default 1). |

**Usage lookups** are lazy and shared by all callers. Nothing runs while the pool is idle: the first pool call (and any later call that finds a member's data older than `ttlMs`) fetches the stale members in parallel and the other calls wait on that one refresh. Between refreshes each successful call adds `cost` to the member's count locally, so a busy pool does not keep using a member that is close to its limit. A quota error that matches `failoverMatch` marks that member's data stale. Members at or above `skipAbovePct` are skipped like a cooling member; explicit calls such as `account: "roy"` are never blocked by usage. A failed lookup (network, HTTP error, bad JSON) is logged without the key, never blocks a call, and is retried no sooner than 60 s later. The `cost` is an estimate: services that bill different tools differently (Tavily research calls cost more than searches) are corrected at the next refresh.

Tavily example (`GET https://api.tavily.com/usage` is free and returns `account.plan_usage` / `account.plan_limit`):
`"usage": {"url": "https://api.tavily.com/usage", "keyFile": "~/.config/acctmux/creds/tavily-{account}.key", "used": "account.plan_usage", "limit": "account.plan_limit"}`

Behaviour:
- **Failover**: a result matching `failoverMatch` cools the member for `cooldownMs`. If the tool is in `tools`, the same call is sent to the next available member, until one succeeds or no member is left; otherwise the quota error is returned as it is (the member still cools, so the next call goes elsewhere).
- **Moved on without a retry list**: a member that cannot start (start failure, or a login already known to be broken) never ran the call, so the same call goes to the next member whatever `tools` says. A member whose start failure is still cached (30 s) is skipped when choosing a member.
- **Never retried**: errors that do not match `failoverMatch`, timeouts, crashes, and cancellations. These are returned to the caller exactly as for a plain account. A login failure that surfaces while the call is running (`authRequired` banner or `resultMatch`) is retried on the next member only for tools listed in `tools`; otherwise it is returned.
- **All members exhausted**: the call fails with `All members of pool "auto" (sunny, product, ai) are cooling down after quota errors. The earliest, "sunny", recovers at <ISO time> (in N s).`, followed by the last upstream error. Further calls fail at once without reaching any upstream until a cooldown expires.
- **Recovery (half-open)**: once a member's cooldown has expired, the next call that reaches it is a single probe; concurrent calls skip that member until the probe finishes. Success puts it back into rotation, a new quota error cools it again.
- **Concurrency**: cooling members are never called, so concurrent calls do not pile onto an exhausted account. Calls already in flight when the first quota error arrives can still reach it.
- **Policy**: the pool name is checked like an account entry (its `deny` adds to `*`, its `allow` replaces the `*` allow), then each member's own policy; members that deny the tool are skipped.
- **State**: cooldowns and counters live in memory, are shared by all requests and are cleared by a restart. Cooldowns are per account, so an account in two pools cools in both.
- **Logging** (stderr): which member served each pool call, quota hits with their cooldown end, `rotating`/`not retried`, probes and recoveries. No arguments, results or keys of the router are logged. The last stderr of a child that fails to start is logged as the child printed it, so an upstream that echoes a secret in its error text will show it in the journal.
- Pool names must match `[A-Za-z0-9_-]+` and must not equal an account name; this is checked at startup (with a directory scan, against the accounts present then; a later account with a pool's name is shadowed by the pool). Unknown members stop startup, except with a directory scan, where they are skipped until they appear.
- With `profileEnv`, the account named `defaultAccount` is the one started without it. If `defaultAccount` is a pool, every member gets `profileEnv` set. Prompts and resources keep using the first account.

### Example: several Tavily API keys
`config.pool.example.json` runs `tavily-mcp` once per key, reading each key from its own file so no key appears in the config, the process list or the router's
environment (`sh -c` sets `TAVILY_API_KEY` for the child only). Put one key per file in `~/.config/acctmux/creds/tavily-<account>.key` with mode 600, and pin a
`tavily-mcp` version instead of using the latest. Keep account names to letters, digits, `-` and `_`, since they are substituted into the shell command.

**Quota error text** (from Tavily's API reference, not yet observed on a live exhausted key): a key over its plan limit gets HTTP 432 `This request exceeds your plan's set usage limit. Please upgrade your plan or contact support@tavily.com`; a pay-as-you-go cap gets 433 `This request exceeds the pay-as-you-go limit. You can increase your limit on the Tavily dashboard.`. `tavily-mcp` 0.2.22 turns an HTTP error into an `isError` result with the text `Tavily API error: {"error":"<message>"}` (checked in its source), so the example's `failoverMatch` is `This request exceeds (your plan's set usage limit|the pay-as-you-go limit)`. It deliberately does not match 429 (`Your request has been blocked due to excessive requests`, a short-lived rate limit that should not cool a key for an hour) or 401 (`Unauthorized: missing or invalid API key`, a config error). The retryable tools are the read-only ones that spend credits (`tavily_search`, `tavily_extract`, `tavily_map`, `tavily_crawl`); `tavily_research` is left out because it is long-running.

## Prompts and resources
If an upstream advertises them, the router advertises and forwards MCP prompts and resources (nothing is advertised otherwise).
- **Prompts** are account-independent templates: listed from each upstream's default account, or the account that loaded the tool list if the default could not start (cached at startup), `prompts/get` always runs on the default account, so it fails while that account cannot start. Name collisions get the `<upstream>__` prefix like tools.
- **Resources** belong to an account (google-workspace-mcp lists Drive files), so URIs are namespaced as `acctmux://<upstream>/<account>/<url-encoded original uri>`.
  `resources/list` shows each upstream's **default account** only (one page per upstream per request, with a combined cursor). `resources/read` works for any account: build the URI with that account's name.
  Resource templates and subscriptions are not forwarded.
- **Policy** covers them through pseudo-tool names: `prompts/get`, `resources/list`, `resources/read`. With an `allow` list these must be listed explicitly, otherwise they are blocked; with `deny` they can be denied by name. Without this a tool allow-list could be bypassed by reading files as resources.

## Using taylorwilsdon's workspace-mcp as an upstream
Tested against real accounts. Working example: `config.multi.example.json`.
- Run it per account with `uvx --python 3.12 workspace-mcp --single-user --tools gmail drive calendar` and a per-account `WORKSPACE_MCP_CREDENTIALS_DIR` plus `USER_GOOGLE_EMAIL` (set through the `accounts` object form). With `USER_GOOGLE_EMAIL` set, its tools no longer require `user_google_email`.
- It stores a login as `<creds dir>/<email>.json` (google-auth `authorized_user` shape). To reuse an existing google-workspace-mcp login without a second consent screen:
  `node scripts/dguido-to-taylor.mjs --source ~/.config/google-workspace-mcp/profiles/<name> --email <address> --out <creds dir>`
- Both servers can then share one refresh token. Checked: with an expired access token taylor refreshed it from the refresh token and wrote the file back, and google-workspace-mcp kept working on the same account afterwards (Google does not rotate installed-app refresh tokens on use). Revoking the grant breaks both.
- Set `authRequired.resultMatch` to `ACTION REQUIRED: Google Authentication Needed` so a missing login fails in about a second with your own message instead of leaving a login listener on port 8000.
- First start downloads the package (about 20 s); later starts take about 1.3 s.

## Several upstreams
Each upstream keeps its own accounts, children, idle timers and policy. The router merges their tool lists. A tool name offered by more than one upstream is exposed as
`<upstream>__<tool>` for every upstream that offers it; unique names stay unchanged. Each tool's selector enum lists only the accounts of the upstream that serves it.
If an upstream fails to start, the others keep working and the router retries it on a later request.
`config.multi.example.json` shows google-workspace-mcp plus taylorwilsdon's `workspace-mcp` side by side.

## Tests
`npm install && npm test` runs `node --test tests/` against a fake stdio upstream; no Google account is needed.
Set `TEST_SDK_ROOT` to a directory holding `node_modules/@modelcontextprotocol/server` (plus `client` and `node`; defaults to the repo itself). Tests run with a throwaway `HOME`.
`tests/e2e.py` is a separate live check against a running router and real accounts.
