import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import assert from "node:assert/strict";
import {
  deleteWorkspaceDirectory,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
} from "./workspaces.js";

test("scanWorkspaceDirectories summarizes workspace directories recursively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-"));
  try {
    const firstDir = path.join(root, "agent-one");
    const secondDir = path.join(root, "agent-two");
    await mkdir(firstDir);
    await mkdir(secondDir);
    await writeFile(path.join(firstDir, "notes.md"), "hello");
    await writeFile(path.join(firstDir, "config.json"), "{\"ok\":true}");
    await mkdir(path.join(firstDir, "nested"));
    await writeFile(path.join(firstDir, "nested", "child.txt"), "nested");
    await writeFile(path.join(secondDir, "README.txt"), "x");

    const directories = await scanWorkspaceDirectories(root);
    const first = directories.find((entry) => entry.directoryName === "agent-one");
    const second = directories.find((entry) => entry.directoryName === "agent-two");

    assert.ok(first);
    assert.equal(first.fileCount, 3);
    assert.equal(
      first.totalSizeBytes,
      Buffer.byteLength("hello") + Buffer.byteLength("{\"ok\":true}") + Buffer.byteLength("nested"),
    );
    assert.notEqual(first.lastModified, new Date(0).toISOString());

    assert.ok(second);
    assert.equal(second.fileCount, 1);
    assert.equal(second.totalSizeBytes, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolveWorkspaceDirectoryPath rejects path traversal", () => {
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1"), path.join("/tmp/daemon", "agent-1"));
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "../agent-1"), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "nested/agent-1"), null);
});

test("deleteWorkspaceDirectory removes only valid workspace directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-delete-"));
  try {
    const targetDir = path.join(root, "agent-delete");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "notes.md"), "delete-me");

    assert.equal(await deleteWorkspaceDirectory(root, "agent-delete"), true);
    assert.deepEqual(await scanWorkspaceDirectories(root), []);
    assert.equal(await deleteWorkspaceDirectory(root, "../outside"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
