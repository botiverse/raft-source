/**
 * Watermarks: the line a metric must stay under, so a regression is caught by
 * a command instead of by someone noticing. A watermark file is JSON:
 *   { "runner": "...", "page": { "server": "...", "channel": "...", "other": "..." }, "marks": { "<metric>": { "max": <number>, "note": "..." } } }
 * `page` is where the lines were set: a switch into a channel with fifty
 * messages and one with five hundred are different measurements, and a line
 * set on one says nothing about the other (the first lines here were set on
 * one channel and then held against another for two days).
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
  /** What was measured when the lines were set, as the report's `page` names it. Lines are only held against a report of the same page. */
  page?: Record<string, string>;
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
  /**
   * Whether the values are of the page the lines were set on. `same`: they are. `different`: `pageDiffers` lists the
   * keys; nothing was held against the lines (`checked` 0) and `ok` is false, because a line of another page neither
   * passes nor fails. `unknown`: the file or the values name no page, so the lines were held as before.
   */
  pageMatch: "same" | "different" | "unknown";
  /** Per differing key: what the lines name and what the values name (null: the values have no such key). */
  pageDiffers: { key: string; lines: string; values: unknown }[];
}

/** A watermark file read from disk: every mark needs a finite `max`, or the line would silently never be crossed. */
export function parseWatermarkFile(raw: unknown, source = "watermark file"): WatermarkFile {
  const file = raw as { runner?: unknown; page?: unknown; marks?: unknown };
  if (!file || typeof file !== "object" || !file.marks || typeof file.marks !== "object" || Array.isArray(file.marks)) throw new Error(`${source}: no "marks" object`);
  const marks: Record<string, Watermark> = {};
  for (const [metric, mark] of Object.entries(file.marks as Record<string, unknown>)) {
    const max = (mark as { max?: unknown } | null)?.max;
    if (typeof max !== "number" || !Number.isFinite(max)) throw new Error(`${source}: "${metric}" needs a numeric "max" (got ${JSON.stringify(mark)})`);
    marks[metric] = { max, ...(typeof (mark as { note?: unknown }).note === "string" ? { note: (mark as { note: string }).note } : {}) };
  }
  let page: Record<string, string> | undefined;
  if (file.page !== undefined) {
    const entries = file.page && typeof file.page === "object" && !Array.isArray(file.page) ? Object.entries(file.page as Record<string, unknown>) : [];
    if (!entries.length || entries.some(([, v]) => typeof v !== "string" || !v.trim())) throw new Error(`${source}: "page" must be an object of names, e.g. { "server": "…", "channel": "…" }`);
    page = Object.fromEntries(entries) as Record<string, string>;
  }
  return { ...(typeof file.runner === "string" ? { runner: file.runner } : {}), ...(page ? { page } : {}), marks };
}

/**
 * What `check` is given: a raft-perf report (its `metrics`, and the `page` it measured) or a flat object of
 * metric -> number. Either may carry a `page` object; a flat object's `page` is the page, not a metric.
 */
export function readValues(report: unknown): { values: Record<string, number | null | undefined>; page: Record<string, unknown> | null } {
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(report)) throw new Error("the values are not a JSON object");
  const { page, ...rest } = report;
  return { values: (isObject(report.metrics) ? report.metrics : rest) as Record<string, number | null | undefined>, page: isObject(page) ? page : null };
}

/** `valuesPage`: the page the values were measured on (the report's `page`), when they come with one. */
export function checkWatermarks(values: Record<string, number | null | undefined>, file: WatermarkFile, valuesPage?: Record<string, unknown> | null): CheckResult {
  const breaches: Breach[] = [];
  const missing: string[] = [];
  let checked = 0;
  // every key the lines name must match; the values may name more
  const pageDiffers = file.page && valuesPage ? Object.entries(file.page).flatMap(([key, lines]) => (valuesPage[key] === lines ? [] : [{ key, lines, values: valuesPage[key] ?? null }])) : [];
  const pageMatch = !file.page || !valuesPage ? "unknown" : pageDiffers.length ? "different" : "same";
  if (pageMatch === "different") return { ok: false, checked: 0, breaches, missing, pageMatch, pageDiffers };
  for (const [metric, mark] of Object.entries(file.marks)) {
    const value = values[metric];
    if (value == null || !Number.isFinite(value)) {
      missing.push(metric);
      continue;
    }
    checked++;
    if (value > mark.max) breaches.push({ metric, value, max: mark.max, overBy: Math.round((value - mark.max) * 10) / 10 });
  }
  return { ok: breaches.length === 0 && missing.length === 0 && checked > 0, checked, breaches, missing, pageMatch, pageDiffers };
}
