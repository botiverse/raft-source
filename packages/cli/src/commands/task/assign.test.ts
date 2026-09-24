import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskAssignCommand } from "./assign.js";

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

  await taskAssignCommand.handler(recordingCtx(io, requests), {
    target: "  #proj-runtime  ", number: "7", assignee: "@akko",
  });

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/tasks/assign",
    body: { channel: "#proj-runtime", task_number: 7, assignee: "@akko" },
  }]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 assigned to @akko.\n");
});

test("a bare handle without @ is normalized rather than rejected", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskAssignCommand.handler(recordingCtx(io, requests), {
    target: "#proj-runtime", number: "7", assignee: "akko",
  });

  assert.equal((requests[0]!.body as { assignee: string }).assignee, "@akko");
  assert.equal(stdout.join(""), "#7 assigned to @akko.\n");
});

test("--expected-revision is forwarded only when supplied", async () => {
  const { io } = memoryIo();
  const withRev: Array<{ method: string; path: string; body: unknown }> = [];
  await taskAssignCommand.handler(recordingCtx(io, withRev), {
    target: "#proj-runtime", number: "7", assignee: "@akko", expectedRevision: "3",
  });
  assert.equal((withRev[0]!.body as { expected_revision?: number }).expected_revision, 3);

  const withoutRev: Array<{ method: string; path: string; body: unknown }> = [];
  await taskAssignCommand.handler(recordingCtx(io, withoutRev), {
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
      async () => { await taskAssignCommand.handler(ctx, opts); },
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
      async () => { await taskAssignCommand.handler(ctx, opts); },
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
      async () => { await taskAssignCommand.handler(ctx, { target: "#proj-runtime", number: "7", assignee: "@akko" }); },
      (err: unknown) => err instanceof CliError && err.code === code,
      `status ${status}`,
    );
  }
});
