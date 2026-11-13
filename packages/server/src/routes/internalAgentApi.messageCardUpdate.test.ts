// RFC 082 PR2: the sender updates its card message (PUT
// /internal/agent-api/messages/:messageId/card), notifying no one; the
// `message` change row and its sync rebuild; the revisions read and their
// retention; the Slack mirror of a card message.
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { parseMessageCard, type MessageCardInput, type SyncChangesResponse } from "@botiverse/raft-shared";
import { vi } from "vitest";

import { getDb } from "../db/index";
import {
  appBotBindings,
  inboxNotificationFacts,
  messageCardRevisions,
  messageMentions,
  messages,
  notificationOutbox,
  oauthAccessTokens,
  oauthClientInstalls,
  users,
} from "../db/schema";
import { addMember, createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { addAgent, addHuman, createChannel } from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createOAuthClient } from "../services/oauthService";
import { buildSearchText } from "../services/searchTokenizer";
import { mutateMessageReaction } from "../services/messageReactionService";
import { __setMessageCardUpdateLimitsForTests, applyMessageCardUpdate, pruneMessageCardRevisions } from "../services/messageCardService";
import {
  __resetOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setOrdinaryMessageOutboundAuthorizationResolverForTests,
  __setSlackBridgeReconciliationMarkerMinterForTests,
  mintSlackBridgeReconciliationMarker,
} from "../services/externalDeliveryOutboxService";

const test = createApiTest();

type Human = typeof users.$inferSelect;

async function seedHuman(label: string): Promise<Human> {
  const suffix = randomUUID().slice(0, 8);
  const [human] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return human!;
}

async function credentialFor(agentId: string): Promise<string> {
  return (await mintAgentCredential({ agentId, scopes: ["send", "read"], name: "message-card-update-test", issuedVia: "computer", createdByUserId: null })).apiKey;
}

/** A Server with the flag on, #builds (public; or private), its owner and HandsBot in it, Reviewer (agent) in it too, and a member outside it. */
async function seedFixture(options: { visibility?: "channel" | "private" } = {}) {
  const owner = await seedHuman("owner");
  const outsider = await seedHuman("outsider");
  const server = await createServer("Card Update Test", `card-update-${randomUUID().slice(0, 8)}`, owner.id);
  await addMember(server.id, outsider.id);
  const agent = await createAgent(server.id, "HandsBot", { runtime: "claude", model: "sonnet" });
  const reviewer = await createAgent(server.id, "Reviewer", { runtime: "claude", model: "sonnet" });
  const channel = await createChannel(server.id, "builds", undefined, options.visibility);
  await addHuman(channel.id, owner.id);
  await addAgent(channel.id, agent.id);
  await addAgent(channel.id, reviewer.id);
  return { owner, outsider, server, agent, reviewer, channel, apiKey: await credentialFor(agent.id), reviewerKey: await credentialFor(reviewer.id) };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function call(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, headers: res.headers, body: await res.json() as any };
}

const sendV2 = (baseUrl: string, apiKey: string, body: Record<string, unknown>) => call(baseUrl, apiKey, "POST", "/v2/send", body);
const updateCard = (baseUrl: string, apiKey: string, messageId: string, body: Record<string, unknown>) =>
  call(baseUrl, apiKey, "PUT", `/messages/${encodeURIComponent(messageId)}/card`, body);

function buildCard(state: string, extra?: string): MessageCardInput {
  return {
    version: 1,
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: extra ? ["title", "state", "note"] : ["title", "state"] },
      title: { type: "Text", props: { text: "Raft App 1.19.0 (11900001)" } },
      state: { type: "Badge", props: { text: state } },
      ...(extra ? { note: { type: "Text", props: { text: extra } } } : {}),
    },
  };
}

/** The fallback Raft derives from buildCard when the sender writes no content (RFC 082 §4.1: the card as markdown). */
function fallbackOf(state: string): string {
  return `Raft App 1.19.0 (11900001)\n\n[${state}]`;
}

async function sendCard(baseUrl: string, fixture: Fixture, target = `#${fixture.channel.name}`) {
  const sent = await sendV2(baseUrl, fixture.apiKey, { target, card: buildCard("In review") });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  return sent.body.messageId as string;
}

async function messageRow(id: string) {
  const [row] = await getDb().select().from(messages).where(eq(messages.id, id));
  return row!;
}

async function revisionsOf(messageId: string) {
  return getDb().select().from(messageCardRevisions).where(eq(messageCardRevisions.messageId, messageId)).orderBy(messageCardRevisions.revision);
}

async function messageChangeRows(messageId: string) {
  const result = await getDb().execute(sql`
    SELECT scope_kind, scope_id::text AS scope_id, parent_id::text AS parent_id, server_id::text AS server_id, entity, entity_id, op
    FROM public.change_log WHERE entity = 'message' AND entity_id = ${messageId} ORDER BY seq`);
  return result.rows as Array<{ scope_kind: string; scope_id: string; parent_id: string | null; server_id: string; entity: string; entity_id: string; op: string }>;
}

