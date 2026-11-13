import assert from "node:assert/strict";
import { agentMigrationLogEntrySchema } from "@botiverse/raft-shared";
import {
  agentMigrationLogOutcome,
  classifyAgentMigrationFailure,
  toAgentMigrationLogEntry,
} from "./agentMigrationLogService";
import type { AgentMigrationRow } from "./agentMigrationService";

test("a too-large workspace is named too_large, whichever layer refused it", () => {
  assert.equal(classifyAgentMigrationFailure("JS_ZodError", "transferSummary.includedBytes: Number must be less than or equal to 10737418240"), "too_large");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE", null), "too_large");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED", null), "too_large");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_ARCHIVE_TOO_LARGE", null), "too_large");
  // A ZodError about anything else is not a size problem.
  assert.equal(classifyAgentMigrationFailure("JS_ZodError", "identity.agentId: Invalid uuid"), "other");
  assert.equal(classifyAgentMigrationFailure("JS_ZodError", null), "other");
});

test("a lost connection is named network", () => {
  assert.equal(classifyAgentMigrationFailure("FETCH_ECONNRESET", null), "network");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_OBJECT_STORE_UNREACHABLE", null), "network");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_TRANSPORT_LOST", "MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_EXHAUSTED:404"), "network");
});

test("anything else, or no code at all, is other", () => {
  assert.equal(classifyAgentMigrationFailure("MIGRATION_CHUNK_DIGEST_MISMATCH", null), "other");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_LEASE_EXPIRED", null), "other");
  // An unreachable computer or supervisor is not a lost connection.
  assert.equal(classifyAgentMigrationFailure("ARCHIVE_COMPUTER_UNREACHABLE", null), "other");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_TARGET_SUPERVISOR_UNREACHABLE", null), "other");
  assert.equal(classifyAgentMigrationFailure("MIGRATION_TRANSPORT_LOST_SOMETHING", null), "other");
  assert.equal(classifyAgentMigrationFailure(null, null), "other");
});

test("every migration state maps to one outcome", () => {
  assert.equal(agentMigrationLogOutcome("completed"), "completed");
  assert.equal(agentMigrationLogOutcome("failed"), "failed");
  assert.equal(agentMigrationLogOutcome("aborted"), "failed");
  assert.equal(agentMigrationLogOutcome("canceled_pre_flip"), "canceled");
  assert.equal(agentMigrationLogOutcome("canceled_post_flip"), "canceled");
  for (const state of ["provisioning", "prep", "ready", "in_transit", "arriving", "starting", "cancel_requested_pre_flip", "cancel_requested_post_flip"]) {
    assert.equal(agentMigrationLogOutcome(state), "in_progress", state);
  }
});

function row(overrides: Partial<AgentMigrationRow>): AgentMigrationRow {
  return {
    supportRef: "mig_test",
    agentId: "00000000-0000-4000-8000-000000000001",
    sourceMachineId: "00000000-0000-4000-8000-000000000002",
    sourceMachineNameSnapshot: "laptop",
    targetKind: "computer",
    targetMachineId: "00000000-0000-4000-8000-000000000003",
    targetMachineNameSnapshot: "desktop",
    state: "prep",
    transferSummary: null,
    sourceBuildProgress: null,
    transportErrorCode: null,
    transportErrorMessage: null,
    failureReason: null,
    abortReason: null,
    completedAt: null,
    abortedAt: null,
    canceledAt: null,
    transportLostAt: null,
    transportTeardownAt: null,
    createdAt: new Date("2026-10-01T00:00:00Z"),
    updatedAt: new Date("2026-10-01T00:05:00Z"),
    ...overrides,
  } as AgentMigrationRow;
}

test("an in-progress move has no end and reads its size from the source's build progress", () => {
  const entry = toAgentMigrationLogEntry(row({
    sourceBuildProgress: { phase: "packing", files: 12, bytes: 3400, reportedAt: "2026-10-01T00:01:00Z" },
    failureReason: "STALE",
  }), null);
  agentMigrationLogEntrySchema.parse(entry);
  assert.equal(entry.outcome, "in_progress");
  assert.equal(entry.endedAt, null);
  assert.equal(entry.bytes, 3400);
  assert.equal(entry.files, 12);
  assert.equal(entry.failureCode, null);
  assert.equal(entry.failureKind, null);
});

test("a failed move without a terminal timestamp ends when the transport was lost or torn down, else at its last update", () => {
  const lost = toAgentMigrationLogEntry(row({
    state: "failed",
    failureReason: "MIGRATION_TRANSPORT_LOST",
    transportLostAt: new Date("2026-10-01T00:03:00Z"),
  }), null);
  assert.equal(lost.endedAt, "2026-10-01T00:03:00.000Z");
  assert.equal(lost.failureCode, "MIGRATION_TRANSPORT_LOST");
  assert.equal(lost.failureKind, "network");

  const tornDown = toAgentMigrationLogEntry(row({
    state: "failed",
    transportErrorCode: "FETCH_ECONNRESET",
    transportTeardownAt: new Date("2026-10-01T00:04:00Z"),
  }), null);
  assert.equal(tornDown.endedAt, "2026-10-01T00:04:00.000Z");

  const aborted = toAgentMigrationLogEntry(row({ state: "aborted", abortReason: "MIGRATION_LEASE_EXPIRED" }), null);
  assert.equal(aborted.endedAt, "2026-10-01T00:05:00.000Z");
  assert.equal(aborted.failureCode, "MIGRATION_LEASE_EXPIRED");
  assert.equal(aborted.failureKind, "other");
});

test("malformed size json reads as unknown rather than failing the log", () => {
  const entry = toAgentMigrationLogEntry(row({
    transferSummary: { includedBytes: "lots" } as never,
    sourceBuildProgress: "garbage" as never,
  }), null);
  assert.equal(entry.bytes, null);
  assert.equal(entry.files, null);
});
