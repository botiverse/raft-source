import { createApiTest } from "../test/integration/apiTest";
// F1: a `feedback:submit` card is a form card (services/feedbackCardForm.ts).
// Its form is sent with POST /api/actions/:messageId/execute and `form`, and
// files the feedback exactly as the card's dialog does (POST
// /api/product-feedback with action_card_message_id): one Hands request with
// the same fields, the same result on the card, the same broadcast and the
// same reply to the agent. The S2 rules hold (422 FORM_INVALID before Hands,
// 409 ALREADY_EXECUTED except the sender's exact retry, FORM_REQUIRED for a
// generic approve, the values only in action_cards.submitted_input), and a
// failed Hands call leaves the card waiting and the agent untold. The ticket
// carries the client the form was sent from, as that client's own dialog or
// page send would (feedbackFormMetadata), read from the request's headers and
// the account, never from the body. The form spends the dialog's per-person
// feedback budget (the limiter tests at the end).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { afterEach } from "vitest";
import { FEEDBACK_SUBMIT_FORM_ID, type ActionCardMetadata, type ActionCardPresentation } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channels, messages, productEvents, users } from "../db/schema";
import { prepareActionCard, setBeforeActionCardExecutionLockForTest } from "../services/actionCardsService";
import { setActionCardFormHandlerForTest } from "../services/actionCardForms";
import { agentFeedbackCardSubmissionId } from "../services/productFeedbackService";
import {
  barrier, cardRow, channelCreateFormHandler, goodValues, headers, post, prepareCreate, seed, submit, type Fixture, type Who,
} from "../test/actionCardFormFixture";
import { HANDS_TICKET_ID, filedTickets, multipartField, withHands, withHandsFeedbackConfigured, type CapturedRequest } from "../test/handsFeedbackStub";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

afterEach(() => {
  setBeforeActionCardExecutionLockForTest(null);
  setActionCardFormHandlerForTest("channel:create", null);
});

const DRAFT = "Agent draft: pinned threads should survive a reload.";
/** The sender's edit: it may only reach Hands and action_cards.submitted_input. */
const EDITED = "Pinned threads vanish-5d1c from my sidebar after every reload.";

/** Prepared where Hands feedback is configured: elsewhere prepare refuses a feedback card. */
async function prepareFeedback(f: Fixture) {
  return withHandsFeedbackConfigured(() => prepareActionCard({
    serverId: f.server.id,
    requesterAgentId: f.agent.id,
    targetChannelId: f.channel.id,
    action: { type: "feedback:submit", feedbackType: "idea", message: DRAFT, draftHint: "You hit this twice today." },
  }));
}

const sendForm = (baseUrl: string, f: Fixture, who: Who, messageId: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}, client: Record<string, string> = {}) =>
  post(baseUrl, f, who, `${messageId}/execute`, { expectedState: "prepared", expectedConfirmationVersion: 1, form: { id: FEEDBACK_SUBMIT_FORM_ID, values }, ...extra }, client);

/**
 * The card's dialog, as the web sends it (FeedbackCardDialog: no client
 * metadata in a browser), or with a client's own header and metadata.
 */
async function sendDialog(baseUrl: string, f: Fixture, who: Who, messageId: string, fields: { type: string; message: string }, client: { headers: Record<string, string>; metadata: Record<string, string> } | null = null) {
  const form = new FormData();
  form.set("type", fields.type);
  form.set("message", fields.message);
  if (client) form.set("metadata", JSON.stringify(client.metadata));
  form.set("submission_id", randomUUID());
  form.set("may_contact", "false");
  form.set("action_card_message_id", messageId);
  form.set("expected_confirmation_version", "1");
  const { "Content-Type": _json, ...auth } = headers(f, who);
  const res = await fetch(`${baseUrl}/api/product-feedback`, { method: "POST", headers: { ...auth, ...client?.headers }, body: form });
  return { status: res.status, text: await res.text() };
}

/** The App's own request headers (Lagoon, #proj-mobile): the platform, and its User-Agent. */
const APP_CLIENTS = {
  android: { "X-Raft-Client-Platform": "android", "User-Agent": "Raft/1.13.0+456 (Android 14; release) Mobile" },
  iPhone: { "X-Raft-Client-Platform": "ios", "User-Agent": "Raft/1.13.0+456 (iPhone; iOS 18.1; release) Mobile" },
  iPad: { "X-Raft-Client-Platform": "ios", "User-Agent": "Raft/1.13.0+456 (iPad; iPadOS 18.1; release) Mobile" },
} as const;