function recordingIo() {
  const emits: Array<{ room: string; event: string; payload: any }> = [];
  return { emits, io: { to: (room: string) => ({ emit: (event: string, payload: unknown) => { emits.push({ room, event, payload }); } }) } };
}

const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";

test("the sender replaces the card: revision 2, the new fallback indexed, message:updated to the conversation, nobody told", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const { emits, io } = recordingIo();
  app.app.set("io", io);

  const updated = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Ready for testing") });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.ok, true);
  assert.equal(updated.body.messageId, messageId);
  assert.equal(updated.body.revision, 2);
  assert.deepEqual(updated.body.unnotifiedMentionHandles, []);
  assert.equal(updated.body.notice, "Updating notifies no one. To tell someone, send a new message.");

  const row = await messageRow(messageId);
  const fallback = fallbackOf("Ready for testing");
  assert.equal(row.content, fallback);
  assert.equal(row.searchText, buildSearchText(fallback), "search indexes the new fallback");
  const metadata = row.actionMetadata as { kind: string; revision: number; updatedAt: string; card: { elements: Record<string, { props: { text?: string } }> } };
  assert.equal(metadata.kind, "message-card");
  assert.equal(metadata.revision, 2);
  assert.equal(metadata.updatedAt, updated.body.updatedAt);
  assert.equal(metadata.card.elements.state!.props.text, "Ready for testing");

  const revisions = await revisionsOf(messageId);
  assert.deepEqual(revisions.map((revision) => [revision.revision, revision.content, revision.senderAgentId]), [
    [1, fallbackOf("In review"), fixture.agent.id],
    [2, fallback, fixture.agent.id],
  ]);

  const update = emits.find((emit) => emit.event === "message:updated" && emit.room === `channel:${fixture.channel.id}`);
  assert.ok(update, "message:updated reaches the conversation");
  assert.equal(update.payload.id, messageId);
  assert.equal(update.payload.content, fallback);
  assert.equal(update.payload.actionMetadata.revision, 2);

  // Agents read the new fallback, `card=r2 updated=…` in the header, and the new card's text.
  const history = await call(app.baseUrl, fixture.reviewerKey, "GET", `/history?channel=${encodeURIComponent(`#${fixture.channel.name}`)}&consume=false`);
  const read = history.body.messages.find((message: { id: string }) => message.id === messageId);
  assert.equal(read.content, fallback);
  assert.deepEqual(read.message_card, { revision: 2, updated_at: updated.body.updatedAt, text: fallback });

  // A short id names the same message.
  const again = await updateCard(app.baseUrl, fixture.apiKey, messageId.slice(0, 8), { card: buildCard("Testing") });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.revision, 3);
});

test("anyone else, and older than 14 days, deleted, retracted, not a card, unknown: one identical 404", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const body = { card: buildCard("Ready for testing") };
  const unknown = await updateCard(app.baseUrl, fixture.apiKey, UNKNOWN_ID, body);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "message_card_not_found");
  assert.match(unknown.body.error, /you sent in the last 14 days/);
  assert.match(unknown.body.error, /deleted or retracted/);
  assert.match(unknown.body.error, /send a new message/);
  const same = (label: string, refused: { status: number; body: unknown }) => {
    assert.equal(refused.status, 404, label);
    assert.deepEqual(refused.body, unknown.body, `${label}: the unknown message's answer`);
  };

  same("malformed id", await updateCard(app.baseUrl, fixture.apiKey, "not-a-message", body));
  same("another agent in the conversation", await updateCard(app.baseUrl, fixture.reviewerKey, messageId, body));
  // An agent of another Server.
  const elsewhere = await createServer("Elsewhere", `elsewhere-${randomUUID().slice(0, 8)}`, fixture.owner.id);
  const stranger = await createAgent(elsewhere.id, "Stranger", { runtime: "claude", model: "sonnet" });
  same("an agent of another Server", await updateCard(app.baseUrl, await credentialFor(stranger.id), messageId, body));

  // The sender's text message is not a card message.
  const plain = await sendV2(app.baseUrl, fixture.apiKey, { target: `#${fixture.channel.name}`, content: "plain text" });
  same("not a card message", await updateCard(app.baseUrl, fixture.apiKey, plain.body.messageId, body));

  const db = getDb();
  const old = await sendCard(app.baseUrl, fixture);
  await db.update(messages).set({ createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000) }).where(eq(messages.id, old));
  same("older than 14 days", await updateCard(app.baseUrl, fixture.apiKey, old, body));
  const deleted = await sendCard(app.baseUrl, fixture);
  await db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, deleted));
  same("deleted", await updateCard(app.baseUrl, fixture.apiKey, deleted, body));
  // RFC 077's retraction: the content replaced and deleted_at set.
  const retracted = await sendCard(app.baseUrl, fixture);
  await db.update(messages).set({ content: "This message was retracted.", searchText: "", deletedAt: new Date() }).where(eq(messages.id, retracted));
  same("retracted", await updateCard(app.baseUrl, fixture.apiKey, retracted, body));

  // Nothing changed anywhere.
  assert.equal((await messageRow(messageId)).content, fallbackOf("In review"));
  for (const id of [messageId, old, deleted, retracted]) assert.equal((await revisionsOf(id)).length, 1, id);
});

