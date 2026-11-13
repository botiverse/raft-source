import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { afterEach, beforeEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { EXTERNAL_AGENT_RUNTIME_ID } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentChannelReadCursors, agentConfigChangeEvents, agentCredentials, agentMigrationHostedTargets, channels, messageMentions, agentMigrationReceiptOutbox, agentMigrations, agentRuntimeProvisions, agents, machines, messages, serverMembers, servers, users } from "../db/schema";
import {
  HOSTED_MIGRATION_TARGET_CONTROL_IDENTITY,
  beginHostedAgentMigrationProvisioning,
  planZenMigratingDelivery,
  requestAgentMigrationCancellation,
} from "./agentMigrationService";
import {
  HostedMigrationConfirmError,
  claimHostedAgentMigrationImport,
  confirmHostedAgentMigration,
  failHostedAgentMigrationBeforeSwitch,
  getHostedMigrationReview,
  hostedRuntimeSnapshotScope,
  recordHostedAgentMigrationFileSet,
  settleMigratedAgentReadBacklog,
} from "./hostedAgentMigrationService";
import { markTestAgentMigrationReady } from "../test/agentMigrationFixture";
import { ANTIPROTON_PROVISIONING_TOKEN_ENV, __setAgentRuntimeProviderTransportForTests, decryptProviderSecret } from "./agentRuntimeProviderService";
import { probeProviderAgent } from "./agentRuntimeProvisionService";
import { mintAgentCredential, RUNNER_MACHINE_CHANGED_REVOKE_REASON } from "./agentCredentialService";
import {
  HOSTED_MIGRATION_IMPORT_FAILED_REASON,
  HOSTED_MIGRATION_IMPORT_STALLED_REASON,
  HOSTED_MIGRATION_AGENT_DELETED_REASON,
  HOSTED_MIGRATION_PROVIDER_FAILED_REASON,
  HOSTED_MIGRATION_PROVIDER_MISMATCH_REASON,
  onHostedMigrationImported,
  sweepHostedAgentMigrations,
} from "./hostedAgentMigrationCompletion";
import { HOSTED_MIGRATION_NOT_CREATED_REASON } from "./agentMigrationReceiptService";
import type { StorageBackend } from "./storageService";

const limits = { maxTotalBytes: 10485760, maxFiles: 2000, maxFileBytes: 2097152 };
const summary = { importedFileCount: 1, importedBytes: 5, skipped: [] };
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.SLOCK_PROVIDER_CREDENTIAL_KEY;
  else process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = savedKey;
});

async function seed(suffix = "") {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: `hosted-owner${suffix}@example.com`, name: `hosted-owner${suffix}`, passwordHash: "hash", emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({ name: "Hosted", slug: `hosted-migration${suffix}`, ownerId: user.id }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: user.id, role: "owner" });
  const [source] = await db.insert(machines).values({ serverId: server.id, userId: user.id, name: "source-mac", apiKeyHash: "h" }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id, name: "mover", status: "active", sessionId: "native-session",
    runtime: "codex", model: "gpt-5.3-codex", executionMode: "byoc", machineId: source.id,
    creatorType: "user", creatorId: user.id,
  }).returning();
  return { user, server, source, agent };
}

async function readyHostedMigration(now: Date, envVars?: Record<string, string>, suffix = "") {
  const seeded = await seed(suffix);
  if (envVars) await getDb().update(agents).set({ envVars }).where(eq(agents.id, seeded.agent.id));
  const provisioning = await beginHostedAgentMigrationProvisioning({
    agentId: seeded.agent.id,
    hostedTarget: { provider: "antiproton", hostedModel: null, importLimits: limits },
    initiatedByUserId: seeded.user.id,
    transportSessionId: `hosted-${seeded.agent.id}`,
    now,
  });
  await markTestAgentMigrationReady(provisioning, { now: new Date(now.getTime() + 1_000) });
  return { ...seeded, provisioning };
}

