import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { initializeLaunchWorkspace } from "./agentLaunchWorkspace";
import type { AgentConfig } from "@botiverse/raft-shared";
import {
  deleteWorkspaceDirectory,
  readWorkspaceOwnerServerId,
  resolveWorkspaceDirectoryPath,
  scanWorkspaceDirectories,
  WORKSPACE_OWNER_MARKER_FILE,
  type WorkspaceDeleteGuard,
  workspaceDeleteRefusal,
  workspaceDisplayPath,
  writeWorkspaceOwnerMarker,
} from "./workspaces";

const AGENT_ID = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";
const OTHER_AGENT_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const SERVER_ID = "server-a";
const idleGuard: WorkspaceDeleteGuard = { serverId: SERVER_ID, isAgentRunning: () => false };

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
    assert.equal(second.displayPath, workspaceDisplayPath(secondDir));
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
    const targetDir = path.join(root, AGENT_ID);
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "notes.md"), "delete-me");

    assert.equal(await deleteWorkspaceDirectory(root, AGENT_ID, idleGuard), true);
    assert.deepEqual(await scanWorkspaceDirectories(root), []);
    assert.equal(await deleteWorkspaceDirectory(root, "../outside", idleGuard), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The blocklist that used to guard this rejected "/", "\\" and ".." -- every traversal
// string and nothing else. "." and "" are neither traversal nor a child: path.join
// collapses both to dataDir itself, so a request naming ONE workspace deleted the root
// holding EVERY agent workspace on the machine, and returned the same success as an
// ordinary delete.
//
// These cases are why the guard is now a containment assertion rather than a longer
// blocklist. A blocklist can only reject the inputs its author thought of, and here the
// failure mode is silent, total and irreversible.
test("resolveWorkspaceDirectoryPath rejects names that resolve to the root itself", () => {
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "."), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", ""), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "./"), null);
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1/.."), null);
  // Must not over-reject: these are still ordinary children.
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1"), path.join("/tmp/daemon", "agent-1"));
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", ".hidden-agent"), path.join("/tmp/daemon", ".hidden-agent"));
  // Deliberate, and the one behaviour the containment guard widens: the old blocklist
  // rejected this purely because it contains "/". It names the same directory as
  // "agent-1" and resolves one level below the root, so it is accepted now. Pinned here
  // so the change is a decision on the record rather than a side effect.
  assert.equal(resolveWorkspaceDirectoryPath("/tmp/daemon", "agent-1/"), path.join("/tmp/daemon", "agent-1"));
});

test("deleteWorkspaceDirectory leaves the root intact when asked to delete '.'", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-root-"));
  try {
    const targetDir = path.join(root, "agent-keep");
    await mkdir(targetDir);
    await writeFile(path.join(targetDir, "notes.md"), "must survive");

    assert.equal(await deleteWorkspaceDirectory(root, ".", idleGuard), false);
    assert.equal(await deleteWorkspaceDirectory(root, "", idleGuard), false);

    // The assertion with teeth. `false` alone is not the property that matters --
    // what matters is that the root and its contents are still there afterwards.
    assert.deepEqual(
      (await scanWorkspaceDirectories(root)).map((d) => d.directoryName),
      ["agent-keep"],
      "deleting '.' must not remove every workspace on the machine",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace display paths are ~-relative under the user's home, absolute elsewhere", () => {
  assert.equal(workspaceDisplayPath("/home/alice/.raft/agents/a1", "/home/alice"), "~/.raft/agents/a1/");
  assert.equal(workspaceDisplayPath("/home/alice/.slock/agents/a1", "/home/alice"), "~/.slock/agents/a1/");
  assert.equal(workspaceDisplayPath("/srv/raft/agents/a1", "/home/alice"), "/srv/raft/agents/a1/");
  // A sibling that merely shares the prefix is not under the home.
  assert.equal(workspaceDisplayPath("/home/alice2/agents/a1", "/home/alice"), "/home/alice2/agents/a1/");
});

// The agents dir is shared by every server's daemon on a Computer. A delete
// from a wrong or older server must not take a workspace that is not an
// agent's, one an agent runs in here, or one another server's agent owns.
async function withWorkspaces(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "daemon-workspaces-guard-"));
  try {
    for (const name of [AGENT_ID, OTHER_AGENT_ID, "projects"]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "notes.md"), "keep");
    }
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("workspace delete refuses a name that is not an agent id", async () => {
  await withWorkspaces(async (root) => {
    assert.equal(workspaceDeleteRefusal(root, "projects", idleGuard), "not_agent_id");
    assert.equal(workspaceDeleteRefusal(root, "../x", idleGuard), "not_agent_id");
    assert.equal(workspaceDeleteRefusal(root, `${AGENT_ID}/`, idleGuard), "not_agent_id");
    assert.equal(await deleteWorkspaceDirectory(root, "projects", idleGuard), false);
    assert.equal(existsSync(path.join(root, "projects", "notes.md")), true);
  });
});

