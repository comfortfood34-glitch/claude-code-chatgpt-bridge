import test from "node:test";
import assert from "node:assert/strict";
import { authorizedRelayToken, validRelayId } from "./mac-relay.js";

test("relay token is checked with exact fixed-length equality", () => {
  const good = "long-private-mac-relay-token-generated-only-for-tests-abc123";
  assert.equal(authorizedRelayToken(good, good), true);
  assert.equal(authorizedRelayToken(good + "x", good), false);
  assert.equal(authorizedRelayToken("bad", good), false);
  assert.equal(authorizedRelayToken("", good), false);
  assert.equal(authorizedRelayToken(good, "short"), false);
  assert.equal(authorizedRelayToken(good, undefined), false);
});

test("relay jobs are UUIDs, not arbitrary Redis key fragments", () => {
  assert.equal(validRelayId("87a31287-67d2-4607-82d2-cf7ecb3ac85d"), true);
  assert.equal(validRelayId("../../secrets"), false);
  assert.equal(validRelayId("not-a-uuid"), false);
});
