import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { messageReadCommand } from "./read";
import { getConsumedExactSeqs, getConsumedReadOrder, getConsumedSeq, recordConsumedSeqs } from "./_consumedSeqState";

// Hermetic regardless of test order: anything that resolves through the Raft
// home (legacy import, the published read record) stays in a temp directory.
process.env.RAFT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "raft-cli-test-home-"));

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("message read command uses injected ApiClient and writes canonical history", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-"));
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            messages: [
              {
                seq: 7,
                id: "abcd1234-0000-0000-0000-000000000000",
                createdAt: "2026-05-28T00:00:00.000Z",
                senderType: "human",
                senderName: "xxchan",
                content: "review this",
              },
            ],
            has_more: false,
            has_older: false,
            has_newer: false,
          },
        };
      },
    }) as any,
  });

  await messageReadCommand.handler(ctx, {
    target: "  #proj-runtime  ",
    around: "abcd1234",
    limit: "20",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/history?channel=%23proj-runtime&around=abcd1234&limit=20",
    },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /Around: abcd1234\. Your read position did not move\. To read new messages and mark them read, use --unread\./);
  assert.match(output, /\[1\/1 seq=7 msg=abcd1234-0000-0000-0000-000000000000/);
  assert.doesNotMatch(output, /Read window|End of window|Older|Newer/, "the whole conversation is on screen");
  assert.doesNotMatch(output, /message ack|attest|model-seen/i);
  assert.match(output, /@xxchan: review this/);
  assert.equal(
    getConsumedSeq(agentContext.agentId, "#proj-runtime"),
    undefined,
    "around reads are context lookups, not read-through freshness boundaries",
  );
  assert.equal(
    getConsumedReadOrder(agentContext.agentId, "#proj-runtime"),
    undefined,
    "around reads must not look like the latest local target context for send attestation",
  );
  assert.deepEqual(
    getConsumedExactSeqs(agentContext.agentId, "#proj-runtime"),
    [7],
    "around reads may prove only the exact bodies they rendered, never a high-water boundary",
  );
});

test("message read command records consumed boundary for ordinary history reads", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-latest-"));
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          messages: [
            {
              seq: 7,
              id: "abcd1234-0000-0000-0000-000000000000",
              createdAt: "2026-05-28T00:00:00.000Z",
              senderType: "human",
              senderName: "xxchan",
              content: "review this",
            },
          ],
          has_more: false,
          has_older: false,
          has_newer: false,
        },
      }),
    }) as any,
  });

  await messageReadCommand.handler(ctx, { target: "#proj-runtime", limit: "20" });

  assert.equal(
    getConsumedSeq(agentContext.agentId, "#proj-runtime"),
    7,
    "ordinary history rows returned to the agent are an active client-seen boundary",
  );
});

test("message read keeps channel, thread, and DM evidence on distinct resolver targets", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-targets-"));
  const cases = [
    { requested: "#alpha", resolved: "#alpha", seq: 101 },
    { requested: "#alpha:feedbeef", resolved: "#alpha:feedbeef", seq: 202 },
    { requested: "dm:@peer", resolved: "dm:@peer", seq: 303 },
  ];

  for (const item of cases) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: true,
          status: 200,
          error: null,
          data: {
            target: item.resolved,
            // The real history envelope has no channel identity fields. That
            // absence must never turn the target into `#undefined`.
            messages: [{
              seq: item.seq,
              id: `${String(item.seq).padStart(8, "0")}-0000-0000-0000-000000000000`,
              content: `body ${item.seq}`,
            }],
            has_more: false,
            has_older: false,
            has_newer: false,
            model_seen_up_to_seq: item.seq,
          },
        }),
      }) as any,
    });
    await messageReadCommand.handler(ctx, { target: item.requested });
  }

  for (const item of cases) {
    assert.equal(
      getConsumedSeq(agentContext.agentId, item.resolved),
      item.seq,
      `${item.resolved} must retain only its own consumed boundary`,
    );
  }
  assert.equal(getConsumedSeq(agentContext.agentId, "#undefined"), undefined);
});

test("message read records a gapped latest window as exact seqs instead of skipping older unread", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-gap-"));
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          messages: [
            { seq: 51, id: "00000051-0000-0000-0000-000000000000", content: "newer one" },
            { seq: 52, id: "00000052-0000-0000-0000-000000000000", content: "newer two" },
          ],
          has_more: true,
          has_older: true,
          has_newer: false,
          last_read_seq: 1,
          model_seen_up_to_seq: null,
        },
      }),
    }) as any,
  });

  await messageReadCommand.handler(ctx, { target: "#proj-runtime" });

  assert.equal(getConsumedSeq(agentContext.agentId, "#proj-runtime"), undefined);
  assert.deepEqual(getConsumedExactSeqs(agentContext.agentId, "#proj-runtime"), [51, 52]);
});

