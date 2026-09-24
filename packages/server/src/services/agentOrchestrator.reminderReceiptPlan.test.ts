import assert from "node:assert/strict";
import { test } from "vitest";

import {
  planReminderFireReceiptAction,
  shouldEmitReminderFiredLifecycle,
} from "./agentOrchestrator.js";

const base = {
  reminderExists: true,
  reminderServerMatchesAgent: true,
  reminderOwnerAgentId: "agent-a",
  reminderVersion: 7,
  reminderStatus: "scheduled",
  receiptAgentId: "agent-a",
  receiptVersion: 7,
} as const;

test("current Reminder fire receipt converges only for the current owner", () => {
  assert.equal(planReminderFireReceiptAction(base), "converge-current");
  assert.equal(
    planReminderFireReceiptAction({ ...base, receiptAgentId: "agent-b" }),
    "reject",
  );
});

test("historical Reminder fire receipt survives a later owner rebind on the same Server", () => {
  assert.equal(
    planReminderFireReceiptAction({
      ...base,
      reminderOwnerAgentId: "agent-b",
      reminderVersion: 8,
      receiptAgentId: "agent-a",
      receiptVersion: 7,
    }),
    "ack-historical",
  );
});

test("historical Reminder fire receipt cannot cross the Server boundary", () => {
  assert.equal(
    planReminderFireReceiptAction({
      ...base,
      reminderServerMatchesAgent: false,
      reminderOwnerAgentId: "agent-b",
      reminderVersion: 8,
      receiptAgentId: "agent-a",
      receiptVersion: 7,
    }),
    "reject",
  );
});

test("unknown-recurrence convergence re-pushes without claiming a fired lifecycle", () => {
  assert.equal(shouldEmitReminderFiredLifecycle({ fired: false }), false);
  assert.equal(shouldEmitReminderFiredLifecycle({ fired: true }), true);
});
