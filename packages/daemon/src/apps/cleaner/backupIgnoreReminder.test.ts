import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES } from "../../agentMigrationExport";
import {
  CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY,
  CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED,
  CLEANER_REMINDER_LARGEST_PREFIX,
  CLEANER_REMINDER_TOP_PATHS_PREFIX,
  backupIgnoreReminderSummary,
  defaultMeasureWorkspaceDirectories,
  defaultScanWorkspaceRoot,
  largestDirectoryNames,
  namedFoldersStillMove,
  parseBackupIgnoreKeepLine,
  parsePersistedReminderState,
  readBackupIgnoreKept,
  reminderNamesSource,
  reminderSignalsCleared,
  CLEANER_PROVIDER_LIMIT_RECENT_MS,
  type CleanerReminderSignal,
  type CleanerSignalSnapshot,
} from "./backupIgnoreReminder";

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "cleaner-reminder-names-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Files of the given sizes, by workspace-relative path. */
async function makeFiles(workspace: string, files: Readonly<Record<string, number>>): Promise<void> {
  for (const [file, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), "x".repeat(bytes));
  }
}

const measure = (workspace: string, directoryNames: string[], options?: { maxEntries?: number; shouldStop?: () => boolean }) =>
  defaultMeasureWorkspaceDirectories({
    absolutePath: workspace,
    directoryNames,
    maxEntries: options?.maxEntries ?? 10_000,
    shouldStop: options?.shouldStop ?? (() => false),
  });

function snapshot(input?: { bytes?: number; files?: number; topPaths?: string[]; tooManyFiles?: boolean }): CleanerSignalSnapshot {
  return {
    disk: null,
    readiness: {
      limits: { maxBytes: 1_000, maxEntries: 1_000 },
      lastMeasured: { files: input?.files ?? 0, bytes: input?.bytes ?? 0, at: "2026-11-10T00:00:00Z", source: "packed" },
      ...(input?.topPaths
        ? {
            lastSizeFailure: {
              migrationId: "mig-1",
              at: "2026-11-10T10:00:00Z",
              code: input.tooManyFiles ? "MIGRATION_OBJECT_STORE_ENTRY_COUNT_LIMIT_EXCEEDED" : "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE",
              topPaths: input.topPaths.map((entry) => ({ path: entry, value: 1 })),
            },
          }
        : {}),
    },
    quota: undefined,
    providerLimitAtMs: null,
  };
}

const signal = (trigger: CleanerReminderSignal["trigger"]): CleanerReminderSignal => ({ trigger, urgent: false, reason: "reason." });

test("# keep: marks a top-level folder, whatever its case and spacing; anything else is not a keep line", () => {
  for (const line of [
    "# keep: work",
    "#keep:work",
    "# KEEP: work",
    "#   Keep  :   work   ",
    "# keep: ./work",
    "# keep: work/",
    "# keep: ./work//",
    "  # keep: work\r",
  ]) {
    assert.equal(parseBackupIgnoreKeepLine(line), "work", line);
  }
  assert.equal(parseBackupIgnoreKeepLine("# keep: my drafts"), "my drafts", "a name with a space is one name");
  for (const line of [`# keep: "my drafts"`, "# keep: 'my drafts'", `# keep: "./my drafts/"`, `#keep:"my drafts"  `]) {
    assert.equal(parseBackupIgnoreKeepLine(line), "my drafts", line);
  }
  // Nothing else is read into the line: the rest of it is the name, and quotes count only as a pair around all of it.
  assert.equal(parseBackupIgnoreKeepLine("# keep: work # mine"), "work # mine");
  assert.equal(parseBackupIgnoreKeepLine(`# keep: "work" # mine`), `"work" # mine`);
  assert.equal(parseBackupIgnoreKeepLine(`# keep: "work'`), `"work'`);
  for (const line of [
    "# keep: work/drafts",
    "# keep: ./work/drafts/",
    "# keep: work\\drafts",
    "keep: work",
    "work",
    "# keep",
    "# keep work",
    "# keeping: work",
    "# do keep: work",
    "# keep:",
    "# keep: /",
    "# keep: .",
    "# keep: ..",
    `# keep: ""`,
    `# keep: "work/drafts"`,
    `# keep: "./"`,
    "",
  ]) {
    assert.equal(parseBackupIgnoreKeepLine(line), null, line);
  }
});

