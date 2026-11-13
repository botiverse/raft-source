import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CONTEXT_GENERATION_FILENAME, type ContextGenerationRecord } from "@botiverse/raft-shared";

import {
  bindContextGenerationToSession,
  configPassiveAx,
  CONTEXT_SESSIONS_FILENAME,
  MAX_REMEMBERED_SESSIONS,
  planSpawnContextGeneration,
  publishSpawnContextGeneration,
  readContextGeneration,
  rememberSessionContext,
  writeContextGeneration,
  type ContextGenerationFs,
} from "./contextGeneration";
import type { RuntimeCompactionReporting } from "./drivers/types";

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "raft-context-generation-"));
}

function readRecord(dir: string): ContextGenerationRecord {
  return JSON.parse(readFileSync(path.join(dir, CONTEXT_GENERATION_FILENAME), "utf8")) as ContextGenerationRecord;
}

/** A spawn as the daemon and the transport do it together: plan with the driver's declaration, then publish. */
function spawn(dir: string, input: { compaction: RuntimeCompactionReporting; resumeSessionId: string | null; passiveAx: boolean }): string | null {
  return publishSpawnContextGeneration(dir, { runtime: "test-runtime", passiveAx: input.passiveAx, plan: planSpawnContextGeneration(dir, input) });
}

