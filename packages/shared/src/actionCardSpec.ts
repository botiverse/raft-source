// `action-card.v1`: Raft's first-party action cards described as data.
//
// An action card (`actionMetadata.kind === "action-card"`) keeps its durable
// `action_cards` row, `confirmationVersion`, state machine and `/api/actions`
// endpoints; it does not become an RFC 076 native provider. What changes is
// how it is shown: `presentation.card` describes the card body and its buttons
// in a closed, inert catalog. No expressions, state bindings or remote
// resources; every string is plain text. Only the server builds one, from the
// validated action; agents never supply one. Inputs exist only in form sheets
// (`forms`), never in the card body.
//
// The frame is the client's, not the spec's: it paints the header (`icon` +
// `title`) and the status line (executed, handled by someone else, expired,
// read-only, busy, errors) from `actionMetadata` (state, executedBy*, result,
// sourceServerId), so a realtime update need not resend the card.
//
// Two parse modes. "emit" is what a server may send: strict. "read" is what a
// client accepts: the same, with the leniencies listed above the schema
// builder, so an older client still shows a newer card and turns only the
// button it cannot handle into "Open in web" (stripActionCardSpec). Unknown
// keys are dropped, except where they could change what a press does (a
// Button's props, its action, the confirm it opens): there the button becomes
// Open in web. Any other problem makes the whole card invalid, and the client
// shows the legacy presentation (title, displayItems, ...).
//
// Lengths count Unicode code points (cardElements.ts). The Kotlin App pins
// this behaviour with actionCard.v1.vector.json (and its .sha256): a change
// here changes that file.
//
// schemaVersion 8 (the question card, docs: question-card spec §5): the
// `Choice` field (capability `field.choice`), a form's `steps` and
// `placement`, the `too_few` issue code and the Choice value. All additive: an
// older reader reads a Choice as an unsupported field (so its form's button
// strips to Open in web), drops `steps` (all fields on one page) and drops
// `placement` (the form opens in the sheet). Text an agent wrote goes
// into a Msg slot only as the raw Msg (actionCardRawText); `string | Msg` is
// not loosened.
//
// schemaVersion 9 (additive over 8): the open intent `migrate_agent` and its
// capability `intent.migrate_agent` (the agent:migrate card's Move agent), as
// add_seats was added in 5: a reader without it opens the button in web, one
// that does not know the intent reads it as unsupported first.

import { z } from "zod";
import { lazySchema } from "./lazySchema";
import type { ActionCardMetadata } from "./actionCards";
import {
  CARD_RESERVED_IDS, cardBadgeTone, cardChildren, cardCodePoints, cardDurationElementSchema, cardElementId, cardElementObject, cardObject, cardRelativeTimeElementSchema,
  cardText, checkBoundedTree, publicPreviewUrl, type CardBadgeTone, type CardUnknownKeys,
} from "./cardElements";
import { DISPLAY_LOCALES, type DisplayLocale } from "./displayLocales";

// Plain constants first: the schema factories below read them when they are
// built (lazySchema.test builds every schema eagerly, so a later `const` would
// be in its TDZ).

export const ACTION_CARD_SPEC_CATALOG = "action-card.v1";

/**
 * What a client can do with a card, declared by the client itself (the card is
 * pushed to the whole channel, so the server cannot strip per viewer). The App
 * keeps the same list in Kotlin. A new field type adds a `field.*`
 * capability; a new catalog is a new name (`action-card.v2`).
 */
export const ACTION_CARD_SPEC_CAPABILITIES = [
  "card.v1", "confirm.v1", "form.v1",
  "field.text_input", "field.text_area", "field.select", "field.toggle", "field.member_picker", "field.channel_picker", "field.agent_picker",
  "field.choice",
  "intent.create_channel", "intent.add_members", "intent.create_agent", "intent.feedback_form", "intent.upgrade_dialog",
  "intent.feedback_ticket", "intent.add_seats", "intent.migrate_agent",
] as const;
export type ActionCardSpecCapability = typeof ACTION_CARD_SPEC_CAPABILITIES[number];

/** Header icons; the frame paints them. A read client shows an icon it does not know as no icon. */
export const ACTION_CARD_SPEC_ICONS = ["hash", "bot", "user_plus", "key", "app", "package", "plug", "message", "sparkles", "shield", "credit_card"] as const;
export type ActionCardSpecIcon = typeof ACTION_CARD_SPEC_ICONS[number];

/**
 * The native screens an `open` button opens: the dialogs, prefilled from
 * `metadata.action` as today, and `feedback_ticket` (result only, below).
 * `add_seats`: a seat request's owner flow (seats:add, task #10): the
 * pre-pay check, the add-seats dialog for what the request is for, then the
 * request's own completion (POST /api/actions/:messageId/seats-added).
 * `migrate_agent`: the migration dialog for an agent:migrate card's Agent
 * (schemaVersion 9), as the agent page opens it; the card is marked executed
 * once the migration starts.
 */
export const ACTION_CARD_SPEC_INTENTS = ["create_channel", "add_members", "create_agent", "feedback_form", "upgrade_dialog", "feedback_ticket", "add_seats", "migrate_agent"] as const;
export type ActionCardSpecIntent = typeof ACTION_CARD_SPEC_INTENTS[number];

/**
 * The only `open` intents a result tree may hold, and they only there (Tenny,
 * #proj-mobile:dbb1d8c2 a0a76b2f: an allowlist of exactly these, never "any
 * open" in a result). Each views what the done card's `metadata.result`
 * names, so the card body, shown before there is a result, refuses them.
 * `feedback_ticket`: the sender's own ticket in Settings › Feedback, from
 * `metadata.result` (`product-feedback`: `ticketId`, `source`); the card
 * carries no ticket id.
 */
export const ACTION_CARD_SPEC_RESULT_INTENTS = ["feedback_ticket"] as const satisfies readonly ActionCardSpecIntent[];

export const ACTION_CARD_SPEC_FIELD_TYPES = ["TextInput", "TextArea", "Select", "Toggle", "MemberPicker", "ChannelPicker", "AgentPicker", "Choice"] as const;
export type ActionCardSpecFieldType = typeof ACTION_CARD_SPEC_FIELD_TYPES[number];
export const ACTION_CARD_SPEC_FIELD_CAPABILITIES: Readonly<Record<ActionCardSpecFieldType, ActionCardSpecCapability>> = {
  TextInput: "field.text_input",
  TextArea: "field.text_area",
  Select: "field.select",
  Toggle: "field.toggle",
  MemberPicker: "field.member_picker",
  ChannelPicker: "field.channel_picker",
  AgentPicker: "field.agent_picker",
  Choice: "field.choice",
};

/**
 * Tree limits (the root is at depth 0; a Stack has at most 12 children,
 * cardElements.ts) and the emit-only size: the whole card as `JSON.stringify`
 * UTF-8. Clients do not measure it, since serializers differ across languages.
 */
export const ACTION_CARD_SPEC_LIMITS = {
  maxElements: 24,
  maxConfirmElements: 12,
  maxDepth: 4,
  maxButtons: 2,
  maxConfirms: 2,
  maxForms: 2,
  maxFields: 12,
  maxOptions: 32,
  maxParams: 8,
  maxPickerItems: 50,
  maxBytes: 24576,
} as const;

const ACTION_ID = /^[a-z][a-z0-9_]{0,31}$/;
const FIELD_TYPE_NAME = /^[A-Z][A-Za-z0-9]{0,31}$/;
const MSG_KEY = /^actionCard(\.[A-Za-z0-9_]{1,64}){1,6}$/;
const PARAM_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const LOCALE_KEY = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_ID = /^[a-z][a-z0-9_.:-]{0,127}$/;
const GATE = /^[a-z][a-z0-9_]{0,63}$/;
const FIELD_NAME = /^[a-z][a-zA-Z0-9_]{0,31}$/;
const OPTION_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/;
/**
 * The value a Choice option may not take (schemaVersion 8): what the person
 * writes in "Other" travels as the value's `other`, never as a selected value.
 */
export const ACTION_CARD_CHOICE_RESERVED_VALUE = "other";
/** A form's `steps` (schemaVersion 8): 2-10 pages. */
export const ACTION_CARD_FORM_STEPS = { min: 2, max: 10 } as const;
/**
 * Where a form is filled in (schemaVersion 8, question-card spec §5.9): in the
 * sheet its button opens (`sheet`, the default when absent), or on the card
 * itself (`inline`). Only how a client draws it: the same form, the same
 * submit. A reader that does not know a value drops it (the sheet).
 */
export const ACTION_CARD_FORM_PLACEMENTS = ["sheet", "inline"] as const;
export type ActionCardFormPlacement = (typeof ACTION_CARD_FORM_PLACEMENTS)[number];
/** A Choice's "Other" text: at most this many code points (its `maxLength`, 1-500). */
export const ACTION_CARD_CHOICE_OTHER_MAX_LENGTH = 500;
/**
 * What "empty after trim" means for a required text field: only these code
 * points (the set JavaScript's `trim` removes, spelled out because Kotlin's
 * `trim` removes a different set): U+0009-U+000D, U+0020, U+00A0, U+1680,
 * U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF.
 */
