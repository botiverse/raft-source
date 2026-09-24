import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  AGENT_MIGRATION_BUNDLE_CONTENT_TYPE,
  AGENT_MIGRATION_COMMIT_MARKER_PATH,
  AGENT_MIGRATION_CONTROL_SCHEMA_VERSION,
  AGENT_MIGRATION_RESUMABLE_CAPABILITIES,
  AGENT_MIGRATION_RESUMABLE_PROTOCOL,
  MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  type AgentMigrationControlManifest,
} from "@botiverse/raft-shared";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  agentMigrationReceiptOutbox,
  agentMigrations,
  agents,
  computers,
  users,
} from "../db/schema.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { registerMachine } from "../services/machineService.js";
import { generateComputerApiKeyMaterial } from "../services/computerCredentialService.js";
import {
  beginAgentMigration,
  beginAgentMigrationProvisioning,
  markAgentMigrationReady,
  requestAgentMigrationCancellation,
  type AgentMigrationTargetImportView,
} from "../services/agentMigrationService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

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

async function seedMigrationApiFixture(options: { markReady?: boolean; provisioning?: boolean } = {}): Promise<{
  targetComputerApiKey: string;
  sourceComputerApiKey: string;
  migrationId: string;
  migrationRef: string;
  grantKey: string;
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
  const provisioning = options.provisioning
    ? await beginAgentMigrationProvisioning({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
      now,
      prepDeadlineMs: 60 * 60 * 1000,
      transferDeadlineMs: 60 * 60 * 1000,
      arrivalDeadlineMs: 60 * 60 * 1000,
      sourceTransferUrl: "https://object-store.example/upload/source",
      targetTransferUrl: "https://object-store.example/download/target",
      transportSessionId: `session-${suffix}`,
    })
    : null;
  const migration = provisioning?.migration ?? await beginAgentMigration({
      agentId: agent.id,
      targetMachineId: targetMachine.id,
      initiatedByUserId: owner.id,
      now,
      prepDeadlineMs: 60 * 60 * 1000,
      transferDeadlineMs: 60 * 60 * 1000,
      arrivalDeadlineMs: 60 * 60 * 1000,
    });
  if (!options.provisioning && options.markReady !== false) {
    const ready = await markAgentMigrationReady({
      grantKey: migration.grantKey,
      manifestPath: "bundle/manifest.json",
      manifestSha256: "sha256:manifest",
      now,
    });
    await db.update(agentMigrations)
      .set({ transferSummary: TEST_TRANSFER_SUMMARY })
      .where(eq(agentMigrations.id, ready.id));
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
    grantKey: migration.grantKey,
    agentId: agent.id,
    serverId: server.id,
    ownerId: owner.id,
    sourceMachineId: sourceMachine.id,
    targetMachineId: targetMachine.id,
    ...(provisioning ? {
      sourceMigrationToken: provisioning.source.message.bearerToken,
      targetMigrationToken: provisioning.target.message.bearerToken,
      transportGeneration: provisioning.source.message.transportGeneration,
      transportLeaseId: provisioning.source.message.leaseId,
      expectedMigrationRevision: provisioning.source.message.expectedMigrationRevision,
    } : {}),
  };
}

