// RFC 082 PR1: card messages on the agent API v2 send (`card`). Send only;
// the update route comes later.
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash } from "../test/integration/credentials";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { projectRaftMessages, type AgentApiMessageEnvelope, type AgentMessage, type MessageCardInput } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { channelAgents, channels, jointChannels, jointChannelServers, messageCardRevisions, messageMentions, messages, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { buildSearchText } from "../services/searchTokenizer";

const test = createApiTest();

type Fixture = {
  serverId: string;
  channelId: string;
  channelName: string;
  agentId: string;
  agentName: string;
  ownerId: string;
  ownerName: string;
  apiKey: string;
};

async function seedFixture(): Promise<Fixture> {
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `message-cards-${suffix}@slock.test`,
    name: `mcowner${suffix.slice(0, 8)}`,
    displayName: "Card Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  const server = await createServer("Message Cards Test", `message-cards-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, "HandsBot", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "builds");
  await addHuman(channel.id, owner!.id);
  await addAgent(channel.id, agent.id);
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "message-cards-test", issuedVia: "computer", createdByUserId: null });
  return {
    serverId: server.id, channelId: channel.id, channelName: channel.name, agentId: agent.id, agentName: agent.name,
    ownerId: owner!.id, ownerName: owner!.name, apiKey: minted.apiKey,
  };
}

async function sendV2(baseUrl: string, fixture: Fixture, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/internal/agent-api/v2/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

async function readHistory(baseUrl: string, fixture: Fixture, target = `#${fixture.channelName}`) {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(target)}&consume=false`, {
    headers: { Authorization: `Bearer ${fixture.apiKey}` },
  });
  assert.equal(res.status, 200);
  return await res.json() as { messages: AgentApiMessageEnvelope[] };
}

async function channelMessages(channelId: string) {
  return getDb().select().from(messages).where(eq(messages.channelId, channelId));
}

async function revisionsOf(messageId: string) {
  return getDb().select().from(messageCardRevisions).where(eq(messageCardRevisions.messageId, messageId));
}

const card: MessageCardInput = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["title", "state", "open"] },
    title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
    state: { type: "Badge", props: { text: "In review", tone: "review" } },
    open: { type: "Button", props: { label: "Open", action: { kind: "navigate", url: "https://appstoreconnect.apple.com/apps/1" } } },
  },
};
/** The card as markdown (RFC 082 §4.3): what agents read of it, and its fallback when the sender writes no content (§4.1). */
const cardText = "Raft App 1.19.0 (11900001)\n\n[In review]\n\n[Open](https://appstoreconnect.apple.com/apps/1)";

test("a valid card is stored with the sender's fallback and revision 1, and returned to readers", async ({ app }) => {
  const fixture = await seedFixture();
  const sent = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: "Raft App 1.19.0: in review", card });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.state, "sent");
  assert.deepEqual(sent.body.messageCard, { revision: 1 }, "the receipt says a card was stored");

  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  assert.equal(row!.content, "Raft App 1.19.0: in review");
  const metadata = row!.actionMetadata as { kind: string; revision: number; updatedAt: string; card: { elements: Record<string, { props: Record<string, unknown> }> } };
  assert.equal(metadata.kind, "message-card");
  assert.equal(metadata.revision, 1);
  assert.ok(!Number.isNaN(Date.parse(metadata.updatedAt)));
  // Stored as parsed: defaults filled in.
  assert.deepEqual(metadata.card.elements.title!.props, { text: "Raft App 1.19.0 (11900001)", tone: "default", mono: false });

  // Revision 1, written with the message.
  const revisions = await revisionsOf(row!.id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.revision, 1);
  assert.equal(revisions[0]!.content, "Raft App 1.19.0: in review");
  assert.equal(revisions[0]!.senderAgentId, fixture.agentId);
  assert.deepEqual(revisions[0]!.card, metadata.card);

  // Readers get the card on the message; agents read the fallback, the header marker and the card's own text.
  const history = await readHistory(app.baseUrl, fixture);
  const read = history.messages.find((message) => message.id === row!.id) as AgentApiMessageEnvelope & { actionMetadata?: { kind?: string } };
  assert.equal(read.content, "Raft App 1.19.0: in review");
  assert.equal(read.actionMetadata?.kind, "message-card");
  assert.deepEqual(read.message_card, { revision: 1, updated_at: metadata.updatedAt, text: cardText });
});

test("a Button's open (web_preview_v0) is stored as sent and read back; any other value refuses the send with card_invalid at its path", async ({ app }) => {
  const fixture = await seedFixture();
  const beside: MessageCardInput = {
    version: 1,
    header: { title: "Preview of the landing page" },
    root: "go",
    elements: { go: { type: "Button", props: { label: "Open preview", action: { kind: "navigate", url: "https://preview.example.com/" }, open: "beside" } } },
  };
  const sent = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: beside });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  const metadata = row!.actionMetadata as { card: { elements: Record<string, { props: Record<string, unknown> }> } };
  assert.equal(metadata.card.elements.go!.props.open, "beside");
  const history = await readHistory(app.baseUrl, fixture);
  const read = history.messages.find((message) => message.id === row!.id) as AgentApiMessageEnvelope & { actionMetadata?: { card?: { elements?: Record<string, { props?: Record<string, unknown> }> } } };
  assert.equal(read.actionMetadata?.card?.elements?.go?.props?.open, "beside", "readers get it as stored");

  const refused = await sendV2(app.baseUrl, fixture, {
    target: `#${fixture.channelName}`,
    content: "fallback",
    card: { ...beside, elements: { go: { type: "Button", props: { label: "Open preview", action: { kind: "navigate", url: "https://preview.example.com/" }, open: "window" } } } },
    idempotencyKey: "bad-open",
  });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.deepEqual([refused.body.code, refused.body.path, refused.body.limit], ["card_invalid", "card.elements.go.props.open", "prop"]);
  assert.equal((await channelMessages(fixture.channelId)).length, 1, "only the valid card was posted");
});