/** The ticket's metadata without what every card send adds: the client's facts. */
function clientFacts(metadata: Record<string, unknown>): Record<string, unknown> {
  const { surface: _surface, feedback_type: _type, contact_consent: _contact, reporter_attribution: _attribution, ...facts } = metadata;
  return facts;
}
const WEB = { product_type: "web", client_kind: "web", platform: "web" };

async function storedMetadata(messageId: string): Promise<ActionCardMetadata> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return row!.actionMetadata as ActionCardMetadata;
}

async function funnel(cardId: string) {
  const rows = await getDb().select().from(productEvents).where(eq(productEvents.subjectId, cardId));
  return rows.map((row) => ({ eventType: row.eventType, metadata: row.metadata as Record<string, unknown> }));
}

/** The agent's result replies in the card's thread. */
async function resultReplies(messageId: string): Promise<string[]> {
  const [thread] = await getDb().select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId)));
  if (!thread) return [];
  const rows = await getDb().select().from(messages).where(and(eq(messages.channelId, thread.id), eq(messages.systemSubtype, "action_card.result_reply")));
  return rows.map((row) => row.content);
}

async function agentHistory(baseUrl: string, f: Fixture) {
  const res = await fetch(`${baseUrl}/internal/agent-api/history?channel=${encodeURIComponent(`#${f.channel.name}`)}&limit=50&consume=false`, {
    headers: { Authorization: `Bearer ${f.agentKey}`, "Content-Type": "application/json" },
  });
  assert.equal(res.status, 200, await res.clone().text());
  return res.text();
}

/** What Hands received for one ticket, minus the request's own framing. */
function ticketFields(request: CapturedRequest) {
  return {
    url: request.url,
    reporter: request.headers["x-hands-reporter-id"],
    message: multipartField(request, "message"),
    kind: multipartField(request, "kind"),
    contact: multipartField(request, "contact"),
    metadata: JSON.parse(multipartField(request, "metadata") ?? "{}") as Record<string, unknown>,
  };
}

test("a feedback card carries the dialog's form; a generic approve is refused and an agent never sees the form", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareFeedback(f);
  const presentation = (await storedMetadata(card.messageId)).presentation as ActionCardPresentation;
  assert.equal(presentation.genericApprovalAllowed, false);
  assert.deepEqual(Object.keys(presentation.card?.forms ?? {}), [FEEDBACK_SUBMIT_FORM_ID]);
  const button = presentation.card?.spec.elements.submitFeedback;
  assert.deepEqual(button?.type === "Button" ? button.props.action : null, { kind: "open_form", form: FEEDBACK_SUBMIT_FORM_ID });

  await withHands(async (requests) => {
    const generic = await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, { expectedState: "prepared", expectedConfirmationVersion: 1 });
    assert.equal(generic.status, 422, generic.text);
    assert.equal(generic.body.errorCode, "FORM_REQUIRED");
    const marked = await post(app.baseUrl, f, "alice", `${card.messageId}/mark-executed`, { result: { kind: "product-feedback", ticketId: randomUUID(), reference: null } });
    assert.equal(marked.status, 409, marked.text);
    assert.equal(marked.body.errorCode, "DIALOG_REQUIRED");
    assert.equal(filedTickets(requests).length, 0);
  });
  assert.equal((await cardRow(card.messageId)).state, "prepared");
  const history = await agentHistory(app.baseUrl, f);
  assert.ok(history.includes(card.messageId), "the agent reads the card message");
  assert.equal(history.includes("open_form"), false, "but not its card");
  assert.equal(history.includes("actionCard.feedback.form.description"), false);
});

