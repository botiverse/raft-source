import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU } from "@botiverse/raft-shared";
import { CliError, CliExit } from "../../core/errors";
import { readPassiveRenderCountsForTest, withPassiveAxContextForTest } from "../../state/passiveRenderCountsTestReader";
import { taskClaimCommand } from "./claim";

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

test("task claim command keeps repeated task numbers as one batched claim request", async () => {
  const { io, stdout } = memoryIo();
  const requests: unknown[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            results: [
              { taskNumber: 87, messageId: "msg-87", success: true },
              { taskNumber: 93, messageId: "msg-93", success: true },
              { taskNumber: 100, messageId: "msg-100", success: true },
            ],
          },
        };
      },
    }) as any,
  });

  await taskClaimCommand.handler(ctx, undefined, { target: "#engineering", number: ["87", "93", "100"] });

  assert.deepEqual(requests, [{
    channel: "#engineering",
    task_numbers: [87, 93, 100],
  }]);
  assert.match(stdout.join(""), /Claim results \(3 claimed\)/);
});

test("reviewer-isolation task claim uses withheld mode and reprojects poisoned legacy hold output", async () => {
  const { io, stdout } = memoryIo();
  const requests: unknown[] = [];
  const poison = {
    body: "peer reviewer already approved",
    sender: "peer-reviewer",
    id: "blind-claim-message",
    timestamp: "2042-07-08T09:10:11.000Z",
    reason: "peer_reviewer_approved",
    error: "legacy claim hold copied verdict",
    lineage: "freshness_decision_fact:task-claim-poison",
  };
  const ctx = createCommandContext({
    io,
    env: { RAFT_REVIEWER_ISOLATION: "true" },
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return {
          ok: true,
          status: 200,
          error: null,
          data: {
            state: "held",
            producerFactId: poison.lineage,
            reason: poison.reason,
            error: poison.error,
            newMessageCount: 1,
            seenUpToSeq: 17,
            seenUpToMessageId: poison.id,
            heldMessages: [{
              seq: 17,
              id: poison.id,
              senderName: poison.sender,
              timestamp: poison.timestamp,
              content: poison.body,
            }],
          },
        };
      },
    }) as any,
  });

  await taskClaimCommand.handler(ctx, undefined, { target: "#engineering", number: ["7"] });

  assert.deepEqual(requests, [{
    channel: "#engineering",
    task_numbers: [7],
    freshnessContextMode: "withheld",
  }]);
  const surface = stdout.join("");
  assert.match(surface, /Reviewer-isolation freshness hold: 1 newer message withheld/);
  for (const value of Object.values(poison)) {
    assert.doesNotMatch(surface, new RegExp(value));
  }
  assert.doesNotMatch(surface, /producerFactId|seenUpToSeq|timestamp|sender/i);
});

// Three arms in one test because two of them are indistinguishable alone: an
// implementation of "exit non-zero if ANY item failed" passes the all-fail and
// all-succeed arms identically to the frozen policy ("exit non-zero only when
// ZERO items succeeded"). The partial arm is the only one that separates them,
// and the two policies differ for a real caller — `claim A B && start` should
// still run when A was claimed and B was not.
test("task claim exit status: zero successes is non-zero, any success is zero", async () => {
  const claimWith = async (results: Array<{ taskNumber: number; messageId: string; success: boolean; reason?: string }>) => {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: true, status: 200, error: null, data: { results },
        }),
      }) as any,
    });
    return taskClaimCommand.handler(ctx, undefined, {
      target: "#engineering",
      number: results.map((r) => String(r.taskNumber)),
    });
  };

  // A — defect witness: every item refused, yet the HTTP call succeeded.
  await assert.rejects(
    () => claimWith([
      { taskNumber: 998, messageId: "m-998", success: false },
      { taskNumber: 999, messageId: "m-999", success: false },
    ]),
    // task #60: the refusal is now a typed CliError (still exit 1), no longer a
    // bare CliExit that upstream misrendered as INTERNAL_BUG.
    (err: unknown) => !(err instanceof CliExit)
      && (err as { code?: string }).code === "CLAIM_FAILED"
      && (err as { exitCode?: number }).exitCode === 1,
    "all-failed claim must exit non-zero via a typed refusal",
  );

  // B — invariant: a real claim still exits 0.
  await assert.doesNotReject(
    () => claimWith([{ taskNumber: 87, messageId: "m-87", success: true }]),
    "successful claim must stay exit 0",
  );

  // D — a task this agent already holds. Carried as a refusal (`success:false`
  // with reason "already claimed by you"), but it authorises work, so it must
  // not exit non-zero: the prompt says do not start work when a claim fails,
  // and re-confirming your own claim is behaviour the product supports.
  await assert.doesNotReject(
    async () => { await claimWith([
      { taskNumber: 87, messageId: "m-87", success: false, reason: TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU },
    ]); },
    "re-confirming a claim you already hold must stay exit 0",
  );

  // C — discriminating arm: partial success exits 0 under the frozen policy.
  await assert.doesNotReject(
    () => claimWith([
      { taskNumber: 87, messageId: "m-87", success: true },
      { taskNumber: 999, messageId: "m-999", success: false },
    ]),
    "partial claim did real work and must stay exit 0",
  );
});

