// App-sent cards, step 1 (RFC 086 §4): an App's bot sends a card message
// (RFC 082) whose buttons act through the App's action endpoint exactly as
// link card buttons do (RFC 076), optionally for one named person (`for`).
//
// The stored card stays valid under the strict card schema every client in
// use reads (messageCard.ts): an acting button is an ordinary navigate Button
// whose `action.url` is the App's fallback page for it and whose
// `disabledReason` Raft writes at send ("Update Raft to use this button"), so
// an older client draws it disabled and never as a link (RFC 082 §5). What
// makes it act is next to the card in the message's metadata:
//
//   action_metadata = { kind: "message-card", card, revision, updatedAt,
//                       actions: { [buttonElementId]: <RFC 076 execute action> },
//                       for?: <user id> }
//
// A client that draws acting buttons declares `card.execute.v1` on the
// batched link card read and gets a handle per acting button it may press
// (`message_card` in the answer); everything after the handle is RFC 076.

//
// Step 2 (RFC 086 §5.1): an acting button's action may carry a `form` the
// person fills in before it runs: TextInput fields, and SecretInput fields
// whose values their device seals to the App (§5.3). Forms are an App-sent
// card's only: a link card's (RFC 076) execute action stays as it is.

import { z } from "zod";
import { LINK_CARD_ACTION_ID, type AppCardEncryptionKey } from "./appLinkPreview";
import { CARD_RESERVED_IDS, cardCodePoints, cardText } from "./cardElements";
import { lazySchema } from "./lazySchema";
import { MESSAGE_CARD_LIMITS, type MessageCard, type MessageCardMetadata } from "./messageCard";

/** The capability a client declares on the link card read when it draws a card message's acting buttons (RFC 086 §4.4). */
export const MESSAGE_CARD_EXECUTE_CAPABILITY = "card.execute.v1" as const;

/**
 * The one stored text of an acting button (RFC 086 §4.4; English): what an
 * older client, which reads only the card, shows on it. Raft writes it at
 * send and update, over whatever the sender put there.
 */
export const MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON = "Update Raft to use this button";

/**
 * The capability a client declares on the link card read when it draws a
 * form on an acting button (RFC 086 §5.1) and fills its TextInput fields.
 * Without it, a button that has a form gets no handle.
 */
export const MESSAGE_CARD_FORM_CAPABILITY = "card.form.v1" as const;
/**
 * The capability a client declares when it also draws SecretInput fields and
 * seals their values to the App (RFC 086 §5.1, §5.3). Without it (or without
 * `card.form.v1`), a button whose form holds a SecretInput gets no handle.
 */
export const MESSAGE_CARD_SECRET_INPUT_CAPABILITY = "card.form.secret.v1" as const;
/** Every capability a card message's acting buttons use, as the read takes them from a client's list. */
export const MESSAGE_CARD_CAPABILITIES = [MESSAGE_CARD_EXECUTE_CAPABILITY, MESSAGE_CARD_FORM_CAPABILITY, MESSAGE_CARD_SECRET_INPUT_CAPABILITY] as const;
export type MessageCardCapability = typeof MESSAGE_CARD_CAPABILITIES[number];

/** Bounds of a form on an acting button (RFC 086 §5.1). */
export const MESSAGE_CARD_FORM_LIMITS = {
  /** Fields in one form. */
  maxFields: 4,
  /** A field's label, in code points (a Button's label: 40). */
  labelMaxCodePoints: 40,
  /** A field's placeholder, in code points. */
  placeholderMaxCodePoints: 120,
  /** The most a TextInput's `maxLength` may be, in code points (an action card's TextInput: 500); also its limit when it names none. */
  textInputMaxLength: 500,
  /** A SecretInput's value, in UTF-8 bytes (RFC 086 §5.1). A declared cap, not a field member: the client stops input there. */
  secretInputMaxBytes: 4096,
} as const;

/** A form field's id: the key of its value (the sealed plaintext is a JSON object of SecretInput values by id, §5.3). */
export const MESSAGE_CARD_FORM_FIELD_ID = LINK_CARD_ACTION_ID;

