import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { BasicTracer, MemoryTraceSink } from "@botiverse/raft-shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import {
  agents, attachments, channels, threadFollows, userChannelReadCursors,
  externalAppInstalls,
  externalAppRegistrations,
  externalAppServerGrants,
  externalChannelBindings,
  externalDeliveryPartitions,
  externalOutboundDeliveries,
  jointChannels,
  jointChannelServers,
  messages, tasks, taskEvents, channelConversionJobs, channelConversionPhaseLedger,
  oauthClients,
  serverMembers,
  servers as serversTable,
  users
} from "../db/schema";
import { createServer as createServerService } from "./serverService";
import {
  acceptJointChannelInvite,
  addAgent,
  addHuman,
  createChannel,
  createJointChannel,
  getOrCreateThread,
  getOrCreateThreadForChannel,
  setLocalChannelArchivedByAgent,
} from "./channelService";
import { createMessage } from "./messageService";
import { conversionCommandId, runConversionCommand } from "./channelConversionCommandService";
import {
  createTaskConversationsInTransaction,
  insertTaskConversationFollow,
  resolveLocalTaskConversationId,
} from "./taskConversationService";
import {
  cancelChannelConversionJob,
  getChannelConversionJob,
  getJointShapeForLocalChannel,
  describeChannelConversionPreJobFailure,
  retryChannelConversionJob,
  runChannelConversionJob,
  startChannelToJointConversion,
  type ChannelConversionPhase,
} from "./channelConversionService";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * A conversion as its command runs it (admit, execute: a failed job is
 * retried), then the job: POST /channels/:id/convert-to-joint, retired on
 * every Server (#wg-rbac:#50), drove the same engine.
 */
async function convertThroughCommand(input: { serverId: string; channelId: string; ownerId: string },
  opts: { tracer?: BasicTracer; preJob?: Array<Record<string, unknown>> } = {}) {
  const admitted = await runConversionCommand({ id: conversionCommandId(undefined), serverId: input.serverId,
    sourceChannelId: input.channelId, requestedByUserId: input.ownerId, kind: "start" },
  (event) => { opts.preJob?.push({ ...event }); });
  return runChannelConversionJob(admitted.id, { tracer: opts.tracer });
}

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

// 0317: messages.server_id follows the parent message's channel through the
// conversion move and the compensation move back (trigger-derived).
async function assertParentServer(messageId: string, expectedServerId: string, label: string) {
  const [row] = await getDb().select({ serverId: messages.serverId }).from(messages).where(eq(messages.id, messageId));
  assert.equal(row?.serverId, expectedServerId, label);
}

// 0297: every thread's parent_channel_id follows its parent message through
// conversion (parent move) and compensation (move back), with no app writes.
async function assertThreadParentChannelsFollowParents(threadId: string, expectedChannelId: string | null, label: string) {
  const [thread] = await getDb().select({ parentChannelId: channels.parentChannelId }).from(channels).where(eq(channels.id, threadId));
  assert.equal(thread?.parentChannelId, expectedChannelId, label);
  const drift = await getDb().execute(sql`
    SELECT thread.id FROM channels thread
    JOIN messages parent ON parent.id = thread.parent_message_id
    WHERE thread.type = 'thread' AND thread.parent_channel_id IS DISTINCT FROM parent.channel_id
  `);
  assert.deepEqual(drift.rows, [], `${label}: no thread drifts from its parent message's channel`);
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
  await getDb().update(channels).set({ guestVisible: true })
    .where(eq(channels.id, fixture.channel.id));
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
  await runChannelConversionJob(job.id, { maxPhases: 1 });
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
  assert.equal(converted!.guestVisible, false, "Joint conversion closes the ordinary Guest discovery policy");
  assert.equal((await getDb().select().from(externalChannelBindings)
    .where(eq(externalChannelBindings.id, binding.id)))[0]!.bindingEpoch, 2);
});

