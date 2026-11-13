import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isKimiRefreshLockHeld, withKimiRefreshLock } from "./kimiCredentialLock";

const FAST = { retries: { retries: 2, factor: 1, minTimeout: 50, maxTimeout: 100 } };

/** A second real process holding the client's lock exactly as the client does (proper-lockfile, same options). */
function holdLockInChild(target: string, holdMs: number): { started: Promise<void>; released: Promise<void> } {
  const script = `
    const lockfile = require(${JSON.stringify(require.resolve("proper-lockfile"))});
    const fs = require("node:fs");
    fs.mkdirSync(require("node:path").dirname(${JSON.stringify(target)}), { recursive: true });
    fs.writeFileSync(${JSON.stringify(target)}, "", { flag: "a" });
    lockfile.lock(${JSON.stringify(target)}, { retries: 0, stale: 5000, realpath: false }).then((release) => {
      process.stdout.write("held\\n");
      setTimeout(() => release().then(() => { process.stdout.write("released\\n"); }), ${holdMs});
    });
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  let onStarted!: () => void;
  let onReleased!: () => void;
  const started = new Promise<void>((resolve) => { onStarted = resolve; });
  const released = new Promise<void>((resolve) => { onReleased = resolve; });
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString();
    if (out.includes("held")) onStarted();
    if (out.includes("released")) onReleased();
  });
  return { started, released };
}

test("task #1282: the client's lock, held by another real process, keeps the daemon out (bounded), and lets it in once released", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kimi-lock-"));
  try {
    const target = path.join(root, "oauth", "kimi-code");
    const holder = holdLockInChild(target, 700);
    await holder.started;
    assert.equal(await isKimiRefreshLockHeld(target), true);
    let ran = 0;
    const startedAt = Date.now();
    const blocked = await withKimiRefreshLock(target, async () => { ran += 1; return "x"; }, FAST);
    assert.equal(blocked.kind, "unavailable");
    assert.equal(ran, 0, "fn never runs without the lock");
    assert.ok(Date.now() - startedAt < 2000, "the wait is bounded");
    await holder.released;
    const held = await withKimiRefreshLock(target, async (handle) => { ran += 1; assert.equal(handle.isCompromised(), false); return "y"; }, FAST);
    assert.deepEqual(held, { kind: "held", value: "y" });
    assert.equal(ran, 1);
    assert.equal(existsSync(`${target}.lock`), false, "released after fn settled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1282: while the daemon holds the lock, the client's own attempt (another real process) is kept out", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kimi-lock-2-"));
  try {
    const target = path.join(root, "oauth", "kimi-code");
    let childResult = "";
    const result = await withKimiRefreshLock(target, async () => {
      const script = `
        const lockfile = require(${JSON.stringify(require.resolve("proper-lockfile"))});
        lockfile.lock(${JSON.stringify(target)}, { retries: 0, stale: 5000, realpath: false })
          .then(() => { process.stdout.write("acquired"); process.exit(0); }, (e) => { process.stdout.write("blocked:" + e.code); process.exit(0); });
      `;
      await new Promise<void>((resolve) => {
        const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
        child.stdout.on("data", (c: Buffer) => { childResult += c.toString(); });
        child.on("close", () => resolve());
      });
      return "done";
    }, FAST);
    assert.deepEqual(result, { kind: "held", value: "done" });
    assert.equal(childResult, "blocked:ELOCKED");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1282: a lock reclaimed or removed under the daemon is reported as compromised on the handle, never thrown", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kimi-lock-3-"));
  try {
    const target = path.join(root, "oauth", "kimi-code");
    const result = await withKimiRefreshLock(target, async (handle) => {
      assert.equal(handle.isCompromised(), false);
      // Another party judged the lock stale and took it over: the lock dir is
      // replaced and carries that party's (older) mtime.
      rmSync(`${target}.lock`, { recursive: true, force: true });
      mkdirSync(`${target}.lock`);
      const foreign = new Date(Date.now() - 60_000);
      utimesSync(`${target}.lock`, foreign, foreign);
      // proper-lockfile renews every max(stale/2, 1 s) (stale is clamped to 2 s) and detects the foreign mtime.
      const deadline = Date.now() + 4000;
      while (!handle.isCompromised() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      return handle.isCompromised();
    }, { ...FAST, staleMs: 2000 });
    assert.deepEqual(result, { kind: "held", value: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a lock home this daemon creates is private and the sentinel is 0600; a sentinel that is a symbolic link is refused and its target untouched", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "kimi-lock-v83-"));
  try {
    const home = path.join(root, ".kimi-code");
    const target = path.join(home, "oauth", "kimi-code");
    const held = await withKimiRefreshLock(target, async () => "ran", FAST);
    assert.deepEqual(held, { kind: "held", value: "ran" });
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(path.dirname(target)).mode & 0o777, 0o700);
    assert.equal(statSync(target).mode & 0o777, 0o600);

    const victim = path.join(root, "victim");
    writeFileSync(victim, "keep");
    const linked = path.join(home, "oauth", "linked");
    symlinkSync(victim, linked);
    let ran = false;
    const refused = await withKimiRefreshLock(linked, async () => { ran = true; return "ran"; }, FAST);
    assert.equal(refused.kind, "unavailable");
    assert.equal(ran, false);
    assert.equal(readFileSync(victim, "utf8"), "keep");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