test("the form files the feedback exactly as the dialog does: the same Hands request, card result, broadcast and reply", async ({ app }) => {
  const f = await seed(app);
  const viaForm = await prepareFeedback(f);
  const viaDialog = await prepareFeedback(f);
  const values = { type: "problem", message: `  ${EDITED}\n` };

  await withHands(async (requests) => {
    const formRes = await sendForm(app.baseUrl, f, "alice", viaForm.messageId, values);
    assert.equal(formRes.status, 200, formRes.text);
    assert.equal(formRes.text.includes(EDITED), false, "the response carries the result, not the text");
    const dialogRes = await sendDialog(app.baseUrl, f, "alice", viaDialog.messageId, { type: "problem", message: EDITED });
    assert.equal(dialogRes.status, 201, dialogRes.text);

    const [fromForm, fromDialog] = filedTickets(requests);
    assert.equal(filedTickets(requests).length, 2, "one ticket each");
    assert.equal(multipartField(fromForm!, "submission_id"), agentFeedbackCardSubmissionId(viaForm.messageId, f.alice.id));
    assert.equal(multipartField(fromDialog!, "submission_id"), agentFeedbackCardSubmissionId(viaDialog.messageId, f.alice.id));
    assert.deepEqual(ticketFields(fromForm!), ticketFields(fromDialog!), "the same request but for the card's submission_id");
    const filed = ticketFields(fromForm!);
    assert.equal(filed.message, EDITED, "the sender's text, trimmed as the dialog's");
    assert.equal(filed.kind, "bug");
    assert.equal(filed.contact, undefined, "no contact details");
    assert.deepEqual(filed.metadata, {
      product_type: "web",
      client_kind: "web",
      platform: "web",
      surface: "agent.feedback_card",
      feedback_type: "problem",
      contact_consent: false,
      reporter_attribution: {
        v: 1,
        server_id: f.server.id,
        server_slug: f.server.slug,
        user_id: f.alice.id,
        handle: f.alice.name,
        source: "agent_card",
        drafted_by_agent_id: f.agent.id,
      },
    });
    for (const request of requests) assert.equal(request.body.includes(DRAFT), false, "the replaced draft never reaches Hands");
  });

  const [formRow, dialogRow] = [await cardRow(viaForm.messageId), await cardRow(viaDialog.messageId)];
  for (const row of [formRow, dialogRow]) {
    assert.equal(row.state, "executed");
    assert.equal(row.executedByUserId, f.alice.id);
    // `source` (S0.3): the Hands app it was filed into, recorded on both paths by sendFeedbackCard.
    assert.deepEqual(row.result, { kind: "product-feedback", ticketId: HANDS_TICKET_ID, reference: "FB-7", source: "web" });
  }
  assert.deepEqual(formRow.submittedInput, { form: FEEDBACK_SUBMIT_FORM_ID, values }, "the form's values as sent");
  assert.equal(dialogRow.submittedInput, null);

  const [formMeta, dialogMeta] = [await storedMetadata(viaForm.messageId), await storedMetadata(viaDialog.messageId)];
  assert.deepEqual(formMeta.result, dialogMeta.result);
  assert.deepEqual(formMeta.presentation?.card?.result, dialogMeta.presentation?.card?.result, "the same result line");
  assert.equal(formMeta.executedByUserId, dialogMeta.executedByUserId);

  for (const card of [viaForm, viaDialog]) {
    assert.ok(f.emitted.some((event) => event.event === "message:updated" && JSON.stringify(event.payload).includes(card.messageId)), "the card was broadcast");
  }
  const [formReplies, dialogReplies] = [await resultReplies(viaForm.messageId), await resultReplies(viaDialog.messageId)];
  assert.equal(formReplies.length, 1);
  assert.match(formReplies[0]!, /Result: feedback submitted\./);
  const sameButCard = (replies: string[]) => replies.map((reply) => reply.replace(/`[0-9a-f]{8}`/, "`<card>`"));
  assert.deepEqual(sameButCard(formReplies), sameButCard(dialogReplies), "the agent is told the same, but for the card's short id");

  // The sender's text: only in action_cards.submitted_input (and Hands).
  assert.equal(JSON.stringify(formMeta).includes(EDITED), false, "not in the message metadata");
  assert.equal(JSON.stringify(f.emitted).includes(EDITED), false, "not in any broadcast");
  assert.equal(JSON.stringify(f.deliveries).includes(EDITED), false, "not in anything delivered to the agent");
  assert.equal((await agentHistory(app.baseUrl, f)).includes(EDITED), false, "not in the agent's history");
  assert.equal(JSON.stringify(await funnel(formRow.id)).includes(EDITED), false, "not in a funnel event");
  // The one difference: the form goes through execute, which also records its attempt.
  assert.deepEqual((await funnel(formRow.id)).map((event) => event.eventType).sort(), ["action_card.execute_attempt", "action_card.execute_success"]);
  assert.deepEqual((await funnel(dialogRow.id)).map((event) => event.eventType), ["action_card.execute_success"]);
});

