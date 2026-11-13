import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createAgentApiClient, type AgentApiClient } from "../agentApiClient";
import { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU } from "../index";
import {
  checkInbox,
  claimTasks,
  isInterrupted,
  drainInbox,
  listInbox,
  projectRaftMessage,
  readHistory,
  SeenFrontier,
  sendMessage,
  verifyInboxNotice,
} from "./index";

// ── fixtures (same placeholder samples the CLI's AX surfaces use) ─────────

const T = "2026-08-31T08:00:00.000Z";
const UUID_A = "00000000-1111-2222-3333-444444444444";
const UUID_B = "55555555-6666-7777-8888-999999999999";
const UUID_C = "aaaabbbb-0000-0000-0000-000000000000";
const sampleMessage = { channel_type: "channel", channel_name: "general", message_id: UUID_A, timestamp: T, sender_type: "human", sender_name: "richard", content: "hello everyone", seq: 1200 };
const sampleMessageChannelThread = { ...sampleMessage, channel_type: "thread", channel_name: "thread-00000000", parent_channel_name: "general", parent_channel_type: "channel", message_id: UUID_B, seq: 1201, content: "thread reply" };
const sampleMessageDm = { ...sampleMessage, channel_type: "dm", channel_name: "richard", message_id: UUID_B, seq: 1201, content: "hey, can you help?" };
const sampleMessageDmThread = { ...sampleMessage, channel_type: "thread", channel_name: "thread-55555555", parent_channel_name: "richard", parent_channel_type: "dm", message_id: UUID_C, seq: 1202, content: "DM thread reply" };

type Scripted = (path: string, init: RequestInit) => Response | Promise<Response>;

