import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { and, eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { openTestApp } from "../test/integration/app.js";
import { getDb } from "../db/index.js";
import {
  agents, channels,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  jointChannels,
  jointChannelServers,
  messages,
  oauthClients,
  serverMembers,
  servers as serversTable,
  users
} from "../db/schema.js";
import { createServer as createServerService } from "./serverService.js";
import {
  addAgent,
  addHuman,
  createChannel,
  createJointChannel,
  getOrCreateThread,
  getOrCreateThreadForChannel,
  setLocalChannelArchivedByAgent,
} from "./channelService.js";
import { createMessage } from "./messageService.js";
import {
  getChannelConversionJob,
  getJointShapeForLocalChannel,
  describeChannelConversionPreJobFailure,
  retryChannelConversionJob,
  runChannelConversionJob,
  startChannelToJointConversion,
  type ChannelConversionPhase,
} from "./channelConversionService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

const CHANNEL_CONVERSION_REAL_PG_URL = process.env.CHANNEL_CONVERSION_REAL_PG_URL;
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

async function migrateRealPostgres(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

function headers(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

async function seedPublicSlackBinding(input: {
  serverId: string;
  ownerId: string;
  channelId: string;
  privacyClass?: "public" | "private";
}) {
  const db = getDb();
  const [client] = await db.insert(oauthClients).values({
    serverId: input.serverId,
    clientId: `conversion-slack-${randomUUID()}`,
    clientSecretHash: "test-only",
    appType: "slock_builtin",
    name: "Slack Bridge conversion",
    allowedScopes: ["messages:read", "messages:write"],
    createdByUserId: input.ownerId,
  }).returning();
  const [registration] = await db.insert(externalAppRegistrations).values({
    oauthClientId: client.id,
    provider: "slack",
    environment: "test",
    providerAppId: `A_CONVERSION_${randomUUID()}`,
    providerOAuthClientId: `conversion-${randomUUID()}`,
    capabilityManifestVersion: 1,
    capabilityManifestHash: "conversion-manifest-v1",
    requiredCapabilities: ["external_projection", "channel_events"],
  }).returning();
  const [grant] = await db.insert(externalAppServerGrants).values({
    serverId: input.serverId,
    registrationId: registration.id,
    grantEpoch: 1,
    grantedManifestVersion: 1,
    grantedManifestHash: "conversion-manifest-v1",
    grantedCapabilities: ["external_projection", "channel_events"],
    grantedByType: "human",
    grantedById: input.ownerId,
  }).returning();
  const providerAuthorityId = `T_CONVERSION_${randomUUID()}`;
  const [install] = await db.insert(externalAppInstalls).values({
    serverId: input.serverId,
    registrationId: registration.id,
    serverGrantId: grant.id,
    grantEpoch: 1,
    connectionEpoch: 1,
    installedScopes: ["channels:history", "channels:read", "chat:write"],
    providerAppId: registration.providerAppId,
    providerTeamId: providerAuthorityId,
    authorityType: "team",
    providerAuthorityId,
    botUserId: `U_CONVERSION_${randomUUID()}`,
    providerBotId: `B_CONVERSION_${randomUUID()}`,
    lastVerifiedAt: new Date(),
  }).returning();
  const [binding] = await db.insert(externalChannelBindings).values({
    serverId: input.serverId,
    registrationId: registration.id,
    installId: install.id,
    channelId: input.channelId,
    providerConversationId: `C_CONVERSION_${randomUUID()}`,
    providerConversationKind: input.privacyClass === "private" ? "private_channel" : "public_channel",
    privacyClass: input.privacyClass ?? "public",
    state: "active",
    grantEpoch: 1,
    connectionEpoch: 1,
    bindingEpoch: 1,
    audienceRevision: input.privacyClass === "private" ? 1 : null,
    audienceFreshUntil: input.privacyClass === "private"
      ? new Date(Date.now() + 60_000)
      : null,
    consentedByType: "human",
    consentedById: input.ownerId,
    consentedAt: new Date(),
  }).returning();
  return binding;
}

async function seedUser(email: string, name: string) {
  const [user] = await getDb().insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}



async function createFounderServer(name: string, slug: string, ownerId: string) {
  const server = await createServerService(name, slug, ownerId);
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  return { ...server, plan: "founder" };
}

async function seedConversionActors(prefix: string) {
  const owner = await seedUser(`${prefix}-owner@slock.test`, `${prefix}-owner`);
  const member = await seedUser(`${prefix}-member@slock.test`, `${prefix}-member`);
  const targetOwner = await seedUser(`${prefix}-target@slock.test`, `${prefix}-target`);
  const server = await createFounderServer(`${prefix} host`, `${prefix}-host`, owner.id);
  const targetServer = await createFounderServer(`${prefix} target`, `${prefix}-target`, targetOwner.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  const [agent] = await getDb().insert(agents).values({
    serverId: server.id,
    name: `${prefix}-agent`,
    runtime: "codex",
  }).returning();
  return { owner, member, targetOwner, server, targetServer, agent };
}

async function seedOrdinaryChannel(input: {
  serverId: string;
  ownerId: string;
  memberId: string;
  agentId: string;
  name: string;
  type?: "channel" | "private";
}) {
  const channel = await createChannel(input.serverId, input.name, "convert me", input.type ?? "channel");
  await addHuman(channel.id, input.ownerId);
  await addHuman(channel.id, input.memberId);
  await addAgent(channel.id, input.agentId);
  const parent = await createMessage(channel.id, "user", input.ownerId, "parent history");
  const thread = await getOrCreateThread(parent.id, input.ownerId, "user");
  const reply = await createMessage(thread.id, "user", input.ownerId, "thread history");
  return { channel, parent, thread, reply };
}

async function seedDirectJointReference(input: {
  serverId: string;
  ownerId: string;
  memberId: string;
  agentId: string;
  targetServerSlug: string;
  targetUserName: string;
  name: string;
}) {
  const result = await createJointChannel({
    hostServerId: input.serverId,
    createdByUserId: input.ownerId,
    name: input.name,
    description: "direct joint",
    userIds: [input.memberId],
    agentIds: [input.agentId],
    targetServerSlug: input.targetServerSlug,
    invitedPeople: [`@${input.targetUserName}`],
  });
  const [projection] = await getDb()
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, result.channel.id));
  assert.ok(projection, "direct joint projection should exist");

  const parent = await createMessage(projection.canonicalChannelId, "user", input.ownerId, "parent history");
  const thread = await getOrCreateThreadForChannel(result.channel.id, parent.id, input.ownerId, "user");
  await createMessage(thread.canonicalThreadChannelId, "user", input.ownerId, "thread history");
  return result.channel;
}

function normalizeShape(shape: Awaited<ReturnType<typeof getJointShapeForLocalChannel>>) {
  assert.ok(shape, "joint shape should exist");
  return {
    parentRole: shape.parent.role,
    memberUserIds: shape.memberUserIds,
    memberAgentIds: shape.memberAgentIds,
    parentMessages: shape.parentMessages
      .map((message) => ({
        content: message.content,
        senderType: message.senderType,
        hasThread: message.threadId != null,
      }))
      .sort((left, right) => left.content.localeCompare(right.content)),
    threads: shape.threadRows
      .map((thread) => ({
        parentContent: thread.parentContent,
        localParentCleared: thread.localParentMessageId == null,
      }))
      .sort((left, right) => left.parentContent.localeCompare(right.parentContent)),
  };
}

test("channel conversion pre-job failures produce bounded retryable response copy", () => {
  const failure = describeChannelConversionPreJobFailure(
    "eligibility_check",
    new Error("canceling statement due to statement timeout"),
  );
  assert.equal(failure.status, 503);
  assert.equal(failure.code, "channel_conversion_eligibility_check_timeout");
  assert.equal(failure.phase, "eligibility_check");
  assert.equal(failure.retryable, true);
  assert.match(failure.error, /checking whether the channel contains tasks/);
  assert.match(failure.error, /source channel was not locked/);
  assert.doesNotMatch(failure.error, /canceling statement/);
});

test("channel conversion drains and epoch-freezes a public Slack binding before Joint storage cutover", async ({ app }) => {
  const prefix = `convert-slack-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
  });
  const binding = await seedPublicSlackBinding({
    serverId: server.id,
    ownerId: owner.id,
    channelId: fixture.channel.id,
  });
  const [sourceMessage] = await getDb().insert(messages).values({
    channelId: fixture.channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "pending external delivery",
  }).returning();
  await getDb().transaction(async (tx) => {
    await tx.insert(externalDeliveryPartitions).values({
      bindingId: binding.id,
      bindingEpoch: binding.bindingEpoch,
      lastEnqueuedPosition: 1,
      cursorPosition: 0,
    });
    await tx.insert(externalOutboundDeliveries).values({
      sourceMessageId: sourceMessage.id,
      bindingId: binding.id,
      bindingEpoch: binding.bindingEpoch,
      partitionPosition: 1,
      enqueueRuntimeRevision: "conversion-runtime-v1",
      renderSnapshot: {},
      renderSnapshotDigest: "a".repeat(64),
      reconciliationMarker: "A".repeat(43),
    });
  });

  await assert.rejects(
    startChannelToJointConversion({
      serverId: server.id,
      sourceChannelId: fixture.channel.id,
      createdByUserId: owner.id,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "external_binding_conversion_drain_pending",
  );
  assert.equal((await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id)))[0]!.state, "active");
  assert.equal((await getDb().select().from(channels)
    .where(eq(channels.id, fixture.channel.id)))[0]!.archivedAt, null);

  await getDb().update(externalOutboundDeliveries).set({
    state: "skipped",
    stateReason: "conversion-test-drained",
  }).where(eq(externalOutboundDeliveries.bindingId, binding.id));
  await getDb().update(externalDeliveryPartitions).set({ cursorPosition: 1 })
    .where(eq(externalDeliveryPartitions.bindingId, binding.id));

  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
  });
  const frozen = (await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id)))[0]!;
  assert.equal(frozen.channelId, fixture.channel.id, "permission-facing binding anchor stays local");
  assert.equal(frozen.state, "paused");
  assert.equal(frozen.stateReason, "channel_conversion_reconfirmation_required");
  assert.equal(frozen.bindingEpoch, binding.bindingEpoch + 1);

  await runChannelConversionJob(job.id);
  const [converted] = await getDb().select().from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(converted!.type, "joint");
  assert.equal((await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id)))[0]!.bindingEpoch, 2);
});

test("channel conversion takes the outbound conversation lock before its binding drain snapshot", {
  skip: !CHANNEL_CONVERSION_REAL_PG_URL,
}, async () => {
  await migrateRealPostgres(CHANNEL_CONVERSION_REAL_PG_URL!);
  const app = await openTestApp(CHANNEL_CONVERSION_REAL_PG_URL!, 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const prefix = `convert-slack-race-${randomUUID().slice(0, 8)}`;
    const { owner, member, server, agent } = await seedConversionActors(prefix);
    const fixture = await seedOrdinaryChannel({
      serverId: server.id,
      ownerId: owner.id,
      memberId: member.id,
      agentId: agent.id,
      name: `${prefix}-room`,
    });
    const binding = await seedPublicSlackBinding({
      serverId: server.id,
      ownerId: owner.id,
      channelId: fixture.channel.id,
    });
    const reconciliationMarker = prefix.replaceAll("-", "").padEnd(43, "R");

    let senderLockedResolve!: () => void;
    const senderLocked = new Promise<void>((resolve) => { senderLockedResolve = resolve; });
    let releaseSender!: () => void;
    const senderMayCommit = new Promise<void>((resolve) => { releaseSender = resolve; });
    const sender = getDb().transaction(async (tx) => {
      // This is the exact row-lock primitive used by outbound admission before
      // source insertion. Its permanent helper contract is covered in the
      // outbound suite; this tooth focuses on conversion's relative order.
      await tx.select({ id: channels.id }).from(channels)
        .where(eq(channels.id, fixture.channel.id)).for("update").limit(1);
      const [sourceMessage] = await tx.insert(messages).values({
        channelId: fixture.channel.id,
        senderType: "user",
        senderId: owner.id,
        content: "concurrent old-epoch delivery",
      }).returning();
      senderLockedResolve();
      await senderMayCommit;
      await tx.insert(externalDeliveryPartitions).values({
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        lastEnqueuedPosition: 1,
        cursorPosition: 0,
      });
      await tx.insert(externalOutboundDeliveries).values({
        sourceMessageId: sourceMessage.id,
        bindingId: binding.id,
        bindingEpoch: binding.bindingEpoch,
        partitionPosition: 1,
        enqueueRuntimeRevision: "conversion-race-runtime-v1",
        renderSnapshot: {},
        renderSnapshotDigest: "b".repeat(64),
        reconciliationMarker,
      });
    });
    await senderLocked;

    let sourceLockPhaseStarted = false;
    try {
      await assert.rejects(
        startChannelToJointConversion({
          serverId: server.id,
          sourceChannelId: fixture.channel.id,
          createdByUserId: owner.id,
          tracePreJobPhase(event) {
            if (event.phase === "source_lock" && event.outcome === "started") {
              sourceLockPhaseStarted = true;
              releaseSender();
            }
          },
        }),
        (error: unknown) => error instanceof Error
          && "code" in error
          && error.code === "external_binding_conversion_drain_pending",
      );
    } finally {
      releaseSender();
      await sender;
    }
    assert.equal(sourceLockPhaseStarted, true);
    assert.equal((await getDb().select().from(externalChannelBindings)
      .where(eq(externalChannelBindings.id, binding.id)))[0]!.state, "active");
    assert.equal((await getDb().select().from(channels)
      .where(eq(channels.id, fixture.channel.id)))[0]!.archivedAt, null);
    assert.equal((await getDb().select().from(externalOutboundDeliveries)
      .where(eq(externalOutboundDeliveries.bindingId, binding.id))).length, 1);
  } finally {
    await app.close();
  }
});

test("channel conversion fails closed for a private Slack audience without a migration contract", async ({ app }) => {
  const prefix = `convert-private-slack-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
    type: "private",
  });
  await seedPublicSlackBinding({
    serverId: server.id,
    ownerId: owner.id,
    channelId: fixture.channel.id,
    privacyClass: "private",
  });
  await assert.rejects(
    startChannelToJointConversion({
      serverId: server.id,
      sourceChannelId: fixture.channel.id,
      createdByUserId: owner.id,
    }),
    (error: unknown) => error instanceof Error
      && "code" in error
      && error.code === "private_external_binding_conversion_unsupported",
  );
  assert.equal((await getDb().select().from(channels)
    .where(eq(channels.id, fixture.channel.id)))[0]!.archivedAt, null);
});