test("from the App, the form files what the App's page send of the card files: its kind, version and the account's language", async ({ app }) => {
  const f = await seed(app);
  await getDb().update(users).set({ displayLanguage: "zh-cn" }).where(eq(users.id, f.alice.id));
  const fields = { type: "problem", message: EDITED };

  await withHands(async (requests) => {
    for (const [label, client] of Object.entries(APP_CLIENTS)) {
      const kind = client["X-Raft-Client-Platform"];
      const [viaForm, viaPage] = [await prepareFeedback(f), await prepareFeedback(f)];
      const before = filedTickets(requests).length;
      const formRes = await sendForm(app.baseUrl, f, "alice", viaForm.messageId, fields, {}, client);
      assert.equal(formRes.status, 200, `${label}: ${formRes.text}`);
      // The App's feedback page (standalone/main.tsx): X-Raft-Client-Kind and the host's facts.
      const pageRes = await sendDialog(app.baseUrl, f, "alice", viaPage.messageId, fields, {
        headers: { "X-Raft-Client-Kind": kind },
        metadata: { client_kind: kind, platform: kind, client_version: "1.13.0", locale: "zh-CN" },
      });
      assert.equal(pageRes.status, 201, `${label}: ${pageRes.text}`);

      const [fromForm, fromPage] = filedTickets(requests).slice(before);
      assert.deepEqual(ticketFields(fromForm!), ticketFields(fromPage!), `${label}: the same request as the page's`);
      assert.deepEqual(clientFacts(ticketFields(fromForm!).metadata), {
        product_type: kind,
        client_kind: kind,
        platform: kind,
        client_version: "1.13.0",
        locale: "zh-CN",
      }, label);
      // The App files into its own app, and the card says so (per-app routing: productFeedback.multiApp.api.test.ts).
      for (const card of [viaForm, viaPage]) {
        assert.deepEqual((await storedMetadata(card.messageId)).result, { kind: "product-feedback", ticketId: HANDS_TICKET_ID, reference: "FB-7", source: kind }, label);
      }
    }
  });
});

test("the web stays web; the desktop app is its dialog's; a User-Agent without a version files the App without one; the body never names the client", async ({ app }) => {
  const f = await seed(app);
  await getDb().update(users).set({ displayLanguage: "ja" }).where(eq(users.id, f.alice.id));
  const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
  const iPhoneSafari = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
  const electron = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Raft/0.1.22 Chrome/141.0.0.0 Electron/38.0.0 Safari/537.36";
  const bodyClaims = {
    client: { platform: "ios", raftVersion: "9.9.9" },
    metadata: { client_kind: "ios", platform: "ios", client_version: "9.9.9", locale: "en" },
    client_kind: "ios",
    platform: "ios",
    client_version: "9.9.9",
    locale: "en",
  };
  const cases: Array<[string, Record<string, string>, Record<string, unknown>, Record<string, unknown>]> = [
    ["a browser", { "X-Raft-Client-Platform": "browser", "User-Agent": chrome }, {}, WEB],
    ["a phone's browser", { "X-Raft-Client-Platform": "browser", "User-Agent": iPhoneSafari }, {}, WEB],
    ["the installed web app", { "X-Raft-Client-Platform": "pwa", "User-Agent": APP_CLIENTS.android["User-Agent"] }, {}, WEB],
    ["an unknown platform", { "X-Raft-Client-Platform": "toaster", "User-Agent": APP_CLIENTS.android["User-Agent"] }, {}, WEB],
    ["HarmonyOS, not checked yet", { "X-Raft-Client-Platform": "harmonyos", "User-Agent": "Raft/1.13.0+456 (HarmonyOS 5.0; release) Mobile" }, {}, WEB],
    ["the desktop app", { "X-Raft-Client-Platform": "desktop_app", "User-Agent": electron }, {}, { ...WEB, client_version: "Raft Desktop 0.1.22" }],
    ["the desktop app, no version", { "X-Raft-Client-Platform": "desktop_app", "User-Agent": chrome }, {}, { ...WEB, client_version: "Raft Desktop" }],
    ["the App, a garbage User-Agent", { "X-Raft-Client-Platform": "android", "User-Agent": "Raft/<script>alert(1)</script> curl/8.7.1" }, {}, { product_type: "android", client_kind: "android", platform: "android", locale: "ja" }],
    ["no header, the body claiming the App", {}, bodyClaims, WEB],
    ["the Android App, the body claiming iOS", APP_CLIENTS.android, bodyClaims, { product_type: "android", client_kind: "android", platform: "android", client_version: "1.13.0", locale: "ja" }],
  ];

  await withHands(async (requests) => {
    for (const [label, client, extra, facts] of cases) {
      const card = await prepareFeedback(f);
      const before = filedTickets(requests).length;
      const res = await sendForm(app.baseUrl, f, "alice", card.messageId, { type: "idea", message: EDITED }, extra, client);
      assert.equal(res.status, 200, `${label}: ${res.text}`);
      const filed = filedTickets(requests).slice(before);
      assert.equal(filed.length, 1, label);
      assert.deepEqual(clientFacts(ticketFields(filed[0]!).metadata), facts, label);
      assert.equal(filed[0]!.body.includes("9.9.9"), false, `${label}: nothing from the body`);
    }
  });
});

