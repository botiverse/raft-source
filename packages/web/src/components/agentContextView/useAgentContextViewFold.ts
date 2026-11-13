import { useMemo } from "react";

/** Text longer than this many lines (or characters) folds to its first lines. */
const FOLD_LINES = 8;
const FOLD_CHARS = 1_200;
const FOLDED_LINES = 4;
const FOLDED_CHARS = 600;

function lineCount(text: string): number {
  let lines = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++;
  return lines;
}

/** Characters a line of a fold to `lines` lines may average (a tool's output folds to 12). */
const CHARS_PER_FOLDED_LINE = 150;

/**
 * Whether `text` folds (unless it is shown `whole`), how many lines it has,
 * and its first lines: a prefix of it, so search's numbers for the matches
 * in it are the text's own. `foldTo`: fold anything past that many lines to
 * them (a tool's output), instead of the default.
 */
export function useAgentContextViewFold(text: string, whole?: boolean, foldTo?: number) {
  return useMemo(() => {
    const lines = lineCount(text);
    const maxChars = foldTo ? foldTo * CHARS_PER_FOLDED_LINE : FOLD_CHARS;
    const long = !whole && (lines > (foldTo ?? FOLD_LINES) || text.length > maxChars);
    const shownLines = foldTo ?? FOLDED_LINES;
    const shownChars = foldTo ? maxChars : FOLDED_CHARS;
    return { lines, long, folded: long ? text.split("\n", shownLines).join("\n").slice(0, shownChars) : text };
  }, [foldTo, text, whole]);
}
