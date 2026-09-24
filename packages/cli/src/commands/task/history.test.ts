import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { taskHistoryCommand } from "./history.js";

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

test("task history reads the exact task and renders ordered actor-bound audit events", async () => {
  const { io, stdout } = memoryIo();
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
            task: { taskNumber: 99, title: "Current title", description: "Current criteria", revision: 3 },
            events: [{
              id: "11111111-1111-4111-8111-111111111111",
              seq: 123,
              eventType: "amended",
              actorType: "agent",
              actorName: "cross",
              payload: { revision: 3, changes: { title: { from: "Old", to: "Current title" } } },
              createdAt: "2026-08-05T00:00:00.000Z",
            }],
          },
        };
      },
    }) as any,
  });

  await taskHistoryCommand.handler(ctx, { target: " #proj-raft-cli ", number: "99" });
  assert.deepEqual(requests, [{
    method: "GET",
    path: "/internal/agent-api/tasks/history?channel=%23proj-raft-cli&task_number=99",
  }]);
  const output = stdout.join("");
  assert.match(output, /## Task #99 history — revision 3/);
  assert.match(output, /seq=123 time=2026-08-05T00:00:00.000Z actor=@cross type=amended/);
  assert.match(output, /"from":"Old","to":"Current title"/);
});