test("422 FORM_INVALID before Hands: blank, too long, not an option, unknown field, wrong type, unknown form", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareFeedback(f);
  const cases: Array<[string, { form?: string; values: Record<string, unknown> }, Array<{ field: string | null; code: string; params?: Record<string, unknown> }>]> = [
    ["blank message", { values: { type: "idea", message: " \n　" } }, [{ field: "message", code: "required" }]],
    ["missing type", { values: { message: EDITED } }, [{ field: "type", code: "required" }]],
    ["past the form's 8000 code points", { values: { type: "idea", message: "a".repeat(8001) } }, [{ field: "message", code: "too_long", params: { max: 8000 } }]],
    // 6000 code points, 12,000 UTF-16 units: past the dialog's 10,000.
    ["past the dialog's UTF-16 limit", { values: { type: "idea", message: "😀".repeat(6000) } }, [{ field: "message", code: "too_long", params: { max: 8000 } }]],
    ["not an option", { values: { type: "bug", message: EDITED } }, [{ field: "type", code: "invalid_option" }]],
    ["wrong type", { values: { type: "idea", message: 42 } }, [{ field: "message", code: "invalid_format" }]],
    ["unknown field", { values: { type: "idea", message: EDITED, contact: "me@example.com" } }, [{ field: "contact", code: "invalid_format" }]],
    ["unknown form", { form: "dialog", values: { type: "idea", message: EDITED } }, [{ field: null, code: "invalid_format" }]],
  ];
  await withHands(async (requests) => {
    for (const [label, { form, values }, issues] of cases) {
      const res = await post(app.baseUrl, f, "alice", `${card.messageId}/execute`, {
        expectedState: "prepared", expectedConfirmationVersion: 1, form: { id: form ?? FEEDBACK_SUBMIT_FORM_ID, values },
      });
      assert.equal(res.status, 422, `${label}: ${res.text}`);
      assert.equal(res.body.errorCode, "FORM_INVALID", label);
      assert.deepEqual(res.body.issues.map((issue) => ({ field: issue.field, code: issue.code, ...(issue.message.params ? { params: issue.message.params } : {}) })), issues, label);
      assert.equal(res.text.includes(EDITED), false, `${label}: a 422 never echoes a value`);
    }
    assert.equal(requests.length, 0, "nothing reached Hands");
  });
  const row = await cardRow(card.messageId);
  assert.equal(row.state, "prepared");
  assert.equal(row.submittedInput, null);
  const events = await funnel(row.id);
  assert.equal(events.length, cases.length);
  for (const event of events) {
    assert.deepEqual(event, { eventType: "action_card.execute_fail", metadata: { action_type: "feedback:submit", error_class: "validation", error_code: "FORM_INVALID", http_status: 422 } });
  }
  assert.deepEqual(await resultReplies(card.messageId), [], "not news for the agent");
});

