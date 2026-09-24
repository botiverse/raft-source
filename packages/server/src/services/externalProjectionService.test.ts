import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import { afterEach } from "vitest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  agents,
  channelAgents,
  channels,
  externalActorProjections,
  externalAddressabilityProjections,
  externalAuthorPolicies,
  externalMessageAuthorFacts,
  externalProjectionAvatarArtifacts,
  inboxNotificationFacts,
  messageMentions,
  messages,
  serverMembers,
  servers,
  tasks,
  threadFollows,
  users,
} from "../db/schema.js";
import {
  createCanonicalExternalMessage,
  insertCanonicalExternalMessage,
  loadExternalMessageAuthors,
  resolveExternalAuthorPolicy,
  resolveExternalMentionFromDurableAuthority,
} from "./externalProjectionService.js";
import { deliverMessagesToAgents, listMessagesByIds } from "./messageService.js";
import { convertMessageToTask } from "./taskService.js";
import { searchMessagesForUser } from "./searchService.js";
import { listSaved, saveMessage } from "./savedService.js";
import { getFollowedThreads, getThreadSummaries } from "./channelService.js";
import { normalizeRowForTest } from "./activitySyncService.js";


afterEach(async () => {
  await closeTestDatabase();
});

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

async function seedExternalProjectionSurface() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: `external-owner-${randomUUID()}@slock.test`,
    name: `external-owner-${randomUUID()}`,
    displayName: "Raft Owner",
    passwordHash: "x",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "External Projection Server",
    slug: `external-${randomUUID()}`,
    ownerId: owner.id,
  }).returning();
  await db.insert(serverMembers).values({ serverId: server.id, userId: owner.id, role: "owner" });
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "external-projection-channel",
    type: "channel",
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `external-reader-${randomUUID()}`,
    displayName: "External Reader",
    runtime: "codex",
  }).returning();
  await db.insert(channelAgents).values({ channelId: channel.id, agentId: agent.id });

  const projectionId = randomUUID();
  const [avatar] = await db.insert(externalProjectionAvatarArtifacts).values({
    ownerType: "external_projection",
    ownerId: projectionId,
    sourceDigest: DIGEST_A,
    publicUrl: "https://cdn.slock.test/external/alice.png",
    mimeType: "image/png",
    byteSize: 512,
    width: 64,
    height: 64,
    artifactRevision: 1,
    state: "active",
  }).returning();
  const [actor] = await db.insert(externalActorProjections).values({
    id: projectionId,
    provider: "slack",
    appRegistrationId: "app-registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    externalActorId: "U-ALICE",
    displayName: "Alice External",
    handles: ["alice"],
    actorKind: "human",
    state: "active",
    deactivated: false,
    projectionRevision: 7,
    avatarArtifactId: avatar.id,
    observedAt: new Date("2026-07-31T00:00:00.000Z"),
  }).returning();
  return { db, owner, server, channel, agent, actor, avatar };
}

function canonicalInput(surface: Awaited<ReturnType<typeof seedExternalProjectionSurface>>) {
  return {
    channelId: surface.channel.id,
    content: "hello <result> @owner from Slack",
    createdAt: new Date("2026-07-31T01:02:03.000Z"),
    projectionId: surface.actor.id,
    provider: surface.actor.provider,
    appRegistrationId: surface.actor.appRegistrationId,
    installId: surface.actor.installId,
    workspaceId: surface.actor.workspaceId,
    externalActorId: surface.actor.externalActorId,
    externalConversationId: "C-RAFT",
    externalMessageId: "1722387723.000100",
    actorProjectionRevision: surface.actor.projectionRevision,
  };
}

