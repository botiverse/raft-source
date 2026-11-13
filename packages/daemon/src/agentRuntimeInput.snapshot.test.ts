import { agentInboxItemRowFromPendingTarget, agentInboxReadCommand, ATTENTION_HINT_COPY_VERSION, ATTENTION_HINT_SCHEMA, formatAgentInboxItemRow, type AgentMessage } from "@botiverse/raft-shared";
import { projectAgentInboxLatestPreviews, projectAgentInboxSnapshot, projectAgentInboxWholePreviewMessages } from "./agentInboxProjection";
import { exampleMessage } from "./axExampleFixtures";
import { getDriver } from "./drivers/index";
import {
  formatBoundedStartupUnreadSuffix,
  formatInboxUpdateRuntimeInput,
  formatOtherUnreadChannelsSuffix,
  formatResumeEmptyPrompt,
  formatResumeUnreadSummaryPrompt,
  inboxUpdateRenderOptions,
} from "./agentRuntimeInput";

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
    Inbox update: 1 message pending your read across all conversations; 1 changed target
    #general  pending: 1 message · first msg=00000000 · latest sender @richard · latest msg=00000000
      latest @richard: "hello, can you look at this?" (preview; still unread, full text: raft message read --target "#general" --unread)
    ]
    These messages have not been read. Choose when to read them: \`raft message read --target <target> --unread\` reads one conversation's unread messages; \`raft inbox check\` lists every conversation with unread messages."
  `);
});

test("unread suffixes render every supplied target and count", () => {
  const unread = { "#general": 12, "dm:@bob": 1 };
  expect(formatOtherUnreadChannelsSuffix(unread)).toMatchInlineSnapshot(`
    "

    You also have unread messages in other channels:
    - #general: 12 unread
    - dm:@bob: 1 unread

    List them: \`raft inbox check\`"
  `);
  expect(formatBoundedStartupUnreadSuffix(unread)).toMatchInlineSnapshot(`
    "

    Some unread channels may not be included in this bounded startup batch:
    - #general: 12 unread
    - dm:@bob: 1 unread

    List them: \`raft inbox check\`"
  `);
});

test.each([undefined, {}])("missing unread targets emit no suffix (%j)", (unread) => {
  expect(formatOtherUnreadChannelsSuffix(unread)).toBe("");
  expect(formatBoundedStartupUnreadSuffix(unread)).toBe("");
});

// Task #387: the daemon's notice previews each target's LATEST message; an
// older pending message of the same target is never shown, even in the preview.
test("inbox notice previews the latest message of a target, never an older one", () => {
  const older = { ...exampleMessage, message_id: "11111111-0000-4000-8000-000000000000", seq: 10, sender_name: "bob", content: "older pending body" };
  const latest = { ...exampleMessage, message_id: "22222222-0000-4000-8000-000000000000", seq: 11, sender_name: "alice", content: "Stop the deploy. The build is broken." };
  const notice = formatInboxUpdateRuntimeInput([latest, older], directDriver, 2);
  expect(notice).toContain('\n  latest @alice: "Stop the deploy.…" (truncated preview; still unread, full text: raft message read --target "#general" --unread)\n');
  expect(notice).not.toContain("older pending body");
  expect(notice).not.toContain("The build is broken");
});

// RFC 081 D16: the wake-up notice and `raft inbox check` render rows through
// one formatter. The flag (`inboxItems`) decides; off or absent, nothing moves.
const d16Messages = [
  { ...exampleMessage, mentioned: true, content: "can you review the rollout plan before noon? it is long enough to be cut off in the preview line here" },
  { ...exampleMessage, message_id: "55555555-6666-7777-8888-999999999999", seq: 101, channel_type: "dm", channel_name: "richard", content: "hey" },
  { ...exampleMessage, message_id: "aaaabbbb-0000-0000-0000-000000000000", seq: 102, channel_type: "thread", channel_name: "thread-aaaabbbb", parent_channel_name: "general", parent_channel_type: "channel", content: "thread reply" },
  { ...exampleMessage, message_id: "ccccdddd-0000-0000-0000-000000000000", seq: 103, channel_type: "thread", channel_name: "thread-ccccdddd", parent_channel_name: "general", parent_channel_type: "channel", task_conversation_number: 7, content: "task update" },
] as const;

