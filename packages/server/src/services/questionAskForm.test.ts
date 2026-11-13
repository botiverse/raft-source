// questionAskFormHandler without a database: an answer must be of its
// question's kind (AppFather's review, #triage task 161), and the card the
// server sends is exactly shared buildQuestionAskCard's (one assembly,
// withActionCardForms, the one measureQuestionCard measures).
import assert from "node:assert/strict";

import {
  buildParsedActionCardSpec,
  buildQuestionAskCard,
  storedQuestionAskActionSchema,
  type ActionCardFormValue,
  type ActionCardResult,
  type QuestionAskAction,
} from "@botiverse/raft-shared";
import type { ActionCardFormContext } from "./actionCardForms";
import { actionCardSpecFor } from "./actionCardPresentation";
import { questionAskFormHandler, QuestionCardExpiredError } from "./questionAskForm";

const ALICE = "0b1e7c4e-1d2a-4f6b-9c3d-5e7f8a9b0c1d";
const SCOUT = "7b2e8f3a-0c5d-4e4f-9a3b-2c3d4e5f6071";

const QUESTION: QuestionAskAction = storedQuestionAskActionSchema.parse({
  type: "question:ask",
  to: "@alice",
  reason: "Before I deploy.",
  questions: [
    { id: "window", kind: "single", text: "Which window?", options: [{ value: "tue", label: "Tue" }, { value: "wed", label: "Wed" }] },
    { id: "envs", kind: "multiple", text: "Which environments?", required: false, options: [{ value: "staging", label: "staging" }, { value: "prod", label: "prod" }] },
    { id: "notes", kind: "text", text: "Anything else?", required: false },
  ],
  addressee: { kind: "user", userId: ALICE, handle: "alice" },
  expiresAt: "2999-01-01T00:00:00.000Z",
});

function ctx(action: QuestionAskAction = QUESTION): ActionCardFormContext<"question:ask"> {
  return {
    action,
    formId: "answers",
    executor: null as never,
    serverId: "s" as never,
    userId: ALICE,
    requesterAgentId: SCOUT,
    messageId: "m",
    confirmationVersion: 1,
    channelId: "c",
    client: { platform: "unknown" },
  };
}

const validate = (values: Record<string, ActionCardFormValue>, action?: QuestionAskAction) => questionAskFormHandler.validate(values, ctx(action));
const issuesOf = async (values: Record<string, unknown>) => {
  const out = await validate(values as Record<string, ActionCardFormValue>);
  return "issues" in out ? out.issues.map((issue) => [issue.field, issue.code]) : [];
};

test("an answer must be of its question's kind: a choice question takes a Choice value, a text question text", async () => {
  // A text answer to a choice question, a choice (or a list) to a text question.
  assert.deepEqual(await issuesOf({ window: "tue" }), [["window", "invalid_format"]]);
  assert.deepEqual(await issuesOf({ window: ["tue"] }), [["window", "invalid_format"]]);
  assert.deepEqual(await issuesOf({ window: { selected: ["tue"] }, notes: { selected: ["tue"] } }), [["notes", "invalid_format"]]);
  assert.deepEqual(await issuesOf({ window: { selected: ["tue"] }, notes: true }), [["notes", "invalid_format"]]);
  // A single question takes one item; options are the question's own.
  assert.deepEqual(await issuesOf({ window: { selected: ["tue", "wed"] } }), [["window", "too_many"]]);
  assert.deepEqual(await issuesOf({ window: { selected: ["tue"], other: "Fri" } }), [["window", "too_many"]]);
  assert.deepEqual(await issuesOf({ window: { selected: ["thu"] } }), [["window", "invalid_option"]]);
});