test("message read marks a transport failure as retryable without calling it an unknown write", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async () => {
        throw new Error("socket closed before an authoritative response");
      },
    }) as any,
  });

  await assert.rejects(
    async () => { await messageReadCommand.handler(ctx, { target: "#proj-runtime" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CHECK_FAILED");
      assert.equal(err.retryable, true);
      assert.equal(err.fault_domain, "agent_api_transport");
      assert.doesNotMatch(err.suggestedNextAction ?? "", /UNKNOWN|CANNOT_CONFIRM|Do not resend/);
      return true;
    },
  );
});

test("message read prints server-projected forwarded snapshots without re-parsing metadata", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-forwarded-read-"));
  const { io, stdout, stderr } = memoryIo();
  const projectedContent = [
    "Forwarded 2 messages",
    "",
    "Forwarded content snapshot:",
    "",
    "Forwarded message 1:",
    "From: @alice",
    "Source: Private source",
    "",
    "first decision",
    "",
    "---",
    "",
    "Forwarded message 2:",
    "From: @bob",
    "Source: #public-source",
    "",
    "second decision",
  ].join("\n");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          messages: [{
            seq: 8,
            id: "dcba4321-0000-0000-0000-000000000000",
            createdAt: "2026-05-28T00:00:01.000Z",
            senderType: "human",
            senderName: "cindyz",
            content: projectedContent,
          }],
          has_more: false,
          has_older: false,
          has_newer: false,
        },
      }),
    }) as any,
  });

  await messageReadCommand.handler(ctx, { target: "#proj-dx", around: "dcba4321", limit: "1" });

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /@cindyz: Forwarded 2 messages\n  │ \n  │ Forwarded content snapshot:/);
  assert.ok(output.indexOf("first decision") < output.indexOf("second decision"));
  assert.match(output, /From: @alice\n  │ Source: Private source/);
  assert.match(output, /From: @bob\n  │ Source: #public-source/);
});

test("message read command accepts legacy --channel alias during target transition", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { messages: [], has_more: false, has_older: false, has_newer: false },
        };
      },
    }) as any,
  });

  await messageReadCommand.handler(ctx, {
    channel: "#proj-runtime",
    after: "105",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/history?channel=%23proj-runtime&after=105",
    },
  ]);
});

test("message read command rejects conflicting --target and legacy --channel", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await messageReadCommand.handler(ctx, { target: "#a", channel: "#b" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--target and legacy --channel must refer to the same target when both are provided");
      return true;
    },
  );
});

test("message read command does not advance the consumed boundary for empty history", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-empty-"));
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { messages: [], has_more: false, has_older: false, has_newer: false },
      }),
    }) as any,
  });

  await messageReadCommand.handler(ctx, {
    channel: "#proj-runtime",
    after: "105",
  });

  assert.equal(
    getConsumedSeq(agentContext.agentId, "#proj-runtime"),
    undefined,
    "No messages means no new body entered model context and no boundary is fabricated",
  );
  assert.equal(
    getConsumedReadOrder(agentContext.agentId, "#proj-runtime"),
    1,
    "empty reads still record the local target context that the agent explicitly opened",
  );
});

test("message read command preserves an existing consumed boundary when there are no newer messages", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-preserve-"));
  recordConsumedSeqs(agentContext.agentId, { "#proj-runtime": 105 });
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { messages: [], has_more: false, has_older: false, has_newer: false },
      }),
    }) as any,
  });

  await messageReadCommand.handler(ctx, {
    channel: "#proj-runtime",
    after: "105",
  });

  assert.equal(
    getConsumedSeq(agentContext.agentId, "#proj-runtime"),
    105,
    "read-after-latest returning no rows must not erase the prior client-seen boundary",
  );
});

test("message read command sends message id anchors for after and before", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { messages: [], has_more: false, has_older: false, has_newer: false },
        };
      },
    }) as any,
  });

  await messageReadCommand.handler(ctx, {
    channel: "#proj-aiax:4c9553d1",
    after: "d306346b",
    before: "12cf730d-282e-4ae7-9dd8-8c18d0ce8ef4",
    limit: "20",
  });

  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/internal/agent-api/history?channel=%23proj-aiax%3A4c9553d1&before=12cf730d-282e-4ae7-9dd8-8c18d0ce8ef4&after=d306346b&limit=20",
    },
  ]);
});

