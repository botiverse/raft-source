/**
 * Watermarks: the line a metric must stay under, so a regression is caught by
 * a command instead of by someone noticing. A watermark file is JSON:
 *   { "runner": "...", "cohort": { "browserWhere": "local", "fixture": "bench-v1@5395d2b0", "benchmarkMs": 9.1 }, "page": { "server": "...", "channel": "...", "other": "..." }, "marks": { "<metric>": { "max": <number>, "note": "..." } } }
 * `page` and `cohort` say where the lines were set: lines set on one channel or
 * one machine say nothing about another, so `check` refuses cross-page and
 * cross-cohort comparisons rather than reporting false breaches or false passes.
 * Pure, pinned by watermarks.test.ts.
 */

import { BROWSER_WHERES, type BrowserWhere } from "./browser";
import { type Cohort, type CohortDifference, type CohortExpectation, compareCohorts } from "./cohort";

export interface Watermark {
  max: number;
  note?: string;
}

export interface WatermarkFile {
  /** Human-readable note of where the lines were measured. */
  runner?: string;
  /** Structured environment/fixture cohort the lines hold for (0.26.0+). */
  cohort?: CohortExpectation;
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
  /** Present when either the watermark file or the caller supplied a cohort. */
  cohortMatch?: "same" | "different" | "unknown";
  cohortDiffers?: CohortDifference[];
}

function parseCohortExpectation(raw: unknown, source: string): CohortExpectation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source}: "cohort" must be an object`);
  const c = raw as Record<string, unknown>;
  const out: CohortExpectation = {};
  if (c.browserWhere !== undefined) {
    if (typeof c.browserWhere !== "string" || !(BROWSER_WHERES as readonly string[]).includes(c.browserWhere)) {
      throw new Error(`${source}: cohort.browserWhere must be ${BROWSER_WHERES.join(" or ")}`);
    }
    out.browserWhere = c.browserWhere as BrowserWhere;
  }
  if (c.edgeColo !== undefined) {
    if (typeof c.edgeColo !== "string" || !/^[A-Za-z]{3}$/.test(c.edgeColo)) throw new Error(`${source}: cohort.edgeColo must be a 3-letter IATA code`);
    out.edgeColo = c.edgeColo.toUpperCase();
  }
  if (c.net !== undefined) {
    if (typeof c.net !== "string" || !c.net.trim()) throw new Error(`${source}: cohort.net must be a non-empty string`);
    out.net = c.net.trim();
  }
  if (c.fixture !== undefined) {
    if (c.fixture !== null && (typeof c.fixture !== "string" || !c.fixture.trim())) throw new Error(`${source}: cohort.fixture must be a non-empty string or null`);
    out.fixture = c.fixture === null ? null : c.fixture.trim();
  }
  if (c.documentIntercepted !== undefined) {
    if (typeof c.documentIntercepted !== "boolean") throw new Error(`${source}: cohort.documentIntercepted must be a boolean`);
    out.documentIntercepted = c.documentIntercepted;
  }
  for (const key of ["cpuSlowdown", "addedRttMs", "benchmarkMs", "connectRttMs"] as const) {
    if (c[key] !== undefined) {
      if (typeof c[key] !== "number" || !Number.isFinite(c[key] as number) || (c[key] as number) < 0) {
        throw new Error(`${source}: cohort.${key} must be a non-negative number`);
      }
      out[key] = c[key] as number;
    }
  }
  if (Object.keys(out).length === 0) throw new Error(`${source}: "cohort" must name at least one constraint`);
  return out;
}

/** A watermark file read from disk: every mark needs a finite `max`, or the line would silently never be crossed. */
export function parseWatermarkFile(raw: unknown, source = "watermark file"): WatermarkFile {
  const file = raw as { runner?: unknown; cohort?: unknown; page?: unknown; marks?: unknown };
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
  const cohort = file.cohort !== undefined ? parseCohortExpectation(file.cohort, source) : undefined;
  return {
    ...(typeof file.runner === "string" ? { runner: file.runner } : {}),
    ...(cohort ? { cohort } : {}),
    ...(page ? { page } : {}),
    marks,
  };
}

/**
 * What `check` is given: a raft-perf report (its `metrics`, and the `page` it measured) or a flat object of
 * metric -> number. Either may carry a `page` object; a flat object's `page` is the page, not a metric.
 */
export function readValues(report: unknown): { values: Record<string, number | null | undefined>; page: Record<string, unknown> | null } {
  const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(report)) throw new Error("the values are not a JSON object");
  const { page, cohort: _cohort, ...rest } = report;
  return { values: (isObject(report.metrics) ? report.metrics : rest) as Record<string, number | null | undefined>, page: isObject(page) ? page : null };
}

/** Extract a report's `cohort` object when present (`null` when the report predates cohorts or is a flat map). */
export function readCohort(report: unknown): Partial<Cohort> | null {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const c = (report as Record<string, unknown>).cohort;
  return c && typeof c === "object" && !Array.isArray(c) ? (c as Partial<Cohort>) : null;
}

/** `valuesPage` and `valuesCohort`: the page and cohort the values were measured on, when they come with one. */
export function checkWatermarks(
  values: Record<string, number | null | undefined>,
  file: WatermarkFile,
  valuesPage?: Record<string, unknown> | null,
  valuesCohort?: Partial<Cohort> | null,
): CheckResult {
  const breaches: Breach[] = [];
  const missing: string[] = [];
  let checked = 0;
  const withCohort = file.cohort !== undefined || valuesCohort !== undefined;
  const pageDiffers = file.page && valuesPage ? Object.entries(file.page).flatMap(([key, lines]) => (valuesPage[key] === lines ? [] : [{ key, lines, values: valuesPage[key] ?? null }])) : [];
  const pageMatch = !file.page || !valuesPage ? "unknown" : pageDiffers.length ? "different" : "same";
  const cohortCmp = file.cohort && valuesCohort ? compareCohorts(file.cohort, valuesCohort) : null;
  const cohortMatch: "same" | "different" | "unknown" = !file.cohort || !valuesCohort ? "unknown" : cohortCmp!.comparable ? "same" : "different";
  const cohortFields = withCohort ? { cohortMatch, cohortDiffers: cohortCmp?.differences ?? [] } : {};
  if (pageMatch === "different" || cohortMatch === "different") {
    return { ok: false, checked: 0, breaches, missing, pageMatch, pageDiffers, ...cohortFields };
  }
  for (const [metric, mark] of Object.entries(file.marks)) {
    const value = values[metric];
    if (value == null || !Number.isFinite(value)) {
      missing.push(metric);
      continue;
    }
    checked++;
    if (value > mark.max) breaches.push({ metric, value, max: mark.max, overBy: Math.round((value - mark.max) * 10) / 10 });
  }
  return { ok: breaches.length === 0 && missing.length === 0 && checked > 0, checked, breaches, missing, pageMatch, pageDiffers, ...cohortFields };
}