test("a human token, and an App bot whose grant was revoked, are refused before the message is looked up", async ({ app }) => {
  // The App's bot on an installing Server (appDeleteRevokesBots.api.test.ts's fixture), in #builds there.
  const short = randomUUID().slice(0, 8);
  const sourceOwner = await seedHuman("source-owner");
  const installerOwner = await seedHuman("installer-owner");
  const source = await createServer("App Source", `app-source-${short}`, sourceOwner.id);
  const installer = await createServer("App Installer", `app-installer-${short}`, installerOwner.id);
  const { client, clientSecret } = await createOAuthClient({ serverId: source.id, createdByUserId: sourceOwner.id, clientId: `card-bot-app-${short}`, name: "Card Bot App", enableBot: true });
  const [install] = await getDb().insert(oauthClientInstalls).values({ serverId: installer.id, clientId: client.id, installedByUserId: installerOwner.id, status: "active", botGrant: "pending" }).returning();
  const installerToken = await tokenForHuman(installerOwner.email);
  const grant = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/install/bot`, {
    method: "POST",
    headers: { Authorization: `Bearer ${installerToken}`, "X-Server-Id": installer.id, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "grant" }),
  });
  assert.equal(grant.status, 200, await grant.clone().text());
  const { bot } = await grant.json() as { bot: { agentId: string } };
  const minted = await fetch(`${app.baseUrl}/api/oauth/installations/${install!.id}/bot-token`, {
    method: "POST",
    headers: { Authorization: `Basic ${Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64")}`, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(minted.status, 200, await minted.clone().text());
  const { apiKey: botKey } = await minted.json() as { apiKey: string };
  const channel = await createChannel(installer.id, "builds");
  await addHuman(channel.id, installerOwner.id);
  await addAgent(channel.id, bot.agentId);

  const sent = await sendV2(app.baseUrl, botKey, { target: "#builds", card: buildCard("In review") });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const messageId = sent.body.messageId as string;
  const body = { card: buildCard("Ready for testing") };
  // Live: the App's bot updates its own card.
  assert.equal((await updateCard(app.baseUrl, botKey, messageId, body)).status, 200);

  // A person's session token is not an agent credential.
  const human = await updateCard(app.baseUrl, installerToken, messageId, body);
  assert.equal(human.status, 401);
  const humanUnknown = await updateCard(app.baseUrl, installerToken, UNKNOWN_ID, body);
  assert.deepEqual([humanUnknown.status, humanUnknown.body], [human.status, human.body], "the same refusal for an unknown id");

  // The installation's bot grant revoked: the bot's key is refused at auth, whatever the message.
  await getDb().update(oauthClientInstalls).set({ botGrant: "revoked" }).where(eq(oauthClientInstalls.id, install!.id));
  const revoked = await updateCard(app.baseUrl, botKey, messageId, body);
  assert.equal(revoked.status, 401);
  assert.deepEqual(revoked.body, { error: "App bot binding not active" });
  assert.deepEqual((await updateCard(app.baseUrl, botKey, UNKNOWN_ID, body)).body, revoked.body);
  // The binding itself revoked, the grant live again: refused the same way.
  await getDb().update(oauthClientInstalls).set({ botGrant: "granted" }).where(eq(oauthClientInstalls.id, install!.id));
  await getDb().update(appBotBindings).set({ state: "disabled" }).where(eq(appBotBindings.agentId, bot.agentId));
  const unbound = await updateCard(app.baseUrl, botKey, messageId, body);
  assert.equal(unbound.status, 401);
  assert.deepEqual(unbound.body, revoked.body);
  assert.equal((await messageRow(messageId)).content, fallbackOf("Ready for testing"));
  assert.equal((await revisionsOf(messageId)).length, 2);
});

test("a stale expectedRevision is 409 card_revision_conflict with the current revision; nothing changes", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Testing"), expectedRevision: 1 })).status, 200);
  const stale = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Ready for testing"), expectedRevision: 1 });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, "card_revision_conflict");
  assert.equal(stale.body.currentRevision, 2);
  assert.match(stale.body.error, /--expected-revision 2/);
  assert.equal(stale.body.suggestedNextAction, "run the same command again with --expected-revision 2");
  assert.equal((await messageRow(messageId)).content, fallbackOf("Testing"));
  assert.equal((await revisionsOf(messageId)).length, 2);
  // Two updates expecting the same revision at once: exactly one wins.
  const racing = await Promise.all([
    updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("A"), expectedRevision: 2 }),
    updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("B"), expectedRevision: 2 }),
  ]);
  assert.deepEqual(racing.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await revisionsOf(messageId)).length, 3);
  // An invalid card is refused as at send, with its path and the next step.
  const invalid = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: { version: 1, root: "go", elements: { go: { type: "Button", props: { label: "Go", action: { kind: "navigate", url: "http://example.com" } } } } } });
  assert.equal(invalid.status, 400);
  assert.deepEqual([invalid.body.code, invalid.body.path, invalid.body.limit], ["card_invalid", "card.elements.go.props.action.url", "url"]);
  assert.match(invalid.body.error, /fix it and run the same command again/);
});

