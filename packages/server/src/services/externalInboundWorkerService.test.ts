import { enableTestSlackIngress } from "../test/integration/slackIngressRollout";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { eq, sql } from "drizzle-orm";

import { getDb } from "../db/index";
import {
  agents,
  attachmentObjectCharges,
  attachmentObjects,
  attachmentUploadReservations,
  attachments,
  channelAgents,
  channelHumans,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalAttachmentAssets,
  externalAttachmentMessageFacts,
  externalAttachmentTransferJobs,
  externalChannelBindings,
  externalHumanIdentityLinks,
  externalInboundEvents,
  externalMessageAuthorFacts,
  externalMentionFacts,
  externalMessageLinks,
  inboxNotificationFacts,
  jointChannels,
  jointChannelServers,
  messageMentions,
  messages,
  oauthClients,
  serverMembers,
  slackVerifiedIngressEvents,
  servers,
  threadFollows,
  users,
} from "../db/schema";
import {
  __setExternalInboundCanonicalCommitHookForTests,
  __setExternalInboundEventRowLockHookForTests,
  createExternalInboundWorkerRuntime,
  enqueueExternalInboundEvent,
  processExternalInboundEventOnce,
  renderSlackInboundMentionLabels,
  type ExternalInboundNormalizedMessage,
  type ExternalInboundRuntimeAuthority,
  type ExternalInboundWorkerDependencies,
} from "./externalInboundWorkerService";
import { processExternalInboundAttachmentOnce } from "./externalInboundAttachmentWorkerService";
import { externalInboundAttachmentIntentState } from "./externalInboundAttachmentStorageService";
import type { ExternalInboundAttachmentProviderAdapter } from "./externalAttachmentProviderAdapter";
import type { StorageBackend } from "./storageService";
import { slackActorProjectionRevisionAfterRefresh } from "./slackBridgeProvisioningControlPlane";


const NOW = new Date("2026-08-03T12:00:00.000Z");

beforeEach(async () => {
  await openTestDatabase("pglite://");
});

afterEach(async () => {
  __setExternalInboundCanonicalCommitHookForTests(null);
  __setExternalInboundEventRowLockHookForTests(null);
  await closeTestDatabase();
});

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function seedFixture(
  privacyClass: "public" | "private" = "public",
  provider = "provider-test",
) {
  const db = getDb();
  const [owner, member] = await db.insert(users).values([
    {
      email: `inbound-owner-${randomUUID()}@raft.test`,
      name: `inbound-owner-${randomUUID().slice(0, 8)}`,
      displayName: "Inbound Owner",
      passwordHash: "test",
      emailVerified: true,
    },
    {
      email: `inbound-member-${randomUUID()}@raft.test`,
      name: `inbound-member-${randomUUID().slice(0, 8)}`,
      displayName: "Inbound Member",
      passwordHash: "test",
      emailVerified: true,
    },
  ]).returning();
  const [server] = await db.insert(servers).values({
    name: "External Inbound Worker",
    slug: `external-inbound-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: `external-inbound-${randomUUID()}`,
    type: privacyClass === "public" ? "channel" : "private",
  }).returning();
  await db.insert(channelHumans).values([
    { channelId: channel.id, userId: owner.id },
    { channelId: channel.id, userId: member.id },
  ]);
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `inbound-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });
  const [client] = await db.insert(oauthClients).values({
    serverId: server.id,
    clientId: `external-inbound-${randomUUID()}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "External inbound fixture",
    createdByUserId: owner.id,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: `A_INBOUND_${randomUUID()}`,
    providerOAuthClientId: `inbound-${randomUUID()}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: "inbound-manifest-v1",
    requiredCapabilities: ["external_projection", "channel_events"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: server.id,
    registrationId: registration.id,
    state: "active",
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "inbound-manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: owner.id,
  }).returning();
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: server.id,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    state: "active",
    connectionEpoch: 3,
    installedScopes: [],
    providerAppId: registration.providerAppId,
    providerTeamId: "authority-1",
    authorityType: "team",
    providerAuthorityId: "authority-1",
    workspaceName: "Frozen Test Workspace",
  }).returning();
  const [actor] = await db.insert(externalActorProjections).values({
    provider,
    appRegistrationId: registration.id,
    installId: install.id,
    workspaceId: "workspace-1",
    externalActorId: "external-actor-1",
    displayName: "External Alice",
    handles: ["alice"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 4,
    observedAt: NOW,
  }).returning();
  const authority: ExternalInboundRuntimeAuthority = {
    runtimeRevision: "runtime-r1",
    provider: actor.provider,
    environment: "test",
    appRegistrationId: actor.appRegistrationId,
    installId: actor.installId,
    workspaceId: actor.workspaceId,
    providerAuthorityId: "authority-1",
    providerConversationId: "conversation-1",
    bindingId: "binding-1",
    bindingEpoch: 2,
    connectionEpoch: 3,
    raftChannelId: channel.id,
    privacyClass,
  };
  return { db, owner, member, server, channel, agent, actor, install, authority };
}

async function seedSecondExternalActor(fixture: Awaited<ReturnType<typeof seedFixture>>) {
  const [actor] = await fixture.db.insert(externalActorProjections).values({
    provider: fixture.actor.provider,
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    externalActorId: `external-actor-${randomUUID()}`,
    displayName: "External Bob",
    handles: ["bob"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 2,
    observedAt: NOW,
  }).returning();
  return actor;
}

async function seedSecondServerOccurrence(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  actor: typeof externalActorProjections.$inferSelect,
) {
  const [server] = await fixture.db.insert(servers).values({
    name: "External inbound second recipient",
    slug: `external-inbound-second-${randomUUID()}`,
    ownerId: fixture.owner.id,
  }).returning();
  await fixture.db.insert(serverMembers).values([
    { serverId: server.id, userId: fixture.owner.id, role: "owner" },
    { serverId: server.id, userId: fixture.member.id, role: "member" },
  ]);
  const [channel] = await fixture.db.insert(channels).values({
    serverId: server.id,
    name: `external-inbound-second-${randomUUID()}`,
    type: "channel",
  }).returning();
  await fixture.db.insert(channelHumans).values([
    { channelId: channel.id, userId: fixture.owner.id },
    { channelId: channel.id, userId: fixture.member.id },
  ]);
  return {
    ...fixture,
    server,
    channel,
    actor,
    authority: {
      ...fixture.authority,
      providerConversationId: `conversation-${randomUUID()}`,
      bindingId: randomUUID(),
      raftChannelId: channel.id,
    },
  };
}

async function convertFixtureToJointWithParticipant(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  const [storageServer, participantServer] = await fixture.db.insert(servers).values([
    {
      name: "External inbound Joint storage",
      slug: `external-inbound-storage-${randomUUID()}`,
      ownerId: fixture.owner.id,
    },
    {
      name: "External inbound Joint participant",
      slug: `external-inbound-participant-${randomUUID()}`,
      ownerId: fixture.owner.id,
    },
  ]).returning();
  await fixture.db.insert(serverMembers).values([
    { serverId: participantServer.id, userId: fixture.owner.id, role: "owner" },
    { serverId: participantServer.id, userId: fixture.member.id, role: "member" },
  ]);
  const [canonical, participant] = await fixture.db.insert(channels).values([
    {
      serverId: storageServer.id,
      name: `external-inbound-canonical-${randomUUID()}`,
      type: "channel",
    },
    {
      serverId: participantServer.id,
      name: `external-inbound-participant-${randomUUID()}`,
      type: "joint",
    },
  ]).returning();
  await fixture.db.insert(channelHumans).values([
    { channelId: participant.id, userId: fixture.owner.id },
    { channelId: participant.id, userId: fixture.member.id },
  ]);
  await fixture.db.update(channels).set({ type: "joint" })
    .where(eq(channels.id, fixture.channel.id));
  const [joint] = await fixture.db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await fixture.db.insert(jointChannelServers).values([
    {
      jointChannelId: joint.id,
      serverId: fixture.server.id,
      localChannelId: fixture.channel.id,
      role: "host",
      joinedByUserId: fixture.owner.id,
    },
    {
      jointChannelId: joint.id,
      serverId: participantServer.id,
      localChannelId: participant.id,
      role: "participant",
      joinedByUserId: fixture.owner.id,
    },
  ]);
  return { canonical, joint, participant, participantServer };
}

function payload(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  providerMessageId: string,
  providerThreadId: string | null = null,
  content?: string,
): ExternalInboundNormalizedMessage {
  return {
    schema: "external-inbound-normalized-event.v1",
    projectionId: fixture.actor.id,
    actorProjectionRevision: fixture.actor.projectionRevision,
    externalActorId: fixture.actor.externalActorId,
    providerMessageId,
    providerThreadId,
    content: content ?? `provider content ${providerMessageId}`,
    createdAt: "2026-08-03T11:59:00.000Z",
  };
}

async function enqueue(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  providerEventId: string,
  body: ExternalInboundNormalizedMessage,
  receivedAt = NOW,
) {
  const plaintext = JSON.stringify(body);
  const admitted = await enqueueExternalInboundEvent({
    db: fixture.db,
    authority: fixture.authority,
    providerEventId,
    normalizedPayloadDigest: digest(plaintext),
    encryptedPayload: plaintext,
    envelopeKeyId: "opaque-envelope-key-1",
    payloadSchemaVersion: body.schema === "external-inbound-normalized-edit.v1" ? 4 : body.schema === "external-inbound-normalized-event.v2"
      || body.schema === "external-inbound-normalized-event.v3" || body.schema === "external-inbound-normalized-event.v4" ? 2 : 1,
    payloadExpiresAt: new Date(receivedAt.getTime() + 5 * 60_000),
    receivedAt,
  });
  return { ...admitted, plaintext };
}

function dependencies(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  input: {
    now?: () => Date;
    runtime?: Awaited<ReturnType<ExternalInboundWorkerDependencies["resolveCurrentRuntime"]>>;
    decrypt?: ExternalInboundWorkerDependencies["decryptNormalizedPayload"];
    resolveProviderMentionProfiles?: ExternalInboundWorkerDependencies["resolveProviderMentionProfiles"];
    resolveProviderAgentMentionHandles?: ExternalInboundWorkerDependencies["resolveProviderAgentMentionHandles"];
    onMessageCommitted?: ExternalInboundWorkerDependencies["onMessageCommitted"];
    onMessageCommittedError?: ExternalInboundWorkerDependencies["onMessageCommittedError"];
    calls?: { decrypt: number; runtime: number };
  } = {},
): ExternalInboundWorkerDependencies {
  const calls = input.calls ?? { decrypt: 0, runtime: 0 };
  return {
    now: input.now ?? (() => NOW),
    async decryptNormalizedPayload(args) {
      calls.decrypt += 1;
      if (input.decrypt) return input.decrypt(args);
      return args.ciphertext;
    },
    async resolveCurrentRuntime() {
      calls.runtime += 1;
      return input.runtime === undefined ? fixture.authority : input.runtime;
    },
    ...(input.resolveProviderMentionProfiles
      ? { resolveProviderMentionProfiles: input.resolveProviderMentionProfiles }
      : {}),
    ...(input.resolveProviderAgentMentionHandles
      ? { resolveProviderAgentMentionHandles: input.resolveProviderAgentMentionHandles }
      : {}),
    ...(input.onMessageCommitted ? { onMessageCommitted: input.onMessageCommitted } : {}),
    ...(input.onMessageCommittedError ? { onMessageCommittedError: input.onMessageCommittedError } : {}),
  };
}

async function process(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
  deps: ExternalInboundWorkerDependencies | null = dependencies(fixture),
) {
  return processExternalInboundEventOnce({
    db: fixture.db,
    leaseOwner: "inbound-worker-1",
    dependencies: deps,
  });
}

async function createInboundFileHarness(
  fixture: Awaited<ReturnType<typeof seedFixture>>,
) {
  const body = Buffer.from("one immutable provider file", "utf8");
  const writes = new Map<string, Buffer>();
  let downloads = 0;
  let inspections = 0;
  let streamWrites = 0;
  let inspectFailure: string | null = null;
  let bridgePaused = false;
  let revokeAfterPutActorId: string | null = null;
  const revokedActors = new Set<string>();
  const maximumByServer = new Map<string, number>();
  let occurrence = 0;
  const storage: StorageBackend = {
    async put(key, data) {
      streamWrites += 1;
      writes.set(key, Buffer.from(data));
      if (revokeAfterPutActorId) {
        revokedActors.add(revokeAfterPutActorId);
        revokeAfterPutActorId = null;
      }
    },
    async get(key) {
      const value = writes.get(key);
      if (!value) throw new Error("missing");
      return Readable.from(value);
    },
    async delete(key) { writes.delete(key); },
  };
  const adapter: ExternalInboundAttachmentProviderAdapter<{ fileId: string }> = {
    provider: fixture.authority.provider,
    capabilities: {
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async inspectInboundAsset({ providerFileId }) {
      inspections += 1;
      if (inspectFailure) throw new Error(inspectFailure);
      return {
        metadata: {
          providerFileId,
          sourceExternalActorId: fixture.actor.externalActorId,
          filename: "shared.txt",
          declaredSizeBytes: body.length,
          mimeType: "text/plain",
          providerCreatedAt: NOW,
        },
        downloadHandle: { fileId: providerFileId },
      };
    },
    async *downloadInboundAsset() {
      downloads += 1;
      yield body;
    },
    classifyFailure(error) {
      return {
        class: "deterministic",
        reason: error instanceof Error ? error.message : "fixture_failure",
        retryAfterMs: null,
        scope: "asset_global",
      };
    },
  };

  const attachmentDependencies = (at: Date) => ({
    storage,
    resolveAdapter: (provider: string) => provider === adapter.provider ? adapter : null,
    authorityIsCurrent: async (_authority: unknown, sourceActorProjectionId: string) => (
      bridgePaused ? "paused" as const : !revokedActors.has(sourceActorProjectionId)
    ),
    maximumFileSizeBytes: async (serverId: string) => maximumByServer.get(serverId) ?? 1024,
    now: () => at,
  });
  const prepare = async (
    actor: typeof externalActorProjections.$inferSelect,
    suffix: string,
    target = fixture,
  ) => {
    occurrence += 1;
    const at = new Date(NOW.getTime() + occurrence * 60_000);
    const filePayload: ExternalInboundNormalizedMessage = {
      ...payload(target, `provider-message-${suffix}`),
      schema: "external-inbound-normalized-event.v2",
      projectionId: actor.id,
      actorProjectionRevision: actor.projectionRevision,
      externalActorId: actor.externalActorId,
      providerFileIds: ["provider-file-shared"],
    };
    const admitted = await enqueue(target, `event-${suffix}`, filePayload, at);
    let prepared = await process(target, dependencies(target, { now: () => at }));
    for (let attempt = 0; attempt < 10 && (
      !("eventId" in prepared) || prepared.eventId !== admitted.event.id
    ); attempt += 1) {
      prepared = await process(target, dependencies(target, { now: () => at }));
    }
    assert.deepEqual(prepared, {
      kind: "blocked",
      eventId: admitted.event.id,
      reason: "attachment_transfer_pending",
    });
    return { admitted, at, target };
  };
  const processTransfer = (suffix: string, at: Date) => processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: `attachment-worker-${suffix}`,
    dependencies: attachmentDependencies(at),
  });

  return {
    body,
    writes,
    counters: () => ({ downloads, inspections, streamWrites }),
    failInspection(reason: string) { inspectFailure = reason; },
    setBridgePaused(paused: boolean) { bridgePaused = paused; },
    revokeActor(actorId: string) { revokedActors.add(actorId); },
    revokeActorAfterNextPut(actorId: string) { revokeAfterPutActorId = actorId; },
    setMaximum(serverId: string, maximumBytes: number) { maximumByServer.set(serverId, maximumBytes); },
    prepare,
    processTransfer,
    async commit(at: Date, target = fixture) {
      return process(target, dependencies(target, {
        now: () => new Date(at.getTime() + 30_000),
      }));
    },
    async deliver(actor: typeof externalActorProjections.$inferSelect, suffix: string) {
      const { admitted, at } = await prepare(actor, suffix);
      let transfer = await processExternalInboundAttachmentOnce({
        db: fixture.db,
        leaseOwner: `attachment-worker-${suffix}-1`,
        dependencies: attachmentDependencies(at),
      });
      if (transfer.kind === "metadata_ready") {
        transfer = await processExternalInboundAttachmentOnce({
          db: fixture.db,
          leaseOwner: `attachment-worker-${suffix}-2`,
          dependencies: attachmentDependencies(at),
        });
      }
      if (transfer.kind === "stored") {
        const committed = await process(fixture, dependencies(fixture, {
          now: () => new Date(at.getTime() + 30_000),
        }));
        assert.equal(committed.kind, "committed");
        return { admitted, transfer, committed };
      }
      return { admitted, transfer, committed: null };
    },
  };
}

test("inbound attachment work pauses with the bridge and resumes without losing its file", async () => {
  const fixture = await seedFixture();
  const harness = await createInboundFileHarness(fixture);
  const { at } = await harness.prepare(fixture.actor, "bridge-pause");
  harness.setBridgePaused(true);
  const paused = await harness.processTransfer("pause", at);
  assert.equal(paused.kind, "retry");
  assert.equal(paused.kind === "retry" ? paused.reason : null, "bridge_disabled");
  assert.equal(harness.counters().inspections, 0);
  harness.setBridgePaused(false);
  const resumed = await harness.processTransfer("resume", new Date(at.getTime() + 31_000));
  assert.equal(resumed.kind, "metadata_ready");
  const stored = await harness.processTransfer("store", new Date(at.getTime() + 31_000));
  assert.equal(stored.kind, "stored");
  assert.equal((await harness.commit(new Date(at.getTime() + 31_000))).kind, "committed");
});

// Visibility is per-platform: a pair is allowed in all four combinations and
// a post-enqueue visibility flip must not strand queued events. Inbound commit
// only requires a live ordinary channel, not a class match.
for (const privacyClass of ["public", "private"] as const) {
  for (const flip of [false, true] as const) {
    test(`cross-class inbound commits ${flip ? "after a queued Raft visibility flip" : "at enqueue"} (${privacyClass})`, async () => {
      const fixture = await seedFixture(privacyClass);
      const raftType = privacyClass === "public" ? "channel" : "private";
      const flipped = raftType === "channel" ? "private" : "channel";
      if (!flip) {
        // The Raft channel is already the opposite class at enqueue+commit.
        await fixture.db.update(channels).set({ type: flipped }).where(eq(channels.id, fixture.channel.id));
      }
      const admitted = await enqueue(fixture, `event-cross-${privacyClass}-${flip}`, payload(fixture, `provider-cross-${privacyClass}-${flip}`));
      assert.equal(admitted.event.status, "queued");
      if (flip) {
        await fixture.db.update(channels).set({ type: flipped }).where(eq(channels.id, fixture.channel.id));
      }
      const result = await process(fixture);
      assert.equal(result.kind, "committed", "a visibility flip must not lose inbound authority");
      assert.equal(result.eventId, admitted.event.id);
    });
  }
}

test("disabled worker is side-effect free and top-level commit is one atomic canonical unit", async () => {
  const fixture = await seedFixture();
  const admitted = await enqueue(fixture, "event-1", payload(fixture, "provider-message-1"));
  assert.deepEqual(await process(fixture, null), { kind: "disabled" });
  assert.equal((await fixture.db.select().from(externalInboundEvents))[0]?.status, "queued");

  const calls = { decrypt: 0, runtime: 0 };
  const result = await process(fixture, dependencies(fixture, { calls }));
  assert.equal(result.kind, "committed");
  assert.equal(result.eventId, admitted.event.id);
  assert.deepEqual(calls, { decrypt: 1, runtime: 1 });

  const [event] = await fixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "committed");
  assert.equal(event.encryptedPayload, null);
  assert.equal(event.envelopeKeyId, null);
  assert.equal(event.payloadExpiresAt, null);
  assert.ok(event.payloadErasedAt);
  assert.match(event.payloadTombstoneDigest ?? "", /^[0-9a-f]{64}$/);
  assert.ok(event.committedMessageId);
  const projected = await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"));
  assert.equal(projected.length, 1);
  assert.equal(projected[0]?.id, event.committedMessageId);
  const [authorFact] = await fixture.db.select().from(externalMessageAuthorFacts);
  assert.equal(authorFact.workspaceName, "Frozen Test Workspace");
  const [link] = await fixture.db.select().from(externalMessageLinks);
  assert.equal(link.firstDirection, "provider_inbound");
  assert.equal(link.providerMessageId, "provider-message-1");
  assert.equal((await fixture.db.select().from(inboxNotificationFacts)).length, 3);
});

