import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { taskAssignCommand } from "./assign";

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

function recordingCtx(io: CliIo, requests: Array<{ method: string; path: string; body: unknown }>) {
  return createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return { ok: true, status: 200, error: null, data: { ok: true, revision: 4, assignee: "@akko" } };
      },
    }) as any,
  });
}

test("task assign sends the handle and writes canonical text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskAssignCommand.handler(recordingCtx(io, requests), undefined, undefined, {
    target: "  #proj-runtime  ", number: "7", assignee: "@akko",
  });

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/tasks/assign",
    // `reason` is always sent (empty when not given): the server then knows
    // this client can give one.
    body: { channel: "#proj-runtime", task_number: 7, assignee: "@akko", reason: "" },
  }]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 assigned to @akko.\n");
});

test("a bare handle without @ is normalized rather than rejected", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskAssignCommand.handler(recordingCtx(io, requests), undefined, undefined, {
    target: "#proj-runtime", number: "7", assignee: "akko",
  });

  assert.equal((requests[0]!.body as { assignee: string }).assignee, "@akko");
  assert.equal(stdout.join(""), "#7 assigned to @akko.\n");
});

test("--expected-revision is forwarded only when supplied", async () => {
  const { io } = memoryIo();
  const withRev: Array<{ method: string; path: string; body: unknown }> = [];
  await taskAssignCommand.handler(recordingCtx(io, withRev), undefined, undefined, {
    target: "#proj-runtime", number: "7", assignee: "@akko", expectedRevision: "3",
  });
  assert.equal((withRev[0]!.body as { expected_revision?: number }).expected_revision, 3);

  const withoutRev: Array<{ method: string; path: string; body: unknown }> = [];
  await taskAssignCommand.handler(recordingCtx(io, withoutRev), undefined, undefined, {
    target: "#proj-runtime", number: "7", assignee: "@akko",
  });
  assert.ok(
    !("expected_revision" in (withoutRev[0]!.body as Record<string, unknown>)),
    "omitting the flag must not send expected_revision: undefined",
  );
});

/**
 * "assign with no assignee" could mean "to me" or "to nobody"; guessing either
 * would be a silent wrong write, so it is refused before any network call —
 * and the message names `unassign` so the agent is not left guessing which.
 */
test("a missing assignee is refused before auth bootstrap, and points at `unassign`", async () => {
  for (const [label, opts] of [
    ["no assignee", { target: "#proj-runtime", number: "7" }],
    ["empty assignee", { target: "#proj-runtime", number: "7", assignee: "   " }],
  ] as const) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => { throw new Error(`${label}: must not reach auth`); },
      createApiClient: () => { throw new Error(`${label}: must not reach the network`); },
    });
    await assert.rejects(
      async () => { await taskAssignCommand.handler(ctx, undefined, undefined, opts); },
      (err: unknown) => {
        assert.ok(err instanceof CliError, label);
        assert.equal(err.code, "INVALID_ARG", label);
        assert.match(err.message, /raft task unassign/, `${label}: must name the verb that clears`);
        return true;
      },
      label,
    );
  }
});

test("invalid numbers and revisions map to typed CliError", async () => {
  for (const opts of [
    { target: "#proj-runtime", number: "0", assignee: "@akko" },
    { target: "#proj-runtime", number: "abc", assignee: "@akko" },
    { target: "#proj-runtime", number: "7", assignee: "@akko", expectedRevision: "-1" },
    { target: "#proj-runtime", number: "7", assignee: "@akko", expectedRevision: "1.5" },
  ]) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => { throw new Error("must not reach auth"); },
      createApiClient: () => { throw new Error("must not reach the network"); },
    });
    await assert.rejects(
      async () => { await taskAssignCommand.handler(ctx, undefined, undefined, opts); },
      (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
      JSON.stringify(opts),
    );
  }
});

test("server failures map to a typed CliError, 5xx distinctly", async () => {
  for (const [status, code] of [[409, "ASSIGN_FAILED"], [503, "SERVER_5XX"]] as const) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: false, status, error: "nope", data: null,
        }),
      }) as any,
    });
    await assert.rejects(
      async () => { await taskAssignCommand.handler(ctx, undefined, undefined, { target: "#proj-runtime", number: "7", assignee: "@akko" }); },
      (err: unknown) => err instanceof CliError && err.code === code,
      `status ${status}`,
    );
  }
});

