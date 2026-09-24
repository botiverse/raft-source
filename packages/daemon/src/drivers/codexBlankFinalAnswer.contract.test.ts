/**
 * task #816 — a blank Codex `final_answer` must never be delivered to the user
 * as if it were the answer.
 *
 * ## Where the fixture comes from
 *
 * Two sources, deliberately kept distinct because they answer different halves:
 *
 * 1. **What Codex actually produced.** Trace bundle `0cf75ab0`, published by
 *    @Tracey, `sha256(gz) =
 *    b4c15c198869b3126775465d42f1c199cf98c99b241ad5c584a1addfeab87fc5`
 *    (verified locally before use). 4,235 lines of Codex's own rollout JSONL.
 *    The final turn, records 4228 / 4231 / 4234, in order:
 *
 *        agent_message   phase=commentary    98 chars of real text
 *        agent_message   phase=final_answer  "\n\n"
 *        task_complete   turn_id=019febf4-3332-7440-9cc7-ee2d7e28708a
 *
 *    Across all 79 turns in that bundle, 78 ended on a blank `final_answer`;
 *    86 of 136 `agent_message` events were `final_answer` and 84 of those were
 *    blank. This shape is the norm for that agent/model, not a one-off.
 *
 * 2. **What the carrier actually receives.** The rollout is Codex's own file;
 *    the daemon never reads it. The daemon speaks the app-server JSON-RPC
 *    protocol (`codex app-server --listen stdio://`, see `codex.ts`). The wire
 *    shapes below were captured from a live `codex app-server` turn rather than
 *    guessed from the rollout: `item/started` (empty text, phase already set) →
 *    `item/agentMessage/delta` → `item/completed` → `turn/completed`.
 *
 * `task_complete.last_agent_message` is **not** part of that protocol — it does
 * not appear anywhere in the app-server JSON schema — and `turn/completed`
 * arrives with `items: []` / `itemsView: "notLoaded"` in practice, despite the
 * schema's `default: "full"`. So the carrier has no same-turn text to recover
 * from at turn end. That is why v1 makes the failure observable instead of
 * reconstructing the answer.
 *
 * ## Counting turns in this bundle, if you ever recount them
 *
 * Parsing first: split on `"\n"`, not `splitlines()` — the payloads contain
 * U+2028-class characters that `splitlines()` treats as line breaks, which
 * shreds single records into fragments. Expect 4,235 lines, of which 72 are
 * not valid JSON (a redaction defect, tracked separately); skip those.
 *
 * A *turn* is the run of records ending at each `event_msg` whose payload type
 * is `task_complete`. There are 79. For each turn:
 *
 *   final       the LAST `event_msg`/`agent_message` whose `phase` is
 *               `"final_answer"`. Blank if absent, or if `message` is empty or
 *               whitespace-only.
 *   lam         `task_complete.last_agent_message`. Blank on the same rule.
 *   commentary  present if ANY `event_msg`/`agent_message` in the turn has
 *               `phase == "commentary"` and a non-whitespace `message`.
 *
 * The counts quoted above as 21/13/44/1 are, in that order:
 *
 *   21   final blank, lam non-blank, commentary present
 *   13   final blank, lam blank,     commentary present
 *   44   final blank, lam blank,     no commentary      ← the silent turns
 *    1   final non-blank
 *
 * The trap: this bundle starts mid-session, so it has no opening boundary.
 * Its first `task_complete` is on line 110 and its first `task_started` is on
 * line 111 — the close precedes the open. Three `agent_message` records sit
 * ahead of that first `task_started`: lines 3 and 78 (commentary, 63 and 165
 * characters) and line 107 (`final_answer`, blank).
 *
 * To reproduce the wrong answer exactly: open a turn on `task_started`, close
 * it on `task_complete`, **and discard any `agent_message` seen while no turn
 * is open**. Those three records are then lost, one turn moves from the
 * commentary-present bucket to the silent bucket, and you get 21/12/45/1.
 *
 * Note that anchoring on `task_started` is not by itself enough to reproduce
 * it — if you retain out-of-window records and attach them to a turn, you
 * still get 21/13/44/1. The discard is the defect; the anchor only creates the
 * window in which records go homeless.
 *
 * There is no trailing fragment to decide about: the file's last record, on
 * line 4235, is the final `task_complete`, so no turn is left open at the end.
 * Only the head is ragged.
 *
 * Either way nothing errors and the four buckets still sum to 79, which is why
 * this was reported wrong in the first place.
 *
 * ## Content substitution, stated plainly
 *
 * The commentary body in the specimen is real text from another user's session.
 * The event *sequence* is reproduced exactly — order, phases, blankness, the
 * `"\n\n"` payload byte-for-byte, and the 98-character length — but the
 * commentary's characters are replaced with a synthetic string of the same
 * length. Nothing this test asserts depends on those characters; it turns only
 * on blank vs non-blank.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import { CodexEventNormalizer } from "./codexEventNormalizer.js";
import type { ParsedEvent } from "./types.js";

const THREAD_ID = "019febf4-0000-7000-8000-000000000000";
const TURN_ID = "019febf4-3332-7440-9cc7-ee2d7e28708a";

/** Same length (98) as the specimen's commentary; characters are synthetic. */
const COMMENTARY_TEXT = "C".repeat(98);
/** Byte-for-byte the specimen's `final_answer` payload. */
const BLANK_FINAL_ANSWER = "\n\n";

