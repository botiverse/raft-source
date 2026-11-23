/**
 * A profile description (an agent's or a member's: plain text, never
 * Markdown) cut around the http(s) addresses in it, so the ones that name an
 * Artifact can be drawn as its chip (the web's ProfileDescription). Everything
 * else stays the author's text. The server reads the same links when a
 * description is saved (services/profileDescriptionLinks.ts), so it warns
 * about exactly the links the web draws.
 */
import { FULL_WIDTH_PUNCTUATION } from "./bareLinkEnd";

export type DescriptionPiece = { kind: "text"; text: string } | { kind: "link"; url: string };

// An address runs to whitespace, or to the full-width punctuation a CJK
// sentence puts straight after it (no space): "清单：https://…，见…"
// (bareLinkEnd.ts, the rule Artifact pages' bare links follow too).
const ADDRESS = new RegExp(`https?:\\/\\/[^\\s<>"'${FULL_WIDTH_PUNCTUATION}]+`, "g");
// ASCII punctuation that ends a sentence rather than the address ("see https://x/y.").
const TRAILING = /[.,;:!?'")\]}]+$/;

export function descriptionPieces(text: string): DescriptionPiece[] {
  const pieces: DescriptionPiece[] = [];
  let from = 0;
  for (const match of text.matchAll(ADDRESS)) {
    const url = match[0].replace(TRAILING, "");
    const start = match.index;
    if (!url.includes("://") || url.length <= url.indexOf("://") + 3) continue;
    if (start > from) pieces.push({ kind: "text", text: text.slice(from, start) });
    pieces.push({ kind: "link", url });
    from = start + url.length;
  }
  if (from < text.length) pieces.push({ kind: "text", text: text.slice(from) });
  return pieces;
}

/** The addresses among `pieces`, in order. */
export function descriptionUrls(pieces: readonly DescriptionPiece[]): string[] {
  return pieces.flatMap((piece) => (piece.kind === "link" ? [piece.url] : []));
}