test("task assign over the task-write budget: RATE_LIMITED, retryable, how long to wait", async () => {
  const { io } = memoryIo();
  const body = {
    error: "This agent made too many task changes: the limit is 120 a minute. Retry in 9 seconds.",
    code: "RATE_LIMITED",
    details: { operation: "tasks.assign", limit: 120, windowSeconds: 60, retryAfterSeconds: 9 },
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({ ok: false, status: 429, error: body.error, errorCode: "RATE_LIMITED", data: null, errorBody: body }),
    }) as any,
  });
  await assert.rejects(
    async () => taskAssignCommand.handler(ctx, undefined, undefined, { target: "#proj-runtime", number: "7", assignee: "@akko" }),
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "RATE_LIMITED");
      assert.equal(err.message, body.error);
      assert.equal(err.retryable, true);
      assert.equal(err.suggestedNextAction, "Wait 9 seconds, then run the same command again (the refused request changed nothing).");
      return true;
    },
  );
});

test("a task ref and a positional assignee name the task and who gets it, with the reason", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskAssignCommand.handler(recordingCtx(io, requests), "#proj-runtime:#51", "@xxchan", {
    reason: "  Your call:\nship Friday or Monday?  ",
  });

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/tasks/assign",
    body: { channel: "#proj-runtime", task_number: 51, assignee: "@xxchan", reason: "Your call: ship Friday or Monday?" },
  }]);
  assert.equal(stdout.join(""), "#51 assigned to @xxchan.\n");
});

test("a DM task ref works, and --assignee still names the assignee after a ref", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskAssignCommand.handler(recordingCtx(io, requests), "dm:@richard:#3", undefined, { assignee: "akko", reason: "Review the draft" });

  assert.deepEqual(requests[0]!.body, { channel: "dm:@richard", task_number: 3, assignee: "@akko", reason: "Review the draft" });
});

test("a lone @who positional with --target/--number is the assignee", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskAssignCommand.handler(recordingCtx(io, requests), "@akko", undefined, { target: "#proj-runtime", number: "7", reason: "Needs your sign-off" });

  assert.deepEqual(requests[0]!.body, { channel: "#proj-runtime", task_number: 7, assignee: "@akko", reason: "Needs your sign-off" });
});

test("a ref and flags that disagree, or two different assignees, are refused before auth bootstrap", async () => {
  for (const [label, ref, who, opts] of [
    ["ref vs --number", "#proj-runtime:#51", "@akko", { number: "52" }],
    ["ref vs --target", "#proj-runtime:#51", "@akko", { target: "#other" }],
    ["positional vs --assignee", "#proj-runtime:#51", "@akko", { assignee: "@bob" }],
    ["not a ref", "proj-runtime-51", "@akko", {}],
    ["reason too long", "#proj-runtime:#51", "@akko", { reason: "x".repeat(501) }],
  ] as const) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => { throw new Error(`${label}: must not reach auth`); },
      createApiClient: () => { throw new Error(`${label}: must not reach the network`); },
    });
    await assert.rejects(
      async () => { await taskAssignCommand.handler(ctx, ref, who, opts); },
      (err: unknown) => err instanceof CliError && (err.code === "INVALID_ARG" || err.code === "INVALID_TARGET"),
      label,
    );
  }
});

test("the server's refusal of a hand-off without a reason is printed as it says it, with its next step", async () => {
  const { io } = memoryIo();
  const error = "Handing a task to someone else needs a reason: say in one line what you are waiting on them for.";
  const step = 'raft task assign "#proj-runtime:#51" @xxchan --reason "…"';
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({ ok: false, status: 400, error, errorCode: "task_assign_reason_required", suggestedNextAction: step, data: null }),
    }) as any,
  });
  await assert.rejects(
    async () => taskAssignCommand.handler(ctx, "#proj-runtime:#51", "@xxchan", {}),
    (err: unknown) => err instanceof CliError && err.code === "ASSIGN_FAILED" && err.message === error && err.suggestedNextAction === step,
  );
});

test("a ref the shell cut off (unquoted #) is named as the likely cause, before auth bootstrap", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => { throw new Error("must not reach auth"); },
    createApiClient: () => { throw new Error("must not reach the network"); },
  });
  // `raft task assign #proj:#51 @x --reason …` reaches the CLI as `raft task assign`.
  await assert.rejects(
    async () => { await taskAssignCommand.handler(ctx, undefined, undefined, {}); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && /# starts a shell comment/.test(err.message),
  );
});