function normalize(normalizer: CodexEventNormalizer, message: unknown): ParsedEvent[] {
  return normalizer.normalizeMessage(message as never).events;
}

function agentMessageStarted(itemId: string, phase: string | null): unknown {
  return {
    method: "item/started",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: "agentMessage", id: itemId, text: "", phase, memoryCitation: null },
    },
  };
}

function agentMessageDelta(itemId: string, delta: string): unknown {
  return {
    method: "item/agentMessage/delta",
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId, delta },
  };
}

function agentMessageCompleted(itemId: string, phase: string | null, text: string): unknown {
  return {
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: "agentMessage", id: itemId, text, phase, memoryCitation: null },
    },
  };
}

function turnStarted(turnId = TURN_ID): unknown {
  return { method: "turn/started", params: { threadId: THREAD_ID, turn: { id: turnId } } };
}

/** Shape observed live: `items` empty, `itemsView` not loaded. */
function turnCompleted(turnId = TURN_ID): unknown {
  return {
    method: "turn/completed",
    params: {
      threadId: THREAD_ID,
      turn: { id: turnId, items: [], itemsView: "notLoaded", status: "completed", error: null },
    },
  };
}

function userVisibleText(events: ParsedEvent[]): string {
  return events
    .filter((e): e is Extract<ParsedEvent, { kind: "text" }> => e.kind === "text")
    .map((e) => e.text)
    .join("");
}

function blankFinalAnswerDiagnostics(events: ParsedEvent[]) {
  return events.filter(
    (e) => e.kind === "runtime_diagnostic" && e.itemType === "codex_blank_final_answer",
  );
}

/** Replays the specimen's final turn and returns every event the carrier emitted. */
function replaySpecimenFinalTurn(opts: { streamDeltas: boolean } = { streamDeltas: true }): ParsedEvent[] {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  const push = (message: unknown) => events.push(...normalize(normalizer, message));

  push({ method: "thread/started", params: { thread: { id: THREAD_ID } } });
  push(turnStarted());

  push(agentMessageStarted("msg-commentary", "commentary"));
  if (opts.streamDeltas) push(agentMessageDelta("msg-commentary", COMMENTARY_TEXT));
  push(agentMessageCompleted("msg-commentary", "commentary", COMMENTARY_TEXT));

  push(agentMessageStarted("msg-final", "final_answer"));
  if (opts.streamDeltas) push(agentMessageDelta("msg-final", BLANK_FINAL_ANSWER));
  push(agentMessageCompleted("msg-final", "final_answer", BLANK_FINAL_ANSWER));

  push(turnCompleted());
  return events;
}

// ── The defect itself ────────────────────────────────────────────────────────

test("#816 specimen: a blank final_answer is not delivered as user-visible text", () => {
  const events = replaySpecimenFinalTurn();
  assert.equal(
    userVisibleText(events),
    "",
    "the specimen's turn produced only a whitespace-only final_answer; delivering it "
      + "hands the user a blank message",
  );
});

test("#816 specimen: the blank terminator is reported as a typed observable fact", () => {
  const events = replaySpecimenFinalTurn();
  assert.equal(
    blankFinalAnswerDiagnostics(events).length,
    1,
    "a turn that produced real assistant text but delivered nothing must say so",
  );
});

test("#816 specimen: the blank final_answer is suppressed on the non-streamed path too", () => {
  // Codex may complete an agentMessage without ever sending a delta. The guard
  // has to live on both paths, otherwise the fix depends on how the provider
  // chose to chunk the answer.
  const events = replaySpecimenFinalTurn({ streamDeltas: false });
  assert.equal(userVisibleText(events), "");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 1);
});

// ── The blank predicate has two branches; each gets its own tooth ────────────

