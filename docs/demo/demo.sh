#!/bin/sh
# Credential-free demo: one acctmux endpoint, two accounts, `account=work` versus `account=personal`.
# Run from the repository root:  sh docs/demo/demo.sh
# It uses the fake upstream from the tests, so no Google login is needed. Needs node 22+, curl, jq.
set -e
D=$(mktemp -d)
trap 'kill $PID 2>/dev/null; rm -rf "$D"' EXIT
PORT=${PORT:-18790}
cat > "$D/config.json" <<EOF
{"port": $PORT, "upstreams": [{"name": "demo", "command": "node", "args": ["$PWD/tests/fake-upstream.mjs"],
  "profileEnv": "FAKE_PROFILE", "accounts": ["work", "personal"], "defaultAccount": "work", "requireAccount": true}]}
EOF
chmod 600 "$D/config.json"
ACCTMUX_CONFIG="$D/config.json" node router.mjs 2>"$D/log" & PID=$!
until grep -q "router listening" "$D/log" 2>/dev/null; do sleep 0.2; done
URL="http://[::1]:$PORT/mcp"
rpc() { curl -s "$URL" -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d "$1" | sed 's/^data: //' | grep '^{'; }
echo '$ tools/list  (every tool carries an account argument)'
rpc '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq -c '.result.tools[] | select(.name=="whoami") | {name, account: .inputSchema.properties.account.enum}'
for a in work personal; do
  echo "\$ whoami account=$a"
  rpc "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"whoami\",\"arguments\":{\"account\":\"$a\"}}}" | jq -r '.result.content[0].text | fromjson | "profile=\(.profile) pid=\(.pid)"'
done
echo '$ whoami (no account: refused, requireAccount is on)'
rpc '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"whoami","arguments":{}}}' | jq -r '.result.content[0].text'
