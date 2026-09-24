import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { rotateLogIfNeeded } from "./logRotation.js";

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "slock-logrot-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

const NOW = new Date("2026-06-19T08:00:00Z");
// All instants here are UTC (`...Z`) and the rotation day-key is UTC (see
// `ymd()` in logRotation.ts), so these cases are TZ-INVARIANT — they assert
// the same outcome in every time zone. Do NOT introduce local-time fixtures:
// a local day-key once made `...T23:30:00Z` straddle the day boundary (pass in
// UTC-5, fail in UTC+8). Keep fixtures + the production day-key both UTC.
// Set a file's mtime to a given day so the date-based check sees it as that day.
const setMtimeDay = async (p: string, iso: string): Promise<void> => {
  const t = new Date(iso);
  await utimes(p, t, t);
};

test("rotateLogIfNeeded: active log written TODAY → not rotated (append continues)", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "service.log");
    await writeFile(log, "today's data");
    await setMtimeDay(log, "2026-06-19T07:00:00Z");
    await rotateLogIfNeeded(log, { now: NOW });
    assert.equal(await readFile(log, "utf8"), "today's data");
    assert.equal(await exists(join(dir, "service.2026-06-19.log")), false);
  });
});

test("rotateLogIfNeeded: active log from a PRIOR day → archived to dated sibling, active freed", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "service.log");
    await writeFile(log, "yesterday's data");
    await setMtimeDay(log, "2026-06-18T23:30:00Z");
    await rotateLogIfNeeded(log, { now: NOW });
    // Active name is freed (caller re-opens fresh); content archived under the day it covered.
    assert.equal(await exists(log), false);
    assert.equal(await readFile(join(dir, "service.2026-06-18.log"), "utf8"), "yesterday's data");
  });
});

test("rotateLogIfNeeded: per-server runner.log archives under its date too", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "runner.log");
    await writeFile(log, "runner output");
    await setMtimeDay(log, "2026-06-17T12:00:00Z");
    await rotateLogIfNeeded(log, { now: NOW });
    assert.equal(await readFile(join(dir, "runner.2026-06-17.log"), "utf8"), "runner output");
  });
});

test("rotateLogIfNeeded: active runner.log over byte cap is archived even on same UTC day", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "runner.log");
    await writeFile(log, "0123456789");
    await setMtimeDay(log, "2026-06-19T07:00:00Z");
    await rotateLogIfNeeded(log, { now: NOW, maxBytes: 4 });
    assert.equal(await exists(log), false);
    assert.equal(await readFile(join(dir, "runner.2026-06-19.log"), "utf8"), "0123456789");
  });
});

test("rotateLogIfNeeded: prunes dated archives older than maxDays", async () => {
  await withTmp(async (dir) => {
    const log = join(dir, "service.log");
    await writeFile(log, "active today");
    await setMtimeDay(log, "2026-06-19T07:00:00Z"); // today → not rotated
    // Old + recent dated archives:
    await writeFile(join(dir, "service.2026-06-01.log"), "old"); // 18 days before NOW
    await writeFile(join(dir, "service.2026-06-17.log"), "recent"); // 2 days before NOW
    await rotateLogIfNeeded(log, { now: NOW, maxDays: 14 });
    assert.equal(await exists(join(dir, "service.2026-06-01.log")), false, "old archive pruned");
    assert.equal(await exists(join(dir, "service.2026-06-17.log")), true, "recent archive kept");
    // Don't touch unrelated files / the active log.
    assert.equal(await exists(log), true);
  });
});

test("rotateLogIfNeeded: missing active log is a no-op (never throws)", async () => {
  await withTmp(async (dir) => {
    await rotateLogIfNeeded(join(dir, "nope.log"), { now: NOW });
    // no throw = pass
  });
});
