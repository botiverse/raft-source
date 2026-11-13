// Card messages (RFC 082): a sender (an agent, an App's bot included) posts a
// message with a card, a small display-only element tree every member of the
// conversation sees the same way, plus a fallback text (the sender's
// `content`, or one Raft derives from the card). Agents read the card as
// markdown Raft generates from it (renderMessageCardMarkdown, at the end).
//
// A third catalog on cardElements.ts, next to link cards v2 (appLinkPreview.ts)
// and action cards (actionCardSpec.ts). It started as the link card v2 tree
// (Stack, Text, Badge, RelativeTime, Duration, Button, and its bounds), and a
// card of only those is still a valid link card v2 (messageCard.test.ts pins
// it). v2.0 (RFC 082 §4.8) adds what link cards don't have: an optional card
// `header` (a title, a subtitle, up to three tags in a status tone) and the
// `Markdown` (a checked subset: messageCardMarkdown.ts), `Fields` and
// `Divider` elements. The card stays version 1: every client in use reads a
// card with the strict schema and shows the whole fallback for anything it
// doesn't know. Buttons only navigate, to a public HTTPS URL. Display only:
// nothing on a card calls anyone back.
//
// Stored on the message as `action_metadata = { kind: "message-card", card,
// revision, updatedAt }`. Card text lengths count Unicode code points, so Go,
// Kotlin and TypeScript agree.

import { z } from "zod";
import { lazySchema } from "./lazySchema";
import {
  CARD_ELEMENT_ID, CARD_RESERVED_IDS, cardBadgeTone, cardCodePoints, cardDurationElement, cardElementId, cardRelativeTimeElement, cardStackElement,
  cardText, checkBoundedTree, publicPreviewUrl, type CardBadgeTone,
} from "./cardElements";
import {
  checkMessageCardMarkdown, MESSAGE_CARD_MARKDOWN_ALLOWED_SUMMARY, MESSAGE_CARD_MARKDOWN_MAX_NESTING, messageCardMarkdownAgentSource,
  messageCardMarkdownTokens, type CardMarkdownToken,
} from "./messageCardMarkdown";
import { createRaftUserRefRegex, extractRaftMentionHandles, RAFT_REF_USER_NAME_PATTERN } from "./raftRefs";
import { formatUtcTimestamp } from "./utcTimestamp";

/** `actionMetadata.kind` of a message card (the stored spelling; never rename it). */
export const MESSAGE_CARD_KIND = "message-card";
export const MESSAGE_CARD_VERSION = 1;

export const MESSAGE_CARD_LIMITS = {
  /** Elements in one card, the root included (link cards v2: 16). */
  maxElements: 16,
  /** The root is depth 0; no element deeper than this (link cards v2: 4). */
  maxDepth: 4,
  /** Button elements in one card (link cards v2: 4). */
  maxButtons: 4,
  /** Tags in the card's header (RFC 082 §4.8). The header is no element: it counts towards maxBytes, not maxElements. */
  maxHeaderTags: 3,
  /** Rows of one Fields element (RFC 082 §4.8). */
  maxFields: 8,
  /** A Markdown element's content, in code points (RFC 082 §4.8). */
  markdownMaxCodePoints: 2000,
  /** Lists and quotes in a Markdown element nest at most this many levels (RFC 082 §4.8). */
  markdownMaxNesting: MESSAGE_CARD_MARKDOWN_MAX_NESTING,
  /** The card as the sender sent it, serialized as JSON, in UTF-8 bytes (8 KiB). */
  maxBytes: 8192,
  /** A derived fallback is cut to this many code points (RFC 082 §4.1). */
  fallbackMaxCodePoints: 500,
  /** What agents read of a card (renderMessageCardMarkdown) is cut to this many code points (RFC 082 §4.3); an 8 KiB card hardly reaches it. */
  agentTextMaxCodePoints: 4000,
  /** Its sender may replace a card this many days after sending it, not later (RFC 082 §4.2). */
  updateWindowDays: 14,
  /** Updates of one message a minute (RFC 082 §4.2). */
  updatesPerMessagePerMinute: 10,
  /** Updates by one sender an hour, over all its card messages (RFC 082 §4.2). */
  updatesPerSenderPerHour: 300,
  /** Every revision is kept this many days after the message was sent: the update window plus 30 (RFC 082 §4.5). */
  revisionRetentionDays: 44,
} as const;

/** What a send says when it is refused because of its card (400; the update route reuses them). */
export const MESSAGE_CARD_ERROR_CODES = {
  /** Was: the Server's `message_cards` flag off (retired; no longer sent). Kept so older clients still parse it. */
  disabled: "message_cards_disabled",
  /** The card breaks a rule: `path` and `limit` say where and which. */
  invalid: "card_invalid",
  /**
   * The target cannot take a card message. No current Server sends it: until
   * RFC 082 v1.8 a Server answered it for a joint channel (`reason:
   * "joint_channel"`), which now takes cards. Kept so a client still maps an
   * older Server's answer (the CLI's MESSAGE_CARD_UNSUPPORTED_TARGET).
   */
  unsupportedTarget: "message_card_unsupported_target",
  /** `mentions` were sent without `content`: a derived fallback mentions no one. */
  mentionsWithoutContent: "message_card_mentions_without_content",
  /** `attachmentIds` were sent with the card: a card message carries no files, in any conversation (RFC 082 §4.1, v1.7). */
  withAttachments: "message_card_with_attachments",
  /**
   * Update (404): no card message with this id the caller may update. One
   * answer for not the sender, older than the window, deleted or retracted,
   * not a card message, and unknown.
   */
  notFound: "message_card_not_found",
  /** Update (409): `expectedRevision` is not the card's current revision (`currentRevision`). */
  revisionConflict: "card_revision_conflict",
} as const;

/** The next step every card refusal names (Sage, RFC 082 §4.2). */
export const MESSAGE_CARD_FIX_NEXT_STEP = "fix it and run the same command again";

const TEXT_TONES = ["default", "muted", "warning"] as const;
const BUTTON_VARIANTS = ["default", "ghost"] as const;
/**
 * A header tag's tone: the design system's status tones, nothing else (RFC
 * 082 §4.8; Kirby: pink and yellow mean "waiting for you" and "you" / "agent
 * working" in Raft, so neither is open to Apps). The header itself has no colour.
 */
export const MESSAGE_CARD_HEADER_TAG_TONES = ["neutral", "info", "success", "warning", "danger"] as const;
export type MessageCardHeaderTagTone = typeof MESSAGE_CARD_HEADER_TAG_TONES[number];
// Every separator a universal-newline reader splits on (AGENT_BODY_LINE_SEPARATOR in agentMessageText.ts).
const CARD_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/**
 * The card's optional header (RFC 082 §4.8): a title, a one-line subtitle and
 * up to three tags, all plain text. Not an element: Raft draws it at the top
 * of the card, and it counts towards the card's 8 KiB only.
 */
