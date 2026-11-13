// #proj-raft-computer:#58: the agent's stable CLI entry
// (cli-transport/<agent>/current/) is rewritten by every launch to use that
// launch's own proxy credential, so a process that outlived its session
// reaches the agent's current session through it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetAgentCredentialProxyForTest } from "../agentCredentialProxy";
import { buildCliStableEntryDir, POWERSHELL_WRAPPER_ENV_NAMES, prepareCliTransport, upgradeExistingAgentWrappers } from "./cliTransport";
import type { SpawnContext } from "./types";

const AGENT = "agent-simons";

function makeCtx(tmp: string, launchId: string, cliPath: string, credential = "sk_agent_simons"): SpawnContext {
  return {
    agentId: AGENT,
    config: { runtime: "claude", serverUrl: "https://test.slock.dev", authToken: "", agentCredentialKey: credential } as never,
    standingPrompt: "standing prompt",
    prompt: "test prompt",
    workingDirectory: path.join(tmp, "workspace"),
    launchId,
    slockCliPath: cliPath,
    daemonApiKey: "daemon-key",
    slockHome: path.join(tmp, "home"),
  };
}

afterEach(async () => {
  await __resetAgentCredentialProxyForTest();
});

test("the stable entry runs the CLI as the agent's newest launch, from a process of an older one", { skip: process.platform === "win32" }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "raft-stable-entry-"));
  try {
    const cliPath = path.join(tmp, "fake-cli.cjs");
    const outPath = path.join(tmp, "env.json");
    writeFileSync(cliPath, `
const { writeFileSync } = require("node:fs");
const pick = ["RAFT_CLI_ENTRY", "SLOCK_AGENT_ID", "SLOCK_AGENT_PROXY_TOKEN_FILE", "SLOCK_CLI_TRANSPORT_DIR", "SLOCK_AGENT_LAUNCH_DIR", "SLOCK_HOME"];
writeFileSync(process.env.RAFT_TEST_OUT, JSON.stringify(Object.fromEntries(pick.map((k) => [k, process.env[k]]))), "utf8");
`, "utf8");
    const first = await prepareCliTransport(makeCtx(tmp, "b5b6d993-old", cliPath), {}, "linux");
    const stableDir = buildCliStableEntryDir(path.join(tmp, "home"), AGENT);
    assert.equal(stableDir, path.join(tmp, "home", "cli-transport", AGENT, "current"));
    const stableRaft = path.join(stableDir, "raft");
    assert.ok(existsSync(stableRaft));
    assert.equal(readFileSync(path.join(stableDir, "slock"), "utf8"), readFileSync(stableRaft, "utf8"));
    assert.ok(existsSync(path.join(stableDir, "cont")), "cont answers through the stable raft beside it");
    assert.doesNotMatch(readFileSync(stableRaft, "utf8"), /SLOCK_AGENT_LAUNCH_DIR:-/, "the stable entry never forwards to a launch");

    // The background process keeps the env of the launch it was started from.
    const run = (wrapper: string) => {
      const result = spawnSync(wrapper, ["server", "info"], {
        env: { ...first.spawnEnv, RAFT_TEST_OUT: outPath },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return JSON.parse(readFileSync(outPath, "utf8")) as Record<string, string | undefined>;
    };
    const tokenFile = (launch: string) => path.join(tmp, "home", "agent-proxy-tokens", AGENT, `${launch}.token`);

    assert.deepEqual(run(stableRaft), {
      RAFT_CLI_ENTRY: "stable_entry",
      SLOCK_AGENT_ID: AGENT,
      SLOCK_AGENT_PROXY_TOKEN_FILE: tokenFile("b5b6d993-old"),
      SLOCK_CLI_TRANSPORT_DIR: first.slockDir,
      SLOCK_AGENT_LAUNCH_DIR: "b5b6d993-old",
      SLOCK_HOME: path.join(tmp, "home"),
    });

    // Session rotation: the newer launch rewrites the stable entry.
    const second = await prepareCliTransport(makeCtx(tmp, "360baf1f-new", cliPath), {}, "linux");
    assert.deepEqual(run(stableRaft), {
      RAFT_CLI_ENTRY: "stable_entry",
      SLOCK_AGENT_ID: AGENT,
      SLOCK_AGENT_PROXY_TOKEN_FILE: tokenFile("360baf1f-new"),
      SLOCK_CLI_TRANSPORT_DIR: second.slockDir,
      SLOCK_AGENT_LAUNCH_DIR: "360baf1f-new",
      SLOCK_HOME: path.join(tmp, "home"),
    });
    // The old launch's own wrapper still uses only its own (now retired) credential, and is not the stable entry.
    const old = run(path.join(first.slockDir, "raft"));
    assert.equal(old.SLOCK_AGENT_PROXY_TOKEN_FILE, tokenFile("b5b6d993-old"));
    assert.equal(old.RAFT_CLI_ENTRY, undefined);

    // Launch-wrapper upgrades never touch the stable entry.
    const before = readFileSync(stableRaft, "utf8");
    const scanned = upgradeExistingAgentWrappers(path.dirname(second.slockDir), second.slockDir, "linux");
    assert.equal(scanned.scanned, 2, "only the old launch's slock and raft");
    assert.equal(readFileSync(stableRaft, "utf8"), before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a launch without a runner credential writes no stable entry", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "raft-stable-entry-"));
  try {
    await prepareCliTransport(makeCtx(tmp, "launch-a", "/fake/cli.js", ""), {}, "linux");
    assert.ok(!existsSync(buildCliStableEntryDir(path.join(tmp, "home"), AGENT)));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("on Windows the stable entry has .cmd and .ps1 flavors that say they are the stable entry", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "raft-stable-entry-"));
  try {
    const result = await prepareCliTransport(makeCtx(tmp, "launch-w", "/fake/cli.js"), {}, "win32");
    const stableDir = buildCliStableEntryDir(path.join(tmp, "home"), AGENT);
    const cmd = readFileSync(path.join(stableDir, "raft.cmd"), "utf8");
    assert.match(cmd, /^@echo off\r\n@REM .*stable entry/);
    assert.match(cmd, /\r\nsetlocal\r\n/);
    assert.match(cmd, /set "RAFT_CLI_ENTRY=stable_entry"/);
    assert.match(cmd, new RegExp(`set "SLOCK_CLI_TRANSPORT_DIR=${result.slockDir.replace(/[\\.]/g, "\\$&")}"`));
    assert.doesNotMatch(cmd, /SLOCK_FORWARD_TARGET/, "no launch forwarding");
    const ps1 = readFileSync(path.join(stableDir, "raft.ps1"), "utf8");
    assert.match(ps1, /\$env:RAFT_CLI_ENTRY='stable_entry'/);
    // Every name the .ps1 sets is restored after the call (task #384).
    for (const name of ["RAFT_CLI_ENTRY", "SLOCK_HOME", "SLOCK_CLI_TRANSPORT_DIR", "SLOCK_AGENT_LAUNCH_DIR"]) {
      assert.ok((POWERSHELL_WRAPPER_ENV_NAMES as readonly string[]).includes(name), name);
    }
    assert.ok(existsSync(path.join(stableDir, "slock.cmd")) && existsSync(path.join(stableDir, "slock.ps1")));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
