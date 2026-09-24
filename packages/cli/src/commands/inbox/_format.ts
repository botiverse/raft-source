import {
  formatAgentInboxAppItems as sharedFormatAgentInboxAppItems,
  formatAgentInboxFullSnapshot as sharedFormatAgentInboxFullSnapshot,
  formatAgentInboxSnapshot as sharedFormatAgentInboxSnapshot,
} from "@botiverse/raft-shared";
export type {
  AgentInboxTargetRow as InboxTargetRow,
  AgentInboxAppItem as InboxAppItem,
  AgentInboxItem as InboxItem,
} from "@botiverse/raft-shared";

import { axSurface } from "../../core/renderer.js";

// The shared inbox projections render both here and inside daemon inbox
// notices; on the CLI side they are reply surfaces in their own right.
export const formatInboxSnapshot = axSurface(
  "Inbox snapshot (shared with daemon inbox rendering).",
  sharedFormatAgentInboxSnapshot,
  {
    examples: [{ args: [[{ target: "#general", pendingCount: 2, firstPendingMsgId: "00000000-1111-2222-3333-444444444444", latestMsgId: "55555555-6666-7777-8888-999999999999", latestSenderName: "richard", latestSenderType: "human", flags: ["mention"] }]] }],
  },
);
export const formatAgentInboxFullSnapshot = axSurface(
  "Full inbox snapshot incl. app items.",
  sharedFormatAgentInboxFullSnapshot,
  {
    examples: [{ args: [{ messageRows: [{ target: "#general", pendingCount: 1, flags: [] }], appItems: [{ source: "app", itemId: "it-1", appId: "reminder", notificationClass: "fire", sourceRef: { kind: "reminder", id: "76d9397d" }, primaryAction: { kind: "run_command", commandId: "reminder.ack" }, actionCli: "raft reminder log", retention: "until_explicit_ack", title: "Reminder fired" }], formatMessageRows: (rows) => rows.map((r) => r.target).join("\n") }] }],
  },
);
export const formatAgentInboxAppItems = axSurface(
  "App-sourced inbox item rows.",
  sharedFormatAgentInboxAppItems,
  {
    examples: [{ args: [[{ source: "app", itemId: "it-1", appId: "reminder", notificationClass: "fire", sourceRef: { kind: "reminder", id: "76d9397d" }, primaryAction: { kind: "run_command", commandId: "reminder.ack" }, actionCli: "raft reminder log", retention: "until_explicit_ack", title: "Reminder fired" }]] }],
  },
);