test("Slack inbound mention labels use current directory projections without minting Raft mention authority", async () => {
  const fixture = await seedFixture("public", "slack");
  await fixture.db.insert(externalActorProjections).values([
    {
      provider: "slack",
      appRegistrationId: fixture.actor.appRegistrationId,
      installId: fixture.actor.installId,
      workspaceId: fixture.actor.workspaceId,
      externalActorId: "UDISPLAYONLY",
      displayName: "Display [Only]",
      handles: [],
      actorKind: "human",
      state: "active",
      deactivated: false,
      projectionRevision: 1,
      observedAt: NOW,
    },
    {
      provider: "slack",
      appRegistrationId: fixture.actor.appRegistrationId,
      installId: fixture.actor.installId,
      workspaceId: fixture.actor.workspaceId,
      externalActorId: "UTOMBSTONED",
      displayName: "Stale Person",
      handles: ["stale"],
      actorKind: "human",
      state: "tombstoned",
      deactivated: true,
      projectionRevision: 2,
      observedAt: NOW,
    },
  ]);
  const body = {
    ...payload(fixture, "provider-message-native-mentions"),
    content: "hi <@U0BTXDF3LGY> / <@UDISPLAYONLY> / <@UUNKNOWN> / <@UTOMBSTONED>",
  };
  await enqueue(fixture, "event-native-mentions", body);
  const resolvedIds: string[][] = [];
  const mentionResult = await process(fixture, dependencies(fixture, {
    async resolveProviderMentionProfiles(input) {
      resolvedIds.push([...input.providerUserIds]);
      return [
        {
          providerUserId: "U0BTXDF3LGY",
          displayName: "August Zhang",
          handle: "august",
        },
        {
          providerUserId: "UUNKNOWN",
          displayName: "UUNKNOWN",
          handle: "UUNKNOWN",
        },
      ];
    },
  }));
  assert.equal(mentionResult.kind, "committed", JSON.stringify(mentionResult));
  assert.deepEqual(resolvedIds, [["U0BTXDF3LGY", "UUNKNOWN", "UTOMBSTONED"]]);
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(
    stored?.content,
    "hi @august / @Display \\[Only\\] / @Slack user / @Slack user",
  );
  assert.doesNotMatch(stored?.content ?? "", /U0BTXDF3LGY|UDISPLAYONLY|UUNKNOWN|UTOMBSTONED/u);
  assert.equal((await fixture.db.select().from(messageMentions)).length, 0);
});

test("Slack member mention with a Raft member's handle cannot mint a Raft mention", async () => {
  const fixture = await seedFixture("public", "slack");
  // The Slack-side actor happens to share the bound Raft owner's handle; a
  // <@U…> picked in Slack must render as a display-only fact, never a
  // messageMentions row that would notify the same-named Raft member.
  const [sameNameProjection] = await fixture.db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    externalActorId: "USAMENAME",
    displayName: fixture.owner.displayName ?? fixture.owner.name,
    handles: [fixture.owner.name],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  }).returning();
  await fixture.db.insert(externalAddressabilityProjections).values({
    projectionId: sameNameProjection.id,
    provider: "slack",
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    connectionEpoch: fixture.authority.connectionEpoch,
    bindingId: fixture.authority.bindingId,
    bindingEpoch: fixture.authority.bindingEpoch,
    conversationId: fixture.authority.providerConversationId,
    memberRevision: 1,
    contextRevision: 1,
    state: "active",
    observedAt: NOW,
    expiresAt: new Date(NOW.getTime() + 60_000),
  });
  const body = {
    ...payload(fixture, "provider-message-samename-mention"),
    content: `hi <@USAMENAME>`,
  };
  await enqueue(fixture, "event-samename-mention", body);
  const mentionResult = await process(fixture, dependencies(fixture, {
    async resolveProviderMentionProfiles() {
      return [{ providerUserId: "USAMENAME", displayName: fixture.owner.name, handle: fixture.owner.name }];
    },
  }));
  assert.equal(mentionResult.kind, "committed", JSON.stringify(mentionResult));
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(stored?.content, `hi @${fixture.owner.name}`);
  assert.equal(
    (await fixture.db.select().from(messageMentions)).length,
    0,
    "a Slack-picked mention must never mint Raft mention authority for the same-named member",
  );
  const facts = await fixture.db.select().from(externalMentionFacts);
  assert.equal(facts.length, 1, "the Slack member stays a display-only external fact");
});

test("Slack directory mention labels reject opaque provider identifiers as handles", async () => {
  const fixture = await seedFixture("public", "slack");
  await fixture.db.insert(externalActorProjections).values({
    provider: "slack",
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    externalActorId: "UOPAQUE",
    displayName: "UOPAQUE",
    handles: ["UOPAQUE"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  });
  await enqueue(fixture, "event-directory-opaque-mention", {
    ...payload(fixture, "provider-message-directory-opaque-mention"),
    content: "hi <@UOPAQUE>",
  });
  let providerCalls = 0;
  assert.equal((await process(fixture, dependencies(fixture, {
    async resolveProviderMentionProfiles() {
      providerCalls += 1;
      return [];
    },
  }))).kind, "committed");
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(stored?.content, "hi @Slack user");
  assert.equal(providerCalls, 0, "a current directory projection never triggers provider fallback");
  assert.doesNotMatch(stored?.content ?? "", /UOPAQUE/u);
  assert.equal((await fixture.db.select().from(messageMentions)).length, 0);
});

test("Slack managed usergroup identity creates one exact Raft Agent mention", async () => {
  const fixture = await seedFixture("public", "slack");
  const providerUsergroupId = "SAGENT123";
  await enqueue(fixture, "event-agent-mention", {
    ...payload(fixture, "provider-message-agent-mention"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [{
      providerUsergroupId,
      handle: "wrong-display-handle",
    }],
    content: `please <!subteam^${providerUsergroupId}|@wrong-display-handle> respond; @alice stays text`,
  });
  const result = await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() {
      return [{
        agentId: fixture.agent.id,
        providerUsergroupId,
        handle: "managed-agent-handle",
      }];
    },
  }));
  assert.equal(result.kind, "committed", JSON.stringify(result));
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(
    stored?.content,
    `please @${fixture.agent.name} respond; @alice stays text`,
    "provider group id, not the display handle, chooses the Agent",
  );
  const mentions = await fixture.db.select().from(messageMentions);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]?.messageId, stored?.id);
  assert.equal(mentions[0]?.targetType, "agent");
  assert.equal(mentions[0]?.targetId, fixture.agent.id);
  assert.equal(mentions[0]?.handleAtSendTime, fixture.agent.name);
  assert.equal(mentions[0]?.notifiableAtSend, true);
});

test("Slack managed group for an Agent outside the bound channel stays inert", async () => {
  const fixture = await seedFixture("public", "slack");
  const [otherAgent] = await fixture.db.insert(agents).values({
    serverId: fixture.server.id,
    name: `outside-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  const providerUsergroupId = "SOUTSIDE1";
  await enqueue(fixture, "event-outside-agent-mention", {
    ...payload(fixture, "provider-message-outside-agent-mention"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [{ providerUsergroupId, handle: "outside-agent" }],
    content: `<!subteam^${providerUsergroupId}|@outside-agent> should stay inert`,
  });
  assert.equal((await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() {
      return [{ agentId: otherAgent.id, providerUsergroupId, handle: "outside-agent" }];
    },
  }))).kind, "committed");
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  // Inert for mention purposes, but the author's label survives display so
  // the reader can tell which Slack group was written.
  assert.equal(stored?.content, "@outside-agent should stay inert");
  assert.equal((await fixture.db.select().from(messageMentions)).length, 0);
});

test("Slack managed human usergroup creates one exact notifiable Raft user mention", async () => {
  const fixture = await seedFixture("public", "slack");
  const agentUsergroupId = "SAGENT123";
  const humanUsergroupId = "SHUMAN123";
  await enqueue(fixture, "event-human-mention", {
    ...payload(fixture, "provider-message-human-mention"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [
      { providerUsergroupId: agentUsergroupId, handle: "managed-agent-handle" },
      { providerUsergroupId: humanUsergroupId, handle: "wrong-human-handle" },
    ],
    content: `<!subteam^${humanUsergroupId}|@wrong-human-handle> and `
      + `<!subteam^${agentUsergroupId}|@managed-agent-handle> please look`,
  });
  const result = await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() {
      return [
        { agentId: fixture.agent.id, providerUsergroupId: agentUsergroupId, handle: "managed-agent-handle" },
        { userId: fixture.member.id, providerUsergroupId: humanUsergroupId, handle: "managed-human-handle" },
      ];
    },
  }));
  assert.equal(result.kind, "committed", JSON.stringify(result));
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(
    stored?.content,
    `@${fixture.member.name} and @${fixture.agent.name} please look`,
    "provider group id, not the display handle, chooses the human",
  );
  const mentions = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, stored!.id));
  assert.deepEqual(mentions.map((row) => ({
    targetType: row.targetType,
    targetId: row.targetId,
    handleAtSendTime: row.handleAtSendTime,
    notifiableAtSend: row.notifiableAtSend,
  })).sort((left, right) => left.targetType.localeCompare(right.targetType)), [
    {
      targetType: "agent",
      targetId: fixture.agent.id,
      handleAtSendTime: fixture.agent.name,
      notifiableAtSend: true,
    },
    {
      targetType: "user",
      targetId: fixture.member.id,
      handleAtSendTime: fixture.member.name,
      notifiableAtSend: true,
    },
  ]);
});

test("Slack managed human group for a user outside the mention scope stays inert", async () => {
  const fixture = await seedFixture("public", "slack");
  const [outsider] = await fixture.db.insert(users).values({
    email: `inbound-group-outsider-${randomUUID()}@raft.test`,
    name: `inbound-group-outsider-${randomUUID().slice(0, 8)}`,
    displayName: "Inbound Group Outsider",
    passwordHash: "test",
    emailVerified: true,
  }).returning();
  await fixture.db.insert(serverMembers).values({
    serverId: fixture.server.id,
    userId: outsider.id,
    role: "member",
  });
  const providerUsergroupId = "SHUMANOUT1";
  await enqueue(fixture, "event-outside-human-mention", {
    ...payload(fixture, "provider-message-outside-human-mention"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [{ providerUsergroupId, handle: "outside-human" }],
    content: `<!subteam^${providerUsergroupId}|@outside-human> should stay inert`,
  });
  assert.equal((await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() {
      return [{ userId: outsider.id, providerUsergroupId, handle: "outside-human" }];
    },
  }))).kind, "committed");
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(stored?.content, "@outside-human should stay inert");
  assert.equal((await fixture.db.select().from(messageMentions)).length, 0);
});

test("Slack Agent mention mapping failure retries instead of committing an inert false negative", async () => {
  const fixture = await seedFixture("public", "slack");
  const providerUsergroupId = "SRETRY123";
  await enqueue(fixture, "event-agent-mention-retry", {
    ...payload(fixture, "provider-message-agent-mention-retry"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [{ providerUsergroupId, handle: "retry-agent" }],
    content: `<!subteam^${providerUsergroupId}|@retry-agent> retry me`,
  });
  assert.deepEqual(await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() { return null; },
  })), {
    kind: "blocked",
    eventId: (await fixture.db.select({ id: externalInboundEvents.id })
      .from(externalInboundEvents))[0]!.id,
    reason: "provider_agent_mention_unavailable",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);

  assert.equal((await process(fixture, dependencies(fixture, {
    now: () => new Date(NOW.getTime() + 31_000),
    async resolveProviderAgentMentionHandles() {
      return [{ agentId: fixture.agent.id, providerUsergroupId, handle: "retry-agent" }];
    },
  }))).kind, "committed");
  assert.equal((await fixture.db.select().from(messageMentions)).length, 1);
});

test("Slack typed @name text mentions bound-channel Agents and humans without a usergroup", async () => {
  const fixture = await seedFixture("public", "slack");
  const [outsideAgent] = await fixture.db.insert(agents).values({
    serverId: fixture.server.id,
    name: `outside-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  const content = [
    `@${fixture.agent.name.toUpperCase()} please look`,
    `and @${fixture.agent.name}的 note`,
    `cc @${fixture.member.name}`,
    `@${outsideAgent.name} is not in this channel`,
    `\`@${fixture.owner.name}\` in code`,
    `mail me@${fixture.owner.name}`,
    "@alice stays text",
  ].join("; ");
  await enqueue(fixture, "event-plain-text-mention", {
    ...payload(fixture, "provider-message-plain-text-mention"),
    content,
  });
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  const [stored] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(stored?.content, content, "typed text is stored as written");
  const mentions = await fixture.db.select().from(messageMentions);
  assert.deepEqual(mentions.map((mention) => ({
    messageId: mention.messageId,
    targetType: mention.targetType,
    targetId: mention.targetId,
    handleAtSendTime: mention.handleAtSendTime,
    notifiableAtSend: mention.notifiableAtSend,
  })).sort((left, right) => left.targetType.localeCompare(right.targetType)), [{
    messageId: stored?.id,
    targetType: "agent",
    targetId: fixture.agent.id,
    handleAtSendTime: fixture.agent.name,
    notifiableAtSend: true,
  }, {
    messageId: stored?.id,
    targetType: "user",
    targetId: fixture.member.id,
    handleAtSendTime: fixture.member.name,
    notifiableAtSend: true,
  }]);
});

test("Slack typed @name text shared by two channel members stays text", async () => {
  const fixture = await seedFixture("public", "slack");
  const shared = fixture.agent.name;
  await fixture.db.update(users).set({ name: shared.toUpperCase() })
    .where(eq(users.id, fixture.member.id));
  await enqueue(fixture, "event-plain-text-ambiguous", {
    ...payload(fixture, "provider-message-plain-text-ambiguous"),
    content: `@${shared.slice(0, 1).toUpperCase()}${shared.slice(1)} who?`,
  });
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  assert.equal((await fixture.db.select().from(messageMentions)).length, 0);
});

test("Slack typed @name text never matches Slack-encoded user or usergroup labels", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "event-slack-labels-not-plain-text", {
    ...payload(fixture, "provider-message-slack-labels-not-plain-text"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [{ providerUsergroupId: "SOTHER123", handle: fixture.agent.name }],
    content: `<@UHUMAN1|${fixture.agent.name}> and <!subteam^SOTHER123|@${fixture.agent.name}>`,
  });
  assert.equal((await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() { return []; },
  }))).kind, "committed");
  assert.equal((await fixture.db.select().from(messageMentions)).length, 0);
});

test("Slack usergroup and typed @name for the same Agent keep one mention", async () => {
  const fixture = await seedFixture("public", "slack");
  const providerUsergroupId = "SAGENTDUP1";
  await enqueue(fixture, "event-agent-mention-both-paths", {
    ...payload(fixture, "provider-message-agent-mention-both-paths"),
    schema: "external-inbound-normalized-event.v3",
    providerFileIds: [],
    providerAgentMentions: [{ providerUsergroupId, handle: fixture.agent.name }],
    content: `<!subteam^${providerUsergroupId}|@${fixture.agent.name}> and again @${fixture.agent.name}`,
  });
  assert.equal((await process(fixture, dependencies(fixture, {
    async resolveProviderAgentMentionHandles() {
      return [{ agentId: fixture.agent.id, providerUsergroupId, handle: fixture.agent.name }];
    },
  }))).kind, "committed");
  const mentions = await fixture.db.select().from(messageMentions);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]?.targetId, fixture.agent.id);
});

test("Slack mention rendering is bounded and provider-neutral content remains byte-identical", () => {
  const labels = new Map([["U1", `@${"x".repeat(80)}`]]);
  const pathological = "<@U1>".repeat(7_000);
  const rendered = renderSlackInboundMentionLabels(pathological, labels);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 40_000);
  assert.doesNotMatch(rendered, /U1/u);
  assert.equal(renderSlackInboundMentionLabels("ordinary provider content", labels), "ordinary provider content");
});

