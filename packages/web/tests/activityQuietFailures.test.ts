import assert from "node:assert/strict";

import { groupQuietFailures, isQuietFailure } from "../src/components/agent/activityQuietFailures";
import type { QuietFailureTurn } from "../src/components/agent/activityQuietFailures";

const HOUR = 3_600_000;
const RESET = Date.parse("2026-11-08T07:00:00.000Z");

function turn(at: number, overrides: Partial<QuietFailureTurn> = {}): QuietFailureTurn & { id: string } {
  return { id: `t${at}`, startedAt: at, endedAt: at + 1_000, outcome: "failed", toolCalls: 0, messagesSent: 0, problemCount: 0, ...overrides };
}

const limited = (at: number) => turn(at, { usageLimit: { resetsAt: RESET } });

test("a quiet failure did nothing: failed, no tool call, no message, nothing gone wrong", () => {
  assert.equal(isQuietFailure(turn(0)), true);
  assert.equal(isQuietFailure(turn(0, { outcome: "completed" })), false);
  assert.equal(isQuietFailure(turn(0, { toolCalls: 1 })), false);
  assert.equal(isQuietFailure(turn(0, { messagesSent: 1 })), false);
  assert.equal(isQuietFailure(turn(0, { lastReplyMessageId: "m1" })), false);
  assert.equal(isQuietFailure(turn(0, { hiddenSentCount: 1 })), false);
  assert.equal(isQuietFailure(turn(0, { problemCount: 1 })), false);
});

test("hourly usage-limit retries between real turns fold into one run, in order", () => {
  const work = turn(0, { outcome: "completed", toolCalls: 4, messagesSent: 1 });
  const retries = [limited(HOUR), limited(2 * HOUR), limited(3 * HOUR)];
  const after = turn(10 * HOUR, { outcome: "completed", toolCalls: 2 });
  assert.deepEqual(groupQuietFailures([work, ...retries, after]), [
    { kind: "turn", turn: work },
    { kind: "run", turns: retries },
    { kind: "turn", turn: after },
  ]);
});

test("one quiet failure alone stays a turn; usage-limit and other failures are separate runs", () => {
  const lone = turn(0);
  assert.deepEqual(groupQuietFailures([lone]), [{ kind: "turn", turn: lone }]);
  const plain = [turn(HOUR), turn(2 * HOUR)];
  const quota = [limited(3 * HOUR), limited(4 * HOUR)];
  assert.deepEqual(groupQuietFailures([...plain, ...quota]), [
    { kind: "run", turns: plain },
    { kind: "run", turns: quota },
  ]);
  // A limit turn between plain failures does not join them.
  const mixed = [turn(HOUR), limited(2 * HOUR), turn(3 * HOUR)];
  assert.deepEqual(groupQuietFailures(mixed), mixed.map((item) => ({ kind: "turn", turn: item })));
});