const BLANK = /^[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*$/;
/** `open_web` comes only from strip, and `unsupported` only from a read; neither may arrive. */
const KNOWN_ACTION_KINDS: readonly string[] = ["execute", "open_form", "open", "navigate", "open_web", "unsupported"];
/** The keys each action kind takes. A read takes one with any other key as unsupported (read leniency 7). */
const ACTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  execute: ["kind", "confirm"],
  open_form: ["kind", "form"],
  open: ["kind", "intent", "gate"],
  navigate: ["kind", "target", "url"],
};
const INTENTS: readonly string[] = ACTION_CARD_SPEC_INTENTS;
const RESULT_INTENTS: readonly string[] = ACTION_CARD_SPEC_RESULT_INTENTS;
const FIELD_TYPES: readonly string[] = ACTION_CARD_SPEC_FIELD_TYPES;
const ICONS: readonly string[] = ACTION_CARD_SPEC_ICONS;
const LOCALES: readonly string[] = DISPLAY_LOCALES;
const ENTITY_KINDS = ["user", "agent", "channel", "computer"] as const;
const EMPHASES = ["primary", "secondary", "destructive"] as const;

// ---------------------------------------------------------------------------
// Types. A received `presentation.card` is untrusted: read it with
// parseActionCardSpec(raw, { mode: "read" }), never by casting.

/**
 * An entity shown by reference. The client shows the name from its own store
 * when it can see the entity, else `fallback`. `serverId` absent = the card's
 * server (`metadata.sourceServerId`), not the viewer's current one.
 */
export interface ActionCardSpecEntityRef {
  kind: "user" | "agent" | "channel" | "computer";
  /** Lowercase canonical UUID, as Postgres prints it. */
  id: string;
  serverId?: string;
  fallback: string;
}

export type ActionCardSpecMsgParam = string | number | ActionCardSpecEntityRef;
/**
 * Card copy that is shown in the viewer's language. The card is broadcast to a
 * whole channel, so it carries its translations: `text.en` always, other
 * display locales when the server has them; a client never looks `key` up (it
 * is for analytics and alignment). Templates use `{name}` placeholders, filled
 * by the client from `params`; `{{` and `}}` are literal braces. Strings,
 * including a string param, are plain text. Data (names, an agent's reason,
 * descriptions) is never a Msg: it is a plain string where the slot takes one.
 */
export interface ActionCardSpecMsg {
  key: string;
  text: { en: string } & { [L in Exclude<DisplayLocale, "en">]?: string };
  params?: Record<string, ActionCardSpecMsgParam>;
}

export type ActionCardSpecNavigateTarget =
  | { kind: "channel" | "agent" | "user"; id: string; serverId?: string }
  | { kind: "message" | "task"; id: string; channelId: string; serverId?: string };

/**
 * What a Button does (capability in brackets):
 * - `execute`: POST /api/actions/:messageId/execute with expectedState and
 *   expectedConfirmationVersion [card.v1]; with `confirm`, show the generic
 *   confirm dialog with `confirms[confirm]` first [confirm.v1];
 * - `open_form`: the generic form sheet for `forms[form]` [form.v1 + the
 *   `field.*` of each of its fields];
 * - `open`: the existing native dialog, prefilled from `metadata.action`;
 *   `gate` only with upgrade_dialog [intent.<intent>]. In a result tree only
 *   the ACTION_CARD_SPEC_RESULT_INTENTS, which view what `metadata.result`
 *   names (feedback_ticket: the sender's ticket);
 * - `navigate`: open the entity natively, or a public HTTPS URL outside Raft
 *   with noopener/noreferrer [card.v1].
 */
export type ActionCardSpecAction =
  | { kind: "execute"; confirm?: string }
  | { kind: "open_form"; form: string }
  | { kind: "open"; intent: ActionCardSpecIntent; gate?: string }
  | { kind: "navigate"; target: ActionCardSpecNavigateTarget }
  | { kind: "navigate"; url: string };
/**
 * A read client's marker for an action it cannot trust itself to perform: a
 * kind or `open` intent it does not know, or a press a key it does not know
 * could change (on the action, the Button's props, or the confirm an execute
 * opens), since that key may be one it must not ignore, such as a new safety
 * check. `originalIntent`: the intent of an `open`. Strip turns it into
 * `open_web`.
 */
export interface ActionCardSpecUnsupportedAction { kind: "unsupported"; originalKind: string; originalIntent?: string }
/**
 * Made only by stripActionCardSpec, never sent: open this message's web link
 * in a browser. Web: `buildMessagePermalink(serverSlug, channelId, messageId)`;
 * App: a builder symmetric to the `RaftMessageLink` parser.
 */
export interface ActionCardSpecOpenWebAction { kind: "open_web" }
/**
 * Primary: the client's default, ink-edged button (raft-ui outline; the
 * screen's one pink button stays the composer's Send). Secondary: outline.
 * Destructive: danger. At most one primary per tree; destructive only on
 * execute with a confirm.
 */
export type ActionCardSpecEmphasis = typeof EMPHASES[number];

/**
 * What a Stack is on the card (schemaVersion 6), for a client to draw it as
 * that part of its card: `reason`, a column of the agent's own words (an
 * optional muted label Text, then the note Text; the web's hint); `actions`,
 * the row of the card's buttons. A reason is a column and an actions row a
 * row. Read drops a role it does not know, or one on the other direction.
 */
export const ACTION_CARD_SPEC_STACK_ROLES = ["reason", "actions"] as const;
export type ActionCardSpecStackRole = typeof ACTION_CARD_SPEC_STACK_ROLES[number];
const STACK_ROLE_DIRECTIONS: Readonly<Record<ActionCardSpecStackRole, "column" | "row">> = { reason: "column", actions: "row" };

export type ActionCardSpecDisplayElement =
  | { type: "Stack"; props: { direction: "column" | "row"; wrap: boolean; role?: ActionCardSpecStackRole }; children?: string[] }
  | { type: "Text"; props: { text: string | ActionCardSpecMsg; tone: "default" | "muted" | "warning"; mono: boolean; clamp?: number } }
  | { type: "Badge"; props: { text: string | ActionCardSpecMsg; tone: CardBadgeTone } }
  | { type: "RelativeTime"; props: { at: string } }
  | { type: "Duration"; props: { start: string; end?: string } }
  /** A property row (what displayItems were); `clamp`, as on Text: the value shows at most that many lines. */
  | { type: "Field"; props: { label: ActionCardSpecMsg; value: string | ActionCardSpecMsg | ActionCardSpecEntityRef[]; mono?: boolean; muted?: boolean; breakAll?: boolean; clamp?: number } }
  | { type: "EntityRef"; props: ActionCardSpecEntityRef }
  /** The client names each scope id, and each permission group id in `groups`, itself. */
  | { type: "ScopeList"; props: { scopes: string[]; groups?: string[]; agentName?: string } }
  | { type: "Notice"; props: { text: ActionCardSpecMsg; tone: "info" | "warning" } };
export interface ActionCardSpecButton<A = ActionCardSpecAction> {
  type: "Button";
  props: { label: ActionCardSpecMsg; emphasis: ActionCardSpecEmphasis; action: A; disabledReason?: ActionCardSpecMsg };
}
export type ActionCardSpecElement<A = ActionCardSpecAction> = ActionCardSpecDisplayElement | ActionCardSpecButton<A>;
export interface ActionCardSpecTree<A = ActionCardSpecAction> { root: string; elements: Record<string, ActionCardSpecElement<A>> }
/** The generic confirm dialog: no buttons in its body, the dialog has its own. */
export interface ActionCardSpecConfirm {
  title: ActionCardSpecMsg;
  confirmLabel: ActionCardSpecMsg;
  spec: { root: string; elements: Record<string, ActionCardSpecDisplayElement> };
}

interface ActionCardSpecFieldCommon { name: string; label: ActionCardSpecMsg; placeholder?: ActionCardSpecMsg; description?: ActionCardSpecMsg }
/** A picker's value is always an array of ids (a single picker: at most one); `emptyText` shows when it has no candidates. */
interface ActionCardSpecPickerCommon extends ActionCardSpecFieldCommon {
  required?: boolean;
  emptyText?: ActionCardSpecMsg;
  multiple: boolean;
  maxItems?: number;
  default?: ActionCardSpecEntityRef[];
}
/** A form field; candidates for pickers come from the client's own store (`scope: "channel"` = the card's channel). */
export type ActionCardSpecField =
  | ActionCardSpecFieldCommon & { type: "TextInput"; required?: boolean; maxLength: number; default?: string }
  | ActionCardSpecFieldCommon & { type: "TextArea"; required?: boolean; maxLength: number; rows?: number; default?: string }
  | ActionCardSpecFieldCommon & { type: "Select"; required?: boolean; options: { value: string; label: ActionCardSpecMsg }[]; default?: string }
  | ActionCardSpecFieldCommon & { type: "Toggle"; default?: boolean }
  | ActionCardSpecPickerCommon & { type: "MemberPicker"; kinds: ["human"] | ["agent"] | ["human", "agent"]; scope: "server" | "channel" }
  | ActionCardSpecPickerCommon & { type: "ChannelPicker"; scope: "joined" | "visible" }
  | ActionCardSpecPickerCommon & { type: "AgentPicker" }
  | ActionCardSpecChoiceField;