test("canonical external message freezes human attribution, replays idempotently, and projects inert Agent provenance", async () => {
  const surface = await seedExternalProjectionSurface();
  const input = canonicalInput(surface);

  const created = await createCanonicalExternalMessage(input);
  assert.equal(created.kind, "created");
  assert.equal(created.message.senderType, "external_projection");
  assert.equal(created.message.senderId, surface.actor.id);
  assert.equal(created.author.displayName, "Alice External");
  assert.equal(created.author.avatarUrl, surface.avatar.publicUrl);

  const replay = await createCanonicalExternalMessage(input);
  assert.equal(replay.kind, "duplicate");
  assert.equal(replay.message.id, created.message.id);
  assert.equal(
    (await surface.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length,
    1,
  );
  assert.equal((await surface.db.select().from(externalMessageAuthorFacts)).length, 1);
  assert.equal((await surface.db.select().from(messageMentions)).length, 0);
  assert.equal((await surface.db.select().from(inboxNotificationFacts)).length, 0);

  const [humanProjection] = await listMessagesByIds([created.message.id]);
  assert.equal(humanProjection.senderName, "Alice External");
  assert.equal(humanProjection.externalAuthor?.externalMessageId, input.externalMessageId);
  assert.equal(humanProjection.externalAuthor?.avatarUrl, surface.avatar.publicUrl);

  assert.equal(
    await convertMessageToTask(created.message.id, "user", surface.owner.id, surface.channel.id),
    "external projection messages cannot be claimed as tasks",
  );
  await surface.db.insert(tasks).values({
    channelId: surface.channel.id,
    taskNumber: 1,
    title: "corrupt external task association",
    status: "todo",
    createdByType: "user",
    createdById: surface.owner.id,
    messageId: created.message.id,
  });
  await surface.db.update(messages)
    .set({ actionMetadata: { kind: "action-card", title: "untrusted action" } })
    .where(eq(messages.id, created.message.id));
  const [corruptedProjection] = await listMessagesByIds([created.message.id]);

  const delivered: any[] = [];
  await deliverMessagesToAgents({
    deliverMessage: async (_agentId: string, payload: unknown) => {
      delivered.push(payload);
      return { status: "queued" };
    },
  } as any, [corruptedProjection], "ignored-raft-name");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sender_type, "third_party_app");
  assert.equal(delivered[0].sender_name, "Alice External");
  assert.equal(delivered[0].mentioned, false);
  assert.equal(delivered[0].external_message.schema, "external-message-provenance.v1");
  assert.equal(delivered[0].external_message.message_id, input.externalMessageId);
  assert.match(delivered[0].content, /&lt;result&gt;/);
  assert.match(delivered[0].content, /user:owner/);
  assert.doesNotMatch(delivered[0].content, /@owner/);
  assert.equal("task_status" in delivered[0], false);
  assert.equal("task_number" in delivered[0], false);
  assert.equal("actionMetadata" in delivered[0], false);
  assert.equal("externalAuthor" in delivered[0], false);
});

