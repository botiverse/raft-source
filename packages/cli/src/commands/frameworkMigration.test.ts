import assert from "node:assert/strict";
import test from "node:test";

import type { ReminderSummary } from "@botiverse/raft-shared";

import type { ApiResponse } from "../client.js";
import type { AgentContext } from "../auth/env.js";
import { createCommandContext } from "../core/context.js";
import { CliError } from "../core/errors.js";
import type { CliIo } from "../core/io.js";
import { attachmentUploadCommand } from "./attachment/upload.js";
import { channelMembersCommand } from "./channel/members.js";
import { integrationListCommand } from "./integration/list.js";
import { integrationLoginCommand } from "./integration/login.js";
import { integrationInvokeCommand } from "./integration/invoke.js";
import { profileUpdateCommand } from "./profile/update.js";
import { reminderCancelCommand } from "./reminder/cancel.js";
import { reminderListCommand } from "./reminder/list.js";
import { reminderLogCommand } from "./reminder/log.js";
import { reminderSnoozeCommand } from "./reminder/snooze.js";
import { reminderUpdateCommand } from "./reminder/update.js";
import { taskClaimCommand } from "./task/claim.js";
import { taskCreateCommand } from "./task/create.js";
import { taskAmendCommand } from "./task/amend.js";
import { taskHistoryCommand } from "./task/history.js";

type MaybePromise<T> = T | Promise<T>;

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

const reminderId = "12345678901234567890123456789012";

function reminder(overrides: Partial<ReminderSummary> = {}): ReminderSummary {
  return {
    reminderId,
    ownerAgentId: "agent-1",
    title: "Follow up",
    fireAt: "2026-05-29T10:00:00.000Z",
    firedAt: null,
    createdAt: "2026-05-29T09:00:00.000Z",
    status: "scheduled",
    msgRef: null,
    msgPermalink: null,
    recurrence: null,
    ...overrides,
  };
}

function service() {
  return {
    id: "svc-1",
    clientId: "docs",
    name: "Docs",
    description: null,
    homepageUrl: null,
    returnUrl: null,
    agentManifestUrl: null,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
  };
}

function humanProfile() {
  return {
    kind: "agent",
    id: "agent-1",
    isSelf: true,
    name: "HaoHao",
    displayName: "HaoHao",
    description: "Runtime agent",
    avatarUrl: null,
    status: "active",
    serverRole: "member",
    runtime: "claude",
    model: "sonnet",
    reasoningEffort: null,
    executionMode: null,
    computerId: null,
    computerName: null,
    computerHostname: null,
    daemonVersion: null,
    creator: null,
    createdAgents: [],
    createdAt: "2026-05-01T00:00:00.000Z",
    deletedAt: null,
  };
}

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, status: 200, error: null, data };
}

function fail(status: number, error: string): ApiResponse<unknown> {
  return { ok: false, status, error, data: null };
}

function proxyFail(): ApiResponse<unknown> {
  return {
    ok: false,
    status: 502,
    error: "failed to proxy local agent request",
    errorCode: "agent_proxy_failed",
    data: null,
    proxy: {
      layer: "local_daemon_proxy",
      correlationId: "0123456789abcdef",
      routeFamily: "tasks/claim",
      failureClass: "pre_response_transport",
      causeCode: "UND_ERR_CONNECT_TIMEOUT",
      upstreamLayer: "tcp",
      responseStarted: false,
      responseComplete: false,
      targetHostClass: "api.raft.build",
      upstream: "server",
    },
  };
}

async function assertInvalidBeforeBootstrap(
  name: string,
  run: (ctx: ReturnType<typeof createCommandContext>) => MaybePromise<void>,
  expectedMessage: string,
): Promise<void> {
  const { io } = memoryIo();
  let loadCalls = 0;
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      loadCalls += 1;
      throw new Error("bootstrap should not run");
    },
  });

  await assert.rejects(
    async () => { await Promise.resolve(run(ctx)); },
    (err: unknown) => {
      assert.ok(err instanceof CliError, name);
      assert.equal(err.code, "INVALID_ARG", name);
      assert.equal(err.message, expectedMessage, name);
      return true;
    },
  );
  assert.equal(loadCalls, 0, `${name} should not load agent context`);
}