/** A Choice option (schemaVersion 8): `label` and `description` are Msgs; an agent's text is the raw Msg (actionCardRawText). */
export interface ActionCardSpecChoiceOption { value: string; label: ActionCardSpecMsg; description?: ActionCardSpecMsg }
/**
 * A Choice's "Other": the last row of the list, which opens a one-line input
 * for the person's own answer (the value's `other`, at most `maxLength` code
 * points).
 */
export interface ActionCardSpecChoiceOther { label: ActionCardSpecMsg; description?: ActionCardSpecMsg; placeholder?: ActionCardSpecMsg; maxLength: number }
/** What a Choice submits and defaults to: the chosen option values, and the person's own text when they chose "Other". */
export interface ActionCardChoiceValue { selected: string[]; other?: string }
/**
 * A Choice field (schemaVersion 8, capability `field.choice`): every option
 * shown at once, one (`multiple: false`) or several, optionally with "Other".
 * Items count the chosen options plus a non-blank `other`: a single Choice
 * takes at most one, a multiple one `minItems`..`maxItems` (default 1 and the
 * option count, plus one with `other`). A new type rather than keys on
 * Select, so an older reader reads it as unsupported instead of dropping
 * `multiple` or `other` and drawing a different question.
 */
export type ActionCardSpecChoiceField = ActionCardSpecFieldCommon & {
  type: "Choice";
  required?: boolean;
  multiple: boolean;
  minItems?: number;
  maxItems?: number;
  options: ActionCardSpecChoiceOption[];
  other?: ActionCardSpecChoiceOther;
  default?: ActionCardChoiceValue;
};
/** A read client's marker for a field type it does not know; a button opening its form becomes `open_web`. */
export interface ActionCardSpecUnsupportedField { type: "unsupported"; originalType: string; name: string }
export interface ActionCardSpecForm<F = ActionCardSpecField> {
  title: ActionCardSpecMsg;
  submitLabel: ActionCardSpecMsg;
  /**
   * The submit button's label by the value chosen in one Select of the form
   * (`field`): a choice the person makes reads as what pressing does ("Approve
   * this call" / "Deny"). `submitLabel` while nothing is chosen, and on a
   * client that does not know the key (its read drops it, safely: a label
   * never changes what a press does). Emit checks it names a Select of the
   * form and only its options; a read takes it as it is.
   */
  submitLabels?: { field: string; labels: Record<string, ActionCardSpecMsg> }; // schemaVersion 7
  description?: ActionCardSpecMsg;
  /**
   * schemaVersion 8: the form's pages, in order, each naming its fields; 2-10
   * steps, every field of `fields` in exactly one. Only how the sheet pages:
   * it is still one submit, on the last page. `fields` still lists every
   * field (an older reader drops `steps` and shows them all on one page).
   * Emit checks the names; a read that finds them not covering every field
   * exactly once drops `steps`.
   */
  steps?: ActionCardSpecFormStep[];
  /**
   * schemaVersion 8: where the form is filled in (ACTION_CARD_FORM_PLACEMENTS);
   * absent is the sheet. The server sets it (a question card's short choice
   * questions are `inline`); a client that does not know it opens the sheet,
   * which still answers the same form.
   */
  placement?: ActionCardFormPlacement;
  fields: F[];
}
/** One page of a form (schemaVersion 8): an optional title, and the names of its fields in order. */
export interface ActionCardSpecFormStep { title?: ActionCardSpecMsg; fields: string[] }

export interface ActionCardSpecCardOf<A, F> {
  catalog: typeof ACTION_CARD_SPEC_CATALOG;
  icon?: ActionCardSpecIcon;
  /** The frame paints icon + title as the header. */
  title: ActionCardSpecMsg;
  /** The card body. */
  spec: ActionCardSpecTree<A>;
  confirms?: Record<string, ActionCardSpecConfirm>;
  forms?: Record<string, ActionCardSpecForm<F>>;
  /**
   * Shown by the frame once the card is executed; its buttons navigate, or
   * open one of the ACTION_CARD_SPEC_RESULT_INTENTS.
   */
  result?: ActionCardSpecTree<A>;
}
/** `presentation.card` as a server builds and sends it (emit mode). */
export type ActionCardSpecCard = ActionCardSpecCardOf<ActionCardSpecAction, ActionCardSpecField>;
/** A card as a client read it: may hold markers for what it does not know. */
export type ActionCardSpecReadCard = ActionCardSpecCardOf<ActionCardSpecAction | ActionCardSpecUnsupportedAction, ActionCardSpecField | ActionCardSpecUnsupportedField>;
/** What a client renders: every button it cannot handle replaced by `open_web`. */
export type ActionCardRenderedCard = ActionCardSpecCardOf<ActionCardSpecAction | ActionCardSpecOpenWebAction, ActionCardSpecField | ActionCardSpecUnsupportedField>;

export type ActionCardSpecParseMode = "emit" | "read";
export type ActionCardSpecParseResult<T> = { ok: true; card: T } | { ok: false };
/** Why a card is invalid: for tests and server logs, never shown. */
export interface ActionCardSpecIssue { path: (string | number)[]; message: string }

// ---------------------------------------------------------------------------
// Templates.

