import { strict as assert } from "node:assert";

import {
  AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY,
  AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY,
  CONTINUATIONS_PILOT_FEATURE_FLAG_KEY,
  isSlackBridgeProductFeatureFlagKey,
  MOBILE_INBOX_INPLACE_FEATURE_FLAG_KEY,
  SLACK_BRIDGE_FEATURE_FLAG_KEYS,
  SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS,
  SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS,
} from "./featureFlags";

test("Slack Bridge exposes product flags without hidden per-direction fuses", () => {
  assert.deepEqual(Object.values(SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS), [
    SLACK_BRIDGE_FEATURE_FLAG_KEYS.master,
  ]);
  assert.equal(SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS.length, 0);
  assert.equal(isSlackBridgeProductFeatureFlagKey(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master), true);
  assert.equal(isSlackBridgeProductFeatureFlagKey("unknown"), false);

  const all = new Set(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS));
  const products = Object.values(SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS);
  const internal = [...SLACK_BRIDGE_INTERNAL_FEATURE_FLAG_KEYS];
  assert.equal(new Set(products).size, products.length);
  assert.equal(new Set(internal).size, internal.length);
  assert.equal(products.some((key) => (internal as readonly string[]).includes(key)), false);
  assert.equal(all.has(SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer), true);
  assert.equal(all.has(SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync), true);
  assert.equal(isSlackBridgeProductFeatureFlagKey(SLACK_BRIDGE_FEATURE_FLAG_KEYS.attachmentTransfer), false);
  assert.equal(isSlackBridgeProductFeatureFlagKey(SLACK_BRIDGE_FEATURE_FLAG_KEYS.reactionSync), false);
  assert.deepEqual(internal, []);
});

test("the continuation pilot has its own server flag key", () => {
  // FFA rules are stored by key: renaming it would silently orphan a rollout.
  assert.equal(CONTINUATIONS_PILOT_FEATURE_FLAG_KEY, "continuations_pilot_v0");
});

test("RFC 081 inbox items have their own server flag key", () => {
  // FFA rules are stored by key: renaming it would silently orphan a rollout.
  assert.equal(AGENT_INBOX_ITEMS_FEATURE_FLAG_KEY, "agent_inbox_items_v0");
});

test("reaction notices for agents have their own server flag key", () => {
  // FFA rules are stored by key: renaming it would silently orphan a rollout.
  assert.equal(AGENT_REACTION_NOTICES_FEATURE_FLAG_KEY, "agent_reaction_notices_v0");
});

test("mobile inbox in place (#245) has its own flag key", () => {
  // FFA rules are stored by key, and mobile reads this one: renaming it would orphan the rollout.
  assert.equal(MOBILE_INBOX_INPLACE_FEATURE_FLAG_KEY, "mobile_inbox_inplace_v0");
});