test("missing required options fail as INVALID_ARG before auth bootstrap", async () => {
  await assertInvalidBeforeBootstrap(
    "channel members",
    (ctx) => channelMembersCommand.handler(ctx, ""),
    "target is required",
  );
  await assertInvalidBeforeBootstrap(
    "reminder cancel",
    (ctx) => reminderCancelCommand.handler(ctx, {}),
    "--id is required",
  );
  await assertInvalidBeforeBootstrap(
    "integration login",
    (ctx) => integrationLoginCommand.handler(ctx, {}),
    "--service is required",
  );
  await assertInvalidBeforeBootstrap(
    "integration invoke",
    (ctx) => integrationInvokeCommand.handler(ctx, {}),
    "--service or service argument is required",
  );
  await assertInvalidBeforeBootstrap(
    "attachment upload",
    (ctx) => attachmentUploadCommand.handler(ctx, {}),
    "--path is required",
  );
  await assertInvalidBeforeBootstrap(
    "profile update",
    (ctx) => profileUpdateCommand.handler(ctx, {}),
    "Provide at least one of --avatar-file, --avatar-url, --display-name, or --description",
  );
  await assertInvalidBeforeBootstrap(
    "task create",
    (ctx) => taskCreateCommand.handler(ctx, { title: ["Ship"] }),
    "--target is required (legacy --channel is accepted during the transition)",
  );
  await assertInvalidBeforeBootstrap(
    "task amend",
    (ctx) => taskAmendCommand.handler(ctx, { number: "8", title: "Current" }),
    "--target is required (legacy --channel is accepted during the transition)",
  );
  await assertInvalidBeforeBootstrap(
    "task history",
    (ctx) => taskHistoryCommand.handler(ctx, { target: "#engineering" }),
    "--number must be a positive integer; got undefined",
  );
});

test("newly migrated commands use injected client and write canonical success output", async () => {
  const cases: Array<{
    name: string;
    run: () => Promise<{ stdout: string; requests: Array<{ method: string; path: string; body?: unknown }> }>;
    stdout: RegExp;
  }> = [
    {
      name: "integration list",
      run: async () => runCommand(ok({ services: [service()], activeLogins: [] }), (ctx) => integrationListCommand.handler(ctx, {})),
      stdout: /Registered services:/,
    },
    {
      name: "integration login",
      run: async () => runCommand(
        ok({ status: "logged_in", service: service(), scopes: ["read"], requestId: "req-1" }),
        (ctx) => integrationLoginCommand.handler(ctx, { service: "docs", scope: ["read"] }),
      ),
      stdout: /Agent login ready: Docs/,
    },
    {
      name: "profile update",
      run: async () => runCommand(ok(humanProfile()), (ctx) => profileUpdateCommand.handler(ctx, { displayName: "xxchan" })),
      stdout: /## Profile/,
    },
    {
      name: "reminder cancel",
      run: async () => runCommand(ok({ reminder: reminder({ status: "canceled" }) }), (ctx) => reminderCancelCommand.handler(ctx, { id: reminderId })),
      stdout: /Reminder canceled:/,
    },
    {
      name: "reminder list",
      run: async () => runCommand(ok({ reminders: [reminder()] }), (ctx) => reminderListCommand.handler(ctx, {})),
      stdout: /#12345678 \[scheduled\]/,
    },
    {
      name: "reminder log",
      run: async () => runCommand(
        ok({ events: [{ eventId: "evt-1", reminderId, eventType: "scheduled", actorType: "agent", actorId: "agent-1", occurredAt: "2026-05-29T09:00:00.000Z", nextFireAt: "2026-05-29T10:00:00.000Z", metadata: null }] }),
        (ctx) => reminderLogCommand.handler(ctx, { id: reminderId }),
      ),
      stdout: /SCHEDULED by agent:agent-1/,
    },
    {
      name: "reminder snooze",
      run: async () => runCommand(ok({ reminder: reminder() }), (ctx) => reminderSnoozeCommand.handler(ctx, { id: reminderId, by: "30m" })),
      stdout: /Reminder snoozed:/,
    },
    {
      name: "reminder update",
      run: async () => runCommand(ok({ reminder: reminder({ title: "Updated" }) }), (ctx) => reminderUpdateCommand.handler(ctx, { id: reminderId, title: "Updated" })),
      stdout: /Reminder updated:/,
    },
    {
      name: "task claim",
      run: async () => runCommand(ok({ results: [{ taskNumber: 7, messageId: "abcdef123456", success: true }] }), (ctx) => taskClaimCommand.handler(ctx, { target: "#engineering", number: ["7"] })),
      stdout: /Claim results/,
    },
    {
      name: "task create",
      run: async () => runCommand(ok({
        tasks: [{
          taskNumber: 8,
          messageId: "abcdef123456",
          title: "Ship",
          status: "todo",
          claimedByType: null,
          claimedById: null,
          claimedAt: null,
          requiresResourceReceipt: false,
        }],
      }), (ctx) => taskCreateCommand.handler(ctx, { target: "#engineering", title: ["Ship"] })),
      stdout: /Created 1 task/,
    },
    {
      name: "task amend",
      run: async () => runCommand(ok({
        task: { taskNumber: 8, title: "Current", description: "criteria", revision: 2 },
        event: {
          id: "11111111-1111-4111-8111-111111111111",
          seq: 12,
          eventType: "amended",
          actorType: "agent",
          actorName: "cross",
          payload: { revision: 2, changes: { title: { from: "Ship", to: "Current" } } },
          createdAt: "2026-08-05T00:00:00.000Z",
        },
      }), (ctx) => taskAmendCommand.handler(ctx, { target: "#engineering", number: "8", title: "Current" })),
      stdout: /#8 amended — revision 2, event seq 12/,
    },
    {
      name: "task history",
      run: async () => runCommand(ok({
        task: { taskNumber: 8, title: "Current", description: "criteria", revision: 2 },
        events: [],
      }), (ctx) => taskHistoryCommand.handler(ctx, { target: "#engineering", number: "8" })),
      stdout: /## Task #8 history — revision 2/,
    },
  ];

  for (const c of cases) {
    const result = await c.run();
    assert.match(result.stdout, c.stdout, c.name);
    assert.ok(result.requests.length > 0, `${c.name} should use injected client`);
  }
});

