import { z } from "zod";
import { lazySchema } from "./lazySchema";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { cjkFriendlyExtension } from "micromark-extension-cjk-friendly";
import { gfmFromMarkdown } from "mdast-util-gfm";
import {
  CARD_BADGE_TONES, cardBadgeTone, cardDurationElement, cardElementId, cardRelativeTimeElement, cardStackElement, cardText, checkBoundedTree, publicPreviewUrl,
  type CardBadgeTone,
} from "./cardElements";
import { parseArtifactRef } from "./artifactRef";

export { isStrictRfc3339Utc, publicPreviewUrl } from "./cardElements";

export type AppLinkPreviewRevision = string & { readonly __appLinkPreviewRevision: unique symbol };

/** Versioned, read-only json-render catalog. No expressions, actions or remote code. */
export const previewTextProps = lazySchema("previewTextProps", () => z.object({ text: z.string().min(1).max(500), tone: z.enum(["default", "muted"]).default("default") }).strict());
export const previewBadgeProps = lazySchema("previewBadgeProps", () => z.object({ text: z.string().min(1).max(60) }).strict());
export const previewStackProps = lazySchema("previewStackProps", () => z.object({}).strict());
const key = lazySchema("key", () => z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/));
const children = lazySchema("children", () => z.array(key).max(12).optional());
const element = lazySchema("element", () => z.discriminatedUnion("type", [
  z.object({ type: z.literal("Stack"), props: previewStackProps, children }).strict(),
  z.object({ type: z.literal("Text"), props: previewTextProps }).strict(),
  z.object({ type: z.literal("Badge"), props: previewBadgeProps }).strict(),
]));
export const appPreviewCardSchema = lazySchema("appPreviewCardSchema", () => z.object({ root: key, elements: z.record(key, element) }).strict().superRefine((spec, ctx) => {
  const tree = checkBoundedTree(spec, { maxElements: 16, maxDepth: 4 });
  if (tree === "size") ctx.addIssue({ code: "custom", message: "Invalid card size or element ID" });
  else if (tree === "tree") ctx.addIssue({ code: "custom", message: "Card must be one bounded tree" });
}));
export const appLinkPreviewResponseSchema = lazySchema("appLinkPreviewResponseSchema", () => z.object({
  version: z.literal(1), title: z.string().min(1).max(160), card: appPreviewCardSchema.optional(),
}).strict());
export type AppLinkPreviewContent = z.infer<typeof appLinkPreviewResponseSchema>;
export type AppLinkPreview = AppLinkPreviewContent & { url: string; appName: string };
/**
 * Asks the viewer whether an App may render its links for them (they have
 * neither consented to it nor declined it on this Server). `icon` is the
 * App's logo URL, as in the App listings, or null.
 */
export type AppLinkPreviewPrompt = { url: string; app: { id: string; name: string; icon: string | null } };
/**
 * What a client reads from `GET /api/messages/:id/app-link-previews`. Not
 * strict at the top level, on purpose: a field the server adds (`prompts`,
 * `appIcons`) is dropped by clients that do not know it, instead of hiding
 * every preview. Each preview is strict, so new per-link data goes at the top.
 *
 * `appIcons`: preview `url` -> the icon Raft stores for the App that rendered
 * it, or null. Older servers leave it out. Up to 10 previews: the per-message
 * link limit (protocol v3.2.3 addendum 2 §5), though v1 reads at most three.
 */
export const appLinkPreviewListResponseSchema = lazySchema("appLinkPreviewListResponseSchema", () => z.object({ previews: z.array(appLinkPreviewResponseSchema.extend({
  url: z.string().refine((value) => !!publicPreviewUrl(value)), appName: z.string().max(300),
})).max(10), appIcons: z.record(z.string(), z.string().max(2000).nullable()).optional() }));

// ---------------------------------------------------------------------------
// Version 2: interactive link cards (RFC 076; protocol v3.2.3 §4.3, §4.4).
// Still a closed, inert catalog: no expressions, no remote code, no inputs.
// Buttons only name an action; Raft decides which ones a viewer gets
// (stripLinkCardActions) and signs a handle per enabled execute action. Card
// text lengths count Unicode code points, so Go and TypeScript agree. Stack,
// RelativeTime, Duration, the badge tones and the tree check come from
// cardElements.ts, which action cards share.

/**
 * Capabilities a client may declare; Raft forwards only these (protocol §11.2)
 * and ignores any other value. They decide what a viewer may press, not what
 * they may see (addendum 1 §2): `card.v2` shows every display element,
 * RelativeTime and Duration included, so `relative_time.v1` is gone. `inline.v1`
 * keeps a card answer's `inline` label (addendum 2 §3), `block.v1` its
 * `placement` (addendum 6; RFC 076 §13). `preview.v3` gets the answer as
 * version 3 items, whichever version the App sent (addendum 7; RFC 076 §14).
 * `badge.color.v1` keeps a card Badge's `color` (RFC 076 §15).
 * `unreviewed_app.v1` (RFC 076 §17): the client shows Raft's confirmation, naming
 * the App as not reviewed by Raft, before every acting button of an App whose
 * read item says `app.reviewed: false`, undo-window buttons included. Only such
 * a client gets those buttons (and that field); others see them as navigate.
 */
