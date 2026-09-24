import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";

import { resolveRaftHome } from "./paths.js";

test("resolveRaftHome: keeps ~/.slock as the default home", () => {
  assert.equal(resolveRaftHome({}, "/Users/alice"), path.resolve("/Users/alice/.slock"));
});

test("resolveRaftHome: ignores empty SLOCK_HOME instead of treating it as the home", () => {
  assert.equal(resolveRaftHome({ SLOCK_HOME: "" }, "/Users/alice"), path.resolve("/Users/alice/.slock"));
  assert.equal(resolveRaftHome({ SLOCK_HOME: "   " }, "/Users/alice"), path.resolve("/Users/alice/.slock"));
});

test("resolveRaftHome: accepts RAFT_HOME as a Computer home alias", () => {
  assert.equal(resolveRaftHome({ RAFT_HOME: "~/raft-state" }, "/Users/alice"), path.resolve("/Users/alice/raft-state"));
});

test("resolveRaftHome: RAFT_HOME takes precedence over SLOCK_HOME", () => {
  assert.equal(
    resolveRaftHome({ SLOCK_HOME: "/tmp/slock-home", RAFT_HOME: "/tmp/raft-home" }, "/Users/alice"),
    path.resolve("/tmp/raft-home"),
  );
});