test("the sender's exact retry is 200 with no second ticket; other values or another person get 409 ALREADY_EXECUTED", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareFeedback(f);
  const values = { type: "problem", message: EDITED };
  await withHands(async (requests) => {
    const first = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(first.status, 200, first.text);
    const retry = await sendForm(app.baseUrl, f, "alice", card.messageId, { message: EDITED, type: "problem" });
    assert.equal(retry.status, 200, retry.text);
    assert.deepEqual(retry.body, first.body, "the same card");

    const edited = await sendForm(app.baseUrl, f, "alice", card.messageId, { ...values, message: `${EDITED} Also on mobile.` });
    assert.equal(edited.status, 409, edited.text);
    assert.equal(edited.body.errorCode, "ALREADY_EXECUTED");
    assert.equal(edited.body.metadata.executedByUserId, f.alice.id);
    const other = await sendForm(app.baseUrl, f, "owner", card.messageId, values);
    assert.equal(other.status, 409, other.text);
    assert.equal(other.body.errorCode, "ALREADY_EXECUTED");
    // The dialog refuses it too, before Hands.
    const dialog = await sendDialog(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(dialog.status, 409, dialog.text);
    assert.equal(JSON.parse(dialog.text).code, "STATE_MISMATCH");

    assert.equal(filedTickets(requests).length, 1, "one ticket");
  });
  assert.deepEqual((await cardRow(card.messageId)).submittedInput, { form: FEEDBACK_SUBMIT_FORM_ID, values });
});

test("refusals: a stale version, a non-member; Hands down leaves the card waiting and the agent untold; Hands' 'already filed' completes it", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareFeedback(f);
  const values = { type: "idea", message: EDITED };

  await withHands(async (requests) => {
    const stale = await sendForm(app.baseUrl, f, "alice", card.messageId, values, { expectedConfirmationVersion: 7 });
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.errorCode, "CONFIRMATION_VERSION_MISMATCH");

    // bob is on the server but not in the card's channel: he may not operate it.
    const notInChannel = await sendForm(app.baseUrl, f, "bob", card.messageId, values);
    assert.equal(notInChannel.status, 403, notInChannel.text);

    assert.equal(filedTickets(requests).length, 0, "no refused send reached Hands");
  });

  await withHands(async () => {
    const down = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(down.status, 503, down.text);
    assert.equal(down.body.errorCode, "feedback_service_unavailable");
  }, () => ({ status: 503, body: { error: "maintenance" } }));
  const waiting = await cardRow(card.messageId);
  assert.equal(waiting.state, "prepared", "the card still waits");
  assert.equal(waiting.submittedInput, null);
  assert.deepEqual(await resultReplies(card.messageId), [], "the agent is not told about a failed send, as with the dialog");
  // A refusal in the delivery step is an execute_fail like any refused
  // execute; the stale version and bob were refused before the funnel.
  assert.deepEqual((await funnel(waiting.id)).map((event) => [event.eventType, event.metadata.error_code, event.metadata.http_status]).sort(), [
    ["action_card.execute_fail", "feedback_service_unavailable", 503],
  ]);

  // Hands' documented reply to a resend with other content: this person filed
  // the card before (a lost response); it completes without a ticket.
  await withHands(async () => {
    const already = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(already.status, 200, already.text);
    assert.deepEqual(already.body.metadata.result, { kind: "product-feedback", ticketId: null, reference: null, source: "web" });
  }, () => ({ status: 409, body: { error: "submission_id already used with a different payload" } }));
  assert.equal((await cardRow(card.messageId)).state, "executed");
});