export const LINK_CARD_CAPABILITIES = ["card.v2", "button.v1", "confirm.v1", "undo.v1", "inline.v1", "inline.tone.v2", "block.v1", "preview.v3", "badge.color.v1", "unreviewed_app.v1"] as const;
export type LinkCardCapability = typeof LINK_CARD_CAPABILITIES[number];
export const UNREVIEWED_APP_CAPABILITY = "unreviewed_app.v1" satisfies LinkCardCapability;
export const LINK_CARD_ACTION_ID = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_BUTTONS = 4;

export const linkCardButtonActionSchema = lazySchema("linkCardButtonActionSchema", () => z.union([
  z.object({ kind: z.literal("navigate"), url: z.string().max(2000).refine((s) => !!publicPreviewUrl(s), "Expected a public HTTPS URL") }).strict(),
  // A preview refresh: no action id, no handle, only the read-only credential.
  z.object({ kind: z.literal("read") }).strict(),
  // Exactly one of confirm / undoWindowMs.
  z.object({ kind: z.literal("execute"), action_id: z.string().regex(LINK_CARD_ACTION_ID), confirm: z.literal("prepare") }).strict(),
  z.object({ kind: z.literal("execute"), action_id: z.string().regex(LINK_CARD_ACTION_ID), undoWindowMs: z.number().int().min(1000).max(10000) }).strict(),
]));
export type LinkCardButtonAction = z.infer<typeof linkCardButtonActionSchema>;

/**
 * A link card Badge's colour (RFC 076 §15): `#RRGGBB`, either case, no alpha;
 * read as lowercase. Only a link card's `Badge` element takes one: not the
 * inline badge (the chip draws none; it may get one later under a capability
 * of its own), a card message's or an action card's. Purely cosmetic: `tone`
 * is still the meaning, and what a client without `badge.color.v1` (or one
 * that can't draw the colour) shows. Raft never refuses an answer for it: an
 * invalid colour is dropped before the schema reads the answer
 * (dropInvalidLinkCardBadgeColors), and every colour is dropped for a client
 * that didn't declare `badge.color.v1` (linkCardBadgeColorsForCapabilities).
 * The schema itself is strict, so a client only ever reads a valid colour.
 */
export const LINK_CARD_BADGE_COLOR = /^#[0-9a-f]{6}$/i;
export const linkCardBadgeColor = lazySchema("linkCardBadgeColor", () => z.string().regex(LINK_CARD_BADGE_COLOR).transform((value) => value.toLowerCase()));

const v2Element = lazySchema("v2Element", () => z.discriminatedUnion("type", [
  cardStackElement,
  // `mono` is for branch names, SHAs and similar; the client picks the face.
  z.object({ type: z.literal("Text"), props: z.object({
    text: cardText(1, 500),
    tone: z.enum(["default", "muted", "warning"]).default("default"),
    mono: z.boolean().default(false),
  }).strict() }).strict(),
  z.object({ type: z.literal("Badge"), props: z.object({
    text: cardText(1, 60),
    tone: cardBadgeTone.default("neutral"),
    color: linkCardBadgeColor.optional(),
  }).strict() }).strict(),
  cardRelativeTimeElement,
  cardDurationElement,
  z.object({ type: z.literal("Button"), props: z.object({
    label: cardText(1, 40),
    variant: z.enum(["default", "ghost"]).default("default"),
    action: linkCardButtonActionSchema,
    disabledReason: cardText(1, 200).optional(),
  }).strict() }).strict(),
]));
export type LinkCardElement = z.infer<typeof v2Element>;

export const linkCardV2Schema = lazySchema("linkCardV2Schema", () => z.object({ root: cardElementId, elements: z.record(cardElementId, v2Element) }).strict().superRefine((spec, ctx) => {
  const tree = checkBoundedTree(spec, { maxElements: 16, maxDepth: 4 });
  if (tree === "size") { ctx.addIssue({ code: "custom", message: "Invalid card size or element ID" }); return; }
  if (tree === "tree") { ctx.addIssue({ code: "custom", message: "Card must be one bounded tree" }); return; }
  const buttons = Object.values(spec.elements).filter((node) => node.type === "Button");
  if (buttons.length > MAX_BUTTONS) ctx.addIssue({ code: "custom", message: `At most ${MAX_BUTTONS} buttons` });
  const actionIds = buttons.flatMap((node) => node.type === "Button" && node.props.action.kind === "execute" ? [node.props.action.action_id] : []);
  if (new Set(actionIds).size !== actionIds.length) ctx.addIssue({ code: "custom", message: "Execute action ids must be unique in a card" });
}));
export type LinkCardV2 = z.infer<typeof linkCardV2Schema>;

const revision = lazySchema("revision", () => z.string().min(1).max(512));
/**
 * The inline badge's tones: the card's badge tones (the same words a status
 * Badge uses in the hover card), plus the four words the first inline badge
 * used. A tone is the App's meaning, not a colour: the web draws every card
 * Badge neutral and no inline badge at all (raft-design #939). A client that
 * declares `inline.tone.v2` accepts all of them and reads `success` and
 * `danger` as `done` and `closed` (inlineBadgeDisplayTone). A client that
 * doesn't (an open tab of an older web) checks the tone strictly against the
 * first four, so Raft downgrades it before the answer reaches that client
 * (linkCardInlineForCapabilities), and an App sends the new words only when
 * the request's `client_capabilities` has `inline.tone.v2`.
 */