test("kept folders are read from the two ignore files the agent writes, within the first 64 KiB of each", async () => {
  await withWorkspace(async (workspace) => {
    assert.deepEqual([...await readBackupIgnoreKept(workspace)], [], "no file: nothing is marked");
    const padding = "# padding\n".repeat(Math.ceil(AGENT_MIGRATION_TOP_LEVEL_SKIP_MAX_BYTES / 10));
    await writeFile(
      path.join(workspace, ".raftbackupignore"),
      `cache/\n# keep: drafts\n# Keep: ./keys/\n# keep: "my notes"\n# keep: nested/path\nkeep: plain\n${padding}# keep: late\n`,
    );
    // The file every Computer version reads: an agent unsure of its version uses this one.
    await writeFile(path.join(workspace, ".raftmigrateignore"), `# keep: legacy\n${padding}# keep: late-legacy\n`);
    // Raft's own file is not the agent's to mark.
    await writeFile(path.join(workspace, ".raftbackupignore.user"), "# keep: chosen\n");
    assert.deepEqual([...await readBackupIgnoreKept(workspace)].sort(), ["drafts", "keys", "legacy", "my notes"]);

    for (const dir of ["cache", "drafts", "keys", "my notes", "nested", "plain", "late", "legacy", "late-legacy", "chosen", "notes", ".raft"]) {
      await mkdir(path.join(workspace, dir));
    }
    const scan = await defaultScanWorkspaceRoot({ absolutePath: workspace, maxEntries: 100, shouldStop: () => false });
    assert.equal(scan.kind, "established");
    if (scan.kind !== "established") return;
    assert.deepEqual([...scan.directoryNames].sort(), ["chosen", "late", "late-legacy", "nested", "plain"], "kept and listed folders are no candidates");
  });
});

test("the largest folders: by what was counted, three at most; an unfinished walk does not outrank a finished larger folder", () => {
  const GIB = 1024 ** 3;
  assert.equal(CLEANER_BACKUP_IGNORE_REMINDER_MAX_NAMED, 3);
  assert.deepEqual(largestDirectoryNames([
    { name: "small", bytes: 10, entries: 1, complete: true },
    { name: "large", bytes: 900, entries: 1, complete: true },
    { name: "middle", bytes: 500, entries: 1, complete: true },
    { name: "fourth", bytes: 400, entries: 1, complete: true },
  ]), ["large", "middle", "fourth"]);
  // 40 GiB in 20 files, finished, against three repositories cut off half-counted.
  assert.deepEqual(largestDirectoryNames([
    { name: "repo-a", bytes: 300_000, entries: 60_000, complete: false },
    { name: "repo-b", bytes: 200_000, entries: 70_000, complete: false },
    { name: "repo-c", bytes: 100_000, entries: 65_000, complete: false },
    { name: "models", bytes: 40 * GIB, entries: 20, complete: true },
  ]), ["models", "repo-a", "repo-b"], "what was counted of an unfinished folder is a lower bound, and it ranks as that");
  assert.deepEqual(largestDirectoryNames([
    { name: "b", bytes: 5, entries: 1, complete: true },
    { name: "a", bytes: 5, entries: 1, complete: true },
    { name: "cut", bytes: 5, entries: 1, complete: false },
    { name: "more", bytes: 6, entries: 1, complete: true },
  ]), ["more", "cut", "a"], "equal counts: the unfinished one first, then by name");
});