/** The fixed sentence for a SecretInput on an undo-window button (RFC 086 §5.1, Tenny 21a5e576). */
export const MESSAGE_CARD_SECRET_INPUT_UNDO_REFUSAL = "A form with a SecretInput goes on a confirm: \"prepare\" button, never on an undo-window button";

/** What a form that doesn't validate is refused with: its shape and bounds. */
const MESSAGE_CARD_FORM_SHAPE = "A form is { fields }: 1 to 4 fields, each { type: \"TextInput\" or \"SecretInput\", id (^[a-z][a-z0-9_]{0,31}$, once per form), label (1-40 characters, one line), placeholder? (1-120), required? }; a TextInput may add maxLength (1-500) and a one-line default within it; a SecretInput takes nothing else, never a default or value";

const CARD_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const oneLine = (max: number) => cardText(1, max).refine((value) => !CARD_LINE_BREAK.test(value), "Expected one line");
const formFieldId = lazySchema("messageCardFormFieldId", () => z.string().regex(MESSAGE_CARD_FORM_FIELD_ID)
  .refine((id) => !CARD_RESERVED_IDS.includes(id), "Not a field id"));
const formFieldCommon = () => ({
  id: formFieldId,
  label: oneLine(MESSAGE_CARD_FORM_LIMITS.labelMaxCodePoints),
  placeholder: oneLine(MESSAGE_CARD_FORM_LIMITS.placeholderMaxCodePoints).optional(),
  required: z.boolean().optional(),
});
/** A one-line text field; `default` (the App's proposal) at most `maxLength` code points, one line. */
const textInputField = lazySchema("messageCardTextInputField", () => z.strictObject({
  type: z.literal("TextInput"),
  ...formFieldCommon(),
  maxLength: z.number().int().min(1).max(MESSAGE_CARD_FORM_LIMITS.textInputMaxLength).optional(),
  default: z.string().optional(),
}).refine((field) => field.default === undefined
  || (cardCodePoints(field.default) <= (field.maxLength ?? MESSAGE_CARD_FORM_LIMITS.textInputMaxLength) && !CARD_LINE_BREAK.test(field.default)),
{ path: ["default"], message: "The default is one line of at most maxLength characters" }));
/**
 * A secret, sealed to the App on the person's device (RFC 086 §5.3): one
 * line, at most MESSAGE_CARD_FORM_LIMITS.secretInputMaxBytes UTF-8 bytes,
 * never prefilled (strict: no `default` or `value` member), never echoed.
 */
const secretInputField = lazySchema("messageCardSecretInputField", () => z.strictObject({
  type: z.literal("SecretInput"),
  ...formFieldCommon(),
}));
const uniqueFieldIds = (form: { fields: readonly { id: string }[] }) => new Set(form.fields.map((field) => field.id)).size === form.fields.length;
/** A form on an acting button: 1 to 4 TextInput or SecretInput fields, each id once. */
export const messageCardFormSchema = lazySchema("messageCardFormSchema", () => z.strictObject({
  fields: z.array(z.discriminatedUnion("type", [textInputField, secretInputField])).min(1).max(MESSAGE_CARD_FORM_LIMITS.maxFields),
}).refine(uniqueFieldIds, { path: ["fields"], message: "Each field has its own id" }));
export type MessageCardForm = z.infer<typeof messageCardFormSchema>;
export type MessageCardFormField = MessageCardForm["fields"][number];
/** An undo-window button's form: TextInput fields only (a SecretInput needs Raft's dialog first, §5.1). */
const messageCardTextFormSchema = lazySchema("messageCardTextFormSchema", () => z.strictObject({
  fields: z.array(textInputField).min(1).max(MESSAGE_CARD_FORM_LIMITS.maxFields),
}).refine(uniqueFieldIds, { path: ["fields"], message: "Each field has its own id" }));

/**
 * An acting button's action: RFC 076's execute action, the same shapes and
 * bounds (exactly one of confirm / undoWindowMs), plus an optional `form`
 * (RFC 086 §5.1). A SecretInput only on a `confirm: "prepare"` button.
 */
