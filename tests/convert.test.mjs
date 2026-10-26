import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "dguido-to-taylor.mjs");
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

test("converts a dguido profile into taylor's credential file with mode 600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctmux-conv-"));
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "tokens.json"), JSON.stringify({ access_token: "AT", refresh_token: "rt-secret-value", expiry_date: Date.UTC(2030, 0, 2, 3, 4, 5), scope: "s1 s2" }));
  fs.writeFileSync(path.join(src, "credentials.json"), JSON.stringify({ installed: { client_id: "CID", client_secret: "cs-secret-value", token_uri: "https://t.example/token" } }));
  const out = path.join(dir, "out");
  const r = run("--source", src, "--email", "a@example.com", "--out", out);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("rt-secret-value") && !r.stdout.includes("cs-secret-value"), "secrets are not printed");
  const file = path.join(out, "a@example.com.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    token: "AT", refresh_token: "rt-secret-value", token_uri: "https://t.example/token", client_id: "CID", client_secret: "cs-secret-value", scopes: ["s1", "s2"], expiry: "2030-01-02T03:04:05.000",
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

test("refuses a source without a refresh token and prints usage when args are missing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acctmux-conv-"));
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ access_token: "AT" }));
  fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ installed: { client_id: "c", client_secret: "s" } }));
  assert.equal(run("--source", dir, "--email", "a@example.com", "--out", path.join(dir, "o")).status, 1);
  assert.equal(run().status, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
