// POST /internal/agent-api/migrations/retry: an agent retries, once, its own
// migration to another Computer after it failed because the workspace was too
// big. The failed migration comes from the real service entry points
// (beginTestAgentMigration, then the source's size report through
// markAgentMigrationTransportLostForComputer), and the retry is asked with the
// agent's own credential, as `raft migration retry` asks it.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  AGENT_MIGRATION_AGENT_RETRY_CAPABILITY,
  AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RETRY_NOTE,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  agentMigrationReceiptOutbox,
  agentMigrations,
  integrationAuditEvents,
  machines,
  messages,
  notificationOutbox,
  serverMembers,
  servers,
  users,
} from "../db/schema";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { markAgentMigrationTransportLostForComputer } from "../services/agentMigrationService";
import { isAgentMigrationRetryUniqueViolation } from "../services/agentMigrationRetry";
import { createServer } from "../services/serverService";
import { beginTestAgentMigration } from "../test/agentMigrationFixture";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest();

const ENTRY_COUNT_FAILURE = "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=2500000:maxEntries=2000000"
  + ":topPathCounts=node_modules%2F,1900000;.cache%2F,400000";

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seedMachine(serverId: string, userId: string, name: string) {
  const [machine] = await getDb().insert(machines).values({
    id: randomUUID(),
    serverId,
    userId,
    name,
    apiKeyHash: `${name}-hash-${randomUUID()}`,
    runtimes: ["codex"],
    daemonVersion: "0.72.7",
    lastHeartbeat: new Date(),
  }).returning();
  return machine!;
}

async function agentKey(agentId: string) {
  const { apiKey } = await mintAgentCredential({
    agentId,
    scopes: ["read", "send", "server"],
    name: `retry-${randomUUID().slice(0, 6)}`,
    issuedVia: "computer",
    createdByUserId: null,
  });
  return apiKey;
}

type App = { app: { get(key: string): unknown; set(key: string, value: unknown): void }; baseUrl: string };

/**
 * A Pro server with an owner and an admin, an agent on `source`, a second
 * agent, and a stub orchestrator: every Computer online and on migration/v3;
 * the source also advertises the retry capability unless told otherwise.
 */
async function seedFixture(app: App) {
  const owner = await seedUser("retry-owner");
  const admin = await seedUser("retry-admin");
  const server = await createServer("Retry", `retry-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: admin.id, role: "admin" });
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const source = await seedMachine(server.id, owner.id, `source-${randomUUID().slice(0, 6)}`);
  const target = await seedMachine(server.id, owner.id, `target-${randomUUID().slice(0, 6)}`);
  const agent = await createAgent(server.id, `retry-agent-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: source.id });
  const other = await createAgent(server.id, `retry-other-${randomUUID().slice(0, 6)}`, { runtime: "codex", machineId: source.id });

  const state = {
    sourceCapabilities: [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_AGENT_RETRY_CAPABILITY] as string[],
    offline: new Set<string>(),
    leases: [] as Array<{ machineId: string; role: string; migrationId: string }>,
    provisions: 0,
  };
  const originalOrchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...originalOrchestrator,
    getMachineStatus: async (machineId: string) => state.offline.has(machineId) ? "offline" : "online",
    getMachineMigrationTransport: async (machineId: string) => ({
      capabilities: machineId === source.id ? state.sourceCapabilities : [AGENT_MIGRATION_CAPABILITY],
    }),
    getMachineRuntimeDetection: async () => null,
    sendAgentMigrationTransportLease: async (machineId: string, message: { role: string; migrationId: string }) => {
      state.leases.push({ machineId, role: message.role, migrationId: message.migrationId });
    },
  });
  app.app.set("agentMigrationObjectStoreTransferProvisioner", async () => {
    state.provisions += 1;
    return { provider: "object_store" as const, sessionId: `retry-session-${randomUUID()}`, leaseMs: 60 * 60 * 1000, maxBytes: 123_456 };
  });

  return {
    owner,
    admin,
    server,
    source,
    target,
    agent,
    other,
    state,
    agentKey: await agentKey(agent.id),
    otherKey: await agentKey(other.id),
    ownerToken: await tokenForHuman(owner.email),
  };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

