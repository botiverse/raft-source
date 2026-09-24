import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { messageReadCommand } from "./read.js";
import { getConsumedReadOrder, getConsumedSeq, recordConsumedSeqs } from "./_consumedSeqState.js";

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
  assert.match(output, /Read window: 1 returned, seq 7, oldest to newest\./);
  assert.match(output, /Around: abcd1234\./);
  assert.match(output, /\[1\/1 seq=7 msg=abcd1234-0000-0000-0000-000000000000/);
  assert.match(output, /End of window: 1\/1 shown\./);
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
  assert.match(output, /@cindyz: Forwarded 2 messages\n\nForwarded content snapshot:/);
  assert.ok(output.indexOf("first decision") < output.indexOf("second decision"));
  assert.match(output, /From: @alice\nSource: Private source/);
  assert.match(output, /From: @bob\nSource: #public-source/);
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
