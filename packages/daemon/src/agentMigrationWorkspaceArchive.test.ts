import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
  AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT,
  archiveCompletedAgentMigrationSourceWorkspace,
} from "./agentMigrationWorkspaceArchive.js";
import { scanWorkspaceDirectories } from "./workspaces.js";

test("completed migration archives exact source bytes outside the active workspace scanner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-source-archive-"));
  const slockHome = path.join(root, "home");
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-1");
  try {
    await mkdir(path.join(source, "notes"), { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "exact-source\n");
    await writeFile(path.join(source, "notes", "receipt.json"), "{\"ok\":true}\n");

    assert.equal(await archiveCompletedAgentMigrationSourceWorkspace({
      slockHome,
      dataDir,
      agentId: "agent-1",
      migrationId: "migration-1",
      now: new Date("2026-08-07T00:00:00.000Z"),
    }), "archived");

    const archive = path.join(
      slockHome,
      AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
      "agent-1",
      "migration-1",
    );
    assert.equal(await readFile(path.join(archive, "MEMORY.md"), "utf8"), "exact-source\n");
    assert.equal(await readFile(path.join(archive, "notes", "receipt.json"), "utf8"), "{\"ok\":true}\n");
    assert.deepEqual(await scanWorkspaceDirectories(dataDir), []);

    assert.equal(await archiveCompletedAgentMigrationSourceWorkspace({
      slockHome,
      dataDir,
      agentId: "agent-1",
      migrationId: "migration-1",
      now: new Date("2026-08-08T00:00:00.000Z"),
    }), "already_archived");
    assert.equal(await readFile(path.join(archive, "MEMORY.md"), "utf8"), "exact-source\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source migration archives retain only the newest bounded set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-source-retention-"));
  const slockHome = path.join(root, "home");
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-2");
  try {
    await mkdir(dataDir, { recursive: true });
    for (let index = 0; index <= AGENT_MIGRATION_WORKSPACE_BACKUP_MAX_PER_AGENT; index += 1) {
      await mkdir(source, { recursive: true });
      await writeFile(path.join(source, "MEMORY.md"), `archive-${index}\n`);
      assert.equal(await archiveCompletedAgentMigrationSourceWorkspace({
        slockHome,
        dataDir,
        agentId: "agent-2",
        migrationId: `migration-${index}`,
        now: new Date(Date.UTC(2026, 7, 1 + index)),
      }), "archived");
    }

    const agentBackupRoot = path.join(
      slockHome,
      AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
      "agent-2",
    );
    assert.deepEqual(
      (await readdir(agentBackupRoot)).sort(),
      ["migration-1", "migration-2", "migration-3"],
    );
    assert.equal(
      await readFile(path.join(agentBackupRoot, "migration-3", "MEMORY.md"), "utf8"),
      "archive-3\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent archive replay converges on the same immutable backup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-source-concurrent-"));
  const slockHome = path.join(root, "home");
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-concurrent");
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "MEMORY.md"), "concurrent-exact\n");
    const outcomes = await Promise.all([
      archiveCompletedAgentMigrationSourceWorkspace({
        slockHome,
        dataDir,
        agentId: "agent-concurrent",
        migrationId: "migration-concurrent",
      }),
      archiveCompletedAgentMigrationSourceWorkspace({
        slockHome,
        dataDir,
        agentId: "agent-concurrent",
        migrationId: "migration-concurrent",
      }),
    ]);
    assert.deepEqual(outcomes.sort(), ["already_archived", "archived"]);
    assert.equal(await readFile(path.join(
      slockHome,
      AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
      "agent-concurrent",
      "migration-concurrent",
      "MEMORY.md",
    ), "utf8"), "concurrent-exact\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source archive fails closed for conflicting, linked, or scanner-visible paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "migration-source-invalid-"));
  const slockHome = path.join(root, "home");
  const dataDir = path.join(slockHome, "agents");
  const source = path.join(dataDir, "agent-3");
  const archive = path.join(
    slockHome,
    AGENT_MIGRATION_WORKSPACE_BACKUP_DIRECTORY,
    "agent-3",
    "migration-conflict",
  );
  try {
    await mkdir(source, { recursive: true });
    await mkdir(archive, { recursive: true });
    await assert.rejects(
      archiveCompletedAgentMigrationSourceWorkspace({
        slockHome,
        dataDir,
        agentId: "agent-3",
        migrationId: "migration-conflict",
      }),
      /MIGRATION_WORKSPACE_ARCHIVE_CONFLICT/,
    );

    await rm(source, { recursive: true, force: true });
    await symlink(archive, source);
    await assert.rejects(
      archiveCompletedAgentMigrationSourceWorkspace({
        slockHome,
        dataDir,
        agentId: "agent-3",
        migrationId: "migration-linked-source",
      }),
      /MIGRATION_WORKSPACE_ARCHIVE_SOURCE_INVALID/,
    );

    const nestedHome = path.join(dataDir, "nested-home");
    await assert.rejects(
      archiveCompletedAgentMigrationSourceWorkspace({
        slockHome: nestedHome,
        dataDir,
        agentId: "agent-absent",
        migrationId: "migration-nested-root",
      }),
      /MIGRATION_WORKSPACE_ARCHIVE_ROOT_INSIDE_DATA_DIR/,
    );

    await assert.rejects(
      archiveCompletedAgentMigrationSourceWorkspace({
        slockHome,
        dataDir,
        agentId: "agent-missing",
        migrationId: "migration-missing",
      }),
      /MIGRATION_WORKSPACE_ARCHIVE_SOURCE_MISSING/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