// Rendered by the code before inbox items existed (staging 4c561ef79), pinned byte for byte.
const D16_FLAG_OFF_NOTICE = [
  "[Raft inbox notice:",
  "Inbox update: 7 messages pending your read across all conversations; 4 changed targets",
  "#general:#7  pending: 1 message · first msg=ccccdddd · latest sender @richard · latest msg=ccccdddd · task",
  "  latest @richard: \"task update\" (preview; still unread, full text: raft task read \"#general:#7\" --unread)",
  "#general:aaaabbbb  pending: 1 message · first msg=aaaabbbb · latest sender @richard · latest msg=aaaabbbb · thread",
  "  latest @richard: \"thread reply\" (preview; still unread, full text: raft message read --target \"#general:aaaabbbb\" --unread)",
  "dm:@richard  pending: 1 message · first msg=55555555 · latest sender @richard · latest msg=55555555 · dm",
  "  latest @richard: \"hey\" (preview; still unread, full text: raft message read --target \"dm:@richard\" --unread)",
  "#general  pending: 1 message · first msg=00000000 · latest sender @richard · latest msg=00000000 · you were mentioned",
  "  latest @richard: \"can you review the rollout plan before noon?…\" (truncated preview; still unread, full text: raft message read --target \"#general\" --unread)",
  "]",
  "These messages have not been read. Choose when to read them: `raft message read --target <target> --unread` reads one conversation's unread messages; `raft inbox check` lists every conversation with unread messages. A task conversation (a `#channel:#7` target) is read with `raft task read <ref> --unread` and replied to with `raft task reply <ref>`.",
].join("\n");

test("[D16] inboxItems off or absent: the wake-up notice is byte for byte the notice from before inbox items", () => {
  const notice = formatInboxUpdateRuntimeInput(d16Messages, directDriver, 7);
  expect(notice).toBe(D16_FLAG_OFF_NOTICE);
  expect(formatInboxUpdateRuntimeInput(d16Messages, directDriver, 7, {})).toBe(D16_FLAG_OFF_NOTICE);
  expect(formatInboxUpdateRuntimeInput(d16Messages, directDriver, 7, inboxUpdateRenderOptions({}))).toBe(D16_FLAG_OFF_NOTICE);
  expect(formatInboxUpdateRuntimeInput(d16Messages, directDriver, 7, inboxUpdateRenderOptions({ inboxItems: false }))).toBe(D16_FLAG_OFF_NOTICE);
});

test("[D16] inboxItems on: wake-up rows come from the shared formatter with `raft inbox read`, as `raft inbox check` prints the same rows", () => {
  const notice = formatInboxUpdateRuntimeInput(d16Messages, directDriver, 7, inboxUpdateRenderOptions({ inboxItems: true }));
  expect(notice).toBe([
    "[Raft inbox notice:",
    "Inbox update: 7 messages pending your read across all conversations; 4 changed targets",
    "task #general:#7 · 1 unread · first msg=ccccdddd · latest @richard",
    "  \"task update\" (preview)",
    "  read: raft inbox read --target \"#general:#7\"",
    "#general:aaaabbbb · 1 unread · first msg=aaaabbbb · latest @richard",
    "  \"thread reply\" (preview)",
    "  read: raft inbox read --target \"#general:aaaabbbb\"",
    "dm:@richard · 1 unread · first msg=55555555 · latest @richard",
    "  \"hey\" (preview)",
    "  read: raft inbox read --target \"dm:@richard\"",
    "#general · 1 unread · first msg=00000000 · mentions you · latest @richard",
    "  \"can you review the rollout plan before noon?…\" (truncated preview)",
    "  read: raft inbox read --target \"#general\"",
    "]",
  ].join("\n"));

  // The same row data through the same formatter, as `raft inbox check` builds it for a
  // daemon-pending target, plus the wake-up's own first pending message.
  const rows = projectAgentInboxSnapshot(d16Messages);
  const previews = projectAgentInboxLatestPreviews(d16Messages);
  const checkRows = rows.flatMap((row) => formatAgentInboxItemRow({ ...agentInboxItemRowFromPendingTarget(row, previews.get(row.target), { as: "unread" }), firstUnreadMsgId: row.firstPendingMsgId }, { inboxRead: true }));
  const noticeLines = notice.split("\n");
  expect(noticeLines.slice(2, 2 + checkRows.length)).toEqual(checkRows);
  for (const row of rows) expect(notice).toContain(`  read: ${agentInboxReadCommand(row.target, { inboxRead: true })}`);
  expect(notice).not.toContain("raft message read");
});