test("message read command maps invalid limit into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await messageReadCommand.handler(ctx, { channel: "#engineering", limit: "0" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--limit must be a positive integer; got 0");
      return true;
    },
  );
});

test("message read command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        data: null,
        error: "channel not found",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageReadCommand.handler(ctx, { channel: "#missing" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "READ_FAILED");
      assert.equal(err.message, "channel not found");
      return true;
    },
  );
});

test("message read command preserves fail-closed anchor error codes", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        data: null,
        error: "Message not found in #proj-dx: 4f9c2210",
        errorCode: "NOT_FOUND",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageReadCommand.handler(ctx, { channel: "#proj-dx", around: "4f9c2210" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "NOT_FOUND");
      assert.equal(err.message, "Message not found in #proj-dx: 4f9c2210");
      return true;
    },
  );
});

test("message read records evidence under the canonical thread target, not the spelling it was called with", async () => {
  // `#proj-runtime:<threadChannelId8>` and `#proj-runtime:<parentMsgShortId>`
  // name the same thread. Keying the consumed-seq evidence under the raw
  // --target string splits one target's store across spellings: a send under
  // the other spelling then freshness-holds on bodies the agent demonstrably
  // read. The server resolver returns the canonical key, so read/check/send
  // meet on one target without reconstructing identity from a rendered row.
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-read-alias-"));
  const { io } = memoryIo();
  const threadRow = {
    seq: 11,
    id: "abcd1234-0000-0000-0000-000000000000",
    createdAt: "2026-05-28T00:00:00.000Z",
    senderType: "human",
    senderName: "xxchan",
    content: "inside the thread",
    channel_type: "thread",
    channel_name: "thread-beefcafe",
    parent_channel_name: "proj-runtime",
    parent_channel_type: "channel",
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          target: "#proj-runtime:beefcafe",
          messages: [threadRow],
          has_more: false,
          has_older: false,
          has_newer: false,
          model_seen_up_to_seq: 11,
        },
      }),
    }) as any,
  });

  // Called with the thread's own channel-id short form — a different spelling
  // than the canonical `thread-beefcafe` parent-message short id.
  await messageReadCommand.handler(ctx, { target: "#proj-runtime:0c1d2e3f" });

  // The evidence landed under the canonical spelling, and the raw spelling is
  // translated to the same record — one key, both spellings.
  assert.equal(getConsumedSeq(agentContext.agentId, "#proj-runtime:beefcafe"), 11);
  assert.equal(getConsumedSeq(agentContext.agentId, "#proj-runtime:0c1d2e3f"), 11,
    "the raw threadId spelling must resolve to the canonical record");
});

function unreadContext(data: Record<string, unknown>, requests: string[] = []) {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push(path);
        return { ok: true, status: 200, error: null, data };
      },
    }) as any,
  });
  return { ctx, stdout };
}

const unreadMessage = (seq: number, content: string) => ({
  seq,
  id: `abcd${seq}000-0000-0000-0000-000000000000`,
  createdAt: "2026-10-05T00:00:00.000Z",
  senderType: "human",
  senderName: "xxchan",
  content,
});

test("message read --unread asks the Server for unread and prints the same command to continue", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unread-"));
  const requests: string[] = [];
  const { ctx, stdout } = unreadContext({
    target: "#wg-ax:b365e91f",
    messages: [unreadMessage(11, "three"), unreadMessage(12, "four")],
    has_more: true,
    has_older: true,
    has_newer: true,
    last_read_seq: 10,
    unread_after_seq: 10,
    model_seen_up_to_seq: 12,
  }, requests);

  await messageReadCommand.handler(ctx, { target: "#wg-ax:b365e91f", unread: true });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /[?&]unread=true(&|$)/);
  assert.doesNotMatch(requests[0], /[?&](after|before|around)=/);
  const out = stdout.join("");
  assert.match(out, /^Unread window: 2 returned, seq 11-12, oldest to newest, starting after your read position \(seq 10\)\./);
  assert.match(out, /Read position: seq 10 → 12\. To re-read these: raft message read --target "#wg-ax:b365e91f" --after 10/);
  assert.match(out, /More unread remain\. Next: raft message read --target "#wg-ax:b365e91f" --unread\n$/);
  assert.equal(getConsumedSeq("agent-1", "#wg-ax:b365e91f"), 12);
});

