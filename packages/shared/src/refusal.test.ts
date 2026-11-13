// The refusal envelope as clients read it (refusal.ts) and as the shared ops
// turn it into a RaftOpError (agentOps/outcome.ts): legacy body shapes, the
// sentence rules, a structured `next` per hint style, and retryAfterSeconds.
import assert from "node:assert/strict";

import type { AgentApiClientError } from "./agentApiClient";
import { failureOutcome, opErrorFromClientError, restyleDefaultNextAction } from "./agentOps/outcome";
import { readRefusal, refusalSentenceProblem } from "./refusal";

const MOVE_HINT = { cli: ["artifact", "move", "pt_abc", "--to", "server"], op: { name: "artifacts.move", args: { artifact: "pt_abc", to: "server" } } };

function httpError(status: number, body: Record<string, unknown>): AgentApiClientError {
  return {
    kind: "http",
    reason: "http_error",
    message: typeof body.error === "string" ? body.error : `HTTP ${status}`,
    status,
    errorCode: typeof body.code === "string" ? body.code : null,
    suggestedNextAction: typeof body.suggestedNextAction === "string" ? body.suggestedNextAction : null,
    response: body,
  };
}

test("readRefusal(): the envelope as sent", () => {
  assert.deepEqual(readRefusal({ error: "Pull the newer version first.", code: "BASE_MOVED", errorCode: "BASE_MOVED", retryAfterSeconds: 3, next: MOVE_HINT, suggestedNextAction: "raft artifact move pt_abc --to server", details: { current: 13 } }), {
    error: "Pull the newer version first.",
    code: "BASE_MOVED",
    retryAfterSeconds: 3,
    next: MOVE_HINT,
    suggestedNextAction: "raft artifact move pt_abc --to server",
    details: { current: 13 },
  });
});

test("readRefusal(): the shapes the Server wrote before the envelope", () => {
  assert.deepEqual(readRefusal({ error: "x y", errorCode: "AMBIGUOUS_ID" }), { error: "x y", code: "AMBIGUOUS_ID" });
  assert.deepEqual(readRefusal({ code: "QUOTA", message: "Upload quota used up.", retryable: true, retryAfterMs: 1500 }), { error: "Upload quota used up.", code: "QUOTA", retryAfterSeconds: 2 });
  // RATE_LIMITED's `details.retryAfterSeconds` is that body's own (agentApiRateLimit.ts parses it), not a generic wait.
  assert.equal(readRefusal({ error: "slow", code: "RATE_LIMITED", details: { retryAfterSeconds: 12 } }).retryAfterSeconds, undefined);
  assert.equal(readRefusal({ error: "slow", retry_after_seconds: 4 }).retryAfterSeconds, 4);
  assert.equal(readRefusal({ error: "slow", retry_after: 5 }).retryAfterSeconds, 5);
  assert.equal(readRefusal({ error: "x y", suggested_next_action: " Ask an admin. " }).suggestedNextAction, "Ask an admin.");
  assert.equal(readRefusal({ ok: false, code: "knowledge_not_found", next_action: "Search instead." }).suggestedNextAction, "Search instead.");
  assert.equal(readRefusal({ error: { code: "approval_expired" } }).code, "approval_expired");
});

test("readRefusal(): what isn't well formed is left out", () => {
  assert.deepEqual(readRefusal(null), {});
  assert.deepEqual(readRefusal("Not found"), {});
  assert.equal(readRefusal({ error: "x y", code: "has spaces" }).code, undefined);
  assert.equal(readRefusal({ error: "x y", retryAfterSeconds: -1 }).retryAfterSeconds, undefined);
  assert.equal(readRefusal({ error: "x y", retryAfterSeconds: 0 }).retryAfterSeconds, undefined, "a wait is more than zero");
  assert.equal(readRefusal({ error: "x y", next: { cli: "raft x" } }).next, undefined);
  assert.equal(readRefusal({ error: "x y", next: { cli: [] } }).next, undefined, "a step with no words would render as a bare `raft`");
  assert.equal(readRefusal({ error: "x y", next: { cli: ["x"], op: { name: 1, args: {} } } }).next, undefined);
});

test("refusalSentenceProblem(): one line, a sentence, at most 500 characters, no command", () => {
  assert.equal(refusalSentenceProblem("No agent by that name on this server. Check the name."), null);
  assert.match(refusalSentenceProblem("Unauthorized") ?? "", /single word/);
  assert.match(refusalSentenceProblem("") ?? "", /empty/);
  assert.match(refusalSentenceProblem("a\nb c") ?? "", /more than one line/);
  assert.match(refusalSentenceProblem("x ".repeat(251)) ?? "", /longer than 500/);
  assert.match(refusalSentenceProblem("Add --title to name it.") ?? "", /command or a flag/);
  assert.match(refusalSentenceProblem("Run raft artifact pull first.") ?? "", /command or a flag/);
});

test("a refusal's structured next: the CLI command, the tool call in tool style, and the operation in next", () => {
  const error = opErrorFromClientError(httpError(409, { error: "Someone pushed a newer version. Pull it and push again.", code: "BASE_MOVED", next: MOVE_HINT, suggestedNextAction: "an older step" }));
  assert.equal(error.message, "Someone pushed a newer version. Pull it and push again.");
  assert.equal(error.nextAction, "raft artifact move pt_abc --to server");
  assert.deepEqual(error.nextHint, MOVE_HINT);

  const failure = failureOutcome(error);
  assert.deepEqual(failure.next?.operation, MOVE_HINT.op);
  const tool = restyleDefaultNextAction(failure, "tool");
  assert.equal(tool.error.nextAction, 'artifacts_move({ artifact: "pt_abc", to: "server" })');
  assert.equal(tool.next?.why, tool.error.nextAction);
  assert.match(tool.text, /Next action: artifacts_move\(/);
});

test("an operation that writes its own step over the Server's hint: the hint no longer drives next.operation or the tool style", () => {
  const server = opErrorFromClientError(httpError(409, { error: "Someone pushed a newer version. Pull it and push again.", code: "BASE_MOVED", next: MOVE_HINT }));
  const own = { ...server, nextAction: "Pull the current version into a new folder, merge your change there, and push from it." };
  const failure = failureOutcome(own);
  assert.equal(failure.next?.operation, undefined);
  const tool = restyleDefaultNextAction(failure, "tool");
  assert.equal(tool.error.nextAction, own.nextAction);
});

test("retryAfterSeconds makes any refusal retryable after the wait, whatever its code", () => {
  const error = opErrorFromClientError(httpError(423, { error: "The card is being updated right now. Try again shortly.", code: "LOCK_TIMEOUT", retryAfterSeconds: 2 }));
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterSeconds, 2);
  assert.equal(error.nextAction, "Wait 2 seconds, then make the same request again.");

  const stepped = opErrorFromClientError(httpError(423, { error: "The card is being updated right now. Try again shortly.", code: "LOCK_TIMEOUT", retryAfterSeconds: 1, suggestedNextAction: "Reload the card first." }));
  assert.equal(stepped.nextAction, "Reload the card first.");
  assert.equal(stepped.retryable, true);

  const plain = opErrorFromClientError(httpError(400, { error: "The title can't be blank. Give it a title.", code: "TITLE_REQUIRED" }));
  assert.equal(plain.retryable, false);
  assert.equal(plain.retryAfterSeconds, undefined);
  assert.equal(plain.nextHint, undefined);
});
