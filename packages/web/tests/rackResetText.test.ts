import assert from "node:assert/strict";
import { createIntl } from "react-intl";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
import type { Locale } from "../src/i18n/locale";
import { mergedMessages } from "../src/i18n/messages";
import { rackReset, rackResetText, resetWhen } from "../src/components/machine/rack/rackResetText";

// A used-up rack cell says when it resets (#triage:#292): minutes under an
// hour, hours under 48 hours, then days, counted down (floor, at least 1);
// nothing when the reset isn't known or has passed (the cell says "Used up").

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function at(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function intl(locale: Locale) {
  return createIntl({ locale, defaultLocale: DEFAULT_LOCALE, messages: mergedMessages(locale) });
}

test("rack reset: minutes under an hour, hours under 48 hours, then days, counted down", () => {
  assert.deepEqual(rackReset(at(30_000), NOW), { unit: "minute", count: 1 }, "the last minute reads 1m, never 0m");
  assert.deepEqual(rackReset(at(45 * MINUTE + 59_000), NOW), { unit: "minute", count: 45 });
  assert.deepEqual(rackReset(at(HOUR - 1), NOW), { unit: "minute", count: 59 });
  assert.deepEqual(rackReset(at(HOUR), NOW), { unit: "hour", count: 1 });
  assert.deepEqual(rackReset(at(3 * HOUR + 59 * MINUTE), NOW), { unit: "hour", count: 3 });
  assert.deepEqual(rackReset(at(48 * HOUR - 1), NOW), { unit: "hour", count: 47 });
  assert.deepEqual(rackReset(at(48 * HOUR), NOW), { unit: "day", count: 2 });
  assert.deepEqual(rackReset(at(3 * DAY - 1), NOW), { unit: "day", count: 2 });
  assert.deepEqual(rackReset(at(6 * DAY + 5 * HOUR), NOW), { unit: "day", count: 6 });
});

test("rack reset: none when it isn't known or has passed", () => {
  assert.equal(rackReset(null, NOW), null);
  assert.equal(rackReset(undefined, NOW), null);
  assert.equal(rackReset("not a date", NOW), null);
  assert.equal(rackReset(at(0), NOW), null);
  assert.equal(rackReset(at(-5 * MINUTE), NOW), null);
  assert.equal(rackResetText(at(-5 * MINUTE), intl("en"), NOW), null);
  assert.equal(rackResetText(null, intl("zh-cn"), NOW), null);
});

test("rack reset words: short in the cell, the same count in full for its name", () => {
  assert.deepEqual(rackResetText(at(45 * MINUTE), intl("zh-cn"), NOW), { short: "45m 后重置", full: "已用完 · 45 分钟后恢复" });
  assert.deepEqual(rackResetText(at(3 * HOUR + 30 * MINUTE), intl("zh-cn"), NOW), { short: "3h 后重置", full: "已用完 · 3 小时后恢复" });
  assert.deepEqual(rackResetText(at(2 * DAY + HOUR), intl("zh-cn"), NOW), { short: "2d 后重置", full: "已用完 · 2 天后恢复" });
  assert.deepEqual(rackResetText(at(45 * MINUTE), intl("en"), NOW), { short: "Back in 45m", full: "Used up · back in 45 minutes" });
  assert.deepEqual(rackResetText(at(3 * HOUR), intl("en"), NOW), { short: "Back in 3h", full: "Used up · back in 3 hours" });
  assert.deepEqual(rackResetText(at(DAY + 23 * HOUR), intl("en"), NOW), { short: "Back in 47h", full: "Used up · back in 47 hours" });
  assert.deepEqual(rackResetText(at(5 * DAY), intl("en"), NOW), { short: "Back in 5d", full: "Used up · back in 5 days" });
  assert.deepEqual(rackResetText(at(HOUR), intl("en"), NOW), { short: "Back in 1h", full: "Used up · back in 1 hour" });
});

test("the usage-limit notification says when it is back relatively, as the card and cell do: \"Back in 6 days\"", () => {
  const when = resetWhen(at(6 * DAY + 3 * HOUR), "en", NOW);
  assert.equal(when, "in 6 days");
  assert.equal(
    intl("en").formatMessage({ id: "layout.systemNotifications.usageLimitBodyWithReset" }, { count: 2, computer: "oak-linux", reset: when }),
    "2 agents on oak-linux may pause. Back in 6 days.",
  );
  assert.equal(resetWhen(at(-MINUTE), "en", NOW), null, "past: no reset to name");
  assert.equal(resetWhen(null, "en", NOW), null);
});
