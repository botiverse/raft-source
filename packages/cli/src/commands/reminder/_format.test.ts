// Snapshot-style tests for agent-facing reminder output format.
// Pins the exact text shape matching MCP chat-bridge formatReminder output.

import { test } from "node:test";
import assert from "node:assert/strict";

import type { ReminderRecurrence } from "@botiverse/raft-shared";
import {
  formatReminder,
  formatReminderScheduled,
  formatReminderList,
  formatReminderCanceled,
} from "./_format.js";

// A fixed clock a day before the fixture's fireAt, so the pre-existing snapshots
// keep meaning "scheduled and still in the future". Passing it explicitly is what
// stops these from silently becoming overdue once real time passes April 2026.
const BEFORE_FIRE = new Date(2026, 3, 21, 9, 30, 0);
const AFTER_FIRE = new Date(2026, 3, 23, 9, 30, 0);

const sample = (overrides: Partial<{
  reminderId: string;
  title: string;
  status: "scheduled" | "fired" | "canceled";
  msgRef: string | null;
  msgPermalink: string | null;
  fireAt: string;
  firedAt: string | null;
  createdAt: string;
  ownerAgentId: string;
  recurrence: ReminderRecurrence | null;
}> = {}) => {
  const fireAt = new Date(2026, 3, 22, 9, 30, 0).toISOString();
  return {
    reminderId: "abcd1234-efgh-5678-ijkl-mnopqrstuvwx",
    ownerAgentId: "agent-1",
    title: "follow up on PR #982",
    fireAt,
    firedAt: null,
    createdAt: new Date().toISOString(),
    status: "scheduled" as const,
    msgRef: null,
    msgPermalink: null,
    recurrence: null,
    ...overrides,
  };
};

test("formatReminder: scheduled without msgRef", () => {
  assert.equal(
    formatReminder(sample(), BEFORE_FIRE),
    `#abcd1234 [scheduled] (one-time) next=${sample().fireAt} "follow up on PR #982"`,
  );
});

test("formatReminder: scheduled with msgRef", () => {
  assert.equal(
    formatReminder(sample({ msgRef: "#engineering:abc12345" }), BEFORE_FIRE),
    `#abcd1234 [scheduled] (one-time) next=${sample().fireAt} "follow up on PR #982" ref=#engineering:abc12345`,
  );
});

test("formatReminder: fired status", () => {
  assert.equal(
    formatReminder(sample({ status: "fired", firedAt: "2026-04-22T01:31:00.000Z" }), BEFORE_FIRE),
    `#abcd1234 [fired] (one-time) fired_at=2026-04-22T01:31:00.000Z "follow up on PR #982"`,
  );
});

test("formatReminder: recurring reminder renders repeat suffix", () => {
  assert.equal(
    formatReminder(sample({ recurrence: { kind: "daily", description: "daily @ 09:00 UTC" } }), BEFORE_FIRE),
    `#abcd1234 [scheduled] (recurring · daily @ 09:00 UTC) next=${sample().fireAt} "follow up on PR #982"`,
  );
});

test("formatReminder: recurring with msgRef renders both", () => {
  assert.equal(
    formatReminder(
      sample({
        msgRef: "#engineering:abc12345",
        recurrence: { kind: "interval", description: "every 15m" },
      }),
      BEFORE_FIRE,
    ),
    `#abcd1234 [scheduled] (recurring · every 15m) next=${sample().fireAt} "follow up on PR #982" ref=#engineering:abc12345`,
  );
});

test("formatReminderScheduled: without warning", () => {
  assert.equal(
    formatReminderScheduled(sample()),
    [
      `Reminder scheduled: #abcd1234 (one-time) "follow up on PR #982"`,
      `Next: ${sample().fireAt}`,
      `(to modify: snooze/update/cancel; raft reminder --help)`,
    ].join("\n"),
  );
});

test("formatReminderScheduled: with warning", () => {
  assert.equal(
    formatReminderScheduled(sample(), "fireAt is >30d in the future"),
    [
      `Reminder scheduled: #abcd1234 (one-time) "follow up on PR #982"`,
      `Next: ${sample().fireAt}`,
      `(to modify: snooze/update/cancel; raft reminder --help)`,
      `Warning: fireAt is >30d in the future`,
    ].join("\n"),
  );
});

test("formatReminderList: empty", () => {
  assert.equal(formatReminderList([], BEFORE_FIRE), "No reminders.");
});

test("formatReminderList: multiple", () => {
  const out = formatReminderList([
    sample({ reminderId: "11111111-aaaa", title: "check CI" }),
    sample({ reminderId: "22222222-bbbb", title: "review PR", status: "fired" }),
  ], BEFORE_FIRE);
  assert.equal(
    out,
    [
      `#11111111 [scheduled] (one-time) next=${sample().fireAt} "check CI"`,
      `#22222222 [fired] (one-time) fired_at=${sample().fireAt} "review PR"`,
    ].join("\n"),
  );
});

test("formatReminderCanceled", () => {
  assert.equal(
    formatReminderCanceled(sample({ status: "canceled" })),
    `Reminder canceled: #abcd1234 [canceled] "follow up on PR #982"`,
  );
});

test("formatReminder: a scheduled row whose next has passed is marked OVERDUE", () => {
  // The incident case. Same row, same timestamp — only the clock moves — and the
  // rendering must stop looking like a healthy waiting reminder.
  assert.equal(
    formatReminder(sample(), AFTER_FIRE),
    `#abcd1234 [scheduled] (one-time) next=${sample().fireAt} OVERDUE "follow up on PR #982"`,
  );
});

test("formatReminder: the same row before its next is not marked", () => {
  // Guards the other direction: the marker must track the clock, not simply
  // decorate every scheduled row.
  assert.ok(!formatReminder(sample(), BEFORE_FIRE).includes("OVERDUE"));
});

test("formatReminder: terminal rows are never marked, however old", () => {
  // `fired` and `canceled` are terminal; a past timestamp on them is expected,
  // so marking them would train people to ignore the marker.
  for (const status of ["fired", "canceled"] as const) {
    assert.ok(
      !formatReminder(sample({ status, firedAt: sample().fireAt }), AFTER_FIRE).includes("OVERDUE"),
      status,
    );
  }
});

test("formatReminder: an unparseable fireAt is not silently reported as on time", () => {
  // Absence of the marker must never be readable as "checked and fine". If the
  // timestamp cannot be parsed we emit nothing rather than guessing a side.
  const out = formatReminder(sample({ fireAt: "not-a-timestamp" }), AFTER_FIRE);
  assert.ok(!out.includes("OVERDUE"));
});

test("formatReminderList: marks only the overdue rows in a mixed list", () => {
  // The actual triage surface: one starved row among healthy ones must be
  // findable without the reader doing date arithmetic per line.
  const out = formatReminderList([
    sample({ reminderId: "11111111-aaaa", title: "overdue one", fireAt: new Date(2026, 3, 20, 9, 0, 0).toISOString() }),
    sample({ reminderId: "22222222-bbbb", title: "still waiting", fireAt: new Date(2026, 3, 25, 9, 0, 0).toISOString() }),
  ], AFTER_FIRE);

  const [first, second] = out.split("\n");
  assert.ok(first?.includes("OVERDUE"), first);
  assert.ok(!second?.includes("OVERDUE"), second);
});
