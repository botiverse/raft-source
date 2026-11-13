// agent:approve_call (antiproton held-call approvals): the server-built
// card, its decision form with submitLabels, its result per status, and the
// plain-text rule for everything antiproton sends.
import assert from "node:assert/strict";
import { test } from "vitest";
import { ACTION_CARD_MESSAGES, type ActionCardMessageEntry } from "./actionCardMessages";
import { ACTION_CARD_SPEC_LIMITS, actionCardSpecIssues, parseActionCardSpec, stripActionCardSpec, type ActionCardSpecForm } from "./actionCardSpec";
import {
  AGENT_APPROVE_CALL_DECISION_FIELD, AGENT_APPROVE_CALL_FORM_ID, buildAgentApproveCallForms, buildParsedActionCardSpec,
} from "./actionCardSpecBuilder";
import {
  actionCardActionSchema, agentApproveCallOperationSchema, buildActionCardPresentation, plainActionCardText, storedActionCardActionSchema,
  type ActionCardResult, type AgentApproveCallAction,
} from "./actionCards";

const action: AgentApproveCallAction = {
  type: "agent:approve_call",
  approvalId: "0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d",
  agentId: "1c2f8d5f-2e3b-4a7c-8d4e-6f8a9b0c1d2e",
  agentName: "scout",
  call: "gh.create_pull_request",
  plugin: "github",
  heldBy: "policy",
  summary: "repo: botiverse/antiproton\ntitle: fix the parser\nbody: [click](https://evil.example) **bold**",
  summaryTruncated: true,
  summaryWithheld: false,
  request: "POST /repos/botiverse/antiproton/pulls (botiverse/antiproton)",
  description: "Approving runs gh.create_pull_request once, exactly as shown, with this agent's gh mount; denying runs nothing.",
  createdAt: "2026-10-29T06:20:00.000Z",
  expiresAt: "2026-10-30T06:20:00.000Z",
  decider: "owner",
};

const built = (a: AgentApproveCallAction, result?: ActionCardResult) => {
  const outcome = buildParsedActionCardSpec(a, result ? { result } : {});
  assert.ok(outcome.ok, JSON.stringify(outcome.ok ? null : outcome.issues));
  return outcome.card;
};

test("an agent can never prepare it: it is a stored type, not an agent one", () => {
  assert.equal(actionCardActionSchema.safeParse(action).success, false);
  assert.equal(storedActionCardActionSchema.safeParse(action).success, true);
  assert.equal(agentApproveCallOperationSchema.safeParse({ ...action, extra: 1 }).success, false, "strict");
});

test("the card shows antiproton's summary verbatim in monospace and its description as plain text; its one button opens the decision", () => {
  const card = built(action);
  const elements = card.spec.elements;
  const summary = elements.summaryText;
  assert.ok(summary?.type === "Text" && summary.props.mono === true);
  assert.equal(summary.props.text, action.summary, "verbatim: markdown and links stay text");
  assert.ok(elements.summaryTruncated, "cut short is said");
  const description = elements.descriptionText;
  assert.ok(description?.type === "Text" && description.props.text === action.description);
  assert.ok(elements.expiresAt?.type === "RelativeTime" && elements.expiresAt.props.at === action.expiresAt);
  assert.ok(elements.call?.type === "Field" && elements.call.props.value === action.call);
  assert.equal(elements.ownerGone, undefined, "sent to the owner");
  const buttons = Object.values(elements).filter((node) => node.type === "Button");
  assert.deepEqual(buttons.map((node) => node.type === "Button" && node.props.action), [{ kind: "execute" }]);
  // No text from antiproton is ever a template or a navigate target.
  assert.equal(JSON.stringify(card).includes("\"navigate\""), false);
});

test("withheld arguments: a warning, no summary; the owner gone: who decides now", () => {
  const card = built({ ...action, summary: "", summaryWithheld: true, decider: "server_admin", heldBy: "agent" });
  assert.equal(card.spec.elements.summaryText, undefined);
  assert.ok(card.spec.elements.withheld?.type === "Notice");
  assert.ok(card.spec.elements.ownerGone?.type === "Notice");
  const held = card.spec.elements.held;
  assert.ok(held?.type === "Notice" && typeof held.props.text !== "string" && held.props.text.key === "actionCard.approveCall.heldByAgent");
});