test("#816 blank predicate: whitespace-only text counts as blank", () => {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "commentary")));
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "commentary", COMMENTARY_TEXT)));
  events.push(...normalize(normalizer, agentMessageStarted("m2", "final_answer")));
  events.push(...normalize(normalizer, agentMessageCompleted("m2", "final_answer", "   \t  \n ")));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 1);
});

test("#816 blank predicate: a missing text field counts as blank", () => {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "commentary")));
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "commentary", COMMENTARY_TEXT)));
  events.push(...normalize(normalizer, {
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: "agentMessage", id: "m2", phase: "final_answer", memoryCitation: null },
    },
  }));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 1);
});

// ── What must NOT change ────────────────────────────────────────────────────

test("#816 healthy turn: a non-blank final_answer is delivered unchanged and silently", () => {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "final_answer")));
  events.push(...normalize(normalizer, agentMessageDelta("m1", "pong")));
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "final_answer", "pong")));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "pong");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 0);
});

test("#816 healthy turn: interior whitespace inside a real answer survives verbatim", () => {
  // The guard keys on the message, not on individual deltas. A delta that
  // happens to be whitespace is ordinary text once the answer has begun, and
  // dropping it would silently corrupt every streamed reply.
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "final_answer")));
  for (const delta of ["Hello", " ", "\n\n", "world"]) {
    events.push(...normalize(normalizer, agentMessageDelta("m1", delta)));
  }
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "final_answer", "Hello \n\nworld")));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "Hello \n\nworld");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 0);
});

test("#816 healthy turn: an answer that opens with whitespace keeps it verbatim", () => {
  // Leading whitespace is held back only until the answer proves it is real,
  // then released unchanged. Dropping it instead would silently reflow every
  // reply that starts with an indent or a blank line — a code block, say.
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "final_answer")));
  for (const delta of ["\n", "  ", "Hi"]) {
    events.push(...normalize(normalizer, agentMessageDelta("m1", delta)));
  }
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "final_answer", "\n  Hi")));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "\n  Hi");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 0);
});

test("#816 an interrupted turn does not leak into the next one", () => {
  // A turn does not always reach turn/completed — interrupts and reconnects
  // cut it short. The next turn/started must still begin from a clean slate,
  // or a turn that said nothing inherits the previous turn's evidence.
  const normalizer = new CodexEventNormalizer();
  const second: ParsedEvent[] = [];

  normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } });
  normalize(normalizer, turnStarted("turn-1"));
  normalize(normalizer, agentMessageStarted("a1", "commentary"));
  normalize(normalizer, agentMessageCompleted("a1", "commentary", COMMENTARY_TEXT));
  // No turn/completed for turn-1: it was cut off.

  second.push(...normalize(normalizer, turnStarted("turn-2")));
  second.push(...normalize(normalizer, agentMessageStarted("b1", "final_answer")));
  second.push(...normalize(normalizer, agentMessageCompleted("b1", "final_answer", BLANK_FINAL_ANSWER)));
  second.push(...normalize(normalizer, turnCompleted("turn-2")));

  assert.equal(
    blankFinalAnswerDiagnostics(second).length,
    0,
    "turn 2 produced nothing of its own; turn 1's abandoned commentary is not its evidence",
  );
});

test("#816 legitimately silent turn: no text and no commentary stays silent", () => {
  // 44 of the specimen's 79 turns are this shape: the agent worked through
  // tools and said nothing. Those turns are correct as they stand, and a fix
  // that starts narrating them is a regression, not a fix.
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, {
    method: "item/started",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: "commandExecution", id: "cmd1", command: "ls" },
    },
  }));
  events.push(...normalize(normalizer, {
    method: "item/completed",
    params: {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      item: { type: "commandExecution", id: "cmd1", command: "ls" },
    },
  }));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "final_answer")));
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "final_answer", BLANK_FINAL_ANSWER)));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "");
  assert.equal(
    blankFinalAnswerDiagnostics(events).length,
    0,
    "nothing was lost here, so there is nothing to report",
  );
});

test("#816 does not collide with the existing zero-evidence turn diagnostic", () => {
  // `codex_zero_evidence_turn_completed` already covers turns with no runtime
  // activity whatsoever, and it escalates to a terminal `error`. The #816 case
  // is the opposite shape — the turn was busy, it just delivered nothing — so
  // the two must stay disjoint. If this one started raising `error`, a blank
  // answer would kill the agent instead of informing the user.
  const events = replaySpecimenFinalTurn();

  assert.equal(
    events.filter((e) => e.kind === "runtime_diagnostic" && e.itemType === "codex_zero_evidence_turn_completed").length,
    0,
    "the specimen turn produced plenty of activity; it is not a zero-evidence turn",
  );
  assert.equal(
    events.filter((e) => e.kind === "error").length,
    0,
    "a blank answer is reportable, not terminal",
  );
});

