import {
  ARTIFACT_PAGE_ANCHOR_MAX_LABEL,
  ARTIFACT_PAGE_ANCHOR_MAX_QUOTE,
  ARTIFACT_PAGE_ANCHOR_NAME,
  ARTIFACT_PAGE_DRAFT_MAX,
  isArtifactPageText,
} from "@botiverse/raft-shared";
import type { ArtifactPageAnchor } from "@botiverse/raft-shared";

/**
 * A page's button that starts a comment (Porthole `comments.open(anchor,
 * { draft })`, P090, P108; xxchan's decision sheets, #proj-workspace). The
 * page asks; Raft opens its own comment box at the page's anchor, with the
 * page's draft in it, and the person reads it, edits it and sends it with
 * Enter, or doesn't. The page never posts and never reads a comment.
 *
 * Everything in the request is the page's word (Tenny): Porthole's bridge has
 * checked its shape, and it is checked again here, against Raft's own rules,
 * before anything opens:
 * - `name` is an identifier (ARTIFACT_PAGE_ANCHOR_NAME), only compared,
 *   never read as a path or a link;
 * - `label` and `quote` are plain text a person is shown, without unseen
 *   characters (ARTIFACT_PAGE_TEXT_UNSEEN), the label at most 200
 *   characters; the quote is cut to 1,000 (the stored anchor's limit) and
 *   is shown as the page's excerpt, never as a passage the person selected;
 *   blank is none;
 * - `draft` is plain text, at most 2,000 characters, nothing unseen: it goes
 *   into the box as the box's text (never HTML, never mentions: an `@Name`
 *   in it stays text unless the person picks the name).
 * Anything else refuses the request: nothing opens and the page hears false.
 */
export interface PageCommentRequest {
  anchor: ArtifactPageAnchor;
  /** The text the box starts with; null: an empty box. */
  draft: string | null;
}

/** How long the box takes no press and no Enter after a page opened it (P108, Porthole THREAT_MODEL §6). */
export const PAGE_COMMENT_ARM_MS = 500;
/**
 * At most one open a second from a page (and fewer once the person keeps
 * closing what it opens: artifactPageOpenGate). No proof of a click is asked
 * of the page (Porthole's default since 0.16.0), so the page alone decides when it
 * calls; Porthole's own limit is 30 calls a minute.
 */
export const PAGE_COMMENT_COOLDOWN_MS = 1_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** At most `max` UTF-16 units, never ending inside a surrogate pair. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]!) ? max - 1 : max;
  return text.slice(0, end);
}

/** A label or quote: absent or blank is none (undefined); text with anything unseen, or too long, refuses (null). */
function pageText(value: unknown, max: number, { cutTo }: { cutTo?: number } = {}): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  if (value.trim() === "") return undefined;
  const text = cutTo !== undefined ? cut(value, cutTo) : value;
  if (text.trim() === "") return undefined;
  return isArtifactPageText(text, max) ? text : null;
}

/** The page's request, by Raft's rules (above), or null when any of it fails them. */
export function parsePageCommentRequest(raw: unknown): PageCommentRequest | null {
  if (!isRecord(raw) || !isRecord(raw.anchor)) return null;
  const { name, label: rawLabel, quote: rawQuote } = raw.anchor;
  if (typeof name !== "string" || !ARTIFACT_PAGE_ANCHOR_NAME.test(name)) return null;
  const label = pageText(rawLabel, ARTIFACT_PAGE_ANCHOR_MAX_LABEL);
  // Porthole takes a quote of up to 2,000; the stored anchor holds 1,000 of it.
  const quote = pageText(rawQuote, ARTIFACT_PAGE_ANCHOR_MAX_QUOTE, { cutTo: ARTIFACT_PAGE_ANCHOR_MAX_QUOTE });
  if (label === null || quote === null) return null;
  let draft: string | null = null;
  if (raw.draft !== undefined) {
    // Unlike a label, a blank draft is a mistake, not "none" (Porthole refuses it too).
    if (!isArtifactPageText(raw.draft, ARTIFACT_PAGE_DRAFT_MAX)) return null;
    draft = raw.draft;
  }
  return {
    anchor: { name, ...(label === undefined ? {} : { label }), ...(quote === undefined ? {} : { quote }) },
    draft,
  };
}
