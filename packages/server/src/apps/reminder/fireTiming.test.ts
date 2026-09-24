import assert from "node:assert/strict";
import { test } from "vitest";

import { isReminderCatchup } from "./fireTiming.js";

const DUE_AT_MS = Date.parse("2026-08-25T18:30:00.000Z");
const TOLERANCE_MS = 1_000;

test("on-time Computer fire stays on-time when Server processing is delayed", () => {
  assert.equal(isReminderCatchup({
    dueAtMs: DUE_AT_MS,
    firedAtClient: "2026-08-25T18:30:00.340Z",
    serverObservedAtMs: DUE_AT_MS + 7_000,
    toleranceMs: TOLERANCE_MS,
  }), false);
});

test("Computer fire beyond the due tolerance is a catchup", () => {
  assert.equal(isReminderCatchup({
    dueAtMs: DUE_AT_MS,
    firedAtClient: "2026-08-25T18:30:01.001Z",
    serverObservedAtMs: DUE_AT_MS + 7_000,
    toleranceMs: TOLERANCE_MS,
  }), true);
});

test("malformed Computer fire time fails closed to Server receipt time", () => {
  assert.equal(isReminderCatchup({
    dueAtMs: DUE_AT_MS,
    firedAtClient: "not-a-date",
    serverObservedAtMs: DUE_AT_MS + 7_000,
    toleranceMs: TOLERANCE_MS,
  }), true);
});
