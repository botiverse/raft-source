import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { taskConvertCommand } from "./convert";

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

const convertedTask = {
  taskNumber: 12,
  messageId: "abcdef12-3456-7890-abcd-ef1234567890",
  title: "look at the retry storm",
  status: "todo",
  claimedByType: null,
  claimedById: null,
  claimedByName: null,
  claimedAt: null,
  requiresResourceReceipt: false,
};

function contextReturning(
  response: ApiResponse<unknown>,
  requests: Array<{ method: string; path: string; body: unknown }>,
  io: CliIo,
) {
  return createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return response;
      },
    }) as any,
  });
}

test("task convert command uses injected ApiClient and writes canonical text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning(
    { ok: true, status: 200, error: null, data: { task: convertedTask } },
    requests,
    io,
  );

  await taskConvertCommand.handler(ctx, { target: "  #proj-runtime  ", messageId: " abcdef12 " });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/tasks/convert",
      body: { channel: "#proj-runtime", message_id: "abcdef12" },
    },
  ]);
  assert.deepEqual(stderr, []);

  const out = stdout.join("");
  // The whole point of this verb is that it does NOT claim, so the receipt has
  // to say so out loud — a blank assignee would read as "someone else has it".
  assert.match(out, /assignee=unassigned/);
  assert.match(out, /task #12 \[todo\]/);
  assert.match(out, /raft message send --target "#proj-runtime:abcdef12"/);
});

test("task convert command requires a message id", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning({ ok: true, status: 200, error: null, data: { task: convertedTask } }, requests, io);

  await assert.rejects(
    async () => { await taskConvertCommand.handler(ctx, { target: "#proj-runtime" }); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
  );
  assert.deepEqual(requests, [], "a rejected argument must not reach the server");
});

test("task convert maps an already-converted conflict into a typed CliError", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning(
    { ok: false, status: 409, error: "already converted", data: null },
    requests,
    io,
  );

  await assert.rejects(
    async () => { await taskConvertCommand.handler(ctx, { target: "#proj-runtime", messageId: "abcdef12" }); },
    (err: unknown) => err instanceof CliError && err.code === "CONVERT_FAILED" && /already converted/.test(err.message),
  );
});

test("task convert maps a 5xx to SERVER_5XX rather than CONVERT_FAILED", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = contextReturning({ ok: false, status: 503, error: "unavailable", data: null }, requests, io);

  await assert.rejects(
    async () => { await taskConvertCommand.handler(ctx, { target: "#proj-runtime", messageId: "abcdef12" }); },
    (err: unknown) => err instanceof CliError && err.code === "SERVER_5XX",
  );
});

test("task v2 server: convert surfaces task_v2_use_create with the create command verbatim", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const hint = [
    "`task convert` is not available on this server: tasks here have their own conversations, and a message is never turned into a task. Nothing was converted.",
    "Create a task from the message instead (the task stays linked to it; edit the title as needed):",
    "  raft task create --target \"#proj-runtime\" --message-id abcdef12 --title \"look at the retry storm\"",
    "To take it yourself in the same step, add --assignee @cody.",
  ].join("\n");
  const ctx = contextReturning(
    { ok: false, status: 409, error: hint, errorCode: "task_v2_use_create", data: null },
    requests,
    io,
  );
  await assert.rejects(
    async () => { await taskConvertCommand.handler(ctx, { target: "#proj-runtime", messageId: "abcdef12" }); },
    (err: unknown) => err instanceof CliError && err.code === "task_v2_use_create" && err.message === hint,
  );
  assert.deepEqual(stdout, []);
});