function client(script: Scripted, calls: Array<{ method: string; path: string; body: unknown }> = []): AgentApiClient {
  return createAgentApiClient({
    fetch: {
      baseUrl: "https://raft.example",
      auth: { authorization: "Bearer sk_agent_test" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        calls.push({ method: init?.method ?? "GET", path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return script(path, init ?? {});
      },
    },
  });
}

const eventsBody = (events: unknown[], extra: Record<string, unknown> = {}) => Response.json({
  events, last_seen_msgId: null, last_seen_seq: null, reply_target: null, has_more: false, ...extra,
});

// ── message projection: the CLI's canonical header line, byte for byte ───

test("projectRaftMessage renders the canonical header line and reply target for all four target shapes", () => {
  const cases: Array<[Record<string, unknown>, string, string]> = [
    [sampleMessage, "#general", `[target=#general msg=00000000 time=2026-08-31 08:00:00Z type=human] @richard: hello everyone`],
    [sampleMessageChannelThread, "#general:00000000", `[target=#general:00000000 msg=55555555 time=2026-08-31 08:00:00Z type=human] @richard: thread reply`],
    [sampleMessageDm, "dm:@richard", `[target=dm:@richard msg=55555555 time=2026-08-31 08:00:00Z type=human] @richard: hey, can you help?`],
    [sampleMessageDmThread, "dm:@richard:55555555", `[target=dm:@richard:55555555 msg=aaaabbbb time=2026-08-31 08:00:00Z type=human] @richard: DM thread reply`],
  ];
  for (const [envelope, target, text] of cases) {
    const message = projectRaftMessage(envelope)!;
    assert.equal(message.target, target);
    assert.equal(message.text, text);
  }
  const withTask = projectRaftMessage({ ...sampleMessage, senderType: "agent", senderName: "Alice", sender_type: undefined, sender_name: undefined, task_status: "in_progress", task_number: 42, task_assignee_id: "a-1", task_assignee_type: "agent", task_assignee_name: "Alice" });
  assert.equal(withTask?.sender.type, "agent");
  assert.deepEqual(withTask?.task, { number: 42, status: "in_progress", assigneeName: "Alice", assigneeId: "a-1", assigneeType: "agent" });
  assert.match(withTask?.text ?? "", / \[task #42 status=in_progress assignee=@Alice\]$/);
});

test("an envelope with no conversation identity is skipped, never rendered as #undefined", async () => {
  assert.equal(projectRaftMessage({ content: "bare" }), null);
  assert.equal(projectRaftMessage({ channel_type: "thread", channel_name: "thread-00000000", content: "orphan thread" }), null);
  // A send response may embed bare envelopes; they must not reach the model.
  const api = client(() => Response.json({ ok: true, state: "sent", messageId: "m-3", recentUnread: [{ content: "bare" }, sampleMessage] }));
  const outcome = await sendMessage(api, { target: "#general", content: "hi" });
  assert.equal(outcome.ok && outcome.state, "sent");
  if (outcome.ok && outcome.state === "sent") {
    assert.deepEqual(outcome.data.recentUnread.map((m) => m.target), ["#general"]);
  }
  assert.ok(!JSON.stringify(outcome).includes("#undefined"));
});

// ── seen frontier rules ──────────────────────────────────────────────────

test("SeenFrontier is per-target, monotonic, and omits the boundary when it knows nothing", () => {
  const frontier = new SeenFrontier();
  assert.deepEqual(frontier.attestation("#a"), { seenExactSeqs: [] });
  frontier.recordExact("#a", [12, 15]);
  frontier.recordUpTo("#a", 10);
  assert.deepEqual(frontier.attestation("#a"), { seenUpToSeq: 10, seenExactSeqs: [12, 15] });
  frontier.recordUpTo("#a", 14);
  frontier.recordUpTo("#a", 9); // browsing older never lowers the mark
  assert.deepEqual(frontier.attestation("#a"), { seenUpToSeq: 14, seenExactSeqs: [15] });
  assert.deepEqual(frontier.attestation("#b"), { seenExactSeqs: [] }, "seq in #a proves nothing about #b");
  assert.deepEqual(frontier.attestation("#a:00000000"), { seenExactSeqs: [] }, "a thread is not its parent");
  frontier.recordAlias("dm:@bob", "dm:@bob~human");
  frontier.recordUpTo("dm:@bob", 3);
  assert.deepEqual(frontier.attestation("dm:@bob~human"), { seenUpToSeq: 3, seenExactSeqs: [] });
  const restored = SeenFrontier.fromSnapshot(JSON.parse(JSON.stringify(frontier.snapshot())));
  assert.deepEqual(restored.attestation("#a"), { seenUpToSeq: 14, seenExactSeqs: [15] });
  assert.deepEqual(restored.attestation("dm:@bob"), { seenUpToSeq: 3, seenExactSeqs: [] });
});

// ── inbox ────────────────────────────────────────────────────────────────

test("checkInbox asks for cursor acks, records exact seqs, and never acknowledges by itself", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const frontier = new SeenFrontier();
  const api = client(() => eventsBody([sampleMessageDm, sampleMessage], { last_seen_seq: 1201, has_more: true, ack_mode: "cursor", inbox_hint: { unread_conversations: 3, command: "raft inbox check" } }), calls);
  const outcome = await checkInbox(api, { limit: 50 }, frontier);
  assert.equal(calls[0]?.path, "/internal/agent-api/events?since=latest&limit=50&ack=cursor");
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.state, "batch");
  assert.deepEqual(outcome.data.messages.map((m) => m.seq), [1200, 1201], "sorted by seq");
  assert.equal(outcome.data.cursor, 1201);
  assert.equal(outcome.data.ackMode, "cursor");
  assert.equal(outcome.data.hasMore, true);
  assert.equal(outcome.data.stillUnreadConversations, 3);
  assert.equal(outcome.next?.kind, "check_inbox_again");
  assert.deepEqual(outcome.next?.args, { since: 1201 });
  assert.equal(outcome.text.split("\n")[0], projectRaftMessage(sampleMessage)!.text);
  assert.match(outcome.text, /More messages are pending\. Run `raft message check` again\./);
  assert.match(outcome.text, /Still unread: 3 conversations\. Run `raft inbox check` to list them\./);
  // A sparse drain records exact seqs only, never a contiguous boundary.
  assert.deepEqual(frontier.attestation("#general"), { seenExactSeqs: [1200] });
  assert.deepEqual(frontier.attestation("dm:@richard"), { seenExactSeqs: [1201] });
});

/**
 * A tiny stateful Server: rows are pending until a cursor-mode pull arrives
 * whose `since` covers them; each pull returns up to `limit` pending rows.
 */
function cursorServer(seqs: number[], limit = 2) {
  let pending = seqs.map((seq) => ({ ...sampleMessage, seq, message_id: `${String(seq).padStart(8, "0")}-0000-0000-0000-000000000000` }));
  const acked: number[] = [];
  const script: Scripted = (path) => {
    const url = new URL(`https://x${path}`);
    const since = url.searchParams.get("since");
    if (since && since !== "latest") {
      const bound = Number(since);
      for (const row of pending) if (row.seq <= bound) acked.push(row.seq);
      pending = pending.filter((row) => row.seq > bound);
    }
    const page = pending.slice(0, limit);
    return eventsBody(page, {
      last_seen_seq: page.length ? Math.max(...page.map((r) => r.seq)) : (since && since !== "latest" ? Number(since) : null),
      has_more: pending.length > page.length,
      ack_mode: "cursor",
    });
  };
  return { script, acked, get pendingSeqs() { return pending.map((r) => r.seq); } };
}

test("drainInbox acknowledges a batch only when the consumer asks for the next one", async () => {
  const server = cursorServer([1200, 1203, 1204]);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = client(server.script, calls);
  const seen: number[][] = [];
  const drain = drainInbox(api, {});
  let step = await drain.next();
  while (!step.done) {
    seen.push(step.value.messages.map((m) => m.seq!));
    // Nothing is acknowledged while this batch is in the consumer's hands.
    assert.deepEqual(server.acked, seen.slice(0, -1).flat(), `acked after handing out batch ${seen.length}`);
    step = await drain.next();
  }
  assert.deepEqual(seen, [[1200, 1203], [1204]]);
  assert.deepEqual(calls.map((c) => c.path), [
    "/internal/agent-api/events?since=latest&ack=cursor",
    "/internal/agent-api/events?since=1203&ack=cursor",
    "/internal/agent-api/events?since=1204&ack=cursor",
  ]);
  assert.deepEqual(server.acked, [1200, 1203, 1204], "the empty closing round acknowledged the last batch");
  assert.equal(step.value.cursor, 1204);
  assert.equal(step.value.hasMore, false);
  assert.equal(step.value.error, null);
  assert.equal(step.value.rounds, 3);
});

test("a consumer that crashes after batch 1 gets batch 1 again on the next pull", async () => {
  const server = cursorServer([1200, 1203, 1204]);
  const api = client(server.script);
  const drain = drainInbox(api, {});
  const first = await drain.next();
  assert.equal(first.done, false);
  if (first.done) return;
  assert.deepEqual(first.value.messages.map((m) => m.seq), [1200, 1203]);
  // The isolate dies here: the consumer never asks for the next batch.
  assert.deepEqual(server.acked, []);
  assert.deepEqual(server.pendingSeqs, [1200, 1203, 1204]);

  const again = await checkInbox(api, {});
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.data.messages.map((m) => m.seq), [1200, 1203], "same batch, still pending");
  // Only passing the confirmed cursor acknowledges it.
  const after = await checkInbox(api, { since: again.data.cursor! });
  assert.deepEqual(server.acked, [1200, 1203]);
  assert.equal(after.ok && after.data.messages.map((m) => m.seq).join(), "1204");
});

test("drainInbox ends with the failure when a later round fails, keeping the batches already handed out", async () => {
  let round = 0;
  const api = client(() => {
    round += 1;
    return round === 1
      ? eventsBody([sampleMessage], { last_seen_seq: 1200, has_more: true, ack_mode: "cursor" })
      : new Response("boom", { status: 503 });
  });
  const batches = [];
  const drain = drainInbox(api, {});
  let step = await drain.next();
  while (!step.done) { batches.push(step.value); step = await drain.next(); }
  assert.equal(batches.length, 1);
  assert.equal(step.value.hasMore, true);
  assert.equal(step.value.error?.error.code, "UNAVAILABLE");
});

test("listInbox is the Activity panel: the open command per row and exactly one next step", async () => {
  const api = client(() => Response.json({
    view: "mentions",
    items: [
      { target: "#proj-sdk:2ad6c504", kind: "thread", unread: 2, mentions: 1, lastReadSeq: 100, activitySeq: 102, latestSenderName: "Tenny", latestAt: T },
      { target: "dm:@tygg", kind: "dm", unread: 1, mentions: 0, lastReadSeq: 0, activitySeq: 90, latestSenderName: "tygg", latestAt: T },
    ],
    hasMore: true,
    nextBeforeSeq: 90,
    totals: { conversations: 7, dms: 1, mentions: 2 },
  }));
  const outcome = await listInbox(api, { view: "mentions" });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.data.conversations[0]?.openCommand, `raft message read --target "#proj-sdk:2ad6c504" --after 100`);
  assert.equal(outcome.next?.kind, "read_target");
  assert.equal(outcome.next?.command, `raft message read --target "#proj-sdk:2ad6c504" --after 100`);
  assert.match(outcome.text, /^Inbox: 7 unread conversations \(1 DMs, 2 with mentions\)\. Newest activity first\./);
  assert.match(outcome.text, /More: raft inbox check --view mentions --before 90/);
  assert.equal(outcome.text.split("\n").filter((line) => line.startsWith("Next:")).length, 1);
});

