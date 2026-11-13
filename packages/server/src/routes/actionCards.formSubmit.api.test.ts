import { createApiTest } from "../test/integration/apiTest";
// form.v1 server side (S2, spec §3.4): POST /api/actions/:messageId/execute
// with `form`. No production type is a form card yet, so these tests make
// channel:create one through setActionCardFormHandlerForTest
// (test/actionCardFormFixture.ts) and run the whole flow: the card's forms and
// open_form button, the shared value checks and the handler's validate (422
// FORM_INVALID), execute in the execute transaction, submitted_input kept off
// the message metadata, broadcasts and agents, 409 ALREADY_EXECUTED vs the
// idempotent retry, FORM_REQUIRED for a client that does not know forms,
// retraction, funnel events, and requests without a form behaving exactly as
// before. Real-PostgreSQL races: actionCardFormSubmit.realPg.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { afterEach } from "vitest";
import {
  parseActionCardSpec,
  type ActionCardFormIssue,
  type ActionCardMetadata,
  type ActionCardPresentation,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channelHumans, messages, productEvents } from "../db/schema";
import * as channelService from "../services/channelService";
import { prepareActionCard, setBeforeActionCardExecutionLockForTest } from "../services/actionCardsService";
import { retractDelegatedMessage } from "../services/assistantSendAsOwnerService";
import { setActionCardFormHandlerForTest } from "../services/actionCardForms";
import {
  FORM, SENTINEL, barrier, cardRow, channelCreateFormHandler, channelsNamed, goodValues, msg, post, prepareCreate, seed, submit, type Fixture,
} from "../test/actionCardFormFixture";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

afterEach(() => {
  setActionCardFormHandlerForTest("channel:create", null);
  setActionCardFormHandlerForTest("integration:register_app", null);
  setBeforeActionCardExecutionLockForTest(null);
});

async function storedMetadata(messageId: string): Promise<ActionCardMetadata> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return row!.actionMetadata as ActionCardMetadata;
}

async function funnel(cardId: string) {
  const rows = await getDb().select().from(productEvents).where(eq(productEvents.subjectId, cardId));
  return rows.map((row) => ({ eventType: row.eventType, metadata: row.metadata as Record<string, unknown> }));
}

function assertPrepared(row: Awaited<ReturnType<typeof cardRow>>, label: string) {
  assert.equal(row.state, "prepared", `${label}: the card is still prepared`);
  assert.equal(row.submittedInput, null, `${label}: nothing was kept`);
  assert.equal(row.executedByUserId, null, `${label}: nobody executed it`);
}

function assertInvalid(res: Awaited<ReturnType<typeof post>>, issues: Array<{ field: string | null; code: string; params?: Record<string, unknown> }>, label: string) {
  assert.equal(res.status, 422, `${label}: ${res.text}`);
  assert.equal(res.body.errorCode, "FORM_INVALID", label);
  assert.equal(typeof res.body.error, "string", label);
  const got = (res.body.issues as ActionCardFormIssue[]).map((issue) => ({ field: issue.field, code: issue.code, ...(issue.message.params ? { params: issue.message.params } : {}) }));
  assert.deepEqual(got, issues, label);
  for (const issue of res.body.issues as ActionCardFormIssue[]) assert.equal(typeof issue.message.text.en, "string", `${label}: every issue has its message`);
  assert.equal(res.text.includes(SENTINEL), false, `${label}: a 422 never echoes a value`);
}