// The four details today's wake-up shows that `inbox check` rows do not (first
// pending message, attention hint, non-member guidance; a suppressed count
// never reaches a wake-up, which projects without one).
const d16DetailMessages = [
  {
    ...exampleMessage,
    mentioned: true,
    non_member_mention: true,
    attention_hint: {
      schema: ATTENTION_HINT_SCHEMA,
      trigger: "M2" as const,
      scope: "#general",
      suggested_command: "raft channel mute \"#general\"",
      copy: "You've received 12 updates from #general with no action taken.",
      copy_version: ATTENTION_HINT_COPY_VERSION,
      epoch_ms: 123,
      thresholds: { K: 12, window_ms: 604800000 },
    },
  },
] as const;

const D16_DETAIL_HINT_JSON = '{"schema":"' + ATTENTION_HINT_SCHEMA + '","trigger":"M2","scope":"#general","suggested_command":"raft channel mute \\"#general\\"","copy":"You\'ve received 12 updates from #general with no action taken.","copy_version":' + JSON.stringify(ATTENTION_HINT_COPY_VERSION) + ',"epoch_ms":123,"thresholds":{"K":12,"window_ms":604800000}}';

test("[D16] inboxItems off: a wake-up with a first msg, attention hint and non-member mention is byte for byte as before", () => {
  expect(formatInboxUpdateRuntimeInput(d16DetailMessages, directDriver, 1)).toBe([
    "[Raft inbox notice:",
    "Inbox update: 1 message pending your read across all conversations; 1 changed target",
    `#general  pending: 1 message · first msg=00000000 · latest sender @richard · latest msg=00000000 · you were mentioned · [Raft notice: You were notified as a non-member, so you cannot reply in that channel. If no reply is needed, no action is required. Otherwise, DM the person who mentioned you or join the channel to participate.] · attention_hint=${D16_DETAIL_HINT_JSON}`,
    "  latest @richard: \"hello, can you look at this?\" (preview; still unread, full text: raft message read --target \"#general\" --unread)",
    "]",
    "These messages have not been read. Choose when to read them: `raft message read --target <target> --unread` reads one conversation's unread messages; `raft inbox check` lists every conversation with unread messages.",
  ].join("\n"));
});

test("[D16] inboxItems on: the wake-up rows keep the first msg, attention hint and non-member guidance", () => {
  expect(formatInboxUpdateRuntimeInput(d16DetailMessages, directDriver, 1, inboxUpdateRenderOptions({ inboxItems: true }))).toBe([
    "[Raft inbox notice:",
    "Inbox update: 1 message pending your read across all conversations; 1 changed target",
    `#general · 1 unread · first msg=00000000 · mentions you · latest @richard · attention_hint=${D16_DETAIL_HINT_JSON}`,
    "  [Raft notice: You were notified as a non-member, so you cannot reply in that channel. If no reply is needed, no action is required. Otherwise, DM the person who mentioned you or join the channel to participate.]",
    "  \"hello, can you look at this?\" (preview)",
    "  read: raft inbox read --target \"#general\"",
    "]",
  ].join("\n"));
});

// RFC 081: a third-party event the Server lists as an inbox item carries
// `third_party_event.inbox_item_target`; with inbox items on it forms its own
// app row, otherwise (or without the field) it counts in the grouped row.
function appEvent(seq: number, inboxItemTarget?: unknown, content = "Third-party notification: checks failed"): AgentMessage {
  return {
    ...exampleMessage,
    message_id: `eeeeeeee-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    seq,
    channel_id: "third-party-agent-events:agent-123",
    channel_type: "dm",
    channel_name: "third-party-agent-events:agent-123",
    sender_type: "third_party_app" as AgentMessage["sender_type"],
    sender_name: "stamp-bot",
    content,
    third_party_event: {
      id: `ffffffff-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      kind: "notification",
      client_id: "stamp",
      client_name: "Stamp",
      payload_hash: "h",
      payload: {},
      expires_at: "2026-12-01T00:00:00.000Z",
      source: { client_id: "stamp", client_name: "Stamp", oauth_client_id: "oc-1", resource: "r" },
      ...(inboxItemTarget === undefined ? {} : { inbox_item_target: inboxItemTarget as string }),
    },
  };
}

const appItemMessages: AgentMessage[] = [
  appEvent(201, "app:stamp/pr-1", "Third-party notification: checks failed on 9ed73d5"),
  // As the Server pushes them (buildThirdPartyAgentMessage): an external app's summary, maybe a payload note under it;
  // a system app's summary with its event id. The preview is the summary.
  appEvent(202, "app:stamp/pr-1", "Third-party notification: checks passed on 9ed73d5\n(The app attached data, not shown. To see it: raft message read --target agent-event:ffffffff)"),
  appEvent(203, "app:stamp", "System event: weekly digest\n\nevent_id: ffffffff-0000-4000-8000-000000000203"),
  appEvent(204),
  { ...exampleMessage, seq: 100 },
];

