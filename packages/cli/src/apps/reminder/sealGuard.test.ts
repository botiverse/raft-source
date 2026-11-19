import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { assertReminderNotSealed, matchesReminderId, parseReminderIdInput } from "./sealGuard";

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "http://127.0.0.1:9898",
  serverId: "server-1",
  token: "proxy-token",
  clientMode: "managed-runner",
  secretSource: "agent-proxy-token-env",
  activeCapabilities: null,
};

function item(sealed: boolean) {
  return {
    source: "app",
    itemId: "reminder:12345678-1234-4123-8123-123456789abc:7",
    appId: "system.reminder",
    notificationClass: "due",
    sourceRef: { kind: "reminder", id: "12345678-1234-4123-8123-123456789abc", revision: "7" },
    primaryAction: { kind: "run_command", commandId: "reminder.ack" },
    actionCli: "raft reminder ack --id 12345678 --revision 7",
    retention: "until_explicit_ack",
    ...(sealed ? { seal: { owner: "@Stone", until: "explicit release", sealedAtMs: 1_000 } } : {}),
  };
}

test("reminder mutation guard blocks a matching seal and permits an unsealed control", async () => {
  let sealed = true;
  let checks = 0;
  const ctx = createCommandContext({
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => {
        checks += 1;
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            rows: [],
            items: [item(sealed)],
            seals: sealed ? [{
              appId: "system.reminder",
              notificationClass: "due",
              sourceRef: { kind: "reminder", id: "12345678-1234-4123-8123-123456789abc", revision: "7" },
              owner: "@Stone",
              until: "explicit release",
              sealedAtMs: 1_000,
            }] : [],
          },
        };
      },
    }) as never,
  });

  await assert.rejects(
    async () => assertReminderNotSealed(ctx, "12345678", "cancel"),
    /sealed by @Stone until explicit release/,
  );
  sealed = false;
  await assertReminderNotSealed(ctx, "12345678", "cancel");
  assert.equal(checks, 2);
});

test("reminder mutation guard fails closed when local seal state cannot be read", async () => {
  const ctx = createCommandContext({
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        error: "daemon unavailable",
        data: null,
      }),
    }) as never,
  });

  await assert.rejects(
    async () => assertReminderNotSealed(ctx, "12345678", "update"),
    /Cannot verify local reminder seals before update/,
  );
});

test("cancel guard blocks a detached seal even when no Inbox item remains", async () => {
  const ctx = createCommandContext({
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: true,
        status: 200,
        error: null,
        data: {
          rows: [],
          items: [],
          seals: [{
            appId: "system.reminder",
            notificationClass: "due",
            sourceRef: { kind: "reminder", id: "12345678-1234-4123-8123-123456789abc", revision: "7" },
            owner: "@Stone",
            until: "explicit release",
            sealedAtMs: 1_000,
          }],
        },
      }),
    }) as never,
  });

  await assert.rejects(
    async () => assertReminderNotSealed(ctx, "12345678", "cancel"),
    /revision 7 is sealed/,
  );
});

test("parseReminderIdInput reads every id form an agent may paste", () => {
  const id = "12345678-1234-4123-8123-123456789abc";
  assert.deepEqual(parseReminderIdInput(id), { id });
  assert.deepEqual(parseReminderIdInput(" 12345678 "), { id: "12345678" });
  assert.deepEqual(parseReminderIdInput(`reminder:${id}`), { id });
  assert.deepEqual(parseReminderIdInput(`reminder:${id}:12`), { id, revision: "12" });
  assert.deepEqual(parseReminderIdInput(`${id}:3`), { id, revision: "3" });
  assert.deepEqual(parseReminderIdInput("reminder:"), { id: "" });
  assert.equal(matchesReminderId(id, "reminder:"), false);
  assert.equal(matchesReminderId(id, `reminder:${id.slice(0, 8)}:2`), true);
});
