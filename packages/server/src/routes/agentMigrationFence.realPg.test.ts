// Route teeth for task #93 line C on real PostgreSQL: each human migration route passes the actor fence into its write,
// so a removal that commits after the request-level checks is refused by the write itself with zero migration state
// change. The removal is held uncommitted in another session while the real HTTP request runs: the request-level checks
// still read the committed member row, and the fenced write is the one seen waiting on it. Each test also proves the
// request got past its request-level stage (provisioner or runtime start called, migration error code), so a lock taken
// earlier in the request cannot satisfy it.
//
// CI: `probe-concurrency-real-pg`, with ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL (shared with the other fence teeth).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import pg from "pg";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import {
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  type ServerRole,
} from "@botiverse/raft-shared";
import { beginArrivingTestAgentMigration } from "../test/agentMigrationFixture";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { agentMigrations, machines, serverMembers, servers, users } from "../db/schema";
import * as agentMigrationService from "../services/agentMigrationService";
import { createAgent } from "../services/agentService";
import { createServer } from "../services/serverService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const REAL_PG_URL = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.ACTOR_MEMBERSHIP_FENCE_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const TEST_TIMEOUT_MS = 60_000;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: TEST_TIMEOUT_MS };

const TRANSFER_SUMMARY = {
  includedFileCount: 1,
  includedBytes: 64,
  excludedRegenerableCount: 0,
  excludedRegenerableByCategory: { thirdPartyDependencies: 0, caches: 0, buildArtifacts: 0, otherRegenerable: 0 },
  keyWorkspaceEntries: { memoryMdPresent: false, notesPresent: false },
};

type TestApp = Awaited<ReturnType<typeof openTestApp>>;

async function withRealPgApp(run: (app: TestApp, observer: pg.Pool) => Promise<void>) {
  assert.ok(REAL_PG_URL, "ACTOR_MEMBERSHIP_FENCE_REAL_PG_URL is required");
  const observer = new pg.Pool({ connectionString: REAL_PG_URL, max: 4 });
  try {
    await migrateRealPgTestDatabase(observer, MIGRATIONS_FOLDER);
    const app = await openTestApp(REAL_PG_URL, 0, {
      humanActivityMuteFlagDefaultEnabled: true,
      skipAuthRateLimit: true,
    });
    try {
      await run(app, observer);
    } finally {
      await app.close();
    }
  } finally {
    await observer.end();
  }
}

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `migration-route-fence-${label}-${suffix}@slock.test`,
    name: `migration-route-fence-${label}-${suffix}`,
    displayName: `migration-route-fence-${label}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedServer(actorRole: ServerRole) {
  const owner = await seedUser("owner");
  const actor = await seedUser("actor");
  const suffix = randomUUID().slice(0, 8);
  const server = await createServer(`Migration Route Fence ${suffix}`, `migration-route-fence-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: actor.id, role: actorRole });
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const now = new Date();
  const [sourceMachine, targetMachine] = await getDb().insert(machines).values([
    { serverId: server.id, userId: owner.id, name: `route-source-${suffix}`, apiKeyHash: `route-source-${suffix}`, runtimes: ["codex"], daemonVersion: "0.72.7", lastHeartbeat: now },
    { serverId: server.id, userId: owner.id, name: `route-target-${suffix}`, apiKeyHash: `route-target-${suffix}`, runtimes: ["codex"], daemonVersion: "0.72.7", lastHeartbeat: now },
  ]).returning();
  const agent = await createAgent(server.id, `route-fence-agent-${suffix}`, { runtime: "codex", machineId: sourceMachine!.id });
  return { owner, actor, server, sourceMachine: sourceMachine!, targetMachine: targetMachine!, agent };
}

/**
 * Waits until a backend running `queryLike` is lock-waiting behind `blockedBy`. Scoping the wait to the removal's own
 * session keeps a concurrently running test (the probe step runs several real-PG files) from satisfying it.
 */
async function waitForLockWaiter(observer: pg.Pool, queryLike: string, blockedBy: number) {
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND query ILIKE $1 AND $2::int = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [queryLike, blockedBy],
    );
    if (rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`no backend waited on a lock for ${queryLike} behind pid ${blockedBy} within ${LOCK_WAIT_TIMEOUT_MS}ms`);
}

/**
 * Holds the actor's removal uncommitted, sends the request, requires the fenced write to wait on the member row, then
 * commits the removal and returns the response.
 */
async function requestDuringRemoval(
  observer: pg.Pool,
  serverId: string,
  actorId: string,
  send: () => Promise<Response>,
): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const session = await observer.connect();
  let response: Promise<{ status: number; body: { error?: string; code?: string } }> | undefined;
  const state = { settled: false };
  try {
    await session.query("BEGIN");
    const { rows: [removal] } = await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await session.query("DELETE FROM server_members WHERE server_id = $1 AND user_id = $2", [serverId, actorId]);
    response = send().then(async (res) => ({ status: res.status, body: await res.json() as { error?: string; code?: string } }));
    response.then(() => { state.settled = true; }, () => { state.settled = true; });
    await waitForLockWaiter(observer, "%from server_members%for share%", removal!.pid);
    assert.equal(state.settled, false, "the request must wait for the uncommitted removal");
    await session.query("COMMIT");
  } finally {
    await session.query("ROLLBACK").catch(() => undefined);
    session.release();
  }
  return await response!;
}

