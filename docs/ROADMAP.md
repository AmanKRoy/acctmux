# Roadmap

## Current state
Config-driven, multi-upstream, with per-account policy and account pools. 155 offline tests plus lint in CI. Verified on real accounts with Google Workspace servers, Tavily, Notion and GitHub. Seven automated reviews are archived in `docs/reviews/` (Claude agents reviewing the code, not human audits). See README.md, docs/CONFIG.md, docs/ARCHITECTURE.md and docs/REVIEW.md.

## Planned
- Rerun the benchmarks that need real Google accounts (warm-call latency, cold account) on the SDK v2 router; 2026-10-25 re-measured only the credential-free ones.
- Load the launchd plist under launchd on a real macOS machine (CI only lints it). The Docker example is run in CI.

## Known limits
- For 2025-era clients an explicit `notifications/cancelled` sent as a separate request is not honoured (a client disconnect is, and so is a 2026-07-28 stream close), and progress is not forwarded.
- Prompts and resources come from the default account only.
- The Google presets target `@dguido/google-workspace-mcp`; for Google accounts a natively multi-account server may be a better fit (see "When not to use it" in the README).

## Related work
- Natively multi-account servers make the router unnecessary for their own service: `taylorwilsdon/google_workspace_mcp` (its multi-account mode has an open token-refresh bug, issue #926) and Google's official remote Workspace servers (Developer Preview).
- Closest existing projects are listed in the README under "Related projects".
