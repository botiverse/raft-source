import { tokenForHuman } from "../../test/integration/credentials";
import { createApiTest } from "../../test/integration/apiTest";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { featureFlagRules, featureFlags, jointChannelServers, jointChannels, messages, notificationOutbox, sessionFamilies, sessions } from "../../db/schema";
import { createServer, headers, seedUser } from "../../routes/channels.api.fixtures";
import type { FcmDeliveryInput } from "../fcmPushProvider";
import { upsertPushRegistration } from "../pushService";
import { __setNotificationBadgeLoaderForTests } from "./badge";
import {
  __resetNotificationDispatchRuntimeForTests,
  __setAfterNotificationClaimForTests,
  __setNotificationDispatchRuntimeForTests,
  drainNotificationRows,
} from "./dispatcher";
import { resolveJointHumanMembershipScopes } from "../jointHumanMembershipAccess";
import { enqueueNotificationRows, messageNotificationEventKey } from "./enqueue";
import { __resetApnsHttpClientForTests, __resetApnsPushProviderForTests, __setApnsHttpClientForTests } from "./transports/apns";
import { __resetFcmPushProviderForTests, __setFcmPushProviderForTests } from "./transports/fcm";

// Raft task #9: a joint thread's local projection has no parent_message_id by
// design (the parent lives on the canonical thread), so the notification for
// a reply in it lost its parent: the title was a bare "Thread", the payload
// had no parentChannelId / parentMessageId. The parent is this server's
// projection of the joint channel, and the parent message is the one
// canonical message. (The APNs thread-id is the thread's own channel since the
// banner copy redesign.)
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type ApnsBody = {
  aps?: { alert?: { title?: string }; "thread-id"?: string };
  serverId?: string;
  channelId?: string;
  threadId?: string;
  parentChannelId?: string;
  parentMessageId?: string;
  messageId?: string;
};