test("POST /api/channels/:id/convert-to-joint preserves history and late invite accept backfills threads", async ({ app }) => {
  const traceSink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink: traceSink }));
  const prefix = `convert-route-${randomUUID().slice(0, 8)}`;
  const { owner, member, targetOwner, server, targetServer, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
    type: "channel",
  });
  const ownerToken = await tokenForHuman(owner.email);
  const targetToken = await tokenForHuman(targetOwner.email);

  const convertRes = await fetch(`${app.baseUrl}/api/channels/${fixture.channel.id}/convert-to-joint`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  const rawConvertBody = await convertRes.text();
  assert.equal(convertRes.status, 200, rawConvertBody);
  const convertedBody = JSON.parse(rawConvertBody) as {
    channel: { id: string; type: string; archivedAt: string | null; jointRole?: string };
    conversionJob: { status: string; phase: string };
  };
  assert.equal(convertedBody.channel.id, fixture.channel.id);
  assert.equal(convertedBody.channel.type, "joint");
  assert.equal(convertedBody.channel.archivedAt, null);
  assert.equal(convertedBody.channel.jointRole, "host");
  assert.equal(convertedBody.conversionJob.status, "done");
  assert.equal(convertedBody.conversionJob.phase, "done");
  const rootSpan = traceSink.getAllSpans().find((span) =>
    span.name === "server.http.request"
    && span.attrs?.["http.route"] === "/api/channels/:id/convert-to-joint"
  );
  assert.ok(rootSpan, "conversion route should emit an HTTP root span");
  const preJobEvents = rootSpan.events.filter((event) => event.name === "server.channel_conversion.pre_job");
  for (const phase of ["eligibility_check", "source_lock", "job_insert"]) {
    assert.ok(
      preJobEvents.some((event) =>
        event.attrs?.phase === phase
        && event.attrs?.outcome === "started"
        && event.attrs?.channel_id === fixture.channel.id,
      ),
      `expected pre-job ${phase} started event`,
    );
    assert.ok(
      preJobEvents.some((event) =>
        event.attrs?.phase === phase
        && event.attrs?.outcome === "ok"
        && event.attrs?.channel_id === fixture.channel.id,
      ),
      `expected pre-job ${phase} ok event`,
    );
  }
  assert.ok(
    preJobEvents.some((event) =>
      event.attrs?.phase === "eligibility_check"
      && event.attrs?.eligibility_subcheck === "direct_task"
      && event.attrs?.outcome === "ok"
    ),
    "expected direct-task eligibility subcheck event",
  );
  assert.ok(
    preJobEvents.some((event) =>
      event.attrs?.phase === "eligibility_check"
      && event.attrs?.eligibility_subcheck === "thread_task"
      && event.attrs?.outcome === "ok"
    ),
    "expected thread-task eligibility subcheck event",
  );

  const [projection] = await getDb()
    .select({
      jointChannelId: jointChannelServers.jointChannelId,
      canonicalChannelId: jointChannels.canonicalChannelId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, fixture.channel.id));
  assert.ok(projection, "converted host projection should resolve to a joint channel");

  const localParentMessages = await getDb().select().from(messages).where(eq(messages.channelId, fixture.channel.id));
  assert.deepEqual(localParentMessages, [], "converted local parent projection should not retain storage messages");
  const canonicalParentMessages = await getDb().select().from(messages).where(eq(messages.channelId, projection.canonicalChannelId));
  assert.deepEqual(canonicalParentMessages.map((message) => message.id), [fixture.parent.id]);
  assert.notEqual(canonicalParentMessages[0].threadId, fixture.thread.id, "parent thread marker should point at canonical thread storage");

  const localThreadMessages = await getDb().select().from(messages).where(eq(messages.channelId, fixture.thread.id));
  assert.deepEqual(localThreadMessages, [], "converted local thread projection should not retain storage messages");
  const [localThread] = await getDb()
    .select({ parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(eq(channels.id, fixture.thread.id));
  assert.equal(localThread.parentMessageId, null, "converted host thread should become a joint local projection");

  const inviteRes = await fetch(`${app.baseUrl}/api/channels/${fixture.channel.id}/joint-invites`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({
      targetServerSlug: targetServer.slug,
      invitedPeople: [`@${targetOwner.name}`],
    }),
  });
  assert.equal(inviteRes.status, 200);
  const inviteBody = await inviteRes.json() as { jointInvite: { id: string } };

  const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${inviteBody.jointInvite.id}/accept`, {
    method: "POST",
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(acceptRes.status, 200);
  const targetProjection = await acceptRes.json() as { id: string; type: string };
  assert.equal(targetProjection.type, "joint");

  const targetMessagesRes = await fetch(`${app.baseUrl}/api/messages/channel/${targetProjection.id}?limit=10`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetMessagesRes.status, 200);
  const targetMessagesBody = await targetMessagesRes.json() as { messages: Array<{ id: string; content: string }> };
  assert.ok(
    targetMessagesBody.messages.some((message) => message.id === fixture.parent.id && message.content === "parent history"),
    "new target projection should read pre-conversion parent history",
  );

  const targetThreadsRes = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}/threads?parentMessageIds=${fixture.parent.id}`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetThreadsRes.status, 200);
  const targetThreadsBody = await targetThreadsRes.json() as Record<string, { threadChannelId: string; replyCount: number }>;
  const targetThreadId = targetThreadsBody[fixture.parent.id]?.threadChannelId;
  assert.ok(targetThreadId, "accept should backfill a target local thread projection for converted history");
  assert.equal(targetThreadsBody[fixture.parent.id].replyCount, 1);

  const targetRepliesRes = await fetch(`${app.baseUrl}/api/messages/channel/${targetThreadId}?limit=10`, {
    headers: headers(targetToken, targetServer.id),
  });
  assert.equal(targetRepliesRes.status, 200);
  const targetRepliesBody = await targetRepliesRes.json() as { messages: Array<{ id: string; content: string }> };
  assert.ok(
    targetRepliesBody.messages.some((message) => message.id === fixture.reply.id && message.content === "thread history"),
    "new target thread projection should read pre-conversion thread history",
  );
});