/** A migration of the agent to `target`, failed by the source's size report. */
async function failForSize(fx: Fixture, input: { initiatedByUserId?: string; message?: string; detailCode?: string } = {}) {
  const started = await beginTestAgentMigration({
    agentId: fx.agent.id,
    targetMachineId: fx.target.id,
    initiatedByUserId: input.initiatedByUserId ?? fx.owner.id,
  });
  return await markAgentMigrationTransportLostForComputer({
    migrationId: started.migration.id,
    serverId: fx.server.id,
    machineId: fx.source.id,
    detailCode: input.detailCode ?? "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: input.message ?? ENTRY_COUNT_FAILURE,
  });
}

async function postRetry(app: App, key: string, body?: unknown) {
  const res = await fetch(`${app.baseUrl}/internal/agent-api/migrations/retry`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text) as Record<string, any>, text };
}

async function migrationsOf(agentId: string) {
  return await getDb().select().from(agentMigrations).where(eq(agentMigrations.agentId, agentId));
}

test("retries a size-failed migration once: everything copied, on behalf of the starter, recorded as the agent's", async ({ app }) => {
  const fx = await seedFixture(app);
  const failed = await failForSize(fx, { initiatedByUserId: fx.admin.id });

  // Body params are ignored: the retry repeats the failed migration as it was.
  const res = await postRetry(app, fx.agentKey, { targetComputer: fx.source.name, agentId: fx.other.id });
  assert.equal(res.status, 200, res.text);
  const rows = await migrationsOf(fx.agent.id);
  assert.equal(rows.length, 2);
  const retry = rows.find((row) => row.id !== failed.id)!;
  assert.deepEqual(res.body, {
    migrationId: retry.id,
    supportRef: retry.supportRef,
    targetMachineName: fx.target.name,
    note: AGENT_MIGRATION_RETRY_NOTE,
  });
  assert.equal(retry.retryOfMigrationId, failed.id);
  assert.equal(retry.triggeredByAgentId, fx.agent.id);
  assert.equal(retry.initiatedByUserId, fx.admin.id, "on behalf of the failed migration's starter");
  assert.equal(retry.targetKind, "computer");
  assert.equal(retry.sourceMachineId, fx.source.id);
  assert.equal(retry.targetMachineId, fx.target.id);
  assert.equal(retry.state, "provisioning");
  assert.deepEqual(
    fx.state.leases.map(({ machineId, role, migrationId }) => [machineId, role, migrationId]).sort(),
    [[fx.source.id, "source", retry.id], [fx.target.id, "target", retry.id]].sort(),
    "both Computers get their transport lease, as for the owner's start",
  );
  assert.equal((await migrationsOf(fx.other.id)).length, 0, "only the acting agent's migrations");

  // Audit: the agent acted, for the starter.
  const [audit] = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.eventType, "agent.migration_retry_started"),
    eq(integrationAuditEvents.serverId, fx.server.id),
  ));
  assert.equal(audit?.actorType, "agent");
  assert.equal(audit?.actorId, fx.agent.id);
  assert.equal(audit?.requesterType, "human");
  assert.equal(audit?.requesterId, fx.admin.id);
  assert.deepEqual(audit?.metadata, {
    agentId: fx.agent.id,
    migrationId: retry.id,
    retryOfMigrationId: failed.id,
    onBehalfOfUserId: fx.admin.id,
    sourceMachineId: fx.source.id,
    targetMachineId: fx.target.id,
  });
  // The starter is told.
  const started = await getDb().select().from(notificationOutbox).where(and(
    eq(notificationOutbox.receiverId, fx.admin.id),
    eq(notificationOutbox.eventKey, `migration:${retry.id}:retry_started`),
  ));
  assert.equal(started.length, 1);
  assert.equal(started[0]!.category, "system_notice");

  // The owner's view names the retry and what the failed attempt measured.
  const status = await fetch(`${app.baseUrl}/api/agents/${fx.agent.id}/migration`, {
    headers: { Authorization: `Bearer ${fx.ownerToken}`, "X-Server-Id": fx.server.id },
  });
  assert.equal(status.status, 200);
  const view = (await status.json() as { migration: Record<string, unknown> }).migration;
  assert.equal(view.migrationRef, retry.supportRef);
  assert.equal(view.retryOfMigrationId, failed.id);
  assert.equal(view.triggeredByAgentId, fx.agent.id);
  assert.deepEqual(view.retryComparison, {
    previousFailure: { code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED", entries: 2_500_000, bytes: null, bytesIsLowerBound: false },
    packed: null,
  });

  // The retry fails for size too: the receipt says a person starts the next
  // one, the starter is told, and no second retry is offered or accepted.
  const retryFailed = await markAgentMigrationTransportLostForComputer({
    migrationId: retry.id,
    serverId: fx.server.id,
    machineId: fx.source.id,
    detailCode: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: ENTRY_COUNT_FAILURE,
    reporterMigrationCapabilities: fx.state.sourceCapabilities,
  });
  assert.equal(retryFailed.state, "failed");
  const [receiptRow] = await getDb().select().from(agentMigrationReceiptOutbox).where(and(
    eq(agentMigrationReceiptOutbox.migrationId, retry.id),
    eq(agentMigrationReceiptOutbox.receiptKind, "failed"),
  ));
  const [receipt] = await getDb().select().from(messages).where(eq(messages.id, receiptRow!.messageId));
  assert.match(receipt!.content, /The automatic retry also failed; a person needs to start the next migration\./);
  assert.doesNotMatch(receipt!.content, /raft migration retry/);
  const failedNotice = await getDb().select().from(notificationOutbox).where(and(
    eq(notificationOutbox.receiverId, fx.admin.id),
    eq(notificationOutbox.eventKey, `migration:${retry.id}:retry_failed`),
  ));
  assert.equal(failedNotice.length, 1);

  const again = await postRetry(app, fx.agentKey);
  assert.equal(again.status, 409, again.text);
  assert.equal(again.body.code, "ALREADY_RETRIED");
  assert.equal((await migrationsOf(fx.agent.id)).length, 2);
});

