import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentActivityDetailKind, TrajectoryEntry } from "@botiverse/raft-shared";
import { buildDaemonActivityMessage } from "./agentActivityProducer.js";

const weakConclusionKinds = [
  "none",
  "daemon_activity",
  "external_activity",
  "slock_action",
  "other",
] as const satisfies readonly AgentActivityDetailKind[];

test("current daemon rejects every weak conclusion-bearing detail kind", () => {
  for (const detailKind of weakConclusionKinds) {
    const built = buildDaemonActivityMessage({
      agentId: "agent-1",
      activityKind: "error",
      detail: "producer conclusion must not cross the wire",
      detailKind,
      isHeartbeat: false,
    });
    assert.equal(built.ok, false, detailKind);
    if (!built.ok) assert.equal(built.drop.reason, "non_fact_activity_detail_kind");
  }

  const missing = buildDaemonActivityMessage({
    agentId: "agent-1",
    activityKind: "working",
    detail: "missing fact kind",
    detailKind: undefined,
    isHeartbeat: false,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.drop.reason, "unknown_activity_detail_kind");
});

test("fact-typed daemon activity omits producer conclusions from envelope and status entries", () => {
  const entries: TrajectoryEntry[] = [{
    kind: "status",
    activity: "working",
    activityKind: "working",
    detail: "Runtime failed",
    detailKind: "runtime_error",
  }];
  const built = buildDaemonActivityMessage({
    agentId: "agent-1",
    activityKind: "working",
    detail: "Runtime failed",
    detailKind: "runtime_error",
    entries,
    isHeartbeat: false,
  });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal("activity" in built.message, false);
  assert.equal("activityKind" in built.message, false);
  assert.deepEqual(built.message.entries, [{
    kind: "status",
    detail: "Runtime failed",
    detailKind: "runtime_error",
  }]);
});