test("two people at once: one completes the card, the other gets 409; one person twice: Hands replays one ticket, both 200", async ({ app }) => {
  const f = await seed(app);
  const values = { type: "idea", message: EDITED };

  const raced = await prepareFeedback(f);
  await withHands(async (requests) => {
    setBeforeActionCardExecutionLockForTest(barrier(2));
    const results = await Promise.all((["alice", "owner"] as const).map((who) => sendForm(app.baseUrl, f, who, raced.messageId, values)));
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409], results.map((res) => res.text).join("\n"));
    assert.equal(results.find((res) => res.status === 409)?.body.errorCode, "ALREADY_EXECUTED");
    // Each filed their own ticket before the card's lock (as two senders of the dialog do).
    assert.deepEqual(new Set(filedTickets(requests).map((request) => multipartField(request, "submission_id"))).size, 2);
  });
  assert.equal((await cardRow(raced.messageId)).state, "executed");

  const twice = await prepareFeedback(f);
  await withHands(async (requests) => {
    setBeforeActionCardExecutionLockForTest(barrier(2));
    const results = await Promise.all([0, 1].map(() => sendForm(app.baseUrl, f, "alice", twice.messageId, values)));
    assert.deepEqual(results.map((res) => res.status), [200, 200], results.map((res) => res.text).join("\n"));
    assert.deepEqual(filedTickets(requests).map((request) => multipartField(request, "submission_id")),
      [agentFeedbackCardSubmissionId(twice.messageId, f.alice.id), agentFeedbackCardSubmissionId(twice.messageId, f.alice.id)],
      "one submission_id: Hands answers the same ticket");
  });
  assert.equal((await cardRow(twice.messageId)).executedByUserId, f.alice.id);
});

// L3: the dialog's per-person feedback limit (app.ts productFeedbackLimiter,
// 10 an hour) counts the form too: the same limiter instance, so one budget,
// run before execute. The pglite harness skips that limiter unless asked.
const limitedTest = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, enforceProductFeedbackRateLimit: true });

const FEEDBACK_LIMIT = 10;
/** The limiter's own answer, as the dialog gets it. */
const FEEDBACK_LIMITED = { error: "Too many feedback submissions. Please try again later.", code: "feedback_rate_limited", errorCode: "feedback_rate_limited" };

function assertStillWaiting(row: Awaited<ReturnType<typeof cardRow>>, label: string) {
  assert.equal(row.state, "prepared", `${label}: the card still waits`);
  assert.equal(row.submittedInput, null, `${label}: nothing was kept`);
  assert.equal(row.executedByUserId, null, `${label}: nobody executed it`);
}

limitedTest("a person's 11th feedback form in an hour gets the dialog's 429: Hands is not called and the card still waits", async ({ app }) => {
  const f = await seed(app);
  const values = { type: "idea", message: EDITED };
  const cards: Array<Awaited<ReturnType<typeof prepareFeedback>>> = [];
  for (let i = 0; i <= FEEDBACK_LIMIT; i += 1) cards.push(await prepareFeedback(f));
  const refused = cards[FEEDBACK_LIMIT]!;

  await withHands(async (requests) => {
    for (const [i, card] of cards.slice(0, FEEDBACK_LIMIT).entries()) {
      const res = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
      assert.equal(res.status, 200, `send ${i + 1}: ${res.text}`);
    }
    const limited = await sendForm(app.baseUrl, f, "alice", refused.messageId, values);
    assert.equal(limited.status, 429, limited.text);
    assert.deepEqual(limited.body, FEEDBACK_LIMITED);
    // The forms spent the dialog's budget: its answer is the same.
    const dialog = await sendDialog(app.baseUrl, f, "alice", refused.messageId, values);
    assert.equal(dialog.status, 429, dialog.text);
    assert.deepEqual(JSON.parse(dialog.text), limited.body);
    assert.equal(filedTickets(requests).length, FEEDBACK_LIMIT, "the refused sends never reached Hands");
  });

  const row = await cardRow(refused.messageId);
  assertStillWaiting(row, "refused");
  assert.deepEqual(await funnel(row.id), [], "refused before execute: no attempt recorded");
  assert.deepEqual(await resultReplies(refused.messageId), [], "the agent is told nothing");
});

limitedTest("the dialog and the form share one budget: what the dialog spent the form cannot; another person has their own", async ({ app }) => {
  const f = await seed(app);
  const values = { type: "problem", message: EDITED };
  const viaDialog = 4;

  await withHands(async (requests) => {
    for (let i = 0; i < viaDialog; i += 1) {
      const res = await sendDialog(app.baseUrl, f, "alice", (await prepareFeedback(f)).messageId, values);
      assert.equal(res.status, 201, `dialog send ${i + 1}: ${res.text}`);
    }
    for (let i = viaDialog; i < FEEDBACK_LIMIT; i += 1) {
      const res = await sendForm(app.baseUrl, f, "alice", (await prepareFeedback(f)).messageId, values);
      assert.equal(res.status, 200, `form send ${i + 1}: ${res.text}`);
    }
    const card = await prepareFeedback(f);
    const limited = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(limited.status, 429, limited.text);
    assert.deepEqual(limited.body, FEEDBACK_LIMITED);
    assertStillWaiting(await cardRow(card.messageId), "alice refused");
    assert.equal(filedTickets(requests).length, FEEDBACK_LIMIT);

    // The owner's budget is their own, on either path; the card alice could not send is still theirs to send.
    const ownerForm = await sendForm(app.baseUrl, f, "owner", card.messageId, values);
    assert.equal(ownerForm.status, 200, ownerForm.text);
    const ownerDialog = await sendDialog(app.baseUrl, f, "owner", (await prepareFeedback(f)).messageId, values);
    assert.equal(ownerDialog.status, 201, ownerDialog.text);
    assert.equal(filedTickets(requests).length, FEEDBACK_LIMIT + 2);
  });
});

