# Limitations and alternatives

## Known limits

- Prompts and resources come from the default account only.
- 2025-era clients: a separate `notifications/cancelled` request is not honoured. A client disconnect is, and so is a 2026-07-28 stream close.
- Progress notifications are not forwarded.
- Without auth, any local process can fill the SDK's cap on open `subscriptions/listen` streams. `init` enables auth by default.
- Tool names can change at runtime when an upstream that was down at start loads later.
- Omitting `account` uses the default account, also for destructive tools, unless the upstream sets `requireAccount`.
- Only Google (two servers), Tavily, Notion and GitHub have been run through it.
- The real Tavily quota-exhausted error has not been observed.


## When not to use it

- **One account in one client session.** Plain stdio is simpler and has no daemon. It measured 51 MB less (156 vs 207 MB).
- **One account shared by a few sessions, no policy needed.** mcp-proxy also keeps one server for all sessions: 246-292 MB here vs the router's 207-228 MB. The router's value starts with the second account.
- **A server that already handles several accounts reliably.**
  - For Google, taylorwilsdon's `workspace-mcp` over HTTP used about a third of the router's memory (124 vs 383 MB at 8 sessions × 2 accounts).
  - Use it if its multi-account mode works for you.
  - In the benchmark it refused the second account's first call after a token refresh ("Attempt to rebind session"). This matches the open issue [#926](https://github.com/taylorwilsdon/google_workspace_mcp/issues/926).
  - #926 status on 2026-10-25: open, last activity 2026-09-27. Fix PRs #928 (conflicts with main) and #1049 are unmerged. Release notes for v2.1.2 and v2.2.0 do not mention it.
  - The maintainer says multi-user mode is for different users, not one user with several accounts ([#250](https://github.com/taylorwilsdon/google_workspace_mcp/issues/250), closed as by design).
  - acctmux avoids the failure with one process per account, at the cost of one process per active account.
- **You need cross-account fan-out** (query all accounts in one call). Routing is explicit: one account per call.
- **You need sampling or progress streams in stateless mode.**
  - A client disconnect cancels the upstream call.
  - A separate `notifications/cancelled` request is not honoured.
  - Progress is not forwarded.
- **Google's official remote Workspace servers fit your accounts.** On 2026-10-23 they required the Workspace Developer Preview Program (needs a Google Workspace account). Not benchmarked here.
- **You need the lowest latency for a cold account.**
  - The first call to an account starts its worker: about 2.2 s on 2026-10-23 with real accounts.
  - 0.9 s on 2026-10-25 against a Google server with no logins, so it depends on the upstream's start and token load.
  - A stdio server that a session already started answers in about 0.85 s, but its ~1.1 s start is paid when every session opens.