test("v2.0: an update to a card with a header, Markdown, Fields and a Divider stores it and reads back; a refused one changes nothing", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const v2: MessageCardInput = {
    version: 1,
    header: { title: "Raft App 1.19.0 (11900001)", subtitle: "TestFlight · Internal, Beta", tags: [{ text: "Ready", tone: "success" }, { text: "iOS", tone: "info" }] },
    root: "root",
    elements: {
      root: { type: "Stack", props: {}, children: ["facts", "rule", "notes"] },
      facts: { type: "Fields", props: { items: [{ label: "Build", value: "11900001", mono: true }] } },
      rule: { type: "Divider", props: {} },
      notes: { type: "Markdown", props: { content: "Ready for **testing**:\n\n> what to test: sign-in" } },
    },
  };
  const stored = { ...v2, elements: { ...v2.elements, root: { type: "Stack", props: { direction: "column", wrap: false }, children: ["facts", "rule", "notes"] } } };
  const text = "**Raft App 1.19.0 (11900001)**\nTestFlight · Internal, Beta\n[Ready] [iOS]\n\n**Build:** `11900001`\n\n---\n\nReady for **testing**:\n\n> what to test: sign-in";
  const updated = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: v2, expectedRevision: 1 });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.revision, 2);
  const row = await messageRow(messageId);
  assert.deepEqual((row.actionMetadata as { card: unknown }).card, stored);
  assert.equal(row.content, text, "the new derived fallback starts with the header");
  assert.deepEqual((await revisionsOf(messageId)).map((revision) => [revision.revision, revision.content]), [[1, fallbackOf("In review")], [2, text]]);
  const history = await call(app.baseUrl, fixture.reviewerKey, "GET", `/history?channel=${encodeURIComponent(`#${fixture.channel.name}`)}&consume=false`);
  const read = history.body.messages.find((message: { id: string }) => message.id === messageId);
  assert.deepEqual(read.actionMetadata.card, stored);
  assert.deepEqual(read.message_card, { revision: 2, updated_at: updated.body.updatedAt, text });

  // Refused as at send: with the path, the limit and (Markdown) the node; nothing changes.
  const refusals: Array<[unknown, string, string, string?]> = [
    [{ ...v2, elements: { ...v2.elements, notes: { type: "Markdown", props: { content: "## Notes" } } } }, "card.elements.notes.props.content", "markdown", "heading"],
    [{ ...v2, header: { title: "T", tags: ["a", "b", "c", "d"].map((tag) => ({ text: tag, tone: "info" })) } }, "card.header.tags[3]", "tags"],
    [{ ...v2, elements: { ...v2.elements, facts: { type: "Fields", props: { items: [] } } } }, "card.elements.facts.props.items", "fields"],
  ];
  for (const [card, path, limit, node] of refusals) {
    const refused = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.deepEqual({ code: refused.body.code, path: refused.body.path, limit: refused.body.limit, node: refused.body.node }, { code: "card_invalid", path, limit, node });
  }
  assert.equal((await messageRow(messageId)).content, text);
  assert.equal(((await messageRow(messageId)).actionMetadata as { revision: number }).revision, 2);
  assert.equal((await revisionsOf(messageId)).length, 2, "no revision for a refused update");
});

