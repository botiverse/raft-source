// Task v2: `raft task view|reply|read|follow|unfollow <ref>` — the task ref
// (`#channel:#7`) or `--target "#channel" --number 7`, and `raft message
// send/read` refusing task refs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import { messageReadCommand } from "../message/read";
import { messageSendCommand } from "../message/send";
import { resolveTaskAddress } from "./_taskAddress";
import { taskFollowCommand, taskUnfollowCommand } from "./follow";
import { taskReadCommand } from "./read";
import { taskReplyCommand } from "./reply";
import { taskViewCommand } from "./view";

// The read ledger and drafts live under the Raft home: keep them in a temp dir.
process.env.RAFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-task-conversation-"));

const agentContext: AgentContext = {
  agentId: "agent-task-conv",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

type Recorded = { method: string; path: string; body?: unknown };

function harness(respond: (request: Recorded) => ApiResponse<unknown>, stdinText?: string) {
  const stdout: string[] = [];
  const requests: Recorded[] = [];
  const ctx = createCommandContext({
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
      ...(stdinText !== undefined ? { stdin: Readable.from([stdinText]) } : {}),
    },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        const request = { method, path: requestPath, body };
        requests.push(request);
        return respond(request);
      },
    }) as any,
  });
  return { ctx, stdout, requests, out: () => stdout.join("") };
}

const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, error: null, data });

