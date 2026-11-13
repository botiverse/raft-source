import { createApiTest } from "../test/integration/apiTest";
// A card prepared more than 30 days ago (action_cards.created_at) can no
// longer be completed by a press that causes the effect (#proj-apps:#40):
// execute, a form submit and reconfirm refuse it with 409
// ACTION_CARD_EXPIRED, saying when it expired and to ask the agent for a new
// request, and write nothing: the row stays `prepared` and the agent is not
// told. mark-executed, which records what a dialog already did, still
// succeeds. Reads serve every prepared card with its deadline (`expiresAt`)
// and a 30-day card past it as `expired`, to people, agents and broadcasts
// alike, without storing either. A question card keeps its own deadline. The
// servers are on Pro: Free's 30-day history window would hide a card this old.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach } from "vitest";
import {
  ACTION_CARD_ACTION_KEYS,
  ACTION_CARD_EXPIRED_ERROR_CODE,
  ACTION_CARD_METADATA_KEYS,
  ACTION_CARD_RESULT_KEYS,
  type ActionCardMetadata,
  type QuestionAskAction,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channels, messages, servers } from "../db/schema";
import { reconfirmActionCard } from "../services/actionCardConversionService";
import { servedActionCardMetadata } from "../services/actionCardExpiry";
import { setActionCardFormHandlerForTest } from "../services/actionCardForms";
import { emitActionCardMessageUpdated } from "../services/actionCardsService";
import * as channelService from "../services/channelService";
import {
  cardRow, channelCreateFormHandler, channelsNamed, goodValues, headers, post, prepareCreate, seed, submit, type Fixture,
} from "../test/actionCardFormFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

afterEach(() => {
  setActionCardFormHandlerForTest("channel:create", null);
});

const DAY = 24 * 60 * 60 * 1000;

async function seedPro(app: Parameters<typeof seed>[0]): Promise<Fixture> {
  const f = await seed(app);
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, f.server.id));
  return f;
}

/** The card as if prepared `days` ago: its row and its carrier message, which prepare writes together. Returns its deadline. */
async function preparedDaysAgo(messageId: string, days: number): Promise<string> {
  const at = new Date(Date.now() - days * DAY);
  await getDb().update(actionCards).set({ createdAt: at }).where(eq(actionCards.messageId, messageId));
  await getDb().update(messages).set({ createdAt: at }).where(eq(messages.id, messageId));
  return new Date(at.getTime() + 30 * DAY).toISOString();
}

async function storedMetadata(messageId: string): Promise<ActionCardMetadata> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return row!.actionMetadata as ActionCardMetadata;
}

/** Nothing about the card was written: its row and its carrier are `prepared`, the carrier holds no deadline. */
async function assertStoredPrepared(messageId: string) {
  assert.equal((await cardRow(messageId)).state, "prepared", "the row stays prepared");
  const stored = await storedMetadata(messageId);
  assert.equal(stored.state, "prepared", "the carrier stays prepared");
  assert.equal("expiresAt" in stored, false, "the deadline is served, never stored");
}

/** A refusal for age: 409 ACTION_CARD_EXPIRED saying when it expired and what to do, and the card as it was. */
async function assertRefusedAsExpired(res: { status: number; text: string; body: { errorCode: string; error: string } }, messageId: string, expiresAt: string) {
  assert.equal(res.status, 409, res.text);
  assert.equal(res.body.errorCode, ACTION_CARD_EXPIRED_ERROR_CODE);
  assert.equal(res.body.error, `This request expired on ${expiresAt.slice(0, 10)} ${expiresAt.slice(11, 16)} UTC. Ask the agent to send a new request.`);
  await assertStoredPrepared(messageId);
  // Nothing went to the agent: no result reply in the card's thread.
  const threads = await getDb().select({ id: channels.id }).from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId)));
  assert.equal(threads.length, 0, "the agent is not told");
}

/**
 * Every key a client is served is listed with what the App's V2 does with it:
 * the card's (ACTION_CARD_METADATA_KEYS), its action's (ACTION_CARD_ACTION_KEYS)
 * and its result's for that kind (ACTION_CARD_RESULT_KEYS).
 */
function assertServedKeysListed(served: ActionCardMetadata) {
  for (const key of Object.keys(served)) assert.ok(Object.hasOwn(ACTION_CARD_METADATA_KEYS, key), `unlisted action_metadata key: ${key}`);
  for (const key of Object.keys(served.action)) assert.ok(Object.hasOwn(ACTION_CARD_ACTION_KEYS, key), `unlisted action key: ${key}`);
  if (!served.result) return;
  const listed = ACTION_CARD_RESULT_KEYS[served.result.kind];
  assert.ok(listed, `unlisted result kind: ${served.result.kind}`);
  for (const key of Object.keys(served.result)) assert.ok(Object.hasOwn(listed, key), `unlisted ${served.result.kind} result key: ${key}`);
}

