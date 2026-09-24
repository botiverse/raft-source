import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { reminderLogCommand } from "./log.js";

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

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, status: 200, error: null, data };
}

test("historical reminder short action reads the full source without acknowledging local due item", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET" && path === "/internal/agent-api/reminders/12345678/log") {
          return ok({
            events: [{
              eventId: "evt-1",
              reminderId,
              eventType: "fired",
              actorType: "system",
              actorId: null,
              occurredAt: "2026-08-09T00:00:00.000Z",
              nextFireAt: null,
              metadata: null,
            }],
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderLogCommand.handler(ctx, { id: "12345678" });

  assert.match(stdout.join(""), /FIRED by system/);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/internal/agent-api/reminders/12345678/log" },
  ]);
});

test("failed reminder log read never checks or acknowledges local Inbox", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return { ok: false, status: 404, error: "Reminder not found", data: null };
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await Promise.resolve(reminderLogCommand.handler(ctx, { id: reminderId })); },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "LOG_FAILED");
      return true;
    },
  );

  assert.deepEqual(requests, [
    { method: "GET", path: `/internal/agent-api/reminders/${reminderId}/log` },
  ]);
  assert.equal(stdout.join(""), "");
});
