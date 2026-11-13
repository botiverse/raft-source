import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { readPassiveRenderCountsForTest, withPassiveAxContextForTest } from "../../state/passiveRenderCountsTestReader";
import { taskAmendCommand } from "./amend";

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

test("task amend sends explicit fields and renders the durable revision/event receipt", async () => {
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
            task: { taskNumber: 99, title: "Current title", description: "criterion A\ncriterion B", revision: 3 },
            event: {
              id: "11111111-1111-4111-8111-111111111111",
              seq: 123,
              eventType: "amended",
              actorType: "agent",
              actorName: "cross",
              payload: {},
              createdAt: "2026-08-05T00:00:00.000Z",
            },
          },
        };
      },
    }) as any,
  });

  await taskAmendCommand.handler(ctx, undefined, {
    target: "  #proj-raft-cli  ",
    number: "99",
    title: "Current title",
    description: "criterion A\ncriterion B",
  });

  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/tasks/amend",
    body: {
      channel: "#proj-raft-cli",
      task_number: 99,
      title: "Current title",
      description: "criterion A\ncriterion B",
    },
  }]);
  assert.deepEqual(stderr, []);
  assert.equal(stdout.join(""), [
    "#99 amended — revision 3, event seq 123.",
    "title: Current title",
    "details:",
    "  │ criterion A",
    "  │ criterion B",
    "",
  ].join("\n"));
});

test("task amend supports explicit description clearing and rejects empty/ambiguous patches", async () => {
  const { io } = memoryIo();
  const bodies: unknown[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        bodies.push(body);
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            task: { taskNumber: 99, title: "Current", description: null, revision: 2 },
            event: {
              id: "11111111-1111-4111-8111-111111111111",
              seq: 2,
              eventType: "amended",
              actorType: "agent",
              actorName: "cross",
              payload: {},
              createdAt: "2026-08-05T00:00:00.000Z",
            },
          },
        };
      },
    }) as any,
  });

  await taskAmendCommand.handler(ctx, undefined, { target: "#proj-raft-cli", number: "99", clearDescription: true });
  assert.deepEqual(bodies, [{ channel: "#proj-raft-cli", task_number: 99, description: null }]);

  await assert.rejects(
    async () => { await taskAmendCommand.handler(ctx, undefined, { target: "#proj-raft-cli", number: "99" }); },
    (error: unknown) => error instanceof CliError && error.code === "INVALID_ARG",
  );
  await assert.rejects(
    async () => {
      await taskAmendCommand.handler(ctx, undefined, {
        target: "#proj-raft-cli",
        number: "99",
        description: "new",
        clearDescription: true,
      });
    },
    (error: unknown) => error instanceof CliError && error.code === "INVALID_ARG",
  );
});

test("reviewer-isolation task amend requests withheld freshness context", async () => {
  const { io, stdout } = memoryIo();
  const bodies: unknown[] = [];
  const ctx = createCommandContext({
    io,
    env: { RAFT_REVIEWER_ISOLATION: "1" },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        bodies.push(body);
        return {
          ok: true,
          status: 200,
          error: null,
          data: { state: "held", newMessageCount: 2, withheldMessageCount: 2, freshnessContextMode: "withheld" },
        };
      },
    }) as any,
  });

  await taskAmendCommand.handler(ctx, undefined, { target: "#proj-raft-cli", number: "99", title: "new" });
  assert.deepEqual(bodies, [{
    channel: "#proj-raft-cli",
    task_number: 99,
    title: "new",
    freshnessContextMode: "withheld",
  }]);
  assert.equal(stdout.join(""), "Reviewer-isolation freshness hold: 2 newer messages withheld.\n");
  assert.doesNotMatch(stdout.join(""), /task amendment|title: new/);
});

test("a held task amend is counted for the daemon's turn report while passive AX is on", async () => {
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
    await taskAmendCommand.handler(ctx, undefined, { target: "#proj-raft-cli", number: "99", title: "new" });
    const held = stdout.join("");
    assert.match(held, /Your task amendment was not applied/);
    assert.deepEqual(readPassiveRenderCountsForTest(agentContext.agentId), [
      { contextId: "ctx-A", kind: "freshness_hold", renders: 1, chars: Array.from(held).length, bytes: Buffer.byteLength(held, "utf8") },
    ]);
  });
});