test("channel conversion takes the outbound conversation lock before its binding drain snapshot", {
  skip: !CHANNEL_CONVERSION_REAL_PG_URL,
}, async () => {
  await migrateRealPostgres(CHANNEL_CONVERSION_REAL_PG_URL!);
  const app = await openTestApp(CHANNEL_CONVERSION_REAL_PG_URL!, 0, { humanActivityMuteFlagDefaultEnabled: true });
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

test("channel conversion requires fresh provider privacy while a verified public positive control still starts", async ({ app }) => {
  void app;
  const prefix = `convert-privacy-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id,
    name: `${prefix}-room`,
  });
  await seedPublicSlackBinding({ serverId: server.id, ownerId: owner.id, channelId: fixture.channel.id });
  let calls = 0;
  await assert.rejects(startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
    async revalidateExternalPrivacy() {
      calls += 1;
      return [{ kind: "unavailable", reason: "provider_unavailable" }];
    },
  }), (error: unknown) => error instanceof Error
    && "code" in error
    && error.code === "external_binding_privacy_unavailable");
  assert.equal(calls, 1);
  assert.equal((await getDb().select().from(channelConversionJobs)).length, 0);

  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
    async revalidateExternalPrivacy() {
      calls += 1;
      return [{ kind: "fresh" }];
    },
  });
  assert.equal(calls, 2);
  assert.equal(job.status, "pending");
});

test("converting preserves history and late invite accept backfills threads", async ({ app }) => {
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

  const preJob: Array<Record<string, unknown>> = [];
  const completed = await convertThroughCommand({ serverId: server.id, channelId: fixture.channel.id, ownerId: owner.id }, { preJob });
  assert.equal(completed.status, "done");
  assert.equal(completed.phase, "done");
  const [convertedRow] = await getDb().select({ type: channels.type, archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, fixture.channel.id));
  assert.deepEqual(convertedRow, { type: "joint", archivedAt: null });
  for (const phase of ["eligibility_check", "source_lock", "job_insert"]) {
    for (const outcome of ["started", "ok"]) {
      assert.ok(preJob.some((event) => event.phase === phase && event.outcome === outcome), `expected pre-job ${phase} ${outcome}`);
    }
  }
  for (const subcheck of ["direct_task", "thread_task"]) {
    assert.ok(preJob.some((event) => event.phase === "eligibility_check" && event.eligibilitySubcheck === subcheck && event.outcome === "ok"),
      `expected ${subcheck} eligibility subcheck`);
  }

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
    const entryPhase = phase === "finalize" ? "audience_cutover" : phase;
    for (let attempts = 0; current.phase !== entryPhase; attempts++) {
      assert.ok(attempts < 15 && current.status !== "done", `job must reach ${entryPhase}`);
      current = await runChannelConversionJob(current.id, { maxPhases: 1 });
      assert.notEqual(current.status, "failed", `job should reach ${phase} without failing first`);
    }

    const failed = await runChannelConversionJob(job.id, { failBeforePhase: phase });
    assert.equal(failed.status, "failed", `injected ${phase} failure should mark the job failed`);
    assert.equal(failed.phase, entryPhase, `injected ${phase} failure rolls back the whole terminal transaction`);

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

test("conversion failure and retry preserve existing archive provenance", async ({ app }) => {
  assert.ok(app.baseUrl);
  const prefix = `convert-archive-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({ serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id, name: `${prefix}-room`, type: "private" });
  await setLocalChannelArchivedByAgent(fixture.channel.id, agent.id, true);
  const snapshot = async () => (await getDb().select({ archivedAt: channels.archivedAt, archivedByUserId: channels.archivedByUserId, archivedByAgentId: channels.archivedByAgentId }).from(channels).where(eq(channels.id, fixture.channel.id)))[0];
  const archived = await snapshot();
  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: fixture.channel.id, createdByUserId: owner.id });
  assert.deepEqual(await snapshot(), archived);
  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "move_parent_messages" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.progress.sourceLock, "released");
  assert.deepEqual(await snapshot(), archived, "compensation must not unarchive the user's channel");
  const retried = await retryChannelConversionJob(job.id);
  assert.notEqual(retried.conversionEpoch, job.conversionEpoch);
  assert.deepEqual(await snapshot(), archived);
  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done");
  assert.deepEqual(await snapshot(), archived, "conversion and lifecycle are independent");
});

