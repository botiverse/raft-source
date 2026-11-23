import { loadSlackChannelDeletionEvidence } from "./slackChannelDeletionEvidence";
import { recordVerifiedSlackChannelDeletion } from "./slackBindingLifecycleService";
import { parseSlackReconciliationScan } from "./slackReconciliationScan";
import { listSlackOutboundQueueBindings } from "./slackBridgePairQueue";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { SLACK_BRIDGE_FEATURE_FLAG_KEYS } from "@botiverse/raft-shared";
import {
  attachmentObjects,
  attachments,
  externalAppCredentials,
  externalChannelBindings,
  slackChannelDeletions,
  externalDeliveryAttempts,
  externalDeliveryOperatorDecisions,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  externalMessageLinks,
  messages,
} from "../db/schema";
import { createSlackBridgeDatabaseOutboundRuntime, SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE } from "./slackBridgeDatabaseOutboundRuntime";
import {
  processExternalDeliveryPartitionHead,
  consumeExternalDeliverySkipDecision,
  cleanupDeletedSlackPairHead,
  recordSlackPairControlWait,
  clearResumedSlackPairControlWait,
  clearEmptySlackPairWaits,
  __setExternalDeliveryAttemptRowLockHookForTests,
} from "./externalDeliveryWorkerService";
import { enqueueSlackBridgeOutboundDelivery, mintSlackBridgeReconciliationMarker, type SlackBridgeRenderSnapshot } from "./externalDeliveryOutboxService";
import { createSlackBridgeProviderRuntime } from "./slackBridgeProviderRuntime";
import { createSlackBridgeEnvCredentialCipher } from "./slackBridgeEnvSecrets";
import { createFeatureFlagRule, deleteFeatureFlagRule } from "./featureFlagService";
import { resetStorageForTests, type StorageBackend } from "./storageService";
import { prepareSlackAttachmentFallbackPlan } from "./slackAttachmentFallbackPlan";
import { NOW, fixture, resolveCurrentOutboundAuthorityOrNull, pairControlFixture, waitForControlState } from "./slackBridgeDatabaseRuntimeAuthority.testkit";

afterEach(async () => {
  __setExternalDeliveryAttemptRowLockHookForTests(null);
  resetStorageForTests();
  await closeTestDatabase();
});

test("administrative pauses retain the first wait without claiming or changing attempts", async () => {
  const surface = await pairControlFixture();
  const before = await surface.db.select().from(externalOutboundDeliveries);
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled", now: NOW });
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "manager_paused" })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused", now: new Date(NOW.getTime() + 10_000) });
  const [waiting] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(waiting.authorityBlockedAt?.toISOString(), NOW.toISOString());
  assert.equal(waiting.authorityBlockedReason, "binding_paused");
  assert.equal(waiting.authorityRetryAt, null);
  assert.deepEqual(await surface.db.select().from(externalOutboundDeliveries), before);
  assert.equal((await surface.db.select().from(externalDeliveryAttempts)).length, 0);
  await surface.db.update(externalChannelBindings).set({ state: "active", stateReason: null })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, now: new Date(NOW.getTime() + 20_000) });
  const [resumed] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(resumed.authorityBlockedAt, null);
  assert.equal(resumed.authorityBlockedReason, null);
});

test("a maintenance pause cannot erase an earlier provider wait or its reconciliation cooldown", async () => {
  const surface = await pairControlFixture();
  const earlier = new Date(NOW.getTime() - 120_000);
  const retry = new Date(NOW.getTime() + 900_000);
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: earlier,
    authorityBlockedReason: "reconciliation_bridge_metadata_missing", authorityRetryAt: retry });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled", now: NOW });
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, now: NOW });
  const [row] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(row.authorityBlockedAt?.toISOString(), earlier.toISOString());
  assert.equal(row.authorityBlockedReason, "reconciliation_bridge_metadata_missing");
  assert.equal(row.authorityRetryAt?.toISOString(), retry.toISOString());
});

