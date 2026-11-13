import assert from "node:assert/strict";

import { execFileSync } from "node:child_process";

import {
  buildRunnerChildEnv,
  PARENT_LOCK_HELD_ENV_VAR,
  removeServiceAddedMallocEnv,
  RUNNER_MALLOC_ADDED_ENV_VAR,
  RUNNER_MALLOC_ENV,
} from "./runnerChildEnv";

// task #915: a service running from ~/.raft while ~/.slock also holds state
// must hand its own home to the daemon (and through it to agents and tools
// such as Stamp/Hands that read only SLOCK_HOME); re-running the default rule
// below the service would land on ~/.slock.
test("buildRunnerChildEnv pins the service's home as both RAFT_HOME and SLOCK_HOME", () => {
  const env = buildRunnerChildEnv(
    { PATH: "/usr/bin", SLOCK_HOME: "/Users/alice/.slock", [PARENT_LOCK_HELD_ENV_VAR]: "1" },
    "/Users/alice/.raft",
  );
  assert.equal(env.RAFT_HOME, "/Users/alice/.raft");
  assert.equal(env.SLOCK_HOME, "/Users/alice/.raft");
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env[PARENT_LOCK_HELD_ENV_VAR], undefined);
});

test("buildRunnerChildEnv without a home leaves the inherited home untouched", () => {
  const env = buildRunnerChildEnv({ SLOCK_HOME: "/x" });
  assert.equal(env.SLOCK_HOME, "/x");
  assert.equal(env.RAFT_HOME, undefined);
});

// #wg-memory-usage:#36: the runner starts with glibc malloc settings on Linux,
// and nothing it spawns inherits them unless the user set them.
test("buildRunnerChildEnv adds the malloc settings on Linux only", () => {
  const linux = buildRunnerChildEnv({ PATH: "/usr/bin" }, undefined, "linux");
  assert.equal(linux.MALLOC_ARENA_MAX, "2");
  assert.equal(linux.MALLOC_MMAP_THRESHOLD_, "131072");
  assert.equal(linux[RUNNER_MALLOC_ADDED_ENV_VAR], "MALLOC_ARENA_MAX,MALLOC_MMAP_THRESHOLD_");
  for (const platform of ["darwin", "win32"] as const) {
    const env = buildRunnerChildEnv({ PATH: "/usr/bin" }, undefined, platform);
    assert.equal(env.MALLOC_ARENA_MAX, undefined);
    assert.equal(env.MALLOC_MMAP_THRESHOLD_, undefined);
    assert.equal(env[RUNNER_MALLOC_ADDED_ENV_VAR], undefined);
  }
});

test("buildRunnerChildEnv keeps a user's own malloc value and marks only what it added", () => {
  const env = buildRunnerChildEnv({ MALLOC_ARENA_MAX: "8" }, undefined, "linux");
  assert.equal(env.MALLOC_ARENA_MAX, "8");
  assert.equal(env.MALLOC_MMAP_THRESHOLD_, "131072");
  assert.equal(env[RUNNER_MALLOC_ADDED_ENV_VAR], "MALLOC_MMAP_THRESHOLD_");
  const both = buildRunnerChildEnv({ MALLOC_ARENA_MAX: "8", MALLOC_MMAP_THRESHOLD_: "65536" }, undefined, "linux");
  assert.equal(both[RUNNER_MALLOC_ADDED_ENV_VAR], undefined);
});

test("buildRunnerChildEnv does not trust an inherited added-marker", () => {
  // A marker leaking into the service's own env must not make the runner
  // delete a value the user set.
  const env = buildRunnerChildEnv(
    { MALLOC_ARENA_MAX: "8", [RUNNER_MALLOC_ADDED_ENV_VAR]: "MALLOC_ARENA_MAX" },
    undefined,
    "linux",
  );
  assert.equal(env[RUNNER_MALLOC_ADDED_ENV_VAR], "MALLOC_MMAP_THRESHOLD_");
  removeServiceAddedMallocEnv(env);
  assert.equal(env.MALLOC_ARENA_MAX, "8");
});

test("removeServiceAddedMallocEnv removes only the added names", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    MALLOC_ARENA_MAX: "8",
    MALLOC_MMAP_THRESHOLD_: "131072",
    [RUNNER_MALLOC_ADDED_ENV_VAR]: "MALLOC_MMAP_THRESHOLD_,PATH",
  };
  removeServiceAddedMallocEnv(env);
  assert.deepEqual(env, { PATH: "/usr/bin", MALLOC_ARENA_MAX: "8" });
});

test("a process the runner spawns does not inherit the service-added malloc settings", () => {
  // Real processes: the "runner" starts with the env the service builds,
  // removes the added vars, then spawns a child that prints its env.
  // The function under test is shipped into the child as source, with the two
  // constants it reads, so the child runs exactly this module's logic.
  const runnerScript = `
    const { execFileSync } = require("node:child_process");
    const RUNNER_MALLOC_ADDED_ENV_VAR = ${JSON.stringify(RUNNER_MALLOC_ADDED_ENV_VAR)};
    const RUNNER_MALLOC_ENV = ${JSON.stringify(RUNNER_MALLOC_ENV)};
    const removeServiceAddedMallocEnv = ${removeServiceAddedMallocEnv.toString()};
    const before = { arena: process.env.MALLOC_ARENA_MAX, threshold: process.env.MALLOC_MMAP_THRESHOLD_ };
    removeServiceAddedMallocEnv(process.env);
    const child = execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({ arena: process.env.MALLOC_ARENA_MAX ?? null, threshold: process.env.MALLOC_MMAP_THRESHOLD_ ?? null, marker: process.env.${RUNNER_MALLOC_ADDED_ENV_VAR} ?? null }))"], { encoding: "utf8" });
    process.stdout.write(JSON.stringify({ before, child: JSON.parse(child) }));
  `;
  const run = (base: NodeJS.ProcessEnv) => JSON.parse(execFileSync(
    process.execPath,
    ["-e", runnerScript],
    { encoding: "utf8", env: buildRunnerChildEnv({ PATH: process.env.PATH, ...base }, undefined, "linux") },
  ));

  const ours = run({});
  assert.deepEqual(ours.before, { arena: "2", threshold: "131072" });
  assert.deepEqual(ours.child, { arena: null, threshold: null, marker: null });

  const users = run({ MALLOC_ARENA_MAX: "4" });
  assert.deepEqual(users.before, { arena: "4", threshold: "131072" });
  assert.deepEqual(users.child, { arena: "4", threshold: null, marker: null });
});