test("channel conversion failure preserves task identity and releases source lock before parent move", async ({ app }) => {
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
  });

  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "move_parent_messages" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.phase, "move_parent_messages");
  assert.equal(failed.progress.taskRowsAffected, 1);
  assert.equal(failed.progress.retryState, "awaiting_retry");
  assert.equal(failed.progress.sourceLock, "released");

  const [lockedSource] = await getDb()
    .select({ archivedAt: channels.archivedAt, archivedByUserId: channels.archivedByUserId })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(lockedSource.archivedAt, null, "compensated failure releases the source lock");
  assert.equal(lockedSource.archivedByUserId, null);
  const [droppedTask] = await getDb()
    .select({ taskStatus: messages.taskStatus, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, task.id));
  assert.equal(droppedTask.taskStatus, "todo", "task identity remains canonical after compensation");
  assert.equal(droppedTask.channelId, fixture.channel.id, "parent messages have not moved yet");

  const writeRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: fixture.channel.id, content: "write after dropped task identity" }),
  });
  assert.equal(writeRes.status, 200, "compensated failure restores ordinary writes");

  const completed = await runChannelConversionJob((await retryChannelConversionJob(job.id)).id);
  assert.equal(completed.status, "done");
  const [convertedTask] = await getDb()
    .select({ taskStatus: messages.taskStatus, channelId: messages.channelId })
    .from(messages)
    .where(eq(messages.id, task.id));
  assert.equal(convertedTask.taskStatus, "todo");
  assert.notEqual(convertedTask.channelId, fixture.channel.id, "retry should still move the message into canonical history");
});

test("channel conversion failure after parent move restores history and releases the source", async ({ app }) => {
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
  assert.equal(failed.progress.sourceLock, "released");

  const [lockedSource] = await getDb()
    .select({ archivedAt: channels.archivedAt, archivedByUserId: channels.archivedByUserId })
    .from(channels)
    .where(eq(channels.id, fixture.channel.id));
  assert.equal(lockedSource.archivedAt, null);
  assert.equal(lockedSource.archivedByUserId, null);
  const localParentMessages = await getDb()
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, fixture.parent.id), eq(messages.channelId, fixture.channel.id)));
  assert.deepEqual(localParentMessages, [{ id: fixture.parent.id }], "compensation restores the source history");
  await assertParentServer(fixture.parent.id, server.id, "compensation restores the origin server_id");
  await assertThreadParentChannelsFollowParents(fixture.thread.id, fixture.channel.id, "after compensation");

  const writeRes = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ channelId: fixture.channel.id, content: "write during partial conversion" }),
  });
  const writeBody = await writeRes.json() as { code?: string; error?: string };
  assert.equal(writeRes.status, 200);

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
  // The local thread is detached from the parent (a projection now) and the
  // canonical thread copy follows the parent into the joint storage channel.
  await assertThreadParentChannelsFollowParents(fixture.thread.id, null, "after completed conversion");
  const [parentAfter] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, fixture.parent.id));
  const [canonicalThread] = await getDb().select({ id: channels.id }).from(channels)
    .where(and(eq(channels.parentMessageId, fixture.parent.id), eq(channels.type, "thread")));
  assert.ok(canonicalThread, "fixture: the canonical thread copy exists");
  await assertThreadParentChannelsFollowParents(canonicalThread.id, parentAfter!.channelId, "canonical thread after completed conversion");
  const [storage] = await getDb().select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.kind, "joint_storage"));
  await assertParentServer(fixture.parent.id, storage!.id, "the converted parent carries the joint_storage server_id");
});

