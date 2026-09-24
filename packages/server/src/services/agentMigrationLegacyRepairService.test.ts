import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  agentMigrationReceiptOutbox,
  agentMigrations,
  agents,
  inboxNotificationFacts,
  messages,
} from "../db/schema.js";
import {
  parseJohnMigrationRepairArgs,
  normalizeJohnMigrationRepairError,
  runJohnMigrationRepair,
  type JohnMigrationRepairDependencies,
} from "../../scripts/ops/incidents/task-39/repair-john-agent-migration-completion.js";
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
import { users } from "../db/schema.js";


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
  keyWorkspaceEntries: {
    memoryMdPresent: true,
    notesPresent: false,
  },
} as const;

afterEach(async () => {
  await closeTestDatabase();
});

async function seedLegacyStartingMigration(): Promise<{
  target: LegacyAgentMigrationRepairTarget;
  row: typeof agentMigrations.$inferSelect;
}> {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `legacy-migration-repair-${suffix}@slock.test`,
    name: `legacy-migration-repair-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const server = await createServer("Legacy Migration Repair", `legacy-migration-repair-${suffix}`, owner.id);
  const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "Legacy Source");
  const { machine: targetMachine } = await registerMachine(server.id, owner.id, "Legacy Target");
  const agent = await createAgent(server.id, "legacy-repair-agent", {
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
    manifestPath: "object-store:legacy/manifest.json",
    manifestSha256: "sha256:legacy",
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
  await db.update(agents)
    .set({ status: "active" })
    .where(eq(agents.id, agent.id));
  assert.ok(row);
  const [holder] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(holder?.machineId, targetMachine.id);
  assert.equal(holder?.status, "active");
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

function historicalProjection(row: typeof agentMigrations.$inferSelect) {
  const {
    state: _state,
    failureReason: _failureReason,
    autoStartFailureStage: _autoStartFailureStage,
    autoStartFailureCode: _autoStartFailureCode,
    autoStartRemediationLeaseId: _autoStartRemediationLeaseId,
    autoStartRemediationLeaseExpiresAt: _autoStartRemediationLeaseExpiresAt,
    completedAt: _completedAt,
    transportTeardownAt: _transportTeardownAt,
    revision: _revision,
    updatedAt: _updatedAt,
    ...historical
  } = row;
  return historical;
}

async function receiptCounts() {
  const db = getDb();
  return {
    messages: (await db.select().from(messages)).length,
    facts: (await db.select().from(inboxNotificationFacts)).length,
    outbox: (await db.select().from(agentMigrationReceiptOutbox)).length,
  };
}

test("legacy repair previews exact prestate and atomically completes with one durable private receipt", async () => {
  const fixture = await seedLegacyStartingMigration();
  const before = await getDb().select().from(agentMigrations);
  const preview = await previewLegacyAgentMigrationCompletion(fixture.target);
  assert.equal(preview.status, "ready");
  assert.match(preview.prestateSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(await getDb().select().from(agentMigrations), before);
  assert.deepEqual(await receiptCounts(), { messages: 0, facts: 0, outbox: 0 });

  const appliedAt = new Date("2026-08-18T08:00:00.000Z");
  const result = await applyLegacyAgentMigrationCompletion({
    ...fixture.target,
    expectedPrestateSha256: preview.prestateSha256!,
    now: appliedAt,
  });
  assert.deepEqual(result, { status: "applied", revision: 10 });

  const [after] = await getDb().select().from(agentMigrations)
    .where(eq(agentMigrations.id, fixture.target.migrationId));
  assert.equal(after?.state, "completed");
  assert.equal(after?.revision, 10);
  assert.equal(after?.failureReason, null);
  assert.equal(after?.autoStartFailureStage, "legacy");
  assert.equal(after?.autoStartFailureCode, "legacy_auto_start_failed");
  assert.equal(after?.completedAt?.toISOString(), appliedAt.toISOString());
  assert.equal(after?.transportTeardownAt?.toISOString(), appliedAt.toISOString());
  assert.deepEqual(historicalProjection(after!), historicalProjection(fixture.row));
  assert.deepEqual(await receiptCounts(), { messages: 1, facts: 1, outbox: 1 });

  const snapshot = {
    migrations: await getDb().select().from(agentMigrations),
    counts: await receiptCounts(),
  };
  const replay = await applyLegacyAgentMigrationCompletion({
    ...fixture.target,
    expectedPrestateSha256: "0".repeat(64),
  });
  assert.deepEqual(replay, { status: "already_repaired", revision: 10 });
  assert.deepEqual({
    migrations: await getDb().select().from(agentMigrations),
    counts: await receiptCounts(),
  }, snapshot);
});

test("legacy repair fails closed on digest drift and rolls receipt failure back with zero residue", async () => {
  const fixture = await seedLegacyStartingMigration();
  const preview = await previewLegacyAgentMigrationCompletion(fixture.target);
  assert.equal(preview.status, "ready");
  const before = await getDb().select().from(agentMigrations);

  await assert.rejects(
    applyLegacyAgentMigrationCompletion({
      ...fixture.target,
      expectedPrestateSha256: "0".repeat(64),
    }),
    /MIGRATION_LEGACY_REPAIR_PRESTATE_DRIFT/,
  );
  assert.deepEqual(await getDb().select().from(agentMigrations), before);
  assert.deepEqual(await receiptCounts(), { messages: 0, facts: 0, outbox: 0 });

  await assert.rejects(
    applyLegacyAgentMigrationCompletion({
      ...fixture.target,
      expectedPrestateSha256: preview.prestateSha256!,
    }, {
      receipt: {
        beforeOutboxInsert: () => {
          throw new Error("PRIVATE_SENTINEL query=SELECT * dsn=postgres://private");
        },
      },
    }),
    /PRIVATE_SENTINEL/,
  );
  assert.deepEqual(await getDb().select().from(agentMigrations), before);
  assert.deepEqual(await receiptCounts(), { messages: 0, facts: 0, outbox: 0 });
});

test("legacy repair rejects holder drift before any terminal or receipt write", async () => {
  const fixture = await seedLegacyStartingMigration();
  await getDb().update(agents)
    .set({ machineId: fixture.row.sourceMachineId })
    .where(eq(agents.id, fixture.target.agentId));
  const before = await getDb().select().from(agentMigrations);
  await assert.rejects(
    previewLegacyAgentMigrationCompletion(fixture.target),
    /MIGRATION_LEGACY_REPAIR_HOLDER_DRIFT/,
  );
  assert.deepEqual(await getDb().select().from(agentMigrations), before);
  assert.deepEqual(await receiptCounts(), { messages: 0, facts: 0, outbox: 0 });
});

test("John carrier CLI requires exact apply confirmation and never exposes raw unexpected errors", () => {
  assert.deepEqual(parseJohnMigrationRepairArgs([]), { mode: "preview" });
  assert.deepEqual(
    parseJohnMigrationRepairArgs([
      "--apply",
      "--confirm",
      "task39-john-migration-completion",
      "--prestate-sha256",
      "a".repeat(64),
    ]),
    { mode: "apply", expectedPrestateSha256: "a".repeat(64) },
  );
  assert.throws(
    () => parseJohnMigrationRepairArgs(["--apply", "--confirm", "wrong", "--prestate-sha256", "a".repeat(64)]),
    /JOHN_MIGRATION_REPAIR_CONFIRMATION_REQUIRED/,
  );
  const privateError = new Error("PRIVATE_SENTINEL stack detail query postgres://private");
  assert.equal(normalizeJohnMigrationRepairError(privateError), "JOHN_MIGRATION_REPAIR_FAILED");
  assert.equal(normalizeJohnMigrationRepairError(
    new Error("MIGRATION_LEGACY_REPAIR_SCHEMA_NOT_READY"),
  ), "MIGRATION_LEGACY_REPAIR_SCHEMA_NOT_READY");
});

test("John carrier CLI emits only the closed preview receipt and fixed stderr code", async () => {
  const stdout: string[] = [];
  const dependencies: JohnMigrationRepairDependencies = {
    initDatabase: async () => undefined,
    closeDatabase: async () => undefined,
    preview: async () => ({
      status: "ready",
      prestateSha256: "b".repeat(64),
      expectedRevision: 9,
    }),
    apply: async () => ({ status: "applied", revision: 10 }),
  };
  await runJohnMigrationRepair({
    argv: [],
    databaseUrl: "postgres://PRIVATE_DSN",
    writeStdout: (line) => stdout.push(line),
    dependencies,
  });
  assert.deepEqual(stdout, [
    `JOHN_MIGRATION_REPAIR_PREVIEW_READY prestate_sha256=${"b".repeat(64)}`,
  ]);
  assert.equal(stdout.join("\n").includes("PRIVATE_DSN"), false);

  const applyStdout: string[] = [];
  await runJohnMigrationRepair({
    argv: [
      "--apply",
      "--confirm",
      "task39-john-migration-completion",
      "--prestate-sha256",
      "b".repeat(64),
    ],
    databaseUrl: "postgres://PRIVATE_DSN",
    writeStdout: (line) => applyStdout.push(line),
    dependencies,
  });
  assert.deepEqual(applyStdout, ["JOHN_MIGRATION_REPAIR_APPLIED revision=10"]);
  assert.equal(applyStdout.join("\n").includes("PRIVATE_DSN"), false);

  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const packageJson = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { scripts?: Record<string, string> };
  const command = packageJson.scripts?.["migration:repair-john-completion"];
  assert.equal(
    command,
    "tsx scripts/ops/incidents/task-39/repair-john-agent-migration-completion.ts",
  );
  const scriptPath = fileURLToPath(
    new URL(`../../${command.slice("tsx ".length)}`, import.meta.url),
  );
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const child = spawnSync(process.execPath, ["--import", "tsx", scriptPath], {
    cwd: packageRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "JOHN_MIGRATION_REPAIR_DATABASE_URL_REQUIRED\n");
});
