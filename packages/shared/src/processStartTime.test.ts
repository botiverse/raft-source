import assert from "node:assert/strict";
import { test } from "vitest";

import {
  parsePsLstartMs,
  parseWindowsCreationTimeUtcMicros,
  PID_REUSE_TOLERANCE_MS,
  startedAfterRecord,
  windowsCreationDateCommand,
} from "./processStartTime";

test("parsePsLstartMs: `ps lstart` in the C locale is local time; another locale is unknown, not a guess", () => {
  assert.equal(parsePsLstartMs("Thu Nov  5 10:15:42 2026\n"), new Date(2026, 10, 5, 10, 15, 42).getTime());
  assert.equal(parsePsLstartMs("Sat Feb 29 23:59:59 2028"), new Date(2028, 1, 29, 23, 59, 59).getTime());
  assert.equal(parsePsLstartMs("Thu Okt  5 10:15:42 2026"), undefined);
  assert.equal(parsePsLstartMs(""), undefined, "no such pid prints nothing");
});

test("parseWindowsCreationTimeUtcMicros: round-trip UTC and DMTF (local time, signed minute offset) agree", () => {
  const utc = Date.UTC(2026, 10, 11, 9, 0, 0) * 1000 + 123_456;
  assert.equal(parseWindowsCreationTimeUtcMicros("2026-11-11T09:00:00.1234567Z"), utc);
  assert.equal(parseWindowsCreationTimeUtcMicros("2026-11-11T09:00:00Z"), utc - 123_456);
  // UTC+8: local 17:00 is 09:00 UTC.
  assert.equal(parseWindowsCreationTimeUtcMicros("20261111170000.123456+480"), utc);
  // UTC-5:30 (minutes, not hours): local 03:30 is 09:00 UTC.
  assert.equal(parseWindowsCreationTimeUtcMicros("20261111033000.123456-330"), utc);
  assert.equal(parseWindowsCreationTimeUtcMicros("20261111090000.123456+000"), utc);
  for (const bad of ["", "11/11/2026 09:00:00", "2026-11-11T09:00:00+01:00", "20261111090000.123+000", "20261111090000.123456+8"]) {
    assert.equal(parseWindowsCreationTimeUtcMicros(bad), undefined, bad);
  }
});

test("windowsCreationDateCommand asks CIM for one process, by a pid that is a number", () => {
  const args = windowsCreationDateCommand(7720);
  assert.deepEqual(args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
  assert.match(args[3]!, /Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=7720" -ErrorAction Stop\)\.CreationDate/);
});

test("startedAfterRecord: only a process that started later than the record plus the slack reused the pid; unknown is never reuse", () => {
  const recordedAtMs = Date.parse("2026-11-13T08:00:00.000Z");
  assert.equal(startedAfterRecord(recordedAtMs, recordedAtMs - 60_000), false, "the process that wrote the record");
  assert.equal(startedAfterRecord(recordedAtMs, recordedAtMs + PID_REUSE_TOLERANCE_MS), false, "within how a start is measured");
  assert.equal(startedAfterRecord(recordedAtMs, recordedAtMs + PID_REUSE_TOLERANCE_MS + 1), true);
  assert.equal(startedAfterRecord(recordedAtMs, undefined), false, "a start that cannot be read");
  assert.equal(startedAfterRecord(recordedAtMs, Number.NaN), false);
  assert.equal(startedAfterRecord(Number.NaN, recordedAtMs), false, "a record without a readable time");
});
