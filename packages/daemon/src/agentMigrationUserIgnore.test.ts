import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMigrationUserIgnoreAdditions } from "@botiverse/raft-shared";
import { listAgentMigrationWorkspace } from "./agentMigrationExport";
import {
  AgentMigrationUserIgnoreWriteError,
  writeAgentMigrationUserIgnoreAdditions,
} from "./agentMigrationUserIgnore";

const NOW = new Date("2026-11-05T10:00:00.000Z");
const USER_FILE = ".raftbackupignore.user";

function withWorkspace(run: (workspace: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agent-migration-user-ignore-"));
    const workspace = path.join(root, "agent");
    mkdirSync(workspace);
    try {
      await run(workspace);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function write(workspace: string, additions: Partial<AgentMigrationUserIgnoreAdditions> & Pick<AgentMigrationUserIgnoreAdditions, "paths">) {
  return writeAgentMigrationUserIgnoreAdditions({
    workspacePath: workspace,
    lease: {
      role: "source",
      userIgnoreAdditions: { addedBy: "Alice", addedAt: "2026-11-04T08:30:00Z", ...additions },
    },
    now: NOW,
  });
}

async function rejectsWith(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AgentMigrationUserIgnoreWriteError);
    assert.equal(err.reason, reason);
    assert.equal(err.message, `MIGRATION_USER_IGNORE_WRITE_FAILED:${reason}`);
    return true;
  });
}

function readUserFile(workspace: string): string {
  return readFileSync(path.join(workspace, USER_FILE), "utf8");
}

test("appends the paths in the reader's form under one comment line, after the existing content", withWorkspace(async (workspace) => {
  writeFileSync(path.join(workspace, USER_FILE), "old");
  const outcome = await write(workspace, { paths: ["./data/raw/", "**/fixtures", "logs"] });
  assert.deepEqual(outcome, { receipt: { written: 3, alreadyPresent: 0, rejected: [] }, rejectedCount: 0 });
  assert.equal(
    readUserFile(workspace),
    "old\n\n# added by Alice at 2026-11-04T08:30:00.000Z (Raft)\ndata/raw\n**/fixtures\nlogs\n",
  );
}));

test("a new file starts with the comment; an unparseable addedAt is now", withWorkspace(async (workspace) => {
  await write(workspace, { paths: ["logs"], addedAt: "yesterday-ish" });
  assert.equal(readUserFile(workspace), "# added by Alice at 2026-11-05T10:00:00.000Z (Raft)\nlogs\n");
}));

test("a re-sent lease writes nothing: every line is already present", withWorkspace(async (workspace) => {
  await write(workspace, { paths: ["logs", "**/fixtures"] });
  const before = readUserFile(workspace);
  const mtime = statSync(path.join(workspace, USER_FILE)).mtimeMs;
  // Same lines in another spelling still match after the reader's normalization.
  const outcome = await write(workspace, { paths: ["./logs/", "**/fixtures/"] });
  assert.deepEqual(outcome, { receipt: { written: 0, alreadyPresent: 2, rejected: [] }, rejectedCount: 0 });
  assert.equal(readUserFile(workspace), before);
  assert.equal(statSync(path.join(workspace, USER_FILE)).mtimeMs, mtime);
}));

test("only the new lines are written when some are already present, and duplicates in one lease count once", withWorkspace(async (workspace) => {
  writeFileSync(path.join(workspace, USER_FILE), "logs\n");
  const outcome = await write(workspace, { paths: ["logs", "data", "data"] });
  assert.deepEqual(outcome?.receipt, { written: 1, alreadyPresent: 2, rejected: [] });
  assert.equal(readUserFile(workspace), "logs\n\n# added by Alice at 2026-11-04T08:30:00.000Z (Raft)\ndata\n");
}));

