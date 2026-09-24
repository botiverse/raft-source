import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "vitest";
import { fileURLToPath } from "node:url";
import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  type AgentMigrationControlManifest,
} from "@botiverse/raft-shared";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import {
  agentMigrationChunkReceipts,
  agentMigrations,
  agents,
  servers,
  users,
} from "../db/schema.js";
import { completeAgentMigrationResumableUpload } from "./agentMigrationService.js";

const REAL_PG_URL_ENV = "AGENT_MIGRATION_RECEIPT_ORDER_REAL_PG_URL";
const REAL_PG_REQUIRED = process.env.AGENT_MIGRATION_RECEIPT_ORDER_REAL_PG_REQUIRED === "1";
const REAL_PG_URL = process.env[REAL_PG_URL_ENV];
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  const sortJsonValue = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sortJsonValue);
    if (current && typeof current === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        sorted[key] = sortJsonValue((current as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return current;
  };
  return JSON.stringify(sortJsonValue(value));
}

function controlManifest(input: {
  migrationId: string;
  generation: string;
  leaseId: string;
  agentId: string;
  sourceMachineId: string;
  targetMachineId: string;
  chunkCount: number;
}): AgentMigrationControlManifest {
  const chunks = Array.from({ length: input.chunkCount }, (_, index) => ({
    index,
    offsetBytes: index * 4,
    sizeBytes: 4,
    sha256: String(index + 1).repeat(64),
  }));
  return {
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: input.migrationId,
      migrationGeneration: input.generation,
      leaseId: input.leaseId,
      agentId: input.agentId,
      sourceMachineId: input.sourceMachineId,
      targetMachineId: input.targetMachineId,
    },
    capability: { required: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES] },
    bundle: {
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      totalBytes: input.chunkCount * 4,
      sha256: "f".repeat(64),
      chunkSizeBytes: 1024 * 1024,
      chunks,
    },
    archive: {
      format: "tar+gzip",
      entryCount: 1,
      expandedBytes: 1,
      maxEntryBytes: 1,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: {
      includedFileCount: 1,
      includedBytes: 1,
      excludedRegenerableCount: 0,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 0,
        caches: 0,
        buildArtifacts: 0,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: { memoryMdPresent: true, notesPresent: false },
    },
    commit: {
      mode: "atomic-rename",
      markerPath: AGENT_MIGRATION_COMMIT_MARKER_PATH,
      requireWholeBundleDigest: true,
      requireAllChunkDigests: true,
      existingWorkspace: "idle-or-same-commit",
    },
  };
}

