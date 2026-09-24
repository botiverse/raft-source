/**
 * The task #92 acceptance rows, in one place, so that BOTH the real
 * implementation and the wrong-patch gate are checked against the *same*
 * table rather than against two copies that can drift apart.
 *
 * This is the wiring the gate was missing. Previously the gate asserted the
 * wrong patch's own behaviour ("it leaks") while never referencing the
 * criteria, so weakening a criterion left the gate untouched -- it could not
 * do the one job it existed for.
 */
export interface CriteriaRow {
  /** Why this shape is in the table. */
  readonly name: string;
  readonly source: string;
  /** Handles a correct implementation must extract -- the S1 assertion. */
  readonly expected: readonly string[];
}

const H = "@handle";

export const TASK_92_ROWS: readonly CriteriaRow[] = [
  // A fence followed by a wrapped name: the shape we write constantly, and the
  // one that had no fixture at all before task #92.
  { name: "fence -> inline", source: "```\nx\n```\nA `" + H + "` B\n", expected: [] },
  { name: "prose -> fence -> inline", source: "a\n```\nx\n```\nB `" + H + "` C\n", expected: [] },
  { name: "fence -> prose -> inline", source: "```x```y`" + H + "`", expected: [] },
  { name: "inline -> fence -> inline", source: "``a`` ```x``` `" + H + "`", expected: [] },
  // Counter-row: the fix must not become "suppress everything". An unwrapped
  // name after a fence still has to be extracted.
  { name: "fence -> bare name (must still extract)", source: "```\nx\n```\nA " + H + " B\n", expected: ["handle"] },
];

/** Rows an implementation satisfies. Empty result = it satisfies every row. */
export function rowsViolatedBy(
  extract: (source: string) => string[],
): string[] {
  const violated: string[] = [];
  for (const row of TASK_92_ROWS) {
    const actual = [...extract(row.source)].sort();
    const expected = [...row.expected].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) violated.push(row.name);
  }
  return violated;
}
