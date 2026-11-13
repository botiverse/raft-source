// Action cards: prepare an operation for a human to confirm in Raft.
//
// Today this covers the Server's existing card types (channel:create,
// channel:add_member, agent:create, and the integration ones); the human who
// clicks the card executes it under their own identity. `plan:upgrade` is the
// exception: it executes nothing (its button opens the upgrade dialog), so no
// outcome reply follows it. `question:ask` asks a person questions: the
// answers come back as a reply, it expires, and the agent that asked may
// withdraw it while nobody has answered (`withdrawQuestionCard`). Generic
// cards for any write operation (`raft.<op>.prepare`) are designed separately
// and will build on this outcome shape.

import { z } from "zod";

import { actionCardActionSchema, looksLikeUuid, QUESTION_ASK_ANYONE, QUESTION_CARD_ERROR_CODES } from "../actionCards";
import type { AgentApiClient, AgentApiClientResult } from "../agentApiClient";
import { agentApiActionPrepareBodySchema, type AgentApiActionPrepareBody, type AgentApiActionWithdrawResponse } from "../agentApiContract";
import { foldAgentOneLineText, indentAgentBodyContinuationLines, quoteAgentOneLineText } from "../agentMessageText";
import { agentTaskThreadTarget } from "../agentText/tasks";
import { lazySchema } from "../lazySchema";
import { formatHint, formatHintName, hintStep, RAFT_HINTS, type RaftHintOptions, type RaftHintStyle } from "./hint";
import { CLI_NEXT_ACTION_PATTERN, failureFromClientResult, failureOutcome, formatOpErrorText, keyedWriteFailure, opError, validateOpRequest, type RaftFailure, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";
import { getParentTargetForThread } from "./seenPolicy/consumedSeqs";

/**
 * `idempotencyKey`: one key per logical prepare. Generated with
 * `crypto.randomUUID()` when omitted and returned as `data.idempotencyKey`
 * (and, on a retryable failure, as `next.args.idempotencyKey`). Repeating the
 * same request with the same key returns the first card (same `messageId`)
 * and posts nothing; the same key with a different request fails with
 * `IDEMPOTENCY_KEY_REUSED`. A key is valid for 24 hours; after that the
 * Server forgets it. Servers without keyed prepare ignore the key.
 */
export type PrepareActionCardRequest = z.infer<typeof prepareActionCardRequestSchema>;

/**
 * The operation's documented schema: the Agent API body with the card as
 * this version knows it (a discriminated union over the card types). The
 * operation manifest projects it flattened (see the SDK's operations.ts), so
 * a model learns the card types from it, and `invoke` checks a tool call
 * against it. `prepareActionCard` itself checks only the wire body: the
 * Server checks the card, so a type or field this version doesn't know yet
 * still reaches it.
 */
export const prepareActionCardRequestSchema = lazySchema("prepareActionCardRequestSchema", () => agentApiActionPrepareBodySchema.extend({
  action: actionCardActionSchema,
}));

export interface RaftPreparedCard {
  target: string;
  /** The card message; a human commits it by clicking its action verb. */
  messageId: string;
  /** The key this prepare was sent with (the caller's `idempotencyKey`, or the generated one). */
  idempotencyKey: string;
  /**
   * True when nothing was posted because the same card is already there:
   * `messageId` is that card. Only `plan:upgrade` does this (a repeat for the
   * same conversation and gate within a day; no gate counts as `general`).
   */
  existing: boolean;
}

/** Who a question card asks, as the Server stored it: a person by handle, or anyone in the channel. */
export type RaftQuestionAsked = { kind: "user"; handle: string } | { kind: "anyone" };

/** A question card's stored `addressee` (what prepare resolved `to` into), or null when the card does not say. */
function questionAsked(action: unknown): RaftQuestionAsked | null {
  const addressee = action && typeof action === "object" ? (action as { addressee?: unknown }).addressee : undefined;
  if (!addressee || typeof addressee !== "object") return null;
  const { kind, handle } = addressee as { kind?: unknown; handle?: unknown };
  if (kind === "anyone") return { kind: "anyone" };
  return kind === "user" && typeof handle === "string" && handle.trim() ? { kind: "user", handle: foldAgentOneLineText(handle) } : null;
}

/** Who a question card asks, from its stored action, else from the `to` the agent sent ("anyone", or a handle). */
function questionAskedFrom(stored: unknown, sent: unknown): RaftQuestionAsked | null {
  const asked = questionAsked(stored);
  if (asked) return asked;
  const to = sent && typeof sent === "object" ? (sent as { to?: unknown }).to : undefined;
  if (typeof to !== "string" || !to.trim()) return null;
  const handle = to.trim().replace(/^@/, "");
  if (handle === QUESTION_ASK_ANYONE) return { kind: "anyone" };
  return handle ? { kind: "user", handle: foldAgentOneLineText(handle) } : null;
}

/** `2026-10-31 16:00 UTC`: a question card's expiry, as its "expired unanswered" reply names it. Null when not a time. */
export function formatQuestionCardExpiry(expiresAt: string): string | null {
  const time = new Date(expiresAt);
  return Number.isNaN(time.getTime()) ? null : `${time.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What the posted-card text depends on besides where it went. */
export interface AgentActionCardPostedOptions {
  /** The card's `action.type` (one this version may not know: the Server checked it). */
  type?: string;
  /** The Server answered with a card already there instead of posting one. */
  existing?: boolean;
  /** A `question:ask` card: who it asks and when it expires, as the Server stored them (null when it did not say). */
  question?: { asked: RaftQuestionAsked | null; expiresAt: string | null };
  /** How the withdraw command of a question card is shown: the CLI's (default) or the tool call. */
  hints?: RaftHintStyle;
}

/**
 * Text is the CLI's `raft action prepare` output; the SDK's `actions.prepare`
 * returns the same words.
 */
export function formatAgentActionCardPosted(
  target: string,
  messageId: string | null,
  card: AgentActionCardPostedOptions = {},
): string {
  const shortId = messageId ? messageId.slice(0, 8) : null;
  const where = shortId ? `${target} as message ${messageId} (short ${shortId})` : target;
  // Only plan:upgrade repeats this way: the same conversation and gate within a day.
  if (card.existing) return `This card is already in ${where}, posted in the last 24 hours; nothing new was posted.\n`;
  if (card.type === "plan:upgrade") {
    return `Upgrade card posted to ${where}. Its button only opens the upgrade dialog; no reply will follow, and you are not told whether they upgrade.\n`;
  }
  if (card.type === "question:ask" && shortId) return formatQuestionCardPosted(target, where, shortId, card);
  return shortId
    ? `Action card posted to ${where}. The human can click the action verb to commit.\n`
    : `Action card posted to ${target}.\n`;
}

/** A question card's receipt (question-card spec §4.5): whom it asks, where the answers arrive, when it expires, how to withdraw it. */
function formatQuestionCardPosted(target: string, where: string, shortId: string, card: AgentActionCardPostedOptions): string {
  const asked = card.question?.asked ?? null;
  const askedPart = asked === null ? "" : asked.kind === "anyone" ? ", asking anyone" : `, asking @${asked.handle}`;
  const answer = asked?.kind === "anyone" ? "When someone answers" : "When they answer";
  // A card posted inside a thread has no thread of its own: the reply lands in that thread.
  const thread = getParentTargetForThread(target) !== null ? "this thread" : "the card's thread";
  const expiry = card.question?.expiresAt ? formatQuestionCardExpiry(card.question.expiresAt) : null;
  const withdraw = formatHint(RAFT_HINTS.actionWithdraw(shortId), card.hints ?? "cli");
  return `Question card posted to ${where}${askedPart}. ${answer}, the answers arrive as a reply in ${thread} that @mentions you; you do not need to poll. `
    + `${expiry ? `It expires ${expiry}; if nobody answers by then, a reply tells you. ` : ""}If you no longer need the answers, withdraw it with: ${withdraw}\n`;
}

/**
 * Where the card's outcome arrives (Server #8604): when a human executes the
 * card, or execution fails, the Server posts a system reply that @mentions
 * the preparer in the card's own thread; a card posted inside a thread has no
 * thread of its own, so the reply lands in that same thread. A question card
 * waits for answers instead (`await_answers`).
 */
function awaitOutcomeNext(target: string, messageId: string, style: RaftHintStyle, question: boolean): RaftNextStep {
  const short = messageId.slice(0, 8);
  const kind = question ? "await_answers" : "await_confirmation";
  const why = (thread: string) => question
    ? `The person answers on the card. When they do, the answers arrive as a reply in ${thread} that @mentions you, and if nobody answers before it expires, a reply says so; you do not need to poll.`
    : `A human must click the card to commit it. When it is executed (or fails), the outcome arrives as a reply in ${thread} that @mentions you; you do not need to poll.`;
  if (getParentTargetForThread(target) !== null) {
    return hintStep(
      kind,
      RAFT_HINTS.messageRead({ target, around: { shown: short, id: messageId } }),
      why("this thread"),
      style,
      { target, around: messageId, messageId },
    );
  }
  const thread = agentTaskThreadTarget(target, messageId);
  return hintStep(
    kind,
    RAFT_HINTS.messageRead({ target: thread }),
    why("the card's thread"),
    style,
    { target: thread, messageId },
  );
}

/**
 * A `plan:upgrade` card executes nothing, so there is no outcome to wait for.
 * A new one: carry on. One already there: read it, to point the person to it.
 */
function planUpgradeNext(target: string, messageId: string, existing: boolean, style: RaftHintStyle): RaftNextStep {
  if (existing) {
    return hintStep(
      "read_existing_card",
      RAFT_HINTS.messageRead({ target, around: { shown: messageId.slice(0, 8), id: messageId } }),
      "Nothing new was posted: the same upgrade card is already in this conversation from the last 24 hours. Read it to point the person to it; its button only opens the upgrade dialog, and no reply will follow.",
      style,
      { target, around: messageId, messageId },
    );
  }
  return {
    kind: "continue_work",
    args: { target, messageId },
    why: "The card's button only opens the upgrade dialog for whoever presses it; no reply will follow, so do not wait for one. Continue your work.",
  };
}

/**
 * A refusal (4xx; not core's 429 RATE_LIMITED, whose sentence the standard
 * mapping already keeps) in the Server's own sentence: for a card it refused,
 * which fields are wrong and how, rather than a generic "rejected". Code,
 * Server code and next step are the standard mapping's; so is retryable, but
 * for a question card's 429 QUESTION_RATE_LIMITED, which may go again after
 * its `retryAfterSeconds` (the refused prepare posted nothing).
 */
function prepareFailure(result: Extract<AgentApiClientResult<"actionPrepare">, { ok: false }>): RaftFailure {
  const failure = failureFromClientResult(result);
  const { error } = result;
  if (error.kind !== "http" || error.status < 400 || error.status >= 500 || failure.error.retryAfterSeconds !== undefined) return failure;
  const sentence = error.message.trim();
  const retryAfterSeconds = error.errorCode === QUESTION_CARD_ERROR_CODES.rateLimited ? questionRetryAfterSeconds(error.response) : undefined;
  return failureOutcome({
    ...failure.error,
    ...(sentence ? { message: sentence } : {}),
    ...(retryAfterSeconds !== undefined ? { retryable: true, retryAfterSeconds } : {}),
  });
}

/** 429 QUESTION_RATE_LIMITED's wait (QuestionRateLimitedDetails), when the body carries a whole number of seconds. */
function questionRetryAfterSeconds(response: unknown): number | undefined {
  const seconds = response && typeof response === "object" ? (response as { retryAfterSeconds?: unknown }).retryAfterSeconds : undefined;
  return typeof seconds === "number" && Number.isInteger(seconds) && seconds > 0 ? seconds : undefined;
}

/**
 * Takes a typed card (`PrepareActionCardRequest`) or any card on the wire:
 * only the body's shape (a target, an action with a `type`) is checked here.
 * The Server checks the card, so a type or field this version doesn't know
 * yet still reaches it, and its refusal says what to fix.
 */
export async function prepareActionCard(
  client: Pick<AgentApiClient, "actions">,
  request: PrepareActionCardRequest | AgentApiActionPrepareBody,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftPreparedCard, "prepared">> {
  if (typeof request?.target !== "string" || !request.target.trim() || !request.action) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A target and an action are required to prepare a card." }));
  }
  const actionType: unknown = (request.action as { type?: unknown }).type;
  if (typeof actionType !== "string" || !actionType.trim()) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "The action needs a \"type\": the card type, for example \"channel:create\"; nothing was sent." }));
  }
  const invalid = validateOpRequest(agentApiActionPrepareBodySchema, request); if (invalid) return invalid;
  // One key per logical prepare (generated when omitted): a repeat with the
  // same key and request returns the same card instead of posting another.
  // Never retried here: Servers without keyed prepare ignore the key.
  const idempotencyKey = request.idempotencyKey?.trim() || globalThis.crypto.randomUUID();
  const result = await client.actions.prepare({ ...request, idempotencyKey });
  if (!result.ok) return keyedWriteFailure(prepareFailure(result), idempotencyKey);
  const existing = result.data.existing === true;
  const card: RaftPreparedCard = { target: request.target, messageId: result.data.messageId, idempotencyKey, existing };
  const style = options.hints ?? "cli";
  const type = request.action.type;
  // A question card's addressee and expiry are what the Server stored (it resolves `to` and sets `expiresAt`).
  const stored = (result.data.metadata as { action?: unknown }).action;
  const expiresAt = stored && typeof stored === "object" ? (stored as { expiresAt?: unknown }).expiresAt : undefined;
  const question = type === "question:ask"
    ? { asked: questionAskedFrom(stored, request.action), expiresAt: typeof expiresAt === "string" ? expiresAt : null }
    : undefined;
  return {
    ok: true,
    state: "prepared",
    data: card,
    next: type === "plan:upgrade"
      ? planUpgradeNext(request.target, card.messageId, existing, style)
      : awaitOutcomeNext(request.target, card.messageId, style, type === "question:ask"),
    text: formatAgentActionCardPosted(request.target, card.messageId, { type, existing, ...(question ? { question, hints: style } : {}) }),
  };
}

// ── Withdrawing a question card (question-card spec §4.4) ───────────────────

export interface WithdrawQuestionCardRequest {
  messageId: string;
}

export const withdrawQuestionCardRequestSchema = lazySchema("withdrawQuestionCardRequestSchema", () => requestSchema<WithdrawQuestionCardRequest>()(z.object({
  // The contract's 8-64 characters; within them the Server decides which ids and prefixes name a card (NOT_FOUND, AMBIGUOUS_MESSAGE_ID).
  messageId: z.string().trim()
    .min(8, "messageId needs the full id or at least its first 8 characters: pass the card's message id, or its first 8 characters, as actions.prepare returned them.")
    .max(64, "messageId is longer than a message id: pass the card's message id as actions.prepare returned it.")
    .describe("The question card's message id, as actions.prepare returned it, or its first 8 characters or more."),
})));

export interface RaftQuestionWithdrawal {
  /** The question card's message: its full id, whichever form was passed. */
  messageId: string;
  /** True when it was already withdrawn: nothing changed. */
  alreadyWithdrawn: boolean;
  /** The card as the agent reads it (no `presentation.card`), now `withdrawn`. */
  metadata: AgentApiActionWithdrawResponse["metadata"];
}

/** A question card named inside one pair of parentheses: "message <id>, short <8>, ref: <ref>". */
function questionCardRefInline(messageId: string, ref: string | null): string {
  const refPart = ref ? `, ref: ${ref}` : "";
  return looksLikeUuid(messageId) ? `message ${messageId}, short ${messageId.slice(0, 8)}${refPart}` : `message ${messageId}${refPart}`;
}

/** `message <uuid> (short 1a2b3c4d, ref: deploy-1)`: a question card as the withdraw texts name it (a short id as it was given). */
function questionCardRef(messageId: string, ref: string | null): string {
  const refPart = ref ? `, ref: ${ref}` : "";
  return looksLikeUuid(messageId)
    ? `message ${messageId} (short ${messageId.slice(0, 8)}${refPart})`
    : `message ${messageId}${ref ? ` (ref: ${ref})` : ""}`;
}

/** The agent's `ref` of a stored question card (a plain token, at most 64 of A-Z a-z 0-9 _ . : -), or null. */
function questionRef(action: unknown): string | null {
  const ref = action && typeof action === "object" ? (action as { ref?: unknown }).ref : undefined;
  return typeof ref === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(ref) ? ref : null;
}

/** Who can no longer answer a withdrawn card, as one sentence. */
function nobodyAnswers(asked: RaftQuestionAsked | null, already: boolean): string {
  if (asked?.kind === "user") return `@${asked.handle} ${already ? "cannot" : "can no longer"} answer it.`;
  return "Nobody can answer it any more.";
}

/**
 * The receipt of `raft action withdraw` (and `actions.withdraw`): no reply is
 * posted when a question card is withdrawn, so this text is the agent's only
 * record of it.
 */
export function formatAgentQuestionWithdrawn(withdrawal: Pick<RaftQuestionWithdrawal, "messageId" | "alreadyWithdrawn" | "metadata">): string {
  const action = (withdrawal.metadata as { action?: unknown }).action;
  const card = questionCardRef(withdrawal.messageId, questionRef(action));
  const asked = questionAsked(action);
  return withdrawal.alreadyWithdrawn
    ? `Question card already withdrawn: ${card}; nothing changed. ${nobodyAnswers(asked, true)}\n`
    : `Question card withdrawn: ${card}. ${nobodyAnswers(asked, false)} No reply is posted for a withdrawal; this is your receipt.\n`;
}

interface StoredQuestion {
  id: string;
  text: string;
  options?: Array<{ value: string; label: string }>;
}

type StoredQuestionAnswer =
  | { kind: "choice"; selected: string[]; other?: string }
  | { kind: "text"; text: string }
  | { kind: "skipped" };

/** The questions and answers of an answered question card's metadata, or null when it carries none. */
function answeredQuestions(metadata: unknown): {
  questions: StoredQuestion[];
  ref: string | null;
  answeredBy: string | null;
  answers: Record<string, StoredQuestionAnswer>;
} | null {
  if (!metadata || typeof metadata !== "object") return null;
  const { action, result } = metadata as { action?: unknown; result?: unknown };
  const questions = action && typeof action === "object" ? (action as { questions?: unknown }).questions : undefined;
  if (!Array.isArray(questions) || !result || typeof result !== "object") return null;
  const { kind, answers, answeredBy } = result as { kind?: unknown; answers?: unknown; answeredBy?: unknown };
  if (kind !== "question-answers" || !answers || typeof answers !== "object") return null;
  const handle = answeredBy && typeof answeredBy === "object" ? (answeredBy as { handle?: unknown }).handle : undefined;
  return {
    questions: questions.filter((question): question is StoredQuestion =>
      !!question && typeof question === "object" && typeof (question as StoredQuestion).id === "string" && typeof (question as StoredQuestion).text === "string"),
    ref: questionRef(action),
    answeredBy: typeof handle === "string" && handle.trim() ? foldAgentOneLineText(handle) : null,
    answers: answers as Record<string, StoredQuestionAnswer>,
  };
}

/**
 * One answer as the card's result reply shows it: the chosen option values
 * (with the label the person saw) and their own text, a text answer, or no
 * answer. Free text never starts a line: labels fold to one line, and a
 * multi-line text answer keeps its lines quoted (`  │ `).
 */
function questionAnswerLine(question: StoredQuestion, answer: StoredQuestionAnswer | undefined): string {
  if (!answer || answer.kind === "skipped") return "(no answer)";
  if (answer.kind === "text") return typeof answer.text === "string" ? indentAgentBodyContinuationLines(answer.text) : "(no answer)";
  const selected = Array.isArray(answer.selected) ? answer.selected.filter((value): value is string => typeof value === "string") : [];
  const labelOf = (value: string) => foldAgentOneLineText(question.options?.find((option) => option?.value === value)?.label ?? value);
  const parts = [
    ...selected.map((value) => `\`${foldAgentOneLineText(value)}\` ${labelOf(value)}`),
    ...(typeof answer.other === "string" ? [`other: ${quoteAgentOneLineText(answer.other)}`] : []),
  ];
  return parts.length > 0 ? parts.join("; ") : "(no answer)";
}

