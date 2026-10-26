# Set up acctmux (guide for an AI coding agent)

Give this file to your AI harness (Claude Code, OpenCode, Codex) and ask it to install and configure acctmux. Every step is non-interactive. Do the steps in order and stop at "Ask the user".

acctmux is one local MCP endpoint that routes each tool call to a per-account child process of an upstream MCP server. Requires Node 22 or newer.

## 1. Install

```sh
git clone https://github.com/AmanKRoy/acctmux.git && cd acctmux && npm install --omit=dev
```

Run it as `node /path/to/acctmux/router.mjs`. (After an npm release, `npx acctmux` does the same.)

## 2. Write the config

Pick the services the user wants. Ask the user for account names for every non-Google service.

```sh
node router.mjs init --preset google-workspace
node router.mjs init --preset tavily,notion,github --accounts work,personal
```

`init` writes `~/.config/acctmux/config.json` and a random bearer token in `~/.config/acctmux/token`, both mode 600, and prints client snippets. It refuses to overwrite an existing config. Add `--no-auth` only if the user asks for it. To change the port use `--port N`.

Never print, log or paste the token file or any file under `~/.config/acctmux/creds/`.

## 3. Add credentials

- **Google:** `npm install -g @dguido/google-workspace-mcp`, then `google-workspace-mcp auth` for the default account and `google-workspace-mcp auth --profile NAME` per extra account. This opens a browser: **Ask the user** to complete it.
- **Tavily, Notion, GitHub:** **Ask the user** to put each account's key or token into `~/.config/acctmux/creds/<service>-<account>.<key|token>` (the exact file names are printed by `init`), mode 600. Do not ask them to paste secrets into the chat.

## 4. Start it

```sh
node router.mjs            # foreground; the log says "router listening"
```

For a permanent service use `systemd/acctmux.service` (copy to `~/.config/systemd/user/`, set the paths, `systemctl --user enable --now acctmux`).

## 5. Connect the client

Use the snippet that `init` printed for the user's client. In short:

- **Claude Code:** `claude mcp add --transport http acctmux http://[::1]:18704/mcp --header "Authorization: Bearer $(cat ~/.config/acctmux/token)"`. For a header that is not stored in `~/.claude.json`, use the `headersHelper` form from the `init` output.
- **OpenCode:** an `mcp` entry with `"type": "remote"`, the URL, and the header `"Authorization": "Bearer {file:~/.config/acctmux/token}"`.
- **Codex:** `[mcp_servers.acctmux]` with `url` and `bearer_token_env_var = "ACCTMUX_TOKEN"`, and `export ACCTMUX_TOKEN="$(cat ~/.config/acctmux/token)"`.

Restart the client so it picks up the server.

## 6. Verify

Ask the client to list the tools of the `acctmux` server. Every tool has an `account` argument whose allowed values are the configured accounts. Call a harmless tool (for example `get_storage_quota` for Google, or `tavily_search`) with `account` set to each account and check that the answers come from different accounts.

If the endpoint answers 401, the client is missing the bearer header. If the first call to an account takes several seconds, that is the child starting; the next calls are fast. Logs: the foreground output, or `journalctl --user -u acctmux`.

## Things to tell the user

- Without `account`, a call uses the default account. For services where the wrong account is costly (mail, calendar) set `"requireAccount": true` on the upstream.
- Per-account allow and deny lists (`policy`) can remove dangerous tools, for example deleting or sharing. See `docs/CONFIG.md`.
- Tested mainly on Linux. The launchd example has never been loaded under launchd.
