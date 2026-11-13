import assert from "node:assert/strict";

import {
  projectSlackProviderChannelsForServer,
  slackBridgeMentionSyncState,
  slackBridgeChannelPairFailureReason,
  slackActorProjectionRevisionAfterRefresh,
} from "./slackBridgeProvisioningControlPlane";

const currentActor = {
  displayName: "Peng",
  handles: ["peng"],
  actorKind: "human" as const,
  state: "active" as const,
  deactivated: false,
  projectionRevision: 76,
};

test("freshness-only Slack audience refresh preserves the actor authority revision", () => {
  assert.equal(slackActorProjectionRevisionAfterRefresh(currentActor, {
    id: "U_PENG",
    displayName: "Peng",
    handle: "peng",
    actorKind: "human",
  }), 76);
});

test("material Slack actor changes advance the actor authority revision exactly once", () => {
  const changes = [
    { displayName: "Peng Renamed", handle: "peng", actorKind: "human" as const },
    { displayName: "Peng", handle: "peng-new", actorKind: "human" as const },
    { displayName: "Peng", handle: "peng", actorKind: "guest" as const },
  ];
  for (const observed of changes) {
    assert.equal(slackActorProjectionRevisionAfterRefresh(currentActor, {
      id: "U_PENG",
      ...observed,
    }), 77);
  }
  assert.equal(slackActorProjectionRevisionAfterRefresh({
    ...currentActor,
    state: "tombstoned",
    deactivated: true,
  }, {
    id: "U_PENG",
    displayName: "Peng",
    handle: "peng",
    actorKind: "human",
  }), 77);
});

test("another server's reserved Slack channel is omitted without exposing its binding", () => {
  const projected = projectSlackProviderChannelsForServer({
    observed: [
      { id: "C_OWN", name: "own", privacyClass: "public" },
      { id: "C_OTHER", name: "secret-other-server-name", privacyClass: "private" },
      { id: "C_FREE", name: "free", privacyClass: "public" },
    ],
    currentBindings: [{ providerConversationId: "C_OWN", privacyClass: "public" }],
    reservedByOtherServer: new Set(["C_OTHER"]),
  });
  assert.deepEqual(projected.map((channel) => channel.id), ["C_OWN", "C_FREE"]);
  assert.equal(JSON.stringify(projected).includes("secret-other-server-name"), false);
});

test("pair failures distinguish missing channels and bot membership; visibility never fails a pair", () => {
  for (const visibility of ["public", "private"] as const) {
    const raft = { type: visibility === "public" ? "channel" : "private" };
    const slack = { privacyClass: visibility, isMember: true };
    assert.equal(slackBridgeChannelPairFailureReason(raft, slack), null);
    assert.equal(slackBridgeChannelPairFailureReason(undefined, slack), "channel_unavailable");
    assert.equal(slackBridgeChannelPairFailureReason(raft, undefined), "channel_unavailable");
    assert.equal(slackBridgeChannelPairFailureReason(raft, { ...slack, isMember: false }), "not_member");
    assert.equal(slackBridgeChannelPairFailureReason(raft, { privacyClass: visibility }), "not_member");
    // Cross-class pairing is admissible: visibility is per-platform.
    assert.equal(slackBridgeChannelPairFailureReason(raft, { ...slack, privacyClass: visibility === "public" ? "private" : "public" }), null);
  }
});


test("retiring an obsolete group cannot mark current members unavailable", () => {
  const human = { serverId: "server-a", userId: "human-a", name: "alice", displayName: "Alice", serverName: "Raft", serverSlug: "raft" };
  const health = slackBridgeMentionSyncState({
    candidates: [], humanCandidates: [human], observedAt: new Date("2032-01-02T03:04:05Z"),
    reconciled: { kind: "fact", fact: {
      handles: [], humanHandles: [{ userId: human.userId, providerUsergroupId: "S_ALICE", handle: "alice" }],
      failures: [{ userId: "other-server-user", slackError: "name_taken", transient: false }],
      cleanupFailures: [{ slackError: "permission_denied" }],
    } },
  });
  assert.equal(health?.state, "synced");
  assert.equal(health?.actual, 1);
  assert.equal(health?.expected, 1);
  assert.equal(health?.slackError, "cleanup_pending");
});