test("past 10 updates a minute on one message, or the sender's hourly budget: 429 with retry_after", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  for (let i = 0; i < 10; i += 1) {
    const ok = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard(`Step ${i}`) });
    assert.equal(ok.status, 200, `update ${i}: ${JSON.stringify(ok.body)}`);
  }
  const limited = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Step 10") });
  assert.equal(limited.status, 429, JSON.stringify(limited.body));
  assert.equal(limited.body.code, "RATE_LIMITED");
  assert.ok(Number.isInteger(limited.body.retry_after) && limited.body.retry_after >= 1 && limited.body.retry_after <= 60);
  assert.equal(limited.headers.get("retry-after"), String(limited.body.retry_after));
  assert.deepEqual({ ...limited.body.details, retryAfterSeconds: 0 }, { operation: "messageCardUpdate", limit: 10, windowSeconds: 60, retryAfterSeconds: 0 });
  assert.match(limited.body.error, /at most 10 updates a minute per message\. Wait \d+ seconds?/);
  assert.equal((await revisionsOf(messageId)).length, 11, "the refused update wrote nothing");
  // Another of the sender's cards is not limited by this one's minute.
  const other = await sendCard(app.baseUrl, fixture);
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, other, { card: buildCard("Testing") })).status, 200);

  // The sender's budget over all its cards (300 an hour; 2 here).
  const fresh = await seedFixture();
  __setMessageCardUpdateLimitsForTests({ perSenderPerHour: 2 });
  try {
    const cards = [await sendCard(app.baseUrl, fresh), await sendCard(app.baseUrl, fresh), await sendCard(app.baseUrl, fresh)];
    // An update the checks refuse (here: an invalid card) spends nothing.
    assert.equal((await updateCard(app.baseUrl, fresh.apiKey, cards[0]!, { card: { version: 1, root: "missing", elements: {} } })).status, 400);
    assert.equal((await updateCard(app.baseUrl, fresh.apiKey, cards[0]!, { card: buildCard("x") })).status, 200);
    assert.equal((await updateCard(app.baseUrl, fresh.apiKey, cards[1]!, { card: buildCard("x") })).status, 200);
    const hourly = await updateCard(app.baseUrl, fresh.apiKey, cards[2]!, { card: buildCard("x") });
    assert.equal(hourly.status, 429, JSON.stringify(hourly.body));
    assert.equal(hourly.body.details.windowSeconds, 3600);
    assert.match(hourly.body.error, /at most 2 card updates an hour/);
  } finally {
    __setMessageCardUpdateLimitsForTests({});
  }
});

test("the same idempotencyKey and body answers the first result with one revision; another body under it is 409", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const body = { card: buildCard("Ready for testing"), expectedRevision: 1, idempotencyKey: "build-11900001-ready" };
  const first = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const { emits, io } = recordingIo();
  app.app.set("io", io);
  // A retry after a lost answer: its expectedRevision is stale now, the key answers first.
  const again = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual(again.body, first.body);
  assert.equal((await revisionsOf(messageId)).length, 2, "one revision for the key");
  assert.equal(emits.length, 0, "a replay changes nothing and emits nothing");
  // Still the first answer after a later update.
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Testing") })).status, 200);
  assert.deepEqual((await updateCard(app.baseUrl, fixture.apiKey, messageId, body)).body, first.body);

  for (const other of [{ ...body, card: buildCard("Rejected") }, { ...body, content: "Ready for testing (written)" }]) {
    const reused = await updateCard(app.baseUrl, fixture.apiKey, messageId, other);
    assert.equal(reused.status, 409, JSON.stringify(reused.body));
    assert.equal(reused.body.code, "idempotency_key_reused");
  }
  assert.equal((await revisionsOf(messageId)).length, 3);
  assert.equal((await messageRow(messageId)).content, fallbackOf("Testing"));
});

test("a replay is compared on what the sender sent: an update stored with an older Server's derived fallback answers its key's retry", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const body = { card: buildCard("Ready for testing"), idempotencyKey: "build-11900001-ready-deploy" };
  const first = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // As a Server before the markdown rendering stored it: the old " · " derivation of the same card.
  const older = "Raft App 1.19.0 (11900001) · Ready for testing";
  await getDb().update(messageCardRevisions).set({ content: older }).where(and(eq(messageCardRevisions.messageId, messageId), eq(messageCardRevisions.revision, 2)));
  await getDb().update(messages).set({ content: older }).where(eq(messages.id, messageId));

  // The same card under the same key, no content: the first answer (revision 2), nothing written.
  const again = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.deepEqual([again.body.revision, again.body.updatedAt, again.body.messageId], [first.body.revision, first.body.updatedAt, first.body.messageId]);
  assert.equal((await revisionsOf(messageId)).length, 2, "no new revision");
  assert.equal((await messageRow(messageId)).content, older, "nothing rewritten");
  // Through the write's own check too (a concurrent retry the route's lookup did not answer).
  const card = parseMessageCard(body.card);
  assert.ok(card.ok);
  const underLock = await applyMessageCardUpdate({
    messageId, senderAgentId: fixture.agent.id, card: card.card, content: fallbackOf("Ready for testing"), senderWroteContent: false, idempotencyKey: body.idempotencyKey,
  });
  assert.deepEqual([underLock.kind, underLock.kind === "updated" && underLock.replayed], ["updated", true]);

  // Content the sender writes is compared: another text under the key is another update.
  const written = await updateCard(app.baseUrl, fixture.apiKey, messageId, { ...body, content: "1.19.0 is ready for testing" });
  assert.equal(written.status, 409, JSON.stringify(written.body));
  assert.equal(written.body.code, "idempotency_key_reused");
  assert.equal((await revisionsOf(messageId)).length, 2);
});

