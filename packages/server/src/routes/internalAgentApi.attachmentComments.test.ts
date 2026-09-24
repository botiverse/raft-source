import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { attachmentCommentRefs, attachments, messageReactions, users } from "../db/schema.js";
import { openTestApp } from "../test/integration/app.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import { createChannel, addAgent, addHuman } from "../services/channelService.js";
import { createMessage } from "../services/messageService.js";
import { mintAgentCredential } from "../services/agentCredentialService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

/**
 * Agent transport for attachment comments (attachment-comments MVP, PR3 /
 * task #5; READ-ONLY since spec v3.5 / task #17): agents list scoped
 * comments but cannot create them — the descope is gated in
 * attachmentCommentService (senderType === "agent"), so it dominates every
 * transport and every downstream state rule.
 */

function agentHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function seedFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `agent-ac-${suffix}@slock.test`,
    name: `agent-ac-${suffix}`,
    displayName: "AC Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();

  // Slug "botiverse": used as a fixture slug for attachment comment tests.
  const server = await createServer("Agent AC Test", "botiverse", owner.id);
  const agent = await createAgent(server.id, "AcCommentBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "agent-ac-room");
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);

  const parentMessage = await createMessage(channel.id, "user", owner.id, "daily artifact", "chat");

  const mkAttachment = async (filename: string, messageId: string | null) => {
    const [row] = await db.insert(attachments).values({
      messageId,
      channelId: channel.id,
      uploaderId: owner.id,
      uploaderType: "user",
      filename,
      mimeType: "text/html",
      sizeBytes: 10,
      storageKey: `${server.id}/${filename}`,
    }).returning();
    return row;
  };

  const linked = await mkAttachment("report.html", parentMessage.id);
  const unlinked = await mkAttachment("draft.html", null);

  const fullKey = await mintAgentCredential({
    agentId: agent.id,
    scopes: ["send", "read"],
    name: "ac-full",
    createdByUserId: null,
  });

  // Send-only credential (no "read") for the list-capability gate.
  const sendOnlyAgent = await createAgent(server.id, "AcSendOnlyBot", { runtime: "claude", model: "sonnet" });
  await addAgent(channel.id, sendOnlyAgent.id);
  const sendOnlyKey = await mintAgentCredential({
    agentId: sendOnlyAgent.id,
    scopes: ["send"],
    name: "ac-send-only",
    createdByUserId: null,
  });

  return {
    db,
    owner,
    ownerEmail: `agent-ac-${suffix}@slock.test`,
    server,
    agent,
    channel,
    parentMessage,
    linked,
    unlinked,
    fullKey: fullKey.apiKey,
    sendOnlyKey: sendOnlyKey.apiKey,
  };
}

async function loginUser(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login for ${email} expected 200`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

test("agent-api attachment comments: agent create is descoped (403, nothing written); scoped reads stay first-class", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const fx = await seedFixture();

    // Agent create → 403 with the stable descope code, regardless of payload.
    const createRes = await fetch(`${baseUrl}/internal/agent-api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: agentHeaders(fx.fullKey),
      body: JSON.stringify({ content: "排序还有问题 > 发言明细表" }),
    });
    assert.equal(createRes.status, 403, await createRes.clone().text());
    assert.equal(((await createRes.json()) as { code: string }).code, "agent_comment_create_disabled");

    // The rejection wrote nothing: no refs for this attachment yet.
    const refs = await fx.db
      .select()
      .from(attachmentCommentRefs)
      .where(eq(attachmentCommentRefs.attachmentId, fx.linked.id));
    assert.equal(refs.length, 0, "descoped create must not write a ref");

    // A HUMAN comments through the user route (the only create path now),
    // with a structural anchor.
    const token = await loginUser(baseUrl, fx.ownerEmail);
    const humanRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Server-Id": fx.server.id,
      },
      body: JSON.stringify({
        content: "L3 的口径修一下",
        anchor: { type: "lines", data: { start: 3, end: 3, quote: "口径" } },
      }),
    });
    assert.equal(humanRes.status, 200, await humanRes.clone().text());
    const created = (await humanRes.json()) as { message: { id: string } };

    // Agent list: comment readable, anchor included, and the viewer block
    // names the descope so clients render no false write affordances.
    const listRes = await fetch(`${baseUrl}/internal/agent-api/attachments/${fx.linked.id}/comments`, {
      headers: agentHeaders(fx.fullKey),
    });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as {
      comments: Array<{
        id: string; senderType: string; anchor: { type: string } | null;
        resolved: boolean; resolvedBy: { reactorId: string; reactorType: string } | null; resolvedAt: string | null;
      }>;
      viewer: { canComment: boolean; reason: string; canResolve: boolean; resolveAction?: { type: string; emoji: string } };
    };
    assert.equal(list.comments.length, 1);
    assert.equal(list.comments[0].id, created.message.id);
    assert.equal(list.comments[0].senderType, "user");
    assert.equal(list.comments[0].anchor?.type, "lines");
    assert.equal(list.comments[0].resolved, false, "comment without ✅ defaults to unresolved");
    assert.equal(list.comments[0].resolvedBy, null);
    assert.equal(list.comments[0].resolvedAt, null);
    assert.equal(list.viewer.canComment, false);
    assert.equal(list.viewer.reason, "agent_descoped");
    assert.equal(list.viewer.canResolve, false, "agent is NOT the parent-message author → canResolve false");
    assert.equal("resolveAction" in list.viewer, false, "no resolveAction when canResolve is false");
  } finally {
    await close();
  }
});

