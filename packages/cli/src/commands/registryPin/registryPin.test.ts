/**
 * Phase-1 behaviour pins for the command registry migration (design: run
 * `raft` commands on the server for hosted agents).
 *
 * Each case runs a real argv through the CLI command tree against a recording
 * fake Agent API (see ./harness.ts) and snapshots the exact requests sent,
 * stdout, stderr and exit code. Fixtures satisfy the shared contract response
 * schemas so the formatters' real text paths are exercised.
 *
 * These pins exist so the registry refactor provably changes nothing. If a
 * snapshot changes, that is an output change: an intentional one must update
 * the snapshot in the same PR and state the reason in the PR description.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { runPinned, runPinnedSequence, scrub, type FakeRoute, type PinRun } from "./harness";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run `raft <argv>` and pin the scrubbed run; `note` distinguishes cases that share an argv. */
async function pin(argv: string[], routes: FakeRoute[], stdin?: string, note?: string): Promise<void> {
  const name = `raft ${argv.join(" ")}${note ? ` (${note})` : ""}`;
  expect(scrub(await runPinned(argv, routes, stdin))).toMatchSnapshot(name);
}

// ── Shared fixtures ─────────────────────────────────────────────────────────

const MSG_PARENT = "aaaabbbb-1111-4222-8333-444455556666";
const MSG_REPLY = "ccccdddd-1111-4222-8333-444455556666";
const MSG_DM = "eeeeffff-1111-4222-8333-444455556666";
const MSG_SENT = "12345678-9abc-4def-8123-456789abcdef";

const SERVER_INFO = {
  runtimeContext: {
    agentId: "agent-pin",
    runtime: "claude",
    model: "claude-opus",
    serverId: "server-1",
    machineName: "build-box",
    workspacePath: "/workspace/agent-pin",
  },
  serverRole: "member",
  channels: [
    { id: "channel-general", name: "general", joined: true, type: "channel", description: "team-wide chat" },
    { id: "channel-eng", name: "engineering", joined: false, type: "channel", description: "build and deploy" },
    { id: "channel-partners", name: "partners", joined: true, type: "joint", description: "Shared with another server" },
  ],
  agents: [
    { name: "agent-pin", status: "active", activity: "working", role: "member" },
    { name: "scout", status: "active", activity: "idle", role: "member", description: "release scout" },
  ],
  humans: [
    { name: "richard", role: "owner" },
    { name: "alice", role: "member" },
  ],
};

const SERVER_INFO_NOT_JOINED = {
  ...SERVER_INFO,
  channels: SERVER_INFO.channels.map((c) => (c.name === "general" ? { ...c, joined: false } : c)),
};

const historyGeneral = {
  target: "#general",
  messages: [
    {
      seq: 41,
      id: MSG_PARENT,
      createdAt: "2026-10-03T11:40:00.000Z",
      senderType: "human",
      senderName: "richard",
      content: "Can someone look at the deploy failure on staging?",
      replyCount: 1,
    },
    {
      seq: 43,
      id: MSG_SENT,
      createdAt: "2026-10-03T11:58:00.000Z",
      senderType: "agent",
      senderName: "scout",
      content: "Rolled back; root cause is the missing env var.",
    },
  ],
  has_more: false,
  has_older: false,
  has_newer: false,
  last_read_seq: 40,
  model_seen_up_to_seq: 43,
};

const historyDm = {
  target: "dm:@richard",
  messages: [
    {
      seq: 7,
      id: MSG_DM,
      createdAt: "2026-10-03T10:00:00.000Z",
      senderType: "human",
      senderName: "richard",
      content: "hey, can you help with the release notes?",
    },
  ],
  has_more: false,
  has_older: false,
  has_newer: false,
  last_read_seq: 6,
  model_seen_up_to_seq: 7,
};

const historyThread = {
  target: "#general:aaaabbbb",
  messages: [
    {
      seq: 42,
      id: MSG_REPLY,
      createdAt: "2026-10-03T11:45:00.000Z",
      senderType: "agent",
      senderName: "scout",
      content: "Looking now — the healthcheck is timing out.",
    },
  ],
  has_more: false,
  has_older: false,
  has_newer: false,
};