test("valid values become each question's answer; absent or blank is skipped", async () => {
  const out = await validate({ window: { selected: [], other: "Fri 09:00" }, envs: { selected: ["staging", "prod"], other: "  " }, notes: "Watch the queue." });
  assert.ok("input" in out);
  assert.deepEqual(out.input.answers, {
    window: { kind: "choice", selected: [], other: "Fri 09:00" },
    envs: { kind: "choice", selected: ["staging", "prod"] },
    notes: { kind: "text", text: "Watch the queue." },
  });
  const skipped = await validate({ window: { selected: ["tue"] }, notes: "   " });
  assert.ok("input" in skipped);
  assert.deepEqual(skipped.input.answers.envs, { kind: "skipped" });
  assert.deepEqual(skipped.input.answers.notes, { kind: "skipped" });
});

test("a confirm (a question of one option): its option is the answer, as any choice's; no Other…, no other option; left out, an optional one is skipped", async () => {
  const confirm = storedQuestionAskActionSchema.parse({
    type: "question:ask",
    questions: [
      { id: "ack", kind: "single", text: "Read the runbook?", options: [{ value: "ok", label: "Got it" }] },
      { id: "also", kind: "multiple", text: "And the checklist?", required: false, options: [{ value: "yes", label: "Done" }] },
    ],
    addressee: { kind: "user", userId: ALICE, handle: "alice" },
    expiresAt: "2999-01-01T00:00:00.000Z",
  });
  const both = await validate({ ack: { selected: ["ok"] }, also: { selected: ["yes"] } }, confirm);
  assert.ok("input" in both);
  assert.deepEqual(both.input.answers, { ack: { kind: "choice", selected: ["ok"] }, also: { kind: "choice", selected: ["yes"] } });
  const one = await validate({ ack: { selected: ["ok"] } }, confirm);
  assert.ok("input" in one);
  assert.deepEqual(one.input.answers.also, { kind: "skipped" });
  const refused = async (values: Record<string, ActionCardFormValue>) => {
    const out = await validate(values, confirm);
    return "issues" in out ? out.issues.map((issue) => [issue.field, issue.code]) : [];
  };
  assert.deepEqual(await refused({ ack: { selected: [], other: "No" } }), [["ack", "invalid_format"]]);
  assert.deepEqual(await refused({ ack: { selected: ["ok"], other: "" } }), [["ack", "invalid_format"]]);
  assert.deepEqual(await refused({ ack: { selected: ["no"] } }), [["ack", "invalid_option"]]);
  // The card the server sends: each a single Choice of its one option, without Other….
  const card = actionCardSpecFor(confirm, { requesterAgentId: SCOUT, names: { users: { [ALICE]: "alice" } }, result: null });
  assert.deepEqual(card!.forms!.answers!.fields.map((field) => field.type === "Choice" && [field.multiple, field.options.length, "other" in field]), [[false, 1, false], [false, 1, false]]);
});

test("a card past its expiresAt refuses under the lock (409 QUESTION_EXPIRED)", async () => {
  await assert.rejects(validate({ window: { selected: ["tue"] } }, { ...QUESTION, expiresAt: "2001-01-01T00:00:00.000Z" }), (err: unknown) =>
    err instanceof QuestionCardExpiredError && err.status === 409 && err.code === "QUESTION_EXPIRED");
});

test("one assembly: the server's card is shared buildQuestionAskCard's, asked and answered (the answered one keeps no form)", () => {
  const answered: ActionCardResult = {
    kind: "question-answers", ref: null, answeredBy: { userId: ALICE, handle: "alice" }, answeredAt: "2026-11-04T10:00:00.000Z",
    answers: { window: { kind: "choice", selected: ["tue"] }, envs: { kind: "skipped" }, notes: { kind: "skipped" } },
  };
  for (const result of [null, answered]) {
    const buildCtx = { requesterAgentId: SCOUT, names: { users: { [ALICE]: "alice" } }, result };
    const shared = buildParsedActionCardSpec(QUESTION, buildCtx, (action, built) => buildQuestionAskCard(action as QuestionAskAction, built));
    assert.ok(shared.ok);
    assert.deepEqual(actionCardSpecFor(QUESTION, buildCtx), shared.card, result ? "answered" : "asked");
  }
  // Without the agent that asked, an asked card's form cannot be built: no card rather than a wrong one.
  assert.equal(actionCardSpecFor(QUESTION, {}), null);
});
