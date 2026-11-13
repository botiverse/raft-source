import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { excludeFromWorkspaceGit } from "./index";

const FILE = ".agents/mcp_config.json";
let root: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const untracked = (cwd: string) => git(cwd, "status", "--porcelain", "--untracked-files=all");

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "exclude-git-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a repository stops seeing the file, in its own exclude, and only one line is added", () => {
  git(root, "init", "-q");
  mkdirSync(path.join(root, ".agents"));
  writeFileSync(path.join(root, ".agents", "mcp_config.json"), "{}");
  assert.match(untracked(root), /mcp_config\.json/);
  excludeFromWorkspaceGit(root, FILE);
  excludeFromWorkspaceGit(root, FILE);
  assert.equal(untracked(root), "");
  const exclude = readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((line) => line === `/${FILE}`).length, 1);
});

const commit = (cwd: string) => git(cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x");
const writeFile = (dir: string) => {
  mkdirSync(path.join(dir, ".agents"), { recursive: true });
  writeFileSync(path.join(dir, ".agents", "mcp_config.json"), "{}");
};

test("a workspace inside a repository covers that path only; the same name elsewhere stays visible", () => {
  git(root, "init", "-q");
  const nested = path.join(root, "agents", "a1");
  writeFile(nested);
  const other = path.join(root, "packages", "tool");
  writeFile(other);
  excludeFromWorkspaceGit(nested, FILE);
  assert.equal(untracked(root), "?? packages/tool/.agents/mcp_config.json\n");
});

test("a linked worktree writes the repository's shared exclude file", () => {
  git(root, "init", "-q");
  commit(root);
  const linked = path.join(root, "linked");
  git(root, "worktree", "add", "-q", linked);
  writeFile(linked);
  assert.match(untracked(linked), /mcp_config\.json/);
  excludeFromWorkspaceGit(linked, FILE);
  assert.equal(untracked(linked), "");
  assert.match(readFileSync(path.join(root, ".git", "info", "exclude"), "utf8"), /^\/\.agents\/mcp_config\.json$/m);
});

test("a workspace reached through a symlink writes the real repository's exclude file", () => {
  git(root, "init", "-q");
  const nested = path.join(root, "agents", "a1");
  writeFile(nested);
  const elsewhere = mkdtempSync(path.join(os.tmpdir(), "exclude-git-link-"));
  try {
    const link = path.join(elsewhere, "workspace");
    symlinkSync(nested, link);
    excludeFromWorkspaceGit(link, FILE);
    assert.equal(untracked(root), "");
    assert.equal(existsSync(path.join(elsewhere, ".git")), false);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("not a repository: nothing happens", () => {
  excludeFromWorkspaceGit(root, FILE);
  assert.equal(existsSync(path.join(root, ".git")), false);
  excludeFromWorkspaceGit(path.join(root, "missing"), FILE);
});
