/**
 * The claim ledger: an optimization is a falsifiable statement ("this change
 * takes about 350 ms off channel_first_visit_settled_ms"), written down before
 * it ships and checked against a measurement after
 * (docs/frontend/perf-measure.md, "Claims"). Pure, pinned by claims.test.ts.
 *
 * A claim is a list of events, one row each (ScopeDB `perf.claims`,
 * append-only); the latest row of a `claim_id` is its state:
 *
 *   opened ─ ship ─▶ shipped ─ verify ─▶ verified | refuted | inconclusive
 *      └────────── withdraw ──────────▶ withdrawn (also from shipped)
 *
 * Before and after are two collections taken at different times on different
 * commits, so their runs cannot be paired. The rule, on the runs of each side:
 *   verified      the median moved in the predicted direction by more than the
 *                 noise floor and by at least half of what was predicted, and the
 *                 two sides do not overlap (every run after is on the predicted
 *                 side of every run before)
 *   refuted       a real move as predicted, but under half the prediction (the
 *                 change helped; the claim about how much was wrong); or the
 *                 median moved the other way beyond the floor; or it did not move
 *                 beyond the floor although the measurement could have seen half
 *                 of what was predicted (the floor is under half the prediction)
 *   inconclusive  the median moved as predicted but runs overlap (take more
 *                 runs), or nothing moved and the measurement was too coarse to tell
 * The floor is the larger of 2% of the before median and, for a metric in
 * milliseconds, 30 ms (the floor `measure` uses). `measured_delta / predicted_delta`
 * is the calibration of whoever predicted: 1 is exact, under 1 is optimism.
 */

export type ClaimEvent = "opened" | "shipped" | "verified" | "refuted" | "inconclusive" | "withdrawn";

export const CLAIM_EVENTS: readonly ClaimEvent[] = ["opened", "shipped", "verified", "refuted", "inconclusive", "withdrawn"];

/** One row of perf.claims. Every row repeats the claim's identity, so a row can be read alone. */
export interface ClaimRow {
  claim_id: string;
  event: ClaimEvent;
  event_at: string;
  project: string;
  env: string;
  title: string;
  ref: string;
  author: string;
  scenario: string;
  metric: string;
  predicted_delta: number;
  baseline_value: number | null;
  measured_value: number | null;
  measured_delta: number | null;
  runs_before: number | null;
  runs_after: number | null;
  commit_sha: string | null;
  runner: string;
  verify_command: string;
  tool_version: string;
  note: string | null;
}

export const MIN_RUNS = 3;
export const FLOOR_MS = 30;
export const FLOOR_RATIO = 0.02;

const STRINGS = ["claim_id", "event_at", "project", "env", "title", "ref", "author", "scenario", "metric", "runner", "verify_command", "tool_version"] as const;
const NUMBERS_OR_NULL = ["baseline_value", "measured_value", "measured_delta", "runs_before", "runs_after"] as const;

/** Parse a claims.jsonl; throws with the line number on a row that is not a claim row. */
export function parseClaims(text: string): ClaimRow[] {
  const rows: ClaimRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const bad = (why: string): never => {
      throw new Error(`claims line ${i + 1}: ${why}`);
    };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      bad("not JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) bad("not an object");
    const row = value as Record<string, unknown>;
    for (const key of STRINGS) if (typeof row[key] !== "string" || row[key] === "") bad(`${key} must be a non-empty string`);
    if (!CLAIM_EVENTS.includes(row.event as ClaimEvent)) bad(`event must be one of ${CLAIM_EVENTS.join(", ")}`);
    if (typeof row.predicted_delta !== "number" || !Number.isFinite(row.predicted_delta) || row.predicted_delta === 0) bad("predicted_delta must be a non-zero number");
    for (const key of NUMBERS_OR_NULL) if (row[key] !== null && (typeof row[key] !== "number" || !Number.isFinite(row[key] as number))) bad(`${key} must be a number or null`);
    for (const key of ["commit_sha", "note"] as const) if (row[key] !== null && typeof row[key] !== "string") bad(`${key} must be a string or null`);
    rows.push(row as unknown as ClaimRow);
  });
  return rows;
}

/** The latest row of each claim, in the order the claims were opened. */
export function claimStates(rows: readonly ClaimRow[]): ClaimRow[] {
  const latest = new Map<string, ClaimRow>();
  for (const row of rows) latest.set(row.claim_id, row);
  return [...latest.values()];
}