test("a hosted migration leases only the source, names the hosted identity, and caps the bundle", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { provisioning, source } = await readyHostedMigration(now);
  const { migration } = provisioning;
  assert.equal(migration.targetKind, "hosted");
  assert.equal(migration.targetMachineId, null);
  assert.equal(provisioning.source.machineId, source.id);
  assert.equal(provisioning.source.message.targetMachineId, HOSTED_MIGRATION_TARGET_CONTROL_IDENTITY);
  assert.equal(migration.transportMaxBytes, 256 * 1024 * 1024);
  const [ready] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, migration.id));
  assert.equal(ready.state, "ready");
  const [hosted] = await db.select().from(agentMigrationHostedTargets).where(eq(agentMigrationHostedTargets.migrationId, migration.id));
  assert.deepEqual(hosted.importLimits, limits);
});

test("claim, review, confirm: the switch makes the agent hosted in one step", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { provisioning, agent, user, server } = await readyHostedMigration(now);
  const claimAt = new Date(now.getTime() + 2_000);
  const claim = await claimHostedAgentMigrationImport({ workerId: "w1", now: claimAt });
  assert.ok(claim);
  assert.equal(claim.migration.state, "in_transit");
  // A second worker gets nothing while the lease holds.
  assert.equal(await claimHostedAgentMigrationImport({ workerId: "w2", now: claimAt }), null);

  const reviewed = await recordHostedAgentMigrationFileSet({
    claim, fileSetObjectKey: "k", fileSetSha256: "s".repeat(64), importSummary: summary, now: claimAt,
  });
  assert.ok(reviewed);
  assert.equal((await getHostedMigrationReview(reviewed.id))?.importSummary?.importedFileCount, 1);
  // The delivery gate still queues while the user decides.
  assert.equal(planZenMigratingDelivery({ migration: reviewed, now: claimAt }).action, "queue");

  await assert.rejects(
    confirmHostedAgentMigration({
      serverId: server.id, agentId: agent.id, migrationRef: reviewed.supportRef,
      expectedRevision: reviewed.revision - 1, userId: user.id, now: claimAt,
    }),
    (error: unknown) => error instanceof HostedMigrationConfirmError && error.code === "MIGRATION_REVISION_STALE",
  );
  const arriving = await confirmHostedAgentMigration({
    serverId: server.id, agentId: agent.id, migrationRef: reviewed.supportRef,
    expectedRevision: reviewed.revision, userId: user.id, now: claimAt,
  });
  assert.equal(arriving.state, "arriving");
  assert.ok(arriving.flippedAt);
  const [switched] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(switched.runtime, EXTERNAL_AGENT_RUNTIME_ID);
  assert.equal(switched.machineId, null);
  assert.equal(switched.sessionId, null);
  // The switch records the configured model it replaced, in the same commit.
  const configEvents = await db.select().from(agentConfigChangeEvents).where(eq(agentConfigChangeEvents.agentId, agent.id));
  assert.equal(configEvents.length, 1);
  assert.equal(configEvents[0].source, "hosted_migration");
  assert.equal(configEvents[0].actorKind, "user");
  assert.equal(configEvents[0].actorId, user.id);
  assert.equal(configEvents[0].beforeRuntime, "codex");
  assert.equal(configEvents[0].beforeModel, "gpt-5.3-codex");
  assert.equal(configEvents[0].afterRuntime, EXTERNAL_AGENT_RUNTIME_ID);
  assert.equal(configEvents[0].afterModel, switched.model);
  assert.equal(configEvents[0].changedAt.toISOString(), claimAt.toISOString());
  const [provision] = await db.select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agent.id));
  assert.equal(provision.importSource, "computer_migration");
  assert.equal(provision.importRef, reviewed.supportRef);
  const [hosted] = await db.select().from(agentMigrationHostedTargets).where(eq(agentMigrationHostedTargets.migrationId, reviewed.id));
  assert.equal(hosted.runtimeSnapshot?.runtime, "codex");
  assert.equal(hosted.runtimeSnapshot?.machineId, provisioning.migration.sourceMachineId);
  // After the switch messages go to the provider, and the switch is final.
  assert.deepEqual(planZenMigratingDelivery({ migration: arriving, now: new Date("2030-01-01T00:00:00.000Z") }), { action: "deliver", reason: "hosted-provider-holds" });
  await assert.rejects(
    requestAgentMigrationCancellation({
      agentId: agent.id, migrationRef: arriving.supportRef, expectedRevision: arriving.revision,
      initiatedByUserId: user.id, reason: "owner_cancel", now: claimAt,
    }),
    /MIGRATION_NOT_CANCELABLE/,
  );
});

