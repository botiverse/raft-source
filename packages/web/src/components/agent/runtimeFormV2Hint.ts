/**
 * Runtime form v2 hints are server copy (`uiSchema.localization.<field>.hint`).
 * The one markup they may carry is an inline Markdown link `[text](https://…)`:
 * rendered as an external link (new tab, `rel="noopener noreferrer"`). Nothing
 * else is interpreted; a link whose target is not an absolute https URL (or is
 * malformed) stays plain text. Built from React nodes, never HTML.
 */
const INLINE_LINK = /\[([^[\]\n]+)\]\(([^()\s]+)\)/g;

/** `at`: the link's offset in the hint, a stable key. */
export type RuntimeFormV2HintPart = { text: string } | { text: string; href: string; at: number };

function httpsHref(raw: string): string | null {
  if (!raw.startsWith("https://")) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Splits a hint into plain text and https links; adjacent text is merged. */
export function parseRuntimeFormV2Hint(hint: string): RuntimeFormV2HintPart[] {
  const parts: RuntimeFormV2HintPart[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && !("href" in last)) last.text += text;
    else parts.push({ text });
  };
  let cursor = 0;
  for (const match of hint.matchAll(INLINE_LINK)) {
    const start = match.index ?? 0;
    pushText(hint.slice(cursor, start));
    const href = httpsHref(match[2]);
    if (href) parts.push({ text: match[1], href, at: start });
    else pushText(match[0]);
    cursor = start + match[0].length;
  }
  pushText(hint.slice(cursor));
  return parts;
}