test("channel conversion retries converge to direct joint identity after every phase failure", async ({ app }) => {
  const prefix = `convert-retry-${randomUUID().slice(0, 8)}`;
  const { owner, member, targetOwner, server, targetServer, agent } = await seedConversionActors(prefix);
  const direct = await seedDirectJointReference({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    targetServerSlug: targetServer.slug,
    targetUserName: targetOwner.name,
    name: `${prefix}-direct`,
  });
  const directShape = normalizeShape(await getJointShapeForLocalChannel(direct.id));
  const phases: ChannelConversionPhase[] = [
    "prepare",
    "drop_task_identity",
    "move_parent_messages",
    "prepare_threads",
    "move_thread_messages",
    "verify",
    "finalize",
  ];

  for (const phase of phases) {
    const fixture = await seedOrdinaryChannel({
      serverId: server.id,
      ownerId: owner.id,
      memberId: member.id,
      agentId: agent.id,
      name: `${prefix}-${phase.replaceAll("_", "-")}`,
      type: "private",
    });
    const job = await startChannelToJointConversion({
      serverId: server.id,
      sourceChannelId: fixture.channel.id,
      createdByUserId: owner.id,
    });
    let current = job;
    while (current.phase !== phase) {
      current = await runChannelConversionJob(current.id, { maxPhases: 1 });
      assert.notEqual(current.status, "failed", `job should reach ${phase} without failing first`);
    }

    const failed = await runChannelConversionJob(job.id, { failBeforePhase: phase });
    assert.equal(failed.status, "failed", `injected ${phase} failure should mark the job failed`);
    assert.equal(failed.phase, phase, `injected ${phase} failure should not advance the phase`);

    await retryChannelConversionJob(job.id);
    const completed = await runChannelConversionJob(job.id);
    assert.equal(completed.status, "done", `retry after ${phase} should complete`);
    assert.equal(completed.phase, "done");

    const convertedShape = normalizeShape(await getJointShapeForLocalChannel(fixture.channel.id));
    assert.deepEqual(convertedShape, directShape, `retry after ${phase} should match direct joint identity`);
    const activeJob = await getChannelConversionJob(job.id);
    assert.equal(activeJob?.error, null);
  }
});

