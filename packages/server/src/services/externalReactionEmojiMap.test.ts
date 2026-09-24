import assert from "node:assert/strict";
import { test } from "vitest";

import { externalReactionFromSlack, externalReactionToSlack } from "./externalReactionEmojiMap.js";

test("versioned standard reaction mapping round-trips base and skin-tone emoji", () => {
  assert.deepEqual(externalReactionToSlack("👍"), {
    canonicalEmoji: "👍",
    providerReactionKey: "thumbsup",
    mappingRevision: 1,
  });
  assert.deepEqual(externalReactionFromSlack("+1"), {
    canonicalEmoji: "👍",
    providerReactionKey: "thumbsup",
    mappingRevision: 1,
  });
  assert.deepEqual(externalReactionToSlack("👍🏽"), {
    canonicalEmoji: "👍🏽",
    providerReactionKey: "thumbsup::skin-tone-4",
    mappingRevision: 1,
  });
  assert.deepEqual(externalReactionFromSlack("thumbsup::skin-tone-4"), {
    canonicalEmoji: "👍🏽",
    providerReactionKey: "thumbsup::skin-tone-4",
    mappingRevision: 1,
  });
});

test("custom names, unknown Unicode, and invalid tone combinations stay unsupported", () => {
  assert.equal(externalReactionFromSlack("workspace_party_parrot"), null);
  assert.equal(externalReactionToSlack("🦄"), null);
  assert.equal(externalReactionFromSlack("heart::skin-tone-2"), null);
});
