import assert from "node:assert/strict";
import test from "node:test";

import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "./featureFlags.js";

test("Slack Bridge exposes one launch gate plus twelve engineering fuses", () => {
  assert.deepEqual(SLACK_BRIDGE_FEATURE_FLAG_KEYS, {
    master: "slack_bridge_v0",
    directory: "external_projection_directory",
    binding: "slack_binding_control_plane",
    enqueue: "slack_outbound_enqueue",
    dispatch: "slack_provider_dispatch",
    customAuthorship: "slack_custom_authorship",
    nativeMention: "slack_native_mentions",
    threadDelivery: "slack_thread_delivery",
    privateBinding: "slack_private_binding",
    eventIngress: "slack_event_ingress",
    inboundProjection: "slack_inbound_projection",
    attachmentTransfer: "slack_attachment_transfer",
    reactionSync: "slack_reaction_sync",
  });
  assert.equal(new Set(Object.values(SLACK_BRIDGE_FEATURE_FLAG_KEYS)).size, 13);
});