export const LINK_CARD_INLINE_BADGE_TONES = [...CARD_BADGE_TONES, "success", "danger"] as const;
export type LinkCardInlineBadgeTone = typeof LINK_CARD_INLINE_BADGE_TONES[number];
/** The four tones a client without `inline.tone.v2` accepts. */
export const LINK_CARD_LEGACY_INLINE_BADGE_TONES = ["neutral", "success", "warning", "danger"] as const;
export type LinkCardLegacyInlineBadgeTone = typeof LINK_CARD_LEGACY_INLINE_BADGE_TONES[number];
/** The card badge tone an inline badge's tone means (`success` is `done`, `danger` is `closed`). */
export function inlineBadgeDisplayTone(tone: LinkCardInlineBadgeTone): CardBadgeTone {
  return tone === "success" ? "done" : tone === "danger" ? "closed" : tone;
}
/**
 * A tone for a client without `inline.tone.v2`, by meaning, so it gets the
 * word it got before the new words, whatever it draws for it (yanyongyu's
 * table, #raft-botiverse bac57d0f): finished or ready (done, action) is
 * success; needs attention is warning; closed, running and waiting for review
 * are ordinary, so neutral.
 */
export function downgradeInlineBadgeTone(tone: LinkCardInlineBadgeTone): LinkCardLegacyInlineBadgeTone {
  switch (tone) {
    case "done": case "action": case "success": return "success";
    case "warning": return "warning";
    case "danger": return "danger";
    default: return "neutral";
  }
}
/**
 * The inline label a client may receive: none without `inline.v1`; as the App
 * sent it with `inline.tone.v2`; otherwise with its badge tone downgraded.
 */
export function linkCardInlineForCapabilities(inline: LinkCardInline | undefined, capabilities: readonly string[]): LinkCardInline | undefined {
  if (!inline || !capabilities.includes("inline.v1")) return undefined;
  return linkCardInlineToneForCapabilities(inline, capabilities);
}
/**
 * An inline label (or version 3 `inline` item) as the App sent it for a client
 * with `inline.tone.v2`, otherwise with its badge tone downgraded. A
 * `preview.v3` client gets its `inline` item this way (RFC 076 §14).
 */
export function linkCardInlineToneForCapabilities<T extends LinkCardInline>(inline: T, capabilities: readonly string[]): T {
  if (capabilities.includes("inline.tone.v2") || !inline.badge) return inline;
  return { ...inline, badge: { ...inline.badge, tone: downgradeInlineBadgeTone(inline.badge.tone) } };
}
/**
 * The read-only inline label a card answer may add (addendum 2 §2): a title and
 * an optional status badge in place of the link text, for a link in the middle
 * of a sentence. No buttons, handles or colours; pressing it opens the link.
 * Only strings and objects, strict. Raft keeps it only for a client that
 * declared `inline.v1`. A card Badge's `color` (RFC 076 §15) is not the
 * inline badge's: the chip draws no badge, so a `color` here is an unknown
 * field like any other and makes the answer invalid.
 */
export const linkCardInlineSchema = lazySchema("linkCardInlineSchema", () => z.object({
  title: cardText(1, 80),
  badge: z.object({ text: cardText(1, 24), tone: z.enum(LINK_CARD_INLINE_BADGE_TONES).default("neutral") }).strict().optional(),
}).strict());
export type LinkCardInline = z.infer<typeof linkCardInlineSchema>;
/**
 * Where a card answer asks to be drawn (addendum 6; RFC 076 §13): `block`, in
 * the message in place of (or after) the link's paragraph. Absent is the
 * inline chip. It is the App's request, not a guarantee: the client may still
 * draw the chip. It changes where the card is drawn, never what it shows or
 * what a viewer may press: the same stripped card, ticket and handles.
 */
export const LINK_CARD_PLACEMENTS = ["block"] as const;
export type LinkCardPlacement = typeof LINK_CARD_PLACEMENTS[number];
/**
 * The placement a client may receive: only with `block.v1`. A client without
 * it (an open tab of an older web, a mobile App on an older shared package)
 * reads the answer strictly, so the field never reaches it and it keeps the
 * chip.
 */
export function linkCardPlacementForCapabilities(placement: LinkCardPlacement | undefined, capabilities: readonly string[]): LinkCardPlacement | undefined {
  return placement && capabilities.includes("block.v1") ? placement : undefined;
}
/**
 * A version 2 preview answer chooses how the link is shown (protocol §4.3):
 * - `link`: only the original link (the App knows the viewer may not see it);
 * - `connect_account`: Raft's fixed, localized template with one navigate
 *   button, for when the App cannot tell yet; the App supplies no text;
 * - `card`: a card, only for a viewer who may read the object, optionally with
 *   an `inline` label and a `placement`. `inline` without `card`, or on the
 *   other two, is invalid; so is `placement` on the other two, or any value
 *   but `block`.
 */
export const appLinkPreviewV2ResponseSchema = lazySchema("appLinkPreviewV2ResponseSchema", () => z.discriminatedUnion("display", [
  z.object({ version: z.literal(2), display: z.literal("link") }).strict(),
  z.object({ version: z.literal(2), display: z.literal("connect_account"), connect_url: z.string().max(2000) }).strict(),
  z.object({
    version: z.literal(2), display: z.literal("card"), title: cardText(1, 160),
    card_revision: revision, business_revision: revision, card: linkCardV2Schema, inline: linkCardInlineSchema.optional(),
    placement: z.enum(LINK_CARD_PLACEMENTS).optional(),
  }).strict(),
]));
export type AppLinkPreviewV2Response = z.infer<typeof appLinkPreviewV2ResponseSchema>;