test("the switch to the cloud revokes the source Computer's runner credentials and keeps the cloud runtime's", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, user, server, source } = await readyHostedMigration(now);
  const runner = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "runner:source", issuedVia: "computer", issuedByMachineId: source.id, createdByUserId: null });
  const human = await mintAgentCredential({ agentId: agent.id, scopes: ["read"], name: "human", issuedVia: "human", createdByUserId: user.id });
  const claimAt = new Date(now.getTime() + 2_000);
  const claim = await claimHostedAgentMigrationImport({ workerId: "w1", now: claimAt });
  assert.ok(claim);
  const reviewed = await recordHostedAgentMigrationFileSet({
    claim, fileSetObjectKey: "k", fileSetSha256: "s".repeat(64), importSummary: summary, now: claimAt,
  });
  assert.ok(reviewed);
  await confirmHostedAgentMigration({
    serverId: server.id, agentId: agent.id, migrationRef: reviewed.supportRef,
    expectedRevision: reviewed.revision, userId: user.id, now: claimAt,
  });

  const [provision] = await db.select({ credentialId: agentRuntimeProvisions.credentialId }).from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agent.id));
  assert.ok(provision?.credentialId);
  const rows = await db.select({ id: agentCredentials.id, revokedReason: agentCredentials.revokedReason }).from(agentCredentials).where(eq(agentCredentials.agentId, agent.id));
  const reasonOf = (id: string) => rows.find((row) => row.id === id)?.revokedReason ?? null;
  assert.equal(reasonOf(runner.credentialId), RUNNER_MACHINE_CHANGED_REVOKE_REASON);
  assert.equal(reasonOf(human.credentialId), null);
  assert.equal(reasonOf(provision.credentialId), null, "the cloud runtime's own credential stays");
});

test("confirming before the review is built, or after a cancel, changes nothing", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { provisioning, agent, user, server } = await readyHostedMigration(now);
  const at = new Date(now.getTime() + 2_000);
  const claim = await claimHostedAgentMigrationImport({ workerId: "w1", now: at });
  assert.ok(claim);
  await assert.rejects(
    confirmHostedAgentMigration({
      serverId: server.id, agentId: agent.id, migrationRef: claim.migration.supportRef,
      expectedRevision: claim.migration.revision, userId: user.id, now: at,
    }),
    (error: unknown) => error instanceof HostedMigrationConfirmError && error.code === "HOSTED_REVIEW_NOT_READY",
  );
  const reviewed = await recordHostedAgentMigrationFileSet({
    claim, fileSetObjectKey: "k", fileSetSha256: "s".repeat(64), importSummary: summary, now: at,
  });
  assert.ok(reviewed);
  const canceled = await requestAgentMigrationCancellation({
    agentId: agent.id, migrationRef: reviewed.supportRef, expectedRevision: reviewed.revision,
    initiatedByUserId: user.id, reason: "owner_cancel", now: at,
  });
  assert.equal(canceled.migration.state, "canceled_pre_flip");
  // The hosted side has no daemon to wait for.
  assert.equal(canceled.migration.cancelTargetOutcome, "cleaned");
  await assert.rejects(
    confirmHostedAgentMigration({
      serverId: server.id, agentId: agent.id, migrationRef: reviewed.supportRef,
      expectedRevision: reviewed.revision, userId: user.id, now: at,
    }),
    HostedMigrationConfirmError,
  );
  const [still] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(still.machineId, provisioning.migration.sourceMachineId);
  assert.equal(still.runtime, "codex");
});

test("an importer failure fails the migration before the switch and leaves the agent on its Computer", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { provisioning, agent } = await readyHostedMigration(now);
  const claim = await claimHostedAgentMigrationImport({ workerId: "w1", now: new Date(now.getTime() + 2_000) });
  assert.ok(claim);
  const failed = await failHostedAgentMigrationBeforeSwitch({ claim, code: "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH", message: "bad" });
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.failureReason, "MIGRATION_WHOLE_BUNDLE_DIGEST_MISMATCH");
  const [still] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(still.machineId, provisioning.migration.sourceMachineId);
  // A stale lease cannot fail it twice.
  assert.equal(await failHostedAgentMigrationBeforeSwitch({ claim, code: "X", message: "x" }), null);
});