test("the original failed receipt offers the retry when the source supports it", async ({ app }) => {
  const fx = await seedFixture(app);
  const started = await beginTestAgentMigration({ agentId: fx.agent.id, targetMachineId: fx.target.id, initiatedByUserId: fx.owner.id });
  await markAgentMigrationTransportLostForComputer({
    migrationId: started.migration.id,
    serverId: fx.server.id,
    machineId: fx.source.id,
    detailCode: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: ENTRY_COUNT_FAILURE,
    reporterMigrationCapabilities: fx.state.sourceCapabilities,
  });
  const [receiptRow] = await getDb().select().from(agentMigrationReceiptOutbox).where(eq(agentMigrationReceiptOutbox.migrationId, started.migration.id));
  const [receipt] = await getDb().select().from(messages).where(eq(messages.id, receiptRow!.messageId));
  assert.match(receipt!.content, new RegExp(`then run \`raft migration retry\` \\(once; it moves you to ${fx.target.name} again\\)\\.`));
  // Not a retry: nobody is notified of a retry.
  assert.equal((await getDb().select().from(notificationOutbox).where(eq(notificationOutbox.receiverId, fx.owner.id))).length, 0);
});

test("refusals change nothing and leave the one retry for later", async ({ app }) => {
  const fx = await seedFixture(app);
  const expectRefused = async (code: string, status: number, key = fx.agentKey) => {
    const before = (await migrationsOf(fx.agent.id)).length;
    const leases = fx.state.leases.length;
    const res = await postRetry(app, key);
    assert.equal(res.status, status, `${code}: ${res.text}`);
    assert.equal(res.body.code, code, res.text);
    assert.equal(typeof res.body.error, "string");
    // The reason says "move" (the CLI's word) and carries no next step; the next step is its own field.
    assert.doesNotMatch(res.body.error, /migration|ask a person|try again/i, `${code}: ${res.body.error}`);
    assert.equal(typeof res.body.suggestedNextAction, "string", `${code} must say what to do instead`);
    assert.ok(res.body.suggestedNextAction.length > 0);
    assert.equal((await migrationsOf(fx.agent.id)).length, before, `${code} must not create a migration`);
    assert.equal(fx.state.leases.length, leases, `${code} must not send a lease`);
  };

  // Nothing to retry yet.
  await expectRefused("NO_RETRYABLE_MIGRATION", 409);

  // A failure that is not about size.
  await failForSize(fx, { detailCode: "MIGRATION_TRANSPORT_LOST", message: "MIGRATION_TRANSPORT_LOST: connection reset" });
  await expectRefused("NO_RETRYABLE_MIGRATION", 409);

  // A size failure; the other agent has nothing of its own to retry.
  const failed = await failForSize(fx);
  await expectRefused("NO_RETRYABLE_MIGRATION", 409, fx.otherKey);

  // The source does not support it.
  fx.state.sourceCapabilities = [AGENT_MIGRATION_CAPABILITY];
  await expectRefused("SOURCE_UNSUPPORTED", 409);
  fx.state.sourceCapabilities = [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_AGENT_RETRY_CAPABILITY];

  // The target is offline.
  fx.state.offline.add(fx.target.id);
  await expectRefused("TARGET_UNAVAILABLE", 409);
  fx.state.offline.clear();

  // The server left Pro: nothing provisioned.
  await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, fx.server.id));
  const provisions = fx.state.provisions;
  await expectRefused("PLAN_REQUIRED", 403);
  assert.equal(fx.state.provisions, provisions, "the paywall refuses before transport provisioning");
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, fx.server.id));

  // Another migration of the agent is in progress (created before the failed one, so the failed one is still the newest).
  const active = await beginTestAgentMigration({ agentId: fx.agent.id, targetMachineId: fx.target.id, initiatedByUserId: fx.owner.id });
  await getDb().update(agentMigrations)
    .set({ createdAt: new Date(failed.createdAt.getTime() - 60_000) })
    .where(eq(agentMigrations.id, active.migration.id));
  await expectRefused("MIGRATION_ACTIVE", 409);
  await getDb().update(agentMigrations).set({ state: "aborted" }).where(eq(agentMigrations.id, active.migration.id));

  // Too long ago.
  await getDb().update(agentMigrations)
    .set({ transportLostAt: new Date(Date.now() - AGENT_MIGRATION_AGENT_RETRY_WINDOW_MS - 60_000) })
    .where(eq(agentMigrations.id, failed.id));
  await expectRefused("RETRY_WINDOW_EXPIRED", 409);
  await getDb().update(agentMigrations).set({ transportLostAt: new Date() }).where(eq(agentMigrations.id, failed.id));

  // None of those used it up.
  const res = await postRetry(app, fx.agentKey);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.migrationId, (await migrationsOf(fx.agent.id)).find((row) => row.retryOfMigrationId === failed.id)?.id);
});

