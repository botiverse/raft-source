import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskListCommand } from "./list.js";

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

test("task list command uses injected ApiClient and writes canonical text", async () => {
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
            tasks: [
              {
                taskNumber: 7,
                status: "in_progress",
                title: "migrate CLI command",
                claimedById: "agent-haohao",
                claimedByName: "HaoHao",
                createdByName: "xxchan",
                messageId: "abcd1234efgh5678",
                revision: 4,
                description: "field assertion\nrendering assertion",
              },
            ],
          },
        };
      },
    }) as any,
  });

  await taskListCommand.handler(ctx, { target: "  #proj-runtime  ", status: "in_progress" });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/tasks?channel=%23proj-runtime&status=in_progress" },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(
    stdout.join(""),
    [
      "## Task Board for #proj-runtime (1 tasks)",
      "",
      "#7 [in_progress] migrate CLI command → @HaoHao (by @xxchan) msg=abcd1234 rev=4",
      "  details: field assertion",
      "           rendering assertion",
      "",
    ].join("\n"),
  );
});

test("task list --mine requests the bound-agent scope and renders grouped complete output", async () => {
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
            tasks: [
              {
                taskNumber: 7,
                status: "in_progress",
                title: "migrate\nCLI command",
                channelRef: "#proj-runtime",
                createdByName: "xxchan",
                messageId: "abcd1234efgh5678",
              },
              {
                taskNumber: 2,
                status: "todo",
                title: "inspect DM task",
                channelRef: "dm:@alice",
              },
            ],
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
        };
      },
    }) as any,
  });

  await taskListCommand.handler(ctx, { mine: true });

  assert.deepEqual(requests, [{ method: "GET", path: "/internal/agent-api/tasks?mine=true" }]);
  assert.deepEqual(stderr, []);
  assert.equal(
    stdout.join(""),
    [
      "## My assigned tasks on this server (unfinished)",
      "",
      "Coverage: incomplete · visible types=channel|private|joint|dm · archived=included · inaccessible scope=not_asserted",
      "Output: showing 2 of 2 visible matches · mode=complete · truncated=false",
      "",
      "### todo (1)",
      "- dm:@alice task #2 [todo] inspect DM task",
      "### in_progress (1)",
      "- #proj-runtime task #7 [in_progress] by=@xxchan msg=abcd1234 migrate CLI command",
      "",
    ].join("\n"),
  );
});

test("task list --mine rejects a channel selector", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext });

  await assert.rejects(
    async () => { await taskListCommand.handler(ctx, { mine: true, target: "#engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /--mine cannot be combined/);
      return true;
    },
  );
});

test("task list --mine distinguishes an empty covered scope from a failed read", async () => {
  const { io, stdout, stderr } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          tasks: [],
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
      }),
    }) as any,
  });

  await taskListCommand.handler(ctx, { mine: true });

  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /showing 0 of 0 visible matches/);
  assert.match(stdout.join(""), /No tasks matched in the covered visible scope\./);
  assert.doesNotMatch(stdout.join(""), /no assignments exist|no tasks assigned globally/i);
});

test("task list command maps invalid status into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await taskListCommand.handler(ctx, { channel: "#engineering", status: "blocked" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /--status must be one of/);
      return true;
    },
  );
});

test("task list command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 403,
        data: null,
        error: "not a channel member",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await taskListCommand.handler(ctx, { channel: "#private" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "LIST_FAILED");
      assert.equal(err.message, "not a channel member");
      return true;
    },
  );
});