test("without content the derived fallback is stored as the content, searchable, and mentions no one", async ({ app }) => {
  const fixture = await seedFixture();
  const other = await createAgent(fixture.serverId, "Reviewer", { runtime: "claude", model: "sonnet" });
  await addAgent(fixture.channelId, other.id);
  const mentioning: MessageCardInput = {
    version: 1,
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["title", "who"] },
      title: { type: "Text", props: { text: "Deploy finished" } },
      who: { type: "Text", props: { text: `ping @${other.name} and @${fixture.ownerName}` } },
    },
  };
  const sent = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: mentioning, idempotencyKey: "derived-1" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(Object.hasOwn(sent.body, "unresolvedMentionHandles"), false);

  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  // The card as markdown: each @handle is code, so no reader takes it for a mention.
  const fallback = `Deploy finished\n\nping \`@${other.name}\` and \`@${fixture.ownerName}\``;
  assert.equal(row!.content, fallback, "the fallback a client without card support shows");
  assert.equal(row!.searchText, buildSearchText(fallback), "search indexes the fallback");
  assert.equal((await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, row!.id))).length, 0, "a derived fallback mentions no one");
  assert.equal((await revisionsOf(row!.id))[0]!.content, fallback);
});

test("a sender-written content still resolves its mentions", async ({ app }) => {
  const fixture = await seedFixture();
  const other = await createAgent(fixture.serverId, "Reviewer", { runtime: "claude", model: "sonnet" });
  await addAgent(fixture.channelId, other.id);
  const sent = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: `@${other.name} build is in review`, card });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const mentions = await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, sent.body.messageId));
  assert.deepEqual(mentions.map((mention) => mention.targetId), [other.id]);
});