async function readMigration(baseUrl: string, apiKey: string, grantKey: string): Promise<AgentMigrationTargetImportView> {
  const res = await fetch(`${baseUrl}/internal/computer/agent-migrations/${encodeURIComponent(grantKey)}`, {
    method: "GET",
    headers: authHeaders(apiKey),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: true; migration: AgentMigrationTargetImportView };
  assert.equal(body.ok, true);
  return body.migration;
}

async function readMigrationById(baseUrl: string, apiKey: string, migrationId: string): Promise<AgentMigrationTargetImportView> {
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
  grantKey: string,
  step: "start-transfer" | "flip-machine" | "arrived",
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/internal/computer/agent-migrations/${encodeURIComponent(grantKey)}/${step}`, {
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

async function postMigrationSourceReady(
  baseUrl: string,
  apiKey: string,
  migrationId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(migrationId)}/source-ready`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: JSON.stringify({ transferSummary: TEST_TRANSFER_SUMMARY, ...body }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

test("agent migration target import API resolves target handoff by migration id", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const byGrant = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const byId = await readMigrationById(app.baseUrl, f.targetComputerApiKey, f.migrationId);

  assert.equal(byId.grantKey, byGrant.grantKey);
  assert.equal(byId.migrationGeneration, byGrant.migrationGeneration);
  assert.equal(byId.state, "ready");
  assert.equal(byId.canDriveTargetImport, true);

  const sourceAttempt = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/by-id/${encodeURIComponent(f.migrationId)}`, {
    method: "GET",
    headers: authHeaders(f.sourceComputerApiKey),
  });
  assert.equal(sourceAttempt.status, 404);
  assert.equal((await sourceAttempt.json() as { code?: string }).code, "migration_missing");
});

test("agent migration source-ready API lets the source Computer mark object-store upload ready", async ({ app }) => {
  const f = await seedMigrationApiFixture({ markReady: false });
  const maxBoundarySummary = {
    ...TEST_TRANSFER_SUMMARY,
    includedBytes: MAX_AGENT_MIGRATION_TRANSPORT_BYTES,
  };

  const ready = await postMigrationSourceReady(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    manifestPath: "object-store:session-source/manifest.json",
    manifestSha256: "sha256:manifest",
    transferSummary: maxBoundarySummary,
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ok, true);
  assert.equal((ready.json.migration as { state?: string }).state, "ready");

  const targetReadback = await readMigrationById(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  assert.equal(targetReadback.state, "ready");
  assert.equal(targetReadback.manifestPath, "object-store:session-source/manifest.json");
  assert.equal(targetReadback.manifestSha256, "sha256:manifest");
  const [persisted] = await getDb().select({
    transferSummary: agentMigrations.transferSummary,
  }).from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.deepEqual(persisted.transferSummary, maxBoundarySummary);

  const replay = await postMigrationSourceReady(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    manifestPath: "object-store:session-source/manifest.json",
    manifestSha256: "sha256:manifest",
    transferSummary: maxBoundarySummary,
  });
  assert.equal(replay.status, 200);
  assert.equal((replay.json.migration as { state?: string }).state, "ready");
});

test("agent migration source-ready API rejects non-pathless or unbounded summaries", async ({ app }) => {
  const f = await seedMigrationApiFixture({ markReady: false });
  for (const transferSummary of [
    { ...TEST_TRANSFER_SUMMARY, sourcePath: "/private/workspace" },
    { ...TEST_TRANSFER_SUMMARY, includedBytes: MAX_AGENT_MIGRATION_TRANSPORT_BYTES + 1 },
    { ...TEST_TRANSFER_SUMMARY, excludedRegenerableCount: 1 },
  ]) {
    const response = await postMigrationSourceReady(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
      manifestPath: "object-store:session-source/manifest.json",
      transferSummary,
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.code, "migration_transfer_summary_invalid");
  }
  const [migration] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migration.state, "prep");
  assert.equal(migration.transferSummary, null);
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
    capability: { required: [...AGENT_MIGRATION_RESUMABLE_CAPABILITIES] },
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

test("agent migration source-ready API promotes provisioning object-store migration to ready", async ({ app }) => {
  const f = await seedMigrationApiFixture({ markReady: false, provisioning: true });

  const ready = await postMigrationSourceReady(app.baseUrl, f.sourceComputerApiKey, f.migrationId, {
    manifestPath: "object-store:session-source/manifest.json",
    manifestSha256: "sha256:manifest",
  });
  assert.equal(ready.status, 200);
  assert.equal(ready.json.ok, true);
  assert.equal((ready.json.migration as { state?: string }).state, "ready");

  const targetReadback = await readMigrationById(app.baseUrl, f.targetComputerApiKey, f.migrationId);
  assert.equal(targetReadback.state, "ready");
  assert.equal(targetReadback.manifestPath, "object-store:session-source/manifest.json");
  assert.equal(targetReadback.manifestSha256, "sha256:manifest");

  const [migrationRow] = await getDb()
    .select({
      state: agentMigrations.state,
      transportProvisionedAt: agentMigrations.transportProvisionedAt,
      transportErrorCode: agentMigrations.transportErrorCode,
    })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "ready");
  assert.ok(migrationRow.transportProvisionedAt);
  assert.equal(migrationRow.transportErrorCode, null);
});

test("agent migration source-ready API rejects non-source Computers", async ({ app }) => {
  const f = await seedMigrationApiFixture({ markReady: false });

  const targetAttempt = await postMigrationSourceReady(app.baseUrl, f.targetComputerApiKey, f.migrationId, {
    manifestPath: "object-store:session-source/manifest.json",
    manifestSha256: "sha256:manifest",
  });
  assert.equal(targetAttempt.status, 404);
  assert.equal(targetAttempt.json.code, "migration_missing");

  const [migrationRow] = await getDb()
    .select({ state: agentMigrations.state, manifestPath: agentMigrations.manifestPath })
    .from(agentMigrations)
    .where(eq(agentMigrations.id, f.migrationId));
  assert.equal(migrationRow.state, "prep");
  assert.equal(migrationRow.manifestPath, null);
});

test("agent migration transport-lost API clears provisioning and prep participant migrations", async ({ app }) => {
  const provisioning = await seedMigrationApiFixture({ markReady: false, provisioning: true });
  const prep = await seedMigrationApiFixture({ markReady: false });

  for (const f of [provisioning, prep]) {
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
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  assert.equal(ready.canDriveTargetImport, true);
  assert.equal(ready.state, "ready");
  assert.equal(ready.sourceMachineId, f.sourceMachineId);
  assert.equal(ready.targetMachineId, f.targetMachineId);
  assert.ok(ready.migrationGeneration);

  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const startedMigration = (started.json.migration as AgentMigrationTargetImportView);
  assert.equal(startedMigration.state, "in_transit");
  assert.notEqual(startedMigration.migrationGeneration, ready.migrationGeneration);

  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: startedMigration.migrationGeneration,
  });
  assert.equal(flipped.status, 200);
  const flippedMigration = (flipped.json.migration as AgentMigrationTargetImportView);
  assert.equal(flippedMigration.state, "arriving");
  assert.notEqual(flippedMigration.migrationGeneration, startedMigration.migrationGeneration);
  const [agentAfterFlip] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentAfterFlip.machineId, f.targetMachineId);

  const arrived = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
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

    const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
    const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
      migrationGeneration: ready.migrationGeneration,
    });
    const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
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
      f.grantKey,
      "arrived",
      arrivalBody,
    );
    await startEntered.promise;

    const observed = await postMigrationStep(
      app.baseUrl,
      f.targetComputerApiKey,
      f.grantKey,
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
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const arrived = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
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
  const retried = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
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

test("arrival stays pending when the source archive response is lost or late and retries idempotently", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  let startCalls = 0;
  let archiveCalls = 0;
  let sourceWorkspaceBytes = "source-workspace-exact\n";
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  app.app.set("agentOrchestrator", {
    ...orchestrator,
    startAgent: async () => {
      startCalls += 1;
      return { outcome: "dispatched" as const };
    },
    archiveAgentMigrationSourceWorkspace: async () => {
      archiveCalls += 1;
      sourceWorkspaceBytes = "";
      if (archiveCalls === 1) throw new Error("source archive response lost after atomic rename");
      return "already_archived" as const;
    },
  });

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const arrivalBody = {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  };

  const first = await postMigrationStep(
    app.baseUrl,
    f.targetComputerApiKey,
    f.grantKey,
    "arrived",
    arrivalBody,
  );
  assert.equal(first.status, 503);
  assert.equal(first.json.code, "migration_source_workspace_archive_failed");
  assert.equal(startCalls, 0, "target start must wait for a confirmed source archive receipt");
  assert.equal(archiveCalls, 1);
  assert.equal(sourceWorkspaceBytes, "", "lost response may arrive after the source was already atomically archived");
  const [pending] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.equal(pending.state, "arriving", "unconfirmed archive must remain retryable and non-terminal");
  assert.equal(pending.sourceWorkspaceArchivedAt, null, "a lost archive response must not forge a durable receipt");
  assert.equal(pending.completedAt, null);
  const completedReceipts = await getDb()
    .select({ id: agentMigrationReceiptOutbox.id })
    .from(agentMigrationReceiptOutbox)
    .where(eq(agentMigrationReceiptOutbox.migrationId, f.migrationId));
  assert.equal(completedReceipts.length, 0, "unconfirmed archive must not enqueue completion receipt");

  const retried = await postMigrationStep(
    app.baseUrl,
    f.targetComputerApiKey,
    f.grantKey,
    "arrived",
    arrivalBody,
  );
  assert.equal(retried.status, 200);
  assert.equal((retried.json.migration as AgentMigrationTargetImportView).state, "completed");
  assert.equal(startCalls, 1, "confirmed archive retry must start target exactly once");
  assert.equal(archiveCalls, 2);
  assert.equal(sourceWorkspaceBytes, "");
  const [completed] = await getDb().select().from(agentMigrations).where(eq(agentMigrations.id, f.migrationId));
  assert.ok(completed.sourceWorkspaceArchivedAt, "already_archived must durably close the archive gate");
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

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
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
    f.grantKey,
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
    f.grantKey,
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
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);

  const staleFlip = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(staleFlip.status, 409);
  assert.equal(staleFlip.json.code, "migration_generation_stale");

  const current = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  assert.equal(current.state, "in_transit");
  const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentRow.machineId, f.sourceMachineId);
});

test("agent migration target import API treats repeated flip callbacks as idempotent success", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const startedMigration = started.json.migration as AgentMigrationTargetImportView;

  const [firstFlip, replayedFlip] = await Promise.all([
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
      migrationGeneration: startedMigration.migrationGeneration,
    }),
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
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
    .where(eq(agentMigrations.grantKey, f.grantKey));
  assert.equal(migrationRow.state, "arriving");
  assert.equal(migrationRow.failureReason, null);
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
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  assert.equal(flipped.status, 200);
  const flippedMigration = flipped.json.migration as AgentMigrationTargetImportView;

  const [firstArrive, replayedArrive] = await Promise.all([
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
      migrationGeneration: flippedMigration.migrationGeneration,
      reportPath: "migrations/arrival-report.json",
      reportSha256: "sha256:arrival",
    }),
    postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
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

  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  const flipped = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  const completed = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(completed.status, 200);
  assert.equal((completed.json.migration as AgentMigrationTargetImportView).state, "completed");

  await getDb().update(agentMigrations)
    .set({ sourceWorkspaceArchivedAt: null })
    .where(eq(agentMigrations.id, f.migrationId));
  const staleReconciliation = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
    migrationGeneration: (flipped.json.migration as AgentMigrationTargetImportView).migrationGeneration,
    reportPath: "migrations/arrival-report.json",
    reportSha256: "sha256:arrival",
  });
  assert.equal(staleReconciliation.status, 409);
  assert.equal(staleReconciliation.json.code, "migration_generation_stale");
  assert.equal(archiveInputs.length, 1, "stale recovery authority must fail before another source archive request");
  const legacy = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  assert.equal(legacy.state, "completed");
  const reconciled = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "arrived", {
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
  const ready = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
  const started = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "start-transfer", {
    migrationGeneration: ready.migrationGeneration,
  });
  assert.equal(started.status, 200);
  await getDb().update(agents).set({ machineId: otherMachine.id }).where(eq(agents.id, f.agentId));

  const mismatchedFlip = await postMigrationStep(app.baseUrl, f.targetComputerApiKey, f.grantKey, "flip-machine", {
    migrationGeneration: (started.json.migration as AgentMigrationTargetImportView).migrationGeneration,
  });
  assert.equal(mismatchedFlip.status, 409);
  assert.equal(mismatchedFlip.json.code, "migration_source_machine_mismatch");

  const [agentRow] = await getDb().select({ machineId: agents.machineId }).from(agents).where(eq(agents.id, f.agentId));
  assert.equal(agentRow.machineId, otherMachine.id);
  const [migrationRow] = await getDb().select({ state: agentMigrations.state }).from(agentMigrations).where(eq(agentMigrations.grantKey, f.grantKey));
  assert.equal(migrationRow.state, "in_transit");
});

test("agent migration target import API rejects source-machine Computer drive attempts", async ({ app }) => {
  const f = await seedMigrationApiFixture();
  const res = await fetch(`${app.baseUrl}/internal/computer/agent-migrations/${encodeURIComponent(f.grantKey)}`, {
    method: "GET",
    headers: authHeaders(f.sourceComputerApiKey),
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json() as { code?: string }).code, "migration_missing");

  const targetReadback = await readMigration(app.baseUrl, f.targetComputerApiKey, f.grantKey);
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