test("real PG route: POST /api/agents/:id/migrate refuses an initiator removed after the request-level checks, creating no migration", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seedServer("admin");
    const actorToken = await tokenForHuman(seeded.actor.email);
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    const sentLeases: string[] = [];
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      getMachineStatus: async () => "online",
      getMachineDaemonVersion: () => "0.72.7",
      getMachineMigrationTransport: async (machineId: string) => ({
        protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
        capabilities: [AGENT_MIGRATION_CAPABILITY],
      }),
      sendAgentMigrationTransportLease: async (machineId: string) => {
        sentLeases.push(machineId);
      },
    });
    let provisionerCalls = 0;
    app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => {
      provisionerCalls += 1;
      return {
        provider: "object_store" as const,
        sessionId: `route-fence-${randomUUID().slice(0, 8)}`,
        leaseMs: 60 * 60 * 1000,
        maxBytes: 123_456,
        storageKey: "agent-migrations/route-fence/bundle",
      };
    });

    const res = await requestDuringRemoval(observer, seeded.server.id, seeded.actor.id, () =>
      fetch(`${app.baseUrl}/api/agents/${seeded.agent.id}/migrate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${actorToken}`, "X-Server-Id": seeded.server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ targetComputer: seeded.targetMachine.id }),
      }));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.deepEqual(res.body, { error: "Not a member of this server", code: "not_supported", details: { failureReason: "not_supported" } });
    assert.equal(provisionerCalls, 1, "the request passed its request-level checks and reached the write transaction");
    assert.equal(sentLeases.length, 0, "no transfer lease is sent");
    const rows = await getDb().select({ id: agentMigrations.id }).from(agentMigrations).where(eq(agentMigrations.agentId, seeded.agent.id));
    assert.equal(rows.length, 0, "a removed initiator creates no migration");
  });
});

test("real PG route: POST /api/agents/:id/migration/cancel refuses a canceller removed after the request-level checks, changing nothing", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    const seeded = await seedServer("admin");
    const provisioned = await agentMigrationService.beginAgentMigrationProvisioning({
      agentId: seeded.agent.id,
      targetMachineId: seeded.targetMachine.id,
      initiatedByUserId: seeded.owner.id,
      transportSessionId: `route-cancel-fence-${randomUUID().slice(0, 8)}`,
    });
    const [migration] = await getDb().update(agentMigrations)
      .set({ state: "in_transit", transportGeneration: "route-cancel-fence-generation" })
      .where(eq(agentMigrations.id, provisioned.migration.id))
      .returning();
    const actorToken = await tokenForHuman(seeded.actor.email);
    const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    const deliveries: string[] = [];
    app.app.set("agentOrchestrator", {
      ...originalOrchestrator,
      sendAgentMigrationCancel: async (machineId: string) => {
        deliveries.push(machineId);
      },
    });

    const res = await requestDuringRemoval(observer, seeded.server.id, seeded.actor.id, () =>
      fetch(`${app.baseUrl}/api/agents/${seeded.agent.id}/migration/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${actorToken}`, "X-Server-Id": seeded.server.id, "Content-Type": "application/json" },
        body: JSON.stringify({ migrationRef: migration!.supportRef, expectedRevision: migration!.revision }),
      }));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    // The migration error shape proves the refusal came from the route's write, not an earlier membership guard.
    assert.deepEqual(res.body, { error: "Not a member of this server", code: "not_supported", details: { failureReason: "not_supported" } });
    assert.equal(deliveries.length, 0, "no cancellation is dispatched");
    const [after] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, migration!.id));
    assert.equal(after?.state, "in_transit");
    assert.equal(after?.revision, migration!.revision);
    assert.equal(after?.cancelRequestedAt, null);
  });
});

test("real PG route: POST /api/agents/:id/start refuses to complete a migration for a starter removed after the request-level checks", REAL_PG_TEST, async () => {
  await withRealPgApp(async (app, observer) => {
    // Members hold controlAgentRuntime.
    const seeded = await seedServer("member");
    const now = new Date();
    const arriving = await beginArrivingTestAgentMigration({
      agentId: seeded.agent.id,
      targetMachineId: seeded.targetMachine.id,
      initiatedByUserId: seeded.owner.id,
      now,
    }, { transferSummary: TRANSFER_SUMMARY });
    const archived = await agentMigrationService.recordAgentMigrationSourceWorkspaceArchived({
      migrationId: arriving.id,
      migrationGeneration: agentMigrationService.agentMigrationGeneration(arriving),
      serverId: seeded.server.id,
      targetMachineId: seeded.targetMachine.id,
      now,
    });
    const arrival = await agentMigrationService.markAgentMigrationTargetImportArrived({
      migrationId: arriving.id,
      migrationGeneration: archived.migrationGeneration,
      serverId: seeded.server.id,
      targetMachineId: seeded.targetMachine.id,
      now,
    });
    assert.equal(arrival.migration.state, "starting");
    const actorToken = await tokenForHuman(seeded.actor.email);
    let startCalls = 0;
    Object.assign(app.app.get("agentOrchestrator"), {
      hasMachineLocally: () => true,
      startAgent: async () => {
        startCalls += 1;
        return { outcome: "dispatched" as const };
      },
    });

    const res = await requestDuringRemoval(observer, seeded.server.id, seeded.actor.id, () =>
      fetch(`${app.baseUrl}/api/agents/${seeded.agent.id}/start`, {
        method: "POST",
        headers: { Authorization: `Bearer ${actorToken}`, "X-Server-Id": seeded.server.id },
      }));
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.error, "Not a member of this server");
    assert.equal(startCalls, 1, "the request passed its request-level checks and dispatched the runtime start (line A effect)");
    const [after] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
    assert.equal(after?.state, "starting", "the migration is not completed by a removed starter");
    assert.equal(after?.completedAt, null);
  });
});
