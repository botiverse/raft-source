import assert from "node:assert/strict";
import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import { useProfileStore } from "../src/store/profileStore";

function projection(workspaceName: string | null): ExternalMessageAuthorProjection {
  return {
    projectionId: "projection-1",
    provider: "slack",
    appRegistrationId: "app-1",
    installId: "install-1",
    workspaceId: "opaque-workspace-id",
    workspaceName,
    externalActorId: "actor-1",
    externalConversationId: "conversation-1",
    externalMessageId: "message-1",
    displayName: "Ada Lovelace",
    actorKind: "human",
    avatarUrl: null,
    avatarDigest: null,
    actorProjectionRevision: 3,
  };
}

afterEach(() => {
  useProfileStore.setState(useProfileStore.getInitialState(), true);
});

test("external profile store retains the frozen author payload and clears it on other navigation", () => {
  const frozen = projection("Analytical Engines");
  useProfileStore.getState().openExternalProfile("message-1", frozen, {
    channelId: "channel-1",
    openSource: "channel",
  });

  assert.equal(useProfileStore.getState().profileType, "external");
  assert.equal(useProfileStore.getState().profileId, "message-1");
  assert.equal(useProfileStore.getState().externalProfile, frozen);
  assert.equal(useProfileStore.getState().externalProfileChannelId, "channel-1");
  assert.equal(useProfileStore.getState().openSource, "channel");

  useProfileStore.getState().openProfile("human", "human-1");
  assert.equal(useProfileStore.getState().profileType, "human");
  assert.equal(useProfileStore.getState().externalProfile, null);
});

test("closing an external profile removes both its target and frozen payload", () => {
  useProfileStore.getState().openExternalProfile("message-1", projection(null), {
    channelId: "channel-1",
  });
  useProfileStore.getState().closeProfile();

  assert.equal(useProfileStore.getState().profileType, null);
  assert.equal(useProfileStore.getState().profileId, null);
  assert.equal(useProfileStore.getState().externalProfile, null);
  assert.equal(useProfileStore.getState().externalProfileChannelId, null);
});