/**
 * Validates a version 2 answer against the App's registered origin: every
 * navigate URL and the connect URL must stay on it. Anything else is null, and
 * Raft shows the plain link (F11: never a placeholder).
 */
export function parseAppLinkPreviewV2(raw: unknown, origin: string): AppLinkPreviewV2Response | null {
  const parsed = appLinkPreviewV2ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (value.display === "connect_account") return onOrigin(value.connect_url, origin) ? value : null;
  if (value.display === "card" && !navigatesOnOrigin(value.card, origin)) return null;
  return value;
}
const onOrigin = (url: string, origin: string) => publicPreviewUrl(url)?.origin === origin;
const navigatesOnOrigin = (card: LinkCardV2, origin: string) => Object.values(card.elements)
  .every((node) => node.type !== "Button" || node.props.action.kind !== "navigate" || onOrigin(node.props.action.url, origin));

// ---------------------------------------------------------------------------
// Version 3: an ordered list of items (RFC 076 §14; protocol addendum 7). A new
// way of showing a link is a new item type, not a new field or version. Raft
// forwards `preview.v3` in `client_capabilities` only when the client declared
// it, accepts a version 2 or 3 answer either way, and converts it for the
// client (services/linkCardReadService.ts).

/**
 * Where a version 3 card item is drawn: `block`, in the message after the
 * link's paragraph (RFC 076 §13's rules), or `hover`, the chip's popover.
 * Required: unlike version 2's `placement`, there is no default.
 */
const LINK_CARD_ITEM_PLACEMENTS = ["block", "hover"] as const;
/** Every item's `type`, known or not. */
const APP_LINK_PREVIEW_ITEM_TYPE = /^[a-z0-9._]{1,32}$/;
const APP_LINK_PREVIEW_MAX_ITEMS = 8;
const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set(["inline", "card", "connect_account"]);
/**
 * The item types this Raft knows, each as strict as version 2 (an unknown field
 * invalidates the answer):
 * - `inline`: the chip label, exactly version 2's `inline`;
 * - `card`: one card with its own title and revisions and a required
 *   placement; `card` is version 2's card tree, stripped and signed as today;
 * - `connect_account`: version 2's connect template, Raft's fixed text.
 */
const appLinkPreviewItemSchema = lazySchema("appLinkPreviewItemSchema", () => z.discriminatedUnion("type", [
  z.object({ type: z.literal("inline"), ...linkCardInlineSchema.shape }).strict(),
  z.object({
    type: z.literal("card"), placement: z.enum(LINK_CARD_ITEM_PLACEMENTS), title: cardText(1, 160),
    card_revision: revision, business_revision: revision, card: linkCardV2Schema,
  }).strict(),
  z.object({ type: z.literal("connect_account"), connect_url: z.string().max(2000) }).strict(),
]));
export type AppLinkPreviewItem = z.infer<typeof appLinkPreviewItemSchema>;
/**
 * A version 3 answer, `{ version: 3, items }`, at most 8 items. Every item is
 * an object with a `type` of 1-32 characters from `a-z 0-9 . _`. An item of a
 * type this Raft doesn't know is dropped, not refused, and the rest stands: an
 * App can send a new kind of item to a Raft that doesn't know it yet. (Content
 * a viewer could execute is never sent that way: it comes with a capability of
 * its own, RFC 076 §14.) Of the known items, at most one `inline` and one
 * `card`, and a `connect_account` only alone. `[]` is the plain link.
 */
export const appLinkPreviewV3ResponseSchema = lazySchema("appLinkPreviewV3ResponseSchema", () => {
  const unknownItem = z.object({ type: z.string().regex(APP_LINK_PREVIEW_ITEM_TYPE).refine((type) => !KNOWN_ITEM_TYPES.has(type)) });
  return z.object({
    version: z.literal(3),
    items: z.array(z.union([appLinkPreviewItemSchema, unknownItem])).max(APP_LINK_PREVIEW_MAX_ITEMS)
      .transform((items) => items.filter((item): item is AppLinkPreviewItem => KNOWN_ITEM_TYPES.has(item.type)))
      .superRefine((items, ctx) => {
        const count = (type: AppLinkPreviewItem["type"]) => items.filter((item) => item.type === type).length;
        if (count("inline") > 1 || count("card") > 1) ctx.addIssue({ code: "custom", message: "At most one inline and one card item" });
        if (count("connect_account") && items.length > 1) ctx.addIssue({ code: "custom", message: "A connect_account item must be the only one" });
      }),
  }).strict();
});
export type AppLinkPreviewV3Response = z.infer<typeof appLinkPreviewV3ResponseSchema>;

/**
 * Validates a version 3 answer like a version 2 one (parseAppLinkPreviewV2):
 * the schema, then every navigate URL and the connect URL on the App's
 * registered origin. Anything else is null: the plain link.
 */
