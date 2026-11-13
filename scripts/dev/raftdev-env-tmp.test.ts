// The environment TMPDIR and cloudflared log path `./raftdev start` gives its
// services (the dir itself: raftdev-cache.ts / raftdev-cache.test.ts).
// Run: pnpm exec vitest run scripts/dev/raftdev-env-tmp.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import { cloudflaredLogPath, prepareServiceTmpdir, runTmuxShellCommand, serviceSpawnEnv, tmuxShellCommand } from "./raftdev";

test("tmux windows get the environment TMPDIR and compile cache exported", () => {
  const cmd = tmuxShellCommand("pnpm --filter @botiverse/raft-web dev", {
    NODE_COMPILE_CACHE: "/c/node-compile-cache",
    TMPDIR: "/c/env/0123abcd/tmp",
  }, "/bin/bash");
  assert.ok(cmd.startsWith("bash -lc "), cmd);
  assert.match(cmd, /export NODE_COMPILE_CACHE=\/c\/node-compile-cache; export TMPDIR=\/c\/env\/0123abcd\/tmp; pnpm --filter @botiverse\/raft-web dev; status=/);
  // TMPDIR precedes the command, so the command and its children inherit it.
  assert.ok(cmd.indexOf("export TMPDIR=") < cmd.indexOf("pnpm --filter"));
});

test("without an environment TMPDIR the window command is unchanged", () => {
  const cmd = tmuxShellCommand("run", { NODE_COMPILE_CACHE: undefined, TMPDIR: undefined }, "/bin/zsh");
  assert.equal(cmd, `bash -lc 'run; status=$?; echo; echo "[raftdev] command exited with status $status"; exec "/bin/zsh" -l'`);
});

test("the cloudflared log goes to the environment dir, else the caller's temp dir", () => {
  assert.equal(cloudflaredLogPath("demo", "/c/env/0123abcd", "/tmp"), "/c/env/0123abcd/cloudflared.log");
  assert.equal(cloudflaredLogPath("demo", null, "/srv/tmp"), "/srv/tmp/slockdev-cf-demo.log");
});

test.skipIf(process.platform !== "linux")("start gives TMPDIR to the windows and cloudflared, never to its own env (the tmux server's)", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "raftdev-env-tmp-"));
  const before = { ...process.env };
  try {
    const envDir = prepareServiceTmpdir(
      { SLOCKDEV_DIR: "/w/.slockdev/demo" },
      { env: { RAFT_DEV_CACHE_DIR: scratch }, maxTmpdirBytes: Infinity, warn: () => {} },
    );
    const tmp = envDir?.tmpdir ?? assert.fail("no environment TMPDIR");
    assert.ok(tmp.startsWith(path.join(scratch, "env") + path.sep), tmp);
    // `tmux new-session` (sh) spawns with process.env, which may start the
    // user's tmux server: it must not carry this environment's TMPDIR.
    assert.deepEqual({ ...process.env }, before);
    // Every window exports it; cloudflared gets it in its spawn env.
    assert.match(runTmuxShellCommand("pnpm dev"), new RegExp(`export TMPDIR=${tmp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}; pnpm dev`));
    const base = { PATH: "/bin" };
    assert.deepEqual(serviceSpawnEnv(base, envDir), { PATH: "/bin", TMPDIR: tmp });
    assert.deepEqual(base, { PATH: "/bin" });
    assert.equal(serviceSpawnEnv(base, null), base);
  } finally {
    // Back to no environment dir for the rest of this module.
    prepareServiceTmpdir({ SLOCKDEV_DIR: "/w/.slockdev/demo" }, { env: { RAFT_DEV_CACHE: "0" }, warn: () => {} });
    rmSync(scratch, { recursive: true, force: true });
  }
  assert.doesNotMatch(runTmuxShellCommand("pnpm dev"), /TMPDIR/);
});
