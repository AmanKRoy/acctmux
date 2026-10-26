#!/usr/bin/env python3
"""End-to-end check of a running acctmux. Read-only calls only.

usage: [ACCTMUX_TOKEN=...] python3 -I tests/e2e.py [url] [reference_url]
  url            router endpoint (default http://[::1]:18704/mcp)
  reference_url  optional: a stock single-account server over streamable HTTP
                 (e.g. mcp-proxy fronting google-workspace-mcp); when given, every
                 tool schema is diffed against it (router schema == reference + `account`).
"""
import json, os, sys, urllib.request

URL = sys.argv[1] if len(sys.argv) > 1 else "http://[::1]:18704/mcp"
REF = sys.argv[2] if len(sys.argv) > 2 else None
INIT = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e", "version": "1"}}}


class Session:
    def __init__(self, url):
        self.url, self.sid = url, None

    def rpc(self, body):
        h = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if os.environ.get("ACCTMUX_TOKEN"):
            h["Authorization"] = "Bearer " + os.environ["ACCTMUX_TOKEN"]
        if self.sid:
            h["mcp-session-id"] = self.sid
        r = urllib.request.urlopen(urllib.request.Request(self.url, json.dumps(body).encode(), h), timeout=90)
        self.sid = r.headers.get("mcp-session-id") or self.sid
        text = r.read().decode()
        for line in text.splitlines():
            if line.startswith("data:"):
                return json.loads(line[5:])
        return json.loads(text) if text.strip() else None


def check(label, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + label + (f"  {detail}" if detail else ""))
    return ok


s = Session(URL)
info = s.rpc(INIT)["result"]["serverInfo"]
tools = s.rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
ok = check("initialize + tools/list", len(tools) > 0, f"{info['name']} {info['version']}, {len(tools)} tools")

accounts = None
for t in tools:
    acc = t["inputSchema"].get("properties", {}).get("account")
    if acc is None or "account" in t["inputSchema"].get("required", []):
        ok &= check(f"{t['name']} has optional account param", False)
    elif not acc.get("enum"):
        ok &= check(f"{t['name']} account enum non-empty", False)
    elif accounts is None or t["name"] == "get_storage_quota":
        accounts = acc["enum"]
ok &= check("all tools carry optional `account`", accounts is not None, f"accounts={accounts}")

if REF:
    ref = Session(REF)
    ref.rpc(INIT)
    ref_tools = ref.rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})["result"]["tools"]
    by_name = {t["name"]: t for t in tools}
    bad = []
    for r in ref_tools:
        x = json.loads(json.dumps(by_name.get(r["name"], {})))
        if not x:
            bad.append(r["name"]); continue
        x["inputSchema"]["properties"].pop("account", None)
        if x != r:
            bad.append(r["name"])
    ok &= check("schemas identical to reference (minus `account`)", not bad and len(ref_tools) == len(tools), str(bad or ""))

for a in accounts or []:
    r = s.rpc({"jsonrpc": "2.0", "id": 3, "method": "tools/call",
               "params": {"name": "get_storage_quota", "arguments": {"account": a}}})["result"]
    email = (r.get("structuredContent") or {}).get("user", {}).get("emailAddress")
    ok &= check(f"get_storage_quota account={a}", not r.get("isError") and bool(email), email or "")

r = s.rpc({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
           "params": {"name": "get_storage_quota", "arguments": {"account": "__nope__"}}})["result"]
ok &= check("unknown account rejected", bool(r.get("isError")))
sys.exit(0 if ok else 1)