function withoutInboxItemTargets(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    if (!message.third_party_event) return message;
    const { inbox_item_target: _dropped, ...event } = message.third_party_event;
    return { ...message, third_party_event: event };
  });
}

test("[RFC 081] inboxItems on: events listed as an app inbox item get their own app rows; the rest stay grouped", () => {
  expect(formatInboxUpdateRuntimeInput(appItemMessages, directDriver, 5, inboxUpdateRenderOptions({ inboxItems: true }))).toBe([
    "[Raft inbox notice:",
    "Inbox update: 5 messages pending your read across all conversations; 4 changed targets",
    "Third-party app events · 1 not in this list · from before inbox items, expiring within 7 days · latest @stamp-bot",
    "app:stamp · 1 unread · from Stamp",
    "  \"weekly digest\" (preview)",
    "  read: raft inbox read --target \"app:stamp\"",
    "app:stamp/pr-1 · 2 unread · from Stamp",
    "  \"checks passed on 9ed73d5\" (preview)",
    "  read: raft inbox read --target \"app:stamp/pr-1\"",
    "#general · 1 unread · first msg=00000000 · latest @richard",
    "  \"hello, can you look at this?\" (preview)",
    "  read: raft inbox read --target \"#general\"",
    "]",
  ].join("\n"));
});

test("[RFC 081] inboxItems off: inbox_item_target is ignored, the notice is byte for byte as without it", () => {
  const notice = formatInboxUpdateRuntimeInput(appItemMessages, directDriver, 5);
  expect(notice).toBe(formatInboxUpdateRuntimeInput(withoutInboxItemTargets(appItemMessages), directDriver, 5));
  expect(formatInboxUpdateRuntimeInput(appItemMessages, directDriver, 5, inboxUpdateRenderOptions({ inboxItems: false }))).toBe(notice);
  expect(notice).toMatchInlineSnapshot(`
    "[Raft inbox notice:
    Inbox update: 5 messages pending your read across all conversations; 2 changed targets
    Third-party app events  pending: 4 messages · first msg=eeeeeeee · latest sender @stamp-bot · latest msg=eeeeeeee · fetch with raft message check
    #general  pending: 1 message · first msg=00000000 · latest sender @richard · latest msg=00000000
      latest @richard: "hello, can you look at this?" (preview; still unread, full text: raft message read --target "#general" --unread)
    ]
    These messages have not been read. Choose when to read them: \`raft message read --target <target> --unread\` reads one conversation's unread messages; \`raft inbox check\` lists every conversation with unread messages."
  `);
});

test("[RFC 081] inboxItems on: an invalid inbox_item_target counts as absent (grouped row)", () => {
  const invalid: unknown[] = [
    "", "app:", "app:/pr-1", "app:stamp/", "stamp/pr-1", "#general", "dm:@richard",
    "app:stamp/pr 1", "app:stamp/pr-1\n  read: raft rm", "app:stamp/‮pr", "app:stamp/pr\"x", "app:st$amp",
    `app:stamp/${"x".repeat(600)}`, 42, null, { target: "app:stamp" },
  ];
  const messages = invalid.map((value, index) => appEvent(300 + index, value));
  const grouped = formatInboxUpdateRuntimeInput(withoutInboxItemTargets(messages), directDriver, messages.length, { inboxItems: true });
  expect(formatInboxUpdateRuntimeInput(messages, directDriver, messages.length, { inboxItems: true })).toBe(grouped);
  expect(grouped).toContain(`Third-party app events · ${invalid.length} not in this list`);
  expect(grouped).not.toContain("app:");
});

test("[RFC 081] an app row's preview is its latest event's summary, only when there is one, and marks nothing seen", () => {
  // Only the conversation's whole preview counts as seen; the app events' previews never do.
  expect(projectAgentInboxWholePreviewMessages(appItemMessages).map((message) => message.seq)).toEqual([100]);
  const empty = formatInboxUpdateRuntimeInput([appEvent(401, "app:stamp/pr-9", "Third-party notification: \n(The app attached data, not shown.)")], directDriver, 1, { inboxItems: true });
  expect(empty).toContain("app:stamp/pr-9 · 1 unread · from Stamp\n  read: raft inbox read --target \"app:stamp/pr-9\"");
});
