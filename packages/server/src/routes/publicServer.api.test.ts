import { vi } from "vitest";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { getDb } from "../db/index";
import {
  agents,
  attachments,
  channelHumans,
  channels,
  externalActorProjections,
  externalMentionFacts,
  featureFlags,
  messageMentions,
  messageReactions,
  messages,
  serverMembers,
  serverInvites,
  servers,
  users,
} from "../db/schema";
import { createChannel, getOrCreateThread, getThreadSummaries, updateChannel } from "../services/channelService";
import { loadPublicThreadPreviews, PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS } from "./publicServer";
import { __setStorageForTests, resetStorageForTests, type StorageBackend } from "../services/storageService";
import type { DbQueryTracer } from "../tracing/dbQueryTrace";
import { createServer, seedUser, headers } from "./channels.api.fixtures";
import { tokenForHuman } from "../test/integration/credentials";
import { addMember } from "../services/serverService";
import { seedBoundGuest } from "../test/guestFixture";
import { createMessage } from "../services/messageService";
import { PUBLIC_SERVER_FEATURE_FLAG_KEY, SERVER_GUEST_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

async function enablePublicServerFeature() {
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
}

async function enablePublicAndGuestFeatures() {
  await enablePublicServerFeature();
  await getDb().update(featureFlags)
    .set({ enabled: true, killSwitch: false, defaultEnabled: true })
    .where(eq(featureFlags.key, SERVER_GUEST_FEATURE_FLAG_KEY));
}

/**
 * Task #70, hard requirement 2 (@cindyz): turning `public` off must refuse the
 * same reader's next request, not just prevent a new anonymous session/token.
 *
 * The dangerous way to pass this is a test that only ever issues fresh requests
 * after the flip using a new app — that would stay green even if the running
 * process cached the decision. So this drives the SAME endpoint on the SAME
 * running app before and after, with nothing in between but the column change.
 */
test("public server: a logged-out reader loses access the moment the toggle goes off", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-server-owner@slock.test", "public-server-owner");
    const server = await createServer("Public Server", "public-server-70", owner.id);

    const open = await createChannel(server.id, "open-channel", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    // No Authorization header anywhere in this test. That is the point.
    const listUrl = `${app.baseUrl}/api/public/servers/public-server-70`;
    const msgsUrl = `${app.baseUrl}/api/public/servers/public-server-70/channels/${open.id}/messages`;

    const before = await fetch(listUrl);
    assert.equal(before.status, 200, await before.clone().text());
    assert.equal(before.headers.get("cache-control"), "no-store", "a browser or CDN must not carry a public decision past the next request");
    const body = await before.json() as { channels: { id: string }[] };
    assert.deepEqual(body.channels.map((c) => c.id), [open.id], "only the guest-visible ordinary channel is offered");

    const readBefore = await fetch(msgsUrl);
    assert.equal(readBefore.status, 200, "a stranger can read the guest-visible channel while public is on");
    assert.equal(readBefore.headers.get("cache-control"), "no-store");

    // The flip. Nothing else changes: same app, same process, same URLs.
    await db.update(servers).set({ publiclyVisible: false }).where(eq(servers.id, server.id));

    const afterList = await fetch(listUrl);
    assert.equal(afterList.status, 404, "the server card must disappear immediately");
    const afterRead = await fetch(msgsUrl);
    assert.equal(afterRead.status, 404, "the same reader's next page request must fail without waiting for cache expiry");
  } finally {
    await app.close();
  }
});

test("public server: rollout flag defaults closed at owner and anonymous boundaries", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const owner = await seedUser("public-gate-owner@slock.test", "public-gate-owner");
    const server = await createServer("Gated", "public-gated-70", owner.id);
    const channel = await createChannel(server.id, "would-be-public", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    const ownerToken = await tokenForHuman(owner.email);
    const ownerUrl = `${app.baseUrl}/api/servers/${server.id}/public-visibility`;

    const ownerRead = await fetch(ownerUrl, { headers: headers(ownerToken, server.id) });
    assert.equal(ownerRead.status, 404, "the owner read must fail closed while rollout is off");
    const ownerWrite = await fetch(ownerUrl, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: false }),
    });
    assert.equal(ownerWrite.status, 404, "the owner write must fail closed while rollout is off");

    const publicList = await fetch(`${app.baseUrl}/api/public/servers/public-gated-70`);
    const publicRead = await fetch(`${app.baseUrl}/api/public/servers/public-gated-70/channels/${channel.id}/messages`);
    const missing = await fetch(`${app.baseUrl}/api/public/servers/does-not-exist-70`);
    assert.equal(publicList.status, 404);
    assert.equal(publicRead.status, 404);
    assert.equal(await publicList.text(), await missing.text(), "flag-off and nonexistent slugs must have byte-identical bodies");

    const [unchanged] = await db.select({ v: servers.publiclyVisible }).from(servers).where(eq(servers.id, server.id));
    assert.equal(unchanged.v, true, "a refused owner PATCH must leave the stored setting untouched");
  } finally {
    await app.close();
  }
});

test("public translation has its own thirty-per-minute IP budget, a quarter of the member endpoint's", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const url = `${app.baseUrl}/api/public/servers/rate-limit-probe/message-translations:batch`;
    for (let index = 0; index < 30; index += 1) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      assert.equal(response.status, 400, `request ${index + 1} should reach validation before the IP budget is exhausted`);
    }
    const limited = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "Too many public translation requests, please slow down" });
  } finally {
    await app.close();
  }
});

/**
 * The surface must be exactly "ordinary channels the owner marked guest-visible".
 * `guestVisible` alone is not the predicate: it exists on other channel kinds too,
 * so the route requires type = "channel" explicitly. Each negative below is a
 * separate way the surface could widen without anyone intending it.
 */
test("public server: the anonymous surface is only guest-visible ordinary channels", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-surface-owner@slock.test", "public-surface-owner");
    const server = await createServer("Surface", "public-surface-70", owner.id);
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    const creator = { type: "user" as const, id: owner.id };
    const visible = await createChannel(server.id, "visible", undefined, "channel", creator);
    const notMarked = await createChannel(server.id, "not-marked", undefined, "channel", creator);
    const privateMarked = await createChannel(server.id, "private-marked", undefined, "private", creator);
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, visible.id));
    // A private channel that is ALSO marked guest-visible: the trap this predicate exists for.
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, privateMarked.id));

    const listed = await (await fetch(`${app.baseUrl}/api/public/servers/public-surface-70`)).json() as { channels: { id: string }[] };
    assert.deepEqual(listed.channels.map((c) => c.id), [visible.id], "a guest-visible PRIVATE channel must not be listed");

    for (const [label, id] of [["unmarked ordinary", notMarked.id], ["guest-visible private", privateMarked.id]] as const) {
      const res = await fetch(`${app.baseUrl}/api/public/servers/public-surface-70/channels/${id}/messages`);
      assert.equal(res.status, 404, `${label} channel must not be readable anonymously`);
    }

    // A non-public server is indistinguishable from one that does not exist,
    // so this endpoint cannot be used to enumerate slugs.
    const other = await createServer("Private Server", "private-server-70", owner.id);
    assert.ok(other.id);
    const probe = await fetch(`${app.baseUrl}/api/public/servers/private-server-70`);
    assert.equal(probe.status, 404, "a non-public server must 404, not 403");

    const [stillPrivate] = await db.select({ v: servers.publiclyVisible }).from(servers)
      .where(and(eq(servers.slug, "private-server-70")));
    assert.equal(stillPrivate.v, false, "probing must not have changed anything");
  } finally {
    await app.close();
  }
});

test("public server: making an ordinary channel private clears its public-reading flag", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const owner = await seedUser("public-private-policy-owner@slock.test", "public-private-policy-owner");
    const server = await createServer("Policy", "public-private-policy-70", owner.id);
    const channel = await createChannel(server.id, "before-private", undefined, "channel", { type: "user", id: owner.id });

    await updateChannel(channel.id, { guestVisible: true });
    const updated = await updateChannel(channel.id, { type: "private" });

    assert.equal(updated.type, "private");
    assert.equal(updated.guestVisible, false, "a private channel must not retain the anonymous audience marker");
  } finally {
    await app.close();
  }
});