function events(list: unknown[]) {
  return {
    events: list,
    last_seen_msgId: list.length ? "msg-last" : null,
    last_seen_seq: list.length ? 1203 : null,
    reply_target: null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: false,
  };
}

const checkEvents = events([
  {
    channel_type: "channel",
    channel_name: "general",
    message_id: MSG_PARENT,
    timestamp: "2026-10-03T11:40:00.000Z",
    sender_type: "human",
    sender_name: "richard",
    content: "@agent-pin can you look at the deploy failure?",
    mentioned: true,
    seq: 1201,
  },
  {
    channel_type: "dm",
    channel_name: "richard",
    message_id: MSG_DM,
    timestamp: "2026-10-03T11:50:00.000Z",
    sender_type: "human",
    sender_name: "richard",
    content: "also, ping me when it is green",
    seq: 1202,
  },
  {
    channel_type: "thread",
    channel_name: "thread-aaaabbbb",
    parent_channel_name: "general",
    parent_channel_type: "channel",
    message_id: MSG_REPLY,
    timestamp: "2026-10-03T11:55:00.000Z",
    sender_type: "agent",
    sender_name: "scout",
    content: "healthcheck is timing out",
    seq: 1203,
  },
]);

function searchResult(overrides: Record<string, unknown> = {}) {
  return {
    id: MSG_PARENT,
    seq: 41,
    channelId: "channel-general",
    threadId: null,
    parentMessageId: null,
    parentMessageContent: null,
    parentChannelId: "channel-general",
    parentChannelName: "general",
    parentChannelType: "channel",
    parentChannelArchivedAt: null,
    senderId: "user-richard",
    senderType: "human",
    senderName: "richard",
    channelName: "general",
    channelType: "channel",
    channelArchivedAt: null,
    content: "Can someone look at the deploy failure on staging?",
    snippet: "look at the <mark>deploy</mark> failure",
    createdAt: "2026-10-03T11:40:00.000Z",
    ...overrides,
  };
}

const reminder = {
  reminderId: "76d9397d-1111-4222-8333-444455556666",
  ownerAgentId: "agent-pin",
  title: "check deploy status",
  fireAt: "2026-10-03T12:30:00.000Z",
  createdAt: "2026-10-03T12:00:00.000Z",
  status: "scheduled" as const,
  msgRef: "#general:aaaabbbb",
  msgPermalink: "https://raft.example/m/aaaabbbb",
  recurrence: null,
};

const claimConflict = {
  kind: "claim_conflict",
  conflictScope: "implementation_execution",
  blockedActions: ["claim"],
  unblockedActionExamples: ["comment in thread"],
  currentAssignee: { type: "agent", name: "scout" },
  taskStatus: "in_progress",
  claimedAt: "2026-10-03T09:00:00.000Z",
  observedAt: "2026-10-03T12:00:00.000Z",
};

const actionPrepared = { messageId: "99990000-1111-4222-8333-444455556666", metadata: { kind: "action-card" } };

// ── Cases ──────────────────────────────────────────────────────────────────

test("message read", async () => {
  await pin(["message", "read", "--target", "#general"], [{ path: /\/history\?/, data: historyGeneral }]);
  await pin(["message", "read", "--target", "dm:@richard"], [{ path: /\/history\?/, data: historyDm }]);
  await pin(["message", "read", "--target", "#general:aaaabbbb"], [{ path: /\/history\?/, data: historyThread }]);
});

test("message check", async () => {
  await pin(["message", "check"], [{ path: /\/events\?/, data: checkEvents }], undefined, "channel, DM and thread reply");
  await pin(["message", "check"], [{ path: /\/events\?/, data: events([]) }], undefined, "empty inbox");
});

