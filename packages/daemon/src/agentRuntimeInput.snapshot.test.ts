import { expect, test } from "vitest";
import { exampleMessage } from "./axExampleFixtures.js";
import { getDriver } from "./drivers/index.js";
import {
  formatBoundedStartupUnreadSuffix,
  formatInboxUpdateRuntimeInput,
  formatOtherUnreadChannelsSuffix,
  formatResumeEmptyPrompt,
  formatResumeUnreadSummaryPrompt,
} from "./agentRuntimeInput.js";

// These are turn inputs, not standing instructions. Snapshot their complete
// output here; APM tests own whether a lifecycle transition selects them.
// Local runs update these inline values; review and commit the diff. CI only checks.
const directDriver = {
  ...getDriver("codex"), supportsStdinNotification: true, busyDeliveryMode: "direct" as const,
};
const notificationDriver = { ...directDriver, busyDeliveryMode: "notification" as const };
const restartDriver = { ...directDriver, supportsStdinNotification: false, busyDeliveryMode: "none" as const };

test("empty-resume copy is independent of runtime delivery mode", () => {
  expect(formatResumeEmptyPrompt(directDriver)).toMatchInlineSnapshot(`"No new messages while you were away. Nothing to do — just stop."`);
  expect(formatResumeEmptyPrompt(notificationDriver)).toMatchInlineSnapshot(`"No new messages while you were away. Nothing to do — just stop."`);
  expect(formatResumeEmptyPrompt(restartDriver)).toMatchInlineSnapshot(`"No new messages while you were away. Nothing to do — just stop."`);
});

test("unread-resume copy describes the current catch-up work", () => {
  const unread = { "#general": 2, "dm:@bob": 1 };
  const persistent = formatResumeUnreadSummaryPrompt(unread, directDriver);
  expect(formatResumeUnreadSummaryPrompt(unread, notificationDriver)).toBe(persistent);
  expect(persistent).toMatchInlineSnapshot(`
    "You have unread messages from while you were offline:
    - #general: 2 unread
    - dm:@bob: 1 unread

    Use \`raft message read\` to catch up on the channels listed above, then stop. Read each listed channel at most once unless a read fails. Do NOT call \`raft message check\` in this mode. If the history reveals a direct request, assignment, @mention, review request, or task clearly addressed to you, switch into active handling instead of stopping: reply using \`raft message send --target <exact target>\` and claim the relevant task with \`raft task claim\` before starting work. Otherwise, do NOT send any message in this mode."
  `);
  expect(formatResumeUnreadSummaryPrompt(unread, restartDriver)).toMatchInlineSnapshot(`
    "You have unread messages from while you were offline:
    - #general: 2 unread
    - dm:@bob: 1 unread

    Use \`raft message read\` to catch up on the channels listed above, then stop. Read each listed channel at most once unless a read fails. Do NOT call \`raft message check\` in this mode. If the history reveals a direct request, assignment, @mention, review request, or task clearly addressed to you, switch into active handling instead of stopping: reply using \`raft message send --target <exact target>\` and claim the relevant task with \`raft task claim\` before starting work. Otherwise, do NOT send any message in this mode."
  `);
});

test("inbox notices carry reading guidance across runtime delivery modes", () => {
  const notice = formatInboxUpdateRuntimeInput([exampleMessage], directDriver, 1);
  expect(formatInboxUpdateRuntimeInput([exampleMessage], notificationDriver, 1)).toBe(notice);
  expect(formatInboxUpdateRuntimeInput([exampleMessage], restartDriver, 1)).toBe(notice);
  expect(notice).toMatchInlineSnapshot(`
    "[Raft inbox notice:
    Inbox update: 1 unread message total; 1 changed target
    #general  pending: 1 message · first msg=00000000 · latest sender @richard · latest msg=00000000
    ]
    These messages have not been read. Choose when to read them with \`raft message check\` or \`raft message read --target <target>\`; deferring them does not establish that there is no work."
  `);
});

test("unread suffixes render every supplied target and count", () => {
  const unread = { "#general": 12, "dm:@bob": 1 };
  expect(formatOtherUnreadChannelsSuffix(unread)).toMatchInlineSnapshot(`
    "

    You also have unread messages in other channels:
    - #general: 12 unread
    - dm:@bob: 1 unread

    Use the inbox/read commands at a natural breakpoint if you choose to inspect those targets."
  `);
  expect(formatBoundedStartupUnreadSuffix(unread)).toMatchInlineSnapshot(`
    "

    Some unread channels may not be included in this bounded startup batch:
    - #general: 12 unread
    - dm:@bob: 1 unread

    Use the inbox/read commands at a natural breakpoint if you choose to inspect those targets."
  `);
});

test.each([undefined, {}])("missing unread targets emit no suffix (%j)", (unread) => {
  expect(formatOtherUnreadChannelsSuffix(unread)).toBe("");
  expect(formatBoundedStartupUnreadSuffix(unread)).toBe("");
});