test("listInbox asks for inbox items; a Server that lists them gets every item with its inbox.read call (RFC 081 D15)", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const REM = "76d9397d-1111-4222-8333-444455556666";
  const api = client(() => Response.json({
    view: "unread",
    items: [
      { target: "dm:@tygg", kind: "dm", unread: 1, mentions: 0, lastReadSeq: 0, activitySeq: 90, latestSenderName: "tygg", latestAt: T },
    ],
    rows: [
      { target: "dm:@tygg", kind: "conversation", conversationKind: "dm", unread: 1, mentions: 0, lastReadSeq: 0, activitySeq: 90, latestSender: { name: "tygg", type: "user" }, preview: "look at this", previewTruncated: false, firstUnreadAt: T, latestAt: T, preLaunch: false },
      { target: "app:stamp/pr-13754", kind: "app", objectRef: "pr-13754", app: { key: "stamp", name: "Stamp" }, related: { target: "#general:#7" }, unread: 2, latestSender: { name: "Stamp", type: "app" }, preview: "checks failed", previewTruncated: true, firstUnreadAt: T, latestAt: T, preLaunch: false },
      { target: `reminder:${REM.slice(0, 8)}`, kind: "reminder", app: { key: "system.reminder", name: "Reminder" }, ack: [{ app: "system.reminder", id: REM, revision: "2" }], unread: 1, latestSender: null, preview: "check the deploy", previewTruncated: false, firstUnreadAt: T, latestAt: T, preLaunch: false },
    ],
    preLaunch: { count: 4, before: "2026-11-10" },
    omitted: { app: 3, reminder: 0 },
    hasMore: false,
    nextBeforeSeq: null,
    totals: { conversations: 1, dms: 1, mentions: 0 },
  }), calls);
  const outcome = await listInbox(api, {}, { hints: "tool" });
  assert.match(calls[0]?.path ?? "", /items=true/);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.data.conversations.length, 1, "the conversation-only list stays");
  assert.deepEqual(outcome.data.items?.map((item) => item.target), ["dm:@tygg", "app:stamp/pr-13754", `reminder:${REM.slice(0, 8)}`]);
  assert.equal(outcome.data.items?.[1]?.objectRef, "pr-13754");
  assert.match(outcome.data.items?.[1]?.readCommand ?? "", /^inbox_read\(/);
  assert.deepEqual(outcome.data.preLaunch, { count: 4, before: "2026-11-10" });
  assert.deepEqual(outcome.data.omitted, { app: 3, reminder: 0 });
  assert.equal(outcome.next?.kind, "read_item");
  assert.deepEqual(outcome.next?.args, { target: "dm:@tygg" });
  assert.match(outcome.text, /^Inbox: 1 unread conversation \(1 DM, 0 with mentions\)\. 4 app items, 1 reminder\. Newest activity first\./);
  assert.match(outcome.text, /Not listed: 3 more app items; read the ones above first\./);
  assert.doesNotMatch(outcome.text, /predate/, "no dismiss operation: a tool caller gets no pre-launch line");
  assert.doesNotMatch(outcome.text, /raft inbox (check|read)/);
  assert.equal(outcome.text.split("\n").filter((line) => line.startsWith("Next:")).length, 1);

  const cli = await listInbox(api, {});
  assert.equal(cli.ok, true);
  if (!cli.ok) return;
  assert.match(cli.text, /read: raft inbox read --target "app:stamp\/pr-13754"/);
  assert.match(cli.text, /dismiss without reading: raft inbox dismiss --before 2026-11-10/);
});

test("listInbox on a Server without inbox items: conversations only, no items field", async () => {
  const api = client(() => Response.json({
    view: "unread", items: [], hasMore: false, nextBeforeSeq: null, totals: { conversations: 0, dms: 0, mentions: 0 },
  }));
  const outcome = await listInbox(api, {});
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.state, "empty");
  assert.equal("items" in outcome.data, false);
  assert.match(outcome.text, /^Inbox: nothing unread\./);
});

// ── read → frontier → send ───────────────────────────────────────────────

