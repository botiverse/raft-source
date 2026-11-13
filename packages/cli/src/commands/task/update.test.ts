import assert from "node:assert/strict";

import { Command } from "commander";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError, CliExit } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { readPassiveRenderCountsForTest, withPassiveAxContextForTest } from "../../state/passiveRenderCountsTestReader";
import { registerTaskUpdateCommand, taskUpdateCommand } from "./update";

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

test("task update command uses injected ApiClient and writes canonical text", async () => {
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
          data: { ok: true },
        };
      },
    }) as any,
  });

  await taskUpdateCommand.handler(ctx, undefined, { target: "  #proj-runtime  ", number: ["7"], status: "in_review" });

  assert.deepEqual(requests, [
    {
      method: "POST",
      path: "/internal/agent-api/tasks/update-status",
      body: { channel: "#proj-runtime", task_number: 7, status: "in_review" },
    },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 moved to in_review.\n");
});

test("task update command preserves freshness-hold output", async () => {
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
          state: "held",
          newMessageCount: 1,
          shownMessageCount: 1,
          heldMessages: [],
        },
      }),
    }) as any,
  });

  await taskUpdateCommand.handler(ctx, undefined, { target: "#proj-runtime", number: ["7"], status: "done" });

  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  // The context is the task's own conversation, where its status line lands.
  assert.match(output, /Held — 1 unread message in #proj-runtime:#7\./);
  assert.match(output, /Your task status update was not applied\./);
  assert.match(output, /rerun the task update command/);
});

test("a held task update is counted for the daemon's turn report while passive AX is on", async () => {
  await withPassiveAxContextForTest("ctx-A", async () => {
    const { io, stdout } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: true, status: 200, error: null, data: { state: "held", newMessageCount: 1, shownMessageCount: 1, heldMessages: [] },
        }),
      }) as any,
    });
    await taskUpdateCommand.handler(ctx, undefined, { target: "#proj-runtime", number: ["7"], status: "done" });
    const held = stdout.join("");
    assert.deepEqual(readPassiveRenderCountsForTest(agentContext.agentId), [
      { contextId: "ctx-A", kind: "freshness_hold", renders: 1, chars: Array.from(held).length, bytes: Buffer.byteLength(held, "utf8") },
    ]);
  });
});

test("reviewer-isolation task update sends withheld mode and never renders poisoned hold metadata", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: unknown[] = [];
  const poison = {
    body: "other reviewer voted NO",
    sender: "other-reviewer",
    id: "blind-task-message",
    timestamp: "2042-06-07T08:09:10.000Z",
    reason: "other_reviewer_voted_no",
    error: "legacy task hold copied verdict",
    lineage: "freshness_decision_fact:task-update-poison",
  };
  const ctx = createCommandContext({
    io,
    env: { RAFT_REVIEWER_ISOLATION: "1" },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            state: "held",
            producerFactId: poison.lineage,
            reason: poison.reason,
            error: poison.error,
            newMessageCount: 2,
            shownMessageCount: 1,
            omittedMessageCount: 1,
            seenUpToSeq: 42,
            seenUpToMessageId: poison.id,
            mentionAnnotation: { formalMentionCount: 1 },
            heldMessages: [{
              seq: 42,
              id: poison.id,
              senderName: poison.sender,
              timestamp: poison.timestamp,
              content: poison.body,
            }],
          },
        };
      },
    }) as any,
  });

  await taskUpdateCommand.handler(ctx, undefined, {
    target: "#proj-runtime",
    number: ["7"],
    status: "done",
  });

  assert.deepEqual(requests, [{
    channel: "#proj-runtime",
    task_number: 7,
    status: "done",
    freshnessContextMode: "withheld",
  }]);
  assert.deepEqual(stderr, []);
  const surface = stdout.join("");
  assert.match(surface, /Reviewer-isolation freshness hold: 2 newer messages withheld/);
  for (const value of Object.values(poison)) {
    assert.doesNotMatch(surface, new RegExp(value));
  }
  assert.doesNotMatch(surface, /producerFactId|seenUpToSeq|formalMentionCount/);
});

test("task update command maps invalid status into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
  });

  await assert.rejects(
    async () => { await taskUpdateCommand.handler(ctx, undefined, { channel: "#engineering", number: ["7"], status: "blocked" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /--status must be one of/);
      return true;
    },
  );
});

test("task update command rejects repeated task numbers before loading credentials", async () => {
  const { io } = memoryIo();
  let loadAgentContextCalls = 0;
  let createApiClientCalls = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      loadAgentContextCalls += 1;
      return agentContext;
    },
    createApiClient: () => {
      createApiClientCalls += 1;
      return {
        request: async (): Promise<ApiResponse<unknown>> => {
          throw new Error("API must not be called for invalid repeated --number");
        },
      } as any;
    },
  });

  await assert.rejects(
    async () => {
      await taskUpdateCommand.handler(ctx, undefined, {
        channel: "#engineering",
        number: ["87", "93", "100"],
        status: "done",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /received 3/);
      assert.match(err.message, /Run task update once per task/);
      return true;
    },
  );
  assert.equal(loadAgentContextCalls, 0);
  assert.equal(createApiClientCalls, 0);
});

