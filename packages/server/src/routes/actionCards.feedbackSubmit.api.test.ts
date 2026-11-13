import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
// `feedback:submit`: an agent drafts product feedback as an action card; a
// person who may operate the card sends it from the prefilled feedback dialog
// through POST /api/product-feedback, as their own feedback. The route checks
// the card before Hands, marks it done from the Hands receipt afterwards, and
// neither the carrier text nor the agent's result reply carries the body.
// The mobile feedback page reads the draft first (GET
// /api/product-feedback/action-card/:messageId) under the same checks.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channels, messages, serverMembers, servers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import * as messageService from "../services/messageService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { prepareActionCard } from "../services/actionCardsService";
import { agentFeedbackCardSubmissionId } from "../services/productFeedbackService";
import {
  FEEDBACK_PATH,
  HANDS_TICKET_ID,
  multipartField,
  withHands,
  withHandsFeedbackConfigured,
  withoutHandsFeedback,
} from "../test/handsFeedbackStub";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const DRAFT = "Agent draft: pinned threads should survive a reload.";
const EDITED = "Pinned threads disappear from my sidebar after every reload.";
const CONVERSATION = "private conversation line that must never reach Hands";
// Generous: a loaded CI host can take far longer than a request normally does.
const REQUEST_TIMEOUT_MS = 120_000;

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }) {
  const deliverMessage = async () => ({ status: "queued", reason: "test" });
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<unknown>) => batch.map(() => deliverMessage()),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
}

async function seedWorld() {
  const wendy = await seedUser("feedback-wendy");
  const outsider = await seedUser("feedback-outsider");
  const server = await createServer("Feedback Cards", `feedback-cards-${randomUUID().slice(0, 8)}`, wendy.id);
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  const agent = await createAgent(server.id, "feedback-scout", { runtime: "claude" });
  const room = await channelService.createChannel(server.id, `feedback-room-${randomUUID().slice(0, 6)}`);
  await channelService.addHuman(room.id, wendy.id);
  await channelService.addAgent(room.id, agent.id);
  const { apiKey } = await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read", "tasks"], name: "feedback-card", issuedVia: "computer", createdByUserId: null });
  return { wendy, outsider, server, agent, room, apiKey };
}

const draftAction = { type: "feedback:submit", feedbackType: "idea", message: DRAFT, draftHint: "You hit this twice today." };

async function postPrepare(baseUrl: string, apiKey: string, target: string) {
  return fetch(`${baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ target, action: draftAction }),
  });
}

/** The agent's prepare where Hands feedback is configured (production, staging). */
const prepare = (baseUrl: string, apiKey: string, target: string) =>
  withHandsFeedbackConfigured(() => postPrepare(baseUrl, apiKey, target));

/** The dialog's submission: the in-app form's fields plus the card's. */
async function sendFeedback(baseUrl: string, token: string, serverId: string | null, fields: Record<string, string>) {
  const form = new FormData();
  form.set("type", "problem");
  form.set("message", EDITED);
  form.set("submission_id", randomUUID());
  form.set("may_contact", "false");
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return fetch(`${baseUrl}/api/product-feedback`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, ...(serverId ? { "X-Server-Id": serverId } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: form,
  });
}

async function codeOf(response: Response): Promise<string | undefined> {
  const body = await response.json() as { code?: string; errorCode?: string };
  return body.code ?? body.errorCode;
}

test("where Hands feedback is configured, an agent prepares a feedback card with no flag row; the carrier text is neutral", async ({ app }) => {
  const { room, apiKey } = await seedWorld();

  const prepared = await prepare(app.baseUrl, apiKey, `#${room.name}`);
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { messageId, metadata } = await prepared.json() as { messageId: string; metadata: ActionCardMetadata };
  assert.equal(metadata.action.type, "feedback:submit");
  const [carrier] = await getDb().select().from(messages).where(eq(messages.id, messageId));
  assert.equal(carrier.content, "Prepared a feedback draft for you");
});

test("where Hands feedback is not configured (self-hosted, local), prepare refuses a feedback card: 403 FEATURE_DISABLED, nothing posted", async ({ app }) => {
  const { server, room, apiKey } = await seedWorld();
  const roomMessages = async () => (await getDb().select().from(messages).where(eq(messages.channelId, room.id))).length;
  const before = await roomMessages();

  // Its send could only answer 503 feedback_not_configured, so the card would wait forever.
  const refused = await withoutHandsFeedback(() => postPrepare(app.baseUrl, apiKey, `#${room.name}`));
  assert.equal(refused.status, 403, await refused.clone().text());
  const body = await refused.json() as { error: string; errorCode: string };
  assert.equal(body.errorCode, "FEATURE_DISABLED");
  assert.equal(body.error, "Feedback cards are not available on this server.");
  assert.equal((await getDb().select().from(actionCards).where(eq(actionCards.serverId, server.id))).length, 0);
  assert.equal(await roomMessages(), before);
});