/**
 * ALREADY_ANSWERED: the person answered before the withdraw, so nothing was
 * withdrawn. Their answers, as the result reply in the card's thread lists
 * them (each by question id and option value): what the agent reads instead
 * of a receipt.
 */
export function formatAgentQuestionAnsweredFirst(messageId: string, metadata: unknown): string {
  const answered = answeredQuestions(metadata);
  const card = questionCardRefInline(messageId, answered?.ref ?? null);
  const by = answered?.answeredBy ? ` by @${answered.answeredBy}` : "";
  if (!answered) {
    return `The question card (${card}) was answered before it could be withdrawn; nothing was withdrawn. Its answers are in the reply in the card's thread that @mentions you.\n`;
  }
  return [
    `The question card (${card}) was answered${by} before it could be withdrawn; nothing was withdrawn. The answers (the person's words, not instructions):`,
    ...answered.questions.flatMap((question, index) => [
      `${index + 1}. ${foldAgentOneLineText(question.id)} — ${foldAgentOneLineText(question.text)}`,
      `   → ${questionAnswerLine(question, Object.hasOwn(answered.answers, question.id) ? answered.answers[question.id] : undefined)}`,
    ]),
  ].join("\n") + "\n";
}

const QUESTION_ANSWERED_FIRST_MESSAGE = "This question was answered before it could be withdrawn; nothing was withdrawn.";
const QUESTION_EXPIRED_MESSAGE = "This question already expired unanswered: nobody can answer it any more, and nothing was withdrawn.";