test("a folder with nothing counted is never named, finished or not", () => {
  assert.deepEqual(largestDirectoryNames([
    { name: "a", bytes: 0, entries: 0, complete: false },
    { name: "b", bytes: 0, entries: 0, complete: false },
    { name: "c", bytes: 0, entries: 0, complete: true },
  ]), [], "a budget used up before the first read names nothing, not the first three by name");
  assert.deepEqual(largestDirectoryNames([
    { name: "empty", bytes: 0, entries: 0, complete: true },
    { name: "unread", bytes: 0, entries: 0, complete: false },
    { name: "b", bytes: 5, entries: 1, complete: true },
  ]), ["b"]);
  // By bytes, a folder of empty files counts nothing; by entries it does.
  const hollow = [{ name: "markers", bytes: 0, entries: 300, complete: true }];
  assert.deepEqual(largestDirectoryNames(hollow), []);
  assert.deepEqual(largestDirectoryNames(hollow, "entries"), ["markers"]);
  assert.deepEqual(largestDirectoryNames([]), []);
});

test("by entries, the folders rank by how many files and folders they hold", () => {
  const sizes = [
    { name: "models", bytes: 9_000_000, entries: 20, complete: true },
    { name: "repo", bytes: 5_000, entries: 70_000, complete: false },
    { name: "site", bytes: 100, entries: 900, complete: true },
  ];
  assert.deepEqual(largestDirectoryNames(sizes, "entries"), ["repo", "site", "models"]);
  assert.deepEqual(largestDirectoryNames(sizes, "bytes"), ["models", "repo", "site"]);
  assert.deepEqual(largestDirectoryNames(sizes), ["models", "repo", "site"]);
});

test("the size estimate counts what a move would take, never following a symlink", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, ".raftbackupignore"), "work/downloads\nwork/big.iso\n**/checkouts\n");
    await makeFiles(workspace, {
      "work/a.txt": 100,
      "work/src/deep/b.txt": 200,
      // Left out of a move at any depth: built-in names, a `**/<name>` line, exact lines.
      "work/node_modules/dep/index.js": 5_000,
      "work/src/checkouts/repo/file": 6_000,
      "work/downloads/set.bin": 7_000,
      "work/big.iso": 8_000,
      "data/one.bin": 40,
      "outside/secret.bin": 9_000,
    });
    await mkdir(path.join(workspace, "empty"));
    await symlink(path.join(workspace, "outside"), path.join(workspace, "data", "link"));
    // Entries as a move counts them: files, folders and symlinks it takes (work: a.txt, src, src/deep, src/deep/b.txt).
    assert.deepEqual(await measure(workspace, ["work", "data", "empty", "missing"]), [
      { name: "work", bytes: 300, entries: 4, complete: true },
      { name: "data", bytes: 40, entries: 2, complete: true },
      { name: "empty", bytes: 0, entries: 0, complete: true },
      { name: "missing", bytes: 0, entries: 0, complete: true },
    ]);
  });
});

test("the size estimate stops at its entry cap and at shouldStop; the folders take turns, so small ones finish", async () => {
  await withWorkspace(async (workspace) => {
    const files: Record<string, number> = { "small/a.bin": 30, "tiny/a.bin": 3 };
    // Larger than one turn (256 entries) and than the cap below.
    for (let index = 0; index < 700; index += 1) files[`huge/f-${index}.bin`] = 10;
    await makeFiles(workspace, files);

    const capped = await measure(workspace, ["huge", "small", "tiny"], { maxEntries: 400 });
    const byName = new Map(capped.map((size) => [size.name, size]));
    assert.deepEqual(byName.get("small"), { name: "small", bytes: 30, entries: 1, complete: true }, "huge did not use up the budget before small had its turn");
    assert.deepEqual(byName.get("tiny"), { name: "tiny", bytes: 3, entries: 1, complete: true });
    const huge = byName.get("huge")!;
    assert.equal(huge.complete, false);
    assert.ok(huge.bytes > 30 && huge.bytes <= 4_000, `${huge.bytes} bytes counted of 7000`);
    assert.equal(huge.bytes, huge.entries * 10, "every entry counted was sized");
    assert.deepEqual(largestDirectoryNames(capped), ["huge", "small", "tiny"], "by what was counted of each");

    const stopped = await measure(workspace, ["huge", "small"], { shouldStop: () => true });
    assert.deepEqual(stopped, [
      { name: "huge", bytes: 0, entries: 0, complete: false },
      { name: "small", bytes: 0, entries: 0, complete: false },
    ], "told to stop before the first read: nothing is counted and nothing is finished");
    assert.deepEqual(largestDirectoryNames(stopped), [], "and nothing is named");

    const full = await measure(workspace, ["huge", "small", "tiny"]);
    assert.deepEqual(full, [
      { name: "huge", bytes: 7_000, entries: 700, complete: true },
      { name: "small", bytes: 30, entries: 1, complete: true },
      { name: "tiny", bytes: 3, entries: 1, complete: true },
    ]);
  });
});

