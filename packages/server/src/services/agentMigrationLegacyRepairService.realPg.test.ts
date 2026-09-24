import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  agentMigrationReceiptOutbox,
  agentMigrations,
  agents,
  inboxNotificationFacts,
  messages,
  users,
} from "../db/schema.js";
import { createAgent } from "./agentService.js";
import {
  agentMigrationGeneration,
  beginAgentMigration,
  flipAgentMigrationMachine,
  markAgentMigrationSourceReadyForComputer,
  markAgentMigrationTargetImportArrived,
  startAgentMigrationTransfer,
} from "./agentMigrationService.js";
import {
  applyLegacyAgentMigrationCompletion,
  previewLegacyAgentMigrationCompletion,
  type LegacyAgentMigrationRepairTarget,
} from "../../scripts/ops/incidents/task-39/agentMigrationLegacyRepairService.js";
import { registerMachine } from "./machineService.js";
import { createServer } from "./serverService.js";

const REAL_PG_URL_ENV = "AGENT_MIGRATION_LEGACY_REPAIR_REAL_PG_URL";
const REAL_PG_REQUIRED = process.env.AGENT_MIGRATION_LEGACY_REPAIR_REAL_PG_REQUIRED === "1";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TRANSFER_SUMMARY = {
  includedFileCount: 3,
  includedBytes: 256,
  excludedRegenerableCount: 4,
  excludedRegenerableByCategory: {
    thirdPartyDependencies: 1,
    caches: 1,
    buildArtifacts: 1,
    otherRegenerable: 1,
  },
  keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: false },
} as const;

function quoteIdentifier(identifier: string): string {
  assert.match(identifier, /^[a-z0-9_]+$/);
  return `"${identifier}"`;
}

function databaseUrlFor(adminUrl: string, databaseName: string): string {
  const parsed = new URL(adminUrl);
  assert.match(parsed.protocol, /^postgres(?:ql)?:$/, `${REAL_PG_URL_ENV} must be a PostgreSQL URL`);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCode(error.cause);
  return undefined;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error ?? "");
  const own = error instanceof Error ? error.message : "";
  const cause = "cause" in error ? errorText(error.cause) : "";
  return `${own}\n${cause}`;
}

async function seedLegacyStartingMigration(label: string): Promise<{
  target: LegacyAgentMigrationRepairTarget;
  row: typeof agentMigrations.$inferSelect;
}> {
  const db = getDb();
  const suffix = `${label}-${randomUUID()}`;
  const [owner] = await db.insert(users).values({
    email: `${suffix}@slock.test`,
    name: suffix,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer(`Legacy Repair ${label}`, `legacy-repair-${suffix}`, owner.id);
  const { machine: sourceMachine } = await registerMachine(server.id, owner.id, `Source ${label}`);
  const { machine: targetMachine } = await registerMachine(server.id, owner.id, `Target ${label}`);
  const agent = await createAgent(server.id, `legacy-repair-${label}`, {
    runtime: "codex",
    machineId: sourceMachine.id,
  });
  const migration = await beginAgentMigration({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: owner.id,
    now: new Date("2026-08-17T00:00:00.000Z"),
  });
  const ready = await markAgentMigrationSourceReadyForComputer({
    migrationId: migration.id,
    serverId: server.id,
    sourceMachineId: sourceMachine.id,
    manifestPath: `object-store:${label}/manifest.json`,
    manifestSha256: `sha256:${label}`,
    transferSummary: TRANSFER_SUMMARY,
    now: new Date("2026-08-17T00:01:00.000Z"),
  });
  await startAgentMigrationTransfer(ready.grantKey, new Date("2026-08-17T00:02:00.000Z"));
  const arriving = await flipAgentMigrationMachine(ready.grantKey, new Date("2026-08-17T00:03:00.000Z"));
  await markAgentMigrationTargetImportArrived({
    grantKey: ready.grantKey,
    migrationGeneration: agentMigrationGeneration(arriving),
    serverId: server.id,
    targetMachineId: targetMachine.id,
    now: new Date("2026-08-17T00:04:00.000Z"),
  });
  const [row] = await db.update(agentMigrations)
    .set({
      revision: 9,
      failureReason: "auto_start_failed",
      autoStartFailureStage: null,
      autoStartFailureCode: null,
      autoStartRetryAttempts: 0,
      autoStartRetryDeadlineAt: null,
      autoStartLastRetryAt: null,
      autoStartRemediationLeaseId: null,
      autoStartRemediationLeaseExpiresAt: null,
      updatedAt: new Date("2026-08-17T00:08:33.000Z"),
    })
    .where(eq(agentMigrations.id, migration.id))
    .returning();
  await db.update(agents).set({ status: "active" }).where(eq(agents.id, agent.id));
  assert.ok(row);
  return {
    row,
    target: {
      migrationId: migration.id,
      serverId: server.id,
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      expectedRevision: 9,
    },
  };
}

async function exactCounts(migrationId: string) {
  const db = getDb();
  const outbox = await db.select().from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, migrationId));
  if (outbox.length === 0) return { outbox: 0, messages: 0, facts: 0 };
  const message = await db.select().from(messages).where(eq(messages.id, outbox[0]!.messageId));
  const facts = await db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, outbox[0]!.messageId));
  return { outbox: outbox.length, messages: message.length, facts: facts.length };
}