test("the card's dialog files the sender's edited text as their own feedback and completes the card", async ({ app }) => {
  const db = getDb();
  const { wendy, server, agent, room, apiKey } = await seedWorld();
  installRecordingOrchestrator(app.app);
  await messageService.createMessage(room.id, "user", wendy.id, CONVERSATION);
  const prepared = await prepare(app.baseUrl, apiKey, `#${room.name}`);
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { messageId } = await prepared.json() as { messageId: string };
  const [card] = await db.select().from(actionCards).where(eq(actionCards.messageId, messageId));
  const token = await tokenForHuman(wendy.email);

  // Neither the generic execute (the card is a form card: F1) nor a
  // client-reported result completes it.
  const executed = await fetch(`${app.baseUrl}/api/actions/${messageId}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
    body: JSON.stringify({ expectedState: "prepared" }),
  });
  assert.equal(executed.status, 422);
  assert.equal(await codeOf(executed), "FORM_REQUIRED");
  const forged = await fetch(`${app.baseUrl}/api/actions/${messageId}/mark-executed`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": server.id },
    body: JSON.stringify({ result: { kind: "product-feedback", ticketId: randomUUID(), reference: null } }),
  });
  assert.equal(forged.status, 409);
  assert.equal(await codeOf(forged), "DIALOG_REQUIRED");

  await withHands(async (requests) => {
    const sent = await sendFeedback(app.baseUrl, token, server.id, {
      action_card_message_id: messageId,
      expected_confirmation_version: String(card.confirmationVersion),
    });
    assert.equal(sent.status, 201, await sent.clone().text());
    const receipt = await sent.json() as { id: string; action_card?: { message_id: string; metadata: ActionCardMetadata } };
    assert.equal(receipt.id, HANDS_TICKET_ID);
    assert.equal(receipt.action_card?.message_id, messageId);
    assert.equal(receipt.action_card?.metadata.state, "executed");
    // `source`: the Hands app it was filed into; from the web, the single (web) app.
    assert.deepEqual(receipt.action_card?.metadata.result, { kind: "product-feedback", ticketId: HANDS_TICKET_ID, reference: "FB-7", source: "web" });
    // The card as data shows the result the server recorded (action-card.v1, S1): where it went, and the
    // sender's View in Settings, which opens the ticket from metadata.result (S0.3).
    const resultTree = receipt.action_card?.metadata.presentation?.card?.result;
    const summary = resultTree?.elements.summary;
    assert.equal(summary?.type === "Text" && typeof summary.props.text === "object" ? summary.props.text.key : null, "actionCard.result.feedbackSentToRaft");
    const openTicket = resultTree?.elements.openTicket;
    assert.deepEqual(openTicket?.type === "Button" ? openTicket.props.action : null, { kind: "open", intent: "feedback_ticket" });
    assert.equal(JSON.stringify(resultTree).includes(HANDS_TICKET_ID), false, "the card carries no ticket id");

    const filed = requests.filter((request) => request.method === "POST" && request.url === FEEDBACK_PATH);
    assert.equal(filed.length, 1);
    const [ticket] = filed;
    assert.equal(multipartField(ticket, "message"), EDITED, "the sender's edited text is what is filed");
    assert.equal(multipartField(ticket, "kind"), "bug");
    const handsMetadata = JSON.parse(multipartField(ticket, "metadata") ?? "{}") as Record<string, unknown>;
    assert.equal(handsMetadata.surface, "agent.feedback_card");
    assert.deepEqual(handsMetadata.reporter_attribution, {
      v: 1,
      server_id: server.id,
      server_slug: server.slug,
      user_id: wendy.id,
      handle: wendy.name,
      source: "agent_card",
      drafted_by_agent_id: agent.id,
    });
    for (const request of requests) {
      assert.equal(request.body.includes(DRAFT), false, "the agent's replaced draft never reaches Hands");
      assert.equal(request.body.includes(CONVERSATION), false, "no conversation content reaches Hands");
    }

    // A second send of the same card is refused before Hands.
    const again = await sendFeedback(app.baseUrl, token, server.id, { action_card_message_id: messageId });
    assert.equal(again.status, 409);
    assert.equal(await codeOf(again), "STATE_MISMATCH");
    assert.equal(requests.filter((request) => request.url === FEEDBACK_PATH).length, 1);
  });

  const [done] = await db.select().from(actionCards).where(eq(actionCards.messageId, messageId));
  assert.equal(done.state, "executed");
  assert.equal(done.executedByUserId, wendy.id);
  const [carrier] = await db.select().from(messages).where(eq(messages.id, messageId));
  assert.equal(carrier.content, "Prepared a feedback draft for you", "the carrier text never carries the body");
  const [thread] = await db.select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId)));
  assert.ok(thread, "the agent is told in the card's thread");
  const replies = await db.select().from(messages).where(and(
    eq(messages.channelId, thread.id),
    eq(messages.systemSubtype, "action_card.result_reply"),
  ));
  assert.ok(replies.some((reply) => /Result: feedback submitted\./.test(reply.content)), replies.map((reply) => reply.content).join("\n"));
  for (const reply of replies) {
    assert.equal(reply.content.includes(EDITED), false, "the agent never sees the sender's text");
    assert.equal(reply.content.includes(DRAFT), false);
  }
});

test("a card prepared more than 30 days ago is refused before Hands, 409 ACTION_CARD_EXPIRED; one prepared 29 days ago is sent", async ({ app }) => {
  const db = getDb();
  const { wendy, server, room, apiKey } = await seedWorld();
  installRecordingOrchestrator(app.app);
  // Pro: Free's 30-day history window would refuse a card this old first.
  await db.update(servers).set({ plan: "pro" }).where(eq(servers.id, server.id));
  const preparedDaysAgo = async (days: number) => {
    const prepared = await prepare(app.baseUrl, apiKey, `#${room.name}`);
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const { messageId } = await prepared.json() as { messageId: string };
    // Its row and its carrier, which prepare writes together.
    const at = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await db.update(actionCards).set({ createdAt: at }).where(eq(actionCards.messageId, messageId));
    await db.update(messages).set({ createdAt: at }).where(eq(messages.id, messageId));
    return messageId;
  };
  const old = await preparedDaysAgo(31);
  const recent = await preparedDaysAgo(29);
  const token = await tokenForHuman(wendy.email);

  await withHands(async (requests) => {
    const refused = await sendFeedback(app.baseUrl, token, server.id, { action_card_message_id: old });
    assert.equal(refused.status, 409, await refused.clone().text());
    const body = await refused.json() as { error: string; code: string };
    assert.equal(body.code, "ACTION_CARD_EXPIRED");
    assert.match(body.error, /Ask the agent to send a new request\.$/);
    assert.equal(requests.filter((request) => request.url === FEEDBACK_PATH).length, 0, "nothing reached Hands");

    const sent = await sendFeedback(app.baseUrl, token, server.id, { action_card_message_id: recent });
    assert.equal(sent.status, 201, await sent.clone().text());
  });
  const [oldRow] = await db.select().from(actionCards).where(eq(actionCards.messageId, old));
  assert.equal(oldRow.state, "prepared", "the expired card's row stays prepared");
  const [recentRow] = await db.select().from(actionCards).where(eq(actionCards.messageId, recent));
  assert.equal(recentRow.state, "executed");
});

