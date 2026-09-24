import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION,
  buildAgentMigrationExportManifest,
  normalizeAgentMigrationSymlinkTarget,
  summarizeAgentMigrationExportManifest,
} from "./agentMigrationExport.js";

function tempRoot(): string {
  return path.join(os.tmpdir(), `agent-migration-export-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-1",
      slockHome,
      workspacePath: workspace,
      mode: "forensic",
      now: new Date("2026-07-06T10:00:00.000Z"),
    });

    assert.equal(manifest.schemaVersion, AGENT_MIGRATION_BUNDLE_SCHEMA_VERSION);
    assert.equal(manifest.defaults.unknownFiles, "include");
    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), [
      ".env",
      ".gitignore",
      "build/artifact.txt",
      "README.md",
    ]);
    assert.deepEqual(manifest.excludedRegenerable.map((entry) => entry.path), [
      "__pycache__",
      ".venv",
      "dist",
      "node_modules",
      "target",
    ]);

    const envEntry = manifest.files.find((entry) => entry.workspaceRelativePath === ".env");
    assert.equal(envEntry?.sha256, sha256("OPENAI_API_KEY=sk-test-secret\nNORMAL=value\n"));
    assert.deepEqual(envEntry?.secretShapes, ["env:NORMAL", "env:OPENAI_API_KEY", "file:.env"]);
    assert.deepEqual(manifest.secretsDisclosed, [{
      path: ".env",
      shapes: ["env:NORMAL", "env:OPENAI_API_KEY", "file:.env"],
    }]);
    const serialized = JSON.stringify(manifest);
    assert.ok(!serialized.includes("sk-test-secret"));
    assert.ok(!serialized.includes(slockHome));
    assert.ok(!serialized.includes(workspace));
    assert.deepEqual(summarizeAgentMigrationExportManifest(manifest), {
      includedFileCount: 4,
      includedBytes: manifest.files.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0),
      excludedRegenerableCount: 5,
      excludedRegenerableByCategory: {
        thirdPartyDependencies: 2,
        caches: 1,
        buildArtifacts: 2,
        otherRegenerable: 0,
      },
      keyWorkspaceEntries: {
        memoryMdPresent: false,
        notesPresent: false,
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migration export summary reports key workspace entries without paths", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-summary");
  try {
    mkdirSync(path.join(workspace, "notes"), { recursive: true });
    writeFileSync(path.join(workspace, "MEMORY.md"), "memory\n");
    writeFileSync(path.join(workspace, "notes", "domain.md"), "domain\n");
    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-summary",
      slockHome,
      workspacePath: workspace,
      mode: "forensic",
    });
    const summary = summarizeAgentMigrationExportManifest(manifest);
    assert.deepEqual(summary.excludedRegenerableByCategory, {
      thirdPartyDependencies: 0,
      caches: 0,
      buildArtifacts: 0,
      otherRegenerable: 0,
    });
    assert.deepEqual(summary.keyWorkspaceEntries, {
      memoryMdPresent: true,
      notesPresent: true,
    });
    assert.equal(JSON.stringify(summary).includes(workspace), false);
    assert.equal(JSON.stringify(summary).includes("domain.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cooperative excludes can remove regenerable dirs but non-regenerable excludes are promoted to include", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-2");
  try {
    mkdirSync(path.join(workspace, "dist"), { recursive: true });
    writeFileSync(path.join(workspace, "dist", "bundle.js"), "regenerated\n");
    writeFileSync(path.join(workspace, "state.sqlite"), "irreplaceable\n");

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-2",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      cooperativeManifest: {
        exclude_regenerable: ["dist", "state.sqlite"],
      },
    });

    assert.deepEqual(manifest.excludedRegenerable.map((entry) => [entry.path, entry.reason]), [
      ["dist", "cooperative_exclude_regenerable"],
    ]);
    assert.deepEqual(manifest.promotedIncludes, [{
      path: "state.sqlite",
      reason: "exclude_not_regenerable",
    }]);
    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["state.sqlite"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable cooperative refusals preserve diagnostics without serializing source absolute paths", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-outside");
  const outsidePath = path.join(root, "outside-state.json");
  const outsideCache = path.join(root, "outside-cache");
  const outsideCleaned = path.join(root, "outside-cleaned");
  const outsideSecret = path.join(root, "outside-secret.env");
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "state.json"), "{}\n");
    writeFileSync(outsidePath, "{}\n");

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-outside",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      cooperativeManifest: {
        include: [outsidePath],
        exclude_regenerable: [outsideCache],
        cleaned: [outsideCleaned],
        secrets_disclosed: [outsideSecret],
      },
    });

    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["state.json"]);
    assert.equal(manifest.proposalRefusals.length, 4);
    for (const [source, original] of [
      ["include", outsidePath],
      ["exclude_regenerable", outsideCache],
      ["cleaned", outsideCleaned],
      ["secrets_disclosed", outsideSecret],
    ] as const) {
      const refusal = manifest.proposalRefusals.find((entry) => entry.source === source);
      assert.deepEqual(refusal, {
        path: `<redacted:absolute:${sha256(original).slice(0, 16)}>`,
        reason: "outside_workspace",
        source,
      });
      assert.ok((refusal?.path.length ?? 0) <= 48, "portable refusal descriptor stays bounded");
    }
    const serialized = JSON.stringify(manifest);
    for (const sourceRoot of [root, slockHome, workspace, outsidePath, outsideCache, outsideCleaned, outsideSecret]) {
      assert.equal(serialized.includes(sourceRoot), false, `portable manifest leaked source path: ${sourceRoot}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable cooperative refusals reject POSIX, Windows drive, and UNC absolute paths on every host", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-foreign-absolute");
  const foreignAbsolutePaths = [
    "/var/tmp/agent-migration-secret.txt",
    "C:\\Users\\alice\\agent-migration-secret.txt",
    "\\\\fileserver\\private-share\\agent-migration-secret.txt",
  ];
  const sources = ["include", "exclude_regenerable", "cleaned", "secrets_disclosed"] as const;
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "state.json"), "{}\n");

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-foreign-absolute",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      cooperativeManifest: {
        include: foreignAbsolutePaths,
        exclude_regenerable: foreignAbsolutePaths,
        cleaned: foreignAbsolutePaths,
        secrets_disclosed: foreignAbsolutePaths,
      },
    });

    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["state.json"]);
    assert.equal(manifest.proposalRefusals.length, foreignAbsolutePaths.length * sources.length);
    assert.deepEqual(manifest.unreachable, []);
    assert.deepEqual(manifest.promotedIncludes, []);
    assert.deepEqual(manifest.cleaned, []);
    assert.deepEqual(manifest.secretsDisclosed, []);

    for (const original of foreignAbsolutePaths) {
      const expectedPath = `<redacted:absolute:${sha256(original).slice(0, 16)}>`;
      for (const source of sources) {
        assert.deepEqual(
          manifest.proposalRefusals.find((entry) => entry.source === source && entry.path === expectedPath),
          { path: expectedPath, reason: "outside_workspace", source },
        );
      }
    }

    const serialized = JSON.stringify(manifest);
    for (const sensitive of [
      ...foreignAbsolutePaths,
      "/var/tmp",
      "C:\\Users\\alice",
      "\\\\fileserver\\private-share",
    ]) {
      const jsonEscaped = JSON.stringify(sensitive).slice(1, -1);
      assert.equal(serialized.includes(sensitive), false, `portable manifest leaked raw path: ${sensitive}`);
      assert.equal(serialized.includes(jsonEscaped), false, `portable manifest leaked JSON-escaped path: ${sensitive}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cooperative relative paths normalize foreign separators and reject traversal or drive-relative forms", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-relative-dialects");
  const unsafePaths = ["..\\outside-secret.txt", "C:drive-relative-secret.txt"];
  try {
    mkdirSync(path.join(workspace, "node_modules", "kept"), { recursive: true });
    writeFileSync(path.join(workspace, "node_modules", "kept", "index.js"), "module.exports = 1;\n");

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-relative-dialects",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      cooperativeManifest: {
        include: ["node_modules\\kept", ...unsafePaths],
      },
    });

    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["node_modules/kept/index.js"]);
    assert.deepEqual(manifest.proposalRefusals, unsafePaths.map((original) => ({
      path: `<redacted:unsafe:${sha256(original).slice(0, 16)}>`,
      reason: "unsafe_path",
      source: "include",
    })).sort((left, right) => left.path.localeCompare(right.path)));
    const serialized = JSON.stringify(manifest);
    for (const original of unsafePaths) {
      assert.equal(serialized.includes(JSON.stringify(original).slice(1, -1)), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cooperative explicit include overrides the regenerable default", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-include-regen");
  try {
    mkdirSync(path.join(workspace, "node_modules", "kept"), { recursive: true });
    writeFileSync(path.join(workspace, "node_modules", "kept", "index.js"), "module.exports = 1;\n");

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-include-regen",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      cooperativeManifest: {
        include: ["node_modules\\kept"],
      },
    });

    assert.deepEqual(manifest.excludedRegenerable, []);
    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["node_modules/kept/index.js"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unreachable paths are recorded in the manifest", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-unreachable");
  const unreadableDir = path.join(workspace, "private-dir");
  try {
    mkdirSync(unreadableDir, { recursive: true });
    writeFileSync(path.join(workspace, "notes.md"), "ok\n");
    chmodSync(unreadableDir, 0o000);

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-unreachable",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      cooperativeManifest: {
        include: ["missing-file"],
      },
    });

    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["notes.md"]);
    assert.deepEqual(manifest.unreachable.map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })), [
      { path: "missing-file", reason: "missing" },
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

test("runtime session refs are emitted as cross-tree metadata without becoming workspace-relative files", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-3");
  const runtimePath = path.join(root, "codex", "sessions", "session-abc.jsonl");
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(path.dirname(runtimePath), { recursive: true });
    writeFileSync(path.join(workspace, "notes.md"), "workspace\n");
    writeFileSync(runtimePath, "{\"type\":\"session\"}\n");

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-3",
      slockHome,
      workspacePath: workspace,
      mode: "cooperative",
      runtimeSessionRefs: [{
        runtime: "codex",
        label: "session-abc",
        path: runtimePath,
        reachable: true,
      }],
    });

    assert.deepEqual(manifest.files.map((entry) => entry.workspaceRelativePath), ["notes.md"]);
    assert.equal(manifest.crossTreeRefs.length, 1);
    assert.equal(manifest.crossTreeRefs[0]?.bundlePath, "runtime/codex/session-abc/session-abc.jsonl");
    assert.equal(manifest.crossTreeRefs[0]?.sha256, sha256("{\"type\":\"session\"}\n"));
    assert.equal(manifest.crossTreeRefs[0]?.reachable, true);
    assert.ok(!JSON.stringify(manifest).includes(runtimePath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace symlinks are represented as links instead of dereferenced content", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-4");
  try {
    mkdirSync(workspace, { recursive: true });
    writeFileSync(path.join(workspace, "target-file"), "content\n");
    symlinkSync("target-file", path.join(workspace, "link-file"));

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-4",
      slockHome,
      workspacePath: workspace,
      mode: "forensic",
    });

    const linkEntry = manifest.files.find((entry) => entry.workspaceRelativePath === "link-file");
    assert.equal(linkEntry?.kind, "symlink");
    assert.equal(linkEntry?.linkTarget, "target-file");
    assert.equal(linkEntry?.sha256, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unsafe symlink targets never enter the structured or JSON manifest", async () => {
  const root = tempRoot();
  const slockHome = path.join(root, ".slock");
  const workspace = path.join(slockHome, "agents", "agent-symlink-safety");
  const unsafeTargets = [
    path.join(root, "source-local-secret"),
    "C:\\Users\\alice\\source-local-secret",
    "C:source-local-secret",
    "\\\\server\\share\\source-local-secret",
  ];
  try {
    mkdirSync(path.join(workspace, "nested"), { recursive: true });
    writeFileSync(path.join(workspace, "target-file"), "content\n");
    symlinkSync("../target-file", path.join(workspace, "nested", "safe-link"));
    unsafeTargets.forEach((target, index) => {
      symlinkSync(target, path.join(workspace, `unsafe-link-${index}`));
    });

    const manifest = await buildAgentMigrationExportManifest({
      agentId: "agent-symlink-safety",
      slockHome,
      workspacePath: workspace,
      mode: "forensic",
    });

    const safeLink = manifest.files.find((entry) => entry.workspaceRelativePath === "nested/safe-link");
    assert.equal(safeLink?.kind, "symlink");
    assert.equal(safeLink?.linkTarget, "../target-file");
    assert.equal(manifest.files.some((entry) => entry.workspaceRelativePath?.startsWith("unsafe-link-")), false);
    assert.deepEqual(
      manifest.unreachable.filter((entry) => entry.reason === "unsafe_symlink_target").map((entry) => entry.path),
      unsafeTargets.map((_target, index) => `unsafe-link-${index}`),
    );
    for (const refusal of manifest.unreachable.filter((entry) => entry.reason === "unsafe_symlink_target")) {
      assert.match(refusal.detail ?? "", /^<redacted:unsafe-symlink-target:[0-9a-f]{16}>$/);
    }
    const serialized = JSON.stringify(manifest);
    for (const target of unsafeTargets) {
      assert.equal(serialized.includes(target), false);
      assert.equal(serialized.includes(JSON.stringify(target).slice(1, -1)), false);
    }
    assert.ok(serialized.length < 10_000, "bounded refusal evidence must not grow with source-local target text");
  } finally {
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