async function agentHistory(baseUrl: string, f: Fixture) {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${f.channel.name}`)}&limit=50&consume=false`, {
    headers: { Authorization: `Bearer ${f.agentKey}`, "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.text();
}

test("the migration added action_cards.submitted_input: nullable jsonb, NULL for a prepared card", async ({ app }) => {
  void app;
  const { rows } = await getDb().execute<{ data_type: string; is_nullable: string; column_default: string | null }>(sql`
    SELECT data_type, is_nullable, column_default FROM information_schema.columns
     WHERE table_name = 'action_cards' AND column_name = 'submitted_input'`);
  assert.deepEqual(rows, [{ data_type: "jsonb", is_nullable: "YES", column_default: null }]);
});

test("a form card carries its forms and an open_form button, and refuses a generic approve", async ({ app }) => {
  const f = await seed(app);
  channelCreateFormHandler();
  const card = await prepareCreate(f);
  const presentation = (await storedMetadata(card.messageId)).presentation as ActionCardPresentation;
  assert.equal(presentation.genericApprovalAllowed, false);
  assert.match(presentation.warning ?? "", /on the web to fill in its form/);
  const parsed = parseActionCardSpec(presentation.card, { mode: "emit" });
  assert.ok(parsed.ok, "the card with its forms passes the emit parse");
  assert.deepEqual(Object.keys(parsed.card.forms ?? {}), [FORM]);
  const buttons = Object.values(parsed.card.spec.elements).filter((node) => node.type === "Button");
  assert.deepEqual(buttons.map((node) => node.type === "Button" ? node.props.action : null), [{ kind: "open_form", form: FORM }]);
  const members = parsed.card.forms![FORM]!.fields.find((field) => field.name === "members");
  assert.deepEqual(members?.type === "MemberPicker" ? members.default : null, [{ kind: "user", id: f.bob.id, fallback: f.bob.id.slice(0, 8) }],
    "an agent's proposal is the form's default");
  assert.equal((await agentHistory(app.baseUrl, f)).includes(FORM), false, "an agent never sees the forms");
});

test("a valid form executes through the handler in the execute transaction; the values stay in submitted_input only", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  const card = await prepareCreate(f);
  const values = goodValues(f);
  const res = await submit(app.baseUrl, f, "alice", card.messageId, values);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(calls, { validate: 1, execute: 1 });

  const [created] = await channelsNamed(f.server.id, "launch-room");
  assert.ok(created, "the handler's channel exists");
  assert.equal(created.type, "private", "the person's choice, not the agent's proposal");
  const members = await getDb().select({ userId: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, created.id));
  assert.deepEqual(members.map((row) => row.userId).sort(), [f.alice.id, f.bob.id].sort());

  const row = await cardRow(card.messageId);
  assert.equal(row.state, "executed");
  assert.equal(row.executedByUserId, f.alice.id);
  assert.deepEqual(row.submittedInput, { form: FORM, values });
  assert.deepEqual(row.result, { kind: "channel", id: created.id, name: "launch-room" });

  const metadata = res.body.metadata as ActionCardMetadata;
  assert.equal(metadata.state, "executed");
  assert.equal(metadata.executedByUserId, f.alice.id);
  assert.deepEqual(metadata.result, { kind: "channel", id: created.id, name: "launch-room" });
  assert.ok(metadata.presentation?.card?.result, "the card shows its result tree");

  // The values (the note is in no result) are nowhere but action_cards.submitted_input.
  assert.equal(res.text.includes(SENTINEL), false, "not in the execute response");
  assert.equal(JSON.stringify(await storedMetadata(card.messageId)).includes(SENTINEL), false, "not in the message metadata");
  const updates = f.emitted.filter((event) => event.event === "message:updated");
  assert.ok(updates.length > 0, "the card was broadcast");
  assert.equal(JSON.stringify(f.emitted).includes(SENTINEL), false, "not in any broadcast");
  assert.equal(JSON.stringify(f.deliveries).includes(SENTINEL), false, "not in anything delivered to the agent");
  assert.equal((await agentHistory(app.baseUrl, f)).includes(SENTINEL), false, "not in the agent's history");
  assert.equal(JSON.stringify(await funnel(row.id)).includes(SENTINEL), false, "not in a funnel event");
  assert.deepEqual((await funnel(row.id)).map((event) => event.eventType).sort(), ["action_card.execute_attempt", "action_card.execute_success"]);
});

test("422 FORM_INVALID: required, too_long, invalid_option, wrong types, unknown field, unknown form, unstorable text; nothing runs", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  const card = await prepareCreate(f);
  const base = goodValues(f);
  const cases: Array<[string, Record<string, unknown>, Array<{ field: string | null; code: string; params?: Record<string, unknown> }>]> = [
    ["blank required text", { ...base, name: " 　\t" }, [{ field: "name", code: "required" }]],
    ["missing required select", (({ visibility: _v, ...rest }) => rest)(base), [{ field: "visibility", code: "required" }]],
    ["too long", { ...base, note: "x".repeat(41) }, [{ field: "note", code: "too_long", params: { max: 40 } }]],
    ["too many", { ...base, members: [randomUUID(), randomUUID(), randomUUID(), randomUUID()] }, [{ field: "members", code: "too_many", params: { max: 3 } }]],
    ["not an option", { ...base, visibility: "secret" }, [{ field: "visibility", code: "invalid_option" }]],
    ["toggle given a string", { ...base, announce: "yes" }, [{ field: "announce", code: "invalid_format" }]],
    ["picker given a string", { ...base, members: f.bob.id }, [{ field: "members", code: "invalid_format" }]],
    ["picker id not a lowercase uuid", { ...base, members: [f.bob.id.toUpperCase()] }, [{ field: "members", code: "invalid_format" }]],
    ["unknown field", { ...base, zeta: "x", extra: 1 }, [{ field: "extra", code: "invalid_format" }, { field: "zeta", code: "invalid_format" }]],
    ["NUL in text", { ...base, note: "a\u0000b" }, [{ field: "note", code: "invalid_format" }]],
    ["unpaired surrogate", { ...base, note: "a\ud800b" }, [{ field: "note", code: "invalid_format" }]],
  ];
  for (const [label, values, issues] of cases) {
    assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, values), issues, label);
  }
  assertInvalid(await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, { expectedState: "prepared", form: { id: "nope", values: base } }),
    [{ field: null, code: "invalid_format" }], "unknown form id");
  assert.deepEqual(calls, { validate: 0, execute: 0 }, "the handler never ran");
  assertPrepared(await cardRow(card.messageId), "after every refusal");
  assert.deepEqual(await channelsNamed(f.server.id, "launch-room"), []);
});

