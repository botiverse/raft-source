import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { reminderCancelCommand } from "./cancel";

const reminderId = "12345678-1234-4123-8123-123456789abc";
const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://127.0.0.1:9898",
  serverId: "server-1",
  token: "proxy-token",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-env",
  activeCapabilities: null,
};

test("cancel is blocked by a reminder-id seal even when the exact Inbox item is absent", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              rows: [],
              items: [],
              seals: [{
                appId: "system.reminder",
                notificationClass: "due",
                sourceRef: { kind: "reminder", id: reminderId, revision: "7" },
                owner: "@Stone",
                until: "explicit release",
                sealedAtMs: 1_000,
              }],
            },
          };
        }
        throw new Error(`cancel escaped local seal guard: ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => reminderCancelCommand.handler(ctx, { id: "12345678" }),
    /revision 7 is sealed/,
  );
  // The Reminder app gate read, once more when it gets no answer (legacy cancel then), the seal check; no cancel.
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/context" },
    { method: "GET", path: "/internal/agent-api/context" },
    { method: "GET", path: "/internal/agent-api/inbox" },
  ]);
});

test("cancel sends the bare id when given the id as raft inbox check prints it", async () => {
  for (const pasted of [`reminder:${reminderId}`, `reminder:${reminderId}:3`]) {
    const requests: Array<{ method: string; path: string }> = [];
    const ctx = createCommandContext({
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
          requests.push({ method, path });
          if (method === "GET" && path === "/internal/agent-api/inbox") {
            return { ok: true, status: 200, error: null, data: { rows: [], items: [], seals: [] } };
          }
          return { ok: false, status: 404, error: "Reminder not found", data: null };
        },
      }) as never,
    });

    await assert.rejects(async () => reminderCancelCommand.handler(ctx, { id: pasted }), /Reminder not found/);
    assert.deepEqual(requests.at(-1), { method: "DELETE", path: `/internal/agent-api/reminders/${reminderId}` });
  }
});

test("a seal still blocks cancel when the id is pasted as reminder:<id>:<rev>", async () => {
  const ctx = createCommandContext({
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return {
            ok: true,
            status: 200,
            error: null,
            data: {
              rows: [],
              items: [],
              seals: [{
                appId: "system.reminder",
                notificationClass: "due",
                sourceRef: { kind: "reminder", id: reminderId, revision: "7" },
                owner: "@Stone",
                until: "explicit release",
                sealedAtMs: 1_000,
              }],
            },
          };
        }
        throw new Error(`cancel escaped local seal guard: ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => reminderCancelCommand.handler(ctx, { id: `reminder:${reminderId}:7` }),
    /revision 7 is sealed/,
  );
});