export const messageCardHeaderSchema = lazySchema("messageCardHeaderSchema", () => z.strictObject({
  title: cardText(1, 100),
  subtitle: cardText(1, 100).refine((value) => !CARD_LINE_BREAK.test(value), "A header subtitle is one line").optional(),
  tags: z.array(z.strictObject({ text: cardText(1, 24), tone: z.enum(MESSAGE_CARD_HEADER_TAG_TONES) })).max(MESSAGE_CARD_LIMITS.maxHeaderTags).optional(),
}));
export type MessageCardHeader = z.output<typeof messageCardHeaderSchema>;

export const messageCardTextElement = lazySchema("messageCardTextElement", () => z.strictObject({
  type: z.literal("Text"),
  props: z.strictObject({
    text: cardText(1, 500),
    tone: z.enum(TEXT_TONES).default("default"),
    // For branch names, SHAs and similar; the client picks the face.
    mono: z.boolean().default(false),
  }),
}));
export const messageCardBadgeElement = lazySchema("messageCardBadgeElement", () => z.strictObject({
  type: z.literal("Badge"),
  props: z.strictObject({ text: cardText(1, 60), tone: cardBadgeTone.default("neutral") }),
}));
/** Only `navigate`: a message card is display only (RFC 082 §3; callbacks are phase 2). */
export const messageCardNavigateAction = lazySchema("messageCardNavigateAction", () => z.strictObject({
  kind: z.literal("navigate"),
  url: z.string().max(2000).refine((s) => !!publicPreviewUrl(s), "Expected a public HTTPS URL"),
}));
/**
 * Where a navigate button opens its page (web_preview_v0; stdrc in the
 * proj-workspace channel, message a351cd82; this text ships in the SDK's
 * types, which must not contain the workspace protocol prefix): `tab` (or absent), a new tab, as every button
 * did before; `beside`, the web's preview panel beside the conversation,
 * where the Server's `web_preview_v0` is on and the conversation has a side
 * area, else a new tab. Only how Raft opens it: the address is the same
 * public HTTPS one either way. A client that doesn't know it opens a tab.
 */
export const MESSAGE_CARD_BUTTON_OPEN = ["tab", "beside"] as const;
export type MessageCardButtonOpen = typeof MESSAGE_CARD_BUTTON_OPEN[number];
export const messageCardButtonElement = lazySchema("messageCardButtonElement", () => z.strictObject({
  type: z.literal("Button"),
  props: z.strictObject({
    label: cardText(1, 40),
    variant: z.enum(BUTTON_VARIANTS).default("default"),
    action: messageCardNavigateAction,
    disabledReason: cardText(1, 200).optional(),
    open: z.enum(MESSAGE_CARD_BUTTON_OPEN).optional(),
  }),
}));

/**
 * Formatted text (RFC 082 §4.8): the one place a card carries markdown. The
 * schema bounds its length; parseMessageCard checks its subset on the parsed
 * tree (messageCardMarkdown.ts), and a client draws a node outside it as its
 * source text.
 */
export const messageCardMarkdownElement = lazySchema("messageCardMarkdownElement", () => z.strictObject({
  type: z.literal("Markdown"),
  props: z.strictObject({ content: cardText(1, MESSAGE_CARD_LIMITS.markdownMaxCodePoints) }),
}));
/** Label and value rows (RFC 082 §4.8), plain text; `mono` for machine-written values (versions, ids, times, commands). */
export const messageCardFieldsElement = lazySchema("messageCardFieldsElement", () => z.strictObject({
  type: z.literal("Fields"),
  props: z.strictObject({
    items: z.array(z.strictObject({ label: cardText(1, 40), value: cardText(1, 200), mono: z.boolean().default(false) })).min(1).max(MESSAGE_CARD_LIMITS.maxFields),
  }),
}));
/** A separator (RFC 082 §4.8). */
export const messageCardDividerElement = lazySchema("messageCardDividerElement", () => z.strictObject({
  type: z.literal("Divider"),
  props: z.strictObject({}),
}));

const ELEMENT_SCHEMAS = {
  Stack: cardStackElement,
  Text: messageCardTextElement,
  Badge: messageCardBadgeElement,
  RelativeTime: cardRelativeTimeElement,
  Duration: cardDurationElement,
  Button: messageCardButtonElement,
  Markdown: messageCardMarkdownElement,
  Fields: messageCardFieldsElement,
  Divider: messageCardDividerElement,
} as const;
export type MessageCardElementType = keyof typeof ELEMENT_SCHEMAS;
export const MESSAGE_CARD_ELEMENT_TYPES = Object.keys(ELEMENT_SCHEMAS) as MessageCardElementType[];

export const messageCardElementSchema = lazySchema("messageCardElementSchema", () => z.discriminatedUnion("type", [
  cardStackElement, messageCardTextElement, messageCardBadgeElement, cardRelativeTimeElement, cardDurationElement, messageCardButtonElement,
  messageCardMarkdownElement, messageCardFieldsElement, messageCardDividerElement,
]));

/**
 * The stored card (defaults filled in). parseMessageCard is the one way in: it
 * says what is wrong, and it checks a Markdown element's subset, which this
 * schema doesn't (a client reading a stored card draws a node outside the
 * subset as its source text rather than dropping the card).
 */
export const messageCardSchema = lazySchema("messageCardSchema", () => z.strictObject({
  version: z.literal(MESSAGE_CARD_VERSION),
  header: messageCardHeaderSchema.optional(),
  root: cardElementId,
  elements: z.record(cardElementId, messageCardElementSchema),
}).superRefine((card, ctx) => {
  if (checkBoundedTree(card, MESSAGE_CARD_LIMITS) !== null) ctx.addIssue({ code: "custom", message: "Card must be one bounded tree" });
  if (Object.values(card.elements).filter((node) => node.type === "Button").length > MESSAGE_CARD_LIMITS.maxButtons) {
    ctx.addIssue({ code: "custom", message: `At most ${MESSAGE_CARD_LIMITS.maxButtons} buttons` });
  }
}));
export type MessageCard = z.output<typeof messageCardSchema>;
export type MessageCardElement = MessageCard["elements"][string];