test("writes a private JSON record with a fresh context id (RFC 072 §7.2.2)", () => {
  const dir = tempDir();
  try {
    const id = writeContextGeneration(dir, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: false }, {
      newId: () => "ctx-1",
      now: () => new Date("2026-09-30T00:00:00.000Z"),
    });
    assert.equal(id, "ctx-1");
    assert.deepEqual(readRecord(dir), {
      contextId: "ctx-1",
      reason: "spawn",
      compactionReported: true,
      runtime: "claude",
      writtenAt: "2026-09-30T00:00:00.000Z",
      passiveAx: false,
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(dir, CONTEXT_GENERATION_FILENAME)).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every write issues a new id; a compaction replaces the spawn id", () => {
  const dir = tempDir();
  try {
    const first = writeContextGeneration(dir, { reason: "spawn", runtime: "codex", compaction: "reported", passiveAx: false });
    const second = writeContextGeneration(dir, { reason: "compaction", runtime: "codex", compaction: "reported", passiveAx: false });
    assert.ok(first && second);
    assert.notEqual(first, second);
    const record = readRecord(dir);
    assert.equal(record.contextId, second);
    assert.equal(record.reason, "compaction");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// D5 (RFC 072 §7.7): the transport directory is reused across same-launch and
// launch-less respawns, so a failed write must not leave the previous spawn's
// id behind — the CLI would match it against old observations (a false "seen").
test("a failed write leaves no generation file, even when a stale one existed", () => {
  const dir = tempDir();
  try {
    writeContextGeneration(dir, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: false }, { newId: () => "stale" });
    assert.equal(readRecord(dir).contextId, "stale");

    const failingFs: ContextGenerationFs = {
      writeFileSync: (() => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }) as unknown as typeof writeFileSync,
      readFileSync,
      renameSync,
      unlinkSync,
    };
    const id = writeContextGeneration(dir, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: false }, { fs: failingFs, newId: () => "fresh" });

    assert.equal(id, null);
    assert.equal(existsSync(path.join(dir, CONTEXT_GENERATION_FILENAME)), false, "no stale id may survive a failed write");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed rename also leaves neither the stale file nor the temp file", () => {
  const dir = tempDir();
  try {
    writeContextGeneration(dir, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: false }, { newId: () => "stale" });
    const failingFs: ContextGenerationFs = {
      readFileSync,
      writeFileSync,
      renameSync: (() => {
        throw Object.assign(new Error("rename failed"), { code: "EIO" });
      }) as unknown as typeof renameSync,
      unlinkSync,
    };
    assert.equal(writeContextGeneration(dir, { reason: "compaction", runtime: "claude", compaction: "reported", passiveAx: false }, { fs: failingFs }), null);
    assert.equal(existsSync(path.join(dir, CONTEXT_GENERATION_FILENAME)), false);
    assert.deepEqual(readdirSync(dir), [], "the temp file is cleaned up too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writing never throws, even when the directory is missing", () => {
  const missing = path.join(tempDir(), "gone");
  assert.equal(writeContextGeneration(missing, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: false }), null);
});

// D4 (RFC 072 §7.7): whether a runtime reports compaction is its driver's own
// declaration (RuntimeDriver.session.compaction, required by the type); the
// record carries exactly what the writer was given.
test("the record says whether compaction is reported, as the driver declared it", () => {
  const dir = tempDir();
  try {
    writeContextGeneration(dir, { reason: "spawn", runtime: "gemini", compaction: "unreported", passiveAx: false });
    assert.equal(readRecord(dir).compactionReported, false);
    writeContextGeneration(dir, { reason: "spawn", runtime: "pi", compaction: "reported", passiveAx: false });
    assert.equal(readRecord(dir).compactionReported, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Only a host that holds the driver plans a spawn; the transport never guesses.
test("a spawn without a plan publishes no id and removes an earlier one", () => {
  const dir = tempDir();
  try {
    writeContextGeneration(dir, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: false }, { newId: () => "stale" });
    assert.equal(publishSpawnContextGeneration(dir, { runtime: "claude", passiveAx: false, plan: undefined }), null);
    assert.equal(existsSync(path.join(dir, CONTEXT_GENERATION_FILENAME)), false, "no stale id may survive a spawn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// Resume is not a new context (tygg, #proj-aiax:915fd5fa; RFC 072 §7.2.3).
// Launch directories live under one agent directory, which holds the table.
function launchDirs(): { root: string; launch: (name: string) => string } {
  const root = tempDir();
  return {
    root,
    launch: (name) => {
      const dir = path.join(root, "agent-1", name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

test("resuming a session the runtime confirmed reuses its context id, even from another launch dir", () => {
  const { root, launch } = launchDirs();
  try {
    const first = launch("launch-1");
    const spawnId = spawn(first, { compaction: "reported", resumeSessionId: null, passiveAx: false });
    bindContextGenerationToSession(first, { runtime: "claude", compaction: "reported", sessionId: "s1", expectedSessionId: null });

    const second = launch("launch-2");
    assert.equal(spawn(second, { compaction: "reported", resumeSessionId: "s1", passiveAx: false }), spawnId);
    assert.equal(readContextGeneration(second)?.reason, "resume");
    if (process.platform !== "win32") {
      assert.equal(statSync(path.join(root, "agent-1", CONTEXT_SESSIONS_FILENAME)).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a resume gets a new id when the session is unknown, or the runtime never reports compaction", () => {
  const { root, launch } = launchDirs();
  try {
    const dir = launch("launch-1");
    const spawnId = spawn(dir, { compaction: "unreported", resumeSessionId: null, passiveAx: false });
    bindContextGenerationToSession(dir, { runtime: "gemini", compaction: "unreported", sessionId: "g1", expectedSessionId: null });
    assert.notEqual(spawn(dir, { compaction: "unreported", resumeSessionId: "g1", passiveAx: false }), spawnId);
    assert.equal(readContextGeneration(dir)?.reason, "spawn");

    spawn(dir, { compaction: "reported", resumeSessionId: "never-seen", passiveAx: false });
    assert.equal(readContextGeneration(dir)?.reason, "spawn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// glimpse G0: the daemon plans the spawn's id before the process exists (to
// book the start input under it); the transport then publishes exactly that id.
test("a planned spawn id is the one published, and planning writes nothing", () => {
  const { root, launch } = launchDirs();
  try {
    const first = launch("launch-1");
    const spawnId = spawn(first, { compaction: "reported", resumeSessionId: null, passiveAx: true });
    bindContextGenerationToSession(first, { runtime: "claude", compaction: "reported", sessionId: "s1", expectedSessionId: null });

    const second = launch("launch-2");
    const resumed = planSpawnContextGeneration(second, { compaction: "reported", resumeSessionId: "s1" });
    assert.deepEqual(resumed, { contextId: spawnId, reason: "resume", compaction: "reported" });
    const fresh = planSpawnContextGeneration(second, { compaction: "reported", resumeSessionId: null });
    assert.equal(fresh.reason, "spawn");
    assert.notEqual(fresh.contextId, spawnId);
    assert.equal(readContextGeneration(second), null, "planning publishes nothing");

    assert.equal(publishSpawnContextGeneration(second, { runtime: "claude", passiveAx: true, plan: fresh }), fresh.contextId);
    assert.equal(readContextGeneration(second)?.contextId, fresh.contextId);
    assert.equal(readContextGeneration(second)?.reason, "spawn");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("binding a session returns the id now current", () => {
  const { root, launch } = launchDirs();
  try {
    const dir = launch("launch-1");
    const spawnId = spawn(dir, { compaction: "reported", resumeSessionId: "s1", passiveAx: false });
    assert.equal(bindContextGenerationToSession(dir, { runtime: "claude", compaction: "reported", sessionId: "s1", expectedSessionId: "s1" }), spawnId);
    const rebound = bindContextGenerationToSession(dir, { runtime: "claude", compaction: "reported", sessionId: "s2", expectedSessionId: "s1" });
    assert.notEqual(rebound, spawnId, "another session than the one resumed: a new id");
    assert.equal(readContextGeneration(dir)?.contextId, rebound);
    assert.equal(bindContextGenerationToSession(launch("empty"), { runtime: "claude", compaction: "reported", sessionId: "s3", expectedSessionId: null }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session_init reporting another session than the one resumed issues a new id bound to it", () => {
  const { root, launch } = launchDirs();
  try {
    const first = launch("launch-1");
    const originalId = spawn(first, { compaction: "reported", resumeSessionId: null, passiveAx: false });
    bindContextGenerationToSession(first, { runtime: "claude", compaction: "reported", sessionId: "s1", expectedSessionId: null });

    // The resume silently started fresh: the runtime reports s2, not s1.
    const second = launch("launch-2");
    assert.equal(spawn(second, { compaction: "reported", resumeSessionId: "s1", passiveAx: false }), originalId);
    bindContextGenerationToSession(second, { runtime: "claude", compaction: "reported", sessionId: "s2", expectedSessionId: "s1" });
    const freshId = readContextGeneration(second)?.contextId;
    assert.ok(freshId);
    assert.notEqual(freshId, originalId, "the fresh session must not inherit s1's context id");

    const third = launch("launch-3");
    assert.equal(spawn(third, { compaction: "reported", resumeSessionId: "s2", passiveAx: false }), freshId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a compaction rebinds the session, so a later resume gets the post-compaction id", () => {
  const { root, launch } = launchDirs();
  try {
    const first = launch("launch-1");
    const spawnId = spawn(first, { compaction: "reported", resumeSessionId: null, passiveAx: false });
    bindContextGenerationToSession(first, { runtime: "codex", compaction: "reported", sessionId: "c1", expectedSessionId: null });
    const compactedId = writeContextGeneration(first, { reason: "compaction", runtime: "codex", compaction: "reported", passiveAx: false });
    rememberSessionContext(first, "c1", compactedId);
    assert.notEqual(compactedId, spawnId);

    assert.equal(spawn(launch("launch-2"), { compaction: "reported", resumeSessionId: "c1", passiveAx: false }), compactedId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed table write drops the whole table, so no pre-compaction id can be reused", () => {
  const { root, launch } = launchDirs();
  try {
    const dir = launch("launch-1");
    const spawnId = spawn(dir, { compaction: "reported", resumeSessionId: null, passiveAx: false });
    bindContextGenerationToSession(dir, { runtime: "claude", compaction: "reported", sessionId: "s1", expectedSessionId: null });

    const failingFs: ContextGenerationFs = {
      readFileSync,
      writeFileSync: ((file: string, ...rest: unknown[]) => {
        if (String(file).includes(CONTEXT_SESSIONS_FILENAME)) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        return (writeFileSync as (...args: unknown[]) => void)(file, ...rest);
      }) as unknown as typeof writeFileSync,
      renameSync,
      unlinkSync,
    };
    const compactedId = writeContextGeneration(dir, { reason: "compaction", runtime: "claude", compaction: "reported", passiveAx: false }, { fs: failingFs });
    rememberSessionContext(dir, "s1", compactedId, { fs: failingFs });

    assert.equal(existsSync(path.join(root, "agent-1", CONTEXT_SESSIONS_FILENAME)), false);
    const resumedId = spawn(launch("launch-2"), { compaction: "reported", resumeSessionId: "s1", passiveAx: false });
    assert.notEqual(resumedId, spawnId);
    assert.notEqual(resumedId, compactedId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("forgetting a retired session, and the table size cap", () => {
  const { root, launch } = launchDirs();
  try {
    const dir = launch("launch-1");
    for (let i = 0; i <= MAX_REMEMBERED_SESSIONS; i += 1) rememberSessionContext(dir, `s${i}`, `ctx-${i}`);
    const table = JSON.parse(readFileSync(path.join(root, "agent-1", CONTEXT_SESSIONS_FILENAME), "utf8"));
    assert.equal(Object.keys(table.sessions).length, MAX_REMEMBERED_SESSIONS);
    assert.equal(table.sessions.s0, undefined, "the least recently updated session is dropped");

    rememberSessionContext(dir, "s1", null);
    spawn(dir, { compaction: "reported", resumeSessionId: "s1", passiveAx: false });
    assert.equal(readContextGeneration(dir)?.reason, "spawn");
    spawn(dir, { compaction: "reported", resumeSessionId: "s2", passiveAx: false });
    assert.equal(readContextGeneration(dir)?.contextId, "ctx-2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// task #359: the passive AX gate rides in the same daemon-written record.
test("the record carries the passive AX gate the writer was given", () => {
  const dir = tempDir();
  try {
    writeContextGeneration(dir, { reason: "spawn", runtime: "claude", compaction: "reported", passiveAx: true });
    assert.equal(readContextGeneration(dir)?.passiveAx, true);
    writeContextGeneration(dir, { reason: "compaction", runtime: "claude", compaction: "reported", passiveAx: false });
    assert.equal(readContextGeneration(dir)?.passiveAx, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("spawn and resume publish the gate; a session mismatch carries the published gate to the new id", () => {
  const { root, launch } = launchDirs();
  try {
    const first = launch("launch-1");
    spawn(first, { compaction: "reported", resumeSessionId: null, passiveAx: true });
    assert.equal(readContextGeneration(first)?.passiveAx, true);
    bindContextGenerationToSession(first, { runtime: "claude", compaction: "reported", sessionId: "s1", expectedSessionId: null });

    const second = launch("launch-2");
    spawn(second, { compaction: "reported", resumeSessionId: "s1", passiveAx: true });
    assert.equal(readContextGeneration(second)?.reason, "resume");
    assert.equal(readContextGeneration(second)?.passiveAx, true);
    bindContextGenerationToSession(second, { runtime: "claude", compaction: "reported", sessionId: "s2", expectedSessionId: "s1" });
    assert.equal(readContextGeneration(second)?.reason, "spawn");
    assert.equal(readContextGeneration(second)?.passiveAx, true, "the new id keeps the gate this process was spawned with");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("configPassiveAx turns the gate on only for an explicit true", () => {
  assert.equal(configPassiveAx({ passiveAx: true }), true);
  assert.equal(configPassiveAx({ passiveAx: false }), false);
  assert.equal(configPassiveAx({}), false, "a config from an older Server has no field");
  assert.equal(configPassiveAx({ passiveAx: "true" }), false);
});
