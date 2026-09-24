import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { listLegacyRaftStatePaths, resolveDefaultRaftHome, resolveRaftHome, resolveRaftHomePath } from "./raftHome.js";

test("resolveRaftHome defaults to ~/.slock", () => {
  assert.equal(resolveRaftHome({}, "/Users/alice"), path.resolve("/Users/alice/.slock"));
});

test("resolveDefaultRaftHome resolves the default root independently of SLOCK_HOME", () => {
  assert.equal(resolveDefaultRaftHome("/Users/alice"), path.resolve("/Users/alice/.slock"));
});

test("resolveRaftHome normalizes SLOCK_HOME to an absolute path", () => {
  assert.equal(resolveRaftHome({ SLOCK_HOME: "relative-slock-root" }, "/Users/alice"), path.resolve("relative-slock-root"));
});

test("resolveRaftHome accepts RAFT_HOME as a fallback", () => {
  assert.equal(resolveRaftHome({ RAFT_HOME: "relative-raft-root" }, "/Users/alice"), path.resolve("relative-raft-root"));
});

test("resolveRaftHome prefers RAFT_HOME over SLOCK_HOME when both are set", () => {
  assert.equal(
    resolveRaftHome({ SLOCK_HOME: "/tmp/slock-loses", RAFT_HOME: "/tmp/raft-wins" }, "/Users/alice"),
    path.resolve("/tmp/raft-wins"),
  );
});

test("resolveRaftHomePath derives child paths from the resolved state root", () => {
  assert.equal(
    resolveRaftHomePath("agents", "/tmp/slock-a"),
    path.join("/tmp/slock-a", "agents"),
  );
});

test("listLegacyRaftStatePaths reports existing default-root state when SLOCK_HOME is custom", () => {
  const home = path.join(os.tmpdir(), `slock-home-test-${process.pid}-${Date.now()}`);
  const customRoot = path.join(home, "custom");
  try {
    mkdirSync(path.join(home, ".slock", "agents"), { recursive: true });
    mkdirSync(path.join(home, ".slock", "machines"), { recursive: true });

    const paths = listLegacyRaftStatePaths(customRoot, home);
    assert.deepEqual(paths.map((entry) => entry.path).sort(), [
      path.join(home, ".slock", "agents"),
      path.join(home, ".slock", "machines"),
    ].sort());
    assert.deepEqual(paths.map((entry) => entry.destination).sort(), [
      path.join(customRoot, "agents"),
      path.join(customRoot, "machines"),
    ].sort());
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listLegacyRaftStatePaths is empty for default SLOCK_HOME", () => {
  const home = path.join(os.tmpdir(), `slock-home-default-test-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(path.join(home, ".slock", "agents"), { recursive: true });
    assert.deepEqual(listLegacyRaftStatePaths(path.join(home, ".slock"), home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
