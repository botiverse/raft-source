// The workspace file viewer never follows a symbolic link: a person allowed to
// view one agent's workspace must not reach other files on the Computer (the
// Computer key, runtime auth, other agents' workspaces) through a link the
// agent made. Refusals answer exactly like a missing file.

import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listWorkspaceDirectory, readWorkspaceFile } from "./agentWorkspaceViewer";

async function withWorkspace(fn: (dirs: { workspace: string; outside: string }) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-viewer-"));
  const workspace = path.join(root, "agents", "agent-1");
  const outside = path.join(root, "outside");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(outside, "dir"), { recursive: true });
  await writeFile(path.join(outside, "runner.state.json"), "{\"computerKey\":\"sk-outside\"}\n");
  await writeFile(path.join(outside, "dir", "notes.md"), "outside notes\n");
  try {
    await fn({ workspace, outside });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** What a missing file gives; every refusal must look the same. */
async function missingFileError(workspace: string): Promise<unknown> {
  return readWorkspaceFile(workspace, "does-not-exist.md").then(
    () => assert.fail("missing file read"),
    (error: unknown) => error,
  );
}

async function assertRefusedLikeMissing(workspace: string, filePath: string): Promise<void> {
  const missing = await missingFileError(workspace) as NodeJS.ErrnoException;
  await assert.rejects(readWorkspaceFile(workspace, filePath), (error: NodeJS.ErrnoException) => {
    assert.equal(error.message, missing.message);
    assert.equal(error.code, missing.code);
    return true;
  });
}

test("a link to a file outside the workspace is listed as a link and reads like a missing file", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n");
    await symlink(path.join(outside, "runner.state.json"), path.join(workspace, "state.json"));

    const files = await listWorkspaceDirectory(workspace);
    const link = files.find((file) => file.name === "state.json");
    assert.deepEqual(link, {
      name: "state.json",
      path: "state.json",
      isDirectory: false,
      isSymlink: true,
      size: 0,
      modifiedAt: link?.modifiedAt,
      isHidden: false,
    });
    assert.ok(!JSON.stringify(files).includes(outside), "the link target is never sent");

    await assertRefusedLikeMissing(workspace, "state.json");
  });
});

test("a link to a directory outside cannot be listed into or read through", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await symlink(path.join(outside, "dir"), path.join(workspace, "shared"));

    const files = await listWorkspaceDirectory(workspace);
    assert.deepEqual(files.map((file) => [file.name, file.isDirectory, file.isSymlink]), [["shared", false, true]]);
    assert.deepEqual(await listWorkspaceDirectory(workspace, "shared"), []);
    // A link in the middle of the path is refused too.
    await assertRefusedLikeMissing(workspace, "shared/notes.md");
  });
});

test("a link pointing inside the workspace is not followed either", async () => {
  await withWorkspace(async ({ workspace }) => {
    await mkdir(path.join(workspace, "docs"));
    await writeFile(path.join(workspace, "docs", "plan.md"), "plan\n");
    await symlink(path.join(workspace, "docs", "plan.md"), path.join(workspace, "plan-link.md"));
    await symlink("docs", path.join(workspace, "docs-link"));

    await assertRefusedLikeMissing(workspace, "plan-link.md");
    await assertRefusedLikeMissing(workspace, "docs-link/plan.md");
    assert.deepEqual(await listWorkspaceDirectory(workspace, "docs-link"), []);
    assert.equal((await readWorkspaceFile(workspace, "docs/plan.md")).content, "plan\n");
  });
});