test("each card bound refuses the send with card_invalid, its path and limit, and posts nothing", async ({ app }) => {
  const fixture = await seedFixture();
  const texts = (n: number, text = "x") => Object.fromEntries(Array.from({ length: n }, (_, i) => [`t${i}`, { type: "Text", props: { text } }]));
  const chain = (levels: number) => Object.fromEntries(Array.from({ length: levels }, (_, i) => [`s${i}`, i === levels - 1
    ? { type: "Text", props: { text: "leaf" } }
    : { type: "Stack", props: {}, children: [`s${i + 1}`] }]));
  const buttons = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, { type: "Button", props: { label: `B${i}`, action: { kind: "navigate", url: `https://example.com/${i}` } } }]));
  const cases: Array<[string, unknown, string, string]> = [
    ["elements", { version: 1, root: "root", elements: { root: { type: "Stack", props: {}, children: Object.keys(texts(12)) }, ...texts(16) } }, "card.elements", "elements"],
    ["depth", { version: 1, root: "s0", elements: chain(6) }, "card.elements.s5", "depth"],
    ["buttons", { version: 1, root: "root", elements: { root: { type: "Stack", props: {}, children: Object.keys(buttons(5)) }, ...buttons(5) } }, "card.elements.b4", "buttons"],
    ["size", { version: 1, root: "root", elements: { root: { type: "Stack", props: {}, children: Object.keys(texts(12)) }, ...texts(12, "\u{1F680}".repeat(200)) } }, "card", "size"],
    ["non-https URL", { version: 1, root: "go", elements: { go: { type: "Button", props: { label: "Go", action: { kind: "navigate", url: "http://example.com" } } } } }, "card.elements.go.props.action.url", "url"],
    ["unknown element", { version: 1, root: "root", elements: { root: { type: "Stack", props: {}, children: ["img"] }, img: { type: "Image", props: {} } } }, "card.elements.img.type", "element_type"],
  ];
  for (const [name, badCard, path, limit] of cases) {
    const refused = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: "fallback", card: badCard, idempotencyKey: `bad-${name}` });
    assert.equal(refused.status, 400, `${name}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "card_invalid", name);
    assert.equal(refused.body.path, path, name);
    assert.equal(refused.body.limit, limit, name);
    assert.match(refused.body.error, /fix it and run the same command again/, name);
    assert.equal(refused.body.suggestedNextAction, "fix it and run the same command again", name);
  }
  assert.equal((await channelMessages(fixture.channelId)).length, 0, "nothing was posted");

  // A card with nothing to derive a fallback from, and no content.
  const onlyButton = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: { version: 1, root: "go", elements: { go: { type: "Button", props: { label: "Go", action: { kind: "navigate", url: "https://example.com" } } } } } });
  assert.equal(onlyButton.status, 400);
  assert.deepEqual([onlyButton.body.code, onlyButton.body.limit], ["card_invalid", "fallback"]);
  // Structured mentions without a content to bind to: refused, not dropped.
  const mentionsOnly = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card, mentions: [{ type: "agent", id: fixture.agentId, name: fixture.agentName }] });
  assert.equal(mentionsOnly.status, 400);
  assert.equal(mentionsOnly.body.code, "message_card_mentions_without_content");
  assert.equal((await channelMessages(fixture.channelId)).length, 0, "nothing was posted");
});

test("a card message carries no files: a card with attachmentIds is refused in a channel, a DM and a thread, and nothing is posted", async ({ app }) => {
  const fixture = await seedFixture();
  const root = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: "Raft App 1.19.0 release" });
  assert.equal(root.status, 200, JSON.stringify(root.body));
  const targets = [
    `#${fixture.channelName}`,
    `dm:@${fixture.ownerName}`,
    `#${fixture.channelName}:${String(root.body.messageId).slice(0, 8)}`,
  ];
  const postedByAgent = async () => (await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.senderType, "agent"), eq(messages.senderId, fixture.agentId)))).length;
  // Whatever the ids are: an id never uploaded, one that is not an id at all, several.
  const attachmentIdSets = [[randomUUID()], ["not-an-attachment-id"], [randomUUID(), randomUUID()]];
  for (const [i, target] of targets.entries()) {
    const refused = await sendV2(app.baseUrl, fixture, { target, content: "Raft App 1.19.0: in review", card, attachmentIds: attachmentIdSets[i], idempotencyKey: `card-files-${i}` });
    assert.equal(refused.status, 400, `${target}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "message_card_with_attachments", target);
    assert.equal(refused.body.error, "A card message carries no files; nothing was posted. Send the card without attachmentIds, and send the files in a separate message.", target);
    assert.equal(refused.body.suggestedNextAction, "send the files in a separate message", target);
  }
  assert.equal(await postedByAgent(), 1, "nothing was posted: only the thread's root message");

  // Without the files the same card goes to each of them; an empty attachmentIds is no files.
  for (const target of targets) {
    const sent = await sendV2(app.baseUrl, fixture, { target, content: "Raft App 1.19.0: in review", card, attachmentIds: [] });
    assert.equal(sent.status, 200, `${target}: ${JSON.stringify(sent.body)}`);
  }
  assert.equal(await postedByAgent(), 1 + targets.length);
});

test("a joint channel takes a card message, stored once in canonical storage (v1.8; internalAgentApi.messageCardJoint.test.ts has the rest)", async ({ app }) => {
  const fixture = await seedFixture();
  const db = getDb();
  const host = await createServer("Card Joint Host", `card-joint-host-${randomUUID()}`, fixture.ownerId);
  const [canonical, hostLocal, local] = await db.insert(channels).values([
    { serverId: host.id, name: "card-joint-canonical", type: "joint" },
    { serverId: host.id, name: "card-joint-host", type: "joint" },
    { serverId: fixture.serverId, name: "card-joint-local", type: "joint" },
  ]).returning();
  const [joint] = await db.insert(jointChannels).values({ canonicalChannelId: canonical!.id, createdByServerId: host.id, createdByUserId: fixture.ownerId }).returning();
  await db.insert(jointChannelServers).values([
    { jointChannelId: joint!.id, serverId: host.id, localChannelId: hostLocal!.id, role: "host", status: "active", joinedByUserId: fixture.ownerId },
    { jointChannelId: joint!.id, serverId: fixture.serverId, localChannelId: local!.id, role: "participant", status: "active", joinedByUserId: fixture.ownerId },
  ]);
  await db.insert(channelAgents).values({ channelId: local!.id, agentId: fixture.agentId });

    const sent = await sendV2(app.baseUrl, fixture, { target: `#${local!.name}`, content: "build", card });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.messageCard, { revision: 1 });
  const [stored, ...others] = await channelMessages(canonical!.id);
  assert.equal(others.length, 0);
  assert.equal(stored!.id, sent.body.messageId);
  assert.equal((stored!.actionMetadata as { kind: string }).kind, "message-card");
  assert.equal((await revisionsOf(stored!.id)).length, 1);
  assert.equal((await channelMessages(local!.id)).length, 0, "no copy on the projection");
});

