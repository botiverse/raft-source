import { test } from "vitest";
import assert from "node:assert/strict";

import {
  computeNextFire,
  formatRecurrence,
  isSupportedRecurrence,
  parseRecurrenceString,
  type Recurrence,
} from "./recurrence.js";

function rule(r: Recurrence): Recurrence {
  return r;
}

test("parse: every:15m", () => {
  const r = parseRecurrenceString("every:15m");
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.recurrence, { version: 1, rule: { kind: "interval", seconds: 900 } });
});

test("parse: every:2h", () => {
  const r = parseRecurrenceString("every:2h");
  if (!r.ok) throw new Error(r.error);
  assert.deepEqual(r.recurrence, { version: 1, rule: { kind: "interval", seconds: 7200 } });
});

test("parse: every:1d", () => {
  const r = parseRecurrenceString("every:1d");
  if (!r.ok) throw new Error(r.error);
  assert.deepEqual(r.recurrence, { version: 1, rule: { kind: "interval", seconds: 86400 } });
});

test("parse: rejects sub-30s intervals (guard against tight re-fire loops)", () => {
  // Only second-level granularity is rejected because we accept m/h/d only,
  // but a small-minute-value check is still useful — every:0m parses to 0s.
  const zero = parseRecurrenceString("every:0m");
  assert.equal(zero.ok, false);
});

test("parse: rejects non-m/h/d units", () => {
  const r = parseRecurrenceString("every:15s");
  assert.equal(r.ok, false);
});

test("parse: daily@09:00", () => {
  const r = parseRecurrenceString("daily@09:00");
  if (!r.ok) throw new Error(r.error);
  assert.deepEqual(r.recurrence.rule, { kind: "daily", hour: 9, minute: 0, tz: "UTC" });
});

test("parse: daily rejects 25:00", () => {
  const r = parseRecurrenceString("daily@25:00");
  assert.equal(r.ok, false);
});

test("parse: daily respects caller tz", () => {
  const r = parseRecurrenceString("daily@09:00", "America/Los_Angeles");
  if (!r.ok) throw new Error(r.error);
  assert.equal((r.recurrence.rule as { tz: string }).tz, "America/Los_Angeles");
});

test("parse: weekly single day", () => {
  const r = parseRecurrenceString("weekly:mon@09:00");
  if (!r.ok) throw new Error(r.error);
  assert.deepEqual(r.recurrence.rule, { kind: "weekly", days: ["mon"], hour: 9, minute: 0, tz: "UTC" });
});

test("parse: weekly multi-day is sorted sun-first and deduped", () => {
  const r = parseRecurrenceString("weekly:fri,mon,Mon@09:00");
  if (!r.ok) throw new Error(r.error);
  assert.deepEqual((r.recurrence.rule as { days: string[] }).days, ["mon", "fri"]);
});

test("parse: weekly rejects unknown dow", () => {
  const r = parseRecurrenceString("weekly:mun@09:00");
  assert.equal(r.ok, false);
});

test("parse: weekly rejects empty dow list", () => {
  const r = parseRecurrenceString("weekly:@09:00");
  assert.equal(r.ok, false);
});

test("parse: unknown form", () => {
  const r = parseRecurrenceString("cron:0 9 * * *");
  assert.equal(r.ok, false);
});

test("parse: empty string", () => {
  const r = parseRecurrenceString("");
  assert.equal(r.ok, false);
});

test("computeNextFire: interval stays drift-free", () => {
  const r: Recurrence = { version: 1, rule: { kind: "interval", seconds: 900 } };
  const from = new Date("2026-04-23T10:00:00.000Z");
  const next = computeNextFire(r, from);
  assert.equal(next.toISOString(), "2026-04-23T10:15:00.000Z");
});

test("computeNextFire: daily UTC, fires today if not yet past", () => {
  const r: Recurrence = { version: 1, rule: { kind: "daily", hour: 9, minute: 0, tz: "UTC" } };
  const from = new Date("2026-04-23T08:30:00.000Z");
  const next = computeNextFire(r, from);
  assert.equal(next.toISOString(), "2026-04-23T09:00:00.000Z");
});