limitedTest("only a feedback card's form counts: with the budget spent, another card's form, an execute without a form, mark-executed and events answer as before", async ({ app }) => {
  const f = await seed(app);
  const feedback = await prepareFeedback(f);
  const plain = await prepareCreate(f, { name: "plain-room", visibility: "public" });

  await withHands(async () => {
    for (let i = 0; i < FEEDBACK_LIMIT; i += 1) {
      const res = await sendDialog(app.baseUrl, f, "alice", (await prepareFeedback(f)).messageId, { type: "idea", message: EDITED });
      assert.equal(res.status, 201, `dialog send ${i + 1}: ${res.text}`);
    }
    const spent = await sendForm(app.baseUrl, f, "alice", feedback.messageId, { type: "idea", message: EDITED });
    assert.equal(spent.status, 429, `control: alice's budget is spent: ${spent.text}`);

    // A card that is not a form card, executed without a form.
    const noForm = await post(app.baseUrl, f, "alice", `${plain.messageId}/execute`, { expectedState: "prepared" });
    assert.equal(noForm.status, 200, noForm.text);
    // Another type's form card, with its form.
    channelCreateFormHandler();
    const formCard = await prepareCreate(f);
    const otherForm = await submit(app.baseUrl, f, "alice", formCard.messageId, goodValues(f));
    assert.equal(otherForm.status, 200, otherForm.text);
    // The feedback card itself, without its form: execute's own answers.
    const generic = await post(app.baseUrl, f, "alice", `${feedback.messageId}/execute`, { expectedState: "prepared", expectedConfirmationVersion: 1 });
    assert.equal(generic.status, 422, generic.text);
    assert.equal(generic.body.errorCode, "FORM_REQUIRED");
    const marked = await post(app.baseUrl, f, "alice", `${feedback.messageId}/mark-executed`, { result: { kind: "product-feedback", ticketId: randomUUID(), reference: null } });
    assert.equal(marked.status, 409, marked.text);
    assert.equal(marked.body.errorCode, "DIALOG_REQUIRED");
    const event = await post(app.baseUrl, f, "alice", `${feedback.messageId}/event`, { eventType: "action_card.open" });
    assert.equal(event.status, 204, event.text);
  });
  assertStillWaiting(await cardRow(feedback.messageId), "feedback card");
});

limitedTest("a retry after Hands failed counts too: ten failed sends of one card, then the 429 before Hands, also once Hands is back", async ({ app }) => {
  const f = await seed(app);
  const card = await prepareFeedback(f);
  const values = { type: "idea", message: EDITED };

  await withHands(async (requests) => {
    for (let i = 0; i < FEEDBACK_LIMIT; i += 1) {
      const down = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
      assert.equal(down.status, 503, `try ${i + 1}: ${down.text}`);
      assert.equal(down.body.errorCode, "feedback_service_unavailable");
    }
    const limited = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(limited.status, 429, limited.text);
    assert.deepEqual(limited.body, FEEDBACK_LIMITED);
    assert.equal(filedTickets(requests).length, FEEDBACK_LIMIT, "each failed try reached Hands once, the refused one did not");
  }, () => ({ status: 503, body: { error: "maintenance" } }));

  await withHands(async (requests) => {
    const still = await sendForm(app.baseUrl, f, "alice", card.messageId, values);
    assert.equal(still.status, 429, still.text);
    assert.equal(filedTickets(requests).length, 0);
  });
  assertStillWaiting(await cardRow(card.messageId), "after the retries");
});