test("the runtime snapshot keeps env values and runtime config out of the clear", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, user, server } = await readyHostedMigration(now, { OPENAI_API_KEY: "sk-very-secret-value" });
  const at = new Date(now.getTime() + 2_000);
  const claim = await claimHostedAgentMigrationImport({ workerId: "w1", now: at });
  assert.ok(claim);
  const reviewed = await recordHostedAgentMigrationFileSet({ claim, fileSetObjectKey: "k", fileSetSha256: "s".repeat(64), importSummary: summary, now: at });
  assert.ok(reviewed);
  await confirmHostedAgentMigration({ serverId: server.id, agentId: agent.id, migrationRef: reviewed.supportRef, expectedRevision: reviewed.revision, userId: user.id, now: at });
  const [hosted] = await db.select().from(agentMigrationHostedTargets).where(eq(agentMigrationHostedTargets.migrationId, reviewed.id));
  const stored = JSON.stringify(hosted.runtimeSnapshot);
  assert.ok(!stored.includes("sk-very-secret-value"));
  assert.ok(!stored.includes("OPENAI_API_KEY"));
  assert.equal(hosted.runtimeSnapshot?.envVarsPresent, true);
  const decrypted = JSON.parse(decryptProviderSecret(hosted.runtimeSnapshot!.encryptedRuntime, hostedRuntimeSnapshotScope(reviewed.id))) as { envVars: Record<string, string> };
  assert.deepEqual(decrypted.envVars, { OPENAI_API_KEY: "sk-very-secret-value" });
  assert.throws(() => decryptProviderSecret(hosted.runtimeSnapshot!.encryptedRuntime, hostedRuntimeSnapshotScope("another-migration")));
});

/** Ready, claimed, reviewed and confirmed: the agent is switched and waits for the provider. */
async function arrivingHostedMigration(now: Date, envVars?: Record<string, string>, suffix = "") {
  const seeded = await readyHostedMigration(now, envVars, suffix);
  const at = new Date(now.getTime() + 2_000);
  const claim = await claimHostedAgentMigrationImport({ workerId: `w${suffix}`, now: at });
  assert.ok(claim);
  const reviewed = await recordHostedAgentMigrationFileSet({ claim, fileSetObjectKey: "file-set-key", fileSetSha256: "s".repeat(64), importSummary: {
    importedFileCount: 2,
    importedBytes: 2048,
    skipped: [{ reason: "provider_rejected", count: 1, bytes: 40, largestPaths: [".env"] }],
  }, now: at });
  assert.ok(reviewed);
  const arriving = await confirmHostedAgentMigration({
    serverId: seeded.server.id, agentId: seeded.agent.id, migrationRef: reviewed.supportRef,
    expectedRevision: reviewed.revision, userId: seeded.user.id, now: at,
  });
  return { ...seeded, arriving, at };
}

function fakeDeps() {
  const archived: string[] = [];
  const deleted: string[] = [];
  return {
    archived,
    deleted,
    deps: {
      orchestrator: { archiveAgentMigrationSourceWorkspace: async (machineId: string) => { archived.push(machineId); return "archived" as const; } },
      storage: { delete: async (key: string) => { deleted.push(key); } } as unknown as StorageBackend,
    },
  };
}

async function receiptText(migrationId: string, kind: "completed" | "failed"): Promise<string> {
  const [row] = await getDb().select({ content: messages.content })
    .from(agentMigrationReceiptOutbox)
    .innerJoin(messages, eq(messages.id, agentMigrationReceiptOutbox.messageId))
    .where(and(eq(agentMigrationReceiptOutbox.migrationId, migrationId), eq(agentMigrationReceiptOutbox.receiptKind, kind)));
  assert.ok(row, `no ${kind} receipt`);
  return row.content;
}

