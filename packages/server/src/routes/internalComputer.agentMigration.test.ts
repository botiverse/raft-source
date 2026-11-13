import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_CAPABILITY,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY,
  type AgentMigrationControlManifest,
} from "@botiverse/raft-shared";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agentCredentials,
  agentMigrations,
  agents,
  computers,
  messages,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { registerMachine } from "../services/machineService";
import { mintAgentCredential, RUNNER_MACHINE_CHANGED_REVOKE_REASON } from "../services/agentCredentialService";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService";
import { AgentMigrationSourceArchiveError } from "../services/agentMigrationSourceArchive";
import { drainAgentMigrationRemediation } from "../services/agentMigrationRemediationWorker";
import {
  beginAgentMigrationProvisioning,
  requestAgentMigrationCancellation,
  type AgentMigrationTargetImportView,
} from "../services/agentMigrationService";
import { markTestAgentMigrationReady } from "../test/agentMigrationFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const TEST_TRANSFER_SUMMARY = {
  includedFileCount: 2,
  includedBytes: 128,
  excludedRegenerableCount: 2,
  excludedRegenerableByCategory: {
    thirdPartyDependencies: 1,
    caches: 0,
    buildArtifacts: 1,
    otherRegenerable: 0,
  },
  keyWorkspaceEntries: {
    memoryMdPresent: true,
    notesPresent: false,
  },
} as const;

async function seedMigrationApiFixture(options: { provisioning?: boolean } = {}): Promise<{
  targetComputerApiKey: string;
  sourceComputerApiKey: string;
  migrationId: string;
  migrationRef: string;
  agentId: string;
  serverId: string;
  ownerId: string;
  sourceMachineId: string;
  targetMachineId: string;
  sourceMigrationToken?: string;
  targetMigrationToken?: string;
  transportGeneration?: string;
  transportLeaseId?: string;
  expectedMigrationRevision?: number;
}> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `migration-api-${suffix}@slock.test`,
    name: `migration-api-${suffix}`,
    displayName: "Migration API Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Migration API", `migration-api-${suffix}`, owner.id);
  const { machine: sourceMachine } = await registerMachine(server.id, owner.id, "source-machine");
  const { machine: targetMachine } = await registerMachine(server.id, owner.id, "target-machine");
  const agent = await createAgent(server.id, "MigrationBot", {
    runtime: "codex",
    model: "gpt-5-codex",
    machineId: sourceMachine.id,
  });
  await db.update(agents)
    .set({ sessionId: "source-native-session" })
    .where(eq(agents.id, agent.id));
  const now = new Date();
  const provisioning = await beginAgentMigrationProvisioning({
    agentId: agent.id,
    targetMachineId: targetMachine.id,
    initiatedByUserId: owner.id,
    now,
    prepDeadlineMs: 60 * 60 * 1000,
    transferDeadlineMs: 60 * 60 * 1000,
    arrivalDeadlineMs: 60 * 60 * 1000,
    transportSessionId: `session-${suffix}`,
  });
  const { migration } = provisioning;
  if (!options.provisioning) {
    await markTestAgentMigrationReady(provisioning, { now, transferSummary: TEST_TRANSFER_SUMMARY });
  }

  const targetComputer = await generateComputerApiKeyMaterial();
  const sourceComputer = await generateComputerApiKeyMaterial();
  await db.insert(computers).values([
    {
      serverId: server.id,
      name: "target-computer",
      apiKeyHash: targetComputer.apiKeyHash,
      apiKeyPrefix: targetComputer.apiKeyPrefix,
      attachedByUserId: owner.id,
      machineId: targetMachine.id,
    },
    {
      serverId: server.id,
      name: "source-computer",
      apiKeyHash: sourceComputer.apiKeyHash,
      apiKeyPrefix: sourceComputer.apiKeyPrefix,
      attachedByUserId: owner.id,
      machineId: sourceMachine.id,
    },
  ]);

  return {
    targetComputerApiKey: targetComputer.apiKey,
    sourceComputerApiKey: sourceComputer.apiKey,
    migrationId: migration.id,
    migrationRef: migration.supportRef,
    agentId: agent.id,
    serverId: server.id,
    ownerId: owner.id,
    sourceMachineId: sourceMachine.id,
    targetMachineId: targetMachine.id,
    sourceMigrationToken: provisioning.source.message.bearerToken,
    targetMigrationToken: provisioning.target.message.bearerToken,
    transportGeneration: provisioning.source.message.transportGeneration,
    transportLeaseId: provisioning.source.message.leaseId,
    expectedMigrationRevision: provisioning.source.message.expectedMigrationRevision,
  };
}

async function readMigration(baseUrl: string, apiKey: string, migrationId: string): Promise<AgentMigrationTargetImportView> {
  const res = await fetch(`${baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}`, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: true; migration: AgentMigrationTargetImportView };
  assert.equal(body.ok, true);
  return body.migration;
}

