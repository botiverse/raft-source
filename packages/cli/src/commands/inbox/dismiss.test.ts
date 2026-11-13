import assert from "node:assert/strict";

import type { AgentApiInboxDismissResponse } from "@botiverse/raft-shared";
import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { inboxDismissCommand } from "./dismiss";

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
  agentId: "agent-inbox-dismiss",
  serverUrl: "https://slock.example",
  serverId: "server-1",
  token: "sk_agent_test",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function dismissed(overrides: Partial<AgentApiInboxDismissResponse> = {}): AgentApiInboxDismissResponse {
  return {
    dismissed: 1,
    conversations: 1,
    appItems: 0,
    skippedNeedsAck: 0,
    earliestActivityAt: "2026-08-02T18:00:00.000Z",
    remaining: 0,
    ...overrides,
  };
}

function dismissClient(response: AgentApiInboxDismissResponse | ApiResponse<unknown>) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const client = {
    request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
      requests.push({ method, path: requestPath, body });
      if (requestPath !== "/internal/agent-api/inbox/dismiss") throw new Error(`unexpected request ${method} ${requestPath}`);
      return "ok" in response && "status" in response
        ? response as ApiResponse<unknown>
        : { ok: true, status: 200, error: null, data: response };
    },
  };
  return { client: client as any, requests };
}

async function run(opts: Record<string, string | undefined>, response: AgentApiInboxDismissResponse | ApiResponse<unknown>) {
  const { io, stdout, stderr } = memoryIo();
  const routed = dismissClient(response);
  const ctx = createCommandContext({ io, loadAgentContext: () => agentContext, createApiClient: () => routed.client });
  await inboxDismissCommand.handler(ctx, opts);
  return { output: stdout.join(""), stderr, requests: routed.requests };
}

function refusal(status: number, errorCode: string | null, error: string, suggestedNextAction: string | null = null): ApiResponse<unknown> {
  return {
    ok: false,
    status,
    error,
    errorCode,
    suggestedNextAction,
    data: null,
    errorBody: { error, ...(errorCode ? { errorCode } : {}), ...(suggestedNextAction ? { suggestedNextAction } : {}) },
  };
}

