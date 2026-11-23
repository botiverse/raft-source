import assert from "node:assert/strict";
import { test } from "vitest";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { reminderScheduleCommand } from "./schedule";
import { reminderSnoozeCommand } from "./snooze";
import { reminderUpdateCommand } from "./update";

// External agents: the server refuses reminder mutations with 409
// `reminders_unsupported_for_external_agents`. The CLI must fail with that
// code and message (never a silent success), and must say that the local seal
// check could not run instead of skipping it silently.

const reminderId = "12345678-1234-4123-8123-123456789abc";
const REFUSAL = {
  ok: false,
  status: 409,
  error: "Reminders are not yet supported for external agents: a reminder is fired by the agent's Raft computer, and an external agent has none. Nothing was scheduled.",
  errorCode: "reminders_unsupported_for_external_agents",
  data: null,
} satisfies ApiResponse<unknown>;

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function harness() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: string[] = [];
  const io: CliIo = {
    stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push(`${method} ${path}`);
        return REFUSAL;
      },
    }) as never,
  });
  return { ctx, stdout, stderr, requests };
}

function assertRefusal(err: unknown): true {
  assert.ok(err instanceof CliError);
  assert.equal(err.code, "reminders_unsupported_for_external_agents");
  assert.match(err.message, /not yet supported for external agents/);
  return true;
}

test("reminder schedule surfaces the external-agent refusal code", async () => {
  const { ctx, stdout, requests } = harness();
  await assert.rejects(
    async () => reminderScheduleCommand.handler(ctx, { title: "follow up", delaySeconds: "60", messageId: "abcd1234" }),
    assertRefusal,
  );
  // The Reminder app gate read (refused here, so off), then the legacy create.
  assert.deepEqual(requests, ["GET /internal/agent-api/context", "POST /internal/agent-api/reminders"]);
  assert.deepEqual(stdout, []);
});

test("reminder snooze and update say the seal check is unavailable, then surface the refusal", async () => {
  for (const run of [
    (ctx: ReturnType<typeof harness>["ctx"]) => reminderSnoozeCommand.handler(ctx, { id: reminderId, by: "30m" }),
    (ctx: ReturnType<typeof harness>["ctx"]) => reminderUpdateCommand.handler(ctx, { id: reminderId, title: "renamed" }),
  ]) {
    const { ctx, stdout, stderr, requests } = harness();
    await assert.rejects(async () => run(ctx), assertRefusal);
    assert.equal(requests.length, 2);
    assert.equal(requests[0], "GET /internal/agent-api/context");
    assert.match(requests[1], /\/internal\/agent-api\/reminders\/12345678-1234-4123-8123-123456789abc/);
    assert.deepEqual(stderr, ["Reminder seals: not checked (not available for external agents).\n"]);
    assert.deepEqual(stdout, []);
  }
});