test("a reminder names something only when size is its reason", () => {
  assert.deepEqual(reminderNamesSource([], snapshot(), false), { kind: "none" }, "far from every limit");
  assert.deepEqual(reminderNamesSource([signal("provider_limit"), signal("provider_quota")], snapshot({ bytes: 499 }), false), { kind: "none" });
  assert.deepEqual(reminderNamesSource([], snapshot({ bytes: 499, topPaths: ["datasets"] }), false), { kind: "none" }, "a failure already reminded of, far from the limits again");

  const byBytes = { kind: "largest", by: "bytes" };
  assert.deepEqual(reminderNamesSource([], snapshot({ bytes: 500 }), false), byBytes, "at half a limit, also without a new signal");
  assert.deepEqual(reminderNamesSource([signal("disk_low")], snapshot(), false), byBytes);
  assert.deepEqual(reminderNamesSource([], snapshot(), true), byBytes, "the merged workspace tip says the disk is low");
  assert.deepEqual(reminderNamesSource([signal("size_failure")], snapshot(), false), byBytes, "a failure that reported no paths");
});

test("the largest folders are those with the most entries when the file count is the reason", () => {
  const byBytes = { kind: "largest", by: "bytes" };
  const byEntries = { kind: "largest", by: "entries" };
  assert.deepEqual(reminderNamesSource([], snapshot({ bytes: 100, files: 600 }), false), byEntries, "nearer the file-count limit");
  assert.deepEqual(reminderNamesSource([signal("readiness_band"), signal("disk_low")], snapshot({ bytes: 100, files: 600 }), true), byEntries);
  assert.deepEqual(reminderNamesSource([], snapshot({ bytes: 700, files: 600 }), false), byBytes, "nearer the size limit");
  assert.deepEqual(reminderNamesSource([signal("disk_low")], snapshot({ bytes: 100, files: 400 }), false), byBytes, "under half of both: low disk alone is about bytes");
  // A new failure says which limit it was, whatever the last measurement reads; one already reminded of does not.
  const tooManyFiles = snapshot({ bytes: 900, files: 100, topPaths: [], tooManyFiles: true });
  assert.deepEqual(reminderNamesSource([signal("size_failure")], tooManyFiles, false), byEntries);
  assert.deepEqual(reminderNamesSource([], tooManyFiles, false), byBytes);
  assert.deepEqual(reminderNamesSource([signal("size_failure")], snapshot({ bytes: 100, files: 900, topPaths: [] }), false), byBytes, "a new failure for its size");
});

test("the Server's largest paths of a failed move are named for a new failure or a workspace newly close to a limit", () => {
  const failed = snapshot({ bytes: 1_200, topPaths: ["datasets", "repo/.git"] });
  assert.deepEqual(reminderNamesSource([signal("size_failure")], failed, false), { kind: "top_paths", paths: ["datasets", "repo/.git"] });
  assert.deepEqual(reminderNamesSource([signal("readiness_band")], failed, false), { kind: "top_paths", paths: ["datasets", "repo/.git"] });
  assert.deepEqual(reminderNamesSource([signal("size_failure"), signal("disk_low")], failed, true), { kind: "top_paths", paths: ["datasets", "repo/.git"] });
  // Not new, or only over half: measured here instead.
  assert.deepEqual(reminderNamesSource([], failed, false), { kind: "largest", by: "bytes" });
  assert.deepEqual(reminderNamesSource([signal("readiness_band")], snapshot({ bytes: 600, topPaths: ["datasets"] }), false), { kind: "largest", by: "bytes" });
});

