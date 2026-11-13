import { tokenForHuman, fixturePasswordHash } from "../test/integration/credentials";
import { insertAttachmentsWithObjects } from "../test/attachmentObjectFixture";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";

import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { openTestApp } from "../test/integration/app";
import { getDb } from "../db/index";
import { attachmentCommentRefs, channels, messageMentions, messages, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { addHuman, createChannel, getOrCreateThread } from "../services/channelService";
import { createMessage } from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

/**
 * API tests for attachment comments (attachment-comments MVP spec §4, task #3 / PR1).
 *
 * Model under test: a comment is a NORMAL message in the attachment's
 * parent-message thread plus one attachment_comment_refs row scoping it to
 * the attachment. Cases reference the spec's §6 matrices (C2/C3/C4 scoped vs
 * general, C12 read-only, J11 archived, J12 unlinked, §3 FK hygiene).
 */



async function seedFixture() {
  const db = getDb();
  const passwordHash = await argon2.hash("password123");

  const mkUser = async (name: string) => {
    const [row] = await db
      .insert(users)
      .values({
        email: `${name}@slock.test`,
        name,
        displayName: name,
        passwordHash,
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      })
      .returning();
    return row;
  };

  const owner = await mkUser("ac-owner");
  const reviewer = await mkUser("ac-reviewer");
  const readonly = await mkUser("ac-readonly");

  // Slug "botiverse": used as a fixture slug for attachment comment tests
  // (task #34) — same pattern as the joint-channel creator gate tests.
  const server = await createServer("AC Test", "botiverse", owner.id);
  for (const u of [reviewer, readonly]) {
    await db.insert(serverMembers).values({ serverId: server.id, userId: u.id, role: "member" });
  }

  const channel = await createChannel(server.id, "ac-reports", "channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, reviewer.id);
  // `readonly` is a server member but NOT a channel member (spec actor A3).

  const parentMessage = await createMessage(channel.id, "user", owner.id, "daily report", "chat");

  const mkAttachment = async (id: string, filename: string, messageId: string | null) => {
    const [row] = await insertAttachmentsWithObjects(db, {
        id,
        messageId,
        channelId: channel.id,
        uploaderId: owner.id,
        uploaderType: "user",
        filename,
        mimeType: "text/html",
        sizeBytes: 10,
        storageKey: `${server.id}/${filename}`,
      });
    return row;
  };

  const linked = await mkAttachment("00000000-0000-4000-8000-00000000ac01", "report.html", parentMessage.id);
  const sibling = await mkAttachment("00000000-0000-4000-8000-00000000ac02", "report.png", parentMessage.id);
  const unlinked = await mkAttachment("00000000-0000-4000-8000-00000000ac00", "draft.html", null);

  return { db, owner, reviewer, readonly, server, channel, parentMessage, linked, sibling, unlinked };
}

function authHeaders(token: string, serverId: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "X-Server-Id": serverId,
  };
}

type EmittedEvent = { room: string; event: string; payload: unknown };

function installFakeIo(app: { set: (key: string, value: unknown) => void }): EmittedEvent[] {
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

test("attachment comments: malformed :id is a typed 400", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const headers = authHeaders(reviewerToken, fx.server.id);
    const malformed = "not-a-uuid";

    // The id never reaches the uuid column, so it is a client error.
    const enabledGet = await fetch(`${baseUrl}/api/attachments/${malformed}/comments`, { headers });
    assert.equal(enabledGet.status, 400, `GET expected 400, got ${enabledGet.status}`);
    assert.equal(((await enabledGet.json()) as { code: string }).code, "invalid_attachment_id");

    const enabledPost = await fetch(`${baseUrl}/api/attachments/${malformed}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "never stored" }),
    });
    assert.equal(enabledPost.status, 400, `POST expected 400, got ${enabledPost.status}`);
    assert.equal(((await enabledPost.json()) as { code: string }).code, "invalid_attachment_id");

  } finally {
    await close();
  }
});

test("attachment comments: message reads expose scoped metadata while shared live updates strip it", async () => {
  const { app, baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const ownerToken = await tokenForHuman("ac-owner@slock.test");
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const ownerHeaders = authHeaders(ownerToken, fx.server.id);
    const reviewerHeaders = authHeaders(reviewerToken, fx.server.id);
    const events = installFakeIo(app);

    const createRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({ content: "viewer-scoped flag probe" }),
    });
    assert.equal(createRes.status, 200, await createRes.clone().text());
    const created = (await createRes.json()) as {
      message: { id: string; commentRef?: { attachmentId: string } | null };
      threadChannelId: string;
    };
    assert.equal(
      created.message.commentRef?.attachmentId,
      fx.linked.id,
      "comment author receives scoped commentRef in the create response for immediate local rendering",
    );
    const createLiveUpdate = events.find((event) =>
      event.event === "message:updated"
      && event.room === `channel:${created.threadChannelId}`
      && (event.payload as { id?: string }).id === created.message.id
    );
    assert.ok(createLiveUpdate, "comment create should emit a shared live update");
    assert.equal(
      (createLiveUpdate!.payload as { commentRef?: unknown }).commentRef,
      null,
      "shared comment-create live update must not expose scoped commentRef",
    );

    const commentSearchRes = await fetch(
      `${baseUrl}/api/messages/search?q=${encodeURIComponent("viewer-scoped flag probe")}&limit=10`,
      { headers: reviewerHeaders },
    );
    assert.equal(commentSearchRes.status, 200, await commentSearchRes.clone().text());
    const commentSearch = (await commentSearchRes.json()) as { results: Array<Record<string, unknown>> };
    const commentSearchHit = commentSearch.results.find((m) => m.id === created.message.id);
    assert.ok(commentSearchHit, "search still returns the normal message result");
    assert.equal("commentRef" in commentSearchHit!, false, "search shape must not expose scoped commentRef");
    assert.equal("attachments" in commentSearchHit!, false, "search shape must not expose scoped attachment counts");

    const ownerThreadRes = await fetch(`${baseUrl}/api/messages/channel/${created.threadChannelId}?limit=50`, {
      headers: ownerHeaders,
    });
    assert.equal(ownerThreadRes.status, 200, await ownerThreadRes.clone().text());
    const ownerThreadMessages = (await ownerThreadRes.json()) as {
      messages: Array<{ id: string; commentRef: { attachmentId: string } | null }>;
    };
    assert.equal(
      ownerThreadMessages.messages.find((m) => m.id === created.message.id)?.commentRef?.attachmentId,
      fx.linked.id,
      "viewer observes scoped commentRef",
    );

    const ownerParentRes = await fetch(`${baseUrl}/api/messages/channel/${fx.channel.id}?limit=50`, {
      headers: ownerHeaders,
    });
    assert.equal(ownerParentRes.status, 200, await ownerParentRes.clone().text());
    const ownerParentMessages = (await ownerParentRes.json()) as {
      messages: Array<{ id: string; attachments: Array<{ id: string; commentCount: number }> }>;
    };
    const ownerParent = ownerParentMessages.messages.find((m) => m.id === fx.parentMessage.id);
    assert.ok(ownerParent, "parent message present");
    assert.equal(ownerParent!.attachments.find((a) => a.id === fx.linked.id)?.commentCount, 1);

    const ownerThreadContextRes = await fetch(
      `${baseUrl}/api/messages/context/${created.message.id}?channelId=${created.threadChannelId}`,
      { headers: ownerHeaders },
    );
    assert.equal(ownerThreadContextRes.status, 200, await ownerThreadContextRes.clone().text());
    const ownerThreadContext = (await ownerThreadContextRes.json()) as {
      messages: Array<{ id: string; commentRef: { attachmentId: string } | null }>;
    };
    assert.equal(
      ownerThreadContext.messages.find((m) => m.id === created.message.id)?.commentRef?.attachmentId,
      fx.linked.id,
      "viewer observes scoped commentRef via context/permalink",
    );

    const ownerParentContextRes = await fetch(
      `${baseUrl}/api/messages/context/${fx.parentMessage.id}?channelId=${fx.channel.id}`,
      { headers: ownerHeaders },
    );
    assert.equal(ownerParentContextRes.status, 200, await ownerParentContextRes.clone().text());
    const ownerParentContext = (await ownerParentContextRes.json()) as {
      messages: Array<{ id: string; attachments: Array<{ id: string; commentCount: number }> }>;
    };
    assert.equal(
      ownerParentContext.messages
        .find((m) => m.id === fx.parentMessage.id)
        ?.attachments.find((a) => a.id === fx.linked.id)?.commentCount,
      1,
      "viewer observes scoped commentCount via context/permalink",
    );

    const ownerThreadSyncRes = await fetch(
      `${baseUrl}/api/messages/sync?channel_id=${created.threadChannelId}&since_seq=0&limit=50`,
      { headers: ownerHeaders },
    );
    assert.equal(ownerThreadSyncRes.status, 200, await ownerThreadSyncRes.clone().text());
    const ownerThreadSync = (await ownerThreadSyncRes.json()) as Array<{
      id: string;
      commentRef: { attachmentId: string } | null;
    }>;
    assert.equal(
      ownerThreadSync.find((m) => m.id === created.message.id)?.commentRef?.attachmentId,
      fx.linked.id,
      "viewer observes scoped commentRef via sync",
    );

    const ownerParentSyncRes = await fetch(
      `${baseUrl}/api/messages/sync?channel_id=${fx.channel.id}&since_seq=0&limit=50`,
      { headers: ownerHeaders },
    );
    assert.equal(ownerParentSyncRes.status, 200, await ownerParentSyncRes.clone().text());
    const ownerParentSync = (await ownerParentSyncRes.json()) as Array<{
      id: string;
      attachments: Array<{ id: string; commentCount: number }>;
    }>;
    assert.equal(
      ownerParentSync.find((m) => m.id === fx.parentMessage.id)?.attachments.find((a) => a.id === fx.linked.id)?.commentCount,
      1,
      "viewer observes scoped commentCount via sync",
    );

    events.length = 0;
    const ownerCommentReactionRes = await fetch(`${baseUrl}/api/messages/${created.message.id}/reactions`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ emoji: "rocket" }),
    });
    assert.equal(ownerCommentReactionRes.status, 200, await ownerCommentReactionRes.clone().text());
    const ownerCommentReaction = (await ownerCommentReactionRes.json()) as {
      commentRef: { attachmentId: string } | null;
    };
    assert.equal(
      ownerCommentReaction.commentRef?.attachmentId,
      fx.linked.id,
      "reaction response observes scoped commentRef",
    );
    const ownerCommentReactionLiveUpdate = events.find((event) =>
      event.event === "message:updated"
      && event.room === `channel:${created.threadChannelId}`
      && (event.payload as { id?: string }).id === created.message.id
    );
    assert.ok(ownerCommentReactionLiveUpdate, "owner comment reaction should emit a shared live update");
    assert.equal(
      (ownerCommentReactionLiveUpdate!.payload as { commentRef?: unknown }).commentRef,
      null,
      "shared live update must strip scoped commentRef even when the actor can see it",
    );

    events.length = 0;
    const ownerParentReactionRes = await fetch(`${baseUrl}/api/messages/${fx.parentMessage.id}/reactions`, {
      method: "POST",
      headers: ownerHeaders,
      body: JSON.stringify({ emoji: "paperclip" }),
    });
    assert.equal(ownerParentReactionRes.status, 200, await ownerParentReactionRes.clone().text());
    const ownerParentReaction = (await ownerParentReactionRes.json()) as {
      attachments: Array<{ id: string; commentCount: number }>;
    };
    assert.equal(
      ownerParentReaction.attachments.find((a) => a.id === fx.linked.id)?.commentCount,
      1,
      "reaction response observes scoped commentCount",
    );
    const ownerParentReactionLiveUpdate = events.find((event) =>
      event.event === "message:updated"
      && event.room === `channel:${fx.channel.id}`
      && (event.payload as { id?: string }).id === fx.parentMessage.id
    );
    assert.ok(ownerParentReactionLiveUpdate, "owner parent reaction should emit a shared live update");
    assert.equal(
      ((ownerParentReactionLiveUpdate!.payload as { attachments?: Array<{ id: string; commentCount: number }> })
        .attachments ?? [])
        .find((a) => a.id === fx.linked.id)?.commentCount,
      0,
      "shared live update must strip scoped commentCount even when the actor can see it",
    );
  } finally {
    await close();
  }
});

test("attachment comments: closed loop (create → scoped list → counts → thread reuse → cascade)", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const headers = authHeaders(reviewerToken, fx.server.id);

    // C2: create a scoped comment.
    const createRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "Segment 口径对吗？ > quoted line" }),
    });
    assert.equal(createRes.status, 200, await createRes.clone().text());
    const created = (await createRes.json()) as {
      message: { id: string; channelId: string; content: string };
      threadChannelId: string;
    };
    assert.equal(created.message.content, "Segment 口径对吗？ > quoted line");
    assert.notEqual(created.threadChannelId, fx.channel.id, "comment lives in thread, not parent channel");
    assert.equal(created.message.channelId, created.threadChannelId);

    // Ref row exists and scopes to the right attachment.
    const refs = await fx.db
      .select()
      .from(attachmentCommentRefs)
      .where(eq(attachmentCommentRefs.commentMessageId, created.message.id));
    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentId, fx.linked.id);

    // C4: a direct (unscoped) thread reply must NOT appear in the scoped list.
    await createMessage(created.threadChannelId, "user", fx.owner.id, "general discussion reply", "chat");

    // Sibling scope isolation: comment on the sibling attachment.
    const siblingRes = await fetch(`${baseUrl}/api/attachments/${fx.sibling.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "PNG 配色太浅" }),
    });
    assert.equal(siblingRes.status, 200);
    const siblingCreated = (await siblingRes.json()) as { threadChannelId: string };
    assert.equal(
      siblingCreated.threadChannelId,
      created.threadChannelId,
      "siblings share the parent-message thread as conversation container",
    );

    // Scoped list: exactly the linked attachment's comment, not the sibling's, not the general reply.
    const listRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, { headers });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as { comments: Array<{ id: string; content: string; reactions: unknown[] }> };
    assert.equal(list.comments.length, 1);
    assert.equal(list.comments[0].id, created.message.id);
    assert.ok(Array.isArray(list.comments[0].reactions));

    // Batch counts are exact per attachment id.
    const countsRes = await fetch(
      `${baseUrl}/api/attachments/comments/counts?ids=${fx.linked.id},${fx.sibling.id},${fx.unlinked.id}`,
      { headers },
    );
    assert.equal(countsRes.status, 200);
    const { counts } = (await countsRes.json()) as { counts: Record<string, number> };
    assert.equal(counts[fx.linked.id], 1);
    assert.equal(counts[fx.sibling.id], 1);
    assert.equal(counts[fx.unlinked.id] ?? 0, 0);

    // Thread reuse: a second comment on the same attachment reuses the thread.
    const secondRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "second pass note" }),
    });
    assert.equal(secondRes.status, 200);
    const second = (await secondRes.json()) as { threadChannelId: string };
    assert.equal(second.threadChannelId, created.threadChannelId);

    // Jump contract (cindyz 6/11, Dozy shape): the messages-list enrichment
    // exposes host coordinates on the comment's re: chip payload —
    // direct-host case routes by the HOST channel itself.
    const channelMessages = (await (await fetch(
      `${baseUrl}/api/messages/channel/${created.threadChannelId}?limit=50`,
      { headers },
    )).json()) as { messages: Array<{ id: string; commentRef: { attachmentId: string; hostMessageId: string; hostSource: { type: string; routeKind: string; channelId: string } } | null }> };
    const enriched = channelMessages.messages.find((m) => m.id === created.message.id);
    assert.ok(enriched, "comment message present in thread listing");
    assert.equal(enriched!.commentRef?.attachmentId, fx.linked.id);
    assert.equal(enriched!.commentRef?.hostMessageId, fx.parentMessage.id);
    // The host top-level message now carries an active thread (the comment
    // thread reused above), so it is a thread root: hostSource flags it via
    // rootThreadChannelId so the re: chip opens the thread expanded rather than
    // locating the closed-state message (cindyz #32, decision A — any host with
    // a thread opens it).
    assert.deepEqual(enriched!.commentRef?.hostSource, {
      type: "channel",
      routeKind: "channel",
      channelId: fx.channel.id,
      rootThreadChannelId: created.threadChannelId,
    });

    // §3 FK hygiene (future-proofing): hard-deleting the comment message row
    // removes the ref by cascade. No such product operation exists today; this
    // locks the constructive property at the schema level.
    await fx.db.delete(messages).where(eq(messages.id, created.message.id));
    const refsAfter = await fx.db
      .select()
      .from(attachmentCommentRefs)
      .where(eq(attachmentCommentRefs.commentMessageId, created.message.id));
    assert.equal(refsAfter.length, 0, "ref row cascades with the message");
  } finally {
    await close();
  }
});