test("addedBy cannot add a rule: control characters and line breaks are dropped, and it is capped", withWorkspace(async (workspace) => {
  mkdirSync(path.join(workspace, "src"));
  writeFileSync(path.join(workspace, "src", "main.ts"), "x");
  await write(workspace, { paths: ["logs"], addedBy: "Mallory\n**/src\r\u2028\t" });
  const lines = readUserFile(workspace).split("\n");
  assert.deepEqual(lines, ["# added by Mallory**/src at 2026-11-04T08:30:00.000Z (Raft)", "logs", ""]);
  const listing = await listAgentMigrationWorkspace({ workspacePath: workspace, onEntry: () => undefined });
  assert.deepEqual(listing.excludedIgnored.map((entry) => entry.path), [], "src still moves");

  rmSync(path.join(workspace, USER_FILE));
  await write(workspace, { paths: ["logs"], addedBy: ` ${"n".repeat(100)} ` });
  assert.match(readUserFile(workspace), new RegExp(`^# added by ${"n".repeat(64)} at `));
  rmSync(path.join(workspace, USER_FILE));
  await write(workspace, { paths: ["logs"], addedBy: "\n\t " });
  assert.match(readUserFile(workspace), /^# added by someone at /);
}));

test("paths that always move and lines the reader would not apply are rejected, the rest written", withWorkspace(async (workspace) => {
  const outcome = await write(workspace, {
    paths: [
      "MEMORY.md",
      ".raftbackupignore",
      ".raftmigrateignore",
      ".raftbackupignore.user",
      ".raft",
      ".raft/activity",
      "../outside",
      path.join(workspace, "logs"),
      "*.log",
      "a/**/b",
      "**/node_modules",
      "# comment",
      "",
      "logs\n**/src",
      "keep-me",
    ],
  });
  assert.equal(outcome?.receipt.written, 1);
  assert.equal(outcome?.rejectedCount, 14);
  assert.deepEqual(outcome?.receipt.rejected, [
    { path: "MEMORY.md", reason: "forced_keep" },
    { path: ".raftbackupignore", reason: "forced_keep" },
    { path: ".raftmigrateignore", reason: "forced_keep" },
    { path: ".raftbackupignore.user", reason: "forced_keep" },
    { path: ".raft", reason: "forced_keep" },
    { path: ".raft/activity", reason: "forced_keep" },
    { path: "../outside", reason: "invalid_line" },
    { path: path.join(workspace, "logs"), reason: "invalid_line" },
    { path: "*.log", reason: "invalid_line" },
    { path: "a/**/b", reason: "invalid_line" },
    { path: "**/node_modules", reason: "invalid_line" },
    { path: "# comment", reason: "invalid_line" },
    { path: "", reason: "invalid_line" },
    { path: "logs\n**/src", reason: "invalid_line" },
  ]);
  assert.equal(readUserFile(workspace), "# added by Alice at 2026-11-04T08:30:00.000Z (Raft)\nkeep-me\n");
}));

test("a path that would be written as a comment line is rejected, so the receipt never claims an unapplied rule", withWorkspace(async (workspace) => {
  const outcome = await write(workspace, { paths: ["./#notes", "a/../#draft", "notes/#1"] });
  assert.deepEqual(outcome?.receipt, {
    written: 1,
    alreadyPresent: 0,
    rejected: [
      { path: "./#notes", reason: "invalid_line" },
      { path: "a/../#draft", reason: "invalid_line" },
    ],
  });
  assert.equal(readUserFile(workspace), "# added by Alice at 2026-11-04T08:30:00.000Z (Raft)\nnotes/#1\n");
  // Re-sent: nothing new is written.
  const again = await write(workspace, { paths: ["./#notes", "notes/#1"] });
  assert.deepEqual(again?.receipt, { written: 0, alreadyPresent: 1, rejected: [{ path: "./#notes", reason: "invalid_line" }] });
}));

test("the receipt lists at most 20 rejected paths but counts them all", withWorkspace(async (workspace) => {
  const outcome = await write(workspace, { paths: [...Array.from({ length: 25 }, (_, i) => `bad-${i}/*`), "ok"] });
  assert.equal(outcome?.receipt.rejected.length, 20);
  assert.equal(outcome?.rejectedCount, 25);
}));

test("every path rejected fails all_rejected and writes nothing", withWorkspace(async (workspace) => {
  await rejectsWith(write(workspace, { paths: ["MEMORY.md", "*.log"] }), "all_rejected");
  assert.throws(() => statSync(path.join(workspace, USER_FILE)));
}));

test("nothing to write: no field, an empty list, or a target lease", withWorkspace(async (workspace) => {
  assert.equal(await writeAgentMigrationUserIgnoreAdditions({ workspacePath: workspace, lease: { role: "source" }, now: NOW }), null);
  assert.equal(await write(workspace, { paths: [] }), null);
  assert.equal(await writeAgentMigrationUserIgnoreAdditions({
    workspacePath: workspace,
    lease: { role: "target", userIgnoreAdditions: { paths: ["logs"], addedBy: "A", addedAt: "" } },
    now: NOW,
  }), null);
  assert.throws(() => statSync(path.join(workspace, USER_FILE)));
}));

test("a malformed field on a source lease fails invalid", withWorkspace(async (workspace) => {
  await rejectsWith(writeAgentMigrationUserIgnoreAdditions({
    workspacePath: workspace,
    lease: { role: "source", userIgnoreAdditions: { paths: "logs", addedBy: "A", addedAt: "" } as never },
    now: NOW,
  }), "invalid");
}));

test("a symlinked .raftbackupignore.user fails symlink and its target is untouched", withWorkspace(async (workspace) => {
  const target = path.join(path.dirname(workspace), "elsewhere.txt");
  writeFileSync(target, "outside\n");
  symlinkSync(target, path.join(workspace, USER_FILE));
  await rejectsWith(write(workspace, { paths: ["logs"] }), "symlink");
  assert.equal(readFileSync(target, "utf8"), "outside\n");
}));

test("a directory at .raftbackupignore.user fails not_regular_file", withWorkspace(async (workspace) => {
  mkdirSync(path.join(workspace, USER_FILE));
  await rejectsWith(write(workspace, { paths: ["logs"] }), "not_regular_file");
}));

test("the export afterwards leaves the written paths behind, attributed to the user file", withWorkspace(async (workspace) => {
  for (const file of ["MEMORY.md", "keep.txt", "data/raw/a.bin", "x/fixtures/f.json", "y/fixtures/g.json"]) {
    mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    writeFileSync(path.join(workspace, file), "content");
  }
  await write(workspace, { paths: ["data/raw", "**/fixtures"] });
  const listed: string[] = [];
  const listing = await listAgentMigrationWorkspace({ workspacePath: workspace, onEntry: (entry) => { listed.push(entry); } });
  assert.deepEqual(listed.sort(), [USER_FILE, "MEMORY.md", "keep.txt"].sort());
  assert.deepEqual(
    listing.excludedIgnored.map(({ path: entry, source, wildcard }) => ({ entry, source, wildcard })),
    [
      { entry: "data/raw", source: "userFile", wildcard: false },
      { entry: "x/fixtures", source: "userFile", wildcard: true },
      { entry: "y/fixtures", source: "userFile", wildcard: true },
    ],
  );
}));
