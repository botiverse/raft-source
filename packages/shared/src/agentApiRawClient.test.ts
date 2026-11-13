import assert from "node:assert/strict";

import {
  agentApiContract,
  type AgentApiRouteKey,
} from "./agentApiContract";
import { asChannelId, asMessageId } from "./brandedIds";
import {
  buildAgentApiRawRoutePath,
  createAgentApiRawClient,
  type AgentApiRawTransport,
  type AgentApiRawTransportRequest,
} from "./agentApiRawClient";
import type { CoreAgentApiRouteKey } from "./agentApiContract";
import { firstPartyAppAgentApiSamples } from "./apps/agentApiSamples";
const raftbenchRunId = "00000000-0000-4000-8000-000000000001";
const raftbenchCoverage = { from: "2026-10-17T00:00:00Z", to: "2026-10-18T00:00:00Z", fetchedMessages: 0, exhausted: true, stopReason: "window_end", notRead: ["Tool outcomes not read"] };
const raftbenchContext = { runId: raftbenchRunId, revision: 1, sourceText: "Coverage: no synthetic source messages", sources: [], coverage: raftbenchCoverage, nextCursor: null };
const raftbenchReport = { runId: raftbenchRunId, revision: 1, status: "complete", patterns: [], gaps: [] };
const raftbenchReceipt = { runId: raftbenchRunId, revision: 1, status: "complete", receiptId: "00000000-0000-4000-8000-000000000002", coverage: raftbenchCoverage };
const coreValidResponses: Record<CoreAgentApiRouteKey, unknown> = {
  raftbenchFindings: { revision: 1, findings: [], total: 0, nextCursor: null, coverage: { historyFrom: null, scannedThroughAt: null, note: "Synthetic coverage" } },
  raftbenchContext,
  raftbenchSubmit: raftbenchReceipt,
  feedbackLocatorIngest: {
    status: "accepted",
    receipt_id: "00000000-0000-4000-8000-000000000001",
    report_id: "00000000-0000-4000-8000-000000000002",
    duplicate: false,
  },
  feedbackLocatorList: { locators: [] },
  events: {
    events: [],
    last_seen_msgId: null,
    last_seen_seq: null,
    reply_target: null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: false,
  },
  historyRead: {
    messages: [],
    has_more: false,
    has_older: false,
    has_newer: false,
  },
  knowledgeGet: {
    ok: true,
    docId: "doc-1",
    topicOrPath: "index",
    docVersion: "v1",
    docState: "published",
    contentType: "text/markdown",
    content: "# Index",
  },
  contextSearch: { ok: true, runtime: "claude", model: null, entryCount: 3, answer: { kind: "search", total: 0, matches: [] } },
  contextRead: { ok: true, runtime: "claude", model: null, entryCount: 3, answer: { kind: "read", found: false } },
  knowledgeSearch: {
    ok: true,
    query: "preview before merge",
    scope: "recipes",
    results: [{
      slug: "recipes/technique/preview-env",
      title: "Spin up a preview environment",
      firstScreen: "# Spin up a preview environment",
    }],
  },
  managedMcpTools: { catalogVersion: 1, tools: [] },
  managedMcpCall: { content: [{ type: "text", text: "found" }], isError: false },
  messageSend: {
    ok: true,
    state: "sent",
    messageId: "msg-1",
  },
  messageSendV2: {
    ok: true,
    state: "sent",
    messageId: "msg-v2",
    unresolvedMentionHandles: [],
  },
  messageResolve: {
    message: {
      message_id: "msg-1",
      timestamp: "2026-06-28T02:00:00.000Z",
    },
  },
  messageSearch: {
    results: [],
    hasMore: false,
  },
  messageReactionAdd: {
    message_id: "msg-1",
    timestamp: "2026-06-28T02:00:00.000Z",
  },
  messageReactionRemove: {
    message_id: "msg-1",
    timestamp: "2026-06-28T02:00:00.000Z",
  },
  messageCardUpdate: { ok: true, messageId: "msg-1", revision: 2, updatedAt: "2026-11-03T12:03:00.000Z", unnotifiedMentionHandles: [], notice: "Updating notifies no one. To tell someone, send a new message." },
  channelJoin: {
    ok: true,
  },
  channelLeave: {
    ok: true,
  },
  channelMute: {
    activityMuted: true,
    muteFromSeq: 42,
  },
  channelUnmute: {
    activityMuted: false,
    muteFromSeq: null,
  },
  channelArchive: {
    id: "channel-1",
    name: "engineering",
    type: "channel",
    archivedAt: "2026-07-11T00:00:00.000Z",
    archivedByUserId: null,
  },
  channelUnarchive: {
    id: "channel-1",
    name: "engineering",
    type: "channel",
    archivedAt: null,
    archivedByUserId: null,
  },
  channelCreate: { id: "chan-2", name: "design", type: "private", description: "Design reviews" },
  channelUpdate: { id: "chan-2", name: "design", type: "private", description: "Design reviews" },
  channelMemberAdd: { ok: true, alreadyMember: false, channelId: "chan-2", member: { type: "agent", id: "agent-2", name: "Kirby" } },
  channelMemberRemove: { ok: true, wasMember: true, channelId: "chan-2", member: { type: "agent", id: "agent-2", name: "Kirby" } },
  channelMembers: {
    channel: { ref: "#wg-raft-cli", type: "channel" },
    agents: [],
    humans: [],
  },
  resolveChannel: {
    channelId: "channel-1",
  },
  threadFollow: { ok: true, following: true, changed: true },
  threadUnfollow: {
    ok: true,
  },
  threadList: {
    threads: [{
      target: "#wg-raft-cli:abcd1234",
      threadChannelId: "11111111-2222-4333-8444-555555555555",
      parentChannelRef: "#wg-raft-cli",
      parentMessageId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      parentMessageShortId: "abcd1234",
      followedAt: "2026-09-10T12:00:00.000Z",
      reason: "mentioned",
      doneAt: null,
    }],
  },
  assistantOwnerInbox: {
    owner: { userId: "33333333-3333-4333-8333-333333333333" },
    filter: "unread",
    items: [{
      kind: "thread",
      channelId: "44444444-4444-4444-8444-444444444444",
      channelName: "proj-runtime",
      channelType: "channel",
      parentChannelId: "55555555-5555-4555-8555-555555555555",
      parentMessageId: "22222222-2222-4222-8222-222222222222",
      unread: 2,
      hasMention: true,
      latestAt: "2026-09-10T12:00:00.000Z",
      latestSenderName: "richard",
      latestPreview: "ship it",
      firstUnreadMessageId: "66666666-6666-4666-8666-666666666666",
    }],
    hasMore: false,
    nextOffset: null,
  },
  assistantOwnerMessages: {
    owner: { userId: "33333333-3333-4333-8333-333333333333" },
    channelId: "55555555-5555-4555-8555-555555555555",
    messages: [],
    hasMore: false,
    hasOlder: false,
    hasNewer: false,
  },
  assistantOwnerArtifact: { owner: { userId: "33333333-3333-4333-8333-333333333333" }, artifact: { id: "pt_abc12345", url: "https://app.raft.build/artifacts/pt_abc12345", title: "Plan", description: null, home: { kind: "conversation", conversation: { id: "55555555-5555-4555-8555-555555555555", type: "channel", target: "#design" } }, author: { type: "user", name: "ada" }, version: 1, latestVersion: 1, commentCount: 0, position: 3, createdAt: "2026-11-12T00:00:00.000Z", updatedAt: "2026-11-12T00:00:00.000Z" }, versions: [], files: [{ path: "index.html", kind: "html", sizeBytes: 12, entry: true }], file: { kind: "text", path: "index.html", entry: true, contentType: "text/html", sizeBytes: 12, content: "<h1>Plan</h1>", truncated: false }, comments: { items: [], olderCursor: null, newestPosition: 3 } },
  assistantOwnerArtifactPublish: { artifact: { id: "pt_abc12345", url: "https://app.raft.build/artifacts/pt_abc12345", version: 1, unchanged: false, homeConversationId: "55555555-5555-4555-8555-555555555555" } },
  assistantOwnerActivity: { owner: { userId: "33333333-3333-4333-8333-333333333333" }, items: [], hasMore: false, nextSince: null },
  assistantOwnerResolve: { id: "88888888-8888-4888-8888-888888888888", type: "human", name: "ada" },
  assistantCheckStateImport: { briefToday: "due" },
  assistantNotify: { outcome: "sent", shown: 1, more: 0, dropped: [] },
  assistantContactRules: { rules: [{ id: "99999999-9999-4999-8999-999999999999", effect: "mute", subject: { kind: "dms" }, anytime: false, until: null, note: null, createdAt: "2026-10-21T00:00:00.000Z", line: "99999999 · mute your DMs" }], settings: { quiet: { from: "22:00", to: "08:00" }, brief: { at: "08:00" }, timezone: "UTC" }, lines: { quiet: "quiet 22:00-08:00 UTC", brief: "morning brief at 08:00 UTC", defaults: "By default…" } },
  assistantContactRuleAdd: { rule: { id: "99999999-9999-4999-8999-999999999999", effect: "mute", subject: { kind: "dms" }, anytime: false, until: null, note: null, createdAt: "2026-10-21T00:00:00.000Z", line: "99999999 · mute your DMs" }, confirmation: "I won't tell you about your DMs anymore.", updated: false },
  assistantContactRuleRemove: { confirmation: "Removed: mute your DMs." },
  assistantContactSettings: { settings: { quiet: null }, confirmation: "Quiet hours are off (UTC)." },
  assistantOwnerSettings: { settings: { theme: "space", storedTheme: "space", themeDecor: true, themeDecorShown: true, displayLanguage: "en", preferredTimezone: "Europe/Berlin" } },
  assistantOwnerSettingsUpdate: { settings: { theme: "space", storedTheme: "space", themeDecor: true, themeDecorShown: true, displayLanguage: "en", preferredTimezone: "Europe/Berlin" }, changed: ["preferredTimezone"] },
  assistantContactRulesImport: { imported: 1, updated: 0, skipped: 0, legacy: 0 },
  assistantToldRecord: { recorded: 1, skipped: 0 },
  assistantToldList: { items: [], hasMore: false, nextCursor: null },
  assistantSendAsOwner: { messageId: "77777777-7777-4777-8777-777777777777", channelId: "55555555-5555-4555-8555-555555555555" },
  assistantForwardAsOwner: { results: [{ to: "#design", channelId: "55555555-5555-4555-8555-555555555555", status: "sent", messageId: "77777777-7777-4777-8777-777777777777" }] },
  assistantSearchForwardTargets: { targets: [{ label: "#design", to: "#design" }] },
  inboxList: {
    view: "unread",
    items: [{
      target: "dm:@richard",
      kind: "dm",
      unread: 3,
      mentions: 0,
      lastReadSeq: 1199,
      activitySeq: 1203,
      latestSenderName: "richard",
      latestAt: "2026-09-10T12:00:00.000Z",
    }],
    hasMore: false,
    nextBeforeSeq: null,
    totals: { conversations: 1, dms: 1, mentions: 0 },
  },
  inboxRead: { target: "app:stamp/pr-13754", kind: "app", entries: [{ id: "77777777-7777-4777-8777-777777777777", senderType: "third_party_app", senderName: "Stamp", content: "checks failed", mentioned: false }], unreadBefore: 3, remaining: 2, remainingCapped: false, consumed: false, nextCursor: null, app: { key: "stamp", name: "Stamp" }, related: { target: "#proj-workspace:#232" } },
  inboxDismiss: { dismissed: 2, conversations: 1, appItems: 1, skippedNeedsAck: 1, earliestActivityAt: "2026-11-01T00:00:00.000Z", remaining: 0 },
  serverUpdate: {
    id: "server-1",
    name: "Renamed Server",
    hideHumansFromMembers: true,
    avatarUrl: null,
  },
  serverLabs: { serverId: "server-1", accessEnabled: true, version: 3, canManageAccess: false, canManageEnrollments: true, labs: [{ labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel", state: "open", enrolled: false, effective: false, updatedAt: null }] },
  serverLabsAccess: { applied: true, auditEventId: "audit-1", serverId: "server-1", accessEnabled: true, version: 4, canManageAccess: false, canManageEnrollments: true, labs: [{ labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel", state: "open", enrolled: true, effective: true, updatedAt: "2026-10-11T09:30:00.000Z" }] },
  serverLabEnrollment: { applied: true, auditEventId: "audit-1", serverId: "server-1", accessEnabled: true, version: 4, canManageAccess: false, canManageEnrollments: true, labs: [{ labKey: "agent-panel-v2", name: "Agent panel v2", description: "The new Agent panel", state: "open", enrolled: true, effective: true, updatedAt: "2026-10-11T09:30:00.000Z" }] },
  agentContext: {
    agent: { id: "agent-1", name: "alice", displayName: "Alice", description: "Reviewer", runtime: "external", external: true },
    server: { id: "server-1", slug: "acme", name: "Acme" },
    credential: { capabilities: ["read", "send"] },
    prompt: { audience: "self-hosted-runner", text: "# Raft CLI operating guide" },
  },
  serverInfo: {
    runtimeContext: {
      agentId: "agent-1",
      serverId: "server-1",
    },
    channels: [],
    agents: [],
    humans: [],
  },  userChannels: {
    user: { name: "xxchan", role: "owner" },
    kind: "human",
    memberships: [],
    uncheckedCount: 0,
    page: { total: 0, offset: 0, limit: 50 },
  },

  senderMentionDeliveries: {
    messageId: "11111111-1111-4111-8111-111111111111",
    deliveries: [],
  },
  mentionActionsPending: {
    pendingMentionActions: [],
  },
  mentionActionsExecute: {
    ok: true,
    action: "notify",
    results: [],
  },
  taskClaim: {
    results: [],
  },
  taskList: {
    tasks: [],
  },
  taskCreate: {
    tasks: [
      {
        taskNumber: 1,
        messageId: "msg-1",
        title: "Raw SDK conformance",
        status: "todo",
        claimedByType: null,
        claimedById: null,
        claimedAt: null,
        requiresResourceReceipt: false,
      },
    ],
  },
  taskUnclaim: {
    ok: true,
  },
  taskAssign: {
    ok: true,
    revision: 4,
    assignee: "@akko",
  },
  taskUpdateStatus: {
    ok: true,
  },
  taskResourceReceipt: {
    ok: true,
    taskNumber: 25,
    revision: 2,
    receipt: {
      object: "staging bucket",
      purpose: "verify resource receipt enforcement",
      teardown_owner: "@akko",
      security_privacy: "internal; no secrets",
      expiry: "2026-09-01T00:00:00.000Z",
      runbook: "runbooks/staging-bucket.md",
      tracking: "task #25",
    },
    expiryFollowup: {
      id: "11111111-2222-4333-8444-555555555555",
      ownerAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      owner: "@akko",
      fireAt: "2026-09-01T00:00:00.000Z",
      msgId: "99999999-8888-4777-8666-555555555555",
      targetChannelId: "22222222-3333-4444-8555-666666666666",
    },
  },
  taskDelete: {
    ok: true,
  },
  taskConvert: {
    task: { taskNumber: 26, messageId: "11111111-2222-3333-4444-555555555555", title: "Ship the assignee picker", status: "todo", claimedByType: null, claimedById: null, claimedByName: null, claimedAt: null, requiresResourceReceipt: false },
  },
  taskAmend: {
    task: { taskNumber: 24, title: "Current title", description: null, revision: 2 },
    event: {
      id: "11111111-1111-4111-8111-111111111111",
      seq: 2,
      eventType: "amended",
      actorType: "agent",
      actorName: "cross",
      payload: { revision: 2, changes: { title: { from: "Old", to: "Current title" } } },
      createdAt: "2026-08-05T00:00:00.000Z",
    },
  },
  taskHistory: {
    task: { taskNumber: 24, title: "Current title", description: null, revision: 2 },
    events: [],
  },
  taskFollowing: { tasks: [{ taskRef: "#wg-raft-cli:#24", taskNumber: 24, title: "Current title", status: "todo", unread: 2, followedAt: "2026-08-05T00:00:00.000Z", reason: "authored" }] },
  taskView: {
      taskRef: "#wg-raft-cli:#24",
      task: { taskNumber: 24, status: "todo", title: "Current title", conversationAnchored: true },
      following: true,
      followReason: "authored",
      conversation: { exists: true, replyCount: 0 },
      sourceMessage: null,
      earlierDiscussion: null,
      recentMessages: [],
      hasOlder: false,
    },
  taskRead: { target: "#wg-raft-cli:#24", messages: [], has_more: false, has_older: false, has_newer: false },
  taskReply: { ok: true, state: "sent", messageId: "11111111-1111-4111-8111-111111111111", messageSeq: 3 },
  taskFollow: { ok: true, taskRef: "#wg-raft-cli:#24", following: true, changed: true },
  taskUnfollow: { ok: true, taskRef: "#wg-raft-cli:#24", following: false, changed: true },
  taskIdleNudge: { send: true, items: [{ ref: "#wg-raft-cli:#24", taskNumber: 24, channel: "#wg-raft-cli", title: "Current title", status: "todo", reason: "newly_assigned", why: "newly yours (assigned by @akko)" }], backlog: [], text: "[Raft task notice: 1 task is waiting on you.]" },
  migrationRetry: { migrationId: "11111111-1111-4111-8111-111111111111", supportRef: "mig_retry", targetMachineName: "studio-mac", note: "The source will stop you once you are idle, then move you." },
  reminderList: {
    reminders: [{
      reminderId: "reminder-1",
      ownerAgentId: "agent-1",
      title: "check CI",
      fireAt: "2026-06-29T05:00:00.000Z",
      firedAt: null,
      createdAt: "2026-06-29T04:00:00.000Z",
      status: "scheduled",
      msgRef: "#wg-raft-cli:abcd1234",
      msgPermalink: null,
      recurrence: null,
    }],
  },
  reminderCreate: {
    reminder: {
      reminderId: "reminder-1",
      ownerAgentId: "agent-1",
      title: "check CI",
      fireAt: "2026-06-29T05:00:00.000Z",
      firedAt: null,
      createdAt: "2026-06-29T04:00:00.000Z",
      status: "scheduled",
      msgRef: "#wg-raft-cli:abcd1234",
      msgPermalink: null,
      recurrence: null,
    },
  },
  reminderCancel: {
    reminder: {
      reminderId: "reminder-1",
      ownerAgentId: "agent-1",
      title: "check CI",
      fireAt: "2026-06-29T05:00:00.000Z",
      firedAt: null,
      createdAt: "2026-06-29T04:00:00.000Z",
      status: "canceled",
      msgRef: "#wg-raft-cli:abcd1234",
      msgPermalink: null,
      recurrence: null,
    },
  },
  reminderSnooze: {
    reminder: {
      reminderId: "reminder-1",
      ownerAgentId: "agent-1",
      title: "check CI",
      fireAt: "2026-06-29T05:05:00.000Z",
      firedAt: "2026-06-29T05:00:00.000Z",
      createdAt: "2026-06-29T04:00:00.000Z",
      status: "scheduled",
      msgRef: "#wg-raft-cli:abcd1234",
      msgPermalink: null,
      recurrence: null,
    },
  },
  reminderUpdate: {
    reminder: {
      reminderId: "reminder-1",
      ownerAgentId: "agent-1",
      title: "check staging",
      fireAt: "2026-06-29T05:00:00.000Z",
      firedAt: null,
      createdAt: "2026-06-29T04:00:00.000Z",
      status: "scheduled",
      msgRef: "#wg-raft-cli:abcd1234",
      msgPermalink: null,
      recurrence: null,
    },
  },
  appSourceAck: {
    ok: true,
    itemId: "source:item:1",
    appId: "system.fixture",
    notificationClass: "due",
    sourceRef: { kind: "source", id: "source-1", revision: "7" },
    sourceEventId: "bbbbbbbb-1234-4123-8123-123456789abc",
    ackAttemptId: "aaaaaaaa-1234-4123-8123-123456789abc",
    replayed: false,
  },
  reminderLog: {
    events: [{
      eventId: "event-1",
      reminderId: "reminder-1",
      eventType: "scheduled",
      actorType: "agent",
      actorId: "agent-1",
      occurredAt: "2026-06-29T04:00:00.000Z",
      nextFireAt: "2026-06-29T05:00:00.000Z",
      metadata: null,
    }],
  },
  appConfigGet: {
    appId: "system.cleaner",
    revision: 0,
    schema: {},
    defaults: {},
    overrides: {},
    effective: {},
  },
  appConfigPatch: {
    appId: "system.cleaner",
    revision: 1,
    schema: {},
    defaults: {},
    overrides: { enabled: false },
    effective: { enabled: false },
  },
  profileShow: {
    kind: "agent",
    id: "agent-1",
    isSelf: true,
    name: "HaoHao",
    displayName: null,
    description: null,
    avatarUrl: null,
    status: "active",
    serverRole: null,
    runtime: "claude",
    model: "sonnet",
    reasoningEffort: null,
    executionMode: null,
    computerId: null,
    computerName: null,
    computerHostname: null,
    daemonVersion: null,
    creator: null,
    createdAgents: [],
    createdAt: "2026-06-29T04:00:00.000Z",
    deletedAt: null,
  },
  profileUpdate: {
    kind: "agent",
    id: "agent-1",
    isSelf: true,
    name: "HaoHao",
    displayName: "HaoHao",
    description: "Runtime agent",
    avatarUrl: "pixel:random:HaoHao",
    status: "active",
    serverRole: null,
    runtime: "claude",
    model: "sonnet",
    reasoningEffort: null,
    executionMode: null,
    computerId: null,
    computerName: null,
    computerHostname: null,
    daemonVersion: null,
    creator: null,
    createdAgents: [],
    createdAt: "2026-06-29T04:00:00.000Z",
    deletedAt: null,
  },
  profileAvatarUpdate: {
    kind: "agent",
    id: "agent-1",
    isSelf: true,
    name: "HaoHao",
    displayName: "HaoHao",
    description: "Runtime agent",
    avatarUrl: "https://cdn.example/avatar.png",
    status: "active",
    serverRole: null,
    runtime: "claude",
    model: "sonnet",
    reasoningEffort: null,
    executionMode: null,
    computerId: null,
    computerName: null,
    computerHostname: null,
    daemonVersion: null,
    creator: null,
    createdAgents: [],
    createdAt: "2026-06-29T04:00:00.000Z",
    deletedAt: null,
  },
  integrationList: {
    services: [{
      id: "client-1",
      clientId: "drive9",
      official: false,
      purpose: "",
      name: "Drive9",
      description: null,
      homepageUrl: null,
      returnUrl: null,
      agentManifestUrl: null,
      createdAt: "2026-06-28T02:00:00.000Z",
      updatedAt: "2026-06-28T02:00:00.000Z",
    }],
    activeLogins: [],
  },
  integrationMarketplaceSearch: {
    surface: "public_marketplace",
    metadataTrust: "untrusted_app_supplied",
    query: "drive",
    limit: 10,
    apps: [{
      id: "client-1",
      clientId: "drive9",
      name: "Drive9",
      description: null,
      category: "Storage",
      dataAccessSummary: null,
      homepageUrl: "https://drive9.example",
      agentManifestUrl: "https://drive9.example/.well-known/raft-agent-manifest.json",
      agentManifestUrlSource: "well_known",
      allowedScopes: ["openid", "profile"],
      logoUrl: null,
      installedOnServer: false,
      updatedAt: "2026-06-28T02:00:00.000Z",
      official: false,
      purpose: "",
    }],
  },
  integrationToken: { access_token: "fixture.jwt.token", token_type: "Bearer", audience: "drive9", expires_in: 300, expires_at: "2026-10-05T00:05:00.000Z" },
  integrationLogin: {
    status: "logged_in",
    service: {
      id: "client-1",
      clientId: "drive9",
      official: false,
      purpose: "",
      name: "Drive9",
      description: null,
      homepageUrl: null,
      returnUrl: null,
      agentManifestUrl: null,
      createdAt: "2026-06-28T02:00:00.000Z",
      updatedAt: "2026-06-28T02:00:00.000Z",
    },
    scopes: ["openid", "profile"],
    requestId: "request-1",
  },
  integrationAppPrepare: {
    status: "prepared",
    mode: "register",
    target: "#wg-raft-cli",
    actionCardMessageId: "msg-action-1",
    action: {
      type: "integration:register_app",
      name: "Drive9",
      clientKey: "drive9",
      returnUrl: "https://drive9.example/auth/raft/callback",
      scopes: ["openid", "profile"],
    },
  },
  integrationAppRotateSecret: {
    clientId: "client-uuid-1",
    clientKey: "drive9",
    clientName: "Drive9",
    clientSecret: "raft_secret_rotated",
  },
  integrationAppTransferOwner: {
    clientId: "client-uuid-1",
    clientKey: "drive9",
    clientName: "Drive9",
    ownerAgentId: "agent-2",
    ownerAgentName: "box",
    ownershipOutcome: "transferred",
    auditEventId: "11111111-1111-4111-8111-111111111112",
  },
  integrationAppUpdate: {
    clientId: "client-uuid-1",
    clientKey: "drive9",
    clientName: "Drive 9",
    updatedFields: ["name", "category"],
  },
  integrationAppManage: {
    action: "request_publish",
    clientId: "client-uuid-1",
    clientKey: "drive9",
    clientName: "Drive9",
    publishStatus: "publish_requested",
  },
  integrationAppLogoUpdate: {
    clientId: "client-uuid-1",
    clientKey: "drive9",
    clientName: "Drive9",
    logoUrl: "/api/integration-logos/client-uuid-1/hash.webp",
  },
  integrationAppList: { apps: [] },
  integrationAppStatus: {
    app: {
      state: "committed",
      card: null,
      name: "Drive9",
      clientKey: "drive9",
      createdAt: "2026-06-27T02:55:01.000Z",
      callbackUrl: "https://drive9.example/auth/raft/callback",
      scopes: ["openid", "profile"],
      category: "Developer Tools",
      recoveryCommand: "raft integration app rotate-secret --client drive9 --output <new-private-path>",
    },
  },
  actionPrepare: {
    messageId: "msg-action-1",
    metadata: { kind: "action-card" },
  },
  actionWithdraw: {
    messageId: "msg-action-1",
    metadata: { kind: "action-card" },
  },
  attachmentUpload: {
    id: "attachment-1",
    filename: "log.txt",
    mimeType: "text/plain",
    sizeBytes: 12,
    thumbnailUrl: null,
  },
  attachmentUploadCapabilities: { directUploadEnabled: true, directUploadThresholdBytes: 94371840, maxBytes: 209715200, sessionExpiresInSeconds: 900 },
  attachmentUploadSessionCreate: { uploadId: "33333333-3333-4333-8333-333333333333", attachmentId: "44444444-4444-4444-8444-444444444444", state: "pending", expiresAt: "2026-06-29T04:15:00.000Z", upload: { method: "PUT", url: "https://r2.example.test/upload", headers: { "Content-Type": "text/plain", "If-None-Match": "*" } } },
  attachmentUploadSessionComplete: { uploadId: "33333333-3333-4333-8333-333333333333", state: "completed", attachment: { id: "44444444-4444-4444-8444-444444444444", filename: "log.txt", mimeType: "text/plain", sizeBytes: 12, thumbnailUrl: null } },
  attachmentUploadSessionCancel: { uploadId: "33333333-3333-4333-8333-333333333333", state: "canceled", expiresAt: "2026-06-29T04:15:00.000Z", attachment: null, terminalReason: "Canceled." },
  attachmentUploadSessionStatus: { uploadId: "33333333-3333-4333-8333-333333333333", state: "pending", expiresAt: "2026-06-29T04:15:00.000Z", attachment: null, terminalReason: null },
  attachmentDownload: new Uint8Array([1, 2, 3]),
  attachmentDownloadUrl: { url: "https://objects.example.test/a?X-Amz-Signature=sig", expiresAt: "2026-10-04T08:00:00.000Z", filename: "report.pdf", mimeType: "application/pdf" },
  attachmentCommentsList: {
    comments: [{
      id: "msg-comment-1",
      channelId: "thread-channel-1",
      senderId: "user-1",
      senderType: "user",
      senderName: "xxchan",
      senderAvatarUrl: null,
      senderGravatarHash: null,
      content: "looks good",
      createdAt: "2026-06-29T04:00:00.000Z",
      reactions: [{
        emoji: "✅",
        reactorType: "user",
        reactorId: "user-1",
        createdAt: "2026-06-29T04:01:00.000Z",
      }],
      anchor: { type: "lines", data: { start: 1, end: 2 } },
      resolved: true,
      resolvedBy: { reactorId: "user-1", reactorType: "user" },
      resolvedAt: "2026-06-29T04:01:00.000Z",
    }],
    threadChannelId: "thread-channel-1",
    viewer: {
      canComment: false,
      reason: "agent_descoped",
      canResolve: true,
      resolveAction: { type: "reaction", emoji: "✅" },
    },
  },
  pushWebhookStatus: { registered: true, url: "https://hooks.example.test/raft", enabled: true, disabledReason: null, disabledAt: null, lastAttemptAt: null, lastDeliveryAt: "2026-06-29T04:00:00.000Z", lastError: null, consecutiveFailures: 0, nextAttemptAt: null },
  pushWebhookRegister: { registered: true, url: "https://hooks.example.test/raft", enabled: true, disabledReason: null, disabledAt: null, lastAttemptAt: null, lastDeliveryAt: "2026-06-29T04:00:00.000Z", lastError: null, consecutiveFailures: 0, nextAttemptAt: null },
  pushWebhookDelete: null,
  mentionsList: { mentions: [], has_more: false },
};
/** Core's, then each app's samples (apps/agentApiSamples.ts). */
const validResponses = {
  ...coreValidResponses,
  ...Object.fromEntries(Object.entries(firstPartyAppAgentApiSamples).map(([key, sample]) => [key, sample.response])),
} as Record<AgentApiRouteKey, unknown>;

const coreMethodInputs: Record<CoreAgentApiRouteKey, unknown[]> = {
  raftbenchFindings: [{ limit: 5 }],
  raftbenchContext: [{ runId: raftbenchRunId }],
  raftbenchSubmit: [raftbenchReport],
  feedbackLocatorIngest: [{
    artifact_kind: "raft-feedback-locator-v0",
    event_kind: "feedback-locator:created",
    payload: { schema_version: "raft.feedback.locator.v0" },
  }],
  feedbackLocatorList: [{ runtime: "codex", limit: "10" }],
  events: [{ since: "latest" }],
  historyRead: [{ channel: "#wg-raft-cli" }],
  knowledgeGet: [{
    topic: "index",
    intent: "Learn which Raft workflows are documented",
    reason: "Need the Manual topic catalog before answering",
  }],
  contextSearch: [{ message_id: "0123abcd", query: "deploy" }],
  contextRead: [{ message_id: "0123abcd", around: "m0.p0" }],
  knowledgeSearch: [{
    query: "preview before merge",
    scope: "recipes",
    intent: "Safely preview the user's change before merge",
    reason: "Need the recommended preview workflow right now",
  }],
  managedMcpTools: [],
  managedMcpCall: [{
    mcpServerId: "11111111-1111-4111-8111-111111111111",
    toolName: "search",
    arguments: { query: "MCP" },
    expectedConfigVersion: 1,
    expectedAssignmentVersion: 1,
  }],
  messageSend: [{ target: "#wg-raft-cli", content: "hello" }],
  messageSendV2: [{ target: "#wg-raft-cli", content: "hello @wenyi", mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "wenyi" }] }],
  messageResolve: [{ msgId: asMessageId("msg/with space") }],
  messageSearch: [{ q: "review status", channel: "#proj-runtime", sender: "xxchan", sort: "recent", limit: "20" }],
  messageReactionAdd: [{ msgId: asMessageId("msg/with space") }, { emoji: "👀" }],
  messageReactionRemove: [{ msgId: asMessageId("msg-1") }, { emoji: "👀" }],
  messageCardUpdate: [{ messageId: asMessageId("msg-1") }, { card: { version: 1, root: "t", elements: { t: { type: "Text", props: { text: "Ready for testing" } } } }, expectedRevision: 1 }],
  channelJoin: [{ channelId: asChannelId("chan/with spaces") }],
  channelLeave: [{ channelId: asChannelId("chan-1") }],
  channelMute: [{ channelId: asChannelId("chan-1") }],
  channelUnmute: [{ channelId: asChannelId("chan-1") }],
  channelArchive: [{ target: "#engineering" }],
  channelUnarchive: [{ target: "#engineering" }],
  channelCreate: [{ name: "design", visibility: "private" }],
  channelUpdate: [{ channelId: asChannelId("chan-2") }, { name: "design-reviews" }],
  channelMemberAdd: [{ channelId: asChannelId("chan-2") }, { agent: "Kirby" }],
  channelMemberRemove: [{ channelId: asChannelId("chan-2") }, { user: "wenyi" }],
  channelMembers: [{ channel: "#wg-raft-cli" }],
  resolveChannel: [{ target: "#wg-raft-cli" }],
  threadFollow: [{ thread: "#wg-raft-cli:abcd1234" }],
  threadUnfollow: [{ thread: "#wg-raft-cli:abcd1234" }],
  threadList: [],
  assistantOwnerInbox: [{ filter: "all", offset: "20" }],
  assistantOwnerMessages: [{ channelId: "55555555-5555-4555-8555-555555555555", around: "abcd1234" }],
  assistantOwnerArtifact: [{ artifact: "pt_abc12345", version: "2" }],
  assistantOwnerArtifactPublish: [{ title: "Plan", files: [{ path: "index.html", content: "<h1>Plan</h1>" }] }],
  assistantOwnerActivity: [{ since: "2026-10-20T00:00:00.000Z", limit: "20" }],
  assistantOwnerResolve: [{ name: "@ada" }],
  assistantCheckStateImport: [{ briefSent: "2026-10-20" }],
  assistantNotify: [{ check_id: "99999999-9999-4999-8999-999999999999", idempotency_key: "turn-1", items: [{ channelId: "55555555-5555-4555-8555-555555555555", summary: "@ada needs your OK" }] }],
  assistantContactRules: [],
  assistantContactRuleAdd: [{ effect: "mute", subject: "dms" }],
  assistantContactRuleRemove: [{ ruleId: "99999999" }],
  assistantContactSettings: [{ quiet: null }],
  assistantOwnerSettings: [],
  assistantOwnerSettingsUpdate: [{ preferredTimezone: "Europe/Berlin" }],
  assistantContactRulesImport: [{ rules: [] }],
  assistantToldRecord: [{ messageIds: ["77777777-7777-4777-8777-777777777777"], via: "notify" }],
  assistantToldList: [{ since: "2026-10-20T00:00:00.000Z" }],
  assistantSendAsOwner: [{ channelId: "55555555-5555-4555-8555-555555555555", content: "on it" }],
  assistantForwardAsOwner: [{ messages: ["77777777-7777-4777-8777-777777777777"], to: ["#design"], requestId: "99999999-9999-4999-8999-999999999999" }],
  assistantSearchForwardTargets: [{ q: "des" }],
  inboxList: [{ view: "mentions", before_seq: "1099", limit: "20" }],
  inboxRead: [{ target: "app:stamp/pr-13754", limit: 5 }],
  inboxDismiss: [{ target: "app:stamp" }],
  agentContext: [],
  serverInfo: [],
  userChannels: [{ name: "Hao Hao/x" }, { offset: "50", limit: "200" }],
  serverUpdate: [{ name: "Renamed Server", hideHumansFromMembers: true }],
  serverLabs: [],
  serverLabsAccess: [{ enabled: false, expectedVersion: 3 }],
  serverLabEnrollment: [{ labKey: "agent-panel-v2" }, { enabled: true, expectedVersion: 3 }],
  senderMentionDeliveries: [{ messageId: "11111111-1111-4111-8111-111111111111" }],
  mentionActionsPending: [{ limit: "20" }],
  mentionActionsExecute: [{ action: "notify", resolutionIds: ["res-1"] }],
  taskClaim: [{ channel: "#wg-raft-cli", task_numbers: [24] }],
  taskList: [{ channel: "#wg-raft-cli", status: "in_progress" }],
  taskCreate: [{ channel: "#wg-raft-cli", tasks: [{ title: "Raw SDK conformance" }] }],
  taskUnclaim: [{ channel: "#wg-raft-cli", task_number: 24 }],
  taskAssign: [{ channel: "#wg-raft-cli", task_number: 24, assignee: "@akko" }],
  taskUpdateStatus: [{ channel: "#wg-raft-cli", task_number: 24, status: "in_review" }],
  taskResourceReceipt: [{
    channel: "#wg-raft-cli",
    task_number: 25,
    receipt: {
      object: "staging bucket",
      purpose: "verify resource receipt enforcement",
      teardown_owner: "@akko",
      security_privacy: "internal; no secrets",
      expiry: "2026-09-01T00:00:00.000Z",
      runbook: "runbooks/staging-bucket.md",
      tracking: "task #25",
    },
  }],
  taskDelete: [{ channel: "#wg-raft-cli", task_number: 24 }],
  taskConvert: [{ channel: "#wg-raft-cli", message_id: "11111111" }],
  taskAmend: [{ channel: "#wg-raft-cli", task_number: 24, title: "Current title" }],
  taskHistory: [{ channel: "#wg-raft-cli", task_number: 24 }],
  taskFollowing: [{}],
  taskView: [{ channel: "#wg-raft-cli", task_number: 24 }],
  taskRead: [{ channel: "#wg-raft-cli", task_number: 24, after: "0" }],
  taskReply: [{ channel: "#wg-raft-cli", task_number: 24, content: "on it", idempotencyKey: "k-1" }],
  taskFollow: [{ channel: "#wg-raft-cli", task_number: 24 }],
  taskUnfollow: [{ channel: "#wg-raft-cli", task_number: 24 }],
  taskIdleNudge: [{ freshSession: true, backgroundTasks: 2 }],
  migrationRetry: [],
  reminderList: [{ status: "scheduled,fired" }],
  reminderCreate: [{ title: "check CI", delaySeconds: 60, msgId: "abcd1234" }],
  reminderCancel: [{ reminderId: "reminder-1" }],
  reminderSnooze: [{ reminderId: "reminder-1" }, { delaySeconds: 300 }],
  reminderUpdate: [{ reminderId: "reminder-1" }, { title: "check staging" }],
  appSourceAck: [{
    itemId: "source:item:1",
    appId: "system.fixture",
    notificationClass: "due",
    sourceRef: { kind: "source", id: "source-1", revision: "7" },
    ackAttemptId: "aaaaaaaa-1234-4123-8123-123456789abc",
  }],
  reminderLog: [{ reminderId: "reminder-1" }],
  appConfigGet: [{ appId: "system.cleaner" }],
  appConfigPatch: [{ appId: "system.cleaner" }, { expectedRevision: 0, set: { enabled: false }, unset: [] }],
  profileShow: [{ target: "@HaoHao" }],
  profileUpdate: [{ displayName: "HaoHao", description: "Runtime agent", avatarUrl: "pixel:random:HaoHao" }],
  profileAvatarUpdate: [],
  integrationList: [],
  integrationMarketplaceSearch: [{ query: "drive", limit: "10" }],
  integrationToken: [{ service: "drive9" }],
  integrationLogin: [{ service: "drive9", scopes: ["openid", "profile"], target: "#wg-raft-cli" }],
  integrationAppPrepare: [{
    mode: "register",
    target: "#wg-raft-cli",
    clientKey: "drive9",
    name: "Drive9",
    returnUrl: "https://drive9.example/auth/raft/callback",
    scopes: ["openid", "profile"],
  }],
  integrationAppRotateSecret: [{ clientKey: "drive9" }],
  integrationAppTransferOwner: [{ clientKey: "drive9", targetAgent: "box" }],
  integrationAppUpdate: [{ clientKey: "drive9", name: "Drive 9", category: "Infrastructure" }],
  integrationAppManage: [{ clientKey: "drive9", action: "request_publish" }],
  integrationAppLogoUpdate: [],
  integrationAppList: [],
  integrationAppStatus: [{ client: "drive9" }],
  actionPrepare: [{
    target: "#wg-raft-cli",
    action: { type: "channel:create", name: "Raw SDK conformance", visibility: "public" },
  }],
  actionWithdraw: [{ messageId: "1a2b3c4d" }],
  attachmentUpload: [],
  attachmentUploadCapabilities: [],
  attachmentUploadSessionCreate: [{ channelId: "11111111-1111-4111-8111-111111111111", filename: "log.txt", mimeType: "text/plain", sizeBytes: 12, clientRequestId: "22222222-2222-4222-8222-222222222222" }],
  attachmentUploadSessionComplete: [{ uploadId: "33333333-3333-4333-8333-333333333333" }],
  attachmentUploadSessionCancel: [{ uploadId: "33333333-3333-4333-8333-333333333333" }],
  attachmentUploadSessionStatus: [{ uploadId: "33333333-3333-4333-8333-333333333333" }],
  attachmentDownload: [{ attachmentId: "attachment/with space" }],
  attachmentDownloadUrl: [{ attachmentId: "attachment/with space" }],
  attachmentCommentsList: [{ attachmentId: "attachment/with space" }, { limit: "25" }],
  pushWebhookStatus: [],
  pushWebhookRegister: [{ url: "https://hooks.example.test/raft", secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }],
  pushWebhookDelete: [],
  mentionsList: [{ limit: "50" }],
};
/** Core's, then each app's samples (apps/agentApiSamples.ts). */
const methodInputs = {
  ...coreMethodInputs,
  ...Object.fromEntries(Object.entries(firstPartyAppAgentApiSamples).map(([key, sample]) => [key, sample.input])),
} as Record<AgentApiRouteKey, unknown[]>;

function methodForRoute(client: unknown, routeKey: AgentApiRouteKey): (...args: unknown[]) => Promise<unknown> {
  const route = agentApiContract[routeKey];
  const resource = (client as Record<string, Record<string, unknown>>)[route.client.resource];
  const method = resource?.[route.client.method];
  assert.equal(typeof method, "function", `${routeKey} exposes ${route.client.resource}.${route.client.method}`);
  return method as (...args: unknown[]) => Promise<unknown>;
}

test("raw client exposes every contract client binding and sends generated route requests", async () => {
  const requests: AgentApiRawTransportRequest[] = [];
  const transport: AgentApiRawTransport = {
    request: async (input) => {
      requests.push(input);
      return {
        ok: true,
        status: 200,
        error: null,
        data: validResponses[input.routeKey],
      };
    },
  };
  const client = createAgentApiRawClient(transport);

  for (const routeKey of Object.keys(agentApiContract) as AgentApiRouteKey[]) {
    const result = await methodForRoute(client, routeKey)(...methodInputs[routeKey]);
    assert.equal((result as { ok: boolean }).ok, true, `${routeKey} returns success`);
  }

  assert.deepEqual(
    requests.map(({ routeKey, method, path, body }) => ({ routeKey, method, path, body })),
    [
      { routeKey: "raftbenchFindings", method: "GET", path: "/internal/agent-api/raftbench/findings?limit=5", body: undefined },
      { routeKey: "raftbenchContext", method: "GET", path: `/internal/agent-api/raftbench/context?runId=${raftbenchRunId}`, body: undefined },
      { routeKey: "raftbenchSubmit", method: "POST", path: "/internal/agent-api/raftbench/submit", body: raftbenchReport },
      {
        routeKey: "feedbackLocatorIngest",
        method: "POST",
        path: "/internal/agent-api/feedback-locators",
        body: {
          artifact_kind: "raft-feedback-locator-v0",
          event_kind: "feedback-locator:created",
          payload: { schema_version: "raft.feedback.locator.v0" },
        },
      },
      {
        routeKey: "feedbackLocatorList",
        method: "GET",
        path: "/internal/agent-api/feedback-locators?runtime=codex&limit=10",
        body: undefined,
      },
      { routeKey: "events", method: "GET", path: "/internal/agent-api/events?since=latest", body: undefined },
      { routeKey: "historyRead", method: "GET", path: "/internal/agent-api/history?channel=%23wg-raft-cli", body: undefined },
      { routeKey: "knowledgeGet", method: "GET", path: "/internal/agent-api/knowledge?topic=index&intent=Learn+which+Raft+workflows+are+documented&reason=Need+the+Manual+topic+catalog+before+answering", body: undefined },
      { routeKey: "knowledgeSearch", method: "GET", path: "/internal/agent-api/knowledge/search?query=preview+before+merge&scope=recipes&intent=Safely+preview+the+user%27s+change+before+merge&reason=Need+the+recommended+preview+workflow+right+now", body: undefined },
      { routeKey: "contextSearch", method: "POST", path: "/internal/agent-api/context/search", body: { message_id: "0123abcd", query: "deploy" } },
      { routeKey: "contextRead", method: "POST", path: "/internal/agent-api/context/read", body: { message_id: "0123abcd", around: "m0.p0" } },
      { routeKey: "managedMcpTools", method: "GET", path: "/internal/agent-api/mcp/tools", body: undefined },
      {
        routeKey: "managedMcpCall",
        method: "POST",
        path: "/internal/agent-api/mcp/call",
        body: {
          mcpServerId: "11111111-1111-4111-8111-111111111111",
          toolName: "search",
          arguments: { query: "MCP" },
          expectedConfigVersion: 1,
          expectedAssignmentVersion: 1,
        },
      },
      { routeKey: "messageSend", method: "POST", path: "/internal/agent-api/send", body: { target: "#wg-raft-cli", content: "hello" } },
      { routeKey: "messageSendV2", method: "POST", path: "/internal/agent-api/v2/send", body: { target: "#wg-raft-cli", content: "hello @wenyi", mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "wenyi" }] } },
      { routeKey: "messageResolve", method: "GET", path: "/internal/agent-api/messages/msg%2Fwith%20space/resolve", body: undefined },
      { routeKey: "messageSearch", method: "GET", path: "/internal/agent-api/search?q=review+status&channel=%23proj-runtime&sender=xxchan&sort=recent&limit=20", body: undefined },
      { routeKey: "messageReactionAdd", method: "POST", path: "/internal/agent-api/messages/msg%2Fwith%20space/reactions", body: { emoji: "👀" } },
      { routeKey: "messageReactionRemove", method: "DELETE", path: "/internal/agent-api/messages/msg-1/reactions", body: { emoji: "👀" } },
      { routeKey: "messageCardUpdate", method: "PUT", path: "/internal/agent-api/messages/msg-1/card", body: { card: { version: 1, root: "t", elements: { t: { type: "Text", props: { text: "Ready for testing" } } } }, expectedRevision: 1 } },
      { routeKey: "channelJoin", method: "POST", path: "/internal/agent-api/channels/chan%2Fwith%20spaces/join", body: undefined },
      { routeKey: "channelLeave", method: "POST", path: "/internal/agent-api/channels/chan-1/leave", body: undefined },
      { routeKey: "channelMute", method: "POST", path: "/internal/agent-api/channels/chan-1/mute", body: undefined },
      { routeKey: "channelUnmute", method: "POST", path: "/internal/agent-api/channels/chan-1/unmute", body: undefined },
      { routeKey: "channelArchive", method: "POST", path: "/internal/agent-api/channels/archive", body: { target: "#engineering" } },
      { routeKey: "channelUnarchive", method: "POST", path: "/internal/agent-api/channels/unarchive", body: { target: "#engineering" } },
      { routeKey: "channelCreate", method: "POST", path: "/internal/agent-api/channels", body: { name: "design", visibility: "private" } },
      { routeKey: "channelUpdate", method: "PATCH", path: "/internal/agent-api/channels/chan-2", body: { name: "design-reviews" } },
      { routeKey: "channelMemberAdd", method: "POST", path: "/internal/agent-api/channels/chan-2/members", body: { agent: "Kirby" } },
      { routeKey: "channelMemberRemove", method: "DELETE", path: "/internal/agent-api/channels/chan-2/members", body: { user: "wenyi" } },
      { routeKey: "channelMembers", method: "GET", path: "/internal/agent-api/channel-members?channel=%23wg-raft-cli", body: undefined },
      { routeKey: "resolveChannel", method: "POST", path: "/internal/agent-api/resolve-channel", body: { target: "#wg-raft-cli" } },
      { routeKey: "threadFollow", method: "POST", path: "/internal/agent-api/threads/follow", body: { thread: "#wg-raft-cli:abcd1234" } },
      { routeKey: "threadUnfollow", method: "POST", path: "/internal/agent-api/threads/unfollow", body: { thread: "#wg-raft-cli:abcd1234" } },
      { routeKey: "threadList", method: "GET", path: "/internal/agent-api/threads", body: undefined },
      { routeKey: "inboxList", method: "GET", path: "/internal/agent-api/inbox/conversations?view=mentions&before_seq=1099&limit=20", body: undefined },
      { routeKey: "inboxRead", method: "POST", path: "/internal/agent-api/inbox/read", body: { target: "app:stamp/pr-13754", limit: 5 } },
      { routeKey: "inboxDismiss", method: "POST", path: "/internal/agent-api/inbox/dismiss", body: { target: "app:stamp" } },
      { routeKey: "assistantOwnerInbox", method: "GET", path: "/internal/agent-api/assistant/owner-inbox?filter=all&offset=20", body: undefined },
      { routeKey: "assistantOwnerMessages", method: "GET", path: "/internal/agent-api/assistant/owner-messages?channelId=55555555-5555-4555-8555-555555555555&around=abcd1234", body: undefined },
      { routeKey: "assistantOwnerArtifact", method: "GET", path: "/internal/agent-api/assistant/owner-artifact?artifact=pt_abc12345&version=2", body: undefined },
      { routeKey: "assistantOwnerArtifactPublish", method: "POST", path: "/internal/agent-api/assistant/owner-artifact", body: { title: "Plan", files: [{ path: "index.html", content: "<h1>Plan</h1>" }] } },
      { routeKey: "assistantOwnerActivity", method: "GET", path: "/internal/agent-api/assistant/owner-activity?since=2026-10-20T00%3A00%3A00.000Z&limit=20", body: undefined },
      { routeKey: "assistantOwnerResolve", method: "GET", path: "/internal/agent-api/assistant/owner-resolve?name=%40ada", body: undefined },
      { routeKey: "assistantContactRules", method: "GET", path: "/internal/agent-api/assistant/contact-rules", body: undefined },
      { routeKey: "assistantContactRuleAdd", method: "POST", path: "/internal/agent-api/assistant/contact-rules", body: { effect: "mute", subject: "dms" } },
      { routeKey: "assistantContactRuleRemove", method: "DELETE", path: "/internal/agent-api/assistant/contact-rules/99999999", body: undefined },
      { routeKey: "assistantContactSettings", method: "PUT", path: "/internal/agent-api/assistant/contact-settings", body: { quiet: null } },
      { routeKey: "assistantOwnerSettings", method: "GET", path: "/internal/agent-api/assistant/owner-settings", body: undefined },
      { routeKey: "assistantOwnerSettingsUpdate", method: "PATCH", path: "/internal/agent-api/assistant/owner-settings", body: { preferredTimezone: "Europe/Berlin" } },
      { routeKey: "assistantContactRulesImport", method: "POST", path: "/internal/agent-api/assistant/contact-rules/import", body: { rules: [] } },
      { routeKey: "assistantToldRecord", method: "POST", path: "/internal/agent-api/assistant/told", body: { messageIds: ["77777777-7777-4777-8777-777777777777"], via: "notify" } },
      { routeKey: "assistantToldList", method: "GET", path: "/internal/agent-api/assistant/told?since=2026-10-20T00%3A00%3A00.000Z", body: undefined },
      { routeKey: "assistantNotify", method: "POST", path: "/internal/agent-api/assistant/notify", body: { check_id: "99999999-9999-4999-8999-999999999999", idempotency_key: "turn-1", items: [{ channelId: "55555555-5555-4555-8555-555555555555", summary: "@ada needs your OK" }] } },
      { routeKey: "assistantCheckStateImport", method: "POST", path: "/internal/agent-api/assistant/check-state/import", body: { briefSent: "2026-10-20" } },
      { routeKey: "assistantSendAsOwner", method: "POST", path: "/internal/agent-api/assistant/send-as-owner", body: { channelId: "55555555-5555-4555-8555-555555555555", content: "on it" } },
      { routeKey: "assistantForwardAsOwner", method: "POST", path: "/internal/agent-api/assistant/forward-as-owner", body: { messages: ["77777777-7777-4777-8777-777777777777"], to: ["#design"], requestId: "99999999-9999-4999-8999-999999999999" } },
      { routeKey: "assistantSearchForwardTargets", method: "GET", path: "/internal/agent-api/assistant/forward-targets?q=des", body: undefined },
      { routeKey: "agentContext", method: "GET", path: "/internal/agent-api/context", body: undefined },
      { routeKey: "serverInfo", method: "GET", path: "/internal/agent-api/server", body: undefined },
      { routeKey: "userChannels", method: "GET", path: "/internal/agent-api/users/Hao%20Hao%2Fx/channels?offset=50&limit=200", body: undefined },
      { routeKey: "serverUpdate", method: "PATCH", path: "/internal/agent-api/server", body: { name: "Renamed Server", hideHumansFromMembers: true } },
      { routeKey: "serverLabs", method: "GET", path: "/internal/agent-api/labs", body: undefined },
      { routeKey: "serverLabsAccess", method: "PATCH", path: "/internal/agent-api/labs/access", body: { enabled: false, expectedVersion: 3 } },
      { routeKey: "serverLabEnrollment", method: "PUT", path: "/internal/agent-api/labs/agent-panel-v2", body: { enabled: true, expectedVersion: 3 } },
      { routeKey: "mentionActionsPending", method: "GET", path: "/internal/agent-api/mention-actions/pending?limit=20", body: undefined },
      { routeKey: "senderMentionDeliveries", method: "GET", path: "/internal/agent-api/messages/11111111-1111-4111-8111-111111111111/mention-deliveries", body: undefined },
      { routeKey: "mentionActionsExecute", method: "POST", path: "/internal/agent-api/mention-actions/execute", body: { action: "notify", resolutionIds: ["res-1"] } },
      { routeKey: "taskClaim", method: "POST", path: "/internal/agent-api/tasks/claim", body: { channel: "#wg-raft-cli", task_numbers: [24] } },
      { routeKey: "taskList", method: "GET", path: "/internal/agent-api/tasks?channel=%23wg-raft-cli&status=in_progress", body: undefined },
      { routeKey: "taskCreate", method: "POST", path: "/internal/agent-api/tasks", body: { channel: "#wg-raft-cli", tasks: [{ title: "Raw SDK conformance" }] } },
      { routeKey: "taskUnclaim", method: "POST", path: "/internal/agent-api/tasks/unclaim", body: { channel: "#wg-raft-cli", task_number: 24 } },
      { routeKey: "taskAssign", method: "POST", path: "/internal/agent-api/tasks/assign", body: { channel: "#wg-raft-cli", task_number: 24, assignee: "@akko" } },
      { routeKey: "taskUpdateStatus", method: "POST", path: "/internal/agent-api/tasks/update-status", body: { channel: "#wg-raft-cli", task_number: 24, status: "in_review" } },
      { routeKey: "taskResourceReceipt", method: "POST", path: "/internal/agent-api/tasks/resource-receipt", body: { channel: "#wg-raft-cli", task_number: 25, receipt: { object: "staging bucket", purpose: "verify resource receipt enforcement", teardown_owner: "@akko", security_privacy: "internal; no secrets", expiry: "2026-09-01T00:00:00.000Z", runbook: "runbooks/staging-bucket.md", tracking: "task #25" } } },
      { routeKey: "taskDelete", method: "POST", path: "/internal/agent-api/tasks/delete", body: { channel: "#wg-raft-cli", task_number: 24 } },
      { routeKey: "taskConvert", method: "POST", path: "/internal/agent-api/tasks/convert", body: { channel: "#wg-raft-cli", message_id: "11111111" } },
      { routeKey: "taskAmend", method: "POST", path: "/internal/agent-api/tasks/amend", body: { channel: "#wg-raft-cli", task_number: 24, title: "Current title" } },
      { routeKey: "taskHistory", method: "GET", path: "/internal/agent-api/tasks/history?channel=%23wg-raft-cli&task_number=24", body: undefined },
      { routeKey: "taskView", method: "GET", path: "/internal/agent-api/tasks/view?channel=%23wg-raft-cli&task_number=24", body: undefined },
      { routeKey: "taskRead", method: "GET", path: "/internal/agent-api/tasks/read?channel=%23wg-raft-cli&task_number=24&after=0", body: undefined },
      { routeKey: "taskReply", method: "POST", path: "/internal/agent-api/tasks/reply", body: { channel: "#wg-raft-cli", task_number: 24, content: "on it", idempotencyKey: "k-1" } },
      { routeKey: "taskFollowing", method: "GET", path: "/internal/agent-api/tasks/following", body: undefined },
      { routeKey: "taskFollow", method: "POST", path: "/internal/agent-api/tasks/follow", body: { channel: "#wg-raft-cli", task_number: 24 } },
      { routeKey: "taskUnfollow", method: "POST", path: "/internal/agent-api/tasks/unfollow", body: { channel: "#wg-raft-cli", task_number: 24 } },
      { routeKey: "taskIdleNudge", method: "POST", path: "/internal/agent-api/tasks/idle-nudge", body: { freshSession: true, backgroundTasks: 2 } },
      { routeKey: "migrationRetry", method: "POST", path: "/internal/agent-api/migrations/retry", body: undefined },
      { routeKey: "reminderList", method: "GET", path: "/internal/agent-api/reminders?status=scheduled%2Cfired", body: undefined },
      { routeKey: "reminderCreate", method: "POST", path: "/internal/agent-api/reminders", body: { title: "check CI", delaySeconds: 60, msgId: "abcd1234" } },
      { routeKey: "reminderCancel", method: "DELETE", path: "/internal/agent-api/reminders/reminder-1", body: undefined },
      { routeKey: "reminderSnooze", method: "POST", path: "/internal/agent-api/reminders/reminder-1/snooze", body: { delaySeconds: 300 } },
      { routeKey: "reminderUpdate", method: "PATCH", path: "/internal/agent-api/reminders/reminder-1", body: { title: "check staging" } },
      {
        routeKey: "appSourceAck",
        method: "POST",
        path: "/internal/agent-api/app-sources/ack",
        body: {
          itemId: "source:item:1",
          appId: "system.fixture",
          notificationClass: "due",
          sourceRef: { kind: "source", id: "source-1", revision: "7" },
          ackAttemptId: "aaaaaaaa-1234-4123-8123-123456789abc",
        },
      },
      { routeKey: "reminderLog", method: "GET", path: "/internal/agent-api/reminders/reminder-1/log", body: undefined },
      { routeKey: "appConfigGet", method: "GET", path: "/internal/agent-api/apps/system.cleaner/config", body: undefined },
      {
        routeKey: "appConfigPatch",
        method: "PATCH",
        path: "/internal/agent-api/apps/system.cleaner/config",
        body: { expectedRevision: 0, set: { enabled: false }, unset: [] },
      },
      { routeKey: "profileShow", method: "GET", path: "/internal/agent-api/profile?target=%40HaoHao", body: undefined },
      {
        routeKey: "profileUpdate",
        method: "POST",
        path: "/internal/agent-api/profile",
        body: { displayName: "HaoHao", description: "Runtime agent", avatarUrl: "pixel:random:HaoHao" },
      },
      { routeKey: "profileAvatarUpdate", method: "POST", path: "/internal/agent-api/profile/avatar", body: undefined },
      { routeKey: "integrationList", method: "GET", path: "/internal/agent-api/integrations", body: undefined },
      { routeKey: "integrationMarketplaceSearch", method: "GET", path: "/internal/agent-api/integrations/marketplace?query=drive&limit=10", body: undefined },
      { routeKey: "integrationToken", method: "POST", path: "/internal/agent-api/integrations/token", body: { service: "drive9" } },
      { routeKey: "integrationLogin", method: "POST", path: "/internal/agent-api/integrations/login", body: { service: "drive9", scopes: ["openid", "profile"], target: "#wg-raft-cli" } },
      {
        routeKey: "integrationAppPrepare",
        method: "POST",
        path: "/internal/agent-api/integrations/app/prepare",
        body: {
          mode: "register",
          target: "#wg-raft-cli",
          clientKey: "drive9",
          name: "Drive9",
          returnUrl: "https://drive9.example/auth/raft/callback",
          scopes: ["openid", "profile"],
        },
      },
      {
        routeKey: "integrationAppRotateSecret",
        method: "POST",
        path: "/internal/agent-api/integrations/app/rotate-secret",
        body: { clientKey: "drive9" },
      },
      {
        routeKey: "integrationAppTransferOwner",
        method: "POST",
        path: "/internal/agent-api/integrations/app/transfer-owner",
        body: { clientKey: "drive9", targetAgent: "box" },
      },
      {
        routeKey: "integrationAppUpdate",
        method: "POST",
        path: "/internal/agent-api/integrations/app/update",
        body: { clientKey: "drive9", name: "Drive 9", category: "Infrastructure" },
      },
      {
        routeKey: "integrationAppManage",
        method: "POST",
        path: "/internal/agent-api/integrations/app/manage",
        body: { clientKey: "drive9", action: "request_publish" },
      },
      {
        routeKey: "integrationAppLogoUpdate",
        method: "POST",
        path: "/internal/agent-api/integrations/app/logo",
        body: undefined,
      },
      {
        routeKey: "integrationAppList",
        method: "GET",
        path: "/internal/agent-api/integrations/app",
        body: undefined,
      },
      {
        routeKey: "integrationAppStatus",
        method: "GET",
        path: "/internal/agent-api/integrations/app/status?client=drive9",
        body: undefined,
      },
      {
        routeKey: "actionPrepare",
        method: "POST",
        path: "/internal/agent-api/prepare-action",
        body: {
          target: "#wg-raft-cli",
          action: { type: "channel:create", name: "Raw SDK conformance", visibility: "public" },
        },
      },
      { routeKey: "actionWithdraw", method: "POST", path: "/internal/agent-api/actions/1a2b3c4d/withdraw", body: undefined },
      { routeKey: "attachmentUpload", method: "POST", path: "/internal/agent-api/upload", body: undefined },
      { routeKey: "attachmentUploadCapabilities", method: "GET", path: "/internal/agent-api/attachment-upload-capabilities", body: undefined },
      { routeKey: "attachmentUploadSessionCreate", method: "POST", path: "/internal/agent-api/attachment-upload-sessions", body: { channelId: "11111111-1111-4111-8111-111111111111", filename: "log.txt", mimeType: "text/plain", sizeBytes: 12, clientRequestId: "22222222-2222-4222-8222-222222222222" } },
      { routeKey: "attachmentUploadSessionComplete", method: "POST", path: "/internal/agent-api/attachment-upload-sessions/33333333-3333-4333-8333-333333333333/complete", body: undefined },
      { routeKey: "attachmentUploadSessionCancel", method: "DELETE", path: "/internal/agent-api/attachment-upload-sessions/33333333-3333-4333-8333-333333333333", body: undefined },
      { routeKey: "attachmentUploadSessionStatus", method: "GET", path: "/internal/agent-api/attachment-upload-sessions/33333333-3333-4333-8333-333333333333", body: undefined },
      { routeKey: "attachmentDownload", method: "GET", path: "/internal/agent-api/attachments/attachment%2Fwith%20space", body: undefined },
      { routeKey: "attachmentDownloadUrl", method: "GET", path: "/internal/agent-api/attachments/attachment%2Fwith%20space/url", body: undefined },
      { routeKey: "attachmentCommentsList", method: "GET", path: "/internal/agent-api/attachments/attachment%2Fwith%20space/comments?limit=25", body: undefined },
      { routeKey: "pushWebhookStatus", method: "GET", path: "/internal/agent-api/push-webhook", body: undefined },
      { routeKey: "pushWebhookRegister", method: "PUT", path: "/internal/agent-api/push-webhook", body: { url: "https://hooks.example.test/raft", secret: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" } },
      { routeKey: "pushWebhookDelete", method: "DELETE", path: "/internal/agent-api/push-webhook", body: undefined },
      { routeKey: "mentionsList", method: "GET", path: "/internal/agent-api/mentions?limit=50", body: undefined },
      ...Object.entries(firstPartyAppAgentApiSamples).map(([routeKey, sample]) => ({ routeKey, ...sample.sent })),
    ],
  );
});

test("raw client can target an internal legacy path prefix without changing route semantics", () => {
  assert.equal(
    buildAgentApiRawRoutePath("messageResolve", {
      pathPrefix: "/internal/agent/agent-1",
      params: { msgId: asMessageId("msg/with space") },
    }),
    "/internal/agent/agent-1/messages/msg%2Fwith%20space/resolve",
  );
});

test("raw client returns typed failures for request and response contract drift", async () => {
  let called = false;
  const client = createAgentApiRawClient({
    request: async () => {
      called = true;
      return {
        ok: true,
        status: 200,
        error: null,
        data: { ok: true },
      };
    },
  });

  const invalidRequest = await client.tasks.updateStatus({
    channel: "#wg-raft-cli",
    task_number: 24,
    status: "not-a-status",
  } as any);
  assert.deepEqual({
    ok: invalidRequest.ok,
    reason: invalidRequest.ok ? null : invalidRequest.reason,
  }, {
    ok: false,
    reason: "request_contract_mismatch",
  });
  assert.equal(called, false);

  const responseDrift = await client.history.read({ channel: "#wg-raft-cli" });
  assert.deepEqual({
    ok: responseDrift.ok,
    reason: responseDrift.ok ? null : responseDrift.reason,
  }, {
    ok: false,
    reason: "response_contract_mismatch",
  });

  const binaryDrift = await createAgentApiRawClient({
    request: async () => ({
      ok: true,
      status: 200,
      error: null,
      data: "not-bytes",
    }),
  }).attachments.download({ attachmentId: "attachment-1" });
  assert.deepEqual({
    ok: binaryDrift.ok,
    reason: binaryDrift.ok ? null : binaryDrift.reason,
  }, {
    ok: false,
    reason: "response_contract_mismatch",
  });
});

test("raw client normalizes transport and HTTP failures into the error envelope", async () => {
  const transportFailure = await createAgentApiRawClient({
    request: async () => {
      throw new Error("socket closed");
    },
  }).server.info();
  assert.deepEqual({
    ok: transportFailure.ok,
    reason: transportFailure.ok ? null : transportFailure.reason,
  }, {
    ok: false,
    reason: "transport_error",
  });

  const httpFailure = await createAgentApiRawClient({
    request: async () => ({
      ok: false,
      status: 403,
      data: { requiredScope: "send" },
      error: "Permission denied",
      errorCode: "SCOPE_DENIED",
      suggestedNextAction: "Ask a human to re-enable send.",
    }),
  }).messages.send({ target: "#wg-raft-cli", content: "hello" });
  assert.deepEqual({
    ok: httpFailure.ok,
    reason: httpFailure.ok ? null : httpFailure.reason,
    status: httpFailure.ok ? null : httpFailure.status,
    errorCode: httpFailure.ok ? null : httpFailure.errorCode,
    suggestedNextAction: httpFailure.ok ? null : httpFailure.suggestedNextAction,
  }, {
    ok: false,
    reason: "http_error",
    status: 403,
    errorCode: "SCOPE_DENIED",
    suggestedNextAction: "Ask a human to re-enable send.",
  });
});

test("raw client never sends a write without its body: extra positional args and a missing required body are refused", async () => {
  const sent: unknown[] = [];
  const client = createAgentApiRawClient({
    request: async (input) => {
      sent.push(input);
      return { ok: true, status: 200, error: null, data: { messageId: "m", metadata: { kind: "action-card" } } };
    },
  });
  const body = { target: "#wg-raft-cli", action: { type: "channel:create", name: "x", visibility: "public" } };
  const threeArgs = await (client.actions.prepare as unknown as (...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>)(undefined, undefined, body);
  assert.equal(threeArgs.ok, false);
  assert.equal(threeArgs.reason, "request_contract_mismatch");
  const missing = await (client.actions.prepare as unknown as (...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>)();
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "request_contract_mismatch");
  assert.equal(sent.length, 0, "nothing reached the transport");

  const ok = await client.actions.prepare(body as never);
  assert.equal(ok.ok, true);
  assert.deepEqual((sent[0] as { body: unknown }).body, body);
});

test("every POST/PUT/PATCH route called through the raw client carries its body", async () => {
  const sent: Array<{ routeKey: string; method: string; body: unknown }> = [];
  const client = createAgentApiRawClient({
    request: async (input) => {
      sent.push({ routeKey: input.routeKey, method: input.method, body: input.body });
      return { ok: true, status: 200, error: null, data: validResponses[input.routeKey as AgentApiRouteKey] };
    },
  });
  for (const routeKey of Object.keys(agentApiContract) as AgentApiRouteKey[]) {
    const route = agentApiContract[routeKey];
    if (!("body" in route.request) || !["POST", "PUT", "PATCH"].includes(route.method)) continue;
    const bodyOptional = route.request.body.safeParse(undefined).success || route.request.body.safeParse({}).success;
    const args = methodInputs[routeKey];
    const bodyArgIndex = (["params", "query", "body"] as const).filter((part) => part in route.request).length - 1;
    if (bodyOptional && args[bodyArgIndex] === undefined) continue; // e.g. channelMute: body is optional and omitted
    await methodForRoute(client, routeKey)(...args);
    const request = sent.find((r) => r.routeKey === routeKey);
    assert.ok(request, `${routeKey} was sent`);
    assert.notEqual(request!.body, undefined, `${routeKey} (${route.method}) carries a body`);
  }
});
