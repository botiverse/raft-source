import type { ReactNode } from "react";

/**
 * A status sentence ending in an inline action ("... from this Computer. Retry").
 *
 * The sentence's LAST GRAPHEME shares a `whitespace-nowrap` span with the action
 * (the space inside it cannot break, and text content stays a plain space), so when the sentence wraps the action can never be left alone
 * on a line of its own. Only one grapheme is glued: a span boundary inside a Latin
 * word is not a break opportunity, so "Computer." still moves as a whole, while
 * Chinese and Japanese text (which breaks between characters, and often contains
 * Latin words with spaces around them) keeps every other break opportunity.
 *
 * raft-ui has no inline action-tail primitive (its `Ellipsis` `after` slot only
 * shows while text is truncated), so this markup is hand-rolled; see the PR.
 */
export function withInlineActionTail(content: ReactNode, action: ReactNode): ReactNode {
  if (!action) return content;
  if (Array.isArray(content)) {
    // Rich-text formatMessage output: glue only when it ENDS in words, so the
    // action never lands before a trailing element.
    const items = [...content];
    let last = items.length - 1;
    while (last >= 0 && typeof items[last] === "string" && !items[last].trim()) last--;
    if (last >= 0 && typeof items[last] === "string") {
      const [head, tail] = splitLastGrapheme(items[last]);
      return <>{items.slice(0, last)}{head}<span className="whitespace-nowrap">{tail}{" "}{action}</span></>;
    }
    return <>{content}{" "}{action}</>;
  }
  if (typeof content === "string" && !content.trim()) return action;
  if (typeof content !== "string") return content ? <>{content}{" "}{action}</> : action;
  const [head, tail] = splitLastGrapheme(content);
  return <>{head}<span className="whitespace-nowrap">{tail}{" "}{action}</span></>;
}

/** `[everything before the last grapheme, the last grapheme]`, trailing whitespace dropped. */
export function splitLastGrapheme(text: string): [string, string] {
  const trimmed = text.trimEnd();
  if (!trimmed) return ["", ""];
  // Intl.Segmenter is missing before Firefox 125; code points are right for nearly all copy.
  // Grapheme clusters are locale-independent (UAX #29); "en" satisfies the explicit-locale rule.
  const last = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(trimmed)].at(-1)?.segment ?? ""
    : Array.from(trimmed).at(-1) ?? "";
  return [trimmed.slice(0, trimmed.length - last.length), last];
}
