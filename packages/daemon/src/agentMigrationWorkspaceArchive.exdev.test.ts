import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

// Simulate a dataDir on a different filesystem than slockHome: the first
// rename out of the data dir fails with EXDEV, like a real cross-volume move.
const exdev = vi.hoisted(() => ({ sourcePrefix: "", failNextRenameFrom: true, freeBytes: null as number | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Report the data dir as another device, with a controllable amount of free space.
    stat: async (target: string, ...rest: unknown[]) => {
      const info = await (actual.stat as (...args: unknown[]) => Promise<import("node:fs").Stats>)(target, ...rest);
      if (exdev.sourcePrefix && String(target).startsWith(exdev.sourcePrefix)) {
        return Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev: info.dev + 1 });
      }
      return info;
    },
    statfs: async (target: string) => {
      const info = await actual.statfs(target);
      return exdev.freeBytes === null ? info : { ...info, bsize: 1, bavail: exdev.freeBytes };
    },
    rename: async (from: string, to: string) => {
      if (exdev.failNextRenameFrom && exdev.sourcePrefix && from.startsWith(exdev.sourcePrefix)) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
      return actual.rename(from, to);
    },
  };
});

// The fake statfs is the free space under test; on macOS the real important-
// usage capacity (osascript) would otherwise replace it.
vi.mock("./volumeCapacity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./volumeCapacity")>();
  return { ...actual, readVolumeCapacity: (target: string) => actual.readVolumeCapacity(target, { platform: "linux" }) };
});

const {
  AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
  archiveCompletedAgentMigrationSourceWorkspace,
  quarantinePreexistingAgentWorkspace,
} = await import("./agentMigrationWorkspaceArchive");

test("cross-filesystem archive copies, verifies, then removes the source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-source-archive-exdev-"));
  const slockHome = path.join(root, "home");
  const dataDir = path.join(root, "other-volume", "agents");
  const source = path.join(dataDir, "agent-1");
  exdev.sourcePrefix = dataDir;
  try {
    await mkdir(path.join(source, "notes"), { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "exact-source\n");
    await writeFile(path.join(source, "notes", "n.md"), "note\n");

    const outcome = await archiveCompletedAgentMigrationSourceWorkspace({
      slockHome,
      dataDir,
      agentId: "agent-1",
      migrationId: "migration-1",
    });
    assert.equal(outcome, "archived");

    const archive = path.join(slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY, "agent-1", "migration-1");
    assert.equal(await readFile(path.join(archive, "MEMORY.md"), "utf8"), "exact-source\n");
    assert.equal(await readFile(path.join(archive, "notes", "n.md"), "utf8"), "note\n");
    await assert.rejects(readdir(source), /ENOENT/);
    const agentBackups = await readdir(path.join(slockHome, AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY, "agent-1"));
    assert.deepEqual(agentBackups, ["migration-1"], "no partial staging copy is left behind");
  } finally {
    exdev.sourcePrefix = "";
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-filesystem quarantine refuses to start without room for the copy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-target-quarantine-exdev-"));
  const slockHome = path.join(root, "home");
  const dataDir = path.join(root, "other-volume", "agents");
  const stale = path.join(dataDir, "agent-1");
  exdev.sourcePrefix = dataDir;
  exdev.freeBytes = 1024;
  try {
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "MEMORY.md"), "left-behind\n");
    await assert.rejects(
      quarantinePreexistingAgentWorkspace({ slockHome, dataDir, agentId: "agent-1", migrationId: "migration-2" }),
      /MIGRATION_WORKSPACE_QUARANTINE_INSUFFICIENT_DISK/,
    );
    assert.equal(await readFile(path.join(stale, "MEMORY.md"), "utf8"), "left-behind\n", "nothing moved");

    exdev.freeBytes = null;
    const { quarantinePath } = await quarantinePreexistingAgentWorkspace({
      slockHome,
      dataDir,
      agentId: "agent-1",
      migrationId: "migration-2",
    });
    assert.equal(await readFile(path.join(quarantinePath, "MEMORY.md"), "utf8"), "left-behind\n");
    await assert.rejects(readdir(stale), /ENOENT/);
  } finally {
    exdev.sourcePrefix = "";
    exdev.freeBytes = null;
    await rm(root, { recursive: true, force: true });
  }
});
