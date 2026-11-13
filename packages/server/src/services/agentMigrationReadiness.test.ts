import { test } from "vitest";
import { dbTest } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES, MAX_AGENT_MIGRATION_TRANSPORT_BYTES } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import {
  beginTestAgentMigration,
  flipTestAgentMigration,
  markTestAgentMigrationReady,
  startTestAgentMigrationTransfer,
} from "../test/agentMigrationFixture";
import { createAgent } from "./agentService";
import {
  agentMigrationGeneration,
  completeAgentMigrationAutoStart,
  markAgentMigrationTransportLostForComputer,
  markAgentMigrationTargetImportArrived,
} from "./agentMigrationService";
import {
  buildAgentMigrationReadiness,
  loadAgentMigrationReadiness,
  type AgentMigrationReadinessRow,
} from "./agentMigrationReadiness";
import { registerMachine } from "./machineService";
import { createServer } from "./serverService";

afterEach(async () => {
  await closeTestDatabase();
});

const LIMITS = { maxBytes: MAX_AGENT_MIGRATION_TRANSPORT_BYTES, maxEntries: AGENT_MIGRATION_MAX_ARCHIVE_ENTRIES };
const T = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute));

function completed(minute: number, files = 1_200, bytes = 5_000_000): AgentMigrationReadinessRow {
  return {
    id: `completed-${minute}`,
    state: "completed",
    transferSummary: { includedFileCount: files, includedBytes: bytes },
    transportErrorCode: null,
    transportErrorMessage: null,
    // Completion follows the target start, a little after arrival.
    completedAt: T(minute + 1),
    arrivedAt: T(minute),
    transportLostAt: null,
    createdAt: T(minute - 5),
  };
}

function failed(minute: number, message: string | null, code = message?.split(":")[0] ?? null): AgentMigrationReadinessRow {
  return {
    id: `failed-${minute}`,
    state: "failed",
    transferSummary: null,
    transportErrorCode: code,
    transportErrorMessage: message,
    completedAt: null,
    arrivedAt: null,
    transportLostAt: T(minute),
    createdAt: T(minute - 5),
  };
}

const ENTRY_COUNT_FAILURE = "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=2500000:maxEntries=2000000"
  + ":topPathCounts=node_modules%2F,1900000;.cache%2F,400000;src%2F,150000;docs%2F,50000";
const BYTES_FAILURE = "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=10737418241:maxBytes=10737418240"
  + ":topEntries=datasets%2F,9000000000;models%2F,3000000000";

test("no migrations: only the limits", () => {
  assert.deepEqual(buildAgentMigrationReadiness([]), { limits: LIMITS });
});

test("last completed only: packed measurement at its completion", () => {
  assert.deepEqual(buildAgentMigrationReadiness([completed(10), completed(1, 5, 5)]), {
    limits: LIMITS,
    lastMeasured: { files: 1_200, bytes: 5_000_000, at: T(10).toISOString(), source: "packed" },
  });
});

test("a starting migration counts as packed, with the same measurement once it completes", () => {
  const starting = { ...completed(10), state: "starting" as const, completedAt: null };
  assert.equal(buildAgentMigrationReadiness([starting]).lastMeasured?.source, "packed");
  assert.deepEqual(buildAgentMigrationReadiness([starting]), buildAgentMigrationReadiness([completed(10)]));
});

test("a size failure is dated by write-once columns, never updatedAt", () => {
  const row = failed(20, BYTES_FAILURE);
  assert.equal(buildAgentMigrationReadiness([row]).lastSizeFailure?.at, T(20).toISOString());
  // No transportLostAt (not written by today's size-failure path): createdAt, also written once.
  assert.equal(buildAgentMigrationReadiness([{ ...row, transportLostAt: null }]).lastSizeFailure?.at, T(15).toISOString());
});

test("entry-count failure newer than completed: files from the failure, bytes from the packed move, top paths capped at 3", () => {
  assert.deepEqual(buildAgentMigrationReadiness([failed(20, ENTRY_COUNT_FAILURE), completed(10)]), {
    limits: LIMITS,
    lastMeasured: { files: 2_500_000, bytes: 5_000_000, at: T(20).toISOString(), source: "failed" },
    lastSizeFailure: {
      migrationId: "failed-20",
      at: T(20).toISOString(),
      code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
      topPaths: [
        { path: "node_modules/", value: 1_900_000 },
        { path: ".cache/", value: 400_000 },
        { path: "src/", value: 150_000 },
      ],
    },
  });
});

test("bytes failure with no packed move: bytes from the failure, files 0", () => {
  assert.deepEqual(buildAgentMigrationReadiness([failed(20, BYTES_FAILURE)]), {
    limits: LIMITS,
    lastMeasured: { files: 0, bytes: 10_737_418_241, at: T(20).toISOString(), source: "failed" },
    lastSizeFailure: {
      migrationId: "failed-20",
      at: T(20).toISOString(),
      code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
      topPaths: [
        { path: "datasets/", value: 9_000_000_000 },
        { path: "models/", value: 3_000_000_000 },
      ],
    },
  });
});

