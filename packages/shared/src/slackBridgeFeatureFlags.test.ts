import assert from "node:assert/strict";

import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "./featureFlags";

test("Slack Bridge retains legacy flag identifiers for mixed-version compatibility", () => {
  assert.deepEqual(SLACK_BRIDGE_FEATURE_FLAG_KEYS, {
    master: "slack_bridge_v0",
    attachmentTransfer: "slack_attachment_transfer",
    reactionSync: "slack_reaction_sync",
  });
  assert.equal(new Set(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS)).size, 3);
});