test("a card submission is refused before Hands unless the sender may operate a current feedback card", async ({ app }) => {
  const { wendy, outsider, server, agent, room, apiKey } = await seedWorld();
  const prepared = await prepare(app.baseUrl, apiKey, `#${room.name}`);
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { messageId } = await prepared.json() as { messageId: string };
  const otherCard = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: room.id,
    action: { type: "channel:create", name: `feedback-not-${randomUUID().slice(0, 6)}`, visibility: "public" },
  });
  const wendyToken = await tokenForHuman(wendy.email);

  await withHands(async (requests) => {
    const notMember = await sendFeedback(app.baseUrl, await tokenForHuman(outsider.email), server.id, { action_card_message_id: messageId });
    assert.equal(notMember.status, 403, await notMember.clone().text());

    const stale = await sendFeedback(app.baseUrl, wendyToken, server.id, { action_card_message_id: messageId, expected_confirmation_version: "7" });
    assert.equal(stale.status, 409);
    assert.equal(await codeOf(stale), "CONFIRMATION_VERSION_MISMATCH");

    const wrongType = await sendFeedback(app.baseUrl, wendyToken, server.id, { action_card_message_id: otherCard.messageId });
    assert.equal(wrongType.status, 409);
    assert.equal(await codeOf(wrongType), "NOT_FEEDBACK_CARD");

    const noServer = await sendFeedback(app.baseUrl, wendyToken, null, { action_card_message_id: messageId });
    assert.equal(noServer.status, 400);

    assert.equal(requests.filter((request) => request.url === FEEDBACK_PATH).length, 0, "no refused submission reached Hands");

    // The ordinary in-app form is unchanged: no card, no agent attribution.
    const plain = await sendFeedback(app.baseUrl, wendyToken, server.id, {});
    assert.equal(plain.status, 201, await plain.clone().text());
    assert.equal(((await plain.json()) as { action_card?: unknown }).action_card, undefined);
    const [ticket] = requests.filter((request) => request.url === FEEDBACK_PATH);
    const handsMetadata = JSON.parse(multipartField(ticket, "metadata") ?? "{}") as Record<string, unknown>;
    assert.equal(handsMetadata.surface, "settings.feedback");
    const attribution = handsMetadata.reporter_attribution as Record<string, unknown>;
    assert.equal(attribution.server_id, server.id);
    assert.equal("source" in attribution, false);
    assert.equal("drafted_by_agent_id" in attribution, false);
  });
  const [card] = await getDb().select().from(actionCards).where(eq(actionCards.messageId, messageId));
  assert.equal(card.state, "prepared", "refusals leave the card waiting");
});