test("a card send's receipt names the card's revision, a same-key replay the revision now; a text send has none", async ({ app }) => {
  const fixture = await seedFixture();
  const body = { target: `#${fixture.channel.name}`, card: buildCard("In review"), idempotencyKey: "testflight-11900001" };
  const sent = await sendV2(app.baseUrl, fixture.apiKey, body);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.deepEqual(sent.body.messageCard, { revision: 1 });
  // An update to the same card and text: revision 2, and the send's replay still matches it.
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, sent.body.messageId, { card: buildCard("In review") })).body.revision, 2);
  const replay = await sendV2(app.baseUrl, fixture.apiKey, body);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.messageId, sent.body.messageId);
  assert.deepEqual(replay.body.messageCard, { revision: 2 });
  const text = await sendV2(app.baseUrl, fixture.apiKey, { target: body.target, content: "plain text", idempotencyKey: "plain-1" });
  assert.equal(text.status, 200, JSON.stringify(text.body));
  assert.equal(Object.hasOwn(text.body, "messageCard"), false);
});

test("a mention added in the new fallback notifies no one, creates no inbox item, wakes no agent; the answer names it", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const delivered: string[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as { deliverMessage: (agentId: string, message: { message_id: string }) => Promise<unknown> };
  orchestrator.deliverMessage = async (agentId) => { delivered.push(agentId); };
  const db = getDb();
  const counts = async () => ({
    mentions: (await db.select().from(messageMentions).where(eq(messageMentions.messageId, messageId))).length,
    inbox: (await db.select().from(inboxNotificationFacts)).length,
    push: (await db.select().from(notificationOutbox)).length,
  });
  const before = await counts();

  const written = await updateCard(app.baseUrl, fixture.apiKey, messageId, {
    card: buildCard("Ready for testing"),
    content: `@${fixture.reviewer.name} and @${fixture.owner.name}: 1.19.0 is ready for testing`,
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.deepEqual(written.body.unnotifiedMentionHandles, [`@${fixture.reviewer.name}`, `@${fixture.owner.name}`]);
  assert.equal(written.body.notice, `Updating notifies no one. @${fixture.reviewer.name} and @${fixture.owner.name} in the new text were not notified; to tell them, send a new message.`);
  // A derived fallback naming someone: its @handle is code (the card as markdown), never a mention, so there is nobody to name.
  const derived = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Ready", `ping @${fixture.reviewer.name}`) });
  assert.equal(derived.status, 200);
  assert.equal((await messageRow(messageId)).content, `${fallbackOf("Ready")}\n\nping \`@${fixture.reviewer.name}\``);
  assert.deepEqual(derived.body.unnotifiedMentionHandles, []);
  assert.equal(derived.body.notice, "Updating notifies no one. To tell someone, send a new message.");

  assert.deepEqual(await counts(), before, "no mention, inbox item or push");
  assert.deepEqual(delivered, [], "no agent woken");
});

test("an update that landed answers its key's retry past the 14 days and over the limits; a new key there is refused", async ({ app }) => {
  const fixture = await seedFixture();
  const messageId = await sendCard(app.baseUrl, fixture);
  const body = { card: buildCard("Ready for testing"), idempotencyKey: "build-11900001-ready" };
  const first = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));

  // Over the message's minute (1 here): a new key is limited, the key's retry is not.
  __setMessageCardUpdateLimitsForTests({ perMessagePerMinute: 1 });
  try {
    const limited = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Testing"), idempotencyKey: "build-11900001-testing" });
    assert.equal(limited.status, 429, JSON.stringify(limited.body));
    const again = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body, first.body);
  } finally {
    __setMessageCardUpdateLimitsForTests({});
  }

  // 15 days on, past the window: the same.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 15 * 24 * 60 * 60 * 1000);
  try {
    const late = await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Testing"), idempotencyKey: "build-11900001-late" });
    assert.equal(late.status, 404, JSON.stringify(late.body));
    assert.equal(late.body.code, "message_card_not_found");
    const again = await updateCard(app.baseUrl, fixture.apiKey, messageId, body);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body, first.body);
  } finally {
    vi.useRealTimers();
  }
  assert.equal((await revisionsOf(messageId)).length, 2, "no revision after the first");
  assert.equal((await messageRow(messageId)).content, fallbackOf("Ready for testing"));
});