test("a conversion retries a failed persisted job and emits phase spans", async ({ app }) => {
  const traceSink = new MemoryTraceSink();
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
  const job = await startChannelToJointConversion({
    serverId: server.id,
    sourceChannelId: fixture.channel.id,
    createdByUserId: owner.id,
  });
  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "prepare" });
  assert.equal(failed.status, "failed");

  const tracer = new BasicTracer({ sink: traceSink });
  const completed = await convertThroughCommand({ serverId: server.id, channelId: fixture.channel.id, ownerId: owner.id }, { tracer });
  assert.equal(completed.id, job.id, "the start retries the failed job");
  assert.equal(completed.status, "done");
  assert.equal(completed.phase, "done");
  assert.equal(completed.error, null);
  const [convertedRow] = await getDb().select({ type: channels.type, archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, fixture.channel.id));
  assert.deepEqual(convertedRow, { type: "joint", archivedAt: null });

  const spans = traceSink.getAllSpans();
  const phaseSpans = spans.filter((span) => span.name === "server.channel_conversion.phase");
  assert.ok(phaseSpans.length >= 6, "the retry should emit one span per conversion phase");
  assert.ok(phaseSpans.some((span) => span.attrs?.phase === "move_parent_messages" && span.events.some((event) => (
    event.name === "server.channel_conversion.phase.finished"
    && event.attrs?.rows_copied === 1
  ))));
  assert.ok(phaseSpans.every((span) => span.attrs?.job_id === job.id));
  assert.ok(phaseSpans.every((span) => span.attrs?.channel_id === fixture.channel.id));
});

test("converting preserves direct and thread task identity", async ({ app }) => {
  const prefix = `convert-task-preserve-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({ serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id, name: `${prefix}-room` });
  const directTask = await createMessage(fixture.channel.id, "user", owner.id, "direct task", "chat", { taskStatus: "todo", taskNumber: 1 });
  const threadTask = await createMessage(fixture.thread.id, "user", owner.id, "thread task", "chat", { taskStatus: "todo", taskNumber: 2 });
  const completed = await convertThroughCommand({ serverId: server.id, channelId: fixture.channel.id, ownerId: owner.id });
  assert.equal(completed.status, "done");
  assert.equal((await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, fixture.channel.id)))[0]?.type, "joint");
  // The runner's progress stays on the server (conversionJobView): read the stored job.
  const [stored] = await getDb().select({ progress: channelConversionJobs.progress }).from(channelConversionJobs).where(eq(channelConversionJobs.id, completed.id));
  assert.equal((stored!.progress as Record<string, unknown>).taskIdentityPreservedAt != null, true);
  const [direct] = await getDb().select({ taskStatus: messages.taskStatus, taskNumber: messages.taskNumber, channelId: messages.channelId }).from(messages).where(eq(messages.id, directTask.id));
  const [thread] = await getDb().select({ taskStatus: messages.taskStatus, taskNumber: messages.taskNumber, channelId: messages.channelId }).from(messages).where(eq(messages.id, threadTask.id));
  assert.equal(direct.taskStatus, "todo");
  assert.equal(direct.taskNumber, 1);
  assert.equal(thread.taskStatus, "todo");
  assert.equal(thread.taskNumber, 2);
  assert.notEqual(direct.channelId, fixture.channel.id);
  assert.notEqual(thread.channelId, fixture.thread.id);
  const canonicalTasks = await getDb().select().from(tasks).where(inArray(tasks.messageId, [directTask.id, threadTask.id]));
  assert.equal(canonicalTasks.length, 2, "legacy tasks must be promoted to canonical Task v2 rows");
  for (const task of canonicalTasks) {
    assert.ok(task.id);
    assert.equal(task.channelId, task.messageId === directTask.id ? direct.channelId : thread.channelId);
    assert.equal(task.status, "todo");
    assert.equal(task.taskNumber, task.messageId === directTask.id ? 1 : 2);
  }

});

test("converting keeps task assignees and history", async ({ app }) => {
  const prefix = `convert-task-history-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({ serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id, name: `${prefix}-room` });
  const directTask = await createMessage(fixture.channel.id, "user", owner.id, "assigned task", "chat", { taskStatus: "todo", taskNumber: 1 });
  const threadTask = await createMessage(fixture.thread.id, "user", owner.id, "assigned thread task", "chat", { taskStatus: "todo", taskNumber: 2 });
  await getDb().update(messages).set({ taskAssigneeType: "user", taskAssigneeId: owner.id, taskClaimedAt: new Date() }).where(eq(messages.id, directTask.id));
  await getDb().update(messages).set({ taskStatus: "done", taskAssigneeType: "agent", taskAssigneeId: agent.id, taskCompletedAt: new Date() }).where(eq(messages.id, threadTask.id));
  const [existingTask] = await getDb().insert(tasks).values({
    channelId: fixture.channel.id, messageId: directTask.id, taskNumber: 1, title: "assigned task",
    createdByType: "user", createdById: owner.id, claimedByType: "user", claimedById: owner.id,
  }).returning();
  const [history] = await getDb().insert(taskEvents).values({ taskId: existingTask.id, eventType: "assignee_changed", actorType: "user", actorId: owner.id, payload: { assigneeId: owner.id } }).returning();
  const completed = await convertThroughCommand({ serverId: server.id, channelId: fixture.channel.id, ownerId: owner.id });
  assert.equal(completed.status, "done");
  assert.equal((await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, fixture.channel.id)))[0]?.type, "joint");
  const rows = await getDb().select({ id: messages.id, taskStatus: messages.taskStatus, taskNumber: messages.taskNumber, taskAssigneeType: messages.taskAssigneeType, taskAssigneeId: messages.taskAssigneeId }).from(messages).where(inArray(messages.id, [directTask.id, threadTask.id]));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.taskStatus, row.taskNumber, row.taskAssigneeType, row.taskAssigneeId]), [["todo", 1, "user", owner.id], ["done", 2, "agent", agent.id]]);
  const canonical = await getDb().select().from(tasks).where(inArray(tasks.messageId, [directTask.id, threadTask.id]));
  assert.equal(canonical.length, 2, "canonical task rows, not only legacy message shadows, must survive");
  const preserved = canonical.find(task => task.id === existingTask.id)!;
  const promoted = canonical.find(task => task.messageId === threadTask.id)!;
  assert.equal(preserved.claimedById, owner.id);
  assert.notEqual(preserved.channelId, fixture.channel.id);
  assert.equal(promoted.status, "done");
  assert.equal(promoted.claimedByType, "agent");
  assert.equal(promoted.claimedById, agent.id);
  assert.ok(promoted.completedAt);
  assert.deepEqual(await getDb().select().from(taskEvents).where(eq(taskEvents.id, history.id)), [history]);

});