test("once the provider imported the file set the migration completes, archives the Computer copy and drops the file set", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, arriving, source, at } = await arrivingHostedMigration(now);
  // Not imported yet: nothing to complete.
  const { deps, archived, deleted } = fakeDeps();
  assert.equal(await onHostedMigrationImported(agent.id, deps, at), null);

  await db.update(agentRuntimeProvisions).set({ state: "active", providerAgentId: "ap_1", importedAt: at }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  const completed = await onHostedMigrationImported(agent.id, deps, at);
  assert.equal(completed?.state, "completed");
  assert.ok(completed?.completedAt);
  assert.deepEqual(archived, [source.id]);
  assert.deepEqual(deleted, ["file-set-key"]);
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.ok(row.sourceWorkspaceArchivedAt);
  const [hosted] = await db.select().from(agentMigrationHostedTargets).where(eq(agentMigrationHostedTargets.migrationId, arriving.id));
  assert.equal(hosted.fileSetObjectKey, null);
  assert.equal(hosted.runtimeSnapshot, null, "the revert-only snapshot is dropped once completed");

  const text = await receiptText(arriving.id, "completed");
  assert.match(text, /Moved from source-mac to the cloud; you now run as a cloud agent\./);
  assert.match(text, /Brought over 2 files \(2 KB\)\./);
  assert.match(text, /1 files the cloud refused \(e\.g\. credential-like\), 40 bytes \(e\.g\. \.env\)/);
  assert.match(text, /GitHub needs to be reconnected once/);
  assert.doesNotMatch(text, /antiproton|hosted/i);
  // A second hook (or the sweep) changes nothing.
  assert.equal(await onHostedMigrationImported(agent.id, deps, at), null);
});

test("a failed archive goes to the background retry and a failed file-set delete is retried by the sweep", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, arriving, at } = await arrivingHostedMigration(now);
  await db.update(agentRuntimeProvisions).set({ state: "active", providerAgentId: "ap_1", importedAt: at }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  let failDelete = true;
  const deleted: string[] = [];
  const deps = {
    orchestrator: { archiveAgentMigrationSourceWorkspace: async (): Promise<"archived"> => { throw new Error("offline"); } },
    storage: { delete: async (key: string) => { if (failDelete) throw new Error("r2 down"); deleted.push(key); } } as unknown as StorageBackend,
  };
  const completed = await onHostedMigrationImported(agent.id, deps, at);
  assert.equal(completed?.state, "completed");
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.sourceWorkspaceArchivedAt, null);
  assert.equal(row.sourceWorkspaceArchiveAttempts, 1);
  assert.ok(row.sourceWorkspaceArchiveRetryAt);
  assert.match(await receiptText(arriving.id, "completed"), /still being cleaned up in the background/);

  failDelete = false;
  await sweepHostedAgentMigrations({ ...deps, now: at });
  assert.deepEqual(deleted, ["file-set-key"]);
});

test("a create the provider refused and never had puts the agent back on its Computer", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, arriving, source, at } = await arrivingHostedMigration(now, { OPENAI_API_KEY: "sk-very-secret-value" });
  await db.update(agentRuntimeProvisions).set({ state: "failed", lastErrorCode: "plan_required", lastErrorMessage: "Upgrade" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  const { deps } = fakeDeps();

  // The provider cannot be asked: wait.
  assert.equal(await sweepHostedAgentMigrations({ ...deps, now: at, probeProvider: async () => "unknown" }), 0);
  let [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.state, "arriving");
  assert.equal(row.failureReason, null);

  await sweepHostedAgentMigrations({ ...deps, now: at, probeProvider: async () => "never_existed" });
  [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.state, "failed");
  assert.equal(row.failureReason, HOSTED_MIGRATION_NOT_CREATED_REASON);
  assert.equal(row.transportErrorCode, "plan_required");
  const [restored] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(restored.machineId, source.id);
  assert.equal(restored.runtime, "codex");
  assert.equal(restored.model, "gpt-5.3-codex");
  assert.deepEqual(restored.envVars, { OPENAI_API_KEY: "sk-very-secret-value" });
  // The switch and the revert each recorded one change; the revert is the system's.
  const configEvents = await db.select().from(agentConfigChangeEvents).where(eq(agentConfigChangeEvents.agentId, agent.id));
  assert.deepEqual(configEvents.map((event) => event.source).sort(), ["hosted_migration", "hosted_migration_revert"]);
  const revert = configEvents.find((event) => event.source === "hosted_migration_revert")!;
  assert.equal(revert.actorKind, "system");
  assert.equal(revert.actorId, null);
  assert.equal(revert.beforeRuntime, EXTERNAL_AGENT_RUNTIME_ID);
  assert.equal(revert.afterRuntime, "codex");
  assert.equal(revert.afterModel, "gpt-5.3-codex");
  assert.ok(!JSON.stringify(configEvents).includes("sk-very-secret-value"), "no env value is copied into the history");
  assert.equal((await db.select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agent.id))).length, 0);
  const credentials = await db.select().from(agentCredentials).where(eq(agentCredentials.agentId, agent.id));
  assert.ok(credentials.length > 0);
  assert.ok(credentials.every((credential) => credential.revokedAt !== null));
  assert.match(await receiptText(arriving.id, "failed"), /You are still on source-mac; your workspace there was not changed\./);
});