// task #60: a zero-success claim must be a typed refusal on stderr, never a
// bare CliExit that upstream wraps into "Code: INTERNAL_BUG", and the error
// itself must carry the holder so it survives when stdout is lost (batched
// `claim && send` invocations surface only the error).
function refusalCtx(results: unknown[]): { ctx: ReturnType<typeof createCommandContext>; stdout: string[] } {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({ ok: true, status: 200, error: null, data: { results } }),
    }) as any,
  });
  return { ctx, stdout };
}

test("zero-success claim with a structured conflict throws typed CLAIM_CONFLICT naming the holder", async () => {
  const { ctx, stdout } = refusalCtx([{
    taskNumber: 57, messageId: "msg-57", success: false,
    reason: "already assigned to @Cody",
    conflict: {
      kind: "claim_conflict", conflictScope: "implementation_execution",
      blockedActions: ["claim"], unblockedActionExamples: ["comment in thread"],
      currentAssignee: { type: "agent", name: "Cody" },
      taskStatus: "in_progress", claimedAt: null, observedAt: "2026-09-07T12:00:00.000Z",
    },
  }]);
  await assert.rejects(
    async () => taskClaimCommand.handler(ctx, undefined, { target: "#proj-task", number: ["57"] }),
    (error: any) => error?.code === "CLAIM_CONFLICT"
      && /#57 held by @Cody/.test(error.message)
      && !/INTERNAL_BUG|CliExit/.test(String(error.message)),
  );
  // stdout keeps the full per-row account (the error is a summary, not a replacement).
  assert.match(stdout.join(""), /@Cody currently holds the implementation lock/);
});

test("zero-success claim without a conflict throws typed CLAIM_FAILED carrying the reason", async () => {
  const { ctx } = refusalCtx([{ taskNumber: 99, success: false, reason: "task not found" }]);
  await assert.rejects(
    async () => taskClaimCommand.handler(ctx, undefined, { target: "#proj-task", number: ["99"] }),
    (error: any) => error?.code === "CLAIM_FAILED" && /#99 task not found/.test(error.message),
  );
});

test("already-claimed-by-you still authorises work: no throw, exit stays clean", async () => {
  const { ctx, stdout } = refusalCtx([{
    taskNumber: 60, messageId: "msg-60", success: false,
    reason: TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU,
  }]);
  await taskClaimCommand.handler(ctx, undefined, { target: "#proj-task", number: ["60"] });
  assert.match(stdout.join(""), /#60: already claimed by you/);
});

test("a partial claim (one success, one conflict) does not throw", async () => {
  const { ctx, stdout } = refusalCtx([
    { taskNumber: 1, messageId: "msg-1", success: true },
    {
      taskNumber: 2, messageId: "msg-2", success: false, reason: "already assigned to @Kai",
      conflict: {
        kind: "claim_conflict", conflictScope: "implementation_execution",
        blockedActions: ["claim"], unblockedActionExamples: ["comment in thread"],
        currentAssignee: { type: "agent", name: "Kai" },
        taskStatus: "in_progress", claimedAt: null, observedAt: "2026-09-07T12:00:00.000Z",
      },
    },
  ]);
  await taskClaimCommand.handler(ctx, undefined, { target: "#proj-task", number: ["1", "2"] });
  assert.match(stdout.join(""), /1 claimed, 1 failed/);
});

// task #333: the proxy-5xx branch no longer carries its own copy of the
// "inspect daemon proxy transport logs" text; it takes the shared
// per-failure_class default, so an upstream_http_response envelope points at
// the server side (the daemon proxy discards the upstream body).
test("proxy 5xx with upstream_http_response yields PROXY_5XX with the server-side next action", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 503,
        error: "upstream HTTP response failed",
        errorCode: "agent_proxy_failed",
        data: null,
        proxy: {
          layer: "local_daemon_proxy",
          correlationId: "aaef4710a7b732e5",
          failureClass: "upstream_http_response",
          causeCode: "HTTP_503",
          routeFamily: "tasks",
          upstreamStatus: 503,
          responseStarted: true,
          responseComplete: true,
        },
      }),
    }) as any,
  });
  await assert.rejects(
    async () => taskClaimCommand.handler(ctx, undefined, { target: "#proj-task", number: ["57"] }),
    (error: any) => error?.code === "PROXY_5XX"
      && /discarded the upstream response body/.test(String(error.suggestedNextAction))
      && !/inspect daemon proxy transport logs/.test(String(error.suggestedNextAction)),
  );
});