/** Why `event` cannot follow the claim's current state, or null when it can. */
export function transitionError(current: ClaimEvent | null, event: ClaimEvent): string | null {
  const allowed: Record<ClaimEvent, readonly (ClaimEvent | null)[]> = {
    opened: [null],
    shipped: ["opened"],
    verified: ["shipped"],
    refuted: ["shipped"],
    inconclusive: ["shipped"],
    withdrawn: ["opened", "shipped"],
  };
  if (allowed[event].includes(current)) return null;
  if (current === null) return "there is no such claim: open it first";
  if (event === "opened") return `the claim already exists (${current})`;
  if (event === "shipped") return current === "shipped" ? "the claim has already shipped" : `the claim is ${current}: that is final (open a new claim for a new attempt)`;
  if (current === "opened" && event !== "withdrawn") return "the claim has not shipped: record the commit with `claim ship` first, so the after-measurement can be tied to it";
  return `the claim is ${current}: that is final (open a new claim for a new attempt)`;
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface ClaimJudgement {
  event: "verified" | "refuted" | "inconclusive";
  reason: string;
  baseline: number;
  measured: number;
  measuredDelta: number;
  floor: number;
  /** measuredDelta / predictedDelta; 1 = exactly as predicted, negative = the other way. */
  calibration: number;
}

const round = (v: number) => Math.round(v * 10) / 10;

/** Judge a shipped claim from the runs measured before and after. Throws when either side has under MIN_RUNS runs. */
export function judgeClaim(metric: string, predictedDelta: number, before: readonly number[], after: readonly number[]): ClaimJudgement {
  if (before.length < MIN_RUNS || after.length < MIN_RUNS) throw new Error(`need at least ${MIN_RUNS} runs on each side (before ${before.length}, after ${after.length})`);
  const baseline = median(before);
  const measured = median(after);
  const delta = measured - baseline;
  const floor = predictionFloor(metric, baseline);
  const sign = Math.sign(predictedDelta);
  // every run after is on the predicted side of every run before / on the other side
  const apartAsPredicted = sign < 0 ? Math.max(...after) < Math.min(...before) : Math.min(...after) > Math.max(...before);
  const apartAgainst = sign < 0 ? Math.min(...after) > Math.max(...before) : Math.max(...after) < Math.min(...before);
  const base = { baseline: round(baseline), measured: round(measured), measuredDelta: round(delta), floor: round(floor), calibration: Math.round((delta / predictedDelta) * 100) / 100 };
  const moved = `${metric} ${round(baseline)} -> ${round(measured)} (${delta > 0 ? "+" : ""}${round(delta)}, predicted ${predictedDelta > 0 ? "+" : ""}${predictedDelta}, floor ${round(floor)})`;
  if (delta * sign > floor && apartAsPredicted) {
    if (Math.abs(delta) >= Math.abs(predictedDelta) / 2) return { ...base, event: "verified", reason: `${moved}: beyond the floor, at least half the prediction, and no run overlaps` };
    return { ...base, event: "refuted", reason: `${moved}: a real move as predicted (no run overlaps), but under half of what was predicted` };
  }
  if (-delta * sign > floor) return { ...base, event: "refuted", reason: `${moved}: it moved the other way beyond the floor${apartAgainst ? ", with no run overlapping" : " (runs overlap)"}` };
  if (delta * sign > floor) return { ...base, event: "inconclusive", reason: `${moved}: the median moved as predicted, but runs of the two sides overlap; take more runs` };
  if (floor < Math.abs(predictedDelta) / 2) return { ...base, event: "refuted", reason: `${moved}: no clear move, and half of the prediction would have shown` };
  return { ...base, event: "inconclusive", reason: `${moved}: no clear move, but the floor is over half the prediction, so this measurement could not have shown it` };
}

/** The noise floor of a metric at a baseline. A prediction not over twice this cannot be refuted by a result of "no move": that comes out inconclusive. */
export function predictionFloor(metric: string, baseline: number): number {
  return Math.max(FLOOR_RATIO * Math.abs(baseline), /_ms$/.test(metric) ? FLOOR_MS : 0);
}

/** A git commit as rows and people write it: 7 to 40 hex digits. */
export const isCommitSha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value);

/** Two shas of the same commit: one is a prefix of the other. */
export const sameCommit = (a: string, b: string): boolean => a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase());

/** The runs of one metric out of perf.page_runs rows (a column, or a key of `extra`); rows without a number are skipped. */
export function metricRuns(rows: ReadonlyArray<Record<string, unknown>>, metric: string): number[] {
  return rows
    .map((row) => (metric in row ? row[metric] : (row.extra as Record<string, unknown> | undefined)?.[metric]))
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}