test("the decision form: Approve or Deny, required, no default; the submit label follows the choice", () => {
  const forms = buildAgentApproveCallForms();
  const form = forms[AGENT_APPROVE_CALL_FORM_ID]!;
  const [decision] = form.fields;
  assert.ok(decision?.type === "Select");
  assert.equal(decision.name, AGENT_APPROVE_CALL_DECISION_FIELD);
  assert.equal(decision.required, true);
  assert.equal(decision.default, undefined, "nothing decided until the person picks");
  assert.deepEqual(decision.options.map((option) => option.value), ["approve", "deny"]);
  assert.equal(form.submitLabels?.field, AGENT_APPROVE_CALL_DECISION_FIELD);
  assert.deepEqual(Object.keys(form.submitLabels!.labels), ["approve", "deny"]);
  const card = { ...built(action), forms };
  assert.ok(parseActionCardSpec(card, { mode: "emit" }).ok, JSON.stringify(actionCardSpecIssues(card, { mode: "emit" })));
});

test("submitLabels: emit takes a Select of the form and its options only; a read keeps what it gets; strip keeps it", () => {
  const base = buildAgentApproveCallForms()[AGENT_APPROVE_CALL_FORM_ID]!;
  const withForm = (form: ActionCardSpecForm) => ({ ...built(action), forms: { [AGENT_APPROVE_CALL_FORM_ID]: form } });
  const label = base.submitLabels!.labels.approve!;
  const notAnOption = { ...base, submitLabels: { field: AGENT_APPROVE_CALL_DECISION_FIELD, labels: { maybe: label } } };
  const notAField = { ...base, submitLabels: { field: "other", labels: { approve: label } } };
  const textField: ActionCardSpecForm = { ...base, fields: [{ type: "TextInput", name: "decision", label, maxLength: 10 }] };
  for (const [name, form] of Object.entries({ notAnOption, notAField, textField })) {
    assert.equal(parseActionCardSpec(withForm(form), { mode: "emit" }).ok, false, name);
  }
  const tooLong = { ...base, submitLabels: { field: AGENT_APPROVE_CALL_DECISION_FIELD, labels: { approve: { key: "actionCard.test.long", text: { en: "x".repeat(25) } } } } };
  assert.equal(parseActionCardSpec(withForm(tooLong), { mode: "emit" }).ok, false, "a label is a button label: at most 24");
  const read = parseActionCardSpec(withForm(notAnOption), { mode: "read" });
  assert.ok(read.ok, "a read takes it as it is and uses what matches");
  const readBase = parseActionCardSpec(withForm(base), { mode: "read" });
  assert.ok(readBase.ok);
  const stripped = stripActionCardSpec(readBase.card, ["card.v1", "form.v1", "field.select"]);
  assert.deepEqual(stripped?.forms?.[AGENT_APPROVE_CALL_FORM_ID]?.submitLabels, base.submitLabels);
  // An older client drops the key it does not know: the read parse strips unknown keys.
  const { submitLabels: _labels, ...withoutLabels } = base;
  assert.ok(parseActionCardSpec(withForm(withoutLabels), { mode: "emit" }).ok);
});