export function parseAppLinkPreviewV3(raw: unknown, origin: string): AppLinkPreviewV3Response | null {
  const parsed = appLinkPreviewV3ResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const valid = parsed.data.items.every((item) => item.type === "connect_account" ? onOrigin(item.connect_url, origin)
    : item.type === "card" ? navigatesOnOrigin(item.card, origin) : true);
  return valid ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Card Badge colours (RFC 076 §15). A colour is cosmetic, so Raft never refuses
// an answer for it: it drops the colour and serves the `tone`, in two cases,
// each counted for the trace (services/linkCardReadService.ts). The inline
// badge has no colour: these leave it alone, and the schema refuses one there.

type JsonObject = Record<string, unknown>;
const isJsonObject = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value);
/** `value` with its own `key` replaced by `change(value[key])`, or `value` itself when that is unchanged. */
const withOwn = (value: JsonObject, key: string, change: (field: unknown) => unknown): JsonObject => {
  if (!Object.hasOwn(value, key)) return value;
  const changed = change(value[key]);
  return changed === value[key] ? value : { ...value, [key]: changed };
};

/**
 * An App's answer as parsed from JSON, before the schema reads it, with every
 * card `Badge` `color` that is not `#RRGGBB` removed: version 2's `card` and
 * a version 3 `card` item. A non-string colour (`null`, a number) is invalid
 * too. Done before the strict schema, which refuses an invalid colour, so the
 * colour goes and the card stays (an invalid colour is refused nowhere else).
 * Nothing else is touched (the inline badge, another element, a version 1
 * card): anything else invalid still refuses the answer. Returns the answer
 * unchanged when nothing was removed; never mutates it.
 */
export function dropInvalidLinkCardBadgeColors(raw: JsonObject): { answer: JsonObject; dropped: number } {
  let dropped = 0;
  const props = (value: unknown): unknown => {
    if (!isJsonObject(value) || !Object.hasOwn(value, "color") || (typeof value.color === "string" && LINK_CARD_BADGE_COLOR.test(value.color))) return value;
    dropped++;
    const { color: _color, ...rest } = value;
    return rest;
  };
  const card = (value: unknown): unknown => isJsonObject(value) ? withOwn(value, "elements", (elements) => {
    if (!isJsonObject(elements)) return elements;
    const before = dropped;
    const next = Object.fromEntries(Object.entries(elements).map(([id, node]): [string, unknown] =>
      [id, isJsonObject(node) && node.type === "Badge" ? withOwn(node, "props", props) : node]));
    return dropped === before ? elements : next;
  }) : value;
  let answer = raw;
  if (raw.version === 2) answer = withOwn(raw, "card", card);
  else if (raw.version === 3) {
    answer = withOwn(raw, "items", (items) => {
      if (!Array.isArray(items)) return items;
      const before = dropped;
      const next = items.map((item) => isJsonObject(item) && item.type === "card" ? withOwn(item, "card", card) : item);
      return dropped === before ? items : next;
    });
  }
  return { answer, dropped };
}

/**
 * The items as a client may receive their card Badges' colours: as the App
 * sent them with `badge.color.v1`; otherwise with no `color` at all, so the
 * client reads `tone` alone. A client without it (an open tab of an older
 * web, the mobile App) reads each item strictly and would refuse the field.
 * `stripped` counts the colours removed.
 */
export function linkCardBadgeColorsForCapabilities(items: readonly AppLinkPreviewItem[], capabilities: readonly string[]): { items: AppLinkPreviewItem[]; stripped: number } {
  if (capabilities.includes("badge.color.v1")) return { items: [...items], stripped: 0 };
  let stripped = 0;
  const card = (tree: LinkCardV2): LinkCardV2 => {
    const before = stripped;
    const elements = Object.fromEntries(Object.entries(tree.elements).map(([id, node]): [string, LinkCardElement] => {
      if (node.type !== "Badge" || node.props.color === undefined) return [id, node];
      stripped++;
      const { color: _color, ...props } = node.props;
      return [id, { ...node, props }];
    }));
    return stripped === before ? tree : { ...tree, elements };
  };
  return { items: items.map((item) => item.type === "card" ? { ...item, card: card(item.card) } : item), stripped };
}

/**
 * One link of a batched read answer (`POST /api/messages/:messageId/link-cards/read`,
 * RFC 076 §6.1), as a client reads it: `v1` (the version 1 preview), `v2` (a
 * version 2 answer that shows something, with the view's ticket and handles),
 * `v3` (the same as version 3 items, only for a client that declared
 * `preview.v3`; RFC 076 §14) or `rate_limited` (read it again after
 * `retry_after` seconds). `app` is Raft's record of the App, its icon the one
 * Raft stores. Strict, like each GET preview.
 */
export const linkCardReadItemSchema = lazySchema("linkCardReadItemSchema", () => {
  const url = z.string().refine((value) => !!publicPreviewUrl(value));
  const app = z.object({ id: z.string().min(1).max(200), name: z.string().max(300), icon: z.string().max(2000).nullable() }).strict();
  const ticket = z.string().min(1).max(4096).brand<"LinkCardReadTicket">().nullable();
  const actions = z.array(z.object({ action_id: z.string().regex(LINK_CARD_ACTION_ID), handle: z.string().min(1).max(4096).brand<"LinkCardHandle">() }).strict()).max(MAX_BUTTONS);
  return z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("v1"), url, app, preview: appLinkPreviewResponseSchema }).strict(),
    z.object({ kind: z.literal("v2"), url, app, preview: appLinkPreviewV2ResponseSchema, ticket, actions }).strict(),
    z.object({ kind: z.literal("v3"), url, app, preview: appLinkPreviewV3ResponseSchema, ticket, actions }).strict(),
    z.object({ kind: z.literal("rate_limited"), url, retry_after: z.number().int().min(0).max(3600) }).strict(),
  ]);
});
export type LinkCardReadAnswerItem = z.infer<typeof linkCardReadItemSchema>;
/** The view's read ticket for one link: opaque, sent back on the view's next read (protocol §3). */
export type LinkCardReadAnswerTicket = NonNullable<Extract<LinkCardReadAnswerItem, { kind: "v2" }>["ticket"]>;