test("canonical writer rejects stale, non-human, and mismatched authority with zero canonical residue", async () => {
  const surface = await seedExternalProjectionSurface();
  const input = canonicalInput(surface);

  await assert.rejects(
    createCanonicalExternalMessage({ ...input, actorProjectionRevision: input.actorProjectionRevision + 1 }),
    /actor authority is not current/,
  );
  await surface.db.update(externalActorProjections).set({ actorKind: "guest" }).where(eq(externalActorProjections.id, surface.actor.id));
  await assert.rejects(createCanonicalExternalMessage(input), /actor authority is not current/);
  await surface.db.update(externalActorProjections).set({ actorKind: "human", state: "tombstoned" }).where(eq(externalActorProjections.id, surface.actor.id));
  await assert.rejects(createCanonicalExternalMessage(input), /actor authority is not current/);

  assert.equal(
    (await surface.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length,
    0,
  );
  assert.equal((await surface.db.select().from(externalMessageAuthorFacts)).length, 0);
});

test("caller transaction rollback leaves neither external message nor immutable author fact", async () => {
  const surface = await seedExternalProjectionSurface();
  const input = canonicalInput(surface);

  await assert.rejects(
    surface.db.transaction(async (executor) => {
      await insertCanonicalExternalMessage({ ...input, executor });
      throw new Error("after-author-fact failpoint");
    }),
    /after-author-fact failpoint/,
  );

  assert.equal(
    (await surface.db.select().from(messages).where(eq(messages.senderType, "external_projection"))).length,
    0,
  );
  assert.equal((await surface.db.select().from(externalMessageAuthorFacts)).length, 0);
});

test("avatar revocation removes the URL from Human projections without rewriting frozen attribution", async () => {
  const surface = await seedExternalProjectionSurface();
  const created = await createCanonicalExternalMessage(canonicalInput(surface));
  await surface.db.update(externalProjectionAvatarArtifacts)
    .set({ state: "revoked" })
    .where(eq(externalProjectionAvatarArtifacts.id, surface.avatar.id));

  const author = (await loadExternalMessageAuthors([created.message.id])).get(created.message.id);
  assert.equal(author?.displayName, "Alice External");
  assert.equal(author?.avatarUrl, null);
  assert.equal(author?.avatarDigest, DIGEST_A);
  const [fact] = await surface.db.select().from(externalMessageAuthorFacts);
  assert.equal(fact.avatarUrl, surface.avatar.publicUrl);
  assert.equal(fact.avatarDigest, DIGEST_A);
});

test("Human search, saved, and thread projections preserve immutable external attribution and revoked-avatar safety", async () => {
  const surface = await seedExternalProjectionSurface();
  const root = await createCanonicalExternalMessage(canonicalInput(surface));
  const [parent] = await surface.db.insert(messages).values({
    channelId: surface.channel.id,
    senderType: "user",
    senderId: surface.owner.id,
    messageType: "chat",
    content: "thread parent",
    searchText: "thread parent",
  }).returning();
  const [thread] = await surface.db.insert(channels).values({
    serverId: surface.server.id,
    name: `thread-${randomUUID()}`,
    type: "thread",
    parentMessageId: parent.id,
  }).returning();
  const reply = await createCanonicalExternalMessage({
    ...canonicalInput(surface),
    channelId: thread.id,
    content: "external thread reply",
    externalConversationId: "C-THREAD",
    externalMessageId: "1722387723.000200",
  });
  assert.equal((await surface.db.select().from(threadFollows)).length, 0, "external authors never become Raft thread followers");
  await surface.db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: surface.owner.id,
    parentMessageId: parent.id,
    reason: "manual",
  });

  await saveMessage(surface.owner.id, root.message.id, surface.server.id);
  const search = await searchMessagesForUser({
    serverId: surface.server.id,
    userId: surface.owner.id,
    channelId: surface.channel.id,
    query: "hello",
  });
  const searchResult = search.results.find((result) => result.id === root.message.id);
  assert.equal(searchResult?.senderType, "external_projection");
  assert.equal(searchResult?.senderName, "Alice External");
  assert.equal(searchResult?.senderAvatarUrl, surface.avatar.publicUrl);
  assert.equal(searchResult?.externalMessage?.message_id, canonicalInput(surface).externalMessageId);

  const [saved] = await listSaved(surface.owner.id, surface.server.id);
  assert.equal(saved?.messageId, root.message.id);
  assert.equal(saved?.senderName, "Alice External");
  assert.equal(saved?.senderAvatarUrl, surface.avatar.publicUrl);

  const summaries = await getThreadSummaries(surface.channel.id);
  const latestReply = summaries[parent.id]?.latestReplies.find((item) => item.messageId === reply.message.id);
  assert.equal(latestReply?.senderType, "external_projection");
  assert.equal(latestReply?.senderName, "Alice External");
  assert.equal(latestReply?.senderAvatarUrl, surface.avatar.publicUrl);
  const [followedThread] = await getFollowedThreads(surface.server.id, surface.owner.id);
  assert.equal(followedThread?.latestActivitySenderType, "external_projection");
  assert.equal(followedThread?.latestActivitySenderName, "Alice External");
  assert.ok(followedThread);
  const activityRow = normalizeRowForTest({
    kind: "thread",
    firstMentionMessageId: null,
    hasMention: false,
    ...followedThread,
  }, new Map());
  assert.equal(activityRow.type, "thread");
  if (activityRow.type === "thread") {
    assert.equal(activityRow.latestActivitySenderKind, "external_projection");
    assert.equal(activityRow.latestActivitySenderName, "Alice External");
  }

  await surface.db.update(externalActorProjections)
    .set({ displayName: "Mutated Current Actor" })
    .where(eq(externalActorProjections.id, surface.actor.id));
  await surface.db.update(externalProjectionAvatarArtifacts)
    .set({ state: "revoked" })
    .where(eq(externalProjectionAvatarArtifacts.id, surface.avatar.id));

  const revokedSearch = await searchMessagesForUser({
    serverId: surface.server.id,
    userId: surface.owner.id,
    channelId: surface.channel.id,
    query: "hello",
  });
  const revokedSearchResult = revokedSearch.results.find((result) => result.id === root.message.id);
  assert.equal(revokedSearchResult?.senderName, "Alice External");
  assert.equal(revokedSearchResult?.senderAvatarUrl, null);
  const [revokedSaved] = await listSaved(surface.owner.id, surface.server.id);
  assert.equal(revokedSaved?.senderName, "Alice External");
  assert.equal(revokedSaved?.senderAvatarUrl, null);
  const revokedLatest = (await getThreadSummaries(surface.channel.id))[parent.id]?.latestReplies
    .find((item) => item.messageId === reply.message.id);
  assert.equal(revokedLatest?.senderName, "Alice External");
  assert.equal(revokedLatest?.senderAvatarUrl, null);

  await surface.db.delete(externalMessageAuthorFacts)
    .where(eq(externalMessageAuthorFacts.messageId, reply.message.id));
  await assert.rejects(
    getThreadSummaries(surface.channel.id),
    /thread reply is missing immutable author fact/i,
  );
  await assert.rejects(
    getFollowedThreads(surface.server.id, surface.owner.id),
    /followed-thread row is missing immutable author fact/i,
  );
});