test("resolveTaskAddress: a ref, or --target + --number, never both disagreeing", () => {
  assert.deepEqual(resolveTaskAddress("#proj:#7", {}), { channel: "#proj", taskNumber: 7, ref: "#proj:#7" });
  assert.deepEqual(resolveTaskAddress("dm:@cody:#3", {}), { channel: "dm:@cody", taskNumber: 3, ref: "dm:@cody:#3" });
  assert.deepEqual(resolveTaskAddress(undefined, { target: "#proj", number: "7" }), { channel: "#proj", taskNumber: 7, ref: "#proj:#7" });
  assert.deepEqual(resolveTaskAddress(undefined, { channel: "#proj", number: "#7" }), { channel: "#proj", taskNumber: 7, ref: "#proj:#7" });
  assert.deepEqual(resolveTaskAddress("#proj:#7", { target: "#proj", number: "7" }).ref, "#proj:#7");
  assert.throws(() => resolveTaskAddress("#proj:#7", { number: "8" }), (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG");
  assert.throws(() => resolveTaskAddress("#proj", {}), (err: unknown) => err instanceof CliError && err.code === "INVALID_TARGET");
  assert.throws(() => resolveTaskAddress("task #7", {}), (err: unknown) => err instanceof CliError && err.code === "INVALID_TARGET");
  assert.throws(() => resolveTaskAddress(undefined, { target: "#proj" }), (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG");
});

test("task view: GET /tasks/view and the task named by its ref with next commands", async () => {
  const h = harness(() => ok({
    taskRef: "#proj:#7",
    task: { taskNumber: 7, status: "in_progress", title: "Homepage hero", claimedById: "a-1", claimedByName: "cody", createdByName: "rc", createdByHandle: "rc", createdAt: "2026-10-20T01:00:00.000Z", description: null, conversationAnchored: true },
    following: true,
    followReason: "assigned",
    conversation: { exists: true, replyCount: 3 },
    sourceMessage: { id: "src67890-0000-0000-0000-000000000000", target: "#proj", senderName: "rc", content: "we need a hero\nfor mobile", createdAt: "2026-10-20T00:00:00.000Z" },
    earlierDiscussion: null,
    recentMessages: [
      { seq: 11, id: "msg11111-0000-0000-0000-000000000000", createdAt: "2026-10-20T01:01:00.000Z", senderType: "agent", senderName: "cody", content: "draft is up" },
    ],
    hasOlder: true,
  }));
  await taskViewCommand.handler(h.ctx, "#proj:#7", {});
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.method, "GET");
  assert.match(h.requests[0]!.path, /\/tasks\/view\?channel=%23proj&task_number=7$/);
  const out = h.out();
  assert.match(out, /^## Task #proj:#7 \[in_progress\]$/m);
  assert.match(out, /^Assignee: @cody$/m);
  assert.match(out, /^Source: msg=src67890 in #proj — @rc: we need a hero for mobile$/m);
  assert.match(out, /^Following: yes \(assigned\) — its replies wake you$/m);
  assert.match(out, /^Discussion \(latest 1 of 3, oldest first\):\n- \[msg=msg11111 seq=11 time=2026-10-20 01:01:00Z type=agent\] @cody: draft is up$/m);
  assert.match(out, /reply \(body on stdin\): raft task reply "#proj:#7"/);
  assert.match(out, /read the discussion: raft task read "#proj:#7" --before 11/);
  assert.match(out, /stop following: raft task unfollow "#proj:#7"/);
  assert.doesNotMatch(out, /raft message (send|read)/);
});

test("task view: Created by names the creator's handle, never a display name as @name", async () => {
  const view = (task: Record<string, unknown>) => ok({
    taskRef: "#proj:#7",
    task: { taskNumber: 7, status: "todo", title: "埋点", claimedById: "a-1", claimedByName: "cody", createdAt: "2026-10-20T01:00:00.000Z", description: null, conversationAnchored: true, ...task },
    following: false,
    conversation: { exists: false, replyCount: 0 },
    sourceMessage: null,
    earlierDiscussion: null,
    recentMessages: [],
    hasOlder: false,
  });
  const current = harness(() => view({ createdByName: "林晓", createdByHandle: "Developer" }));
  await taskViewCommand.handler(current.ctx, "#proj:#7", {});
  assert.match(current.out(), /^Created by: @Developer at 2026-10-20 01:00:00Z$/m);
  // A server from before `createdByHandle`: the display name as plain text.
  const older = harness(() => view({ createdByName: "林晓" }));
  await taskViewCommand.handler(older.ctx, "#proj:#7", {});
  assert.match(older.out(), /^Created by: 林晓 at 2026-10-20 01:00:00Z$/m);
  assert.doesNotMatch(older.out(), /@林晓/);
});

test("task reply: POST /tasks/reply with the stdin body, mentions and attachments; prints the ref", async () => {
  const h = harness(() => ok({ ok: true, state: "sent", messageId: "11111111-1111-4111-8111-111111111111", messageSeq: 5 }), "on it\n");
  await taskReplyCommand.handler(h.ctx, undefined, { target: "#proj", number: "7", attachmentId: ["33333333-3333-4333-8333-333333333333"] });
  assert.equal(h.requests.length, 1);
  const request = h.requests[0]!;
  assert.equal(request.method, "POST");
  assert.match(request.path, /\/tasks\/reply$/);
  const body = request.body as Record<string, unknown>;
  assert.equal(body.channel, "#proj");
  assert.equal(body.task_number, 7);
  assert.equal(body.content, "on it\n");
  assert.deepEqual(body.attachmentIds, ["33333333-3333-4333-8333-333333333333"]);
  assert.equal(typeof body.idempotencyKey, "string");
  assert.equal(h.out(), "Reply sent to #proj:#7. Message ID: 11111111-1111-4111-8111-111111111111\n");
});

test("task reply: names the agents the reply was delivered to", async () => {
  const h = harness(() => ok({ ok: true, state: "sent", messageId: "11111111-1111-4111-8111-111111111111", messageSeq: 5, deliveredToAgents: ["Otter"] }), "on it\n");
  await taskReplyCommand.handler(h.ctx, "#proj:#7", {});
  assert.equal(h.out(), "Reply sent to #proj:#7. Message ID: 11111111-1111-4111-8111-111111111111\nDelivered to 1 agent: Otter.\n");
});

test("task reply: a lost 5xx is reconciled under the same idempotency key, never sent twice", async () => {
  let call = 0;
  const h = harness((request) => {
    call += 1;
    const body = request.body as Record<string, unknown>;
    if (call === 1) return { ok: false, status: 502, error: "bad gateway", data: null };
    assert.equal(body.reconcileOnly, true);
    return ok({ ok: true, state: "committed", messageId: "22222222-2222-4222-8222-222222222222", messageSeq: 6, reconciliation: true, receiptComplete: false });
  }, "hello");
  await taskReplyCommand.handler(h.ctx, "#proj:#7", {});
  assert.equal(h.requests.length, 2);
  assert.equal((h.requests[0]!.body as Record<string, unknown>).idempotencyKey, (h.requests[1]!.body as Record<string, unknown>).idempotencyKey);
  assert.match(h.out(), /^Reply sent to #proj:#7\. Message ID: 22222222-2222-4222-8222-222222222222\n/);
});

test("task reply: no stdin body names the task reply heredoc, without a request", async () => {
  const h = harness(() => ok({}), "   ");
  await assert.rejects(
    async () => taskReplyCommand.handler(h.ctx, "#proj:#7", {}),
    (err: unknown) => err instanceof CliError && (err.code as string) === "MISSING_CONTENT" && /raft task reply "#proj:#7" <<'RAFTMSG'/.test(err.message),
  );
  assert.equal(h.requests.length, 0);
});

test("task reply: the server's refusal (flag off) surfaces its code", async () => {
  const h = harness(() => ({
    ok: false,
    status: 409,
    error: "Task conversations are not enabled on this server. Task #7 is discussed in its message's thread.",
    errorCode: "task_conversations_not_enabled",
    data: null,
  }), "hello");
  await assert.rejects(
    async () => taskReplyCommand.handler(h.ctx, "#proj:#7", {}),
    (err: unknown) => err instanceof CliError && (err.code as string) === "task_conversations_not_enabled",
  );
});

test("task read: GET /tasks/read with the window flags; the window is named by the ref", async () => {
  const h = harness(() => ok({
    target: "#proj:#7",
    messages: [{ seq: 12, id: "msg12121-0000-0000-0000-000000000000", createdAt: "2026-10-20T01:02:00.000Z", senderType: "human", senderName: "rc", content: "looks good" }],
    has_more: false,
    has_older: false,
    has_newer: false,
  }));
  await taskReadCommand.handler(h.ctx, "#proj:#7", { after: "0", limit: "50" });
  assert.match(h.requests[0]!.path, /\/tasks\/read\?channel=%23proj&task_number=7&after=0&limit=50$/);
  const out = h.out();
  assert.doesNotMatch(out, /Coverage:/);
  assert.match(out, /^\[1\/1 seq=12 [^\n]*@rc: looks good\n$/);
  assert.doesNotMatch(out, /replyTarget=/);
});

test("task follow / unfollow: POST and receipts naming the ref", async () => {
  const follow = harness(() => ok({ ok: true, taskRef: "#proj:#7", following: true, changed: true }));
  await taskFollowCommand.handler(follow.ctx, "#proj:#7", {});
  assert.match(follow.requests[0]!.path, /\/tasks\/follow$/);
  assert.deepEqual(follow.requests[0]!.body, { channel: "#proj", task_number: 7 });
  assert.match(follow.out(), /^Following #proj:#7: its replies now wake you\.\nTo stop: raft task unfollow "#proj:#7"\n$/);

  const unfollow = harness(() => ok({ ok: true, taskRef: "#proj:#7", following: false, changed: true }));
  await taskUnfollowCommand.handler(unfollow.ctx, undefined, { target: "#proj", number: "7" });
  assert.match(unfollow.requests[0]!.path, /\/tasks\/unfollow$/);
  // No --reason sends no reason: the server posts just "@agent stopped following this task".
  assert.deepEqual(unfollow.requests[0]!.body, { channel: "#proj", task_number: 7 });
  assert.match(unfollow.out(), /^Unfollowed #proj:#7: its ordinary replies no longer wake you\./);
  // Assignment and claim follow again, like an @mention (personal attention).
  assert.match(unfollow.out(), /\nA later @mention, being assigned the task or claiming it follows it again; replying in it does too\.\n/);

  const withReason = harness(() => ok({ ok: true, taskRef: "#proj:#7", following: false, changed: true }));
  await taskUnfollowCommand.handler(withReason.ctx, "#proj:#7", { reason: "  handed off to @rc  " });
  assert.deepEqual(withReason.requests[0]!.body, { channel: "#proj", task_number: 7, reason: "handed off to @rc" });
});

test("message send / message read refuse a task ref locally, naming the task command", async () => {
  // Servers accept the ref (older CLIs copy it from deliveries); this CLI
  // keeps the task model: replies go through `raft task reply`.
  const send = harness(() => ok({}), "hello");
  await assert.rejects(
    async () => messageSendCommand.handler(send.ctx, [], { target: "#proj:#7" }),
    (err: unknown) => err instanceof CliError
      && (err.code as string) === "task_target_use_task_command"
      && err.message.includes(`raft task reply "#proj:#7" <<'RAFTMSG'`),
  );
  assert.equal(send.requests.length, 0);

  const read = harness(() => ok({}));
  await assert.rejects(
    async () => messageReadCommand.handler(read.ctx, { target: "dm:@cody:#3" }),
    (err: unknown) => err instanceof CliError
      && (err.code as string) === "task_target_use_task_command"
      && err.message.includes(`raft task read "dm:@cody:#3"`),
  );
  assert.equal(read.requests.length, 0);
});

test("inbox check: a task conversation row is labelled by its ref and title and is read with raft task read", async () => {
  const { formatInboxCheck } = await import("../inbox/_format");
  const out = String(formatInboxCheck({
    view: "unread",
    nowMs: Date.parse("2026-09-25T12:00:00.000Z"),
    list: {
      view: "unread",
      items: [{ target: "#proj:#7", kind: "thread", conversationKind: "task", taskNumber: 7, title: "Homepage  hero\ncopy", unread: 2, mentions: 0, lastReadSeq: 40, activitySeq: 50, latestSenderName: "cody", latestAt: "2026-09-25T11:55:00.000Z" }],
      hasMore: false,
      nextBeforeSeq: null,
      totals: { conversations: 1, dms: 0, mentions: 0 },
    },
  }));
  assert.match(out, /^task #proj:#7 "Homepage hero copy" · 2 unread · latest @cody 5m ago\n  read: raft task read "#proj:#7" --unread$/m);
  assert.match(out, /Next: read the first conversation above: raft task read "#proj:#7" --unread/);
  assert.doesNotMatch(out, /raft message read/);
});
