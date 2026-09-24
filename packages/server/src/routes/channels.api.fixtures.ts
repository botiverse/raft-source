import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import {
  PRO_AGENT_SEAT_BLOCK_SIZE,
  THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY
} from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { legacyDoneFrontierFallbacksTotal } from "../metrics.js";
import {
  users, servers as serversTable,
  serverMembers, messages, threadFollows, subscriptions,
  featureFlags,
  featureFlagRules
} from "../db/schema.js";
import { createServer as createServerService } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, getOrCreateThread, addHuman, addAgent } from "../services/channelService.js";
import {
  createMessage
} from "../services/messageService.js";
import {
  recordInboxNotificationFacts
} from "../services/inboxNotificationService.js";
import { READ_RECEIPTS_FEATURE_FLAG_KEY } from "../services/featureFlagService.js";
import {
  resolveChannelSuppressionTarget,
  resolveThreadSuppressionTarget,
} from "../services/inboxSuppressionWriters.js";


export type Fixtures = {
  serverId: string;
  parentChannelId: string;
  threadId: string;
  parentMessageId: string;
  ownerToken: string;
  followerToken: string;
  memberBToken: string;
  outsiderToken: string;
  ownerId: string;
  memberBId: string;
  followerId: string;
  outsiderId: string;
  agentAId: string;
  agentBId: string;
};


export interface EmittedEvent {
  room: string;
  event: string;
  payload: unknown;
}


export async function createServer(name: string, slug: string, ownerId: string) {
  const server = await createServerService(name, slug, ownerId);
  if (slug === "botiverse") {
    await getDb().update(serversTable).set({ plan: "pro" }).where(eq(serversTable.id, server.id));
    const proSeatQuantity = 10;
    await getDb().insert(subscriptions).values({
      serverId: server.id,
      plan: "pro",
      provider: "stripe",
      stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeProPackItemId: `si_pro_${randomUUID()}`,
      status: "active",
      provisionedHumanSeats: proSeatQuantity,
      provisionedAgentSeats: proSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
      proPackQuantity: proSeatQuantity,
      trialFreePackQuantity: 0,
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: ownerId,
      updatedByUserId: ownerId,
    });
    return { ...server, plan: "pro" };
  }
  // Pin non-billing test servers to an unlimited, full-featured plan so their
  // behavior does NOT depend on the ambient free-trial wall-clock.
  //
  // A fresh server defaults to the `free` plan, whose effective limits are
  // unlimited ONLY while the free trial is active (getTrialFreeLimits /
  // isTrialActive vs TRIAL_END_DATE) and tighten once the trial ends — message
  // history gains a 30-day cutoff and pro-gated features (joint channels) stop
  // being allowed. Tests asserting history_cutoff_present=false /
  // fallback_reason="feature_disabled" / that the RisingWave stats backend is
  // reached (a cutoff short-circuits stats to Postgres before RW is tried) /
  // that joint-channel create succeeds silently flipped red the moment
  // TRIAL_END_DATE elapsed in real time. `founder` (unlimited, no subscription
  // needed) makes those deterministic regardless of when the suite runs. Tests
  // that specifically exercise free/trial billing gating must set their own
  // plan after this call.
  await getDb().update(serversTable).set({ plan: "founder" }).where(eq(serversTable.id, server.id));
  return { ...server, plan: "founder" };
}


export function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
  const events: EmittedEvent[] = [];
  const makeRoomChain = (rooms: string[]) => ({
    in(room: string) {
      return makeRoomChain([...rooms, room]);
    },
    socketsJoin(room: string) {
      events.push({ room: rooms.join(" "), event: "socketsJoin", payload: { room } });
    },
  });
  app.set("io", {
    // Model one connected socket per server member. Production publication
    // still evaluates read authority; transport eviction is covered by real
    // Socket tests in securityLifecycle.api.test.ts.
    local: {
      in(room: string) {
        return { async fetchSockets() {
          const members = await getDb().select({ userId: serverMembers.userId })
            .from(serverMembers).where(eq(serverMembers.serverId, room.slice("server:".length)));
          return members.map(({ userId }) => ({
            data: { userId },
            async join() {},
            emit(event: string, payload: unknown) {
              events.push({ room: `user:${userId}`, event, payload });
            },
          }));
        } };
      },
    },
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          events.push({ room, event, payload });
        },
      };
    },
    in(room: string) {
      return makeRoomChain([room]);
    },
  });
  return events;
}