test("public server: anonymous message history is a narrow public projection", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-projection-owner@slock.test", "public-projection-owner");
    const publicAvatarUrl = `/api/avatars/users/${"a".repeat(32)}.webp`;
    await db.update(users).set({
      avatarUrl: publicAvatarUrl,
      description: "Public profile description",
    }).where(eq(users.id, owner.id));
    const server = await createServer("Projection", "public-projection-70", owner.id);
    const channel = await createChannel(server.id, "public-projection", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({
      publiclyVisible: true,
      avatarUrl: "https://third-party.example.test/server-avatar.png?signature=secret",
    }).where(eq(servers.id, server.id));
    const externalServerAvatar = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70`)).json() as { server: { avatarUrl: string | null } };
    assert.equal(externalServerAvatar.server.avatarUrl, null, "third-party server avatars must not cross the anonymous boundary");
    const storedServerAvatar = `/api/avatars/server-${server.id}/${"c".repeat(32)}.webp`;
    await db.update(servers).set({ avatarUrl: storedServerAvatar }).where(eq(servers.id, server.id));
    const storedServerProjection = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70`)).json() as { server: { avatarUrl: string | null } };
    assert.equal(storedServerProjection.server.avatarUrl, storedServerAvatar);
    const message = await createMessage(channel.id, "user", owner.id, "Public words only");
    await db.update(messages).set({
      actionMetadata: { kind: "action-card", secretControlPlaneFact: "must-not-leak" },
      taskStatus: "in_progress",
      taskAssigneeId: owner.id,
      taskAssigneeType: "user",
    }).where(eq(messages.id, message.id));

    const response = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`);
    assert.equal(response.status, 200);
    const body = await response.json() as { messages: Array<Record<string, unknown>> };
    assert.equal(body.messages.length, 1);
    assert.deepEqual(Object.keys(body.messages[0]!).sort(), [
      "attachments", "content", "createdAt", "id", "lastReplyAt", "latestReplies", "mentions", "messageType", "reactions", "replyCount", "sender", "senderType", "threadId",
    ]);
    assert.deepEqual(
      [body.messages[0]!.attachments, body.messages[0]!.mentions, body.messages[0]!.reactions],
      [[], [], []],
      "a message without attachments, mentions or reactions carries empty lists",
    );
    assert.deepEqual(body.messages[0]!.latestReplies, [], "a message with no thread carries an empty preview");
    assert.equal(body.messages[0]!.lastReplyAt, null);
    assert.equal(body.messages[0]!.content, "Public words only");
    assert.deepEqual(body.messages[0]!.sender, {
      displayName: owner.displayName || owner.name,
      handle: owner.name,
      avatarUrl: publicAvatarUrl,
      description: "Public profile description",
    });
    assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
    assert.equal(JSON.stringify(body).includes(owner.id), false, "anonymous DTO must not expose actor ids");

    const storedAgentAvatar = `/api/avatars/${server.id}/${"b".repeat(32)}.webp`;
    const [storedAgent] = await db.insert(agents).values({
      serverId: server.id,
      name: "stored-avatar-agent",
      displayName: "Stored Avatar Agent",
      avatarUrl: storedAgentAvatar,
      description: "Public agent description",
    }).returning();
    const [externalAgent] = await db.insert(agents).values({
      serverId: server.id,
      name: "external-avatar-agent",
      displayName: "External Avatar Agent",
      avatarUrl: "https://third-party.example.test/private-avatar.png?signature=secret",
      description: "External avatar is filtered",
    }).returning();
    const storedAgentMessage = await createMessage(channel.id, "agent", storedAgent.id, "Stored agent avatar");
    const externalAgentMessage = await createMessage(channel.id, "agent", externalAgent.id, "External agent avatar");
    const otherServer = await createServer("Other Projection", "other-public-projection-70", owner.id);
    const otherServerAvatar = `/api/avatars/${otherServer.id}/${"d".repeat(32)}.webp`;
    const [otherServerAgent] = await db.insert(agents).values({
      serverId: otherServer.id,
      name: "other-server-agent",
      displayName: "Other Server Secret Agent",
      avatarUrl: otherServerAvatar,
      description: "Must not cross the server boundary",
    }).returning();
    const otherServerAgentMessage = await createMessage(channel.id, "agent", otherServerAgent.id, "Cross-server agent id");
    const agentProjection = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`)).json() as {
      messages: Array<{ id: string; sender: { displayName: string; handle: string | null; avatarUrl: string | null; description: string | null } }>;
    };
    assert.deepEqual(agentProjection.messages.find((row) => row.id === storedAgentMessage.id)?.sender, {
      displayName: "Stored Avatar Agent",
      handle: "stored-avatar-agent",
      avatarUrl: storedAgentAvatar,
      description: "Public agent description",
    });
    assert.deepEqual(agentProjection.messages.find((row) => row.id === externalAgentMessage.id)?.sender, {
      displayName: "External Avatar Agent",
      handle: "external-avatar-agent",
      avatarUrl: null,
      description: "External avatar is filtered",
    }, "third-party or signed avatar URLs must not cross the anonymous boundary");
    assert.deepEqual(agentProjection.messages.find((row) => row.id === otherServerAgentMessage.id)?.sender, {
      displayName: "Unknown agent",
      handle: null,
      avatarUrl: null,
      description: null,
    }, "an agent id from another server must not project that server's profile data");

    const thread = await getOrCreateThread(message.id, owner.id, "user");
    const reply = await createMessage(thread.id, "user", owner.id, "> quoted\n\n**reply**");
    const newerReply = await createMessage(thread.id, "user", owner.id, "newer reply");
    const withThread = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`);
    const withThreadBody = await withThread.json() as { messages: Array<{ id: string; threadId: string | null; replyCount: number }> };
    const parentProjection = withThreadBody.messages.find((row) => row.id === message.id);
    assert.deepEqual(parentProjection && {
      id: parentProjection.id,
      threadId: parentProjection.threadId,
      replyCount: parentProjection.replyCount,
    }, {
      id: message.id,
      threadId: thread.id,
      replyCount: 2,
    });
    // wg-rbac task #123: the parent row carries the newest replies so the public
    // page can render the inline preview members see. Same boundary as the
    // rows themselves: display name and filtered avatar, never an actor id.
    const previewed = withThreadBody.messages.find((row) => row.id === message.id) as unknown as {
      lastReplyAt: string | null;
      latestReplies: Array<Record<string, unknown>>;
    };
    assert.equal(previewed.latestReplies.length, 2);
    for (const item of previewed.latestReplies) {
      assert.deepEqual(Object.keys(item).sort(), [
        "createdAt", "messageId", "preview", "senderAvatarUrl", "senderName", "senderType", "seq",
      ], "the reply preview is an explicit projection: widening it must be a deliberate edit here");
    }
    assert.deepEqual(previewed.latestReplies.map((item) => [item.messageId, item.preview, item.senderType, item.senderName, item.senderAvatarUrl]), [
      [reply.id, "> quoted\n\n**reply**", "user", owner.displayName || owner.name, publicAvatarUrl],
      [newerReply.id, "newer reply", "user", owner.displayName || owner.name, publicAvatarUrl],
    ]);
    assert.ok(previewed.lastReplyAt, "the last reply time is projected with the preview");
    assert.equal(JSON.stringify(withThreadBody).includes(owner.id), false, "reply previews must not expose actor ids");
    assert.equal(JSON.stringify(withThreadBody).includes("must-not-leak"), false);

    // Ark, review of PR 9695: the member read also aggregates every sender over
    // each thread's whole history ("participants"). The public page shows no
    // participants and an anonymous request must not read those ids or pay a
    // cost that grows with the thread, so the public path switches it off.
    // Proven on the query names the read actually issues: the public loader
    // (the function the route calls) never issues the participants read, and
    // the same recorder does see it on the member default, so its absence
    // above is not the recorder being blind.
    const recordQueries = () => {
      const names: string[] = [];
      const tracer: DbQueryTracer = (queryName, work) => { names.push(queryName); return work(); };
      return { names, tracer };
    };
    const publicRead = recordQueries();
    const publicSummaries = await loadPublicThreadPreviews(channel.id, server.id, [message.id], publicRead.tracer);
    assert.ok(publicRead.names.includes("channel_threads.latest_replies_by_threads"), "the public path reads the latest replies");
    assert.equal(publicRead.names.includes("channel_threads.participants_by_threads"), false, "the public path must not issue the participants read");
    assert.equal(publicRead.names.includes("channel_threads.unread_by_threads"), false, "the public path has no viewer, so no unread read");
    assert.deepEqual(publicSummaries[message.id]?.participantIds, [], "no participant ids are produced on the public path");
    assert.equal(publicSummaries[message.id]?.latestReplies.length, 2);
    const memberRead = recordQueries();
    const memberSummaries = await getThreadSummaries(channel.id, { parentMessageIds: [message.id], traceQuery: memberRead.tracer });
    assert.ok(memberRead.names.includes("channel_threads.participants_by_threads"), "the member default still reads participants");
    assert.deepEqual(memberSummaries[message.id]?.participantIds, [owner.id]);

    const agentThread = await getOrCreateThread(storedAgentMessage.id, owner.id, "user");
    const externalAgentReply = await createMessage(agentThread.id, "agent", externalAgent.id, "reply with a third-party avatar");
    const storedAgentReply = await createMessage(agentThread.id, "agent", storedAgent.id, "reply with a stored avatar");
    const agentPreviewBody = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`)).json() as {
      messages: Array<{ id: string; latestReplies: Array<{ messageId: string; senderName: string; senderAvatarUrl: string | null }> }>;
    };
    const agentPreview = agentPreviewBody.messages.find((row) => row.id === storedAgentMessage.id)!.latestReplies;
    assert.deepEqual(agentPreview.map((item) => [item.messageId, item.senderName, item.senderAvatarUrl]), [
      [externalAgentReply.id, "External Avatar Agent", null],
      [storedAgentReply.id, "Stored Avatar Agent", storedAgentAvatar],
    ], "reply avatars pass the same stored-upload rule as parent rows");
    assert.equal(JSON.stringify(agentPreviewBody).includes("third-party.example.test"), false);
    for (const id of [externalAgent.id, storedAgent.id]) {
      assert.equal(JSON.stringify(agentPreviewBody).includes(id), false, "reply previews must not expose agent ids");
    }
    // wg-rbac #56: a reply by another server's agent resolves like that agent's
    // parent row above ("Unknown agent", no avatar), not by its real profile.
    const otherServerAgentReply = await createMessage(agentThread.id, "agent", otherServerAgent.id, "reply from another server's agent");
    const crossServerPreviewBody = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages`)).json() as {
      messages: Array<{ id: string; latestReplies: Array<{ messageId: string; senderName: string; senderAvatarUrl: string | null }> }>;
    };
    const crossServerPreview = crossServerPreviewBody.messages.find((row) => row.id === storedAgentMessage.id)!.latestReplies
      .find((item) => item.messageId === otherServerAgentReply.id);
    assert.deepEqual(crossServerPreview && [crossServerPreview.senderName, crossServerPreview.senderAvatarUrl], ["Unknown agent", null],
      "a reply preview by another server's agent gets the parent row's fallback");
    assert.equal(JSON.stringify(crossServerPreviewBody).includes("Other Server Secret Agent"), false, "the other server's agent name must not leak through a preview");
    assert.equal(JSON.stringify(crossServerPreviewBody).includes(otherServerAvatar), false);
    const threadResponse = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages`);
    assert.equal(threadResponse.status, 200);
    const threadBody = await threadResponse.json() as { messages: Array<Record<string, unknown>> };
    assert.equal(threadBody.messages[0]?.id, reply.id);
    assert.equal(threadBody.messages[0]?.content, "> quoted\n\n**reply**");
    assert.equal(JSON.stringify(threadBody).includes(owner.id), false, "public thread DTO must not expose actor ids");
    const latestThreadPage = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages?limit=1`)).json() as { messages: Array<{ id: string }> };
    assert.deepEqual(latestThreadPage.messages.map((row) => row.id), [newerReply.id]);
    const olderThreadPage = await (await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages?limit=1&beforeMessageId=${newerReply.id}`)).json() as { messages: Array<{ id: string }> };
    assert.deepEqual(olderThreadPage.messages.map((row) => row.id), [reply.id], "public thread pagination must page beyond the latest window");

    await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
    const killedThread = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages`);
    assert.equal(killedThread.status, 404, "the Public kill switch must close the thread route too");
    await db.update(featureFlags).set({ killSwitch: false }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));

    const second = await createMessage(channel.id, "user", owner.id, "Second public message");
    const older = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages?beforeMessageId=${second.id}`);
    assert.equal(older.status, 200);
    const olderBody = await older.json() as { messages: Array<{ id: string }> };
    assert.deepEqual(
      olderBody.messages.map((row) => row.id),
      [message.id, storedAgentMessage.id, externalAgentMessage.id, otherServerAgentMessage.id],
      "message-id cursor pages only within its channel",
    );

    const other = await createChannel(server.id, "other-public", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, other.id));
    const otherMessage = await createMessage(other.id, "user", owner.id, "Other channel");
    const crossed = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/channels/${channel.id}/messages?beforeMessageId=${otherMessage.id}`);
    assert.equal(crossed.status, 404, "a cursor from another channel must not become an oracle or pagination boundary");

    await db.update(channels).set({ guestVisible: false }).where(eq(channels.id, channel.id));
    const revokedThread = await fetch(`${app.baseUrl}/api/public/servers/public-projection-70/threads/${thread.id}/messages`);
    assert.equal(revokedThread.status, 404, "thread access must disappear with its public parent on the next request");
  } finally {
    await app.close();
  }
});

/**
 * Agents' default avatar is a client-rendered pixel key, not an image URL:
 * `pixel:<key>` (a sprite in packages/shared/assets/pixelAvatars.json) or
 * `pixel:random:<seed>`. It references no URL and carries no personal data, so
 * signed-out pages show it (Warden; redo of #9991). Only keys the pixel avatar
 * service can draw project: an unknown key, an oversize seed or a seed with a
 * control character stays null, on parent rows, latestReplies and the public
 * thread endpoint alike.
 */
test("public server: agents' valid pixel avatar keys project on every anonymous message surface", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-pixel-owner@slock.test", "public-pixel-owner");
    const server = await createServer("Pixel Projection", "public-pixel-avatars", owner.id);
    const channel = await createChannel(server.id, "public-pixel", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    // A human with a pixel-shaped avatarUrl stays null: human avatars are stored uploads only.
    await db.update(users).set({ avatarUrl: "pixel:robot" }).where(eq(users.id, owner.id));

    const cases = [
      { name: "pixel-preset-agent", avatarUrl: "pixel:robot", expected: "pixel:robot" as string | null },
      { name: "pixel-random-agent", avatarUrl: "pixel:random:seed-42", expected: "pixel:random:seed-42" },
      { name: "pixel-unknown-agent", avatarUrl: "pixel:not-a-real-key", expected: null },
      { name: "pixel-oversize-agent", avatarUrl: `pixel:random:${"x".repeat(300)}`, expected: null },
      { name: "pixel-control-agent", avatarUrl: "pixel:random:seed\u0007bad", expected: null },
      { name: "pixel-empty-agent", avatarUrl: "pixel:", expected: null },
    ];
    const seeded = [];
    for (const item of cases) {
      const [agent] = await db.insert(agents).values({
        serverId: server.id,
        name: item.name,
        displayName: item.name,
        avatarUrl: item.avatarUrl,
      }).returning();
      seeded.push({ ...item, agent: agent! });
    }
    const humanMessage = await createMessage(channel.id, "user", owner.id, "human with a pixel-shaped avatarUrl");
    const thread = await getOrCreateThread(humanMessage.id, owner.id, "user");
    const parents = [];
    const replies = [];
    for (const item of seeded) {
      parents.push(await createMessage(channel.id, "agent", item.agent.id, `${item.name} parent`));
      replies.push(await createMessage(thread.id, "agent", item.agent.id, `${item.name} reply`));
    }
    const expected = seeded.map((item) => [item.name, item.expected]);

    const channelBody = await (await fetch(`${app.baseUrl}/api/public/servers/public-pixel-avatars/channels/${channel.id}/messages`)).json() as {
      messages: Array<{
        id: string;
        sender: { displayName: string; avatarUrl: string | null };
        latestReplies: Array<{ messageId: string; senderName: string; senderAvatarUrl: string | null }>;
      }>;
    };
    assert.deepEqual(
      parents.map((parent) => channelBody.messages.find((row) => row.id === parent.id)!.sender).map((sender) => [sender.displayName, sender.avatarUrl]),
      expected,
      "parent rows project valid pixel keys and null everything else",
    );
    assert.equal(channelBody.messages.find((row) => row.id === humanMessage.id)!.sender.avatarUrl, null, "a human's pixel-shaped avatarUrl is not projected");
    const threadRow = channelBody.messages.find((row) => row.id === humanMessage.id)!;
    assert.ok(threadRow.latestReplies.length >= 2);
    assert.deepEqual(
      threadRow.latestReplies.map((reply) => [reply.senderName, reply.senderAvatarUrl]),
      expected.slice(-threadRow.latestReplies.length),
      "latestReplies follow the same pixel rule (the newest replies: unknown key, oversize seed, control char, empty)",
    );

    const threadBody = await (await fetch(`${app.baseUrl}/api/public/servers/public-pixel-avatars/threads/${thread.id}/messages`)).json() as {
      messages: Array<{ id: string; sender: { displayName: string; avatarUrl: string | null } }>;
    };
    assert.deepEqual(
      replies.map((reply) => threadBody.messages.find((row) => row.id === reply.id)!.sender).map((sender) => [sender.displayName, sender.avatarUrl]),
      expected,
      "the public thread endpoint follows the same pixel rule",
    );

    // latestReplies is the newest few; make the valid keys the newest to cover them projecting there too.
    const presetReply = await createMessage(thread.id, "agent", seeded[0]!.agent.id, "preset again");
    const randomReply = await createMessage(thread.id, "agent", seeded[1]!.agent.id, "random again");
    const refreshed = await (await fetch(`${app.baseUrl}/api/public/servers/public-pixel-avatars/channels/${channel.id}/messages`)).json() as typeof channelBody;
    assert.deepEqual(
      refreshed.messages.find((row) => row.id === humanMessage.id)!.latestReplies.slice(-2).map((reply) => [reply.messageId, reply.senderAvatarUrl]),
      [[presetReply.id, "pixel:robot"], [randomReply.id, "pixel:random:seed-42"]],
      "latestReplies project valid pixel keys",
    );
  } finally {
    await app.close();
  }
});

/**
 * The toggle is OWNER-only, and that is the whole reason it is its own endpoint.
 *
 * The obvious implementation — a field on `PATCH /servers/:id` — is gated on
 * `editServerSettings`, which ADMINS also hold. Folding it in would have handed
 * "make this server readable by the entire internet" to every admin, and nothing
 * in that route would have looked wrong. This test is the thing that would go red.
 */
test("public server: only the owner can flip the toggle, not an admin", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("pv-owner@slock.test", "pv-owner");
    const admin = await seedUser("pv-admin@slock.test", "pv-admin");
    const server = await createServer("Toggle", "public-toggle-70", owner.id);
    await addMember(server.id, admin.id, "admin");
    const ownerToken = await tokenForHuman(owner.email);
    const adminToken = await tokenForHuman(admin.email);

    const open = await createChannel(server.id, "open", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));

    const url = `${app.baseUrl}/api/servers/${server.id}/public-visibility`;

    // The admin holds editServerSettings and is still refused, on both verbs.
    const adminRead = await fetch(url, { headers: headers(adminToken, server.id) });
    assert.equal(adminRead.status, 403, "an admin must not even read the public-visibility state");
    const adminWrite = await fetch(url, {
      method: "PATCH",
      headers: headers(adminToken, server.id),
      body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(adminWrite.status, 403, "an admin must not be able to publish the server");

    const [untouched] = await db.select({ v: servers.publiclyVisible }).from(servers).where(eq(servers.id, server.id));
    assert.equal(untouched.v, false, "the refused admin write must not have changed anything");

    // The owner can, and the read tells the UI exactly what becomes world-readable.
    const ownerRead = await fetch(url, { headers: headers(ownerToken, server.id) });
    assert.equal(ownerRead.status, 200, await ownerRead.clone().text());
    const state = await ownerRead.json() as { publiclyVisible: boolean; exposedChannels: { id: string }[] };
    assert.equal(state.publiclyVisible, false);
    assert.deepEqual(state.exposedChannels.map((c) => c.id), [open.id],
      "the owner is shown the exact channel list that becomes world-readable");

    const ownerWrite = await fetch(url, {
      method: "PATCH",
      headers: headers(ownerToken, server.id),
      body: JSON.stringify({ publiclyVisible: true }),
    });
    assert.equal(ownerWrite.status, 200, await ownerWrite.clone().text());

    // And the toggle is wired to the same column the anonymous route reads —
    // proving the owner-facing control and the public surface cannot drift apart.
    const anon = await fetch(`${app.baseUrl}/api/public/servers/public-toggle-70`);
    assert.equal(anon.status, 200, "flipping the owner toggle must open the anonymous surface");
  } finally {
    await app.close();
  }
});

// Guest joining is retired (#wg-rbac:#47); public reading stays. The legacy
// guestVisible field (now visitorVisible, no longer behind server_guest_v0,
// #wg-rbac:#51; channels.visitorVisible.api.test.ts) puts a channel on the public page.
test("public reading stays: an owner makes a channel visible with the legacy field, and a signed-out visitor reads it until it is hidden", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-visible-owner@slock.test", "public-visible-owner");
    const server = await createServer("Visible Setting", "public-visible-47", owner.id);
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    const channel = await createChannel(server.id, "readable", undefined, "channel", { type: "user", id: owner.id });
    const posted = await createMessage(channel.id, "user", owner.id, "public-visible-47 hello");
    const ownerHeaders = headers(await tokenForHuman(owner.email), server.id);
    const setVisible = (guestVisible: boolean) => fetch(`${app.baseUrl}/api/channels/${channel.id}`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ guestVisible }),
    });
    const listUrl = `${app.baseUrl}/api/public/servers/public-visible-47`;
    const msgsUrl = `${app.baseUrl}/api/public/servers/public-visible-47/channels/${channel.id}/messages`;

    assert.equal((await fetch(msgsUrl)).status, 404, "not readable before the owner makes it visible");

    const shown = await setVisible(true);
    assert.equal(shown.status, 200, await shown.clone().text());
    assert.equal((await shown.json() as { guestVisible: boolean }).guestVisible, true);

    // No Authorization header: a signed-out visitor.
    const listed = await fetch(listUrl);
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as Record<string, unknown> & { channels: { id: string }[] };
    assert.deepEqual(listedBody.channels.map((c) => c.id), [channel.id]);
    assert.equal("canJoinAsGuest" in listedBody, false, "the public page offers no Guest join");
    const read = await fetch(msgsUrl);
    assert.equal(read.status, 200, await read.clone().text());
    assert.ok((await read.text()).includes(posted.id), "the visitor reads the channel's messages");

    const hidden = await setVisible(false);
    assert.equal(hidden.status, 200);
    assert.equal((await fetch(msgsUrl)).status, 404, "hidden again: the visitor's next read fails");
  } finally {
    await app.close();
  }
});

test("public Guest join is gone: its owner switch and its join route 404, and servers.public_guest_join_enabled is dropped", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicAndGuestFeatures();
    const owner = await seedUser("public-join-owner@slock.test", "public-join-owner");
    const visitor = await seedUser("public-join-visitor@slock.test", "public-join-visitor");
    const server = await createServer("Join Retired", "public-join-retired-47", owner.id);
    await db.update(servers).set({ publiclyVisible: true, translationEnabled: true }).where(eq(servers.id, server.id));
    const ownerHeaders = headers(await tokenForHuman(owner.email), server.id);

    // Both rollout flags on, owner caller: still gone.
    const ownerSwitch = await fetch(`${app.baseUrl}/api/servers/${server.id}/public-guest-join`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ publicGuestJoinEnabled: true }),
    });
    assert.equal(ownerSwitch.status, 404, "PATCH /servers/:id/public-guest-join is removed");

    const joinUrl = `${app.baseUrl}/api/public/servers/public-join-retired-47/join-as-guest`;
    const membership = () => db.select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, visitor.id)));
    const anonymous = await fetch(joinUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(anonymous.status, 404, "POST /public/servers/:slug/join-as-guest is removed");
    const signedIn = await fetch(joinUrl, { method: "POST", headers: headers(await tokenForHuman(visitor.email), server.id), body: "{}" });
    assert.equal(signedIn.status, 404);
    assert.deepEqual(await membership(), [], "no membership is created");

    const readback = await (await fetch(`${app.baseUrl}/api/public/servers/public-join-retired-47`)).json() as Record<string, unknown> & { server: Record<string, unknown> };
    assert.equal("canJoinAsGuest" in readback, false);
    assert.equal("publicGuestJoinEnabled" in readback.server, false);
    assert.equal(readback.server.translationEnabled, true, "public Settings still receive the server's translation switch");

    const settings = await fetch(`${app.baseUrl}/api/servers/${server.id}/public-visibility`, { headers: ownerHeaders });
    assert.equal(settings.status, 200);
    assert.equal("publicGuestJoinEnabled" in (await settings.json() as Record<string, unknown>), false);

    // The retired column is gone (migration guest_join_public_column_drop):
    // turning Public off works on a table without it.
    const { rows } = await db.execute<{ column_name: string }>(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'public_guest_join_enabled'
    `);
    assert.deepEqual(rows, [], "servers.public_guest_join_enabled is dropped");
    const closed = await fetch(`${app.baseUrl}/api/servers/${server.id}/public-visibility`, {
      method: "PATCH",
      headers: ownerHeaders,
      body: JSON.stringify({ publiclyVisible: false }),
    });
    assert.equal(closed.status, 200, await closed.clone().text());
    assert.deepEqual(await closed.json(), { publiclyVisible: false, publicSearchEnabled: true });
  } finally {
    await app.close();
  }
});