test("workspace delete refuses the workspace of an agent running here, in any letter case", async () => {
  await withWorkspaces(async (root) => {
    const guard: WorkspaceDeleteGuard = { serverId: SERVER_ID, isAgentRunning: (agentId) => agentId === AGENT_ID };
    assert.equal(workspaceDeleteRefusal(root, AGENT_ID, guard), "agent_running");
    assert.equal(workspaceDeleteRefusal(root, AGENT_ID.toUpperCase(), guard), "agent_running");
    assert.equal(await deleteWorkspaceDirectory(root, AGENT_ID, guard), false);
    assert.equal(existsSync(path.join(root, AGENT_ID, "notes.md")), true);
    // Another agent's workspace is not held by it.
    assert.equal(await deleteWorkspaceDirectory(root, OTHER_AGENT_ID, guard), true);
  });
});

test("workspace delete refuses a workspace whose owner marker names another server", async () => {
  await withWorkspaces(async (root) => {
    writeWorkspaceOwnerMarker(root, AGENT_ID, "server-b");
    assert.equal(workspaceDeleteRefusal(root, AGENT_ID, idleGuard), "owner_server_mismatch");
    assert.equal(workspaceDeleteRefusal(root, AGENT_ID, { ...idleGuard, serverId: null }), "owner_server_unknown");
    assert.equal(await deleteWorkspaceDirectory(root, AGENT_ID, idleGuard), false);
    assert.equal(existsSync(path.join(root, AGENT_ID, "notes.md")), true);
  });
});

test("workspace delete allows an idle agent workspace without an owner marker, or with an unparsable one", async () => {
  await withWorkspaces(async (root) => {
    assert.equal(readWorkspaceOwnerServerId(root, AGENT_ID), null);
    assert.equal(await deleteWorkspaceDirectory(root, AGENT_ID, { serverId: null, isAgentRunning: () => false }), true);
    assert.equal(existsSync(path.join(root, AGENT_ID)), false);

    await mkdir(path.join(root, ".agent-state", OTHER_AGENT_ID), { recursive: true });
    await writeFile(path.join(root, ".agent-state", OTHER_AGENT_ID, WORKSPACE_OWNER_MARKER_FILE), "{not json");
    assert.equal(await deleteWorkspaceDirectory(root, OTHER_AGENT_ID, idleGuard), true);
  });
});

test("workspace delete allows an idle agent workspace whose owner marker names this server", async () => {
  await withWorkspaces(async (root) => {
    writeWorkspaceOwnerMarker(root, AGENT_ID, SERVER_ID);
    assert.equal(readWorkspaceOwnerServerId(root, AGENT_ID), SERVER_ID);
    assert.equal(await deleteWorkspaceDirectory(root, AGENT_ID, idleGuard), true);
    assert.equal(existsSync(path.join(root, AGENT_ID)), false);
  });
});

test("preparing an agent's launch workspace records the launch's server as its owner", async () => {
  await withWorkspaces(async (root) => {
    const config = {
      name: "agent",
      description: "test agent",
      runtime: "claude",
      runtimeContext: { serverId: SERVER_ID },
    } as unknown as AgentConfig;
    await initializeLaunchWorkspace(path.join(root, AGENT_ID), AGENT_ID, config);
    // Beside the workspace, in the daemon's per-agent state; never inside the workspace.
    assert.equal(existsSync(path.join(root, ".agent-state", AGENT_ID, WORKSPACE_OWNER_MARKER_FILE)), true);
    assert.equal(readWorkspaceOwnerServerId(root, AGENT_ID), SERVER_ID);
    assert.equal(workspaceDeleteRefusal(root, AGENT_ID, { ...idleGuard, serverId: "server-b" }), "owner_server_mismatch");

    // A later launch for another server takes the workspace over.
    await initializeLaunchWorkspace(path.join(root, AGENT_ID), AGENT_ID, { ...config, runtimeContext: { serverId: "server-b" } });
    assert.equal(readWorkspaceOwnerServerId(root, AGENT_ID), "server-b");
  });
});