test("message send", async () => {
  await pin(
    ["message", "send", "--target", "#general"],
    [{ method: "POST", path: /\/send$/, data: { ok: true, state: "sent", messageId: MSG_SENT, messageSeq: 44 } }],
    "hello",
    "sent",
  );
  // Held, real wire shape: held envelopes carry no channel identity fields.
  await pin(
    ["message", "send", "--target", "#general"],
    [{
      method: "POST",
      path: /\/send$/,
      data: {
        ok: true,
        state: "held",
        outcome: "held",
        subtype: "freshness",
        decision: "local_hold",
        producerFactId: "freshness_decision_fact:pin-1",
        newMessageCount: 2,
        shownMessageCount: 2,
        omittedMessageCount: 0,
        seenUpToSeq: 43,
        seenUpToMessageId: MSG_SENT,
        mentionAnnotation: { formalMentionCount: 0 },
        heldMessages: [
          { seq: 42, message_id: MSG_REPLY, sender_name: "scout", sender_type: "agent", timestamp: "2026-10-03T11:45:00.000Z", content: "healthcheck is timing out" },
          { seq: 43, message_id: MSG_SENT, sender_name: "richard", sender_type: "human", timestamp: "2026-10-03T11:58:00.000Z", content: "rolling back now" },
        ],
      },
    }],
    "hello",
    "held, envelopes without channel fields",
  );
  // Held, envelopes with channel fields.
  await pin(
    ["message", "send", "--target", "#general"],
    [{
      method: "POST",
      path: /\/send$/,
      data: {
        state: "held",
        newMessageCount: 1,
        shownMessageCount: 1,
        omittedMessageCount: 0,
        seenUpToSeq: 42,
        heldMessages: [
          {
            seq: 42,
            message_id: MSG_REPLY,
            channel_type: "channel",
            channel_name: "general",
            sender_name: "scout",
            sender_type: "agent",
            timestamp: "2026-10-03T11:45:00.000Z",
            content: "healthcheck is timing out",
          },
        ],
      },
    }],
    "hello",
    "held, envelopes with channel fields",
  );
  await pin(
    ["message", "send", "--target", "#general"],
    [{
      method: "POST",
      path: /\/send$/,
      data: { ok: true, state: "sent", messageId: MSG_SENT, messageSeq: 44, unresolvedMentionHandles: ["@wenyi"] },
    }],
    "hello @wenyi",
    "sent with unresolved mention",
  );
});

test("message send --discard-draft", async () => {
  // A held send saves a draft under a generated key; --discard-draft acts on it.
  const heldRoute: FakeRoute[] = [{
    method: "POST",
    path: /\/send$/,
    data: {
      state: "held",
      newMessageCount: 1,
      shownMessageCount: 1,
      omittedMessageCount: 0,
      seenUpToSeq: 42,
      heldMessages: [
        { seq: 42, message_id: MSG_REPLY, sender_name: "scout", sender_type: "agent", timestamp: "2026-10-03T11:45:00.000Z", content: "healthcheck is timing out" },
      ],
    },
  }];
  const discard = (key?: string) => ["message", "send", "--discard-draft", "--target", "#general", ...(key === undefined ? [] : ["--expected-draft-key", key])];
  /** The draft key is random per run: steps are pinned with it replaced. */
  const steps = (key: string, runs: Array<{ argv: string[]; run: PinRun }>) =>
    runs.map(({ argv, run }) => JSON.parse(JSON.stringify({ argv, run: scrub(run) }).split(key).join("<draft-key>")) as unknown);

  const match = await runPinnedSequence(async (run) => {
    const held = await run(["message", "send", "--target", "#general"], heldRoute, "hello");
    const key = (held.requests[0]?.body as { idempotencyKey: string }).idempotencyKey;
    const first = { argv: discard(key), run: await run(discard(key), []) };
    const again = { argv: discard(key), run: await run(discard(key), []) };
    return steps(key, [first, again]);
  });
  expect(match).toMatchSnapshot("raft message send --discard-draft --target #general --expected-draft-key <draft-key> (match, then again: no draft)");

  const mismatch = await runPinnedSequence(async (run) => {
    const held = await run(["message", "send", "--target", "#general"], heldRoute, "hello");
    const key = (held.requests[0]?.body as { idempotencyKey: string }).idempotencyKey;
    const wrong = { argv: discard("not-the-draft-key"), run: await run(discard("not-the-draft-key"), []) };
    const right = { argv: discard(key), run: await run(discard(key), []) };
    return steps(key, [wrong, right]);
  });
  expect(mismatch).toMatchSnapshot("raft message send --discard-draft --target #general --expected-draft-key not-the-draft-key (mismatch: nothing discarded, then the right key)");

  await pin(discard("not-the-draft-key"), [], undefined, "no draft");
});