test("a stored Guest server invite from before the one-channel model is refused, never turned into a membership (#wg-rbac:#15)", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const owner = await seedUser("source-invite-owner@slock.test", "source-invite-owner");
    const invitee = await seedUser("source-invite-guest@slock.test", "source-invite-guest");
    const server = await createServer("Invite Source", "invite-source-74", owner.id);
    const rawToken = "public-task-74-source-specific-guest-invite";
    await db.insert(serverInvites).values({
      serverId: server.id,
      invitedEmail: invitee.email,
      invitedByUserId: owner.id,
      role: "guest",
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const [precondition] = await db.select({ publiclyVisible: servers.publiclyVisible })
      .from(servers).where(eq(servers.id, server.id));
    assert.deepEqual(precondition, { publiclyVisible: false });

    const token = await tokenForHuman(invitee.email);
    const accepted = await fetch(`${app.baseUrl}/api/auth/accept-invite`, {
      method: "POST",
      headers: headers(token, server.id),
      body: JSON.stringify({ token: rawToken }),
    });
    assert.equal(accepted.status, 400, await accepted.clone().text());
    assert.deepEqual(await accepted.json(), { error: "This invite has been revoked" });
    const memberships = await db.select({ role: serverMembers.role }).from(serverMembers)
      .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
    assert.deepEqual(memberships, [], "no Guest without a channel, and no Member either");
    const [invite] = await db.select({ status: serverInvites.status }).from(serverInvites)
      .where(eq(serverInvites.serverId, server.id));
    assert.equal(invite?.status, "expired");
  } finally {
    await app.close();
  }
});