test("channel conversion failure before parent move unlocks intact source and retry re-locks before resuming", async ({ app }) => {
  const prefix = `convert-unlock-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
    type: "private",
  });
  const agentArchive = await setLocalChannelArchivedByAgent(fixture.channel.id, agent.id, true);
  assert.equal(agentArchive.changed, true);
  assert.equal(agentArchive.channel.archivedByAgentId, agent.id);
  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
  });
  const [sourceLock] = await getDb()
    .select({
      archivedAt: channels.archivedAt,
      archivedByUserId: channels.archivedByUserId,
      archivedByAgentId: channels.archivedByAgentId,
    })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.ok(sourceLock.archivedAt);
  assert.equal(sourceLock.archivedByUserId, owner.id, "conversion lock must record its human initiator");
  assert.equal(sourceLock.archivedByAgentId, null, "conversion lock must replace prior agent provenance");

  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "move_parent_messages" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "move_parent_messages");

  const [unlockedSource] = await getDb()
    .select({
      archivedAt: channels.archivedAt,
      archivedByUserId: channels.archivedByUserId,
      archivedByAgentId: channels.archivedByAgentId,
    })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(unlockedSource.archivedAt, null, "pre-move failure must release the read-only archive lock");
  assert.equal(unlockedSource.archivedByUserId, null);
  assert.equal(unlockedSource.archivedByAgentId, null);
  const stillLocalParentMessages = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, fixture.parent.id), eq(messages.channelId, fixture.channel.id)));
  assert.equal(stillLocalParentMessages.length, 1, "pre-move failure should leave source history intact");
  const postFailureParent = await createMessage(fixture.channel.id, "user", owner.id, "post-failure parent");

  const retried = await retryChannelConversionJob(job.id);
  assert.equal(retried.phase, "prepare", "failed retry should restart idempotent phases to sweep post-failure writes");
  const [relockedSource] = await getDb()
    .select({
      archivedAt: channels.archivedAt,
      archivedByUserId: channels.archivedByUserId,
      archivedByAgentId: channels.archivedByAgentId,
    })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.ok(relockedSource.archivedAt, "retry should re-lock while conversion is running");
  assert.equal(relockedSource.archivedByUserId, owner.id);
  assert.equal(relockedSource.archivedByAgentId, null);

  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done");
  const [finalSource] = await getDb()
    .select({
      type: channels.type,
      archivedAt: channels.archivedAt,
      archivedByUserId: channels.archivedByUserId,
      archivedByAgentId: channels.archivedByAgentId,
    })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(finalSource.type, "joint");
  assert.equal(finalSource.archivedAt, null);
  assert.equal(finalSource.archivedByUserId, null);
  assert.equal(finalSource.archivedByAgentId, null);
  const convertedShape = normalizeShape(await getJointShapeForLocalChannel(fixture.channel.id));
  assert.ok(
    convertedShape.parentMessages.some((message) => message.content === "post-failure parent" && !message.hasThread),
    "retry should move parent messages written after failure unlock",
  );
  const localPostFailureMessages = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, postFailureParent.id), eq(messages.channelId, fixture.channel.id)));
  assert.deepEqual(localPostFailureMessages, []);
});

test("channel conversion failure after task identity drop retains source lock before parent move", async ({ app }) => {
  const prefix = `convert-task-drop-lock-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
    type: "private",
  });
  const ownerToken = await tokenForHuman(owner.email);
  const task = await createMessage(fixture.channel.id, "user", owner.id, "task already dropped before failure", "chat", {
    taskStatus: "todo",
    taskNumber: 1,
  });
  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
    confirmTaskIdentityDrop: true,
  });

  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "move_parent_messages" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "move_parent_messages");
  assert.equal(failed.progress.taskRowsAffected, 1);
  assert.equal(failed.progress.retryState, "awaiting_retry");
  assert.equal(failed.progress.sourceLock, "retained");

  const [lockedSource] = await getDb()
    .select({ archivedAt: channels.archivedAt, archivedByUserId: channels.archivedByUserId })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.ok(lockedSource.archivedAt, "post-task-drop failure must retain the source lock");
  assert.equal(lockedSource.archivedByUserId, owner.id);
  const [droppedTask] = await getDb()
    .select({ taskStatus: messages.taskStatus, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, task.id));
  assert.equal(droppedTask.taskStatus, null, "task identity has already been destructively dropped");
  assert.equal(droppedTask.channelId, fixture.channel.id, "parent messages have not moved yet");

  const writeRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: fixture.channel.id, content: "write after dropped task identity" }),
  });
  const writeBody = await writeRes.json() as { code?: string };
  assert.equal(writeRes.status, 409);
  assert.equal(writeBody.code, "channel_archived");

  const completed = await runChannelConversionJob((await retryChannelConversionJob(job.id)).id);
  assert.equal(completed.status, "done");
  const [convertedTask] = await getDb()
    .select({ taskStatus: messages.taskStatus, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, task.id));
  assert.equal(convertedTask.taskStatus, null);
  assert.notEqual(convertedTask.channelId, fixture.channel.id, "retry should still move the message into canonical history");
});

