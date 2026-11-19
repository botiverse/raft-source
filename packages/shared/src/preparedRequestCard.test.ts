// RFC 085 request:prepare in shared: what an agent may send, what a card stores, how the card is drawn (its form keyed
// by the digest it shows), and the state older clients are served for a declined card.
import assert from "node:assert/strict";
import { actionCardActionSchema, storedActionCardActionSchema, withServedActionCardState, ACTION_CARD_STATES_SERVED_AS } from "./actionCards";
import {
  buildActionCardSpec, buildParsedActionCardSpec, buildPreparedRequestForms, withActionCardForms, type ActionCardSpecBuildContext,
} from "./actionCardSpecBuilder";
import {
  PREPARED_REQUEST_DECISION_FIELD,
  isPreparedRequestAgentAction,
  preparedRequestActionSchema,
  preparedRequestAgentActionSchema,
  preparedRequestFormId,
  type PreparedRequestAction,
} from "./preparedRequestCard";

const CHANNEL = "6f1389e2-5b60-4337-8e0d-e801dd9918f9";
const PERSON = "fa876988-bb1a-413f-8048-d618873b8588";
const AGENT = "e57cc630-2846-43b3-b7da-24249c11619c";
const DIGEST = "08cc157dae0e49cd813d13b47f057c938ff4597e274f0e9bd0a9986529d2aba1";

const stored = (extra: Partial<PreparedRequestAction> = {}): PreparedRequestAction => ({
  type: "request:prepare",
  operation: "channel:archive",
  route: "POST /api/channels/:id/archive",
  params: { id: CHANNEL },
  body: {},
  permission: "archiveChannels",
  addressee: { kind: "user", userId: PERSON, handle: "martin" },
  note: "Ops asked. <b>not markup</b> @everyone",
  template: "channel.archive",
  summaryModel: { channel: { kind: "channel", id: CHANNEL }, visibility: { kind: "text", text: "public" } },
  display: { title: "actionCard.field.channel", verb: "actionCard.assistantOwnerAction.form.confirm", fields: [{ label: "actionCard.field.channel", value: "channel" }] },
  digest: DIGEST,
  attempt: 1,
  ...extra,
});

test("an agent sends an operation, its args and the person; never what the server writes", () => {
  const sent = { type: "request:prepare", to: "@martin", operation: "channel:archive", args: { channel: "#ops" }, note: "why" };
  assert.equal(preparedRequestAgentActionSchema.safeParse(sent).success, true);
  assert.equal(isPreparedRequestAgentAction(sent), true);
  for (const extra of [{ route: "POST /api/x" }, { digest: DIGEST }, { summaryModel: {} }, { params: { id: CHANNEL } }]) {
    assert.equal(preparedRequestAgentActionSchema.safeParse({ ...sent, ...extra }).success, false, JSON.stringify(extra));
  }
  assert.equal(preparedRequestAgentActionSchema.safeParse({ ...sent, operation: "DELETE /api/servers/:id" }).success, false);
  assert.equal(preparedRequestAgentActionSchema.safeParse({ ...sent, args: { nested: { a: 1 } } }).success, false);
  // Not an agent card type: with the flag off, prepare refuses it as a type it doesn't know.
  assert.equal(actionCardActionSchema.safeParse(sent).success, false);
});

test("a stored card: its fields name model entries, its copy is message keys, and it is a stored card type", () => {
  assert.equal(preparedRequestActionSchema.safeParse(stored()).success, true);
  assert.equal(storedActionCardActionSchema.safeParse(stored()).success, true);
  assert.equal(preparedRequestActionSchema.safeParse(stored({ display: { ...stored().display, fields: [{ label: "actionCard.field.channel", value: "missing" }] } })).success, false);
  assert.equal(preparedRequestActionSchema.safeParse(stored({ display: { ...stored().display, title: "actionCard.no.such.key" } })).success, false);
  assert.equal(preparedRequestActionSchema.safeParse({ ...stored(), route: "GET /api/channels/:id" }).success, false);
  assert.equal(preparedRequestActionSchema.safeParse({ ...stored(), query: "x=1" }).success, false, "never a query string");
});

test("the card: the decision form keyed by the digest it shows, the note as plain text, a refusal by its code only", () => {
  const forms = buildPreparedRequestForms(stored());
  assert.deepEqual(Object.keys(forms), [preparedRequestFormId(DIGEST)]);
  assert.equal(preparedRequestFormId(DIGEST), `d${DIGEST.slice(0, 31)}`);
  assert.match(preparedRequestFormId(DIGEST), /^[a-z][a-z0-9_]{0,31}$/);
  const form = forms[preparedRequestFormId(DIGEST)]!;
  assert.deepEqual(form.fields.map((field) => field.name), [PREPARED_REQUEST_DECISION_FIELD]);

  const built = buildParsedActionCardSpec(stored({ refusal: { status: 403, code: "http_403", attempt: 1, at: "2026-11-13T07:00:00.000Z" } }), {
    requesterAgentId: AGENT,
    names: { channels: { [CHANNEL]: "ops" }, users: { [PERSON]: "martin" } },
  }, (action, ctx) => withForms(action as PreparedRequestAction, ctx)); // the form handler's assembly, as the server's actionCardSpecFor
  assert.ok(built.ok, JSON.stringify(built));
  const text = JSON.stringify(built.card);
  assert.ok(text.includes("Ops asked. <b>not markup</b> @everyone"), "the note, as its own text");
  assert.ok(text.includes("http_403"));
  assert.ok(text.includes(`"fallback":"ops"`));
  assert.ok(text.includes(`"form":"${preparedRequestFormId(DIGEST)}"`), "the card's button opens the digest's form");
});

test("declined is served to every client as expired, a state they all know; other states as they are", () => {
  assert.deepEqual(ACTION_CARD_STATES_SERVED_AS, { declined: "expired" });
  assert.deepEqual(withServedActionCardState({ kind: "action-card", state: "declined", result: { kind: "prepared-request", outcome: "declined" } }),
    { kind: "action-card", state: "expired", result: { kind: "prepared-request", outcome: "declined" } });
  for (const state of ["prepared", "executed", "expired", "withdrawn", "reconfirm_required", "frozen"]) {
    const metadata = { kind: "action-card", state };
    assert.equal(withServedActionCardState(metadata), metadata, state);
  }
  assert.equal(withServedActionCardState(null), null);
});

function withForms(action: PreparedRequestAction, ctx: ActionCardSpecBuildContext) {
  return withActionCardForms(buildActionCardSpec(action, ctx), buildPreparedRequestForms(action));
}