test("message read --unread with nothing unread says where the read position is", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unread-empty-"));
  const { ctx, stdout } = unreadContext({
    messages: [], has_more: false, has_older: true, has_newer: false, last_read_seq: 12, unread_after_seq: 12,
  });
  await messageReadCommand.handler(ctx, { target: "#general", unread: true });
  assert.match(stdout.join(""), /No unread messages in #general\. You have read through seq 12\./);
});

test("message read --unread fails closed on a Server that ignored the flag", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unread-old-"));
  const { ctx, stdout } = unreadContext({
    messages: [unreadMessage(40, "latest page, not unread")], has_more: true, has_older: true, has_newer: false, last_read_seq: 10,
  });
  await assert.rejects(
    async () => { await messageReadCommand.handler(ctx, { target: "#general", unread: true }); },
    (error: unknown) => error instanceof CliError && error.code === "UNSUPPORTED_BY_SERVER" && /without --unread/.test(String(error.suggestedNextAction)),
  );
  assert.equal(stdout.join(""), "", "the latest page must not be printed as unread");
});

test("message read --unread refuses an anchor before calling the Server", async () => {
  const requests: string[] = [];
  const { ctx } = unreadContext({}, requests);
  for (const anchor of [{ after: "10" }, { before: "10" }, { around: "abcd1234" }]) {
    await assert.rejects(
      async () => { await messageReadCommand.handler(ctx, { target: "#general", unread: true, ...anchor }); },
      (error: unknown) => error instanceof CliError && error.code === "INVALID_ARG",
    );
  }
  assert.deepEqual(requests, []);
});

test("message read --unread says when the newest messages were too recent to mark read", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unread-settle-"));
  const { ctx, stdout } = unreadContext({
    messages: [unreadMessage(11, "settled"), unreadMessage(12, "just committed")],
    has_more: false, has_older: true, has_newer: false,
    last_read_seq: 10, unread_after_seq: 10, read_through_seq: 11, model_seen_up_to_seq: 12,
  });
  await messageReadCommand.handler(ctx, { target: "#general", unread: true });
  const out = stdout.join("");
  assert.match(out, /Read position: seq 10 → 11\./);
  assert.match(out, /1 newest message was too recent to mark read at once; it should be marked read in a few seconds\. If your next --unread shows it again, it is folded into one line: nothing new\.\n$/);
  assert.doesNotMatch(out, /No more unread/);
});

test("message read --unread folds a message it already showed instead of repeating it as new", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-consumed-unread-fold-"));
  // First read: 12 was too recent to mark read, so the Server will return it again.
  const first = unreadContext({
    target: "#general",
    messages: [unreadMessage(11, "settled"), unreadMessage(12, "just committed")],
    has_more: false, has_older: true, has_newer: false,
    last_read_seq: 10, unread_after_seq: 10, read_through_seq: 11, model_seen_up_to_seq: 12,
  });
  await messageReadCommand.handler(first.ctx, { target: "#general", unread: true });
  assert.match(first.stdout.join(""), /just committed/);

  const second = unreadContext({
    target: "#general",
    messages: [unreadMessage(12, "just committed"), unreadMessage(13, "brand new")],
    has_more: false, has_older: true, has_newer: false,
    last_read_seq: 11, unread_after_seq: 11, read_through_seq: 13, model_seen_up_to_seq: 13,
  });
  await messageReadCommand.handler(second.ctx, { target: "#general", unread: true });
  const out = second.stdout.join("");
  assert.doesNotMatch(out, /just committed/, "the repeat must not be printed as a new message");
  assert.match(out, /^Unread window: 1 returned, seq 13,/);
  assert.match(out, /1 message you were already shown \(seq 12\) is not repeated\.\n/);
  assert.equal(out.match(/--after 11/g)?.length, 1, "the re-read command is printed once");
  assert.match(out, /\[1\/1 seq=13 [^\n]*brand new/);

  // Only the repeat came back: say there is nothing new.
  const third = unreadContext({
    target: "#general",
    messages: [unreadMessage(13, "brand new")],
    has_more: false, has_older: true, has_newer: false,
    last_read_seq: 12, unread_after_seq: 12, read_through_seq: 13, model_seen_up_to_seq: 13,
  });
  await messageReadCommand.handler(third.ctx, { target: "#general", unread: true });
  assert.match(third.stdout.join(""), /No new unread messages in #general\. 1 message you were already shown \(seq 13\) is not repeated\. To see it again: raft message read --target "#general" --after 12/);
});