test(
  "upload completion orders real-Postgres receipt rows before positional validation",
  {
    skip: !(REAL_PG_URL || REAL_PG_REQUIRED),
  },
  async () => {
    assert.ok(REAL_PG_URL);
    const databaseName = `slock_migration_receipt_order_${process.pid}_${randomBytes(4).toString("hex")}`;
    const admin = new pg.Client({
      connectionString: REAL_PG_URL,
      application_name: "migration-receipt-order-admin",
    });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const testUrl = databaseUrlFor(REAL_PG_URL, databaseName);

      const configure = new pg.Client({ connectionString: testUrl });
      await configure.connect();
      try {
        // The regression requires a deterministic heap scan. These disposable-DB
        // settings keep the service's un-ordered SELECT away from either index;
        // the precondition below then proves PostgreSQL actually returns 2,1,0.
        await configure.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_indexscan = off`);
        await configure.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_indexonlyscan = off`);
        await configure.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET enable_bitmapscan = off`);
        await configure.query(`ALTER DATABASE ${quoteIdentifier(databaseName)} SET max_parallel_workers_per_gather = 0`);
      } finally {
        await configure.end();
      }

      const migratePool = new pg.Pool({ connectionString: testUrl, max: 1 });
      await migrate(drizzle(migratePool), { migrationsFolder: MIGRATIONS_FOLDER });
      await migratePool.end();
      await initDatabase(testUrl);

      const db = getDb();
      const userId = randomUUID();
      const serverId = randomUUID();
      await db.insert(users).values({
        id: userId,
        email: `${databaseName}@example.test`,
        name: "migration-receipt-order-owner",
        passwordHash: "hash",
        emailVerified: true,
      });
      await db.insert(servers).values({
        id: serverId,
        name: "Migration Receipt Order",
        slug: databaseName.replaceAll("_", "-"),
        ownerId: userId,
      });

      const seedUpload = async (label: string, chunkCount: number) => {
        const agentId = randomUUID();
        const migrationId = randomUUID();
        const sourceMachineId = randomUUID();
        const targetMachineId = randomUUID();
        const generation = `generation-${label}`;
        const leaseId = `lease-${label}`;
        const sourceToken = `source-token-${label}`;
        const control = controlManifest({
          migrationId,
          generation,
          leaseId,
          agentId,
          sourceMachineId,
          targetMachineId,
          chunkCount,
        });
        const controlSha256 = sha256(canonicalJson(control));
        const now = new Date("2099-08-08T00:00:00.000Z");

        await db.insert(agents).values({
          id: agentId,
          serverId,
          name: `receipt-order-${label}`,
          status: "active",
        });
        await db.insert(agentMigrations).values({
          id: migrationId,
          serverId,
          agentId,
          sourceMachineId,
          targetMachineId,
          sourceMachineNameSnapshot: `source-${label}`,
          targetMachineNameSnapshot: `target-${label}`,
          state: "provisioning",
          supportRef: `mig_receipt_order_${label}`,
          contractVersion: 2,
          grantKey: `grant-receipt-order-${label}`,
          transportSessionId: `session-${label}`,
          transportProvider: "object_store",
          transportExpiresAt: new Date("2100-08-08T00:00:00.000Z"),
          transportMaxBytes: 1024 * 1024 * 1024,
          sourceTransportTokenHash: sha256(sourceToken),
          targetTransportTokenHash: sha256(`target-token-${label}`),
          transportProtocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
          transportGeneration: generation,
          transportLeaseId: leaseId,
          transportExpectedMigrationRevision: 1,
          transportControlManifest: control,
          transportControlSha256: controlSha256,
          transportControlRegisteredAt: now,
          sourceQuiescedAt: now,
          prepDeadlineAt: new Date("2100-08-08T01:00:00.000Z"),
          transferDeadlineAt: new Date("2100-08-08T02:00:00.000Z"),
          arrivalDeadlineAt: new Date("2100-08-08T03:00:00.000Z"),
          createdAt: now,
          updatedAt: now,
        });
        await db.insert(agentMigrationChunkReceipts).values(
          [...control.bundle.chunks].reverse().map((chunk) => ({
            migrationId,
            transportGeneration: generation,
            leaseId,
            chunkIndex: chunk.index,
            sizeBytes: chunk.sizeBytes,
            sha256: chunk.sha256,
            sourceReceiptAt: now,
            createdAt: now,
            updatedAt: now,
          })),
        );
        return {
          input: {
            migrationId,
            serverId,
            sourceMachineId,
            transportToken: sourceToken,
            migrationGeneration: generation,
            leaseId,
            controlSha256,
            now: new Date("2099-08-08T00:01:00.000Z"),
          },
          migrationId,
          generation,
        };
      };

      const single = await seedUpload("single", 1);
      assert.equal((await completeAgentMigrationResumableUpload(single.input)).state, "ready");

      const multi = await seedUpload("multi", 3);
      const physicalRead = new pg.Client({ connectionString: testUrl });
      await physicalRead.connect();
      try {
        const result = await physicalRead.query<{ chunk_index: number }>(
          `SELECT chunk_index
             FROM agent_migration_chunk_receipts
            WHERE migration_id = $1 AND transport_generation = $2`,
          [multi.migrationId, multi.generation],
        );
        assert.deepEqual(
          result.rows.map((row) => row.chunk_index),
          [2, 1, 0],
          "the RED proof requires a real unordered PostgreSQL result",
        );
      } finally {
        await physicalRead.end();
      }

      const completed = await completeAgentMigrationResumableUpload(multi.input);
      assert.equal(completed.state, "ready");
      assert.ok(completed.transportUploadCompletedAt);
      await closeDatabase();
    } finally {
      await closeDatabase().catch(() => {});
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
);