test("the master OFF to ON runtime records waiting with zero claims and automatically drains original work", async () => {
  const surface = await pairControlFixture(1);
  const cipher = createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) });
  const sealed = await cipher.sealer.seal({ serverId: surface.server.id, accessToken: "synthetic-bot-token", tokenType: "bot",
    providerAppId: surface.install.providerAppId, providerTeamId: surface.install.providerTeamId!, botUserId: surface.install.botUserId!, now: NOW });
  await surface.db.update(externalAppCredentials).set({ encryptedMaterial: sealed.encryptedMaterial,
    envelopeKeyId: sealed.envelopeKeyId, aadVersion: sealed.aadVersion }).where(eq(externalAppCredentials.installId, surface.install.id));
  await deleteFeatureFlagRule(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, surface.masterRule.id);
  let posts = 0;
  let claims = 0;
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: cipher, now: () => NOW,
    fetch: (async (input) => {
      assert.equal(new URL(String(input)).pathname.split("/").at(-1), "chat.postMessage"); posts += 1;
      return new Response(JSON.stringify({ ok: true, channel: surface.binding.providerConversationId, ts: "1793210000.000100" }),
        { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch });
  const errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
    runWorkerOnce: async (input) => { claims += 1; return processExternalDeliveryPartitionHead(input); } });
  runtime.start();
  try {
    await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]?.authorityBlockedReason === "master_disabled");
    const [off] = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(off.state, "queued"); assert.equal(off.leaseGeneration, 0); assert.equal(off.providerAttempts, 0);
    assert.equal(claims, 0); assert.equal(posts, 0);
    await createFeatureFlagRule({ flagKey: SLACK_BRIDGE_FEATURE_FLAG_KEYS.master, stage: "server", decision: "allow", values: [surface.server.id] });
    await waitForControlState(async () => (await surface.db.select().from(externalOutboundDeliveries))[0]?.state === "accepted");
    assert.equal(posts, 1);
    assert.deepEqual(errors, []);
    const [pair] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(pair.cursorPosition, 1); assert.equal(pair.authorityBlockedAt, null);
  } finally { await runtime.stop(); await provider.stop(); }
});

test("a deleted destination drains attempted unknown and following untouched work with no provider I/O", async () => {
  const surface = await pairControlFixture(3);
  assert.equal((await surface.head()).kind, "attempted");
  const checkpoint = parseSlackReconciliationScan({ schema: "slack-reconciliation-scan.v3", providerAttempt: 1, scopeKey: "f".repeat(64),
    oldest: "1.000000", latest: "2.000000", cursor: "preserved-checkpoint", match: null, metadataMissing: false, markerUnconfirmed: false, historyLimited: false });
  await surface.db.update(externalOutboundDeliveries).set({ reconciliationScan: checkpoint })
    .where(eq(externalOutboundDeliveries.id, surface.deliveries[0]!.id));
  const ledger = await surface.db.select().from(externalDeliveryAttempts);
  await surface.deleted();
  const provider = createSlackBridgeProviderRuntime({ db: surface.db, credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }),
    now: () => NOW, fetch: (async () => { throw new Error("deleted destination must never call Slack"); }) as typeof fetch });
  let ordinaryWorkerCalls = 0;
  const errors: unknown[] = [];
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 10, onError: (error) => errors.push(error),
    runWorkerOnce: async () => { ordinaryWorkerCalls += 1; throw new Error("deleted pair must use local cleanup"); } });
  runtime.start();
  try {
    await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]?.cursorPosition === 3);
  } finally { await runtime.stop(); await provider.stop(); }
  const rows = await surface.db.select().from(externalOutboundDeliveries).orderBy(externalOutboundDeliveries.partitionPosition);
  assert.deepEqual(rows.map((row) => row.stateReason), ["destination_deleted_outcome_unconfirmed", "destination_deleted", "destination_deleted"]);
  assert.ok(rows.every((row) => row.state === "skipped"));
  assert.deepEqual(rows.map((row) => row.providerAttempts), [1, 0, 0]);
  assert.deepEqual(rows[0]!.reconciliationScan, checkpoint);
  assert.deepEqual(await surface.db.select().from(externalDeliveryAttempts), ledger.map((attempt) => attempt.outcome === "provider_io_started"
    ? { ...attempt, outcome: "outcome_unknown", outcomeReason: "destination_deleted", terminalAt: NOW, updatedAt: NOW } : attempt));
  assert.deepEqual(rows.map((row) => row.renderSnapshot), surface.deliveries.map((row) => row.renderSnapshot));
  assert.equal(ordinaryWorkerCalls, 0); assert.equal(surface.providerCalls(), 1); assert.deepEqual(errors, []);
});

for (const receipt of ["accepted_delivery", "accepted_link"] as const) {
  test(`a deleted pair preserves the accepted local fact (${receipt})`, async () => {
    const surface = await pairControlFixture(1);
    surface.deps.dispatchProvider = async () => ({ kind: "accepted", providerMessageId: "original-accepted" });
    await surface.head();
    await surface.db.update(externalOutboundDeliveries).set({ stateReason: "original_acceptance_evidence" });
    await surface.db.update(externalDeliveryPartitions).set({ cursorPosition: 0, authorityBlockedAt: NOW,
      authorityBlockedReason: "slack_not_in_channel" });
    if (receipt === "accepted_delivery") await surface.db.delete(externalMessageLinks);
    else await surface.db.update(externalOutboundDeliveries).set({ state: "outcome_unknown", acceptedAt: null, providerMessageId: null });
    const scope = await surface.deleted();
    const result = await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: NOW });
    assert.equal(result.kind, "cursor_recovered");
    const [row] = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(row.state, "accepted"); assert.equal(row.providerMessageId, "original-accepted"); assert.equal(row.providerAttempts, 1);
    assert.equal(row.stateReason, "original_acceptance_evidence", "cleanup preserves the original receipt reason");
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.cursorPosition, 1); assert.equal(partition.authorityBlockedAt, null);
  });
}

