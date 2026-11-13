// Card pieces shared by Raft's two closed, inert json-render catalogs:
// interactive link cards (appLinkPreview.ts, RFC 076) and first-party action
// cards (actionCardSpec.ts, `action-card.v1`). Each catalog builds its own
// element union from these, so neither imports the other's schema.
//
// Both catalogs import this; a change here must keep appLinkPreview.test.ts
// AND actionCard.v1.vector.json passing.
//
// Card text lengths count Unicode code points, so Go, Kotlin and TypeScript
// agree.

import { z } from "zod";
import { lazySchema } from "./lazySchema";

/** Unicode code points in `value`; a lone surrogate counts as one, as with Kotlin's `codePointCount`. */
export function cardCodePoints(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** A string of `min`-`max` code points. */
export function cardText(min: number, max: number) {
  return z.string().refine((value) => cardCodePoints(value) >= min && cardCodePoints(value) <= max,
    `Expected ${min}-${max} characters`);
}

const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
/** Strict RFC 3339 UTC on a date that exists (protocol v3.2.3 §5.2). */
export function isStrictRfc3339Utc(value: string): boolean {
  const m = RFC3339_UTC.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export const cardRfc3339Utc = lazySchema("cardRfc3339Utc", () => z.string().max(40).refine(isStrictRfc3339Utc, "Expected an RFC 3339 UTC timestamp"));

/**
 * A public HTTPS URL: no credentials, port, fragment or IP literal, a dotted
 * host, at most 2000 characters. Link previews, link-card navigate buttons and
 * action-card navigate buttons all accept only these.
 */
export function publicPreviewUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.port
      || !url.hostname.includes(".") || /[\[\]:]/.test(url.hostname) || /^\d+(\.\d+){3}$/.test(url.hostname)
      || raw.length > 2000) return null;
    return url;
  } catch { return null; }
}

export const CARD_ELEMENT_ID = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
/** Names a JavaScript object treats specially; never an element id (or, in action cards, any other key). */
export const CARD_RESERVED_IDS: readonly string[] = ["constructor", "prototype", "__proto__"];
export const cardElementId = lazySchema("cardElementId", () => z.string().regex(CARD_ELEMENT_ID));
export function cardChildren(max: number) {
  return z.array(cardElementId).max(max).optional();
}

export const CARD_BADGE_TONES = ["neutral", "review", "progress", "warning", "action", "done", "closed"] as const;
export type CardBadgeTone = typeof CARD_BADGE_TONES[number];
export const cardBadgeTone = lazySchema("cardBadgeTone", () => z.enum(CARD_BADGE_TONES));

/**
 * What a card object does with a key it does not know: "strict" refuses it
 * (link cards; action cards as a server emits them), "strip" drops it from the
 * parsed value without looking at it (action cards as a client reads them, so
 * an older client still shows a card with a newer prop).
 */
export type CardUnknownKeys = "strict" | "strip";
export function cardObject<S extends z.core.$ZodLooseShape>(shape: S, unknownKeys: CardUnknownKeys) {
  return unknownKeys === "strict" ? z.strictObject(shape) : z.object(shape);
}
/** An element object: as cardObject, but `children` belongs to a Stack, so on any other element it is refused either way. */
export function cardElementObject<S extends z.core.$ZodLooseShape>(shape: S, unknownKeys: CardUnknownKeys) {
  return unknownKeys === "strict" ? z.strictObject(shape) : z.object({ ...shape, children: z.never({ error: "Only a Stack has children" }).optional() });
}

// Layout is a closed choice, not CSS: column (the v1 behaviour) or a row that
// may wrap, with spacing left to the client.
export function cardStackElementSchema(unknownKeys: CardUnknownKeys) {
  return cardObject({ type: z.literal("Stack"), props: cardObject({
    direction: z.enum(["column", "row"]).default("column"),
    wrap: z.boolean().default(false),
  }, unknownKeys).refine((p) => p.direction === "row" || !p.wrap, "Only a row can wrap"), children: cardChildren(12) }, unknownKeys);
}
export function cardRelativeTimeElementSchema(unknownKeys: CardUnknownKeys) {
  return cardElementObject({ type: z.literal("RelativeTime"), props: cardObject({ at: cardRfc3339Utc }, unknownKeys) }, unknownKeys);
}
// No `end`: still running, the client ticks. With `end`: finished, frozen.
export function cardDurationElementSchema(unknownKeys: CardUnknownKeys) {
  return cardElementObject({ type: z.literal("Duration"), props: cardObject({ start: cardRfc3339Utc, end: cardRfc3339Utc.optional() }, unknownKeys)
    .refine((p) => !p.end || Date.parse(p.end) >= Date.parse(p.start), "A duration cannot end before it starts") }, unknownKeys);
}
export const cardStackElement = lazySchema("cardStackElement", () => cardStackElementSchema("strict"));
export const cardRelativeTimeElement = lazySchema("cardRelativeTimeElement", () => cardRelativeTimeElementSchema("strict"));
export const cardDurationElement = lazySchema("cardDurationElement", () => cardDurationElementSchema("strict"));

/**
 * Whether a parsed card is one bounded tree: at most `maxElements` elements,
 * no reserved id ("size"); every element reached exactly once from `root`
 * through Stack children, the root at depth 0 and none deeper than `maxDepth`
 * ("tree"). Null when it is.
 */
export function checkBoundedTree(
  spec: { root: string; elements: Record<string, { type: string; children?: string[] } | undefined> },
  limits: { maxElements: number; maxDepth: number },
): "size" | "tree" | null {
  const ids = Object.keys(spec.elements);
  if (ids.length > limits.maxElements || ids.some((id) => CARD_RESERVED_IDS.includes(id))) return "size";
  const visited = new Set<string>();
  const visit = (id: string, depth: number): boolean => {
    const node = spec.elements[id];
    if (!Object.hasOwn(spec.elements, id) || !node || visited.has(id) || depth > limits.maxDepth) return false;
    visited.add(id);
    return node.type !== "Stack" || (node.children ?? []).every((child) => visit(child, depth + 1));
  };
  if (!visit(spec.root, 0) || visited.size !== ids.length) return "tree";
  return null;
}