test("the newest size failure wins, past a later non-size failure", () => {
  const readiness = buildAgentMigrationReadiness([
    failed(30, "MIGRATION_TRANSPORT_LOST"),
    failed(25, BYTES_FAILURE),
    failed(20, ENTRY_COUNT_FAILURE),
    completed(10),
  ]);
  assert.equal(readiness.lastSizeFailure?.code, "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE");
  assert.equal(readiness.lastSizeFailure?.migrationId, "failed-25");
  assert.deepEqual(readiness.lastMeasured, { files: 1_200, bytes: 10_737_418_241, at: T(25).toISOString(), source: "failed" });
});

test("a size failure known only by its code has no top paths and keeps the packed counts", () => {
  const readiness = buildAgentMigrationReadiness([failed(20, null, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED"), completed(10)]);
  assert.deepEqual(readiness.lastSizeFailure?.topPaths, []);
  assert.deepEqual(readiness.lastMeasured, { files: 1_200, bytes: 5_000_000, at: T(20).toISOString(), source: "failed" });
});

test("size failure older than the latest completed is ignored", () => {
  assert.deepEqual(buildAgentMigrationReadiness([completed(30), failed(20, ENTRY_COUNT_FAILURE)]), {
    limits: LIMITS,
    lastMeasured: { files: 1_200, bytes: 5_000_000, at: T(30).toISOString(), source: "packed" },
  });
});

test("non-size failure is ignored", () => {
  assert.deepEqual(buildAgentMigrationReadiness([failed(20, "MIGRATION_TRANSPORT_LOST: socket closed"), completed(10)]), {
    limits: LIMITS,
    lastMeasured: { files: 1_200, bytes: 5_000_000, at: T(10).toISOString(), source: "packed" },
  });
});

dbTest("loadAgentMigrationReadiness reads the agent's newest computer migrations", async ({ db: _db }) => {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `migration-readiness-${suffix}@slock.test`,
    name: `migration-readiness-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Migration Readiness", `migration-readiness-${suffix}`, owner!.id);
  const { machine: source } = await registerMachine(server.id, owner!.id, "Readiness Source");
  const { machine: target } = await registerMachine(server.id, owner!.id, "Readiness Target");
  const agent = await createAgent(server.id, "readiness-agent", { runtime: "codex", machineId: source.id });
  assert.deepEqual(await loadAgentMigrationReadiness(agent.id), { limits: LIMITS });

  const first = await beginTestAgentMigration({ agentId: agent.id, targetMachineId: target.id, initiatedByUserId: owner!.id, now: T(0) });
  await markTestAgentMigrationReady(first, {
    now: T(1),
    transferSummary: {
      includedFileCount: 42,
      includedBytes: 4_096,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: { thirdPartyDependencies: 0, caches: 0, buildArtifacts: 0, otherRegenerable: 0 },
      keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
    },
  });
  await startTestAgentMigrationTransfer(first.migration.id, T(2));
  const arriving = await flipTestAgentMigration(first.migration.id, T(3));
  await markAgentMigrationTargetImportArrived({
    migrationId: arriving.id,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: target.id,
    now: T(4),
  });
  // `starting`: what the start on the target sees, before completion.
  assert.equal((await loadAgentMigrationReadiness(agent.id)).lastMeasured?.source, "packed");
  await completeAgentMigrationAutoStart({ migrationId: arriving.id, agentId: agent.id, targetMachineId: target.id, now: T(5) });
  assert.deepEqual((await loadAgentMigrationReadiness(agent.id)).lastMeasured, {
    files: 42, bytes: 4_096, at: T(4).toISOString(), source: "packed",
  });

  // Back to the first Computer; the source reports the workspace too big.
  const second = await beginTestAgentMigration({ agentId: agent.id, targetMachineId: source.id, initiatedByUserId: owner!.id, now: T(10) });
  await markAgentMigrationTransportLostForComputer({
    migrationId: second.migration.id,
    serverId: server.id,
    machineId: target.id,
    detailCode: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: ENTRY_COUNT_FAILURE,
    now: T(12),
  });
  const readiness = await loadAgentMigrationReadiness(agent.id);
  assert.deepEqual(readiness.lastMeasured, { files: 2_500_000, bytes: 4_096, at: T(12).toISOString(), source: "failed" });
  assert.equal(readiness.lastSizeFailure?.topPaths.length, 3);
  assert.equal(readiness.lastSizeFailure?.migrationId, second.migration.id);
  assert.equal(readiness.lastSizeFailure?.at, T(12).toISOString());
});
