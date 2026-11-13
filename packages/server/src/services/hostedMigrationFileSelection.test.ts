import assert from "node:assert/strict";
import { test } from "vitest";
import {
  classifyHostedImportEntry,
  isHostedImportText,
  selectHostedImportFiles,
  summarizeHostedImport,
} from "./hostedMigrationFileSelection";

const limits = { maxTotalBytes: 100, maxFiles: 3, maxFileBytes: 50 };
const file = (path: string, sizeBytes = 1) => ({ type: "file" as const, path, sizeBytes });

test("entries the provider can never take are classified from metadata alone", () => {
  const cases: Array<[Parameters<typeof classifyHostedImportEntry>[0], string | null]> = [
    [file("MEMORY.md"), null],
    [file("notes/plan.md"), null],
    [file("src/app.ts"), null],
    [{ type: "symlink", path: "link" }, "symlink"],
    [file("repo/.git/config"), "git"],
    [file(".git/HEAD"), "git"],
    [file(".raft/activity/log"), "raft_state"],
    [file(".raft-migration/commit-v1.json"), "raft_state"],
    [file(".raftmigrateignore"), "raft_state"],
    [file(".raftbackupignore"), "raft_state"],
    [file(".raftbackupignore.user"), "raft_state"],
    [file("notes/.raftbackupignore"), null],
    [file(".agents/skills/x.md"), "path_rule"],
    [file("notes/with space.md"), "path_rule"],
    [file("notes/naïve.md"), "path_rule"],
    [file(`notes/${"a".repeat(130)}`), "path_rule"],
    [file("memory"), "reserved"],
    [file("journal"), "reserved"],
    [file("notes/memory"), null],
    [file("big.log", 51), "file_too_large"],
  ];
  for (const [entry, reason] of cases) {
    assert.equal(classifyHostedImportEntry(entry, limits), reason, entry.path);
  }
});

test("the budget fills MEMORY.md first, then notes, then the rest by path, first fit", () => {
  const { selected, overBudget } = selectHostedImportFiles([
    { path: "zeta.md", sizeBytes: 10 },
    { path: "notes/b.md", sizeBytes: 40 },
    { path: "alpha.md", sizeBytes: 60 },
    { path: "MEMORY.md", sizeBytes: 30 },
    { path: "beta.md", sizeBytes: 10 },
  ], limits);
  // 30 + 40 = 70; alpha (60) does not fit, beta (10) does, then the 3-file cap stops zeta.
  assert.deepEqual(selected.map((f) => f.path), ["MEMORY.md", "notes/b.md", "beta.md"]);
  assert.deepEqual(overBudget.map((f) => f.path), ["alpha.md", "zeta.md"]);
});

test("selection does not depend on the order entries arrive in", () => {
  const files = [
    { path: "b.md", sizeBytes: 5 }, { path: "MEMORY.md", sizeBytes: 5 }, { path: "notes/a.md", sizeBytes: 5 }, { path: "a.md", sizeBytes: 5 },
  ];
  const forward = selectHostedImportFiles(files, limits);
  const backward = selectHostedImportFiles([...files].reverse(), limits);
  assert.deepEqual(forward, backward);
});

test("text means UTF-8 without NUL", () => {
  assert.equal(isHostedImportText(Buffer.from("plain ✓ text")), true);
  assert.equal(isHostedImportText(Buffer.from([0x61, 0x00, 0x62])), false);
  assert.equal(isHostedImportText(Buffer.from([0xff, 0xfe, 0x41])), false);
});

test("the summary groups skips by reason with the largest paths first, bounded", () => {
  const summary = summarizeHostedImport({
    imported: [{ path: "MEMORY.md", sizeBytes: 7 }],
    skipped: [
      { path: "a.bin", sizeBytes: 3, reason: "not_text" },
      { path: "repo/.git/x", sizeBytes: 9, reason: "git" },
      { path: "b.bin", sizeBytes: 8, reason: "not_text" },
    ],
  });
  assert.deepEqual(summary, {
    importedFileCount: 1,
    importedBytes: 7,
    skipped: [
      { reason: "git", count: 1, bytes: 9, largestPaths: ["repo/.git/x"] },
      { reason: "not_text", count: 2, bytes: 11, largestPaths: ["b.bin", "a.bin"] },
    ],
  });
});