test("channel conversion failure after parent move keeps source locked and marks awaiting retry", async ({ app }) => {
  const prefix = `convert-await-retry-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
    type: "private",
  });
  const ownerToken = await tokenForHuman(owner.email);
  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
  });

  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "prepare_threads" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "prepare_threads");
  assert.equal(failed.progress.retryState, "awaiting_retry");
  assert.equal(failed.progress.sourceLock, "retained");

  const [lockedSource] = await getDb()
    .select({ archivedAt: channels.archivedAt, archivedByUserId: channels.archivedByUserId })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.ok(lockedSource.archivedAt, "post-move failure should keep the source read-only");
  assert.equal(lockedSource.archivedByUserId, owner.id);
  const localParentMessages = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, fixture.parent.id), eq(messages.channelId, fixture.channel.id)));
  assert.deepEqual(localParentMessages, [], "post-move failure has partial history and must not expose source as writable");

  const writeRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: fixture.channel.id, content: "write during partial conversion" }),
  });
  const writeBody = await writeRes.json() as { code?: string; error?: string };
  assert.equal(writeRes.status, 409);
  assert.equal(writeBody.code, "channel_archived");

  const retried = await retryChannelConversionJob(job.id);
  assert.equal(retried.phase, "prepare");
  assert.equal(retried.progress.retryState, "running");
  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done");
  const [finalSource] = await getDb()
    .select({ type: channels.type, archivedAt: channels.archivedAt, archivedByUserId: channels.archivedByUserId })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(finalSource.type, "joint");
  assert.equal(finalSource.archivedAt, null);
  assert.equal(finalSource.archivedByUserId, null);
});

test("POST /api/channels/:id/convert-to-joint retries a failed persisted job and emits conversion spans", async ({ app }) => {
  const traceSink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink: traceSink }));
  const prefix = `convert-route-retry-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
    type: "channel",
  });
  const ownerToken = await tokenForHuman(owner.email);
  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
  });
  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "prepare" });
  assert.equal(failed.status, "failed");

  const convertRes = await fetch(`${app.baseUrl}/api/channels/${fixture.channel.id}/convert-to-joint`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
  });
  const rawConvertBody = await convertRes.text();
  assert.equal(convertRes.status, 200, rawConvertBody);
  const convertedBody = JSON.parse(rawConvertBody) as {
    channel: { id: string; type: string; archivedAt: string | null };
    conversionJob: { id: string; status: string; phase: string; error: string | null };
  };
  assert.equal(convertedBody.conversionJob.id, job.id);
  assert.equal(convertedBody.conversionJob.status, "done");
  assert.equal(convertedBody.conversionJob.phase, "done");
  assert.equal(convertedBody.conversionJob.error, null);
  assert.equal(convertedBody.channel.type, "joint");
  assert.equal(convertedBody.channel.archivedAt, null);

  const spans = traceSink.getAllSpans();
  const rootSpan = spans.find((span) =>
    span.name === "server.http.request"
    && span.attrs?.["http.route"] === "/api/channels/:id/convert-to-joint"
  );
  assert.ok(rootSpan, "route should emit an HTTP root span");
  const rootJobEvent = rootSpan.events.find((event) => event.name === "server.channel_conversion.job.started");
  assert.ok(rootJobEvent, "HTTP root span should carry a conversion job event");
  assert.equal(rootJobEvent.attrs?.job_id, job.id);
  assert.equal(rootJobEvent.attrs?.channel_id, fixture.channel.id);

  const jobSpan = spans.find((span) => span.name === "server.channel_conversion.job");
  assert.ok(jobSpan, "route should emit a job-level conversion span");
  assert.equal(jobSpan.status, "ok");
  assert.equal(jobSpan.attrs?.job_id, job.id);
  assert.equal(jobSpan.attrs?.channel_id, fixture.channel.id);
  assert.equal(jobSpan.attrs?.outcome, "ok");
  assert.equal(jobSpan.context.traceId, rootSpan.context.traceId);
  assert.equal(jobSpan.context.parentSpanId, rootSpan.context.spanId);

  const phaseSpans = spans.filter((span) => span.name === "server.channel_conversion.phase");
  assert.ok(phaseSpans.length >= 6, "route retry should emit one span per conversion phase");
  assert.ok(phaseSpans.some((span) => span.attrs?.phase === "move_parent_messages" && span.events.some((event) => (
    event.name === "server.channel_conversion.phase.finished"
    && event.attrs?.rows_copied === 1
  ))));
  assert.ok(phaseSpans.every((span) => span.attrs?.job_id === job.id));
  assert.ok(phaseSpans.every((span) => span.attrs?.channel_id === fixture.channel.id));
  assert.ok(phaseSpans.every((span) => span.context.traceId === jobSpan.context.traceId));
  assert.ok(phaseSpans.every((span) => span.context.parentSpanId === jobSpan.context.spanId));
});

