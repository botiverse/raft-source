/**
 * Where a bare address written in text ends when a CJK sentence goes on straight after it, with
 * no space: "见 https://…/artifacts/H6Xq（v10，第 6 轮）". The full-width punctuation such a
 * sentence uses is never part of the address; it ends it as a space would, so the link is
 * `https://…/artifacts/H6Xq` and `（v10，第 6 轮）` stays text.
 *
 * One rule for every place that reads bare addresses out of text, so they agree on where a link
 * ends: an Artifact's Markdown page (the content Worker's renderer, its GFM literal links), the
 * links the server reads from that page (contentLinks.ts, the viewer's titles and backlinks), and
 * profile descriptions (descriptionLinks.ts). A link with an explicit end (`[words](url)`,
 * `<url>`, an HTML `href`) is the author's own and isn't cut.
 */

/**
 * The full-width punctuation, as the body of a regex character class: CJK Symbols and Punctuation
 * (U+3000-303F: the ideographic space, 、。〈〉《》「」『』【】〔〕〜…) and the punctuation of
 * Halfwidth and Fullwidth Forms (（）！，：；？［］｛｝～, the halfwidth ｡｢｣､･…), not its
 * full-width letters and digits.
 */
export const FULL_WIDTH_PUNCTUATION = "\\u3000-\\u303f\\uff01-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65";

const FIRST_FULL_WIDTH_PUNCTUATION = new RegExp(`[${FULL_WIDTH_PUNCTUATION}]`);

/** A bare address as written up to its first full-width punctuation (the whole of it when there is none). */
export function bareLinkBeforeFullWidthPunctuation(address: string): string {
  const at = address.search(FIRST_FULL_WIDTH_PUNCTUATION);
  return at < 0 ? address : address.slice(0, at);
}