test("v2 file events stay non-canonical until provider bytes are stored, then link atomically", async () => {
  const fixture = await seedFixture("public", "slack");
  const fileBodies = new Map([
    ["provider-file-1", Buffer.from("first provider attachment", "utf8")],
    ["provider-file-2", Buffer.from("second provider attachment", "utf8")],
  ]);
  const filePayload: ExternalInboundNormalizedMessage = {
    ...payload(fixture, "provider-message-file-1"),
    schema: "external-inbound-normalized-event.v2",
    providerFileIds: [...fileBodies.keys()],
  };
  const admitted = await enqueue(fixture, "event-file-1", filePayload);
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: admitted.event.id,
    reason: "attachment_transfer_pending",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);
  const writes = new Map<string, Buffer>();
  const storage: StorageBackend = {
    async put(key, data) { writes.set(key, Buffer.from(data)); },
    async putStream(key, data, _contentType, contentLength) {
      const chunks: Buffer[] = [];
      for await (const chunk of data) chunks.push(Buffer.from(chunk));
      const stored = Buffer.concat(chunks);
      assert.equal(stored.length, contentLength);
      writes.set(key, stored);
    },
    async get(key) {
      const value = writes.get(key);
      if (!value) throw new Error("missing");
      return Readable.from(value);
    },
    async delete(key) { writes.delete(key); },
  };
  const adapter: ExternalInboundAttachmentProviderAdapter<{ fileId: string }> = {
    provider: fixture.authority.provider,
    capabilities: {
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async inspectInboundAsset({ providerFileId }) {
      const body = fileBodies.get(providerFileId);
      if (!body) throw new Error("unknown fixture file");
      return {
        metadata: {
          providerFileId,
          sourceExternalActorId: fixture.actor.externalActorId,
          filename: `${providerFileId}.txt`,
          declaredSizeBytes: body.length,
          mimeType: "text/plain",
          providerCreatedAt: NOW,
        },
        downloadHandle: { fileId: providerFileId },
      };
    },
    async *downloadInboundAsset({ handle }) {
      yield fileBodies.get(handle.fileId)!;
    },
    classifyFailure() {
      return {
        class: "transient",
        reason: "fixture_failure",
        retryAfterMs: null,
        scope: "asset_global",
      };
    },
  };
  const attachmentDependencies = {
    storage,
    resolveAdapter: (provider: string) => provider === adapter.provider ? adapter : null,
    authorityIsCurrent: async (authority: { provider: string; bindingId: string; connectionEpoch: number }) => (
      authority.provider === fixture.authority.provider
      && authority.bindingId === fixture.authority.bindingId
      && authority.connectionEpoch === fixture.authority.connectionEpoch
    ),
    maximumFileSizeBytes: async () => 1024,
    now: () => NOW,
  };
  const firstMetadata = await processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: "attachment-worker-first-metadata",
    dependencies: attachmentDependencies,
  });
  assert.equal(firstMetadata.kind, "metadata_ready");
  const jobsAfterFirstMetadata = await fixture.db.select({
    id: externalAttachmentTransferJobs.id,
    providerFileId: externalAttachmentAssets.providerFileId,
    phase: externalAttachmentTransferJobs.phase,
  }).from(externalAttachmentTransferJobs).innerJoin(
    externalAttachmentAssets,
    eq(externalAttachmentAssets.id, externalAttachmentTransferJobs.assetId),
  );
  const delayedMetadataJob = jobsAfterFirstMetadata.find(
    (job) => job.phase === "metadata",
  );
  const waitingDownloadJob = jobsAfterFirstMetadata.find(
    (job) => job.phase === "download",
  );
  assert.ok(delayedMetadataJob && waitingDownloadJob);
  await fixture.db.update(externalAttachmentTransferJobs).set({
    state: "retry_wait",
    nextAttemptAt: new Date(NOW.getTime() + 30_000),
    lastErrorClass: "provider_attachment_credential_busy",
  }).where(eq(externalAttachmentTransferJobs.id, delayedMetadataJob.id));
  const waitingForBatchMetadata = await processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: "attachment-worker-waiting-download",
    dependencies: attachmentDependencies,
  });
  assert.equal(waitingForBatchMetadata.kind, "metadata_ready");
  const [pacedDownloadJob] = await fixture.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.id, waitingDownloadJob.id));
  assert.ok(pacedDownloadJob);
  assert.equal(pacedDownloadJob.state, "queued");
  assert.equal(
    pacedDownloadJob.nextAttemptAt.getTime(),
    NOW.getTime() + 31_000,
    "a batch peer awaiting metadata must yield instead of hot-looping on the shared credential",
  );
  await fixture.db.update(externalAttachmentTransferJobs).set({
    state: "queued",
    nextAttemptAt: NOW,
    lastErrorClass: null,
  }).where(eq(externalAttachmentTransferJobs.id, delayedMetadataJob.id));
  const readyAt = new Date(NOW.getTime() + 31_000);
  const readyAttachmentDependencies = { ...attachmentDependencies, now: () => readyAt };
  let storedCount = 0;
  for (let index = 0; index < fileBodies.size * 3 && storedCount < fileBodies.size; index += 1) {
    const transfer = await processExternalInboundAttachmentOnce({
      db: fixture.db,
      leaseOwner: `attachment-worker-${index + 1}`,
      dependencies: readyAttachmentDependencies,
    });
    assert.ok(transfer.kind === "metadata_ready" || transfer.kind === "stored");
    if (transfer.kind === "stored") storedCount += 1;
  }
  assert.equal(storedCount, fileBodies.size);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);
  const committedAt = new Date(NOW.getTime() + 30_000);
  const committed = await process(fixture, dependencies(fixture, { now: () => committedAt }));
  assert.equal(committed.kind, "committed");
  if (committed.kind !== "committed") assert.fail("expected file message commit");
  const linkedAttachments = await fixture.db.select().from(attachments)
    .where(eq(attachments.messageId, committed.messageId));
  assert.deepEqual(
    linkedAttachments.sort((left, right) => left.messagePosition! - right.messagePosition!)
      .map((attachment) => ({
        uploaderType: attachment.uploaderType,
        uploaderId: attachment.uploaderId,
        filename: attachment.filename,
        messagePosition: attachment.messagePosition,
      })),
    [...fileBodies.keys()].map((providerFileId, messagePosition) => ({
      uploaderType: "external_projection",
      uploaderId: fixture.actor.id,
      filename: `${providerFileId}.txt`,
      messagePosition,
    })),
  );
  const assets = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  assert.deepEqual(assets.map((asset) => asset.state), ["linked", "linked"]);
  assert.deepEqual(facts.map((fact) => fact.state), ["linked", "linked"]);
  assert.ok(facts.every((fact) => fact.messageLinkId));
  assert.deepEqual(jobs.map((job) => job.state), ["completed", "completed"]);
  assert.deepEqual(
    [...writes.values()].map((value) => value.toString("utf8")).sort(),
    [...fileBodies.values()].map((value) => value.toString("utf8")).sort(),
  );
  await enqueue(fixture, "edit-file-caption", editPayload(fixture, "provider-message-file-1", "1785758400.000004", "new caption"));
  assert.equal((await process(fixture, dependencies(fixture, { now: () => committedAt }))).kind, "committed");
  assert.deepEqual(await fixture.db.select().from(attachments).where(eq(attachments.messageId, committed.messageId)), linkedAttachments);
  assert.deepEqual(await fixture.db.select().from(externalAttachmentTransferJobs), jobs);
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.id, committed.messageId)))[0].content, "new caption");
});

test("the same actor can re-share one stored provider file without a second download or charge", async () => {
  const fixture = await seedFixture();
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.deliver(fixture.actor, "reshare-same-1");
  const second = await harness.deliver(fixture.actor, "reshare-same-2");
  assert.equal(first.transfer.kind, "stored");
  assert.equal(second.transfer.kind, "stored");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 2, streamWrites: 1 });
  assert.equal(harness.writes.size, 1);
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentUploadReservations)).length, 2);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(facts.length, 2);
  assert.ok(facts.every((fact) => fact.sourceActorProjectionId === fixture.actor.id));
  const projections = await fixture.db.select().from(attachments)
    .where(eq(attachments.objectId, (await fixture.db.select().from(attachmentObjects))[0]!.id));
  assert.equal(projections.length, 2);
  assert.ok(projections.every((projection) => (
    projection.uploaderId === fixture.actor.id
    && projection.uploaderType === "external_projection"
    && projection.messageId !== null
  )));
});

test("two queued occurrences elect one materializer across metadata A, metadata B, store A, reuse B", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "interleaved-a");
  const second = await harness.prepare(secondActor, "interleaved-b");

  assert.equal((await harness.processTransfer("interleaved-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("interleaved-2", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("interleaved-3", second.at)).kind, "stored");
  assert.equal((await harness.processTransfer(
    "interleaved-4",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");

  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  const projections = await fixture.db.select().from(attachments);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentUploadReservations)).length, 2);
  assert.equal(facts.length, 2);
  assert.equal(jobs.length, 2);
  assert.equal(projections.length, 2);
  assert.equal(asset.state, "linked");
  assert.equal(asset.materializationOwnerJobId, jobs.find((job) => (
    job.messageFactId === facts.find((fact) => fact.inboundEventId === first.admitted.event.id)!.id
  ))!.id);
  assert.ok(jobs.every((job) => job.state === "completed"));
  assert.ok(facts.every((fact) => fact.state === "linked"));
  assert.deepEqual(
    new Set(projections.map((projection) => projection.uploaderId)),
    new Set([fixture.actor.id, secondActor.id]),
  );
  assert.deepEqual(
    new Set(projections.map((projection) => projection.messageId)),
    new Set([
      (await fixture.db.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, first.admitted.event.id)))[0]!.committedMessageId,
      (await fixture.db.select().from(externalInboundEvents)
        .where(eq(externalInboundEvents.id, second.admitted.event.id)))[0]!.committedMessageId,
    ]),
  );
});

test("two workers racing queued occurrences still perform one materialization", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  await harness.prepare(fixture.actor, "concurrent-a");
  const second = await harness.prepare(secondActor, "concurrent-b");
  assert.equal((await harness.processTransfer("concurrent-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("concurrent-metadata-2", second.at)).kind, "metadata_ready");

  const raceAt = new Date(second.at.getTime() + 1_000);
  const raced = await Promise.all([
    harness.processTransfer("concurrent-store-a", raceAt),
    harness.processTransfer("concurrent-store-b", raceAt),
  ]);
  assert.ok(raced.every((result) => result.kind === "stored" || result.kind === "metadata_ready"));
  let facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  if (facts.some((fact) => fact.state === "pending")) {
    assert.equal((await harness.processTransfer(
      "concurrent-reuse",
      new Date(raceAt.getTime() + 1_000),
    )).kind, "stored");
    facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  }
  assert.ok(facts.every((fact) => fact.state === "stored"));
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(externalAttachmentAssets)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachments)).length, 2);
  assert.equal((await fixture.db.select().from(attachmentUploadReservations)).length, 2);
  assert.ok((await fixture.db.select().from(externalAttachmentTransferJobs))
    .every((job) => job.state === "completed"));
});

test("revoked owner occurrence hands frozen metadata to a valid waiter without poisoning the asset", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "owner-revoked-a");
  const second = await harness.prepare(secondActor, "owner-revoked-b");
  assert.equal((await harness.processTransfer("owner-revoked-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("owner-revoked-metadata-2", second.at)).kind, "metadata_ready");

  harness.revokeActor(fixture.actor.id);
  const revoked = await harness.processTransfer("owner-revoked-a", second.at);
  assert.equal(revoked.kind, "unavailable");
  assert.equal(revoked.kind === "unavailable" ? revoked.reason : null, "attachment_authority_revoked");
  const [transferredAsset] = await fixture.db.select().from(externalAttachmentAssets);
  const factsBeforeStore = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobsBeforeStore = await fixture.db.select().from(externalAttachmentTransferJobs);
  const waiterFact = factsBeforeStore.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const waiterJob = jobsBeforeStore.find((job) => job.messageFactId === waiterFact.id)!;
  assert.equal(transferredAsset.state, "metadata_ready");
  assert.equal(transferredAsset.materializationOwnerJobId, waiterJob.id);

  assert.equal((await harness.processTransfer(
    "owner-revoked-b",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");
  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.equal((await harness.commit(second.at)).kind, "committed");
  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(asset.state, "linked");
  assert.equal(asset.materializationOwnerJobId, waiterJob.id);
  assert.deepEqual(new Set(facts.map((fact) => fact.state)), new Set(["revoked", "linked"]));
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  const [firstEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, first.admitted.event.id));
  assert.ok(firstEvent.committedMessageId);
});

test("ownership can hand off repeatedly when successive occurrence actors are revoked", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const thirdActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  await harness.prepare(fixture.actor, "handoff-a");
  await harness.prepare(secondActor, "handoff-b");
  const third = await harness.prepare(thirdActor, "handoff-c");
  assert.equal((await harness.processTransfer("handoff-metadata-1", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("handoff-metadata-2", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("handoff-metadata-3", third.at)).kind, "metadata_ready");

  harness.revokeActor(fixture.actor.id);
  assert.equal((await harness.processTransfer("handoff-revoked-a", third.at)).kind, "unavailable");
  harness.revokeActor(secondActor.id);
  const afterFirstHandoff = new Date(third.at.getTime() + 1_000);
  assert.equal((await harness.processTransfer("handoff-revoked-b", afterFirstHandoff)).kind, "unavailable");
  assert.equal((await harness.processTransfer(
    "handoff-valid-c",
    new Date(afterFirstHandoff.getTime() + 1_000),
  )).kind, "stored");

  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  const thirdFact = facts.find((fact) => fact.inboundEventId === third.admitted.event.id)!;
  const thirdJob = jobs.find((job) => job.messageFactId === thirdFact.id)!;
  assert.equal(asset.state, "stored");
  assert.equal(asset.materializationOwnerJobId, thirdJob.id);
  assert.deepEqual(facts.map((fact) => fact.state).sort(), ["revoked", "revoked", "stored"]);
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 4, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
});

test("handoff skips a future retry waiter so a runnable occurrence materializes immediately", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const thirdActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "retry-handoff-a");
  const second = await harness.prepare(secondActor, "retry-handoff-b");
  const third = await harness.prepare(thirdActor, "retry-handoff-c");
  assert.equal((await harness.processTransfer("retry-handoff-metadata-1", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("retry-handoff-metadata-2", third.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("retry-handoff-metadata-3", third.at)).kind, "metadata_ready");

  const factsBeforeHandoff = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobsBeforeHandoff = await fixture.db.select().from(externalAttachmentTransferJobs);
  const secondFact = factsBeforeHandoff.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const thirdFact = factsBeforeHandoff.find((fact) => fact.inboundEventId === third.admitted.event.id)!;
  const secondJob = jobsBeforeHandoff.find((job) => job.messageFactId === secondFact.id)!;
  const thirdJob = jobsBeforeHandoff.find((job) => job.messageFactId === thirdFact.id)!;
  const retryAt = new Date(third.at.getTime() + 24 * 60 * 60 * 1_000);
  await fixture.db.update(externalAttachmentTransferJobs).set({
    state: "retry_wait",
    nextAttemptAt: retryAt,
    lastErrorClass: "provider_rate_limited",
    updatedAt: third.at,
  }).where(eq(externalAttachmentTransferJobs.id, secondJob.id));

  harness.revokeActor(fixture.actor.id);
  const handoffAt = third.at;
  assert.equal((await harness.processTransfer("retry-handoff-revoked-a", handoffAt)).kind, "unavailable");
  const [handedOffAsset] = await fixture.db.select().from(externalAttachmentAssets);
  const [preservedRetry] = await fixture.db.select().from(externalAttachmentTransferJobs)
    .where(eq(externalAttachmentTransferJobs.id, secondJob.id));
  assert.equal(handedOffAsset.materializationOwnerJobId, thirdJob.id);
  assert.equal(preservedRetry.state, "retry_wait");
  assert.equal(preservedRetry.nextAttemptAt.getTime(), retryAt.getTime());

  assert.equal((await harness.processTransfer("retry-handoff-zero-eligible", handoffAt)).kind, "empty");
  assert.equal((await harness.processTransfer(
    "retry-handoff-runnable-c",
    new Date(handoffAt.getTime() + 1_000),
  )).kind, "stored");
  assert.equal((await harness.processTransfer(
    "retry-handoff-due-b",
    new Date(retryAt.getTime() + 1_000),
  )).kind, "stored");

  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const firstFact = facts.find((fact) => fact.inboundEventId === first.admitted.event.id)!;
  const secondFinalFact = facts.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const thirdFinalFact = facts.find((fact) => fact.inboundEventId === third.admitted.event.id)!;
  assert.equal(firstFact.state, "revoked");
  assert.equal(secondFinalFact.state, "stored");
  assert.equal(thirdFinalFact.state, "stored");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 4, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
});

test("an unowned metadata-ready asset can be claimed by a future occurrence", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "future-owner-a");
  assert.equal((await harness.processTransfer("future-owner-metadata-a", first.at)).kind, "metadata_ready");
  harness.revokeActor(fixture.actor.id);
  assert.equal((await harness.processTransfer("future-owner-revoked-a", first.at)).kind, "unavailable");
  const [unowned] = await fixture.db.select().from(externalAttachmentAssets);
  assert.equal(unowned.state, "metadata_ready");
  assert.equal(unowned.materializationOwnerJobId, null);

  const second = await harness.prepare(secondActor, "future-owner-b");
  assert.equal((await harness.processTransfer("future-owner-metadata-b", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("future-owner-store-b", second.at)).kind, "stored");
  const [claimed] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const jobs = await fixture.db.select().from(externalAttachmentTransferJobs);
  const secondFact = facts.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  const secondJob = jobs.find((job) => job.messageFactId === secondFact.id)!;
  assert.equal(claimed.state, "stored");
  assert.equal(claimed.materializationOwnerJobId, secondJob.id);
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 3, streamWrites: 1 });
});

test("authority loss after owner PUT leaves its cleanup intent and lets the waiter publish a new object", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "post-put-revoked-a");
  const second = await harness.prepare(secondActor, "post-put-revoked-b");
  assert.equal((await harness.processTransfer("post-put-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("post-put-metadata-2", second.at)).kind, "metadata_ready");

  harness.revokeActorAfterNextPut(fixture.actor.id);
  assert.equal((await harness.processTransfer("post-put-owner", second.at)).kind, "unavailable");
  assert.equal((await harness.processTransfer(
    "post-put-waiter",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");

  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  const firstFact = facts.find((fact) => fact.inboundEventId === first.admitted.event.id)!;
  const secondFact = facts.find((fact) => fact.inboundEventId === second.admitted.event.id)!;
  assert.equal(await externalInboundAttachmentIntentState(fixture.db, firstFact.id), "planned");
  assert.equal(await externalInboundAttachmentIntentState(fixture.db, secondFact.id), "completed");
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.equal((await fixture.db.select().from(attachments)).length, 1);
  assert.deepEqual(harness.counters(), { downloads: 2, inspections: 4, streamWrites: 2 });
  assert.equal(harness.writes.size, 2, "the failed owner's distinct planned artifact remains cleanup-owned");
});

test("owner server-plan rejection transfers materialization to an eligible server", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const secondTarget = await seedSecondServerOccurrence(fixture, secondActor);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.prepare(fixture.actor, "plan-small-a");
  const second = await harness.prepare(secondActor, "plan-large-b", secondTarget);
  assert.equal((await harness.processTransfer("plan-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("plan-metadata-2", second.at)).kind, "metadata_ready");

  harness.setMaximum(fixture.server.id, 1);
  const rejected = await harness.processTransfer("plan-small-owner", second.at);
  assert.equal(rejected.kind, "unavailable");
  assert.equal(rejected.kind === "unavailable" ? rejected.reason : null, "recipient_plan_file_limit_exceeded");
  assert.equal((await harness.processTransfer(
    "plan-large-waiter",
    new Date(second.at.getTime() + 1_000),
  )).kind, "stored");
  assert.equal((await harness.commit(second.at, fixture)).kind, "committed");
  assert.equal((await harness.commit(second.at, secondTarget)).kind, "committed");

  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(asset.state, "linked");
  assert.deepEqual(new Set(facts.map((fact) => fact.state)), new Set(["unavailable", "linked"]));
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 4, streamWrites: 1 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  const [firstEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, first.admitted.event.id));
  const [secondEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, second.admitted.event.id));
  assert.ok(firstEvent.committedMessageId);
  assert.ok(secondEvent.committedMessageId);
});

test("provider-file global failure is decided once and all queued occurrences converge unavailable", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  await harness.prepare(fixture.actor, "global-failure-a");
  const second = await harness.prepare(secondActor, "global-failure-b");
  assert.equal((await harness.processTransfer("global-metadata-1", second.at)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("global-metadata-2", second.at)).kind, "metadata_ready");

  harness.failInspection("provider_file_not_found");
  const ownerFailure = await harness.processTransfer("global-owner", second.at);
  assert.equal(ownerFailure.kind, "unavailable");
  const waiterFailure = await harness.processTransfer(
    "global-waiter",
    new Date(second.at.getTime() + 1_000),
  );
  assert.equal(waiterFailure.kind, "unavailable");
  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(asset.state, "failed");
  assert.equal(asset.terminalFailureClass, "provider_file_not_found");
  assert.ok(facts.every((fact) => fact.state === "unavailable"));
  assert.ok(facts.every((fact) => fact.terminalFailureClass === "provider_file_not_found"));
  assert.deepEqual(harness.counters(), { downloads: 0, inspections: 3, streamWrites: 0 });
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 0);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 0);
  assert.equal((await harness.commit(second.at)).kind, "committed");
  assert.equal((await harness.commit(second.at)).kind, "committed");
});

test("a different actor gets an occurrence-owned projection and later failure cannot poison shared bytes", async () => {
  const fixture = await seedFixture();
  const secondActor = await seedSecondExternalActor(fixture);
  const harness = await createInboundFileHarness(fixture);
  const first = await harness.deliver(fixture.actor, "reshare-distinct-1");
  const second = await harness.deliver(secondActor, "reshare-distinct-2");
  assert.equal(first.transfer.kind, "stored");
  assert.equal(second.transfer.kind, "stored");
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 2, streamWrites: 1 });

  const [asset] = await fixture.db.select().from(externalAttachmentAssets);
  const facts = await fixture.db.select().from(externalAttachmentMessageFacts);
  assert.equal(facts.length, 2);
  assert.deepEqual(
    new Set(facts.map((fact) => fact.sourceActorProjectionId)),
    new Set([fixture.actor.id, secondActor.id]),
  );
  const projections = await fixture.db.select().from(attachments);
  assert.equal(projections.length, 2);
  assert.ok(projections.every((projection) => projection.objectId === asset.raftObjectId));
  assert.deepEqual(
    new Set(projections.map((projection) => projection.uploaderId)),
    new Set([fixture.actor.id, secondActor.id]),
  );

  harness.revokeActor(secondActor.id);
  const failed = await harness.deliver(secondActor, "reshare-distinct-failed");
  assert.equal(failed.transfer.kind, "unavailable");
  const [preservedAsset] = await fixture.db.select().from(externalAttachmentAssets);
  assert.equal(preservedAsset.id, asset.id);
  assert.equal(preservedAsset.state, "linked");
  assert.equal(preservedAsset.raftObjectId, asset.raftObjectId);
  assert.equal(preservedAsset.sourceContentDigest, asset.sourceContentDigest);
  const firstProjection = projections.find((projection) => projection.uploaderId === fixture.actor.id)!;
  const [stillLinked] = await fixture.db.select().from(attachments)
    .where(eq(attachments.id, firstProjection.id));
  assert.equal(stillLinked.messageId, firstProjection.messageId);
  assert.equal((await fixture.db.select().from(attachmentObjects)).length, 1);
  assert.equal((await fixture.db.select().from(attachmentObjectCharges)).length, 1);
  assert.deepEqual(harness.counters(), { downloads: 1, inspections: 2, streamWrites: 1 });
});