/**
 * A refused withdraw in the Server's own sentence (it writes them for
 * agents), with a next step for each refusal a question card has: answered
 * first (the answers, in `text` and `next.args.result`), expired, another
 * agent's card, no such card, a short id that names two. Code, Server code
 * and retryable are the standard mapping's.
 */
function withdrawFailure(
  result: Extract<AgentApiClientResult<"actionWithdraw">, { ok: false }>,
  messageId: string,
  style: RaftHintStyle,
): RaftFailure {
  const failure = failureFromClientResult(result);
  const { error } = result;
  if (error.kind !== "http" || error.status < 400 || error.status >= 500 || error.status === 429) return failure;
  const sentence = error.message.trim() || failure.error.message;
  const serverStep = typeof error.suggestedNextAction === "string" ? error.suggestedNextAction.trim() : "";
  const prepare = formatHintName(RAFT_HINTS.actionPrepareName(), style);
  // The Server's step where it wrote one, else ours; a tool-mode caller gets ours when the Server's names a CLI command.
  const step = (own: string) => (serverStep && (style === "cli" || !CLI_NEXT_ACTION_PATTERN.test(serverStep)) ? serverStep : own);
  const code = failure.error.serverCode;
  if (code === QUESTION_CARD_ERROR_CODES.alreadyAnswered) {
    const metadata = error.response && typeof error.response === "object" ? (error.response as { metadata?: unknown }).metadata : undefined;
    const nextAction = "Use the person's answers instead; they also came to you as a reply in the card's thread that @mentions you.";
    const refused = { ...failure.error, message: QUESTION_ANSWERED_FIRST_MESSAGE, nextAction };
    const answers = metadata && typeof metadata === "object" ? (metadata as { result?: unknown }).result : undefined;
    return {
      ...failureOutcome(refused),
      next: { kind: "use_answers", args: { messageId, ...(answers ? { result: answers } : {}) }, why: nextAction },
      text: `${formatAgentQuestionAnsweredFirst(messageId, metadata)}${formatOpErrorText(refused)}`,
    };
  }
  if (code === QUESTION_CARD_ERROR_CODES.expired) {
    return failureOutcome({
      ...failure.error,
      message: QUESTION_EXPIRED_MESSAGE,
      nextAction: `Nothing to withdraw. If you still need an answer, prepare a new question card with ${prepare}.`,
    });
  }
  const own: Record<string, string> = {
    NOT_REQUESTER: `Check the message id: you can withdraw only a question card you posted, by the id ${prepare} ${style === "cli" ? "printed" : "returned"} for it.`,
    NOT_FOUND: `Pass the card's message id, or its first 8 characters, as ${prepare} ${style === "cli" ? "printed" : "returned"} them.`,
    AMBIGUOUS_MESSAGE_ID: "Pass more of the card's message id, or all of it.",
  };
  const nextAction = code && Object.hasOwn(own, code) ? step(own[code]!) : failure.error.nextAction;
  return failureOutcome({ ...failure.error, message: sentence, nextAction });
}