test("a held claim is counted for the daemon's turn report while passive AX is on", async () => {
  await withPassiveAxContextForTest("ctx-A", async () => {
    const { io, stdout } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({
          ok: true,
          status: 200,
          error: null,
          data: { state: "held", newMessageCount: 1, seenUpToSeq: 17, heldMessages: [{ seq: 17, id: "m-17", senderName: "ana", content: "taking #7 myself" }] },
        }),
      }) as any,
    });
    await taskClaimCommand.handler(ctx, undefined, { target: "#engineering", number: ["7"] });
    const held = stdout.join("");
    assert.match(held, /Your task claim was not applied/);
    assert.deepEqual(readPassiveRenderCountsForTest("agent-1"), [
      { contextId: "ctx-A", kind: "freshness_hold", renders: 1, chars: Array.from(held).length, bytes: Buffer.byteLength(held, "utf8") },
    ]);
  });
});

test("task v2 server: claim --message-id surfaces task_v2_use_create with the server's commands verbatim", async () => {
  const { io, stdout } = memoryIo();
  const hint = [
    "`task claim --message-id` is not available on this server: tasks here have their own conversations and are claimed by number. Nothing was claimed.",
    "Message abcdef12 has 2 tasks — claim by number:",
    "  raft task claim --target \"#proj-task\" --number 4",
    "  raft task claim --target \"#proj-task\" --number 5",
  ].join("\n");
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false, status: 409, error: hint, errorCode: "task_v2_use_create", data: null,
      }),
    }) as any,
  });
  await assert.rejects(
    async () => taskClaimCommand.handler(ctx, undefined, { target: "#proj-task", messageId: ["abcdef12"] }),
    (error: any) => error?.code === "task_v2_use_create" && error.message === hint,
  );
  assert.deepEqual(stdout, []);
});

test("task claim over the task-write budget: RATE_LIMITED, retryable, the wait; under reviewer isolation too (the sentence holds only counts)", async () => {
  const body = {
    error: "This agent made too many task changes: the limit is 120 a minute. Retry in 5 seconds.",
    code: "RATE_LIMITED",
    details: { operation: "taskClaim", limit: 120, windowSeconds: 60, retryAfterSeconds: 5 },
  };
  for (const reviewerIsolation of [false, true]) {
    const { io } = memoryIo();
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (): Promise<ApiResponse<unknown>> => ({ ok: false, status: 429, error: body.error, errorCode: "RATE_LIMITED", data: null, errorBody: body }),
      }) as any,
    });
    await assert.rejects(
      async () => taskClaimCommand.handler(ctx, undefined, { target: "#engineering", number: ["7"], ...(reviewerIsolation ? { reviewerIsolation: true } : {}) }),
      (err: unknown) => {
        const e = err as { code?: string; message?: string; retryable?: boolean; suggestedNextAction?: string };
        assert.equal(e.code, "RATE_LIMITED");
        assert.equal(e.message, body.error);
        assert.equal(e.retryable, true);
        assert.equal(e.suggestedNextAction, "Wait 5 seconds, then run the same command again (the refused request changed nothing).");
        return true;
      },
    );
  }
});

test("task claim takes one task by its ref", async () => {
  const { io } = memoryIo();
  const requests: unknown[] = [];
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, _path: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push(body);
        return { ok: true, status: 200, error: null, data: { results: [{ taskNumber: 7, messageId: "msg-7", success: true }] } };
      },
    }) as any,
  });

  await taskClaimCommand.handler(ctx, "#engineering:#7", {});

  assert.deepEqual(requests, [{ channel: "#engineering", task_numbers: [7] }]);
  await assert.rejects(
    async () => { await taskClaimCommand.handler(ctx, "#engineering:#7", { messageId: ["abcd1234"] }); },
    (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG",
  );
  assert.equal(requests.length, 1);
});