test("readHistory advances the frontier to the Server's model-seen boundary, and an around lookup records exact seqs only", async () => {
  const frontier = new SeenFrontier();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = client((path) => Response.json({
    // The Server echoes the canonical spelling of the requested target.
    target: decodeURIComponent(new URL(`https://x${path}`).searchParams.get("channel") ?? "").toLowerCase(),
    messages: [sampleMessage, { ...sampleMessage, seq: 1203, message_id: UUID_B }],
    has_more: false, has_older: path.includes("around") , has_newer: false,
    last_read_seq: 1199, model_seen_up_to_seq: 1203,
  }), calls);
  const page = await readHistory(api, { target: "#General" }, frontier);
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.data.target, "#general");
  assert.deepEqual(frontier.attestation("#General"), { seenUpToSeq: 1203, seenExactSeqs: [] }, "alias resolved to the canonical target");
  assert.equal(page.next, null);

  const around = await readHistory(api, { target: "#other", around: 1203 }, frontier);
  assert.equal(around.ok, true);
  assert.deepEqual(frontier.attestation("#other"), { seenExactSeqs: [1200, 1203] });
  if (around.ok) assert.equal(around.next?.kind, "read_older");
});

test("readHistory with consume: false asks the Server not to mark the page read and records nothing as seen", async () => {
  const frontier = new SeenFrontier();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = client(() => Response.json({
    target: "#general",
    messages: [sampleMessage, { ...sampleMessage, seq: 1203, message_id: UUID_B }],
    has_more: false, has_older: false, has_newer: false,
    last_read_seq: 1199, model_seen_up_to_seq: null,
  }), calls);
  const page = await readHistory(api, { target: "#general", consume: false }, frontier);
  assert.equal(page.ok && page.data.messages.length, 2);
  assert.equal(calls[0]?.path, "/internal/agent-api/history?channel=%23general&consume=false");
  assert.deepEqual(frontier.attestation("#general"), { seenExactSeqs: [] }, "a non-consuming read is not evidence the model saw anything");

  await readHistory(api, { target: "#general" }, frontier);
  assert.equal(calls[1]?.path, "/internal/agent-api/history?channel=%23general", "the default request is unchanged");
});

test("readHistory says when the plan's history window hid messages, as the CLI does", async () => {
  const note = "Older messages are hidden: this server is on the Free plan, which keeps the last 30 days. Upgrading to Pro restores the full history.";
  let answer: Record<string, unknown> = {
    target: "#general",
    messages: [sampleMessage],
    has_more: false, has_older: false, has_newer: false,
    last_read_seq: 900, model_seen_up_to_seq: 1200, unread_after_seq: 900, read_through_seq: 1200,
    historyLimited: true, historyLimitMessage: note,
  };
  const api = client(() => Response.json(answer));

  const unread = await readHistory(api, { target: "#general", unread: true }, new SeenFrontier());
  assert.equal(unread.ok && unread.data.historyLimitMessage, note);
  assert.ok(unread.ok && unread.text.startsWith(`${note}\n`), "the note leads the text");

  answer = { target: "#general", messages: [], has_more: false, has_older: false, has_newer: false, last_read_seq: null, historyLimited: true, historyLimitMessage: note };
  const empty = await readHistory(api, { target: "#general" }, new SeenFrontier());
  assert.equal(empty.ok && empty.text, `${note}\nNo messages in #general.`);

  // Everything after the read position was hidden: the read moved it over them.
  answer = { target: "#general", messages: [], has_more: false, has_older: false, has_newer: false, last_read_seq: 900, unread_after_seq: 900, read_through_seq: 1199, historyLimited: true, historyLimitMessage: note };
  const emptyUnread = await readHistory(api, { target: "#general", unread: true }, new SeenFrontier());
  assert.equal(emptyUnread.ok && emptyUnread.text, `${note}\nNo unread messages in #general. You have read through seq 1199.`);

  answer = { target: "#general", messages: [], has_more: false, has_older: false, has_newer: false, last_read_seq: null, historyLimited: true };
  const noMessage = await readHistory(api, { target: "#general" }, new SeenFrontier());
  assert.equal(noMessage.ok && noMessage.text, "Message history is limited on this plan.\nNo messages in #general.");

  answer = { target: "#general", messages: [], has_more: false, has_older: false, has_newer: false, last_read_seq: null };
  const plain = await readHistory(api, { target: "#general" }, new SeenFrontier());
  assert.equal(plain.ok && plain.text, "No messages in #general.");
  assert.equal(plain.ok && plain.data.historyLimitMessage, undefined);
});

test("readHistory with unread: true reads from the read position, continues with the same call, and fails closed on an old Server", async () => {
  const frontier = new SeenFrontier();
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let answer: Record<string, unknown> = {
    target: "#general",
    messages: [sampleMessage, { ...sampleMessage, seq: 1203, message_id: UUID_B }],
    has_more: true, has_older: true, has_newer: true,
    last_read_seq: 1199, model_seen_up_to_seq: 1203, unread_after_seq: 1199,
  };
  const api = client(() => Response.json(answer), calls);

  const page = await readHistory(api, { target: "#general", unread: true }, frontier);
  assert.equal(calls[0]?.path, "/internal/agent-api/history?channel=%23general&unread=true");
  assert.equal(page.ok, true);
  if (!page.ok) return;
  assert.equal(page.data.unreadAfterSeq, 1199);
  assert.equal(page.next?.command, `raft message read --target "#general" --unread`, "the continuation is the same call, not a seq");
  assert.deepEqual(frontier.attestation("#general"), { seenUpToSeq: 1203, seenExactSeqs: [] });

  answer = { target: "#general", messages: [], has_more: false, has_older: true, has_newer: false, last_read_seq: 1203, unread_after_seq: 1203 };
  const empty = await readHistory(api, { target: "#general", unread: true }, frontier);
  assert.equal(empty.ok && empty.text, "No unread messages in #general. You have read through seq 1203.");
  assert.equal(empty.ok && empty.next, null);

  // A Server without `unread` ignores it and returns the latest page.
  answer = { target: "#general", messages: [sampleMessage], has_more: false, has_older: true, has_newer: false, last_read_seq: 1199 };
  const old = await readHistory(api, { target: "#general", unread: true }, frontier);
  assert.equal(old.ok, false);
  if (!old.ok) assert.match(old.error.nextAction, /inbox\.list/);

  const combined = await readHistory(api, { target: "#general", unread: true, after: 5 }, frontier);
  assert.equal(combined.ok, false);
  if (!combined.ok) assert.equal(combined.error.code, "INVALID_REQUEST");
  assert.equal(calls.length, 3, "a combined request never reaches the Server");
});

