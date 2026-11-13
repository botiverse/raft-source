import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import {
  reminderAckCommand,
  reminderDismissCommand,
  reminderSealCommand,
  reminderUnsealCommand,
} from "../../apps/reminder/ack";

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
  seal?: { owner: string; until: string; sealedAtMs: number };
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
    ...(overrides.seal ? { seal: overrides.seal } : {}),
  };
}

test("ack rejects a sealed exact reminder before posting the item", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
          return ok({
            rows: [],
            items: [dueItem({
              revision: "7",
              seal: { owner: "@Stone", until: "production contains fix", sealedAtMs: 1_000 },
            })],
            seals: [{
              appId: "system.reminder",
              notificationClass: "due",
              sourceRef: { kind: "reminder", id: reminderId, revision: "7" },
              owner: "@Stone",
              until: "production contains fix",
              sealedAtMs: 1_000,
            }],
            acknowledged_app_sources: [],
          });
      },
    }) as never,
  });

  await assert.rejects(
    async () => reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" }),
    /sealed \(registered revision 7\) by @Stone until production contains fix/,
  );
  assert.deepEqual(requests, [{ method: "GET", path: "/internal/agent-api/inbox" }]);
});

test("seal and unseal all-pending use exact local item identities", async () => {
  const { io, stdout } = memoryIo();
  let sealed = false;
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (path === "/internal/agent-api/inbox" && method === "GET") {
          return ok({
            rows: [],
            items: ["7", "8"].map((revision) => dueItem({
              revision,
              ...(sealed ? { seal: { owner: "@Stone", until: "deploy", sealedAtMs: 1_000 } } : {}),
            })),
            seals: sealed ? ["7", "8"].map((revision) => ({
              appId: "system.reminder",
              notificationClass: "due",
              sourceRef: { kind: "reminder", id: reminderId, revision },
              owner: "@Stone",
              until: "deploy",
              sealedAtMs: 1_000,
            })) : [],
          });
        }
        if (path === "/internal/agent-api/inbox/seal" && method === "POST") {
          sealed = true;
          return ok({ ok: true, affected: 2 });
        }
        if (path === "/internal/agent-api/inbox/unseal" && method === "POST") {
          sealed = false;
          return ok({ ok: true, affected: 2 });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderSealCommand.handler(ctx, {
    id: "12345678",
    allPending: true,
    owner: "@Stone",
    until: "deploy",
  });
  await reminderUnsealCommand.handler(ctx, { id: "12345678", allPending: true });

  assert.deepEqual(requests.filter((request) => request.method === "POST").map((request) => request.body), [
    {
      sources: ["7", "8"].map((revision) => ({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision },
      })),
      owner: "@Stone",
      until: "deploy",
    },
    {
      sources: ["7", "8"].map((revision) => ({
        appId: "system.reminder",
        notificationClass: "due",
        sourceRef: { kind: "reminder", id: reminderId, revision },
      })),
    },
  ]);
  assert.match(stdout.join(""), /Sealed 2/);
  assert.match(stdout.join(""), /Unsealed 2/);
});

test("seal can register an exact full reminder identity after its Inbox item is gone", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({ rows: [], items: [], seals: [] });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/seal") {
          return ok({ ok: true, affected: 1 });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderSealCommand.handler(ctx, {
    id: reminderId,
    revision: "7",
    owner: "@Stone",
    until: "explicit release",
  });

  assert.deepEqual(requests[1]?.body, {
    sources: [{
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId, revision: "7" },
    }],
    owner: "@Stone",
    until: "explicit release",
  });
});

test("seal can register a detached reminder-id-only protection entry", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        if (method === "GET" && path === "/internal/agent-api/inbox") return ok({ rows: [], items: [], seals: [] });
        if (method === "POST" && path === "/internal/agent-api/inbox/seal") return ok({ ok: true, affected: 1 });
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderSealCommand.handler(ctx, {
    id: reminderId,
    owner: "@Stone",
    until: "explicit release",
  });

  assert.deepEqual(requests[1]?.body, {
    sources: [{
      appId: "system.reminder",
      notificationClass: "due",
      sourceRef: { kind: "reminder", id: reminderId },
    }],
    owner: "@Stone",
    until: "explicit release",
  });
});

