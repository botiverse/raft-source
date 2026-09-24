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
import { messageCheckCommand } from "./check.js";
import { getConsumedSeq } from "./_consumedSeqState.js";

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
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function agentEvents(messages: Array<{ seq: number; content: string; [key: string]: unknown }>, hasMore = false) {
  const last = messages[messages.length - 1];
  return {
    events: messages,
    last_seen_msgId: last ? `msg-${last.seq}` : null,
    last_seen_seq: last?.seq ?? null,
    reply_target: null,
    pending_notice_ids: [],
    wake_reason: null,
    has_more: hasMore,
  };
}

test("message check command drains inbox through injected ApiClient and writes canonical text", async () => {
  process.env.SLOCK_CLI_CONSUMED_SEQ_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "slock-cli-check-no-consume-"));
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (path === "/internal/agent-api/events?since=latest") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: agentEvents([{
              seq: 7,
              channel_type: "public",
              channel_name: "proj-runtime",
              message_id: "abcd1234-0000-0000-0000-000000000000",
              timestamp: "2026-05-28T00:00:00.000Z",
              sender_type: "human",
              sender_name: "xxchan",
              content: "review this",
            }]),
          };
        }
        return {
          ok: true,
          status: 200,
          error: null,
          data: { ok: true },
        };
      },
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/events?since=latest", body: undefined },
  ]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /target=#proj-runtime/);
  assert.match(output, /msg=abcd1234/);
  assert.match(output, /@xxchan: review this/);
  assert.equal(
    getConsumedSeq(agentContext.agentId, "#proj-runtime"),
    undefined,
    "message check is a sparse attention/event drain and must not seed a high-water model-seen boundary",
  );
});

test("message check command renders an actionable hint when more messages may remain", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_test",
    }),
    createApiClient: () => {
      let calls = 0;
      return {
        request: async (): Promise<ApiResponse<unknown>> => {
          calls += 1;
          if (calls === 1) {
            return {
              ok: true,
              status: 200,
              error: null,
              data: agentEvents([{ seq: 8, content: "visible before retry failure" }], true),
            };
          }
          return {
            ok: false,
            status: 503,
            error: "events temporarily unavailable",
            data: null,
          };
        },
      } as any;
    },
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /visible before retry failure/);
  assert.match(output, /More messages are pending\. Run `raft message check` again\./);
});

test("message check command renders a final-drain hint when one explicit batch is complete", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_test",
    }),
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: agentEvents([{ seq: 8, content: "complete batch" }], false),
      }),
    }) as any,
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /complete batch/);
  assert.match(output, /No more new inbox messages\./);
  assert.doesNotMatch(output, /More messages are pending/);
});

test("message check command renders a final-drain hint when has_more batches were fully drained", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({
      ...agentContext,
      clientMode: "self-hosted-runner",
      secretSource: "profile-credential-file",
      token: "sk_agent_test",
    }),
    createApiClient: () => {
      let calls = 0;
      return {
        request: async (): Promise<ApiResponse<unknown>> => {
          calls += 1;
          return {
            ok: true,
            status: 200,
            error: null,
            data: agentEvents([{ seq: calls, content: `batch ${calls}` }], calls === 1),
          };
        },
      } as any;
    },
  });

  await messageCheckCommand.handler(ctx);

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /batch 1/);
  assert.match(output, /batch 2/);
  assert.match(output, /No more new inbox messages\./);
  assert.doesNotMatch(output, /More messages are pending/);
  assert.doesNotMatch(output, /Additional pending message batches/);
});

test("message check command maps events failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 409,
        data: null,
        error: "events conflict",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageCheckCommand.handler(ctx); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CHECK_FAILED");
      assert.equal(err.message, "events conflict");
      return true;
    },
  );
});

test("message check command fails loud when the inbox events surface returns 5xx", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        data: null,
        error: "events temporarily unavailable",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await messageCheckCommand.handler(ctx); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "SERVER_5XX");
      assert.equal(err.message, "events temporarily unavailable");
      return true;
    },
  );
  assert.deepEqual(stdout, [], "an unavailable inbox surface must never print an empty-inbox claim");
});
