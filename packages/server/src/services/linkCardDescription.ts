import { canonicalJsonSha256 } from "../lib/canonicalJson";
import type { StrictJsonValue } from "../lib/strictJson";

// The confirmation description an App returns from prepare (protocol v3.2.3
// §5.2), and its prepared_digest (§10). The input is the output of
// parseStrictJson, so duplicate keys and lone surrogates never reach here. A
// description holds only strings, objects and arrays, so JCS has no number
// ambiguity; numbers, booleans and null are refused here, not by the parser
// (Tenny 77619123). This check is hand-written instead of zod so that nothing is
// dropped, defaulted or rebuilt: the object that passes is the object that is
// hashed, `__proto__` key in `terms` included.
//
// Lengths count Unicode code points, so Go and TypeScript agree (Tenny
// 6e486d6c). Only the limits §5.2 defines are checked: target, execution_mode
// and execution_account are any string, and terms is any { string: string }
// of at most 16 entries; the 32 KiB body cap bounds the rest. read_at is
// strict RFC 3339 UTC on a real calendar date and is hashed exactly as sent,
// never reformatted.

export type LinkCardDescriptionRow = { label: string; value: string };

export type LinkCardPreparedDescription = {
  prepared_action_id: string;
  action_id: string;
  business_revision: string;
  locale: string;
  read_at: string;
  title: string;
  body?: string;
  rows?: LinkCardDescriptionRow[];
  fine_print?: string;
  confirm_label: string;
  cancel_label: string;
  target?: string;
  execution_mode?: string;
  execution_account?: string;
  terms?: Record<string, string>;
};

export type LinkCardDescriptionResult =
  | { ok: true; description: LinkCardPreparedDescription }
  | { ok: false; reason: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTION_ID = /^[a-z][a-z0-9_]{0,31}$/;
const BCP47 = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const RFC3339_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

const MAX_ROWS = 8;
const MAX_TERMS = 16;

type Rule = { required: boolean; check: (value: StrictJsonValue) => string | null };

const codePoints = (value: string) => {
  let n = 0;
  for (const _ of value) n++;
  return n;
};
const text = (min: number, max: number) => (value: StrictJsonValue) =>
  typeof value === "string" && codePoints(value) >= min && codePoints(value) <= max ? null : `must be a string of ${min}-${max} characters`;
const pattern = (re: RegExp, max: number, what: string) => (value: StrictJsonValue) =>
  typeof value === "string" && codePoints(value) <= max && re.test(value) ? null : `must be ${what}`;
const anyString = (value: StrictJsonValue) => (typeof value === "string" ? null : "must be a string");

const isObject = (value: StrictJsonValue): value is { [key: string]: StrictJsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only strings, objects and arrays, at any depth: what every digested description is made of. */
export function isLinkCardStringTree(value: StrictJsonValue): boolean {
  if (typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isLinkCardStringTree);
  return isObject(value) && Object.values(value).every(isLinkCardStringTree);
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/**
 * Strict RFC 3339 UTC (`Z`, optional fraction) on a date that exists; no leap
 * seconds. Leap years are computed (proleptic Gregorian, as Go's time.Date),
 * not via Date.UTC, which maps years 0-99 to 1900-1999: 0000-02-29 exists.
 */
export function isStrictRfc3339Utc(value: string): boolean {
  const m = RFC3339_UTC.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= days;
}

const RULES: Record<keyof LinkCardPreparedDescription, Rule> = {
  prepared_action_id: { required: true, check: pattern(UUID, 36, "a lowercase UUID") },
  action_id: { required: true, check: pattern(ACTION_ID, 32, "an action id") },
  // §5.2 sets no maximum here, but the handle carries the card's
  // business_revision, which is at most 512 long: a longer one could never
  // match it, so it is refused here.
  business_revision: { required: true, check: text(1, 512) },
  locale: { required: true, check: pattern(BCP47, 35, "a BCP 47 language tag") },
  read_at: {
    required: true,
    check: (value) => typeof value === "string" && isStrictRfc3339Utc(value) ? null : "must be an RFC 3339 UTC timestamp",
  },
  title: { required: true, check: text(1, 120) },
  body: { required: false, check: text(0, 500) },
  rows: {
    required: false,
    check: (value) => {
      if (!Array.isArray(value) || value.length > MAX_ROWS) return `must be an array of at most ${MAX_ROWS} rows`;
      for (const row of value) {
        if (!isObject(row)) return "each row must be an object";
        const keys = Object.keys(row);
        if (keys.length !== 2 || !Object.hasOwn(row, "label") || !Object.hasOwn(row, "value")) return "each row must be exactly { label, value }";
        if (text(1, 40)(row.label) || text(1, 200)(row.value)) return "row label must be 1-40 and value 1-200 characters";
      }
      return null;
    },
  },
  fine_print: { required: false, check: text(0, 500) },
  confirm_label: { required: true, check: text(1, 40) },
  cancel_label: { required: true, check: text(1, 40) },
  target: { required: false, check: anyString },
  execution_mode: { required: false, check: anyString },
  execution_account: { required: false, check: anyString },
  terms: {
    required: false,
    check: (value) => {
      if (!isObject(value)) return "must be an object of strings";
      const items = Object.values(value);
      if (items.length > MAX_TERMS) return `must have at most ${MAX_TERMS} entries`;
      return items.every((item) => typeof item === "string") ? null : "must be an object of strings";
    },
  },
};

export function parseLinkCardPreparedDescription(value: StrictJsonValue): LinkCardDescriptionResult {
  if (!isObject(value)) return { ok: false, reason: "description must be an object" };
  if (!isLinkCardStringTree(value)) return { ok: false, reason: "description may hold only strings, objects and arrays" };
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(RULES, key)) return { ok: false, reason: `unknown field ${JSON.stringify(key)}` };
  }
  for (const [key, rule] of Object.entries(RULES) as [string, Rule][]) {
    if (!Object.hasOwn(value, key)) {
      if (rule.required) return { ok: false, reason: `missing field ${key}` };
      continue;
    }
    const problem = rule.check(value[key]);
    if (problem) return { ok: false, reason: `${key} ${problem}` };
  }
  return { ok: true, description: value as unknown as LinkCardPreparedDescription };
}

/** prepared_digest: lowercase hex SHA-256 of the JCS form of the parsed description (protocol v3.2.3 §10). */
export function linkCardPreparedDigest(description: LinkCardPreparedDescription): string {
  return canonicalJsonSha256(description);
}