type TemplateToken = { text: string } | { param: string };
/** Left to right, no backtracking: `{{` / `}}` are literal braces, `{name}` a placeholder, any other brace invalid (null). */
function templateTokens(template: string): TemplateToken[] | null {
  const tokens: TemplateToken[] = [];
  const placeholder = /\{([a-zA-Z][a-zA-Z0-9_]{0,31})\}/y;
  let text = "";
  for (let i = 0; i < template.length;) {
    const c = template[i]!;
    if ((c === "{" || c === "}") && template[i + 1] === c) { text += c; i += 2; continue; }
    if (c === "}") return null;
    if (c === "{") {
      placeholder.lastIndex = i;
      const m = placeholder.exec(template);
      if (!m) return null;
      if (text) tokens.push({ text });
      text = "";
      tokens.push({ param: m[1]! });
      i += m[0].length;
      continue;
    }
    text += c;
    i++;
  }
  if (text) tokens.push({ text });
  return tokens;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const notReserved = (name: string) => !CARD_RESERVED_IDS.includes(name);
/** zod drops a raw `__proto__` key from a record without a word; Kotlin would see it, so it is refused. */
const hasNoProtoKey = (raw: unknown) => !isPlainRecord(raw) || !Object.hasOwn(raw, "__proto__");
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** Whether raw JSON object `raw` has an own key outside `keys` (a raw `__proto__` included). */
const hasKeyOutside = (raw: unknown, keys: readonly string[]) => isPlainRecord(raw) && Object.keys(raw).some((key) => !keys.includes(key));
/** The keys its kind takes, when `raw` is an action of a known kind that also has a key outside them; else null. */
const keysOfActionWithUnknownKey = (raw: unknown): readonly string[] | null => {
  if (!isPlainRecord(raw) || typeof raw.kind !== "string" || !Object.hasOwn(ACTION_KEYS, raw.kind)) return null;
  const keys = ACTION_KEYS[raw.kind]!;
  return hasKeyOutside(raw, keys) ? keys : null;
};

type ReadAction = ActionCardSpecAction | ActionCardSpecUnsupportedAction;
const destructiveAllowed = (action: ReadAction) => action.kind === "unsupported" || (action.kind === "execute" && action.confirm !== undefined);
/** An `open` whose intent views a done card's result: allowed in a result tree only. */
const opensResultIntent = (action: ReadAction) => action.kind === "open" && RESULT_INTENTS.includes(action.intent);
/** What a result tree's button may do: navigate, open a result intent, or a read's marker. */
const resultActionAllowed = (action: ReadAction) => action.kind === "navigate" || action.kind === "unsupported" || opensResultIntent(action);
/** The marker for an action a read will not perform as written; one that already is a marker stays as it is. */
const unsupportedAction = (action: ReadAction): ActionCardSpecUnsupportedAction => {
  if (action.kind === "unsupported") return action;
  return action.kind === "open" ? { kind: "unsupported", originalKind: "open", originalIntent: action.intent } : { kind: "unsupported", originalKind: action.kind };
};
/** Marks a confirm a read found a key in it does not know (read leniency 7); the card drops it. Never in a parsed card. */
const CONFIRM_WITH_UNKNOWN_KEY = Symbol("confirmWithUnknownKey");
const pickerMax = (field: { multiple: boolean; maxItems?: number }) =>
  field.multiple ? field.maxItems ?? ACTION_CARD_SPEC_LIMITS.maxPickerItems : 1;
/** How many items a Choice offers: its options, plus "Other" when it has one. */
const choiceItems = (field: { options: readonly unknown[]; other?: unknown }) => field.options.length + (field.other ? 1 : 0);
/** At most how many items a Choice takes: one when single, else maxItems (default: every item). */
const choiceMax = (field: { multiple: boolean; maxItems?: number; options: readonly unknown[]; other?: unknown }) =>
  field.multiple ? field.maxItems ?? choiceItems(field) : 1;
/** At least how many items a Choice takes once anything is chosen: minItems when multiple (default 1). */
const choiceMin = (field: { multiple: boolean; minItems?: number }) => (field.multiple ? field.minItems ?? 1 : 1);

interface ChoiceShape {
  multiple: boolean;
  minItems?: number;
  maxItems?: number;
  options: { value: string }[];
  other?: { maxLength: number };
  default?: { selected: string[]; other?: string };
}
/** A Choice's own rules: bounds only on a multiple one and within its items; a default that it could submit. */
function checkChoice(field: ChoiceShape, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  const items = choiceItems(field);
  if (!field.multiple && (field.minItems !== undefined || field.maxItems !== undefined)) issue("minItems", "Only a multiple Choice takes minItems and maxItems");
  if (field.minItems !== undefined && field.minItems > items) issue("minItems", "minItems is more than the Choice offers");
  if (field.maxItems !== undefined && field.maxItems > items) issue("maxItems", "maxItems is more than the Choice offers");
  if (field.minItems !== undefined && field.maxItems !== undefined && field.minItems > field.maxItems) issue("minItems", "minItems is more than maxItems");
  const value = field.default;
  if (!value) return;
  if (!unique(value.selected) || value.selected.some((selected) => !field.options.some((option) => option.value === selected))) {
    issue("default", "The default selects options of the Choice, once each");
  }
  if (value.other !== undefined && (!field.other || BLANK.test(value.other) || cardCodePoints(value.other) > field.other.maxLength)) {
    issue("default", "The default's other needs the Choice's Other, and fits its maxLength");
  }
  if (value.selected.length + (value.other !== undefined ? 1 : 0) > choiceMax(field)) issue("default", "The default chooses more than the Choice takes");
}

/** Whether a form's `steps` (if any) name every one of its fields exactly once. */
function stepsCoverFields(form: { steps?: { fields: string[] }[]; fields: { name: string }[] }): boolean {
  if (form.steps === undefined) return true;
  const named = form.steps.flatMap((step) => step.fields);
  const names = form.fields.map((field) => field.name);
  return unique(named) && named.length === names.length && names.every((name) => named.includes(name));
}

// ---------------------------------------------------------------------------
// Schemas. One builder, two modes; the differences are the read leniencies:
// 1. an action kind it does not know (shaped `^[a-z][a-z0-9_]{0,31}$`, on an
//    object) reads as `{ kind: "unsupported", originalKind }`, other props
//    ignored;
// 2. so does an `open` intent it does not know (same shape), with
//    `originalIntent`;
// 3. a field type it does not know (`^[A-Z][A-Za-z0-9]{0,31}$`) reads as
//    `{ type: "unsupported", originalType, name }`: `name` is still checked
//    and unique, other props ignored, and the form stays;
// 4. an envelope key it does not know is dropped, and so is an icon, and a
//    Stack role (on the wrong direction too);
// 5. a Msg locale it does not know (`^[a-z]{2,3}(-[a-z0-9]{2,8})?$`) is dropped,
//    its template unchecked;
// 6. any other object's key it does not know is dropped, its value unchecked:
//    on an element (besides type, props and a Stack's children) and the props
//    of every element but a Button, a Msg, an EntityRef (element, Field value,
//    param, picker default), a navigate target, a tree ({root, elements}), a
//    form, a form step, a known field, a Select or Choice option, a Choice's
//    `other` and its default. Known keys keep their rules, and `children` on
//    an element other than a Stack is still refused;
// 7. except where a key could change what a press does; there the known keys
//    are checked as usual and the button's action reads as
//    `{ kind: "unsupported", originalKind }` (an `open` also keeps
//    `originalIntent`; a marker stays as it is), so strip makes it "Open in
//    web". That is a key outside a Button's props, outside its action's kind
//    (ACTION_KEYS), or outside a confirm (title, confirmLabel, spec): such a
//    confirm is dropped from `confirms`, and every execute naming it marked,
//    once the rest of the card is valid.
// Emit refuses all seven. Both refuse `open_web` and `unsupported` as input.
// And (schemaVersion 8) a form's `steps` whose names do not cover its fields
// exactly once: emit refuses it, read drops `steps` (one page); a form's
// `placement` it does not know: emit refuses it, read drops it (the sheet).
// The tree rules (one execute, destructive, result buttons, result intents
// only in a result) and the confirm and form references see the markers a
// Button's props or action made, not the action they replace; a dropped
// confirm changes no verdict.

function actionCardSpecSchema(mode: ActionCardSpecParseMode) {
  const read = mode === "read";
  const unknownKeys: CardUnknownKeys = read ? "strip" : "strict";
  const object = <S extends z.core.$ZodLooseShape>(shape: S) => cardObject(shape, unknownKeys);
  const elementObject = <S extends z.core.$ZodLooseShape>(shape: S) => cardElementObject(shape, unknownKeys);
  const name = (pattern: RegExp) => z.string().regex(pattern).refine(notReserved, "Reserved name");
  const record = <V extends z.ZodType>(key: z.ZodString, value: V, max = Number.POSITIVE_INFINITY) => z.unknown()
    .refine(hasNoProtoKey, "Reserved key").pipe(z.record(key, value))
    .refine((entries) => Object.keys(entries).length <= max, `At most ${max} entries`);
  const lowerUuid = z.string().regex(LOWER_UUID, "Expected a lowercase UUID");
  const entityRef = object({ kind: z.enum(ENTITY_KINDS), id: lowerUuid, serverId: lowerUuid.optional(), fallback: cardText(1, 200) });

  const template = (max: number) => cardText(1, max).refine((value) => templateTokens(value) !== null, "Use {name} placeholders, and {{ or }} for a brace");
  const msgText = (max: number) => {
    const shape = z.object(Object.fromEntries(LOCALES.map((locale) => [locale, locale === "en" ? template(max) : template(max).optional()])));
    if (!read) return shape.strict();
    return z.unknown().refine((raw) => !isPlainRecord(raw) || Object.keys(raw).every((key) => LOCALES.includes(key) || LOCALE_KEY.test(key)),
      "Unknown locale key").pipe(shape);
  };
  const msg = (max: number) => object({
    key: z.string().regex(MSG_KEY),
    text: msgText(max),
    params: record(name(PARAM_NAME), z.union([cardText(0, 500), z.number().int(), entityRef]), ACTION_CARD_SPEC_LIMITS.maxParams).optional(),
  }).superRefine((value, ctx) => {
    for (const [locale, text] of Object.entries(value.text)) {
      for (const token of typeof text === "string" ? templateTokens(text) ?? [] : []) {
        if ("param" in token && !(value.params && Object.hasOwn(value.params, token.param))) {
          ctx.addIssue({ code: "custom", path: ["text", locale], message: `No param for {${token.param}}` });
        }
      }
    }
  });

  const actionId = name(ACTION_ID);
  const navigateTarget = z.union([
    object({ kind: z.enum(["channel", "agent", "user"]), id: lowerUuid, serverId: lowerUuid.optional() }),
    object({ kind: z.enum(["message", "task"]), id: lowerUuid, channelId: lowerUuid, serverId: lowerUuid.optional() }),
  ]);
  // Strict in both modes: a read finds an unknown action key itself (leniency 7).
  const knownActions = [
    z.object({ kind: z.literal("execute"), confirm: actionId.optional() }).strict(),
    z.object({ kind: z.literal("open_form"), form: actionId }).strict(),
    z.object({ kind: z.literal("open"), intent: z.enum(ACTION_CARD_SPEC_INTENTS), gate: z.string().regex(GATE).optional() }).strict()
      .refine((action) => action.gate === undefined || action.intent === "upgrade_dialog", "Only upgrade_dialog takes a gate"),
    z.object({ kind: z.literal("navigate"), target: navigateTarget }).strict(),
    z.object({ kind: z.literal("navigate"), url: z.string().max(2000).refine((url) => !!publicPreviewUrl(url), "Expected a public HTTPS URL") }).strict(),
  ] as const;
  const knownAction = z.union(knownActions);
  const lenientActions = [
    z.unknown().refine((raw) => keysOfActionWithUnknownKey(raw) !== null)
      .transform((raw) => {
        const action = raw as Record<string, unknown>;
        return Object.fromEntries(keysOfActionWithUnknownKey(raw)!.filter((key) => Object.hasOwn(action, key)).map((key) => [key, action[key]]));
      })
      .pipe(knownAction)
      .transform(unsupportedAction),
    z.looseObject({ kind: z.literal("open"), intent: z.string().regex(ACTION_ID).refine((intent) => !INTENTS.includes(intent)) })
      .transform((action): ActionCardSpecUnsupportedAction => ({ kind: "unsupported", originalKind: "open", originalIntent: action.intent })),
    z.looseObject({ kind: z.string().regex(ACTION_ID).refine((kind) => !KNOWN_ACTION_KINDS.includes(kind)) })
      .transform((action): ActionCardSpecUnsupportedAction => ({ kind: "unsupported", originalKind: action.kind })),
  ] as const;
  const action: z.ZodType<ReadAction> = read ? z.union([...knownActions, ...lenientActions]) : knownAction;
  const buttonShape = { label: msg(24), emphasis: z.enum(EMPHASES).default("secondary"), action, disabledReason: msg(200).optional() };
  // Read leniency 7: a Button prop it does not know may change what a press does, so the button's action reads as unsupported.
  const buttonProps: z.ZodType<{ emphasis: ActionCardSpecEmphasis; action: ReadAction }> = read
    ? z.union([
      z.strictObject(buttonShape),
      z.unknown().refine((raw) => hasKeyOutside(raw, Object.keys(buttonShape))).pipe(z.object(buttonShape))
        .transform((props) => ({ ...props, action: unsupportedAction(props.action) })),
    ])
    : z.strictObject(buttonShape);

  // The link cards' Stack (cardElements.ts), plus `role` (schemaVersion 6).
  const stackRoleFits = (props: { direction: "column" | "row"; role?: unknown }) => props.role === undefined
    || ((ACTION_CARD_SPEC_STACK_ROLES as readonly unknown[]).includes(props.role) && STACK_ROLE_DIRECTIONS[props.role as ActionCardSpecStackRole] === props.direction);
  const stackElement = object({
    type: z.literal("Stack"),
    props: object({
      direction: z.enum(["column", "row"]).default("column"),
      wrap: z.boolean().default(false),
      role: read ? z.unknown().optional() : z.enum(ACTION_CARD_SPEC_STACK_ROLES).optional(),
    })
      .refine((props) => props.direction === "row" || !props.wrap, "Only a row can wrap")
      .refine((props) => read || stackRoleFits(props), "A reason Stack is a column and an actions Stack a row")
      .transform(({ role, ...props }) => (role !== undefined && stackRoleFits({ ...props, role })
        ? { ...props, role: role as ActionCardSpecStackRole }
        : props)),
    children: cardChildren(12),
  });

  const element = z.discriminatedUnion("type", [
    stackElement,
    elementObject({ type: z.literal("Text"), props: object({
      text: z.union([cardText(1, 2000), msg(500)]),
      tone: z.enum(["default", "muted", "warning"]).default("default"),
      mono: z.boolean().default(false),
      clamp: z.number().int().min(1).max(6).optional(),
    }) }),
    elementObject({ type: z.literal("Badge"), props: object({ text: z.union([cardText(1, 60), msg(60)]), tone: cardBadgeTone.default("neutral") }) }),
    cardRelativeTimeElementSchema(unknownKeys),
    cardDurationElementSchema(unknownKeys),
    elementObject({ type: z.literal("Field"), props: object({
      label: msg(40),
      value: z.union([cardText(1, 2000), msg(500), z.array(entityRef).min(1).max(50)]),
      mono: z.boolean().optional(),
      muted: z.boolean().optional(),
      breakAll: z.boolean().optional(),
      clamp: z.number().int().min(1).max(6).optional(),
    }) }),
    elementObject({ type: z.literal("EntityRef"), props: entityRef }),
    elementObject({ type: z.literal("ScopeList"), props: object({
      scopes: z.array(z.string().regex(SCOPE_ID)).min(1).max(64).refine(unique, "Scopes must be unique"),
      groups: z.array(z.string().regex(SCOPE_ID)).min(1).max(32).refine(unique, "Groups must be unique").optional(),
      agentName: cardText(1, 100).optional(),
    }) }),
    elementObject({ type: z.literal("Notice"), props: object({ text: msg(500), tone: z.enum(["info", "warning"]).default("info") }) }),
    elementObject({ type: z.literal("Button"), props: buttonProps.refine((props) => props.emphasis !== "destructive" || destructiveAllowed(props.action),
      "Only an execute button with a confirm can be destructive") }),
  ]);

  /**
   * spec: the body, no result intent; result: after execute, navigate or a
   * result intent only; confirm: a dialog body, no buttons.
   */
  const tree = (rule: "spec" | "result" | "confirm") => object({ root: cardElementId, elements: record(cardElementId, element) })
    .superRefine((value, ctx) => {
      const maxElements = rule === "confirm" ? ACTION_CARD_SPEC_LIMITS.maxConfirmElements : ACTION_CARD_SPEC_LIMITS.maxElements;
      const bounded = checkBoundedTree(value, { maxElements, maxDepth: ACTION_CARD_SPEC_LIMITS.maxDepth });
      if (bounded === "size") { ctx.addIssue({ code: "custom", message: `At most ${maxElements} elements, none with a reserved ID` }); return; }
      if (bounded === "tree") { ctx.addIssue({ code: "custom", message: "Card must be one bounded tree" }); return; }
      const buttons = Object.values(value.elements).flatMap((node) => node.type === "Button" ? [node.props] : []);
      const issue = (message: string) => ctx.addIssue({ code: "custom", message });
      if (rule === "confirm" && buttons.length > 0) issue("A confirmation has no buttons");
      if (buttons.length > ACTION_CARD_SPEC_LIMITS.maxButtons) issue(`At most ${ACTION_CARD_SPEC_LIMITS.maxButtons} buttons`);
      if (rule === "spec" && buttons.filter((button) => button.action.kind === "execute").length > 1) issue("At most one execute button: a card has one action");
      if (rule === "result" && buttons.some((button) => !resultActionAllowed(button.action))) {
        issue(`Result buttons only navigate or open ${ACTION_CARD_SPEC_RESULT_INTENTS.join(", ")}`);
      }
      if (rule === "spec" && buttons.some((button) => opensResultIntent(button.action))) issue(`${ACTION_CARD_SPEC_RESULT_INTENTS.join(", ")} opens only from a result`);
      if (buttons.filter((button) => button.emphasis === "primary").length > 1) issue("At most one primary button");
    });

  const fieldName = name(FIELD_NAME);
  const common = { name: fieldName, label: msg(40), placeholder: msg(120).optional(), description: msg(300).optional() };
  const required = z.boolean().optional();
  const withinMaxLength = (field: { maxLength: number; default?: string }) => field.default === undefined || cardCodePoints(field.default) <= field.maxLength;
  const picker = { ...common, required, emptyText: msg(120).optional(), multiple: z.boolean(), maxItems: z.number().int().min(1).max(50).optional(), default: z.array(entityRef).optional() };
  const checkPicker = (fits: (kind: ActionCardSpecEntityRef["kind"]) => boolean) =>
    (field: { multiple: boolean; maxItems?: number; default?: ActionCardSpecEntityRef[] }, ctx: z.RefinementCtx) => {
      if (!field.multiple && field.maxItems !== undefined && field.maxItems !== 1) ctx.addIssue({ code: "custom", path: ["maxItems"], message: "A single picker takes one item" });
      const defaults = field.default ?? [];
      if (defaults.length > pickerMax(field)) ctx.addIssue({ code: "custom", path: ["default"], message: "More defaults than the picker takes" });
      if (defaults.some((ref) => !fits(ref.kind))) ctx.addIssue({ code: "custom", path: ["default"], message: "A default does not fit the picker" });
      if (!unique(defaults.map((ref) => ref.id))) ctx.addIssue({ code: "custom", path: ["default"], message: "Defaults must be unique" });
    };
  const knownField = z.discriminatedUnion("type", [
    object({ type: z.literal("TextInput"), ...common, required, maxLength: z.number().int().min(1).max(500), default: z.string().optional() })
      .refine(withinMaxLength, { path: ["default"], message: "The default is longer than maxLength" }),
    object({ type: z.literal("TextArea"), ...common, required, maxLength: z.number().int().min(1).max(8000), rows: z.number().int().min(2).max(10).optional(), default: z.string().optional() })
      .refine(withinMaxLength, { path: ["default"], message: "The default is longer than maxLength" }),
    object({ type: z.literal("Select"), ...common, required,
      options: z.array(object({ value: z.string().regex(OPTION_VALUE), label: msg(40) })).min(1).max(ACTION_CARD_SPEC_LIMITS.maxOptions)
        .refine((options) => unique(options.map((option) => option.value)), "Option values must be unique"),
      default: z.string().optional() })
      .refine((field) => field.default === undefined || field.options.some((option) => option.value === field.default), { path: ["default"], message: "The default must be an option" }),
    // A toggle is always answered (false by default), so it cannot be required.
    object({ type: z.literal("Toggle"), ...common, default: z.boolean().optional() }),
    object({ type: z.literal("MemberPicker"), ...picker,
      kinds: z.union([z.tuple([z.literal("human")]), z.tuple([z.literal("agent")]), z.tuple([z.literal("human"), z.literal("agent")])]),
      scope: z.enum(["server", "channel"]) })
      .superRefine((field, ctx) => checkPicker((kind) => field.kinds.some((k) => (k === "human" ? "user" : "agent") === kind))(field, ctx)),
    object({ type: z.literal("ChannelPicker"), ...picker, scope: z.enum(["joined", "visible"]) })
      .superRefine(checkPicker((kind) => kind === "channel")),
    object({ type: z.literal("AgentPicker"), ...picker })
      .superRefine(checkPicker((kind) => kind === "agent")),
    object({ type: z.literal("Choice"), ...common, required, multiple: z.boolean(),
      minItems: z.number().int().min(1).max(ACTION_CARD_SPEC_LIMITS.maxOptions + 1).optional(),
      maxItems: z.number().int().min(1).max(ACTION_CARD_SPEC_LIMITS.maxOptions + 1).optional(),
      options: z.array(object({
        value: z.string().regex(OPTION_VALUE).refine((value) => value !== ACTION_CARD_CHOICE_RESERVED_VALUE, `"${ACTION_CARD_CHOICE_RESERVED_VALUE}" is reserved for the Other text`),
        label: msg(80),
        description: msg(200).optional(),
      })).min(1).max(ACTION_CARD_SPEC_LIMITS.maxOptions)
        .refine((options) => unique(options.map((option) => option.value)), "Option values must be unique"),
      other: object({ label: msg(40), description: msg(120).optional(), placeholder: msg(120).optional(), maxLength: z.number().int().min(1).max(ACTION_CARD_CHOICE_OTHER_MAX_LENGTH) }).optional(),
      default: object({ selected: z.array(z.string()).max(ACTION_CARD_SPEC_LIMITS.maxOptions), other: z.string().optional() }).optional() })
      .superRefine(checkChoice),
  ]);
  const unsupportedField = z.looseObject({ type: z.string().regex(FIELD_TYPE_NAME).refine((type) => !FIELD_TYPES.includes(type)), name: fieldName })
    .transform((field): ActionCardSpecUnsupportedField => ({ type: "unsupported", originalType: field.type, name: field.name }));
  const field = read ? z.union([knownField, unsupportedField]) : knownField;
  const submitLabels = object({ field: fieldName, labels: record(z.string().regex(OPTION_VALUE), msg(24), ACTION_CARD_SPEC_LIMITS.maxOptions) });
  const step = object({ title: msg(80).optional(), fields: z.array(fieldName).min(1).max(ACTION_CARD_SPEC_LIMITS.maxFields) });
  const form = object({
    title: msg(80), submitLabel: msg(24), submitLabels: submitLabels.optional(), description: msg(500).optional(),
    steps: z.array(step).min(ACTION_CARD_FORM_STEPS.min).max(ACTION_CARD_FORM_STEPS.max).optional(),
    // Read: a placement it does not know is dropped (below), so the form opens in the sheet.
    placement: read ? z.unknown().optional() : z.enum(ACTION_CARD_FORM_PLACEMENTS).optional(),
    fields: z.array(field).min(1).max(ACTION_CARD_SPEC_LIMITS.maxFields),
  })
    .refine((value) => unique(value.fields.map((f) => f.name)), { path: ["fields"], message: "Field names must be unique in a form" })
    // Steps name every field of the form exactly once (emit; a read drops steps that do not, below).
    .refine((value) => read || stepsCoverFields(value), { path: ["steps"], message: "Steps name every field of the form exactly once" })
    // Labels name one Select of this form and only its options (emit; a read uses what matches).
    .refine((value) => {
      if (read || !value.submitLabels) return true;
      const select = value.fields.find((f) => f.name === value.submitLabels!.field);
      return select?.type === "Select" && Object.keys(value.submitLabels.labels).every((key) => select.options.some((option) => option.value === key));
    }, { path: ["submitLabels"], message: "submitLabels name a Select of the form and its options" })
    .transform(({ placement, ...value }) => {
      const kept = (ACTION_CARD_FORM_PLACEMENTS as readonly unknown[]).includes(placement) ? { placement: placement as ActionCardFormPlacement } : {};
      if (value.steps === undefined || stepsCoverFields(value)) return { ...value, ...kept };
      const { steps: _dropped, ...rest } = value;
      return { ...rest, ...kept };
    });
  const confirmShape = { title: msg(80), confirmLabel: msg(24), spec: tree("confirm") };
  // Read leniency 7: a confirm key it does not know may change what confirming does; the card drops the confirm (below).
  const confirm = read
    ? z.union([
      z.strictObject(confirmShape),
      z.unknown().refine((raw) => hasKeyOutside(raw, Object.keys(confirmShape))).pipe(z.object(confirmShape))
        .transform((value) => ({ ...value, [CONFIRM_WITH_UNKNOWN_KEY]: true as const })),
    ])
    : z.strictObject(confirmShape);

  const shape = {
    catalog: z.literal(ACTION_CARD_SPEC_CATALOG),
    icon: read ? z.string().optional() : z.enum(ACTION_CARD_SPEC_ICONS).optional(),
    title: msg(80),
    spec: tree("spec"),
    confirms: record(actionId, confirm, ACTION_CARD_SPEC_LIMITS.maxConfirms).optional(),
    forms: record(actionId, form, ACTION_CARD_SPEC_LIMITS.maxForms).optional(),
    result: tree("result").optional(),
  };
  return object(shape).superRefine((card, ctx) => {
    // A button names an existing confirm / form; one nothing names is ignored.
    for (const [id, node] of Object.entries(card.spec.elements)) {
      if (node.type !== "Button") continue;
      const action = node.props.action;
      const path = ["spec", "elements", id, "props", "action"];
      if (action.kind === "execute" && action.confirm !== undefined && !(card.confirms && Object.hasOwn(card.confirms, action.confirm))) {
        ctx.addIssue({ code: "custom", path, message: `No confirm "${action.confirm}"` });
      }
      if (action.kind === "open_form" && !(card.forms && Object.hasOwn(card.forms, action.form))) {
        ctx.addIssue({ code: "custom", path, message: `No form "${action.form}"` });
      }
    }
  }).transform((card) => {
    const { icon, ...rest } = card;
    const known = icon === undefined || ICONS.includes(icon) ? card : rest;
    // Last, once the card is otherwise valid: a confirm with a key a read does not know is dropped, and each
    // execute naming it reads as unsupported, so it is never shown with that key ignored.
    const confirms = known.confirms;
    const dropped = confirms ? Object.keys(confirms).filter((id) => Object.hasOwn(confirms[id]!, CONFIRM_WITH_UNKNOWN_KEY)) : [];
    if (dropped.length === 0) return known;
    const elements = Object.fromEntries(Object.entries(known.spec.elements).map(([id, node]) => {
      const action = node.type === "Button" ? node.props.action : null;
      if (action?.kind !== "execute" || action.confirm === undefined || !dropped.includes(action.confirm)) return [id, node];
      return [id, { ...node, props: { ...node.props, action: unsupportedAction(action) } }];
    }));
    return { ...known, spec: { ...known.spec, elements }, confirms: Object.fromEntries(Object.entries(confirms!).filter(([id]) => !dropped.includes(id))) };
  });
}

const actionCardSpecEmitSchema = lazySchema("actionCardSpecEmitSchema", () => actionCardSpecSchema("emit"));
const actionCardSpecReadSchema = lazySchema("actionCardSpecReadSchema", () => actionCardSpecSchema("read"));

// ---------------------------------------------------------------------------
// Parsing.

function flattenIssues(issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[] = []): ActionCardSpecIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) return issue.errors.flatMap((errors) => flattenIssues(errors, path));
    return [{ path: path.map((part) => typeof part === "symbol" ? String(part) : part), message: issue.message }];
  });
}

