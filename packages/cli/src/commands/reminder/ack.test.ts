import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { reminderAckCommand, reminderDismissCommand } from "../../apps/reminder/ack.js";

const reminderId = "12345678-1234-4123-8123-123456789abc";
const otherReminderId = "12345678-9999-4999-8999-999999999999";

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

function dueItem(overrides: {
  id?: string;
  revision: string;
  retention?: "until_source_read" | "until_explicit_ack";
  commandId?: string;
  actionCli?: string;
}) {
  const id = overrides.id ?? reminderId;
  return {
    source: "app",
    itemId: `reminder:${id}:${overrides.revision}`,
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id, revision: overrides.revision },
    primaryAction: { kind: "run_command", commandId: overrides.commandId ?? "reminder.ack" },
    actionCli: overrides.actionCli ?? `raft reminder ack --id ${id.slice(0, 8)} --revision ${overrides.revision}`,
    retention: overrides.retention ?? "until_explicit_ack",
  };
}

function acknowledgedSource(overrides: { id?: string; revision: string }) {
  const id = overrides.id ?? reminderId;
  return {
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id, revision: overrides.revision },
    itemId: `reminder:${id}:${overrides.revision}`,
    acknowledgedAtMs: 1_000,
    ownerAgentId: agentContext.agentId,
  };
}

test("ack retires the exact active fired item, including legacy persisted reminder item shape", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({
            rows: [],
            items: [
              dueItem({
                revision: "7",
                retention: "until_source_read",
                commandId: "reminder.log",
                actionCli: "raft reminder log --id 12345678",
              }),
            ],
            acknowledged_app_sources: [],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          assert.deepEqual(body, { itemId: `reminder:${reminderId}:7` });
          return ok({
            ok: true,
            itemId: `reminder:${reminderId}:7`,
            remaining_app_items: 0,
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderAckCommand.handler(ctx, { id: "12345678", revision: "7" });

  assert.match(stdout.join(""), /fired item acknowledged/);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/internal/agent-api/inbox" },
    { method: "POST", path: "/internal/agent-api/inbox/ack" },
  ]);
});

test("dismiss command shares the same exact fired-item acknowledgement path", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({
            rows: [],
            items: [dueItem({ revision: "7" })],
            acknowledged_app_sources: [],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          assert.deepEqual(body, { itemId: `reminder:${reminderId}:7` });
          return ok({
            ok: true,
            itemId: `reminder:${reminderId}:7`,
            remaining_app_items: 0,
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderDismissCommand.handler(ctx, { id: "12345678", revision: "7" });

  assert.match(stdout.join(""), /fired item acknowledged/);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/internal/agent-api/inbox" },
    { method: "POST", path: "/internal/agent-api/inbox/ack" },
  ]);
});

test("repeat ack is idempotent only with an exact durable acknowledged-source tombstone", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({
            rows: [],
            items: [],
            acknowledged_app_sources: [acknowledgedSource({ revision: "7" })],
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" });

  assert.match(stdout.join(""), /was already acknowledged for this fired item/);
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/inbox" },
  ]);
});

test("ack 404 after a stale snapshot only succeeds with a refreshed exact tombstone", async () => {
  const { io, stdout } = memoryIo();
  let inboxReads = 0;
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          inboxReads += 1;
          return ok({
            rows: [],
            items: inboxReads === 1 ? [dueItem({ revision: "7" })] : [],
            acknowledged_app_sources: inboxReads === 1 ? [] : [acknowledgedSource({ revision: "7" })],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          assert.deepEqual(body, { itemId: `reminder:${reminderId}:7` });
          return { ok: false, status: 404, error: "item not found", errorCode: "item_not_found", data: null };
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" });

  assert.match(stdout.join(""), /fired item acknowledged/);
  assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/internal/agent-api/inbox" },
    { method: "POST", path: "/internal/agent-api/inbox/ack" },
    { method: "GET", path: "/internal/agent-api/inbox" },
  ]);
});

test("ack 404 after a stale snapshot fails closed without a refreshed exact tombstone", async () => {
  const { io } = memoryIo();
  let inboxReads = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          inboxReads += 1;
          return ok({
            rows: [],
            items: inboxReads === 1 ? [dueItem({ revision: "7" })] : [],
            acknowledged_app_sources: [],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          return { ok: false, status: 404, error: "item not found", errorCode: "item_not_found", data: null };
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await Promise.resolve(reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" })); },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ACK_FAILED");
      assert.match((error as { message?: string }).message ?? "", /No durable acknowledgement/);
      return true;
    },
  );
});

test("ack does not treat absence as idempotency without an exact tombstone", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({ rows: [], items: [], acknowledged_app_sources: [] });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await Promise.resolve(reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" })); },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ACK_FAILED");
      return true;
    },
  );
});

test("ack of N fails closed after the same reminder advances to active N+1", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({
            rows: [],
            items: [dueItem({ revision: "8" })],
            acknowledged_app_sources: [acknowledgedSource({ revision: "7" })],
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await Promise.resolve(reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" })); },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ACK_FAILED");
      return true;
    },
  );
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/inbox" },
  ]);
});

test("ack rejects a short id that is ambiguous across active or acknowledged reminder sources", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({
            rows: [],
            items: [dueItem({ revision: "7" })],
            acknowledged_app_sources: [acknowledgedSource({ id: otherReminderId, revision: "7" })],
          });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await Promise.resolve(reminderAckCommand.handler(ctx, { id: "12345678", revision: "7" })); },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ACK_FAILED");
      assert.match((error as { message?: string }).message ?? "", /ambiguous/);
      return true;
    },
  );
});
