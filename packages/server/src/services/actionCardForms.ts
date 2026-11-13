// Form handlers for first-party action cards (form.v1, spec §3.4).
//
// An action type with a form handler is a form card: its presentation.card
// carries the handler's forms and an `open_form` button
// (actionCardPresentation.ts), its legacy presentation refuses a generic
// approve, and POST /api/actions/:messageId/execute completes it only with a
// submitted `form` (actionCardsService.executeActionCard):
//   1. the form id must be one of the card's forms;
//   2. checkActionCardFormValues(form, values, { mode: "server" }) (shared:
//      required, lengths, types, options, unknown names, id format);
//   3. handler.validate: whatever only the server can know (each picker id
//      exists and this person may choose it, conflicts);
//   4. handler.execute, in execute's transaction, under its locks, in place of
//      the type's built-in action; the card is marked executed with its result.
// Any issue is a 422 FORM_INVALID with the issues, and nothing is written.
// A handler whose action leaves Raft (a call to another service) has a
// `deliver` step: steps 1-3 and `deliver` run before execute's transaction,
// so no lock is held while the other service answers, and step 4 records
// what it returned.
//
// The submitted values are kept in action_cards.submitted_input, never in the
// message metadata (what the channel, realtime updates and agents read) and
// never in logs or funnel events; the card shows its `result` afterwards.
//
// Production form cards: feedback:submit (services/feedbackCardForm.ts),
// agent:approve_call (services/agentApproveCallForm.ts) and question:ask
// (services/questionAskForm.ts).
// Tests register others with setActionCardFormHandlerForTest.

import type {
  ActionCardFormIssue,
  ActionCardFormSubmission,
  ActionCardFormValue,
  ActionCardResult,
  ActionCardSpecBuildContext,
  ActionCardSpecField,
  ActionCardSpecForm,
  ServerId,
  StoredActionCardAction,
  StoredActionCardActionType,
} from "@botiverse/raft-shared";
import { actionCardFormIssue, checkActionCardFormValues } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import type { getDb } from "../db/index";
import { agentApproveCallFormHandler } from "./agentApproveCallForm";
import { assistantOwnerActionFormHandler, type OwnerConfirmRequest } from "./assistantOwnerActionCards";
import { feedbackCardFormHandler } from "./feedbackCardForm";
import { questionAskFormHandler } from "./questionAskForm";
import type { RequestClient } from "./productEventContext";

type ActionOf<T extends StoredActionCardActionType> = Extract<StoredActionCardAction, { type: T }>;

/** What a handler's validate and execute see. */
export interface ActionCardFormContext<T extends StoredActionCardActionType = StoredActionCardActionType> {
  /** The card's action as stored (action_cards.payload), re-read under execute's lock. */
  action: ActionOf<T>;
  /** The form submitted (one of buildForm's ids). */
  formId: string;
  /**
   * Execute's transaction: read and write through it, never through getDb().
   * For a handler with `deliver`, validate and deliver run before that
   * transaction, and this is the plain database (no lock held).
   */
  executor: ReturnType<typeof getDb>;
  /** The card's target server, where the action runs and every permission is checked. */
  serverId: ServerId;
  /** The person submitting the form (the executor once it succeeds). */
  userId: string;
  requesterAgentId: string;
  messageId: string;
  /** The card's confirmation version, for writers that re-check the card (createChannel's actionCardMessageId). */
  confirmationVersion: number;
  /** The card's channel as the target server sees it (a picker's `scope: "channel"`). */
  channelId: string;
  /**
   * The client the form was sent from, by the execute request's headers
   * (requestClient: X-Raft-Client-Platform, User-Agent), never its body;
   * `unknown` without one. feedback:submit files it with the feedback.
   */
  client: RequestClient;
  /**
   * The socket server, for a handler whose action changes other cards
   * (agent:approve_call: every card of the same hold); absent outside a request.
   */
  io?: SocketServer | null;
  /**
   * The submitter's own request (the app and their Authorization header), for
   * a handler whose action runs one of their own routes: an assistant
   * owner-action card's Confirm (assistantOwnerActionCards.ts). Absent outside a request.
   */
  ownerRequest?: OwnerConfirmRequest;
}

export type ActionCardFormValidation<I> = { input: I } | { issues: ActionCardFormIssue[] };

/**
 * One form card type. The spec and the checks live together, so the server
 * stays the only authority over what a form accepts.
 */
export interface ActionCardFormHandler<T extends StoredActionCardActionType = StoredActionCardActionType, I = unknown> {
  /**
   * The card's forms by id (`^[a-z][a-z0-9_]{0,31}$`, at most 2), from the
   * action (an agent's prefill goes in `default`). The card's button opens the
   * first. Must pass the emit parse with the card, else the card is left out.
   */
  buildForm(action: ActionOf<T>, ctx: ActionCardSpecBuildContext): Record<string, ActionCardSpecForm>;
  /**
   * Values that passed the shared checks (every key is a field of the form,
   * every value of its field's type). Picker ids: whether each exists
   * (not_found) and whether this person may choose it here (not_allowed) is
   * this handler's to check, through ctx.executor. Never put a value in an
   * issue's params.
   */
  validate(values: Record<string, ActionCardFormValue>, ctx: ActionCardFormContext<T>): Promise<ActionCardFormValidation<I>>;
  /**
   * Optional: the part of the action that leaves Raft (a call to another
   * service). It runs once validate passed and BEFORE execute's transaction:
   * that transaction locks the card's channel, which would stall every
   * message sent there while the other service answered. What it returns is
   * execute's input. The card is still prepared then and may not be after
   * (someone else completes it, a conversion freezes it), and a retry runs it
   * again, so it must be idempotent per card and person. Its errors do not
   * reach the requesting agent (nothing happened on the card; the submitter
   * retries): give them a `status` and `code` for the response.
   */
  deliver?(input: I, ctx: ActionCardFormContext<T>): Promise<I>;
  /**
   * Runs the action, in place of the type's built-in one: the permission to
   * do it is this handler's to check (execute has checked that this person
   * may operate the card). Throwing rolls everything back; the error's message
   * reaches the requesting agent as the failure reason, so it must not quote
   * submitted values (prefer an issue from validate). After `deliver`, it
   * only records what deliver returned.
   */
  execute(input: I, ctx: ActionCardFormContext<T>): Promise<ActionCardResult>;
  /**
   * The type also completes without its form, by its own path
   * (feedback:submit: its dialog's POST /api/product-feedback, which marks the
   * card). Then a card whose forms do not fit (a draft longer than a field
   * takes, or the card past 24 KiB) is sent with the type's own button
   * instead of no card at all. Leave it unset for any other type: its card
   * must never offer a button that ends in FORM_REQUIRED.
   */
  completesWithoutForm?: boolean;
}

