import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { getDb } from "../db/index";
import { eq } from "drizzle-orm";
import { channels, jointChannelServers, messages, servers, users } from "../db/schema";
import { seedJointChannel } from "../test/integration/jointFixture";
import {
  formatCanonicalAgentMessageRef,
  replacePermalinksOutsideMarkdownCode,
  renderAgentReadablePermalinksInTexts,
  renderAgentReadablePermalinks,
} from "./agentPermalinkRenderService";


afterEach(async () => {
  await closeTestDatabase();
});

test("formatCanonicalAgentMessageRef uses target+msg for regular channels", () => {
  assert.equal(
    formatCanonicalAgentMessageRef({
      messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
      channelName: "engineering",
      channelType: "channel",
      parentMessageId: null,
      parentChannelName: null,
      parentChannelType: null,
    }),
    "#engineering msg=7556f881",
  );
});

test("formatCanonicalAgentMessageRef uses DM target+msg for DM messages", () => {
  assert.equal(
    formatCanonicalAgentMessageRef({
      messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
      channelName: "richard",
      channelType: "dm",
      parentMessageId: null,
      parentChannelName: null,
      parentChannelType: null,
    }),
    "dm:@richard msg=7556f881",
  );
});

test("formatCanonicalAgentMessageRef uses thread target plus msg for thread replies", () => {
  assert.equal(
    formatCanonicalAgentMessageRef({
      messageId: "7556f881-a5f8-4b0d-88dc-8b5af28e8f05",
      channelName: "thread-a1b2c3d4",
      channelType: "thread",
      parentMessageId: "a1b2c3d4-1111-2222-3333-444444444444",
      parentChannelName: "engineering",
      parentChannelType: "channel",
    }),
    "#engineering:a1b2c3d4 msg=7556f881",
  );
});

test("replacePermalinksOutsideMarkdownCode leaves inline-code permalinks raw", () => {
  const permalink = "https://app.slock.ai/s/botiverse/channel/d18d9dad-8a5c-44ef-8d85-2c0570baf939?message=cbdd9db5-9229-4bf2-89de-b2ec815703b5";
  const rendered = replacePermalinksOutsideMarkdownCode(
    `send raw \`${permalink}\` but also mention ${permalink}`,
    new Map([[permalink, "#engineering msg=cbdd9db5"]]),
  );

  assert.equal(
    rendered,
    `send raw \`${permalink}\` but also mention #engineering msg=cbdd9db5`,
  );
});

test("replacePermalinksOutsideMarkdownCode leaves fenced-code permalinks raw", () => {
  const permalink = "https://app.slock.ai/s/botiverse/channel/d18d9dad-8a5c-44ef-8d85-2c0570baf939?message=cbdd9db5-9229-4bf2-89de-b2ec815703b5";
  const rendered = replacePermalinksOutsideMarkdownCode(
    `\`\`\`txt\n${permalink}\n\`\`\`\noutside ${permalink}`,
    new Map([[permalink, "#engineering msg=cbdd9db5"]]),
  );

  assert.equal(
    rendered,
    `\`\`\`txt\n${permalink}\n\`\`\`\noutside #engineering msg=cbdd9db5`,
  );
});

test("renderAgentReadablePermalinks stops permalink extraction at CJK punctuation", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "permalink-owner@slock.test",
    name: "permalink-owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Botiverse",
    slug: "botiverse",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "proj-message",
    type: "channel",
  }).returning();
  const [message] = await db.insert(messages).values({
    channelId: channel.id,
    senderType: "user",
    senderId: owner.id,
    content: "target",
  }).returning();

  const permalink = `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=${message.id}`;
  const rendered = await renderAgentReadablePermalinks(
    `谁做一下 ${permalink}，Kevin 不适合做这个`,
    server.id,
  );

  assert.equal(rendered, `谁做一下 #proj-message msg=${message.id.slice(0, 8)}，Kevin 不适合做这个`);
});

test("renderAgentReadablePermalinks canonicalizes parent-channel permalinks that point at thread replies", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "thread-permalink-owner@slock.test",
    name: "thread-permalink-owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Botiverse",
    slug: "botiverse",
    ownerId: owner.id,
  }).returning();
  const [parentChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: "proj-task",
    type: "channel",
  }).returning();
  const [parentMessage] = await db.insert(messages).values({
    channelId: parentChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "task root",
  }).returning();
  const [threadChannel] = await db.insert(channels).values({
    serverId: server.id,
    name: `thread-${parentMessage.id.slice(0, 8)}`,
    type: "thread",
    parentMessageId: parentMessage.id,
  }).returning();
  const [reply] = await db.insert(messages).values({
    channelId: threadChannel.id,
    senderType: "user",
    senderId: owner.id,
    content: "thread reply",
  }).returning();

  const malformedPermalink = `https://app.slock.ai/s/${server.slug}/channel/${parentChannel.id}?msg=${reply.id.slice(0, 8)}`;
  const rendered = await renderAgentReadablePermalinks(
    `bad link ${malformedPermalink}`,
    server.id,
  );

  assert.equal(rendered, `bad link #proj-task:${parentMessage.id.slice(0, 8)} msg=${reply.id.slice(0, 8)}`);
});