test("the result: what happened, who decided by role, and the run's outcome", () => {
  const cases: Array<[ActionCardResult & { kind: "agent-call-approval" }, string, boolean]> = [
    [{ kind: "agent-call-approval", status: "approved", decidedBy: { via: "raft", role: "agent_owner" }, decidedAt: "2026-10-29T07:00:00.000Z", outcome: null }, "actionCard.result.approveCall.approved", true],
    [{ kind: "agent-call-approval", status: "executed", decidedBy: { via: "raft", role: "server_admin" }, decidedAt: "2026-10-29T07:00:00.000Z", outcome: { summary: "{\"number\":12}", truncated: true, withheld: false } }, "actionCard.result.approveCall.executed", true],
    [{ kind: "agent-call-approval", status: "failed", decidedBy: { via: "console" }, decidedAt: "2026-10-29T07:00:00.000Z", outcome: { summary: "", truncated: false, withheld: true } }, "actionCard.result.approveCall.failed", true],
    [{ kind: "agent-call-approval", status: "denied", decidedBy: { via: "raft", role: "server_owner" }, decidedAt: "2026-10-29T07:00:00.000Z", outcome: null }, "actionCard.result.approveCall.denied", true],
    [{ kind: "agent-call-approval", status: "expired", decidedBy: { via: "expiry" }, decidedAt: "2026-10-30T06:20:00.000Z", outcome: null }, "actionCard.result.approveCall.expired", false],
    [{ kind: "agent-call-approval", status: "unavailable", decidedBy: null, decidedAt: null, outcome: null }, "actionCard.result.approveCall.unavailable", false],
  ];
  for (const [result, key, named] of cases) {
    const card = built(action, result);
    const elements = card.result!.elements;
    const summary = elements.summary;
    assert.ok(summary?.type === "Text" && typeof summary.props.text !== "string" && summary.props.text.key === key, result.status);
    assert.equal(Boolean(elements.decidedBy), named, `${result.status}: decided by`);
    assert.equal(JSON.stringify(card.result).includes("raftUserId"), false, "never a user id");
  }
  const executed = built(action, cases[1]![0]).result!.elements;
  assert.ok(executed.outcomeText?.type === "Text" && executed.outcomeText.props.mono && executed.outcomeText.props.text === "{\"number\":12}");
  assert.ok(executed.outcomeTruncated);
  assert.ok(built(action, cases[2]![0]).result!.elements.outcomeWithheld);
});

test("the biggest card, every locale and the form, stays under 24 KiB", () => {
  const big: AgentApproveCallAction = {
    ...action,
    agentName: "a".repeat(120),
    call: "c".repeat(200),
    plugin: "p".repeat(120),
    summary: "s".repeat(2000),
    request: "r".repeat(600),
    description: "d".repeat(1000),
    decider: "server_admin",
  };
  const card = { ...built(big, { kind: "agent-call-approval", status: "executed", decidedBy: { via: "raft", role: "server_admin" }, decidedAt: action.createdAt, outcome: { summary: "o".repeat(2000), truncated: true, withheld: false } }), forms: buildAgentApproveCallForms() };
  const parsed = parseActionCardSpec(card, { mode: "emit" });
  assert.ok(parsed.ok, JSON.stringify(actionCardSpecIssues(card, { mode: "emit" })));
  assert.ok(new TextEncoder().encode(JSON.stringify(parsed.card)).length < ACTION_CARD_SPEC_LIMITS.maxBytes);
});

test("its copy is in the table in every display locale", () => {
  const table = ACTION_CARD_MESSAGES as Record<string, ActionCardMessageEntry>;
  const keys = Object.keys(table).filter((key) => key.includes("approveCall"));
  assert.ok(keys.length > 20);
  for (const key of keys) assert.deepEqual(Object.keys(table[key]!.text).sort(), ["en", "es", "ja", "ko", "pt-br", "ru", "zh-cn", "zh-tw"], key);
});

test("the legacy presentation refuses a generic approve and shows only plain fields", () => {
  const presentation = buildActionCardPresentation(action);
  assert.equal(presentation.genericApprovalAllowed, false);
  assert.equal(presentation.riskLevel, "elevated");
  assert.deepEqual(buildActionCardPresentation({ ...action, summary: "", summaryWithheld: true }).displayItems.find((item) => item.key === "summary")?.value, "Withheld");
});

test("plainActionCardText: no control or bidi characters, newlines only when asked, cut to its slot", () => {
  const raw = "a‮b⁦c⁩d‏e؜f\u0007g\u0000h i\r\nj\tk";
  assert.equal(plainActionCardText(raw, 100, { multiline: true }), "abcdefghi\nj\tk");
  assert.equal(plainActionCardText(raw, 100), "abcdefghi j k");
  assert.equal(plainActionCardText("  [x](https://e.example)  ", 100), "[x](https://e.example)", "markup is kept as text");
  assert.equal(plainActionCardText("😀".repeat(10), 5), "😀😀😀😀…", "code points");
  // Every invisible format character: zero-width spaces and joiners, invisible operators, word joiner,
  // deprecated format controls, the BOM, tag characters.
  const invisible = ["\u200B", "\u200C", "\u200D", "\u2060", "\u2061", "\u2064", "\u206A", "\u206F", "\uFEFF", "\u00AD", "\u{E0001}", "\u{E0041}", "\u{E007F}"];
  assert.equal(plainActionCardText(`ap${invisible.join("")}prove`, 100), "approve");
});