/**
 * Acceptance A5 — a logged-out visitor has NO write path, anywhere.
 *
 * The weak version of this test pokes the public router with a POST and finds a
 * 404. That is trivially true (no such route is registered) and could never have
 * gone red, so it certifies nothing. The property worth pinning is broader: with
 * the server public and a channel world-readable, an anonymous caller must not be
 * able to write through ANY route — and the check is the absence of the side
 * effect, not the status code, because a 401 returned after a row was inserted
 * would look identical from outside.
 */
test("public server: a logged-out visitor has no write path and leaves no state behind", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("pv-write-owner@slock.test", "pv-write-owner");
    const server = await createServer("NoWrite", "public-nowrite-70", owner.id);
    const open = await createChannel(server.id, "readable", undefined, "channel", { type: "user", id: owner.id });
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, open.id));
    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));

    // Confirm the reader really is inside the public surface first — otherwise
    // every refusal below could be "not public" rather than "not writable",
    // and the test would pass for the wrong reason.
    const readable = await fetch(`${app.baseUrl}/api/public/servers/public-nowrite-70/channels/${open.id}/messages`);
    assert.equal(readable.status, 200, "precondition: the anonymous reader can read this channel");

    const before = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, open.id));

    const attempts: [string, RequestInit][] = [
      // The real send path, with no credentials.
      [`${app.baseUrl}/api/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channelId: open.id, content: "anonymous write" }) }],
      // The public router itself must expose no write verb.
      [`${app.baseUrl}/api/public/servers/public-nowrite-70/channels/${open.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "anonymous write" }) }],
      // Nor a way to join, which would convert a reader into a member.
      [`${app.baseUrl}/api/channels/${open.id}/join`, { method: "POST" }],
    ];
    for (const [url, init] of attempts) {
      const res = await fetch(url, init);
      assert.ok(res.status >= 400, `anonymous write must be refused: ${init.method} ${url} returned ${res.status}`);
    }

    const after = await db.select({ id: messages.id }).from(messages).where(eq(messages.channelId, open.id));
    assert.equal(after.length, before.length, "no anonymous attempt may leave a message behind");

    const memberRows = await db.select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, open.id));
    assert.deepEqual(memberRows.map((r) => r.userId), [owner.id], "no anonymous attempt may create a membership row");
  } finally {
    await app.close();
  }
});