test("422 from the handler's validate: picker ids that do not exist or that this person may not choose", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  const card = await prepareCreate(f);
  const base = goodValues(f);
  assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { ...base, members: [randomUUID()] }), [{ field: "members", code: "not_found" }], "no such user");
  assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { ...base, members: [f.outsider.id] }), [{ field: "members", code: "not_allowed" }], "not on this server");
  assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { ...base, copyFrom: [f.hidden.id] }), [{ field: "copyFrom", code: "not_allowed" }], "a private channel alice cannot see");
  assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { ...base, copyFrom: [randomUUID()] }), [{ field: "copyFrom", code: "not_found" }], "no such channel");
  assert.deepEqual(calls, { validate: 4, execute: 0 });
  assertPrepared(await cardRow(card.messageId), "after the handler's refusals");

  // The same private channel is bob's to choose.
  await channelService.addHuman(f.channel.id, f.bob.id);
  const ok = await submit(app.baseUrl, f, "bob", card.messageId, { ...base, members: [], copyFrom: [f.hidden.id] });
  assert.equal(ok.status, 200, ok.text);
});

test("a 422 records execute_fail with error_class validation and no value; no attempt or success is left", async ({ app }) => {
  const f = await seed(app);
  channelCreateFormHandler();
  const card = await prepareCreate(f);
  assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { ...goodValues(f), name: "" }), [{ field: "name", code: "required" }], "required");
  const events = await funnel((await cardRow(card.messageId)).id);
  assert.deepEqual(events, [{
    eventType: "action_card.execute_fail",
    metadata: { action_type: "channel:create", error_class: "validation", error_code: "FORM_INVALID", http_status: 422 },
  }]);
  assert.deepEqual(f.deliveries.filter((d) => JSON.stringify(d.payload).includes("failed")), [], "a form's problems are not news for the preparer");
});

test("422 FORM_REQUIRED: a form card refuses execute and mark-executed without its form", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  const card = await prepareCreate(f);
  const bare = await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, { expectedState: "prepared" });
  assert.equal(bare.status, 422, bare.text);
  assert.deepEqual(bare.body, { error: bare.body.error, errorCode: "FORM_REQUIRED" });
  const marked = await post(app.baseUrl, f, "alice", `${card.messageId}/mark-executed`, { result: { kind: "channel", id: f.hidden.id, name: f.hidden.name } });
  assert.equal(marked.status, 422, marked.text);
  assert.equal(marked.body.errorCode, "FORM_REQUIRED");
  assert.deepEqual(calls, { validate: 0, execute: 0 });
  assertPrepared(await cardRow(card.messageId), "FORM_REQUIRED");
  assert.deepEqual(await channelsNamed(f.server.id, "launch-room"), [], "the built-in create never ran");
  const events = await funnel((await cardRow(card.messageId)).id);
  assert.deepEqual(events.map((event) => event.metadata), [{ action_type: "channel:create", error_class: "validation", error_code: "FORM_REQUIRED", http_status: 422 }]);
});