// The card as a sender writes it (defaults optional). Zod-free, so the agent
// API request type (agentApiMessageContract.ts) needs no validator to read.
export type MessageCardElementInput =
  | { type: "Stack"; props: { direction?: "column" | "row"; wrap?: boolean }; children?: string[] }
  | { type: "Text"; props: { text: string; tone?: typeof TEXT_TONES[number]; mono?: boolean } }
  | { type: "Badge"; props: { text: string; tone?: CardBadgeTone } }
  | { type: "RelativeTime"; props: { at: string } }
  | { type: "Duration"; props: { start: string; end?: string } }
  | { type: "Button"; props: { label: string; variant?: typeof BUTTON_VARIANTS[number]; action: { kind: "navigate"; url: string }; disabledReason?: string; open?: MessageCardButtonOpen } }
  | { type: "Markdown"; props: { content: string } }
  | { type: "Fields"; props: { items: Array<{ label: string; value: string; mono?: boolean }> } }
  | { type: "Divider"; props: Record<string, never> };
export interface MessageCardHeaderInput {
  title: string;
  subtitle?: string;
  tags?: Array<{ text: string; tone: MessageCardHeaderTagTone }>;
}
export interface MessageCardInput {
  version: typeof MESSAGE_CARD_VERSION;
  header?: MessageCardHeaderInput;
  root: string;
  elements: Record<string, MessageCardElementInput>;
}
// A card the sender may write is one the schema reads, and the other way round.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _MessageCardInputLockstep = Assert<MutuallyAssignable<MessageCardInput, z.input<typeof messageCardSchema>>>;

/** `action_metadata` of a card message. `revision` starts at 1; `updatedAt` is ISO UTC. */
export interface MessageCardMetadata {
  kind: typeof MESSAGE_CARD_KIND;
  card: MessageCard;
  revision: number;
  updatedAt: string;
}

/** Whether `value` is a message card's metadata (kind and revision; the card is not re-validated). */
export function isMessageCardMetadata(value: unknown): value is MessageCardMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<MessageCardMetadata>;
  return metadata.kind === MESSAGE_CARD_KIND && Number.isInteger(metadata.revision) && (metadata.revision ?? 0) >= 1
    && !!metadata.card && typeof metadata.card === "object";
}

/** The metadata a send stores: revision 1, updated when it was sent. */
export function messageCardMetadataAtSend(card: MessageCard, sentAt: Date): MessageCardMetadata {
  return { kind: MESSAGE_CARD_KIND, card, revision: 1, updatedAt: sentAt.toISOString() };
}

/** The metadata an update stores: the new card, the next revision, updated now. */
export function messageCardMetadataAfterUpdate(current: MessageCardMetadata, card: MessageCard, updatedAt: Date): MessageCardMetadata {
  return { kind: MESSAGE_CARD_KIND, card, revision: current.revision + 1, updatedAt: updatedAt.toISOString() };
}

/**
 * What an update's answer says (RFC 082 §4.2, Sage 2): nobody was told, and
 * each @mention in the new fallback by name, since none of them was notified.
 */
export function formatMessageCardUpdateNotice(unnotifiedMentionHandles: readonly string[]): string {
  if (unnotifiedMentionHandles.length === 0) return "Updating notifies no one. To tell someone, send a new message.";
  const names = unnotifiedMentionHandles.length === 1
    ? unnotifiedMentionHandles[0]!
    : `${unnotifiedMentionHandles.slice(0, -1).join(", ")} and ${unnotifiedMentionHandles[unnotifiedMentionHandles.length - 1]}`;
  const verb = unnotifiedMentionHandles.length === 1 ? "was" : "were";
  return `Updating notifies no one. ${names} in the new text ${verb} not notified; to tell them, send a new message.`;
}

/**
 * Which rule a card breaks:
 * - `shape`: not `{ version: 1, header?, root, elements }`, or a field the card has no place for;
 * - `size`: more than 8 KiB of JSON (the header included);
 * - `elements`: more than 16 elements;
 * - `element_id`: an id that is not `[a-zA-Z][a-zA-Z0-9_-]{0,63}`, or a reserved name;
 * - `element_type`: not one of Stack, Text, Badge, RelativeTime, Duration, Button, Markdown, Fields, Divider;
 * - `children`: a Stack with more than 12 children;
 * - `depth`: an element deeper than 4 (the root is 0);
 * - `tree`: not one tree from `root` (a missing root or child, an element
 *   reached twice or not at all);
 * - `buttons`: more than 4 buttons;
 * - `text`: a text outside its length, in code points;
 * - `url`: a navigate URL that is not a public HTTPS URL;
 * - `action`: a button action other than `navigate`;
 * - `time`: not an RFC 3339 UTC time, or a Duration that ends before it starts;
 * - `tags`: more than 3 tags in the header;
 * - `fields`: a Fields element with no rows or more than 8;
 * - `markdown`: a Markdown element with something outside its subset (`node`
 *   names it: a heading, an image, a table, HTML, a link that is not
 *   http:, https: or mailto:,
 *   a list or quote nested deeper than 3, ...);
 * - `prop`: any other property that is missing or not allowed (a header
 *   tag's tone included);
 * - `fallback`: no `content`, and nothing on the card to derive one from.
 */
export type MessageCardLimit =
  | "shape" | "size" | "elements" | "element_id" | "element_type" | "children" | "depth" | "tree"
  | "buttons" | "text" | "url" | "action" | "time" | "tags" | "fields" | "markdown" | "prop" | "fallback";

/** Where a card breaks a rule (`card.elements.title.props.text`), which rule, and what it allows. */
export interface MessageCardProblem {
  path: string;
  limit: MessageCardLimit;
  message: string;
  /**
   * `markdown` only: what the Markdown check found outside the subset, as
   * an mdast node type (`heading`, `html`, `image`, `table`, `link`, `list`,
   * `taskListItem`, ...; messageCardMarkdown.ts).
   */
  node?: string;
}

export type MessageCardParseResult = { ok: true; card: MessageCard } | { ok: false; problem: MessageCardProblem };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

function refused(path: string, limit: MessageCardLimit, message: string): MessageCardParseResult {
  return { ok: false, problem: { path, limit, message } };
}

/** Each element's text props and their bounds, in code points. */
const TEXT_BOUNDS: Partial<Record<MessageCardElementType, Record<string, readonly [number, number]>>> = {
  Text: { text: [1, 500] },
  Badge: { text: [1, 60] },
  Button: { label: [1, 40], disabledReason: [1, 200] },
  Markdown: { content: [1, MESSAGE_CARD_LIMITS.markdownMaxCodePoints] },
  Fields: { label: [1, 40], value: [1, 200] },
};

function issuePath(path: readonly PropertyKey[]): string {
  return path.map((key) => typeof key === "number" ? `[${key}]` : `.${String(key)}`).join("");
}

function valueAt(value: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>((at, key) => (at && typeof at === "object" ? (at as Record<PropertyKey, unknown>)[key] : undefined), value);
}