for (const provider of ["provider-test", "slack"] as const) {
test(`a terminal ${provider} file failure keeps the body and one unavailable marker without a fake attachment`, async () => {
  const fixture = await seedFixture("public", provider);
  const originalContent = provider === "slack" ? "中".repeat(15_000) : "original body";
  const filePayload: ExternalInboundNormalizedMessage = {
    ...payload(fixture, "provider-message-file-missing", null, originalContent),
    schema: "external-inbound-normalized-event.v2",
    providerFileIds: ["provider-file-missing"],
  };
  const admitted = await enqueue(fixture, "event-file-missing", filePayload);
  const pending = await process(fixture);
  assert.equal(pending.kind, "blocked");
  const adapter: ExternalInboundAttachmentProviderAdapter<never> = {
    provider: fixture.authority.provider,
    capabilities: {
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1024,
    },
    async inspectInboundAsset() { throw new Error("missing"); },
    async *downloadInboundAsset() { throw new Error("must not download"); },
    classifyFailure() {
      return {
        class: "deterministic",
        reason: "provider_file_not_found",
        retryAfterMs: null,
        scope: "asset_global",
      };
    },
  };
  const storage: StorageBackend = {
    async put() { assert.fail("must not store"); },
    async putStream() { assert.fail("must not store"); },
    async get() { throw new Error("must not read"); },
    async delete() {},
  };
  const unavailable = await processExternalInboundAttachmentOnce({
    db: fixture.db,
    leaseOwner: "attachment-worker-missing",
    dependencies: {
      storage,
      resolveAdapter: () => adapter,
      authorityIsCurrent: async () => true,
      maximumFileSizeBytes: async () => 1024,
      now: () => NOW,
    },
  });
  if (unavailable.kind === "metadata_ready") {
    assert.fail("missing provider file must fail during metadata inspection");
  }
  assert.equal(unavailable.kind, "unavailable");
  if (unavailable.kind !== "unavailable") assert.fail("expected unavailable attachment");
  assert.equal(unavailable.reason, "provider_file_not_found");
  const committed = await process(fixture, dependencies(fixture, {
    now: () => new Date(NOW.getTime() + 30_000),
  }));
  assert.equal(committed.kind, "committed");
  if (committed.kind !== "committed") assert.fail("expected unavailable file message commit");
  const [message] = await fixture.db.select().from(messages)
    .where(eq(messages.id, committed.messageId));
  assert.ok(message.content === `${originalContent}\n\n[One or more attachments unavailable]`,
    "the complete original body and marker must survive together");
  assert.equal((await fixture.db.select().from(attachments)
    .where(eq(attachments.messageId, committed.messageId))).length, 0);
  const [fact] = await fixture.db.select().from(externalAttachmentMessageFacts)
    .where(eq(externalAttachmentMessageFacts.inboundEventId, admitted.event.id));
  assert.equal(fact.state, "unavailable");
  assert.equal(fact.terminalFailureClass, "provider_file_not_found");
  assert.ok(fact.messageLinkId);
});
}

test("top-level Joint inbound keeps local authority but commits only to canonical storage", async () => {
  const fixture = await seedFixture("public");
  const [storageServer] = await fixture.db.insert(servers).values({
    name: "External inbound Joint storage",
    slug: `external-inbound-storage-${randomUUID()}`,
    ownerId: fixture.owner.id,
  }).returning();
  const [canonical] = await fixture.db.insert(channels).values({
    serverId: storageServer.id,
    name: `external-inbound-canonical-${randomUUID()}`,
    type: "channel",
  }).returning();
  await fixture.db.update(channels).set({ type: "joint" })
    .where(eq(channels.id, fixture.channel.id));
  const [joint] = await fixture.db.insert(jointChannels).values({
    canonicalChannelId: canonical.id,
    createdByServerId: fixture.server.id,
    createdByUserId: fixture.owner.id,
  }).returning();
  await fixture.db.insert(jointChannelServers).values({
    jointChannelId: joint.id,
    serverId: fixture.server.id,
    localChannelId: fixture.channel.id,
    role: "host",
    joinedByUserId: fixture.owner.id,
  });

  const admitted = await enqueue(fixture, "event-joint-1", payload(fixture, "provider-joint-message-1"));
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  assert.equal(result.eventId, admitted.event.id);
  const [projected] = await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"));
  assert.equal(projected!.channelId, canonical.id);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.channelId, fixture.channel.id))).length, 0);

  await fixture.db.update(jointChannelServers).set({ role: "participant" })
    .where(eq(jointChannelServers.localChannelId, fixture.channel.id));
  await enqueue(fixture, "event-joint-participant", payload(fixture, "provider-joint-message-2"));
  const rejected = await process(fixture);
  assert.deepEqual(rejected, {
    kind: "blocked",
    eventId: (await fixture.db.select().from(externalInboundEvents)
      .where(eq(externalInboundEvents.providerEventId, "event-joint-participant")))[0]!.id,
    reason: "commit_authority_lost_or_root_unavailable",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 1);
});

test("provider event replay is exact and conflicting frozen authority fails closed", async () => {
  const fixture = await seedFixture();
  const body = payload(fixture, "provider-message-1");
  const [left, right] = await Promise.all([
    enqueue(fixture, "event-1", body),
    enqueue(fixture, "event-1", body),
  ]);
  const [first, replay] = left.duplicate ? [right, left] : [left, right];
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.id, first.event.id);
  await assert.rejects(
    enqueueExternalInboundEvent({
      db: fixture.db,
      authority: { ...fixture.authority, connectionEpoch: fixture.authority.connectionEpoch + 1 },
      providerEventId: "event-1",
      normalizedPayloadDigest: digest(first.plaintext),
      encryptedPayload: first.plaintext,
      envelopeKeyId: "opaque-envelope-key-1",
      payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
      receivedAt: NOW,
    }),
    /conflicts with frozen admission/,
  );
  assert.equal((await fixture.db.select().from(externalInboundEvents)).length, 1);
});

test("sealed payload parsing is closed, UTC-canonical, and binds privacy in AAD", async () => {
  const fixture = await seedFixture("private");
  const validBody = payload(fixture, "provider-message-aad");
  const admitted = await enqueue(fixture, "event-aad", validBody);
  let observedPrivacyClass: "public" | "private" | null = null;
  const committed = await process(fixture, dependencies(fixture, {
    decrypt: async (args) => {
      observedPrivacyClass = args.aad.privacyClass;
      return admitted.plaintext;
    },
  }));
  assert.equal(committed.kind, "committed");
  assert.equal(observedPrivacyClass, "private");

  const unknownFieldBody = { ...payload(fixture, "provider-message-unknown"), providerRawPayload: "must-not-cross" };
  const plaintext = JSON.stringify(unknownFieldBody);
  const [event] = await fixture.db.insert(externalInboundEvents).values({
    ...fixture.authority,
    providerEventId: "event-unknown",
    normalizedPayloadDigest: digest(plaintext),
    encryptedPayload: plaintext,
    envelopeKeyId: "opaque-envelope-key-2",
    payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
    receivedAt: NOW,
    updatedAt: NOW,
  }).returning();
  const rejected = await process(fixture);
  assert.deepEqual(rejected, { kind: "blocked", eventId: event.id, reason: "payload_invalid" });
  const [quarantined] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, event.id));
  assert.equal(quarantined.status, "quarantined");
  assert.equal(quarantined.encryptedPayload, null);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.content, unknownFieldBody.content))).length, 0);

  const nonCanonicalTimeBody = {
    ...payload(fixture, "provider-message-noncanonical-time"),
    createdAt: "2026-08-03T11:59:00Z",
  };
  const nonCanonicalPlaintext = JSON.stringify(nonCanonicalTimeBody);
  const [nonCanonicalEvent] = await fixture.db.insert(externalInboundEvents).values({
    ...fixture.authority,
    providerEventId: "event-noncanonical-time",
    normalizedPayloadDigest: digest(nonCanonicalPlaintext),
    encryptedPayload: nonCanonicalPlaintext,
    envelopeKeyId: "opaque-envelope-key-3",
    payloadExpiresAt: new Date(NOW.getTime() + 5 * 60_000),
    receivedAt: NOW,
    updatedAt: NOW,
  }).returning();
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: nonCanonicalEvent.id,
    reason: "payload_invalid",
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.content, nonCanonicalTimeBody.content))).length, 0);
});

test("inbound schema rejects impossible processing and false terminal evidence", async () => {
  const fixture = await seedFixture();
  const admitted = await enqueue(fixture, "event-shape", payload(fixture, "provider-shape"));
  const [existingMessage] = await fixture.db.insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    messageType: "chat",
    content: "existing canonical message",
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await assert.rejects(
    fixture.db.update(externalInboundEvents).set({ status: "processing" })
      .where(eq(externalInboundEvents.id, admitted.event.id)),
  );
  await assert.rejects(
    fixture.db.update(externalInboundEvents).set({ provider: "p".repeat(81) })
      .where(eq(externalInboundEvents.id, admitted.event.id)),
  );
  await assert.rejects(
    fixture.db.update(externalInboundEvents).set({
      status: "committed",
      committedMessageId: existingMessage.id,
    }).where(eq(externalInboundEvents.id, admitted.event.id)),
  );
  await assert.rejects(fixture.db.execute(sql`
    UPDATE external_inbound_events
    SET status = 'future_state',
        encrypted_payload = NULL,
        envelope_key_id = NULL,
        payload_expires_at = NULL,
        payload_erased_at = ${NOW},
        payload_tombstone_digest = ${"a".repeat(64)}
    WHERE id = ${admitted.event.id}
  `));
  const [event] = await fixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "queued");
  assert.ok(event.encryptedPayload);
  assert.equal(event.committedMessageId, null);
});

test("provider message replay becomes a terminal duplicate with zero second canonical message", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-1", payload(fixture, "provider-message-1"));
  const first = await process(fixture);
  assert.equal(first.kind, "committed");
  await enqueue(fixture, "event-2", payload(fixture, "provider-message-1"));
  const replay = await process(fixture);
  assert.equal(replay.kind, "duplicate");
  assert.equal(replay.messageId, first.messageId);
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageAuthorFacts)).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
});

test("a committed provider message publishes realtime once while notification failure never replays persistence", async () => {
  const fixture = await seedFixture();
  const published: { eventId: string; messageId: string }[] = [];
  const errors: unknown[] = [];
  const deps = dependencies(fixture, {
    async onMessageCommitted(input) {
      published.push(input);
      if (published.length === 2) throw new Error("socket unavailable");
    },
    onMessageCommittedError(error) {
      errors.push(error);
    },
  });

  const firstAdmission = await enqueue(fixture, "event-realtime-1", payload(fixture, "provider-realtime-1"));
  const first = await process(fixture, deps);
  assert.equal(first.kind, "committed");
  assert.deepEqual(published, [{ eventId: firstAdmission.event.id, messageId: first.messageId }]);

  await enqueue(fixture, "event-realtime-duplicate", payload(fixture, "provider-realtime-1"));
  const duplicate = await process(fixture, deps);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(published.length, 1, "provider replay must not emit a duplicate realtime message");

  const secondAdmission = await enqueue(fixture, "event-realtime-2", payload(fixture, "provider-realtime-2"));
  const second = await process(fixture, deps);
  assert.equal(second.kind, "committed", "socket failure must not roll back the canonical commit");
  assert.deepEqual(published[1], { eventId: secondAdmission.event.id, messageId: second.messageId });
  assert.equal(errors.length, 1);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 2);
  const [secondEvent] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, secondAdmission.event.id));
  assert.equal(secondEvent.status, "committed");
});

test("provider message identity with a different payload is quarantined instead of hidden as duplicate", async () => {
  const fixture = await seedFixture();
  const firstBody = payload(fixture, "provider-message-conflict");
  await enqueue(fixture, "event-conflict-1", firstBody);
  const first = await process(fixture);
  assert.equal(first.kind, "committed");

  const conflictingBody = {
    ...firstBody,
    content: "different content under the same provider message identity",
  };
  const admitted = await enqueue(fixture, "event-conflict-2", conflictingBody);
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: admitted.event.id,
    reason: "provider_message_payload_conflict",
  });

  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageAuthorFacts)).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
  assert.equal((await fixture.db.select().from(inboxNotificationFacts)).length, 3);
  const [event] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, admitted.event.id));
  assert.equal(event.status, "quarantined");
  assert.equal(event.outcomeReason, "provider_message_payload_conflict");
  assert.equal(event.committedMessageId, null);
  assert.equal(event.encryptedPayload, null);
  assert.ok(event.payloadErasedAt);
  assert.match(event.payloadTombstoneDigest ?? "", /^[0-9a-f]{64}$/);
});

test("accepted outbound provider identity is terminalized as an echo without a second canonical message", async () => {
  const fixture = await seedFixture();
  const [sourceMessage] = await fixture.db.insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: fixture.owner.id,
    messageType: "chat",
    content: "source already dispatched outbound",
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await fixture.db.insert(externalMessageLinks).values({
    provider: fixture.authority.provider,
    installId: fixture.authority.installId,
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerConversationId: fixture.authority.providerConversationId,
    providerMessageId: "provider-outbound-echo",
    providerThreadId: null,
    bindingId: fixture.authority.bindingId,
    bindingEpoch: fixture.authority.bindingEpoch,
    connectionEpoch: fixture.authority.connectionEpoch,
    raftMessageId: sourceMessage.id,
    raftCanonicalRootMessageId: null,
    firstDirection: "raft_outbound",
    payloadFingerprint: "b".repeat(64),
    outcomeState: "accepted",
    authorityState: "active",
    stateReason: "provider_accepted",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const admitted = await enqueue(
    fixture,
    "event-outbound-echo",
    payload(fixture, "provider-outbound-echo"),
  );

  assert.deepEqual(await process(fixture), {
    kind: "echo",
    eventId: admitted.event.id,
    messageId: sourceMessage.id,
  });
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.senderType, "external_projection"))).length, 0);
  const [event] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, admitted.event.id));
  assert.equal(event.status, "echo");
  assert.equal(event.encryptedPayload, null);
  assert.equal(event.committedMessageId, sourceMessage.id);
});

test("canonical commit failpoint rolls message, author, link, inbox, and terminal erase back together", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-1", payload(fixture, "provider-message-1"));
  let clock = NOW;
  const workerDependencies = dependencies(fixture, { now: () => clock });
  __setExternalInboundCanonicalCommitHookForTests(() => {
    throw new Error("after-inbox atomic failpoint");
  });
  assert.deepEqual(await process(fixture, workerDependencies), {
    kind: "blocked",
    eventId: (await fixture.db.select().from(externalInboundEvents))[0]?.id,
    reason: "canonical_commit_failed",
  });
  assert.deepEqual({
    projectedMessages: (await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length,
    authors: (await fixture.db.select().from(externalMessageAuthorFacts)).length,
    links: (await fixture.db.select().from(externalMessageLinks)).length,
    inbox: (await fixture.db.select().from(inboxNotificationFacts)).length,
  }, { projectedMessages: 0, authors: 0, links: 0, inbox: 0 });
  const [event] = await fixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "queued");
  assert.ok(event.encryptedPayload);
  assert.equal(event.leaseOwner, null);

  __setExternalInboundCanonicalCommitHookForTests(null);
  clock = new Date(NOW.getTime() + 30_000);
  assert.equal((await process(fixture, workerDependencies)).kind, "committed");
});

test("runtime mismatch and revoked actor each commit zero message/link/inbox residue", async () => {
  const mismatch = await seedFixture();
  await enqueue(mismatch, "event-runtime", payload(mismatch, "provider-message-runtime"));
  let clock = NOW;
  const mismatchResult = await process(mismatch, dependencies(mismatch, {
    now: () => clock,
    runtime: { ...mismatch.authority, runtimeRevision: "runtime-r2" },
  }));
  assert.equal(mismatchResult.kind, "blocked");
  assert.equal(mismatchResult.reason, "runtime_authority_inactive_or_mismatched");
  assert.equal((await mismatch.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await mismatch.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await mismatch.db.select().from(inboxNotificationFacts)).length, 0);
  assert.equal((await mismatch.db.select().from(externalInboundEvents))[0]?.status, "queued");

  await mismatch.db.update(externalActorProjections).set({ state: "tombstoned" })
    .where(eq(externalActorProjections.id, mismatch.actor.id));
  clock = new Date(NOW.getTime() + 30_000);
  const revokedResult = await process(mismatch, dependencies(mismatch, { now: () => clock }));
  assert.equal(revokedResult.kind, "blocked");
  assert.equal(revokedResult.reason, "external_actor_authority_revoked");
  const [revokedEvent] = await mismatch.db.select().from(externalInboundEvents);
  assert.equal(revokedEvent.status, "revoked");
  assert.equal(revokedEvent.encryptedPayload, null);
  assert.equal((await mismatch.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await mismatch.db.select().from(externalMessageAuthorFacts)).length, 0);
  assert.equal((await mismatch.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await mismatch.db.select().from(inboxNotificationFacts)).length, 0);
});

test("freshness-only audience refresh does not revoke an already-enqueued actor event", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-freshness-refresh", payload(fixture, "provider-message-freshness-refresh"));

  const projectionRevision = slackActorProjectionRevisionAfterRefresh(fixture.actor, {
    id: fixture.actor.externalActorId,
    displayName: fixture.actor.displayName,
    handle: "alice",
    actorKind: "human",
  });
  await fixture.db.update(externalActorProjections).set({
    projectionRevision,
    observedAt: new Date(NOW.getTime() + 1_000),
    updatedAt: new Date(NOW.getTime() + 1_000),
  }).where(eq(externalActorProjections.id, fixture.actor.id));

  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 1);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 1);
  assert.equal((await fixture.db.select().from(externalInboundEvents))[0]?.status, "committed");
});

test("material audience actor refresh still revokes an event frozen at the previous revision", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-material-refresh", payload(fixture, "provider-message-material-refresh"));

  const projectionRevision = slackActorProjectionRevisionAfterRefresh(fixture.actor, {
    id: fixture.actor.externalActorId,
    displayName: "External Alice Renamed",
    handle: "alice",
    actorKind: "human",
  });
  await fixture.db.update(externalActorProjections).set({
    displayName: "External Alice Renamed",
    projectionRevision,
    observedAt: new Date(NOW.getTime() + 1_000),
    updatedAt: new Date(NOW.getTime() + 1_000),
  }).where(eq(externalActorProjections.id, fixture.actor.id));

  const result = await process(fixture);
  assert.equal(result.kind, "blocked");
  assert.equal(result.reason, "external_actor_authority_revoked");
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await fixture.db.select().from(externalMessageLinks)).length, 0);
  assert.equal((await fixture.db.select().from(externalInboundEvents))[0]?.status, "revoked");
});