for (const evidence of ["archived", "access_error", "different_target", "revoked"] as const) {
  test(`a destination cannot be discarded without its current deletion proof (${evidence})`, async () => {
    const surface = await pairControlFixture(1);
    await surface.db.update(externalChannelBindings).set({ state: evidence === "revoked" ? "revoked" : "paused",
      stateReason: evidence === "archived" ? "provider_channel_archived" : evidence === "access_error" ? "slack_channel_not_found" : "provider_channel_deleted",
      ...(evidence === "different_target" ? { providerConversationId: "C_DIFFERENT_DESTINATION" } : {}),
    }).where(eq(externalChannelBindings.id, surface.binding.id));
    const result = await cleanupDeletedSlackPairHead({ db: surface.db, ...surface.scope, now: NOW });
    assert.equal(result.kind, "blocked");
    const [row] = await surface.db.select().from(externalOutboundDeliveries);
    assert.equal(row.state, "queued"); assert.equal(row.providerAttempts, 0);
    assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 0);
  });
}

test("a deletion cleanup respects an in-flight lease and fences its expired pre-I/O claim", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalOutboundDeliveries).set({ state: "dispatching", leaseOwner: "old-worker", leaseGeneration: 1,
    leaseOriginState: "queued", leaseExpiresAt: new Date(NOW.getTime() + 60_000) });
  const scope = await surface.deleted();
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: NOW })).kind, "blocked");
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 0);
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: new Date(NOW.getTime() + 61_000) })).kind, "skipped");
  const [row] = await surface.db.select().from(externalOutboundDeliveries);
  assert.equal(row.leaseGeneration, 2); assert.equal(row.leaseOwner, null); assert.equal(row.providerAttempts, 0);
});

test("a late provider response cannot resurrect work consumed by proven deletion", async () => {
  const surface = await pairControlFixture(1);
  let clock = NOW;
  surface.deps.now = () => clock;
  let entered!: () => void;
  const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
  let complete!: () => void;
  const providerResponse = new Promise<void>((resolve) => { complete = resolve; });
  surface.deps.dispatchProvider = async () => {
    entered();
    await providerResponse;
    return { kind: "accepted", providerMessageId: "late-original-receipt" };
  };
  const inFlight = surface.head();
  let ledger: typeof externalDeliveryAttempts.$inferSelect[] = [];
  try {
    await providerEntered;
    ledger = await surface.db.select().from(externalDeliveryAttempts);
    const scope = await surface.deleted();
    assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: clock })).kind, "blocked");
    clock = new Date(NOW.getTime() + 61_000);
    assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: clock })).kind, "skipped");
  } finally {
    complete();
    await assert.rejects(inFlight, /outcome lost exact lease authority/);
  }
  const [row] = await surface.db.select().from(externalOutboundDeliveries);
  assert.equal(row.state, "skipped");
  assert.equal(row.stateReason, "destination_deleted_outcome_unconfirmed");
  assert.equal(row.providerAttempts, 1);
  assert.equal(row.providerMessageId, null, "the expired writer cannot overwrite the recorded unknown outcome");
  assert.deepEqual(await surface.db.select().from(externalDeliveryAttempts), ledger.map((attempt) => ({
    ...attempt, outcome: "outcome_unknown", outcomeReason: "destination_deleted", terminalAt: clock, updatedAt: clock,
  })));
  assert.equal((await surface.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition, 1);
});

test("an empty current queue drops obsolete wait fields without touching consumed delivery facts", async () => {
  const surface = await pairControlFixture(1);
  surface.deps.dispatchProvider = async () => ({ kind: "accepted", providerMessageId: "sent-before-empty-cleanup" });
  await surface.head();
  await surface.db.update(externalDeliveryPartitions).set({ authorityBlockedAt: NOW, authorityBlockedReason: "master_disabled" });
  const before = await surface.db.select().from(externalOutboundDeliveries);
  await clearEmptySlackPairWaits({ db: surface.db, bindings: [{ bindingId: surface.binding.id, bindingEpoch: 3 }], now: NOW });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedAt, null);
  assert.deepEqual(await surface.db.select().from(externalOutboundDeliveries), before);
});

for (const blockedBy of ["runtime", "credential"] as const) {
  test(`the first real ${blockedBy} failure after maintenance starts a new wait clock`, async () => {
    const surface = await pairControlFixture(1);
    await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled",
      now: new Date(NOW.getTime() - 3_600_000) });
    if (blockedBy === "runtime") surface.deps.resolveCurrentRuntime = async () => null;
    else surface.deps.leaseCredential = async () => null;
    const result = await surface.head();
    assert.equal(result.kind, "authority_blocked");
    if (result.kind !== "authority_blocked") assert.fail("expected a real authority wait");
    assert.equal(result.severity, "retrying");
    assert.equal(result.alert, undefined, "maintenance age cannot produce an immediate fault alert");
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
    assert.equal(partition.authorityOverdueAlertedAt, null);
  });
}