function inspectActionCardSpec(raw: unknown, mode: ActionCardSpecParseMode): { card: ActionCardSpecReadCard; issues: [] } | { card: null; issues: ActionCardSpecIssue[] } {
  const parsed = (mode === "emit" ? actionCardSpecEmitSchema : actionCardSpecReadSchema).safeParse(raw);
  if (!parsed.success) return { card: null, issues: flattenIssues(parsed.error.issues) };
  const card = parsed.data as ActionCardSpecReadCard;
  if (mode === "emit") {
    const bytes = new TextEncoder().encode(JSON.stringify(card)).length;
    if (bytes > ACTION_CARD_SPEC_LIMITS.maxBytes) return { card: null, issues: [{ path: [], message: `The card is ${bytes} bytes, over ${ACTION_CARD_SPEC_LIMITS.maxBytes}` }] };
  }
  return { card, issues: [] };
}

/**
 * Reads a card. `emit`: what a server may send, fully strict, with the size
 * limit (measured on the parsed card, defaults filled in); S1's builders use
 * it. `read`: what a client accepts, with the seven leniencies above the schema
 * builder. Unknown keys are dropped, except where they could change what a
 * press does (a Button's props, its action, the confirm it opens): there the
 * button becomes Open in web (its action an unsupported marker, as for an
 * unknown action kind, intent or field type). Unknown icons and locales are
 * dropped too. A known key with a bad value still makes the card invalid.
 * Never throws; `{ ok: false }` means the client shows the legacy
 * presentation.
 */