test("a one-click type turned form card: genericApprovalAllowed flips to false and execute without a form is FORM_REQUIRED", async ({ app }) => {
  const f = await seed(app);
  const action = { type: "integration:register_app" as const, name: "Form App", clientKey: `form-app-${randomUUID().slice(0, 6)}`, returnUrl: "https://example.com/callback", scopes: [] };
  const plain = await prepareActionCard({ serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id, action });
  assert.equal((await storedMetadata(plain.messageId)).presentation?.genericApprovalAllowed, true, "control: a one-click card allows a generic approve");

  setActionCardFormHandlerForTest("integration:register_app", {
    buildForm: () => ({ register: { title: msg("register.title", "Register"), submitLabel: msg("register.submit", "Register"), fields: [{ type: "TextInput", name: "label", label: msg("register.label", "Label"), maxLength: 40 }] } }),
    validate: async () => { throw new Error("not reached"); },
    execute: async () => { throw new Error("not reached"); },
  });
  const formCard = await prepareActionCard({ serverId: f.server.id, requesterAgentId: f.agent.id, targetChannelId: f.channel.id, action: { ...action, clientKey: `${action.clientKey}-2` } });
  const presentation = (await storedMetadata(formCard.messageId)).presentation!;
  assert.equal(presentation.genericApprovalAllowed, false);
  assert.match(presentation.warning ?? "", /^The requesting agent becomes the initial app owner\..* Open this card on the web to fill in its form\.$/);
  const parsed = parseActionCardSpec(presentation.card, { mode: "emit" });
  assert.ok(parsed.ok);
  assert.deepEqual(Object.values(parsed.card.spec.elements).flatMap((node) => node.type === "Button" ? [node.props.action] : []), [{ kind: "open_form", form: "register" }],
    "the execute button opens the form");
  const res = await post(app.baseUrl, f, "owner", `${formCard.messageId}/execute`, { expectedState: "prepared" });
  assert.equal(res.status, 422, res.text);
  assert.equal(res.body.errorCode, "FORM_REQUIRED");
  assertPrepared(await cardRow(formCard.messageId), "register_app form card");
});

test("409 ALREADY_EXECUTED for a second submitter and for the executor with other values; 200 for the executor's exact retry", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  const card = await prepareCreate(f);
  const values = goodValues(f);
  const first = await submit(app.baseUrl, f, "alice", card.messageId, values);
  assert.equal(first.status, 200, first.text);

  const second = await submit(app.baseUrl, f, "owner", card.messageId, values);
  assert.equal(second.status, 409, second.text);
  assert.equal(second.body.errorCode, "ALREADY_EXECUTED");
  assert.equal(typeof second.body.error, "string");
  assert.equal(second.body.metadata.state, "executed");
  assert.equal(second.body.metadata.executedByUserId, f.alice.id, "the second submitter learns who did");
  assert.deepEqual(second.body.metadata.result, first.body.metadata.result);
  assert.equal(second.text.includes(SENTINEL), false, "the 409 never carries the first submitter's values");

  const other = await submit(app.baseUrl, f, "alice", card.messageId, { ...values, note: "changed my mind" });
  assert.equal(other.status, 409, other.text);
  assert.equal(other.body.errorCode, "ALREADY_EXECUTED");

  // The same values in another key order is the same submission (canonical JSON).
  const reordered = Object.fromEntries(Object.entries(values).reverse());
  const retry = await submit(app.baseUrl, f, "alice", card.messageId, reordered);
  assert.equal(retry.status, 200, retry.text);
  assert.deepEqual(retry.body, first.body, "the retry answers with the card as executed");
  const reorderedPicker = await submit(app.baseUrl, f, "alice", card.messageId, { ...values, members: [...(values.members as string[]), f.alice.id] });
  assert.equal(reorderedPicker.status, 409, "different picker ids are different values");

  assert.deepEqual(calls, { validate: 1, execute: 1 }, "it ran once");
  assert.equal((await channelsNamed(f.server.id, "launch-room")).length, 1);
  assert.deepEqual((await cardRow(card.messageId)).submittedInput, { form: FORM, values }, "the stored values are the first ones");
});