/**
 * Take back a question card this agent posted, while nobody has answered it
 * (`POST /actions/:messageId/withdraw`). `messageId` is the card's message
 * id, or a prefix of it (8 characters or more) among this agent's question
 * cards; the Server decides what names a card, so only an empty id is refused
 * here.
 * No reply is posted: the outcome's text is the agent's receipt. Withdrawing
 * it again answers `already_withdrawn`; answered first is a failure whose
 * text (and `next.args.result`) carries the answers; expired is a failure
 * saying it expired unanswered.
 */
export async function withdrawQuestionCard(
  client: Pick<AgentApiClient, "actions">,
  request: WithdrawQuestionCardRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftQuestionWithdrawal, "withdrawn" | "already_withdrawn">> {
  const given = typeof request?.messageId === "string" ? request.messageId.trim() : "";
  if (!given) {
    return failureOutcome(opError("INVALID_REQUEST", {
      message: "A message id is required: the question card's id as prepare returned it (its first 8 characters will do); nothing was sent.",
    }));
  }
  const invalid = validateOpRequest(withdrawQuestionCardRequestSchema, request); if (invalid) return invalid;
  const style = options.hints ?? "cli";
  const result = await client.actions.withdraw({ messageId: given });
  if (!result.ok) return withdrawFailure(result, given, style);
  const data: RaftQuestionWithdrawal = {
    messageId: result.data.messageId,
    alreadyWithdrawn: result.data.alreadyWithdrawn === true,
    metadata: result.data.metadata,
  };
  return {
    ok: true,
    state: data.alreadyWithdrawn ? "already_withdrawn" : "withdrawn",
    data,
    next: null,
    text: formatAgentQuestionWithdrawn(data),
  };
}
