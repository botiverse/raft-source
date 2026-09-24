import assert from "node:assert/strict";
import { test } from "vitest";

import type { TrajectoryEntry } from "@botiverse/raft-shared";
import {
  fingerprintAgentRuntimeError,
  projectAgentActivityFromRedisHash,
  projectAgentRuntimeErrorFromRedisHash,
} from "../replicaRouter.js";
import { projectAgentActivityHintFromPersistedEvent } from "./agentActivityLogService.js";

test("legacy Redis activity cache without kind fields falls back from activity/detail", () => {
  const projected = projectAgentActivityFromRedisHash({
    activity: "working",
    detail: "legacy display text",
    updatedAt: "12345",
  });

  assert.deepEqual(projected, {
    activity: "working",
    detail: "legacy display text",
    detailKind: "other",
    updatedAt: 12345,
  });
});

test("Redis activity cache preserves observedAtMs separately from write clock", () => {
  const projected = projectAgentActivityFromRedisHash({
    activity: "working",
    detail: "running command",
    detailKind: "running_command",
    observedAtMs: "12345",
    updatedAt: "67890",
  });

  assert.deepEqual(projected, {
    activity: "working",
    detail: "running command",
    detailKind: "running_command",
    observedAtMs: 12345,
    updatedAt: 67890,
  });
});

test("Redis runtime-error mirror preserves the authority fingerprint and payload", () => {
  const error = {
    message: "Provider authentication failed",
    at: "2026-08-02T12:00:00.000Z",
    launchId: "launch-1",
    actionRequired: true,
  };

  assert.deepEqual(projectAgentRuntimeErrorFromRedisHash({
    state: "error",
    fingerprint: fingerprintAgentRuntimeError(error),
    message: error.message,
    at: error.at,
    launchId: error.launchId,
    actionRequired: "1",
    updatedAt: "12345",
  }), {
    error,
    fingerprint: fingerprintAgentRuntimeError(error),
    updatedAt: 12345,
  });
});

test("Redis runtime-error clear is an explicit tombstone and malformed fingerprints fail closed", () => {
  const fingerprint = fingerprintAgentRuntimeError(null);
  assert.deepEqual(projectAgentRuntimeErrorFromRedisHash({
    state: "clear",
    fingerprint,
    updatedAt: "67890",
  }), {
    error: null,
    fingerprint,
    updatedAt: 67890,
  });
  assert.equal(projectAgentRuntimeErrorFromRedisHash({
    state: "clear",
    fingerprint: "stale-error",
    updatedAt: "67890",
  }), null);
});

test("legacy persisted activity hint without detail kind remains readable", () => {
  const entries: TrajectoryEntry[] = [
    {
      kind: "status",
      activity: "working",
      detail: "legacy display text",
    },
  ];

  const projected = projectAgentActivityHintFromPersistedEvent({
    activity: "working",
    detail: "legacy display text",
    entries,
    createdAt: new Date(12345),
  });

  assert.deepEqual(projected, {
    activity: "working",
    detail: "legacy display text",
    detailKind: "other",
    updatedAt: 12345,
  });
});