test("concurrent submissions: exactly one executes; the other is 409, or the idempotent 200 for the same person and values", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  // Both requests pass the preflight (card prepared) before either takes the
  // card's lock, so the loser meets the executed card inside its transaction.

  const card = await prepareCreate(f);
  setBeforeActionCardExecutionLockForTest(barrier(2));
  const raced = await Promise.all([submit(app.baseUrl, f, "alice", card.messageId, goodValues(f)), submit(app.baseUrl, f, "owner", card.messageId, goodValues(f))]);
  setBeforeActionCardExecutionLockForTest(null);
  assert.deepEqual(raced.map((res) => res.status).sort(), [200, 409], raced.map((res) => res.text).join("\n"));
  assert.equal(raced.find((res) => res.status === 409)!.body.errorCode, "ALREADY_EXECUTED");
  const winner = raced.find((res) => res.status === 200)!.body.metadata.executedByUserId;
  assert.equal((await cardRow(card.messageId)).executedByUserId, winner);
  assert.equal((await channelsNamed(f.server.id, "launch-room")).length, 1);
  const replies = f.deliveries.filter((d) => JSON.stringify(d.payload).includes(card.messageId.slice(0, 8)));
  assert.equal(replies.filter((d) => JSON.stringify(d.payload).includes("failed")).length, 0, "the loser is no failure for the preparer");

  const again = await prepareCreate(f, { name: "second-room" });
  const same = { ...goodValues(f), name: "second-room" };
  setBeforeActionCardExecutionLockForTest(barrier(2));
  const retried = await Promise.all([submit(app.baseUrl, f, "alice", again.messageId, same), submit(app.baseUrl, f, "alice", again.messageId, same)]);
  setBeforeActionCardExecutionLockForTest(null);
  assert.deepEqual(retried.map((res) => res.status), [200, 200], retried.map((res) => res.text).join("\n"));
  assert.equal((await channelsNamed(f.server.id, "second-room")).length, 1);
  assert.deepEqual(calls, { validate: 2, execute: 2 }, "one execution per card");
});

test("versions, frozen and state checks behave as today with a form", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler();
  const card = await prepareCreate(f);
  const stale = await submit(app.baseUrl, f, "alice", card.messageId, goodValues(f), { expectedConfirmationVersion: 2 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.body.errorCode, "CONFIRMATION_VERSION_MISMATCH");

  await getDb().update(actionCards).set({ freezeState: "frozen" }).where(eq(actionCards.messageId, card.messageId));
  const frozen = await submit(app.baseUrl, f, "alice", card.messageId, goodValues(f));
  assert.equal(frozen.status, 409, frozen.text);
  assert.equal(frozen.body.errorCode, "action_card_conversion_frozen");
  await getDb().update(actionCards).set({ freezeState: "reconfirm_required" }).where(eq(actionCards.messageId, card.messageId));
  const reconfirm = await submit(app.baseUrl, f, "alice", card.messageId, goodValues(f));
  assert.equal(reconfirm.status, 409, reconfirm.text);
  assert.equal(reconfirm.body.errorCode, "action_card_reconfirmation_required");

  assert.deepEqual(calls, { validate: 0, execute: 0 });
  assertPrepared(await cardRow(card.messageId), "stale / frozen");
});

test("execute body: a malformed form is 400 before anything else", async ({ app }) => {
  const f = await seed(app);
  channelCreateFormHandler();
  const card = await prepareCreate(f);
  for (const [label, form] of [
    ["an unknown key", { id: FORM, values: {}, extra: true }],
    ["no values", { id: FORM }],
    ["values an array", { id: FORM, values: [] }],
    ["id not a string", { id: 3, values: {} }],
    ["a string", "create_channel"],
    ["null", null],
  ] as const) {
    const res = await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, { expectedState: "prepared", form });
    assert.equal(res.status, 400, `${label}: ${res.text}`);
    assert.equal(res.body.errorCode, "INVALID_FORM_SUBMISSION", label);
  }
  assertPrepared(await cardRow(card.messageId), "malformed bodies");
  assert.deepEqual(await funnel((await cardRow(card.messageId)).id), [], "a malformed body is no attempt");
});

test("a handler that throws after writing rolls everything back", async ({ app }) => {
  const f = await seed(app);
  const calls = channelCreateFormHandler({ failAfterCreate: true });
  const card = await prepareCreate(f);
  const res = await submit(app.baseUrl, f, "alice", card.messageId, goodValues(f));
  assert.equal(res.status, 500, res.text);
  assert.equal(calls.execute, 1);
  assert.deepEqual(await channelsNamed(f.server.id, "launch-room"), [], "the handler's write rolled back");
  assertPrepared(await cardRow(card.messageId), "after the handler threw");
});

