import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAlwaysLoad } from "../lib/util.mjs";

test("stripAlwaysLoad removes anthropic/alwaysLoad and drops empty _meta", () => {
  assert.deepEqual(stripAlwaysLoad({ name: "a", _meta: { "anthropic/alwaysLoad": true } }), { name: "a" });
});
test("stripAlwaysLoad keeps other _meta keys", () => {
  assert.deepEqual(stripAlwaysLoad({ name: "a", _meta: { "anthropic/alwaysLoad": true, x: 1 } }), { name: "a", _meta: { x: 1 } });
});
test("stripAlwaysLoad leaves tools without the flag untouched", () => {
  const t = { name: "a", _meta: { x: 1 } };
  assert.equal(stripAlwaysLoad(t), t);
});