test("renderAgentReadablePermalinks accepts the APP_URL host", async () => {
  const previousAppUrl = process.env.APP_URL;
  process.env.APP_URL = "https://chat.example.com";
  try {
    await openTestDatabase("pglite://");
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "configured-host-owner@slock.test",
      name: "configured-host-owner",
      passwordHash: "hash",
      emailVerified: true,
    }).returning();
    const [server] = await db.insert(servers).values({
      name: "Botiverse",
      slug: "botiverse",
      ownerId: owner.id,
    }).returning();
    const [channel] = await db.insert(channels).values({
      serverId: server.id,
      name: "proj-message",
      type: "channel",
    }).returning();
    const [message] = await db.insert(messages).values({
      channelId: channel.id,
      senderType: "user",
      senderId: owner.id,
      content: "target",
    }).returning();

    const permalink = `https://chat.example.com/s/${server.slug}/channel/${channel.id}?msg=${message.id}`;
    const rendered = await renderAgentReadablePermalinks(`see ${permalink}`, server.id);

    assert.equal(rendered, `see #proj-message msg=${message.id.slice(0, 8)}`);
  } finally {
    if (previousAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previousAppUrl;
  }
});

test("renderAgentReadablePermalinks preserves malformed message ids", async ({ db: database }) => {

  const db = getDb();
  const [owner] = await db.insert(users).values({
    email: "malformed-permalink-owner@slock.test",
    name: "malformed-permalink-owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "Botiverse",
    slug: "botiverse",
    ownerId: owner.id,
  }).returning();
  const [channel] = await db.insert(channels).values({
    serverId: server.id,
    name: "proj-message",
    type: "channel",
  }).returning();

  const permalink = `https://app.slock.ai/s/${server.slug}/channel/${channel.id}?msg=abc123456789`;
  const content = `malformed ${permalink}`;
  const rendered = await renderAgentReadablePermalinks(content, server.id);

  assert.equal(rendered, content);
});

test("renderAgentReadablePermalinks fails open and preserves original content", async ({ db }) => {

  const content = "see https://app.slock.ai/s/botiverse/channel/11111111-1111-1111-1111-111111111111?msg=aaaaaaaa";
  await closeTestDatabase();

  assert.equal(await renderAgentReadablePermalinks(content, "not-a-server-uuid"), content);
  assert.deepEqual(await renderAgentReadablePermalinksInTexts([content], "not-a-server-uuid"), [content]);
});

// #460: a joint channel's messages live in its canonical channel (on the joint_storage server), so a permalink into
// the server's own projection of a joint was left raw. It renders by that projection, as the server's channels do;
// one into another server's projection, or a joint the server has left, stays raw.
test("renderAgentReadablePermalinks renders a permalink into the server's own joint projection by that projection", async ({ db: _db }) => {
  const db = getDb();
  const [owner] = await db.insert(users).values({ email: "joint-permalink-owner@slock.test", name: "joint-permalink-owner", passwordHash: "hash", emailVerified: true }).returning();
  const [host, peer] = await db.insert(servers).values([
    { name: "Host", slug: "jp-host", ownerId: owner!.id },
    { name: "Peer", slug: "jp-peer", ownerId: owner!.id },
  ]).returning();
  const joint = await seedJointChannel({ name: "partners", serverIds: [host!.id, peer!.id], createdByUserId: owner!.id });
  const [hostCopy, peerCopy] = joint.projections as [typeof joint.projections[number], typeof joint.projections[number]];
  const [top, parent] = await db.insert(messages).values([
    { channelId: joint.canonical.id, senderType: "user", senderId: owner!.id, content: "joint top" },
    { channelId: joint.canonical.id, senderType: "user", senderId: owner!.id, content: "joint parent" },
  ]).returning();
  const [thread] = await db.insert(channels).values({ serverId: joint.canonical.serverId, name: `thread-${parent!.id.slice(0, 8)}`, type: "thread", parentMessageId: parent!.id }).returning();
  const [reply] = await db.insert(messages).values({ channelId: thread!.id, senderType: "user", senderId: owner!.id, content: "joint reply" }).returning();

  const link = (slug: string, channelId: string, msg: string) => `https://app.slock.ai/s/${slug}/channel/${channelId}?msg=${msg}`;
  assert.equal(
    await renderAgentReadablePermalinks(`see ${link("jp-host", hostCopy.id, top!.id)} and ${link("jp-host", hostCopy.id, top!.id.slice(0, 8))}`, host!.id),
    `see #partners msg=${top!.id.slice(0, 8)} and #partners msg=${top!.id.slice(0, 8)}`,
  );
  assert.equal(
    await renderAgentReadablePermalinks(`reply ${link("jp-host", hostCopy.id, reply!.id.slice(0, 8))}`, host!.id),
    `reply #partners:${parent!.id.slice(0, 8)} msg=${reply!.id.slice(0, 8)}`,
  );
  // Another server's projection: not this server's conversation, raw (its slug is not this server's either).
  const foreign = `x ${link("jp-host", peerCopy.id, top!.id)}`;
  assert.equal(await renderAgentReadablePermalinks(foreign, host!.id), foreign);
  // The host leaves the joint: raw.
  await db.update(jointChannelServers).set({ status: "disconnected" }).where(eq(jointChannelServers.localChannelId, hostCopy.id));
  const left = `y ${link("jp-host", hostCopy.id, top!.id)}`;
  assert.equal(await renderAgentReadablePermalinks(left, host!.id), left);
});
