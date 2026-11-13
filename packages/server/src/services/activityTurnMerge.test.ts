import assert from "node:assert/strict";

import { EMPTY_WAKE_CONTINUATION_MS, type ActivityTurnSummary } from "@botiverse/raft-shared";
import { absorbEmptyWake, pageTurnSummaries } from "./activityTurnMerge";

type Turn = ActivityTurnSummary & { id: string };

const wakeTrigger = { target: "#proj:abc", channelId: "c1", sender: "tenny", messageId: "m1" };

function turn(id: string, startedAt: number, endedAt: number, overrides: Partial<Turn> = {}): Turn {
  return {
    v: 1, id, startedAt, endedAt, outcome: "completed",
    actions: [], toolCalls: 0, problems: [], problemCount: 0, messagesSent: 0,
    ...overrides,
  };
}

/** The Remy sequence: a wake at 100 that closes a second later empty, then the work with no trigger. */
const emptyWake = turn("wake", 100_000, 101_000, { trigger: wakeTrigger });
const work = turn("work", 101_500, 160_000, {
  outcome: "unknown",
  actions: [{ kind: "run_command", count: 2 }, { kind: "send_message", count: 1 }],
  toolCalls: 3,
  messagesSent: 1,
  lastReplyMessageId: "reply-1",
  problems: [{ kind: "run_command", reason: "call_failed", at: 150_000 }],
  problemCount: 1,
});

test("task #17: an empty completed wake and the no-trigger turn after it read as one turn with the trigger and the work", () => {
  const older = turn("older", 10_000, 20_000, { trigger: { target: "dm:@richard" } });
  const { summaries, consumed } = pageTurnSummaries([work, emptyWake, older], 30);
  assert.equal(consumed, 3);
  assert.deepEqual(summaries, [
    { ...work, id: "wake", startedAt: 100_000, trigger: wakeTrigger },
    older,
  ]);
});

test("task #17: no merge when the following turn has its own trigger", () => {
  const nextWake = { ...work, trigger: { target: "#other", channelId: "c2" } };
  const { summaries } = pageTurnSummaries([nextWake, emptyWake], 30);
  assert.deepEqual(summaries, [nextWake, emptyWake]);
});

test("task #17: no merge when the empty turn did not complete, or did something", () => {
  for (const notEmpty of [
    { ...emptyWake, outcome: "unknown" as const },
    { ...emptyWake, outcome: "interrupted" as const },
    { ...emptyWake, toolCalls: 1 },
    { ...emptyWake, messagesSent: 1 },
    { ...emptyWake, problemCount: 1 },
    { ...emptyWake, trigger: undefined },
  ]) {
    const { summaries } = pageTurnSummaries([work, notEmpty], 30);
    assert.deepEqual(summaries, [work, notEmpty]);
  }
});

test("task #17: an empty wake with nothing after it stays as it is", () => {
  assert.deepEqual(pageTurnSummaries([emptyWake], 30), { summaries: [emptyWake], consumed: 1 });
});

test("task #17: a pair across the page's end is merged on that page, and the next page starts after it", () => {
  const newest = turn("newest", 200_000, 210_000, { trigger: { target: "#a" } });
  const oldest = turn("oldest", 1_000, 2_000, { trigger: { target: "#b" } });
  // The work is the page's last row and its wake the first row past the page.
  const rows = [newest, work, emptyWake, oldest];
  const first = pageTurnSummaries(rows, 2);
  assert.deepEqual(first.summaries.map((summary) => [summary.id, summary.startedAt, summary.toolCalls]), [
    ["newest", 200_000, 0],
    ["wake", 100_000, 3],
  ]);
  // The page used three rows: the next one starts at `oldest`, so the wake is never listed alone.
  assert.equal(first.consumed, 3);
  assert.deepEqual(pageTurnSummaries(rows.slice(first.consumed), 2), { summaries: [oldest], consumed: 1 });
});

test("task #17: work going on after an empty wake takes over the wake's trigger, start and id; a new wake does not", () => {
  const { outcome, ...soFar } = work;
  assert.equal(outcome, "unknown");
  const running = { ...soFar, endedAt: 170_000, running: true as const };
  const older = turn("older", 10_000, 20_000);

  const continued = absorbEmptyWake([emptyWake, older], { turn: running, continuesPreviousTurn: true });
  assert.deepEqual(continued.summaries, [older]);
  assert.deepEqual(continued.current, { ...running, id: "wake", startedAt: 100_000, trigger: wakeTrigger });

  // A turn that started with a message handed over is a wake of its own.
  const woken = absorbEmptyWake([emptyWake, older], { turn: running, continuesPreviousTurn: false });
  assert.deepEqual(woken.summaries, [emptyWake, older]);
  assert.deepEqual(woken.current, running);

  // Nothing running: the list as it is.
  assert.deepEqual(absorbEmptyWake([emptyWake], null), { summaries: [emptyWake], current: null });
});

test("task #17: an empty wake and a no-trigger turn far apart are two turns, listed or running", () => {
  // A message read and left unanswered at 100 s, and a background follow-up five hours later.
  const later = { ...work, startedAt: emptyWake.endedAt + 5 * 3_600_000, endedAt: emptyWake.endedAt + 5 * 3_600_000 + 60_000 };
  assert.deepEqual(pageTurnSummaries([later, emptyWake], 30).summaries, [later, emptyWake]);
  // Just past the bound is already too far; at the bound it still continues the wake.
  const pastBound = { ...work, startedAt: emptyWake.endedAt + EMPTY_WAKE_CONTINUATION_MS + 1 };
  assert.deepEqual(pageTurnSummaries([pastBound, emptyWake], 30).summaries, [pastBound, emptyWake]);
  const atBound = { ...work, startedAt: emptyWake.endedAt + EMPTY_WAKE_CONTINUATION_MS };
  assert.equal(pageTurnSummaries([atBound, emptyWake], 30).summaries.length, 1);

  const { outcome: _outcome, ...soFar } = later;
  const running = { ...soFar, running: true as const };
  assert.deepEqual(absorbEmptyWake([emptyWake], { turn: running, continuesPreviousTurn: true }), { summaries: [emptyWake], current: running });
});

test("a joined turn shows the work's last text, else the wake's", () => {
  const saidNothingNeeded = { ...emptyWake, lastText: "The #general message said no reply needed, so I didn't reply." };
  const said = { ...work, lastText: "Ran the tests; all pass." };
  assert.equal(pageTurnSummaries([said, saidNothingNeeded], 30).summaries[0]?.lastText, "Ran the tests; all pass.");
  assert.equal(pageTurnSummaries([work, saidNothingNeeded], 30).summaries[0]?.lastText, saidNothingNeeded.lastText);
  assert.equal("lastText" in pageTurnSummaries([work, emptyWake], 30).summaries[0]!, false, "neither output text: none");

  const { outcome: _outcome, ...soFar } = work;
  const running = { ...soFar, endedAt: 170_000, running: true as const };
  assert.equal(absorbEmptyWake([saidNothingNeeded], { turn: running, continuesPreviousTurn: true }).current?.lastText, saidNothingNeeded.lastText);
  assert.equal(absorbEmptyWake([saidNothingNeeded], { turn: { ...running, lastText: "Looking at the logs." }, continuesPreviousTurn: true }).current?.lastText, "Looking at the logs.");
});
