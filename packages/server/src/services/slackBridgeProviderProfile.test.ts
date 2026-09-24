import assert from "node:assert/strict";
import { test } from "vitest";
import { slackProfileAvatarLocator } from "./slackBridgeProviderRuntime.js";

test("Slack profile distinguishes uploaded image, real default-avatar removal, and unknown data", () => {
  const uploaded = "https://avatars.slack-edge.com/uploaded_72.png";
  assert.equal(slackProfileAvatarLocator({
    is_custom_image: true, image_72: uploaded, image_original: uploaded, avatar_hash: "uploaded",
  }), uploaded);
  // Real users.info response after users.deletePhoto: both optional custom fields disappear.
  assert.equal(slackProfileAvatarLocator({
    image_72: "https://secure.gravatar.com/avatar/default?s=72",
    avatar_hash: "g5dad64a4e88",
  }), null);
  assert.equal(slackProfileAvatarLocator({ is_custom_image: false, image_72: uploaded }), null);
  assert.equal(slackProfileAvatarLocator({}), undefined);
  assert.equal(slackProfileAvatarLocator({ is_custom_image: true }), undefined);
  assert.equal(slackProfileAvatarLocator({ image_72: uploaded }), uploaded);
});
