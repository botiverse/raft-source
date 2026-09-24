// Teeth for the int4 seq-headroom tripwire (zero-DB stopgap).
//
// The classification boundaries are the load-bearing part: a tripwire that
// fires one seq too late is indistinguishable from no tripwire. Positive and
// negative cases sit ADJACENT across each threshold so only real
// threshold-reading logic stays green (no arithmetic coincidence).
import assert from "node:assert/strict";
import { test } from "vitest";

import {
  INT4_MAX,
  SEQ_HEADROOM_CRITICAL_RATIO,
  SEQ_HEADROOM_WARN_RATIO,
  classifySeqHeadroom,
  probeSeqHeadroom,
  resetSeqHeadroomThrottleForTest,
} from "./seqHeadroomTripwire.js";

test("classify: adjacent values across the warn threshold disagree", () => {
  const warnAt = Math.ceil(INT4_MAX * SEQ_HEADROOM_WARN_RATIO);
  assert.equal(classifySeqHeadroom(warnAt - 1), "ok");
  assert.equal(classifySeqHeadroom(warnAt), "warn");
});

test("classify: adjacent values across the critical threshold disagree", () => {
  const criticalAt = Math.ceil(INT4_MAX * SEQ_HEADROOM_CRITICAL_RATIO);
  assert.equal(classifySeqHeadroom(criticalAt - 1), "warn");
  assert.equal(classifySeqHeadroom(criticalAt), "critical");
});

test("classify: the actual ceiling and beyond are critical, zero is ok", () => {
  assert.equal(classifySeqHeadroom(INT4_MAX), "critical");
  assert.equal(classifySeqHeadroom(INT4_MAX + 1), "critical");
  assert.equal(classifySeqHeadroom(0), "ok");
});

test("probe is fail-open: no database configured must not throw", () => {
  resetSeqHeadroomThrottleForTest();
  // getDb() inside the probe will fail in this bare test process; the probe
  // contract is that this NEVER propagates (health must not be affected).
  assert.doesNotThrow(() => probeSeqHeadroom());
});
