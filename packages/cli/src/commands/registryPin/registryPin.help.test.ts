/**
 * Phase-1 behaviour pins, part 2: what the registry migration must keep that
 * registryPin.test.ts does not reach — `--help` text, parse-stage errors,
 * `--peer-kind`, missing stdin, managed-runner (daemon) variants, reminder
 * seal-guard paths and naive-timestamp search.
 *
 * Same harness and rules as registryPin.test.ts: the binary's own program
 * (buildRaftProgram + runRaftArgv) against a recording fake Agent API; a
 * changed snapshot is an output change and must be justified in the PR.
 */
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PIN_MANAGED_AGENT, runPinned, scrub, type FakeRoute, type PinOptions } from "./harness";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Run `raft <argv>` and pin the scrubbed run; `note` distinguishes cases that share an argv. */
async function pin(argv: string[], routes: FakeRoute[], stdin?: string, note?: string, options?: PinOptions): Promise<void> {
  const name = `raft ${argv.join(" ")}${note ? ` (${note})` : ""}`;
  expect(scrub(await runPinned(argv, routes, stdin, options))).toMatchSnapshot(name);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const MSG_PARENT = "aaaabbbb-1111-4222-8333-444455556666";
const MSG_DM = "eeeeffff-1111-4222-8333-444455556666";
const MSG_SENT = "12345678-9abc-4def-8123-456789abcdef";
const LEASE_EVENT_ID = "0f3b6c2e-8d41-4a7b-9c55-1e2f3a4b5c6d";
const REMINDER_ID = "76d9397d-1111-4222-8333-444455556666";

const historyDm = {
  target: "dm:@richard",
  messages: [
    {
      seq: 7,
      id: MSG_DM,
      createdAt: "2026-10-03T10:00:00.000Z",
      senderType: "agent",
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

function events(list: unknown[], extra: Record<string, unknown> = {}) {
  return {
    events: list,
    last_seen_msgId: list.length ? "msg-last" : null,
    last_seen_seq: list.length ? 1203 : null,
    reply_target: null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: false,
    ...extra,
  };
}

const reminder = {
  reminderId: REMINDER_ID,
  ownerAgentId: "agent-pin",
  title: "check deploy status",
  fireAt: "2026-10-03T12:30:00.000Z",
  createdAt: "2026-10-03T12:00:00.000Z",
  status: "scheduled" as const,
  msgRef: "#general:aaaabbbb",
  msgPermalink: "https://raft.example/m/aaaabbbb",
  recurrence: null,
};

const reminderDueItem = {
  source: "app",
  itemId: `reminder:${REMINDER_ID}:1`,
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "1" },
  primaryAction: { kind: "run_command", commandId: "reminder.ack" },
  actionCli: "raft reminder ack --id 76d9397d --revision 1",
  retention: "until_explicit_ack",
};

const reminderSeal = {
  appId: "system.reminder",
  notificationClass: "due",
  sourceRef: { kind: "reminder", id: REMINDER_ID, revision: "1" },
  owner: "@Stone",
  until: "explicit release",
  sealedAtMs: 1_000,
};

const managed: PinOptions = { agent: PIN_MANAGED_AGENT, recordHeaders: true };

// ── --help ──────────────────────────────────────────────────────────────────

const HELP_PATHS: string[][] = [
  [],
  ["message"],
  ["message", "read"],
  ["message", "check"],
  ["message", "send"],
  ["message", "search"],
  ["message", "react"],
  ["message", "update-card"],
  ["inbox"],
  ["inbox", "check"],
  ["inbox", "read"],
  ["inbox", "dismiss"],
  ["context"],
  ["context", "search"],
  ["context", "read"],
  ["thread"],
  ["thread", "follow"],
  ["thread", "unfollow"],
  ["channel"],
  ["channel", "join"],
  ["channel", "leave"],
  ["channel", "members"],
  ["server"],
  ["server", "info"],
  ["user"],
  ["user", "info"],
  ["task"],
  ["task", "list"],
  ["task", "claim"],
  ["task", "update"],
  ["task", "create"],
  ["reminder"],
  ["reminder", "schedule"],
  ["reminder", "list"],
  ["reminder", "cancel"],
  ["reminder", "snooze"],
  ["reminder", "update"],
  ["manual"],
  ["manual", "get"],
  ["manual", "search"],
  ["knowledge"],
  ["knowledge", "get"],
  ["knowledge", "search"],
  ["action"],
  ["action", "prepare"],
  ["action", "withdraw"],
  ["artifact"],
  ["artifact", "read"],
  ["artifact", "list"],
  ["artifact", "comments"],
  ["artifact", "download"],
  ["artifact", "pull"],
  ["artifact", "push"],
  ["artifact", "check"],
  ["artifact", "comment"],
  ["artifact", "review"],
  ["artifact", "resolve"],
  ["artifact", "reopen"],
  ["artifact", "follow"],
  ["artifact", "unfollow"],
  ["artifact", "move"],
  ["artifact", "delete"],
  ["artifact", "save"],
  ["agent", "logout"],
  ["migration"],
  ["migration", "retry"],
  ["proc"],
  ["proc", "start"],
  ["proc", "list"],
  ["proc", "logs"],
  ["proc", "stop"],
];

test("--help", async () => {
  for (const path of HELP_PATHS) {
    const run = scrub(await runPinned([...path, "--help"], []));
    expect(run.requests).toEqual([]);
    expect(run).toMatchSnapshot(`raft ${[...path, "--help"].join(" ")}`);
  }
});

// ── Parse-stage errors ──────────────────────────────────────────────────────

test("parse errors", async () => {
  await pin(["message", "read", "--bogus"], [], undefined, "unknown option");
  await pin(["channel", "members"], [], undefined, "missing required argument");
  await pin(["manual", "get"], [], undefined, "missing topic: manual-specific next action");
  await pin(["message", "frobnicate"], [], undefined, "unknown subcommand");
  await pin(["frobnicate"], [], undefined, "unknown group");
  await pin(["message"], [], undefined, "group without a subcommand");
});

// ── --peer-kind ─────────────────────────────────────────────────────────────

test("--peer-kind", async () => {
  await pin(["message", "read", "--target", "dm:@richard", "--peer-kind", "agent"], [{ path: /\/history\?/, data: historyDm }]);
  await pin(
    ["message", "send", "--target", "dm:@richard", "--peer-kind", "human"],
    [{ method: "POST", path: /\/send$/, data: { ok: true, state: "sent", messageId: MSG_SENT, messageSeq: 8 } }],
    "hello",
  );
  await pin(
    ["action", "prepare", "--target", "dm:@richard", "--peer-kind", "agent"],
    [{ method: "POST", path: /action/, data: { messageId: "99990000-1111-4222-8333-444455556666", metadata: { kind: "action-card" } } }],
    JSON.stringify({ type: "agent:create", name: "release-bot", description: "Drafts release notes" }),
  );
});

// ── No stdin (interactive TTY, nothing piped) ───────────────────────────────

test("no stdin", async () => {
  await pin(["message", "send", "--target", "#general"], [], undefined, "TTY stdin, no content");
  await pin(["action", "prepare", "--target", "#general"], [], undefined, "TTY stdin, no action JSON");
});

// ── Managed runner (daemon-local inbox) ─────────────────────────────────────

test("managed runner: message check", async () => {
  await pin(["message", "check"], [
    {
      method: "GET",
      path: /\/events\?/,
      data: events([{
        seq: 0,
        channel_type: "dm",
        channel_name: "third-party-agent-events:agent-pin",
        message_id: LEASE_EVENT_ID,
        timestamp: "2026-10-03T11:59:00.000Z",
        sender_type: "third_party_app",
        sender_name: "stamp",
        content: "Third-party event: pr approved",
        third_party_event: {
          id: LEASE_EVENT_ID,
          kind: "pr_approved",
          client_id: "stamp",
          client_name: "Stamp",
          payload_hash: "sha256:0123abcd",
          payload: { pr: 42, state: "approved" },
          expires_at: "2026-10-03T12:01:00.000Z",
        },
      }], {
        third_party_lease: { batch_id: "batch-1", event_ids: [LEASE_EVENT_ID], expires_at: "2026-10-03T12:01:00.000Z" },
      }),
    },
    { method: "POST", path: /third-party-events\/ack$/, data: { ok: true, batchId: "batch-1", acked: [LEASE_EVENT_ID] } },
  ], undefined, "leased third-party event, acked after output", managed);
  await pin(["message", "check"], [
    {
      method: "GET",
      path: /\/events\?/,
      data: events([{
        channel_type: "channel",
        channel_name: "general",
        message_id: MSG_PARENT,
        timestamp: "2026-10-03T11:40:00.000Z",
        sender_type: "human",
        sender_name: "richard",
        content: "@agent-pin can you look at the deploy failure?",
        mentioned: true,
        seq: 1201,
      }]),
    },
  ], undefined, "channel message, no lease", managed);
  await pin(["message", "check"], [
    { method: "GET", path: /\/events\?/, data: events([]) },
    { method: "GET", path: /\/inbox$/, data: { rows: [], items: [reminderDueItem], pending_app_items: 1 } },
  ], undefined, "empty inbox, app items pending", managed);
});

test("managed runner: inbox check", async () => {
  await pin(["inbox", "check"], [
    {
      path: /inbox\/conversations/,
      data: {
        view: "unread",
        items: [{ target: "dm:@richard", kind: "dm", unread: 3, mentions: 0, lastReadSeq: 1200, activitySeq: 1210, latestSenderName: "richard", latestAt: "2026-10-03T11:48:00.000Z" }],
        hasMore: false,
        nextBeforeSeq: null,
        totals: { conversations: 1, dms: 1, mentions: 0 },
      },
    },
    {
      path: /\/inbox$/,
      data: { rows: [{ target: "dm:@richard", pendingCount: 2, flags: ["dm"] }], items: [reminderDueItem], seals: [reminderSeal] },
    },
  ], undefined, "daemon pending rows, app item and seal", managed);
  await pin(["inbox", "check"], [
    {
      path: /inbox\/conversations/,
      data: { view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 } },
    },
    { path: /\/inbox$/, response: { ok: false, status: 502, error: "daemon unavailable", data: null } },
  ], undefined, "daemon snapshot unavailable", managed);
});

// ── Reminder seal guard, snooze, update ─────────────────────────────────────

test("reminder cancel seal guard", async () => {
  const cancelRoutes: FakeRoute[] = [
    { method: "GET", path: /reminders\?/, data: { reminders: [reminder] } },
    { method: "DELETE", path: /reminders/, data: { reminder: { ...reminder, status: "canceled" } } },
  ];
  // External agent (seals not checked, diagnostic on stderr) is pinned in
  // registryPin.test.ts "reminder schedule / list / cancel".
  await pin(["reminder", "cancel", "--id", "76d9397d"], [
    { method: "GET", path: /\/inbox$/, data: { rows: [], items: [], seals: [] } },
    ...cancelRoutes,
  ], undefined, "managed runner: no seal", managed);
  await pin(["reminder", "cancel", "--id", "76d9397d"], [
    { method: "GET", path: /\/inbox$/, data: { rows: [], items: [reminderDueItem], seals: [reminderSeal] } },
    ...cancelRoutes,
  ], undefined, "managed runner: sealed", managed);
});

test("reminder snooze / update", async () => {
  const lookup: FakeRoute = { method: "GET", path: /reminders\?/, data: { reminders: [reminder] } };
  await pin(["reminder", "snooze", "--id", "76d9397d", "--by", "30m"], [
    lookup,
    { method: "POST", path: /snooze/, data: { reminder: { ...reminder, fireAt: "2026-10-03T13:00:00.000Z" } } },
  ]);
  await pin(["reminder", "update", "--id", "76d9397d", "--in", "2h"], [
    lookup,
    { method: "PATCH", path: /reminders\//, data: { reminder: { ...reminder, fireAt: "2026-10-03T14:00:00.000Z" } } },
  ]);
  await pin(["reminder", "update", "--id", "76d9397d", "--cadence", "daily@09:00"], [
    lookup,
    {
      method: "PATCH",
      path: /reminders\//,
      data: {
        reminder: {
          ...reminder,
          fireAt: "2026-10-04T01:00:00.000Z",
          recurrence: { kind: "daily", description: "daily at 09:00 Asia/Singapore" },
        },
      },
    },
  ]);
});

// ── Naive timestamps (local timezone; vitest pins TZ=Asia/Singapore) ────────

test("message search --before naive timestamp", async () => {
  await pin(["message", "search", "--query", "deploy", "--before", "2026-10-01 10:00"], [
    { path: /search/, data: { results: [], hasMore: false } },
  ]);
});