test("the same idempotencyKey returns the original message and makes one revision; another card under it is refused", async ({ app }) => {
  const fixture = await seedFixture();
  const body = { target: `#${fixture.channelName}`, content: "Raft App 1.19.0: in review", card, idempotencyKey: "testflight-11900001" };
  const first = await sendV2(app.baseUrl, fixture, body);
  const again = await sendV2(app.baseUrl, fixture, body);
  assert.equal(first.status, 200);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.messageId, first.body.messageId);
  assert.deepEqual(again.body.messageCard, { revision: 1 });
  assert.equal((await channelMessages(fixture.channelId)).length, 1);
  assert.equal((await revisionsOf(first.body.messageId)).length, 1);

  const otherCard: MessageCardInput = { ...card, elements: { ...card.elements, state: { type: "Badge", props: { text: "Ready for testing", tone: "done" } } } };
  const reused = await sendV2(app.baseUrl, fixture, { ...body, card: otherCard });
  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  assert.equal(reused.body.code, "idempotency_key_reused");
  assert.equal(reused.body.mismatch, "card");
  const withoutCard = await sendV2(app.baseUrl, fixture, { target: body.target, content: body.content, idempotencyKey: body.idempotencyKey });
  assert.equal(withoutCard.status, 409);
  assert.equal(withoutCard.body.mismatch, "card");
  assert.equal((await channelMessages(fixture.channelId)).length, 1);
});