/** The card as a person's client reads it in the channel history. */
async function humanRead(baseUrl: string, f: Fixture, messageId: string): Promise<ActionCardMetadata> {
  const res = await fetch(`${baseUrl}/api/messages/channel/${f.channel.id}?limit=50`, { headers: headers(f, "owner") });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { messages: Array<{ id: string; actionMetadata?: ActionCardMetadata }> };
  const message = body.messages.find((candidate) => candidate.id === messageId);
  assert.ok(message?.actionMetadata, "the card is in the human history");
  return message.actionMetadata;
}

/** The same card as its agent reads it (`raft message read`). */
async function agentRead(baseUrl: string, f: Fixture, messageId: string): Promise<ActionCardMetadata> {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${f.channel.name}`)}&limit=50&consume=false`, {
    headers: { Authorization: `Bearer ${f.agentKey}`, "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = await res.json() as { messages: Array<{ id: string; actionMetadata?: ActionCardMetadata }> };
  const message = body.messages.find((candidate) => candidate.id === messageId);
  assert.ok(message?.actionMetadata, "the card is in the agent history");
  return message.actionMetadata;
}

test("execute: a card prepared 31 days ago is refused 409 ACTION_CARD_EXPIRED and nothing runs; one prepared 29 days ago runs", async ({ app }) => {
  const f = await seedPro(app);
  const old = await prepareCreate(f, { name: "expired-room", initialHumans: [] });
  const oldExpiry = await preparedDaysAgo(old.messageId, 31);
  await assertRefusedAsExpired(await post(app.baseUrl, f, "owner", `${old.messageId}/execute`, { expectedState: "prepared" }), old.messageId, oldExpiry);
  assert.equal((await channelsNamed(f.server.id, "expired-room")).length, 0, "no channel was created");

  const recent = await prepareCreate(f, { name: "recent-room", initialHumans: [] });
  await preparedDaysAgo(recent.messageId, 29);
  const ran = await post(app.baseUrl, f, "owner", `${recent.messageId}/execute`, { expectedState: "prepared" });
  assert.equal(ran.status, 200, ran.text);
  assert.equal(ran.body.metadata.state, "executed");
  assert.equal("expiresAt" in ran.body.metadata, false, "a done card has no deadline");
  assert.equal((await channelsNamed(f.server.id, "recent-room")).length, 1);
});

test("a form submit: a card prepared 31 days ago is refused before its form is checked; at 29 days it runs", async ({ app }) => {
  const f = await seedPro(app);
  const calls = channelCreateFormHandler();
  const old = await prepareCreate(f);
  const oldExpiry = await preparedDaysAgo(old.messageId, 31);
  await assertRefusedAsExpired(await submit(app.baseUrl, f, "owner", old.messageId, goodValues(f)), old.messageId, oldExpiry);
  assert.deepEqual(calls, { validate: 0, execute: 0 }, "the form handler never ran");
  assert.equal((await cardRow(old.messageId)).submittedInput, null, "no values were kept");

  const recent = await prepareCreate(f);
  await preparedDaysAgo(recent.messageId, 29);
  const ran = await submit(app.baseUrl, f, "owner", recent.messageId, goodValues(f));
  assert.equal(ran.status, 200, ran.text);
  assert.equal(ran.body.metadata.state, "executed");
});

test("mark-executed on a card older than 30 days still succeeds: it records what the dialog already did", async ({ app }) => {
  const f = await seedPro(app);
  // What the create dialog made through the regular API before marking the card.
  const made = await channelService.createChannel(f.server.id, `dialog-room-${randomUUID().slice(0, 6)}`);
  const old = await prepareCreate(f, { name: made.name, initialHumans: [] });
  await preparedDaysAgo(old.messageId, 31);
  assert.equal((await humanRead(app.baseUrl, f, old.messageId)).state, "expired", "it reads as expired");

  const marked = await post(app.baseUrl, f, "owner", `${old.messageId}/mark-executed`, { result: { kind: "channel", id: made.id, name: made.name } });
  assert.equal(marked.status, 200, marked.text);
  assert.equal(marked.body.metadata.state, "executed");
  assert.equal((await cardRow(old.messageId)).state, "executed");
  const done = await humanRead(app.baseUrl, f, old.messageId);
  assert.equal(done.state, "executed", "and reads as done");
  assert.equal(done.result?.kind, "channel");
  assertServedKeysListed(done);
});

test("reconfirm: a card prepared 31 days ago is not re-opened; one prepared 29 days ago is, served with its deadline", async ({ app }) => {
  const f = await seedPro(app);
  const db = getDb();
  const oldCard = await prepareCreate(f, { name: `joint-old-${randomUUID().slice(0, 6)}`, initialHumans: [] });
  const recentCard = await prepareCreate(f, { name: `joint-recent-${randomUUID().slice(0, 6)}`, initialHumans: [] });
  // Cards a joint conversion left waiting for reconfirmation.
  await db.update(channels).set({ type: "joint" }).where(eq(channels.id, f.channel.id));
  const waiting = async (messageId: string, days: number) => {
    await db.update(actionCards).set({ freezeState: "reconfirm_required", conversionSourceChannelId: f.channel.id }).where(eq(actionCards.messageId, messageId));
    await db.update(messages).set({ actionMetadata: { ...await storedMetadata(messageId), state: "reconfirm_required" } }).where(eq(messages.id, messageId));
    return preparedDaysAgo(messageId, days);
  };

  await waiting(oldCard.messageId, 31);
  await assert.rejects(
    db.transaction((tx) => reconfirmActionCard(tx, { messageId: oldCard.messageId, userId: f.owner.id })),
    (err: unknown) => (err as { status?: number; code?: string }).status === 409 && (err as { code?: string }).code === ACTION_CARD_EXPIRED_ERROR_CODE,
  );
  const oldRow = await cardRow(oldCard.messageId);
  assert.equal(oldRow.freezeState, "reconfirm_required", "still waiting, not re-opened");
  assert.equal(oldRow.confirmationVersion, 1);
  assert.equal((await storedMetadata(oldCard.messageId)).state, "reconfirm_required");

  const recentExpiry = await waiting(recentCard.messageId, 29);
  const out = await db.transaction((tx) => reconfirmActionCard(tx, { messageId: recentCard.messageId, userId: f.owner.id }));
  assert.equal(out.metadata.state, "prepared");
  assert.equal("expiresAt" in out.metadata, false, "what reconfirm stores has no deadline");
  assert.equal((await cardRow(recentCard.messageId)).freezeState, "ready");
  // What the route answers with (routes/actions.ts): the stored card, served.
  const served = servedActionCardMetadata(out.metadata, out.card);
  assert.equal(served.expiresAt, recentExpiry);
  assert.equal(served.state, "prepared");
  assert.equal("expiresAt" in await storedMetadata(recentCard.messageId), false);
});

test("read: a card prepared 29 days ago is served prepared with its deadline; one prepared 31 days ago is served expired (to people, agents and broadcasts), and neither is written", async ({ app }) => {
  const f = await seedPro(app);
  const recent = await prepareCreate(f, { name: "read-recent", initialHumans: [] });
  const old = await prepareCreate(f, { name: "read-old", initialHumans: [] });
  const recentExpiry = await preparedDaysAgo(recent.messageId, 29);
  const oldExpiry = await preparedDaysAgo(old.messageId, 31);

  const recentRead = await humanRead(app.baseUrl, f, recent.messageId);
  assert.equal(recentRead.state, "prepared");
  assert.equal(recentRead.expiresAt, recentExpiry, "prepared-at plus 30 days");

  // An old client ignores expiresAt: the state alone draws the card ended.
  const oldRead = await humanRead(app.baseUrl, f, old.messageId);
  assert.equal(oldRead.state, "expired");
  assert.equal(oldRead.expiresAt, oldExpiry);
  assert.ok(oldRead.presentation?.card, "the card keeps its title and facts");

  // Its agent reads it expired too, without the card.
  const asAgent = await agentRead(app.baseUrl, f, old.messageId);
  assert.equal(asAgent.state, "expired");
  assert.equal(asAgent.expiresAt, oldExpiry);
  assert.equal(asAgent.presentation?.card, undefined);

  // A broadcast of the card serves it the same way.
  const before = f.emitted.length;
  await emitActionCardMessageUpdated(app.app.get("io") as never, { id: old.messageId });
  const update = f.emitted.slice(before).find((entry) => entry.event === "message:updated" && (entry.payload as { id?: string }).id === old.messageId);
  assert.ok(update, "the update was broadcast");
  const broadcast = (update.payload as { actionMetadata: ActionCardMetadata }).actionMetadata;
  assert.equal(broadcast.state, "expired");
  assert.equal(broadcast.expiresAt, oldExpiry);

  for (const served of [recentRead, oldRead, asAgent, broadcast]) assertServedKeysListed(served);

  // No events, no writes: both rows are as prepare left them.
  await assertStoredPrepared(recent.messageId);
  await assertStoredPrepared(old.messageId);
});

test("a question card prepared 31 days ago keeps its own deadline: served prepared with its own expiresAt, and answered", async ({ app }) => {
  const f = await seedPro(app);
  const prepared = await fetch(`${app.baseUrl}/internal/agent-api/prepare-action`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.agentKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      target: `#${f.channel.name}`,
      action: { type: "question:ask", to: `@${f.alice.name}`, questions: [{ id: "window", kind: "single", text: "Which window?", options: [{ value: "tue", label: "Tue" }, { value: "wed", label: "Wed" }] }] },
    }),
  });
  const text = await prepared.text();
  assert.equal(prepared.status, 201, text);
  const { messageId } = JSON.parse(text) as { messageId: string };
  // Its own expiresAt (7 days from prepare by default) is still ahead; only the 30-day rule would end it.
  await preparedDaysAgo(messageId, 31);
  const own = ((await storedMetadata(messageId)).action as QuestionAskAction).expiresAt!;
  const read = await humanRead(app.baseUrl, f, messageId);
  assert.equal(read.state, "prepared");
  assert.equal(read.expiresAt, new Date(own).toISOString(), "its own deadline, not prepared-at plus 30 days");

  const answered = await post(app.baseUrl, f, "alice", `${messageId}/execute`, { expectedState: "prepared", form: { id: "answers", values: { window: { selected: ["wed"] } } } });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.body.metadata.state, "executed");
});