test("the member server list says whether the public page is live, and only that", async () => {
  // cindyz, #wg-rbac:cbca4ee7: members get an at-a-glance mark when their
  // server is public. Live means public AND rolled out; the owner-only stored
  // setting itself is not sent.
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const owner = await seedUser("public-live-owner@slock.test", "public-live-owner");
    const member = await seedUser("public-live-member@slock.test", "public-live-member");
    const server = await createServer("Public Live", "public-live-128", owner.id);
    await addMember(server.id, member.id, "member");
    const memberToken = await tokenForHuman(member.email);
    const listFor = async () => {
      const res = await fetch(`${app.baseUrl}/api/servers`, { headers: headers(memberToken, server.id) });
      assert.equal(res.status, 200);
      const rows = await res.json() as Array<Record<string, unknown>>;
      const row = rows.find((r) => r.id === server.id);
      assert.ok(row, "the member sees the server");
      return row;
    };

    const privateRow = await listFor();
    assert.equal(privateRow.publicPageLive, false, "not public: not live");
    assert.ok(!("publiclyVisible" in privateRow), "the owner-only stored setting is not sent");

    await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
    assert.equal((await listFor()).publicPageLive, false, "public but the rollout flag is off: the page 404s, so not live");

    await enablePublicServerFeature();
    assert.equal((await listFor()).publicPageLive, true, "public and rolled out: live");

    // The mark agrees with what a logged-out visitor gets from the same rows.
    const anonymous = await fetch(`${app.baseUrl}/api/public/servers/public-live-128`);
    assert.equal(anonymous.status, 200, "live in the list ⇔ the public page answers");

    // A Guest of the server receives the same boolean.
    const guest = await seedUser("public-live-guest@slock.test", "public-live-guest");
    await seedBoundGuest({ serverId: server.id, userId: guest.id });
    const guestToken = await tokenForHuman(guest.email);
    const guestRes = await fetch(`${app.baseUrl}/api/servers`, { headers: headers(guestToken, server.id) });
    const guestRow = (await guestRes.json() as Array<Record<string, unknown>>).find((r) => r.id === server.id);
    assert.equal(guestRow?.publicPageLive, true, "Guests see the same mark");

    await db.update(servers).set({ publiclyVisible: false }).where(eq(servers.id, server.id));
    assert.equal((await listFor()).publicPageLive, false, "switched back off: not live");
    const anonymousOff = await fetch(`${app.baseUrl}/api/public/servers/public-live-128`);
    assert.equal(anonymousOff.status, 404, "not live in the list ⇔ the public page is gone");
  } finally {
    await app.close();
  }
});

test("the member server list evaluates the public-page gate once for all public servers", async () => {
  // Ark: one batch evaluation (fixed query count), not one per server.
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    await enablePublicServerFeature();
    const owner = await seedUser("public-batch-owner@slock.test", "public-batch-owner");
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const server = await createServer(`Public Batch ${n}`, `public-batch-${n}-128`, owner.id);
      await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
      ids.push(server.id);
    }
    const featureFlagService = await import("../services/featureFlagService");
    const calls: number[] = [];
    const original = featureFlagService.evaluateFeatureFlags;
    const spy = vi.spyOn(featureFlagService, "evaluateFeatureFlags").mockImplementation(async (inputs, executor) => {
      calls.push(inputs.filter((input) => input.key === PUBLIC_SERVER_FEATURE_FLAG_KEY).length);
      return original(inputs, executor);
    });
    try {
      const token = await tokenForHuman(owner.email);
      const res = await fetch(`${app.baseUrl}/api/servers`, { headers: headers(token, ids[0]!) });
      const rows = await res.json() as Array<Record<string, unknown>>;
      assert.deepEqual(ids.map((id) => rows.find((r) => r.id === id)?.publicPageLive), [true, true, true]);
      assert.deepEqual(calls.filter((n) => n > 0), [3], "one batch call carrying all three public servers");
    } finally {
      spy.mockRestore();
    }
  } finally {
    await app.close();
  }
});