test("atomic cutover drains every cleanup batch before committing success", async ({ app }) => {
  assert.ok(app.baseUrl);
  const prefix = `convert-cleanup-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({ serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id, name: prefix });
  const passwordHash = await fixturePasswordHash("password123");
  const people = await getDb().insert(users).values(Array.from({ length: 129 }, (_, i) => ({ email: `${prefix}-${i}@slock.test`, name: `${prefix}-${i}`, passwordHash }))).returning({ id: users.id });
  await getDb().insert(serverMembers).values(people.map(person => ({ serverId: server.id, userId: person.id, role: "member" as const })));
  await getDb().insert(userChannelReadCursors).values(people.map(person => ({ channelId: fixture.channel.id, userId: person.id })));
  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: fixture.channel.id, createdByUserId: owner.id });
  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done", "cleanup crossing the 128-row boundary must finish in the terminal transaction");
  assert.deepEqual(await getDb().select().from(userChannelReadCursors).where(eq(userChannelReadCursors.channelId, fixture.channel.id)), []);
});

test("cancel compensates every task created by an incomplete promotion batch", async ({ app }) => {
  assert.ok(app.baseUrl);
  const prefix = `convert-task-batch-${randomUUID().slice(0, 8)}`;
  const { owner, server } = await seedConversionActors(prefix);
  const channel = await createChannel(server.id, prefix, undefined, "private");
  await addHuman(channel.id, owner.id);
  await getDb().insert(messages).values(Array.from({ length: 129 }, (_, i) => ({
    channelId: channel.id, senderType: "user" as const, senderId: owner.id,
    content: `legacy task ${i}`, taskStatus: "todo" as const, taskNumber: i + 1,
  })));
  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: channel.id, createdByUserId: owner.id });
  const partial = await runChannelConversionJob(job.id, { maxPhases: 2 });
  assert.equal(partial.phase, "prepare_tasks");
  assert.equal((await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id))).length, 128);
  assert.equal((await cancelChannelConversionJob(job.id)).status, "canceled");
  assert.deepEqual(await getDb().select().from(tasks).where(eq(tasks.channelId, channel.id)), []);
  assert.equal((await getDb().select().from(messages).where(eq(messages.channelId, channel.id))).length, 129);
});

/**
 * Task v2: a channel holding a task whose conversation has a reply, an
 * attachment and a follower. Returns the conversation (on the host server).
 */
async function seedTaskConversation(input: { serverId: string; channelId: string; ownerId: string; memberId: string }) {
  const [task] = await getDb().insert(tasks).values({
    channelId: input.channelId,
    taskNumber: 1,
    title: "converted task",
    createdByType: "user",
    createdById: input.ownerId,
  }).returning();
  const created = await createTaskConversationsInTransaction(getDb(), {
    tasks: [{ id: task!.id, channelId: input.channelId }],
    storageChannel: { id: input.channelId, serverId: input.serverId, type: "channel" },
    initiatingServerId: input.serverId,
    createdByUserId: input.ownerId,
  });
  const conversationId = created.get(task!.id)!.canonicalChannelId;
  await insertTaskConversationFollow(getDb(), {
    conversationChannelId: conversationId,
    taskId: task!.id,
    follower: { type: "user", id: input.memberId },
    reason: "manual",
  });
  const reply = await createMessage(conversationId, "user", input.ownerId, "task conversation reply");
  const [attachment] = await insertAttachmentsWithObjects(getDb(), {
    messageId: reply.id,
    channelId: conversationId,
    uploaderId: input.ownerId,
    uploaderType: "user",
    filename: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
    storageKey: `test/${randomUUID()}`,
  });
  return { task: task!, conversationId, reply, attachment: attachment! };
}

async function readTaskConversationJointShape(taskId: string, localConversationId: string) {
  const [task] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  const [local] = await getDb().select().from(channels).where(eq(channels.id, localConversationId));
  const projections = await getDb()
    .select({
      role: jointChannelServers.role,
      status: jointChannelServers.status,
      serverId: jointChannelServers.serverId,
      canonicalChannelId: jointChannels.canonicalChannelId,
    })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, localConversationId));
  const conversations = await getDb().select().from(channels)
    .where(and(eq(channels.taskId, taskId), eq(channels.type, "task")));
  return { task: task!, local: local!, projections, conversations };
}

test("channel → joint conversion turns an existing task conversation into a joint one (canonical on storage, host local projection)", async ({ app }) => {
  assert.ok(app.baseUrl);
  const prefix = `convert-task-conv-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id, name: `${prefix}-room`,
  });
  const seeded = await seedTaskConversation({ serverId: server.id, channelId: fixture.channel.id, ownerId: owner.id, memberId: member.id });

  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: fixture.channel.id, createdByUserId: owner.id });
  const completed = await runChannelConversionJob(job.id);
  assert.equal(completed.status, "done");
  assert.equal(completed.progress.preparedTaskConversations, 1);

  const [parentProjection] = await getDb()
    .select({ canonicalChannelId: jointChannels.canonicalChannelId })
    .from(jointChannelServers)
    .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
    .where(eq(jointChannelServers.localChannelId, fixture.channel.id));
  const [storage] = await getDb().select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.kind, "joint_storage"));
  const shape = await readTaskConversationJointShape(seeded.task.id, seeded.conversationId);

  assert.equal(shape.task.channelId, parentProjection!.canonicalChannelId, "the task moved to the canonical channel");
  assert.notEqual(shape.task.conversationChannelId, seeded.conversationId, "the task points at a new canonical conversation");
  const canonical = shape.conversations.find((row) => row.id === shape.task.conversationChannelId);
  assert.ok(canonical, "canonical task conversation exists");
  assert.equal(canonical.serverId, storage!.id, "canonical conversation lives on the joint storage server");
  assert.equal(canonical.parentChannelId, parentProjection!.canonicalChannelId);
  assert.equal(shape.local.type, "task");
  assert.equal(shape.local.serverId, server.id);
  assert.equal(shape.local.parentChannelId, fixture.channel.id, "the host's conversation hangs off its local joint channel");
  assert.deepEqual(shape.projections.map(({ role, status, serverId, canonicalChannelId }) => ({ role, status, serverId, canonicalChannelId })), [
    { role: "host", status: "active", serverId: server.id, canonicalChannelId: canonical.id },
  ]);
  assert.equal(await resolveLocalTaskConversationId(seeded.task.id, fixture.channel.id), seeded.conversationId);

  const [movedReply] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, seeded.reply.id));
  assert.equal(movedReply!.channelId, canonical.id, "replies are stored in the canonical conversation");
  assert.deepEqual(await getDb().select().from(messages).where(eq(messages.channelId, seeded.conversationId)), []);
  const [movedAttachment] = await getDb().select({ channelId: attachments.channelId }).from(attachments).where(eq(attachments.id, seeded.attachment.id));
  assert.equal(movedAttachment!.channelId, canonical.id, "attachments move with their message");
  const follows = await getDb().select({ threadChannelId: threadFollows.threadChannelId, unfollowedAt: threadFollows.unfollowedAt })
    .from(threadFollows).where(and(eq(threadFollows.followerType, "user"), eq(threadFollows.followerId, member.id), eq(threadFollows.parentTaskId, seeded.task.id)));
  assert.deepEqual(follows, [{ threadChannelId: seeded.conversationId, unfollowedAt: null }], "follows stay keyed on the host's local conversation");
});