test("the summary names three at most and never counts the rest", () => {
  const names = { prefix: CLEANER_REMINDER_LARGEST_PREFIX, items: ["work/", "data/", "cache/", "fourth/", "fifth/"] };
  assert.deepEqual(backupIgnoreReminderSummary([], names), {
    summary: "Largest folders that still move: work/, data/, cache/.",
    namedCount: 3,
  });
  assert.deepEqual(backupIgnoreReminderSummary(["Disk is low (1.0 GiB free)."], { ...names, items: ["work/"] }), {
    summary: "Disk is low (1.0 GiB free). Largest folders that still move: work/.",
    namedCount: 1,
  });
});

test("the names shown are always the first of the ranked list: one that does not fit ends them", () => {
  const long = `${"x".repeat(200)}/`;
  for (const prefix of [CLEANER_REMINDER_LARGEST_PREFIX, CLEANER_REMINDER_TOP_PATHS_PREFIX]) {
    // The largest does not fit: no names at all, never the second and third in its place.
    assert.deepEqual(backupIgnoreReminderSummary([], { prefix, items: [long, "data/", "cache/"] }), {
      summary: CLEANER_BACKUP_IGNORE_REMINDER_GENERIC_SUMMARY,
      namedCount: 0,
    }, prefix);
    assert.deepEqual(backupIgnoreReminderSummary(["Disk is low (1.0 GiB free)."], { prefix, items: [long, "data/", "cache/"] }), {
      summary: "Disk is low (1.0 GiB free).",
      namedCount: 0,
    }, prefix);
    // The second does not fit: the first alone, not the first and the third.
    assert.deepEqual(backupIgnoreReminderSummary([], { prefix, items: ["work/", long, "cache/"] }), {
      summary: `${prefix}work/.`,
      namedCount: 1,
    }, prefix);
    // A name with a control character ends them the same way.
    assert.deepEqual(backupIgnoreReminderSummary([], { prefix, items: ["work/", "bad\u0007name/", "cache/"] }), {
      summary: `${prefix}work/.`,
      namedCount: 1,
    }, prefix);
    assert.deepEqual(backupIgnoreReminderSummary([], { prefix, items: ["bad\u0007name/", "work/"] }).namedCount, 0, prefix);
  }
});

test("a persisted state parses whatever an earlier version kept in names, and always carries names: null", () => {
  const signals = {
    diskLowFreeBytes: 9,
    diskCritical: false,
    readinessBand: 1,
    sizeFailureMigrationIds: ["mig-1"],
    quotaState: "ok",
    providerLimitAtMs: null,
  };
  const expected = { version: 1, lastReminderAtMs: 5, stamp: { mtimeMs: 1, size: 2 }, signals, names: null };
  for (const names of [["data", "models"], null, 7, undefined]) {
    assert.deepEqual(
      parsePersistedReminderState({ version: 1, lastReminderAtMs: 5, stamp: { mtimeMs: 1, size: 2 }, signals, names, lastScanAtMs: 3 }),
      expected,
      JSON.stringify(names),
    );
  }
  assert.equal(parsePersistedReminderState({ version: 1, signals: { ...signals, readinessBand: 9 }, names: null }), null, "what it does keep is still checked");
});

// ── Withdrawal of a presented reminder ──────────────────────────────────────

const READY_LIMITS = { maxBytes: 1_000, maxEntries: 1_000 };
const measured = (bytes: number) => ({ files: 0, bytes, at: "2026-11-10T00:00:00Z", source: "packed" as const });
const quiet: CleanerSignalSnapshot = { disk: null, readiness: null, quota: undefined, providerLimitAtMs: null };

