import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REMINDER_FIRE_RECEIPT_CAPABILITY,
  REMINDER_FIRE_REQUEST_CAPABILITY,
} from "@botiverse/raft-shared/src/apps/reminder/protocol.js";

import {
  type ReminderProtocolConnectionFacts,
  selectReminderDueProtocol,
} from "./protocolTransition.js";

type IsExactKeySet<Actual extends PropertyKey, Expected extends PropertyKey> =
  [Exclude<Actual, Expected>] extends [never]
    ? [Exclude<Expected, Actual>] extends [never]
      ? true
      : false
    : false;

const reminderProtocolConnectionFactsKeysAreClosed: IsExactKeySet<
  keyof ReminderProtocolConnectionFacts,
  "daemonVersion" | "capabilities"
> = true;
void reminderProtocolConnectionFactsKeysAreClosed;

test("Reminder transition routes by daemonVersion", () => {
  const common = {
    capabilities: new Set<string>(),
  };
  assert.equal(
    selectReminderDueProtocol({ ...common, daemonVersion: "1.0.15" }),
    "legacy_fire_attempt",
  );
  assert.equal(
    selectReminderDueProtocol({ ...common, daemonVersion: "1.0.16" }),
    "fire_receipt",
  );
});

test("explicit fire-receipt capability overrides the temporary version fallback", () => {
  assert.equal(
    selectReminderDueProtocol({
      daemonVersion: "1.0.15",
      capabilities: new Set([REMINDER_FIRE_RECEIPT_CAPABILITY]),
    }),
    "fire_receipt",
  );
  assert.equal(
    selectReminderDueProtocol({
      daemonVersion: null,
      capabilities: new Set(),
    }),
    "unknown",
  );
});

test("explicit fire-request capability supersedes every older due wire", () => {
  assert.equal(
    selectReminderDueProtocol({
      daemonVersion: "1.0.15",
      capabilities: new Set([
        REMINDER_FIRE_RECEIPT_CAPABILITY,
        REMINDER_FIRE_REQUEST_CAPABILITY,
      ]),
    }),
    "fire_request",
  );
});