test("a recorded legacy deletion survives a mid-cleanup replacement and drains the bounded remainder", async () => {
  const surface = await pairControlFixture(SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE + 1);
  await surface.deleted();
  const scope = { registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId };
  const proof = await loadSlackChannelDeletionEvidence(surface.db, scope);
  assert.ok(proof, "expected recorded legacy deletion");
  assert.equal(proof.sourceKind, "legacy_binding");
  assert.equal(proof.providerEventId, null); assert.equal(proof.payloadSha256, null);
  const provider = createSlackBridgeProviderRuntime({ db: surface.db,
    credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }), now: () => NOW,
    fetch: (async () => { throw new Error("local deletion cleanup cannot call Slack"); }) as typeof fetch });
  let normalWorkers = 0;
  const runtime = () => createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 60_000,
    runWorkerOnce: async () => { normalWorkers += 1; throw new Error("old work cannot move to the replacement"); } });
  const first = runtime(); first.start();
  try { await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition === SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE); }
  finally { await first.stop(); }
  await surface.db.update(externalChannelBindings).set({ state: "revoked", stateReason: "provisioning_pair_replaced", bindingEpoch: 5 })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  await surface.db.insert(externalChannelBindings).values({ ...surface.binding, id: randomUUID(), bindingEpoch: 1,
    providerConversationId: "C_REPLACEMENT", state: "active", stateReason: null });
  assert.ok((await listSlackOutboundQueueBindings(surface.db, surface.registration.id)).some((binding) => binding.id === surface.binding.id),
    "deleted revoked bindings with unfinished work remain eligible");
  const second = runtime(); second.start();
  try { await waitForControlState(async () => (await surface.db.select().from(externalDeliveryPartitions))[0]!.cursorPosition === SLACK_DELETED_QUEUE_CLEANUP_BATCH_SIZE + 1); }
  finally { await second.stop(); await provider.stop(); }
  assert.equal(normalWorkers, 0);
  assert.ok(!(await listSlackOutboundQueueBindings(surface.db, surface.registration.id)).some((binding) => binding.id === surface.binding.id),
    "a fully consumed revoked binding is no longer scanned on every tick");
  assert.ok((await surface.db.select().from(externalOutboundDeliveries)).every((delivery) => delivery.state === "skipped"
    && delivery.stateReason === "destination_deleted" && delivery.providerAttempts === 0));
  assert.deepEqual(await loadSlackChannelDeletionEvidence(surface.db, scope), proof);
  for (const mismatch of [{ environment: "production" as const }, { providerAppId: "A_OTHER" },
    { providerAuthorityId: "T_OTHER" }, { providerConversationId: "C_OTHER" }, { registrationId: randomUUID() }]) {
    assert.equal(await loadSlackChannelDeletionEvidence(surface.db, { ...scope, ...mismatch }), null);
  }
});

test("a paused binding without a deletion fact remains unknown and cannot discard a queued message", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted", bindingEpoch: 4 })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  const cleanupScope = { ...surface.scope, currentBindingEpoch: 4 };
  const [binding] = await surface.db.select().from(externalChannelBindings);
  assert.equal(binding.state, "paused"); assert.equal(binding.stateReason, "provider_channel_deleted");
  assert.deepEqual(await surface.db.select().from(slackChannelDeletions), []);
  const scope = { registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId };
  assert.equal(await loadSlackChannelDeletionEvidence(surface.db, scope), null);
  await surface.db.update(externalChannelBindings).set({ state: "revoked", stateReason: "provisioning_pair_removed" });
  assert.equal(await loadSlackChannelDeletionEvidence(surface.db, scope), null);
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...cleanupScope, now: NOW })).kind, "blocked");
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "queued");
});

