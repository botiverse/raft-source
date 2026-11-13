import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { taskCreateCommand } from "./create";

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

test("task create without a source on a task v2 server shows the Server's sentence and the create to run instead", async () => {
  const { io } = memoryIo();
  const sentence = "A task needs a source: the id of the channel message that asked for it, as the task's source message. If the request is in a thread, use that thread's message; for something you thought of yourself, first post a message in the channel saying what and why, then create the task from it.";
  const next = `raft task create --target "#engineering" --message-id <id> --title "…"`;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 400,
        data: null,
        error: sentence,
        errorCode: "task_source_required",
        suggestedNextAction: next,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await taskCreateCommand.handler(ctx, { target: "#engineering", title: ["Ship"] }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CREATE_FAILED");
      assert.equal(err.message, sentence);
      assert.equal(err.suggestedNextAction, next);
      return true;
    },
  );
});

test("task create from a thread reply says the task hangs under the thread's root message", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          tasks: [{
            taskNumber: 4,
            messageId: "#4",
            title: "Fix the login bug",
            status: "todo",
            claimedByType: null,
            claimedById: null,
            claimedAt: null,
            requiresResourceReceipt: false,
            conversationAnchored: true,
            sourceMessageId: "aaaabbbb-0000-4000-8000-000000000000",
            sourceThreadReplyId: "ccccdddd-0000-4000-8000-000000000000",
          }],
        },
      }),
    }) as any,
  });

  await taskCreateCommand.handler(ctx, { target: "#engineering", title: ["Fix the login bug"], messageId: "ccccdddd" });
  assert.match(stdout.join(""), /^Source: the thread's root message msg=aaaabbbb \(you gave a reply in its thread, msg=ccccdddd\)\.$/m);
});

test("task create help says the source message is required where task conversations are on", () => {
  const option = taskCreateCommand.spec.options?.find((candidate) => candidate.flags === "--message-id <id>");
  assert.match(option?.description ?? "", /^Source \(required where task conversations are on\)/);
  assert.match(taskCreateCommand.spec.guidance ?? "", /first post a message in the channel saying what and why/);
  assert.match(taskCreateCommand.spec.guidance ?? "", /a thread reply: its thread's root/);
});

test("task create sends description and source message id", async () => {
  const { io } = memoryIo();
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
              taskNumber: 12,
              messageId: "333333334444",
              title: "Hero section",
              status: "todo",
              claimedByType: null,
              claimedById: null,
              claimedAt: null,
              requiresResourceReceipt: false,
            }],
          },
        };
      },
    }) as any,
  });

  await taskCreateCommand.handler(ctx, {
    target: "#launch-site",
    title: ["Hero section"],
    description: "  Countdown + CTA  ",
    messageId: " cf3aa0a0 ",
  });

  assert.deepEqual(requests, [{
    channel: "#launch-site",
    tasks: [{ title: "Hero section", description: "Countdown + CTA", source_message_id: "cf3aa0a0" }],
  }]);
});

test("task create applies --message-id to every title and rejects --description with several titles", async () => {
  const requests: unknown[] = [];
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return { ok: true, status: 200, error: null, data: { tasks: [] } };
      },
    }) as any,
  });

  await taskCreateCommand.handler(ctx, {
    target: "#launch-site",
    title: ["A", "B"],
    messageId: "cf3aa0a0",
  });
  assert.deepEqual(requests, [{
    channel: "#launch-site",
    tasks: [
      { title: "A", source_message_id: "cf3aa0a0" },
      { title: "B", source_message_id: "cf3aa0a0" },
    ],
  }]);

  await assert.rejects(
    async () => {
      await taskCreateCommand.handler(ctx, { target: "#launch-site", title: ["A", "B"], description: "x" });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.equal(err.message, "--description can only be used with a single --title");
      return true;
    },
  );
  assert.equal(requests.length, 1);
});

test("task create sends --status for every title and refuses a status a task can't start in", async () => {
  const requests: unknown[] = [];
  const ctx = createCommandContext({
    io: memoryIo().io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return { ok: true, status: 200, error: null, data: { tasks: [] } };
      },
    }) as any,
  });

  // Self-assigned but reserved for later.
  await taskCreateCommand.handler(ctx, { target: "#launch-site", title: ["Later"], assignee: "@me", status: "todo" });
  // In progress with nobody on it: statuses have no assignee requirement.
  await taskCreateCommand.handler(ctx, { target: "#launch-site", title: ["A", "B"], status: " in_progress " });
  // Parked at creation: no reason to ask for, a new task has nothing to come back from.
  await taskCreateCommand.handler(ctx, { target: "#launch-site", title: ["Not now"], status: "backlog" });
  assert.deepEqual(requests, [
    { channel: "#launch-site", tasks: [{ title: "Later" }], assignee: "@me", status: "todo" },
    { channel: "#launch-site", tasks: [{ title: "A" }, { title: "B" }], status: "in_progress" },
    { channel: "#launch-site", tasks: [{ title: "Not now" }], status: "backlog" },
  ]);

  for (const status of ["done", "in_review", "closed", ""]) {
    await assert.rejects(
      async () => {
        await taskCreateCommand.handler(ctx, { target: "#launch-site", title: ["A"], status });
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_ARG");
        assert.match(err.message, /^--status must be one of: backlog, todo, in_progress; got /);
        return true;
      },
    );
  }
  assert.equal(requests.length, 3, "a refused status sends nothing");
  const option = taskCreateCommand.spec.options?.find((candidate) => candidate.flags === "--status <status>");
  assert.match(option?.description ?? "", /Default: in_progress when you assign yourself, otherwise todo/);
});
