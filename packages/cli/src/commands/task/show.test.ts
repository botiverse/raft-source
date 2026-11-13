import assert from "node:assert/strict";

import type { ApiResponse } from "../../client";
import type { AgentContext } from "../../auth/env";
import { createCommandContext } from "../../core/context";
import { CliError } from "../../core/errors";
import type { CliIo } from "../../core/io";
import { taskShowCommand } from "./show";

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

function ctxReturningBody(body: Record<string, unknown>, requests: Array<{ method: string; path: string }> = []) {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return { ok: true, status: 200, error: null, data: body };
      },
    }) as any,
  });
  return { ctx, stdout, requests };
}

function ctxReturning(tasks: unknown[], requests: Array<{ method: string; path: string }> = []) {
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path });
        return { ok: true, status: 200, error: null, data: { tasks } };
      },
    }) as any,
  });
  return { ctx, stdout, requests };
}

test("task show renders the delivery surface's labels verbatim", async () => {
  const { ctx, stdout } = ctxReturning([
    { taskNumber: 7, status: "in_review", title: "A title", description: "A description" },
  ]);
  await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" });
  const out = stdout.join("");
  // Copied from the agent delivery surface; two renderings of one field that disagree is the
  // defect task #323 exists to fix.
  assert.match(out, /^Current title: A title$/m);
  assert.match(out, /^Current description: A description$/m);
});

test("task show asks for status=all, or finished tasks become invisible", async () => {
  const requests: Array<{ method: string; path: string }> = [];
  const { ctx } = ctxReturning([{ taskNumber: 7, status: "done", title: "t", description: "d" }], requests);
  await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" });
  // Without status=all the board omits done/closed work and `show` would report a real task as
  // missing — an absence manufactured by the query.
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.path, /status=all/);
});

// @Huaihuai (PR #8048 review): an empty channel is a SUCCESSFUL read. The previous version called it a
// broken read, which is false for every channel that genuinely has no tasks. The server can also
// return [] for a swallowed read error (task #327), so the message must name both and claim neither.
test("an EMPTY list is ambiguous: neither 'read failed' nor 'does not exist'", async () => {
  const { ctx } = ctxReturning([]);
  await assert.rejects(
    async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
    (error: unknown) => {
      if (!(error instanceof CliError)) return false;
      assert.equal(error.code, "NOT_FOUND");
      assert.doesNotMatch(error.message, /read itself did not work/);
      assert.match(error.message, /no tasks/);
      assert.match(error.message, /did not assert the list is complete/);
      assert.match(error.message, /failed to read/);
      assert.match(error.message, /not evidence that task #7 does not exist/);
      return true;
    },
  );
});

test("a NON-empty list with no match is NOT_FOUND and states the denominator", async () => {
  const { ctx } = ctxReturning([
    { taskNumber: 1, status: "todo", title: "x", description: null },
    { taskNumber: 2, status: "todo", title: "y", description: null },
  ]);
  await assert.rejects(
    async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
    (error: unknown) =>
      error instanceof CliError
      && error.code === "NOT_FOUND"
      && /searched 2 task\(s\), status=all/.test(error.message),
  );
});

test("a count is not a denominator unless the server asserted the list was complete", async () => {
  // The route that serves `scope:"channel"` sends no `pagination` block, and the contract marks
  // it `.optional()` — so the completeness assertion is ABSENT, which is not "complete".
  const { ctx } = ctxReturningBody({ tasks: [{ taskNumber: 1, status: "todo", title: "x" }], scope: "channel" });
  await assert.rejects(
    async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
    (error: unknown) =>
      error instanceof CliError
      && error.code === "NOT_FOUND"
      && /does NOT assert completeness/.test(error.message)
      // The claim must be downgraded, not merely annotated: absence from a possibly-partial
      // list cannot be reported as non-existence.
      && /absent from what was returned/.test(error.message)
      && !/server asserts this list is complete/.test(error.message),
  );
});

test("the completeness clause tracks the response, so it cannot become a fixed decoration", async () => {
  const { ctx } = ctxReturningBody({
    tasks: [{ taskNumber: 1, status: "todo", title: "x" }],
    scope: "channel",
    pagination: { mode: "complete", truncated: false },
  });
  await assert.rejects(
    async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
    (error: unknown) =>
      error instanceof CliError
      && error.code === "NOT_FOUND"
      && /server asserts this list is complete/.test(error.message)
      && !/does NOT assert completeness/.test(error.message),
  );
});

// @Huaihuai (PR #8048 review): an EMPTY list WITH the completeness assertion follows the assertion —
// the server has stated the board is whole and empty — rather than the "can't tell" message.
test("an EMPTY list with the completeness assertion is a definite not-found", async () => {
  const { ctx } = ctxReturningBody({ tasks: [], scope: "channel", pagination: { mode: "complete", truncated: false } });
  await assert.rejects(
    async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
    (error: unknown) => {
      if (!(error instanceof CliError)) return false;
      assert.equal(error.code, "NOT_FOUND");
      assert.match(error.message, /server asserts this list is complete/);
      assert.doesNotMatch(error.message, /cannot tell/);
      return true;
    },
  );
});

test("a different or incomplete scope cannot prove a task absent from this channel", async () => {
  for (const body of [
    { tasks: [], scope: "mine", pagination: { mode: "complete", truncated: false } },
    { tasks: [], scope: "channel", pagination: { mode: "complete", truncated: false }, coverage: { status: "incomplete", visibleChannelTypes: ["channel"], includesArchived: true, inaccessibleScope: "not_asserted", reason: "scope omitted" } },
  ]) {
    const { ctx } = ctxReturningBody(body);
    await assert.rejects(
      async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
      (error: unknown) => error instanceof CliError && error.code === "NOT_FOUND"
        && /did not assert the list is complete/.test(error.message)
        && !/server asserts this list is complete/.test(error.message),
    );
  }
});

test("a truncated:true body never reaches the completeness branch — the contract rejects it first", async () => {
  // Measured, not assumed: `truncated` is `z.literal(false)`, so a `true` fails shared-contract
  // parsing and surfaces as INVALID_JSON_RESPONSE — it is never seen as either branch here. This
  // test pins WHERE the fail-closed happens; if the literal is ever widened to z.boolean(), this
  // test flips to NOT_FOUND and forces the `asserted` check above to be re-read.
  const { ctx } = ctxReturningBody({
    tasks: [{ taskNumber: 1, status: "todo", title: "x" }],
    pagination: { mode: "complete", truncated: true },
  });
  await assert.rejects(
    async () => { await taskShowCommand.handler(ctx, { target: "#proj-daemon", number: "7" }); },
    (error: unknown) =>
      error instanceof CliError
      && error.code === "INVALID_JSON_RESPONSE"
      && !/not found/.test(error.message),
  );
});

test("description null and description absent are DIFFERENT states, neither rendered as blank", async () => {
  const explicitNull = ctxReturning([{ taskNumber: 7, status: "todo", title: "t", description: null }]);
  await taskShowCommand.handler(explicitNull.ctx, { target: "#proj-daemon", number: "7" });
  assert.match(explicitNull.stdout.join(""), /^Current description: \(none set\)$/m);

  const omitted = ctxReturning([{ taskNumber: 7, status: "todo", title: "t" }]);
  await taskShowCommand.handler(omitted.ctx, { target: "#proj-daemon", number: "7" });
  // "the field was null" and "the surface did not return the field" must not collapse into one
  // silent blank — that is the third state this card is about.
  assert.match(omitted.stdout.join(""), /^Current description: \(not returned by this surface\)$/m);
});
