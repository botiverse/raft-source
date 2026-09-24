import assert from "node:assert/strict";
import { test } from "vitest";

import { slackActorProjectionRevisionAfterRefresh } from "./slackBridgeProvisioningControlPlane.js";

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