test("without a form, a card that is not a form card executes exactly as before; a form sent to it names no form it has", async ({ app }) => {
  const f = await seed(app);
  // No handler: channel:create is today's dialog-backed card, executed inline.
  const card = await prepareCreate(f, { name: "plain-room", visibility: "public" });
  const presentation = (await storedMetadata(card.messageId)).presentation!;
  assert.equal(presentation.card?.forms, undefined);
  assert.equal(presentation.warning, undefined);

  assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { name: "plain-room" }), [{ field: null, code: "invalid_format" }], "a form for a card with none");
  assertPrepared(await cardRow(card.messageId), "a form for a card with none");

  const res = await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, { expectedState: "prepared" });
  assert.equal(res.status, 200, res.text);
  assert.equal((await channelsNamed(f.server.id, "plain-room")).length, 1);
  assert.equal((await cardRow(card.messageId)).submittedInput, null, "no values without a form");

  // Executed: today's answers to a request without a form.
  const stale = await post(app.baseUrl, f, "owner", `${card.messageId}/execute`, { expectedState: "prepared" });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.body.errorCode, "STATE_MISMATCH");
  const replay = await post(app.baseUrl, f, "owner", `${card.messageId}/execute`, {});
  assert.equal(replay.status, 200, replay.text);
  assert.deepEqual(replay.body, res.body, "the idempotent replay answers with the card");
  // A form on it, executed: the 409, not the silent replay.
  const formOnExecuted = await submit(app.baseUrl, f, "alice", card.messageId, { name: "plain-room" });
  assert.equal(formOnExecuted.status, 409, formOnExecuted.text);
  assert.equal(formOnExecuted.body.errorCode, "ALREADY_EXECUTED");
});

test("retracting the carrier clears the card's submitted values in the same transaction", async ({ app }) => {
  const f = await seed(app);
  channelCreateFormHandler();
  const kept = await prepareCreate(f);
  assert.equal((await submit(app.baseUrl, f, "alice", kept.messageId, goodValues(f))).status, 200);
  // Today's carriers are agent-sent and so not retractable (RFC 077 retracts
  // what an assistant sent for its owner): stand a card on a delegated message.
  const [delegated] = await getDb().insert(messages).values({
    channelId: f.channel.id, senderType: "user", senderId: f.owner.id, content: "sent for me", delegatedByAgentId: f.agent.id,
  }).returning();
  const values = { form: FORM, values: { name: "x", note: SENTINEL } };
  await getDb().insert(actionCards).values({
    serverId: f.server.id, messageId: delegated!.id, requesterAgentId: f.agent.id, actionType: "channel:create",
    payload: { type: "channel:create", name: "x" }, state: "executed", submittedInput: values,
  });
  const out = await retractDelegatedMessage({ io: app.app.get("io"), serverId: f.server.id, userId: f.owner.id, messageId: delegated!.id });
  assert.ok(out.deletedAt);
  assert.equal((await cardRow(delegated!.id)).submittedInput, null, "the retracted carrier's values are gone");
  assert.deepEqual((await cardRow(kept.messageId)).submittedInput, { form: FORM, values: goodValues(f) }, "another card keeps its own");
});

test("a form card whose forms fail the emit parse has no card and refuses every submission (fail closed)", async ({ app }) => {
  const f = await seed(app);
  const warn = console.warn;
  console.warn = () => {};
  try {
    setActionCardFormHandlerForTest("channel:create", {
      buildForm: () => ({ [FORM]: { title: msg("form.title", "T"), submitLabel: msg("form.submit", "S"), fields: [{ type: "TextInput", name: "Bad Name", label: msg("form.name", "N"), maxLength: 10 }] } }),
      validate: async () => { throw new Error("not reached"); },
      execute: async () => { throw new Error("not reached"); },
    });
    const card = await prepareCreate(f);
    const presentation = (await storedMetadata(card.messageId)).presentation!;
    assert.equal(presentation.card, undefined, "the card is left out");
    assert.equal(presentation.genericApprovalAllowed, false, "and still refuses a generic approve");
    assertInvalid(await submit(app.baseUrl, f, "alice", card.messageId, { "Bad Name": "x" }), [{ field: null, code: "invalid_format" }], "no form the card has");
    const bare = await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, { expectedState: "prepared" });
    assert.equal(bare.body.errorCode, "FORM_REQUIRED", bare.text);
    assertPrepared(await cardRow(card.messageId), "fail closed");
  } finally {
    console.warn = warn;
  }
});
