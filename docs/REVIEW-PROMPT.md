# Reusable prompt for the independent review (give to an Opus-class subagent)

You are an independent, adversarial senior reviewer. Read-only on the repo; you may run throwaway copies of the router on other ports (ACCTMUX_PORT=18711+)
with a fake stdio child and a fake HOME; never touch the live service, systemd units, user configs or real credentials/tokens; never print secrets.

Project: this repo (README.md, docs/ARCHITECTURE.md, docs/ROADMAP.md, docs/REVIEW.md, router.mjs, tests/, systemd/). Read all first. Also read docs/reviews/* to avoid repeating fixed findings.

Deliver, concise, with file:line refs and CONFIRMED/SUSPECTED tags:
1. Bugs/correctness/races/leaks/MCP-spec/security (verify against the SDK source in node_modules rather than guessing).
2. Architecture: is it the right design; challenge docs; concrete alternatives with numbers.
3. Differentiation: actually inspect (README/source/WebFetch) taylorwilsdon/google_workspace_mcp, Google's official Workspace MCP servers, MCPlexer, mcp-proxy, supergateway,
   MetaMCP, mcp-router, Docker MCP gateway, lazy-mcp. State precisely what this does that none of them do, and what they do better.
4. Test/CI/packaging/docs quality against open-source norms.
5. Ranked fixes (value/effort) with patch sketches.
6. VERDICT: ship for personal use? publish publicly? would you star it? what single thing blocks a yes? Be honest; no praise padding.