test("message search", async () => {
  const data = {
    results: [
      searchResult(),
      searchResult({
        id: MSG_REPLY,
        seq: 42,
        channelId: "thread-channel-1",
        threadId: "thread-channel-1",
        parentMessageId: MSG_PARENT,
        parentMessageContent: "Can someone look at the deploy failure on staging?",
        channelName: "thread-aaaabbbb",
        channelType: "thread",
        senderId: "agent-scout",
        senderType: "agent",
        senderName: "scout",
        content: "deploy healthcheck is timing out",
        snippet: "<mark>deploy</mark> healthcheck is timing out",
        createdAt: "2026-10-03T11:45:00.000Z",
      }),
    ],
    hasMore: false,
  };
  await pin(["message", "search", "--query", "deploy"], [{ path: /search/, data }]);
  await pin(["message", "search", "--target", "#general", "--query", "deploy"], [{ path: /search/, data: { results: [searchResult()], hasMore: false } }]);
});

test("message react", async () => {
  await pin(["message", "react", "--message-id", "aaaabbbb", "--emoji", "👍"], [{ path: /reaction/, data: { ok: true } }]);
});

test("inbox check", async () => {
  const items = [
    { target: "dm:@richard", kind: "dm", unread: 3, mentions: 0, lastReadSeq: 1200, activitySeq: 1210, latestSenderName: "richard", latestAt: "2026-10-03T11:48:00.000Z" },
    { target: "#general:aaaabbbb", kind: "thread", unread: 1, mentions: 1, lastReadSeq: 1180, activitySeq: 1190, latestSenderName: "scout", latestAt: "2026-10-03T11:00:00.000Z" },
    { target: "#engineering", kind: "channel", unread: 12, mentions: 0, lastReadSeq: 900, activitySeq: 1100, latestSenderName: "alice", latestAt: "2026-10-02T18:00:00.000Z" },
  ];
  await pin(["inbox", "check"], [{
    path: /inbox\/conversations/,
    data: { view: "unread", items, hasMore: true, nextBeforeSeq: 1100, totals: { conversations: 7, dms: 1, mentions: 1 } },
  }]);
  await pin(["inbox", "check", "--view", "mentions"], [{
    path: /inbox\/conversations/,
    data: { view: "mentions", items: [items[1]], hasMore: false, nextBeforeSeq: null, totals: { conversations: 7, dms: 1, mentions: 1 } },
  }]);
});

test("inbox check (inbox items, RFC 081)", async () => {
  const reminderId = "76d9397d-1111-4222-8333-444455556666";
  const rows = [
    { target: "dm:@richard", kind: "conversation", conversationKind: "dm", unread: 3, mentions: 0, latestSender: { name: "richard", type: "user" }, preview: "can you look at the release notes?", previewTruncated: false, firstUnreadAt: "2026-10-03T11:40:00.000Z", latestAt: "2026-10-03T11:48:00.000Z", preLaunch: false },
    { target: "app:stamp/pr-13754", kind: "app", objectRef: "pr-13754", app: { key: "stamp", name: "Stamp" }, related: { target: "#general:aaaabbbb" }, unread: 2, latestSender: { name: "Stamp", type: "app" }, preview: "checks failed on 9ed73d5", previewTruncated: true, firstUnreadAt: "2026-10-03T11:30:00.000Z", latestAt: "2026-10-03T11:35:00.000Z", preLaunch: false },
    { target: `reminder:${reminderId}`, kind: "reminder", app: { key: "system.reminder", name: "Reminder" }, ack: [{ app: "system.reminder", id: reminderId, revision: "2" }], unread: 1, latestSender: null, preview: "check the deploy", previewTruncated: false, firstUnreadAt: "2026-10-03T11:00:00.000Z", latestAt: "2026-10-03T11:00:00.000Z", preLaunch: false },
  ];
  await pin(["inbox", "check"], [{
    path: /inbox\/conversations/,
    data: { view: "unread", items: [], rows, hasMore: false, nextBeforeSeq: null, totals: { conversations: 1, dms: 1, mentions: 0 }, preLaunch: { count: 9, before: "2026-09-01" }, omitted: { app: 0, reminder: 1 } },
  }]);
});

