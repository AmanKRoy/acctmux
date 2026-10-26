# Security policy

acctmux is experimental (0.x). It is meant to run on your own machine, bound to loopback or a Unix socket, with bearer auth turned on. Anything that can reach the endpoint can use every account the router has logged in, so do not expose it to a network.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Please do not open a public issue for a security problem.

Reports are handled on a best-effort basis by a single maintainer. Expect a first reply within about a week.

## Scope

In scope: the router (`router.mjs`, `lib/`), the config and token handling, the `acctmux init` command, and the example service files.

Out of scope: the upstream MCP servers that acctmux launches (report those to their own projects), and issues that need a local attacker who already runs as your user.