test("computeNextFire: daily UTC, rolls to tomorrow when past", () => {
  const r: Recurrence = { version: 1, rule: { kind: "daily", hour: 9, minute: 0, tz: "UTC" } };
  const from = new Date("2026-04-23T09:30:00.000Z");
  const next = computeNextFire(r, from);
  assert.equal(next.toISOString(), "2026-04-24T09:00:00.000Z");
});

test("computeNextFire: daily NY tz, DST spring-forward (2026-03-08 02:00→03:00)", () => {
  // US spring-forward 2026 is March 8. 2:30am local "doesn't exist" that day.
  // For daily@02:30 NY, the fire before DST lands at 06:30Z (EST = UTC-5),
  // and after DST the same wall-clock fires at 06:30Z (EDT = UTC-4 → 02:30 local).
  // Note: 2:30am on March 8 is skipped; we pick up the next valid instant.
  const r: Recurrence = { version: 1, rule: { kind: "daily", hour: 2, minute: 30, tz: "America/New_York" } };
  // Just before DST transition (fire at 2:30 EST on March 7)
  const beforeDst = new Date("2026-03-07T00:00:00.000Z");
  const n1 = computeNextFire(r, beforeDst);
  assert.equal(n1.toISOString(), "2026-03-07T07:30:00.000Z");
  // After the transition, next daily@02:30 on March 9 lands at 06:30Z (EDT = UTC-4)
  const afterDst = new Date("2026-03-08T20:00:00.000Z");
  const n2 = computeNextFire(r, afterDst);
  assert.equal(n2.toISOString(), "2026-03-09T06:30:00.000Z");
});

test("computeNextFire: weekly picks nearest matching day after from", () => {
  // 2026-04-23 is a Thursday. weekly:mon,fri@09:00 UTC from Thursday 10:00 → Friday 09:00.
  const r: Recurrence = {
    version: 1,
    rule: { kind: "weekly", days: ["mon", "fri"], hour: 9, minute: 0, tz: "UTC" },
  };
  const from = new Date("2026-04-23T10:00:00.000Z");
  const next = computeNextFire(r, from);
  assert.equal(next.toISOString(), "2026-04-24T09:00:00.000Z");
});

test("computeNextFire: weekly wraps to next week", () => {
  // From Friday 10:00 with only mon listed → next Monday 09:00.
  const r: Recurrence = {
    version: 1,
    rule: { kind: "weekly", days: ["mon"], hour: 9, minute: 0, tz: "UTC" },
  };
  const from = new Date("2026-04-24T10:00:00.000Z"); // Friday
  const next = computeNextFire(r, from);
  assert.equal(next.toISOString(), "2026-04-27T09:00:00.000Z"); // Monday
});

test("formatRecurrence: interval humanized", () => {
  assert.equal(formatRecurrence(rule({ version: 1, rule: { kind: "interval", seconds: 900 } })), "every 15m");
  assert.equal(formatRecurrence(rule({ version: 1, rule: { kind: "interval", seconds: 3600 } })), "every 1h");
  assert.equal(formatRecurrence(rule({ version: 1, rule: { kind: "interval", seconds: 86400 } })), "every 1d");
});

test("formatRecurrence: daily/weekly carry tz", () => {
  const d = formatRecurrence(rule({ version: 1, rule: { kind: "daily", hour: 9, minute: 0, tz: "UTC" } }));
  assert.equal(d, "daily at 09:00 UTC");
  const w = formatRecurrence(
    rule({ version: 1, rule: { kind: "weekly", days: ["mon", "fri"], hour: 9, minute: 0, tz: "UTC" } }),
  );
  assert.equal(w, "weekly mon,fri at 09:00 UTC");
});

test("isSupportedRecurrence: fails forward-compat unknown kind", () => {
  assert.equal(isSupportedRecurrence(null), false);
  assert.equal(isSupportedRecurrence({}), false);
  assert.equal(isSupportedRecurrence({ version: 1, rule: { kind: "cron", expression: "0 9 * * *" } }), false);
  assert.equal(isSupportedRecurrence({ version: 2, rule: { kind: "interval", seconds: 60 } }), false);
  assert.equal(isSupportedRecurrence({ version: 1, rule: { kind: "interval", seconds: 900 } }), true);
});