test("attachment comments: boundaries (unlinked 404, non-member 403, read-only A3 can read, archived 409)", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const readonlyToken = await tokenForHuman("ac-readonly@slock.test");
    const reviewerHeaders = authHeaders(reviewerToken, fx.server.id);
    const readonlyHeaders = authHeaders(readonlyToken, fx.server.id);

    // J12: unlinked attachment rejects comment creation. An object-bound
    // draft is not readable before its message exists (attachment authority),
    // so it answers 404 like any unreadable id; the 422 below that check was
    // only ever reached by object-less legacy rows (storage step 2b).
    const unlinkedRes = await fetch(`${baseUrl}/api/attachments/${fx.unlinked.id}/comments`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({ content: "too early" }),
    });
    assert.equal(unlinkedRes.status, 404);
    assert.deepEqual(await unlinkedRes.json(), { error: "Attachment not found" });

    // Seed one comment so read paths have content.
    const seedComment = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({ content: "needs fixing" }),
    });
    assert.equal(seedComment.status, 200);

    // C12 (actor A3): server member who never joined the channel can READ
    // comments (public-channel visibility) but cannot CREATE (403).
    const readRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, { headers: readonlyHeaders });
    assert.equal(readRes.status, 200, await readRes.clone().text());
    const readBody = (await readRes.json()) as { comments: unknown[] };
    assert.equal(readBody.comments.length, 1);

    const writeRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: readonlyHeaders,
      body: JSON.stringify({ content: "drive-by" }),
    });
    assert.equal(writeRes.status, 403);
    assert.equal(((await writeRes.json()) as { code: string }).code, "not_a_member");

    // Validation: empty content.
    const emptyRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({ content: "   " }),
    });
    assert.equal(emptyRes.status, 400);

    // Counts ids validation.
    const badCounts = await fetch(`${baseUrl}/api/attachments/comments/counts?ids=`, { headers: reviewerHeaders });
    assert.equal(badCounts.status, 400);

    // J11: archived channel blocks new comments with 409.
    await fx.db
      .update(channels)
      .set({ archivedAt: new Date() })
      .where(eq(channels.id, fx.channel.id));
    const archivedRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({ content: "after archive" }),
    });
    assert.equal(archivedRes.status, 409);
    assert.equal(((await archivedRes.json()) as { code: string }).code, "channel_archived");
  } finally {
    await close();
  }
});

