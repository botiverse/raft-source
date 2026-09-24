import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest.js";
import { channels, featureFlagRules, serverMembers, threadFollows, userChannelInboxStates, messageMentions } from "../db/schema.js";
import { getDoneInboxItems, getFollowedThreads, getInboxItems } from "../services/channelService.js";

const test = createApiTest({ onboardingOpenerFlagDefaultEnabled: false, humanActivityMuteFlagDefaultEnabled: true });
for (const surface of ["done", "followed", "mention"] as const) {
  test(`guest ${surface} reads recheck current visibility`, async ({ seed, db }) => {
    const owner = await seed.human(); const guest = await seed.human();
    const server = await seed.server({ owner, members: [guest] });
    await db.update(serverMembers).set({ role: "guest" }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, guest.id)));
    await db.insert(featureFlagRules).values({ flagKey: SERVER_GUEST_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [server.id] });
    const channel = await seed.channel({ server, members: [owner], visibility: "channel" });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    const parent = await seed.message({ channel, author: owner, content: "audit-inbox-secret" });
    const [thread] = await db.insert(channels).values({ serverId: server.id, name: "audit-thread", type: "thread", parentMessageId: parent.id }).returning();
    await db.insert(threadFollows).values({ threadChannelId: thread.id, parentMessageId: parent.id, reason: "manual", followerType: "user", followerId: guest.id });
    await seed.message({ channel: thread, author: owner, content: "audit-new-thread-secret" });
    if (surface === "done") await db.insert(userChannelInboxStates).values({ userId: guest.id, channelId: channel.id, doneAt: new Date() });
    // Durable notified residue models a mention delivered before visibility
    // revocation (no claim that a fresh hidden mention is initially notifiable).
    if (surface === "mention") await db.insert(messageMentions).values({ messageId: parent.id, serverId: server.id, channelId: channel.id, messageSeq: parent.seq, targetType: "user", targetId: guest.id, handleAtSendTime: guest.name, notifiedAt: new Date() });
    const read = async () => surface === "done" ? (await getDoneInboxItems(server.id, guest.id)).items
      : surface === "followed" ? await getFollowedThreads(server.id, guest.id)
      : (await getInboxItems(server.id, guest.id, { filter: "mentions", forcePostgres: true })).items;
    assert.ok((await read()).length > 0, "positive visible control");
    await db.update(channels).set({ guestVisible: false }).where(eq(channels.id, channel.id));
    assert.deepEqual(await read(), [], "residual follows/done/mentions must not grant access");
  });
}