test("inbox read / dismiss", async () => {
  await pin(["inbox", "read", "--target", "#general"], [{
    method: "POST",
    path: /inbox\/read$/,
    data: {
      target: "#general",
      kind: "conversation",
      entries: [
        { seq: 1201, message_id: MSG_PARENT, channel_type: "channel", channel_name: "general", timestamp: "2026-10-03T11:40:00.000Z", sender_type: "human", sender_name: "richard", content: "deploy is green" },
        { seq: 1202, message_id: MSG_REPLY, channel_type: "channel", channel_name: "general", timestamp: "2026-10-03T11:41:00.000Z", sender_type: "agent", sender_name: "scout", content: "thanks" },
      ],
      unreadBefore: 4,
      remaining: 2,
      remainingCapped: false,
      consumed: false,
      nextCursor: null,
    },
  }]);
  await pin(["inbox", "read", "--target", "#general"], [{
    method: "POST",
    path: /inbox\/read$/,
    response: { ok: false, status: 404, error: "Inbox items are off", errorCode: "INBOX_ITEMS_DISABLED", data: null },
  }], undefined, "inbox items off");
  await pin(["inbox", "dismiss", "--before", "2026-09-01"], [{
    method: "POST",
    path: /inbox\/dismiss$/,
    data: { dismissed: 9, conversations: 9, appItems: 0, skippedNeedsAck: 1, earliestActivityAt: "2026-08-02T18:00:00.000Z", remaining: 0 },
  }]);
  await pin(["inbox", "dismiss"], [], undefined, "neither flag");
});

test("thread unfollow", async () => {
  await pin(["thread", "unfollow", "--target", "#general:aaaabbbb"], [{ path: /unfollow/, data: { ok: true } }]);
});

test("channel join / leave / members", async () => {
  await pin(["channel", "join", "--target", "#general"], [
    { method: "GET", path: /\/server$/, data: SERVER_INFO_NOT_JOINED },
    { method: "POST", path: /join/, data: { ok: true } },
  ], undefined, "not yet joined");
  await pin(["channel", "join", "--target", "#general"], [{ method: "GET", path: /\/server$/, data: SERVER_INFO }], undefined, "already joined");
  await pin(["channel", "leave", "--target", "#general"], [
    { method: "GET", path: /\/server$/, data: SERVER_INFO },
    {
      method: "POST",
      path: /leave/,
      data: {
        ok: true,
        attention: {
          stillArrives: ["If #general is public, followed threads still notify until you unfollow them."],
          threadBoundary: "Leaving a channel does not unfollow existing thread follows.",
        },
      },
    },
  ]);
  await pin(["channel", "members", "#general"], [{
    path: /channel-members/,
    data: {
      channel: { ref: "#general", type: "channel" },
      agents: [{ name: "agent-pin", status: "active" }, { name: "scout", status: "inactive" }],
      humans: [{ name: "richard", role: "owner", description: "founder" }, { name: "alice", role: "member" }],
    },
  }]);
});

test("server info", async () => {
  const routes = [{ path: /\/server$/, data: SERVER_INFO }];
  await pin(["server", "info"], routes);
  await pin(["server", "info", "--channels"], routes);
  await pin(["server", "info", "--full"], routes);
});

test("user info", async () => {
  // One GET /users/:name/channels: the user's server.info entry and the rows
  // of the window channels whose roster lists them (#general lists agent-pin,
  // scout, richard and alice; #engineering scout and alice; #partners
  // richard). These rows carry no channel roles, so the pinned text does not
  // depend on whose role a row would report.
  const [general, engineering, partners] = SERVER_INFO.channels;
  const page = { total: 3, offset: 0, limit: 50 };
  const routes: FakeRoute[] = [
    {
      path: /\/users\/richard\/channels\?offset=0&limit=50$/,
      data: { user: SERVER_INFO.humans[0], kind: "human", memberships: [general, partners], uncheckedCount: 0, page },
    },
    {
      path: /\/users\/scout\/channels\?offset=0&limit=50$/,
      data: { user: SERVER_INFO.agents[1], kind: "agent", memberships: [general, engineering], uncheckedCount: 0, page },
    },
  ];
  await pin(["user", "info", "richard"], routes);
  await pin(["user", "info", "scout"], routes);
});

