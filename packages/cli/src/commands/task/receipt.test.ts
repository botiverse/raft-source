import assert from "node:assert/strict";
import test from "node:test";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { taskReceiptCommand } from "./receipt.js";

function memoryIo(): { io: CliIo; stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
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

const receiptOpts = {
  target: "#proj-runtime",
  number: "17",
  object: "staging bucket raft-17",
  purpose: "exercise restore acceptance",
  teardownOwner: "@akko",
  securityPrivacy: "internal; encrypted; no secrets",
  expiry: "2026-09-01T00:00:00.000Z",
  runbook: "runbooks/raft-17.md",
  tracking: "task #17",
};

test("task receipt sends all seven fields and renders owner/anchor receipt", async () => {
  const { io, stdout } = memoryIo();
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
            ok: true,
            taskNumber: 17,
            revision: 4,
            receipt: {
              object: "staging bucket raft-17",
              purpose: "exercise restore acceptance",
              teardown_owner: "@akko",
              security_privacy: "internal; encrypted; no secrets",
              expiry: "2026-09-01T00:00:00.000Z",
              runbook: "runbooks/raft-17.md",
              tracking: "task #17",
            },
            expiryFollowup: {
              id: "11111111-2222-4333-8444-555555555555",
              ownerAgentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
              owner: "@akko",
              fireAt: "2026-09-01T00:00:00.000Z",
              msgId: "99999999-8888-4777-8666-555555555555",
              targetChannelId: "22222222-3333-4444-8555-666666666666",
            },
          },
        };
      },
    }) as any,
  });

  await taskReceiptCommand.handler(ctx, receiptOpts);
  assert.deepEqual(requests, [{
    method: "POST",
    path: "/internal/agent-api/tasks/resource-receipt",
    body: {
      channel: "#proj-runtime",
      task_number: 17,
      receipt: {
        object: "staging bucket raft-17",
        purpose: "exercise restore acceptance",
        teardown_owner: "@akko",
        security_privacy: "internal; encrypted; no secrets",
        expiry: "2026-09-01T00:00:00.000Z",
        runbook: "runbooks/raft-17.md",
        tracking: "task #17",
      },
    },
  }]);
  assert.match(stdout.join(""), /owned by @akko/);
  assert.match(stdout.join(""), /Follow-up anchor: msg=99999999/);
});

test("task receipt rejects blank fields before auth bootstrap", async () => {
  const { io } = memoryIo();
  let authCalls = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      authCalls += 1;
      return agentContext;
    },
  });
  await assert.rejects(
    async () => { await taskReceiptCommand.handler(ctx, { ...receiptOpts, runbook: "   " }); },
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INVALID_ARG");
      assert.match(error.message, /--runbook is required and must be nonblank/);
      return true;
    },
  );
  assert.equal(authCalls, 0);
});
