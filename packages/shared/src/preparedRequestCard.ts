// RFC 085 §4.2-§4.4: the prepared-request card (`request:prepare`).
//
// An agent names an operation on the server's delegable list (the server's
// services/delegableCardRoutes.ts, empty until the first templates) and the
// person who is to confirm it. The server resolves the agent's args to the
// route's path params and body under the agent's visibility, builds the
// summary model (the resolved ids and values the person approves), stores
// the card with a digest of route, params, body and model, and posts it in
// the conversation. Only the named person commits: the server runs that exact
// request as them through the route's own middleware (assistant owner
// actions' dispatchOwnerRoute), or they decline.
//
// Two schemas, as question:ask: what an agent sends
// (preparedRequestAgentActionSchema) and what a card stores
// (preparedRequestActionSchema). The agent's shape is not in the agent card
// union (actionCards.ts actionCardActionSchema): while the server flag
// `prepared_request_card_v0` is off, prepare refuses the type exactly as it
// refuses a type it doesn't know, and the server's prepare picks the type up
// before that union only when the flag is on.
//
// Everything a viewer sees on the card is the server's: the template's copy
// (actionCardMessages keys, `display`) over the model's ids (EntityRefs, so
// each viewer's client names what it can see), the agent's `note` as raw text
// under Reason. The card carries no route answer: a route refusal is kept as
// its status and code only (`refusal`), since every viewer and the agent read
// the card.

import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { isActionCardMessageKey } from "./actionCardMessageKeys";
import { SERVER_CAPABILITY_KEYS } from "./serverPermissions";

export const PREPARED_REQUEST_ACTION_TYPE = "request:prepare" as const;

/** At most this many open cards per agent and named person (RFC 085 §4.2); the next prepare is refused and names them. */
export const PREPARED_REQUEST_OPEN_PER_PERSON = 5;
/** The agent's note, shown under Reason as its own raw text. */
export const PREPARED_REQUEST_NOTE_MAX_LENGTH = 500;
/** An operation's agent-facing name: `noun:verb` (`agent:stop`, `channel:archive`). */
export const PREPARED_REQUEST_OPERATION_PATTERN = /^[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,31}$/;
/** A route as the delegable list keys it: method and the Express path under /api. */
export const PREPARED_REQUEST_ROUTE_PATTERN = /^(POST|PUT|PATCH|DELETE) \/api\/[A-Za-z0-9_:/.-]{1,280}$/;
/** A summary model entry's name; it is also the Msg param the template's copy fills with it. */
export const PREPARED_REQUEST_MODEL_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,31}$/;
/** A Msg takes at most 8 params (actionCardSpec maxParams); the title takes every model entry. */
export const PREPARED_REQUEST_MODEL_MAX_ENTRIES = 8;
/** The decision field of the card's form, as the assistant owner-action card's. */
export const PREPARED_REQUEST_DECISION_FIELD = "decision";

/**
 * The card's form id carries the digest the person was shown (RFC 085 §4.2:
 * "the person's client posts the card id and the digest it showed"): `d` and
 * the digest's first 31 hex digits, within a form id's 32 characters. A client
 * that posts the form it drew posts that digest; a form built from an older
 * summary names a form the card no longer has and is refused.
 */
export function preparedRequestFormId(digest: string): string {
  return `d${digest.slice(0, 31)}`;
}

const argName = lazySchema("preparedRequestArgName", () => z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/));
/** An arg in the agent's own words: a handle, a name, a role, a number, a flag, or a list of names. */
const argValue = lazySchema("preparedRequestArgValue", () => z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null(), z.array(z.string().max(500)).max(50)]));

/** What an agent sends to prepare one: `{"type":"request:prepare","to":"@person","operation":"agent:stop","args":{...},"note":"why"}`. */
export const preparedRequestAgentActionSchema = lazySchema("preparedRequestAgentActionSchema", () => z.strictObject({
  type: z.literal(PREPARED_REQUEST_ACTION_TYPE),
  /** The one person who may confirm it: their handle (`@name`). */
  to: z.string().trim().min(1).max(200),
  operation: z.string().regex(PREPARED_REQUEST_OPERATION_PATTERN, "an operation name such as agent:stop"),
  args: z.record(argName, argValue).refine((args) => Object.keys(args).length <= 20, "at most 20 args").default({}),
  note: z.string().trim().min(1).max(PREPARED_REQUEST_NOTE_MAX_LENGTH).optional(),
}));
export type PreparedRequestAgentAction = z.infer<typeof preparedRequestAgentActionSchema>;

/** Whether an action as sent names this type (before any schema: prepare picks it up by its type alone). */
export function isPreparedRequestAgentAction(action: unknown): boolean {
  return typeof action === "object" && action !== null && (action as { type?: unknown }).type === PREPARED_REQUEST_ACTION_TYPE;
}

const PREPARED_REQUEST_ENTITY_KINDS = ["user", "agent", "channel", "computer"] as const;

/**
 * One value the person approves: an entity by id (a client names it from what
 * it can see), or a value as text (a role, a model). Never a display name:
 * names change without the request changing, so the model compares ids.
 */
export const preparedRequestModelValueSchema = lazySchema("preparedRequestModelValueSchema", () => z.union([
  z.strictObject({ kind: z.enum(PREPARED_REQUEST_ENTITY_KINDS), id: z.uuid() }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(200) }),
]));
export type PreparedRequestModelValue = z.infer<typeof preparedRequestModelValueSchema>;
export type PreparedRequestModel = Record<string, PreparedRequestModelValue>;

