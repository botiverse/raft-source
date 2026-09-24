import assert from "node:assert/strict";
import test from "node:test";
import { createIntl, createIntlCache } from "react-intl";
import {
  formatReminderReceiptContentTitle,
  formatReminderReceiptTime,
  formatReminderReceiptTooltip,
  splitReminderReceiptFireAtTokens,
} from "../src/utils/reminderReceiptTime";
import { en } from "../src/i18n/messages/en";

const formatMessage = createIntl(
  { locale: "en", defaultLocale: "en", messages: en },
  createIntlCache(),
).formatMessage;

test("formats same-day reminder receipts using local 'today at' phrasing", () => {
  const now = new Date("2026-04-25T08:00:00.000Z");
  const rendered = formatReminderReceiptTime("2026-04-25T08:49:00.000Z", formatMessage, now);
  assert.match(rendered, /^today at /);
});

test("formats next-day reminder receipts using local 'tomorrow at' phrasing", () => {
  const now = new Date("2026-04-25T08:00:00.000Z");
  const rendered = formatReminderReceiptTime("2026-04-26T08:49:00.000Z", formatMessage, now);
  assert.match(rendered, /^tomorrow at /);
});

test("formats reminder receipt clock and day labels with the selected UI time settings", () => {
  const now = new Date("2026-05-14T23:30:00.000Z");
  const rendered = formatReminderReceiptTime("2026-05-15T00:15:00.000Z", formatMessage, now, {
    locale: "en-US",
    timeFormat: "24h",
    timeZone: "America/Los_Angeles",
  });
  assert.equal(rendered, "today at 17:15");
});

test("formats later reminder receipts with month/day phrasing", () => {
  const now = new Date("2026-04-25T08:00:00.000Z");
  const rendered = formatReminderReceiptTime("2026-04-28T08:49:00.000Z", formatMessage, now);
  assert.match(rendered, /^[A-Z][a-z]{2} \d{1,2} at /);
});

test("tooltip formatter falls back to the original value for invalid dates", () => {
  assert.equal(formatReminderReceiptTooltip("not-a-date"), "not-a-date");
});

test("splits server reminder receipt fire-at tokens for system message rendering", () => {
  assert.deepEqual(
    splitReminderReceiptFireAtTokens(
      '@agent scheduled a reminder - fires <span data-reminder-fire-at="2026-05-07T01:00:00.000Z">2026-05-07 01:00 UTC</span>',
    ),
    [
      { type: "text", value: "@agent scheduled a reminder - fires " },
      { type: "reminderFireAt", value: "2026-05-07T01:00:00.000Z" },
    ],
  );
});

test("formats reminder receipt content titles without leaking raw span tokens", () => {
  const title = formatReminderReceiptContentTitle(
    '@agent scheduled a reminder - fires <span data-reminder-fire-at="2026-05-07T01:00:00.000Z">2026-05-07 01:00 UTC</span>',
  );

  assert.match(title, /^@agent scheduled a reminder - fires /);
  assert.doesNotMatch(title, /<span/);
  assert.doesNotMatch(title, /data-reminder-fire-at/);
  assert.doesNotMatch(title, /2026-05-07 01:00 UTC/);
});
