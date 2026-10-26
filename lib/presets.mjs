// Opt-in presets: an upstream entry with "preset": "<name>" starts from these values and may override any of them (env is replaced, not merged).
// The Tavily, Notion and GitHub presets read one credential file per account from ~/.config/acctmux/creds/ and pin the upstream version.
// They have no built-in accounts: list them in "accounts" (see docs/CONFIG.md).
const CREDS_ENV = "^(PATH|HOME|USER|LANG|XDG_.*)$";
const fromFile = (variable, file, run) => ["-c", `${variable}="$(cat "$HOME/.config/acctmux/creds/${file}")" exec ${run}`];

export const PRESETS = {
  "google-workspace": {
    command: "google-workspace-mcp",
    env: { GOOGLE_WORKSPACE_SERVICES: process.env.GOOGLE_WORKSPACE_SERVICES || "drive,gmail,calendar", BROWSER: "true", XDG_CURRENT_DESKTOP: "X-Generic" },
    envPass: "^(PATH|HOME|USER|LANG|LC_.*|TZ|XDG_.*|NODE_OPTIONS|GOOGLE_.*)$",
    authRequired: {
      match: "AUTHENTICATION REQUIRED|Starting authentication flow",
      message: 'Account "{account}" needs re-authentication (token revoked or expired). Run `google-workspace-mcp auth` (add `--profile {account}` for a non-default profile).',
    },
    profileEnv: "GOOGLE_WORKSPACE_MCP_PROFILE",
    accounts: { root: "~/.config/google-workspace-mcp", marker: "tokens.json", profilesDir: "profiles" },
    selectorDescription: "Google account profile to use",
    warmup: { tool: "get_storage_quota" },
  },
  tavily: {
    command: "sh",
    args: fromFile("TAVILY_API_KEY", "tavily-{account}.key", "npx -y tavily-mcp@0.2.22"),
    envPass: CREDS_ENV,
    selectorDescription: "Tavily API key to use",
  },
  notion: {
    command: "sh",
    args: fromFile("NOTION_TOKEN", "notion-{account}.token", "npx -y @notionhq/notion-mcp-server@2.5.2"),
    envPass: CREDS_ENV,
    selectorDescription: "Notion workspace to use",
  },
  github: {
    command: "sh",
    args: fromFile("GITHUB_PERSONAL_ACCESS_TOKEN", "github-{account}.token", "github-mcp-server stdio"),
    envPass: CREDS_ENV,
    selectorDescription: "GitHub account to use",
    policy: { "*": { deny: ["delete_file", "merge_pull_request"] } },
  },
};

// File each credential preset reads, for the hints `acctmux init` prints.
export const CRED_FILES = { tavily: "tavily-{account}.key", notion: "notion-{account}.token", github: "github-{account}.token" };
