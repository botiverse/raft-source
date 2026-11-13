import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  compareRuntimeCliVersions,
  observeRuntimeCliVersions,
  readRuntimeCliVersionState,
  runtimeCliVersionDrift,
  runtimeCliVersionsPath,
  writeRuntimeCliVersionState,
} from "./runtimeCliVersionTracker";

const empty = { schemaVersion: 1 as const, versions: {}, downgrades: {} };
const at = new Date("2026-10-18T08:00:00.000Z");
/** No runtime ships with the Computer: every runtime is compared. */
const none: ReadonlySet<string> = new Set();

test("versions compare by their dotted numbers whatever the CLI prints around them", () => {
  assert.ok(compareRuntimeCliVersions("codex-cli 0.163.0", "codex-cli 0.151.0")! > 0);
  assert.ok(compareRuntimeCliVersions("2.1.301 (Claude Code)", "2.1.400")! < 0);
  assert.equal(compareRuntimeCliVersions("1.2", "1.2.0"), 0);
  assert.equal(compareRuntimeCliVersions("dev", "1.0.0"), null);
});

test("the first detection only records; a later downgrade is a change and a notice", () => {
  const first = observeRuntimeCliVersions(empty, { codex: "codex-cli 0.163.0", claude: "2.1.301" }, at, none);
  assert.deepEqual(first.changes, []);
  const down = observeRuntimeCliVersions(first.next, { codex: "codex-cli 0.151.0", claude: "2.1.301" }, at, none);
  assert.deepEqual(down.changes, [{ runtime: "codex", from: "codex-cli 0.163.0", to: "codex-cli 0.151.0", direction: "downgrade" }]);
  assert.deepEqual(down.next.downgrades.codex, { from: "codex-cli 0.163.0", to: "codex-cli 0.151.0", at: at.toISOString() });
  assert.equal(down.next.downgrades.claude, undefined);
});

test("a notice clears once the version is back, and remembers the good version across a second step down", () => {
  const recorded = observeRuntimeCliVersions(empty, { codex: "0.163.0" }, at, none).next;
  const once = observeRuntimeCliVersions(recorded, { codex: "0.155.0" }, at, none).next;
  const twice = observeRuntimeCliVersions(once, { codex: "0.151.0" }, at, none).next;
  assert.equal(twice.downgrades.codex?.from, "0.163.0");
  const back = observeRuntimeCliVersions(twice, { codex: "0.163.0" }, at, none);
  assert.equal(back.changes[0]?.direction, "upgrade");
  assert.equal(back.next.downgrades.codex, undefined);
});

// builtin and pi run inside the daemon process. The version their probe
// reports is fixed by the Computer build (the bundled SDK's package version;
// in the native binary that is the Computer's own, as in the numbers below)
// and goes down exactly when the Computer does, so "an older copy earlier on
// PATH" is the wrong advice for them (seen after an intended downgrade).
const shipped = new Set(["builtin", "pi"]);

test("a runtime that ships with the Computer going down is neither a change nor a notice; a CLI going down in the same detection still is both", () => {
  const before = { codex: "codex-cli 0.163.0", builtin: "1.22.0", pi: "1.22.0" };
  const first = observeRuntimeCliVersions(empty, before, at, shipped);
  assert.deepEqual(first.next.versions, { codex: "codex-cli 0.163.0" });
  const down = observeRuntimeCliVersions(first.next, { codex: "codex-cli 0.151.0", builtin: "1.0.69", pi: "1.0.69" }, at, shipped);
  assert.deepEqual(down.changes, [{ runtime: "codex", from: "codex-cli 0.163.0", to: "codex-cli 0.151.0", direction: "downgrade" }]);
  assert.deepEqual(down.next.downgrades, { codex: { from: "codex-cli 0.163.0", to: "codex-cli 0.151.0", at: at.toISOString() } });
  assert.deepEqual(down.next.versions, { codex: "codex-cli 0.151.0" });
});