/** In-memory storage that streams bytes (the local-storage shape: no presign). */
function memoryStorage(objects: Record<string, string>): StorageBackend {
  return {
    async put() {},
    async delete() {},
    async get(key) {
      const body = objects[key];
      if (body === undefined) {
        const missing = new Error("The specified key does not exist.");
        missing.name = "NoSuchKey";
        throw missing;
      }
      return Readable.from([Buffer.from(body)]);
    },
  };
}

async function seedPublicAttachmentServer(slug: string) {
  const db = getDb();
  await enablePublicServerFeature();
  const owner = await seedUser(`${slug}-owner@slock.test`, `${slug}-owner`);
  const server = await createServer("Attachments", slug, owner.id);
  await db.update(servers).set({ publiclyVisible: true }).where(eq(servers.id, server.id));
  const creator = { type: "user" as const, id: owner.id };
  const channel = await createChannel(server.id, "public-files", undefined, "channel", creator);
  await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, channel.id));
  return { owner, server, channel, creator };
}

// Real sends give each linked attachment its index in the message
// (attachmentLinkingService). Without it the read falls back to created_at and
// then the random id, so two rows inserted in the same instant came back in
// either order and the deepEqual below flaked (bug-triage task #19).
const nextMessagePosition = new Map<string, number>();

async function insertAttachment(input: {
  channelId: string;
  uploaderId: string;
  messageId: string | null;
  filename: string;
  mimeType: string;
  storageKey: string;
  sizeBytes?: number;
}) {
  const id = randomUUID();
  const messagePosition = input.messageId ? nextMessagePosition.get(input.messageId) ?? 0 : null;
  if (input.messageId) nextMessagePosition.set(input.messageId, (messagePosition ?? 0) + 1);
  await insertAttachmentsWithObjects(getDb(), {
    id,
    channelId: input.channelId,
    messageId: input.messageId,
    messagePosition,
    pendingChannelId: input.messageId ? null : input.channelId,
    uploaderId: input.uploaderId,
    uploaderType: "user",
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes ?? 5,
    storageKey: input.storageKey,
    thumbnailKey: `thumbnails/${id}.webp`,
    width: input.mimeType.startsWith("image/") ? 64 : null,
    height: input.mimeType.startsWith("image/") ? 48 : null,
  });
  return id;
}

/**
 * Product decision (cindyz): the public page shows attachments, mentions and
 * reactions. Each is projected for display only — the anonymous DTO still
 * carries no user/agent id, no handle the content does not already show, no
 * reactor identity and no long-lived thumbnail capability URL.
 */
test("public server: attachments, mentions and reactions are display-only projections", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const { owner, server, channel } = await seedPublicAttachmentServer("public-rich-128");
    const mona = await seedUser("public-rich-mona@slock.test", "mona");
    await db.update(users).set({ displayName: "Mona Display" }).where(eq(users.id, mona.id));
    const editedAway = await seedUser("public-rich-edited@slock.test", "edited-away");
    const [agent] = await db.insert(agents).values({
      serverId: server.id,
      name: "helper-bot",
      displayName: "Helper Bot",
    }).returning();
    const message = await createMessage(channel.id, "user", owner.id, "hi @mona and @helper-bot, see files");
    for (const [index, [targetType, targetId, handle]] of ([
      ["user", mona.id, "mona"],
      ["agent", agent.id, "helper-bot"],
      ["user", editedAway.id, "edited-away"],
    ] as const).entries()) {
      await db.insert(messageMentions).values({
        messageId: message.id,
        messageSeq: message.seq,
        serverId: server.id,
        channelId: channel.id,
        targetType,
        targetId,
        handleAtSendTime: handle,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      });
    }
    await db.insert(messageReactions).values([
      { messageId: message.id, reactorType: "user", reactorId: owner.id, emoji: "👍", createdAt: new Date("2026-01-01T00:00:00Z") },
      { messageId: message.id, reactorType: "user", reactorId: mona.id, emoji: "👍", createdAt: new Date("2026-01-01T00:00:02Z") },
      { messageId: message.id, reactorType: "agent", reactorId: agent.id, emoji: "🎉", createdAt: new Date("2026-01-01T00:00:01Z") },
    ]);
    const imageId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "photo.png", mimeType: "image/png", storageKey: `${server.id}/photo.png`,
    });
    const htmlId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "page.html", mimeType: "text/html", storageKey: `${server.id}/page.html`,
    });

    const response = await fetch(`${app.baseUrl}/api/public/servers/public-rich-128/channels/${channel.id}/messages`);
    assert.equal(response.status, 200);
    const text = await response.text();
    const row = (JSON.parse(text) as { messages: Array<Record<string, unknown>> }).messages[0]!;
    assert.deepEqual(row.attachments, [
      { id: imageId, filename: "photo.png", mimeType: "image/png", sizeBytes: 5, width: 64, height: 48 },
      { id: htmlId, filename: "page.html", mimeType: "text/html", sizeBytes: 5, width: null, height: null },
    ]);
    assert.deepEqual(row.mentions, [
      { type: "user", name: "mona", displayName: "Mona Display" },
      { type: "agent", name: "helper-bot", displayName: "Helper Bot" },
    ], "a mention fact whose token is no longer in the content is not projected");
    assert.deepEqual(row.reactions, [{ emoji: "👍", count: 2 }, { emoji: "🎉", count: 1 }]);
    for (const secret of [owner.id, mona.id, agent.id, editedAway.id, "edited-away", "thumbnails/", server.id]) {
      assert.equal(text.includes(secret), false, `the public DTO must not carry ${secret}`);
    }
  } finally {
    await app.close();
  }
});

test("public server: a typed @name with no stored fact is highlighted only when it names a current member or agent", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const { owner, server, channel } = await seedPublicAttachmentServer("public-typed-128");
    // A server member who was never stored as a mention (e.g. outside the
    // channel when the message was sent): the member view highlights them
    // through its directory, so the public page must too.
    const dana = await seedUser("public-typed-dana@slock.test", "dana");
    await db.update(users).set({ displayName: "Dana Display" }).where(eq(users.id, dana.id));
    await db.insert(serverMembers).values({ serverId: server.id, userId: dana.id, role: "member" });
    const [agent] = await db.insert(agents).values({ serverId: server.id, name: "typed-bot", displayName: "Typed Bot" }).returning();
    // A real user who is not a member, a deleted agent, and an agent of another server.
    const outsider = await seedUser("public-typed-outsider@slock.test", "outsider");
    const [deletedAgent] = await db.insert(agents).values({ serverId: server.id, name: "gone-bot", deletedAt: new Date() }).returning();
    const otherOwner = await seedUser("public-typed-other@slock.test", "public-typed-other");
    const otherServer = await createServer("Other", "public-typed-other", otherOwner.id);
    const [foreignAgent] = await db.insert(agents).values({ serverId: otherServer.id, name: "foreign-bot" }).returning();
    // `outsider` is a member somewhere else, just not of this server.
    await db.insert(serverMembers).values({ serverId: otherServer.id, userId: outsider.id, role: "member" });

    await createMessage(
      channel.id,
      "user",
      owner.id,
      "cc @dana @typed-bot @outsider @gone-bot @foreign-bot @ghost and `@dana` in code",
    );

    const response = await fetch(`${app.baseUrl}/api/public/servers/public-typed-128/channels/${channel.id}/messages`);
    assert.equal(response.status, 200);
    const text = await response.text();
    const row = (JSON.parse(text) as { messages: Array<Record<string, unknown>> }).messages[0]!;
    const byName = new Map((row.mentions as Array<{ name: string; type: string; displayName: string }>).map((m) => [m.name, m]));
    assert.deepEqual([...byName.keys()].sort(), ["dana", "typed-bot"], "only current members/agents of this server are highlighted");
    assert.deepEqual(byName.get("dana"), { type: "user", name: "dana", displayName: "Dana Display" });
    assert.deepEqual(byName.get("typed-bot"), { type: "agent", name: "typed-bot", displayName: "Typed Bot" });
    for (const secret of [dana.id, agent.id, outsider.id, deletedAgent.id, foreignAgent.id, "Outsider"]) {
      assert.equal(text.includes(secret), false, `the public DTO must not carry ${secret}`);
    }

    // External-origin text (Slack) has no Raft mention authority: a bare
    // `@dana` there stays plain, as in the member view, while a stored
    // provider-side mention fact stays highlighted (display-only).
    const now = new Date();
    const [projection] = await db.insert(externalActorProjections).values({
      provider: "slack",
      appRegistrationId: "reg-public-typed",
      installId: "install-public-typed",
      workspaceId: "T-public-typed",
      externalActorId: "U-ada",
      displayName: "Ada Slack",
      handles: ["ada"],
      actorKind: "human",
      state: "active",
      deactivated: false,
      projectionRevision: 1,
      observedAt: now,
    }).returning();
    const [externalMessage] = await db.insert(messages).values({
      channelId: channel.id,
      senderType: "external_projection",
      senderId: projection!.id,
      messageType: "chat",
      content: "from slack: @dana and @ada",
    }).returning();
    await db.insert(externalMentionFacts).values({
      messageId: externalMessage!.id,
      projectionId: projection!.id,
      provider: "slack",
      appRegistrationId: "reg-public-typed",
      installId: "install-public-typed",
      workspaceId: "T-public-typed",
      externalActorId: "U-ada",
      connectionEpoch: 1,
      bindingId: "binding-public-typed",
      bindingEpoch: 1,
      conversationId: "C-public-typed",
      memberRevision: 1,
      contextRevision: 1,
      freshnessObservedAt: now,
      freshnessExpiresAt: new Date(now.getTime() + 60_000),
      handleAtSendTime: "ada",
      resolutionReason: "explicit_projection",
    });
    const second = await fetch(`${app.baseUrl}/api/public/servers/public-typed-128/channels/${channel.id}/messages`);
    const secondText = await second.text();
    const external = (JSON.parse(secondText) as { messages: Array<Record<string, unknown>> }).messages
      .find((m) => m.id === externalMessage!.id)!;
    assert.deepEqual(external.mentions, [{ type: "external", name: "ada", displayName: "ada" }],
      "external-origin text never resolves bare @names against the directory; stored facts still show");
    for (const secret of [dana.id, projection!.id, "U-ada"]) {
      assert.equal(secondText.includes(secret), false, `the public DTO must not carry ${secret}`);
    }
  } finally {
    await app.close();
  }
});