test("the starter's authority is checked again: a starter who lost migrateAgents is refused", async ({ app }) => {
  const fx = await seedFixture(app);
  await failForSize(fx, { initiatedByUserId: fx.admin.id });
  // The admin who started it is now a member (no migrateAgents, not the agent's creator).
  await getDb().update(serverMembers).set({ role: "member" })
    .where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, fx.admin.id)));
  const refused = await postRetry(app, fx.agentKey);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.body.code, "STARTER_NOT_AUTHORIZED");

  // Gone from the server altogether.
  await getDb().delete(serverMembers)
    .where(and(eq(serverMembers.serverId, fx.server.id), eq(serverMembers.userId, fx.admin.id)));
  const gone = await postRetry(app, fx.agentKey);
  assert.equal(gone.body.code, "STARTER_NOT_AUTHORIZED");
  assert.equal((await migrationsOf(fx.agent.id)).length, 1);

  // Back as admin: the same retry goes through.
  await getDb().insert(serverMembers).values({ serverId: fx.server.id, userId: fx.admin.id, role: "admin" });
  const ok = await postRetry(app, fx.agentKey);
  assert.equal(ok.status, 200, ok.text);
});

test("idx_agent_migrations_retry_of allows one retry per migration", async ({ app }) => {
  const fx = await seedFixture(app);
  const failed = await failForSize(fx);
  const ok = await postRetry(app, fx.agentKey);
  assert.equal(ok.status, 200, ok.text);
  const [retry] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.retryOfMigrationId, failed.id));
  // A second row naming the same failed migration (a race the route's checks lost) is refused by the index.
  await getDb().update(agentMigrations).set({ state: "aborted" }).where(eq(agentMigrations.id, retry!.id));
  const { id: _id, supportRef: _ref, grantKey: _grant, receiptChannelId: _channel, ...copy } = retry!;
  await assert.rejects(
    getDb().insert(agentMigrations).values({ ...copy, state: "aborted", supportRef: `mig_${randomUUID().replace(/-/g, "").slice(0, 22)}`, grantKey: `agent_migration:${randomUUID()}` }),
    (err: unknown) => {
      assert.ok(isAgentMigrationRetryUniqueViolation(err), String(err));
      return true;
    },
  );
});
