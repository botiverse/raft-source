import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { inboxCheckCommand } from "./check.js";

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
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-env",
  activeCapabilities: null,
};

test("inbox check command renders pending target snapshot without content", async () => {
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
            rows: [
              {
                target: "#proj-aiax:6676bcd7",
                pendingCount: 2,
                firstPendingMsgId: "aaaaaaaa-0000-4000-8000-000000000000",
                latestMsgId: "bbbbbbbb-0000-4000-8000-000000000000",
                latestSenderName: "tygg",
                flags: ["mention", "thread"],
              },
            ],
          },
        };
      },
    }) as any,
  });

  await inboxCheckCommand.handler(ctx);

  assert.deepEqual(requests, [{ method: "GET", path: "/internal/agent-api/inbox" }]);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /Inbox: 1 pending target/);
  assert.match(output, /#proj-aiax:6676bcd7/);
  assert.match(output, /first msg=aaaaaaaa/);
  assert.match(output, /latest sender @tygg/);
  assert.match(output, /you were mentioned/);
  assert.doesNotMatch(output, / · mention(?: ·|$)/);
});

test("inbox check command rejects non-managed runners before network I/O", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => ({ ...agentContext, clientMode: "self-hosted-runner" }),
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { rows: [] },
        };
      },
    }) as any,
  });

  await assert.rejects(
    async () => { await inboxCheckCommand.handler(ctx); },
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "INBOX_CHECK_FAILED");
      assert.match((err as { message?: string }).message ?? "", /managed daemon runners/);
      assert.equal((err as { suggestedNextAction?: string }).suggestedNextAction, "Use `raft message check` to drain messages.");
      return true;
    },
  );
  assert.deepEqual(requests, []);
});

test("inbox check command renders empty snapshot", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: { rows: [] },
      }),
    }) as any,
  });

  await inboxCheckCommand.handler(ctx);

  assert.equal(stdout.join(""), "Inbox: empty\n");
});

test("inbox check command uses inbox-specific failure code", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 403,
        error: "denied",
        data: null,
      }),
    }) as any,
  });

  await assert.rejects(
    async () => { await inboxCheckCommand.handler(ctx); },
    (err: unknown) => {
      assert.equal((err as { code?: string }).code, "INBOX_CHECK_FAILED");
      assert.equal((err as { message?: string }).message, "denied");
      return true;
    },
  );
});


test("inbox check command message-only response is byte-compatible with shared snapshot formatter", async () => {
  const { io, stdout } = memoryIo();
  const rows = [
    {
      target: "#proj-aiax:6676bcd7",
      pendingCount: 2,
      firstPendingMsgId: "aaaaaaaa-0000-4000-8000-000000000000",
      latestMsgId: "bbbbbbbb-0000-4000-8000-000000000000",
      latestSenderName: "tygg",
      flags: ["mention", "thread"],
    },
  ];
  const { formatAgentInboxSnapshot } = await import("@botiverse/raft-shared");
  const expected = `${formatAgentInboxSnapshot(rows as any)}\n`;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        // message-only: no items / empty items must not change output bytes
        data: { rows, items: rows.map((row) => ({ source: "message_target", row })), pending_app_items: 0 },
      }),
    }) as any,
  });
  await inboxCheckCommand.handler(ctx);
  assert.equal(stdout.join(""), expected);
});

test("inbox check command renders structured sourceRef and exact actionCli from OS mint", async () => {
  const { io, stdout, stderr } = memoryIo();
  const appItem = {
    source: "app" as const,
    itemId: "item-uuid-0001",
    appId: "test.fixture",
    notificationClass: "due",
    sourceRef: {
      kind: "fixture",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      revision: "3",
    },
    primaryAction: { kind: "run_command" as const, commandId: "fixture.log" },
    actionCli: "raft fixture log --id aaaaaaaa",
    retention: "until_source_read" as const,
    title: "Due",
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          rows: [],
          items: [appItem],
          pending_app_items: 1,
        },
      }),
    }) as any,
  });
  await inboxCheckCommand.handler(ctx);
  assert.deepEqual(stderr, []);
  const output = stdout.join("");
  assert.match(output, /App items: 1/);
  assert.match(output, /sourceRef=fixture:aaaaaaaa-0000-4000-8000-000000000001:3/);
  assert.match(output, /action=raft fixture log --id aaaaaaaa/);
  assert.doesNotMatch(output, /msg=|sender|seq=/);
});