test("a replay is compared on what the sender sent: a card stored with an older Server's derived fallback answers its key's retry", async ({ app }) => {
  const fixture = await seedFixture();
  const body = { target: `#${fixture.channelName}`, card, idempotencyKey: "testflight-deploy" };
  const first = await sendV2(app.baseUrl, fixture, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // As a Server before the markdown rendering stored it: the old " · " derivation of the same card.
  const older = "Raft App 1.19.0 (11900001) · In review";
  await getDb().update(messages).set({ content: older, searchText: buildSearchText(older) }).where(eq(messages.id, first.body.messageId));
  await getDb().update(messageCardRevisions).set({ content: older }).where(eq(messageCardRevisions.messageId, first.body.messageId));

  // The same card under the same key, no content: the original message, no conflict, nothing new.
  const again = await sendV2(app.baseUrl, fixture, body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.messageId, first.body.messageId);
  assert.deepEqual(again.body.messageCard, { revision: 1 });
  assert.equal((await channelMessages(fixture.channelId)).length, 1, "no new message");
  assert.equal((await revisionsOf(first.body.messageId)).length, 1);
  assert.equal((await channelMessages(fixture.channelId))[0]!.content, older, "nothing rewritten");

  // Content the sender writes is compared: another text under the key is another send.
  const written = await sendV2(app.baseUrl, fixture, { ...body, content: "Raft App 1.19.0: in review" });
  assert.equal(written.status, 409, JSON.stringify(written.body));
  assert.deepEqual([written.body.code, written.body.mismatch], ["idempotency_key_reused", "content"]);
  // And a sender-written send replays only with that same text.
  const textual = { target: body.target, card, content: "Raft App 1.19.0: in review", idempotencyKey: "testflight-written" };
  const sentWritten = await sendV2(app.baseUrl, fixture, textual);
  assert.equal(sentWritten.status, 200, JSON.stringify(sentWritten.body));
  assert.equal((await sendV2(app.baseUrl, fixture, textual)).body.messageId, sentWritten.body.messageId);
  const otherText = await sendV2(app.baseUrl, fixture, { ...textual, content: "Raft App 1.19.0: ready" });
  assert.deepEqual([otherText.status, otherText.body.mismatch], [409, "content"]);
  assert.equal((await channelMessages(fixture.channelId)).length, 2);
});

test("a reconciliation (reconcileOnly) of a committed card send says it carries a card, at its revision now; of a text send, nothing", async ({ app }) => {
  const fixture = await seedFixture();
  const target = `#${fixture.channelName}`;
  const sent = await sendV2(app.baseUrl, fixture, { target, card, idempotencyKey: "testflight-reconcile-card" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const reconciled = await sendV2(app.baseUrl, fixture, { target, idempotencyKey: "testflight-reconcile-card", reconcileOnly: true });
  assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
  assert.deepEqual(reconciled.body, {
    ok: true,
    state: "committed",
    messageId: sent.body.messageId,
    messageSeq: sent.body.messageSeq,
    reconciliation: true,
    receiptComplete: false,
    messageCard: { revision: 1 },
  });

  // After an update, the revision stored now.
  const updated = await fetch(`${app.baseUrl}/internal/agent-api/messages/${sent.body.messageId}/card`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${fixture.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ card: { ...card, elements: { ...card.elements, state: { type: "Badge", props: { text: "Ready for testing", tone: "done" } } } } }),
  });
  assert.equal(updated.status, 200, await updated.text());
  const afterUpdate = await sendV2(app.baseUrl, fixture, { target, idempotencyKey: "testflight-reconcile-card", reconcileOnly: true });
  assert.deepEqual(afterUpdate.body.messageCard, { revision: 2 });

  // A text message: no messageCard.
  const plain = await sendV2(app.baseUrl, fixture, { target, content: "just text", idempotencyKey: "testflight-reconcile-text" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  const plainReconciled = await sendV2(app.baseUrl, fixture, { target, idempotencyKey: "testflight-reconcile-text", reconcileOnly: true });
  assert.equal(plainReconciled.body.state, "committed");
  assert.equal(plainReconciled.body.messageId, plain.body.messageId);
  assert.equal(Object.hasOwn(plainReconciled.body, "messageCard"), false, "no card, no messageCard");
});

test("agents read card=r1 in the header of deliveries and reads, never in the body, and the card's own text under it", async ({ app }) => {
  const fixture = await seedFixture();
  const reader = await createAgent(fixture.serverId, "Watcher", { runtime: "claude", model: "sonnet" });
  await addAgent(fixture.channelId, reader.id);
  const delivered: Array<{ agentId: string; message: AgentMessage }> = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: AgentMessage) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId, message) => { delivered.push({ agentId, message }); };

  // No idempotency key: the direct persistence path writes the revision too.
  const sent = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal((await revisionsOf(sent.body.messageId)).length, 1);

  const delivery = delivered.find((entry) => entry.agentId === reader.id && entry.message.message_id === sent.body.messageId);
  assert.ok(delivery, "the card message reaches the other agent");
  assert.equal(delivery.message.message_card?.revision, 1);
  assert.equal(delivery.message.message_card?.text, cardText, "the card as markdown, generated from the stored card");
  assert.equal(delivery.message.content, cardText, "no content: the fallback is the same rendering");

  const history = await readHistory(app.baseUrl, fixture);
  const [line] = projectRaftMessages(history.messages.map((message) => ({ ...message, channel_type: "channel", channel_name: fixture.channelName })))
    .filter((message) => message.id === sent.body.messageId);
  assert.ok(line);
  assert.match(line.text, /^\[target=#builds msg=[0-9a-f]{8} time=\S+ \S+ type=agent card=r1\] @handsbot: Raft App 1\.19\.0 \(11900001\)\n  │ \n  │ \[In review\]/i);
  assert.equal(line.text.includes("\ncard:"), false, "a body that already is the card's text is not repeated");
  assert.equal(line.content.includes("card="), false);

  // A card sent before this rendering (its fallback the old " · " form) reads the same text: generated when served.
  const older = "Raft App 1.19.0 (11900001) · In review";
  await getDb().update(messages).set({ content: older }).where(eq(messages.id, sent.body.messageId));
  const reread = (await readHistory(app.baseUrl, fixture)).messages.find((message) => message.id === sent.body.messageId)!;
  assert.equal(reread.message_card?.text, cardText);
  const [olderLine] = projectRaftMessages([{ ...reread, channel_type: "channel", channel_name: fixture.channelName }]);
  assert.ok(olderLine!.text.endsWith(`· In review\ncard:\n  │ Raft App 1.19.0 (11900001)\n  │ \n  │ [In review]\n  │ \n  │ [Open](https://appstoreconnect.apple.com/apps/1)`), olderLine!.text);

  // An ordinary message carries no marker.
  const plain = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: "just text" });
  assert.equal(Object.hasOwn(plain.body, "messageCard"), false, "no card, no messageCard");
  const [plainRow] = await getDb().select({ id: messages.id }).from(messages).where(and(eq(messages.channelId, fixture.channelId), eq(messages.id, plain.body.messageId)));
  const plainRead = (await readHistory(app.baseUrl, fixture)).messages.find((message) => message.id === plainRow!.id);
  assert.equal(plainRead?.message_card, undefined);
  const plainDelivery = delivered.find((entry) => entry.agentId === reader.id && entry.message.message_id === plain.body.messageId);
  assert.ok(plainDelivery);
  assert.equal(plainDelivery.message.message_card, undefined, "no card, no text");
});

// ---------------------------------------------------------------------------
// RFC 082 v2.0 (§4.8): the card header and the Markdown, Fields and Divider
// elements. Every rule is in the shared tests and contract vectors
// (messageCard.test.ts, messageCard.vector.test.ts); these check the send.

const v2Card: MessageCardInput = {
  version: 1,
  header: {
    title: "Play rejected this submission: 1.20.0",
    subtitle: "Raft Android · Google Play · production",
    tags: [{ text: "Failed", tone: "danger" }, { text: "Policy", tone: "warning" }, { text: "Android", tone: "neutral" }],
  },
  root: "root",
  elements: {
    root: { type: "Stack", props: {}, children: ["facts", "rule", "notes"] },
    facts: { type: "Fields", props: { items: [{ label: "Version", value: "1.20.0 (12000003)", mono: true }, { label: "Track", value: "production" }] } },
    rule: { type: "Divider", props: {} },
    notes: { type: "Markdown", props: { content: "Google says the **target API level** is too low.\n\n- raise `targetSdk` to 35" } },
  },
};
/** v2Card as stored: the Stack's and Fields' defaults filled in. */
const v2Stored = {
  ...v2Card,
  elements: { ...v2Card.elements, root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["facts", "rule", "notes"] }, facts: { type: "Fields", props: { items: [{ label: "Version", value: "1.20.0 (12000003)", mono: true }, { label: "Track", value: "production", mono: false }] } } },
};
/** What agents read of v2Card, and its derived fallback: the header first, then the fields, the rule and the Markdown. */
const v2CardText = "**Play rejected this submission: 1.20.0**\n"
  + "Raft Android · Google Play · production\n"
  + "[Failed] [Policy] [Android]\n\n"
  + "**Version:** `1.20.0 (12000003)`\n**Track:** production\n\n"
  + "---\n\n"
  + "Google says the **target API level** is too low.\n\n- raise `targetSdk` to 35";