async function sync(baseUrl: string, human: Human, serverId: string, since?: string): Promise<SyncChangesResponse> {
  const res = await fetch(`${baseUrl}/api/sync/changes${since ? `?since=${encodeURIComponent(since)}` : ""}`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(human.email)}`, "X-Server-Id": serverId },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as SyncChangesResponse;
}

test("an update writes one message change in the channel's scope; /api/sync/changes rebuilds it for a member only", async ({ app }) => {
  const fixture = await seedFixture({ visibility: "private" });
  const ownerStart = await sync(app.baseUrl, fixture.owner, fixture.server.id);
  const outsiderStart = await sync(app.baseUrl, fixture.outsider, fixture.server.id);
  const messageId = await sendCard(app.baseUrl, fixture);
  assert.deepEqual(await messageChangeRows(messageId), [], "a send writes no message change (clients get it by sequence)");
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Ready for testing") })).status, 200);

  assert.deepEqual(await messageChangeRows(messageId), [{
    scope_kind: "channel", scope_id: fixture.channel.id, parent_id: null, server_id: fixture.server.id,
    entity: "message", entity_id: messageId, op: "upsert",
  }]);
  const round = await sync(app.baseUrl, fixture.owner, fixture.server.id, ownerStart.cursor);
  const change = round.changes.find((c) => c.entity === "message");
  assert.ok(change && change.op === "upsert", JSON.stringify(round.changes));
  assert.equal(change.id, messageId);
  // The row is the message list's row for that message.
  const listed = await fetch(`${app.baseUrl}/api/messages/channel/${fixture.channel.id}?limit=50`, {
    headers: { Authorization: `Bearer ${await tokenForHuman(fixture.owner.email)}`, "X-Server-Id": fixture.server.id },
  });
  const listRow = (await listed.json() as { messages: Array<{ id: string }> }).messages.find((m) => m.id === messageId);
  assert.deepEqual(change.row, listRow);
  const row = change.row as unknown as { content: string; channelId: string; actionMetadata: { revision: number } };
  assert.equal(row.content, fallbackOf("Ready for testing"));
  assert.equal(row.actionMetadata.revision, 2);

  // A Server member outside the private channel gets no row.
  const outsiderRound = await sync(app.baseUrl, fixture.outsider, fixture.server.id, outsiderStart.cursor);
  assert.equal(outsiderRound.changes.some((c) => c.entity === "message"), false);

  // A reaction count changing is not a message change: no trigger on messages.
  await mutateMessageReaction({ channelId: fixture.channel.id, messageId, emoji: "👀", actor: { kind: "user", id: fixture.owner.id }, operation: "add" });
  await getDb().update(messages).set({ taskStatus: null, updatedAt: new Date() }).where(eq(messages.id, messageId));
  assert.equal((await messageChangeRows(messageId)).length, 1);
});

test("a thread reply's change row names its parent channel, and reaches the parent channel's members", async ({ app }) => {
  const fixture = await seedFixture();
  const ownerStart = await sync(app.baseUrl, fixture.owner, fixture.server.id);
  const parent = await sendV2(app.baseUrl, fixture.apiKey, { target: `#${fixture.channel.name}`, content: "1.19.0 builds" });
  const replyId = await sendCard(app.baseUrl, fixture, `#${fixture.channel.name}:${(parent.body.messageId as string).slice(0, 8)}`);
  const reply = await messageRow(replyId);
  assert.notEqual(reply.channelId, fixture.channel.id, "the reply lives in the thread");
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, replyId, { card: buildCard("Ready for testing") })).status, 200);
  assert.deepEqual((await messageChangeRows(replyId)).map((r) => [r.scope_kind, r.scope_id, r.parent_id]), [["channel", reply.channelId, fixture.channel.id]]);
  const round = await sync(app.baseUrl, fixture.owner, fixture.server.id, ownerStart.cursor);
  const change = round.changes.find((c) => c.entity === "message" && c.id === replyId);
  assert.ok(change && change.op === "upsert", JSON.stringify(round.changes));
  assert.equal((change.row as { channelId: string; content: string }).channelId, reply.channelId);
  assert.equal((change.row as { content: string }).content, fallbackOf("Ready for testing"));
});