test("channel → joint conversion rollback restores a task conversation it had made joint", async ({ app }) => {
  assert.ok(app.baseUrl);
  const prefix = `convert-task-conv-rb-${randomUUID().slice(0, 8)}`;
  const { owner, member, server, agent } = await seedConversionActors(prefix);
  const fixture = await seedOrdinaryChannel({
    serverId: server.id, ownerId: owner.id, memberId: member.id, agentId: agent.id, name: `${prefix}-room`,
  });
  const seeded = await seedTaskConversation({ serverId: server.id, channelId: fixture.channel.id, ownerId: owner.id, memberId: member.id });

  const job = await startChannelToJointConversion({ serverId: server.id, sourceChannelId: fixture.channel.id, createdByUserId: owner.id });
  // Fails after prepare_threads made the projection and move_thread_messages moved the reply.
  const failed = await runChannelConversionJob(job.id, { failBeforePhase: "verify" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.progress.sourceLock, "released");

  const restored = await readTaskConversationJointShape(seeded.task.id, seeded.conversationId);
  assert.equal(restored.task.channelId, fixture.channel.id, "the task is back in the source channel");
  assert.equal(restored.task.conversationChannelId, seeded.conversationId, "the task points at its original conversation again");
  assert.equal(restored.local.parentChannelId, fixture.channel.id);
  assert.deepEqual(restored.projections, [], "no joint record is left for the conversation");
  assert.deepEqual(restored.conversations.map((row) => row.id), [seeded.conversationId], "the canonical conversation is gone");
  const [reply] = await getDb().select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, seeded.reply.id));
  assert.equal(reply!.channelId, seeded.conversationId, "the reply is back in the original conversation");
  const [attachment] = await getDb().select({ channelId: attachments.channelId }).from(attachments).where(eq(attachments.id, seeded.attachment.id));
  assert.equal(attachment!.channelId, seeded.conversationId);

  const completed = await runChannelConversionJob((await retryChannelConversionJob(job.id)).id);
  assert.equal(completed.status, "done");
  const converted = await readTaskConversationJointShape(seeded.task.id, seeded.conversationId);
  assert.notEqual(converted.task.conversationChannelId, seeded.conversationId, "retry converts the conversation again");
  assert.equal(converted.projections.length, 1);
  assert.equal(converted.conversations.length, 2);
});
