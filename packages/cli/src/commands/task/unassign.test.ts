import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskUnassignCommand } from "./unassign.js";

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
        return { ok: true, status: 200, error: null, data: { ok: true, revision: 4, assignee: null } };
      },
    }) as any,
  });
}

/**
 * The key wire property: an explicit `null`, not an omitted key. The server
 * distinguishes "clear it" from "not specified", so dropping the field would
 * be read as "leave the assignee alone" and the command would silently no-op.
 */
test("task unassign sends an explicit null assignee and writes canonical text", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];

  await taskUnassignCommand.handler(recordingCtx(io, requests), {
    target: "  #proj-runtime  ", number: "7",
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.method, "POST");
  assert.equal(requests[0]!.path, "/internal/agent-api/tasks/assign");

  const body = requests[0]!.body as Record<string, unknown>;
  assert.ok("assignee" in body, "the key must be present");
  assert.equal(body.assignee, null, "the server distinguishes 'clear it' from 'not specified'");
  assert.equal(body.channel, "#proj-runtime");
  assert.equal(body.task_number, 7);

  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), "#7 unassigned — now open.\n");
});

test("task unassign forwards --expected-revision only when supplied", async () => {
  const { io } = memoryIo();

  const withRev: Array<{ method: string; path: string; body: unknown }> = [];
  await taskUnassignCommand.handler(recordingCtx(io, withRev), {
    target: "#proj-runtime", number: "7", expectedRevision: "3",
  });
  assert.equal((withRev[0]!.body as { expected_revision?: number }).expected_revision, 3);

  const withoutRev: Array<{ method: string; path: string; body: unknown }> = [];
  await taskUnassignCommand.handler(recordingCtx(io, withoutRev), {
    target: "#proj-runtime", number: "7",
  });
  assert.ok(
    !("expected_revision" in (withoutRev[0]!.body as Record<string, unknown>)),
    "an absent revision must not become a literal undefined on the wire",
  );
});

test("task unassign takes no assignee flag — clearing is the whole verb", async () => {
  const { io } = memoryIo();
  const flags = taskUnassignCommand.spec.options?.map((o) => o.flags) ?? [];
  assert.ok(
    !flags.some((f) => f.includes("--assignee")),
    `unassign must not accept --assignee; got ${JSON.stringify(flags)}`,
  );
  assert.ok(
    !flags.some((f) => f.includes("--unassign")),
    "unassign must not carry a flag inverting itself",
  );
});

test("task unassign maps invalid numbers and revisions to typed CliError", async () => {
  for (const opts of [
    { target: "#proj-runtime", number: "0" },
    { target: "#proj-runtime", number: "abc" },
    { target: "#proj-runtime", number: "7", expectedRevision: "-1" },
    { target: "#proj-runtime", number: "7", expectedRevision: "1.5" },
  ]) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => { throw new Error("must not reach auth"); },
      createApiClient: () => { throw new Error("must not reach the network"); },
    });
    await assert.rejects(
      async () => { await taskUnassignCommand.handler(ctx, opts); },
      (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
      JSON.stringify(opts),
    );
  }
});