const modelName = lazySchema("preparedRequestModelName", () => z.string().regex(PREPARED_REQUEST_MODEL_NAME_PATTERN));
const messageKey = lazySchema("preparedRequestMessageKey", () => z.string().max(200).refine(isActionCardMessageKey, "not an action-card message key"));

/**
 * How the card draws the model, from the route's summary template (RFC 085
 * §4.3): message keys only, the copy in every locale living in
 * actionCardMessages. `title` (verb plus object) takes every model entry as a
 * param by its name; `verb` labels the confirm ("Stop agent"); each field is a
 * label over one model entry.
 */
export const preparedRequestDisplaySchema = lazySchema("preparedRequestDisplaySchema", () => z.strictObject({
  title: messageKey,
  verb: messageKey,
  fields: z.array(z.strictObject({ label: messageKey, value: modelName })).max(PREPARED_REQUEST_MODEL_MAX_ENTRIES),
}));
export type PreparedRequestDisplay = z.infer<typeof preparedRequestDisplaySchema>;

/** A route refusal on the last attempt (the card stays open): its status and code, never its body. */
const refusalSchema = lazySchema("preparedRequestRefusalSchema", () => z.strictObject({
  status: z.number().int().min(400).max(499),
  code: z.string().min(1).max(80),
  attempt: z.number().int().min(1),
  at: z.iso.datetime(),
}));

/** What a `request:prepare` card stores (action_cards.payload, and the carrier's metadata.action). */
export const preparedRequestActionSchema = lazySchema("preparedRequestActionSchema", () => z.strictObject({
  type: z.literal(PREPARED_REQUEST_ACTION_TYPE),
  operation: z.string().regex(PREPARED_REQUEST_OPERATION_PATTERN),
  /** The delegable route it runs, as the list keys it ("POST /api/channels/:id/archive"). */
  route: z.string().regex(PREPARED_REQUEST_ROUTE_PATTERN),
  /** The route's path params, as its params schema parsed them. Never a query string. */
  params: z.record(z.string().regex(/^[A-Za-z]\w{0,31}$/), z.string().min(1).max(200)),
  /** The body, exactly as the route's body schema parsed it (only its output is kept and sent). */
  body: z.record(z.string(), z.json()),
  /** The capability the list names for the route: a client folds the card for a viewer without it. The route decides. */
  permission: z.enum(SERVER_CAPABILITY_KEYS),
  /** The one person who may confirm or decline, by id; `handle` as their row has it. */
  addressee: z.strictObject({ kind: z.literal("user"), userId: z.uuid(), handle: z.string().min(1).max(200) }),
  note: z.string().min(1).max(PREPARED_REQUEST_NOTE_MAX_LENGTH).optional(),
  /** The route's summary template (the list's `summaryTemplate`). */
  template: z.string().min(1).max(80),
  /** The summary model: the resolved ids and values the person approves (RFC 085 §4.2 step 3). */
  summaryModel: z.record(modelName, preparedRequestModelValueSchema)
    .refine((model) => Object.keys(model).length <= PREPARED_REQUEST_MODEL_MAX_ENTRIES, `at most ${PREPARED_REQUEST_MODEL_MAX_ENTRIES} entries`),
  display: preparedRequestDisplaySchema,
  /** sha256 hex of the canonical { route, params, body, summaryModel }: what the person confirms. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * The commit attempt the next confirm makes, from 1. A route refusal (4xx)
   * reopens the card for the next one; the route's idempotency key is the
   * card's message id and this number.
   */
  attempt: z.number().int().min(1).max(10_000),
  refusal: refusalSchema.optional(),
  /** When the server rebuilt the model at a commit and it differed from what was prepared (RFC 085 §4.2 step 2). */
  changedAt: z.iso.datetime().optional(),
  /**
   * The card waits to be confirmed again because its summary changed (set
   * with `reconfirm_required`, cleared when the person confirms again), as
   * opposed to a channel conversion asking for it, which its own path answers.
   */
  changePending: z.literal(true).optional(),
}).superRefine((action, ctx) => {
  for (const [index, field] of action.display.fields.entries()) {
    if (!Object.hasOwn(action.summaryModel, field.value)) ctx.addIssue({ code: "custom", path: ["display", "fields", index, "value"], message: "not a model entry" });
  }
}));
export type PreparedRequestAction = z.infer<typeof preparedRequestActionSchema>;

/**
 * The one result kind the preparing agent gets back (RFC 085 §4.2), whatever
 * the route: the outcome, the route's own refusal code when it ran and
 * refused, and the summary as the agent may see it. Never the route's
 * response body: the route ran with the person's visibility.
 *
 * - `success`: the route answered 2xx.
 * - `refused`: the route answered 4xx with `code`; the card is open for another try.
 * - `unknown`: no answer in time, a 5xx, or the process stopped between the
 *   claim and the record: it may have run, and is never run again.
 * - `changed_since_prepared`: the summary changed and now names something the
 *   preparing agent can't see; the card can't be confirmed.
 * - `declined`, `expired` (30 days), `withdrawn` (by the agent).
 */
export const PREPARED_REQUEST_OUTCOMES = ["success", "refused", "unknown", "changed_since_prepared", "declined", "expired", "withdrawn"] as const;
export type PreparedRequestOutcome = (typeof PREPARED_REQUEST_OUTCOMES)[number];

/** How a card ended, as its `metadata.result` records it (the outcomes that end a card where a person acted). */
export type PreparedRequestCardOutcome = Extract<PreparedRequestOutcome, "success" | "unknown" | "changed_since_prepared" | "declined">;
