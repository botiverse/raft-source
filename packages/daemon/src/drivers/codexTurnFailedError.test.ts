/**
 * A failed Codex turn reports its real cause once. Codex sends the cause as a
 * final `error` notification and then ends the turn `failed`, usually with no
 * message of its own. Adding a fixed "Codex turn failed" on top made it the
 * last runtime error, so the `daemon.runtime.turn` span and the fingerprint
 * fence carried one constant fingerprint for every Codex failure (a 429, a
 * gateway 403 and a usage limit all looked the same; AndyLok,
 * #botiverse-raft-deployment msg=228ec5da).
 */
import assert from "node:assert/strict";
import { CodexEventNormalizer } from "./codexEventNormalizer";
import type { ParsedEvent } from "./types";

const THREAD = "01a1a271-8bdf-7060-a9f1-16b0144b3c9b";
const TURN = "01a1a271-8bea-77e0-aa1e-0438c35b88b7";

function normalize(normalizer: CodexEventNormalizer, message: unknown): ParsedEvent[] {
  return normalizer.normalizeMessage(message as never).events;
}

function started(): CodexEventNormalizer {
  const normalizer = new CodexEventNormalizer();
  normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD } } });
  normalize(normalizer, { method: "turn/started", params: { threadId: THREAD, turn: { id: TURN } } });
  return normalizer;
}

function errors(events: ParsedEvent[]): string[] {
  return events.flatMap((event) => event.kind === "error" ? [event.message] : []);
}

test("the real cause from the error notification is the turn's only error", () => {
  const normalizer = started();
  const events = [
    ...normalize(normalizer, { method: "error", params: { threadId: THREAD, error: { message: "exceeded retry limit, last status: 429 Too Many Requests" }, willRetry: false } }),
    ...normalize(normalizer, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed" } } }),
  ];
  assert.deepEqual(errors(events), ["exceeded retry limit, last status: 429 Too Many Requests"]);
  assert.ok(events.some((event) => event.kind === "turn_end"));
});

test("a failed turn with no earlier error still reports one, its own message or the fixed one", () => {
  const own = started();
  assert.deepEqual(errors(normalize(own, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed", error: { message: "model not allowed" } } } })), ["model not allowed"]);
  const bare = started();
  assert.deepEqual(errors(normalize(bare, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed" } } })), ["Codex turn failed"]);
});

test("a retried error does not count, and an earlier turn's error does not carry into the next", () => {
  const normalizer = started();
  normalize(normalizer, { method: "error", params: { threadId: THREAD, error: { message: "stream disconnected" }, willRetry: true } });
  assert.deepEqual(errors(normalize(normalizer, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed" } } })), ["Codex turn failed"]);

  const next = started();
  normalize(next, { method: "error", params: { threadId: THREAD, error: { message: "boom" }, willRetry: false } });
  normalize(next, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed" } } });
  normalize(next, { method: "turn/started", params: { threadId: THREAD, turn: { id: "turn-2" } } });
  assert.deepEqual(errors(normalize(next, { method: "turn/completed", params: { threadId: THREAD, turn: { id: "turn-2", status: "failed" } } })), ["Codex turn failed"]);
});

// AndyLok (Computer 1.22.0, legacy host): a custom provider's invalid model
// name failed three Codex turns whose spans all carried the fingerprint of
// "Codex thread entered system error state" (e2d8f35d79f756ff), while their
// `runtime.error` records carried the real cause: a reasonless systemError
// status came before the error notification, and the turn span ends at the
// turn's first runtime error.
test("a reasonless systemError during a turn waits for the turn's real cause, and stands in only when none came", () => {
  const systemError = { method: "thread/status/changed", params: { threadId: THREAD, status: { type: "systemError" } } };
  const realCause = "The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-chat-does-not-exist.";
  const before = started();
  const events = [
    ...normalize(before, systemError),
    ...normalize(before, { method: "error", params: { threadId: THREAD, error: { message: realCause }, willRetry: false } }),
    ...normalize(before, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed" } } }),
  ];
  assert.deepEqual(errors(events), [realCause]);
  assert.ok(events.some((event) => event.kind === "runtime_diagnostic" && event.itemType === "codex_thread_system_error_without_reason"), "the diagnostic is still reported");

  const after = started();
  normalize(after, { method: "error", params: { threadId: THREAD, error: { message: realCause }, willRetry: false } });
  assert.deepEqual(errors(normalize(after, systemError)), []);

  const alone = started();
  assert.deepEqual(errors(normalize(alone, systemError)), [], "held until the turn ends");
  assert.deepEqual(errors(normalize(alone, { method: "turn/completed", params: { threadId: THREAD, turn: { id: TURN, status: "failed" } } })), ["Codex thread entered system error state"]);

  // Outside a turn there is no turn end to wait for: reported at once, as before.
  const idle = new CodexEventNormalizer();
  normalize(idle, { method: "thread/started", params: { thread: { id: THREAD } } });
  assert.deepEqual(errors(normalize(idle, systemError)), ["Codex thread entered system error state"]);
});