test("what an earlier Computer recorded for a runtime that ships with the Computer is dropped on the next detection, detected or not", () => {
  const written = {
    schemaVersion: 1 as const,
    versions: { codex: "0.151.0", builtin: "1.0.69", pi: "1.0.69" },
    downgrades: {
      codex: { from: "0.163.0", to: "0.151.0", at: at.toISOString() },
      builtin: { from: "1.22.0", to: "1.0.69", at: at.toISOString() },
      pi: { from: "1.22.0", to: "1.0.69", at: at.toISOString() },
    },
  };
  const detections: Record<string, string>[] = [{ codex: "0.151.0", builtin: "1.0.69", pi: "1.0.69" }, {}];
  for (const detected of detections) {
    const healed = observeRuntimeCliVersions(written, detected, at, shipped);
    assert.deepEqual(healed.changes, []);
    assert.deepEqual(healed.next.versions, { codex: "0.151.0" });
    assert.deepEqual(healed.next.downgrades, { codex: written.downgrades.codex });
  }
});

test("a runtime that ships with the Computer going up is not a change either, and a CLI going up beside it still is", () => {
  const recorded = observeRuntimeCliVersions(empty, { codex: "0.151.0", builtin: "1.0.69" }, at, shipped).next;
  const up = observeRuntimeCliVersions(recorded, { codex: "0.163.0", builtin: "1.22.0" }, at, shipped);
  assert.deepEqual(up.changes, [{ runtime: "codex", from: "0.151.0", to: "0.163.0", direction: "upgrade" }]);
  assert.deepEqual(up.next, { schemaVersion: 1, versions: { codex: "0.163.0" }, downgrades: {} });
});

test("a runtime missing from one detection keeps its record", () => {
  const recorded = observeRuntimeCliVersions(empty, { codex: "0.163.0" }, at, none).next;
  const missing = observeRuntimeCliVersions(recorded, {}, at, none);
  assert.deepEqual(missing.changes, []);
  assert.equal(missing.next.versions.codex, "0.163.0");
});

test("the record round-trips through the Raft home, and a bad file reads as empty", async () => {
  const home = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "runtime-cli-"));
  assert.deepEqual(await readRuntimeCliVersionState(home), empty);
  const state = observeRuntimeCliVersions(observeRuntimeCliVersions(empty, { codex: "0.163.0" }, at, none).next, { codex: "0.151.0" }, at, none).next;
  await writeRuntimeCliVersionState(home, state);
  assert.deepEqual(await readRuntimeCliVersionState(home), state);
  assert.match(await readFile(runtimeCliVersionsPath(home), "utf8"), /"schemaVersion": 1/);
});

test("reconciler step 15 (B12): drift is one entry per runtime with the count of live processes on another version", () => {
  const live = [
    { runtime: "codex", version: "codex-cli 0.150.0" },
    { runtime: "codex", version: "codex-cli 0.150.0" },
    { runtime: "codex", version: "codex-cli 0.163.0" },
    { runtime: "claude", version: "2.1.400 (Claude Code)" },
  ];
  assert.deepEqual(runtimeCliVersionDrift(live, { codex: "codex-cli 0.163.0", claude: "2.1.301 (Claude Code)" }), [
    { runtime: "codex", from: "codex-cli 0.150.0", to: "codex-cli 0.163.0", direction: "upgrade", liveAgents: 2, fromVersions: 1 },
    { runtime: "claude", from: "2.1.400 (Claude Code)", to: "2.1.301 (Claude Code)", direction: "downgrade", liveAgents: 1, fromVersions: 1 },
  ]);
});

test("reconciler step 15 (B12): no drift when versions match or the runtime was not detected this round", () => {
  const live = [{ runtime: "codex", version: "0.163.0" }, { runtime: "kimi", version: "1.0.0" }];
  assert.deepEqual(runtimeCliVersionDrift(live, { codex: "0.163.0" }), []);
  assert.deepEqual(runtimeCliVersionDrift([], { codex: "0.163.0" }), []);
});

test("reconciler step 15 (B12): direction is unknown when processes drifted both ways or a version has no number", () => {
  const mixed = runtimeCliVersionDrift([
    { runtime: "codex", version: "0.150.0" },
    { runtime: "codex", version: "0.170.0" },
    { runtime: "codex", version: "0.170.0" },
  ], { codex: "0.163.0" });
  assert.deepEqual(mixed, [{ runtime: "codex", from: "0.170.0", to: "0.163.0", direction: "unknown", liveAgents: 3, fromVersions: 2 }]);
  assert.equal(runtimeCliVersionDrift([{ runtime: "codex", version: "dev" }], { codex: "0.163.0" })[0]?.direction, "unknown");
});