export async function enableReadReceiptsForServer(serverId: string): Promise<void> {
  const db = getDb();
  await db.insert(featureFlags).values({
    key: READ_RECEIPTS_FEATURE_FLAG_KEY,
    description: "test read receipts",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "server",
    defaultEnabled: false,
    salt: "read-receipts-test",
  }).onConflictDoUpdate({
    target: featureFlags.key,
    set: {
      enabled: true,
      killSwitch: false,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "read-receipts-test",
    },
  });
  await db.insert(featureFlagRules).values({
    flagKey: READ_RECEIPTS_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}


export async function enableThreadAgentFollowerManagementForServer(serverId: string): Promise<void> {
  const db = getDb();
  await db.insert(featureFlags).values({
    key: THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
    description: "test thread Agent follower management",
    enabled: true,
    killSwitch: false,
    randomizationUnit: "server",
    defaultEnabled: false,
    salt: "thread-agent-follower-management-test",
  }).onConflictDoUpdate({
    target: featureFlags.key,
    set: {
      enabled: true,
      killSwitch: false,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "thread-agent-follower-management-test",
    },
  });
  await db.insert(featureFlagRules).values({
    flagKey: THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}


export async function recordTestInboxFact(opts: {
  serverId: string;
  receiverId: string;
  kind: "channel" | "dm" | "thread";
  sourceChannelId: string;
  message: typeof messages.$inferSelect;
  personalMention?: boolean;
}) {
  await recordInboxNotificationFacts([{
    receiverType: "user",
    receiverId: opts.receiverId,
    serverId: opts.serverId,
    kind: opts.kind,
    sourceChannelId: opts.sourceChannelId,
    messageId: opts.message.id,
    messageSeq: opts.message.seq,
    activityAt: opts.message.createdAt,
    personalMention: opts.personalMention === true,
    unreadEligible: true,
  }]);
}


/**
 * Seed a minimal fixture that separates "parent channel membership" from
 * "thread_follows". Parent members ≠ followers so we can prove the two
 * lists are distinct.
 *
 *   parent channel members: owner + memberB + agentA
 *   thread_follows:         owner + follower (user) + agentB (agent)
 */
export async function seedThreadFixture(baseUrl: string, serverSlug = "contract-test"): Promise<Fixtures> {
  const db = getDb();

  const [owner] = await db.insert(users).values({
    email: "owner@slock.test",
    name: "owner",
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [memberB] = await db.insert(users).values({
    email: "member-b@slock.test",
    name: "member-b",
    displayName: "Member B",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [follower] = await db.insert(users).values({
    email: "follower@slock.test",
    name: "follower",
    displayName: "Follower",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const [outsider] = await db.insert(users).values({
    email: "outsider@slock.test",
    name: "outsider",
    displayName: "Outsider",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  const server = await createServer("Contract Test Server", serverSlug, owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: memberB.id, role: "member" },
    { serverId: server.id, userId: follower.id, role: "member" },
    { serverId: server.id, userId: outsider.id, role: "member" },
  ]);

  const agentA = await createAgent(server.id, "agent-a", { runtime: "codex" });
  const agentB = await createAgent(server.id, "agent-b", { runtime: "codex" });

  const parentChannel = await createChannel(server.id, "parent-room");
  await addHuman(parentChannel.id, owner.id);
  await addHuman(parentChannel.id, memberB.id);
  await addAgent(parentChannel.id, agentA.id);

  const parentMessage = await createMessage(parentChannel.id, "user", owner.id, "parent message");

  // getOrCreateThread does NOT write any thread_follows row — opening a thread
  // must never auto-follow (that is the bug this contract fixes). The fixture
  // simulates the post-first-reply state by manually inserting follow rows for:
  //   owner     → 'authored' (parent-message author, written by the reply path)
  //   follower  → 'manual'   (a user NOT in the parent channel, to prove that
  //                           follow lists are distinct from parent membership)
  //   agentB    → 'manual'   (an agent NOT in the parent channel, same reason)
  const thread = await getOrCreateThread(parentMessage.id, owner.id, "user");

  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: owner.id,
    parentMessageId: parentMessage.id,
    reason: "authored",
  }).onConflictDoNothing();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "user",
    followerId: follower.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
  }).onConflictDoNothing();
  await db.insert(threadFollows).values({
    threadChannelId: thread.id,
    followerType: "agent",
    followerId: agentB.id,
    parentMessageId: parentMessage.id,
    reason: "manual",
  }).onConflictDoNothing();



  return {
    serverId: server.id,
    parentChannelId: parentChannel.id,
    threadId: thread.id,
    parentMessageId: parentMessage.id,
    ownerToken: await tokenForHuman("owner@slock.test"),
    followerToken: await tokenForHuman("follower@slock.test"),
    memberBToken: await tokenForHuman("member-b@slock.test"),
    outsiderToken: await tokenForHuman("outsider@slock.test"),
    ownerId: owner.id,
    memberBId: memberB.id,
    followerId: follower.id,
    outsiderId: outsider.id,
    agentAId: agentA.id,
    agentBId: agentB.id,
  };
}


export function headers(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}


export async function channelDoneBody(channelId: string) {
  const target = await resolveChannelSuppressionTarget(channelId);
  assert.ok(target?.latestSeqExact, `channel ${channelId} must expose a positive Done frontier`);
  return {
    channelId,
    throughActivitySeq: target.latestSeqExact,
    frontierSpace: "storage",
  };
}


export async function threadDoneBody(threadChannelId: string) {
  const target = await resolveThreadSuppressionTarget(threadChannelId);
  assert.ok(target?.latestSeqExact, `thread ${threadChannelId} must expose a positive Done frontier`);
  return {
    threadChannelId,
    throughActivitySeq: target.latestSeqExact,
    frontierSpace: "storage",
  };
}


export async function legacyDoneFallbackCount(targetKind: "channel" | "thread") {
  const metric = await legacyDoneFrontierFallbacksTotal.get();
  return metric.values.find((value) => value.labels.target_kind === targetKind)?.value ?? 0;
}


export async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}





// These tests pin firstMentionMessageId on the DEFAULT pg_serving policy path
// (#3398 serving used for filter=all when human-activity-mute is enabled, which
// openTestApp("pglite://") enables by default and RisingWave is absent under
// pglite). Rows must be seeded through the real input path: createMessage +
// recordTestInboxFact (so the channel/thread is a visible base_rows row) +
// message_mentions inserts. The pg_serving receiver_rows -> mention_scope ->
// live_mentions path resolves firstMentionMessageId = MIN-seq UNREAD personal mention.

export type InboxMentionItem =
  | { kind: "channel" | "dm"; channelId: string; firstUnreadMessageId: string | null; firstMentionMessageId: string | null; unreadCount: number; hasMention: boolean }
  | { kind: "thread"; threadChannelId: string; firstUnreadMessageId: string | null; firstMentionMessageId: string | null; unreadCount: number; hasMention: boolean };


export async function fetchInboxAll(baseUrl: string, token: string, serverId: string): Promise<InboxMentionItem[]> {
  const res = await fetch(`${baseUrl}/api/channels/inbox?filter=all`, {
    headers: headers(token, serverId),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { items: InboxMentionItem[] };
  return body.items;
}


// ---------------------------------------------------------------------------
// task #48 -- the channel existence oracle.
//
// @Tenny's ruling (#proj-activity:b3ffd225, `f0a31e7f`) is NOT "unify to 404".
// It is that the response must not depend on whether the channel exists *for a
// requester with no prior relationship*. So there are TWO controls, and each is
// only meaningful with the other:
//
//   PAIRED negative control -- stranger vs a REAL private channel, and stranger
//   vs a genuinely NONEXISTENT id, must be byte-identical. Testing only one of
//   the two is not testing: a site that 404s everything passes the first alone,
//   and a site that 403s everything passes the second alone.
//
//   RETAINED-403 control -- an ex-member who still carries residue must KEEP the
//   403, or the usability half of #48 (Activity that can never be cleared)
//   regresses while the leak half looks fixed.
//
// ACCEPTED BOUNDARY -- judged, not overlooked (@Tenny). Two populations get the
// non-disclosing 404 even though they know the channel exists: people dropped by
// a public -> private conversion, and former members with neither a read cursor
// nor any residue. They leave NO server-side record, so no cheap witness can see
// them. This costs them nothing functional -- having no residue means having
// nothing to clear -- so the loss is one of candour, not capability. The fix
// would be a "was once visible" history table, and a record of who could once
// see what is itself exactly the shape this class of bug loves. We are not
// building a real probe surface to close a cosmetic gap.
// ---------------------------------------------------------------------------

/** Every site that takes a caller-supplied channel id and gates on access. */
export function oracleProbes(baseUrl: string, h: Record<string, string>, id: string) {
  return [
    { name: "GET /channels/:id/files", run: () => fetch(`${baseUrl}/api/channels/${id}/files`, { headers: h }) },
    { name: "GET /channels/:id/threads", run: () => fetch(`${baseUrl}/api/channels/${id}/threads`, { headers: h }) },
    {
      name: "GET /channels/:id/threads/:messageId",
      run: () => fetch(`${baseUrl}/api/channels/${id}/threads/${randomUUID()}`, { headers: h }),
    },
    {
      name: "POST /channels/:id/threads",
      run: () => fetch(`${baseUrl}/api/channels/${id}/threads`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ parentMessageId: randomUUID() }),
      }),
    },
    { name: "GET /messages/channel/:channelId", run: () => fetch(`${baseUrl}/api/messages/channel/${id}`, { headers: h }) },
    { name: "GET /messages/sync", run: () => fetch(`${baseUrl}/api/messages/sync?channel_id=${id}`, { headers: h }) },
  ];
}