test(
  "legacy repair is atomic, schema-gated, and exactly once under real PostgreSQL",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL);
    const databaseName = `slock_legacy_repair_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({ connectionString: REAL_PG_URL, application_name: "legacy-repair-admin" });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);
      const migratePool = new pg.Pool({ connectionString: testUrl, max: 1 });
      await migrate(drizzle(migratePool), { migrationsFolder: MIGRATIONS_FOLDER });
      await migratePool.end();
      await initDatabase(testUrl);

      const concurrent = await seedLegacyStartingMigration("concurrent");
      const preview = await previewLegacyAgentMigrationCompletion(concurrent.target);
      assert.equal(preview.status, "ready");
      assert.match(preview.prestateSha256 ?? "", /^[0-9a-f]{64}$/);

      const settled = await Promise.allSettled([
        applyLegacyAgentMigrationCompletion({
          ...concurrent.target,
          expectedPrestateSha256: preview.prestateSha256!,
        }),
        applyLegacyAgentMigrationCompletion({
          ...concurrent.target,
          expectedPrestateSha256: preview.prestateSha256!,
        }),
      ]);
      const applied = settled.filter((entry) => entry.status === "fulfilled" && entry.value.status === "applied");
      const terminalReplay = settled.filter(
        (entry) => entry.status === "fulfilled" && entry.value.status === "already_repaired",
      );
      const serializationLosers = settled.filter(
        (entry) => entry.status === "rejected" && ["40001", "40P01"].includes(errorCode(entry.reason) ?? ""),
      );
      assert.equal(applied.length, 1);
      assert.equal(terminalReplay.length + serializationLosers.length, 1);
      assert.deepEqual(await exactCounts(concurrent.target.migrationId), { outbox: 1, messages: 1, facts: 1 });
      const replay = await applyLegacyAgentMigrationCompletion({
        ...concurrent.target,
        expectedPrestateSha256: "0".repeat(64),
      });
      assert.deepEqual(replay, { status: "already_repaired", revision: 10 });
      assert.deepEqual(await exactCounts(concurrent.target.migrationId), { outbox: 1, messages: 1, facts: 1 });

      const rollback = await seedLegacyStartingMigration("rollback");
      const rollbackPreview = await previewLegacyAgentMigrationCompletion(rollback.target);
      assert.equal(rollbackPreview.status, "ready");
      await assert.rejects(
        applyLegacyAgentMigrationCompletion({
          ...rollback.target,
          expectedPrestateSha256: rollbackPreview.prestateSha256!,
        }, {
          receipt: { beforeOutboxInsert: () => { throw new Error("injected_receipt_failure"); } },
        }),
        /injected_receipt_failure/,
      );
      const [rolledBack] = await getDb().select().from(agentMigrations)
        .where(eq(agentMigrations.id, rollback.target.migrationId));
      assert.equal(rolledBack?.state, "starting");
      assert.equal(rolledBack?.revision, 9);
      assert.deepEqual(await exactCounts(rollback.target.migrationId), { outbox: 0, messages: 0, facts: 0 });

      await assert.rejects(
        getDb().transaction(async (tx) => {
          await tx.update(agentMigrations)
            .set({ updatedAt: new Date("2099-01-01T00:00:00.000Z") })
            .where(eq(agentMigrations.id, rollback.target.migrationId));
        }, { isolationLevel: "repeatable read", accessMode: "read only" }),
        (error: unknown) => errorCode(error) === "25006",
      );

      const deferred = await seedLegacyStartingMigration("deferred");
      await assert.rejects(
        getDb().transaction(async (tx) => {
          await tx.update(agentMigrations)
            .set({
              state: "completed",
              revision: 10,
              completedAt: new Date("2026-08-18T08:00:00.000Z"),
            })
            .where(eq(agentMigrations.id, deferred.target.migrationId));
        }),
        (error: unknown) => errorText(error).includes("terminal agent migration requires durable receipt"),
      );
      const [stillStarting] = await getDb().select().from(agentMigrations)
        .where(eq(agentMigrations.id, deferred.target.migrationId));
      assert.equal(stillStarting?.state, "starting");

      await getDb().execute(sql`
        DROP TRIGGER agent_migration_completed_receipt_required ON agent_migrations
      `);
      await assert.rejects(
        previewLegacyAgentMigrationCompletion(deferred.target),
        /MIGRATION_LEGACY_REPAIR_SCHEMA_NOT_READY/,
      );
    } finally {
      await closeDatabase();
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
      await admin.end();
    }
  },
);