// Production registry. A server-built type (agent:approve_call) is a form card too.
type Registry = { [T in StoredActionCardActionType]?: ActionCardFormHandler<T, unknown> };
const HANDLERS: Registry = {
  "feedback:submit": feedbackCardFormHandler,
  "agent:approve_call": agentApproveCallFormHandler,
  "assistant:owner_action": assistantOwnerActionFormHandler,
  "question:ask": questionAskFormHandler,
};
const handlersForTest: Registry = {};

/** The form handler for an action type, if it is a form card. */
export function actionCardFormHandlerFor(type: string): ActionCardFormHandler | undefined {
  const key = type as StoredActionCardActionType;
  return (Object.hasOwn(handlersForTest, key) ? handlersForTest[key] : Object.hasOwn(HANDLERS, key) ? HANDLERS[key] : undefined) as ActionCardFormHandler | undefined;
}

/** Make `type` a form card with `handler` (null: back to production). Test only. */
export function setActionCardFormHandlerForTest<T extends StoredActionCardActionType, I>(type: T, handler: ActionCardFormHandler<T, I> | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("action-card form handler hooks are test-only");
  if (handler) (handlersForTest as Record<string, unknown>)[type] = handler;
  else delete handlersForTest[type];
}

/** action_cards.submitted_input: the form and the values exactly as accepted. */
export interface ActionCardSubmittedInput { form: string; values: Record<string, ActionCardFormValue> }

/** The legacy presentation's note on a form card, for clients that only read it. */
export const ACTION_CARD_FORM_LEGACY_WARNING = "Open this card on the web to fill in its form.";

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * Text Postgres cannot keep in jsonb (U+0000, an unpaired surrogate) would
 * fail the write after the action ran; refuse it as invalid_format first.
 */
function storableIssues(form: ActionCardSpecForm, values: Record<string, ActionCardFormValue>): ActionCardFormIssue[] {
  const unstorable = (text: string) => text.includes("\u0000") || LONE_SURROGATE.test(text);
  return form.fields.flatMap((field: ActionCardSpecField) => {
    const value = Object.hasOwn(values, field.name) ? values[field.name] : undefined;
    const texts = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
    return texts.some(unstorable) ? [actionCardFormIssue(field.name, "invalid_format")] : [];
  });
}

export type ActionCardFormRun =
  | { ok: true; result: ActionCardResult; submittedInput: ActionCardSubmittedInput }
  | { ok: false; issues: ActionCardFormIssue[] };

export type ActionCardFormCheck =
  | { ok: true; input: unknown; submittedInput: ActionCardSubmittedInput }
  | { ok: false; issues: ActionCardFormIssue[] };

/**
 * Steps 1-3 above for one submission: what execute's input is, or the
 * issues. `forms` are the card's forms as the emit parse returned them (none:
 * the card has no form, every id is unknown).
 */
export async function checkActionCardForm(input: {
  handler: ActionCardFormHandler | undefined;
  forms: Record<string, ActionCardSpecForm> | undefined;
  submission: ActionCardFormSubmission;
  ctx: Omit<ActionCardFormContext, "formId">;
}): Promise<ActionCardFormCheck> {
  const { handler, forms, submission } = input;
  const form = handler && forms && Object.hasOwn(forms, submission.id) ? forms[submission.id] : undefined;
  if (!handler || !form) return { ok: false, issues: [actionCardFormIssue(null, "invalid_format")] };
  const checked = checkActionCardFormValues(form, submission.values, { mode: "server" });
  if (checked.length > 0) return { ok: false, issues: checked };
  // The shared check passed: a plain record of the form's fields, each of its type.
  const values = submission.values;
  const unstorable = storableIssues(form, values);
  if (unstorable.length > 0) return { ok: false, issues: unstorable };
  const validated = await handler.validate(values, { ...input.ctx, formId: submission.id });
  if ("issues" in validated) {
    return { ok: false, issues: validated.issues.length > 0 ? validated.issues : [actionCardFormIssue(null, "invalid_format")] };
  }
  return { ok: true, input: validated.input, submittedInput: { form: submission.id, values } };
}

/** Steps 1-4 above for one submission, for a handler without `deliver`. */
export async function runActionCardForm(input: {
  handler: ActionCardFormHandler | undefined;
  forms: Record<string, ActionCardSpecForm> | undefined;
  submission: ActionCardFormSubmission;
  ctx: Omit<ActionCardFormContext, "formId">;
}): Promise<ActionCardFormRun> {
  const checked = await checkActionCardForm(input);
  if (!checked.ok) return checked;
  const result = await input.handler!.execute(checked.input, { ...input.ctx, formId: input.submission.id });
  return { ok: true, result, submittedInput: checked.submittedInput };
}