export const messageCardExecuteActionSchema = lazySchema("messageCardExecuteActionSchema", () => z.union([
  z.strictObject({ kind: z.literal("execute"), action_id: z.string().regex(LINK_CARD_ACTION_ID), confirm: z.literal("prepare"), form: messageCardFormSchema.optional() }),
  z.strictObject({
    kind: z.literal("execute"), action_id: z.string().regex(LINK_CARD_ACTION_ID), undoWindowMs: z.number().int().min(1000).max(10000), form: messageCardTextFormSchema.optional(),
  }),
]));
export type MessageCardExecuteAction = z.infer<typeof messageCardExecuteActionSchema>;

/** Whether an acting button's form asks for a secret (RFC 086 §5): only an official App with a card encryption key may send one. */
export function messageCardActionHasSecretInput(action: MessageCardExecuteAction): boolean {
  return !!action.form?.fields.some((field) => field.type === "SecretInput");
}

/** What a client must declare on the read to get a handle for this acting button. */
export function messageCardActionCapabilities(action: MessageCardExecuteAction): MessageCardCapability[] {
  return [
    MESSAGE_CARD_EXECUTE_CAPABILITY,
    ...(action.form ? [MESSAGE_CARD_FORM_CAPABILITY] : []),
    ...(messageCardActionHasSecretInput(action) ? [MESSAGE_CARD_SECRET_INPUT_CAPABILITY] : []),
  ];
}

/**
 * The form's values on execute (RFC 086 §5.3, §5.4), as the person's device
 * sends them in `POST /api/link-cards/execute` and Raft forwards them, inline,
 * in the execute request to the App's action endpoint; never stored, logged or
 * part of the request digest:
 * - `sealed_inputs`: the SecretInput values, a JWE compact string sealed to
 *   the App's card encryption key (opaque to Raft), at most
 *   MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES. Its plaintext is a JSON object of
 *   the SecretInput values by field id. Required, and only allowed, when the
 *   button's form holds a SecretInput;
 * - `inputs`: the TextInput values by field id, in plain text (Raft checks
 *   them against the form; the App sees them as typed). Only TextInput ids of
 *   the button's form, each one line of at most its `maxLength` code points;
 *   every required TextInput present and not empty.
 * A button without a form takes neither; prepare and every other card
 * request take neither.
 */
export type MessageCardFormSubmission = { sealedInputs: string | null; inputs: Readonly<Record<string, string>> | null };

/** The most `sealed_inputs` may be (RFC 086 §5.4), in bytes; a JWE compact string is ASCII, so also in characters. */
export const MESSAGE_CARD_SEALED_INPUTS_MAX_BYTES = 8 * 1024;
/** A JWE compact serialization's shape: five base64url segments, the second (the encrypted key) empty under ECDH-ES. Nothing of it is read. */
export const MESSAGE_CARD_SEALED_INPUTS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Whether a submission fits the button's form (`form` undefined: the button
 * has none). A yes or no only: a refusal never says which value, or what of
 * it, didn't fit.
 */
export function messageCardFormSubmissionFits(form: MessageCardForm | undefined, submission: MessageCardFormSubmission): boolean {
  if (!form) return submission.sealedInputs === null && submission.inputs === null;
  const hasSecret = form.fields.some((field) => field.type === "SecretInput");
  if ((submission.sealedInputs !== null) !== hasSecret) return false;
  const inputs = submission.inputs ?? {};
  const textFields = new Map(form.fields.flatMap((field) => (field.type === "TextInput" ? [[field.id, field] as const] : [])));
  for (const [id, value] of Object.entries(inputs)) {
    const field = textFields.get(id);
    if (!field || typeof value !== "string" || cardCodePoints(value) > (field.maxLength ?? MESSAGE_CARD_FORM_LIMITS.textInputMaxLength) || CARD_LINE_BREAK.test(value)) return false;
  }
  return [...textFields.values()].every((field) => !field.required || (Object.hasOwn(inputs, field.id) && inputs[field.id] !== ""));
}