/** One element's first schema issue (a Fields element's row count before anything in its rows), as a problem at its path. */
function elementProblem(id: string, type: MessageCardElementType, element: Record<string, unknown>, issues: readonly z.core.$ZodIssue[]): MessageCardProblem {
  const rows = type === "Fields"
    ? issues.find((candidate) => issuePath(candidate.path) === ".props.items" && (candidate.code === "too_big" || candidate.code === "too_small"))
    : undefined;
  if (rows) {
    const items = valueAt(element, rows.path);
    return {
      path: `card.elements.${id}.props.items`,
      limit: "fields",
      message: `Fields has 1-${MESSAGE_CARD_LIMITS.maxFields} rows; this one has ${Array.isArray(items) ? items.length : 0}`,
    };
  }
  const issue = issues[0]!;
  const path = `card.elements.${id}${issuePath(issue.path)}`;
  const field = issue.path[issue.path.length - 1];
  const value = valueAt(element, issue.path);
  if (field === "children" && issue.code === "too_big") {
    return { path, limit: "children", message: "A Stack has at most 12 children" };
  }
  if (field === "url") return { path, limit: "url", message: "A button's URL must be a public https: URL (no credentials, port, fragment or IP address), at most 2000 characters" };
  if (type === "Button" && field === "open") return { path, limit: "prop", message: `A button's open is ${MESSAGE_CARD_BUTTON_OPEN.join(" or ")}: "beside" opens the page in the web preview beside the conversation, "tab" (the default) in a new tab` };
  if (issue.path.includes("action")) return { path, limit: "action", message: "A message card button only navigates: action { kind: \"navigate\", url }" };
  if (field === "at" || field === "start" || field === "end" || (type === "Duration" && issue.code === "custom")) {
    return { path, limit: "time", message: type === "Duration" && issue.code === "custom" && field !== "start" && field !== "end"
      ? "A Duration cannot end before it starts"
      : "Expected an RFC 3339 UTC time, such as 2026-11-03T12:03:00Z" };
  }
  const bounds = typeof field === "string" ? TEXT_BOUNDS[type]?.[field] : undefined;
  if (bounds && typeof value === "string") {
    const [min, max] = bounds;
    return { path, limit: "text", message: `${type} ${String(field)} is ${min}-${max} characters (Unicode code points); this one has ${cardCodePoints(value)}` };
  }
  return { path, limit: "prop", message: `${type}: ${issue.message}` };
}

const HEADER_TEXT_BOUNDS: Record<string, readonly [number, number]> = { title: [1, 100], subtitle: [1, 100], text: [1, 24] };

/** The header's first problem (RFC 082 §4.8), or null. */
function headerProblem(header: unknown): MessageCardProblem | null {
  if (!isPlainObject(header)) {
    return { path: "card.header", limit: "shape", message: "header is an object: { title, subtitle?, tags? }" };
  }
  const parsed = messageCardHeaderSchema.safeParse(header);
  if (parsed.success) return null;
  const tags = parsed.error.issues.find((issue) => issuePath(issue.path) === ".tags" && issue.code === "too_big");
  if (tags) {
    const count = Array.isArray(header.tags) ? header.tags.length : 0;
    return { path: `card.header.tags[${MESSAGE_CARD_LIMITS.maxHeaderTags}]`, limit: "tags", message: `The header has ${count} tags; at most ${MESSAGE_CARD_LIMITS.maxHeaderTags}` };
  }
  const issue = parsed.error.issues[0]!;
  const path = `card.header${issuePath(issue.path)}`;
  const field = issue.path[issue.path.length - 1];
  const value = valueAt(header, issue.path);
  const name = field === "text" ? "tag text" : String(field);
  if (field === "subtitle" && issue.code === "custom") {
    return { path, limit: "text", message: "The header subtitle is one line: no line breaks" };
  }
  const bounds = typeof field === "string" ? HEADER_TEXT_BOUNDS[field] : undefined;
  if (bounds && typeof value === "string") {
    return { path, limit: "text", message: `Header ${name} is ${bounds[0]}-${bounds[1]} characters (Unicode code points); this one has ${cardCodePoints(value)}` };
  }
  if (field === "tone") {
    return { path, limit: "prop", message: `A header tag's tone is ${MESSAGE_CARD_HEADER_TAG_TONES.join(", ")}` };
  }
  return { path, limit: "prop", message: `Header: ${issue.message}` };
}

/** A Markdown element's first node outside the subset (RFC 082 §4.8), or null. */
function markdownProblem(id: string, content: string): MessageCardProblem | null {
  const found = checkMessageCardMarkdown(content);
  if (!found) return null;
  return {
    path: `card.elements.${id}.props.content`,
    limit: "markdown",
    node: found.found,
    message: `Markdown has ${found.description} at line ${found.line}, column ${found.column}, which card Markdown doesn't allow; ${MESSAGE_CARD_MARKDOWN_ALLOWED_SUMMARY}`,
  };
}

/**
 * Reads a card a sender sent: the card (with defaults filled in), or the first
 * rule it breaks, with its path, for the 400 `card_invalid`. Checked in this
 * order: the shape, the size (the sender's JSON), the header, the number of
 * elements, each element (a Markdown element's subset with it), the tree from
 * `root` (depth included), the buttons.
 */
