// Test fixture: every hint builder in RAFT_HINTS, called the ways the shared
// formatters and operations call it, with its golden CLI form (the exact
// string the CLI printed before hints were structured; it must never move)
// and its tool form. hint.test.ts pins both; the SDK checks each `op` against
// the operation's request schema (packages/raft-sdk/src/hints.test.ts).

import { RAFT_HINTS, RAFT_NO_TOOL_WORDING, type RaftHint, type RaftHintBuilderName } from "./hint";

export interface RaftHintSample {
  hint: RaftHint;
  cli: string;
  tool: string;
}

const UUID = "00000000-1111-2222-3333-444444444444";
const MSG = "abcdef12-0000-4000-8000-000000000000";

export const RAFT_HINT_SAMPLES: Record<RaftHintBuilderName, RaftHintSample[]> = {
  messageRead: [
    { hint: RAFT_HINTS.messageRead({ target: "#ops" }), cli: `raft message read --target "#ops"`, tool: `messages_read({ target: "#ops" })` },
    { hint: RAFT_HINTS.messageRead({ target: "#ops", after: 12 }), cli: `raft message read --target "#ops" --after 12`, tool: `messages_read({ target: "#ops", after: 12 })` },
    { hint: RAFT_HINTS.messageRead({ target: "dm:@richard", before: 7 }), cli: `raft message read --target "dm:@richard" --before 7`, tool: `messages_read({ target: "dm:@richard", before: 7 })` },
    { hint: RAFT_HINTS.messageRead({ target: "#ops", before: 7, limit: 100 }), cli: `raft message read --target "#ops" --before 7 --limit 100`, tool: `messages_read({ target: "#ops", before: 7, limit: 100 })` },
    {
      hint: RAFT_HINTS.messageRead({ target: "dm:@richard:1234abcd", around: { shown: "abcdef12", id: MSG } }),
      cli: `raft message read --target "dm:@richard:1234abcd" --around abcdef12`,
      tool: `messages_read({ target: "dm:@richard:1234abcd", around: "${MSG}" })`,
    },
  ],
  messageSearch: [
    {
      hint: RAFT_HINTS.messageSearch({ query: "invoice", cursor: "CUR" }),
      cli: `raft message search --query 'invoice' --sort recent --cursor 'CUR'`,
      tool: `messages_search({ query: "invoice", sort: "recent", cursor: "CUR" })`,
    },
    {
      hint: RAFT_HINTS.messageSearch({ query: "it's due", target: "#billing", sender: "alice", after: "2026-09-16T00:00:00.000+00:00", limit: 5, cursor: "CUR" }),
      cli: `raft message search --query 'it'\\''s due' --target '#billing' --sender 'alice' --after '2026-09-16T00:00:00.000+00:00' --limit 5 --sort recent --cursor 'CUR'`,
      tool: `messages_search({ query: "it's due", target: "#billing", sender: "alice", after: "2026-09-16T00:00:00.000+00:00", limit: 5, sort: "recent", cursor: "CUR" })`,
    },
  ],
  messageSearchQuery: [
    { hint: RAFT_HINTS.messageSearchQuery({ query: "rollout plan" }), cli: `raft message search --query 'rollout plan'`, tool: `messages_search({ query: "rollout plan" })` },
    { hint: RAFT_HINTS.messageSearchQuery({ query: "it's due", target: "#billing" }), cli: `raft message search --query 'it'\\''s due' --target '#billing'`, tool: `messages_search({ query: "it's due", target: "#billing" })` },
  ],
  messageSend: [
    { hint: RAFT_HINTS.messageSend({ target: "#ops:abcd1234" }), cli: `raft message send --target "#ops:abcd1234"`, tool: `messages_send({ target: "#ops:abcd1234", content: … })` },
    { hint: RAFT_HINTS.messageSend({ target: "dm:@name" }), cli: `raft message send --target "dm:@name"`, tool: `messages_send({ target: "dm:@name", content: … })` },
    { hint: RAFT_HINTS.messageSend({ target: "<conversation>" }), cli: "raft message send --target <conversation>", tool: `messages_send({ target: "<conversation>", content: … })` },
    {
      hint: RAFT_HINTS.messageSend({ target: "#ops", attachmentId: "att-1" }),
      cli: `raft message send --target "#ops" --attachment-id att-1`,
      tool: `messages_send({ target: "#ops", attachmentIds: ["att-1"], content: … })`,
    },
    {
      hint: RAFT_HINTS.messageSend({ attachmentId: "att-1" }),
      cli: `raft message send --attachment-id att-1`,
      tool: `messages_send({ attachmentIds: ["att-1"], target: …, content: … })`,
    },
    {
      hint: RAFT_HINTS.messageSend({ target: "#ops", targetConfirmed: true }),
      cli: `raft message send --target "#ops" --target-confirmed`,
      tool: `messages_send({ target: "#ops", targetConfirmed: true, content: … })`,
    },
  ],
  messageSendContent: [
    {
      hint: RAFT_HINTS.messageSendContent({ target: "#ops:abcd1234", content: "<what to look at>: https://app.raft.build/artifacts/pt_abc" }),
      cli: `raft message send --target "#ops:abcd1234" <<<'<what to look at>: https://app.raft.build/artifacts/pt_abc'`,
      tool: `messages_send({ target: "#ops:abcd1234", content: "<what to look at>: https://app.raft.build/artifacts/pt_abc" })`,
    },
    {
      hint: RAFT_HINTS.messageSendContent({ target: "dm:@name", content: "it's up: https://x" }),
      cli: `raft message send --target "dm:@name" <<<'it'\\''s up: https://x'`,
      tool: `messages_send({ target: "dm:@name", content: "it's up: https://x" })`,
    },
  ],
  messageReply: [
    {
      hint: RAFT_HINTS.messageReply({ target: "#proj-x:3f2a1c9e" }),
      cli: `raft message send --target "#proj-x:3f2a1c9e" <<<'<your reply>'`,
      tool: `messages_send({ target: "#proj-x:3f2a1c9e", content: … })`,
    },
  ],
  messageSendName: [{ hint: RAFT_HINTS.messageSendName(), cli: "raft message send", tool: "messages_send({ target: …, content: … })" }],
  messageCheck: [{ hint: RAFT_HINTS.messageCheck(), cli: "raft message check", tool: "inbox_check({})" }],
  inboxList: [
    { hint: RAFT_HINTS.inboxList(), cli: "raft inbox check", tool: "inbox_list({})" },
    { hint: RAFT_HINTS.inboxList({ before: 40 }), cli: "raft inbox check --before 40", tool: "inbox_list({ before: 40 })" },
    { hint: RAFT_HINTS.inboxList({ view: "mentions", before: 40 }), cli: "raft inbox check --view mentions --before 40", tool: `inbox_list({ view: "mentions", before: 40 })` },
  ],
  inboxRead: [
    { hint: RAFT_HINTS.inboxRead({ target: "#ops" }), cli: `raft inbox read --target "#ops"`, tool: `inbox_read({ target: "#ops" })` },
    { hint: RAFT_HINTS.inboxRead({ target: `reminder:${UUID}`, cursor: "c2" }), cli: `raft inbox read --target "reminder:${UUID}" --cursor c2`, tool: `inbox_read({ target: "reminder:${UUID}", cursor: "c2" })` },
  ],
  inboxDismiss: [
    { hint: RAFT_HINTS.inboxDismiss({ target: "app:stamp/pr-1" }), cli: `raft inbox dismiss --target "app:stamp/pr-1"`, tool: RAFT_NO_TOOL_WORDING },
    { hint: RAFT_HINTS.inboxDismiss({ before: "2026-11-01" }), cli: "raft inbox dismiss --before 2026-11-01", tool: RAFT_NO_TOOL_WORDING },
  ],
  reminderAck: [
    { hint: RAFT_HINTS.reminderAck({ id: UUID, revision: "3" }), cli: `raft reminder ack --id ${UUID} --revision 3`, tool: RAFT_NO_TOOL_WORDING },
  ],
  serverInfo: [
    { hint: RAFT_HINTS.serverInfo({ view: "channels" }), cli: "raft server info --channels", tool: `server_info({ view: "channels" })` },
    { hint: RAFT_HINTS.serverInfo({ view: "agents" }), cli: "raft server info --agents", tool: `server_info({ view: "agents" })` },
    { hint: RAFT_HINTS.serverInfo({ view: "humans" }), cli: "raft server info --humans", tool: `server_info({ view: "humans" })` },
    { hint: RAFT_HINTS.serverInfo({ view: "full" }), cli: "raft server info --full", tool: `server_info({ view: "full" })` },
    {
      hint: RAFT_HINTS.serverInfo({ view: "channels", offset: 50, limit: 50, joined: true }),
      cli: "raft server info --channels --offset 50 --limit 50 --joined",
      tool: `server_info({ view: "channels", offset: 50, limit: 50, joined: true })`,
    },
    {
      hint: RAFT_HINTS.serverInfo({ view: "agents", offset: 10, limit: 10, query: "ops" }),
      cli: `raft server info --agents --offset 10 --limit 10 --query "ops"`,
      tool: `server_info({ view: "agents", offset: 10, limit: 10, query: "ops" })`,
    },
    { hint: RAFT_HINTS.serverInfo({ view: "channels", query: true }), cli: "raft server info --channels --query <name>", tool: `server_info({ view: "channels", query: … })` },
    { hint: RAFT_HINTS.serverInfo({ view: "humans", query: true }), cli: "raft server info --humans --query <name>", tool: `server_info({ view: "humans", query: … })` },
  ],
  userInfo: [
    { hint: RAFT_HINTS.userInfo(), cli: "raft user info <name>", tool: "users_info({ name: … })" },
    { hint: RAFT_HINTS.userInfo({ name: "richard", offset: 50, limit: 50 }), cli: "raft user info @richard --offset 50 --limit 50", tool: `users_info({ name: "@richard", offset: 50, limit: 50 })` },
  ],
  channelInfo: [
    { hint: RAFT_HINTS.channelInfo(), cli: "raft channel info <name>", tool: "channels_info({ target: … })" },
    { hint: RAFT_HINTS.channelInfo("#ops"), cli: `raft channel info "#ops"`, tool: `channels_info({ target: "#ops" })` },
  ],
  channelMembers: [{ hint: RAFT_HINTS.channelMembers("#general"), cli: `raft channel members "#general"`, tool: `channels_members({ target: "#general" })` }],
  channelJoinName: [{ hint: RAFT_HINTS.channelJoinName(), cli: "raft channel join", tool: "channels_join({ target: … })" }],
  channelLeaveName: [{ hint: RAFT_HINTS.channelLeaveName(), cli: "raft channel leave", tool: "channels_leave({ target: … })" }],
  channelMuteName: [{ hint: RAFT_HINTS.channelMuteName(), cli: "raft channel mute", tool: "channels_mute({ target: … })" }],
  channelUnmuteName: [{ hint: RAFT_HINTS.channelUnmuteName(), cli: "raft channel unmute", tool: "channels_unmute({ target: … })" }],
  threadUnfollowName: [{ hint: RAFT_HINTS.threadUnfollowName(), cli: "raft thread unfollow", tool: "threads_unfollow({ target: … })" }],
  channelCreateName: [{ hint: RAFT_HINTS.channelCreateName(), cli: "raft channel create", tool: "channels_create({ name: … })" }],
  channelUpdateName: [{ hint: RAFT_HINTS.channelUpdateName(), cli: "raft channel update", tool: "channels_update({ target: … })" }],
  channelAnnouncementSet: [
    { hint: RAFT_HINTS.channelAnnouncementSet({ target: "#ops", artifact: "pt_rules" }), cli: `raft channel update --target "#ops" --announcement pt_rules`, tool: `channels_update({ target: "#ops", announcement: "pt_rules" })` },
    { hint: RAFT_HINTS.channelAnnouncementSet({ target: "#ops" }), cli: `raft channel update --target "#ops" --announcement <artifact>`, tool: `channels_update({ target: "#ops", announcement: … })` },
  ],
  channelAnnouncementClear: [
    { hint: RAFT_HINTS.channelAnnouncementClear({ target: "#ops" }), cli: `raft channel update --target "#ops" --no-announcement`, tool: `channels_update({ target: "#ops", announcement: null })` },
  ],
  channelArchiveName: [{ hint: RAFT_HINTS.channelArchiveName(), cli: "raft channel archive", tool: "channels_archive({ target: … })" }],
  channelUnarchiveName: [{ hint: RAFT_HINTS.channelUnarchiveName(), cli: "raft channel unarchive", tool: "channels_unarchive({ target: … })" }],
  channelAddMemberName: [{ hint: RAFT_HINTS.channelAddMemberName(), cli: "raft channel add-member", tool: "channels_add_member({ target: … })" }],
  channelRemoveMemberName: [{ hint: RAFT_HINTS.channelRemoveMemberName(), cli: "raft channel remove-member", tool: "channels_remove_member({ target: … })" }],
  channelLeaveDeleting: [
    { hint: RAFT_HINTS.channelLeaveDeleting("#scratch"), cli: `raft channel leave --target "#scratch" --delete-if-last`, tool: `channels_leave({ target: "#scratch", deleteIfLast: true })` },
  ],
  channelRemoveMemberDeleting: [
    { hint: RAFT_HINTS.channelRemoveMemberDeleting("#scratch", { user: "@alice" }), cli: `raft channel remove-member --target "#scratch" --user @alice --delete-if-last`, tool: `channels_remove_member({ target: "#scratch", user: "@alice", deleteIfLast: true })` },
    { hint: RAFT_HINTS.channelRemoveMemberDeleting("#scratch", { agent: "@bot" }), cli: `raft channel remove-member --target "#scratch" --agent @bot --delete-if-last`, tool: `channels_remove_member({ target: "#scratch", agent: "@bot", deleteIfLast: true })` },
  ],
  serverUpdateName: [{ hint: RAFT_HINTS.serverUpdateName(), cli: "raft server update", tool: "server_update({})" }],
  taskClaim: [
    { hint: RAFT_HINTS.taskClaim({ target: "#proj-sdk", taskNumber: 3 }), cli: `raft task claim --target "#proj-sdk" --number 3`, tool: `tasks_claim({ target: "#proj-sdk", taskNumbers: [3] })` },
  ],
  taskReply: [
    { hint: RAFT_HINTS.taskReply("#proj-sdk:#7"), cli: `raft task reply "#proj-sdk:#7"`, tool: RAFT_NO_TOOL_WORDING },
    { hint: RAFT_HINTS.messageSend({ target: "dm:@cody:#3" }), cli: `raft task reply "dm:@cody:#3"`, tool: RAFT_NO_TOOL_WORDING },
  ],
  taskRead: [
    { hint: RAFT_HINTS.taskRead({ ref: "#proj-sdk:#7" }), cli: `raft task read "#proj-sdk:#7"`, tool: RAFT_NO_TOOL_WORDING },
    { hint: RAFT_HINTS.messageRead({ target: "#proj-sdk:#7", after: 12 }), cli: `raft task read "#proj-sdk:#7" --after 12`, tool: RAFT_NO_TOOL_WORDING },
    { hint: RAFT_HINTS.messageRead({ target: "#proj-sdk:#7", after: 12, limit: 100 }), cli: `raft task read "#proj-sdk:#7" --after 12 --limit 100`, tool: RAFT_NO_TOOL_WORDING },
    {
      hint: RAFT_HINTS.messageRead({ target: "dm:@cody:#3", around: { shown: "abcdef12", id: MSG } }),
      cli: `raft task read "dm:@cody:#3" --around abcdef12`,
      tool: RAFT_NO_TOOL_WORDING,
    },
  ],
  taskView: [{ hint: RAFT_HINTS.taskView("#proj-sdk:#7"), cli: `raft task view "#proj-sdk:#7"`, tool: RAFT_NO_TOOL_WORDING }],
  taskFollow: [{ hint: RAFT_HINTS.taskFollow("#proj-sdk:#7"), cli: `raft task follow "#proj-sdk:#7"`, tool: RAFT_NO_TOOL_WORDING }],
  taskUnfollow: [{ hint: RAFT_HINTS.taskUnfollow("#proj-sdk:#7"), cli: `raft task unfollow "#proj-sdk:#7"`, tool: RAFT_NO_TOOL_WORDING }],
  taskReplyName: [{ hint: RAFT_HINTS.taskReplyName(), cli: "raft task reply", tool: RAFT_NO_TOOL_WORDING }],
  taskReadName: [{ hint: RAFT_HINTS.taskReadName(), cli: "raft task read", tool: RAFT_NO_TOOL_WORDING }],
  taskUpdateName: [{ hint: RAFT_HINTS.taskUpdateName(), cli: "raft task update", tool: "tasks_update_status({ target: …, taskNumber: …, status: … })" }],
  taskAssignName: [{ hint: RAFT_HINTS.taskAssignName(), cli: "raft task assign", tool: "tasks_assign({ target: …, taskNumber: …, assignee: … })" }],
  taskAssignWithReason: [{
    hint: RAFT_HINTS.taskAssignWithReason({ ref: "#proj-sdk:#51", target: "#proj-sdk", taskNumber: 51, assignee: "@grace" }),
    cli: 'raft task assign "#proj-sdk:#51" @grace --reason "…"',
    tool: 'tasks_assign({ target: "#proj-sdk", taskNumber: 51, assignee: "@grace", reason: … })',
  }],
  taskHandoff: [{ hint: RAFT_HINTS.taskHandoff(), cli: 'raft task assign "#channel:#N" @who --reason "what you need from them"', tool: "tasks_assign({ target: …, taskNumber: …, assignee: …, reason: … })" }],
  taskClaimName: [{ hint: RAFT_HINTS.taskClaimName(), cli: "raft task claim", tool: "tasks_claim({ target: …, taskNumbers: … })" }],
  taskListName: [{ hint: RAFT_HINTS.taskListName(), cli: "raft task list --target <board>", tool: "tasks_list({ target: … })" }],
  taskCreateFromMessage: [
    {
      hint: RAFT_HINTS.taskCreateFromMessage({ target: "#proj-sdk", messageId: "abcdef12", title: "ship it" }),
      cli: `raft task create --target "#proj-sdk" --message-id abcdef12 --title "ship it"`,
      tool: "ask a human via an action card (`actions_prepare`)",
    },
    {
      hint: RAFT_HINTS.taskCreateFromMessage({ target: "#proj-sdk", messageId: "abcdef12", title: "ship it", assignee: "@cody" }),
      cli: `raft task create --target "#proj-sdk" --message-id abcdef12 --title "ship it" --assignee @cody`,
      tool: "ask a human via an action card (`actions_prepare`)",
    },
  ],
  taskCreateWithSource: [
    {
      hint: RAFT_HINTS.taskCreateWithSource({ target: "#proj-sdk" }),
      cli: `raft task create --target "#proj-sdk" --message-id <id> --title "…"`,
      tool: `tasks_create({ target: "#proj-sdk", sourceMessageId: …, tasks: … })`,
    },
  ],
  taskListAll: [
    { hint: RAFT_HINTS.taskListAll("#proj-sdk"), cli: `raft task list --target "#proj-sdk" --status all`, tool: `tasks_list({ target: "#proj-sdk", status: "all" })` },
  ],
  mentionAction: [
    { hint: RAFT_HINTS.mentionAction("notify", UUID), cli: `raft mention notify ${UUID}`, tool: `mentions_notify({ resolutionIds: ["${UUID}"] })` },
    { hint: RAFT_HINTS.mentionAction("add", UUID), cli: `raft mention add ${UUID}`, tool: `mentions_add({ resolutionIds: ["${UUID}"] })` },
  ],
  mentionPending: [{ hint: RAFT_HINTS.mentionPending(), cli: "raft mention pending", tool: "mentions_pending({})" }],
  actionWithdraw: [
    { hint: RAFT_HINTS.actionWithdraw("abcdef12"), cli: "raft action withdraw --message abcdef12", tool: `actions_withdraw({ messageId: "abcdef12" })` },
    { hint: RAFT_HINTS.actionWithdraw(MSG), cli: `raft action withdraw --message ${MSG}`, tool: `actions_withdraw({ messageId: "${MSG}" })` },
  ],
  actionPrepareName: [{ hint: RAFT_HINTS.actionPrepareName(), cli: "raft action prepare", tool: "actions_prepare({ target: …, action: … })" }],
  manualGet: [
    { hint: RAFT_HINTS.manualGet("tasks", { intent: "Track my work with tasks", reason: "Deciding how to claim one" }), cli: `raft manual get tasks --intent "Track my work with tasks" --reason "Deciding how to claim one"`, tool: `manual_get({ topic: "tasks", intent: "Track my work with tasks", reason: "Deciding how to claim one" })` },
    { hint: RAFT_HINTS.manualGet("artifact", { intent: `Ship "v2" for $5`, reason: "It's needed now" }), cli: `raft manual get artifact --intent 'Ship "v2" for $5' --reason "It's needed now"`, tool: `manual_get({ topic: "artifact", intent: "Ship \\"v2\\" for $5", reason: "It's needed now" })` },
  ],
  attachmentView: [
    { hint: RAFT_HINTS.attachmentView(), cli: "raft attachment view", tool: "attachments_download_url({ attachmentId: … })" },
    { hint: RAFT_HINTS.attachmentView("att-1"), cli: "raft attachment view", tool: `attachments_download_url({ attachmentId: "att-1" })` },
  ],
  attachmentDownload: [
    { hint: RAFT_HINTS.attachmentDownload("att-1"), cli: "raft attachment view att-1 --output <path>", tool: `raft.attachments.download({ attachmentId: "att-1" })` },
    { hint: RAFT_HINTS.attachmentDownload("att-1", "<dir>/<file name>"), cli: "raft attachment view att-1 --output <dir>/<file name>", tool: `raft.attachments.download({ attachmentId: "att-1" })` },
  ],
  attachmentUpload: [
    { hint: RAFT_HINTS.attachmentUpload(), cli: "raft attachment upload --path <file> --target <conversation>", tool: "ask a human via an action card (`actions_prepare`)" },
  ],
  artifactRead: [
    { hint: RAFT_HINTS.artifactRead({}), cli: "raft artifact read <artifact>", tool: "artifacts_read({ artifact: … })" },
    { hint: RAFT_HINTS.artifactRead({ artifact: "pt_abc", files: true }), cli: "raft artifact read pt_abc --files", tool: `artifacts_read({ artifact: "pt_abc", files: true })` },
    { hint: RAFT_HINTS.artifactRead({ artifact: "pt_abc", version: 9, files: true }), cli: "raft artifact read pt_abc --rev 9 --files", tool: `artifacts_read({ artifact: "pt_abc", version: 9, files: true })` },
    // A title (an agent may pass one) is quoted as one shell word; an id or an old name stays bare.
    { hint: RAFT_HINTS.artifactRead({ artifact: "Rollout's plan" }), cli: `raft artifact read 'Rollout'\\''s plan'`, tool: `artifacts_read({ artifact: "Rollout's plan" })` },
    { hint: RAFT_HINTS.artifactRead({ artifact: "workspace-prototype" }), cli: "raft artifact read workspace-prototype", tool: `artifacts_read({ artifact: "workspace-prototype" })` },
  ],
  artifactList: [
    { hint: RAFT_HINTS.artifactList({}), cli: "raft artifact list", tool: "artifacts_list({})" },
    { hint: RAFT_HINTS.artifactList({ target: "#ops", cursor: "c2", limit: 5 }), cli: `raft artifact list --target "#ops" --cursor c2 --limit 5`, tool: `artifacts_list({ target: "#ops", cursor: "c2", limit: 5 })` },
    { hint: RAFT_HINTS.artifactList({ query: "rollout's plan", cursor: "c3" }), cli: `raft artifact list --query 'rollout'\\''s plan' --cursor c3`, tool: `artifacts_list({ query: "rollout's plan", cursor: "c3" })` },
  ],
  artifactComments: [
    { hint: RAFT_HINTS.artifactComments({ artifact: "pt_abc" }), cli: "raft artifact comments pt_abc", tool: `artifacts_comments({ artifact: "pt_abc" })` },
    { hint: RAFT_HINTS.artifactComments({ artifact: "pt_abc", review: "rv_1" }), cli: "raft artifact comments pt_abc --review rv_1", tool: `artifacts_comments({ artifact: "pt_abc", review: "rv_1" })` },
    {
      hint: RAFT_HINTS.artifactComments({ artifact: "pt_abc", path: "a.html", all: true, cursor: "c2" }),
      cli: `raft artifact comments pt_abc --path 'a.html' --all --cursor c2`,
      tool: `artifacts_comments({ artifact: "pt_abc", path: "a.html", all: true, cursor: "c2" })`,
    },
  ],
  artifactDownload: [
    { hint: RAFT_HINTS.artifactDownload({ artifact: "pt_abc" }), cli: "raft artifact download pt_abc <path> --output <file>", tool: `artifacts_file_content({ artifact: "pt_abc", path: … })` },
    {
      hint: RAFT_HINTS.artifactDownload({ artifact: "pt_abc", path: "logo.png", version: 9 }),
      cli: `raft artifact download pt_abc 'logo.png' --rev 9 --output <file>`,
      tool: `artifacts_file_content({ artifact: "pt_abc", path: "logo.png", version: 9 })`,
    },
    {
      hint: RAFT_HINTS.artifactDownload({ artifact: "pt_abc", image: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c" }),
      cli: "raft artifact download pt_abc --image 3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c --output <file>",
      tool: `raft.artifacts.commentImage({ artifact: "pt_abc", fileId: "3f2c1a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c" })`,
    },
    {
      hint: RAFT_HINTS.artifactDownload({ artifact: "Q3 report", image: "f1", output: "comment-c_812-1.png" }),
      cli: "raft artifact download 'Q3 report' --image f1 --output comment-c_812-1.png",
      tool: `raft.artifacts.commentImage({ artifact: "Q3 report", fileId: "f1" })`,
    },
  ],
  artifactPull: [
    { hint: RAFT_HINTS.artifactPull({ artifact: "pt_abc" }), cli: "raft artifact pull pt_abc", tool: "ask a human via an action card (`actions_prepare`)" },
    { hint: RAFT_HINTS.artifactPull({ artifact: "pt_abc", dir: "./proto" }), cli: `raft artifact pull pt_abc --dir "./proto"`, tool: "ask a human via an action card (`actions_prepare`)" },
    { hint: RAFT_HINTS.artifactPull({ artifact: "pt_abc", dir: "<new dir>" }), cli: "raft artifact pull pt_abc --dir <new dir>", tool: "ask a human via an action card (`actions_prepare`)" },
    { hint: RAFT_HINTS.artifactPull({ artifact: "Q3 report" }), cli: "raft artifact pull 'Q3 report'", tool: "ask a human via an action card (`actions_prepare`)" },
  ],
  artifactPublish: [
    { hint: RAFT_HINTS.artifactPublish({}), cli: "raft artifact push <dir>", tool: "artifacts_push({ files: … })" },
    { hint: RAFT_HINTS.artifactPublish({ target: "<conversation>" }), cli: "raft artifact push <dir> --target <conversation>", tool: `artifacts_push({ target: "<conversation>", files: … })` },
    { hint: RAFT_HINTS.artifactPublish({ dir: "./q3", target: "#ops" }), cli: `raft artifact push "./q3" --target "#ops"`, tool: `artifacts_push({ target: "#ops", files: … })` },
    {
      hint: RAFT_HINTS.artifactPublish({ dir: "./proto", artifact: "pt_abc", base: 12, deletePath: "old.html" }),
      cli: `raft artifact push "./proto" --delete 'old.html'`,
      tool: `artifacts_push({ artifact: "pt_abc", base: 12, delete: ["old.html"], files: … })`,
    },
  ],
  artifactComment: [
    { hint: RAFT_HINTS.artifactComment({ artifact: "pt_abc", path: "a.html", replyTo: "c_1" }), cli: `raft artifact comment pt_abc --path 'a.html' --reply-to c_1`, tool: `artifacts_comment({ artifact: "pt_abc", path: "a.html", replyTo: "c_1", body: … })` },
    { hint: RAFT_HINTS.artifactComment({ artifact: "pt_abc" }), cli: "raft artifact comment pt_abc", tool: `artifacts_comment({ artifact: "pt_abc", body: … })` },
  ],
  artifactResolve: [
    { hint: RAFT_HINTS.artifactResolve({ artifact: "pt_abc", comment: "c_1", note: "Done in v13" }), cli: `raft artifact resolve pt_abc c_1 --note "Done in v13"`, tool: `artifacts_resolve({ artifact: "pt_abc", comment: "c_1", note: "Done in v13" })` },
    { hint: RAFT_HINTS.artifactResolve({ artifact: "pt_abc", comment: "c_1" }), cli: "raft artifact resolve pt_abc c_1", tool: `artifacts_resolve({ artifact: "pt_abc", comment: "c_1" })` },
  ],
  artifactReopen: [
    { hint: RAFT_HINTS.artifactReopen({ artifact: "pt_abc", comment: "c_1" }), cli: "raft artifact reopen pt_abc c_1", tool: `artifacts_reopen({ artifact: "pt_abc", comment: "c_1" })` },
  ],
  artifactReview: [
    { hint: RAFT_HINTS.artifactReview({ artifact: "pt_abc" }), cli: "raft artifact review pt_abc", tool: `artifacts_review({ artifact: "pt_abc", comments: … })` },
    { hint: RAFT_HINTS.artifactReview({ artifact: "pt_abc", version: 3 }), cli: "raft artifact review pt_abc --rev 3", tool: `artifacts_review({ artifact: "pt_abc", version: 3, comments: … })` },
  ],
  artifactFollow: [
    { hint: RAFT_HINTS.artifactFollow({ artifact: "pt_abc" }), cli: "raft artifact follow pt_abc", tool: `artifacts_follow({ artifact: "pt_abc" })` },
  ],
  artifactUnfollow: [
    { hint: RAFT_HINTS.artifactUnfollow({ artifact: "pt_abc" }), cli: "raft artifact unfollow pt_abc", tool: `artifacts_unfollow({ artifact: "pt_abc" })` },
  ],
  artifactMove: [
    { hint: RAFT_HINTS.artifactMove({ artifact: "pt_abc" }), cli: "raft artifact move pt_abc --to server", tool: `artifacts_move({ artifact: "pt_abc", to: "server" })` },
  ],
  artifactSave: [
    { hint: RAFT_HINTS.artifactSave({ attachmentId: "att-1" }), cli: "raft artifact save att-1", tool: `artifacts_save_attachment({ attachmentId: "att-1" })` },
  ],
  artifactCheck: [
    { hint: RAFT_HINTS.artifactCheck({ artifact: "pt_abc" }), cli: "raft artifact check pt_abc", tool: `artifacts_check({ artifact: "pt_abc" })` },
    { hint: RAFT_HINTS.artifactCheck({ artifact: "pt_abc", wait: true }), cli: "raft artifact check pt_abc --wait", tool: `artifacts_check({ artifact: "pt_abc", wait: true })` },
    { hint: RAFT_HINTS.artifactCheck({ artifact: "pt_abc", version: 12, wait: true }), cli: "raft artifact check pt_abc --rev 12 --wait", tool: `artifacts_check({ artifact: "pt_abc", version: 12, wait: true })` },
    { hint: RAFT_HINTS.artifactCheck({ artifact: "Q3 report", version: 2 }), cli: "raft artifact check 'Q3 report' --rev 2", tool: `artifacts_check({ artifact: "Q3 report", version: 2 })` },
  ],
};