test("task list", async () => {
  const tasks = [
    { taskNumber: 3, status: "todo", title: "Fix the staging healthcheck", createdByName: "richard", createdByHandle: "richard", messageId: MSG_PARENT, revision: 0, description: null },
    { taskNumber: 2, status: "in_progress", title: "Write release notes", claimedById: "agent-scout", claimedByName: "scout", createdByName: "richard", createdByHandle: "richard", messageId: MSG_REPLY, revision: 2, description: "for 0.0.31" },
  ];
  await pin(["task", "list", "--target", "#general"], [{ path: /tasks/, data: { tasks, scope: "channel" } }]);
  await pin(["task", "list", "--mine"], [{
    path: /tasks/,
    data: {
      tasks: [{ ...tasks[1], claimedById: "agent-pin", claimedByName: "agent-pin", channelRef: "#general" }],
      scope: "mine",
      coverage: {
        status: "incomplete",
        visibleChannelTypes: ["channel", "private", "joint", "dm"],
        includesArchived: true,
        inaccessibleScope: "not_asserted",
        reason: "membership can change after assignment",
      },
      pagination: { mode: "complete", truncated: false },
    },
  }]);
});

test("task claim", async () => {
  const argv = ["task", "claim", "--target", "#general", "--number", "3"];
  await pin(argv, [{ path: /claim/, data: { results: [{ taskNumber: 3, messageId: MSG_PARENT, success: true }] } }], undefined, "claimed");
  await pin(argv, [{
    path: /claim/,
    data: { results: [{ taskNumber: 3, messageId: MSG_PARENT, success: false, reason: "already assigned to @scout", conflict: claimConflict }] },
  }], undefined, "refused: held by another assignee");
  await pin(argv, [{
    path: /claim/,
    data: {
      state: "held",
      newMessageCount: 1,
      shownMessageCount: 1,
      omittedMessageCount: 0,
      seenUpToSeq: 42,
      heldMessages: [
        { seq: 42, message_id: MSG_REPLY, sender_name: "scout", sender_type: "agent", timestamp: "2026-10-03T11:45:00.000Z", content: "I'll take #3 actually" },
      ],
    },
  }], undefined, "freshness held");
});

test("task update", async () => {
  await pin(
    ["task", "update", "--target", "#general", "--number", "3", "--status", "in_review"],
    [{ path: /tasks/, data: { ok: true } }],
  );
});

test("task create", async () => {
  const created = (taskNumber: number, title: string) => ({
    taskNumber,
    messageId: `${taskNumber}${taskNumber}${taskNumber}${taskNumber}0000-1111-4222-8333-444455556666`,
    title,
    status: "todo",
    claimedByType: null,
    claimedById: null,
    claimedByName: null,
    claimedAt: null,
    requiresResourceReceipt: false,
  });
  await pin(["task", "create", "--target", "#general", "--title", "Fix it"], [{ path: /tasks/, data: { tasks: [created(4, "Fix it")] } }]);
  await pin(
    ["task", "create", "--target", "#general", "--title", "Fix it", "--title", "Test it"],
    [{ path: /tasks/, data: { tasks: [created(4, "Fix it"), created(5, "Test it")] } }],
  );
});

test("reminder schedule / list / cancel", async () => {
  await pin(
    ["reminder", "schedule", "--title", "check deploy status", "--delay-seconds", "1800", "--message-id", "aaaabbbb"],
    [{ method: "POST", path: /reminders/, data: { reminder } }],
  );
  await pin(["reminder", "list"], [{
    path: /reminders/,
    data: {
      reminders: [
        reminder,
        {
          ...reminder,
          reminderId: "88880000-1111-4222-8333-444455556666",
          title: "daily standup summary",
          fireAt: "2026-10-04T01:00:00.000Z",
          recurrence: { kind: "daily", description: "daily at 09:00 Asia/Singapore" },
        },
        { ...reminder, reminderId: "99990000-aaaa-4222-8333-444455556666", title: "overdue check", fireAt: "2026-10-03T11:00:00.000Z", status: "fired", firedAt: "2026-10-03T11:00:00.000Z" },
      ],
    },
  }]);
  await pin(["reminder", "list", "--status", "fired"], [{
    path: /reminders/,
    data: {
      reminders: [
        { ...reminder, reminderId: "99990000-aaaa-4222-8333-444455556666", title: "overdue check", fireAt: "2026-10-03T11:00:00.000Z", status: "fired", firedAt: "2026-10-03T11:00:00.000Z" },
      ],
    },
  }]);
  await pin(["reminder", "cancel", "--id", "76d9397d"], [
    { method: "GET", path: /reminders/, data: { reminders: [reminder] } },
    { method: "DELETE", path: /reminders/, data: { reminder: { ...reminder, status: "canceled" } } },
  ]);
});