test("external message reads fail closed when immutable author facts are missing", async () => {
  const surface = await seedExternalProjectionSurface();
  const created = await createCanonicalExternalMessage(canonicalInput(surface));
  await saveMessage(surface.owner.id, created.message.id, surface.server.id);
  await surface.db.delete(externalMessageAuthorFacts)
    .where(eq(externalMessageAuthorFacts.messageId, created.message.id));

  await assert.rejects(
    listMessagesByIds([created.message.id]),
    /missing immutable author fact/i,
  );
  await assert.rejects(
    searchMessagesForUser({
      serverId: surface.server.id,
      userId: surface.owner.id,
      channelId: surface.channel.id,
      query: "hello",
    }),
    /search row is missing immutable author fact/i,
  );
  await assert.rejects(
    listSaved(surface.owner.id, surface.server.id),
    /saved row is missing immutable author fact/i,
  );
});

test("outbound author consent and external mention authority fail closed on revoke, stale time, and Raft-handle collision", async () => {
  const surface = await seedExternalProjectionSurface();
  const authorAvatarId = randomUUID();
  await surface.db.insert(externalProjectionAvatarArtifacts).values({
    id: authorAvatarId,
    ownerType: "user",
    ownerId: surface.owner.id,
    sourceDigest: DIGEST_B,
    publicUrl: "https://cdn.slock.test/raft/owner.png",
    mimeType: "image/png",
    byteSize: 512,
    width: 64,
    height: 64,
    artifactRevision: 3,
    state: "active",
  });
  const [policy] = await surface.db.insert(externalAuthorPolicies).values({
    serverId: surface.server.id,
    provider: "slack",
    appRegistrationId: "app-registration-1",
    installId: "install-1",
    bindingId: "binding-1",
    bindingEpoch: 4,
    authorType: "user",
    authorId: surface.owner.id,
    displayName: "Raft Owner",
    avatarArtifactId: authorAvatarId,
    fallbackKind: "human",
    consentRevision: 2,
    state: "granted",
  }).returning();
  const authorPolicyInput = {
    serverId: surface.server.id,
    provider: policy.provider,
    appRegistrationId: policy.appRegistrationId,
    installId: policy.installId,
    bindingId: policy.bindingId,
    bindingEpoch: policy.bindingEpoch,
    authorType: "user" as const,
    authorId: surface.owner.id,
  };
  assert.equal((await resolveExternalAuthorPolicy(authorPolicyInput))?.avatar?.publicUrl, "https://cdn.slock.test/raft/owner.png");
  await surface.db.update(externalAuthorPolicies).set({ state: "revoked" }).where(eq(externalAuthorPolicies.id, policy.id));
  assert.equal(await resolveExternalAuthorPolicy(authorPolicyInput), null);

  const context = {
    provider: "slack",
    appRegistrationId: "app-registration-1",
    installId: "install-1",
    workspaceId: "workspace-1",
    connectionEpoch: 2,
    bindingId: "binding-1",
    bindingEpoch: 4,
    conversationId: "C-RAFT",
    memberRevision: 5,
    contextRevision: 6,
  };
  await surface.db.insert(externalAddressabilityProjections).values({
    projectionId: surface.actor.id,
    ...context,
    state: "active",
    observedAt: new Date("2026-07-31T00:00:00.000Z"),
    expiresAt: new Date("2026-07-31T02:00:00.000Z"),
  });

  const exact = await resolveExternalMentionFromDurableAuthority({
    rawHandle: "@alice",
    explicitProjectionId: surface.actor.id,
    raftPrincipalCollision: false,
    context,
    now: new Date("2026-07-31T01:00:00.000Z"),
  });
  assert.equal(exact.kind, "resolved");
  if (exact.kind === "resolved") assert.equal(exact.fact.externalActorId, "U-ALICE");

  const stale = await resolveExternalMentionFromDurableAuthority({
    rawHandle: "@alice",
    explicitProjectionId: surface.actor.id,
    raftPrincipalCollision: false,
    context,
    now: new Date("2026-07-31T03:00:00.000Z"),
  });
  assert.deepEqual(stale, { kind: "not_resolved", reason: "projection_stale" });

  const collision = await resolveExternalMentionFromDurableAuthority({
    rawHandle: "@alice",
    raftPrincipalCollision: true,
    context,
    now: new Date("2026-07-31T01:00:00.000Z"),
  });
  assert.deepEqual(collision, { kind: "not_resolved", reason: "raft_principal_collision" });

  const wrongContext = await resolveExternalMentionFromDurableAuthority({
    rawHandle: "@alice",
    explicitProjectionId: surface.actor.id,
    raftPrincipalCollision: false,
    context: { ...context, bindingEpoch: context.bindingEpoch + 1 },
    now: new Date("2026-07-31T01:00:00.000Z"),
  });
  assert.equal(wrongContext.kind, "not_resolved");

  const addressabilityRows = await surface.db.select().from(externalAddressabilityProjections).where(and(
    eq(externalAddressabilityProjections.projectionId, surface.actor.id),
    eq(externalAddressabilityProjections.bindingId, context.bindingId),
  ));
  assert.equal(addressabilityRows.length, 1, "read-only resolution must not mutate durable addressability authority");
});
