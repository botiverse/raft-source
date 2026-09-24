import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareDevStartEnv } from "./dev-start.mjs";

test("prepareDevStartEnv creates an isolated SLOCK_HOME when none is provided", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "dev-start-test-"));
  try {
    const env = prepareDevStartEnv({ PATH: "/bin" }, "/Users/alice", tempRoot);
    assert.match(env.SLOCK_HOME, /^\/.*dev-start-test-.*\/raft-computer-app-dev-/);
    assert.equal(env.RAFT_HOME, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepareDevStartEnv refuses explicit real ~/.slock unless forced", () => {
  assert.throws(
    () => prepareDevStartEnv({ SLOCK_HOME: "~/.slock" }, "/Users/alice", tmpdir()),
    /Refusing to start the Desktop app dev build against real ~\/\.slock/,
  );
});

test("prepareDevStartEnv allows explicit real home only with force flag", () => {
  const env = prepareDevStartEnv(
    { SLOCK_HOME: "~/.slock", RAFT_COMPUTER_APP_ALLOW_REAL_HOME: "1" },
    "/Users/alice",
    tmpdir(),
  );
  assert.equal(env.SLOCK_HOME, "/Users/alice/.slock");
});

test("prepareDevStartEnv prefers RAFT_HOME and normalizes SLOCK_HOME to match", () => {
  const env = prepareDevStartEnv(
    { SLOCK_HOME: "/tmp/explicit-slock", RAFT_HOME: "/tmp/explicit-raft" },
    "/Users/alice",
    tmpdir(),
  );
  assert.equal(env.SLOCK_HOME, "/tmp/explicit-raft");
  assert.equal(env.RAFT_HOME, "/tmp/explicit-raft");
});
