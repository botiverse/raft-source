import assert from "node:assert/strict";
import test from "node:test";

import { dedupeTaskAssigneeMembers } from "../src/components/task/taskAssigneeCandidates.ts";

test("joint task assignees collapse duplicate server projections by global actor id", () => {
  const projectionA = {
    id: "user-1",
    serverId: "server-a",
    displayName: "Ada on A",
    avatarUrl: "https://example.test/a.png",
  };
  const projectionB = {
    id: "user-1",
    serverId: "server-b",
    displayName: "Ada on B",
    avatarUrl: "https://example.test/b.png",
  };
  const otherUser = { id: "user-2", serverId: "server-a", displayName: "Grace" };
  const candidates = dedupeTaskAssigneeMembers([projectionA, otherUser, projectionB]);

  assert.deepEqual(candidates, [
    projectionA,
    otherUser,
  ]);
  assert.equal(new Set(candidates.map((candidate) => `user:${candidate.id}`)).size, candidates.length);

  const reversedProjectionOrder = dedupeTaskAssigneeMembers([projectionB, otherUser, projectionA]);
  assert.deepEqual(
    reversedProjectionOrder,
    candidates,
    "projection order must not change the representative label or avatar for a logical actor",
  );
});