test("readHistory with unread: true folds messages the agent was already shown, keeping them in data", async () => {
  const frontier = new SeenFrontier();
  let answer: Record<string, unknown> = {
    target: "#general",
    messages: [sampleMessage, { ...sampleMessage, seq: 1203, message_id: UUID_B }],
    has_more: false, has_older: true, has_newer: false,
    last_read_seq: 1199, unread_after_seq: 1199, read_through_seq: 1200, model_seen_up_to_seq: 1203,
  };
  const api = client(() => Response.json(answer), []);
  const first = await readHistory(api, { target: "#general", unread: true }, frontier);
  assert.equal(first.ok && first.data.alreadyShownSeqs, undefined, "nothing was shown before the first read");

  // 1203 was too recent to mark read, so the Server returns it again.
  answer = {
    target: "#general",
    messages: [{ ...sampleMessage, seq: 1203, message_id: UUID_B }],
    has_more: false, has_older: true, has_newer: false,
    last_read_seq: 1200, unread_after_seq: 1200, read_through_seq: 1203, model_seen_up_to_seq: 1203,
  };
  const again = await readHistory(api, { target: "#general", unread: true }, frontier);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(again.data.alreadyShownSeqs, [1203]);
  assert.equal(again.data.messages.length, 1, "data keeps the message; only text folds it");
  assert.equal(again.text, `No new unread messages in #general. 1 message you were already shown (seq 1203) is not repeated. To see it again: raft message read --target "#general" --after 1200`);
});