test("a blocked oldest event backs off so a newer eligible event commits, then remains retryable", async () => {
  const fixture = await seedFixture();
  const blocked = await enqueue(fixture, "event-blocked", payload(fixture, "provider-message-blocked"));
  let clock = NOW;
  let advanceFirstBlockedResolution = true;
  const workerDependencies: ExternalInboundWorkerDependencies = {
    now: () => clock,
    async decryptNormalizedPayload({ ciphertext }) {
      return ciphertext;
    },
    async resolveCurrentRuntime({ eventId }) {
      if (eventId !== blocked.event.id) return fixture.authority;
      if (advanceFirstBlockedResolution) {
        advanceFirstBlockedResolution = false;
        clock = new Date(clock.getTime() + 31_000);
      }
      return null;
    },
  };

  assert.deepEqual(await process(fixture, workerDependencies), {
    kind: "blocked",
    eventId: blocked.event.id,
    reason: "runtime_authority_inactive_or_mismatched",
  });

  clock = new Date(clock.getTime() + 1_000);
  const newer = await enqueue(
    fixture,
    "event-newer",
    payload(fixture, "provider-message-newer"),
    clock,
  );
  const committed = await process(fixture, workerDependencies);
  assert.equal(committed.kind, "committed");
  assert.equal(committed.eventId, newer.event.id);

  const [blockedDuringBackoff] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, blocked.event.id));
  assert.equal(blockedDuringBackoff.status, "queued");
  assert.equal(blockedDuringBackoff.leaseGeneration, 1);

  clock = new Date(NOW.getTime() + 61_000);
  assert.deepEqual(await process(fixture, workerDependencies), {
    kind: "blocked",
    eventId: blocked.event.id,
    reason: "runtime_authority_inactive_or_mismatched",
  });
  const [retried] = await fixture.db.select().from(externalInboundEvents)
    .where(eq(externalInboundEvents.id, blocked.event.id));
  assert.equal(retried.status, "queued");
  assert.equal(retried.leaseGeneration, 2);
});

test("thread reply resolves only an exact accepted root and atomically creates the canonical thread", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "event-root", payload(fixture, "provider-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");

  await enqueue(fixture, "event-reply", payload(fixture, "provider-reply", "provider-root"));
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed");
  const [thread] = await fixture.db.select().from(channels).where(eq(channels.type, "thread"));
  assert.ok(thread);
  const [rootMessage] = await fixture.db.select().from(messages).where(eq(messages.id, root.messageId));
  const [replyMessage] = await fixture.db.select().from(messages).where(eq(messages.id, reply.messageId));
  assert.equal(rootMessage.threadId, thread.id);
  assert.equal(replyMessage.channelId, thread.id);
  const [replyLink] = await fixture.db.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.providerMessageId, "provider-reply"));
  assert.equal(replyLink.providerThreadId, "provider-root");
  assert.equal(replyLink.raftCanonicalRootMessageId, root.messageId);

  const before = (await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length;
  await enqueue(fixture, "event-wrong-root", payload(fixture, "provider-wrong-reply", "missing-root"));
  const blocked = await process(fixture);
  assert.equal(blocked.kind, "blocked");
  assert.equal(blocked.reason, "commit_authority_lost_or_root_unavailable");
  assert.equal((await fixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, before);
});

test("Joint inbound reply atomically materializes every active local thread face and canonical facts", async () => {
  const fixture = await seedFixture("public");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  await enqueue(fixture, "event-joint-root", payload(fixture, "provider-joint-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");

  await enqueue(
    fixture,
    "event-joint-reply",
    payload(fixture, "provider-joint-reply", "provider-joint-root"),
  );
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed");
  const [rootMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, root.messageId));
  assert.ok(rootMessage.threadId);
  const [canonicalThread] = await fixture.db.select().from(channels)
    .where(eq(channels.id, rootMessage.threadId));
  assert.equal(canonicalThread.type, "thread");
  assert.equal(canonicalThread.parentMessageId, root.messageId);
  assert.equal(canonicalThread.serverId, jointFixture.canonical.serverId);

  const [jointThread] = await fixture.db.select().from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, canonicalThread.id));
  assert.ok(jointThread);
  const threadProjections = await fixture.db.select({
    mapping: jointChannelServers,
    channel: channels,
  }).from(jointChannelServers)
    .innerJoin(channels, eq(channels.id, jointChannelServers.localChannelId))
    .where(eq(jointChannelServers.jointChannelId, jointThread.id));
  assert.equal(threadProjections.length, 2);
  assert.deepEqual(
    threadProjections.map(({ mapping, channel }) => ({
      serverId: mapping.serverId,
      role: mapping.role,
      type: channel.type,
      parentMessageId: channel.parentMessageId,
      deletedAt: channel.deletedAt,
    })).sort((left, right) => left.serverId.localeCompare(right.serverId)),
    [
      {
        serverId: fixture.server.id,
        role: "host",
        type: "thread",
        parentMessageId: null,
        deletedAt: null,
      },
      {
        serverId: jointFixture.participantServer.id,
        role: "participant",
        type: "thread",
        parentMessageId: null,
        deletedAt: null,
      },
    ].sort((left, right) => left.serverId.localeCompare(right.serverId)),
  );
  const [replyMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, reply.messageId));
  assert.equal(replyMessage.channelId, canonicalThread.id);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.channelId, threadProjections[0]!.channel.id))).length, 0);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.channelId, threadProjections[1]!.channel.id))).length, 0);
  const [replyLink] = await fixture.db.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.providerMessageId, "provider-joint-reply"));
  assert.equal(replyLink.raftCanonicalRootMessageId, root.messageId);
  assert.equal(replyLink.providerThreadId, "provider-joint-root");

  const facts = await fixture.db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, reply.messageId));
  assert.equal(facts.length, 0, "external authors do not mint Raft thread-follow authority");

  await enqueue(
    fixture,
    "event-joint-reply-duplicate",
    payload(fixture, "provider-joint-reply", "provider-joint-root"),
  );
  const duplicate = await process(fixture);
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.messageId, reply.messageId);
  assert.equal((await fixture.db.select().from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, canonicalThread.id))).length, 1);
  assert.equal((await fixture.db.select().from(jointChannelServers)
    .where(eq(jointChannelServers.jointChannelId, jointThread.id))).length, 2);
});

test("Joint inbound reply fails closed when any active parent face is unavailable", async () => {
  const fixture = await seedFixture("public");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  await enqueue(fixture, "event-joint-block-root", payload(fixture, "provider-joint-block-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");
  await fixture.db.update(channels).set({ archivedAt: NOW })
    .where(eq(channels.id, jointFixture.participant.id));

  const admitted = await enqueue(
    fixture,
    "event-joint-block-reply",
    payload(fixture, "provider-joint-block-reply", "provider-joint-block-root"),
  );
  assert.deepEqual(await process(fixture), {
    kind: "blocked",
    eventId: admitted.event.id,
    reason: "commit_authority_lost_or_root_unavailable",
  });
  const [rootMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, root.messageId));
  assert.equal(rootMessage.threadId, null);
  assert.equal((await fixture.db.select().from(messages)
    .where(eq(messages.content, "provider content provider-joint-block-reply"))).length, 0);
  assert.equal((await fixture.db.select().from(externalMessageLinks)
    .where(eq(externalMessageLinks.providerMessageId, "provider-joint-block-reply"))).length, 0);
  assert.equal((await fixture.db.select().from(channels)
    .where(eq(channels.type, "thread"))).length, 0);
});

test("lease expiry is sampled after the exact event row lock and stop abort leaves no lease residue", async () => {
  const expiryFixture = await seedFixture();
  await enqueue(expiryFixture, "event-expiry", payload(expiryFixture, "provider-expiry"));
  let clock = NOW;
  __setExternalInboundEventRowLockHookForTests(() => {
    clock = new Date(NOW.getTime() + 60_000);
  });
  const expired = await process(expiryFixture, dependencies(expiryFixture, { now: () => clock }));
  assert.equal(expired.kind, "blocked");
  assert.equal(expired.reason, "lease_expired_before_canonical_commit");
  assert.equal((await expiryFixture.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length, 0);
  assert.equal((await expiryFixture.db.select().from(externalInboundEvents))[0]?.status, "queued");
  __setExternalInboundEventRowLockHookForTests(null);
  clock = new Date(NOW.getTime() + 90_000);

  let decryptStarted!: () => void;
  const started = new Promise<void>((resolve) => { decryptStarted = resolve; });
  const runtime = createExternalInboundWorkerRuntime({
    db: expiryFixture.db,
    leaseOwner: "runtime-worker",
    intervalMs: 60_000,
    dependencies: dependencies(expiryFixture, {
      now: () => clock,
      decrypt: ({ signal }) => new Promise<string>((_resolve, reject) => {
        decryptStarted();
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }),
  });
  runtime.start();
  await started;
  await runtime.stop();
  const [event] = await expiryFixture.db.select().from(externalInboundEvents);
  assert.equal(event.status, "queued");
  assert.equal(event.leaseOwner, null);
  assert.equal(event.leaseExpiresAt, null);
  assert.ok(event.encryptedPayload);
});

test("inbound thread reply on an agent-authored root records the authored thread follow", async () => {
  const fixture = await seedFixture("public", "slack");
  // Agent posts the root inside Raft; the bridge then outbound-mirrored it, so
  // an accepted link rows exists. Provider reply lands on the canonical thread.
  const [agentRoot] = await fixture.db.insert(messages).values({
    channelId: fixture.channel.id,
    content: "agent root",
    senderType: "agent",
    senderId: fixture.agent.id,
    messageType: "chat",
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await fixture.db.insert(externalMessageLinks).values({
    provider: "slack",
    installId: fixture.authority.installId,
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerConversationId: fixture.authority.providerConversationId,
    providerMessageId: "provider-agent-root",
    bindingId: fixture.authority.bindingId,
    bindingEpoch: fixture.authority.bindingEpoch,
    connectionEpoch: fixture.authority.connectionEpoch,
    raftMessageId: agentRoot.id,
    raftCanonicalRootMessageId: agentRoot.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: digest("provider-agent-root"),
    outcomeState: "accepted",
    authorityState: "active",
    stateReason: "raft_outbound_committed",
  });

  await enqueue(
    fixture,
    "event-agent-root-reply",
    payload(fixture, "provider-reply-to-agent", "provider-agent-root"),
  );
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed");

  const [rootMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, agentRoot.id));
  assert.ok(rootMessage.threadId);
  const follows = await fixture.db.select().from(threadFollows)
    .where(eq(threadFollows.threadChannelId, rootMessage.threadId!));
  assert.equal(follows.length, 1);
  assert.equal(follows[0]!.followerType, "agent");
  assert.equal(follows[0]!.followerId, fixture.agent.id);
  assert.equal(follows[0]!.reason, "authored");

  const facts = await fixture.db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, reply.messageId));
  const agentFact = facts.find((fact) => fact.receiverType === "agent" && fact.receiverId === fixture.agent.id);
  assert.ok(agentFact, "agent parent author must be an unread-eligible receiver");
  assert.equal(agentFact!.unreadEligible, true);
});

test("picked Slack users never mint Raft mentions, even when linked; the bridge bot still addresses agents", async () => {
  const fixture = await seedFixture("public", "slack");
  await fixture.db.update(externalAppInstalls)
    .set({ botUserId: "UBOT" })
    .where(eq(externalAppInstalls.id, fixture.install.id));
  await fixture.db.insert(externalHumanIdentityLinks).values({
    serverId: fixture.server.id,
    installId: fixture.install.id,
    userId: fixture.member.id,
    provider: "slack",
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerUserId: "ULINKEDMEMBER",
    state: "active",
    linkEpoch: 1,
    observedConnectionEpoch: fixture.authority.connectionEpoch,
  });

  const mentionContent = "hey <@ULINKEDMEMBER> and <@UBOT> take a look <@UUNKNOWN>";
  await enqueue(
    fixture,
    "event-mention",
    payload(fixture, "provider-mention", null, mentionContent),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed");

  const rows = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, result.messageId!));
  const targets = rows.map((row) => `${row.targetType}:${row.targetId}`).sort();
  assert.deepEqual(targets, [
    `agent:${fixture.agent.id}`,
  ], "a Slack account is a Slack identity; the linked Raft member is not mentioned");
  for (const row of rows) {
    assert.equal(row.notifiableAtSend, true);
    assert.equal(row.source, "send_path");
  }
});

test("a Slack member picked in Slack is recorded as a display-only external mention, never a Raft mention", async () => {
  const fixture = await seedFixture("public", "slack");
  const slackActor = (externalActorId: string, displayName: string, handles: string[]) => ({
    provider: "slack",
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    externalActorId,
    displayName,
    handles,
    actorKind: "human" as const,
    state: "active" as const,
    deactivated: false,
    projectionRevision: 1,
    observedAt: NOW,
  });
  const [present, departed, unobserved] = await fixture.db.insert(externalActorProjections).values([
    slackActor("UPRESENT", "Ada Lovelace", ["ada"]),
    slackActor("UDEPARTED", "Grace Hopper", ["grace"]),
    slackActor("UUNOBSERVED", "Alan Turing", ["alan"]),
  ]).returning();
  const observation = (projectionId: string, state: "active" | "removed") => ({
    projectionId,
    provider: "slack",
    appRegistrationId: fixture.actor.appRegistrationId,
    installId: fixture.actor.installId,
    workspaceId: fixture.actor.workspaceId,
    connectionEpoch: fixture.authority.connectionEpoch,
    bindingId: fixture.authority.bindingId,
    bindingEpoch: fixture.authority.bindingEpoch,
    conversationId: fixture.authority.providerConversationId,
    memberRevision: 5,
    contextRevision: 5,
    state,
    observedAt: new Date(NOW.getTime() - 60_000),
    expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  });
  await fixture.db.insert(externalAddressabilityProjections).values([
    observation(present!.id, "active"),
    observation(departed!.id, "removed"),
  ]);

  await enqueue(
    fixture,
    "event-picked-slack-member",
    payload(fixture, "provider-picked-slack-member", null, "hi <@UPRESENT>, <@UDEPARTED> and <@UUNOBSERVED>"),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed", JSON.stringify(result));

  const [message] = await fixture.db.select().from(messages).where(eq(messages.id, result.messageId!));
  assert.match(message!.content, /^hi @ada, @grace and @alan$/u);
  const facts = await fixture.db.select().from(externalMentionFacts)
    .where(eq(externalMentionFacts.messageId, result.messageId!));
  assert.deepEqual(
    facts.map((fact) => [fact.projectionId, fact.externalActorId, fact.handleAtSendTime, fact.resolutionReason]),
    [[present!.id, "UPRESENT", "ada", "explicit_projection"]],
    "only a member this binding currently observes is styled; departed and unobserved members stay plain text",
  );
  assert.ok(!facts.some((fact) => fact.projectionId === unobserved!.id));
  const raftMentions = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, result.messageId!));
  assert.equal(raftMentions.length, 0, "a Slack member is not a Raft principal and is never notified");
});

test("inbound mention of an unlinked provider user mints no Raft mention rows", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(
    fixture,
    "event-unlinked-mention",
    payload(fixture, "provider-unlinked-mention", null, "hi <@UNOBODY>"),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  const rows = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, result.messageId!));
  assert.equal(rows.length, 0);
});

test("inbound thread reply delivers to a bot-mentioned non-follower exactly once", async () => {
  const fixture = await seedFixture("public", "slack");
  await fixture.db.update(externalAppInstalls)
    .set({ botUserId: "UBOT" })
    .where(eq(externalAppInstalls.id, fixture.install.id));

  // Provider-authored root (outbound-mirrored identity), agent is a parent
  // channel member but NOT a thread follower. A bot mention mints the agent
  // target; the commit's inbox fact marks it personalMention — delivery must
  // not also fire the non-member wake path (exact-once).
  const [root] = await fixture.db.insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "agent",
    senderId: fixture.agent.id,
    messageType: "chat",
    content: "agent thread root",
    createdAt: NOW,
    updatedAt: NOW,
  }).returning();
  await fixture.db.insert(externalMessageLinks).values({
    provider: "slack",
    installId: fixture.authority.installId,
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerConversationId: fixture.authority.providerConversationId,
    providerMessageId: "provider-root-exact-once",
    bindingId: fixture.authority.bindingId,
    bindingEpoch: fixture.authority.bindingEpoch,
    connectionEpoch: fixture.authority.connectionEpoch,
    raftMessageId: root.id,
    raftCanonicalRootMessageId: root.id,
    firstDirection: "raft_outbound",
    payloadFingerprint: digest("provider-root-exact-once"),
    outcomeState: "accepted",
    authorityState: "active",
    stateReason: "raft_outbound_committed",
  });

  await enqueue(
    fixture,
    "event-bot-mention-reply",
    payload(fixture, "provider-bot-mention-reply", "provider-root-exact-once", "looks good <@UBOT>"),
  );
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed", JSON.stringify(reply));

  const [replyMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, reply.messageId));
  const minted = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, reply.messageId!));
  assert.deepEqual(
    minted.map((row) => `${row.targetType}:${row.targetId}`),
    [`agent:${fixture.agent.id}`],
  );
  const facts = await fixture.db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, reply.messageId!));
  const agentFact = facts.find((fact) => fact.receiverType === "agent" && fact.receiverId === fixture.agent.id);
  assert.ok(agentFact, "bot-mention must put the agent in the fact audience");
  assert.equal(agentFact!.personalMention, true);

  const deliveries: { agentId: string; channelId: string; mentioned?: boolean }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, channelId: payload.channel_id, mentioned: payload.mentioned });
      return { status: "delivered" as const };
    },
  } as any;
  const { deliverExternalInboundCommittedMessageToAgents } = await import("./messageService");
  await deliverExternalInboundCommittedMessageToAgents(orchestrator, reply.messageId!);
  assert.equal(
    deliveries.filter((delivery) => delivery.agentId === fixture.agent.id).length,
    1,
    "a mentioned agent in the fact audience must be delivered exactly once",
  );
  assert.equal(deliveries[0]!.channelId, replyMessage!.channelId);
  assert.equal(deliveries[0]!.mentioned, true);
});