test("agent-api attachment comments: descope dominates state rules; read capability still gates the list", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const fx = await seedFixture();

    // The descope fires before unlinked/empty/length state checks — agents
    // get ONE stable answer, not a state-dependent mix.
    for (const [label, attachmentId, body] of [
      ["unlinked attachment", fx.unlinked.id, { content: "too early" }],
      ["empty content", fx.linked.id, { content: "  " }],
      ["oversized content", fx.linked.id, { content: "x".repeat(32_001) }],
    ] as const) {
      const res = await fetch(`${baseUrl}/internal/agent-api/attachments/${attachmentId}/comments`, {
        method: "POST",
        headers: agentHeaders(fx.fullKey),
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 403, `${label}: descope gate should answer first`);
      assert.equal(((await res.json()) as { code: string }).code, "agent_comment_create_disabled", label);
    }

    // Missing "read" capability → cannot list (auth layer, unchanged).
    const noRead = await fetch(`${baseUrl}/internal/agent-api/attachments/${fx.linked.id}/comments`, {
      headers: agentHeaders(fx.sendOnlyKey),
    });
    assert.equal(noRead.status, 403);
    assert.equal(((await noRead.json()) as { code: string }).code, "capability_not_authorized");

    const malformedList = await fetch(`${baseUrl}/internal/agent-api/attachments/e66f3b51/comments`, {
      headers: agentHeaders(fx.fullKey),
    });
    assert.equal(malformedList.status, 404);
    assert.equal(((await malformedList.json()) as { error?: string }).error, "Attachment not found");

    const malformedCreate = await fetch(`${baseUrl}/internal/agent-api/attachments/e66f3b51/comments`, {
      method: "POST",
      headers: agentHeaders(fx.fullKey),
      body: JSON.stringify({ content: "should not hit attachment lookup" }),
    });
    assert.equal(malformedCreate.status, 404);
    assert.equal(((await malformedCreate.json()) as { error?: string }).error, "Attachment not found");
  } finally {
    await close();
  }
});

test("agent-api attachment comments: ✅ from valid resolver marks comment resolved", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const fx = await seedFixture();
    const db = fx.db;
    const token = await loginUser(baseUrl, fx.ownerEmail);

    // Human creates a comment on the linked attachment.
    const commentRes = await fetch(`${baseUrl}/api/attachments/${fx.linked.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": fx.server.id },
      body: JSON.stringify({ content: "第三行有问题" }),
    });
    assert.equal(commentRes.status, 200);
    const commentMsg = ((await commentRes.json()) as { message: { id: string } }).message;

    // Before ✅: comment is unresolved.
    const listBefore = await fetch(`${baseUrl}/internal/agent-api/attachments/${fx.linked.id}/comments`, {
      headers: agentHeaders(fx.fullKey),
    });
    const before = (await listBefore.json()) as { comments: Array<{ resolved: boolean; resolvedBy: unknown; resolvedAt: unknown }> };
    assert.equal(before.comments[0].resolved, false);

    // Parent-message author (owner) reacts ✅ — satisfies §5 rule.
    await db.insert(messageReactions).values({
      messageId: commentMsg.id,
      reactorType: "user",
      reactorId: fx.owner.id,
      emoji: "✅",
    });

    const listAfter = await fetch(`${baseUrl}/internal/agent-api/attachments/${fx.linked.id}/comments`, {
      headers: agentHeaders(fx.fullKey),
    });
    const after = (await listAfter.json()) as {
      comments: Array<{ resolved: boolean; resolvedBy: { reactorId: string; reactorType: string } | null; resolvedAt: string | null }>;
    };
    assert.equal(after.comments[0].resolved, true, "✅ from parent-message author resolves the comment");
    assert.deepEqual(after.comments[0].resolvedBy, { reactorId: fx.owner.id, reactorType: "user" });
    assert.ok(after.comments[0].resolvedAt, "resolvedAt is set");
  } finally {
    await close();
  }
});

test("agent-api attachment comments: viewer.canResolve + resolveAction present only when agent is parent-message author", async () => {
  const { baseUrl, close } = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });
  try {
    const fx = await seedFixture();
    const db = fx.db;

    // Create a message where the AGENT is the sender (simulates agent-authored artifact).
    const agentMessage = await createMessage(fx.channel.id, "agent", fx.agent.id, "agent artifact", "chat");

    // Attach a file to the agent's message.
    const [agentAttachment] = await db.insert(attachments).values({
      messageId: agentMessage.id,
      channelId: fx.channel.id,
      uploaderId: fx.agent.id,
      uploaderType: "agent",
      filename: "agent-report.html",
      mimeType: "text/html",
      sizeBytes: 10,
      storageKey: `${fx.server.id}/agent-report.html`,
    }).returning();

    // Human comments on the agent's attachment.
    const token = await loginUser(baseUrl, fx.ownerEmail);
    const commentRes = await fetch(`${baseUrl}/api/attachments/${agentAttachment.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Server-Id": fx.server.id },
      body: JSON.stringify({ content: "请检查一下" }),
    });
    assert.equal(commentRes.status, 200);

    // Agent lists comments — it IS the parent-message author, so canResolve should be true.
    const listRes = await fetch(`${baseUrl}/internal/agent-api/attachments/${agentAttachment.id}/comments`, {
      headers: agentHeaders(fx.fullKey),
    });
    assert.equal(listRes.status, 200);
    const list = (await listRes.json()) as {
      viewer: { canComment: boolean; canResolve: boolean; resolveAction?: { type: string; emoji: string } };
    };
    assert.equal(list.viewer.canResolve, true, "agent is parent-message author → canResolve");
    assert.deepEqual(list.viewer.resolveAction, { type: "reaction", emoji: "✅" }, "resolveAction tells agent how to resolve");
  } finally {
    await close();
  }
});