test("task update parser rejects repeated --number instead of silently using the last value", async () => {
  const { io, stderr } = memoryIo();
  let loadAgentContextCalls = 0;
  let createApiClientCalls = 0;
  const program = new Command();
  program.exitOverride();
  const task = program.command("task");
  registerTaskUpdateCommand(task, {
    io,
    loadAgentContext: () => {
      loadAgentContextCalls += 1;
      return agentContext;
    },
    createApiClient: () => {
      createApiClientCalls += 1;
      return {
        request: async (): Promise<ApiResponse<unknown>> => {
          throw new Error("API must not be called for invalid repeated --number");
        },
      } as any;
    },
  });

  await assert.rejects(
    async () => {
      await program.parseAsync([
        "node",
        "raft",
        "task",
        "update",
        "--target",
        "#proj-docs",
        "--number",
        "87",
        "--number",
        "93",
        "--number",
        "100",
        "--status",
        "done",
      ]);
    },
    (err: unknown) => {
      assert.ok(err instanceof CliExit);
      assert.equal(err.exitCode, 1);
      return true;
    },
  );
  assert.equal(loadAgentContextCalls, 0);
  assert.equal(createApiClientCalls, 0);
  const surface = stderr.join("");
  assert.match(surface, /Error: task update accepts exactly one --number; received 3/);
  assert.match(surface, /Code: INVALID_ARG/);
});

test("task update command rejects missing task number before loading credentials", async () => {
  const { io } = memoryIo();
  let loadAgentContextCalls = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      loadAgentContextCalls += 1;
      return agentContext;
    },
  });

  await assert.rejects(
    async () => {
      await taskUpdateCommand.handler(ctx, undefined, {
        channel: "#engineering",
        status: "done",
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /Provide exactly one --number/);
      return true;
    },
  );
  assert.equal(loadAgentContextCalls, 0);
});

test("task update command maps server failures into typed CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 404,
        data: null,
        error: "task not found",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await taskUpdateCommand.handler(ctx, undefined, { channel: "#engineering", number: ["7"], status: "done" }); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "UPDATE_FAILED");
      assert.equal(err.message, "task not found");
      return true;
    },
  );
});

test("task update sends backlog with its reason, folded to one line, and without one", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: unknown[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return { ok: true, status: 200, error: null, data: { ok: true, status: "backlog" } };
      },
    }) as any,
  });

  await taskUpdateCommand.handler(ctx, undefined, { target: "#proj-runtime", number: ["7"], status: "backlog", reason: " waits for the\nserver-side record " });
  await taskUpdateCommand.handler(ctx, undefined, { target: "#proj-runtime", number: ["8"], status: "backlog" });
  await taskUpdateCommand.handler(ctx, undefined, { target: "#proj-runtime", number: ["9"], status: "backlog", reason: "   " });

  assert.deepEqual(requests, [
    { channel: "#proj-runtime", task_number: 7, status: "backlog", reason: "waits for the server-side record" },
    { channel: "#proj-runtime", task_number: 8, status: "backlog" },
    { channel: "#proj-runtime", task_number: 9, status: "backlog" },
  ]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 moved to backlog.\n#8 moved to backlog.\n#9 moved to backlog.\n");
});

test("task update refuses --reason with any other status before loading credentials", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      throw new Error("must not load credentials");
    },
  });
  await assert.rejects(
    async () => {
      await taskUpdateCommand.handler(ctx, undefined, { target: "#proj-runtime", number: ["7"], status: "done", reason: "shipped" });
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /^--reason: reason is only for moving a task to backlog/);
      return true;
    },
  );
});

test("task update takes the task by its ref, as task view does, and refuses a ref that disagrees with --number", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return { ok: true, status: 200, error: null, data: { ok: true } };
      },
    }) as any,
  });

  await taskUpdateCommand.handler(ctx, "#proj-runtime:#7", { status: "done" });
  await taskUpdateCommand.handler(ctx, "dm:@richard:#3", { number: ["3"], status: "in_progress" });

  assert.deepEqual(requests.map((r) => r.body), [
    { channel: "#proj-runtime", task_number: 7, status: "done" },
    { channel: "dm:@richard", task_number: 3, status: "in_progress" },
  ]);

  await assert.rejects(
    async () => { await taskUpdateCommand.handler(ctx, "#proj-runtime:#7", { number: ["8"], status: "done" }); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
  );
  assert.equal(requests.length, 2, "a disagreeing ref sends nothing");
});

test("--peer-kind applies to a DM task ref; a channel ref refuses it, naming the DM forms", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return { ok: true, status: 200, error: null, data: { ok: true } };
      },
    }) as any,
  });

  await taskUpdateCommand.handler(ctx, "dm:@richard:#3", { peerKind: "agent", status: "done" });
  assert.deepEqual(requests.map((r) => r.body), [{ channel: "dm:@richard~agent", task_number: 3, status: "done" }]);

  await assert.rejects(
    async () => { await taskUpdateCommand.handler(ctx, "#proj-runtime:#7", { peerKind: "agent", status: "done" }); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && /dm:@peer~agent:#7/.test(err.message),
  );
  await assert.rejects(
    async () => { await taskUpdateCommand.handler(ctx, undefined, { status: "done" }); },
    (err: unknown) => err instanceof CliError && /# starts a shell comment/.test(err.message),
  );
  assert.equal(requests.length, 1);
});