test("v2.0: a header, Markdown, Fields and a Divider are stored and read back as sent; the derived fallback and the agent text start with the header", async ({ app }) => {
  const fixture = await seedFixture();
  const sent = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: v2Card });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.messageCard, { revision: 1 });

  const [row] = await getDb().select().from(messages).where(eq(messages.id, sent.body.messageId));
  const metadata = row!.actionMetadata as { kind: string; revision: number; updatedAt: string; card: unknown };
  assert.equal(metadata.kind, "message-card");
  assert.deepEqual(metadata.card, v2Stored, "the card is stored as sent, defaults filled in, the header included");
  assert.equal(row!.content, v2CardText, "the derived fallback carries the header and the fields");
  assert.equal(row!.searchText, buildSearchText(v2CardText));
  assert.deepEqual((await revisionsOf(row!.id))[0]!.card, v2Stored);

  const history = await readHistory(app.baseUrl, fixture);
  const read = history.messages.find((message) => message.id === row!.id) as AgentApiMessageEnvelope & { actionMetadata?: { card?: unknown } };
  assert.deepEqual(read.actionMetadata?.card, v2Stored, "readers get the card back as stored");
  assert.equal(read.content, v2CardText);
  assert.deepEqual(read.message_card, { revision: 1, updated_at: metadata.updatedAt, text: v2CardText });
});