// `leftoverFlag`: a row of the retired joint_human_membership_v1 rollout flag,
// off with a deny rule for the host, is left behind. It changes nothing.
for (const leftoverFlag of [false, true]) {
for (const removalAt of ["never", "before_drain", "after_preparation"] as const) {
test(`a joint thread reply notification respects current access (${leftoverFlag ? "leftover retired flag off" : "no flag row"}, ${removalAt})`, async ({ app }) => {
  const previousEnv = {
    keyId: process.env.APNS_KEY_ID,
    teamId: process.env.APNS_TEAM_ID,
    privateKey: process.env.APNS_PRIVATE_KEY,
  };
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APNS_KEY_ID = "TESTKEY123";
  process.env.APNS_TEAM_ID = "TEAM123456";
  process.env.APNS_PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const captured: ApnsBody[] = [];
  const fcm: FcmDeliveryInput[] = [];
  // The env-configured APNs provider builds the real request; only HTTP/2 is faked.
  __resetApnsPushProviderForTests();
  __setApnsHttpClientForTests(async (request) => {
    captured.push(request.body as ApnsBody);
    return { statusCode: 200, body: "" };
  });
  __setFcmPushProviderForTests({ send: async (input) => { fcm.push(input); return { status: "sent" }; } });
  __setNotificationBadgeLoaderForTests(async (_userId, serverIds) => new Map(serverIds.slice(0, 1).map((serverId) => [serverId, 1])));
  // The messages posted below enqueue their own rows; nothing drains on its own.
  __setNotificationDispatchRuntimeForTests({ schedule: () => {}, sleep: async () => {}, jitterMs: () => 1 });
  try {
    const db = getDb();
    const hostOwner = await seedUser("joint-push-host@slock.test", "joint-push-host");
    const targetOwner = await seedUser("joint-push-target@slock.test", "joint-push-target");
    const hostServer = await createServer("Joint Push Host", "botiverse", hostOwner.id);
    const targetServer = await createServer("Joint Push Target", "joint-push-target", targetOwner.id);
    if (leftoverFlag) {
      await db.insert(featureFlags).values({ key: "joint_human_membership_v1", randomizationUnit: "server", salt: "audit", defaultEnabled: false }).onConflictDoNothing();
      await db.insert(featureFlagRules).values({ id: randomUUID(), flagKey: "joint_human_membership_v1",
        stage: "server", priority: 0, decision: "deny", values: [hostServer.id] });
    }
    const hostToken = await tokenForHuman(hostOwner.email);
    const targetToken = await tokenForHuman(targetOwner.email);

    const createRes = await fetch(`${app.baseUrl}/api/channels`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({
        name: "partner-room",
        visibility: "joint",
        targetServerSlug: targetServer.slug,
        invitedPeople: [`@${targetOwner.name}`],
      }),
    });
    assert.equal(createRes.status, 200);
    const hostProjection = await createRes.json() as { id: string; jointInvite: { id: string } };
    const acceptRes = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostProjection.jointInvite.id}/accept`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(acceptRes.status, 200);
    const targetProjection = await acceptRes.json() as { id: string; name: string };

    const scope = (await resolveJointHumanMembershipScopes({ localChannelIds: [targetProjection.id] }, db)).get(targetProjection.id);
    assert.ok(scope, "fixture: a joint projection");

    const parentRes = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ channelId: hostProjection.id, content: "parent on both sides" }),
    });
    assert.equal(parentRes.status, 200);
    const parent = await parentRes.json() as { id: string };
    const threadRes = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/threads`, {
      method: "POST",
      headers: headers(hostToken, hostServer.id),
      body: JSON.stringify({ parentMessageId: parent.id, content: "host thread reply" }),
    });
    assert.equal(threadRes.status, 200);
    const hostThread = await threadRes.json() as { threadChannelId: string };

    const [threadJoint] = await db
      .select({ jointChannelId: jointChannelServers.jointChannelId, canonicalThreadId: jointChannels.canonicalChannelId })
      .from(jointChannelServers)
      .innerJoin(jointChannels, eq(jointChannels.id, jointChannelServers.jointChannelId))
      .where(eq(jointChannelServers.localChannelId, hostThread.threadChannelId));
    assert.ok(threadJoint, "fixture: the host thread is a joint thread projection");
    const [targetThread] = await db
      .select({ id: jointChannelServers.localChannelId })
      .from(jointChannelServers)
      .where(and(
        eq(jointChannelServers.jointChannelId, threadJoint.jointChannelId),
        eq(jointChannelServers.serverId, targetServer.id),
      ));
    assert.ok(targetThread, "fixture: the target server has its own thread projection");
    const [reply] = await db
      .select({ id: messages.id, seq: messages.seq })
      .from(messages)
      .where(eq(messages.channelId, threadJoint.canonicalThreadId));
    assert.ok(reply, "fixture: the reply is stored on the canonical thread");

    const [family] = await db.insert(sessionFamilies).values({ userId: targetOwner.id }).returning();
    await db.insert(sessions).values({
      userId: targetOwner.id,
      familyId: family.id,
      tokenHash: `token-${family.id}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await upsertPushRegistration({
      installationId: "joint-thread-install",
      provider: "apns",
      userId: targetOwner.id,
      serverId: targetServer.id,
      sessionFamilyId: family.id,
      deviceToken: "jointthreadtoken",
      topic: "build.raft.app",
      env: "sandbox",
    });
    await upsertPushRegistration({
      installationId: "joint-thread-android",
      provider: "fcm",
      userId: targetOwner.id,
      serverId: targetServer.id,
      sessionFamilyId: family.id,
      deviceToken: "fcm:joint-thread-token",
      topic: "build.raft.app",
      env: "production",
    });
    captured.length = 0;

    // One row: the reply on the recipient server's thread projection.
    const eventKey = messageNotificationEventKey(reply.id);
    await db.delete(notificationOutbox).where(and(eq(notificationOutbox.receiverId, targetOwner.id), eq(notificationOutbox.eventKey, eventKey)));
    const ids = await enqueueNotificationRows([{
      receiverId: targetOwner.id,
      serverId: targetServer.id,
      kind: "thread",
      sourceChannelId: targetThread.id,
      messageId: reply.id,
      messageSeq: reply.seq,
      activityAt: new Date(),
      personalMention: false,
      eventKey,
      category: "thread",
    }]);
    assert.equal(ids.length, 1);
    const removeRecipient = async () => {
      const visible = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, { headers: headers(targetToken, targetServer.id) });
      assert.equal(visible.status, 200);
      // Only the host manages members: the removal goes through the host's copy.
      const removed = await fetch(`${app.baseUrl}/api/channels/${hostProjection.id}/members/user/${targetOwner.id}`, {
        method: "DELETE", headers: headers(hostToken, hostServer.id),
      });
      assert.equal(removed.status, 200, await removed.clone().text());
      const denied = await fetch(`${app.baseUrl}/api/channels/${targetProjection.id}`, { headers: headers(targetToken, targetServer.id) });
      assert.ok([403, 404].includes(denied.status), "the ordinary channel read must already be revoked");
    };
    if (removalAt === "before_drain") await removeRecipient();
    if (removalAt === "after_preparation") __setAfterNotificationClaimForTests(removeRecipient);
    assert.deepEqual(await drainNotificationRows(ids), { claimed: 1, processed: 1 });
    if (removalAt !== "never") {
      const [suppressed] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, ids[0]!));
      assert.ok((suppressed?.status === "suppressed" && suppressed.decision === "suppressed:no_access")
        || (suppressed?.status === "revoked" && suppressed.decision === "suppressed:event_missing"),
      `a queued joint reply must not outlive recipient access: ${JSON.stringify(suppressed)}`);
      assert.equal(captured.filter(body => body.messageId === reply.id).length, 0);
      assert.equal(fcm.filter(body => body.message.data.messageId === reply.id).length, 0);
      return;
    }

    const [row] = await db.select().from(notificationOutbox).where(eq(notificationOutbox.id, ids[0]!));
    assert.equal(row?.status, "delivered", JSON.stringify(row));

    const body = captured.find((candidate) => candidate.messageId === reply.id);
    assert.ok(body, "the reply was pushed");

    // The parent is the recipient server's own projection of the joint channel
    // and the one canonical parent message.
    assert.equal(body.serverId, targetServer.id);
    assert.equal(body.channelId, targetThread.id);
    assert.equal(body.threadId, targetThread.id);
    assert.equal(body.parentChannelId, targetProjection.id);
    assert.equal(body.parentMessageId, parent.id);
    // The title never carries the server (that is the subtitle, for receivers of 2+ servers).
    assert.equal(body.aps?.alert?.title, `Thread in #${targetProjection.name}`);
    assert.equal(body.aps?.["thread-id"], `${targetServer.id}:${targetThread.id}`, "one APNs stack per thread (retraction matches groupKey)");

    const android = fcm.find((candidate) => candidate.message.data.messageId === reply.id);
    assert.ok(android, "the reply was sent to FCM");
    assert.equal(android.message.data.channelId, targetThread.id);
    assert.equal(android.message.data.threadId, targetThread.id);
    assert.equal(android.message.data.parentChannelId, targetProjection.id);
    assert.equal(android.message.data.parentMessageId, parent.id);

    // Tapping the push opens the thread on the recipient's server: the ids in
    // the payload resolve there, as the recipient, to the same local thread.
    const reopen = await fetch(`${app.baseUrl}/api/channels/${body.parentChannelId}/threads`, {
      method: "POST",
      headers: headers(targetToken, targetServer.id),
      body: JSON.stringify({ parentMessageId: body.parentMessageId }),
    });
    assert.equal(reopen.status, 200);
    assert.equal((await reopen.json() as { threadChannelId: string }).threadChannelId, targetThread.id);

    const parentContext = await fetch(
      `${app.baseUrl}/api/messages/context/${body.parentMessageId}?channelId=${body.parentChannelId}`,
      { headers: headers(targetToken, targetServer.id) },
    );
    assert.equal(parentContext.status, 200, "the app's parent-context read resolves the pushed pair on the recipient's server");

    const parentTimeline = await fetch(`${app.baseUrl}/api/messages/channel/${body.parentChannelId}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(parentTimeline.status, 200);
    const timeline = await parentTimeline.json() as { messages: Array<{ id: string; threadId: string | null }> };
    assert.equal(
      timeline.messages.find((message) => message.id === body.parentMessageId)?.threadId,
      targetThread.id,
      "the parent message is in the recipient's parent channel and points at the recipient's thread",
    );

    const threadTimeline = await fetch(`${app.baseUrl}/api/messages/channel/${body.threadId}`, {
      headers: headers(targetToken, targetServer.id),
    });
    assert.equal(threadTimeline.status, 200);
    const threadMessages = await threadTimeline.json() as { messages: Array<{ id: string }> };
    assert.ok(threadMessages.messages.some((message) => message.id === reply.id), "the pushed reply reads on the recipient's thread");
  } finally {
    __setAfterNotificationClaimForTests(null);
    __resetApnsHttpClientForTests();
    __resetApnsPushProviderForTests();
    __resetFcmPushProviderForTests();
    __setNotificationBadgeLoaderForTests(null);
    __resetNotificationDispatchRuntimeForTests();
    restoreEnv("APNS_KEY_ID", previousEnv.keyId);
    restoreEnv("APNS_TEAM_ID", previousEnv.teamId);
    restoreEnv("APNS_PRIVATE_KEY", previousEnv.privateKey);
  }
});
}
}
