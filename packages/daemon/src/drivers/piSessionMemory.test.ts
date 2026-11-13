import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  PI_SESSION_MEMORY_TRACE_ATTRS,
  piSessionMemoryAttrs,
  trackPiSessionMemory,
  type PiSessionMemorySource,
} from "./piSessionMemory";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const HOUR = 60 * 60_000;

function fakeSession(entries: number, file: string | undefined, createdAt: string | null) {
  const manager: PiSessionMemorySource = {
    getEntryCount: () => entries,
    getSessionFile: () => file,
    getHeader: () => (createdAt === null ? null : { timestamp: createdAt }),
  };
  return { sessionManager: manager };
}

test("totals live sessions; the largest is by size; age runs from session creation", () => {
  const sizes: Record<string, number> = { "/s/a.jsonl": 3 * 1024 * 1024, "/s/b.jsonl": 512 * 1024 };
  const a = fakeSession(377, "/s/a.jsonl", new Date(NOW - 2 * HOUR).toISOString());
  const b = fakeSession(900, "/s/b.jsonl", new Date(NOW - 30 * HOUR).toISOString());
  // pi writes the file only at the first message: no size yet, still counted.
  const fresh = fakeSession(1, "/s/not-written.jsonl", new Date(NOW - 1000).toISOString());
  const untrack = [a, b, fresh].map((session) => trackPiSessionMemory(session));
  try {
    const attrs = piSessionMemoryAttrs(NOW, (file) => {
      const size = sizes[file];
      if (size === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return size;
    });
    assert.deepEqual(attrs, {
      pi_session_count: 3,
      pi_session_entry_count: 1278,
      pi_session_kb: 3584,
      pi_largest_session_entry_count: 377,
      pi_largest_session_kb: 3072,
      pi_oldest_session_age_ms: 30 * HOUR,
    });
    assert.deepEqual(Object.keys(attrs).sort(), [...PI_SESSION_MEMORY_TRACE_ATTRS].sort());
  } finally {
    for (const done of untrack) done();
  }
});

test("a disposed session stops counting, and none leaves only the zero count", () => {
  const untrack = trackPiSessionMemory(fakeSession(5, undefined, new Date(NOW).toISOString()));
  assert.equal(piSessionMemoryAttrs(NOW).pi_session_count, 1);
  untrack();
  assert.deepEqual(piSessionMemoryAttrs(NOW), { pi_session_count: 0 });
});

test("a session that throws mid-dispose or lacks a header does not break the event", () => {
  const broken = {
    get sessionManager(): PiSessionMemorySource {
      throw new Error("disposed");
    },
  };
  const headerless = fakeSession(2, undefined, null);
  const untrack = [trackPiSessionMemory(broken), trackPiSessionMemory(headerless)];
  try {
    assert.deepEqual(piSessionMemoryAttrs(NOW), {
      pi_session_count: 1,
      pi_session_entry_count: 2,
      pi_session_kb: 0,
      pi_largest_session_entry_count: 2,
      pi_largest_session_kb: 0,
    });
  } finally {
    for (const done of untrack) done();
  }
});

test("reads a real session file's size from disk", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pi-session-memory-"));
  try {
    const file = path.join(dir, "session.jsonl");
    writeFileSync(file, "x".repeat(10 * 1024));
    const untrack = trackPiSessionMemory(fakeSession(3, file, new Date(NOW).toISOString()));
    try {
      assert.equal(piSessionMemoryAttrs(NOW).pi_session_kb, 10);
    } finally {
      untrack();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