test("v2.0: an @name or #channel in Markdown notifies no one, whether the sender wrote content or not", async ({ app }) => {
  const fixture = await seedFixture();
  const other = await createAgent(fixture.serverId, "Reviewer", { runtime: "claude", model: "sonnet" });
  await addAgent(fixture.channelId, other.id);
  const pinging: MessageCardInput = {
    version: 1,
    header: { title: `Ask @${other.name}` },
    root: "notes",
    elements: { notes: { type: "Markdown", props: { content: `Ping **@${other.name}** and @${fixture.ownerName} in #${fixture.channelName}` } } },
  };
  const written = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: "Build failed", card: pinging, idempotencyKey: "md-written" });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  const derived = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: pinging, idempotencyKey: "md-derived" });
  assert.equal(derived.status, 200, JSON.stringify(derived.body));
  for (const messageId of [written.body.messageId, derived.body.messageId]) {
    assert.equal((await getDb().select().from(messageMentions).where(eq(messageMentions.messageId, messageId))).length, 0, "no mention from the card");
  }
  const [row] = await getDb().select().from(messages).where(eq(messages.id, derived.body.messageId));
  assert.equal(row!.content, `**Ask \`@${other.name}\`**\n\nPing **\`@${other.name}\`** and \`@${fixture.ownerName}\` in #${fixture.channelName}`);
});

