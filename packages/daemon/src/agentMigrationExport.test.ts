import assert from "node:assert/strict";
import { MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT } from "@botiverse/raft-shared";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  listAgentMigrationWorkspace,
  normalizeAgentMigrationSymlinkTarget,
  summarizeAgentMigrationTransfer,
} from "./agentMigrationExport";

function tempRoot(): string {
  return path.join(os.tmpdir(), `agent-migration-export-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function listWorkspace(workspacePath: string) {
  const listed: string[] = [];
  const listing = await listAgentMigrationWorkspace({
    workspacePath,
    onEntry: (relativePath) => {
      listed.push(relativePath);
    },
  });
  return { listed, ...listing };
}

function summarize(excluded: Awaited<ReturnType<typeof listWorkspace>>, input: {
  includedFileCount?: number;
  includedBytes?: number;
  memoryMdPresent?: boolean;
  notesPresent?: boolean;
} = {}) {
  return summarizeAgentMigrationTransfer({
    includedFileCount: input.includedFileCount ?? excluded.listed.length,
    includedBytes: input.includedBytes ?? 0,
    memoryMdPresent: input.memoryMdPresent ?? false,
    notesPresent: input.notesPresent ?? false,
    excludedRegenerable: excluded.excludedRegenerable,
    excludedIgnored: excluded.excludedIgnored,
  });
}

test("migration export includes unknown workspace files by default and excludes only regenerable dirs", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-1");
  try {
    mkdirSync(path.join(workspace, "node_modules", "leftpad"), { recursive: true });
    mkdirSync(path.join(workspace, "target"), { recursive: true });
    mkdirSync(path.join(workspace, ".venv"), { recursive: true });
    mkdirSync(path.join(workspace, "dist"), { recursive: true });
    mkdirSync(path.join(workspace, "__pycache__"), { recursive: true });
    mkdirSync(path.join(workspace, "build"), { recursive: true });
    writeFileSync(path.join(workspace, "README.md"), "important notes\n");
    writeFileSync(path.join(workspace, ".gitignore"), ".env\nbuild\n");
    writeFileSync(path.join(workspace, ".env"), "OPENAI_API_KEY=sk-test-secret\nNORMAL=value\n");
    writeFileSync(path.join(workspace, "node_modules", "leftpad", "index.js"), "regenerated\n");
    writeFileSync(path.join(workspace, "target", "artifact"), "regenerated\n");
    writeFileSync(path.join(workspace, ".venv", "pyvenv.cfg"), "regenerated\n");
    writeFileSync(path.join(workspace, "dist", "bundle.js"), "regenerated\n");
    writeFileSync(path.join(workspace, "__pycache__", "module.pyc"), "regenerated\n");
    writeFileSync(path.join(workspace, "build", "artifact.txt"), "not on daemon whitelist\n");

    const listing = await listWorkspace(workspace);

    assert.deepEqual([...listing.listed].sort((x, y) => x.localeCompare(y)), [
      ".env",
      ".gitignore",
      "build/artifact.txt",
      "README.md",
    ]);
    assert.deepEqual(listing.excludedRegenerable.map((entry) => entry.path), [
      "__pycache__",
      ".venv",
      "dist",
      "node_modules",
      "target",
    ]);
    assert.deepEqual(summarize(listing).excludedRegenerableByCategory, {
      thirdPartyDependencies: 2,
      caches: 1,
      buildArtifacts: 2,
      otherRegenerable: 0,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreadable directories are recorded as unreachable by the workspace listing", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-unreachable");
  const unreadableDir = path.join(workspace, "private-dir");
  try {
    mkdirSync(unreadableDir, { recursive: true });
    writeFileSync(path.join(workspace, "notes.md"), "ok\n");
    chmodSync(unreadableDir, 0o000);

    const listed: string[] = [];
    const listing = await listAgentMigrationWorkspace({
      workspacePath: workspace,
      onEntry: (relativePath) => {
        listed.push(relativePath);
      },
    });

    assert.deepEqual(listed, ["notes.md"]);
    assert.deepEqual(listing.unreachable.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })), [
      { path: "private-dir", reason: "read_error" },
    ]);
  } finally {
    try {
      chmodSync(unreadableDir, 0o700);
    } catch {
      // Directory may not exist if setup failed early.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("symlink target normalization rejects foreign roots, NUL, and workspace escape on every host", () => {
  for (const target of [
    "/Users/alice/source-local-secret",
    "C:\\Users\\alice\\source-local-secret",
    "C:source-local-secret",
    "\\\\server\\share\\source-local-secret",
    "target\0secret",
    "../../source-local-secret",
  ]) {
    assert.throws(
      () => normalizeAgentMigrationSymlinkTarget("nested/link", target),
      /MIGRATION_OBJECT_STORE_UNSAFE_LINK/,
      target,
    );
  }
  assert.equal(
    normalizeAgentMigrationSymlinkTarget("nested/link", "peer\\target-file"),
    "peer/target-file",
  );
  assert.equal(
    normalizeAgentMigrationSymlinkTarget("nested/link", "../target-file"),
    "../target-file",
  );
});

test("common framework build outputs and tool caches are summarized as regenerable, by category", () => {
  const summary = summarizeAgentMigrationTransfer({
    includedFileCount: 0,
    includedBytes: 0,
    memoryMdPresent: false,
    notesPresent: false,
    excludedRegenerable: [
      { path: "web/.next" },
      { path: "py/.mypy_cache" },
      { path: "py/.pytest_cache" },
      { path: "infra/.terraform" },
      { path: "app/.turbo" },
    ] as never,
  });
  assert.deepEqual(summary.excludedRegenerableByCategory, {
    thirdPartyDependencies: 1,
    caches: 3,
    buildArtifacts: 1,
    otherRegenerable: 0,
  });
});

test(".raftmigrateignore excludes listed paths with their size, but never MEMORY.md or the ignore file", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-ignore");
  try {
    mkdirSync(path.join(workspace, "datasets", "raw"), { recursive: true });
    mkdirSync(path.join(workspace, "notes"), { recursive: true });
    writeFileSync(path.join(workspace, "MEMORY.md"), "memory\n");
    writeFileSync(path.join(workspace, "notes", "domain.md"), "domain\n");
    writeFileSync(path.join(workspace, "datasets", "a.csv"), "x".repeat(300));
    writeFileSync(path.join(workspace, "datasets", "raw", "b.csv"), "y".repeat(700));
    writeFileSync(path.join(workspace, "cache.sqlite"), "z".repeat(50));
    writeFileSync(path.join(workspace, "keep.txt"), "keep\n");
    writeFileSync(path.join(workspace, ".raftmigrateignore"), [
      "# re-downloadable",
      "./datasets/",
      "cache.sqlite",
      "MEMORY.md",
      ".raftmigrateignore",
      "*.log",
      "../outside",
      "",
    ].join("\n"));

    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [".raftmigrateignore", "MEMORY.md", "keep.txt", "notes/domain.md"]);
    assert.deepEqual(listing.excludedIgnored, [
      { path: "cache.sqlite", reason: "raftmigrateignore", source: "legacyFile", wildcard: false, fileCount: 1, sizeBytes: 50 },
      { path: "datasets", reason: "raftmigrateignore", source: "legacyFile", wildcard: false, fileCount: 2, sizeBytes: 1000 },
    ]);

    const summary = summarize(listing);
    assert.deepEqual(summary.excludedIgnored, {
      count: 2,
      fileCount: 3,
      bytes: 1050,
      largest: [{ path: "datasets", bytes: 1000 }, { path: "cache.sqlite", bytes: 50 }],
    });
    assert.equal(JSON.stringify(summary).includes(workspace), false);
    // Without the Server's capability the summary is exactly the old one.
    assert.equal("excludedIgnoredBySource" in summary, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measuring ignored paths stops at one shared bound, while every ignored file stays excluded", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-ignore-bound");
  try {
    for (const dir of ["a", "b"]) {
      mkdirSync(path.join(workspace, dir), { recursive: true });
      // Each source alone holds more than half the bound (Tenny).
      for (let i = 0; i < 8; i += 1) writeFileSync(path.join(workspace, dir, `f${i}`), "x");
    }
    writeFileSync(path.join(workspace, "keep.txt"), "keep\n");
    writeFileSync(path.join(workspace, ".raftmigrateignore"), "a/\nb/\n");
    const listed: string[] = [];
    const listing = await listAgentMigrationWorkspace({
      workspacePath: workspace,
      onEntry: (relativePath) => { listed.push(relativePath); },
      ignoredFileMeasureLimit: 10,
    });
    // Only the measuring stops: nothing under a/ or b/ is listed for the bundle.
    assert.deepEqual([...listed].sort(), [".raftmigrateignore", "keep.txt"]);
    const counted = listing.excludedIgnored.reduce((total, entry) => total + entry.fileCount, 0);
    assert.equal(counted, 10, "one total across both paths, not 10 each");
    assert.deepEqual(listing.excludedIgnored.map((entry) => entry.path), ["a", "b"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the summary never reports more ignored files than its bound, so a strict server still accepts it", () => {
  const summary = summarizeAgentMigrationTransfer({
    includedFileCount: 1,
    includedBytes: 0,
    memoryMdPresent: true,
    notesPresent: false,
    excludedRegenerable: [],
    excludedIgnored: [
      { path: "a", reason: "raftmigrateignore", fileCount: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT - 1, sizeBytes: 1 },
      { path: "b", reason: "raftmigrateignore", fileCount: 5, sizeBytes: 1 },
    ],
  });
  assert.equal(summary.excludedIgnored?.fileCount, MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT);
});

test(".raftmigrateignore never excludes .raft/activity, its parents, or anything inside it", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-ignore-activity");
  try {
    mkdirSync(path.join(workspace, ".raft", "activity"), { recursive: true });
    mkdirSync(path.join(workspace, ".raft", "scratch"), { recursive: true });
    writeFileSync(path.join(workspace, ".raft", "activity", "1-1-s.jsonl"), "{}\n");
    writeFileSync(path.join(workspace, ".raft", "scratch", "tmp.bin"), "x".repeat(10));
    writeFileSync(path.join(workspace, ".raftmigrateignore"), [
      ".raft",
      "./.raft/activity/",
      ".raft/activity/1-1-s.jsonl",
      ".raft/scratch",
      ".raft/activity-old",
      "",
    ].join("\n"));

    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [".raft/activity/1-1-s.jsonl", ".raftmigrateignore"]);
    assert.deepEqual(listing.excludedIgnored, [
      { path: ".raft/scratch", reason: "raftmigrateignore", source: "legacyFile", wildcard: false, fileCount: 1, sizeBytes: 10 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a summary without ignored paths omits excludedIgnored so older servers still accept it", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-no-ignore");
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "MEMORY.md"), "memory\n");
    const listing = await listWorkspace(workspace);
    assert.deepEqual(listing.excludedIgnored, []);
    assert.equal("excludedIgnored" in summarize(listing), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function writeTree(workspace: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(workspace, relativePath)), { recursive: true });
    writeFileSync(path.join(workspace, relativePath), content);
  }
}

function ignoredBySource(listing: Awaited<ReturnType<typeof listWorkspace>>) {
  return listing.excludedIgnored.map(({ path: entryPath, source, wildcard }) => ({ path: entryPath, source, wildcard }));
}

test("the three ignore files are united, and a path listed in several counts once, for the first in user > agent > legacy", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-union");
  try {
    writeTree(workspace, {
      "MEMORY.md": "memory\n",
      "keep.txt": "keep\n",
      "agent-only/a": "a".repeat(10),
      "legacy-only/b": "b".repeat(20),
      "user-only/c": "c".repeat(30),
      "shared-all/d": "d".repeat(40),
      "agent-legacy/e": "e".repeat(50),
      ".raftbackupignore": "agent-only\nshared-all\nagent-legacy\n",
      ".raftmigrateignore": "legacy-only\nshared-all\nagent-legacy\n",
      ".raftbackupignore.user": "# added by Raft for alice at 2026-11-04T00:00:00Z\nuser-only\nshared-all\n",
    });
    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [".raftbackupignore", ".raftbackupignore.user", ".raftmigrateignore", "MEMORY.md", "keep.txt"]);
    assert.deepEqual(ignoredBySource(listing), [
      { path: "agent-legacy", source: "agentFile", wildcard: false },
      { path: "agent-only", source: "agentFile", wildcard: false },
      { path: "legacy-only", source: "legacyFile", wildcard: false },
      { path: "shared-all", source: "userFile", wildcard: false },
      { path: "user-only", source: "userFile", wildcard: false },
    ]);
    const summary = summarizeAgentMigrationTransfer({
      includedFileCount: listing.listed.length,
      includedBytes: 0,
      memoryMdPresent: true,
      notesPresent: false,
      excludedRegenerable: listing.excludedRegenerable,
      excludedIgnored: listing.excludedIgnored,
      reportIgnoredBySource: true,
    });
    assert.deepEqual(summary.excludedIgnoredBySource, {
      userFile: { count: 2, fileCount: 2, bytes: 70 },
      agentFile: { count: 2, fileCount: 2, bytes: 60 },
      legacyFile: { count: 1, fileCount: 1, bytes: 20 },
      wildcard: { count: 0, fileCount: 0, bytes: 0 },
    });
    assert.deepEqual(
      { count: summary.excludedIgnored?.count, fileCount: summary.excludedIgnored?.fileCount, bytes: summary.excludedIgnored?.bytes },
      { count: 5, fileCount: 5, bytes: 150 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("**/<name> excludes directories of that name at any depth, never files, and other patterns are skipped", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-wildcard");
  try {
    writeTree(workspace, {
      "repos/a/checkout/x.txt": "x".repeat(5),
      "repos/b/deep/er/checkout/y.txt": "y".repeat(7),
      "checkout/z.txt": "z",
      // A file named like the wildcard is not a directory: it moves.
      "notes/checkout": "file\n",
      "logs/run.log": "log\n",
      "logs/keep/run.log": "log\n",
      "tmpdata/t.bin": "t",
      ".raftbackupignore": [
        "**/checkout/",
        "**/*.log",
        "**/logs/keep",
        "logs/**/run.log",
        "**/tmp*",
        "**/",
        "**/..",
        "**",
        "",
      ].join("\n"),
    });
    // A symlink named like the wildcard is not matched either.
    mkdirSync(path.join(workspace, "links"), { recursive: true });
    symlinkSync(path.join(workspace, "repos", "a"), path.join(workspace, "links", "checkout"));
    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [
      ".raftbackupignore",
      "links/checkout",
      "logs/keep/run.log",
      "logs/run.log",
      "notes/checkout",
      "tmpdata/t.bin",
    ]);
    assert.deepEqual(listing.excludedIgnored, [
      { path: "checkout", reason: "raftmigrateignore", source: "agentFile", wildcard: true, fileCount: 1, sizeBytes: 1 },
      { path: "repos/a/checkout", reason: "raftmigrateignore", source: "agentFile", wildcard: true, fileCount: 1, sizeBytes: 5 },
      { path: "repos/b/deep/er/checkout", reason: "raftmigrateignore", source: "agentFile", wildcard: true, fileCount: 1, sizeBytes: 7 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact line outranks a wildcard from the same or a later file; an earlier file's wildcard outranks a later exact line", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-wildcard-precedence");
  try {
    writeTree(workspace, {
      "a/cache/1": "1",
      "b/cache/2": "22",
      "c/cache/3": "333",
      ".raftbackupignore": "**/cache\na/cache\n",
      ".raftmigrateignore": "b/cache\n",
      ".raftbackupignore.user": "c/cache\n",
    });
    const listing = await listWorkspace(workspace);
    assert.deepEqual(ignoredBySource(listing), [
      { path: "a/cache", source: "agentFile", wildcard: false },
      { path: "b/cache", source: "agentFile", wildcard: true },
      { path: "c/cache", source: "userFile", wildcard: false },
    ]);
    const summary = summarizeAgentMigrationTransfer({
      includedFileCount: listing.listed.length,
      includedBytes: 0,
      memoryMdPresent: false,
      notesPresent: false,
      excludedRegenerable: [],
      excludedIgnored: listing.excludedIgnored,
      reportIgnoredBySource: true,
    });
    assert.deepEqual(summary.excludedIgnoredBySource, {
      userFile: { count: 1, fileCount: 1, bytes: 3 },
      agentFile: { count: 2, fileCount: 2, bytes: 3 },
      legacyFile: { count: 0, fileCount: 0, bytes: 0 },
      wildcard: { count: 1, fileCount: 1, bytes: 2 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no ignore line, exact or wildcard, in any file excludes MEMORY.md, an ignore file, or .raft/activity and its parents", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-forced-keeps");
  const lines = [
    "MEMORY.md",
    ".raftbackupignore",
    ".raftmigrateignore",
    ".raftbackupignore.user",
    ".raft",
    ".raft/activity",
    "**/MEMORY.md",
    "**/.raftbackupignore.user",
    "**/.raft",
    "**/activity",
    "",
  ].join("\n");
  try {
    writeTree(workspace, {
      "MEMORY.md": "memory\n",
      ".raft/activity/1-1-s.jsonl": "{}\n",
      // Only the root .raft is protected; a nested one is the agent's call.
      "sub/.raft/x": "x",
      "sub/activity/y": "y",
      ".raftbackupignore": lines,
      ".raftmigrateignore": lines,
      ".raftbackupignore.user": lines,
    });
    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [
      ".raft/activity/1-1-s.jsonl",
      ".raftbackupignore",
      ".raftbackupignore.user",
      ".raftmigrateignore",
      "MEMORY.md",
    ]);
    assert.deepEqual(ignoredBySource(listing), [
      { path: "sub/.raft", source: "userFile", wildcard: true },
      { path: "sub/activity", source: "userFile", wildcard: true },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("two sources over the shared measuring bound: the per-source counts add up to the bounded total", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-sources-bound");
  try {
    for (const dir of ["a", "b"]) {
      mkdirSync(path.join(workspace, dir), { recursive: true });
      for (let i = 0; i < 8; i += 1) writeFileSync(path.join(workspace, dir, `f${i}`), "x");
    }
    writeFileSync(path.join(workspace, ".raftbackupignore.user"), "a\n");
    writeFileSync(path.join(workspace, ".raftbackupignore"), "**/b\n");
    const listed: string[] = [];
    const listing = await listAgentMigrationWorkspace({
      workspacePath: workspace,
      onEntry: (relativePath) => { listed.push(relativePath); },
      ignoredFileMeasureLimit: 10,
    });
    assert.deepEqual([...listed].sort(), [".raftbackupignore", ".raftbackupignore.user"]);
    const summary = summarizeAgentMigrationTransfer({
      includedFileCount: listed.length,
      includedBytes: 0,
      memoryMdPresent: false,
      notesPresent: false,
      excludedRegenerable: [],
      excludedIgnored: listing.excludedIgnored,
      reportIgnoredBySource: true,
    });
    assert.equal(summary.excludedIgnored?.fileCount, 10);
    assert.deepEqual(summary.excludedIgnoredBySource, {
      userFile: { count: 1, fileCount: 8, bytes: 8 },
      agentFile: { count: 1, fileCount: 2, bytes: 2 },
      legacyFile: { count: 0, fileCount: 0, bytes: 0 },
      wildcard: { count: 1, fileCount: 2, bytes: 2 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("per-source counts are clamped with the total at the summary bound, so a strict server accepts them", () => {
  const summary = summarizeAgentMigrationTransfer({
    includedFileCount: 1,
    includedBytes: 0,
    memoryMdPresent: true,
    notesPresent: false,
    excludedRegenerable: [],
    excludedIgnored: [
      { path: "a", reason: "raftmigrateignore", source: "agentFile", wildcard: true, fileCount: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT - 1, sizeBytes: 1 },
      { path: "b", reason: "raftmigrateignore", source: "userFile", wildcard: false, fileCount: 5, sizeBytes: 1 },
    ],
    reportIgnoredBySource: true,
  });
  assert.equal(summary.excludedIgnored?.fileCount, MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT);
  assert.deepEqual(summary.excludedIgnoredBySource, {
    userFile: { count: 1, fileCount: 5, bytes: 1 },
    agentFile: { count: 1, fileCount: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT - 5, bytes: 1 },
    legacyFile: { count: 0, fileCount: 0, bytes: 0 },
    wildcard: { count: 1, fileCount: MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT - 5, bytes: 1 },
  });
});

test("excludedIgnoredBySource is reported only when asked, and never without ignored paths", () => {
  const base = {
    includedFileCount: 1,
    includedBytes: 0,
    memoryMdPresent: true,
    notesPresent: false,
    excludedRegenerable: [],
  };
  const ignored = [{ path: "a", reason: "raftmigrateignore" as const, source: "agentFile" as const, wildcard: false, fileCount: 1, sizeBytes: 1 }];
  assert.equal("excludedIgnoredBySource" in summarizeAgentMigrationTransfer({ ...base, excludedIgnored: ignored }), false);
  assert.equal("excludedIgnoredBySource" in summarizeAgentMigrationTransfer({ ...base, excludedIgnored: ignored, reportIgnoredBySource: false }), false);
  assert.equal("excludedIgnoredBySource" in summarizeAgentMigrationTransfer({ ...base, excludedIgnored: ignored, reportIgnoredBySource: true }), true);
  const none = summarizeAgentMigrationTransfer({ ...base, excludedIgnored: [], reportIgnoredBySource: true });
  assert.equal("excludedIgnored" in none, false);
  assert.equal("excludedIgnoredBySource" in none, false);
});

test("a **/<name> line in .raftmigrateignore is skipped like any pattern: older Computers read only that file, exact paths only", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-legacy-wildcard");
  try {
    writeTree(workspace, {
      "repo/.git/HEAD": "ref\n",
      "repo/src/a.ts": "a\n",
      "other/.git/config": "c\n",
      "scratch/s": "s",
      ".raftmigrateignore": "**/.git\n**/scratch\n",
    });
    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [
      ".raftmigrateignore",
      "other/.git/config",
      "repo/.git/HEAD",
      "repo/src/a.ts",
      "scratch/s",
    ]);
    assert.deepEqual(listing.excludedIgnored, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("**/<name> naming a built-in regenerable directory leaves it a built-in exclusion; an exact line still ignores it", async () => {
  const root = tempRoot();
  const workspace = path.join(root, "agent-wildcard-builtin");
  try {
    writeTree(workspace, {
      "node_modules/a/index.js": "a".repeat(10),
      "pkg/node_modules/b/index.js": "b".repeat(20),
      "web/node_modules/c/index.js": "c".repeat(30),
      "repo/checkout/x": "x".repeat(4),
      ".raftbackupignore": "**/node_modules\n**/checkout\nweb/node_modules\n",
      ".raftbackupignore.user": "**/node_modules\n",
    });
    const listing = await listWorkspace(workspace);
    assert.deepEqual([...listing.listed].sort(), [".raftbackupignore", ".raftbackupignore.user"]);
    assert.deepEqual(listing.excludedRegenerable.map((entry) => entry.path), ["node_modules", "pkg/node_modules"]);
    assert.deepEqual(listing.excludedIgnored, [
      { path: "repo/checkout", reason: "raftmigrateignore", source: "agentFile", wildcard: true, fileCount: 1, sizeBytes: 4 },
      { path: "web/node_modules", reason: "raftmigrateignore", source: "agentFile", wildcard: false, fileCount: 1, sizeBytes: 30 },
    ]);
    const summary = summarizeAgentMigrationTransfer({
      includedFileCount: listing.listed.length,
      includedBytes: 0,
      memoryMdPresent: false,
      notesPresent: false,
      excludedRegenerable: listing.excludedRegenerable,
      excludedIgnored: listing.excludedIgnored,
      reportIgnoredBySource: true,
    });
    assert.equal(summary.excludedRegenerableByCategory.thirdPartyDependencies, 2);
    assert.deepEqual(summary.excludedIgnored, {
      count: 2,
      fileCount: 2,
      bytes: 34,
      largest: [{ path: "web/node_modules", bytes: 30 }, { path: "repo/checkout", bytes: 4 }],
    });
    assert.deepEqual(summary.excludedIgnoredBySource, {
      userFile: { count: 0, fileCount: 0, bytes: 0 },
      agentFile: { count: 2, fileCount: 2, bytes: 34 },
      legacyFile: { count: 0, fileCount: 0, bytes: 0 },
      wildcard: { count: 1, fileCount: 1, bytes: 4 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