test("nested links and a link deeper in the tree are refused", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await mkdir(path.join(workspace, "a", "b"), { recursive: true });
    await symlink(path.join(outside, "dir"), path.join(workspace, "a", "b", "out"));
    await symlink(path.join(workspace, "a", "b", "out"), path.join(workspace, "a", "chain"));
    await symlink(path.join(workspace, "a"), path.join(workspace, "a-link"));

    const inner = await listWorkspaceDirectory(workspace, "a/b");
    assert.deepEqual(inner.map((file) => [file.path, file.isSymlink]), [[path.join("a", "b", "out"), true]]);
    assert.deepEqual(await listWorkspaceDirectory(workspace, "a/b/out"), []);
    assert.deepEqual(await listWorkspaceDirectory(workspace, "a/chain"), []);
    assert.deepEqual(await listWorkspaceDirectory(workspace, "a-link/b"), []);
    await assertRefusedLikeMissing(workspace, "a/b/out/notes.md");
    await assertRefusedLikeMissing(workspace, "a/chain/notes.md");
    await assertRefusedLikeMissing(workspace, "a-link/b/out/notes.md");
  });
});

test("a dangling link is listed as a link and reads like a missing file", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await symlink(path.join(outside, "gone.json"), path.join(workspace, "gone.json"));
    const files = await listWorkspaceDirectory(workspace);
    assert.deepEqual(files.map((file) => [file.name, file.isSymlink]), [["gone.json", true]]);
    await assertRefusedLikeMissing(workspace, "gone.json");
  });
});

test("a workspace root that is itself a link is neither listed nor read", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    const linkedRoot = path.join(path.dirname(workspace), "agent-2");
    await symlink(outside, linkedRoot);
    assert.deepEqual(await listWorkspaceDirectory(linkedRoot), []);
    assert.deepEqual(await listWorkspaceDirectory(linkedRoot, "dir"), []);
    await assert.rejects(readWorkspaceFile(linkedRoot, "runner.state.json"), /File not found/);
  });
});

test("a hard link to a file outside the workspace is listed but reads like a missing file", async () => {
  await withWorkspace(async ({ workspace, outside }) => {
    await link(path.join(outside, "runner.state.json"), path.join(workspace, "notes.txt"));

    const files = await listWorkspaceDirectory(workspace);
    assert.ok(files.some((file) => file.name === "notes.txt"), "still listed");
    await assertRefusedLikeMissing(workspace, "notes.txt");
  });
});

test("regular files, directories, hidden files and path refusals are unchanged", async () => {
  await withWorkspace(async ({ workspace }) => {
    await mkdir(path.join(workspace, "notes"));
    await writeFile(path.join(workspace, "notes", "today.md"), "today\n");
    await writeFile(path.join(workspace, "MEMORY.md"), "# memory\n");
    await writeFile(path.join(workspace, ".gitignore"), "node_modules\n");
    await mkdir(path.join(workspace, ".ssh"));
    await writeFile(path.join(workspace, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const files = await listWorkspaceDirectory(workspace);
    assert.deepEqual(files.map((file) => [file.name, file.isDirectory, file.isSymlink]), [
      ["notes", true, undefined],
      ["image.png", false, undefined],
      ["MEMORY.md", false, undefined],
    ]);
    const withHidden = await listWorkspaceDirectory(workspace, undefined, true);
    assert.deepEqual(withHidden.map((file) => file.name), ["notes", ".gitignore", "image.png", "MEMORY.md"]);
    assert.deepEqual((await listWorkspaceDirectory(workspace, "notes")).map((file) => file.path), [path.join("notes", "today.md")]);

    assert.deepEqual(await readWorkspaceFile(workspace, "notes/today.md"), { content: "today\n", binary: false, size: 6, encoding: "utf-8" });
    assert.equal((await readWorkspaceFile(workspace, "image.png")).content, "iVBORw==");
    await assert.rejects(readWorkspaceFile(workspace, "notes"), /Cannot read a directory/);
    await assert.rejects(readWorkspaceFile(workspace, "../outside/runner.state.json"), /Access denied/);
    await assert.rejects(readWorkspaceFile(workspace, "/etc/hosts"), /Access denied/);
    assert.deepEqual(await listWorkspaceDirectory(workspace, ".."), []);
  });
});
