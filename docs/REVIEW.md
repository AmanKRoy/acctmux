# Review log

Independent adversarial review by an Opus subagent (read-only; ran throwaway copies on other ports with a fake child). Date 2026-10-23.
Verdict on v0.1: sound design, **not safe to rely on daily** until B1-B4 were fixed. All of the below were fixed in v0.2 unless noted.

| ID | Finding | Status |
|---|---|---|
| B1 | Child crash mid-call hung the client 300 s: assigning `transport.onclose` after `connect()` overwrote the SDK's own handler so pending requests were never rejected | **Fixed** - use `client.onclose`; verified: killing the child mid-call returns `Connection closed` in ~0.5 s and next call respawns |
| B2 | Child failing to start blocked callers 60 s per retry; failed entry deletion could remove a newer healthy entry | **Fixed** - 15 s connect timeout, 30 s failure cache, identity-checked deletion |
| B3 | Any web page could call tools (CSRF via `text/plain; x=application/json`, DNS rebinding); no Host/Origin checks | **Fixed** - reject `Origin`, non-loopback `Host`, non-exact JSON content type; verified 403 on all three, 200 on legit |
| B4 | No body size limit | **Fixed** - 32 MB cap, 413 (verified with 40 MB body) |
| B5 | Advertised default account `"default"` invalid on profile-only setups | **Fixed** - default = `default` if present else first account |
| B6 | Upstream resources/prompts/listChanged not exposed | **Documented** (not needed for this upstream's usage) |
| B7 | Client cancellation not forwarded | **Fixed** - `extra.signal` passed through |
| B8 | Expired token makes the child start an interactive OAuth flow and hang up to 5 min | **Documented**; mitigation is re-running `auth --profile <name>` |
| B9 | New accounts not visible in open sessions (stateless, no `listChanged`) | **Documented** |
| B10 | `tools/list` pagination ignored; listen errors unhandled; `After=network-online.target` meaningless in user units; REVIEW.md placeholder | **Fixed** (pagination, listen error exit); unit `After=` left harmless |
| O5 | Idle default 10 min keeps every touched account resident | **Fixed** - 150 s default |
| O7 | Startup child discarded | **Fixed** - kept warm and idle-killed |
| O8 | Spawn failures not cached | **Fixed** (30 s) |
| O11 | Children inherited full environment | **Fixed** - allowlist |
| O9 | Replace per-tool enum with plain string to save ~1.5k tokens | Not done (enum gives schema-level validation) |
| O10 | Cap child semi-space | Not done (unmeasured) |
| Alt | Worker threads per account | Rejected (upstream `process.exit`/signal handlers, fragile) |

Verified correct by the reviewer: concurrent first calls share one spawn; idle-kill cannot fire mid-call; batch/ping/protocol-version handled by the SDK;
`accounts()` names never reach a filesystem path (no traversal).

Reviewer's corrections to the original docs: RSS overstated real cost (PSS: router 32 MB, child ~99 MB); context saving mostly relevant to clients
that do not defer tool schemas; a natively multi-account upstream (taylorwilsdon/google_workspace_mcp) or Google's official remote servers make the router unnecessary
for Google specifically. Merit as open source: the pattern (single tool surface + injected profile selector + lazy child per credential set) is
reasonably unusual, but publishing needs generalising the hard-coded upstream command/profile env var.

## Later reviews
Review 01 is summarised above. Reviews 02 to 07 (all 2026-10-24) are archived in `docs/reviews/` with a disposition for every finding. They are automated reviews by Claude Opus subagents, not human audits. Review 07 is a whole-repo and efficiency audit; a dedicated security pass is still to do.