test("public attachment download: anonymous reads follow the public message authority on every request", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const { owner, server, channel, creator } = await seedPublicAttachmentServer("public-download-128");
    const message = await createMessage(channel.id, "user", owner.id, "files");
    const imageId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "photo.png", mimeType: "image/png", storageKey: `${server.id}/photo.png`,
    });
    const htmlId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "page.html", mimeType: "text/html", storageKey: `${server.id}/page.html`,
    });
    const svgId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "logo.svg", mimeType: "image/svg+xml", storageKey: `${server.id}/logo.svg`,
    });
    const draftId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: null,
      filename: "draft.png", mimeType: "image/png", storageKey: `${server.id}/draft.png`,
    });

    const privateChannel = await createChannel(server.id, "private-files", undefined, "private", creator);
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, privateChannel.id));
    const unmarked = await createChannel(server.id, "unmarked-files", undefined, "channel", creator);
    const archived = await createChannel(server.id, "archived-files", undefined, "channel", creator);
    await db.update(channels).set({ guestVisible: true }).where(eq(channels.id, archived.id));
    const hiddenIds: Array<[string, string]> = [];
    for (const [label, hidden] of [["private", privateChannel], ["not guest-visible", unmarked], ["archived", archived]] as const) {
      const hiddenMessage = await createMessage(hidden.id, "user", owner.id, `${label} file`);
      hiddenIds.push([label, await insertAttachment({
        channelId: hidden.id, uploaderId: owner.id, messageId: hiddenMessage.id,
        filename: "hidden.png", mimeType: "image/png", storageKey: `${server.id}/hidden.png`,
      })]);
    }
    await db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archived.id));

    // A thread under the public parent is readable; one under a private parent is not.
    const thread = await getOrCreateThread(message.id, owner.id, "user");
    const reply = await createMessage(thread.id, "user", owner.id, "reply with a file");
    const threadAttachmentId = await insertAttachment({
      channelId: thread.id, uploaderId: owner.id, messageId: reply.id,
      filename: "reply.png", mimeType: "image/png", storageKey: `${server.id}/reply.png`,
    });
    const privateParent = await createMessage(privateChannel.id, "user", owner.id, "private parent");
    const privateThread = await getOrCreateThread(privateParent.id, owner.id, "user");
    const privateReply = await createMessage(privateThread.id, "user", owner.id, "private reply");
    const privateThreadAttachmentId = await insertAttachment({
      channelId: privateThread.id, uploaderId: owner.id, messageId: privateReply.id,
      filename: "private-reply.png", mimeType: "image/png", storageKey: `${server.id}/private-reply.png`,
    });

    // Another public server: its slug must not unlock this server's attachment.
    const other = await seedPublicAttachmentServer("public-download-other-128");
    assert.ok(other.server.id);

    __setStorageForTests(memoryStorage({
      [`${server.id}/photo.png`]: "PNG!!",
      [`${server.id}/page.html`]: "<b>x</b>",
      [`${server.id}/logo.svg`]: "<svg/>",
      [`${server.id}/draft.png`]: "DRAFT",
      [`${server.id}/hidden.png`]: "HIDE!",
      [`${server.id}/reply.png`]: "REPLY",
      [`${server.id}/private-reply.png`]: "PRIVR",
    }));
    const url = (id: string, slug = "public-download-128") => `${app.baseUrl}/api/public/servers/${slug}/attachments/${id}`;

    // No Authorization header anywhere: an anonymous visitor.
    const image = await fetch(url(imageId));
    assert.equal(image.status, 200, await image.clone().text());
    assert.equal(await image.text(), "PNG!!");
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("content-disposition"), "inline; filename=\"photo.png\"; filename*=UTF-8''photo.png");
    assert.equal(image.headers.get("cache-control"), "no-store", "revocation must apply on the next request");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    // The public page (app origin) loads this via <img> from the API origin;
    // a same-origin CORP would make the browser block it (myoland, #wg-rbac:118bb169).
    assert.equal(image.headers.get("cross-origin-resource-policy"), "cross-origin");

    const forcedDownload = await fetch(`${url(imageId)}?download=1`);
    assert.equal(forcedDownload.headers.get("content-disposition"), "attachment; filename=\"photo.png\"; filename*=UTF-8''photo.png");
    await forcedDownload.arrayBuffer();
    for (const [id, filename] of [[htmlId, "page.html"], [svgId, "logo.svg"]] as const) {
      const unsafe = await fetch(url(id));
      assert.equal(unsafe.status, 200);
      assert.equal(
        unsafe.headers.get("content-disposition"),
        `attachment; filename="${filename}"; filename*=UTF-8''${filename}`,
        `${filename} must never render inline on the API origin`,
      );
      assert.equal(unsafe.headers.get("x-content-type-options"), "nosniff");
      await unsafe.arrayBuffer();
    }

    const threadRead = await fetch(url(threadAttachmentId));
    assert.equal(threadRead.status, 200, "a reply in a thread under a public parent inherits its readability");
    assert.equal(await threadRead.text(), "REPLY");

    const notFound = await (await fetch(url(randomUUID()))).text();
    const refusals: Array<[string, string, string?]> = [
      ...hiddenIds.map(([label, id]) => [`${label} channel`, id] as [string, string]),
      ["unbound draft upload", draftId],
      ["thread under a private parent", privateThreadAttachmentId],
      ["another public server's slug", imageId, "public-download-other-128"],
      ["malformed id", "not-a-uuid"],
    ];
    for (const [label, id, slug] of refusals) {
      const res = await fetch(url(id, slug));
      assert.equal(res.status, 404, `${label} must not be downloadable anonymously`);
      if (label !== "malformed id") assert.equal(await res.text(), notFound, `${label} must be indistinguishable from a missing attachment`);
    }

    await db.update(featureFlags).set({ killSwitch: true }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
    assert.equal((await fetch(url(imageId))).status, 404, "the Public kill switch closes attachment reads");
    await db.update(featureFlags).set({ killSwitch: false }).where(eq(featureFlags.key, PUBLIC_SERVER_FEATURE_FLAG_KEY));
    assert.equal((await fetch(url(imageId))).status, 200);

    await db.update(servers).set({ publiclyVisible: false }).where(eq(servers.id, server.id));
    assert.equal((await fetch(url(imageId))).status, 404, "the same reader's next attachment request fails once Public is off");
    assert.equal((await fetch(url(threadAttachmentId))).status, 404);
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

// Storage step 2b: the public page and the public download read size, type and
// key from the attachment object only. Step 2c: a projection without an object
// cannot exist any more (attachments.object_id is NOT NULL).
test("public attachments read the object, and the database refuses a projection without one", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const db = getDb();
    const { owner, server, channel } = await seedPublicAttachmentServer("public-objects-2b");
    const message = await createMessage(channel.id, "user", owner.id, "files");
    const imageId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "photo.png", mimeType: "image/png", storageKey: `${server.id}/photo.png`,
    });
    await assert.rejects(db.insert(attachments).values({
      id: randomUUID(), objectId: null as unknown as string, channelId: channel.id, messageId: message.id, messagePosition: 1,
      uploaderId: owner.id, uploaderType: "user", filename: "objectless.png",
    }));
    __setStorageForTests(memoryStorage({
      [`${server.id}/photo.png`]: "PNG!!",
    }));

    const page = await fetch(`${app.baseUrl}/api/public/servers/public-objects-2b/channels/${channel.id}/messages`);
    assert.equal(page.status, 200);
    const [row] = (await page.json() as { messages: Array<{ attachments: unknown[] }> }).messages;
    assert.deepEqual(row!.attachments, [
      { id: imageId, filename: "photo.png", mimeType: "image/png", sizeBytes: 5, width: 64, height: 48 },
    ]);

    const image = await fetch(`${app.baseUrl}/api/public/servers/public-objects-2b/attachments/${imageId}`);
    assert.equal(image.status, 200);
    assert.equal(await image.text(), "PNG!!");
    assert.equal(image.headers.get("content-type"), "image/png");
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("public attachment download: object storage gets a one-minute presigned redirect", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { owner, server, channel } = await seedPublicAttachmentServer("public-presign-128");
    const message = await createMessage(channel.id, "user", owner.id, "file");
    const htmlId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "page.html", mimeType: "text/html", storageKey: `${server.id}/page.html`,
    });
    const presignCalls: Array<{ key: string; options: Parameters<NonNullable<StorageBackend["getPresignedUrl"]>>[1] }> = [];
    __setStorageForTests({
      ...memoryStorage({}),
      async getPresignedUrl(key, options) {
        presignCalls.push({ key, options });
        return "https://storage.example.test/presigned";
      },
    });
    const res = await fetch(`${app.baseUrl}/api/public/servers/public-presign-128/attachments/${htmlId}`, { redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "https://storage.example.test/presigned");
    assert.equal(res.headers.get("cache-control"), "no-store");
    // The browser applies CORP to the redirect hop too, so it must allow the app origin.
    assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.deepEqual(presignCalls, [{
      key: `${server.id}/page.html`,
      options: {
        expiresIn: PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
        responseContentDisposition: "attachment; filename=\"page.html\"; filename*=UTF-8''page.html",
        responseContentType: "text/html; charset=utf-8",
      },
    }]);
    assert.equal(PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS, 60);
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

/**
 * Product decision (cindyz): the public page previews PDFs like members do. The
 * read-only preview frame opts in with `?disposition=inline`; only a PDF honors
 * it, with the member inline-preview headers, and each request still
 * reauthorizes. HTML and SVG stay downloads whatever the query says.
 */
test("public attachment preview: only a PDF is served inline on request, with the member preview headers", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { owner, server, channel } = await seedPublicAttachmentServer("public-pdf-preview");
    const message = await createMessage(channel.id, "user", owner.id, "files");
    const pdfId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "paper.pdf", mimeType: "application/pdf", storageKey: `${server.id}/paper.pdf`,
    });
    const htmlId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "page.html", mimeType: "text/html", storageKey: `${server.id}/page.html`,
    });
    const svgId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "logo.svg", mimeType: "image/svg+xml", storageKey: `${server.id}/logo.svg`,
    });
    __setStorageForTests(memoryStorage({
      [`${server.id}/paper.pdf`]: "%PDF-",
      [`${server.id}/page.html`]: "<b>x</b>",
      [`${server.id}/logo.svg`]: "<svg/>",
    }));
    const url = (id: string, query = "") => `${app.baseUrl}/api/public/servers/public-pdf-preview/attachments/${id}${query}`;

    const inline = await fetch(url(pdfId, "?disposition=inline"));
    assert.equal(inline.status, 200);
    assert.equal(await inline.text(), "%PDF-");
    assert.equal(inline.headers.get("content-type"), "application/pdf");
    assert.equal(inline.headers.get("content-disposition"), "inline; filename=\"paper.pdf\"; filename*=UTF-8''paper.pdf");
    assert.equal(inline.headers.get("x-content-type-options"), "nosniff");
    assert.equal(inline.headers.get("cache-control"), "no-store");
    const csp = inline.headers.get("content-security-policy") ?? "";
    assert.match(csp, /^frame-ancestors 'self'/);
    assert.doesNotMatch(csp, /sandbox/, "Chromium's PDF viewer cannot load under a sandbox CSP");
    assert.ok(inline.headers.get("x-frame-options") === null, "the web app must be able to frame the PDF");
    assert.equal(inline.headers.get("cross-origin-resource-policy"), "cross-origin");
    assert.equal(inline.headers.get("referrer-policy"), "no-referrer");

    for (const query of ["", "?disposition=inline&download=1"]) {
      const download = await fetch(url(pdfId, query));
      assert.equal(download.headers.get("content-disposition"), "attachment; filename=\"paper.pdf\"; filename*=UTF-8''paper.pdf", `PDF ${query || "default"} is a download`);
      assert.equal(download.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      await download.arrayBuffer();
    }
    for (const [id, filename] of [[htmlId, "page.html"], [svgId, "logo.svg"]] as const) {
      const unsafe = await fetch(url(id, "?disposition=inline"));
      assert.equal(unsafe.headers.get("content-disposition"), `attachment; filename="${filename}"; filename*=UTF-8''${filename}`, `${filename} never renders inline`);
      assert.equal(unsafe.headers.get("content-security-policy"), "default-src 'none'; sandbox");
      await unsafe.arrayBuffer();
    }

    await getDb().update(servers).set({ publiclyVisible: false }).where(eq(servers.id, server.id));
    assert.equal((await fetch(url(pdfId, "?disposition=inline"))).status, 404, "the inline preview reauthorizes on every request");
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("public attachment preview: an inline PDF presigns an inline disposition, still for one minute", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const { owner, server, channel } = await seedPublicAttachmentServer("public-pdf-presign");
    const message = await createMessage(channel.id, "user", owner.id, "file");
    const pdfId = await insertAttachment({
      channelId: channel.id, uploaderId: owner.id, messageId: message.id,
      filename: "paper.pdf", mimeType: "application/pdf", storageKey: `${server.id}/paper.pdf`,
    });
    const presignCalls: Array<Parameters<NonNullable<StorageBackend["getPresignedUrl"]>>[1]> = [];
    __setStorageForTests({
      ...memoryStorage({}),
      async getPresignedUrl(_key, options) {
        presignCalls.push(options);
        return "https://storage.example.test/presigned";
      },
    });
    const base = `${app.baseUrl}/api/public/servers/public-pdf-presign/attachments/${pdfId}`;
    assert.equal((await fetch(`${base}?disposition=inline`, { redirect: "manual" })).status, 302);
    assert.equal((await fetch(base, { redirect: "manual" })).status, 302);
    assert.deepEqual(presignCalls, [
      {
        expiresIn: PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
        responseContentDisposition: "inline; filename=\"paper.pdf\"; filename*=UTF-8''paper.pdf",
        responseContentType: "application/pdf",
      },
      {
        expiresIn: PUBLIC_ATTACHMENT_PRESIGNED_URL_TTL_SECONDS,
        responseContentDisposition: "attachment; filename=\"paper.pdf\"; filename*=UTF-8''paper.pdf",
        responseContentType: "application/pdf",
      },
    ]);
  } finally {
    resetStorageForTests();
    await app.close();
  }
});

test("public attachment downloads have their own one-hundred-twenty-per-minute IP budget", async () => {
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const url = `${app.baseUrl}/api/public/servers/rate-limit-probe/attachments/${randomUUID()}`;
    for (let index = 0; index < 120; index += 1) {
      const response = await fetch(url);
      assert.equal(response.status, 404, `request ${index + 1} should reach authorization before the IP budget is exhausted`);
    }
    const limited = await fetch(url);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "Too many public attachment requests, please slow down" });
  } finally {
    await app.close();
  }
});
