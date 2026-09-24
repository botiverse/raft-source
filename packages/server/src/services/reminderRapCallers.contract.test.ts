import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const onboardingSource = readFileSync(
  new URL("./onboardingService.ts", import.meta.url),
  "utf8",
);
const wikiSource = readFileSync(
  new URL("./wikiService.ts", import.meta.url),
  "utf8",
);
const appOwnedReminderServiceSource = readFileSync(
  new URL("../apps/reminder/service.ts", import.meta.url),
  "utf8",
);

const RETIRED_SERVER_REMINDER_CONSUMERS = [
  /platformBridge/,
  /prepareTimerCancellation/,
  /hardDeleteAfterTimer/,
  /cancelAfterTimer/,
  /\brearm\(/,
  /deliverFireWake/,
  /deliverBuiltInDueEvent/,
  /prepareSystemMessageForOrderedDelivery/,
  /broadcastSystemMessage\([^)]*(?:reminder|Reminder)/s,
];

test("Onboarding and Wiki publish committed lifecycle revisions to the Computer", () => {
  assert.match(onboardingSource, /import \{ createAppReminder \} from "\.\.\/apps\/reminder\/crud\.js";/);
  assert.match(onboardingSource, /await input\.deps\.createSchedule\(/);
  assert.match(onboardingSource, /pushReminderUpsert\(row\.ownerAgentId, row\)/);

  assert.match(wikiSource, /createAppReminder\(/);
  assert.match(wikiSource, /cancelAppReminder\(/);
  assert.match(wikiSource, /replaceAppReminder\(/);
  assert.match(wikiSource, /flushWikiScheduleSync\(reminderChanges, input\.syncReminder\)/);
  assert.match(wikiSource, /\{ kind: "upsert", row \}/);
  assert.match(wikiSource, /kind: "cancel"/);
});

test("Wiki sync happens only after its database transaction commits", () => {
  const transactionStart = wikiSource.indexOf("const result = await db.transaction(async (tx) => {");
  const transactionEnd = wikiSource.indexOf("\n  });", transactionStart);
  const syncStart = wikiSource.indexOf(
    "await flushWikiScheduleSync(reminderChanges, input.syncReminder);",
    transactionStart,
  );
  assert.notEqual(transactionStart, -1);
  assert.notEqual(transactionEnd, -1);
  assert.notEqual(syncStart, -1);
  assert.ok(
    syncStart > transactionEnd,
    "canonical Reminder sync must run only after the Wiki setup transaction closes",
  );
  const transactionBody = wikiSource.slice(transactionStart, transactionEnd);
  assert.doesNotMatch(transactionBody, /await input\.syncReminder/);
});

test("retired Server timer, derived-DM, message, and direct-wake consumers stay absent", () => {
  const combined = `${onboardingSource}\n${wikiSource}\n${appOwnedReminderServiceSource}`;
  for (const consumer of RETIRED_SERVER_REMINDER_CONSUMERS) {
    assert.doesNotMatch(combined, consumer);
  }
  assert.doesNotMatch(appOwnedReminderServiceSource, /getDueReminders/);
});