test("revisions: a member reads every version from the message; an owner outside a private channel, an App token and an agent key cannot", async ({ app }) => {
  const fixture = await seedFixture({ visibility: "private" });
  const messageId = await sendCard(app.baseUrl, fixture);
  assert.equal((await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Ready for testing"), content: "1.19.0: ready" })).status, 200);
  const read = (authorization: string, id = messageId) => fetch(`${app.baseUrl}/api/messages/${id}/card-revisions`, {
    headers: { Authorization: authorization, "X-Server-Id": fixture.server.id },
  });

  const member = await read(`Bearer ${await tokenForHuman(fixture.owner.email)}`);
  assert.equal(member.status, 200);
  assert.equal(member.headers.get("cache-control"), "private, no-store");
  const body = await member.json() as { messageId: string; revisions: Array<{ revision: number; content: string; card: { elements: Record<string, { props: { text: string } }> }; createdAt: string }> };
  assert.equal(body.messageId, messageId);
  assert.deepEqual(body.revisions.map((r) => [r.revision, r.content, r.card.elements.state!.props.text]), [
    [1, fallbackOf("In review"), "In review"],
    [2, "1.19.0: ready", "Ready for testing"],
  ]);

  // The Server's owner, an admin there, outside the private channel: the unknown message's answer.
  const admin = await seedHuman("admin");
  await addMember(fixture.server.id, admin.id, "admin");
  for (const human of [admin, fixture.outsider]) {
    const token = `Bearer ${await tokenForHuman(human.email)}`;
    const refused = await read(token);
    const unknown = await read(token, UNKNOWN_ID);
    assert.equal(refused.status, 404);
    assert.deepEqual([refused.status, await refused.json()], [unknown.status, await unknown.json()]);
  }
  // Not a person's session: an App's OAuth token for the owner, the sender's agent key.
  const { client } = await createOAuthClient({ serverId: fixture.server.id, createdByUserId: fixture.owner.id, clientId: `card-reader-${randomUUID().slice(0, 8)}`, name: "Card Reader", enableBot: true });
  const appToken = `slock_at_${randomBytes(32).toString("hex")}`;
  await getDb().insert(oauthAccessTokens).values({
    serverId: fixture.server.id, principalType: "human", userId: fixture.owner.id, clientId: client.id,
    tokenHash: createHash("sha256").update(appToken).digest("hex"), scopes: ["openid", "profile"], expiresAt: new Date(Date.now() + 3_600_000),
  });
  assert.equal((await read(`Bearer ${appToken}`)).status, 401);
  assert.equal((await read(`Bearer ${fixture.apiKey}`)).status, 401);
  // A deleted message: the unknown message's answer, no revisions.
  const ownerToken = `Bearer ${await tokenForHuman(fixture.owner.email)}`;
  const deleted = await sendCard(app.baseUrl, fixture);
  await getDb().update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, deleted));
  const deletedRead = await read(ownerToken, deleted);
  const unknownRead = await read(ownerToken, UNKNOWN_ID);
  assert.equal(deletedRead.status, 404);
  assert.deepEqual(await deletedRead.json(), await unknownRead.json());
  // Not a card message: no revisions.
  const plain = await sendV2(app.baseUrl, fixture.apiKey, { target: `#${fixture.channel.name}`, content: "text" });
  const none = await read(`Bearer ${await tokenForHuman(fixture.owner.email)}`, plain.body.messageId);
  assert.deepEqual(await none.json(), { messageId: plain.body.messageId, revisions: [] });
});

test("revisions are deleted 44 days after the message was sent; the message keeps its current card", async ({ app }) => {
  const fixture = await seedFixture();
  const day = 24 * 60 * 60 * 1000;
  const expired = await sendCard(app.baseUrl, fixture);
  const kept = await sendCard(app.baseUrl, fixture);
  for (const id of [expired, kept]) assert.equal((await updateCard(app.baseUrl, fixture.apiKey, id, { card: buildCard("Ready for testing") })).status, 200);
  const db = getDb();
  const backdate = async (id: string, sentDaysAgo: number) => {
    await db.update(messages).set({ createdAt: new Date(Date.now() - sentDaysAgo * day) }).where(eq(messages.id, id));
    // Revision 1 at send, revision 2 within the update window.
    await db.update(messageCardRevisions).set({ createdAt: new Date(Date.now() - sentDaysAgo * day) }).where(and(eq(messageCardRevisions.messageId, id), eq(messageCardRevisions.revision, 1)));
    await db.update(messageCardRevisions).set({ createdAt: new Date(Date.now() - (sentDaysAgo - 13) * day) }).where(and(eq(messageCardRevisions.messageId, id), eq(messageCardRevisions.revision, 2)));
  };
  await backdate(expired, 45);
  await backdate(kept, 43);

  assert.equal(await pruneMessageCardRevisions(), 2);
  assert.deepEqual(await revisionsOf(expired), []);
  assert.deepEqual((await revisionsOf(kept)).map((r) => r.revision), [1, 2]);
  const row = await messageRow(expired);
  assert.equal((row.actionMetadata as { revision: number }).revision, 2);
  assert.equal(row.content, fallbackOf("Ready for testing"));
  assert.equal(await pruneMessageCardRevisions(), 0);
});

test("the Slack mirror carries a card message's first fallback, and an update never posts a new Slack message", async ({ app }) => {
  const fixture = await seedFixture();
  const mirrored: string[] = [];
  // The outbound admission seam: what the mirror would post (admitting nothing).
  __setOrdinaryMessageOutboundAuthorizationResolverForTests(async (request) => { mirrored.push(request.sourceText); return null; });
  __setSlackBridgeReconciliationMarkerMinterForTests(({ deliveryId }) => mintSlackBridgeReconciliationMarker("card-mirror-test-key", deliveryId));
  try {
    const messageId = await sendCard(app.baseUrl, fixture);
    assert.deepEqual(mirrored, [fallbackOf("In review")], "the first fallback, text only");
    assert.equal((await updateCard(app.baseUrl, fixture.apiKey, messageId, { card: buildCard("Ready for testing") })).status, 200);
    assert.deepEqual(mirrored, [fallbackOf("In review")], "an update is no new send (it edits the copy: §4.6)");
  } finally {
    __resetOrdinaryMessageOutboundAuthorizationResolverForTests();
  }
});