test("a refused create whose source Computer was detached meanwhile leaves the agent unbound and stopped, not on the revoked machine", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, arriving, source, at } = await arrivingHostedMigration(now, undefined, "-detached-source");
  await db.update(agentRuntimeProvisions).set({ state: "failed", lastErrorCode: "plan_required" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  // The source's key is revoked while the agent is hosted (a legacy machine: its own key).
  await db.update(machines).set({ apiKeyHash: "revoked:account_deletion_requested" }).where(eq(machines.id, source.id));
  const { deps } = fakeDeps();

  await sweepHostedAgentMigrations({ ...deps, now: at, probeProvider: async () => "never_existed" });
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.state, "failed");
  assert.equal(row.failureReason, HOSTED_MIGRATION_NOT_CREATED_REASON);
  const [restored] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(restored.machineId, null, "not back on the revoked machine");
  assert.equal(restored.status, "stopped");
  assert.equal(restored.runtime, "codex", "its runtime is restored all the same");
});

test("an import that failed or never came needs attention, and a later import still completes", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, arriving, at } = await arrivingHostedMigration(now);
  const { deps } = fakeDeps();
  await db.update(agentRuntimeProvisions).set({ state: "active", providerAgentId: "ap_1" }).where(eq(agentRuntimeProvisions.agentId, agent.id));

  // Under 20 h without an import: still just waiting.
  assert.equal(await sweepHostedAgentMigrations({ ...deps, now: new Date(at.getTime() + 19 * 3_600_000) }), 0);
  await sweepHostedAgentMigrations({ ...deps, now: new Date(at.getTime() + 21 * 3_600_000) });
  let [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.failureReason, HOSTED_MIGRATION_IMPORT_STALLED_REASON);

  await db.update(agentRuntimeProvisions).set({ importFailedAt: at, importErrorCode: "too_large" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  await sweepHostedAgentMigrations({ ...deps, now: at });
  [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.state, "arriving");
  assert.equal(row.failureReason, HOSTED_MIGRATION_IMPORT_FAILED_REASON);
  // Marked once, not on every pass.
  assert.equal(await sweepHostedAgentMigrations({ ...deps, now: at }), 0);

  // A manual retry imported it.
  await db.update(agentRuntimeProvisions).set({ importFailedAt: null, importedAt: at }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  await sweepHostedAgentMigrations({ ...deps, now: at });
  [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.state, "completed");
  assert.equal(row.failureReason, null);
});

test("rows waiting on a person never crowd a new arrival out of the sweep", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { deps } = fakeDeps();
  // 21 stuck rows: a refused create the provider will not answer for.
  for (let index = 0; index < 21; index += 1) {
    const { agent } = await arrivingHostedMigration(now, undefined, `-stuck-${index}`);
    await db.update(agentRuntimeProvisions).set({ state: "failed" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  }
  await sweepHostedAgentMigrations({ ...deps, now, probeProvider: async () => "unknown" });
  const fresh = await arrivingHostedMigration(new Date(now.getTime() + 60_000), undefined, "-fresh");
  await db.update(agentRuntimeProvisions).set({ state: "active", providerAgentId: "ap_fresh", importedAt: fresh.at }).where(eq(agentRuntimeProvisions.agentId, fresh.agent.id));
  // The hook was lost; the sweep alone must complete it.
  await sweepHostedAgentMigrations({ ...deps, now: fresh.at, probeProvider: async () => "unknown" });
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, fresh.arriving.id));
  assert.equal(row.state, "completed");
});

