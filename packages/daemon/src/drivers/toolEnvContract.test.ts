// Contract: a managed agent's tools see the same agent env as a child-process
// runtime — the spawnEnv prepareCliTransport computed — with the agent identity
// present and the daemon's credential / profile keys and a web upgrade's
// operation variables absent. The in-process Kimi SDK engine spawns tools from
// the harness base env (kimiToolBaseEnv).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { kimiToolBaseEnv } from "./kimi-sdk";
import { prepareCliTransport } from "./cliTransport";
import type { SpawnContext } from "./types";

const DAEMON_ONLY_ENV = {
  SLOCK_AGENT_TOKEN_FILE: "/tmp/daemon-token-must-not-reach-tools",
  SLOCK_AGENT_PROXY_URL: "http://127.0.0.1:1/daemon-proxy",
  RAFT_PROFILE: "daemon-login-profile",
  // A web upgrade's operation variables, inherited by the service from the
  // installer that started it (#proj-raft-computer:#32).
  RAFT_COMPUTER_OPERATION_ID: "web-upgrade-operation-id",
  RAFT_COMPUTER_APPROVED_BY: "remote:web-upgrade-operation-id",
  RAFT_COMPUTER_NON_INTERACTIVE: "1",
  RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1",
};
// Computer configuration the service carries on purpose reaches the agent.
const COMPUTER_CONFIG_ENV = { RAFT_COMPUTER_INSTALLER_CHANNEL: "alpha" };
const PROBE_KEYS = ["SLOCK_AGENT_ID", "SLOCK_SERVER_URL", "RAFT_CURRENT_COMPUTER_ID", ...Object.keys(COMPUTER_CONFIG_ENV), ...Object.keys(DAEMON_ONLY_ENV)];
const PROBE = `printf '%s|' ${PROBE_KEYS.map((key) => `"\${${key}-unset}"`).join(" ")}`;
const EXPECTED = ["contract-agent", "https://contract.raft.test", "contract-computer", "alpha", ...Object.keys(DAEMON_ONLY_ENV).map(() => "unset")]
  .map((value) => `${value}|`).join("");

const saved: Record<string, string | undefined> = {};
let root = "";
let spawnEnv: NodeJS.ProcessEnv = {};

beforeAll(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), "slock-tool-env-contract-"));
  for (const [key, value] of Object.entries({ ...DAEMON_ONLY_ENV, ...COMPUTER_CONFIG_ENV, SLOCK_HOME: path.join(root, "home") })) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  const ctx = {
    agentId: "contract-agent",
    config: {
      runtime: "claude",
      serverUrl: "https://contract.raft.test",
      authToken: "contract-token",
      runtimeContext: { agentId: "contract-agent", machineId: "contract-computer" },
    },
    standingPrompt: "",
    prompt: "",
    workingDirectory: root,
    launchId: "contract-launch",
    slockCliPath: "/fake/cli/index.js",
    daemonApiKey: "contract-daemon-key",
  } as unknown as SpawnContext;
  spawnEnv = (await prepareCliTransport(ctx, {}, process.platform)).spawnEnv;
});

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("child-process runtime: spawnEnv carries the agent and drops daemon credentials", { skip: process.platform === "win32" }, () => {
  const out = spawnSync("sh", ["-c", PROBE], { env: spawnEnv, encoding: "utf8" });
  assert.equal(out.stdout, EXPECTED);
});

test("Kimi SDK tool base env: same env as a child-process runtime", { skip: process.platform === "win32" }, async () => {
  // The Kimi engine spawns tool processes with the harness's baseEnv in place
  // of the daemon's process.env.
  const env = kimiToolBaseEnv({ spawnEnv, slockDir: spawnEnv.SLOCK_CLI_TRANSPORT_DIR ?? "", slockHome: spawnEnv.SLOCK_HOME ?? "" });
  assert.equal(execFileSync("sh", ["-c", PROBE], { env, encoding: "utf8" }), EXPECTED);
});
