import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskCreateCommand } from "./create.js";

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

test("task create command uses injected ApiClient and writes canonical text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            tasks: [
              {
                taskNumber: 8,
                messageId: "abcdef123456",
                title: "Ship typed surface",
                status: "todo",
                claimedByType: null,
                claimedById: null,
                claimedAt: null,
                requiresResourceReceipt: false,
              },
              {
                taskNumber: 9,
                messageId: "fedcba654321",
                title: "Add drift tests",
                status: "todo",
                claimedByType: null,
                claimedById: null,
                claimedAt: null,
                requiresResourceReceipt: false,
              },
            ],
          },
        };
      },
    }) as any,
  });

  await taskCreateCommand.handler(ctx, {
    target: "  #proj-runtime  ",
    title: ["Ship typed surface", "Add drift tests"],
  });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/tasks",
      body: {
        channel: "#proj-runtime",
        tasks: [
          { title: "Ship typed surface" },
          { title: "Add drift tests" },
        ],
      },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(
    stdout.join(""),
    [
      "Created 2 task(s) in #proj-runtime:",
      "#8 [todo] assignee=unassigned claimedAt=null msg=abcdef12 \"Ship typed surface\"",
      "#9 [todo] assignee=unassigned claimedAt=null msg=fedcba65 \"Add drift tests\"",
      "",
      "To follow up in each task's thread:",
      "#8 → raft message send --target \"#proj-runtime:abcdef12\"",
      "#9 → raft message send --target \"#proj-runtime:fedcba65\"",
      "",
    ].join("\n"),
  );
});

test("task create sends one atomic create-and-assign request", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            tasks: [{
              taskNumber: 10,
              messageId: "aaaabbbbcccc",
              title: "Atomic dispatch",
              status: "todo",
              claimedByType: "agent",
              claimedById: "agent-2",
              claimedByName: "ApplePI",
              claimedAt: null,
              requiresResourceReceipt: false,
            }],
            assignmentReceipt: {
              messageId: "receipt123456",
              content: "📌 Assigned @ApplePI to task #10 \"Atomic dispatch\"",
              assignee: "@ApplePI",
              state: "assigned",
            },
          },
        };
      },
    }) as any,
  });

  await taskCreateCommand.handler(ctx, {
    target: "#proj-runtime",
    title: ["Atomic dispatch"],
    assignee: "  @ApplePI  ",
  });

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/tasks",
    body: {
      channel: "#proj-runtime",
      tasks: [{ title: "Atomic dispatch" }],
      assignee: "@ApplePI",
    },
  }]);
  assert.deepEqual(stderr, []);
  assert.match(stdout.join(""), /Created 1 task\(s\) in #proj-runtime/);
  assert.match(stdout.join(""), /#10 \[todo\] assignee=@ApplePI claimedAt=null/);
  assert.match(stdout.join(""), /Assignment receipt \(msg=receipt1\):/);
  assert.match(stdout.join(""), /📌 Assigned @ApplePI to task #10 "Atomic dispatch"/);
});

test("task create help advertises atomic assignee semantics", () => {
  const option = taskCreateCommand.spec.options?.find((candidate) => candidate.flags === "--assignee <handle>");
  assert.deepEqual(option, {
    flags: "--assignee <handle>",
    description: "Assign every created task atomically to an eligible '@handle'",
  });
  assert.match(taskCreateCommand.spec.helpAfter ?? "", /Self-assignment starts work/);
  assert.match(taskCreateCommand.spec.helpAfter ?? "", /owner\/admin assignment/);
  assert.match(taskCreateCommand.spec.helpAfter ?? "", /no task-message is created/);
  assert.match(taskCreateCommand.spec.helpAfter ?? "", /cannot move to done/);
});

test("task create marks every batch item as resource-creating", async () => {
  const { io, stdout } = memoryIo();
  const requests: unknown[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            tasks: [{
              taskNumber: 11,
              messageId: "111111112222",
              title: "Create staging bucket",
              status: "todo",
              claimedByType: null,
              claimedById: null,
              claimedAt: null,
              requiresResourceReceipt: true,
            }],
          },
        };
      },
    }) as any,
  });

  await taskCreateCommand.handler(ctx, {
    target: "#proj-runtime",
    title: ["Create staging bucket"],
    createsResource: true,
  });

  assert.deepEqual(requests, [{
    channel: "#proj-runtime",
    tasks: [{ title: "Create staging bucket", creates_resource: true }],
  }]);
  assert.match(stdout.join(""), /resource-receipt=pending/);
});

test("task create rejects a non-handle assignee before auth bootstrap", async () => {
  const { io } = memoryIo();
  let loadCalls = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      loadCalls += 1;
      return agentContext;
    },
  });

  await assert.rejects(
    async () => {
      await taskCreateCommand.handler(ctx, {
        target: "#engineering",
        title: ["Ship"],
        assignee: "ApplePI",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--assignee must be an @handle");
      return true;
    },
  );
  assert.equal(loadCalls, 0);
});

test("task create command maps missing titles into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await taskCreateCommand.handler(ctx, { channel: "#engineering" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--title is required (at least one)");
      return true;
    },
  );
});

test("task create command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 403,
        data: null,
        error: "agent cannot post",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await taskCreateCommand.handler(ctx, { target: "#engineering", title: ["Ship"] }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CREATE_FAILED");
      assert.equal(err.message, "agent cannot post");
      return true;
    },
  );
});