test("a refused create the provider had, deleted, or files under another tenant is left to a person", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { deps } = fakeDeps();
  const cases = [
    ["exists", HOSTED_MIGRATION_PROVIDER_FAILED_REASON],
    ["deleted", HOSTED_MIGRATION_AGENT_DELETED_REASON],
    ["elsewhere", HOSTED_MIGRATION_PROVIDER_MISMATCH_REASON],
  ] as const;
  for (const [existence, reason] of cases) {
    const { agent, arriving, at } = await arrivingHostedMigration(now, undefined, `-${existence}`);
    await db.update(agentRuntimeProvisions).set({ state: "failed" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
    await sweepHostedAgentMigrations({ ...deps, now: at, probeProvider: async (agentId) => agentId === agent.id ? existence : "unknown" });
    const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
    assert.equal(row.state, "arriving", existence);
    assert.equal(row.failureReason, reason);
    const [still] = await db.select().from(agents).where(eq(agents.id, agent.id));
    assert.equal(still.machineId, null, `${existence}: no automatic revert`);
  }
});

test("a refused create whose provider never answers still reaches a person after 20 h", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, arriving, at } = await arrivingHostedMigration(now);
  await db.update(agentRuntimeProvisions).set({ state: "failed" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  const { deps } = fakeDeps();
  await sweepHostedAgentMigrations({ ...deps, now: new Date(at.getTime() + 21 * 3_600_000), probeProvider: async () => "unknown" });
  const [row] = await db.select().from(agentMigrations).where(eq(agentMigrations.id, arriving.id));
  assert.equal(row.state, "arriving");
  assert.equal(row.failureReason, HOSTED_MIGRATION_IMPORT_STALLED_REASON);
  const [still] = await db.select().from(agents).where(eq(agents.id, agent.id));
  assert.equal(still.machineId, null, "no revert without a never_existed answer");
});

test("only a 2xx that says never_existed counts as never created; anything else is unknown", async ({ db }) => {
  const now = new Date("2026-10-18T06:00:00.000Z");
  const { agent, server, at } = await arrivingHostedMigration(now);
  await db.update(agentRuntimeProvisions).set({ state: "failed" }).where(eq(agentRuntimeProvisions.agentId, agent.id));
  const savedToken = process.env[ANTIPROTON_PROVISIONING_TOKEN_ENV];
  process.env[ANTIPROTON_PROVISIONING_TOKEN_ENV] = "test-token";
  const urls: string[] = [];
  let answer: () => Response = () => Response.json({});
  __setAgentRuntimeProviderTransportForTests({
    baseUrl: "http://127.0.0.1:1",
    fetch: (async (url: string) => { urls.push(String(url)); return answer(); }) as typeof globalThis.fetch,
  });
  try {
    const cases: Array<[() => Response, string]> = [
      [() => Response.json({}), "unknown"],
      [() => Response.json({ state: "bogus" }), "unknown"],
      [() => Response.json({ state: 1 }), "unknown"],
      [() => new Response("not json", { status: 200 }), "unknown"],
      [() => Response.json({ error: { code: "not_found" } }, { status: 404 }), "unknown"],
      [() => Response.json({}, { status: 401 }), "unknown"],
      [() => Response.json({}, { status: 405 }), "unknown"],
      [() => Response.json({ state: "deleted" }), "deleted"],
      [() => Response.json({ state: "never_existed" }), "never_existed"],
    ];
    for (const [response, expected] of cases) {
      answer = response;
      assert.equal(await probeProviderAgent(agent.id), expected, `${expected} for ${response().status} ${await response().text()}`);
    }
    // Asked with the server the provision was created with.
    assert.ok(urls.every((url) => url.includes(`/provision/agents/by-raft-agent/${agent.id}/existence`) && url.includes(server.id)));

    // A 2xx {} through the real probe never reverts.
    answer = () => Response.json({});
    const { deps } = fakeDeps();
    await sweepHostedAgentMigrations({ ...deps, now: at });
    const [still] = await db.select().from(agents).where(eq(agents.id, agent.id));
    assert.equal(still.machineId, null);
  } finally {
    __setAgentRuntimeProviderTransportForTests(null);
    if (savedToken === undefined) delete process.env[ANTIPROTON_PROVISIONING_TOKEN_ENV];
    else process.env[ANTIPROTON_PROVISIONING_TOKEN_ENV] = savedToken;
  }
});

test("the switch marks an old read backlog read and keeps DMs and unread @mentions", async ({ db }) => {
  const now = new Date("2026-10-20T19:00:00.000Z");
  const { provisioning, agent, user, server } = await readyHostedMigration(now, undefined, "-backlog");
  const [backlog, mentioned, dm, current] = await db.insert(channels).values([
    { serverId: server.id, name: "backlog", type: "channel" },
    { serverId: server.id, name: "mentioned", type: "channel" },
    { serverId: server.id, name: "dm-owner", type: "dm" },
    { serverId: server.id, name: "current", type: "channel" },
  ]).returning();
  const post = async (channelId: string, content: string) =>
    (await db.insert(messages).values({ channelId, senderType: "user", senderId: user.id, content }).returning())[0]!;
  const readThrough = async (channelId: string, seq: number) =>
    db.insert(agentChannelReadCursors).values({ agentId: agent.id, channelId, lastReadSeq: seq });
  const cursorOf = async (channelId: string) =>
    (await db.select({ seq: agentChannelReadCursors.lastReadSeq, version: agentChannelReadCursors.readStateVersion })
      .from(agentChannelReadCursors)
      .where(and(eq(agentChannelReadCursors.agentId, agent.id), eq(agentChannelReadCursors.channelId, channelId))))[0]!;

  const backlogRead = await post(backlog.id, "read in July");
  await post(backlog.id, "never delivered 1");
  const backlogLatest = await post(backlog.id, "never delivered 2");
  await readThrough(backlog.id, backlogRead.seq);

  const mentionedRead = await post(mentioned.id, "read");
  const mention = await post(mentioned.id, "@mover please look");
  await db.insert(messageMentions).values({
    messageId: mention.id, serverId: server.id, channelId: mentioned.id, messageSeq: mention.seq,
    targetType: "agent", targetId: agent.id, handleAtSendTime: "mover",
  });
  await readThrough(mentioned.id, mentionedRead.seq);

  const dmRead = await post(dm.id, "hi");
  await post(dm.id, "still waiting on you");
  await readThrough(dm.id, dmRead.seq);
  // A thread in the DM is owed too.
  const [dmThread] = await db.insert(channels).values({ serverId: server.id, name: "dm-thread", type: "thread", parentMessageId: dmRead.id }).returning();
  const dmThreadRead = await post(dmThread.id, "thread start");
  await post(dmThread.id, "thread follow-up");
  await readThrough(dmThread.id, dmThreadRead.seq);

  const currentLatest = await post(current.id, "seen");
  await readThrough(current.id, currentLatest.seq);
  const currentBefore = await cursorOf(current.id);

  const claimAt = new Date(now.getTime() + 2_000);
  const claim = await claimHostedAgentMigrationImport({ workerId: "w1", now: claimAt });
  assert.ok(claim);
  const reviewed = await recordHostedAgentMigrationFileSet({
    claim, fileSetObjectKey: "k", fileSetSha256: "s".repeat(64), importSummary: summary, now: claimAt,
  });
  assert.ok(reviewed);
  await confirmHostedAgentMigration({
    serverId: server.id, agentId: agent.id, migrationRef: reviewed.supportRef,
    expectedRevision: reviewed.revision, userId: user.id, now: claimAt,
  });
  assert.equal(provisioning.migration.agentId, agent.id);

  assert.equal((await cursorOf(backlog.id)).seq, backlogLatest.seq, "the old backlog is read through its latest message");
  assert.equal((await cursorOf(mentioned.id)).seq, mentionedRead.seq, "an unread @mention of the agent stays unread");
  assert.equal((await cursorOf(dm.id)).seq, dmRead.seq, "a DM stays unread");
  assert.equal((await cursorOf(dmThread.id)).seq, dmThreadRead.seq, "a thread in a DM stays unread");
  assert.deepEqual(await cursorOf(current.id), currentBefore, "a conversation already read is not touched");

  // Raise-only and idempotent: a second pass finds nothing left to settle.
  assert.deepEqual(await settleMigratedAgentReadBacklog(db, agent.id), { conversations: 0, messages: 0, keptConversations: 3 });
});