test("attachment comments: GET viewer state and POST agree for writable channels", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const headers = authHeaders(reviewerToken, fx.server.id);

    // GET viewer state and POST behavior must agree. Current Free/Pro/Founder
    // limits do not impose a channel-count read-only window, so this fixture is
    // expected to remain writable.
    const listRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, { headers });
    assert.equal(listRes.status, 200);
    const { viewer } = (await listRes.json()) as { viewer: { canComment: boolean; reason: string } };
    assert.equal(viewer.canComment, true);

    const postRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "agreement probe" }),
    });
    assert.equal(postRes.status, 200, "viewer says writable, POST must succeed");
  } finally {
    await close();
  }
});

test("attachment comments: attachment hosted on a THREAD REPLY uses the existing thread (no thread-in-thread)", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const db = getDb();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const headers = authHeaders(reviewerToken, fx.server.id);

    // Build the case from spec v3.4: a thread exists on the parent message,
    // and a REPLY inside that thread carries its own attachment.
    const thread = await getOrCreateThread(fx.parentMessage.id, fx.owner.id, "user");
    const threadReply = await createMessage(thread.id, "user", fx.owner.id, "follow-up artifact", "chat");
    const [threadHosted] = await insertAttachmentsWithObjects(db, {
        id: "00000000-0000-4000-8000-00000000ac03",
        messageId: threadReply.id,
        channelId: thread.id,
        uploaderId: fx.owner.id,
        uploaderType: "user",
        filename: "fix-v2.html",
        mimeType: "text/html",
        sizeBytes: 10,
        storageKey: `${fx.server.id}/fix-v2.html`,
      });

    const createRes = await fetch(`${baseUrl}/api/attachments/${threadHosted.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "v2 这版排序对了" }),
    });
    assert.equal(createRes.status, 200, await createRes.clone().text());
    const created = (await createRes.json()) as {
      message: { id: string; channelId: string };
      threadChannelId: string;
    };
    // Review conversation = the EXISTING thread; no nested thread channel.
    assert.equal(created.threadChannelId, thread.id);
    assert.equal(created.message.channelId, thread.id);

    // Ref scopes to the thread-hosted attachment; counts/list see it.
    const refs = await db
      .select()
      .from(attachmentCommentRefs)
      .where(eq(attachmentCommentRefs.commentMessageId, created.message.id));
    assert.equal(refs.length, 1);
    assert.equal(refs[0].attachmentId, threadHosted.id);

    const listRes = await fetch(`${baseUrl}/api/attachments/${threadHosted.id}/comments`, { headers });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as { comments: Array<{ id: string }>; threadChannelId: string };
    assert.equal(list.comments.length, 1);
    assert.equal(list.comments[0].id, created.message.id);

    // Jump contract, thread-hosted case (the trap Dozy flagged): hostSource
    // must route by the PARENT channel + thread parent message — never the
    // raw thread channel id, which nav.toThreadMessage cannot route by.
    const threadMessages = (await (await fetch(
      `${baseUrl}/api/messages/channel/${thread.id}?limit=50`,
      { headers },
    )).json()) as { messages: Array<{ id: string; commentRef: { hostMessageId: string; hostSource: Record<string, unknown> } | null }> };
    const enriched = threadMessages.messages.find((m) => m.id === created.message.id);
    assert.ok(enriched, "comment message present in thread listing");
    assert.equal(enriched!.commentRef?.hostMessageId, threadReply.id);
    assert.deepEqual(enriched!.commentRef?.hostSource, {
      type: "thread",
      routeKind: "channel",
      channelId: fx.channel.id,
      parentMessageId: fx.parentMessage.id,
      threadChannelId: thread.id,
    });
  } finally {
    await close();
  }
});

test("attachment comments: cross-server attachment ids are indistinguishable from nonexistent (404, not 422)", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const db = getDb();
    const passwordHash = await argon2.hash("password123");

    // Server B with its own user, who will probe server A's attachment ids.
    const [userB] = await db
      .insert(users)
      .values({
        email: "ac-outsider@slock.test",
        name: "ac-outsider",
        displayName: "ac-outsider",
        passwordHash,
        emailVerified: true,
        profileSetupCompletedAt: new Date(),
      })
      .returning();
    const serverB = await createServer("AC Other", "ac-other", userB.id);
    const tokenB = await tokenForHuman("ac-outsider@slock.test");
    const headersB = authHeaders(tokenB, serverB.id);

    // Cross-server UNLINKED attachment must NOT leak its unlinked state as
    // 422 (regression for the access-order leak found in PR #2739 review).
    const unlinkedProbe = await fetch(`${baseUrl}/api/attachments/${fx.unlinked.id}/comments`, {
      method: "POST",
      headers: headersB,
      body: JSON.stringify({ content: "probe" }),
    });
    assert.equal(unlinkedProbe.status, 404, await unlinkedProbe.clone().text());

    // Cross-server LINKED attachment stays 404 as well.
    const linkedProbe = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: headersB,
      body: JSON.stringify({ content: "probe" }),
    });
    assert.equal(linkedProbe.status, 404);

    // A same-server member gets the same 404 for an object-bound draft (see
    // the J12 note in the boundaries case).
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const sameServer = await fetch(`${baseUrl}/api/attachments/${fx.unlinked.id}/comments`, {
      method: "POST",
      headers: authHeaders(reviewerToken, fx.server.id),
      body: JSON.stringify({ content: "draft at home" }),
    });
    assert.equal(sameServer.status, 404);
  } finally {
    await close();
  }
});

test("attachment comments: private-channel attachment create cloaks before body validation", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const db = getDb();
    const privateChannel = await createChannel(fx.server.id, "ac-private", "private reports", "private");
    await addHuman(privateChannel.id, fx.owner.id);
    const privateMessage = await createMessage(privateChannel.id, "user", fx.owner.id, "private report", "chat");
    const [privateAttachment] = await insertAttachmentsWithObjects(db, {
        id: "00000000-0000-4000-8000-00000000ac04",
        messageId: privateMessage.id,
        channelId: privateChannel.id,
        uploaderId: fx.owner.id,
        uploaderType: "user",
        filename: "private.html",
        mimeType: "text/html",
        sizeBytes: 10,
        storageKey: `${fx.server.id}/private.html`,
      });

    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const reviewerHeaders = authHeaders(reviewerToken, fx.server.id);

    const listRes = await fetch(`${baseUrl}/api/attachments/${privateAttachment.id}/comments`, { headers: reviewerHeaders });
    assert.equal(listRes.status, 404);

    const writeRes = await fetch(`${baseUrl}/api/attachments/${privateAttachment.id}/comments`, {
      method: "POST",
      headers: reviewerHeaders,
      body: JSON.stringify({
        content: "probe",
        mentions: "invalid-before-access-would-leak",
      }),
    });
    assert.equal(writeRes.status, 404, await writeRes.clone().text());
    assert.equal(((await writeRes.json()) as { error: string }).error, "Attachment not found");
  } finally {
    await close();
  }
});

test("attachment comments: structural anchors — closed vocabulary, payload cap, round-trip on list", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const headers = authHeaders(reviewerToken, fx.server.id);

    // Valid anchor round-trips: stored on the ref, returned by the list.
    // (Known fields only — the validator rebuilds the payload per type.)
    const anchor = {
      type: "md-section",
      data: { headingId: "activation", headingTitle: "Activation", quote: "D0≥35" },
    };
    const createRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "这一节口径对吗？", anchor }),
    });
    assert.equal(createRes.status, 200, await createRes.clone().text());
    const created = (await createRes.json()) as { message: { id: string } };

    const listRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, { headers });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as {
      comments: Array<{ id: string; anchor: { type: string; data: Record<string, unknown> } | null }>;
    };
    const mine = list.comments.find((c) => c.id === created.message.id);
    assert.ok(mine, "created comment appears in list");
    assert.deepEqual(mine!.anchor, anchor);

    // Anchorless comments stay valid and report anchor: null.
    const plainRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "no anchor here" }),
    });
    assert.equal(plainRes.status, 200);
    const plain = (await plainRes.json()) as { message: { id: string } };
    const listRes2 = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, { headers });
    const list2 = (await listRes2.json()) as { comments: Array<{ id: string; anchor: unknown }> };
    assert.equal(list2.comments.find((c) => c.id === plain.message.id)!.anchor, null);

    // Closed vocabulary: unknown type is rejected before any write.
    const badTypeRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "x", anchor: { type: "dom-xpath", data: {} } }),
    });
    assert.equal(badTypeRes.status, 400);
    assert.equal(((await badTypeRes.json()) as { code: string }).code, "anchor_type_invalid");

    // Malformed shape: data must be an object.
    const badShapeRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "x", anchor: { type: "lines", data: [1, 2] } }),
    });
    assert.equal(badShapeRes.status, 400);
    assert.equal(((await badShapeRes.json()) as { code: string }).code, "anchor_invalid");

    // Payload cap: anchors carry locations + a short quote, never content.
    const hugeRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "x",
        anchor: { type: "lines", data: { quote: "q".repeat(5000) } },
      }),
    });
    assert.equal(hugeRes.status, 400);
    assert.equal(((await hugeRes.json()) as { code: string }).code, "anchor_too_large");

    // Per-type shape contract (Dozy review on 3831678a): a KNOWN type with a
    // malformed payload must be rejected, not stored as a dead chip.
    for (const [label, anchor] of [
      ["md-section missing fields", { type: "md-section", data: {} }],
      ["md-section empty headingId", { type: "md-section", data: { headingId: "", headingTitle: "T" } }],
      ["lines missing range", { type: "lines", data: {} }],
      ["lines non-numeric range", { type: "lines", data: { start: "x", end: "y" } }],
      ["lines zero start", { type: "lines", data: { start: 0, end: 2 } }],
      ["lines inverted range", { type: "lines", data: { start: 5, end: 2 } }],
      ["csv-rows fractional", { type: "csv-rows", data: { start: 1.5, end: 2 } }],
      ["html-region missing fields", { type: "html-region", data: { x: 1, y: 2 } }],
      ["html-region negative", { type: "html-region", data: { x: -1, y: 0, w: 10, h: 10, viewportWidth: 800, documentWidth: 1000, documentHeight: 2000 } }],
      ["html-region non-finite", { type: "html-region", data: { x: 1, y: 2, w: 3, h: 4, viewportWidth: 800, documentWidth: 1000, documentHeight: "1e3" } }],
      ["html-region zero viewport", { type: "html-region", data: { x: 1, y: 2, w: 3, h: 4, viewportWidth: 0, documentWidth: 1000, documentHeight: 2000 } }],
    ] as const) {
      const res = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ content: "x", anchor }),
      });
      assert.equal(res.status, 400, label);
      assert.equal(((await res.json()) as { code: string }).code, "anchor_invalid", label);
    }

    // Stored payloads are rebuilt from known fields only — extras dropped.
    const paddedRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "padded anchor",
        anchor: { type: "lines", data: { start: 2, end: 4, quote: "q", extra: "DROP ME" } },
      }),
    });
    assert.equal(paddedRes.status, 200);
    const padded = (await paddedRes.json()) as { message: { id: string } };

    // html-region: bridge-sourced numbers are rounded/clamped and rebuilt —
    // floats round, extras drop, the rest round-trips.
    const regionRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: "region anchor",
        anchor: {
          type: "html-region",
          data: { x: 10.6, y: 20.2, w: 0, h: 0, viewportWidth: 1280, documentWidth: 1280, documentHeight: 4000.9, spoofed: true },
        },
      }),
    });
    assert.equal(regionRes.status, 200, await regionRes.clone().text());
    const region = (await regionRes.json()) as { message: { id: string } };

    // Rejected anchors must not have produced messages or refs: the scoped
    // list holds exactly the four successful comments, and the padded /
    // region anchors came back normalized.
    const finalList = (await (await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, { headers })).json()) as {
      comments: Array<{ id: string; anchor: { data: Record<string, unknown> } | null }>;
    };
    assert.equal(finalList.comments.length, 4, "failed anchor validations wrote nothing");
    assert.deepEqual(
      finalList.comments.find((c) => c.id === padded.message.id)!.anchor!.data,
      { start: 2, end: 4, quote: "q" },
    );
    assert.deepEqual(
      finalList.comments.find((c) => c.id === region.message.id)!.anchor!.data,
      { x: 11, y: 20, w: 0, h: 0, viewportWidth: 1280, documentWidth: 1280, documentHeight: 4001 },
    );
  } finally {
    await close();
  }
});

test("attachment comments: structured mentions ride the shared message pipeline", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    const fx = await seedFixture();
    const reviewerToken = await tokenForHuman("ac-reviewer@slock.test");
    const headers = authHeaders(reviewerToken, fx.server.id);

    // Valid picker-confirmed mention: persisted as a message_mentions row by
    // broadcastAndDeliver — the comment transport adds no parallel mention
    // machinery (task #20, composer inheritance).
    const res = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: `@${fx.owner.name} 看一下这节`,
        mentions: [{ type: "user", id: fx.owner.id, name: fx.owner.name }],
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const created = (await res.json()) as { message: { id: string } };
    const rows = await fx.db
      .select()
      .from(messageMentions)
      .where(eq(messageMentions.messageId, created.message.id));
    assert.equal(rows.length, 1, "mention persisted through the shared pipeline");

    // Invalid payload is rejected by the SAME wire parser as the messages
    // route — and writes nothing.
    const bad = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "x", mentions: [{ type: "user", id: "not-a-uuid", name: "x" }] }),
    });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { code: string }).code, "mentions_invalid");
  } finally {
    await close();
  }
});

test("attachment comments: agents receive complete scope quotation across live, history, and search (tasks #37/#158)", async ({ app }) => {

  const { baseUrl, close } = app;
  try {
    const db = getDb();
    const [owner] = await db.insert(users).values({
      email: "agent-scope-owner@slock.test",
      name: "agent-scope-owner",
      displayName: "Scope Owner",
      passwordHash: await fixturePasswordHash("password123"),
      emailVerified: true,
      profileSetupCompletedAt: new Date(),
    }).returning();
    const server = await createServer("Agent Scope Test", "botiverse", owner.id);
    const { createAgent } = await import("../services/agentService");
    const { addAgent } = await import("../services/channelService");
    const agent = await createAgent(server.id, "ScopeBot", { runtime: "claude", model: "sonnet" });
    const agentCredential = await mintAgentCredential({
      agentId: agent.id,
      scopes: ["read"],
      name: "scope-history-search",
      issuedVia: "computer",
      createdByUserId: null,
    });
    const channel = await createChannel(server.id, "scope-room", "channel");
    await addHuman(channel.id, owner.id);
    await addAgent(channel.id, agent.id);
    const parentMessage = await createMessage(channel.id, "user", owner.id, "artifact", "chat");
    const [attachment] = await insertAttachmentsWithObjects(db, {
      messageId: parentMessage.id,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename: "screen_text.html",
      mimeType: "text/html",
      sizeBytes: 10,
      storageKey: `${server.id}/screen_text.html`,
    });

    // Capture agent deliveries (harness stub pattern, see channels.api.test).
    const deliveries: Array<{ agentId: string; message: { content: string } }> = [];
    const agentOrchestrator = app.app.get("agentOrchestrator") as {
      deliverMessage: (agentId: string, message: { content: string }) => Promise<void>;
    };
    agentOrchestrator.deliverMessage = async (agentId, message) => {
      deliveries.push({ agentId, message });
    };

    const token = await tokenForHuman("agent-scope-owner@slock.test");
    const headers = authHeaders(token, server.id);

    // Thread delivery goes to thread FOLLOWERS (getThreadAgentFollowers) —
    // bootstrap the thread with a first comment, follow the agent, then
    // assert on the next comment's delivery (the huxijin scenario: Bernard
    // was already following the review thread).
    const bootstrap = await fetch(`${baseUrl}/api/attachments/${attachment.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "bootstrap thread" }),
    });
    assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
    const bootstrapped = (await bootstrap.json()) as { threadChannelId: string };
    const { recordThreadFollow } = await import("../services/channelService");
    await recordThreadFollow("agent", agent.id, bootstrapped.threadChannelId, parentMessage.id, "replied");

    // Anchored comment: the FIRST delivery to the agent must already carry
    // the scope line (the ref row is inserted only after broadcastAndDeliver
    // — the anchor is passed straight through, never read back).
    const firstQuoteLine = `complete-selection-${"q".repeat(120)}`;
    const fullQuote = `${firstQuoteLine}\r\nsecond paragraph\n\nfinal line`;
    const scopeLine = "[re: screen_text.html · § Rollout plan]";
    const quoteBlock = `> ${firstQuoteLine}\n> second paragraph\n>\n> final line`;
    const commentContent = "task158quote 太live了。全去了吧。";
    const expectedScopedContent = `${scopeLine}\n${quoteBlock}\n${commentContent}`;
    const res = await fetch(`${baseUrl}/api/attachments/${attachment.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        content: commentContent,
        anchor: {
          type: "md-section",
          data: { headingId: "rollout-plan", headingTitle: "Rollout plan", quote: fullQuote },
        },
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const created = (await res.json()) as { message: { id: string }; threadChannelId: string };

    const agentDelivery = deliveries.find(
      (d) => d.agentId === agent.id && d.message.content.includes("task158quote"),
    );
    assert.ok(agentDelivery, "agent in the channel receives the comment");
    assert.equal(
      agentDelivery!.message.content,
      expectedScopedContent,
      "live delivery carries the compact scope line and complete quotation",
    );

    // The HUMAN-facing stored message stays exactly what the user typed —
    // the scope line is an agent projection only.
    const [storedRow] = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.id, created.message.id));
    assert.equal(storedRow.content, commentContent);

    // History path: enrichment exposes the compact anchorLabel on commentRef
    // so thread context / clients can render the same scope.
    const listed = (await (await fetch(
      `${baseUrl}/api/messages/channel/${created.threadChannelId}?limit=50`,
      { headers },
    )).json()) as { messages: Array<{ id: string; content: string; commentRef: { filename: string; anchorLabel: string | null } | null }> };
    const enriched = listed.messages.find((m) => m.id === created.message.id);
    assert.ok(enriched?.commentRef, "commentRef enriched");
    assert.equal(
      enriched!.commentRef!.anchorLabel,
      `§ Rollout plan ·「${fullQuote.slice(0, 80)}…」`,
    );
    assert.equal(enriched!.content, commentContent, "human read path content untouched");

    // Unanchored comment still gets the filename-only scope line — the
    // attachment scope itself was what agents never saw (huxijin report).
    deliveries.length = 0;
    const res2 = await fetch(`${baseUrl}/api/attachments/${attachment.id}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: "其他都去掉" }),
    });
    assert.equal(res2.status, 200);
    const plain = deliveries.find((d) => d.agentId === agent.id && d.message.content.includes("其他都去掉"));
    assert.ok(plain, "unanchored comment delivered");
    assert.ok(
      plain!.message.content.startsWith("[re: screen_text.html]\n"),
      `filename-only scope line, got: ${plain!.message.content.slice(0, 60)}`,
    );

    // Agent history/search carry the same scope block as live delivery.
    const agentHeaders = { Authorization: `Bearer ${agentCredential.apiKey}` };
    const threadRef = `#scope-room:${parentMessage.id.slice(0, 8)}`;
    const historyRes = await fetch(
      `${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(threadRef)}&limit=50`,
      { headers: agentHeaders },
    );
    assert.equal(historyRes.status, 200, await historyRes.clone().text());
    const historyBody = await historyRes.json() as {
      messages: Array<{ id: string; content: string }>;
    };
    assert.equal(
      historyBody.messages.find((message) => message.id === created.message.id)?.content,
      expectedScopedContent,
      "history read carries the same two-line scope block as live delivery",
    );

    const searchParams = new URLSearchParams({ q: "task158quote", sort: "recent", limit: "10" });
    const searchRes = await fetch(`${baseUrl}/internal/agent-api/search?${searchParams}`, {
      headers: agentHeaders,
    });
    assert.equal(searchRes.status, 200, await searchRes.clone().text());
    const searchBody = await searchRes.json() as {
      results: Array<{ id: string; content: string }>;
    };
    assert.equal(
      searchBody.results.find((message) => message.id === created.message.id)?.content,
      expectedScopedContent,
      "search carries the same two-line scope block as live delivery",
    );
  } finally {
    await close();
  }
});