test("#816 a genuinely zero-evidence turn keeps its own diagnostic and does not gain this one", () => {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(
    events.filter((e) => e.kind === "runtime_diagnostic" && e.itemType === "codex_zero_evidence_turn_completed").length,
    1,
  );
  assert.equal(blankFinalAnswerDiagnostics(events).length, 0);
});

test("#816 unknown phase is not treated as commentary", () => {
  // The app-server schema is explicit: "Providers do not emit this
  // consistently, so callers must treat `None` as phase unknown." A missing
  // phase must keep its legacy user-visible behaviour.
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", null)));
  events.push(...normalize(normalizer, agentMessageDelta("m1", "legacy answer")));
  events.push(...normalize(normalizer, agentMessageCompleted("m1", null, "legacy answer")));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "legacy answer");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 0);
});

// ── Turn boundaries ─────────────────────────────────────────────────────────

test("#816 no cross-turn contamination: an earlier turn's text cannot rescue a later one", () => {
  const normalizer = new CodexEventNormalizer();
  const first: ParsedEvent[] = [];
  const second: ParsedEvent[] = [];

  normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } });
  first.push(...normalize(normalizer, turnStarted("turn-1")));
  first.push(...normalize(normalizer, agentMessageStarted("a1", "commentary")));
  first.push(...normalize(normalizer, agentMessageCompleted("a1", "commentary", COMMENTARY_TEXT)));
  first.push(...normalize(normalizer, agentMessageStarted("a2", "final_answer")));
  first.push(...normalize(normalizer, agentMessageCompleted("a2", "final_answer", BLANK_FINAL_ANSWER)));
  first.push(...normalize(normalizer, turnCompleted("turn-1")));

  // Second turn says nothing at all. It must be judged on its own evidence.
  second.push(...normalize(normalizer, turnStarted("turn-2")));
  second.push(...normalize(normalizer, agentMessageStarted("b1", "final_answer")));
  second.push(...normalize(normalizer, agentMessageCompleted("b1", "final_answer", BLANK_FINAL_ANSWER)));
  second.push(...normalize(normalizer, turnCompleted("turn-2")));

  assert.equal(blankFinalAnswerDiagnostics(first).length, 1);
  assert.equal(
    blankFinalAnswerDiagnostics(second).length,
    0,
    "turn 2 lost nothing; turn 1's commentary must not leak across the boundary",
  );
  assert.equal(userVisibleText(second), "");
});

test("#816 exactly once: one blank turn reports one diagnostic, not one per message", () => {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  for (const [index, text] of [COMMENTARY_TEXT, COMMENTARY_TEXT, COMMENTARY_TEXT].entries()) {
    events.push(...normalize(normalizer, agentMessageStarted(`c${index}`, "commentary")));
    events.push(...normalize(normalizer, agentMessageCompleted(`c${index}`, "commentary", text)));
  }
  for (const [index] of [0, 1].entries()) {
    events.push(...normalize(normalizer, agentMessageStarted(`f${index}`, "final_answer")));
    events.push(...normalize(normalizer, agentMessageCompleted(`f${index}`, "final_answer", BLANK_FINAL_ANSWER)));
  }
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(userVisibleText(events), "");
  assert.equal(blankFinalAnswerDiagnostics(events).length, 1);
});

test("#816 exactly once: a repeated turn/completed does not re-report", () => {
  const normalizer = new CodexEventNormalizer();
  const events: ParsedEvent[] = [];
  events.push(...normalize(normalizer, { method: "thread/started", params: { thread: { id: THREAD_ID } } }));
  events.push(...normalize(normalizer, turnStarted()));
  events.push(...normalize(normalizer, agentMessageStarted("m1", "commentary")));
  events.push(...normalize(normalizer, agentMessageCompleted("m1", "commentary", COMMENTARY_TEXT)));
  events.push(...normalize(normalizer, agentMessageStarted("m2", "final_answer")));
  events.push(...normalize(normalizer, agentMessageCompleted("m2", "final_answer", BLANK_FINAL_ANSWER)));
  events.push(...normalize(normalizer, turnCompleted()));
  events.push(...normalize(normalizer, turnCompleted()));

  assert.equal(blankFinalAnswerDiagnostics(events).length, 1);
});