/**
 * Reads a batched read answer. Not strict at the top level (a field the server
 * adds later is ignored), and each item is read on its own: an item this client
 * can't read, a kind added later included, leaves only that link plain. A v2 or
 * v3 item is checked against its link's origin like the server checks the
 * App's answer (`parseAppLinkPreviewV2`, `parseAppLinkPreviewV3`, which also
 * drops item types this client doesn't know); `display: "link"` and `[]` are
 * no item. `prompts` is left for the caller, which reads it as it reads the
 * GET's.
 */
export function parseLinkCardReadAnswer(data: unknown): LinkCardReadAnswerItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.slice(0, 10).flatMap((raw): LinkCardReadAnswerItem[] => {
    const item = linkCardReadItemSchema.safeParse(raw);
    if (!item.success) return [];
    if (item.data.kind === "v3") {
      const preview = parseAppLinkPreviewV3(item.data.preview, new URL(item.data.url).origin);
      return preview?.items.length ? [{ ...item.data, preview }] : [];
    }
    if (item.data.kind !== "v2") return [item.data];
    const preview = parseAppLinkPreviewV2(item.data.preview, new URL(item.data.url).origin);
    return preview && preview.display !== "link" ? [{ ...item.data, preview }] : [];
  });
}

/** The toast an App may return; errors use `warning` (protocol §4.4). */
export const linkCardToastSchema = lazySchema("linkCardToastSchema", () => z.object({
  tone: z.enum(["info", "success", "warning"]), text: cardText(1, 200),
}).strict());

/**
 * Server -> web, socket event name `link_card.operation_changed`, emitted to
 * `socketUserServerRoom(viewer, server)` whenever an operation's receipt
 * changes (RFC 076 §6.8; protocol v3.2.3 §8.3). It carries no content: the
 * client reads `POST /api/link-cards/status`, shows a toast at most once per
 * `receipt_revision`, and re-reads the card if that view is still showing. The
 * socket is not the source of truth: a missed hint is recovered by status and
 * the operation lookups.
 */
export const LINK_CARD_OPERATION_CHANGED_EVENT = "link_card.operation_changed";
export type LinkCardOperationChangedEvent = { operation_id: string; receipt_revision: number };

/**
 * The most a provider's buttons may do on this read (addendum 4 §2):
 * - `navigate`: a provider that is not an approved official App keeps only
 *   navigate buttons; even `read` goes (Tenny 90cf59b3 #5);
 * - `read`: an official App without an approved action endpoint in force, or
 *   whose registration is suspended, keeps navigate and read;
 * - `execute`: an official App with an approved endpoint and a normal
 *   registration keeps every button.
 * Display only: the action endpoints check again before any call (C2b).
 */
export type LinkCardActionTier = "navigate" | "read" | "execute";

/**
 * What a viewer may press. Buttons beyond the provider's tier go, buttons need
 * `button.v1`, and execute needs `confirm.v1` or `undo.v1` for its kind. A
 * stripped button is removed from the tree, never shown disabled; a disabled
 * one that survives stays visible and gets no handle (linkCardExecuteActions).
 * Pure: returns a new card.
 */
export function stripLinkCardActions(card: LinkCardV2, input: { tier: LinkCardActionTier; capabilities: readonly string[] }): LinkCardV2 {
  const has = (capability: LinkCardCapability) => input.capabilities.includes(capability);
  const keep = (action: LinkCardButtonAction): boolean => {
    if (!has("button.v1")) return false;
    if (action.kind === "navigate") return true;
    if (action.kind === "read") return input.tier !== "navigate";
    if (input.tier !== "execute") return false;
    return "confirm" in action ? has("confirm.v1") : has("undo.v1");
  };
  const removed = new Set(Object.entries(card.elements)
    .filter(([, node]) => node.type === "Button" && !keep(node.props.action)).map(([id]) => id));
  if (!removed.size) return card;
  const elements: LinkCardV2["elements"] = {};
  for (const [id, node] of Object.entries(card.elements)) {
    if (removed.has(id)) continue;
    elements[id] = node.type === "Stack" && node.children ? { ...node, children: node.children.filter((child) => !removed.has(child)) } : node;
  }
  return removed.has(card.root) ? { root: card.root, elements: { [card.root]: { type: "Stack", props: { direction: "column", wrap: false }, children: [] } } } : { root: card.root, elements };
}

/**
 * The actions Raft signs a handle for: enabled, named execute buttons
 * (protocol §4.1 step 7). `descriptor` is the validated Button props; Raft
 * hashes its JCS form into the handle (§3.3).
 */
export function linkCardExecuteActions(card: LinkCardV2): { actionId: string; requiresPrepare: boolean; descriptor: Extract<LinkCardElement, { type: "Button" }>["props"] }[] {
  return Object.values(card.elements).flatMap((node) => node.type === "Button" && node.props.action.kind === "execute" && !node.props.disabledReason
    ? [{ actionId: node.props.action.action_id, requiresPrepare: "confirm" in node.props.action, descriptor: node.props }]
    : []);
}