export function parseActionCardSpec(raw: unknown, options: { mode: "emit" }): ActionCardSpecParseResult<ActionCardSpecCard>;
export function parseActionCardSpec(raw: unknown, options: { mode: "read" }): ActionCardSpecParseResult<ActionCardSpecReadCard>;
export function parseActionCardSpec(raw: unknown, options: { mode: ActionCardSpecParseMode }): ActionCardSpecParseResult<ActionCardSpecReadCard>;
export function parseActionCardSpec(raw: unknown, options: { mode: ActionCardSpecParseMode }): ActionCardSpecParseResult<ActionCardSpecReadCard> {
  const { card } = inspectActionCardSpec(raw, options.mode);
  return card ? { ok: true, card } : { ok: false };
}

/** Why parseActionCardSpec refuses a card (empty when it accepts it). For tests and server logs. */
export function actionCardSpecIssues(raw: unknown, options: { mode: ActionCardSpecParseMode }): ActionCardSpecIssue[] {
  return inspectActionCardSpec(raw, options.mode).issues;
}

// ---------------------------------------------------------------------------
// Messages.

/** The template a viewer reads: their display locale's, else English. */
export function pickActionCardTemplate(msg: ActionCardSpecMsg, displayLocale: string): string {
  const text: Record<string, string | undefined> = msg.text;
  return (Object.hasOwn(text, displayLocale) ? text[displayLocale] : undefined) ?? msg.text.en;
}

/**
 * A Msg's template with its params filled in, as segments: text (a string
 * param, or an integer as plain base-10 digits) and entity references, which
 * the client shows as a mention or channel chip where the slot allows rich
 * content (title, Text, Notice, Field) and as the plain name elsewhere (Button
 * labels). Adjacent text is merged and empty text dropped. A placeholder
 * without a param (only in a Msg that was never parsed) stays as written.
 * With `keepParams`, a string or number param is a segment of its own marked
 * `param` (never merged), for a client that keeps a name on one line.
 */