async function postMigrationStep(
  baseUrl: string,
  apiKey: string,
  migrationId: string,
  step: "start-transfer" | "flip-machine" | "arrived",
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}/${step}`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

async function postMigrationTransportLost(
  baseUrl: string,
  apiKey: string,
  migrationId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}/transport-lost`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test("agent migration target import API resolves target handoff by migration id", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const byId = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);

  assert.equal(byId.migrationId, f.migrationId);
  assert.equal("grantKey" in byId, false);
  assert.equal(byId.state, "ready");
  assert.equal(byId.canDriveTargetImport, true);

  const sourceAttempt = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(f.migrationId)}`, {
    method: "GET",
    headers: authHeaders(f.sourceComputerApiKey),
  });
  assert.equal(sourceAttempt.status, 404);
  assert.equal((await sourceAttempt.json() as { code?: string }).code, "migration_missing");
});

test("resumable migration routes enforce source quiescence, immutable generation, and transport-token auth", async ({ app }) => {
  const f = await seedMigrationApiFixture({ provisioning: true });
  assert.ok(f.sourceMigrationToken);
  assert.ok(f.targetMigrationToken);
  assert.ok(f.transportGeneration);
  assert.ok(f.transportLeaseId);
  assert.ok(f.expectedMigrationRevision);
  const base = `${app.baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(f.migrationId)}/resumable`;
  const sourceHeaders = {
    ...authHeaders(f.sourceComputerApiKey),
    "X-Raft-Migration-Token": f.sourceMigrationToken,
  };
  const control: AgentMigrationControlManifest = {
    schemaVersion: AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
    protocol: AGENT_MIGRATION_RESUMABLE_PROTOCOL,
    identity: {
      migrationId: f.migrationId,
      migrationGeneration: f.transportGeneration,
      leaseId: f.transportLeaseId,
      agentId: f.agentId,
      sourceMachineId: f.sourceMachineId,
      targetMachineId: f.targetMachineId,
    },
    capability: { required: [AGENT_MIGRATION_CAPABILITY] },
    bundle: {
      contentType: AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
      totalBytes: 2,
      sha256: "a".repeat(64),
      chunkSizeBytes: 1024 * 1024,
      chunks: [{ index: 0, offsetBytes: 0, sizeBytes: 2, sha256: "b".repeat(64) }],
    },
    archive: {
      format: "tar+gzip",
      entryCount: 1,
      expandedBytes: 2,
      maxEntryBytes: 2,
      allowedEntryTypes: ["file", "symlink"],
    },
    transferSummary: {
      includedFileCount: 1,
      includedBytes: 2,
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

  const missingToken = await fetch(`${base}/source-quiesced`, {
    method: "POST",
    headers: authHeaders(f.sourceComputerApiKey),
    body: JSON.stringify({ receipt: {} }),
  });
  assert.equal(missingToken.status, 401);
  assert.equal((await missingToken.json() as { code?: string }).code, "migration_transport_token_missing");

  const beforeQuiesce = await fetch(`${base}/control`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ control }),
  });
  assert.equal(beforeQuiesce.status, 409);
  assert.equal((await beforeQuiesce.json() as { code?: string }).code, "migration_source_not_quiesced");

  // task #62: a draining source reports its wait before quiesce. Give the
  // fixture the drain room a draining source gets (sourceDrainUntil = prep - 10 min).
  const drainCap = new Date(Date.now() + 5 * 60 * 1000);
  await getDb().update(agentMigrations)
    .set({ prepDeadlineAt: new Date(drainCap.getTime() + 10 * 60 * 1000) })
    .where(eq(agentMigrations.id, f.migrationId));
  const draining = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ migrationGeneration: f.transportGeneration, phase: "draining", drainUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(), waitingFor: "queued_input" }),
  });
  assert.equal(draining.status, 200, await draining.clone().text());
  assert.equal((await draining.json() as { advanced?: boolean }).advanced, false);
  const [whileDraining] = await getDb().select({ sourceBuildProgress: agentMigrations.sourceBuildProgress })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(whileDraining.sourceBuildProgress?.phase, "draining");
  assert.equal((whileDraining.sourceBuildProgress as { drainUntil?: string }).drainUntil, drainCap.toISOString(), "clamped to the lease's sourceDrainUntil");
  assert.equal((whileDraining.sourceBuildProgress as { waitingFor?: string }).waitingFor, "queued_input");
  const malformedDraining = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ migrationGeneration: f.transportGeneration, phase: "draining" }),
  });
  assert.equal(malformedDraining.status, 400);
  assert.equal((await malformedDraining.json() as { code?: string }).code, "migration_source_progress_invalid");

  const quiesced = await fetch(`${base}/source-quiesced`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({
      receipt: {
        schemaVersion: "agent-migration-quiesce/v1",
        migrationId: f.migrationId,
        migrationGeneration: f.transportGeneration,
        agentId: f.agentId,
        sourceMachineId: f.sourceMachineId,
        sourceRuntimeState: "stopped",
        stoppedAt: new Date().toISOString(),
        actor: "migration",
        launchSessionIdentity: "launch:route-test:session:route-test",
        expectedRuntimeRevision: String(f.expectedMigrationRevision),
      },
    }),
  });
  assert.equal(quiesced.status, 200, await quiesced.text());

  const invalidProgress = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ migrationGeneration: f.transportGeneration, phase: "uploading", files: 1, bytes: 1 }),
  });
  assert.equal(invalidProgress.status, 400);
  assert.equal((await invalidProgress.json() as { code?: string }).code, "migration_source_progress_invalid");
  // The source's first report carries what it did with the user's ignore
  // additions; a malformed receipt gets the same 400 as any malformed report.
  const userIgnoreAdditions = { written: 1, alreadyPresent: 0, rejected: [{ path: "/abs", reason: "invalid_line" }] };
  const invalidReceipt = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({
      migrationGeneration: f.transportGeneration,
      phase: "scanning",
      files: 0,
      bytes: 0,
      userIgnoreAdditions: { ...userIgnoreAdditions, written: -1 },
    }),
  });
  assert.equal(invalidReceipt.status, 400);
  assert.equal((await invalidReceipt.json() as { code?: string }).code, "migration_source_progress_invalid");
  const receiptProgress = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ migrationGeneration: f.transportGeneration, phase: "scanning", files: 0, bytes: 0, userIgnoreAdditions }),
  });
  assert.equal(receiptProgress.status, 200, await receiptProgress.text());
  const [withReceipt] = await getDb().select({ userIgnoreReceipt: agentMigrations.userIgnoreReceipt })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.deepEqual(withReceipt.userIgnoreReceipt, userIgnoreAdditions);
  const progress = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ migrationGeneration: f.transportGeneration, phase: "scanning", files: 12, bytes: 3_400 }),
  });
  const progressBody = await progress.json() as { advanced?: boolean; prepDeadlineAt?: string };
  assert.equal(progress.status, 200, JSON.stringify(progressBody));
  assert.equal(progressBody.advanced, true);
  assert.ok(progressBody.prepDeadlineAt);
  const repeatedProgress = await fetch(`${base}/source-progress`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ migrationGeneration: f.transportGeneration, phase: "scanning", files: 12, bytes: 3_400 }),
  });
  assert.equal((await repeatedProgress.json() as { advanced?: boolean }).advanced, false);

  const registered = await fetch(`${base}/control`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({ control }),
  });
  const registeredBody = await registered.json() as { code?: string; missingChunkIndexes?: number[] };
  assert.equal(registered.status, 200, JSON.stringify(registeredBody));
  assert.deepEqual(registeredBody.missingChunkIndexes, [0]);

  const staleReceipt = await fetch(`${base}/chunks/0/receipt`, {
    method: "POST",
    headers: sourceHeaders,
    body: JSON.stringify({
      role: "source",
      migrationGeneration: "stale-generation",
      leaseId: f.transportLeaseId,
      chunkIndex: 0,
      sizeBytes: 2,
      sha256: "b".repeat(64),
    }),
  });
  assert.equal(staleReceipt.status, 409);
  assert.equal((await staleReceipt.json() as { code?: string }).code, "migration_generation_stale");
});

test("agent migration transport-lost API clears provisioning and ready participant migrations", async ({ app }) => {
  const provisioning = await seedMigrationApiFixture({ provisioning: true });
  const ready = await seedMigrationApiFixture();

  for (const f of [provisioning, ready]) {
    const lost = await postMigrationTransportLost(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
      message: "MIGRATION_TEST_CLEAR_STUCK",
    });
    assert.equal(lost.status, 200);
    assert.equal(lost.json.ok, true);
    assert.equal((lost.json.migration as { state?: string }).state, "failed");
    assert.equal((lost.json.migration as { transportErrorCode?: string }).transportErrorCode, "MIGRATION_TRANSPORT_LOST");

    const [migrationRow] = await getDb()
      .select({
        state: agentMigrations.state,
        failureReason: agentMigrations.failureReason,
        transportErrorCode: agentMigrations.transportErrorCode,
        transportErrorMessage: agentMigrations.transportErrorMessage,
      })
      .from(agentMigrations)
      .where(eq(agentMigrations.id, f.migrationId));
    assert.equal(migrationRow.state, "failed");
    assert.equal(migrationRow.failureReason, "MIGRATION_TRANSPORT_LOST");
    assert.equal(migrationRow.transportErrorCode, "MIGRATION_TRANSPORT_LOST");
    assert.equal(migrationRow.transportErrorMessage, "MIGRATION_TEST_CLEAR_STUCK");
  }
});

test("agent migration transport-lost API persists the typed object-store size reason", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const boundedAccountingMessage = "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE:actualBytes=629145600:maxBytes=536870912:topEntries=.git%2F,314572800;archive.tar,209715200;media%2F,104857600";

  const lost = await postMigrationTransportLost(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
    message: boundedAccountingMessage,
  });
  assert.equal(lost.status, 200);
  assert.equal(lost.json.ok, true);
  assert.equal((lost.json.migration as { state?: string }).state, "failed");
  assert.equal(
    (lost.json.migration as { failureReason?: string }).failureReason,
    "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
  );
  assert.equal(
    (lost.json.migration as { transportErrorCode?: string }).transportErrorCode,
    "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
  );

  const [migrationRow] = await getDb()
    .select({
      state: agentMigrations.state,
      failureReason: agentMigrations.failureReason,
      transportErrorCode: agentMigrations.transportErrorCode,
      transportErrorMessage: agentMigrations.transportErrorMessage,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "failed");
  assert.equal(migrationRow.failureReason, "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE");
  assert.equal(migrationRow.transportErrorCode, "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE");
  assert.equal(
    migrationRow.transportErrorMessage,
    boundedAccountingMessage,
  );
});

test("a workspace-size failure bumps the agent's config revision and pushes its config; another failure does not", async ({ app }) => {
  const pushed: string[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    applyAgentConfig: async (agentId: string) => {
      pushed.push(agentId);
      return "pushed" as const;
    },
  });
  const configRevision = async (agentId: string) => (await getDb().select({ configRevision: agents.configRevision })
    .from(agents).where(eq(agents.id, agentId)))[0]!.configRevision;

  const sized = await seedMigrationApiFixture();
  const before = await configRevision(sized.agentId);
  const lost = await postMigrationTransportLost(app.baseUrl, sized.sourceComputerApiKey, sized.migrationId, {
    code: "MIGRATION_TRANSPORT_LOST",
    detailCode: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=2500000:maxEntries=2000000:topPathCounts=node_modules%2F,2400000",
  });
  assert.equal(lost.status, 200);
  assert.equal(await configRevision(sized.agentId), before + 1, "the revision moves with the failure");
  assert.deepEqual(pushed, [sized.agentId]);

  const other = await seedMigrationApiFixture();
  const otherBefore = await configRevision(other.agentId);
  assert.equal((await postMigrationTransportLost(app.baseUrl, other.sourceComputerApiKey, other.migrationId, {
    message: "MIGRATION_TEST_CLEAR_STUCK",
  })).status, 200);
  assert.equal(await configRevision(other.agentId), otherBefore);
  assert.deepEqual(pushed, [sized.agentId], "a non-size failure does not change migrationReadiness");
});

test("a source's size failure names the ignore file its advertised capabilities read; a target's report or an older source keeps .raftmigrateignore", async ({ app }) => {
  const capabilitiesByMachine = new Map<string, string[]>();
  const asked: string[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    getMachineMigrationTransport: async (machineId: string) => {
      asked.push(machineId);
      const capabilities = capabilitiesByMachine.get(machineId);
      return capabilities ? { capabilities } : null;
    },
  });
  const sizeFailure = {
    code: "MIGRATION_TRANSPORT_LOST",
    detailCode: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=2500000:maxEntries=2000000:topPathCounts=node_modules%2F,2400000",
  };
  const receiptText = async (migrationId: string) => {
    const [row] = await getDb().select({ receiptChannelId: agentMigrations.receiptChannelId })
      .from(agentMigrations).where(eq(agentMigrations.id, migrationId));
    const rows = await getDb().select({ content: messages.content }).from(messages)
      .where(eq(messages.channelId, row!.receiptChannelId!));
    const failed = rows.map((entry) => entry.content).filter((content) => content.startsWith("Migration failed."));
    assert.equal(failed.length, 1);
    return failed[0]!;
  };

  const newer = await seedMigrationApiFixture();
  capabilitiesByMachine.set(newer.sourceMachineId, [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY]);
  assert.equal((await postMigrationTransportLost(app.baseUrl, newer.sourceComputerApiKey, newer.migrationId, sizeFailure)).status, 200);
  assert.deepEqual(asked, [newer.sourceMachineId], "the reporting Computer's own capabilities are read");
  const newerText = await receiptText(newer.migrationId);
  assert.match(newerText, /list it in \.raftbackupignore \(listed paths are not moved; a `\*\*\/<name>` line skips every folder with that name\), then ask for the migration to be retried\./);
  assert.doesNotMatch(newerText, /raftmigrateignore/);

  const older = await seedMigrationApiFixture();
  capabilitiesByMachine.set(older.sourceMachineId, [AGENT_MIGRATION_CAPABILITY]);
  assert.equal((await postMigrationTransportLost(app.baseUrl, older.sourceComputerApiKey, older.migrationId, sizeFailure)).status, 200);
  assert.match(await receiptText(older.migrationId), /list it in \.raftmigrateignore \(listed paths are not moved\), then ask/);

  // A target's capabilities say nothing about the source.
  const byTarget = await seedMigrationApiFixture();
  capabilitiesByMachine.set(byTarget.targetMachineId, [AGENT_MIGRATION_CAPABILITY, AGENT_MIGRATION_SOURCE_USER_IGNORE_CAPABILITY]);
  assert.equal((await postMigrationTransportLost(app.baseUrl, byTarget.targetComputerApiKey, byTarget.migrationId, sizeFailure)).status, 200);
  assert.match(await receiptText(byTarget.migrationId), /list it in \.raftmigrateignore/);
});

test("agent migration transport-lost API records a failed user-ignore write with its reason", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const lost = await postMigrationTransportLost(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    code: "MIGRATION_USER_IGNORE_WRITE_FAILED",
    detailCode: "MIGRATION_USER_IGNORE_WRITE_FAILED:symlink",
    message: ".raftbackupignore.user is a symlink",
  });
  assert.equal(lost.status, 200);
  assert.equal((lost.json.migration as { failureReason?: string }).failureReason, "MIGRATION_USER_IGNORE_WRITE_FAILED");
  const [migrationRow] = await getDb()
    .select({
      state: agentMigrations.state,
      failureReason: agentMigrations.failureReason,
      transportErrorCode: agentMigrations.transportErrorCode,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "failed");
  assert.equal(migrationRow.failureReason, "MIGRATION_USER_IGNORE_WRITE_FAILED");
  assert.equal(migrationRow.transportErrorCode, "MIGRATION_USER_IGNORE_WRITE_FAILED:symlink");
});

test("agent migration transport-lost API persists the typed manifest size reason", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const manifestMessage = "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE:manifestBytes=73400320:maxBytes=67108864:entryCount=97079:topPaths=.git%2F,34214;src%2F,12877";

  const lost = await postMigrationTransportLost(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    code: "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
    message: manifestMessage,
  });
  assert.equal(lost.status, 200);
  assert.equal(lost.json.ok, true);
  assert.equal((lost.json.migration as { state?: string }).state, "failed");
  assert.equal(
    (lost.json.migration as { failureReason?: string }).failureReason,
    "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
  );
  assert.equal(
    (lost.json.migration as { transportErrorCode?: string }).transportErrorCode,
    "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE",
  );

  const [migrationRow] = await getDb()
    .select({
      state: agentMigrations.state,
      failureReason: agentMigrations.failureReason,
      transportErrorCode: agentMigrations.transportErrorCode,
      transportErrorMessage: agentMigrations.transportErrorMessage,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "failed");
  assert.equal(migrationRow.failureReason, "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE");
  assert.equal(migrationRow.transportErrorCode, "MIGRATION_OBJECT_STORE_MANIFEST_TOO_LARGE");
  assert.equal(migrationRow.transportErrorMessage, manifestMessage);
});

test("agent migration transport-lost API persists the typed target disk reason", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const diskMessage = "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK:requiredBytes=7516192768:availableBytes=4294967296:contentBytes=3489660928";

  const lost = await postMigrationTransportLost(app.baseUrl, f.targetComputerApiKey, f.migrationId, {
    code: "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK",
    message: diskMessage,
  });
  assert.equal(lost.status, 200);
  assert.equal(lost.json.ok, true);
  assert.equal((lost.json.migration as { state?: string }).state, "failed");
  assert.equal(
    (lost.json.migration as { failureReason?: string }).failureReason,
    "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK",
  );

  const [migrationRow] = await getDb()
    .select({
      transportErrorCode: agentMigrations.transportErrorCode,
      transportErrorMessage: agentMigrations.transportErrorMessage,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.transportErrorCode, "MIGRATION_OBJECT_STORE_INSUFFICIENT_DISK");
  assert.equal(migrationRow.transportErrorMessage, diskMessage);
});

test("agent migration transport-lost preserves the specific workspace conflict over the generic fallback", async ({ app }) => {
  const f = await seedMigrationApiFixture({ provisioning: true });
  const lost = await postMigrationTransportLost(app.baseUrl, f.targetComputerApiKey, f.migrationId, {
    code: "MIGRATION_WORKSPACE_ALREADY_EXISTS",
    message: "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  });
  assert.equal(lost.status, 200);
  assert.equal((lost.json.migration as { failureReason?: string }).failureReason, "MIGRATION_WORKSPACE_ALREADY_EXISTS");
  assert.equal(
    (lost.json.migration as { transportErrorCode?: string }).transportErrorCode,
    "MIGRATION_WORKSPACE_ALREADY_EXISTS",
  );
  const [migrationRow] = await getDb()
    .select({
      failureReason: agentMigrations.failureReason,
      transportErrorCode: agentMigrations.transportErrorCode,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.failureReason, "MIGRATION_WORKSPACE_ALREADY_EXISTS");
  assert.equal(migrationRow.transportErrorCode, "MIGRATION_WORKSPACE_ALREADY_EXISTS");
});

test("agent migration transport-lost preserves the classified workspace entry-count failure", async ({ app }) => {
  const f = await seedMigrationApiFixture({ provisioning: true });
  const diagnosticMessage = "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED:entryCount=250001:maxEntries=250000:topPathCounts=src%2F,200000;.git%2F,50001";
  const lost = await postMigrationTransportLost(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    role: "source",
    transferKind: "upload",
    code: "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
    message: diagnosticMessage,
  });
  assert.equal(lost.status, 200);
  assert.equal(
    (lost.json.migration as { failureReason?: string }).failureReason,
    "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED",
  );
  const [migrationRow] = await getDb()
    .select({
      failureReason: agentMigrations.failureReason,
      transportErrorCode: agentMigrations.transportErrorCode,
      transportErrorMessage: agentMigrations.transportErrorMessage,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.failureReason, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED");
  assert.equal(migrationRow.transportErrorCode, "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED");
  assert.equal(migrationRow.transportErrorMessage, diagnosticMessage);
});

test("agent migration transport-lost API rejects same-server non-participant Computers", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const { machine: otherMachine } = await registerMachine(
    f.serverId,
    f.ownerId,
    "other-machine",
  );
  const otherComputer = await generateComputerApiKeyMaterial();
  await getDb().insert(computers).values({
    serverId: f.serverId,
    name: "other-computer",
    apiKeyHash: otherComputer.apiKeyHash,
    apiKeyPrefix: otherComputer.apiKeyPrefix,
    attachedByUserId: f.ownerId,
    machineId: otherMachine.id,
  });

  const lost = await postMigrationTransportLost(app.baseUrl, otherComputer.apiKey, f.migrationId, {
    message: "MIGRATION_OBJECT_STORE_DOWNLOAD_RETRY_EXHAUSTED:404",
  });
  assert.equal(lost.status, 404);
  assert.equal(lost.json.code, "migration_missing");

  const [migrationRow] = await getDb()
    .select({ state: agentMigrations.state, failureReason: agentMigrations.failureReason })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "ready");
  assert.equal(migrationRow.failureReason, null);
});

test("agent migration target import API drives read/start/flip/arrive with generation readback", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  let autoStartAgentId: string | null = null;
  const archiveCalls: Array<{ machineId: string; migrationId: string; agentId: string }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async (agentId: string) => {
      const [migration] = await getDb().select({
        sourceWorkspaceArchivedAt: agentMigrations.sourceWorkspaceArchivedAt,
      }).from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
      assert.ok(migration.sourceWorkspaceArchivedAt, "target start must see the durable source archive receipt");
      autoStartAgentId = agentId;
      return { outcome: "dispatched" as const };
    },
    archiveAgentMigrationSourceWorkspace: async (
      machineId: string,
      input: { migrationId: string; agentId: string },
    ) => {
      const [migration] = await getDb().select({ state: agentMigrations.state })
        .from(agentMigrations)
        .where(eq(agentMigrations.id, input.migrationId));
      assert.equal(migration.state, "arriving", "source archive receipt must gate target start and durable completion");
      archiveCalls.push({ machineId, ...input });
      return "archived" as const;
    },
  });
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  assert.equal(ready.canDriveTargetImport, true);
  assert.equal(ready.state, "ready");
  assert.equal(ready.sourceMachineId, f.sourceMachineId);
  assert.equal(ready.targetMachineId, f.targetMachineId);
  assert.ok(ready.migrationGeneration);

  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const startedMigration = (started.json.migration as AgentMigrationTargetImportView);
  assert.equal(startedMigration.state, "in_transit");
  assert.notEqual(startedMigration.migrationGeneration, ready.migrationGeneration);

  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: startedMigration.migrationGeneration,
  });
  assert.equal(flipped.status, 200);
  const flippedMigration = (flipped.json.migration as AgentMigrationTargetImportView);
  assert.equal(flippedMigration.state, "arriving");
  assert.notEqual(flippedMigration.migrationGeneration, startedMigration.migrationGeneration);
  const [agentAfterFlip] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentAfterFlip.machineId, f.targetMachineId);

  const arrived = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
    migrationGeneration: flippedMigration.migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(arrived.status, 200);
  const arrivedMigration = (arrived.json.migration as AgentMigrationTargetImportView);
  assert.equal(arrivedMigration.state, "completed");
  assert.equal(autoStartAgentId, f.agentId);
  assert.deepEqual(archiveCalls, [{
    machineId: f.sourceMachineId,
    migrationId: f.migrationId,
    agentId: f.agentId,
  }]);
  assert.notEqual(arrivedMigration.migrationGeneration, flippedMigration.migrationGeneration);
  const [agentAfterArrival] = await getDb().select({ sessionId: agents.sessionId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentAfterArrival.sessionId, null, "target import arrival must not resume a source-native session");
});

test("arrival observation rechecks the idempotent source archive while target auto-start is in progress", async ({ app }) => {

  const startEntered = deferred<void>();
  const releaseStart = deferred<void>();
  let firstArrival: Promise<{ status: number; json: Record<string, unknown> }> | null = null;
  try {
    const f = await seedMigrationApiFixture();
    let archiveCalls = 0;
    let sourceWorkspaceBytes = "source-workspace-exact\n";
    const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
    app.app.set("agentOrchestrator", {
      ...orchestrator,
      startAgent: async () => {
        startEntered.resolve();
        await releaseStart.promise;
        throw new Error("target start remained unconfirmed");
      },
      archiveAgentMigrationSourceWorkspace: async () => {
        archiveCalls += 1;
        sourceWorkspaceBytes = "";
        return "archived" as const;
      },
    });

    const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
    const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
      migrationGeneration: ready.migrationGeneration,
    });
    const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
      migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    });
    const arrivalBody = {
      migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
      reportPath: "migrations/arrival-report.json",
      reportSha256: "sha256:arrival",
    };

    firstArrival = postMigrationStep(
      app.baseUrl,
      f.targetComputerApiKey,
      f.migrationId,
      "arrived",
      arrivalBody,
    );
    await startEntered.promise;

    const observed = await postMigrationStep(
      app.baseUrl,
      f.targetComputerApiKey,
      f.migrationId,
      "arrived",
      arrivalBody,
    );
    assert.equal(observed.status, 200);
    assert.equal((observed.json.migration as AgentMigrationTargetImportView).state, "starting");
    assert.equal(archiveCalls, 2, "each arrival observation must confirm the idempotent archive receipt");
    assert.equal(sourceWorkspaceBytes, "");

    releaseStart.resolve();
    const failedStart = await firstArrival;
    firstArrival = null;
    assert.equal(failedStart.status, 200);
    assert.equal((failedStart.json.migration as AgentMigrationTargetImportView).state, "starting");
    assert.equal(archiveCalls, 2);
    assert.equal(sourceWorkspaceBytes, "");
  } finally {
    releaseStart.resolve();
    await firstArrival?.catch(() => undefined);
    await app.close();
  }
});

test("agent migration target import API keeps arrival retryable when automatic start fails", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  let sourceWorkspaceBytes = "source-workspace-exact\n";
  let archiveCalls = 0;
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async () => {
      throw new Error("target daemon disconnected");
    },
    archiveAgentMigrationSourceWorkspace: async () => {
      archiveCalls += 1;
      sourceWorkspaceBytes = "";
      return "archived" as const;
    },
  });
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const arrived = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });

  assert.equal(arrived.status, 200);
  assert.equal((arrived.json.migration as AgentMigrationTargetImportView).state, "starting");
  const [migration] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migration.state, "starting");
  assert.equal(migration.failureReason, "auto_start_failed");
  assert.equal(migration.autoStartFailureStage, "start_agent");
  assert.equal(migration.autoStartFailureCode, "start_threw");
  assert.equal(migration.completedAt, null);
  assert.equal(archiveCalls, 1, "source archive must be confirmed before target auto-start");
  assert.equal(sourceWorkspaceBytes, "");
  const [agent] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agent.machineId, f.targetMachineId);

  let retryStartedAgentId: string | null = null;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async (agentId: string) => {
      retryStartedAgentId = agentId;
      return { outcome: "dispatched" as const };
    },
    archiveAgentMigrationSourceWorkspace: async () => {
      archiveCalls += 1;
      sourceWorkspaceBytes = "";
      return "archived" as const;
    },
  });
  const retried = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(retried.status, 200);
  assert.equal((retried.json.migration as AgentMigrationTargetImportView).state, "completed");
  assert.equal(retryStartedAgentId, f.agentId);
  assert.equal(archiveCalls, 2, "target auto-start retry must re-confirm the idempotent archive receipt");
  assert.equal(sourceWorkspaceBytes, "");
});

test("a failed source archive after the flip no longer fails the migration; the archive is retried in the background", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  let startCalls = 0;
  let archiveCalls = 0;
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  const fakeOrchestrator = {
    ...orchestrator,
    startAgent: async () => {
      startCalls += 1;
      return { outcome: "dispatched" as const };
    },
    archiveAgentMigrationSourceWorkspace: async () => {
      archiveCalls += 1;
      if (archiveCalls === 1) throw new AgentMigrationSourceArchiveError("NODE_EXDEV");
      return "archived" as const;
    },
  };
  app.app.set("agentOrchestrator", fakeOrchestrator);

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const arrivalBody = {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  };

  const first = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", arrivalBody);
  assert.equal(first.status, 200);
  assert.equal((first.json.migration as AgentMigrationTargetImportView).state, "completed");
  assert.equal(startCalls, 1, "the agent starts on the target without waiting for source cleanup");
  const [completed] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.equal(completed.sourceWorkspaceArchivedAt, null, "an unconfirmed archive is not forged as done");
  assert.equal(completed.sourceWorkspaceArchiveAttempts, 1);
  assert.equal(completed.sourceWorkspaceArchiveLastError, "NODE_EXDEV");
  assert.ok(completed.sourceWorkspaceArchiveRetryAt);

  // A replay with the pre-arrival generation must not trigger another archive request.
  const replayed = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", arrivalBody);
  assert.equal(replayed.status, 409);
  assert.equal(archiveCalls, 1);
  assert.equal(startCalls, 1);

  const result = await drainAgentMigrationRemediation({
    io: app.app.get("io") ?? ({ to: () => ({ emit: () => undefined }) } as never),
    orchestrator: fakeOrchestrator as never,
    workerId: "archive-retry",
    now: new Date(completed.sourceWorkspaceArchiveRetryAt!.getTime() + 1_000),
  });
  assert.equal(result.sourceArchive, true);
  const [archived] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.ok(archived.sourceWorkspaceArchivedAt, "background retry durably records the archive");
  assert.equal(archived.state, "completed");
  assert.equal(archiveCalls, 2);
});

test("agent migration target import API does not complete a reclaimed wake-lock-skipped start", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const firstStartEntered = deferred<void>();
  const releaseFirstStart = deferred<void>();
  let startCalls = 0;
  let archiveCalls = 0;
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async () => {
      startCalls += 1;
      if (startCalls === 1) {
        firstStartEntered.resolve();
        await releaseFirstStart.promise;
        throw new Error("original dispatch failed");
      }
      return { outcome: "skipped" as const, reason: "wake_lock_held" as const };
    },
    archiveAgentMigrationSourceWorkspace: async () => {
      archiveCalls += 1;
      return "archived" as const;
    },
  });

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const arrivalBody = {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  };

  const originalArrival = postMigrationStep(
    app.baseUrl,
    f.targetComputerApiKey,
    f.migrationId,
    "arrived",
    arrivalBody,
  );
  await firstStartEntered.promise;
  await getDb().update(agentMigrations)
    .set({ updatedAt: new Date("2000-01-01T00:00:00.000Z") })
    .where(eq(agentMigrations.id, f.migrationId));

  const reclaimed = await postMigrationStep(
    app.baseUrl,
    f.targetComputerApiKey,
    f.migrationId,
    "arrived",
    arrivalBody,
  );
  assert.equal(reclaimed.status, 200);
  assert.equal((reclaimed.json.migration as AgentMigrationTargetImportView).state, "starting");

  releaseFirstStart.resolve();
  const original = await originalArrival;
  assert.equal(original.status, 200);
  assert.equal((original.json.migration as AgentMigrationTargetImportView).state, "starting");
  assert.equal(startCalls, 2);

  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.equal(persisted.state, "starting");
  assert.equal(persisted.failureReason, "auto_start_failed");
  assert.equal(persisted.autoStartFailureStage, "start_agent");
  assert.equal(persisted.autoStartFailureCode, "start_threw");
  assert.equal(persisted.completedAt, null);
  assert.equal(archiveCalls, 2, "both dispatch attempts must confirm the idempotent archive receipt");
});

test("agent migration target import API rejects old generations without mutating holder", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);

  const staleFlip = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(staleFlip.status, 409);
  assert.equal(staleFlip.json.code, "migration_generation_stale");

  const current = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  assert.equal(current.state, "in_transit");
  const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentRow.machineId, f.sourceMachineId);
});

test("agent migration target import API treats repeated flip callbacks as idempotent success", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const startedMigration = started.json.migration as AgentMigrationTargetImportView;

  const [firstFlip, replayedFlip] = await Promise.all([
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
      migrationGeneration: startedMigration.migrationGeneration,
    }),
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
      migrationGeneration: startedMigration.migrationGeneration,
    }),
  ]);
  assert.equal(firstFlip.status, 200);
  assert.equal(replayedFlip.status, 200);
  assert.equal((firstFlip.json.migration as AgentMigrationTargetImportView).state, "arriving");
  assert.equal((replayedFlip.json.migration as AgentMigrationTargetImportView).state, "arriving");

  const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentRow.machineId, f.targetMachineId);
  const [migrationRow] = await getDb().select({ state: agentMigrations.state, failureReason: agentMigrations.failureReason })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "arriving");
  assert.equal(migrationRow.failureReason, null);
});

test("the flip revokes the source Computer's runner credentials, not the target's or a person's", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const mint = (name: string, issuedByMachineId: string) =>
    mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name, issuedVia: "computer", issuedByMachineId, createdByUserId: null });
  const source = await mint("runner:source", f.sourceMachineId);
  // The mint route refuses the target until the flip; a target-issued row (as an
  // earlier holder of the agent could have left) must still survive the flip.
  const target = await mint("runner:target", f.targetMachineId);
  const human = await mintAgentCredential({ agentId: f.agentId, scopes: ["read"], name: "human", issuedVia: "human", createdByUserId: f.ownerId });

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  assert.equal(flipped.status, 200);

  const reasonOf = async (credentialId: string) => {
    const [row] = await getDb().select({ revokedAt: agentCredentials.revokedAt, revokedReason: agentCredentials.revokedReason })
      .from(agentCredentials).where(eq(agentCredentials.id, credentialId));
    return row?.revokedAt ? row.revokedReason : null;
  };
  assert.equal(await reasonOf(source.credentialId), RUNNER_MACHINE_CHANGED_REVOKE_REASON);
  assert.equal(await reasonOf(target.credentialId), null, "the target's runner key stays");
  assert.equal(await reasonOf(human.credentialId), null, "a person's key stays");
  const probe = await fetch(`${app.baseUrl}/internal/agent-api`, { headers: authHeaders(target.apiKey) });
  assert.equal(probe.status, 200, await probe.text());
});

test("agent migration target import API treats repeated arrive callbacks as idempotent success", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  let archiveCalls = 0;
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async () => ({ outcome: "dispatched" as const }),
    archiveAgentMigrationSourceWorkspace: async () => {
      archiveCalls += 1;
      return archiveCalls === 1 ? "archived" as const : "already_archived" as const;
    },
  });
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  assert.equal(flipped.status, 200);
  const flippedMigration = flipped.json.migration as AgentMigrationTargetImportView;

  const [firstArrive, replayedArrive] = await Promise.all([
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
      migrationGeneration: flippedMigration.migrationGeneration,
      reportPath: "migrations/arrival-report.json",
      reportSha256: "sha256:arrival",
    }),
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
      migrationGeneration: flippedMigration.migrationGeneration,
      reportPath: "migrations/arrival-report.json",
      reportSha256: "sha256:arrival",
    }),
  ]);
  assert.equal(firstArrive.status, 200);
  assert.equal(replayedArrive.status, 200);
  assert.equal((firstArrive.json.migration as AgentMigrationTargetImportView).state, "completed");
  assert.equal((replayedArrive.json.migration as AgentMigrationTargetImportView).state, "completed");
  assert.ok(archiveCalls >= 1);
});

test("target Computer explicitly reconciles a legacy completed row with the authoritative source archive", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const archiveInputs: Array<{ machineId: string; migrationId: string; agentId: string }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async () => ({ outcome: "dispatched" as const }),
    archiveAgentMigrationSourceWorkspace: async (
      machineId: string,
      input: { migrationId: string; agentId: string },
    ) => {
      archiveInputs.push({ machineId, ...input });
      return archiveInputs.length === 1 ? "archived" as const : "already_archived" as const;
    },
  });

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const completed = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(completed.status, 200);
  assert.equal((completed.json.migration as AgentMigrationTargetImportView).state, "completed");

  await getDb().update(agentMigrations)
    .set({ sourceWorkspaceArchivedAt: null })
    .where(eq(agentMigrations.id, f.migrationId));
  const staleReconciliation = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(staleReconciliation.status, 409);
  assert.equal(staleReconciliation.json.code, "migration_generation_stale");
  assert.equal(archiveInputs.length, 1, "stale recovery authority must fail before another source archive request");
  const legacy = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  assert.equal(legacy.state, "completed");
  const reconciled = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "arrived", {
    migrationGeneration: legacy.migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(reconciled.status, 200);
  assert.equal((reconciled.json.migration as AgentMigrationTargetImportView).state, "completed");
  assert.deepEqual(archiveInputs[1], {
    machineId: f.sourceMachineId,
    migrationId: f.migrationId,
    agentId: f.agentId,
  });
  const [persisted] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.ok(persisted.sourceWorkspaceArchivedAt, "reconciliation must persist the authoritative archive confirmation");
});

test("agent migration target import API rejects flip when holder moved to another machine", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const { machine: otherMachine } = await registerMachine(
    f.serverId,
    f.ownerId,
    "other-machine",
  );
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  await getDb().update(agents).set({ machineId: otherMachine.id }).where(eq(agents.id, f.agentId));

  const mismatchedFlip = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.migrationId, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  assert.equal(mismatchedFlip.status, 409);
  assert.equal(mismatchedFlip.json.code, "migration_source_machine_mismatch");

  const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentRow.machineId, otherMachine.id);
  const [migrationRow] = await getDb().select({ state: agentMigrations.state }).from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "in_transit");
});

test("agent migration target import API rejects source-machine Computer drive attempts", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const res = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(f.migrationId)}`, {
    method: "GET",
    headers: authHeaders(f.sourceComputerApiKey),
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { code?: string }).code, "migration_missing");

  const targetReadback = await readMigration(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  assert.equal(targetReadback.state, "ready");
  const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentRow.machineId, f.sourceMachineId);
});