async function dismissError(opts: Record<string, string | undefined>, response: ApiResponse<unknown>): Promise<CliError> {
  try {
    await run(opts, response);
  } catch (err) {
    assert.ok(err instanceof CliError, `expected a CliError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected inbox dismiss to fail");
}

test("[D12] --target dismisses one item without reading it", async () => {
  const { output, stderr, requests } = await run({ target: "app:stamp/pr-13754" }, dismissed({ conversations: 0, appItems: 1 }));
  assert.deepEqual(requests, [{ method: "POST", path: "/internal/agent-api/inbox/dismiss", body: { target: "app:stamp/pr-13754" } }]);
  assert.deepEqual(stderr, []);
  assert.equal(output, "Dismissed 1 item; not read.\nNext: raft inbox check\n");
});

test("[D12][D13] --before says what it skipped and what is left", async () => {
  const { output, requests } = await run({ before: "2026-11-01" }, dismissed({ dismissed: 500, conversations: 480, appItems: 20, skippedNeedsAck: 2, remaining: 37 }));
  assert.deepEqual(requests[0].body, { before: "2026-11-01" });
  assert.equal(output, [
    "Dismissed 500 items; not read.",
    "Skipped 2 reminders that need an ack.",
    "37 more to dismiss: run the same command again.",
    "Next: raft inbox check",
    "",
  ].join("\n"));

  const one = await run({ before: "2026-11-01T00:00:00Z" }, dismissed({ dismissed: 0, conversations: 0, skippedNeedsAck: 1 }));
  assert.equal(one.output, "Dismissed 0 items; not read.\nSkipped 1 reminder that needs an ack.\nNext: raft inbox check\n");
});

test("exactly one of --target or --before, checked before any request; there is no all", async () => {
  const routed = dismissClient(dismissed());
  const ctx = createCommandContext({ io: memoryIo().io, loadAgentContext: () => agentContext, createApiClient: () => routed.client });
  for (const opts of [{}, { target: "#general", before: "2026-11-01" }, { target: "  ", before: "" }]) {
    await assert.rejects(
      async () => { await inboxDismissCommand.handler(ctx, opts); },
      (err: unknown) => err instanceof CliError
        && err.code === "INVALID_ARG"
        && err.message === "Give exactly one of --target or --before; there is no \"all\".",
    );
  }
  assert.deepEqual(routed.requests, []);
});

test("[D13] a reminder is never dismissed: NEEDS_ACK points at its ack", async () => {
  const withAck = await dismissError({ target: "reminder:76d9397d" }, refusal(409, "NEEDS_ACK", "A reminder is acked, not dismissed.", "raft reminder ack --id 76d9397d --revision 2"));
  assert.equal(withAck.code, "NEEDS_ACK");
  assert.equal(withAck.message, "A reminder is acked, not dismissed.");
  assert.equal(withAck.suggestedNextAction, "raft reminder ack --id 76d9397d --revision 2");

  const bare = await dismissError({ target: "reminder:76d9397d" }, refusal(409, "NEEDS_ACK", "A reminder is acked, not dismissed."));
  assert.equal(bare.suggestedNextAction, "Ack it with raft reminder ack.");
});

test("a bad or too recent --before keeps the server's sentence and says what is accepted", async () => {
  for (const code of ["INVALID_BEFORE", "BEFORE_TOO_RECENT", "INVALID_ARG"]) {
    const err = await dismissError({ before: "yesterday" }, refusal(400, code, `before refused: ${code}`));
    assert.equal(err.code, code);
    assert.equal(err.message, `before refused: ${code}`);
    assert.equal(err.suggestedNextAction, "Use YYYY-MM-DD or an RFC 3339 time at least 24 hours ago, or the launch date that raft inbox check's pre-launch line names.");
  }
});

test("inbox items off, not implemented yet, and an unknown item", async () => {
  const off = await dismissError({ before: "2026-11-01" }, refusal(404, "INBOX_ITEMS_DISABLED", "Inbox items are off"));
  assert.equal(off.code, "INBOX_ITEMS_DISABLED");
  assert.equal(off.message, "Inbox items are not on for this server, so there is nothing to dismiss.");
  assert.equal(off.suggestedNextAction, "raft inbox check");

  const notYet = await dismissError({ target: "#general" }, refusal(501, "NOT_IMPLEMENTED", "Not implemented"));
  assert.equal(notYet.code, "UNSUPPORTED_BY_SERVER");
  assert.equal(notYet.message, "This server can't dismiss inbox items yet.");

  const missing = await dismissError({ target: "app:stamp/pr-9" }, refusal(404, "NOT_FOUND", "No such inbox item"));
  assert.equal(missing.code, "NOT_FOUND");
  assert.equal(missing.message, "No inbox item app:stamp/pr-9 that you can dismiss.");
  assert.equal(missing.suggestedNextAction, "raft inbox check lists your items.");
});

test("a 429 (dismiss is in the write budget) says how long to wait and the command to run again", async () => {
  const body = {
    error: "This agent made too many changes: the limit is 30 a minute. Retry in 12 seconds.",
    code: "RATE_LIMITED",
    details: { operation: "inbox.dismiss", limit: 30, windowSeconds: 60, retryAfterSeconds: 12 },
  };
  const err = await dismissError({ before: "2026-11-01" }, { ok: false, status: 429, error: body.error, errorCode: "RATE_LIMITED", suggestedNextAction: null, data: null, errorBody: body });
  assert.equal(err.code, "RATE_LIMITED");
  assert.match(err.suggestedNextAction ?? "", /Wait 12 seconds[\s\S]*raft inbox dismiss --before 2026-11-01/);
});