test("sendMessage attests the frontier, surfaces a hold as an interrupt, and a resume with the same key attests the held boundary", async () => {
  const frontier = new SeenFrontier();
  frontier.recordUpTo("#general", 1203);
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let sends = 0;
  const api = client(() => {
    sends += 1;
    if (sends === 1) {
      return Response.json({
        ok: true, state: "held", outcome: "held", subtype: "freshness", reason: "newer_messages_available", decision: "syncing_hold",
        producerFactId: "fact-1", available_actions: ["check_messages", "send_draft", "send_anyway"],
        heldMessages: [{ ...sampleMessage, seq: 1210, message_id: UUID_B, content: "newer" }],
        newMessageCount: 2, shownMessageCount: 1, omittedMessageCount: 1, seenUpToSeq: 1210,
        mentionAnnotation: { formalMentionCount: 1 },
      });
    }
    return Response.json({ ok: true, state: "sent", messageId: "m-1", messageSeq: 1211 });
  }, calls);

  const first = await sendMessage(api, { target: "#general", content: "hello" }, frontier);
  assert.equal(calls[0]?.path, "/internal/agent-api/v2/send");
  const generatedKey = (calls[0]?.body as { idempotencyKey: string }).idempotencyKey;
  assert.match(generatedKey, /^[0-9a-f-]{36}$/, "a key is generated when the caller passes none");
  assert.deepEqual(calls[0]?.body, { target: "#general", content: "hello", idempotencyKey: generatedKey, seenUpToSeq: 1203 });
  assert.equal(first.ok, true);
  if (!isInterrupted(first)) return assert.fail("expected an interrupt");
  const interrupt = first.interrupt;
  assert.equal(interrupt.reason, "unread_messages");
  assert.equal(interrupt.newMessageCount, 2);
  assert.equal(interrupt.formalMentionCount, 1);
  assert.equal(interrupt.heldMessages[0]?.text, `[target=#general msg=55555555 time=2026-08-31 08:00:00Z type=human] @richard: newer`);
  // In-process the SDK stores no draft: resume is the original key only (call send again with it), no argv, and no cancel.
  assert.deepEqual(interrupt.resume, { idempotencyKey: generatedKey });
  assert.equal(interrupt.cancel, undefined, "nothing was stored, so cancelling needs no request");
  assert.equal(first.next?.kind, "resend");
  assert.deepEqual(first.next?.args, { target: "#general" }, "no continuation rides on next");
  assert.match(first.next?.why ?? "", /frontier\.recordHeld\(interrupt\)/);
  assert.equal(first.next?.command, undefined, "the held text shows all of it: next does not send the model to read it again");
  assert.match(first.text, /^Held — 2 unread messages in #general\. Your message was not sent\./);
  assert.equal(interrupt.context, first.text);
  assert.equal("resend" in interrupt || "continuation" in interrupt || "data" in first, false, "no closures, no continuation");
  // Explicit attestation: the caller says the model saw the held context.
  assert.deepEqual(frontier.attestation("#general"), { seenUpToSeq: 1203, seenExactSeqs: [] }, "nothing recorded implicitly");
  assert.equal(frontier.recordHeld(interrupt), true);
  assert.deepEqual(frontier.attestation("#general"), { seenUpToSeq: 1210, seenExactSeqs: [] });
  assert.equal(frontier.recordHeld({ target: "#x", seenUpToSeq: 5, withheld: true }), false, "withheld context is never attested");

  // Resuming in-process: the same request under the interrupt's key; the frontier attests the held boundary.
  const second = await sendMessage(api, { target: "#general", content: "hello", idempotencyKey: interrupt.resume.idempotencyKey }, frontier);
  assert.deepEqual(calls[1]?.body, { target: "#general", content: "hello", idempotencyKey: generatedKey, seenUpToSeq: 1210 }, "a resume is the same logical message: same key");
  assert.equal(second.ok && second.state, "sent");
  if (second.ok && second.state === "sent") assert.equal(second.data.messageId, "m-1");
});

test("held messages without conversation fields are projected under the send target, and a short preview is never attested", async () => {
  // The shape the Server actually sends for held previews: a message row with `channelId`, no `channel_type`/`channel_name`.
  const bare = (seq: number, id: string, content: string) => ({ id, channelId: "c-1", seq, senderType: "human", senderName: "richard", content, createdAt: T, timestamp: T });
  const heldFor = (target: string, held: unknown[], newMessageCount: number, omittedMessageCount: number) => {
    const api = client(() => Response.json({
      ok: true, state: "held", outcome: "held", subtype: "freshness", reason: "newer_messages_available", decision: "syncing_hold",
      producerFactId: "f", available_actions: [], heldMessages: held, newMessageCount, shownMessageCount: held.length, omittedMessageCount, seenUpToSeq: 1210,
    }));
    return sendMessage(api, { target, content: "hi", idempotencyKey: "k-1" });
  };

  for (const [target, expected] of [
    ["dm:@cody", "dm:@cody"],
    ["#raft-antiproton", "#raft-antiproton"],
    ["#general:00000000", "#general:00000000"],
    ["dm:@cody:55555555", "dm:@cody:55555555"],
  ] as const) {
    const outcome = await heldFor(target, [bare(1210, UUID_B, "newer")], 1, 0);
    if (!isInterrupted(outcome)) return assert.fail("expected an interrupt");
    assert.equal(outcome.interrupt.heldMessages.length, 1, `${target}: the held message is kept`);
    assert.equal(outcome.interrupt.heldMessages[0]?.target, expected);
    assert.equal(outcome.interrupt.heldMessages[0]?.text, `[target=${expected} msg=55555555 time=2026-08-31 08:00:00Z type=human] @richard: newer`);
    assert.equal(outcome.interrupt.contextComplete, true);
    assert.equal(outcome.interrupt.seenUpToSeq, 1210);
    assert.equal(outcome.interrupt.resume.idempotencyKey, "k-1");
  }

  // 13 new, 3 shown, 10 omitted: accounted for.
  const joint = await heldFor("#raft-antiproton", [bare(1208, UUID_A, "a"), bare(1209, UUID_B, "b"), bare(1210, UUID_C, "c")], 13, 10);
  if (!isInterrupted(joint)) return assert.fail("expected an interrupt");
  assert.equal(joint.interrupt.heldMessages.length, 3);
  assert.equal(joint.interrupt.contextComplete, true);

  // The bodies shown do not account for newMessageCount: no seen, nothing to attest.
  const frontier = new SeenFrontier();
  const short = await heldFor("dm:@cody", [], 1, 0);
  if (!isInterrupted(short)) return assert.fail("expected an interrupt");
  assert.equal(short.interrupt.contextComplete, false);
  assert.deepEqual(short.interrupt.resume, { idempotencyKey: "k-1" }, "resume is still offered (in-process: the key to call again with)");
  assert.deepEqual(short.next?.args, { target: "dm:@cody" });
  assert.match(short.next?.why ?? "", /interrupt\.context does not show all of them in full; read the conversation/);
  assert.equal(short.next?.command, 'raft message read --target "dm:@cody"');
  // The held text is the CLI's (formatAgentHold): the count, then (nothing shown) the command to read them.
  assert.match(short.text, /^Held — 1 unread message in dm:@cody\. Your message was not sent\./);
  assert.match(short.text, /Not shown here\. Read them: raft message read --target "dm:@cody"/);
  assert.match(short.text, /Not all of them are shown here: read the conversation first \(raft message read --target "dm:@cody"\)\. Then: If what you just read already says what you meant to say \(for example, someone already answered\), or makes your message unnecessary, send nothing\. Otherwise, to send it unchanged, send it again with idempotencyKey "k-1"\./);
  assert.equal(frontier.recordHeld(short.interrupt), false, "an incomplete preview is never attested");
  assert.deepEqual(frontier.attestation("dm:@cody"), { seenExactSeqs: [] });
});

test("sendMessage names the agents the message was delivered to, as the CLI does; [] and not counted print nothing", async () => {
  const many = Array.from({ length: 12 }, (_, i) => `agent${String(i + 1).padStart(2, "0")}`);
  const sentWith = (extra: Record<string, unknown>, messageId: string) =>
    sendMessage(client(() => Response.json({ ok: true, state: "sent", messageId, ...extra })), { target: "#general", content: "hi" });

  const two = await sentWith({ deliveredToAgents: ["Archer", "Otter"] }, "m-4");
  assert.ok(two.ok && two.state === "sent");
  assert.deepEqual(two.data.deliveredToAgents, ["Archer", "Otter"]);
  assert.equal(two.text, "Message sent to #general. Message ID: m-4\nDelivered to 2 agents: Archer, Otter.");

  const one = await sentWith({ deliveredToAgents: ["Otter"] }, "m-5");
  assert.ok(one.ok && one.state === "sent");
  assert.equal(one.text, "Message sent to #general. Message ID: m-5\nDelivered to 1 agent: Otter.");

  const crowd = await sentWith({ deliveredToAgents: many }, "m-6");
  assert.ok(crowd.ok && crowd.state === "sent");
  assert.equal(crowd.text, `Message sent to #general. Message ID: m-6\nDelivered to 12 agents: ${many.slice(0, 10).join(", ")} and 2 more.`);

  const none = await sentWith({ deliveredToAgents: [] }, "m-7");
  assert.ok(none.ok && none.state === "sent");
  assert.deepEqual(none.data.deliveredToAgents, []);
  assert.equal(none.text, "Message sent to #general. Message ID: m-7");

  const uncounted = await sentWith({}, "m-8");
  assert.ok(uncounted.ok && uncounted.state === "sent");
  assert.equal(uncounted.data.deliveredToAgents, null);
  assert.equal(uncounted.text, "Message sent to #general. Message ID: m-8");
});

test("sendMessage retries a request that never reached the Server, with the same key, and gives up after three attempts", async () => {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let attempts = 0;
  const api = client(() => {
    attempts += 1;
    if (attempts < 3) throw new Error("connection reset");
    return Response.json({ ok: true, state: "sent", messageId: "m-2" });
  }, calls);
  const outcome = await sendMessage(api, { target: "#general", content: "hi", idempotencyKey: "k-9" });
  assert.equal(outcome.ok && outcome.state, "sent");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => (c.body as { idempotencyKey: string }).idempotencyKey === "k-9"));

  let failures = 0;
  const dead = client(() => { failures += 1; throw new Error("down"); });
  const failed = await sendMessage(dead, { target: "#general", content: "hi" });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, "TRANSPORT_ERROR");
  assert.equal(failures, 3);
});