/** Whether a raw (not yet validated) action is an undo-window one whose form holds a SecretInput: refused with its own sentence. */
function isSecretInputOnUndoButton(raw: unknown): boolean {
  if (!isPlainObject(raw) || !Object.hasOwn(raw, "undoWindowMs") || !isPlainObject(raw.form)) return false;
  const fields = raw.form.fields;
  return Array.isArray(fields) && fields.some((field) => isPlainObject(field) && field.type === "SecretInput");
}
/** Button element id -> its execute action; at most MESSAGE_CARD_LIMITS.maxButtons. */
export type MessageCardActions = Record<string, MessageCardExecuteAction>;

/** Why a request's `actions` can't be stored: where, and what to change. */
export interface MessageCardActionsProblem {
  path: string;
  message: string;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Reads a send's or an update's `actions` against the card it came with
 * (already parsed): 1 to 4 entries, each key naming a Button element of the
 * card, each value an RFC 076 execute action, no action_id twice. Returns the
 * card to store, each acting button carrying Raft's disabledReason, and the
 * actions as validated; or the first problem.
 */
export function applyMessageCardActions(card: MessageCard, raw: unknown):
  { ok: true; card: MessageCard; actions: MessageCardActions } | { ok: false; problem: MessageCardActionsProblem } {
  if (!isPlainObject(raw)) {
    return { ok: false, problem: { path: "actions", message: "actions is an object from a Button's element id to its execute action" } };
  }
  const ids = Object.keys(raw);
  if (ids.length === 0 || ids.length > MESSAGE_CARD_LIMITS.maxButtons) {
    return { ok: false, problem: { path: "actions", message: `actions names 1 to ${MESSAGE_CARD_LIMITS.maxButtons} Buttons of the card; this one names ${ids.length}` } };
  }
  const actions: MessageCardActions = {};
  const actionIds = new Set<string>();
  for (const id of ids) {
    const element = Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
    if (!element || element.type !== "Button") {
      return { ok: false, problem: { path: `actions.${id}`, message: `"${id}" is not a Button element of the card; each key of actions names one` } };
    }
    if (isSecretInputOnUndoButton(raw[id])) {
      return { ok: false, problem: { path: `actions.${id}.form`, message: MESSAGE_CARD_SECRET_INPUT_UNDO_REFUSAL } };
    }
    const parsed = messageCardExecuteActionSchema.safeParse(raw[id]);
    const form = isPlainObject(raw[id]) && Object.hasOwn(raw[id], "form") ? (raw[id] as Record<string, unknown>).form : undefined;
    if (!parsed.success && form !== undefined && !messageCardFormSchema.safeParse(form).success) {
      return { ok: false, problem: { path: `actions.${id}.form`, message: MESSAGE_CARD_FORM_SHAPE } };
    }
    if (!parsed.success) {
      return {
        ok: false,
        problem: {
          path: `actions.${id}`,
          message: "An acting button's action is { kind: \"execute\", action_id, confirm: \"prepare\" } or { kind: \"execute\", action_id, undoWindowMs } (1000-10000), action_id matching ^[a-z][a-z0-9_]{0,31}$",
        },
      };
    }
    if (actionIds.has(parsed.data.action_id)) {
      return { ok: false, problem: { path: `actions.${id}.action_id`, message: `action_id "${parsed.data.action_id}" is on two buttons; each acting button has its own` } };
    }
    actionIds.add(parsed.data.action_id);
    actions[id] = parsed.data;
  }
  const elements = { ...card.elements };
  for (const id of ids) {
    const button = elements[id] as Extract<MessageCard["elements"][string], { type: "Button" }>;
    elements[id] = { ...button, props: { ...button.props, disabledReason: MESSAGE_CARD_ACTING_BUTTON_DISABLED_REASON } };
  }
  return { ok: true, card: { ...card, elements }, actions };
}

/** One acting button of a stored card message: its element, its fallback page (the navigate URL) and its action. */
export interface MessageCardActingButton {
  elementId: string;
  /** The App's fallback page for this button: the stored Button's navigate URL, the operation's URL identity (RFC 086 §4.3). */
  url: string;
  label: string;
  action: MessageCardExecuteAction;
}

/**
 * The acting buttons of stored card message metadata, in the order of
 * `actions`; empty without `actions`. Read leniently: an entry whose key names
 * no Button or whose action doesn't validate is left out, never guessed.
 */
export function messageCardActingButtons(metadata: Pick<MessageCardMetadata, "card" | "actions">): MessageCardActingButton[] {
  const raw = (metadata as { actions?: unknown }).actions;
  if (!isPlainObject(raw)) return [];
  const elements = isPlainObject(metadata.card?.elements) ? metadata.card.elements : {};
  return Object.keys(raw).flatMap((elementId) => {
    const element = Object.hasOwn(elements, elementId) ? elements[elementId] : undefined;
    if (!element || element.type !== "Button") return [];
    const { action: navigate, label } = (element.props ?? {}) as { action?: { url?: unknown }; label?: unknown };
    const action = messageCardExecuteActionSchema.safeParse(raw[elementId]);
    if (!action.success || typeof navigate?.url !== "string" || typeof label !== "string") return [];
    return [{ elementId, url: navigate.url, label, action: action.data }];
  });
}

/** The one person stored card message metadata is for (a user id), or null. */
export function messageCardForUser(metadata: unknown): string | null {
  const value = isPlainObject(metadata) ? metadata.for : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The `message_card` of the batched link card read's answer (RFC 086 §4.2),
 * for a card message whose metadata has `actions`:
 * - `card_revision`: the card's revision these handles are for, as text; a
 *   prepare sends it as `claimed.business_revision`;
 * - `actions`: one per acting button this viewer may press now (none without
 *   `card.execute.v1`, for anyone but `for`, or while the App can't act;
 *   none for a button with a form without `card.form.v1`, or with a
 *   SecretInput without `card.form.secret.v1` too);
 *   `url` is the button's fallback page, the key under which the client
 *   presents `ticket` again on its next read;
 * - `waiting_for`: when the card is for one person and the viewer isn't them,
 *   who it is, so the client can say "Waiting for {name}";
 * - `consent` (RFC 086 §4.2, Tenny): what stands between the viewer and the
 *   buttons is their choice for this App, the per-App consent link cards
 *   use (an App learns who someone is only after that person agreed once):
 *   - `"needed"`: never agreed. The buttons draw enabled; the first press
 *     runs the App's first-view prompt, which the read's `prompts` carries in
 *     the link card read's own shape (`{ url, app }`; allowing is
 *     `POST /api/integrations/clients/:appId/link-preview-consent`), and the
 *     client reads again;
 *   - `"declined"`: the viewer declined this App. No handles; the buttons
 *     say so, with the way to change it: allowing the App (the same call,
 *     which lifts the decline, or the App's choice in Settings);
 * - `app`: the App acting, with `reviewed: false` for an App acting under its
 *   own Server's confirmation (RFC 076 §17), only for a client that declared
 *   `unreviewed_app.v1`; present with handles and with `consent`.
 *   `app.encryption_key` (RFC 086 §5.2): the public JWK a SecretInput's
 *   value is sealed to, from Raft's registration of the App (never from the
 *   card), present only when a handle in `actions` is for a button whose form
 *   holds a SecretInput. Its `kid` is the one those handles were issued
 *   under: after the App rotates its key they stop working, and the client
 *   reads again.
 */
export interface MessageCardReadAnswer {
  card_revision: string;
  /** `client_key` beside `encryption_key`: the App's client key, the sealed header's `aud` (RFC 086 §5.3). */
  app?: { id: string; name: string; icon: string | null; reviewed?: false; encryption_key?: AppCardEncryptionKey; client_key?: string };
  /** `handle_exp` on a SecretInput button's action: the handle's expiry (Unix seconds), the sealed header's `exp` (RFC 086 §5.3). */
  actions: { element_id: string; action_id: string; url: string; ticket: string; handle: string; handle_exp?: number }[];
  waiting_for?: { id: string; name: string };
  consent?: "needed" | "declined";
}
