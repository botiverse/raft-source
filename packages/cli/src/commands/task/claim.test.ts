import assert from "node:assert/strict";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU } from "@botiverse/raft-shared";
import { CliExit } from "../../core/errors.js";
import { taskClaimCommand } from "./claim.js";

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

  await taskClaimCommand.handler(ctx, { target: "#engineering", number: ["87", "93", "100"] });

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

  await taskClaimCommand.handler(ctx, { target: "#engineering", number: ["7"] });

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
    return taskClaimCommand.handler(ctx, {
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
    async () => taskClaimCommand.handler(ctx, { target: "#proj-task", number: ["57"] }),
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
    async () => taskClaimCommand.handler(ctx, { target: "#proj-task", number: ["99"] }),
    (error: any) => error?.code === "CLAIM_FAILED" && /#99 task not found/.test(error.message),
  );
});

test("already-claimed-by-you still authorises work: no throw, exit stays clean", async () => {
  const { ctx, stdout } = refusalCtx([{
    taskNumber: 60, messageId: "msg-60", success: false,
    reason: TASK_CLAIM_REASON_ALREADY_CLAIMED_BY_YOU,
  }]);
  await taskClaimCommand.handler(ctx, { target: "#proj-task", number: ["60"] });
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
  await taskClaimCommand.handler(ctx, { target: "#proj-task", number: ["1", "2"] });
  assert.match(stdout.join(""), /1 claimed, 1 failed/);
});