test("sendMessage maps a reused idempotency key to a typed error with the Server's next action", async () => {
  const api = client(() => Response.json({ error: "key reused", errorCode: "idempotency_key_reused", suggestedNextAction: "Use a new key." }, { status: 409 }));
  const outcome = await sendMessage(api, { target: "#general", content: "again", idempotencyKey: "k-1" });
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error.code, "IDEMPOTENCY_KEY_REUSED");
  assert.equal(outcome.error.serverCode, "idempotency_key_reused");
  assert.equal(outcome.error.nextAction, "Use a new key.");
  assert.equal(outcome.error.retryable, false);
  assert.match(outcome.text, /^Error: /);
});

// ── tasks ────────────────────────────────────────────────────────────────

test("claimTasks reports per-row authorisation and treats 'already claimed by you' as work-authorising", async () => {
  assert.equal(TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU, "already claimed by you", "tasks.ts mirrors this literal");
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const api = client(() => Response.json({ results: [
    { taskNumber: 1, success: true },
    { taskNumber: 2, success: false, reason: "already claimed by you" },
    { taskNumber: 3, success: false, reason: "held by another assignee", conflict: { kind: "claim_conflict", conflictScope: "implementation_execution", blockedActions: ["implement"], unblockedActionExamples: [], currentAssignee: { type: "agent", name: "Otter" }, taskStatus: "in_progress", claimedAt: T, observedAt: T } },
  ] }), calls);
  const outcome = await claimTasks(api, { target: "#proj-sdk", taskNumbers: [1, 2, 3] });
  assert.deepEqual(calls[0]?.body, { channel: "#proj-sdk", task_numbers: [1, 2, 3] });
  assert.equal(outcome.ok, true);
  if (!outcome.ok || outcome.state === "interrupted") return assert.fail("expected claim rows");
  assert.equal(outcome.state, "partial");
  assert.deepEqual(outcome.data.rows.map((r) => [r.state, r.mayWork]), [["claimed", true], ["already_yours", true], ["conflict", false]]);
  assert.equal(outcome.data.rows[2]?.holder?.name, "Otter");
  // Text is the CLI's `raft task claim` output, byte for byte.
  assert.match(outcome.text, /^Claim results \(1 claimed, 2 failed\):/);
  assert.match(outcome.text, /#2: already claimed by you\./);
  assert.match(outcome.text, /#3: Claim failed — @Otter currently holds the implementation lock/);

  const refused = await claimTasks(client(() => Response.json({ results: [{ taskNumber: 9, success: false, reason: "task is closed" }] })), { target: "#proj-sdk", taskNumbers: [9] });
  assert.equal(refused.ok && refused.state, "refused");
  if (refused.ok && refused.state !== "interrupted") assert.equal(refused.next?.kind, "do_not_start");
});

test("claimTasks surfaces a freshness hold as an interrupt: resume is the identical claim, no cancel", async () => {
  let claims = 0;
  const api = client(() => {
    claims += 1;
    return claims === 1
      ? Response.json({ state: "held", freshnessContextMode: "withheld", withheldMessageCount: 4 })
      : Response.json({ results: [{ taskNumber: 1, success: true }] });
  });
  const outcome = await claimTasks(api, { target: "#proj-sdk", taskNumbers: [1], messageIds: ["aaaabbbb"] });
  if (!isInterrupted(outcome)) return assert.fail("expected an interrupt");
  assert.equal(outcome.interrupt.newMessageCount, 4);
  assert.equal(outcome.interrupt.withheld, true);
  assert.equal(outcome.interrupt.contextComplete, false);
  assert.deepEqual(outcome.interrupt.resume, { argv: ["task", "claim", "--target", "#proj-sdk", "--number", "1", "--message-id", "aaaabbbb"] });
  assert.equal("cancel" in outcome.interrupt, false, "a held claim saved nothing: no cancel");
  assert.equal(outcome.next?.kind, "retry_claim");
  assert.deepEqual(outcome.next?.args, { target: "#proj-sdk" });
  // Reviewer isolation: the CLI's count-only line, then (SDK only: its text is all a model sees) what happened and the way forward.
  assert.equal(outcome.text, "Reviewer-isolation freshness hold: 4 newer messages withheld.\n\nYour task claim was not applied. After reviewing, rerun the claim if it is still correct.");
  assert.equal(outcome.interrupt.context, outcome.text);
  const again = await claimTasks(api, { target: "#proj-sdk", taskNumbers: [1] });
  assert.equal(again.ok && again.state, "claimed");
});

test("a hold's next names the read exactly when its held text does", async () => {
  const held = (heldMessages: unknown[]) => client(() => Response.json({
    ok: true, state: "held", outcome: "held", subtype: "freshness", reason: "newer_messages_available", decision: "syncing_hold",
    producerFactId: "f", available_actions: [], heldMessages, newMessageCount: heldMessages.length, shownMessageCount: heldMessages.length, omittedMessageCount: 0, seenUpToSeq: 1210,
  }));
  const row = (content: string, extra: Record<string, unknown> = {}) => ({ id: UUID_B, channelId: "c-1", seq: 1210, senderType: "human", senderName: "richard", content, createdAt: T, timestamp: T, ...extra });
  const read = 'raft message read --target "#general"';
  // A claim's context is the task's own conversation, where its lines land.
  const claimRead = 'raft task read "#general:#1"';
  const cases: Array<[string, unknown, string | undefined, RegExp]> = [
    ["whole", row("newer"), undefined, /\n  └ ─+\n/],
    ["cut", row("x".repeat(200)), read, /Previews are truncated\. Full text: raft message read/],
    ["attachment", row("see file", { attachments: [{ id: "a-1", filename: "plan.md" }] }), read, /Not all of it is shown here\. Read it: raft message read/],
  ];
  for (const [name, message, command, text] of cases) {
    const sent = await sendMessage(held([message]), { target: "#general", content: "hi", idempotencyKey: "k-1" });
    if (!isInterrupted(sent)) return assert.fail(`${name}: expected a send interrupt, got ${JSON.stringify(sent).slice(0, 300)}`);
    assert.match(sent.text, text, `${name}: held text`);
    assert.equal(sent.next?.command, command, `${name}: send next agrees with the text`);
    assert.equal(sent.next?.kind, "resend");
    const claim = await claimTasks(held([message]), { target: "#general", taskNumbers: [1] });
    if (!isInterrupted(claim)) return assert.fail(`${name}: expected a claim interrupt, got ${JSON.stringify(claim).slice(0, 300)}`);
    assert.equal(claim.next?.command, command && claimRead, `${name}: claim next agrees with the text`);
    assert.equal(claim.next?.kind, "retry_claim");
    assert.match(claim.next?.why ?? "", command ? /read them/ : /interrupt\.context shows them/);
  }
});

// ── wake ─────────────────────────────────────────────────────────────────

test("verifyInboxNotice accepts a correctly signed notice and rejects the rest, with no time window", async () => {
  const secret = "0123456789abcdef".repeat(4);
  const notice = {
    schema: "raft-agent-inbox-notice.v1", noticeId: "ntc_1", recipientAgentId: "agent-1", occurredAt: "2020-01-01T00:00:00.000Z",
    text: "Inbox update: 1 message pending your read across all conversations; 1 changed target",
    targets: [{ target: "#proj-sdk:2ad6c504", channelId: "c-1", channelType: "thread", pendingCount: 1, firstPendingMsgId: "m-1", latestMsgId: "m-1", latestSeq: "42", latestSenderName: "Tenny", latestSenderType: "agent", flags: ["mention", "thread"] }],
  };
  const body = new TextEncoder().encode(JSON.stringify(notice));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  const ok = await verifyInboxNotice({ headers: new Headers({ "x-raft-signature-256": signature, "x-raft-delivery-id": "ntc_1" }), body, secret });
  assert.equal(ok.ok, true);
  if (!ok.ok) return;
  assert.equal(ok.notice.noticeId, "ntc_1");
  assert.equal(ok.notice.deliveryId, "ntc_1");
  assert.equal(ok.notice.targets[0]?.target, "#proj-sdk:2ad6c504");
  assert.equal(ok.notice.targets[0]?.mentionsYou, true);
  assert.equal(ok.notice.targets[0]?.latestSeq, "42", "the latest seq, for /events wait_for");

  const record = await verifyInboxNotice({ headers: { "X-Raft-Signature-256": signature }, body, secret });
  assert.equal(record.ok, true, "plain header records work too");

  const bad = await verifyInboxNotice({ headers: new Headers({ "x-raft-signature-256": signature }), body, secret: "other-secret-other-secret-other-secret-1234" });
  assert.deepEqual(bad.ok ? null : bad.reason, "bad_signature");
  const missing = await verifyInboxNotice({ headers: new Headers(), body, secret });
  assert.deepEqual(missing.ok ? null : missing.reason, "missing_signature");
  const tampered = new TextEncoder().encode(JSON.stringify({ ...notice, text: "changed" }));
  const forged = await verifyInboxNotice({ headers: new Headers({ "x-raft-signature-256": signature }), body: tampered, secret });
  assert.deepEqual(forged.ok ? null : forged.reason, "bad_signature");
  const wrongSchema = new TextEncoder().encode(JSON.stringify({ ...notice, schema: "raft-agent-inbox-notice.v2" }));
  const unsupported = await verifyInboxNotice({ headers: new Headers({ "x-raft-signature-256": `sha256=${createHmac("sha256", secret).update(wrongSchema).digest("hex")}` }), body: wrongSchema, secret });
  assert.deepEqual(unsupported.ok ? null : unsupported.reason, "unsupported_schema");
});

test("readHistory retains bare camelCase messages using the returned conversation target", async () => {
  for (const target of ["#onboarding-eval", "#onboarding-eval:00000000", "dm:@richard", "dm:@richard:55555555"]) {
    const api = client(() => Response.json({ target, messages: [{
      id: UUID_A, seq: 270, content: "owner asks for feedback help", senderType: "human",
      senderName: "richard", createdAt: T, channelId: UUID_B,
    }], has_more: false, has_older: false, has_newer: false, last_read_seq: 269, model_seen_up_to_seq: 270 }));
    const outcome = await readHistory(api, { target: "#requested-alias", limit: 10 }, new SeenFrontier());
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    if (!outcome.ok) throw new Error("history read failed");
    assert.equal(outcome.data.messages.length, 1, "a successful nonempty server page must remain nonempty");
    const message = outcome.data.messages[0]!;
    assert.equal(message.target, target);
    assert.equal(message.id, UUID_A);
    assert.equal(message.seq, 270);
    assert.equal(message.sender.name, "richard");
    assert.equal(message.content, "owner asks for feedback help");
  }
});