export type ActionCardMsgSegment = { text: string; param?: true } | { ref: ActionCardSpecEntityRef };
export function renderActionCardMsg(msg: ActionCardSpecMsg, displayLocale: string, options: { keepParams?: boolean } = {}): ActionCardMsgSegment[] {
  const template = pickActionCardTemplate(msg, displayLocale);
  const segments: ActionCardMsgSegment[] = [];
  const pushText = (text: string, param = false) => {
    if (!text) return;
    if (param && options.keepParams) {
      segments.push({ text, param: true });
      return;
    }
    const last = segments[segments.length - 1];
    if (last && "text" in last && !last.param) last.text += text;
    else segments.push({ text });
  };
  for (const token of templateTokens(template) ?? [{ text: template }]) {
    if ("text" in token) { pushText(token.text); continue; }
    const param = msg.params && Object.hasOwn(msg.params, token.param) ? msg.params[token.param] : undefined;
    if (param === undefined) pushText(`{${token.param}}`);
    else if (typeof param === "string") pushText(param, true);
    else if (typeof param === "number") pushText(String(param), true);
    else segments.push({ ref: { ...param } });
  }
  return segments;
}

/** The label of every button strip replaces, in every display locale. */
export const ACTION_CARD_OPEN_IN_WEB_LABEL: ActionCardSpecMsg = {
  key: "actionCard.openInWeb",
  text: { en: "Open in web", es: "Abrir en la web", "pt-br": "Abrir na web", ru: "Открыть в веб-версии", ko: "웹에서 열기", ja: "ウェブで開く", "zh-cn": "在网页打开", "zh-tw": "在網頁開啟" },
};

/** The key of the raw Msg (actionCardRawText). Clients never look a key up, so no table lists it. */
export const ACTION_CARD_RAW_TEXT_KEY = "actionCard.text.raw";
/** The raw Msg's text: 1-500 code points, the limit of a Msg's string param. */
export const ACTION_CARD_RAW_TEXT_MAX_LENGTH = 500;

/**
 * Text someone else wrote (an agent's question, option, description or
 * placeholder) for a slot that takes only a Msg: the "raw Msg", a template of
 * one placeholder with the text as its string param, English only. A client
 * shows a string param as it is, never as a template (so braces and markup
 * stay text) and falls back to English in every locale, so a reader of any
 * schemaVersion shows the text unchanged. The server wraps such text only
 * through this. Throws a RangeError unless the text is 1-500 code points:
 * longer text belongs in a slot that takes a plain string (a Field value, a
 * Text), never cut here.
 */
export function actionCardRawText(t: string): ActionCardSpecMsg {
  const length = cardCodePoints(t);
  if (length < 1 || length > ACTION_CARD_RAW_TEXT_MAX_LENGTH) {
    throw new RangeError(`Raw Msg text must be 1-${ACTION_CARD_RAW_TEXT_MAX_LENGTH} code points, not ${length}`);
  }
  return { key: ACTION_CARD_RAW_TEXT_KEY, text: { en: "{t}" }, params: { t } };
}

// ---------------------------------------------------------------------------
// Strip.

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneJson) as T;
  if (isPlainRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)])) as T;
  return value;
}

/**
 * What this client renders of a read card. Without `card.v1`, nothing (null:
 * show the legacy presentation). Otherwise each Button in `spec` and `result`
 * the client cannot handle (an unsupported action: an unknown kind or intent,
 * or a press a key the client does not know could change; a capability it
 * lacks: confirm.v1, form.v1, a field type of its form, the intent; a form
 * with an unsupported field) becomes, under the same element id, an "Open in
 * web" button: same emphasis (destructive becomes secondary) and
 * disabledReason. An execute with a confirm is never downgraded to a plain
 * execute. Everything else, forms and confirms included, is kept. Pure:
 * returns a new card.
 */
export function stripActionCardSpec(card: ActionCardSpecReadCard, capabilities: readonly string[]): ActionCardRenderedCard | null {
  const has = (capability: ActionCardSpecCapability) => capabilities.includes(capability);
  if (!has("card.v1")) return null;
  const supported = (action: ReadAction): action is ActionCardSpecAction => {
    switch (action.kind) {
      case "execute": return action.confirm === undefined || has("confirm.v1");
      case "open_form": {
        const form = card.forms && Object.hasOwn(card.forms, action.form) ? card.forms[action.form] : undefined;
        return !!form && has("form.v1") && form.fields.every((field) => field.type !== "unsupported" && has(ACTION_CARD_SPEC_FIELD_CAPABILITIES[field.type]));
      }
      case "open": return has(`intent.${action.intent}`);
      case "navigate": return true;
      default: return false;
    }
  };
  const strip = (tree: ActionCardSpecTree<ReadAction>): ActionCardSpecTree<ActionCardSpecAction | ActionCardSpecOpenWebAction> => ({
    root: tree.root,
    elements: Object.fromEntries(Object.entries(tree.elements).map(([id, node]): [string, ActionCardSpecElement<ActionCardSpecAction | ActionCardSpecOpenWebAction>] => {
      if (node.type !== "Button") return [id, cloneJson(node)];
      const { action, emphasis, disabledReason } = node.props;
      if (supported(action)) return [id, cloneJson({ ...node, props: { ...node.props, action } })];
      return [id, { type: "Button", props: {
        label: cloneJson(ACTION_CARD_OPEN_IN_WEB_LABEL),
        emphasis: emphasis === "destructive" ? "secondary" : emphasis,
        action: { kind: "open_web" },
        ...(disabledReason ? { disabledReason: cloneJson(disabledReason) } : {}),
      } }];
    })),
  });
  const { spec, result, ...rest } = card;
  return { ...cloneJson(rest), spec: strip(spec), ...(result ? { result: strip(result) } : {}) };
}

// ---------------------------------------------------------------------------
// Forms: submission, value checks and errors (S2 serves them).

export type ActionCardFormValue = string | boolean | string[] | ActionCardChoiceValue;
/** `form` on POST /api/actions/:messageId/execute: the form's id and a value per field name (pickers: ids; a Choice: ActionCardChoiceValue). */
export interface ActionCardFormSubmission { id: string; values: Record<string, ActionCardFormValue> }

/** `too_few` is schemaVersion 8 (a multiple Choice under its minItems); an older client shows its `message` as it shows any code. */
export const ACTION_CARD_FORM_ISSUE_CODES = ["required", "too_long", "too_many", "invalid_option", "not_found", "not_allowed", "conflict", "invalid_format", "too_few"] as const;
export type ActionCardFormIssueCode = typeof ACTION_CARD_FORM_ISSUE_CODES[number];
/** One problem with a submitted form: under its field, or at the top of the sheet when `field` is null. */
export interface ActionCardFormIssue { field: string | null; code: ActionCardFormIssueCode; message: ActionCardSpecMsg }

/** The generic message per issue code, in every display locale; too_long and too_many take `{max}`, too_few `{min}`. */
export const ACTION_CARD_FORM_ISSUE_MESSAGES: { readonly [C in ActionCardFormIssueCode]: ActionCardSpecMsg } = {
  required: { key: "actionCard.form.issue.required", text: {
    en: "This field is required.", es: "Este campo es obligatorio.", "pt-br": "Este campo é obrigatório.", ru: "Это обязательное поле.", ko: "필수 항목이에요.",
    ja: "この項目は必須です。", "zh-cn": "此项为必填项。", "zh-tw": "此欄位為必填。",
  } },
  too_long: { key: "actionCard.form.issue.too_long", text: {
    en: "Use {max} characters or fewer.", es: "Usa {max} caracteres o menos.", "pt-br": "Use no máximo {max} caracteres.", ru: "Максимальное количество символов: {max}.", ko: "{max}자 이하로 입력해 주세요.",
    ja: "{max} 文字以内で入力してください。", "zh-cn": "最多 {max} 个字符。", "zh-tw": "最多 {max} 個字元。",
  } },
  too_many: { key: "actionCard.form.issue.too_many", text: {
    en: "Choose {max} or fewer.", es: "Elige {max} o menos.", "pt-br": "Escolha no máximo {max}.", ru: "Выберите не больше {max}.", ko: "{max}개 이하로 선택해 주세요.",
    ja: "{max} 個以内で選択してください。", "zh-cn": "最多选择 {max} 项。", "zh-tw": "最多選擇 {max} 項。",
  } },
  invalid_option: { key: "actionCard.form.issue.invalid_option", text: {
    en: "Choose one of the options.", es: "Elige una de las opciones.", "pt-br": "Escolha uma das opções.", ru: "Выберите один из вариантов.", ko: "옵션 중에서 선택해 주세요.",
    ja: "選択肢から選択してください。", "zh-cn": "请从选项中选择。", "zh-tw": "請從選項中選擇。",
  } },
  not_found: { key: "actionCard.form.issue.not_found", text: {
    en: "This no longer exists.", es: "Ya no existe.", "pt-br": "Isso não existe mais.", ru: "Этот элемент больше не существует.", ko: "더 이상 존재하지 않아요.",
    ja: "これはもう存在しません。", "zh-cn": "该项已不存在。", "zh-tw": "該項目已不存在。",
  } },
  not_allowed: { key: "actionCard.form.issue.not_allowed", text: {
    en: "You can't choose this.", es: "No puedes elegir esto.", "pt-br": "Você não pode escolher isso.", ru: "Этот вариант нельзя выбрать.", ko: "이 항목은 선택할 수 없어요.",
    ja: "これは選択できません。", "zh-cn": "你不能选择此项。", "zh-tw": "你無法選擇此項。",
  } },
  conflict: { key: "actionCard.form.issue.conflict", text: {
    en: "This is already taken.", es: "Ya está en uso.", "pt-br": "Isso já está em uso.", ru: "Уже используется.", ko: "이미 사용 중이에요.",
    ja: "すでに使用されています。", "zh-cn": "已被占用。", "zh-tw": "已被使用。",
  } },
  invalid_format: { key: "actionCard.form.issue.invalid_format", text: {
    en: "This value is not valid.", es: "Este valor no es válido.", "pt-br": "Este valor não é válido.", ru: "Недопустимое значение.", ko: "유효하지 않은 값이에요.",
    ja: "この値は無効です。", "zh-cn": "此值无效。", "zh-tw": "此值無效。",
  } },
  too_few: { key: "actionCard.form.issue.too_few", text: {
    en: "Choose at least {min}.", es: "Elige al menos {min}.", "pt-br": "Escolha pelo menos {min}.", ru: "Выберите не меньше {min}.", ko: "{min}개 이상 선택해 주세요.",
    ja: "{min} 個以上選択してください。", "zh-cn": "至少选择 {min} 项。", "zh-tw": "至少選擇 {min} 項。",
  } },
};