test("POST /api/channels/:id/convert-to-joint requires explicit task identity drop confirmation before locking history", async ({ app }) => {
  const prefix = `convert-task-confirm-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
  });
  const directTask = await createMessage(fixture.channel.id, "user", owner.id, "blocked task", "chat", {
    taskStatus: "todo",
    taskNumber: 1,
  });
  const threadTask = await createMessage(fixture.thread.id, "user", owner.id, "blocked thread task", "chat", {
    taskStatus: "todo",
    taskNumber: 2,
  });
  const ownerToken = await tokenForHuman(owner.email);

  const convertRes = await fetch(`${app.baseUrl}/api/channels/${fixture.channel.id}/convert-to-joint`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({}),
  });
  const body = await convertRes.json() as {
    code?: string;
    requiresConfirmation?: boolean;
    taskIdentityDrop?: {
      policy?: string;
      acknowledged?: boolean;
      inventory?: {
        directTaskCount?: number;
        threadTaskCount?: number;
        totalCount?: number;
        directTasks?: Array<{ messageId: string; taskNumber: number | null }>;
        threadTasks?: Array<{ messageId: string; taskNumber: number | null }>;
      };
    };
  };
  assert.equal(convertRes.status, 409);
  assert.equal(body.code, "channel_conversion_task_identity_drop_required");
  assert.equal(body.requiresConfirmation, true);
  assert.equal(body.taskIdentityDrop?.policy, "drop_task_identity");
  assert.equal(body.taskIdentityDrop?.acknowledged, false);
  assert.equal(body.taskIdentityDrop?.inventory?.directTaskCount, 1);
  assert.equal(body.taskIdentityDrop?.inventory?.threadTaskCount, 1);
  assert.equal(body.taskIdentityDrop?.inventory?.totalCount, 2);
  assert.deepEqual(body.taskIdentityDrop?.inventory?.directTasks?.map((task) => task.messageId), [directTask.id]);
  assert.deepEqual(body.taskIdentityDrop?.inventory?.threadTasks?.map((task) => task.messageId), [threadTask.id]);

  const [source] = await getDb()
    .select({ archivedAt: channels.archivedAt })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(source.archivedAt, null, "unconfirmed task-drop conversion should not archive-lock the source");
  const stillTasks = await getDb()
    .select({ id: messages.id, taskStatus: messages.taskStatus, taskNumber: messages.taskNumber })
    .from(messages)
    .where(eq(messages.taskStatus, "todo"));
  assert.ok(stillTasks.some((task) => task.id === directTask.id && task.taskNumber === 1));
});

test("POST /api/channels/:id/convert-to-joint drops direct and thread task identity after confirmation", async ({ app }) => {
  const traceSink = new MemoryTraceSink();
  app.app.set("serverTracer", new BasicTracer({ sink: traceSink }));
  const prefix = `convert-task-drop-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id,
    ownerId: owner.id,
    memberId: member.id,
    agentId: agent.id,
    name: `${prefix}-room`,
  });
  const directTask = await createMessage(fixture.channel.id, "user", owner.id, "confirmed task", "chat", {
    taskStatus: "todo",
    taskNumber: 1,
  });
  const threadTask = await createMessage(fixture.thread.id, "user", owner.id, "confirmed thread task", "chat", {
    taskStatus: "todo",
    taskNumber: 2,
  });
  await getDb().update(messages).set({
    taskAssigneeType: "user",
    taskAssigneeId: owner.id,
    taskClaimedAt: new Date(),
  }).where(eq(messages.id, directTask.id));
  await getDb().update(messages).set({
    taskAssigneeType: "agent",
    taskAssigneeId: agent.id,
    taskClaimedAt: new Date(),
    taskCompletedAt: new Date(),
  }).where(eq(messages.id, threadTask.id));
  const ownerToken = await tokenForHuman(owner.email);

  const convertRes = await fetch(`${app.baseUrl}/api/channels/${fixture.channel.id}/convert-to-joint`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ confirmTaskIdentityDrop: true }),
  });
  const body = await convertRes.json() as { channel?: { type?: string }; conversionJob?: { status?: string; progress?: Record<string, unknown> } };
  assert.equal(convertRes.status, 200);
  assert.equal(body.channel?.type, "joint");
  assert.equal(body.conversionJob?.status, "done");
  assert.equal(body.conversionJob?.progress?.taskConversionPolicy, "drop_task_identity");
  assert.equal(body.conversionJob?.progress?.taskDropAcknowledged, true);
  assert.equal(body.conversionJob?.progress?.taskRowsAffected, 1);
  assert.equal(body.conversionJob?.progress?.threadTaskRowsAffected, 1);
  const dropPhaseSpan = traceSink.getAllSpans().find((span) =>
    span.name === "server.channel_conversion.phase"
    && span.attrs?.phase === "drop_task_identity"
  );
  assert.ok(dropPhaseSpan, "confirmed conversion should trace the drop_task_identity phase");
  const dropFinishedEvent = dropPhaseSpan.events.find((event) =>
    event.name === "server.channel_conversion.phase.finished"
  );
  assert.equal(dropFinishedEvent?.attrs?.task_conversion_policy, "drop_task_identity");
  assert.equal(dropFinishedEvent?.attrs?.task_rows_affected, 1);
  assert.equal(dropFinishedEvent?.attrs?.thread_task_rows_affected, 1);
  assert.equal(dropFinishedEvent?.attrs?.acknowledged, true);
  const traceAttrs = JSON.stringify(dropFinishedEvent?.attrs ?? {});
  assert.equal(traceAttrs.includes("confirmed task"), false, "trace attrs must not include raw direct task text");
  assert.equal(traceAttrs.includes("confirmed thread task"), false, "trace attrs must not include raw thread task text");
  assert.equal(traceAttrs.includes(owner.name), false, "trace attrs must not include assignee display text");
  assert.equal(traceAttrs.includes(agent.name), false, "trace attrs must not include assignee display text");
  for (const attrName of Object.keys(dropFinishedEvent?.attrs ?? {})) {
    assert.doesNotMatch(attrName, /title|body|content|text|assignee/i, "trace attrs should only expose policy/count/outcome fields");
  }

  const [source] = await getDb()
    .select({ type: channels.type, archivedAt: channels.archivedAt })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(source.type, "joint");
  assert.equal(source.archivedAt, null);
  const clearedTasks = await getDb()
    .select({
      id: messages.id,
      taskStatus: messages.taskStatus,
      taskNumber: messages.taskNumber,
      taskAssigneeType: messages.taskAssigneeType,
      taskAssigneeId: messages.taskAssigneeId,
      taskClaimedAt: messages.taskClaimedAt,
      taskCompletedAt: messages.taskCompletedAt,
    })
    .from(messages)
    .where(inArray(messages.id, [directTask.id, threadTask.id]));
  assert.equal(clearedTasks.length, 2);
  for (const task of clearedTasks) {
    assert.equal(task.taskStatus, null);
    assert.equal(task.taskNumber, null);
    assert.equal(task.taskAssigneeType, null);
    assert.equal(task.taskAssigneeId, null);
    assert.equal(task.taskClaimedAt, null);
    assert.equal(task.taskCompletedAt, null);
  }
});
