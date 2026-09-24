import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";

import { readBundledCliVersion, readBundledDaemonVersion, readComputerVersion } from "./version.js";

type VersionEnv = {
  raft?: string;
  slock?: string;
  daemon?: string;
};

async function withVersionEnv<T>(env: VersionEnv, fn: () => T | Promise<T>): Promise<T> {
  const previousRaft = process.env.RAFT_COMPUTER_VERSION;
  const previousSlock = process.env.SLOCK_COMPUTER_VERSION;
  const previousDaemon = process.env.RAFT_DAEMON_VERSION;
  setEnvValue("RAFT_COMPUTER_VERSION", env.raft);
  setEnvValue("SLOCK_COMPUTER_VERSION", env.slock);
  setEnvValue("RAFT_DAEMON_VERSION", env.daemon);
  try {
    return await fn();
  } finally {
    setEnvValue("RAFT_COMPUTER_VERSION", previousRaft);
    setEnvValue("SLOCK_COMPUTER_VERSION", previousSlock);
    setEnvValue("RAFT_DAEMON_VERSION", previousDaemon);
  }
}

function setEnvValue(
  name: "RAFT_COMPUTER_VERSION" | "SLOCK_COMPUTER_VERSION" | "RAFT_DAEMON_VERSION",
  value: string | undefined,
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

test("readComputerVersion reads package metadata and ignores runtime version env", async () => {
  await withVersionEnv({ raft: "7.7.7-env-must-not-win", slock: "9.9.9-legacy-dirty" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "raft-computer-version-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.8.7-test" }));
      const distUrl = pathToFileURL(join(root, "dist", "index.js")).href;
      assert.equal(readComputerVersion(distUrl), "9.8.7-test");
      const libraryUrl = pathToFileURL(join(root, "dist", "lib", "index.js")).href;
      assert.equal(readComputerVersion(libraryUrl), "9.8.7-test");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("readComputerVersion falls back for missing or malformed package metadata", async () => {
  await withVersionEnv({ raft: undefined, slock: "9.9.9-legacy-dirty" }, async () => {
    assert.equal(readComputerVersion(pathToFileURL(resolve(tmpdir(), "missing", "dist", "index.js")).href), "0.0.0-dev");

    const root = await mkdtemp(join(tmpdir(), "raft-computer-version-bad-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify({ version: 123 }));
      const distUrl = pathToFileURL(join(root, "dist", "index.js")).href;
      assert.equal(readComputerVersion(distUrl), "0.0.0-dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("readComputerVersion accepts an injected SEA build constant without package metadata", async () => {
  await withVersionEnv({ raft: "7.7.7-env-must-not-win", slock: "9.9.9-legacy-dirty" }, () => {
    const missing = pathToFileURL(resolve(tmpdir(), "no-such-sea", "dist", "index.js")).href;
    assert.equal(readComputerVersion(missing, "1.2.3-sea"), "1.2.3-sea");
  });
});

test("readBundledDaemonVersion exposes the daemon version baked into Computer SEA", async () => {
  await withVersionEnv({ daemon: "42.0.0-env-must-not-win" }, () => {
    assert.equal(readBundledDaemonVersion("0.72.4-sea"), "0.72.4-sea");
    assert.equal(readBundledDaemonVersion(), undefined);
  });
});

test("readBundledCliVersion exposes the CLI version baked into Computer SEA", async () => {
  const previous = process.env.RAFT_CLI_VERSION;
  process.env.RAFT_CLI_VERSION = "99.0.0-env-must-not-win";
  try {
    assert.equal(readBundledCliVersion("0.0.17"), "0.0.17");
    assert.equal(readBundledCliVersion(), undefined);
  } finally {
    if (previous === undefined) delete process.env.RAFT_CLI_VERSION;
    else process.env.RAFT_CLI_VERSION = previous;
  }
});