test("cancel acknowledgement API enforces Computer role plus transport and cancel generations", async ({ app }) => {
  const f = await seedMigrationApiFixture({ provisioning: true });
  const [migration] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  const requested = await requestAgentMigrationCancellation({
    agentId: f.agentId,
    migrationRef: f.migrationRef,
    expectedRevision: migration.revision,
    initiatedByUserId: f.ownerId,
    reason: "owner_cancel",
  });
  const cancelGeneration = requested.migration.cancelGeneration!;
  const transportGeneration = requested.migration.cancelTransportGeneration!;

  const stale = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${f.migrationId}/cancel-ack`, {
    method: "POST",
    headers: authHeaders(f.sourceComputerApiKey),
    body: JSON.stringify({
      migrationRef: f.migrationRef,
      transportGeneration: "stale-generation",
      cancelGeneration,
      role: "source",
      outcome: "cleaned",
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { code?: string }).code, "migration_generation_stale");

  const sourceAck = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${f.migrationId}/cancel-ack`, {
    method: "POST",
    headers: authHeaders(f.sourceComputerApiKey),
    body: JSON.stringify({
      migrationRef: f.migrationRef,
      transportGeneration,
      cancelGeneration,
      role: "source",
      outcome: "cleaned",
    }),
  });
  assert.equal(sourceAck.status, 200, await sourceAck.clone().text());
  assert.equal((await sourceAck.json() as { migration?: { state?: string } }).migration?.state, "canceled_pre_flip");

  const targetAck = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${f.migrationId}/cancel-ack`, {
    method: "POST",
    headers: authHeaders(f.targetComputerApiKey),
    body: JSON.stringify({
      migrationRef: f.migrationRef,
      transportGeneration,
      cancelGeneration,
      role: "target",
      outcome: "cleaned",
    }),
  });
  assert.equal(targetAck.status, 200, await targetAck.clone().text());
  assert.equal((await targetAck.json() as { migration?: { state?: string } }).migration?.state, "canceled_pre_flip");
});

test("post-flip target cancel acknowledgement rejects cleaned without terminalizing", async ({ app }) => {
  const f = await seedMigrationApiFixture({ provisioning: true });
  const flippedAt = new Date("2026-08-03T09:00:01.000Z");
  const [flipped] = await getDb().update(agentMigrations)
    .set({ state: "arriving", flippedAt, revision: f.expectedMigrationRevision! + 1, updatedAt: flippedAt })
    .where(eq(agentMigrations.id, f.migrationId))
    .returning();
  await getDb().update(agents)
    .set({ machineId: f.targetMachineId, updatedAt: flippedAt })
    .where(eq(agents.id, f.agentId));
  const requested = await requestAgentMigrationCancellation({
    agentId: f.agentId,
    migrationRef: f.migrationRef,
    expectedRevision: flipped.revision,
    initiatedByUserId: f.ownerId,
    reason: "owner_cancel_after_flip",
    now: new Date("2026-08-03T09:00:02.000Z"),
  });
  assert.equal(requested.migration.state, "canceled_post_flip");
  assert.equal(requested.migration.cancelDisposition, "post_flip_target_authoritative");

  const rejected = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${f.migrationId}/cancel-ack`, {
    method: "POST",
    headers: authHeaders(f.targetComputerApiKey),
    body: JSON.stringify({
      migrationRef: f.migrationRef,
      transportGeneration: requested.migration.cancelTransportGeneration,
      cancelGeneration: requested.migration.cancelGeneration,
      role: "target",
      outcome: "cleaned",
    }),
  });
  assert.equal(rejected.status, 409, await rejected.clone().text());
  assert.equal((await rejected.json() as { code?: string }).code, "migration_cancel_outcome_mismatch");

  const [afterRejectedTargetAck] = await getDb().select()
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(afterRejectedTargetAck.state, "canceled_post_flip");
  assert.equal(afterRejectedTargetAck.cancelTargetAckAt, null);
  assert.equal(afterRejectedTargetAck.cancelTargetOutcome, null);
  assert.ok(afterRejectedTargetAck.canceledAt);
  assert.ok(afterRejectedTargetAck.transportTeardownAt);
  assert.equal(afterRejectedTargetAck.revision, requested.migration.revision);
});