test("manual get / search", async () => {
  await pin(
    ["manual", "get", "index", "--intent", "Learn available Raft workflows", "--reason", "Need the topic catalog now"],
    [{
      path: /knowledge/,
      data: {
        ok: true,
        docId: "index",
        topicOrPath: "index",
        docVersion: "sha256:abc123",
        docState: "available",
        contentType: "text/markdown",
        content: "# Raft manual\n\n- `messaging` — sending and reading\n- `tasks` — task lifecycle\n",
      },
    }],
  );
  await pin(
    ["manual", "search", "preview before merge", "--intent", "Learn available Raft workflows", "--reason", "Need the topic catalog now"],
    [{
      path: /knowledge/,
      data: {
        ok: true,
        query: "preview before merge",
        scope: null,
        results: [
          { slug: "review/preview", title: "Preview before merge", firstScreen: "Deploy a preview, link it in the PR, then merge." },
          { slug: "tasks", title: "Tasks", firstScreen: "Claim, update, and close tasks." },
        ],
      },
    }],
  );
});

const ACTIONS: Record<string, unknown> = {
  "channel:create": {
    type: "channel:create",
    name: "release-war-room",
    description: "Coordinate the 0.0.31 release",
    initialHumans: ["@richard"],
    initialAgents: ["@scout"],
    draftHint: "richard asked for a dedicated release channel",
  },
  "agent:create": {
    type: "agent:create",
    name: "release-bot",
    description: "Drafts release notes",
    suggestedComputer: "build-box",
  },
  "channel:add_member": {
    type: "channel:add_member",
    channel: "#general",
    humans: ["@alice"],
    agents: ["@scout"],
  },
  "integration:approve_agent_login": {
    type: "integration:approve_agent_login",
    requestId: "11111111-2222-4333-8444-555555555555",
    agentId: "22222222-3333-4444-8555-666666666666",
    agentName: "scout",
    clientId: "33333333-4444-4555-8666-777777777777",
    clientKey: "linear",
    clientName: "Linear",
    scopes: ["issues:read", "issues:write"],
  },
  "integration:install_marketplace_app": {
    type: "integration:install_marketplace_app",
    clientId: "33333333-4444-4555-8666-777777777777",
    clientKey: "linear",
    clientName: "Linear",
    clientNameSha256: "a".repeat(64),
    agentId: "22222222-3333-4444-8555-666666666666",
    agentName: "scout",
    scopes: ["issues:read"],
  },
  "integration:register_app": {
    type: "integration:register_app",
    name: "Deploy Dashboard",
    returnUrl: "https://deploy.example/callback",
    homepageUrl: "https://deploy.example",
    description: "Shows deploy status",
  },
  "integration:update_app_registration": {
    type: "integration:update_app_registration",
    clientKey: "deploy-dashboard",
    description: "Shows deploy and rollback status",
  },
  "integration:recover_app_owner": {
    type: "integration:recover_app_owner",
    clientKey: "deploy-dashboard",
    targetAgent: "@scout",
  },
  "feedback:submit": {
    type: "feedback:submit",
    feedbackType: "problem",
    message: "Search does not find messages in DMs",
  },
  "plan:upgrade": {
    type: "plan:upgrade",
    reason: "You asked for the launch notes from March, and Free can't show messages older than 30 days.",
    gate: "history_30d",
  },
};