const publicCallbackUrl = (s: string) => !!publicPreviewUrl(s) && !new URL(s).search;
/** The preview request versions an App may declare it answers (`preview_versions`). */
export const APP_LINK_PREVIEW_VERSIONS = [1, 2, 3] as const;
export type AppLinkPreviewVersion = (typeof APP_LINK_PREVIEW_VERSIONS)[number];
/** What an App that declares nothing answers: version 1 only. */
export const DEFAULT_APP_LINK_PREVIEW_VERSIONS: readonly AppLinkPreviewVersion[] = [1];
export const appLinkPreviewRegistrationSchema = lazySchema("appLinkPreviewRegistrationSchema", () => z.object({
  origin: z.string().max(500).refine((s) => publicPreviewUrl(s)?.origin === s, "Expected an HTTPS origin without a trailing slash"),
  endpoint: z.string().max(2000).refine(publicCallbackUrl, "Expected a public HTTPS endpoint without query or fragment"),
  paths: z.array(z.string().regex(/^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)$/).max(300)).min(1).max(10),
  /**
   * Interactive link cards (RFC 076 §4): where Raft sends prepare / execute /
   * status. Same origin and transport rules as `endpoint`. Omitted or null =
   * no buttons. For a published App, adding or changing it waits for
   * marketplace review; removing it applies at once.
   */
  action_endpoint: z.string().max(2000).refine(publicCallbackUrl, "Expected a public HTTPS action endpoint without query or fragment").nullable().optional(),
  /**
   * The preview request versions the App answers. Omitted = `[1]`; not
   * nullable (leave it out instead). Only 1, 2 and 3, no duplicates (stored
   * sorted), and it must include 1: every App must handle version 1, because
   * Raft keeps sending it wherever the reader cannot take a newer one. The
   * mobile App uses only the version 1 GET, and so do a Server without
   * interactive_link_cards and a client without card.v2. Declaring 3 needs
   * 2: a version 3 answer rides on the version 2 request (RFC 076 §14), so an
   * App that declares 3 without 2 would never be asked for it. A version 2
   * request goes only to an App that declared 2.
   */
  preview_versions: z.array(z.literal(APP_LINK_PREVIEW_VERSIONS))
    .refine((versions) => versions.includes(1), "Every App must answer preview version 1")
    .refine((versions) => new Set(versions).size === versions.length, "Preview versions must not repeat")
    .refine((versions) => !versions.includes(3) || versions.includes(2), "Preview version 3 rides on the version 2 request, so declaring 3 needs 2")
    .optional(),
}).strict()
  .refine((v) => publicPreviewUrl(v.endpoint)?.origin === v.origin, "Callback must belong to the registered origin")
  .refine((v) => !v.action_endpoint || publicPreviewUrl(v.action_endpoint)?.origin === v.origin, "Action endpoint must belong to the registered origin"));
export type AppLinkPreviewRegistration = z.infer<typeof appLinkPreviewRegistrationSchema>;
export function matchesAppPreview(url: string, registration: AppLinkPreviewRegistration): boolean {
  const parsed = publicPreviewUrl(url);
  return !!parsed && parsed.origin === registration.origin && registration.paths.some((path) =>
    parsed.pathname === path || parsed.pathname.startsWith(path.endsWith("/") ? path : path + "/"));
}
/**
 * The links one App link read covers, at most `limit`: messagePreviewUrls'
 * links without Raft's own objects' (an Artifact's, as the shared
 * parseArtifactRef reads it on `appHosts`, Raft's own app hostnames), which
 * the web reads from core's object summaries and never from an App. They are
 * dropped before the limit, so they never take an App link's place: ten
 * Artifact links before one App link leave the App link in the read. The
 * server's reads (the GET, three; the batched read, ten), its live-state checks
 * and the web's useAppLinkPreviews all count with this, so they agree on
 * which links a read covers.
 */
export function appLinkReadUrls(content: string, appHosts: readonly string[], limit = 3): string[] {
  return messagePreviewUrls(content, Number.POSITIVE_INFINITY).filter((url) => parseArtifactRef(url, { appHosts }).kind !== "id").slice(0, limit);
}
/**
 * A link's text as written, raw HTML included: a link whose text carries
 * markup (`[<b>url</b>](url)`) is not bare, as the web doesn't make it a chip.
 */
function linkText(node: { type: string; value?: string; children?: unknown[] }): string {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map((child) => linkText(child as { type: string })).join("");
}
/** A bare link: its text is its own address (an autolink, `<url>`, `[url](url)`). */
function isBareLink(text: string, url: string): boolean {
  try { return new URL(text.trim()).href === new URL(url).href; } catch { return false; }
}
/** `raw`'s WHATWG href, or null where it isn't a URL. */
function hrefOf(raw: string): string | null {
  try { return new URL(raw).href; } catch { return null; }
}
type MessageTree = ReturnType<typeof fromMarkdown>;
type MessageNode = MessageTree | MessageTree["children"][number];
/**
 * Every visible, bare Markdown link of `content` that `accept` takes, in
 * message order, with its WHATWG href and its node (whose `position` is its
 * place in `content`).
 */