test("top-level Joint inbound commits fan agent delivery to every active local face", async () => {
  const fixture = await seedFixture("public", "slack");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  const [participantAgent] = await fixture.db.insert(agents).values({
    serverId: jointFixture.participantServer.id,
    name: `inbound-joint-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  await fixture.db.insert(channelAgents).values({
    channelId: jointFixture.participant.id,
    agentId: participantAgent.id,
  });
  await fixture.db.update(externalAppInstalls)
    .set({ botUserId: "UBOT" })
    .where(eq(externalAppInstalls.id, fixture.install.id));

  await enqueue(
    fixture,
    "event-joint-bot-mention",
    payload(fixture, "provider-joint-bot", null, "hello <@UBOT>"),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed");

  // Mention minting fans out per face: the host-channel agent AND the
  // participant-face agent each get a row.
  const minted = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, result.messageId!));
  assert.deepEqual(
    minted.map((row) => `${row.targetType}:${row.targetId}`).sort(),
    [`agent:${fixture.agent.id}`, `agent:${participantAgent.id}`].sort(),
  );
  for (const row of minted) assert.equal(row.notifiableAtSend, true);

  // Facts land per face (sourceChannelId = the local channel id), so each
  // side's agents receive the message under their own local identity.
  const facts = await fixture.db.select().from(inboxNotificationFacts)
    .where(eq(inboxNotificationFacts.messageId, result.messageId!));
  const hostAgentFact = facts.find((fact) =>
    fact.receiverType === "agent" && fact.receiverId === fixture.agent.id);
  const participantAgentFact = facts.find((fact) =>
    fact.receiverType === "agent" && fact.receiverId === participantAgent.id);
  assert.ok(hostAgentFact);
  assert.equal(hostAgentFact!.sourceChannelId, fixture.channel.id);
  assert.ok(participantAgentFact);
  assert.equal(participantAgentFact!.sourceChannelId, jointFixture.participant.id);

  const deliveries: { agentId: string; channelId: string }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({ agentId, channelId: payload.channel_id });
      return { status: "delivered" as const };
    },
  } as any;
  const { deliverExternalInboundCommittedMessageToAgents } = await import("./messageService");
  await deliverExternalInboundCommittedMessageToAgents(orchestrator, result.messageId!);
  const byAgent = new Map(deliveries.map((delivery) => [delivery.agentId, delivery.channelId]));
  assert.equal(byAgent.get(fixture.agent.id), fixture.channel.id);
  assert.equal(byAgent.get(participantAgent.id), jointFixture.participant.id);
});

test("private-channel mention of a linked outsider mints no row at all", async () => {
  const fixture = await seedFixture("private", "slack");
  const [outsider] = await fixture.db.insert(users).values({
    email: `inbound-priv-outsider-${randomUUID()}@raft.test`,
    name: `inbound-priv-outsider-${randomUUID().slice(0, 8)}`,
    displayName: "Private Outsider",
    passwordHash: "test",
    emailVerified: true,
  }).returning();
  await fixture.db.insert(serverMembers).values({
    serverId: fixture.server.id,
    userId: outsider.id,
    role: "member",
  });
  await fixture.db.insert(externalHumanIdentityLinks).values({
    serverId: fixture.server.id,
    installId: fixture.install.id,
    userId: outsider.id,
    provider: "slack",
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerUserId: "UPRIVOUT",
    state: "active",
    linkEpoch: 1,
    observedConnectionEpoch: fixture.authority.connectionEpoch,
  });

  await enqueue(
    fixture,
    "event-priv-outsider-mention",
    payload(fixture, "provider-priv-outsider", null, "cc <@UPRIVOUT>"),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  assert.equal(
    (await fixture.db.select().from(messageMentions)
      .where(eq(messageMentions.messageId, result.messageId!))).length,
    0,
    "private scope must not record an out-of-scope linked identity",
  );
});

test("Joint channel mention of a linked outsider mints no row at all", async () => {
  const fixture = await seedFixture("public", "slack");
  await convertFixtureToJointWithParticipant(fixture);
  const [outsider] = await fixture.db.insert(users).values({
    email: `inbound-joint-outsider-${randomUUID()}@raft.test`,
    name: `inbound-joint-outsider-${randomUUID().slice(0, 8)}`,
    displayName: "Joint Outsider",
    passwordHash: "test",
    emailVerified: true,
  }).returning();
  await fixture.db.insert(serverMembers).values({
    serverId: fixture.server.id,
    userId: outsider.id,
    role: "member",
  });
  await fixture.db.insert(externalHumanIdentityLinks).values({
    serverId: fixture.server.id,
    installId: fixture.install.id,
    userId: outsider.id,
    provider: "slack",
    providerAuthorityId: fixture.authority.providerAuthorityId,
    providerUserId: "UJOINTOUT",
    state: "active",
    linkEpoch: 1,
    observedConnectionEpoch: fixture.authority.connectionEpoch,
  });

  await enqueue(
    fixture,
    "event-joint-outsider-mention",
    payload(fixture, "provider-joint-outsider", null, "cc <@UJOINTOUT>"),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  assert.equal(
    (await fixture.db.select().from(messageMentions)
      .where(eq(messageMentions.messageId, result.messageId!))).length,
    0,
    "joint scope must not record an out-of-scope linked identity",
  );
});

test("Joint channel inbound writes mention rows at the host local face coordinates", async () => {
  const fixture = await seedFixture("public", "slack");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  await fixture.db.update(externalAppInstalls)
    .set({ botUserId: "UBOT" })
    .where(eq(externalAppInstalls.id, fixture.install.id));

  await enqueue(
    fixture,
    "event-joint-origin",
    payload(fixture, "provider-joint-origin", null, "ping <@UBOT>"),
  );
  const result = await process(fixture);
  assert.equal(result.kind, "committed");

  const rows = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, result.messageId!));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    // mention-v6 contract: message lands on canonical storage, but the
    // mention row records the sender's local projection — the host face.
    assert.equal(row.channelId, fixture.channel.id);
    assert.equal(row.serverId, fixture.server.id);
  }
  assert.notEqual(fixture.channel.id, jointFixture.canonical.id);
});

test("Joint thread inbound delivers per-face parent context and host-face mention coordinates", async () => {
  const fixture = await seedFixture("public", "slack");
  const jointFixture = await convertFixtureToJointWithParticipant(fixture);
  const [participantAgent] = await fixture.db.insert(agents).values({
    serverId: jointFixture.participantServer.id,
    name: `inbound-jt-agent-${randomUUID().slice(0, 8)}`,
    runtime: "codex",
  }).returning();
  await fixture.db.insert(channelAgents).values({
    channelId: jointFixture.participant.id,
    agentId: participantAgent.id,
  });
  await fixture.db.update(externalAppInstalls)
    .set({ botUserId: "UBOT" })
    .where(eq(externalAppInstalls.id, fixture.install.id));

  await enqueue(fixture, "event-jt-root", payload(fixture, "provider-jt-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");
  await enqueue(
    fixture,
    "event-jt-reply",
    payload(fixture, "provider-jt-reply", "provider-jt-root", "reply <@UBOT>"),
  );
  const reply = await process(fixture);
  assert.equal(reply.kind, "committed");

  const [rootMessage] = await fixture.db.select().from(messages)
    .where(eq(messages.id, root.messageId));
  const [jointThread] = await fixture.db.select().from(jointChannels)
    .where(eq(jointChannels.canonicalChannelId, rootMessage.threadId!));
  const threadFaces = await fixture.db.select({
    mapping: jointChannelServers,
  }).from(jointChannelServers)
    .where(eq(jointChannelServers.jointChannelId, jointThread.id));
  const hostFace = threadFaces.find((face) => face.mapping.role === "host")!;
  const participantFace = threadFaces.find((face) => face.mapping.role === "participant")!;

  // Mention rows carry the sender's local face coordinates — the host local
  // thread — never the canonical storage thread.
  const rows = await fixture.db.select().from(messageMentions)
    .where(eq(messageMentions.messageId, reply.messageId!));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.channelId, hostFace.mapping.localChannelId);
    assert.equal(row.serverId, fixture.server.id);
  }

  const deliveries: { agentId: string; channelId: string; parentId?: string; parentType?: string }[] = [];
  const orchestrator = {
    deliverMessage: async (agentId: string, payload: any) => {
      deliveries.push({
        agentId,
        channelId: payload.channel_id,
        parentId: payload.parent_channel_id,
        parentType: payload.parent_channel_type,
      });
      return { status: "delivered" as const };
    },
  } as any;
  const { deliverExternalInboundCommittedMessageToAgents } = await import("./messageService");
  await deliverExternalInboundCommittedMessageToAgents(orchestrator, reply.messageId!);

  const byAgent = new Map(deliveries.map((delivery) => [delivery.agentId, delivery]));
  const host = byAgent.get(fixture.agent.id);
  assert.ok(host);
  assert.equal(host!.channelId, hostFace.mapping.localChannelId);
  assert.equal(host!.parentId, fixture.channel.id);
  assert.equal(host!.parentType, "joint");
  const participant = byAgent.get(participantAgent.id);
  assert.ok(participant);
  assert.equal(participant!.channelId, participantFace.mapping.localChannelId);
  assert.equal(participant!.parentId, jointFixture.participant.id);
  assert.equal(participant!.parentType, "joint");
});

function editPayload(fixture: Awaited<ReturnType<typeof seedFixture>>, id: string, ts: string, content: string, threadId: string | null = null): ExternalInboundNormalizedMessage {
  return { ...payload(fixture, id, threadId, content), schema: "external-inbound-normalized-edit.v1",
    providerFileIds: [], providerAgentMentions: [], providerEditedTs: ts };
}

for (const visibility of ["public", "private"] as const) {
  test(`Slack body edit updates the original row without new inbox facts or send notifications (${visibility})`, async () => {
    const fixture = await seedFixture(visibility, "slack");
    await enqueue(fixture, "original", payload(fixture, "1785758340.000001"));
    const original = await process(fixture, dependencies(fixture));
    assert.equal(original.kind, "committed");
    const [before] = await fixture.db.select().from(messages);
    const inboxBefore = await fixture.db.select().from(inboxNotificationFacts);
    let edited = 0;
    let newMessages = 0;
    await enqueue(fixture, "edit", editPayload(fixture, "1785758340.000001", "1785758400.000002", "new searchable content"));
    assert.equal((await process(fixture, { ...dependencies(fixture),
      onMessageEdited: ({ messageId }) => { assert.equal(messageId, before.id); edited++; },
      onMessageCommitted: () => { newMessages++; },
    })).kind, "committed");
    const [after] = await fixture.db.select().from(messages);
    assert.equal(after.id, before.id);
    assert.equal(after.seq, before.seq);
    assert.equal(after.senderId, before.senderId);
    assert.equal(after.content, "new searchable content");
    assert.equal(after.searchText, after.content);
    assert.deepEqual(await fixture.db.select().from(inboxNotificationFacts), inboxBefore);
    assert.equal(edited, 1);
    assert.equal(newMessages, 0);
    // Redelivery under a different event ID and an older microsecond edit
    // cannot overwrite the latest body or emit a second update.
    for (const [eventId, ts] of [["duplicate-edit", "1785758400.000002"], ["older-edit", "1785758400.000001"]]) {
      await enqueue(fixture, eventId, editPayload(fixture, "1785758340.000001", ts, "stale body"));
      assert.equal((await process(fixture, { ...dependencies(fixture), onMessageEdited: () => { edited++; } })).kind, "duplicate");
    }
    assert.equal(edited, 1);
    assert.equal((await fixture.db.select().from(messages))[0].content, "new searchable content");
    await enqueue(fixture, "newer-edit", editPayload(fixture, "1785758340.000001", "1785758400.000003", "newer within same millisecond"));
    assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
    const [newer] = await fixture.db.select().from(messages);
    assert.equal(newer.content, "newer within same millisecond");
    assert.ok(newer.updatedAt > after.updatedAt, "consecutive accepted edits retain a monotonic preview content revision even when the clock is unchanged");
    // Original-message retries retain their original fingerprint after edits.
    await enqueue(fixture, "original-redelivery", payload(fixture, "1785758340.000001"));
    assert.equal((await process(fixture, dependencies(fixture))).kind, "duplicate");
  });
}

test("Slack thread reply edits preserve the reply's channel and root", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "root", payload(fixture, "root-id"));
  await process(fixture, dependencies(fixture));
  await enqueue(fixture, "reply", payload(fixture, "reply-id", "root-id"));
  await process(fixture, dependencies(fixture));
  const [link] = (await fixture.db.select().from(externalMessageLinks)).filter((row) => row.providerMessageId === "reply-id");
  const [before] = await fixture.db.select().from(messages).where(eq(messages.id, link.raftMessageId));
  await enqueue(fixture, "edit-reply", editPayload(fixture, "reply-id", "1785758400.000003", "edited reply", "root-id"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  const [after] = await fixture.db.select().from(messages).where(eq(messages.id, link.raftMessageId));
  assert.equal(after.channelId, before.channelId);
  assert.equal(after.content, "edited reply");
  assert.equal((await fixture.db.select().from(messages)).length, 2);
});

async function messageChangeRows(fixture: Awaited<ReturnType<typeof seedFixture>>, messageId: string) {
  const result = await fixture.db.execute(sql`
    SELECT scope_kind, scope_id::text AS scope_id, parent_id::text AS parent_id, op
    FROM public.change_log WHERE entity = 'message' AND entity_id = ${messageId} ORDER BY seq`);
  return result.rows;
}

test("RFC 082: a Slack body edit writes one message change row in its conversation's scope (a thread reply: its parent channel)", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "root", payload(fixture, "root-id"));
  await process(fixture, dependencies(fixture));
  await enqueue(fixture, "reply", payload(fixture, "reply-id", "root-id"));
  await process(fixture, dependencies(fixture));
  const links = await fixture.db.select().from(externalMessageLinks);
  const rootId = links.find((link) => link.providerMessageId === "root-id")!.raftMessageId;
  const replyId = links.find((link) => link.providerMessageId === "reply-id")!.raftMessageId;
  assert.deepEqual(await messageChangeRows(fixture, rootId), [], "a new message writes none (clients get it by sequence)");

  await enqueue(fixture, "edit-root", editPayload(fixture, "root-id", "1785758400.000002", "edited root"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  await enqueue(fixture, "edit-reply", editPayload(fixture, "reply-id", "1785758400.000003", "edited reply", "root-id"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  const [reply] = await fixture.db.select().from(messages).where(eq(messages.id, replyId));
  assert.notEqual(reply.channelId, fixture.channel.id);
  assert.deepEqual(await messageChangeRows(fixture, rootId), [{ scope_kind: "channel", scope_id: fixture.channel.id, parent_id: null, op: "upsert" }]);
  assert.deepEqual(await messageChangeRows(fixture, replyId), [{ scope_kind: "channel", scope_id: reply.channelId, parent_id: fixture.channel.id, op: "upsert" }]);
  // A metadata-only change (the same body) changes nothing a client holds.
  await enqueue(fixture, "edit-root-same", editPayload(fixture, "root-id", "1785758400.000004", "edited root"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "duplicate");
  assert.equal((await messageChangeRows(fixture, rootId)).length, 1);
});

test("RFC 082: a Slack edit leaves a message card alone", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "original", payload(fixture, "card-id"));
  await process(fixture, dependencies(fixture));
  const [before] = await fixture.db.select().from(messages);
  const metadata = {
    kind: "message-card",
    revision: 1,
    updatedAt: NOW.toISOString(),
    card: { version: 1, root: "t", elements: { t: { type: "Text", props: { text: "In review", tone: "default", mono: false } } } },
  };
  await fixture.db.update(messages).set({ actionMetadata: metadata }).where(eq(messages.id, before.id));
  let edited = 0;
  await enqueue(fixture, "edit", editPayload(fixture, "card-id", "1785758400.000002", "rewritten in Slack"));
  assert.equal((await process(fixture, { ...dependencies(fixture), onMessageEdited: () => { edited++; } })).kind, "duplicate");
  const [after] = await fixture.db.select().from(messages).where(eq(messages.id, before.id));
  assert.equal(after.content, before.content);
  assert.equal(after.searchText, before.searchText);
  assert.deepEqual(after.actionMetadata, metadata);
  assert.equal(edited, 0, "no message:updated");
  assert.deepEqual(await messageChangeRows(fixture, before.id), []);
});

test("RFC 082 §4.6: an edit event on a card message's bridged copy that reaches the worker is left alone and never called our echo", async () => {
  const fixture = await seedFixture("public", "slack");
  const metadata = {
    kind: "message-card",
    revision: 2,
    updatedAt: NOW.toISOString(),
    card: { version: 1, root: "t", elements: { t: { type: "Text", props: { text: "Ready", tone: "default", mono: false } } } },
  };
  const outbound = async (providerMessageId: string, actionMetadata: unknown) => {
    const [message] = await fixture.db.insert(messages).values({
      channelId: fixture.channel.id, content: "Build 1.19.0 · Ready", senderType: "agent", senderId: fixture.agent.id,
      messageType: "chat", actionMetadata, createdAt: NOW, updatedAt: NOW,
    }).returning();
    await fixture.db.insert(externalMessageLinks).values({
      provider: "slack", installId: fixture.authority.installId, providerAuthorityId: fixture.authority.providerAuthorityId,
      providerConversationId: fixture.authority.providerConversationId, providerMessageId,
      bindingId: fixture.authority.bindingId, bindingEpoch: fixture.authority.bindingEpoch,
      connectionEpoch: fixture.authority.connectionEpoch, raftMessageId: message.id, firstDirection: "raft_outbound",
      payloadFingerprint: digest(providerMessageId), outcomeState: "accepted", authorityState: "active",
      stateReason: "raft_outbound_committed",
    });
    return message;
  };
  const cardMessage = await outbound("1785758400.000100", metadata);
  const ordinary = await outbound("1785758400.000200", null);
  let edited = 0;
  await enqueue(fixture, "card-edit", editPayload(fixture, "1785758400.000100", "1785758400.000101", "@here rewritten"));
  const cardResult = await process(fixture, { ...dependencies(fixture), onMessageEdited: () => { edited++; } });
  assert.equal(cardResult.kind, "duplicate", "not proven our echo: the safe handling leaves the card alone");
  await enqueue(fixture, "ordinary-edit", editPayload(fixture, "1785758400.000200", "1785758400.000201", "rewritten"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "echo", "an ordinary bridged message keeps its echo");
  const [after] = await fixture.db.select().from(messages).where(eq(messages.id, cardMessage.id));
  assert.equal(after.content, cardMessage.content);
  assert.deepEqual(after.actionMetadata, metadata);
  assert.equal(edited, 0);
  assert.deepEqual(await messageChangeRows(fixture, cardMessage.id), []);
  assert.deepEqual(await messageChangeRows(fixture, ordinary.id), []);
});

test("Slack edit arriving before its original retries instead of inserting a second message", async () => {
  const fixture = await seedFixture("public", "slack");
  const edit = await enqueue(fixture, "early-edit", editPayload(fixture, "late-original", "1785758400.000003", "latest"));
  const result = await process(fixture, dependencies(fixture));
  assert.deepEqual(result, { kind: "blocked", eventId: edit.event.id, reason: "edit_original_message_pending" });
  assert.equal((await fixture.db.select().from(messages)).length, 0);
  await enqueue(fixture, "late-original-event", payload(fixture, "late-original"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  assert.equal((await process(fixture, dependencies(fixture, { now: () => new Date(NOW.getTime() + 31_000) }))).kind, "committed");
  assert.equal((await fixture.db.select().from(messages)).length, 1);
  assert.equal((await fixture.db.select().from(messages))[0].content, "latest");
});

for (const denial of ["actor", "revoked", "archive", "workspace"] as const) {
  test(`Slack edit cannot overwrite outside its original authority: ${denial}`, async () => {
    const fixture = await seedFixture("public", "slack");
    await enqueue(fixture, "original", payload(fixture, "original-id"));
    await process(fixture, dependencies(fixture));
    const body = editPayload(fixture, "original-id", "1785758400.000003", "must not replace");
    if (denial === "actor") body.externalActorId = "OTHER_USER";
    if (denial === "workspace") fixture.authority.providerAuthorityId = "different-workspace";
    if (denial === "archive") await fixture.db.update(channels).set({ archivedAt: NOW }).where(eq(channels.id, fixture.channel.id));
    await enqueue(fixture, "denied-edit", body);
    const result = await process(fixture, dependencies(fixture, denial === "revoked" ? { runtime: null } : {}));
    assert.equal(result.kind, "blocked");
    assert.equal((await fixture.db.select().from(messages))[0].content, "provider content original-id");
  });
}

test("Slack metadata-only changes advance ordering without marking the body edited", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "original", payload(fixture, "original-id", null, "unchanged"));
  await process(fixture, dependencies(fixture));
  const [before] = await fixture.db.select().from(messages);
  await enqueue(fixture, "metadata", editPayload(fixture, "original-id", "1785758400.000003", "unchanged"));
  assert.equal((await process(fixture, { ...dependencies(fixture), onMessageEdited: () => assert.fail("metadata must not emit a body edit") })).kind, "duplicate");
  assert.deepEqual((await fixture.db.select().from(messages))[0], before);
  await enqueue(fixture, "older-edit", editPayload(fixture, "original-id", "1785758400.000002", "older content"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "duplicate");
  assert.equal((await fixture.db.select().from(messages))[0].content, "unchanged");
});

test("Slack edit custody rejects a null edit timestamp before touching its message", async () => {
  const fixture = await seedFixture("public", "slack");
  const body = editPayload(fixture, "original-id", "1785758400.000003", "invalid");
  Object.assign(body, { providerEditedTs: null });
  const event = await enqueue(fixture, "invalid-edit", body);
  assert.deepEqual(await process(fixture, dependencies(fixture)), {
    kind: "blocked", eventId: event.event.id, reason: "payload_invalid",
  });
  assert.equal((await fixture.db.select().from(messages)).length, 0);
});

test("Slack edit cannot move an original into a different thread or create that thread", async () => {
  const fixture = await seedFixture("public", "slack");
  for (const id of ["original", "other-root"]) {
    await enqueue(fixture, id, payload(fixture, id));
    await process(fixture, dependencies(fixture));
  }
  const beforeChannels = await fixture.db.select().from(channels);
  await enqueue(fixture, "move-edit", editPayload(fixture, "original", "1785758400.000003", "moved", "other-root"));
  const result = await process(fixture, dependencies(fixture));
  assert.equal(result.kind, "blocked");
  assert.deepEqual(await fixture.db.select().from(channels), beforeChannels);
  assert.equal((await fixture.db.select().from(messages)).some((row) => row.content === "moved"), false);
});

for (const privacy of ["public", "private"] as const) {
  test(`Slack emoji render in roots, replies and edits through one canonical path (${privacy})`, async () => {
    const fixture = await seedFixture(privacy, "slack");
    await enqueue(fixture, "emoji-root", payload(fixture, "emoji-root-id", null, ":test_tube: :+1::skin-tone-4:"));
    const root = await process(fixture);
    assert.equal(root.kind, "committed");
    const [originalRoot] = await fixture.db.select().from(messages).where(eq(messages.id, root.messageId!));
    assert.equal(originalRoot.content, "🧪 👍🏽");
    await enqueue(fixture, "emoji-reply", payload(fixture, "emoji-reply-id", "emoji-root-id", ":female-technologist::skin-tone-4: `:test_tube:`"));
    const reply = await process(fixture);
    assert.equal(reply.kind, "committed");
    const [originalReply] = await fixture.db.select().from(messages).where(eq(messages.id, reply.messageId!));
    assert.equal(originalReply.content, "👩🏽‍💻 `:test_tube:`");
    await enqueue(fixture, "emoji-edit-root", editPayload(fixture, "emoji-root-id", "1785758400.000004", "root :white_check_mark: :workspace_parrot:"));
    assert.equal((await process(fixture)).kind, "committed");
    await enqueue(fixture, "emoji-edit-reply", editPayload(fixture, "emoji-reply-id", "1785758400.000005", "reply :test_tube:", "emoji-root-id"));
    assert.equal((await process(fixture)).kind, "committed");
    const [editedRoot] = await fixture.db.select().from(messages).where(eq(messages.id, root.messageId!));
    const [editedReply] = await fixture.db.select().from(messages).where(eq(messages.id, reply.messageId!));
    assert.equal(editedRoot.content, "root ✅ :workspace_parrot:");
    assert.equal(editedRoot.searchText, editedRoot.content);
    assert.equal(editedReply.content, "reply 🧪");
    assert.equal(editedReply.channelId, originalReply.channelId);
    assert.equal((await fixture.db.select().from(messages)).length, 2);
  });
}

test("other providers do not inherit Slack shortcode interpretation", async () => {
  const fixture = await seedFixture();
  await enqueue(fixture, "literal-provider", payload(fixture, "literal-provider-id", null, ":test_tube:"));
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  const [message] = await fixture.db.select().from(messages).where(eq(messages.id, result.messageId!));
  assert.equal(message.content, ":test_tube:");
});


test("Slack emoji rendering preserves escaped tones and uppercase URL bytes in canonical storage", async () => {
  const fixture = await seedFixture("private", "slack");
  const literal = "\\:thumbsup::skin-tone-4: HTTPS://example.test/:test_tube:";
  await enqueue(fixture, "emoji-literal-fidelity", payload(fixture, "emoji-literal-fidelity-id", null, `${literal} :test_tube:`));
  const result = await process(fixture);
  assert.equal(result.kind, "committed");
  const [message] = await fixture.db.select().from(messages).where(eq(messages.id, result.messageId!));
  assert.equal(message.content, `${literal} 🧪`);
  assert.equal(message.searchText, message.content);
});

for (const kind of ["public", "private", "joint"] as const) {
  test(`historical receipt preserves inbound replies and edits after binding update (${kind})`, async () => {
    const fixture = await seedFixture(kind === "private" ? "private" : "public", "slack");
    if (kind === "joint") await convertFixtureToJointWithParticipant(fixture);
    await enqueue(fixture, "old-root", payload(fixture, "old-root"));
    const root = await process(fixture);
    assert.equal(root.kind, "committed");
    await fixture.db.update(externalMessageLinks).set({ bindingEpoch: 1, bindingId: "historical-binding",
      installId: "historical-install", connectionEpoch: 1, authorityState: "stale" })
      .where(eq(externalMessageLinks.providerMessageId, "old-root"));
    const [oldActor] = await fixture.db.insert(externalActorProjections).values({ ...fixture.actor,
      id: randomUUID(), installId: "historical-install", appRegistrationId: "historical-registration" }).returning();
    await fixture.db.update(messages).set({ senderId: oldActor.id }).where(eq(messages.id, root.messageId));
    await fixture.db.update(externalMessageAuthorFacts).set({ projectionId: oldActor.id,
      installId: "historical-install", appRegistrationId: "historical-registration" })
      .where(eq(externalMessageAuthorFacts.messageId, root.messageId));
    await enqueue(fixture, "new-reply", payload(fixture, "new-reply", "old-root"));
    const reply = await process(fixture);
    assert.equal(reply.kind, "committed");
    const [replyLink] = await fixture.db.select().from(externalMessageLinks)
      .where(eq(externalMessageLinks.providerMessageId, "new-reply"));
    assert.equal(replyLink.raftCanonicalRootMessageId, root.messageId);
    assert.equal(replyLink.bindingEpoch, 2, "the new operation belongs to current authority");
    await enqueue(fixture, "old-root-edit", editPayload(fixture, "old-root", "1785758400.000010", "edited historical root"));
    assert.equal((await process(fixture)).kind, "committed");
    const [updated] = await fixture.db.select().from(messages).where(eq(messages.id, root.messageId));
    assert.equal(updated.content, "edited historical root");
    const [historical] = await fixture.db.select().from(externalMessageLinks)
      .where(eq(externalMessageLinks.providerMessageId, "old-root"));
    assert.equal(historical.bindingEpoch, 1, "historical provenance is not rewritten");
  });
}

test("historical root lookup rejects a different channel pair or unaccepted receipt", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "root", payload(fixture, "root"));
  await process(fixture);
  const [root] = await fixture.db.select().from(externalMessageLinks);
  for (const patch of [
    { providerConversationId: "another-channel" },
    { providerAuthorityId: "another-workspace" }, { outcomeState: "unknown" as const, providerMessageId: null, firstDirection: "raft_outbound" as const },
  ]) {
    await fixture.db.update(externalMessageLinks).set({ ...root, bindingEpoch: 1, ...patch })
      .where(eq(externalMessageLinks.id, root.id));
    const body = payload(fixture, `rejected-${JSON.stringify(patch)}`, "root");
    await enqueue(fixture, `event-${JSON.stringify(patch)}`, body);
    assert.equal((await process(fixture)).kind, "blocked");
  }
  await fixture.db.update(externalMessageLinks).set(root).where(eq(externalMessageLinks.id, root.id));
  const [otherParent] = await fixture.db.insert(channels).values({ serverId: fixture.server.id,
    name: "another-actual-channel", type: "channel" }).returning();
  await fixture.db.update(messages).set({ channelId: otherParent.id }).where(eq(messages.id, root.raftMessageId));
  await enqueue(fixture, "wrong-raft-parent", payload(fixture, "wrong-raft-reply", "root"));
  assert.equal((await process(fixture)).kind, "blocked", "same Slack coordinates cannot move another Raft channel into this pair");
  assert.equal((await fixture.db.select().from(messages)).length, 1);
});

async function seedCurrentBindingForMissingRoot(fixture: Awaited<ReturnType<typeof seedFixture>>) {
  const [binding] = await fixture.db.insert(externalChannelBindings).values({
    serverId: fixture.server.id, registrationId: fixture.actor.appRegistrationId, installId: fixture.install.id,
    channelId: fixture.channel.id, providerConversationId: fixture.authority.providerConversationId,
    providerConversationKind: "public_channel", privacyClass: "public", state: "active", grantEpoch: 1,
    connectionEpoch: fixture.authority.connectionEpoch, bindingEpoch: fixture.authority.bindingEpoch,
    consentedByType: "human", consentedById: fixture.owner.id, consentedAt: NOW,
  }).returning();
  fixture.authority.bindingId = binding.id;
}

for (const kind of ["reply", "reaction"] as const) {
  test(`confirmed missing historical parent discards inbound ${kind} and the next body commits`, async () => {
    const fixture = await seedFixture("public", "slack");
    await seedCurrentBindingForMissingRoot(fixture);
    let discardedId: string;
    if (kind === "reply") {
      discardedId = (await enqueue(fixture, "orphan-reply", payload(fixture, "1790000000.000200", "1500000000.000100"))).event.id;
    } else {
      const plaintext = JSON.stringify({ schema: "external-inbound-normalized-reaction.v1", operation: "add",
        providerMessageId: "1500000000.000100", externalActorId: fixture.actor.externalActorId,
        providerReactionKey: "eyes", eventOccurredAt: NOW.toISOString(), eventSequence: NOW.getTime() * 1000,
        botUserId: "U_BOT" });
      const [event] = await fixture.db.insert(externalInboundEvents).values({ ...fixture.authority,
        providerEventId: "orphan-reaction", normalizedPayloadDigest: digest(plaintext), encryptedPayload: plaintext,
        envelopeKeyId: "opaque-envelope-key-1", payloadSchemaVersion: 3,
        payloadAadPurpose: "external-inbound-normalized-event", payloadAadVersion: 1,
        payloadExpiresAt: new Date(NOW.getTime() + 60_000), receivedAt: NOW, updatedAt: NOW,
      }).returning();
      discardedId = event.id;
    }
    const discarded = await process(fixture);
    assert.equal(discarded.kind, "blocked");
    assert.equal("reason" in discarded ? discarded.reason : null, "confirmed_thread_root_missing");
    const [row] = await fixture.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, discardedId));
    assert.equal(row.status, "dead");
    assert.equal(row.encryptedPayload, null);
    assert.ok(row.payloadErasedAt);
    await enqueue(fixture, "following-body", payload(fixture, "1790000000.000300", null, "following delivered body"));
    assert.equal((await process(fixture)).kind, "committed");
    const rows = await fixture.db.select().from(messages);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "following delivered body");
  });
}

test("a fresh reordered inbound root stays recoverable instead of being discarded", async () => {
  const fixture = await seedFixture("public", "slack");
  await seedCurrentBindingForMissingRoot(fixture);
  const rootId = `${Math.floor(NOW.getTime() / 1000) + 1}.000100`;
  const child = await enqueue(fixture, "reordered-child", payload(fixture, "1790000000.000500", rootId));
  assert.equal((await process(fixture)).kind, "blocked");
  const [waiting] = await fixture.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, child.event.id));
  assert.equal(waiting.status, "queued");
  assert.ok(waiting.encryptedPayload);
  await enqueue(fixture, "delayed-root", payload(fixture, rootId));
  assert.equal((await process(fixture)).kind, "committed");
  assert.equal((await process(fixture, dependencies(fixture, { now: () => new Date(NOW.getTime() + 31_000) }))).kind, "committed");
  assert.equal((await fixture.db.select().from(messages)).length, 2);
});

for (const operation of ["reply", "edit", "duplicate"] as const) {
  test(`ambiguous historical Slack mappings cannot choose an arbitrary ${operation} target`, async () => {
    const fixture = await seedFixture("public", "slack");
    await enqueue(fixture, "first-root", payload(fixture, "conflicted-root"));
    const first = await process(fixture);
    assert.equal(first.kind, "committed");
    await enqueue(fixture, "second-root", payload(fixture, "other-root"));
    const second = await process(fixture);
    assert.equal(second.kind, "committed");
    const [original] = await fixture.db.select().from(externalMessageLinks).where(eq(externalMessageLinks.raftMessageId, first.messageId!));
    await fixture.db.insert(externalMessageLinks).values({ ...original, id: randomUUID(), installId: "older-install",
      raftMessageId: second.messageId!, bindingId: "older-binding", bindingEpoch: 1 });
    const body = operation === "edit" ? editPayload(fixture, "conflicted-root", "1785758400.000010", "must not overwrite")
      : operation === "reply" ? payload(fixture, "conflicted-reply", "conflicted-root")
      : payload(fixture, "conflicted-root", null, "duplicate must not pick");
    await enqueue(fixture, `ambiguous-${operation}`, body);
    assert.equal((await process(fixture)).kind, "blocked");
    const stored = await fixture.db.select().from(messages);
    assert.equal(stored.length, 2);
    assert.ok(stored.every((message) => message.content !== "must not overwrite"));
  });
}

test("an old Slack root queued after rebind is not mistaken for confirmed absence", async () => {
  const fixture = await seedFixture("public", "slack");
  await seedCurrentBindingForMissingRoot(fixture);
  const oldRoot = "1500000000.000100";
  const child = await enqueue(fixture, "late-child", payload(fixture, "1790000000.000700", oldRoot));
  const root = await enqueue(fixture, "late-old-root", payload(fixture, oldRoot));
  await fixture.db.update(externalInboundEvents).set({ receivedAt: new Date(NOW.getTime() + 1) }).where(eq(externalInboundEvents.id, root.event.id));
  assert.equal((await process(fixture)).kind, "blocked");
  const [waiting] = await fixture.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, child.event.id));
  assert.equal(waiting.status, "queued");
  assert.ok(waiting.encryptedPayload, "the old root's arrival time cannot justify erasing its reply");
  assert.equal((await process(fixture)).kind, "committed");
  assert.equal((await process(fixture, dependencies(fixture, { now: () => new Date(NOW.getTime() + 31_000) }))).kind, "committed");
  assert.equal((await fixture.db.select().from(messages)).length, 2);
});


test("queued inbound reply and edit retain custody while using the reauthorized current actor", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "before-rebind-root", payload(fixture, "before-rebind-root"));
  const root = await process(fixture);
  assert.equal(root.kind, "committed");
  await enqueue(fixture, "queued-rebind-reply", payload(fixture, "queued-rebind-reply", "before-rebind-root"));
  await enqueue(fixture, "queued-rebind-edit", editPayload(fixture, "before-rebind-root", "1785758400.000020", "edited under current actor"), new Date(NOW.getTime() + 1));
  const [actor] = await fixture.db.insert(externalActorProjections).values({ ...fixture.actor,
    id: randomUUID(), installId: "reauthorized-install" }).returning();
  await fixture.db.update(externalActorProjections).set({ state: "tombstoned" }).where(eq(externalActorProjections.id, fixture.actor.id));
  const current = { ...fixture.authority, installId: actor.installId, appRegistrationId: actor.appRegistrationId,
    bindingId: randomUUID(), bindingEpoch: 1, connectionEpoch: 3, runtimeRevision: "current-reauthorized-runtime" };
  const runtime = { ...fixture.authority, operationAuthority: current };
  const reply = await process(fixture, dependencies(fixture, { runtime }));
  assert.equal(reply.kind, "committed");
  const [storedReply] = await fixture.db.select().from(messages).where(eq(messages.id, reply.messageId));
  assert.equal(storedReply.senderId, actor.id);
  assert.equal((await process(fixture, dependencies(fixture, { runtime }))).kind, "committed");
  const [edited] = await fixture.db.select().from(messages).where(eq(messages.id, root.messageId));
  assert.equal(edited.content, "edited under current actor");
  const originalEvent = (await fixture.db.select().from(externalInboundEvents)).find((event) => event.providerEventId === "queued-rebind-reply");
  assert.equal(originalEvent?.installId, fixture.authority.installId, "the original sealed custody coordinates are retained");
});

test("late self-bot detection reaches a terminal state without creating a message", async () => {
  const fixture = await seedFixture("public", "slack");
  await fixture.db.update(externalAppInstalls).set({ providerBotId: "B_CURRENT" }).where(eq(externalAppInstalls.id, fixture.install.id));
  await fixture.db.update(externalActorProjections).set({ actorKind: "bot", externalActorId: "B_CURRENT" })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  fixture.actor.externalActorId = "B_CURRENT";
  const event = await enqueue(fixture, "late-self-bot", payload(fixture, "1785758340.000001"));
  const result = await process(fixture);
  assert.equal(result.kind, "blocked");
  if (result.kind === "blocked") assert.equal(result.reason, "provider_self_echo_without_link");
  const [stored] = await fixture.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, event.event.id));
  assert.equal(stored.status, "dead");
  assert.equal(stored.outcomeReason, "provider_self_echo_without_link");
  assert.equal(stored.encryptedPayload, null);
  assert.equal((await fixture.db.select().from(messages)).length, 0);
  assert.equal((await process(fixture)).kind, "empty");
});

test("normalized Slack bot messages and edits preserve bot authorship without new principals", async () => {
  const fixture = await seedFixture("public", "slack");
  await fixture.db.update(externalActorProjections).set({ actorKind: "bot", externalActorId: "B_ALERT" })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  fixture.actor.externalActorId = "B_ALERT";
  const membersBefore = (await fixture.db.select().from(serverMembers)).length;
  const agentsBefore = (await fixture.db.select().from(agents)).length;
  await enqueue(fixture, "bot-original", payload(fixture, "1785758340.000001", null, "bot original"));
  const original = await process(fixture, dependencies(fixture));
  assert.equal(original.kind, "committed");
  const [fact] = await fixture.db.select().from(externalMessageAuthorFacts);
  assert.equal(fact.actorKind, "bot");
  assert.equal(fact.externalActorId, "B_ALERT");
  await enqueue(fixture, "bot-edit", editPayload(fixture, "1785758340.000001", "1785758400.000002", "bot edited"));
  assert.equal((await process(fixture, dependencies(fixture))).kind, "committed");
  const [message] = await fixture.db.select().from(messages);
  assert.equal(message.content, "bot edited");
  assert.equal((await fixture.db.select().from(messages)).length, 1);
  assert.equal((await fixture.db.select().from(serverMembers)).length, membersBefore);
  assert.equal((await fixture.db.select().from(agents)).length, agentsBefore);
  await fixture.db.update(externalActorProjections).set({ actorKind: "human" })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  await enqueue(fixture, "wrong-kind-edit", editPayload(fixture, "1785758340.000001", "1785758400.000003", "wrong"));
  const mismatch = await process(fixture, dependencies(fixture));
  assert.equal(mismatch.kind, "blocked");
  if (mismatch.kind === "blocked") assert.equal(mismatch.reason, "edit_message_authority_mismatch");
  assert.equal((await fixture.db.select().from(messages))[0]?.content, "bot edited");
});

for (const actorKind of ["bot", "human"] as const) {
  test(`normalized bot presentation cannot rewrite stable ${actorKind} identity`, async () => {
    const fixture = await seedFixture("public", "slack");
    if (actorKind === "bot") {
      await fixture.db.update(externalActorProjections).set({ actorKind: "bot", externalActorId: "B_ALERT" })
        .where(eq(externalActorProjections.id, fixture.actor.id));
      fixture.actor.externalActorId = "B_ALERT";
    }
    const body: ExternalInboundNormalizedMessage = { ...payload(fixture, "1785758340.000002"),
      schema: "external-inbound-normalized-event.v4", providerFileIds: [], providerAgentMentions: [],
      botPresentation: { displayName: "Deployment alert", avatarArtifactId: null } };
    await enqueue(fixture, `presentation-${actorKind}`, body);
    const result = await process(fixture, dependencies(fixture));
    if (actorKind === "human") {
      assert.equal(result.kind, "blocked");
      if (result.kind === "blocked") assert.equal(result.reason, "bot_actor_authority_mismatch");
      assert.equal((await fixture.db.select().from(messages)).length, 0);
    } else {
      assert.equal(result.kind, "committed");
      const [fact] = await fixture.db.select().from(externalMessageAuthorFacts);
      assert.equal(fact.actorKind, "bot");
      assert.equal(fact.displayName, fixture.actor.displayName);
      const [profile] = await fixture.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, fixture.actor.id));
      assert.equal(profile.displayName, fixture.actor.displayName);
      assert.equal(profile.externalActorId, "B_ALERT");
    }
  });
}

test("Slack text within the message character limit preserves multilingual content", async () => {
  const fixture = await seedFixture("public", "slack");
  const content = "中".repeat(15_000);
  await enqueue(fixture, "unicode-message", payload(fixture, "1785758340.000010", null, content));
  const result = await process(fixture, dependencies(fixture));
  assert.equal(result.kind, "committed", JSON.stringify(result));
  const [stored] = await fixture.db.select().from(messages);
  assert.equal(stored.content, content);
});

test("durable Slack delivery survives a display-only actor refresh on the same binding", async () => {
  const fixture = await seedFixture("public", "slack");
  await enqueue(fixture, "durable-profile-refresh", payload(fixture, "provider-profile-refresh", null, "original body"));
  await fixture.db.update(externalActorProjections).set({ displayName: "Refreshed Slack Name",
    projectionRevision: fixture.actor.projectionRevision + 1, updatedAt: new Date(NOW.getTime() + 1_000) })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  await enableTestSlackIngress();
  const result = await processExternalInboundEventOnce({ db: fixture.db, leaseOwner: "durable-worker",
    dependencies: dependencies(fixture), durableSlackMode: true, providerScope: "slack" });
  assert.equal(result.kind, "committed");
  const [message] = await fixture.db.select().from(messages).where(eq(messages.id, result.messageId!));
  const [author] = await fixture.db.select().from(externalMessageAuthorFacts).where(eq(externalMessageAuthorFacts.messageId, result.messageId!));
  assert.equal(message.content, "original body");
  assert.equal(message.senderId, fixture.actor.id);
  assert.equal(author.externalActorId, fixture.actor.externalActorId);
  assert.equal(author.displayName, "Refreshed Slack Name");
});

test("durable Slack delivery retains ciphertext when its actor identity is no longer current", async () => {
  const fixture = await seedFixture("public", "slack");
  const admitted = await enqueue(fixture, "durable-actor-unavailable", payload(fixture, "provider-actor-unavailable", null, "retain body"));
  await fixture.db.update(externalActorProjections).set({ state: "tombstoned" })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  await enableTestSlackIngress();
  const result = await processExternalInboundEventOnce({ db: fixture.db, leaseOwner: "durable-worker",
    dependencies: dependencies(fixture), durableSlackMode: true, providerScope: "slack" });
  assert.equal(result.kind, "blocked");
  const [event] = await fixture.db.select().from(externalInboundEvents).where(eq(externalInboundEvents.id, admitted.event.id));
  assert.equal(event.status, "queued");
  assert.ok(event.encryptedPayload, "temporary identity uncertainty must not erase the message");
  assert.equal((await fixture.db.select().from(messages)).length, 0);
});

test("a single unrecognized raw event does not block delivery of the surrounding messages", async () => {
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { parseVerifiedSlackMessage } = await import("./slackVerifiedIngressNormalize");
  const fixture = await seedFixture("public", "slack");
  await enableTestSlackIngress();
  // Use one coherent provider scope, as the durable raw worker requires.
  await fixture.db.update(externalAppInstalls).set({ providerTeamId: fixture.actor.workspaceId,
    providerAuthorityId: fixture.actor.workspaceId }).where(eq(externalAppInstalls.id, fixture.install.id));
  const authority = { ...fixture.authority, providerAuthorityId: fixture.actor.workspaceId };
  const providerAppId = fixture.install.providerAppId;
  const key = Buffer.alloc(32, 9);
  let clock = new Date(NOW);
  for (const [id, subtype, text] of [["Ev_FIRST", undefined, "first body"],
    ["Ev_BAD", "future_format", "held body"], ["Ev_LAST", undefined, "last body"]] as const) {
    const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
      registrationId: authority.appRegistrationId, environment: authority.environment, providerAppId,
      providerAuthorityId: authority.providerAuthorityId, providerConversationId: authority.providerConversationId,
      providerEventId: id };
    const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: providerAppId,
      team_id: authority.providerAuthorityId, event_id: id, event: { type: "message", channel: authority.providerConversationId,
        ...(subtype ? { subtype } : {}), user: fixture.actor.externalActorId, ts: id === "Ev_FIRST"
          ? "1785758340.000001" : id === "Ev_BAD" ? "1785758341.000001" : "1785758342.000001", text } }));
    await enqueueSlackVerifiedIngress({ db: fixture.db, aad, rawDigest: digest(bytes.toString("utf8")),
      encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: clock,
      validateEndpoint: async () => true });
  }
  const tick = () => processVerifiedSlackIngressOnce({ db: fixture.db, leaseOwner: "raw-worker", leaseMs: 5_000,
    now: () => clock,
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } },
    prepare: async (event) => {
      const parsed = parseVerifiedSlackMessage(event);
      if (!parsed) return { kind: "unrecognized" as const, reason: "unsupported_event_format" as const };
      const plaintext = JSON.stringify({ schema: "external-inbound-normalized-event.v3", projectionId: fixture.actor.id,
        actorProjectionRevision: fixture.actor.projectionRevision, externalActorId: fixture.actor.externalActorId,
        providerMessageId: parsed.providerMessageId, providerThreadId: parsed.providerThreadId,
        providerFileIds: parsed.providerFileIds, providerAgentMentions: parsed.providerAgentMentions,
        content: parsed.content, createdAt: parsed.createdAt });
      return { kind: "materialize" as const, authority, normalizedPayloadDigest: digest(plaintext),
        encryptedPayload: plaintext, envelopeKeyId: "test", payloadSchemaVersion: 2 as const,
        payloadExpiresAt: new Date(clock.getTime() + 60_000), validateCurrentAuthority: async () => true };
    } });
  const consume = () => processExternalInboundEventOnce({ db: fixture.db, leaseOwner: "normalized-worker", durableSlackMode: true,
    dependencies: dependencies(fixture, { now: () => clock, runtime: authority }) });
  assert.equal((await tick()).kind, "materialized");
  assert.equal((await consume()).kind, "committed");
  assert.equal((await tick()).kind, "empty", "settle the completed first head");
  for (let n = 1; n <= 3; n++) {
    assert.equal((await tick()).kind, n < 3 ? "deferred" : "held");
    clock = new Date(clock.getTime() + 60_000);
  }
  assert.equal((await tick()).kind, "materialized");
  assert.equal((await consume()).kind, "committed");
  const delivered = await fixture.db.select().from(messages).where(eq(messages.channelId, fixture.channel.id));
  assert.deepEqual(delivered.map(message => message.content), ["first body", "last body"]);
  const held = await fixture.db.select().from(slackVerifiedIngressEvents)
    .where(eq(slackVerifiedIngressEvents.providerEventId, "Ev_BAD"));
  assert.equal(held[0]?.state, "held");
  assert.ok(held[0]?.encryptedPayload);
});

test.each(["invalid_json", "invalid_envelope", "key_unavailable"] as const)("normalized event recovery distinguishes %s", async (corruption) => {
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const { replayHeldSlackIngress } = await import("./slackVerifiedIngressWorker");
  const { parseVerifiedSlackMessage } = await import("./slackVerifiedIngressNormalize");
  const { SlackNormalizedEnvelopeInvalid } = await import("./slackNormalizedPayloadError");
  const fixture = await seedFixture("public", "slack");
  await enableTestSlackIngress();
  await fixture.db.update(externalAppInstalls).set({ providerTeamId: fixture.actor.workspaceId,
    providerAuthorityId: fixture.actor.workspaceId }).where(eq(externalAppInstalls.id, fixture.install.id));
  const authority = { ...fixture.authority, providerAuthorityId: fixture.actor.workspaceId };
  const key = Buffer.alloc(32, 12);
  let clock = new Date(NOW);
  let retryBad: (() => ReturnType<typeof enqueueSlackVerifiedIngress>) | undefined;
  for (const [id, text, ts] of [["Ev_BAD_NORMALIZED", "original bad body", "1785758340.000001"],
    ["Ev_FOLLOWER", "following body", "1785758341.000001"]] as const) {
    const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const,
      registrationId: authority.appRegistrationId, environment: authority.environment, providerAppId: fixture.install.providerAppId,
      providerAuthorityId: authority.providerAuthorityId, providerConversationId: authority.providerConversationId, providerEventId: id };
    const bytes = Buffer.from(JSON.stringify({ type: "event_callback", api_app_id: aad.providerAppId,
      team_id: aad.providerAuthorityId, event_id: id, event: { type: "message", channel: aad.providerConversationId,
        user: fixture.actor.externalActorId, ts, text } }));
    const admit = () => enqueueSlackVerifiedIngress({ db: fixture.db, aad, rawDigest: digest(bytes.toString("utf8")),
      encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: clock,
      validateEndpoint: async () => true });
    if (id === "Ev_BAD_NORMALIZED") retryBad = admit;
    await admit();
  }
  let repaired = false;
  const tick = () => processVerifiedSlackIngressOnce({ db: fixture.db, leaseOwner: "raw-worker", leaseMs: 5_000,
    now: () => clock, crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, prepare: async event => {
      const parsed = parseVerifiedSlackMessage(event);
      if (!parsed) return { kind: "unrecognized" as const, reason: "invalid_event_shape" as const };
      const bad = parsed.content === "original bad body" && !repaired;
      const plaintext = bad ? "invalid-normalized-json" : JSON.stringify({ schema: "external-inbound-normalized-event.v3",
        projectionId: fixture.actor.id, actorProjectionRevision: fixture.actor.projectionRevision,
        externalActorId: fixture.actor.externalActorId, providerMessageId: parsed.providerMessageId,
        providerThreadId: parsed.providerThreadId, providerFileIds: parsed.providerFileIds,
        providerAgentMentions: parsed.providerAgentMentions, content: parsed.content, createdAt: parsed.createdAt });
      return { kind: "materialize" as const, authority, normalizedPayloadDigest: digest(plaintext), encryptedPayload: plaintext,
        envelopeKeyId: "test", payloadSchemaVersion: 2 as const, payloadExpiresAt: new Date(clock.getTime() + 60_000),
        validateCurrentAuthority: async () => true };
    } });
  const consume = () => processExternalInboundEventOnce({ db: fixture.db, leaseOwner: "normalized-worker",
    durableSlackMode: true, dependencies: dependencies(fixture, { now: () => clock, runtime: authority,
      decrypt: async input => {
        if (corruption === "key_unavailable" && input.ciphertext === "invalid-normalized-json") {
          throw new Error("temporary key service failure");
        }
        if (corruption === "invalid_envelope" && input.ciphertext === "invalid-normalized-json") {
          throw new SlackNormalizedEnvelopeInvalid();
        }
        return input.ciphertext;
      } }) });
  if (corruption === "key_unavailable") {
    assert.equal((await tick()).kind, "materialized");
    const result = await consume();
    assert.equal(result.kind, "blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    assert.equal(result.reason, "payload_decrypt_failed");
    await tick();
    const [waiting] = await fixture.db.select().from(slackVerifiedIngressEvents)
      .where(eq(slackVerifiedIngressEvents.providerEventId, "Ev_BAD_NORMALIZED"));
    assert.equal(waiting?.state, "materialized");
    assert.ok(waiting?.encryptedPayload, "an unavailable key must preserve FIFO custody, not isolate");
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal((await tick()).kind, "materialized");
    assert.equal((await consume()).kind, "blocked");
    assert.equal((await tick()).kind, "empty", "raw worker settles the failed normalized head");
    clock = new Date(clock.getTime() + 60_000);
  }
  const [held] = await fixture.db.select().from(slackVerifiedIngressEvents)
    .where(eq(slackVerifiedIngressEvents.providerEventId, "Ev_BAD_NORMALIZED"));
  assert.equal(held?.state, "quarantined"); assert.ok(held?.encryptedPayload);
  assert.equal(held?.lastIsolationReason, "normalized_payload_invalid");
  const duplicate = await retryBad!();
  assert.equal(duplicate.kind, "receipt");
  if (duplicate.kind !== "receipt") throw new Error("expected retained receipt");
  assert.equal(duplicate.id, held!.id, "a signed retry acknowledges the already retained receipt");
  assert.equal(duplicate.duplicate, true);
  assert.equal((await tick()).kind, "materialized");
  assert.equal((await consume()).kind, "committed", "a later normal event must not be blocked by the isolated row");
  assert.equal((await tick()).kind, "empty", "finish the follower before replay");
  repaired = true;
  assert.equal(await replayHeldSlackIngress({ db: fixture.db, partitionId: held!.partitionId, eventId: held!.id,
    now: () => clock, authorize: async () => ({ kind: "human" as const, id: "test-operator" }) }), true);
  assert.equal((await tick()).kind, "materialized");
  assert.equal((await consume()).kind, "committed");
  const delivered = await fixture.db.select().from(messages).where(eq(messages.channelId, fixture.channel.id));
  assert.deepEqual(delivered.map(message => message.content).sort(), ["following body", "original bad body"].sort());
  assert.equal(delivered.find(message => message.content === "original bad body")?.createdAt.toISOString(),
    new Date(1785758340 * 1000).toISOString());
  const [replayed] = await fixture.db.select().from(slackVerifiedIngressEvents)
    .where(eq(slackVerifiedIngressEvents.id, held!.id));
  assert.equal(replayed?.replayCount, 1); assert.ok(replayed?.lastReplayedAt);
  assert.equal(replayed?.lastIsolationReason, "normalized_payload_invalid");
});

test("verified attachment by a departed human downloads and commits without restoring the sender", async () => {
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const fixture = await seedFixture("public", "slack");
  await enableTestSlackIngress();
  await fixture.db.update(externalAppInstalls).set({ providerTeamId: fixture.actor.workspaceId,
    providerAuthorityId: fixture.actor.workspaceId }).where(eq(externalAppInstalls.id, fixture.install.id));
  const authority = { ...fixture.authority, providerAuthorityId: fixture.actor.workspaceId };
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: authority.appRegistrationId,
    environment: authority.environment, providerAppId: fixture.install.providerAppId, providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId, providerEventId: "Ev_DEPARTED_FILE" };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId,
    event_id: aad.providerEventId, event: { type: "message", channel: aad.providerConversationId,
      user: fixture.actor.externalActorId, ts: "1785758340.000001", text: "file from earlier", files: [{ id: "F_LEFT" }] } };
  const bytes = Buffer.from(JSON.stringify(event)); const key = Buffer.alloc(32, 4);
  await enqueueSlackVerifiedIngress({ db: fixture.db, aad, rawDigest: digest(bytes.toString("utf8")),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: NOW,
    validateEndpoint: async () => true });
  await fixture.db.update(externalActorProjections).set({ state: "tombstoned", deactivated: true })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  const plaintext = JSON.stringify({ schema: "external-inbound-normalized-event.v3", projectionId: fixture.actor.id,
    actorProjectionRevision: fixture.actor.projectionRevision, externalActorId: fixture.actor.externalActorId,
    providerMessageId: "1785758340.000001", providerThreadId: null, providerFileIds: ["F_LEFT"],
    providerAgentMentions: [], content: "file from earlier", createdAt: new Date(1785758340 * 1000).toISOString() });
  const raw = await processVerifiedSlackIngressOnce({ db: fixture.db, leaseOwner: "left-file-raw", leaseMs: 30_000,
    now: () => NOW, scope: { registrationId: aad.registrationId, environment: aad.environment },
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, prepare: async () => ({ kind: "materialize" as const, authority, normalizedPayloadDigest: digest(plaintext),
      encryptedPayload: plaintext, envelopeKeyId: "test", payloadSchemaVersion: 2 as const,
      payloadExpiresAt: new Date(NOW.getTime() + 60_000), validateCurrentAuthority: async () => true }) });
  assert.equal(raw.kind, "materialized");
  let inboundClock = NOW;
  const consume = () => processExternalInboundEventOnce({ db: fixture.db, leaseOwner: "left-file-inbound", durableSlackMode: true,
    dependencies: dependencies(fixture, { now: () => inboundClock, runtime: authority }) });
  const waiting = await consume(); assert.equal(waiting.kind, "blocked");
  if (waiting.kind !== "blocked") throw new Error("expected file wait");
  assert.equal(waiting.reason, "attachment_transfer_pending");
  const harness = await createInboundFileHarness(fixture);
  assert.equal((await harness.processTransfer("left-file-metadata", NOW)).kind, "metadata_ready");
  assert.equal((await harness.processTransfer("left-file-store", NOW)).kind, "stored");
  inboundClock = new Date(NOW.getTime() + 60_000);
  assert.equal((await consume()).kind, "committed");
  assert.equal(harness.counters().downloads, 1);
  const [actor] = await fixture.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, fixture.actor.id));
  assert.equal(actor.state, "tombstoned"); assert.equal(actor.deactivated, true);
});

test("a verified queued edit by a departed human updates only their original message", async () => {
  const { enqueueSlackVerifiedIngress } = await import("./slackVerifiedIngressInbox");
  const { sealSlackVerifiedIngress, openSlackVerifiedIngress } = await import("./slackVerifiedIngressCrypto");
  const { processVerifiedSlackIngressOnce } = await import("./slackVerifiedIngressRuntime");
  const fixture = await seedFixture("public", "slack");
  await fixture.db.update(externalAppInstalls).set({ providerTeamId: fixture.actor.workspaceId,
    providerAuthorityId: fixture.actor.workspaceId }).where(eq(externalAppInstalls.id, fixture.install.id));
  fixture.authority.providerAuthorityId = fixture.actor.workspaceId;
  await enqueue(fixture, "original-before-left", payload(fixture, "1785758340.000001", null, "original text"));
  const original = await process(fixture, dependencies(fixture));
  assert.equal(original.kind, "committed");
  await enableTestSlackIngress();
  const authority = fixture.authority;
  const aad = { purpose: "slack-verified-ingress" as const, version: 1 as const, registrationId: authority.appRegistrationId,
    environment: authority.environment, providerAppId: fixture.install.providerAppId, providerAuthorityId: authority.providerAuthorityId,
    providerConversationId: authority.providerConversationId, providerEventId: "Ev_DEPARTED_EDIT" };
  const event = { type: "event_callback", api_app_id: aad.providerAppId, team_id: aad.providerAuthorityId, event_id: aad.providerEventId,
    event: { type: "message", subtype: "message_changed", channel: aad.providerConversationId, event_ts: "1785758400.000002",
      message: { user: fixture.actor.externalActorId, ts: "1785758340.000001", text: "edited before leaving", edited: { ts: "1785758400.000002" } } } };
  const bytes = Buffer.from(JSON.stringify(event)); const key = Buffer.alloc(32, 4);
  await enqueueSlackVerifiedIngress({ db: fixture.db, aad, rawDigest: digest(bytes.toString("utf8")),
    encryptedPayload: sealSlackVerifiedIngress({ bytes, key, aad }), envelopeKeyId: "test", now: NOW,
    validateEndpoint: async () => true });
  await fixture.db.update(externalActorProjections).set({ state: "tombstoned", deactivated: true })
    .where(eq(externalActorProjections.id, fixture.actor.id));
  const plaintext = JSON.stringify(editPayload(fixture, "1785758340.000001", "1785758400.000002", "edited before leaving"));
  const raw = await processVerifiedSlackIngressOnce({ db: fixture.db, leaseOwner: "left-edit-raw", leaseMs: 30_000,
    now: () => NOW, scope: { registrationId: aad.registrationId, environment: aad.environment },
    crypto: { async seal() { throw new Error("unused"); }, async open(input) {
      return openSlackVerifiedIngress({ envelope: input.encryptedPayload, key, aad: input.aad });
    } }, prepare: async () => ({ kind: "materialize" as const, authority, normalizedPayloadDigest: digest(plaintext),
      encryptedPayload: plaintext, envelopeKeyId: "test", payloadSchemaVersion: 4 as const,
      payloadExpiresAt: new Date(NOW.getTime() + 60_000), validateCurrentAuthority: async () => true }) });
  assert.equal(raw.kind, "materialized");
  const inboxBefore = await fixture.db.select().from(inboxNotificationFacts);
  const result = await processExternalInboundEventOnce({ db: fixture.db, leaseOwner: "left-edit", durableSlackMode: true,
    dependencies: dependencies(fixture, { now: () => NOW, runtime: authority }) });
  assert.equal(result.kind, "committed");
  const [message] = await fixture.db.select().from(messages);
  assert.equal(message.content, "edited before leaving");
  assert.deepEqual(await fixture.db.select().from(inboxNotificationFacts), inboxBefore);
  const [actor] = await fixture.db.select().from(externalActorProjections).where(eq(externalActorProjections.id, fixture.actor.id));
  assert.equal(actor.state, "tombstoned"); assert.equal(actor.deactivated, true);
});
