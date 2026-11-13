/**
 * Watermarks: the line a metric must stay under, so a regression is caught by
 * a command instead of by someone noticing. A watermark file is JSON:
 *   { "runner": "...", "marks": { "<metric>": { "max": <number>, "note": "..." } } }
 * Metric names are those of the report's `metrics` (each also an `extra` key of its perf.page_runs rows), with their unit.
 * Pure, pinned by watermarks.test.ts.
 */

export interface Watermark {
  max: number;
  note?: string;
}

export interface WatermarkFile {
  /** Where the lines were measured: they hold for that kind of runner only. */
  runner?: string;
  marks: Record<string, Watermark>;
}

export interface Breach {
  metric: string;
  value: number;
  max: number;
  overBy: number;
}

export interface CheckResult {
  ok: boolean;
  checked: number;
  breaches: Breach[];
  /** Metrics with a watermark but no value: a check that did not run is not a pass. */
  missing: string[];
}

/** A watermark file read from disk: every mark needs a finite `max`, or the line would silently never be crossed. */
export function parseWatermarkFile(raw: unknown, source = "watermark file"): WatermarkFile {
  const file = raw as { runner?: unknown; marks?: unknown };
  if (!file || typeof file !== "object" || !file.marks || typeof file.marks !== "object" || Array.isArray(file.marks)) throw new Error(`${source}: no "marks" object`);
  const marks: Record<string, Watermark> = {};
  for (const [metric, mark] of Object.entries(file.marks as Record<string, unknown>)) {
    const max = (mark as { max?: unknown } | null)?.max;
    if (typeof max !== "number" || !Number.isFinite(max)) throw new Error(`${source}: "${metric}" needs a numeric "max" (got ${JSON.stringify(mark)})`);
    marks[metric] = { max, ...(typeof (mark as { note?: unknown }).note === "string" ? { note: (mark as { note: string }).note } : {}) };
  }
  return { ...(typeof file.runner === "string" ? { runner: file.runner } : {}), marks };
}

export function checkWatermarks(values: Record<string, number | null | undefined>, file: WatermarkFile): CheckResult {
  const breaches: Breach[] = [];
  const missing: string[] = [];
  let checked = 0;
  for (const [metric, mark] of Object.entries(file.marks)) {
    const value = values[metric];
    if (value == null || !Number.isFinite(value)) {
      missing.push(metric);
      continue;
    }
    checked++;
    if (value > mark.max) breaches.push({ metric, value, max: mark.max, overBy: Math.round((value - mark.max) * 10) / 10 });
  }
  return { ok: breaches.length === 0 && missing.length === 0 && checked > 0, checked, breaches, missing };
}