test("v2.0: each new rule refuses the send with card_invalid, its path, its limit and (Markdown) the node, and posts nothing", async ({ app }) => {
  const fixture = await seedFixture();
  const text = { root: { type: "Text", props: { text: "x" } } };
  const markdown = (content: string) => ({ version: 1, root: "m", elements: { m: { type: "Markdown", props: { content } } } });
  const fields = (items: unknown) => ({ version: 1, root: "f", elements: { f: { type: "Fields", props: { items } } } });
  const cases: Array<[string, unknown, string, string, string?]> = [
    ["fourth tag", { version: 1, header: { title: "T", tags: ["a", "b", "c", "d"].map((tag) => ({ text: tag, tone: "info" })) }, root: "root", elements: text }, "card.header.tags[3]", "tags"],
    ["unknown tone", { version: 1, header: { title: "T", tags: [{ text: "a", tone: "pink" }] }, root: "root", elements: text }, "card.header.tags[0].tone", "prop"],
    ["header tone", { version: 1, header: { title: "T", tone: "danger" }, root: "root", elements: text }, "card.header", "prop"],
    ["long title", { version: 1, header: { title: "t".repeat(101) }, root: "root", elements: text }, "card.header.title", "text"],
    ["long label", fields([{ label: "l".repeat(41), value: "v" }]), "card.elements.f.props.items[0].label", "text"],
    ["long value", fields([{ label: "l", value: "v".repeat(201) }]), "card.elements.f.props.items[0].value", "text"],
    ["nine fields", fields(Array.from({ length: 9 }, (_, i) => ({ label: `L${i}`, value: "v" }))), "card.elements.f.props.items", "fields"],
    ["long markdown", markdown("m".repeat(2001)), "card.elements.m.props.content", "text"],
    ["heading", markdown("# Release notes"), "card.elements.m.props.content", "markdown", "heading"],
    ["image", markdown("![logo](https://example.com/logo.png)"), "card.elements.m.props.content", "markdown", "image"],
    ["table", markdown("| a | b |\n| - | - |\n| 1 | 2 |"), "card.elements.m.props.content", "markdown", "table"],
    ["horizontal rule", markdown("a\n\n---\n\nb"), "card.elements.m.props.content", "markdown", "thematicBreak"],
    ["inline HTML", markdown("x <b>y</b>"), "card.elements.m.props.content", "markdown", "html"],
    ["block HTML", markdown("<div>\nhi\n</div>"), "card.elements.m.props.content", "markdown", "html"],
    ["footnote", markdown("Text[^1]\n\n[^1]: note"), "card.elements.m.props.content", "markdown", "footnoteReference"],
    ["reference link", markdown("[docs][1]\n\n[1]: https://example.com"), "card.elements.m.props.content", "markdown", "linkReference"],
    ["math", markdown("Area is $x^2$."), "card.elements.m.props.content", "markdown", "inlineMath"],
    ["javascript link", markdown("[x](javascript:alert(1))"), "card.elements.m.props.content", "markdown", "link"],
    ["tel link", markdown("[call](tel:+15551234567)"), "card.elements.m.props.content", "markdown", "link"],
    ["nested 4 deep", markdown("- a\n  - b\n    - c\n      - d"), "card.elements.m.props.content", "markdown", "list"],
  ];
  for (const [name, badCard, path, limit, node] of cases) {
    const refused = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, content: "fallback", card: badCard, idempotencyKey: `v2-bad-${name}` });
    assert.equal(refused.status, 400, `${name}: ${JSON.stringify(refused.body)}`);
    assert.deepEqual(
      { code: refused.body.code, path: refused.body.path, limit: refused.body.limit, node: refused.body.node },
      { code: "card_invalid", path, limit, node },
      name,
    );
    assert.match(refused.body.error, /fix it and run the same command again/, name);
  }
  assert.equal((await channelMessages(fixture.channelId)).length, 0, "nothing was posted");
  // Nothing to derive a fallback from: a Divider and a Button.
  const ruleOnly = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: { version: 1, root: "root", elements: {
    root: { type: "Stack", props: {}, children: ["rule", "go"] }, rule: { type: "Divider", props: {} },
    go: { type: "Button", props: { label: "Go", action: { kind: "navigate", url: "https://example.com" } } },
  } } });
  assert.deepEqual([ruleOnly.status, ruleOnly.body.code, ruleOnly.body.limit], [400, "card_invalid", "fallback"]);
  assert.equal((await channelMessages(fixture.channelId)).length, 0, "nothing was posted");
  // A message's link schemes are a card's too: an email address and a mailto: link go through.
  const mail = await sendV2(app.baseUrl, fixture, { target: `#${fixture.channelName}`, card: markdown("mail ci@example.com or [Lagoon](mailto:lagoon@example.com)") });
  assert.equal(mail.status, 200, JSON.stringify(mail.body));
});

