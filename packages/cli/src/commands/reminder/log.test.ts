import assert from "node:assert/strict";
import { afterEach, beforeEach, vi } from "vitest";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError, cliError } from "../../core/errors";
import type { CliIo } from "../../core/io";

const invokeAppAction = vi.hoisted(() => vi.fn());
vi.mock("../integration/invoke", () => ({ invokeAppAction }));

import { reminderLogCommand } from "./log";

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

// ── --key: a trigger key's history from the Reminder app ───────────────────

const NOW = "2026-08-31T08:00:00.000Z";

function keyLogContext() {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => { throw new Error("--key goes through invokeAppAction"); },
  });
  return { ctx, stdout };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  invokeAppAction.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

test("--key lists entries newest first, one line each, titles folded and cut, bodies not printed", async () => {
  invokeAppAction.mockResolvedValueOnce({
    service: { clientId: "reminder" },
    value: {
      key: "slip_BTC",
      entries: [
        { at: "2026-08-31T07:58:00.000Z", level: "wake", title: "BTC slipped\n2.4%", body: "SECRET-BODY", outcome: "merged", anchor: null },
        { at: "2026-08-31T07:50:00.000Z", level: "log", title: "x".repeat(130), body: "", outcome: "recorded", anchor: null },
        { at: "2026-08-30T23:10:00.000Z", level: "wake", title: "BTC slipped 1.1%", body: "", outcome: "woke", anchor: null, event: { status: "written", attempts: 1 } },
      ],
      sinceLastEvent: { triggerCount: 2, firstTriggeredAt: "2026-08-31T07:50:00.000Z", lastTriggeredAt: "2026-08-31T07:58:00.000Z", lastEventAt: "2026-08-30T23:10:00.000Z" },
    },
  });
  const { ctx, stdout } = keyLogContext();
  await reminderLogCommand.handler(ctx, { key: "slip_BTC", limit: "3" });

  assert.equal(stdout.join(""), [
    "Trigger log for slip_BTC: 3 entries, newest first.",
    "07:58Z · wake · merged · BTC slipped 2.4%",
    `07:50Z · log · recorded · ${"x".repeat(119)}…`,
    "2026-08-30 23:10Z · wake · woke · BTC slipped 1.1%",
    "Since the last notice: 2 triggers (first 07:50Z, last 07:58Z).",
    "Next: raft reminder trigger --key slip_BTC --title <text> raises it again.",
    "",
  ].join("\n"));
  assert.doesNotMatch(stdout.join(""), /SECRET-BODY/);
  assert.deepEqual(invokeAppAction.mock.calls[0][1], { service: "reminder", action: "list-trigger-log", payload: { key: "slip_BTC", limit: 3 }, requireOfficial: true });
});

test("--key with no entries says so for the last 7 days; the reserved raft.throttled key can be read", async () => {
  invokeAppAction.mockResolvedValueOnce({
    service: { clientId: "reminder" },
    value: { key: "raft.throttled", entries: [], sinceLastEvent: { triggerCount: 0, firstTriggeredAt: null, lastTriggeredAt: null, lastEventAt: null } },
  });
  const { ctx, stdout } = keyLogContext();
  await reminderLogCommand.handler(ctx, { key: "raft.throttled" });
  assert.equal(stdout.join(""), [
    "Trigger log for raft.throttled: no entries in the last 7 days.",
    "Next: raft reminder log --key <key> shows one of the keys named above.",
    "",
  ].join("\n"));
  assert.deepEqual(invokeAppAction.mock.calls[0][1], { service: "reminder", action: "list-trigger-log", payload: { key: "raft.throttled" }, requireOfficial: true });
});

test("--id and --key: exactly one; both or neither is INVALID_ARG naming both flags", async () => {
  for (const opts of [{}, { id: reminderId, key: "slip_BTC" }]) {
    const { ctx } = keyLogContext();
    await assert.rejects(
      async () => reminderLogCommand.handler(ctx, opts),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "INVALID_ARG");
        assert.match(error.message, /--id .*--key/);
        return true;
      },
    );
  }
  for (const [opts, message] of [
    [{ key: "bad key" }, /--key must be 1-64 characters/],
    [{ key: "slip_BTC", limit: "0" }, /--limit must be a whole number from 1 to 200; got "0"/],
    [{ id: reminderId, limit: "5" }, /--limit applies only with --key/],
  ] as const) {
    const { ctx } = keyLogContext();
    await assert.rejects(async () => reminderLogCommand.handler(ctx, opts), message);
  }
  assert.equal(invokeAppAction.mock.calls.length, 0);
});

test("--key without the Reminder app: REMINDER_APP_NOT_INSTALLED", async () => {
  invokeAppAction.mockRejectedValueOnce(cliError("INTEGRATION_NOT_FOUND", "No registered integration matched reminder"));
  const { ctx } = keyLogContext();
  await assert.rejects(
    async () => reminderLogCommand.handler(ctx, { key: "slip_BTC" }),
    (error: unknown) => error instanceof CliError
      && error.code === "REMINDER_APP_NOT_INSTALLED"
      && error.message === "The Reminder app isn't installed on this server, so no trigger log was read.",
  );
});