test("retirement backfills old paused state before outbound cleanup consumes it", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_deleted", bindingEpoch: 4 })
    .where(eq(externalChannelBindings.id, surface.binding.id));
  const scope = { registrationId: surface.registration.id, environment: "test" as const,
    providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId };
  assert.equal(await loadSlackChannelDeletionEvidence(surface.db, scope), null);
  const directory = fileURLToPath(new URL("../../drizzle", import.meta.url));
  const journal = JSON.parse(readFileSync(`${directory}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] };
  const tag = journal.entries.find((entry) => entry.tag.endsWith("_slack_deletion_capture_retirement"))?.tag;
  assert.ok(tag);
  const statements = readFileSync(`${directory}/${tag}.sql`, "utf8").split("--> statement-breakpoint");
  await surface.db.transaction(async (tx) => {
    for (const statement of statements) if (statement.trim()) await tx.execute(sql.raw(statement));
  });
  const proof = await loadSlackChannelDeletionEvidence(surface.db, scope);
  assert.equal(proof?.sourceKind, "legacy_binding");
  assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...surface.scope, currentBindingEpoch: 4, now: NOW })).kind, "skipped");
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.stateReason, "destination_deleted");
});

test("archived controls retain the specific unarchive hint", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused", now: NOW });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_archived");
});

test("a cleanup custody conflict stays visible and retries only after its cooldown", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalChannelBindings).set({ providerConversationId: "C_DIFFERENT_DESTINATION",
    state: "paused", stateReason: "provider_channel_deleted" });
  await surface.db.insert(slackChannelDeletions).values({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: "C_DIFFERENT_DESTINATION", sourceInstallId: surface.install.id,
    sourceKind: "legacy_binding", sourceKey: `binding:${surface.binding.id}:3`, sourceBindingId: surface.binding.id, observedAt: NOW });
  let clock = NOW;
  let diagnostics = 0;
  const warning = vi.spyOn(console, "warn").mockImplementation((_message, metadata) => {
    if (metadata?.event === "server.slack_bridge.destination.cleaned" && metadata.outcome === "blocked") diagnostics += 1;
  });
  const provider = createSlackBridgeProviderRuntime({ db: surface.db,
    credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }), now: () => clock,
    fetch: (async () => { throw new Error("custody conflict cannot call Slack"); }) as typeof fetch });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider,
    registrationId: surface.registration.id, reconciliationKey: "control-test", now: () => clock, workerIntervalMs: 10 });
  runtime.start();
  try {
    await waitForControlState(async () => diagnostics === 1);
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.authorityBlockedReason, "destination_cleanup_custody_conflict");
    assert.equal(partition.authorityRetryAt?.getTime(), NOW.getTime() + 60_000);
    clock = new Date(NOW.getTime() + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(diagnostics, 1, "the recorded cooldown prevents per-tick audit/query churn");
    clock = new Date(NOW.getTime() + 61_000);
    await waitForControlState(async () => diagnostics === 2);
    assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "queued");
  } finally { await runtime.stop(); await provider.stop(); warning.mockRestore(); }
});

for (const previous of ["fresh", "provider_archive"] as const) {
  test(`an archived binding resumes with a fresh real-fault clock (${previous})`, async () => {
    const surface = await pairControlFixture(1);
    await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
    const since = new Date(NOW.getTime() - 3_600_000);
    if (previous === "provider_archive") await surface.db.update(externalDeliveryPartitions).set({
      authorityBlockedAt: since, authorityBlockedReason: "slack_channel_archived", authorityOverdueAlertedAt: since });
    await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused_archived", now: since });
    assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "binding_paused_archived");
    await surface.db.update(externalChannelBindings).set({ state: "active", stateReason: null });
    surface.deps.resolveCurrentRuntime = async () => null;
    const result = await surface.head();
    assert.equal(result.kind, "authority_blocked");
    if (result.kind !== "authority_blocked") assert.fail("expected a real fault");
    assert.equal(result.severity, "retrying"); assert.equal(result.alert, undefined);
    const [partition] = await surface.db.select().from(externalDeliveryPartitions);
    assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
    assert.equal(partition.authorityOverdueAlertedAt, null);
  });
}

test("a provider pair failure after maintenance starts its own fault clock", async () => {
  const surface = await pairControlFixture(1);
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "master_disabled",
    now: new Date(NOW.getTime() - 3_600_000) });
  let posted = 0;
  surface.deps.dispatchProvider = async () => { posted += 1; return {
    kind: "deterministic_failure", reasonCode: "not_in_channel", pairBlockedReason: "slack_not_in_channel" }; };
  const result = await surface.head();
  assert.equal(result.kind, "attempted"); assert.equal(posted, 1, "exercise actual post-outcome recording");
  const [partition] = await surface.db.select().from(externalDeliveryPartitions);
  assert.equal(partition.authorityBlockedAt?.toISOString(), NOW.toISOString());
  assert.equal(partition.authorityBlockedReason, "slack_not_in_channel");
  await clearResumedSlackPairControlWait({ db: surface.db, ...surface.scope, now: NOW });
  assert.equal((await surface.db.select().from(externalDeliveryPartitions))[0]!.authorityBlockedReason, "slack_not_in_channel",
    "an active cached binding alone cannot erase a provider membership failure");
});

test("resuming an archive clears its stale hint before a dead head offers manual recovery", async () => {
  const surface = await pairControlFixture(1);
  await surface.db.update(externalOutboundDeliveries).set({ state: "dead", stateReason: "failure_budget_exhausted",
    providerAttempts: 4, ambiguityBudgetProviderAttempts: 3, dispatchedFailureAttempts: 4, firstDispatchedAt: NOW });
  await surface.db.update(externalChannelBindings).set({ state: "paused", stateReason: "provider_channel_archived" });
  await recordSlackPairControlWait({ db: surface.db, ...surface.scope, reason: "binding_paused_archived",
    now: new Date(NOW.getTime() - 3_600_000) });
  await surface.db.update(externalChannelBindings).set({ state: "active", stateReason: null });
  let complete!: () => void; let fail!: (error: unknown) => void;
  const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const provider = createSlackBridgeProviderRuntime({ db: surface.db,
    credentialCipher: createSlackBridgeEnvCredentialCipher({ key: Buffer.alloc(32, 41) }), now: () => NOW,
    fetch: (async () => { throw new Error("manual head cannot call Slack"); }) as typeof fetch });
  const runtime = createSlackBridgeDatabaseOutboundRuntime({ db: surface.db, provider, registrationId: surface.registration.id,
    reconciliationKey: "control-test", now: () => NOW, workerIntervalMs: 60_000,
    async runWorkerOnce(input) { try {
      const [before] = await surface.db.select().from(externalDeliveryPartitions);
      assert.equal(before.authorityBlockedReason, null, "clear the archive control before examining a terminal head");
      const result = await processExternalDeliveryPartitionHead(input);
      assert.equal(result.kind, "blocked");
      assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.state, "dead");
      complete(); return result;
    } catch (error) { fail(error); throw error; } } });
  runtime.start();
  try { await Promise.race([finished, new Promise((_, reject) => setTimeout(() => reject(new Error("resumed archive did not run")), 5_000))]); }
  finally { await runtime.stop(); await provider.stop(); }
});

test("deletion cursor recovery retains an operator skip audit label", async () => {
  const surface = await pairControlFixture(1);
  const [decision] = await surface.db.insert(externalDeliveryOperatorDecisions).values({ deliveryId: surface.deliveries[0]!.id,
    bindingId: surface.binding.id, bindingEpoch: 3, partitionPosition: 1, action: "skip", actorType: "user",
    actorId: surface.owner.id, reason: "operator-selected skip", duplicateRiskAcknowledged: false,
    dataLossAcknowledged: true, decisionRevision: 1 }).returning();
  assert.equal((await consumeExternalDeliverySkipDecision({ db: surface.db, bindingId: surface.binding.id,
    bindingEpoch: 3, decisionId: decision!.id, now: NOW })).kind, "skipped");
  await surface.db.update(externalDeliveryPartitions).set({ cursorPosition: 0 });
  const scope = await surface.deleted();
  const outcomes: string[] = [];
  const warning = vi.spyOn(console, "warn").mockImplementation((_message, metadata) => {
    if (metadata?.event === "server.slack_bridge.destination.cleaned") outcomes.push(metadata.outcome);
  });
  try { assert.equal((await cleanupDeletedSlackPairHead({ db: surface.db, ...scope, now: NOW })).kind, "cursor_recovered"); }
  finally { warning.mockRestore(); }
  assert.deepEqual(outcomes, ["operator_skip"]);
  assert.equal((await surface.db.select().from(externalOutboundDeliveries))[0]!.stateReason, "operator_audited_skip");
});

for (const attempted of [false, true]) test(`a ${attempted ? "previously attempted" : "never-attempted"} planned head can use confirmed destination deletion cleanup`, async () => {
  const surface = await fixture("public");
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "planned missing file", messageType: "chat", createdAt: NOW }).returning();
  const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
    uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/missing-cleanup`,
    contentHash: "a".repeat(64), mimeType: "text/plain", sizeBytes: 4 }).returning();
  await surface.db.insert(attachments).values({ objectId: object.id, messageId: message.id,
    messagePosition: 0, channelId: surface.channel.id, uploaderId: surface.owner.id,
    uploaderType: "user", filename: "missing.txt" });
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("plan-cleanup", deliveryId) }));
  const snapshot = queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const storage: StorageBackend = { async put() {}, async delete() {}, async get() { throw new Error("unused"); },
    async probeObjectPresence() { return "missing"; } };
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ db: surface.db, deliveryId: queued.delivery.id,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true }), { kind: "planned", revision: 1 });
  if (attempted) {
    await surface.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('slock.attachment_plan', '1', true)`);
      await tx.update(externalOutboundDeliveries).set({ state: "outcome_unknown", providerAttempts: 1,
        firstDispatchedAt: NOW, updatedAt: NOW }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
      await tx.insert(externalDeliveryAttempts).values({ deliveryId: queued.delivery.id, attemptNumber: 1,
        leaseGeneration: 1, runtimeRevision: "runtime-r1", credentialRevision: 1,
        dispatchAuthorization: "automatic", providerIoStartedAt: NOW });
    });
  }
  const denied = () => surface.db.update(externalOutboundDeliveries).set({ state: "skipped", stateReason: attempted ? "destination_deleted_outcome_unconfirmed" : "destination_deleted",
    leaseGeneration: 2, updatedAt: NOW }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  await assert.rejects(denied(), "without confirmed deletion an old writer cannot skip a planned head");
  await surface.db.insert(slackChannelDeletions).values({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: "C_OTHER", sourceInstallId: surface.install.id, sourceKind: "legacy_binding",
    sourceKey: "wrong-channel", sourceBindingId: surface.binding.id, observedAt: NOW });
  await assert.rejects(denied(), "another channel's deletion cannot authorize a skip");
  const recorded = await recordVerifiedSlackChannelDeletion({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: `Ev_DELETE_${randomUUID()}`,
    providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64), now: NOW });
  assert.ok(recorded?.paused);
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ state: "skipped", stateReason: attempted ? "destination_deleted_outcome_unconfirmed" : "destination_deleted",
    leaseGeneration: 2, renderSnapshotDigest: "b".repeat(64), updatedAt: NOW })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), "deletion may not rewrite the frozen snapshot");
  await assert.rejects(surface.db.update(externalOutboundDeliveries).set({ stateReason: "legacy-claim" })
    .where(eq(externalOutboundDeliveries.id, queued.delivery.id)), "deletion evidence must not unblock a legacy send");
  if (attempted) {
    const [accepted] = await surface.db.insert(externalMessageLinks).values({
      deliveryId: queued.delivery.id, provider: "slack", installId: surface.install.id,
      providerAuthorityId: surface.install.providerAuthorityId, providerConversationId: surface.binding.providerConversationId,
      providerMessageId: "1700000000.000001", bindingId: queued.delivery.bindingId,
      bindingEpoch: queued.delivery.bindingEpoch, connectionEpoch: surface.binding.connectionEpoch,
      raftMessageId: message.id, firstDirection: "raft_outbound", payloadFingerprint: queued.delivery.renderSnapshotDigest,
      outcomeState: "accepted", authorityState: "active",
    }).returning();
    await assert.rejects(denied(), "an accepted receipt must never be discarded as unknown");
    await surface.db.delete(externalMessageLinks).where(eq(externalMessageLinks.id, accepted.id));
  }
  const [currentBinding] = await surface.db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, surface.binding.id));
  const cleanup = () => cleanupDeletedSlackPairHead({ db: surface.db, registrationId: surface.registration.id,
    currentBindingId: currentBinding.id, currentBindingEpoch: currentBinding.bindingEpoch,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, now: NOW });
  const realPgUrl = process.env.CARDY_W3_REAL_PG_URL;
  if (realPgUrl) {
    const holder = new pg.Client({ connectionString: realPgUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT id FROM external_outbound_deliveries WHERE id = $1 FOR UPDATE", [queued.delivery.id]);
      assert.equal((await cleanup()).kind, "empty", "a locked head cannot be skipped or passed");
      const [whileLocked] = await surface.db.select().from(externalDeliveryPartitions)
        .where(eq(externalDeliveryPartitions.bindingId, queued.delivery.bindingId));
      assert.equal(whileLocked.cursorPosition, 0);
      await holder.query("COMMIT");
      assert.equal((await cleanup()).kind, "skipped");
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      await holder.end();
    }
  } else {
    assert.equal((await cleanup()).kind, "skipped");
  }
  const [settled] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(settled.stateReason, attempted ? "destination_deleted_outcome_unconfirmed" : "destination_deleted");
  assert.equal(settled.providerAttempts, attempted ? 1 : 0);
  if (attempted) {
    const attempts = await surface.db.select().from(externalDeliveryAttempts)
      .where(eq(externalDeliveryAttempts.deliveryId, queued.delivery.id));
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.outcome, "outcome_unknown");
    assert.equal(attempts[0]!.outcomeReason, "destination_deleted");
  }
  const [partition] = await surface.db.select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, queued.delivery.bindingId));
  assert.equal(partition.cursorPosition, queued.delivery.partitionPosition);
});

for (const receipt of ["delivery", "link"] as const) test(`planned accepted ${receipt} survives deleted destination cleanup`, async () => {
  const surface = await fixture("public");
  const [message] = await surface.db.insert(messages).values({ channelId: surface.channel.id,
    senderType: "user", senderId: surface.owner.id, content: "planned missing file", messageType: "chat", createdAt: NOW }).returning();
  const [object] = await surface.db.insert(attachmentObjects).values({ originServerId: surface.server.id,
    uploaderId: surface.owner.id, uploaderType: "user", storageKey: `${surface.server.id}/missing-cleanup`,
    contentHash: "a".repeat(64), mimeType: "text/plain", sizeBytes: 4 }).returning();
  await surface.db.insert(attachments).values({ objectId: object.id, messageId: message.id,
    messagePosition: 0, channelId: surface.channel.id, uploaderId: surface.owner.id,
    uploaderType: "user", filename: "missing.txt" });
  const active = await resolveCurrentOutboundAuthorityOrNull({ executor: surface.db, bindingId: surface.binding.id,
    expectedConnectionEpoch: surface.binding.connectionEpoch, expectedBindingEpoch: surface.binding.bindingEpoch,
    senderType: "user", senderId: surface.owner.id, now: NOW, registrationId: surface.registration.id });
  assert.ok(active);
  const queued = await surface.db.transaction((executor) => enqueueSlackBridgeOutboundDelivery({ executor, message,
    activeRuntime: { level: "top_level", authorityConversationId: surface.channel.id,
      runtimePredicateRevision: active.runtimeRevision, bindingAuthority: active.neutral },
    canonicalConversationId: surface.channel.id, senderType: "user", senderId: surface.owner.id,
    authorName: surface.owner.name, sanitizedText: message.content,
    mintReconciliationMarker: ({ deliveryId }) => mintSlackBridgeReconciliationMarker("plan-cleanup", deliveryId) }));
  const snapshot = queued.delivery.renderSnapshot as unknown as SlackBridgeRenderSnapshot;
  const storage: StorageBackend = { async put() {}, async delete() {}, async get() { throw new Error("unused"); },
    async probeObjectPresence() { return "missing"; } };
  assert.deepEqual(await prepareSlackAttachmentFallbackPlan({ db: surface.db, deliveryId: queued.delivery.id,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, snapshot, storage,
    now: () => NOW, assertWriterFleetFenced: async () => true }), { kind: "planned", revision: 1 });
  const acceptedTs = "1700000000.000001";
  await surface.db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('slock.attachment_plan', '1', true)`);
    await tx.update(externalOutboundDeliveries).set({ state: receipt === "delivery" ? "accepted" : "outcome_unknown",
      providerAttempts: 1, firstDispatchedAt: NOW,
      providerMessageId: receipt === "delivery" ? acceptedTs : null,
      acceptedAt: receipt === "delivery" ? NOW : null, stateReason: "original_reason", updatedAt: NOW,
    }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
    await tx.insert(externalDeliveryAttempts).values({ deliveryId: queued.delivery.id, attemptNumber: 1,
      leaseGeneration: 1, runtimeRevision: "runtime-r1", credentialRevision: 1,
      dispatchAuthorization: "automatic", providerIoStartedAt: NOW });
  });
  if (receipt === "link") {
    await surface.db.insert(externalMessageLinks).values({ deliveryId: queued.delivery.id,
      provider: "slack", installId: surface.install.id, providerAuthorityId: surface.install.providerAuthorityId,
      providerConversationId: surface.binding.providerConversationId, providerMessageId: acceptedTs,
      bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch,
      connectionEpoch: surface.binding.connectionEpoch, raftMessageId: message.id,
      raftCanonicalRootMessageId: snapshot.canonicalRootMessageId,
      firstDirection: "raft_outbound", payloadFingerprint: queued.delivery.renderSnapshotDigest,
      outcomeState: "accepted", authorityState: "active" });
  }
  const promote = (id: string) => surface.db.update(externalOutboundDeliveries).set({ state: "accepted",
    providerMessageId: id, acceptedAt: NOW, nextAttemptAt: null, leaseGeneration: 2, updatedAt: NOW,
  }).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  await assert.rejects(promote(acceptedTs), "accepted cursor recovery requires deletion evidence");
  const recorded = await recordVerifiedSlackChannelDeletion({ registrationId: surface.registration.id,
    environment: "test", providerAppId: surface.install.providerAppId, providerAuthorityId: surface.install.providerAuthorityId,
    providerConversationId: surface.binding.providerConversationId, providerEventId: `Ev_DELETE_${randomUUID()}`,
    providerEventType: "channel_deleted", signingSecretRevision: 1, payloadSha256: "a".repeat(64), now: NOW });
  assert.ok(recorded?.paused);
  await assert.rejects(promote("1700000000.000099"), "cleanup must not change or invent the accepted receipt");
  if (receipt === "link") {
    await surface.db.update(externalMessageLinks).set({ payloadFingerprint: "b".repeat(64) })
      .where(eq(externalMessageLinks.deliveryId, queued.delivery.id));
    await assert.rejects(promote(acceptedTs), "a receipt with a different frozen payload is not proof");
    await surface.db.update(externalMessageLinks).set({ payloadFingerprint: queued.delivery.renderSnapshotDigest })
      .where(eq(externalMessageLinks.deliveryId, queued.delivery.id));
  }
  const [currentBinding] = await surface.db.select().from(externalChannelBindings).where(eq(externalChannelBindings.id, surface.binding.id));
  const result = await cleanupDeletedSlackPairHead({ db: surface.db, registrationId: surface.registration.id,
    currentBindingId: currentBinding.id, currentBindingEpoch: currentBinding.bindingEpoch,
    bindingId: queued.delivery.bindingId, bindingEpoch: queued.delivery.bindingEpoch, now: NOW });
  assert.equal(result.kind, "cursor_recovered");
  const [settled] = await surface.db.select().from(externalOutboundDeliveries).where(eq(externalOutboundDeliveries.id, queued.delivery.id));
  assert.equal(settled.state, "accepted"); assert.equal(settled.providerMessageId, acceptedTs);
  assert.equal(settled.providerAttempts, 1); assert.equal(settled.stateReason, "original_reason");
  const [partition] = await surface.db.select().from(externalDeliveryPartitions)
    .where(eq(externalDeliveryPartitions.bindingId, queued.delivery.bindingId));
  assert.equal(partition.cursorPosition, queued.delivery.partitionPosition);
});
