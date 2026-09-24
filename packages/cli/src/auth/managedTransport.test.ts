import assert from "node:assert/strict";
import { spawnSync as realSpawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  forwardManagedTransportIfNeeded,
  ManagedTransportError,
  resolveManagedTransportWrapper,
  SLOCK_AGENT_LAUNCH_DIR_ENV,
  SLOCK_CLI_TRANSPORT_DIR_ENV,
} from "./managedTransport.js";

function fixture(): { root: string; wrapperDir: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-managed-forward-"));
  const wrapperDir = path.join(root, "cli-transport", "agent-1", "launch-1");
  mkdirSync(wrapperDir, { recursive: true });
  writeFileSync(path.join(wrapperDir, "raft"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return {
    root,
    wrapperDir,
    env: {
      SLOCK_HOME: root,
      SLOCK_AGENT_ID: "agent-1",
      [SLOCK_AGENT_LAUNCH_DIR_ENV]: "launch-1",
      [SLOCK_CLI_TRANSPORT_DIR_ENV]: wrapperDir,
      RAFT_PROFILE: "foreign-profile",
    },
  };
}

test("managed transport: a host-global CLI resolves the exact current-launch wrapper", () => {
  const { root, wrapperDir, env } = fixture();
  try {
    assert.equal(resolveManagedTransportWrapper(env, "linux"), path.join(wrapperDir, "raft"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: forwarding executes the wrapper instead of continuing with ambient profile", () => {
  const { root, env } = fixture();
  try {
    const calls: Array<{ command: string; argv: readonly string[] }> = [];
    const result = forwardManagedTransportIfNeeded(["message", "check"], env, {
      platform: "linux",
      spawnSync: ((command: string, argv: readonly string[]) => {
        calls.push({ command, argv });
        return { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: 0, signal: null };
      }) as unknown as typeof import("node:child_process").spawnSync,
    });
    assert.equal(result?.status, 0);
    assert.deepEqual(calls, [{
      command: path.join(env[SLOCK_CLI_TRANSPORT_DIR_ENV]!, "raft"),
      argv: ["message", "check"],
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: arbitrary or symlink transport directories fail closed", () => {
  const { root, env } = fixture();
  try {
    env[SLOCK_CLI_TRANSPORT_DIR_ENV] = path.join(root, "foreign");
    assert.throws(
      () => resolveManagedTransportWrapper(env, "linux"),
      (error: unknown) => error instanceof ManagedTransportError && error.code === "MANAGED_WRAPPER_UNAVAILABLE",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: wrapper-authenticated invocation does not recurse", () => {
  const { root, env } = fixture();
  try {
    env.SLOCK_AGENT_PROXY_TOKEN_FILE = path.join(root, "proxy-token");
    assert.equal(resolveManagedTransportWrapper(env, "linux"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed transport: the real CLI entry forwards before parsing or profile auth", { skip: process.platform === "win32" }, () => {
  const { root, wrapperDir, env } = fixture();
  const argsFile = path.join(root, "forwarded-args");
  try {
    writeFileSync(
      path.join(wrapperDir, "raft"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\nexit 23\n`,
      { mode: 0o755 },
    );
    const result = realSpawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts", "message", "check"],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: { ...process.env, ...env },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 23, result.stderr);
    assert.equal(readFileSync(argsFile, "utf8"), "message\ncheck\n");
    assert.doesNotMatch(result.stderr, /PROFILE_FILE|MISSING_TOKEN|unknown command/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
