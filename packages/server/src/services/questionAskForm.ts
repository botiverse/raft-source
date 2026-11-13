// `question:ask` as a form card (question-card spec §5.4): an agent's
// questions, answered by the person asked (or, `to: "anyone"`, by whoever in
// the channel answers first) in the card's one form. The card and its form are
// shared buildQuestionAskCard's: this handler's buildForm is
// buildQuestionAskForms, assembled by withActionCardForms, the function
// measureQuestionCard measures at prepare.
//
// Who may answer is decided before execute's lock (assertActionCardTypeAuthority:
// 403 NOT_ADDRESSEE, as a Guest is on any question card); one answer wins by execute's atomic claim on the card
// (a second gets 409 ALREADY_EXECUTED). Under the lock, validate refuses a
// card past its `expiresAt` (409 QUESTION_EXPIRED; execute then ends it as
// expired and tells the agent) and turns each value into the answer of its
// question's kind: a choice question takes only a Choice value, a text
// question only text (422 invalid_format otherwise). execute records them as
// the card's `question-answers` result, which the agent reads and its result
// reply quotes; the values themselves stay in action_cards.submitted_input as
// for every form card.

import { eq } from "drizzle-orm";
import {
  actionCardFormIssue,
  buildQuestionAskForms,
  isQuestionAskConfirm,
  QUESTION_CARD_ERROR_CODES,
  type ActionCardChoiceValue,
  type ActionCardFormIssue,
  type ActionCardFormValue,
  type ActionCardQuestionAnswer,
  type QuestionAskAction,
  type QuestionAskQuestion,
} from "@botiverse/raft-shared";
import { users } from "../db/schema";
import type { ActionCardFormHandler } from "./actionCardForms";

/** What validate makes of the values: each question's answer, in question order. */
export interface QuestionAskFormInput {
  answers: Record<string, ActionCardQuestionAnswer>;
}

/**
 * A submit to a question card that has ended by time (409 QUESTION_EXPIRED):
 * the execute route answers with its status and code, and executeActionCard
 * ends the card as expired.
 */
export class QuestionCardExpiredError extends Error {
  readonly status = 409;
  readonly code = QUESTION_CARD_ERROR_CODES.expired;
  constructor() {
    super("This question expired before it was answered; your answers were not sent");
    this.name = "QuestionCardExpiredError";
  }
}

/** Whether a question card's time is up at `now` (a card without `expiresAt` never expires). */
export function questionCardExpired(action: Pick<QuestionAskAction, "expiresAt">, now: number = Date.now()): boolean {
  return action.expiresAt !== undefined && Date.parse(action.expiresAt) <= now;
}

const isChoiceValue = (value: ActionCardFormValue): value is ActionCardChoiceValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One question's answer from its value, or the issue: the value's type must be
 * the question's (a Choice value for single and multiple, text for text).
 * Absent or blank is `skipped`; the shared checks have already refused a blank
 * required one, an unknown option, too many or too few items, too long text.
 */
function answerOf(question: QuestionAskQuestion, value: ActionCardFormValue | undefined): ActionCardQuestionAnswer | ActionCardFormIssue {
  if (value === undefined) return { kind: "skipped" };
  if (question.kind === "text") {
    if (typeof value !== "string") return actionCardFormIssue(question.id, "invalid_format");
    return value.trim() ? { kind: "text", text: value } : { kind: "skipped" };
  }
  if (!isChoiceValue(value) || !Array.isArray(value.selected) || value.selected.some((item) => typeof item !== "string")) {
    return actionCardFormIssue(question.id, "invalid_format");
  }
  const offered = new Set((question.options ?? []).map((option) => option.value));
  if (value.selected.some((item) => !offered.has(item)) || new Set(value.selected).size !== value.selected.length) {
    return actionCardFormIssue(question.id, "invalid_option");
  }
  // A confirm (one option) offers no Other…: its form's Choice has none, and the shared checks refuse it first.
  if (isQuestionAskConfirm(question) && value.other !== undefined) return actionCardFormIssue(question.id, "invalid_format");
  const other = typeof value.other === "string" && value.other.trim() ? value.other : undefined;
  if (question.kind === "single" && value.selected.length + (other === undefined ? 0 : 1) > 1) {
    return actionCardFormIssue(question.id, "too_many", { max: 1 });
  }
  if (value.selected.length === 0 && other === undefined) return { kind: "skipped" };
  return { kind: "choice", selected: [...value.selected], ...(other === undefined ? {} : { other }) };
}

const isIssue = (answer: ActionCardQuestionAnswer | ActionCardFormIssue): answer is ActionCardFormIssue => "code" in answer;

export const questionAskFormHandler: ActionCardFormHandler<"question:ask", QuestionAskFormInput> = {
  buildForm(action, ctx) {
    return buildQuestionAskForms(action, ctx);
  },

  async validate(values, ctx) {
    // Under execute's lock: the card may have run out of time since it was drawn.
    if (questionCardExpired(ctx.action)) throw new QuestionCardExpiredError();
    const answers: Record<string, ActionCardQuestionAnswer> = {};
    const issues: ActionCardFormIssue[] = [];
    for (const question of ctx.action.questions) {
      const answer = answerOf(question, Object.hasOwn(values, question.id) ? values[question.id] : undefined);
      if (isIssue(answer)) issues.push(answer);
      else answers[question.id] = answer;
    }
    return issues.length > 0 ? { issues } : { input: { answers } };
  },

  async execute(input, ctx) {
    const [user] = await ctx.executor.select({ name: users.name }).from(users).where(eq(users.id, ctx.userId)).limit(1);
    if (!user) throw new Error("The person answering is gone");
    return {
      kind: "question-answers",
      ref: ctx.action.ref ?? null,
      answeredBy: { userId: ctx.userId, handle: user.name },
      answeredAt: new Date().toISOString(),
      answers: input.answers,
    };
  },
};