test("reminderSignalsCleared: each signal is gone only when it was measured gone; a plain baseline never is", () => {
  const now = 10 * CLEANER_PROVIDER_LIMIT_RECENT_MS;
  assert.equal(reminderSignalsCleared([], quiet, now), false, "sent for no signal: nothing to clear");

  const low = { availableBytes: 9, totalBytes: 100 };
  const fine = { availableBytes: 50, totalBytes: 100 };
  assert.equal(reminderSignalsCleared(["disk_low"], { ...quiet, disk: low }, now), false);
  assert.equal(reminderSignalsCleared(["disk_low"], quiet, now), false, "no disk measurement");
  assert.equal(reminderSignalsCleared(["disk_low"], { ...quiet, disk: fine }, now), true);

  const over = { limits: READY_LIMITS, lastMeasured: measured(600) };
  const under = { limits: READY_LIMITS, lastMeasured: measured(100) };
  assert.equal(reminderSignalsCleared(["readiness_band"], { ...quiet, readiness: over }, now), false);
  assert.equal(reminderSignalsCleared(["readiness_band"], quiet, now), false, "no readiness from the Server");
  assert.equal(reminderSignalsCleared(["readiness_band"], { ...quiet, readiness: { limits: READY_LIMITS } }, now), false, "no measurement");
  assert.equal(reminderSignalsCleared(["readiness_band"], { ...quiet, readiness: under }, now), true);

  const failed = { ...under, lastSizeFailure: { migrationId: "mig-1", at: "2026-11-10T10:00:00Z", code: "MIGRATION_OBJECT_STORE_BUNDLE_TOO_LARGE" as const, topPaths: [] } };
  assert.equal(reminderSignalsCleared(["size_failure"], { ...quiet, readiness: failed }, now), false);
  assert.equal(reminderSignalsCleared(["size_failure"], quiet, now), false);
  assert.equal(reminderSignalsCleared(["size_failure"], { ...quiet, readiness: under }, now), true);

  assert.equal(reminderSignalsCleared(["provider_quota"], { ...quiet, quota: { state: "warning" } }, now), false);
  assert.equal(reminderSignalsCleared(["provider_quota"], quiet, now), false, "no reading");
  assert.equal(reminderSignalsCleared(["provider_quota"], { ...quiet, quota: { state: "ok" } }, now), true);

  assert.equal(reminderSignalsCleared(["provider_limit"], { ...quiet, providerLimitAtMs: now - 1 }, now), false);
  assert.equal(reminderSignalsCleared(["provider_limit"], { ...quiet, providerLimitAtMs: now - CLEANER_PROVIDER_LIMIT_RECENT_MS }, now), true);

  // Every one of them, not any.
  assert.equal(reminderSignalsCleared(["disk_low", "readiness_band"], { ...quiet, disk: fine, readiness: over }, now), false);
  assert.equal(reminderSignalsCleared(["disk_low", "readiness_band"], { ...quiet, disk: fine, readiness: under }, now), true);
});

test("namedFoldersStillMove: false only when each named folder is ignored, marked kept or gone", async () => {
  await withWorkspace(async (workspace) => {
    await makeFiles(workspace, { "data/a.bin": 10, "models/b.bin": 10, "drafts/c.txt": 10, "plain.txt": 1 });
    assert.equal(await namedFoldersStillMove(workspace, ["data", "models", "drafts"]), true);

    await writeFile(path.join(workspace, ".raftbackupignore"), "data/\n**/models\n");
    assert.equal(await namedFoldersStillMove(workspace, ["data", "models"]), false, "both skipped by the ignore file");
    assert.equal(await namedFoldersStillMove(workspace, ["data", "models", "drafts"]), true, "one still moves");

    await writeFile(path.join(workspace, ".raftmigrateignore"), "# keep: drafts\n");
    assert.equal(await namedFoldersStillMove(workspace, ["data", "models", "drafts"]), false, "the third is marked kept");

    assert.equal(await namedFoldersStillMove(workspace, ["gone"]), false, "no longer there");
    assert.equal(await namedFoldersStillMove(workspace, ["plain.txt"]), false, "no longer a folder");
    assert.equal(await namedFoldersStillMove(workspace, []), false);
  });
});
