/**
 * A profile description (an agent's or a member's: plain text, never
 * Markdown) cut around the http(s) addresses in it, so the ones that name an
 * Artifact can be drawn as its chip (ProfileDescription). Everything else
 * stays the author's text.
 */
export type DescriptionPiece = { kind: "text"; text: string } | { kind: "link"; url: string };

// An address runs to whitespace, or to the full-width punctuation a CJK
// sentence puts straight after it (no space): "清单：https://…，见…".
const ADDRESS = /https?:\/\/[^\s<>"'\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+/g;
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