test("ack rejects a later revision when an earlier tuple for the reminder id is sealed", async () => {
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
            seals: [{
              appId: "system.reminder",
              notificationClass: "due",
              sourceRef: { kind: "reminder", id: reminderId, revision: "7" },
              owner: "@Stone",
              until: "explicit release",
              sealedAtMs: 1_000,
            }],
            acknowledged_app_sources: [],
          });
        }
        throw new Error(`ack escaped local id-level seal guard: ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => reminderAckCommand.handler(ctx, { id: reminderId, revision: "8" }),
    /registered revision 7/,
  );
  assert.deepEqual(requests, [{ method: "GET", path: "/internal/agent-api/inbox" }]);
});

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
              dueItem({ revision: "8" }),
            ],
            acknowledged_app_sources: [],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          assert.deepEqual(body, { itemId: `reminder:${reminderId}:7` });
          return ok({
            ok: true,
            itemId: `reminder:${reminderId}:7`,
            remaining_app_items: 1,
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

test("repeat ack of an acked item sends the daemon the ack (it forwards it to the Server) and reports it acknowledged", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, ...(body === undefined ? {} : { body }) });
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({
            rows: [],
            items: [],
            acknowledged_app_sources: [acknowledgedSource({ revision: "7" })],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          return ok({ ok: true, itemId: `reminder:${reminderId}:7`, remaining_app_items: 0, replayed: true });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" });

  assert.match(stdout.join(""), /was already acknowledged for this fired item/);
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/inbox" },
    { method: "POST", path: "/internal/agent-api/inbox/ack", body: { itemId: `reminder:${reminderId}:7` } },
  ]);
});

test("repeat ack against a daemon that only knows the local tombstone (item_not_found) keeps the old answer", async () => {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({ rows: [], items: [], acknowledged_app_sources: [acknowledgedSource({ revision: "7" })] });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          return { ok: false, status: 404, error: "item not found", errorCode: "item_not_found", data: null };
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" });
  assert.match(stdout.join(""), /was already acknowledged for this fired item/);
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

test("ack of a full reminder id the daemon does not hold sends the exact source; item_not_found fails closed", async () => {
  const { io } = memoryIo();
  const bodies: unknown[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({ rows: [], items: [], acknowledged_app_sources: [] });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          bodies.push(body);
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
      return true;
    },
  );
  assert.deepEqual(bodies, [{
    itemId: `reminder:${reminderId}:7`,
    source: { appId: "system.reminder", notificationClass: "due", sourceRef: { kind: "reminder", id: reminderId, revision: "7" } },
  }]);
});

test("ack of a short id nothing local matches asks for the full id without posting", async () => {
  const { io } = memoryIo();
  const requests: string[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push(`${method} ${path}`);
        if (method === "GET" && path === "/internal/agent-api/inbox") {
          return ok({ rows: [], items: [], acknowledged_app_sources: [] });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await assert.rejects(
    async () => { await Promise.resolve(reminderAckCommand.handler(ctx, { id: reminderId.slice(0, 8), revision: "7" })); },
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ACK_FAILED");
      assert.equal(
        (error as { message?: string }).message,
        "No reminder Inbox item on this Computer matches 12345678 revision 7, so the short id cannot be resolved",
      );
      assert.equal(
        (error as { suggestedNextAction?: string }).suggestedNextAction,
        "Run the ack with the full reminder id from its ack: line in raft inbox check.",
      );
      return true;
    },
  );
  assert.deepEqual(requests, ["GET /internal/agent-api/inbox"]);
});

test("repeat ack of N stays idempotent after the same reminder advances to active N+1", async () => {
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
            items: [dueItem({ revision: "8" })],
            acknowledged_app_sources: [acknowledgedSource({ revision: "7" })],
          });
        }
        if (method === "POST" && path === "/internal/agent-api/inbox/ack") {
          return ok({ ok: true, itemId: `reminder:${reminderId}:7`, remaining_app_items: 1 });
        }
        throw new Error(`unexpected request ${method} ${path}`);
      },
    }) as never,
  });

  await reminderAckCommand.handler(ctx, { id: reminderId, revision: "7" });

  assert.match(stdout.join(""), /was already acknowledged for this fired item/);
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/inbox" },
    { method: "POST", path: "/internal/agent-api/inbox/ack" },
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
