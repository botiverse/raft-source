/**
 * A patch that satisfies a criterion WITHOUT fixing the defect (task #92).
 *
 * Kept executable on purpose. Its whole job is to CHANGE STATE if the task #92
 * acceptance criteria are ever weakened, and a document cannot do that: prose
 * has no pass/fail, so it looks identical whether the criteria still catch this
 * or no longer do. A snippet pasted in a README also drifts away from the real
 * source with nothing emitting a signal.
 *
 * This was the author's first attempt at FIX A: merge the overlapping ranges
 * rather than prevent them. Merging preserves the spurious span's EXTENT and
 * folds it into the fence, so the merged code span reaches the wrapped name's
 * opening backtick and the name still lands in prose. The walk becomes
 * self-consistent -- an identity replacer is lossless -- while the leak remains.
 */

interface Span {
  start: number;
  end: number;
}

/** The wrong FIX A: sorts, then merges overlaps instead of preventing them. */
export function wrongMarkdownCodeSpans(source: string): Span[] {
  const spans: Span[] = [];
  for (const match of source.matchAll(/```[\s\S]*?```/g)) {
    spans.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  for (const match of source.matchAll(/``[^`]+``|`[^`]+`/g)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!spans.some((span) => start >= span.start && end <= span.end)) {
      spans.push({ start, end });
    }
  }
  spans.sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

function walk(source: string, spans: Span[], replacer: (chunk: string) => string): string {
  let output = "";
  let cursor = 0;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    const start = span.start > cursor ? span.start : cursor;
    if (start > cursor) output += replacer(source.slice(cursor, start));
    output += source.slice(start, span.end);
    cursor = span.end;
  }
  if (cursor < source.length) output += replacer(source.slice(cursor));
  return output;
}

/** Identity replacement under the wrong patch -- used to show it is lossless. */
export function wrongReplaceOutsideMarkdownCode(
  source: string,
  replacer: (chunk: string) => string,
): string {
  return walk(source, wrongMarkdownCodeSpans(source), replacer);
}

/** Mention extraction under the wrong patch -- used to show it still leaks. */
export function wrongExtractRaftMentionHandles(source: string): string[] {
  const handles = new Set<string>();
  wrongReplaceOutsideMarkdownCode(source, (chunk) => {
    for (const match of chunk.matchAll(/@([\p{L}\p{N}_-]+)/gu)) handles.add(match[1]);
    return chunk;
  });
  return [...handles];
}