test("newly migrated commands map server failures to CliError", async () => {
  const cases: Array<{ name: string; code: string; run: (ctx: ReturnType<typeof createCommandContext>) => MaybePromise<void> }> = [
    { name: "integration list", code: "INTEGRATION_LIST_FAILED", run: (ctx) => integrationListCommand.handler(ctx, {}) },
    { name: "integration login", code: "INTEGRATION_LOGIN_FAILED", run: (ctx) => integrationLoginCommand.handler(ctx, { service: "docs" }) },
    { name: "profile update", code: "PROFILE_UPDATE_FAILED", run: (ctx) => profileUpdateCommand.handler(ctx, { displayName: "xxchan" }) },
    { name: "reminder cancel", code: "CANCEL_FAILED", run: (ctx) => reminderCancelCommand.handler(ctx, { id: reminderId }) },
    { name: "reminder list", code: "LIST_FAILED", run: (ctx) => reminderListCommand.handler(ctx, {}) },
    { name: "reminder log", code: "LOG_FAILED", run: (ctx) => reminderLogCommand.handler(ctx, { id: reminderId }) },
    { name: "reminder snooze", code: "SNOOZE_FAILED", run: (ctx) => reminderSnoozeCommand.handler(ctx, { id: reminderId, by: "30m" }) },
    { name: "reminder update", code: "UPDATE_FAILED", run: (ctx) => reminderUpdateCommand.handler(ctx, { id: reminderId, title: "Updated" }) },
    { name: "task claim", code: "CLAIM_FAILED", run: (ctx) => taskClaimCommand.handler(ctx, { target: "#engineering", number: ["7"] }) },
    { name: "task create", code: "CREATE_FAILED", run: (ctx) => taskCreateCommand.handler(ctx, { target: "#engineering", title: ["Ship"] }) },
    { name: "task amend", code: "AMEND_FAILED", run: (ctx) => taskAmendCommand.handler(ctx, { target: "#engineering", number: "8", title: "Current" }) },
    { name: "task history", code: "HISTORY_FAILED", run: (ctx) => taskHistoryCommand.handler(ctx, { target: "#engineering", number: "8" }) },
  ];

  for (const c of cases) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({ request: async () => fail(409, "server rejected") }) as any,
    });
    await assert.rejects(
      async () => { await Promise.resolve(c.run(ctx)); },
      (err: unknown) => {
        assert.ok(err instanceof CliError, c.name);
        assert.equal(err.code, c.code, c.name);
        assert.equal(err.message, "server rejected", c.name);
        return true;
      },
    );
  }
});

test("task claim maps daemon proxy 5xx envelopes to proxy-scoped CliError", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({ request: async () => proxyFail() }) as any,
  });

  await assert.rejects(
    async () => { await Promise.resolve(taskClaimCommand.handler(ctx, { target: "#engineering", number: ["7"] })); },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "PROXY_5XX");
      assert.equal(err.message, "failed to proxy local agent request");
      assert.equal(err.layer, "local_daemon_proxy");
      assert.equal(err.correlationId, "0123456789abcdef");
      assert.equal(err.proxyFailureClass, "pre_response_transport");
      assert.equal(err.proxyCauseCode, "UND_ERR_CONNECT_TIMEOUT");
      assert.equal(err.proxyRouteFamily, "tasks/claim");
      assert.equal(err.proxyResponseStarted, false);
      assert.equal(err.proxyResponseComplete, false);
      assert.match(err.suggestedNextAction ?? "", /local daemon proxy/);
      return true;
    },
  );
});

test("task claim accepts legacy --channel alias during target transition", async () => {
  const result = await runCommand(
    ok({ results: [{ taskNumber: 7, messageId: "abcdef123456", success: true }] }),
    (ctx) => taskClaimCommand.handler(ctx, { channel: "#engineering", number: ["7"] }),
  );

  assert.deepEqual(result.requests, [
    {
      method: "POST",
      path: "/internal/agent-api/tasks/claim",
      body: { channel: "#engineering", task_numbers: [7] },
    },
  ]);
});

test("task claim rejects conflicting --target and legacy --channel before auth bootstrap", async () => {
  await assertInvalidBeforeBootstrap(
    "task claim",
    (ctx) => taskClaimCommand.handler(ctx, { target: "#engineering", channel: "#ops", number: ["7"] }),
    "--target and legacy --channel must refer to the same target when both are provided",
  );
});

async function runCommand(
  response: ApiResponse<unknown>,
  run: (ctx: ReturnType<typeof createCommandContext>) => MaybePromise<void>,
): Promise<{ stdout: string; requests: Array<{ method: string; path: string; body?: unknown }> }> {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path, body });
        return response;
      },
    }) as any,
  });

  await Promise.resolve(run(ctx));
  return { stdout: stdout.join(""), requests };
}