test("a card send has a submission_id fixed per card and sender; only Hands' 'already filed' 409 completes the card", async ({ app }) => {
  const db = getDb();
  const { wendy, server, room, apiKey } = await seedWorld();
  installRecordingOrchestrator(app.app);
  const token = await tokenForHuman(wendy.email);
  const prepareCard = async () => {
    const prepared = await prepare(app.baseUrl, apiKey, `#${room.name}`);
    assert.equal(prepared.status, 201, await prepared.clone().text());
    return (await prepared.json() as { messageId: string }).messageId;
  };

  // Hands' documented reply to a reused submission_id with other content
  // (botiverse/hands worker/src/routes/feedback.ts). The literal text is
  // pinned here: if either side changes it, this case fails.
  const filedCard = await prepareCard();
  const clientSubmissionId = randomUUID();
  await withHands(async (requests) => {
    const sent = await sendFeedback(app.baseUrl, token, server.id, {
      action_card_message_id: filedCard,
      submission_id: clientSubmissionId,
    });
    assert.equal(sent.status, 409, await sent.clone().text());
    const body = await sent.json() as { code: string; action_card?: { message_id: string; metadata: ActionCardMetadata } };
    assert.equal(body.code, "feedback_card_already_sent");
    assert.equal(body.action_card?.metadata.state, "executed");
    assert.deepEqual(body.action_card?.metadata.result, { kind: "product-feedback", ticketId: null, reference: null, source: "web" });

    const [filed] = requests.filter((request) => request.method === "POST" && request.url === FEEDBACK_PATH);
    assert.ok(filed);
    assert.equal(multipartField(filed, "submission_id"), agentFeedbackCardSubmissionId(filedCard, wendy.id));
    assert.notEqual(multipartField(filed, "submission_id"), clientSubmissionId, "a card send ignores the client's id");
  }, () => ({ status: 409, body: { error: "submission_id already used with a different payload" } }));
  const [completed] = await db.select().from(actionCards).where(eq(actionCards.messageId, filedCard));
  assert.equal(completed.state, "executed");

  // Any other 409 stays an ordinary conflict and leaves the card waiting.
  const conflictCard = await prepareCard();
  await withHands(async () => {
    const sent = await sendFeedback(app.baseUrl, token, server.id, { action_card_message_id: conflictCard });
    assert.equal(sent.status, 409, await sent.clone().text());
    assert.equal(await codeOf(sent), "feedback_submission_conflict");
  }, () => ({ status: 409, body: { error: "submission_id already used by a different reporter" } }));
  const [waiting] = await db.select().from(actionCards).where(eq(actionCards.messageId, conflictCard));
  assert.equal(waiting.state, "prepared");

  // The id is stable per card and sender, and differs between people.
  assert.equal(agentFeedbackCardSubmissionId(filedCard, wendy.id), agentFeedbackCardSubmissionId(filedCard, wendy.id));
  assert.notEqual(agentFeedbackCardSubmissionId(filedCard, wendy.id), agentFeedbackCardSubmissionId(filedCard, randomUUID()));
});