test("action prepare", async () => {
  for (const [type, action] of Object.entries(ACTIONS)) {
    const run = scrub(await runPinned(
      ["action", "prepare", "--target", "#general"],
      [{ method: "POST", path: /action/, data: actionPrepared }],
      JSON.stringify(action),
    ));
    expect(run).toMatchSnapshot(type);
  }
  // The Server checks the card: the CLI sends it as written and prints the refusal.
  const invalid = scrub(await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{
      method: "POST",
      path: /action/,
      response: { ok: false, status: 400, error: "channel:add_member must include at least one human or agent", errorCode: "INVALID_PAYLOAD", data: null },
    }],
    JSON.stringify({ type: "channel:add_member", channel: "#general" }),
  ));
  expect(invalid.requests).toHaveLength(1);
  expect(invalid).toMatchSnapshot("channel:add_member without members (server refusal)");
  // A card type this CLI doesn't know reaches the Server as written.
  const unknownType = scrub(await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /action/, data: actionPrepared }],
    JSON.stringify({ type: "future:card", title: "Plan the offsite" }),
  ));
  expect(unknownType).toMatchSnapshot("a card type this CLI does not know (sent as written)");
  // JSON without a card type is refused before anything is sent.
  const noType = scrub(await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /action/, data: actionPrepared }],
    JSON.stringify({ name: "demo" }),
  ));
  expect(noType.requests).toEqual([]);
  expect(noType).toMatchSnapshot("no type (refused before sending)");
  // A plan:upgrade repeat within a day posts nothing; the server answers with the card already there.
  const existing = scrub(await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{ method: "POST", path: /action/, data: { ...actionPrepared, existing: true } }],
    JSON.stringify(ACTIONS["plan:upgrade"]),
  ));
  expect(existing).toMatchSnapshot("plan:upgrade already posted (existing)");
  // An upgrade card takes the reason and the gate only: the Server refuses any other field, saying why and what to do.
  const withText = scrub(await runPinned(
    ["action", "prepare", "--target", "#general"],
    [{
      method: "POST",
      path: /action/,
      response: {
        ok: false,
        status: 400,
        error: 'The card was refused: plan:upgrade takes only "reason" and an optional "gate". Remove the other fields.',
        errorCode: "INVALID_ACTION",
        suggestedNextAction: "Fix the fields named above and prepare the card again.",
        data: null,
      },
    }],
    JSON.stringify({ ...ACTIONS["plan:upgrade"] as object, message: "Upgrade!" }),
  ));
  expect(withText.requests).toHaveLength(1);
  expect(withText).toMatchSnapshot("plan:upgrade with agent text (server refusal)");
  // In a shared channel the server refuses it; the agent reads why and where to post instead.
  const shared = scrub(await runPinned(
    ["action", "prepare", "--target", "#partners"],
    [{
      method: "POST",
      path: /action/,
      response: {
        ok: false,
        status: 403,
        error: "Upgrade cards can't be posted in a shared channel: upgrading is for this server's own people. Post it in one of this server's channels or a DM instead.",
        errorCode: "JOINT_CHANNEL_NOT_ALLOWED",
        data: null,
      },
    }],
    JSON.stringify(ACTIONS["plan:upgrade"]),
  ));
  expect(shared).toMatchSnapshot("plan:upgrade in a shared channel (server refusal)");
});

test("server error responses", async () => {
  await pin(["task", "claim", "--target", "#general", "--number", "3"], [{
    path: /claim/,
    response: {
      ok: false,
      status: 403,
      error: "You are not a member of #general",
      errorCode: "FORBIDDEN",
      suggestedNextAction: "Join #general first: raft channel join --target \"#general\"",
      data: null,
    },
  }], undefined, "403 forbidden");
  await pin(["message", "read", "--target", "#general:deadbeef"], [{
    path: /history/,
    response: {
      ok: false,
      status: 404,
      error: "Thread not found: #general:deadbeef",
      errorCode: "NOT_FOUND",
      suggestedNextAction: "Check the short id with raft message read --target \"#general\".",
      data: null,
    },
  }], undefined, "404 not found");
});

test("RaftBench service refusal uses the existing delivery response without INVALID_RESPONSE", async () => {
  const run = await runPinned(["mention", "delivery", "--message", MSG_SENT], [{
    path: /\/messages\/.+\/mention-deliveries$/,
    data: { messageId: MSG_SENT, deliveries: [{ targetHandle: "raftbench-service", outcome: "lost", reasonCategory: "unclassified" }] },
  }]);
  expect(run.exitCode).toBe(0);
  expect(run.stderr).toBe("");
  expect(run.stdout).toContain("LOST — cause is outside the seat-availability set; re-route");
});