/** An issue with the generic message for its code. */
export function actionCardFormIssue(field: string | null, code: ActionCardFormIssueCode, params?: Record<string, ActionCardSpecMsgParam>): ActionCardFormIssue {
  return { field, code, message: { ...cloneJson(ACTION_CARD_FORM_ISSUE_MESSAGES[code]), ...(params ? { params: cloneJson(params) } : {}) } };
}

/**
 * The checks both sides share; the App ports the client part. At most one
 * issue per field, in field order, then (server) unknown names sorted by
 * UTF-16 code units, as Kotlin's String.compareTo. A missing key is "not
 * provided".
 * - client: `required` (text: blank, see BLANK; Select: missing or ""; a
 *   picker: no ids; a Choice: no option chosen and `other` absent or blank),
 *   `too_long` (code points of the raw string over maxLength; a Choice's
 *   `other` over its Other's maxLength), `too_many` (more ids than the picker
 *   takes; a Choice: more items, options plus a non-blank `other`, than it
 *   takes), `too_few` (a multiple Choice with some but fewer items than its
 *   minItems). A value of the wrong type is left to the server.
 * - server, also: a value of the wrong type, an unknown field name, a picker id
 *   that is not a lowercase UUID or is repeated -> `invalid_format`; a Select
 *   value that is no option -> `invalid_option`. A Choice: a value that is not
 *   `{ selected: string[], other?: string }`, a selected value repeated or the
 *   reserved "other", `other` on a Choice without Other, or more than one
 *   selected on a single Choice -> `invalid_format` (checked first); a
 *   selected value that is no option -> `invalid_option` (checked last).
 *   Whether each id exists and may be chosen (not_found / not_allowed) is the
 *   form handler's.
 * Unsupported fields are skipped: a client never opens their form.
 */
export function checkActionCardFormValues(
  form: ActionCardSpecForm<ActionCardSpecField | ActionCardSpecUnsupportedField>,
  values: unknown,
  options: { mode: "client" | "server" },
): ActionCardFormIssue[] {
  const server = options.mode === "server";
  if (!isPlainRecord(values)) {
    if (server) return [actionCardFormIssue(null, "invalid_format")];
    values = {};
  }
  const submitted = values as Record<string, unknown>;
  const issues: ActionCardFormIssue[] = [];
  for (const field of form.fields) {
    if (field.type === "unsupported") continue;
    const provided = Object.hasOwn(submitted, field.name);
    const issue = fieldIssue(field, provided, provided ? submitted[field.name] : undefined, server);
    if (issue) issues.push(issue);
  }
  if (server) {
    const names = new Set(form.fields.map((field) => field.name));
    for (const key of Object.keys(submitted).filter((key) => !names.has(key)).sort()) issues.push(actionCardFormIssue(key, "invalid_format"));
  }
  return issues;
}

function fieldIssue(field: ActionCardSpecField, provided: boolean, value: unknown, server: boolean): ActionCardFormIssue | null {
  const wrongType = () => server ? actionCardFormIssue(field.name, "invalid_format") : null;
  switch (field.type) {
    case "TextInput":
    case "TextArea":
    case "Select": {
      if (provided && typeof value !== "string") return wrongType();
      const text = provided ? value as string : undefined;
      const empty = text === undefined || (field.type === "Select" ? text === "" : BLANK.test(text));
      if (empty && field.required) return actionCardFormIssue(field.name, "required");
      if (text === undefined) return null;
      if (field.type !== "Select") return cardCodePoints(text) > field.maxLength ? actionCardFormIssue(field.name, "too_long", { max: field.maxLength }) : null;
      return server && text !== "" && !field.options.some((option) => option.value === text) ? actionCardFormIssue(field.name, "invalid_option") : null;
    }
    case "Toggle":
      return provided && typeof value !== "boolean" ? wrongType() : null;
    case "Choice":
      return choiceIssue(field, provided, value, server);
    default: {
      if (provided && !(Array.isArray(value) && value.every((id) => typeof id === "string"))) return wrongType();
      const ids = provided ? value as string[] : [];
      if (ids.length === 0) return field.required ? actionCardFormIssue(field.name, "required") : null;
      const max = pickerMax(field);
      if (ids.length > max) return actionCardFormIssue(field.name, "too_many", { max });
      return server && (ids.some((id) => !LOWER_UUID.test(id)) || !unique(ids)) ? actionCardFormIssue(field.name, "invalid_format") : null;
    }
  }
}

/** Whether `value` is a Choice value: `{ selected: string[], other?: string }` and nothing else. */
function isChoiceValue(value: unknown): value is ActionCardChoiceValue {
  return isPlainRecord(value)
    && Object.keys(value).every((key) => key === "selected" || key === "other")
    && Array.isArray(value.selected) && value.selected.every((selected) => typeof selected === "string")
    && (value.other === undefined || typeof value.other === "string");
}

function choiceIssue(field: ActionCardSpecChoiceField, provided: boolean, value: unknown, server: boolean): ActionCardFormIssue | null {
  if (provided && !isChoiceValue(value)) return server ? actionCardFormIssue(field.name, "invalid_format") : null;
  const selected = provided ? (value as ActionCardChoiceValue).selected : [];
  const other = provided ? (value as ActionCardChoiceValue).other : undefined;
  if (server && (!unique(selected) || selected.includes(ACTION_CARD_CHOICE_RESERVED_VALUE) || (other !== undefined && !field.other)
    || (!field.multiple && selected.length > 1))) {
    return actionCardFormIssue(field.name, "invalid_format");
  }
  const items = selected.length + (other !== undefined && !BLANK.test(other) ? 1 : 0);
  if (items === 0 && field.required) return actionCardFormIssue(field.name, "required");
  if (other !== undefined && field.other && cardCodePoints(other) > field.other.maxLength) return actionCardFormIssue(field.name, "too_long", { max: field.other.maxLength });
  if (items === 0) return null;
  const max = choiceMax(field);
  if (items > max) return actionCardFormIssue(field.name, "too_many", { max });
  const min = choiceMin(field);
  if (items < min) return actionCardFormIssue(field.name, "too_few", { min });
  return server && selected.some((choice) => !field.options.some((option) => option.value === choice)) ? actionCardFormIssue(field.name, "invalid_option") : null;
}

/** 422 from execute when a submitted form fails its checks. */
export const ACTION_CARD_FORM_INVALID_STATUS = 422;
export const ACTION_CARD_FORM_INVALID_ERROR_CODE = "FORM_INVALID";
export interface ActionCardFormInvalidBody { error: string; errorCode: typeof ACTION_CARD_FORM_INVALID_ERROR_CODE; issues: ActionCardFormIssue[] }

/**
 * 422 from execute (and mark-executed) when a form card is completed without
 * its form: a client that does not know forms, such as an older App's generic
 * approve.
 */
export const ACTION_CARD_FORM_REQUIRED_STATUS = 422;
export const ACTION_CARD_FORM_REQUIRED_ERROR_CODE = "FORM_REQUIRED";
export interface ActionCardFormRequiredBody { error: string; errorCode: typeof ACTION_CARD_FORM_REQUIRED_ERROR_CODE }

/**
 * 409 from execute when a request with `form` reaches a card that is already
 * executed, so a second submitter does not think their values took effect.
 * The same executor sending the same values again gets the idempotent 200; a
 * request without `form` keeps today's behaviour.
 */
export const ACTION_CARD_ALREADY_EXECUTED_STATUS = 409;
export const ACTION_CARD_ALREADY_EXECUTED_ERROR_CODE = "ALREADY_EXECUTED";
export interface ActionCardAlreadyExecutedBody { error: string; errorCode: typeof ACTION_CARD_ALREADY_EXECUTED_ERROR_CODE; metadata: ActionCardMetadata }