/** The mobile feedback page's read of a card's draft, from the server in `server`. */
async function readDraft(baseUrl: string, token: string, serverId: string | null, messageId: string) {
  return fetch(`${baseUrl}/api/product-feedback/action-card/${messageId}`, {
    headers: { Authorization: `Bearer ${token}`, ...(serverId ? { "X-Server-Id": serverId } : {}) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

const UNAVAILABLE = { error: "Feedback card unavailable", code: "feedback_card_unavailable" };

test("the feedback page reads a card's draft under the send's checks, and every refusal is the same 404", async ({ app }) => {
  const db = getDb();
  const { wendy, outsider, server, agent, room, apiKey } = await seedWorld();
  installRecordingOrchestrator(app.app);
  const prepared = await prepare(app.baseUrl, apiKey, `#${room.name}`);
  assert.equal(prepared.status, 201, await prepared.clone().text());
  const { messageId } = await prepared.json() as { messageId: string };
  const otherCard = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: room.id,
    action: { type: "channel:create", name: `feedback-not-${randomUUID().slice(0, 6)}`, visibility: "public" },
  });
  const stranger = await seedUser("feedback-stranger");
  const elsewhere = await createServer("Elsewhere", `feedback-elsewhere-${randomUUID().slice(0, 8)}`, wendy.id);
  const [card] = await db.select().from(actionCards).where(eq(actionCards.messageId, messageId));
  const wendyToken = await tokenForHuman(wendy.email);

  await withHands(async (requests) => {
    const read = await readDraft(app.baseUrl, wendyToken, server.id, messageId);
    assert.equal(read.status, 200, await read.clone().text());
    assert.deepEqual(await read.json(), {
      message_id: messageId,
      feedback_type: "idea",
      message: DRAFT,
      confirmation_version: card.confirmationVersion,
    });

    const outsiderToken = await tokenForHuman(outsider.email);
    const strangerToken = await tokenForHuman(stranger.email);
    const refusals: Array<[string, () => Promise<Response>]> = [
      ["server member outside the card's channel", () => readDraft(app.baseUrl, outsiderToken, server.id, messageId)],
      ["not a member of the server", () => readDraft(app.baseUrl, strangerToken, server.id, messageId)],
      ["another server of the same person", () => readDraft(app.baseUrl, wendyToken, elsewhere.id, messageId)],
      ["not a feedback card", () => readDraft(app.baseUrl, wendyToken, server.id, otherCard.messageId)],
      ["no such message", () => readDraft(app.baseUrl, wendyToken, server.id, randomUUID())],
      ["not a message id", () => readDraft(app.baseUrl, wendyToken, server.id, "not-a-uuid")],
      ["no X-Server-Id", () => readDraft(app.baseUrl, wendyToken, null, messageId)],
      ["an X-Server-Id that is not a UUID", () => readDraft(app.baseUrl, wendyToken, "acme", messageId)],
    ];
    for (const [reason, read] of refusals) {
      const response = await read();
      assert.equal(response.status, 404, reason);
      assert.deepEqual(await response.json(), UNAVAILABLE, reason);
    }

    await db.update(actionCards).set({ freezeState: "frozen" }).where(eq(actionCards.messageId, messageId));
    const frozen = await readDraft(app.baseUrl, wendyToken, server.id, messageId);
    assert.equal(frozen.status, 404);
    assert.deepEqual(await frozen.json(), UNAVAILABLE);
    await db.update(actionCards).set({ freezeState: "ready" }).where(eq(actionCards.messageId, messageId));

    assert.equal(requests.length, 0, "reading a draft never calls Hands");
    const [unchanged] = await db.select().from(actionCards).where(eq(actionCards.messageId, messageId));
    assert.equal(unchanged.state, "prepared");
    assert.equal(unchanged.confirmationVersion, card.confirmationVersion);

    // The version it returned is what the page's send is checked against.
    const sent = await sendFeedback(app.baseUrl, wendyToken, server.id, {
      action_card_message_id: messageId,
      expected_confirmation_version: String(card.confirmationVersion),
    });
    assert.equal(sent.status, 201, await sent.clone().text());
    const filed = requests.length;

    const alreadySent = await readDraft(app.baseUrl, wendyToken, server.id, messageId);
    assert.equal(alreadySent.status, 404);
    assert.deepEqual(await alreadySent.json(), UNAVAILABLE);
    assert.equal(requests.length, filed, "reading a sent card never calls Hands");
  });
});