export function parseMessageCard(raw: unknown): MessageCardParseResult {
  if (!isPlainObject(raw)) return refused("card", "shape", "A card is a JSON object: { version: 1, root, elements }");
  const bytes = utf8Bytes(JSON.stringify(raw));
  if (bytes > MESSAGE_CARD_LIMITS.maxBytes) {
    return refused("card", "size", `The card is ${bytes} bytes of JSON; at most ${MESSAGE_CARD_LIMITS.maxBytes} (8 KiB)`);
  }
  for (const key of Object.keys(raw)) {
    if (key !== "version" && key !== "header" && key !== "root" && key !== "elements") {
      return refused(`card.${key}`, "shape", "A card has only version, header, root and elements");
    }
  }
  if (raw.version !== MESSAGE_CARD_VERSION) return refused("card.version", "shape", "version must be 1");
  if (raw.header !== undefined) {
    const problem = headerProblem(raw.header);
    if (problem) return { ok: false, problem };
  }
  if (!isPlainObject(raw.elements)) return refused("card.elements", "shape", "elements is an object: element id -> element");
  const elements = raw.elements;
  const ids = Object.keys(elements);
  if (ids.length > MESSAGE_CARD_LIMITS.maxElements) {
    return refused("card.elements", "elements", `The card has ${ids.length} elements; at most ${MESSAGE_CARD_LIMITS.maxElements}`);
  }
  for (const id of ids) {
    if (!CARD_ELEMENT_ID.test(id) || CARD_RESERVED_IDS.includes(id)) {
      return refused(`card.elements.${id}`, "element_id", "An element id is 1-64 letters, digits, _ or -, starts with a letter, and is not constructor, prototype or __proto__");
    }
  }
  for (const id of ids) {
    const element = elements[id];
    const type = isPlainObject(element) ? element.type : undefined;
    if (typeof type !== "string" || !Object.hasOwn(ELEMENT_SCHEMAS, type)) {
      return refused(`card.elements.${id}.type`, "element_type", `Unknown element type${typeof type === "string" ? ` "${type}"` : ""}; a card has ${MESSAGE_CARD_ELEMENT_TYPES.join(", ")}`);
    }
    const parsed = ELEMENT_SCHEMAS[type as MessageCardElementType].safeParse(element);
    if (!parsed.success) return { ok: false, problem: elementProblem(id, type as MessageCardElementType, element as Record<string, unknown>, parsed.error.issues) };
    if (parsed.data.type === "Markdown") {
      const problem = markdownProblem(id, parsed.data.props.content);
      if (problem) return { ok: false, problem };
    }
  }
  if (typeof raw.root !== "string" || !Object.hasOwn(elements, raw.root)) {
    return refused("card.root", "tree", "root must name one of the card's elements");
  }
  // One tree from the root, in tree order: each element reached once, none deeper than maxDepth.
  const visited = new Set<string>();
  const order: string[] = [];
  const walk = (id: string, path: string, depth: number): MessageCardParseResult | null => {
    if (!Object.hasOwn(elements, id)) return refused(path, "tree", `No element "${id}" in the card`);
    if (visited.has(id)) return refused(path, "tree", `Element "${id}" is reached twice; each element has one parent`);
    if (depth > MESSAGE_CARD_LIMITS.maxDepth) {
      return refused(`card.elements.${id}`, "depth", `Element "${id}" is at depth ${depth}; at most ${MESSAGE_CARD_LIMITS.maxDepth} (the root is depth 0)`);
    }
    visited.add(id);
    order.push(id);
    const node = elements[id] as { type: string; children?: string[] };
    if (node.type !== "Stack") return null;
    for (const [index, child] of (node.children ?? []).entries()) {
      const problem = walk(child, `card.elements.${id}.children[${index}]`, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  const treeProblem = walk(raw.root, "card.root", 0);
  if (treeProblem) return treeProblem;
  const unreachable = ids.find((id) => !visited.has(id));
  if (unreachable) return refused(`card.elements.${unreachable}`, "tree", `Element "${unreachable}" is not reachable from the root`);
  const buttons = order.filter((id) => (elements[id] as { type: string }).type === "Button");
  if (buttons.length > MESSAGE_CARD_LIMITS.maxButtons) {
    return refused(`card.elements.${buttons[MESSAGE_CARD_LIMITS.maxButtons]}`, "buttons", `The card has ${buttons.length} buttons; at most ${MESSAGE_CARD_LIMITS.maxButtons}`);
  }
  // The whole card once more, as stored (defaults in): a backstop for any rule above.
  const card = messageCardSchema.safeParse(raw);
  if (!card.success) return refused("card", "shape", card.error.issues[0]?.message ?? "Invalid card");
  return { ok: true, card: card.data };
}

/** The 400 text: the path, the rule, and the next step. */
export function formatMessageCardProblem(problem: MessageCardProblem): string {
  return `Card invalid at ${problem.path} (${problem.limit}): ${problem.message}; ${MESSAGE_CARD_FIX_NEXT_STEP}.`;
}

/**
 * RFC 082 §4.1: a card sent without `content` (absent or empty) needs
 * something to derive its fallback from. The problem a send or an update is
 * refused with (`fallback`), or null. Clients check it before any request.
 */
export function messageCardFallbackProblem(card: MessageCard, content: string | undefined): MessageCardProblem | null {
  if (typeof content === "string" && content.length > 0) return null;
  if (messageCardHasFallbackText(card)) return null;
  return {
    path: "card",
    limit: "fallback",
    message: "No content was sent and the card has no header, Text, Badge, RelativeTime, Duration, Markdown or Fields to derive it from; add content or one of them",
  };
}

/** The content a send or an update stores: the sender's when it wrote one, else the fallback derived from the card. */
export function messageCardStoredContent(card: MessageCard, content: string | undefined): string {
  return typeof content === "string" && content.length > 0 ? content : deriveMessageCardFallback(card);
}

/** A card (or any JSON value) as canonical JSON: object keys sorted, so equal values give equal bytes. */
export function canonicalMessageCardJson(value: unknown): string {
  return canonicalCardJson(JSON.parse(JSON.stringify(value ?? null)));
}

function canonicalCardJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalCardJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalCardJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** A card as stored (defaults filled in), as canonical JSON; null when it is not a card. */
function storedCardJson(card: unknown): string | null {
  const parsed = messageCardSchema.safeParse(card);
  return parsed.success ? canonicalCardJson(JSON.parse(JSON.stringify(parsed.data))) : null;
}

/**
 * Whether two cards are the same card: each as stored (defaults filled in),
 * compared by value whatever their key order. A card as the sender wrote it
 * equals the stored copy of it. Anything that is not a card equals nothing.
 * The CLI's retry rule (RFC 082 §4.2) reads the current card with it.
 */
export function messageCardsEqual(a: unknown, b: unknown): boolean {
  const left = storedCardJson(a);
  return left !== null && left === storedCardJson(b);
}

// ---------------------------------------------------------------------------
// The card as markdown (RFC 082 §4.1, §4.3; artin and Tenny, 2026-11-05).
//
// What agents read of a card message is generated by Raft from the card
// itself, so an agent reads what people see; the fallback Raft stores when
// the sender wrote no `content` is the same rendering, cut shorter. Basic
// markdown: the header first (v2.0), then the elements from `root` in tree
// order, a column's children as blocks (a blank line between), a row's
// children on one line joined with " · ". Text on a card is plain text by
// contract (§6.1), so every text is escaped: it makes no formatting, link,
// heading, list or table, and an `@handle` in it is set as inline code, which
// none of the readers (the Server's mention parser, the web's mention chips)
// take for a mention. A Markdown element is the one exception: its content as
// it stands (it passed the subset check), its `@handle`s set as inline code
// too.
//
// One case per element type (cardElementRuns); the switch is exhaustive, so
// a new element type does not compile until it has its case.

/**
 * One block's tokens. A `block` run (Markdown, Fields, Divider) stays a
 * block of its own in a row too: the row's line ends before it and starts
 * again after it.
 */
interface CardMarkdownRun {
  tokens: CardMarkdownToken[];
  block?: true;
}

const CARD_MARKDOWN_ROW_SEPARATOR = " · ";
const CARD_MARKDOWN_BLOCK_SEPARATOR = "\n\n";
/** Before a Text with `tone: "warning"` (the web draws it in the warning colour). */
export const MESSAGE_CARD_MARKDOWN_WARNING_PREFIX = "⚠️ ";
const CARD_ONE_LINE_FOLD = /(?:\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]|\s)+/g;
// Where the Server's mention parser sees no mention (raftRefs.ts): inside a bare URL.
const CARD_BARE_URL = /https?:\/\/[^\s<>]+/g;
// `@a@b`: once `@a` is code, `@b` would start the text after it, so it goes into the same span.
const CARD_MENTION_CHAIN = new RegExp(`^(?:@${RAFT_REF_USER_NAME_PATTERN})+`, "u");
const CARD_WORD_CHAR = /^[\p{L}\p{N}]$/u;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const ENTITY_LIKE = /^&#?[A-Za-z0-9]+;/;

function foldCardText(text: string): string {
  return text.replace(CARD_ONE_LINE_FOLD, " ").trim();
}

function codePointBefore(text: string, index: number): string {
  return Array.from(text.slice(Math.max(0, index - 2), index)).pop() ?? "";
}

function codePointAfter(text: string, index: number): string {
  const point = text.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}

/** Whether a character of plain text must be escaped to stay plain text wherever it is on a line. */
function cardCharNeedsEscape(text: string, index: number, char: string, table: boolean): boolean {
  switch (char) {
    // Code, emphasis, links (and a Badge's own brackets), strikethrough, math, HTML and autolinks.
    case "`": case "*": case "[": case "]": case "~": case "$": case "<": return true;
    // A table needs two lines of one text.
    case "|": return table;
    // `snake_case` stays as written: an underscore between two letters or digits never makes emphasis.
    case "_": return !(CARD_WORD_CHAR.test(codePointBefore(text, index)) && CARD_WORD_CHAR.test(codePointAfter(text, index + 1)));
    // `C:\Users` stays; a backslash that would escape what follows (or end a line) is escaped itself.
    case "\\": return index + 1 >= text.length || ASCII_PUNCTUATION.test(text[index + 1]!);
    case "&": return ENTITY_LIKE.test(text.slice(index));
    default: return false;
  }
}

/** Where a line's first characters would make a heading, quote, list or rule: the index to escape, or -1. */
function cardLineStartMarkupIndex(line: string): number {
  const ordered = /^\d{1,9}(?=[.)](?:\s|$))/.exec(line);
  if (ordered) return ordered[0].length;
  return /^(?:#{1,6}(?:\s|$)|>|[-+](?:\s|$)|-[-\s]*$|=+\s*$)/.test(line) ? 0 : -1;
}

/**
 * One line of plain text as markdown that says exactly that text: a token a
 * character (with its escape), and each `@handle` that could be read as a
 * mention as one inline code token. `lineStart`: the text may start a line.
 * `table`: the text spans lines. `mentions: false` in a link's label, where
 * nothing is a mention.
 */
function cardTextTokens(text: string, options: { lineStart?: boolean; table?: boolean; mentions?: boolean } = {}): CardMarkdownToken[] {
  const mentionEnds = new Map<number, number>();
  if (options.mentions !== false) {
    const urls = Array.from(text.matchAll(CARD_BARE_URL), (match) => [match.index, match.index + match[0].length] as const);
    let covered = 0;
    for (const match of text.matchAll(createRaftUserRefRegex())) {
      const start = match.index + match[1]!.length;
      if (start < covered || urls.some(([from, to]) => start >= from && start < to)) continue;
      covered = start + CARD_MENTION_CHAIN.exec(text.slice(start))![0].length;
      mentionEnds.set(start, covered);
    }
  }
  const lead = options.lineStart ? cardLineStartMarkupIndex(text) : -1;
  const tokens: CardMarkdownToken[] = [];
  for (let index = 0; index < text.length;) {
    const mentionEnd = mentionEnds.get(index);
    if (mentionEnd !== undefined) {
      tokens.push({ text: `\`${text.slice(index, mentionEnd)}\`` });
      index = mentionEnd;
      continue;
    }
    const char = codePointAfter(text, index);
    tokens.push({ text: index === lead || cardCharNeedsEscape(text, index, char, options.table === true) ? `\\${char}` : char });
    index += char.length;
  }
  return tokens;
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
}

/** One line as an inline code span: its fence one backtick longer than any run in it. */
function cardCodeSpanTokens(line: string): CardMarkdownToken[] {
  const fence = "`".repeat(longestBacktickRun(line) + 1);
  const pad = line.startsWith("`") || line.endsWith("`") ? " " : "";
  return [{ text: `${fence}${pad}`, opens: `${pad}${fence}` }, ...Array.from(line, (char) => ({ text: char })), { text: `${pad}${fence}`, closes: true }];
}

/** Lines as a fenced code block. */
function cardCodeBlockTokens(lines: readonly string[]): CardMarkdownToken[] {
  const body = lines.join("\n");
  const fence = "`".repeat(Math.max(3, longestBacktickRun(body) + 1));
  return [{ text: `${fence}\n`, opens: `\n${fence}` }, ...Array.from(body, (char) => ({ text: char })), { text: `\n${fence}`, closes: true }];
}

/** A text's lines, without blank lines around them and with one blank line at most between them; prose lines trimmed, code lines only at their end. */
function cardTextLines(text: string, code: boolean): string[] {
  const lines: string[] = [];
  for (const raw of text.split(CARD_LINE_BREAK)) {
    const line = code ? raw.trimEnd() : raw.trim();
    if (line || (lines.length > 0 && lines[lines.length - 1] !== "")) lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinCardRuns(runs: readonly CardMarkdownToken[][], separator: string): CardMarkdownToken[] {
  return runs.flatMap((run, index) => (index === 0 ? run : [{ text: separator }, ...run]));
}

/** A row's runs as blocks: each stretch of inline runs on one line, joined with " · "; a block run as its own block. */
function rowCardRuns(runs: readonly CardMarkdownRun[]): CardMarkdownRun[] {
  const out: CardMarkdownRun[] = [];
  let line: CardMarkdownToken[][] = [];
  const endLine = () => {
    if (line.length > 0) out.push({ tokens: joinCardRuns(line, CARD_MARKDOWN_ROW_SEPARATOR) });
    line = [];
  };
  for (const run of runs) {
    if (run.block) {
      endLine();
      out.push(run);
    } else {
      line.push(run.tokens);
    }
  }
  endLine();
  return out;
}

type MessageCardElementProps<T extends MessageCardElementType> = Extract<MessageCardElement, { type: T }>["props"];

/** A Text: a paragraph in a column (its line breaks kept), one line in a row; `mono` as code. */
function cardTextRun(props: MessageCardElementProps<"Text">, inline: boolean): CardMarkdownToken[] {
  const warning = props.tone === "warning";
  if (inline) {
    const line = foldCardText(props.text);
    if (!line) return [];
    const body = props.mono ? cardCodeSpanTokens(line) : cardTextTokens(line, { lineStart: true });
    return warning ? [{ text: MESSAGE_CARD_MARKDOWN_WARNING_PREFIX }, ...body] : body;
  }
  const lines = cardTextLines(props.text, props.mono);
  if (lines.length === 0) return [];
  if (props.mono && lines.length > 1) {
    // A fence starts its own line, so a warning's sign goes on the line before it.
    return warning ? [{ text: MESSAGE_CARD_MARKDOWN_WARNING_PREFIX.trimEnd() }, { text: "\n" }, ...cardCodeBlockTokens(lines)] : cardCodeBlockTokens(lines);
  }
  const body = props.mono
    ? cardCodeSpanTokens(lines[0]!.trim())
    : lines.flatMap((line, index) => [
      ...(index > 0 ? [{ text: "\n" }] : []),
      ...(line ? cardTextTokens(line, { lineStart: true, table: lines.length > 1 }) : []),
    ]);
  return warning ? [{ text: MESSAGE_CARD_MARKDOWN_WARNING_PREFIX }, ...body] : body;
}

/** A Badge, and a header tag: `[text]` (the web draws every badge neutral, and a tag's text says its state by itself, so the tone is left out). */
function cardBadgeRun(props: { text: string }): CardMarkdownToken[] {
  const text = foldCardText(props.text);
  return text ? [{ text: "[", opens: "]" }, ...cardTextTokens(text), { text: "]", closes: true }] : [];
}

/**
 * A Button: `[label](url)`. A disabled one opens nothing, so, as people see
 * it, it is its label and the sender's reason, never where it would go: `label
 * (disabled: reason)`. A URL Raft can't open is no button (the web draws
 * none).
 */
function cardButtonRun(props: MessageCardElementProps<"Button">): CardMarkdownToken[] {
  const label = foldCardText(props.label);
  if (props.disabledReason !== undefined) {
    const reason = foldCardText(props.disabledReason);
    return [...cardTextTokens(label, { lineStart: true }), { text: reason ? " (disabled: " : " (disabled" }, ...cardTextTokens(reason), { text: ")" }];
  }
  const url = publicPreviewUrl(props.action.url);
  if (!url || !label) return [];
  const text = cardTextTokens(label, { mentions: false }).map((token) => token.text).join("");
  // The parsed URL's own spelling (spaces and angle brackets already percent-encoded); parentheses escaped for the destination.
  return [{ text: `[${text}](${url.href.replace(/[\\()]/g, "\\$&")})` }];
}

/**
 * The header (RFC 082 §4.8): its title in bold, the subtitle on the next
 * line, the tags as `[text]` on one line. Every text escaped as plain text.
 */
function cardHeaderTokens(header: MessageCardHeader | undefined): CardMarkdownToken[] {
  if (!header) return [];
  const lines: CardMarkdownToken[][] = [];
  const title = foldCardText(header.title);
  if (title) lines.push([{ text: "**", opens: "**" }, ...cardTextTokens(title), { text: "**", closes: true }]);
  const subtitle = header.subtitle === undefined ? "" : foldCardText(header.subtitle);
  if (subtitle) lines.push(cardTextTokens(subtitle, { lineStart: true }));
  const tags = (header.tags ?? []).map((tag) => cardBadgeRun(tag)).filter((run) => run.length > 0);
  if (tags.length > 0) lines.push(joinCardRuns(tags, " "));
  return joinCardRuns(lines, "\n");
}

/**
 * A Markdown element: its content as it stands (it passed the subset check),
 * each `@handle` outside code and links as inline code
 * (messageCardMarkdownAgentSource). Should that still leave a mention (it
 * must not), the content is set as plain text instead: a card never mentions
 * anyone.
 */
function cardMarkdownElementTokens(props: MessageCardElementProps<"Markdown">): CardMarkdownToken[] {
  const source = messageCardMarkdownAgentSource(props.content);
  if (!source) return [];
  if (extractRaftMentionHandles(source).length === 0) return messageCardMarkdownTokens(source);
  const lines = cardTextLines(props.content, false);
  return lines.flatMap((line, index) => [
    ...(index > 0 ? [{ text: "\n" }] : []),
    ...(line ? cardTextTokens(line, { lineStart: true, table: lines.length > 1 }) : []),
  ]);
}

/** Fields: a line per row, `**label:** value` (a `mono` value as inline code); labels and values escaped as plain text. */
function cardFieldsTokens(props: MessageCardElementProps<"Fields">): CardMarkdownToken[] {
  const lines = props.items.flatMap((item) => {
    const label = foldCardText(item.label);
    const value = foldCardText(item.value);
    if (!label && !value) return [];
    const valueTokens = !value ? [] : [{ text: " " }, ...(item.mono ? cardCodeSpanTokens(value) : cardTextTokens(value))];
    return [[{ text: "**", opens: ":**" }, ...cardTextTokens(label), { text: ":**", closes: true as const }, ...valueTokens]];
  });
  return joinCardRuns(lines, "\n");
}

/** A Divider: a rule, `---`, a block of its own. */
const CARD_MARKDOWN_DIVIDER = "---";

interface CardMarkdownOptions {
  /** Buttons as links; left out to see whether the card says anything else. */
  buttons: boolean;
  /** Dividers as `---`; left out to see whether the card says anything else (a rule says nothing). */
  dividers: boolean;
}

/**
 * An element's runs: each a block in a column. A row is one run, its
 * children joined with " · "; a Stack inside a row (or a column inside it)
 * adds its children to that row's line. A Markdown, Fields or Divider
 * element is always a block: in a row, the line ends before it.
 */
function cardElementRuns(card: MessageCard, id: string, depth: number, inline: boolean, options: CardMarkdownOptions): CardMarkdownRun[] {
  const node = Object.hasOwn(card.elements, id) ? card.elements[id] : undefined;
  if (!node || depth > MESSAGE_CARD_LIMITS.maxDepth) return [];
  let tokens: CardMarkdownToken[];
  let block = false;
  switch (node.type) {
    case "Stack": {
      const row = node.props.direction === "row";
      const runs = (node.children ?? []).flatMap((child) => cardElementRuns(card, child, depth + 1, inline || row, options));
      return row && !inline ? rowCardRuns(runs) : runs;
    }
    case "Text": tokens = cardTextRun(node.props, inline); break;
    case "Badge": tokens = cardBadgeRun(node.props); break;
    case "RelativeTime": tokens = [{ text: formatUtcTimestamp(node.props.at) }]; break;
    case "Duration": tokens = [{ text: `${formatUtcTimestamp(node.props.start)} –${node.props.end ? ` ${formatUtcTimestamp(node.props.end)}` : ""}` }]; break;
    case "Button": tokens = options.buttons ? cardButtonRun(node.props) : []; break;
    case "Markdown": tokens = cardMarkdownElementTokens(node.props); block = true; break;
    case "Fields": tokens = cardFieldsTokens(node.props); block = true; break;
    case "Divider": tokens = options.dividers ? [{ text: CARD_MARKDOWN_DIVIDER }] : []; block = true; break;
    default: {
      const unhandled: never = node;
      void unhandled;
      return [];
    }
  }
  if (tokens.length === 0) return [];
  return [block ? { tokens, block: true } : { tokens }];
}

/**
 * The tokens as one string, at most `maxCodePoints` code points: cut between
 * tokens with "…", every span still open ended (innermost first).
 */
function cutCardMarkdown(tokens: readonly CardMarkdownToken[], maxCodePoints: number): string {
  const full = tokens.map((token) => token.text).join("");
  if (cardCodePoints(full) <= maxCodePoints) return full;
  let out = "";
  let used = 0;
  let open: string[] = [];
  const closers = (spans: readonly string[]) => spans.slice().reverse().join("");
  for (const token of tokens) {
    const next = token.closes ? open.slice(0, -1) : token.opens !== undefined ? [...open, token.opens] : open;
    const cost = cardCodePoints(token.text);
    if (used + cost + 1 + cardCodePoints(closers(next)) > maxCodePoints) break;
    out += token.text;
    used += cost;
    open = next;
  }
  return `${open.length > 0 ? out : out.trimEnd()}…${closers(open)}`;
}

function cardMarkdown(card: MessageCard, maxCodePoints: number, options: CardMarkdownOptions): string {
  const header = cardHeaderTokens(card.header);
  const blocks = [
    ...(header.length > 0 ? [header] : []),
    ...cardElementRuns(card, card.root, 0, false, options).map((run) => run.tokens),
  ];
  return cutCardMarkdown(joinCardRuns(blocks, CARD_MARKDOWN_BLOCK_SEPARATOR), maxCodePoints);
}

/**
 * The card as markdown (RFC 082 §4.3): what agents read of a card message,
 * generated from the card itself. Pure and deterministic, so any stored card
 * (one sent before this rendering too) reads the same. The header first
 * (v2.0): its title in bold, the subtitle on the next line, the tags as
 * `[text]` on one line. Then in tree order from `root`:
 * - Stack: a column's children as blocks, a blank line between; a row's on
 *   one line, joined with " · " (a Markdown, Fields or Divider in it is a
 *   block of its own);
 * - Text: a paragraph (a row folds it to one line); `mono` as code (inline,
 *   or a fenced block when it spans lines in a column); `tone: "warning"`
 *   after "⚠️ ";
 * - Badge: `[text]`;
 * - RelativeTime: its UTC time (`2026-11-03 12:03:00Z`); Duration: `start –
 *   end`, or `start –` while it runs;
 * - Button: `[label](url)`; a disabled one `label (disabled: reason)`;
 * - Markdown (v2.0): its content as it stands;
 * - Fields (v2.0): a line per row, `**label:** value` (`mono` as inline code);
 * - Divider (v2.0): `---`.
 * Every text but a Markdown element's is escaped as plain text, and an
 * `@handle` anywhere is inline code: it never mentions anyone. At most
 * `maxCodePoints` code points (default
 * MESSAGE_CARD_LIMITS.agentTextMaxCodePoints), cut with "…" (a cut inside
 * bold, a link, a code block or a badge still ends it). Empty when the card
 * shows no text.
 */
export function renderMessageCardMarkdown(card: MessageCard, options: { maxCodePoints?: number } = {}): string {
  return cardMarkdown(card, options.maxCodePoints ?? MESSAGE_CARD_LIMITS.agentTextMaxCodePoints, { buttons: true, dividers: true });
}

/**
 * The fallback Raft stores as the message's content when the sender wrote none
 * (RFC 082 §4.1): the card as markdown (renderMessageCardMarkdown), at most
 * 500 code points (cut with "…"). Pure. Empty when the card shows no text.
 * It never mentions anyone: an `@handle` in it is inline code, and the send
 * resolves no mention from a derived fallback anyway.
 */
export function deriveMessageCardFallback(card: MessageCard): string {
  return renderMessageCardMarkdown(card, { maxCodePoints: MESSAGE_CARD_LIMITS.fallbackMaxCodePoints });
}

/**
 * Whether the card has words to derive a fallback from: a header, Text,
 * Badge, RelativeTime, Duration, Markdown or Fields that shows something. Its
 * buttons and dividers alone are not enough (RFC 082 §4.1): a fallback of
 * nothing but links and rules says nothing.
 */
function messageCardHasFallbackText(card: MessageCard): boolean {
  return cardMarkdown(card, MESSAGE_CARD_LIMITS.fallbackMaxCodePoints, { buttons: false, dividers: false }) !== "";
}

/**
 * What an agent reads about a card message (RFC 082 §4.3): its revision,
 * when it last changed, and what the card says. Agents read the message's
 * content as the body, and the header says `card=r<revision>` (and
 * `updated=` once revised), so an agent knows the message may change; the
 * card's own text follows the body. Wire field `message_card` on
 * agent-facing messages.
 */
export interface AgentMessageCardMarker {
  revision: number;
  /** ISO UTC; when the card was posted or last replaced. */
  updated_at: string;
  /**
   * The card as markdown (renderMessageCardMarkdown), generated by Raft from
   * the stored card when the message is served, so an agent reads what people
   * see. Absent from a Server older than it, and when the card shows no text.
   */
  text?: string;
}

/** The agent-facing marker of a message's `action_metadata`; null when it is not a message card. */
export function agentMessageCardMarker(actionMetadata: unknown): AgentMessageCardMarker | null {
  if (!isMessageCardMetadata(actionMetadata)) return null;
  const marker: AgentMessageCardMarker = { revision: actionMetadata.revision, updated_at: actionMetadata.updatedAt };
  // Read through the stored-card schema, as the web reads it: a card this Server can't read gets no text, never a guess.
  const card = messageCardSchema.safeParse(actionMetadata.card);
  const text = card.success ? renderMessageCardMarkdown(card.data) : "";
  return text ? { ...marker, text } : marker;
}