function bareLinkNodes(
  content: string,
  accept: (raw: string) => boolean,
  onNode?: (node: MessageNode, ancestors: readonly MessageNode[]) => void,
  labelled = false,
): { href: string; node: MessageNode; ancestors: readonly MessageNode[]; bare: boolean }[] {
  const tree = fromMarkdown(content.slice(0, 32000), { extensions: [gfm(), cjkFriendlyExtension(), { disable: { null: ["codeIndented"] } }], mdastExtensions: [gfmFromMarkdown()] });
  const found: { href: string; node: MessageNode; ancestors: readonly MessageNode[]; bare: boolean }[] = [];
  const definitions = new Map<string, string>();
  const scan = (node: MessageNode) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url);
    if ("children" in node) for (const child of node.children) scan(child as MessageNode);
  };
  scan(tree);
  const visit = (node: MessageNode, ancestors: readonly MessageNode[]) => {
    onNode?.(node, ancestors);
    const raw = node.type === "link" ? node.url : node.type === "linkReference" ? definitions.get(node.identifier) : undefined;
    const bare = !!raw && isBareLink(linkText(node as { type: string }), raw);
    // A destination that isn't a URL (`[words](https://a b)`, written by hand) is no link to read: skipped, never thrown
    // (a throw here, in a message's render, took the whole conversation down: #triage:#351).
    const href = raw && accept(raw) && (bare || labelled) ? hrefOf(raw) : null;
    if (href) found.push({ href, node, ancestors, bare });
    if ("children" in node) for (const child of node.children) visit(child as MessageNode, [...ancestors, node]);
  };
  visit(tree, []);
  return found;
}
/** The visible, bare Markdown links of `content` that `accept` takes, as WHATWG hrefs, once each in message order. */
function visibleBareLinks(content: string, accept: (raw: string) => boolean): string[] {
  return [...new Set(bareLinkNodes(content, accept).map((link) => link.href))];
}

/** Blocks a version 3 block card is never drawn in: the author's quote, a table, a heading, a footnote. */
const NO_BLOCK_CARD_IN: ReadonlySet<string> = new Set(["blockquote", "table", "heading", "footnoteDefinition"]);
/**
 * Where version 3 block cards may go in `content` (RFC 076 §14; raft-design
 * Navigation › Block cards):
 * - `places`: the bare public HTTPS links that messagePreviewUrls reads, in a
 *   paragraph or a list item (not in a quote the author wrote, a table cell,
 *   a heading or a footnote), each address once, at its first such place, in
 *   message order. `offset` is where the link starts in `content`: a client
 *   finds the link in its rendered Markdown by it;
 * - `end`: where the last such paragraph ends, or null: the place for a card
 *   whose link isn't in this text (a translation that dropped it).
 * Which links get a card (an App answered one, at most 3 a message) is the
 * client's.
 */
export function appLinkBlockCardLayout(content: string): { places: { url: string; offset: number }[]; end: number | null } {
  const places = new Map<string, number>();
  let end: number | null = null;
  const outside = (ancestors: readonly MessageNode[]) => !ancestors.some((ancestor) => NO_BLOCK_CARD_IN.has(ancestor.type));
  const links = bareLinkNodes(content, (raw) => !!publicPreviewUrl(raw), (node, ancestors) => {
    if (node.type === "paragraph" && outside(ancestors) && node.position?.end.offset !== undefined) end = node.position.end.offset;
  });
  for (const { href, node, ancestors } of links) {
    const offset = node.position?.start.offset;
    if (places.has(href) || offset === undefined || !outside(ancestors)) continue;
    places.set(href, offset);
  }
  return { places: [...places].map(([url, offset]) => ({ url, offset })), end };
}
/** appLinkBlockCardLayout's `places`. */
export function appLinkBlockCardPlaces(content: string): { url: string; offset: number }[] {
  return appLinkBlockCardLayout(content).places;
}

/**
 * Only visible, bare Markdown links: the ones a client can show as the App's
 * chip (protocol v3.2.3 addendum 5 §1). A link the author gave words to stays
 * as written, so it is neither previewed nor asked about, and the App never
 * learns of it. Code and image destinations do not trigger callbacks.
 * Deduplicated in message order, at most `limit`: three for the v1 preview
 * GET, ten for the batched link-card read (addendum 2 §5).
 */
export function messagePreviewUrls(content: string, limit = 3): string[] {
  return visibleBareLinks(content, (raw) => !!publicPreviewUrl(raw)).slice(0, limit);
}

/**
 * Every visible, bare http(s) link of a message: messagePreviewUrls' rules
 * (a link the author gave words to, code and image destinations don't count;
 * once each, in message order) without its public-HTTPS filter, which only an
 * App's callback needs. The web reads Raft's own links from these (first-party
 * objects, such as an Artifact on this deployment's host, a port or plain http
 * included): one extraction per message for its link cards.
 */
export function messageBareLinks(content: string): string[] {
  return visibleBareLinks(content, (raw) => /^https?:\/\//i.test(raw));
}

/**
 * Every visible http(s) link of a message, bare or with words the author gave
 * it (`bare` false), once each in message order; an address written both
 * ways is bare. Code and image destinations don't count, as for
 * messageBareLinks. For Raft's own objects only (#proj-workspace:#289): an
 * Artifact linked with words still gets its card under the message, while an
 * App's link previews stay bare-only (messagePreviewUrls).
 */
export function messageVisibleLinks(content: string): { href: string; bare: boolean }[] {
  const links = new Map<string, boolean>();
  for (const { href, bare } of bareLinkNodes(content, (raw) => /^https?:\/\//i.test(raw), undefined, true)) links.set(href, (links.get(href) ?? false) || bare);
  return [...links].map(([href, bare]) => ({ href, bare }));
}
