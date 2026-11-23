import assert from "node:assert/strict";
import { ELECTRON_NODE_SCRIPT_EXEC_ARGV } from "./nodeHostLaunch";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { execFileSync } from "node:child_process";
import {
  buildCodexAppServerArgs,
  codexThreadFields,
  CODEX_MANAGED_MCP_TOKEN_ENV,
  withCodexManagedMcpToken,
  CODEX_NPM_ROOT_TIMEOUT_MS,
  clearCodexProbeCacheForTests,
  detectCodexModels,
  detectCodexModelsFromAppServer,
  prepareCodexLaunch,
  probeCodex,
  compareCodexVersions,
  parseCodexVersion,
  resolveCodexCommand,
  resolveCodexSpawn,
  resolveCodexSpawnAsync,
} from "./codex";
import { ProbeChildError, type runProbeChild } from "./probeChild";
import { resolveCodexHomeRootFromEnv } from "./codexHome";
import type { SpawnContext } from "./types";

/** task #1277: plays a sync execFileSync stand-in through the async probe-child seam (same error objects, same verdicts). */
function viaProbeChild(execFileSyncFn: typeof execFileSync): typeof runProbeChild {
  return async (command, args) => ({ stdout: String(execFileSyncFn(command, [...args]) ?? ""), stderr: "" });
}

const codexConfig = {
  name: "codex-agent",
  displayName: "Codex Agent",
  description: "test agent",
  model: "gpt-5.3-codex",
  runtime: "codex",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.slock.ai",
  authToken: "sk_machine_test",
};

test("codex app-server gets the managed MCP endpoint without its token: the token is read from its own environment", () => {
  const args = buildCodexAppServerArgs({ name: "raft_managed", endpointUrl: "http://127.0.0.1:43123/mcp" });
  assert.deepEqual(args, [
    "app-server",
    "-c",
    'mcp_servers.raft_managed.url="http://127.0.0.1:43123/mcp"',
    "-c",
    `mcp_servers.raft_managed.bearer_token_env_var="${CODEX_MANAGED_MCP_TOKEN_ENV}"`,
    "--listen",
    "stdio://",
  ]);
  // #proj-runtime:#40: other OS users can read a process's arguments.
  assert.doesNotMatch(JSON.stringify(args), /\/mcp\/|Authorization|private\.example/);
});

test("only the app-server's own environment gets the managed MCP token", () => {
  const base = { PATH: "/usr/bin" };
  assert.deepEqual(withCodexManagedMcpToken(base, { token: "tok" }), { PATH: "/usr/bin", [CODEX_MANAGED_MCP_TOKEN_ENV]: "tok" });
  assert.deepEqual(base, { PATH: "/usr/bin" }, "the shared spawn env (discovery probes) stays without it");
  assert.equal(withCodexManagedMcpToken(base, null), base);
});

function makeSpawnContext(
  workingDirectory: string,
  overrides: Partial<SpawnContext["config"]> = {},
): SpawnContext {
  return {
    agentId: "agent-1",
    config: {
      ...codexConfig,
      ...overrides,
    },
    standingPrompt: "stand still",
    prompt: "initial prompt",
    workingDirectory,
    slockCliPath: process.execPath,
    daemonApiKey: "sk_machine_test",
    launchId: "launch-1",
  };
}

function installScriptedCodexAppServer(root: string): { binDir: string; logPath: string } {
  const binDir = path.join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  const logPath = path.join(root, "codex-app-server.log");
  const scriptPath = path.join(binDir, "codex");
  writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const scenario = process.env.SCRIPTED_CODEX_SCENARIO || "fresh";
const logPath = process.env.SCRIPTED_CODEX_LOG;

function log(message) {
  if (!logPath) return;
  const entry = { ...message };
  if (message.method === "thread/start" || message.method === "thread/resume") {
    entry.codexHomeEnv = process.env.CODEX_HOME || null;
  }
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

function writeTrustConfig(cwd) {
  const root = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), ".codex");
  fs.mkdirSync(root, { recursive: true });
  fs.appendFileSync(path.join(root, "config.toml"), "[projects." + JSON.stringify(cwd) + "]\\ntrust_level = \\"trusted\\"\\n");
}

if (process.argv[2] === "app-server" && process.argv[3] === "--help") {
  process.stdout.write("Usage: codex app-server\\n");
  process.exit(0);
}

if (process.argv[2] !== "app-server" || process.argv[3] !== "--listen" || process.argv[4] !== "stdio://") {
  console.error("unexpected argv: " + JSON.stringify(process.argv.slice(2)));
  process.exit(2);
}

let unarchived = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  log(message);

  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "scripted-codex/1.0.0 (Mac OS 26.4.1; arm64) Kaku/0.11.0 (scripted-codex; 1.0.0)" } });
    return;
  }

  if (message.method === "thread/resume") {
    if (scenario === "resume_pending") {
      return;
    }
    if (scenario === "resume_missing_rollout") {
      send({ id: message.id, error: { message: "No rollout found for thread " + message.params.threadId } });
      return;
    }
    if (scenario === "resume_thread_writer_busy") {
      send({ id: message.id, error: { message: "Thread " + message.params.threadId + " already has an active writer" } });
      return;
    }
    if (scenario === "resume_permission_denied") {
      send({ id: message.id, error: { message: "No permission to access thread " + message.params.threadId } });
      return;
    }
    if ((scenario === "resume_archived" && !unarchived) || scenario === "resume_archived_unarchive_fails") {
      const id = message.params.threadId;
      send({ id: message.id, error: { code: -32600, message: "session " + id + " is archived. Run \`codex unarchive " + id + "\` to unarchive it first." } });
      return;
    }
    if (scenario === "resume_named") {
      send({ id: message.id, result: { thread: { id: message.params.threadId, name: "Renamed by user" } } });
      return;
    }
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }

  if (message.method === "thread/unarchive") {
    if (scenario === "resume_archived_unarchive_fails") {
      send({ id: message.id, error: { code: -32600, message: "no archived rollout found for thread id " + message.params.threadId } });
      return;
    }
    unarchived = true;
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }

  if (message.method === "thread/start") {
    if (scenario === "trust_write_after_log_delay") {
      setTimeout(() => {
        writeTrustConfig(message.params.cwd);
        send({ id: message.id, result: { thread: { id: "fresh-thread-1" } } });
      }, 25);
      return;
    }
    if (scenario === "trust_write") {
      writeTrustConfig(message.params.cwd);
    }
    send({ id: message.id, result: { thread: { id: "fresh-thread-1" } } });
    return;
  }

  if (message.method === "model/list") {
    // task #1277: SCRIPTED_CODEX_HOLD_MS delays the reply so a test can cancel
    // while the app-server is active.
    const hold = Number(process.env.SCRIPTED_CODEX_HOLD_MS || 0);
    const reply = () => send({
      id: message.id,
      result: {
        data: [
          {
            id: "gpt-5.5",
            model: "gpt-5.5",
            displayName: "GPT-5.5",
            hidden: false,
            isDefault: true,
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "quick" },
              { reasoningEffort: "medium", description: "balanced" },
            ],
            defaultReasoningEffort: "medium",
            additionalSpeedTiers: ["fast"],
          },
          {
            id: "gpt-no-reasoning",
            model: "gpt-no-reasoning",
            displayName: "GPT No Reasoning",
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
          },
          {
            id: "gpt-legacy-reasoning",
            model: "gpt-legacy-reasoning",
            displayName: "GPT Legacy Reasoning",
            hidden: false,
            defaultReasoningEffort: "medium",
          },
          {
            id: "gpt-stale-default",
            model: "gpt-stale-default",
            displayName: "GPT Stale Default",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "low", description: "quick" }],
            defaultReasoningEffort: "high",
          },
          {
            // #wg-runtime-form:#27: an account with Ultrafast. Listed out of order,
            // with the default opt-out, a malformed id and copy to bound.
            id: "gpt-6.2-astra",
            model: "gpt-6.2-astra",
            displayName: "GPT-6.2-Astra",
            hidden: false,
            serviceTiers: [
              { id: "ultrafast", name: "Ultrafast", description: "Up to 4.5x speed,\\n uses more of your plan" },
              { id: "default", name: "Standard" },
              { id: "Not An Id", name: "Broken" },
              { id: "flex", name: "Flex", description: "Slower, cheaper" },
              { id: "priority", name: "Fast", description: "2x speed, increased usage" },
            ],
          },
          {
            // #wg-runtime-form:#31: explicitly no fast tiers (only default/flex).
            id: "gpt-no-fast",
            model: "gpt-no-fast",
            displayName: "GPT No Fast",
            hidden: false,
            serviceTiers: [{ id: "default", name: "Standard" }, { id: "flex", name: "Flex" }],
          },
          {
            id: "hidden-model",
            displayName: "Hidden",
            hidden: true,
          },
        ],
        nextCursor: null,
      },
    });
    if (hold > 0) setTimeout(reply, hold); else reply();
    return;
  }

  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-1", status: "completed" } } });
  }
});
`, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);
  return { binDir, logPath };
}


function readScriptedCodexMessages(logPath: string): any[] {
  try {
    return readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}


test("codex CODEX_HOME resolution preserves explicit user configuration", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-home-explicit-"));
  try {
    const explicitCodexHome = path.join(root, "user-codex-home");
    const env = {
      CODEX_HOME: explicitCodexHome,
      SLOCK_HOME: path.join(root, "slock-home"),
    } as NodeJS.ProcessEnv;

    const codexHome = resolveCodexHomeRootFromEnv(env, { defaultHomeDir: root });

    assert.equal(codexHome, explicitCodexHome);
    assert.equal(env.CODEX_HOME, explicitCodexHome);
    assert.equal(existsSync(path.join(root, "slock-home", "codex-home", "agent-1")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function withTempHome(cb: (home: string) => void) {
  const home = mkdtempSync(path.join(os.tmpdir(), "slock-codex-"));
  try { cb(home); } finally { rmSync(home, { recursive: true, force: true }); }
}

test("detectCodexModelsFromAppServer reads auth-filtered model/list metadata", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-model-list-test-"));
  try {
    const workDir = path.join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const { binDir, logPath } = installScriptedCodexAppServer(root);
    const result = await detectCodexModelsFromAppServer({
      cwd: workDir,
      timeoutMs: 2000,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        SCRIPTED_CODEX_LOG: logPath,
      },
    });

    assert.deepEqual(result, {
      models: [{
        id: "gpt-5.5",
        label: "GPT-5.5",
        verified: "launchable",
        supportedReasoningEfforts: ["low", "medium"],
        defaultReasoningEffort: "medium",
        serviceTiers: ["fast"],
      }, {
        // task #triage:#431: an explicit empty list is reported (the model takes no effort), and its
        // default, which is not in it, is dropped.
        id: "gpt-no-reasoning",
        label: "GPT No Reasoning",
        verified: "launchable",
        supportedReasoningEfforts: [],
      }, {
        // No list at all: unknown, and the default passes through as before.
        id: "gpt-legacy-reasoning",
        label: "GPT Legacy Reasoning",
        verified: "launchable",
        defaultReasoningEffort: "medium",
      }, {
        id: "gpt-stale-default",
        label: "GPT Stale Default",
        verified: "launchable",
        supportedReasoningEfforts: ["low"],
      }, {
        id: "gpt-6.2-astra",
        label: "GPT-6.2-Astra",
        verified: "launchable",
        serviceTiers: ["ultrafast", "default", "Not An Id", "flex", "priority"],
        // Named tiers this Computer launches: primary first; the opt-out, the slower flex and a malformed id dropped; copy on one line.
        serviceTierChoices: [
          { id: "priority", name: "Fast", description: "2x speed, increased usage" },
          { id: "ultrafast", name: "Ultrafast", description: "Up to 4.5x speed, uses more of your plan" },
        ],
      }, {
        id: "gpt-no-fast",
        label: "GPT No Fast",
        verified: "launchable",
        serviceTiers: ["default", "flex"],
        serviceTierChoices: [],
      }],
      default: "gpt-5.5",
    });
    assert.deepEqual(
      readScriptedCodexMessages(logPath).map((message) => message.method),
      ["initialize", "initialized", "model/list"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("detectCodexModels returns null when cache missing", () => {
  withTempHome((home) => {
    assert.equal(detectCodexModels(home), null);
  });
});

test("detectCodexModels extracts visible API-supported models and reads default from config.toml", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-5.4", display_name: "GPT-5.4", visibility: "public" },
        { slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" },
        { slug: "gpt-5.4-codex", display_name: "GPT-5.4 Codex" },
        { slug: "hidden-picker-model", visibility: "hide" },
        { slug: "internal-preview", visibility: "internal" },
        { slug: "no-api", supported_in_api: false },
        { slug: "bare-slug" },
      ],
    }));
    writeFileSync(path.join(home, ".codex", "config.toml"), `model = "gpt-5.4-codex"\n`);

    const result = detectCodexModels(home);
    assert.ok(result);
    assert.deepEqual(result!.models.map((m) => m.id).sort(), ["bare-slug", "gpt-5.4", "gpt-5.4-codex", "gpt-5.5"]);
    const gpt54 = result!.models.find((m) => m.id === "gpt-5.4");
    assert.equal(gpt54?.label, "GPT-5.4");
    const gpt55 = result!.models.find((m) => m.id === "gpt-5.5");
    assert.equal(gpt55?.label, "GPT-5.5");
    const bare = result!.models.find((m) => m.id === "bare-slug");
    assert.equal(bare?.label, "bare-slug");
    assert.equal(result!.default, "gpt-5.4-codex");
  });
});

test("detectCodexModels keeps GPT-6.1 Sol only when the cache lists it", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".codex"));
    const write = (visibility: string) => writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility },
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
      ],
    }));
    write("list");
    assert.deepEqual(detectCodexModels(home)!.models.map((m) => m.id), ["gpt-6.1-sol", "gpt-6-astra"]);
    // A hidden entry stays hidden even though the bundled fallback knows the slug.
    write("hide");
    assert.deepEqual(detectCodexModels(home)!.models.map((m) => m.id), ["gpt-6-astra"]);
  });
});

test("detectCodexModels reads CODEX_HOME root-shaped cache and config", () => {
  withTempHome((home) => {
    writeFileSync(path.join(home, "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-5.5-codex", display_name: "GPT-5.5 Codex", visibility: "public" }],
    }));
    writeFileSync(path.join(home, "config.toml"), `model = "gpt-5.5-codex"\n`);

    const result = detectCodexModels(home);
    assert.ok(result);
    assert.deepEqual(result!.models, [{
      id: "gpt-5.5-codex",
      label: "GPT-5.5 Codex",
      verified: "launchable",
    }]);
    assert.equal(result!.default, "gpt-5.5-codex");
  });
});

test("detectCodexModels tolerates missing config.toml", () => {
  withTempHome((home) => {
    mkdirSync(path.join(home, ".codex"));
    writeFileSync(path.join(home, ".codex", "models_cache.json"), JSON.stringify({
      models: [{ slug: "gpt-5.4", visibility: "public" }],
    }));
    const result = detectCodexModels(home);
    assert.ok(result);
    assert.equal(result!.default, undefined);
  });
});

test("resolveCodexCommand falls back to ChatGPT.app bundled CLI on macOS", () => {
  const resolved = resolveCodexCommand({
    platform: "darwin",
    execFileSyncFn: () => {
      throw new Error("not on path");
    },
    existsSyncFn: (candidate) => candidate === "/Applications/ChatGPT.app/Contents/Resources/codex",
  });

  assert.equal(resolved, "/Applications/ChatGPT.app/Contents/Resources/codex");
});

test("probeCodex reports version from ChatGPT.app bundled CLI fallback", () => {
  const result = probeCodex({
    platform: "darwin",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object, maybeOptions?: object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") throw new Error("not on path");
      assert.equal(command, "/Applications/ChatGPT.app/Contents/Resources/codex");
      if (args[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\n");
      }
      assert.deepEqual(args, ["--version"]);
      return Buffer.from("codex-cli 0.116.0-alpha.10\n");
    }) as typeof import("node:child_process").execFileSync,
    existsSyncFn: (candidate) => candidate === "/Applications/ChatGPT.app/Contents/Resources/codex",
    statSyncFn: () => {
      throw new Error("disable host-file cache for the injected probe");
    },
  });

  assert.deepEqual(result, { available: true, version: "codex-cli 0.116.0-alpha.10" });
});

test("probeCodex falls through ordered candidates when the first lacks app-server", () => {
  const pathCodex = "/tmp/old-codex";
  const appCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const result = probeCodex({
    platform: "darwin",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") return Buffer.from(`${pathCodex}\n`);
      if (command === pathCodex && args[0] === "app-server") {
        const error = new Error("unknown command") as Error & { status: number };
        error.status = 2;
        throw error;
      }
      if (command === appCodex && args[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\n");
      }
      if (command === appCodex && args[0] === "--version") {
        return Buffer.from("codex-cli 0.130.0\n");
      }
      throw new Error(`unexpected exec ${command} ${args.join(" ")}`);
    }) as typeof import("node:child_process").execFileSync,
    existsSyncFn: (candidate) => candidate === appCodex,
    statSyncFn: () => {
      throw new Error("disable host-file cache for the injected probe");
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.version, "codex-cli 0.130.0");
  assert.match(result.diagnostic ?? "", /old-codex rejected: app-server probe exit status 2/);
});

test("probeCodex does not advertise version-only installs without app-server", () => {
  const result = probeCodex({
    platform: "linux",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") return Buffer.from("/tmp/codex\n");
      if (args[0] === "app-server") {
        const error = new Error("unknown command") as Error & { status: number };
        error.status = 2;
        throw error;
      }
      if (args[0] === "--version") return Buffer.from("codex-cli 0.115.0\n");
      throw new Error(`unexpected exec ${command} ${args.join(" ")}`);
    }) as typeof import("node:child_process").execFileSync,
  });

  assert.equal(result.available, false);
  assert.equal(result.unavailableReason, "probe_failed");
  assert.match(result.diagnostic ?? "", /\/tmp\/codex rejected: app-server probe exit status 2/);
});

test("probeCodex reports not_installed when no Codex candidate exists anywhere", () => {
  withTempHome((home) => {
    const result = probeCodex({
      platform: "linux",
      homeDir: home,
      env: { PATH: "/nonexistent-bin", HOME: home },
      existsSyncFn: () => false,
      execFileSyncFn: (() => {
        throw Object.assign(new Error("which: no codex"), { status: 1 });
      }) as unknown as typeof import("node:child_process").execFileSync,
      statSyncFn: () => {
        throw new Error("disable host-file cache for the injected probe");
      },
    });

    assert.equal(result.available, false);
    assert.equal(result.unavailableReason, "not_installed");
  });
});

test("resolveCodexCommand ignores Windows sandbox runner fallback", () => {
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    const resolved = resolveCodexCommand({
      platform: "win32",
      homeDir: home,
      existsSyncFn: (candidate) => candidate.startsWith(sandboxBin),
      execFileSyncFn: () => {
        throw new Error("not on path");
      },
    });

    assert.equal(resolved, null);
  });
});

test("probeCodex does not treat Windows sandbox runner as available", () => {
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      existsSyncFn: (candidate) => candidate.startsWith(sandboxBin),
      execFileSyncFn: () => {
        throw new Error("not on path");
      },
    });

    assert.equal(result.available, false);
  });
});

test("resolveCodexSpawn returns Codex Desktop exe on Windows when npm install not found", () => {
  const desktopCodex = "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
      platform: "win32",
      homeDir: home,
      execFileSyncFn: ((command: string, args?: readonly string[]) => {
        if (command === "npm") throw new Error("npm install not found");
        if (command === desktopCodex && args?.[0] === "app-server") {
          assert.deepEqual(args, ["app-server", "--help"]);
          return Buffer.from("Usage: codex app-server\r\n");
        }
        assert.equal(command, "powershell.exe");
        assert.deepEqual(args?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
        return Buffer.from(`${desktopCodex}\r\n`);
      }) as any,
    });

    assert.equal(result.command, desktopCodex);
    assert.deepEqual(result.args, ["app-server", "--listen", "stdio://"]);
    assert.equal(result.shell, false);
  });
});

test("resolveCodexSpawn runs the Windows npm entry through packaged Electron's Node mode", () => {
  const electronExecutable = String.raw`C:\Program Files\Raft\Raft.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const baseEnv = { BASE_ENV: "present" };

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: baseEnv,
    execFileSyncFn: ((command: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === electronExecutable) {
        assert.deepEqual(args, [...ELECTRON_NODE_SCRIPT_EXEC_ARGV, npmEntry, "app-server", "--help"]);
        assert.equal(options?.env?.BASE_ENV, "present");
        assert.equal(options?.env?.ELECTRON_RUN_AS_NODE, "1");
        return Buffer.from("Usage: codex app-server\r\n");
      }
      throw new Error(`unexpected command ${command}`);
    }) as any,
    existsSyncFn: (candidate: string) => candidate === npmEntry,
    windowsEnvironmentReaderFn: () => ({}),
    execPath: electronExecutable,
    execIsElectron: true,
  } as any);

  assert.equal(result.command, electronExecutable);
  assert.deepEqual(result.args, [...ELECTRON_NODE_SCRIPT_EXEC_ARGV, npmEntry, "app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, false);
  assert.equal(result.env?.BASE_ENV, "present");
  assert.equal(result.env?.ELECTRON_RUN_AS_NODE, "1");
});

test("resolveCodexSpawn runs the Windows npm entry through a genuine Node host", () => {
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: { BASE_ENV: "present" },
    execPath: nodeExecutable,
    execIsElectron: false,
    execIsSea: false,
    hasNodeRuntime: true,
    existsSyncFn: (candidate) => candidate === npmEntry,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === nodeExecutable) {
        assert.equal(options?.env?.BASE_ENV, "present");
        assert.equal(options?.env?.ELECTRON_RUN_AS_NODE, undefined);
        if (args?.includes("--version")) return Buffer.from("codex-cli 0.149.0\r\n");
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  });

  assert.equal(result.command, nodeExecutable);
  assert.deepEqual(result.args, [npmEntry, "app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, false);
  assert.equal(result.env?.ELECTRON_RUN_AS_NODE, undefined);
});

test("resolveCodexSpawn in a Windows SEA runs the PATH wrapper's entry with the wrapper's node, not cmd.exe", () => {
  clearCodexProbeCacheForTests();
  const seaExecutable = String.raw`C:\Program Files\Raft\raft-computer.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const pathNode = String.raw`C:\Program Files\nodejs\node.exe`;
  const shimContent = 'CALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
  const invoked: string[] = [];

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: { PATH: String.raw`C:\Users\bot\AppData\Roaming\npm` },
    execPath: seaExecutable,
    execIsElectron: false,
    execIsSea: true,
    hasNodeRuntime: true,
    existsSyncFn: (candidate) => candidate === npmEntry || candidate === shim,
    readFileSyncFn: (file) => {
      assert.equal(file, shim);
      return shimContent;
    },
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      invoked.push(command);
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === "powershell.exe") {
        return Buffer.from(`${args?.[args.length - 1] === "node" ? pathNode : shim}\r\n`);
      }
      if (command === seaExecutable) assert.fail("a SEA executable must never be used as the Node host");
      if (command === shim) assert.fail("a .cmd wrapper must not be executed");
      if (command === pathNode && args?.[1] === "app-server") {
        assert.deepEqual(args, [npmEntry, "app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === pathNode && args?.[1] === "--version") return Buffer.from("codex-cli 0.149.0\r\n");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  });

  assert.deepEqual(result, {
    command: pathNode,
    args: [npmEntry, "app-server", "--listen", "stdio://"],
    shell: false,
    source: "path",
    // The OAR host launches the shim itself (oarCodexLaunch.ts).
    windowsShim: shim,
    rejectedCandidateCount: 1,
    rejectionKind: "node_host",
    version: "codex-cli 0.149.0",
  });
  assert.ok(!invoked.includes(seaExecutable));
  clearCodexProbeCacheForTests();
});

// npm's shim (OAR recognises it: one `%dp0%`-relative script) and a scoop-style
// one naming its target by absolute path (Raft resolves it; OAR would go through cmd.exe).
const NPM_CODEX_SHIM = 'CALL :find_dp0\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
const ABSOLUTE_CODEX_SHIM = '@"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\bot\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

test("the Windows npm entry's launch names npm's global shim beside `npm root -g` for the OAR host, only a shim OAR runs without cmd.exe (sync and async)", async () => {
  const nodeExecutable = String.raw`C:\Program Files\nodejs\node.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const stand = ((command: string, args?: readonly string[]) => {
    if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
    if (command === nodeExecutable) return Buffer.from(args?.includes("--version") ? "codex-cli 0.149.0\r\n" : "Usage: codex app-server\r\n");
    if (command === "powershell.exe") throw new Error("codex is not on PATH");
    throw new Error(`unexpected command ${command}`);
  }) as unknown as typeof execFileSync;
  const deps = (shimText: string | null) => ({
    platform: "win32" as const,
    env: { BASE_ENV: "present" },
    execPath: nodeExecutable,
    execIsElectron: false,
    execIsSea: false,
    hasNodeRuntime: true,
    windowsEnvironmentReaderFn: () => ({}),
    existsSyncFn: (candidate: string) => candidate === npmEntry || (shimText !== null && candidate === shim),
    readFileSyncFn: (file: string) => {
      assert.equal(file, shim);
      return shimText ?? "";
    },
    execFileSyncFn: stand,
    runProbeChildFn: viaProbeChild(stand),
  });
  for (const [shimText, expected] of [[NPM_CODEX_SHIM, shim], [ABSOLUTE_CODEX_SHIM, undefined], [null, undefined]] as const) {
    clearCodexProbeCacheForTests();
    const viaSync = resolveCodexSpawn(["app-server"], deps(shimText));
    assert.equal(viaSync.source, "npm_global");
    assert.deepEqual([viaSync.command, ...viaSync.args], [nodeExecutable, npmEntry, "app-server"]);
    assert.equal(viaSync.windowsShim, expected, String(shimText));
    clearCodexProbeCacheForTests();
    const viaAsync = await resolveCodexSpawnAsync(["app-server"], deps(shimText));
    assert.deepEqual(viaAsync, viaSync);
  }
  clearCodexProbeCacheForTests();
});

test("CODEX_BIN naming a .cmd: the launch names it for the OAR host only when OAR runs it without cmd.exe", () => {
  const shim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const siblingNode = String.raw`C:\Users\bot\AppData\Roaming\npm\node.exe`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  for (const [shimText, expected] of [[NPM_CODEX_SHIM, shim], [ABSOLUTE_CODEX_SHIM, undefined]] as const) {
    clearCodexProbeCacheForTests();
    const result = resolveCodexSpawn(["app-server"], {
      platform: "win32",
      env: { CODEX_BIN: shim },
      existsSyncFn: (candidate) => [shim, siblingNode, npmEntry].includes(candidate),
      readFileSyncFn: () => shimText,
      windowsEnvironmentReaderFn: () => ({}),
      execFileSyncFn: ((command: string, args?: readonly string[]) => {
        // The node the driver picks for the shim (the daemon's own Node host here).
        if (args?.includes(npmEntry)) return Buffer.from(args.includes("--version") ? "codex-cli 0.149.0\r\n" : "Usage: codex app-server\r\n");
        throw new Error(`unexpected command ${command}`);
      }) as any,
    });
    assert.equal(result.source, "explicit_bin");
    assert.deepEqual(result.args.slice(-2), [npmEntry, "app-server"]);
    assert.equal(result.windowsShim, expected, shimText);
  }
  clearCodexProbeCacheForTests();
});

test("resolveCodexSpawn skips an npm JS entry in a Windows SEA and selects the native install", () => {
  clearCodexProbeCacheForTests();
  const seaExecutable = String.raw`C:\Program Files\Raft\raft-computer.exe`;
  const globalRoot = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Users\bot\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const nativeCodex = String.raw`C:\Users\bot\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe`;

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: {
      PATH: String.raw`C:\Windows\System32`,
      LOCALAPPDATA: String.raw`C:\Users\bot\AppData\Local`,
    },
    execPath: seaExecutable,
    execIsElectron: false,
    execIsSea: true,
    hasNodeRuntime: true,
    existsSyncFn: (candidate) => candidate === npmEntry || candidate === nativeCodex,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      if (command === seaExecutable) assert.fail("a SEA executable must never be used as the Node host");
      if (command === nativeCodex && args?.[0] === "app-server") return Buffer.from("Usage: codex app-server\r\n");
      if (command === nativeCodex && args?.[0] === "--version") return Buffer.from("codex-cli 0.149.0\r\n");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  });

  assert.deepEqual(result, {
    command: nativeCodex,
    args: ["app-server", "--listen", "stdio://"],
    shell: false,
    source: "desktop_install",
    rejectedCandidateCount: 1,
    rejectionKind: "node_host",
    version: "codex-cli 0.149.0",
  });
  clearCodexProbeCacheForTests();
});

/**
 * Windows discovery with OAR listing the Desktop build CLIs (OAR's own
 * `desktopBuildExecutables`, which reads and orders the build folders, is
 * tested in OAR): `builds` is what it answers per `bin` folder, newest first.
 */
function windowsDesktopBuildDeps(options: {
  existing: readonly string[];
  builds: Record<string, string[]>;
  versions: Record<string, string>;
}) {
  return {
    platform: "win32" as const,
    env: {
      PATH: String.raw`C:\Windows\System32`,
      LOCALAPPDATA: String.raw`C:\Users\bot\AppData\Local`,
    },
    execIsElectron: false,
    existsSyncFn: (candidate: string) => options.existing.includes(candidate),
    codexDesktopBuildsFn: (bin: string) => options.builds[bin] ?? [],
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === "npm") throw new Error("npm is not installed");
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      const version = options.versions[command];
      if (version === undefined) throw new Error(`${command} is broken`);
      if (args?.[0] === "app-server") return Buffer.from("Usage: codex app-server\r\n");
      if (args?.[0] === "--version") return Buffer.from(`codex-cli ${version}\r\n`);
      throw new Error(`unexpected command ${command}`);
    }) as any,
  };
}

const DESKTOP_BIN = String.raw`C:\Users\bot\AppData\Local\OpenAI\Codex\bin`;
const DESKTOP_OLD_BUILD = String.raw`C:\Users\bot\AppData\Local\OpenAI\Codex\bin\0a1b2c3d4e5f6071\codex.exe`;
const DESKTOP_NEW_BUILD = String.raw`C:\Users\bot\AppData\Local\OpenAI\Codex\bin\5449c1f0f26f1f98\codex.exe`;

test("Codex Desktop builds under bin\\<build hash> are discovery candidates; arbitration takes the newest version", () => {
  clearCodexProbeCacheForTests();
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], windowsDesktopBuildDeps({
    existing: [DESKTOP_OLD_BUILD, DESKTOP_NEW_BUILD],
    // Listed oldest first: arbitration, not the listing order, picks the newest version.
    builds: { [DESKTOP_BIN]: [DESKTOP_OLD_BUILD, DESKTOP_NEW_BUILD] },
    versions: { [DESKTOP_OLD_BUILD]: "0.149.0", [DESKTOP_NEW_BUILD]: "0.150.0" },
  }));
  assert.equal(result?.command, DESKTOP_NEW_BUILD);
  assert.equal(result?.source, "desktop_install");
  clearCodexProbeCacheForTests();
});

test("a broken newest Codex Desktop build falls through to an older working one", () => {
  clearCodexProbeCacheForTests();
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], windowsDesktopBuildDeps({
    existing: [DESKTOP_OLD_BUILD, DESKTOP_NEW_BUILD],
    builds: { [DESKTOP_BIN]: [DESKTOP_NEW_BUILD, DESKTOP_OLD_BUILD] },
    // The newest build is half-installed: it answers no probe.
    versions: { [DESKTOP_OLD_BUILD]: "0.149.0" },
  }));
  assert.equal(result?.command, DESKTOP_OLD_BUILD);
  assert.equal(result?.source, "desktop_install");
  assert.equal(result?.rejectedCandidateCount, 1);
  clearCodexProbeCacheForTests();
});

test("the fixed Codex Desktop bin\\codex.exe is still found, and no Desktop install gives no command", () => {
  clearCodexProbeCacheForTests();
  const fixed = String.raw`C:\Users\bot\AppData\Local\OpenAI\Codex\bin\codex.exe`;
  assert.equal(resolveCodexCommand(windowsDesktopBuildDeps({
    existing: [fixed, DESKTOP_NEW_BUILD],
    builds: { [DESKTOP_BIN]: [DESKTOP_NEW_BUILD] },
    versions: { [fixed]: "0.150.0", [DESKTOP_NEW_BUILD]: "0.150.0" },
  })), fixed);
  assert.equal(resolveCodexCommand(windowsDesktopBuildDeps({
    existing: [],
    builds: {},
    versions: {},
  })), null);
  clearCodexProbeCacheForTests();
});

test("only OAR's Desktop codex.exe entries are Desktop candidates, not its npm codex.cmd shim", () => {
  clearCodexProbeCacheForTests();
  // OAR lists `%APPDATA%\npm\codex.cmd` first; Raft finds npm installs through `npm root -g` and PATH.
  const npmShim = String.raw`C:\Users\bot\AppData\Roaming\npm\codex.cmd`;
  const deps = windowsDesktopBuildDeps({
    existing: [npmShim, DESKTOP_NEW_BUILD],
    builds: { [DESKTOP_BIN]: [DESKTOP_NEW_BUILD] },
    versions: { [npmShim]: "0.151.0", [DESKTOP_NEW_BUILD]: "0.150.0" },
  });
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], { ...deps, env: { ...deps.env, APPDATA: String.raw`C:\Users\bot\AppData\Roaming` } });
  assert.equal(result?.command, DESKTOP_NEW_BUILD);
  assert.equal(result?.source, "desktop_install");
  clearCodexProbeCacheForTests();
});

test("probeCodex reports a bounded missing-node-host rejection when a Windows SEA has no executable fallback", () => {
  clearCodexProbeCacheForTests();
  const seaExecutable = String.raw`C:\Private User\Raft\raft-computer.exe`;
  const globalRoot = String.raw`C:\Private User\AppData\Roaming\npm\node_modules`;
  const npmEntry = String.raw`C:\Private User\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`;
  const privatePath = String.raw`C:\Private User\private-bin`;
  const deps = {
    platform: "win32" as const,
    env: { PATH: privatePath },
    execPath: seaExecutable,
    execIsElectron: false,
    execIsSea: true,
    hasNodeRuntime: true,
    existsSyncFn: (candidate: string) => candidate === npmEntry,
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string) => {
      if (command === "npm") return Buffer.from(`${globalRoot}\r\n`);
      if (command === "powershell.exe") throw new Error("codex is not on PATH");
      if (command === seaExecutable) assert.fail("a SEA executable must never be used as the Node host");
      throw new Error(`unexpected command ${command}`);
    }) as any,
  };

  const probe = probeCodex(deps);
  assert.equal(probe.available, false);
  assert.match(probe.diagnostic ?? "", /npm_global JavaScript entry rejected: node_host_unavailable \(host_kind=sea\)/);
  assert.doesNotMatch(probe.diagnostic ?? "", /Private User|private-bin|codex\.js/);
  assert.throws(() => resolveCodexSpawn(["app-server"], deps), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /npm_global JavaScript entry rejected: node_host_unavailable \(host_kind=sea\)/);
    assert.doesNotMatch(error.message, /Private User|private-bin|codex\.js/);
    return true;
  });
  clearCodexProbeCacheForTests();
});

test("resolveCodexSpawn never runs a .cmd wrapper it cannot resolve", () => {
  const shim = "C:\\Users\\test\\AppData\\Local\\npm\\codex.cmd";
  assert.throws(() => resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    existsSyncFn: (candidate) => candidate === shim,
    readFileSyncFn: () => "@echo off\r\npowershell -File \"%SCRIPT_DIR%\\codex.ps1\" %*\r\n",
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === "npm") throw new Error("npm install not found");
      if (command === shim) assert.fail("a .cmd wrapper must not be executed");
      if (command === "powershell.exe") {
        assert.deepEqual(args?.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
        return Buffer.from(`${shim}\r\n`);
      }
      throw new Error(`unexpected command ${command}`);
    }) as any,
  }), /batch wrapper rejected: batch_target_unresolved/);
});

test("resolveCodexSpawn falls back to standard Codex Desktop install path on Windows", () => {
  const desktopCodex = "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";

  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    homeDir: "C:\\Users\\user",
    env: { USERPROFILE: "C:\\Users\\user" },
    existsSyncFn: (candidate) => candidate === desktopCodex,
    execFileSyncFn: ((command: string, args?: readonly string[]) => {
      if (command === desktopCodex && args?.[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      throw new Error("not on path");
    }) as any,
  });

  assert.equal(result.command, desktopCodex);
  assert.deepEqual(result.args, ["app-server", "--listen", "stdio://"]);
  assert.equal(result.shell, false);
});

test("Codex inventory and spawn fall back to the native Windows install when the PATH probe times out", () => {
  const nativeCodex = "C:\\Users\\user\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  let pathProbeCount = 0;

  const deps = {
    platform: "win32" as const,
    env: {
      LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local",
      USERPROFILE: "C:\\Users\\user",
    },
    existsSyncFn: (candidate: string) => candidate === nativeCodex,
    windowsEnvironmentReaderFn: () => null,
    execFileSyncFn: ((command: string, args?: readonly string[], options?: { timeout?: number }) => {
      if (command === "npm") throw new Error("npm install not found");
      if (command === "powershell.exe") {
        pathProbeCount += 1;
        assert.equal(options?.timeout, 1000);
        const error = new Error("PATH probe timed out") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        throw error;
      }
      if (command === nativeCodex && args?.[0] === "app-server") {
        assert.deepEqual(args, ["app-server", "--help"]);
        return Buffer.from("Usage: codex app-server\r\n");
      }
      if (command === nativeCodex && args?.[0] === "--version") {
        return Buffer.from("codex-cli 0.145.0\r\n");
      }
      throw new Error(`unexpected exec ${command}`);
    }) as any,
  };

  assert.deepEqual(probeCodex(deps), {
    available: true,
    version: "codex-cli 0.145.0",
  });
  assert.deepEqual(
    resolveCodexSpawn(["app-server", "--listen", "stdio://"], deps),
    {
      command: nativeCodex,
      args: ["app-server", "--listen", "stdio://"],
      shell: false,
      source: "desktop_install",
      rejectedCandidateCount: 0,
      version: "codex-cli 0.145.0",
    },
  );
  assert.equal(pathProbeCount, 4);
});

test("resolveCodexSpawn rejects Windows sandbox runner when no real Codex CLI is found", () => {
  withTempHome((home) => {
    const sandboxBin = path.join(home, ".codex", ".sandbox-bin");
    mkdirSync(sandboxBin, { recursive: true });
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.129.0-alpha.1.exe"), "");
    writeFileSync(path.join(sandboxBin, "codex-command-runner-0.130.0-alpha.5.exe"), "");

    assert.throws(() => resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
      platform: "win32",
      homeDir: home,
      existsSyncFn: (candidate) => candidate.startsWith(sandboxBin),
      execFileSyncFn: () => {
        throw new Error("not on path");
      },
    }), /sandbox helper/);
  });
});

test("compareCodexVersions orders dotted triples and real alpha builds", () => {
  assert.equal(compareCodexVersions("codex-cli 0.147.0", "0.143.0"), 1);
  assert.equal(compareCodexVersions("0.143.0", "0.147.0-alpha.1"), -1);
  assert.equal(compareCodexVersions("not-a-version", "0.1.0"), null);
  // Same core: release ranks above prerelease.
  assert.equal(compareCodexVersions("0.147.0", "0.147.0-alpha.6.5"), 1);
  // Real install family from parent thread: later alpha trail wins.
  assert.equal(compareCodexVersions("codex-cli 0.147.0-alpha.6.5", "0.147.0-alpha.1"), 1);
  assert.equal(compareCodexVersions("0.147.0-alpha.1", "0.147.0-alpha.6.5"), -1);
  assert.equal(compareCodexVersions("0.147.0-alpha.6.5", "0.147.0-alpha.6.5"), 0);
  assert.equal(compareCodexVersions("0.147.0-alpha.6.5", "0.147.0-alpha.6"), 1);
  assert.ok(parseCodexVersion("codex-cli 0.147.0-alpha.6.5")?.pre?.join(".") === "6.5");
});

test("resolveCodexSpawn CODEX_BIN is authoritative over a higher-version PATH candidate", () => {
  const override = "/opt/override/codex";
  const pathBin = "/opt/path/codex";
  const probed: string[] = [];
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "darwin",
    env: { PATH: "/opt/path", CODEX_BIN: override },
    existsSyncFn: (p) => {
      const s = String(p);
      return s === override || s === pathBin || s.endsWith(`${path.sep}codex`);
    },
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const c = String(cmd);
      if (c === "which" || c.endsWith("/which")) {
        // PATH would surface the higher version; override must still win without probing it.
        return Buffer.from(`${pathBin}\n`);
      }
      probed.push(c);
      if (args.includes("--version")) {
        if (c === override) return Buffer.from("0.143.0\n");
        if (c === pathBin) return Buffer.from("0.147.0-alpha.6.5\n");
      }
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, override);
  assert.equal(result.source, "explicit_bin");
  assert.ok(probed.includes(override));
  assert.ok(!probed.includes(pathBin), "PATH candidate must not be version-arbitrated against CODEX_BIN");
});

test("resolveCodexSpawn CODEX_BIN is authoritative on Windows", () => {
  const override = "C:\\override\\codex.exe";
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32", CODEX_BIN: override, LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    existsSyncFn: (p) => String(p) === override,
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const c = String(cmd);
      // npm root / where must not be required for an absolute override.
      if (c === "npm" || c === "where" || c === "where.exe") {
        throw new Error("should not need discovery when CODEX_BIN is set");
      }
      if (c === override && args.includes("--version")) return Buffer.from("0.147.0-alpha.6.5\n");
      if (c === override) return Buffer.from("");
      throw new Error(`unexpected exec: ${c}`);
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, override);
  assert.equal(result.source, "explicit_bin");
});

test("resolveCodexSpawn fails closed when CODEX_BIN is set but unusable", () => {
  assert.throws(
    () => resolveCodexSpawn(["app-server"], {
      platform: "darwin",
      env: { PATH: "/opt/path", CODEX_BIN: "/missing/override/codex" },
      existsSyncFn: (p) => String(p) === "/opt/path/codex",
      execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        if (String(cmd) === "which" || String(cmd).endsWith("/which")) {
          return Buffer.from("/opt/path/codex\n");
        }
        if (args.includes("--version")) return Buffer.from("0.147.0\n");
        return Buffer.from("");
      }) as typeof import("node:child_process").execFileSync,
    }),
    /CODEX_BIN is set but does not resolve|path does not exist/,
  );
});

test("resolveCodexSpawn fails closed when CODEX_BIN probe fails even if PATH has a candidate", () => {
  const override = "/opt/override/codex";
  assert.throws(
    () => resolveCodexSpawn(["app-server"], {
      platform: "darwin",
      env: { PATH: "/opt/path", CODEX_BIN: override },
      existsSyncFn: (p) => {
        const s = String(p);
        return s === override || s === "/opt/path/codex";
      },
      execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
        const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
        if (String(cmd) === "which" || String(cmd).endsWith("/which")) {
          return Buffer.from("/opt/path/codex\n");
        }
        if (String(cmd) === override) {
          const err = new Error("override broken") as NodeJS.ErrnoException & { status?: number };
          err.status = 127;
          throw err;
        }
        if (args.includes("--version")) return Buffer.from("0.147.0\n");
        return Buffer.from("");
      }) as typeof import("node:child_process").execFileSync,
    }),
    /CODEX_BIN is set but does not resolve|app-server probe/,
  );
});

test("resolveCodexSpawn uses ChatGPT.app desktop bundle when PATH misses codex", () => {
  const chatgpt = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const exists = new Set([chatgpt]);
  const result = resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
    platform: "darwin",
    env: { PATH: "/empty" },
    existsSyncFn: (p) => exists.has(String(p)),
    execFileSyncFn: ((_cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (args.includes("--version")) return Buffer.from("0.147.0\n");
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, chatgpt);
  assert.equal(result.source, "desktop_bundle");
});

test("resolveCodexSpawn does not revive deprecated Codex.app-only fallback", () => {
  const legacy = "/Applications/Codex.app/Contents/Resources/codex";
  const exists = new Set([legacy]);
  assert.throws(
    () => resolveCodexSpawn(["app-server", "--listen", "stdio://"], {
      platform: "darwin",
      env: { PATH: "/empty" },
      existsSyncFn: (p) => exists.has(String(p)),
      execFileSyncFn: ((() => Buffer.from("")) as unknown as typeof import("node:child_process").execFileSync),
    }),
    /Cannot resolve a compatible Codex CLI/,
  );
});

test("resolveCodexSpawn selects higher version among PATH and desktop candidates", () => {
  const pathBin = "/opt/old/codex";
  const desktop = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const result = resolveCodexSpawn(["app-server"], {
    platform: "darwin",
    env: { PATH: "/opt/old", HOME: "/Users/tester" },
    existsSyncFn: (p) => {
      const s = String(p);
      return s === pathBin || s === desktop;
    },
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      const c = String(cmd);
      if (c === "which" || c.endsWith("/which")) {
        return Buffer.from(`${pathBin}\n`);
      }
      if (args.includes("--version")) {
        if (c === pathBin) return Buffer.from("codex-cli 0.143.0\n");
        if (c === desktop) return Buffer.from("codex-cli 0.147.0-alpha.6.5\n");
      }
      // app-server --help succeeds for both
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(result.command, desktop);
  assert.equal(result.source, "desktop_bundle");
});

test("codex probe cache reuses exec on same path mtime/size and re-probes on change", () => {
  clearCodexProbeCacheForTests();
  const bin = "/tmp/haohao-codex-cache-bin";
  let mtimeMs = 1000;
  let size = 100;
  let execCount = 0;

  const deps = {
    platform: "darwin" as const,
    env: { PATH: "/empty", CODEX_BIN: bin },
    existsSyncFn: (p: string) => String(p) === bin,
    statSyncFn: (p: string) => {
      assert.equal(String(p), bin);
      return { mtimeMs, size };
    },
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      execCount += 1;
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (String(cmd) !== bin) throw new Error(`unexpected ${cmd}`);
      if (args.includes("--version")) return Buffer.from("0.147.0-alpha.6.5\n");
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  };

  const first = resolveCodexSpawn(["app-server"], deps);
  assert.equal(first.command, bin);
  const afterFirst = execCount;
  assert.ok(afterFirst >= 2, "first resolve must probe app-server and version");

  const second = resolveCodexSpawn(["app-server"], deps);
  assert.equal(second.command, bin);
  assert.equal(execCount, afterFirst, "second resolve must reuse probe cache (zero extra exec)");

  mtimeMs = 2000; // invalidate
  const third = resolveCodexSpawn(["app-server"], deps);
  assert.equal(third.command, bin);
  assert.ok(execCount > afterFirst, "mtime change must re-probe");

  clearCodexProbeCacheForTests();
});

test("codex probe cache re-probes after a cached failure recovers", () => {
  clearCodexProbeCacheForTests();
  const bin = "/tmp/haohao-codex-cache-fail-bin";
  let mtimeMs = 50;
  let fail = true;
  let execCount = 0;

  const deps = {
    platform: "darwin" as const,
    env: { PATH: "/empty", CODEX_BIN: bin },
    existsSyncFn: (p: string) => String(p) === bin,
    statSyncFn: () => ({ mtimeMs, size: 10 }),
    execFileSyncFn: ((cmd: string, argsOrOptions?: readonly string[] | object) => {
      execCount += 1;
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (fail) {
        const err = new Error("boom") as NodeJS.ErrnoException & { status?: number };
        err.status = 1;
        throw err;
      }
      if (args.includes("--version")) return Buffer.from("0.147.0\n");
      return Buffer.from("");
    }) as typeof import("node:child_process").execFileSync,
  };

  assert.throws(() => resolveCodexSpawn(["app-server"], deps), /CODEX_BIN is set/);
  const afterFail = execCount;
  assert.ok(afterFail >= 1);

  // Same mtime: failure is cached — still fail without needing a different mtime,
  // but we invalidate via mtime change (binary "fixed").
  mtimeMs = 51;
  fail = false;
  const ok = resolveCodexSpawn(["app-server"], deps);
  assert.equal(ok.command, bin);
  assert.ok(execCount > afterFail, "recovered binary after mtime change must re-probe");

  clearCodexProbeCacheForTests();
});

// task #1263: the Windows `npm root -g` discovery child runs under a budget and a
// timed-out child neither stalls nor reclassifies the probe.
function windowsNpmRootFakes(npmBehaviour: "ok" | "timeout", desktopCodex?: string) {
  const captured: { npmTimeout?: unknown } = {};
  const execFileSyncFn = ((command: string, args?: readonly string[], options?: { timeout?: unknown }) => {
    if (command === "npm") {
      captured.npmTimeout = options?.timeout;
      if (npmBehaviour === "timeout") throw Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" });
      return Buffer.from("C:\\Users\\user\\AppData\\Roaming\\npm\\node_modules\r\n");
    }
    if (desktopCodex && command === desktopCodex && args?.[0] === "app-server") {
      return Buffer.from("Usage: codex app-server\r\n");
    }
    assert.equal(command, "powershell.exe");
    if (args?.some((arg) => arg.includes("Get-Command"))) {
      if (desktopCodex) return Buffer.from(`${desktopCodex}\r\n`);
      throw Object.assign(new Error("CommandNotFound"), { status: 3 });
    }
    return Buffer.from("");
  }) as unknown as typeof import("node:child_process").execFileSync;
  return { captured, execFileSyncFn };
}

test("task #1263: the Windows npm root discovery child runs under CODEX_NPM_ROOT_TIMEOUT_MS", () => {
  assert.equal(CODEX_NPM_ROOT_TIMEOUT_MS, 5000);
  withTempHome((home) => {
    const { captured, execFileSyncFn } = windowsNpmRootFakes("ok");
    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      env: { PATH: "C:\\nonexistent-bin" },
      existsSyncFn: () => false,
      execFileSyncFn,
      statSyncFn: () => {
        throw new Error("disable host-file cache for the injected probe");
      },
    });
    assert.equal(captured.npmTimeout, CODEX_NPM_ROOT_TIMEOUT_MS);
    assert.equal(result.available, false);
    assert.equal(result.unavailableReason, "not_installed");
  });
});

test("task #1263: a timed-out npm root child keeps the not_installed classification and leaves a path-free note", () => {
  withTempHome((home) => {
    const { execFileSyncFn } = windowsNpmRootFakes("timeout");
    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      env: { PATH: "C:\\nonexistent-bin" },
      existsSyncFn: () => false,
      execFileSyncFn,
      statSyncFn: () => {
        throw new Error("disable host-file cache for the injected probe");
      },
    });
    assert.equal(result.available, false);
    assert.equal(result.unavailableReason, "not_installed");
    assert.match(result.diagnostic ?? "", /npm_global discovery: `npm root -g` did not finish within 5000 ms, so the global npm install was not searched and a Codex installed only there is not ruled out/);
    assert.doesNotMatch(result.diagnostic ?? "", /npm_global discovery[^;]*(Users|AppData|\\\\)/);
  });
});

test("task #1263: a timed-out npm root child still lets PATH/desktop discovery select Codex", () => {
  const desktopCodex = "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  withTempHome((home) => {
    const { execFileSyncFn } = windowsNpmRootFakes("timeout", desktopCodex);
    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      env: { PATH: "C:\\nonexistent-bin" },
      existsSyncFn: (candidate: unknown) => candidate === desktopCodex,
      execFileSyncFn,
      statSyncFn: () => {
        throw new Error("disable host-file cache for the injected probe");
      },
    });
    assert.equal(result.available, true);
    assert.match(result.diagnostic ?? "", /npm root -g` did not finish within 5000 ms/);
  });
});

test("task #1263: a timed-out npm root child still lets PATH discovery select a codex executable, in the original order", () => {
  const shim = "C:\\Users\\user\\AppData\\Local\\Programs\\codex\\codex.exe";
  withTempHome((home) => {
    const calls: string[] = [];
    const execFileSyncFn = ((command: string, args?: readonly string[]) => {
      if (command === "npm") {
        calls.push("npm");
        throw Object.assign(new Error("spawnSync npm ETIMEDOUT"), { code: "ETIMEDOUT" });
      }
      if (command === shim && args?.[0] === "app-server") {
        calls.push("app-server");
        return Buffer.from("Usage: codex app-server\r\n");
      }
      assert.equal(command, "powershell.exe");
      if (args?.some((arg) => arg.includes("Get-Command"))) {
        calls.push("get-command");
        return Buffer.from(`${shim}\r\n`);
      }
      return Buffer.from("");
    }) as unknown as typeof import("node:child_process").execFileSync;
    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      env: { PATH: "C:\\Users\\user\\AppData\\Local\\Programs\\codex" },
      existsSyncFn: () => false,
      execFileSyncFn,
      statSyncFn: () => {
        throw new Error("disable host-file cache for the injected probe");
      },
    });
    assert.equal(result.available, true);
    assert.equal(calls[0], "npm", "npm root discovery still runs first");
    assert.ok(calls.indexOf("get-command") > calls.indexOf("npm"), "PATH discovery follows the timed-out npm step");
    assert.ok(calls.includes("app-server"), "the PATH candidate is probed");
    assert.match(result.diagnostic ?? "", /npm root -g` did not finish within 5000 ms/);
  });
});

test("task #1263: a timed-out npm root child still lets desktop-only discovery select Codex (reviewer)", () => {
  const desktopCodex = "C:\\Users\\user\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe";
  withTempHome((home) => {
    const fakes = windowsNpmRootFakes("timeout", desktopCodex);
    const execFileSyncFn = ((command: string, args?: readonly string[], options?: unknown) => {
      if (command === "powershell.exe" && args?.some(arg => arg.includes("Get-Command"))) throw Object.assign(new Error("missing"), {status: 3});
      return (fakes.execFileSyncFn as any)(command, args, options);
    }) as typeof fakes.execFileSyncFn;
    const result = probeCodex({
      platform: "win32",
      homeDir: home,
      env: { PATH: "C:\\nonexistent-bin", LOCALAPPDATA: "C:\\Users\\user\\AppData\\Local" },
      existsSyncFn: (candidate: unknown) => candidate === desktopCodex,
      execFileSyncFn,
      statSyncFn: () => {
        throw new Error("disable host-file cache for the injected probe");
      },
    });
    assert.equal(result.available, true);
    assert.match(result.diagnostic ?? "", /npm root -g` did not finish within 5000 ms/);
  });
});


// ── task #1277, PR 2: the async candidate resolution behind the form's model detection ──

test("task #1277: resolveCodexSpawnAsync selects the same candidate, with the same version arbitration, as resolveCodexSpawn", async () => {
  // Two POSIX candidates: the PATH codex (older) and the desktop plugin
  // app-server under the home directory (newer), which darwin discovery scans.
  const home = "/nonexistent-home";
  const bundle = path.join(home, ".codex", "plugins", ".plugin-appserver", "codex");
  const stand = ((command: string, args?: readonly string[]) => {
    if (command === "which") return Buffer.from("/usr/local/bin/codex\n");
    if (args?.[0] === "app-server") return Buffer.from("Usage\n");
    if (args?.[0] === "--version") return Buffer.from(command === bundle ? "codex-cli 0.90.0\n" : "codex-cli 0.80.0\n");
    throw new Error(`unexpected ${command} ${args?.join(" ")}`);
  }) as unknown as typeof execFileSync;
  const deps = { platform: "darwin" as const, homeDir: home, existsSyncFn: (p: string) => p === bundle, env: { PATH: "/usr/local/bin" } };
  clearCodexProbeCacheForTests();
  const viaSync = resolveCodexSpawn(["app-server"], { ...deps, execFileSyncFn: stand });
  clearCodexProbeCacheForTests();
  const viaAsync = await resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: viaProbeChild(stand) });
  assert.deepEqual(viaAsync, viaSync);
  assert.equal(viaAsync.command, bundle, "the newer desktop bundle wins the version arbitration in both");
});

test("task #1277: resolveCodexSpawnAsync rejects with the same text as resolveCodexSpawn when every candidate fails its app-server probe", async () => {
  const stand = ((command: string, args?: readonly string[]) => {
    if (command === "which") return Buffer.from("/usr/local/bin/codex\n");
    if (args?.[0] === "app-server") throw Object.assign(new Error("exit 2"), { status: 2 });
    throw new Error(`unexpected ${command}`);
  }) as unknown as typeof execFileSync;
  const deps = { platform: "linux" as const, homeDir: "/nonexistent-home", existsSyncFn: () => false, env: { PATH: "/usr/local/bin" } };
  clearCodexProbeCacheForTests();
  let syncMessage = "";
  try { resolveCodexSpawn(["app-server"], { ...deps, execFileSyncFn: stand }); } catch (error) { syncMessage = (error as Error).message; }
  clearCodexProbeCacheForTests();
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: viaProbeChild(stand) }), (error: unknown) => {
    assert.equal((error as Error).message, syncMessage);
    assert.match(syncMessage, /app-server probe exit status 2/);
    return true;
  });
});

test("task #1277: the async candidate probe reuses a verdict the synchronous probe cached, without spawning", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-async-cache-"));
  try {
    const codexPath = path.join(root, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    const stand = ((command: string, args?: readonly string[]) => {
      if (command === "which") return Buffer.from(`${codexPath}\n`);
      if (args?.[0] === "app-server") return Buffer.from("Usage\n");
      if (args?.[0] === "--version") return Buffer.from("codex-cli 0.80.0\n");
      throw new Error(`unexpected ${command}`);
    }) as unknown as typeof execFileSync;
    const deps = { platform: "linux" as const, homeDir: path.join(root, "no-home"), env: { PATH: root } };
    clearCodexProbeCacheForTests();
    resolveCodexSpawn(["app-server"], { ...deps, execFileSyncFn: stand });
    // The async resolver must only run the PATH lookup; the probe and the
    // version read come from the shared cache.
    const spawned: string[] = [];
    const viaAsync = await resolveCodexSpawnAsync(["app-server"], {
      ...deps,
      runProbeChildFn: async (command, args) => {
        spawned.push([command, ...args].join(" "));
        if (command === "which") return { stdout: `${codexPath}\n`, stderr: "" };
        throw new Error(`the cached probe must not be rerun: ${command} ${args.join(" ")}`);
      },
    });
    assert.equal(viaAsync.command, codexPath);
    assert.deepEqual(spawned, ["which codex"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277: codex form detection no longer blocks the daemon's event loop on the candidate search", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-detect-nonblocking-"));
  try {
    const workDir = path.join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const { binDir, logPath } = installScriptedCodexAppServer(root);
    // A `which` that answers slowly stands in for a cold PATH scan.
    const slowWhich = path.join(binDir, "which");
    writeFileSync(slowWhich, `#!/bin/sh\nsleep 0.4\necho ${path.join(binDir, "codex")}\n`);
    chmodSync(slowWhich, 0o755);
    let ticks = 0;
    const ticker = setInterval(() => { ticks += 1; }, 20);
    try {
      clearCodexProbeCacheForTests();
      const result = await detectCodexModelsFromAppServer({
        cwd: workDir,
        timeoutMs: 5000,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SCRIPTED_CODEX_LOG: logPath },
        deps: { platform: "linux", homeDir: path.join(root, "no-home") },
      });
      assert.ok(result && result.models.length > 0, JSON.stringify(result));
      assert.ok(ticks >= 5, `the event loop ran ${ticks} ticks during the 400 ms lookup; a blocking lookup would run none`);
    } finally {
      clearInterval(ticker);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): a cancelled codex form detection rejects with the abort and never starts the app-server", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-detect-abort-"));
  try {
    const workDir = path.join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const { binDir, logPath } = installScriptedCodexAppServer(root);
    const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SCRIPTED_CODEX_LOG: logPath };
    const isAbort = (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR";
    // Pre-aborted: nothing runs.
    const pre = new AbortController();
    pre.abort();
    clearCodexProbeCacheForTests();
    await assert.rejects(detectCodexModelsFromAppServer({ cwd: workDir, env, deps: { platform: "linux", homeDir: path.join(root, "no-home"), signal: pre.signal } }), isAbort, "pre-aborted");
    // Aborted as the lookup returns: the candidate is known, the app-server must still not start.
    const gap = new AbortController();
    clearCodexProbeCacheForTests();
    await assert.rejects(detectCodexModelsFromAppServer({
      cwd: workDir, env,
      deps: {
        platform: "linux", homeDir: path.join(root, "no-home"), signal: gap.signal,
        runProbeChildFn: async (command, args) => {
          if (command === "which") return { stdout: `${path.join(binDir, "codex")}\n`, stderr: "" };
          if (args.includes("--version")) { gap.abort(); return { stdout: "codex-cli 0.80.0\n", stderr: "" }; }
          return { stdout: "Usage\n", stderr: "" };
        },
      },
    }), isAbort, "aborted between the candidate probe and the spawn");
    assert.equal(existsSync(logPath), false, "the scripted app-server must never have started");
    // Aborted while the app-server is active: killed, rejected well before the deadline.
    const active = new AbortController();
    clearCodexProbeCacheForTests();
    const startedAt = Date.now();
    // Abort once the app-server is really running (its first logged request),
    // not during the candidate probes that precede the spawn.
    const abortOnceStarted = setInterval(() => {
      if (!existsSync(logPath)) return;
      clearInterval(abortOnceStarted);
      active.abort();
    }, 20);
    await assert.rejects(detectCodexModelsFromAppServer({
      cwd: workDir, timeoutMs: 10_000,
      env: { ...env, SCRIPTED_CODEX_HOLD_MS: "8000" },
      deps: { platform: "linux", homeDir: path.join(root, "no-home"), signal: active.signal },
    }), (error: unknown) => {
      assert.ok(isAbort(error), "aborted while active");
      const cleanup = (error as { cleanup?: { childExited: boolean } }).cleanup;
      assert.equal(cleanup?.childExited, true, "the app-server's exit was observed, not assumed");
      return true;
    }).finally(() => clearInterval(abortOnceStarted));
    assert.ok(Date.now() - startedAt < 5000, "the cancel ended the detection, not the 10 s deadline");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): a cancel during the candidate's app-server probe or version read is rethrown before any cache write, so later resolutions are unaffected", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-async-cancel-cache-"));
  try {
    const codexPath = path.join(root, "codex");
    writeFileSync(codexPath, "#!/bin/sh\n");
    const deps = { platform: "linux" as const, homeDir: path.join(root, "no-home"), env: { PATH: root } };
    const good = ((command: string, args?: readonly string[]) => {
      if (command === "which") return Buffer.from(`${codexPath}\n`);
      if (args?.[0] === "app-server") return Buffer.from("Usage\n");
      if (args?.[0] === "--version") return Buffer.from("codex-cli 0.80.0\n");
      throw new Error(`unexpected ${command}`);
    }) as unknown as typeof execFileSync;
    const isAbort = (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR";

    for (const stage of ["app-server", "--version"] as const) {
      clearCodexProbeCacheForTests();
      const controller = new AbortController();
      const cancelAt: typeof runProbeChild = async (command, args) => {
        if (command === "which") return { stdout: `${codexPath}\n`, stderr: "" };
        if (args[0] === stage) {
          controller.abort();
          throw new ProbeChildError(`${stage} aborted`, { code: "ABORT_ERR", cleanup: { childExited: true, waitedMs: 2 } });
        }
        return { stdout: args[0] === "--version" ? "codex-cli 0.80.0\n" : "Usage\n", stderr: "" };
      };
      await assert.rejects(
        resolveCodexSpawnAsync(["app-server"], { ...deps, signal: controller.signal, runProbeChildFn: cancelAt }),
        (error: unknown) => isAbort(error) && (error as { cleanup?: { childExited?: boolean } }).cleanup?.childExited === true,
        `${stage}: the cancel is rethrown with its cleanup, not classified`,
      );
      // The shared cache holds no verdict for this candidate: a following
      // normal resolution, synchronous and asynchronous, selects it with its
      // real version.
      const viaSync = resolveCodexSpawn(["app-server"], { ...deps, execFileSyncFn: good });
      assert.equal(viaSync.command, codexPath, `${stage}: the synchronous resolver still accepts the candidate`);
      assert.equal(probeCodex({ ...deps, execFileSyncFn: good }).version, "codex-cli 0.80.0", `${stage}: the version is read, not a cached unknown`);
      const viaAsync = await resolveCodexSpawnAsync(["app-server"], { ...deps, runProbeChildFn: viaProbeChild(good) });
      assert.equal(viaAsync.command, codexPath, `${stage}: the async resolver still accepts the candidate`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (review): a cancel during the Windows npm-root discovery is rethrown with its (unconfirmed) cleanup and no PATH lookup follows", async () => {
  const controller = new AbortController();
  const children: string[] = [];
  const runChild: typeof runProbeChild = async (command, args) => {
    children.push([command, ...args].join(" "));
    if (command === "npm") {
      controller.abort();
      throw new ProbeChildError("npm root -g aborted", { code: "ABORT_ERR", cleanup: { childExited: false, waitedMs: 5000 } });
    }
    return { stdout: "C:\\tools\\codex.exe\r\n", stderr: "" };
  };
  await assert.rejects(
    resolveCodexSpawnAsync(["app-server"], {
      platform: "win32",
      env: { PATH: "C:\\tools" },
      windowsEnvironmentReaderFn: () => ({}),
      existsSyncFn: () => false,
      signal: controller.signal,
      runProbeChildFn: runChild,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProbeChildError && error.code === "ABORT_ERR");
      assert.deepEqual(error.cleanup, { childExited: false, waitedMs: 5000 }, "the original abort, with its unconfirmed cleanup, is what the caller sees");
      return true;
    },
  );
  assert.deepEqual(children, ["npm root -g"], "no PATH lookup runs after the cancel");
});

// ── task #1277, B-group: the codex launch resolves under the start attempt's cancel ──

test("task #1277 (launch): prepareCodexLaunch with an already-cancelled launch signal creates no child and rejects with the abort", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-launch-cancel-"));
  const previous = { PATH: process.env.PATH, SCRIPTED_CODEX_LOG: process.env.SCRIPTED_CODEX_LOG };
  try {
    const workDir = path.join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const { binDir, logPath } = installScriptedCodexAppServer(root);
    process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
    process.env.SCRIPTED_CODEX_LOG = logPath;
    clearCodexProbeCacheForTests();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      prepareCodexLaunch({ ...makeSpawnContext(workDir), launchSignal: controller.signal }),
      (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
    );
    assert.equal(existsSync(logPath), false, "no codex app-server was started");
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.SCRIPTED_CODEX_LOG === undefined) delete process.env.SCRIPTED_CODEX_LOG; else process.env.SCRIPTED_CODEX_LOG = previous.SCRIPTED_CODEX_LOG;
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #1277 (launch): prepareCodexLaunch cancelled while the candidate search runs creates no child and leaves the probe cache clean", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-launch-cancel-mid-"));
  const previous = { PATH: process.env.PATH, SCRIPTED_CODEX_LOG: process.env.SCRIPTED_CODEX_LOG };
  try {
    const workDir = path.join(root, "work");
    mkdirSync(workDir, { recursive: true });
    const { binDir, logPath } = installScriptedCodexAppServer(root);
    // A slow `which` stands in for a cold PATH scan during the candidate search.
    const slowWhich = path.join(binDir, "which");
    writeFileSync(slowWhich, `#!/bin/sh\nsleep 0.5\necho ${path.join(binDir, "codex")}\n`);
    chmodSync(slowWhich, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${previous.PATH ?? ""}`;
    process.env.SCRIPTED_CODEX_LOG = logPath;
    clearCodexProbeCacheForTests();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(
      prepareCodexLaunch({ ...makeSpawnContext(workDir), launchSignal: controller.signal }),
      (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "ABORT_ERR",
    );
    assert.equal(existsSync(logPath), false, "no codex app-server was started after the cancel");
    // The cancel wrote nothing to the shared probe cache: a later uncancelled
    // launch resolution still finds the candidate usable.
    const prep = await prepareCodexLaunch(makeSpawnContext(workDir));
    assert.ok(prep.command, "the next launch preparation resolves normally");
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.SCRIPTED_CODEX_LOG === undefined) delete process.env.SCRIPTED_CODEX_LOG; else process.env.SCRIPTED_CODEX_LOG = previous.SCRIPTED_CODEX_LOG;
    rmSync(root, { recursive: true, force: true });
  }
});

test("#wg-ax:#3: Codex thread fields carry Raft's launch decisions before OAR wire mapping", () => {
  const fresh = makeSpawnContext("/work", { model: "gpt-5.5", reasoningEffort: "high" } as never);
  assert.deepEqual(codexThreadFields(fresh), { cwd: "/work", developerInstructions: "stand still", model: "gpt-5.5", reasoningEffort: "high", fast: false });

  const resumed = makeSpawnContext("/work", { sessionId: "thread-9" } as never);
  assert.equal(codexThreadFields(resumed).resumeThreadId, "thread-9");
  assert.equal(codexThreadFields(resumed).developerInstructions, "stand still");

  // #wg-runtime-form:#27: a named fast tier goes as Codex names it; plain fast leaves serviceTier undefined.
  const tiered = (mode: unknown) => makeSpawnContext("/work", {
    runtimeConfig: { version: 1, runtime: "codex", model: { kind: "preset", id: "gpt-6.2-astra" }, mode },
  } as never);
  assert.equal(codexThreadFields(tiered({ kind: "fast", serviceTier: "ultrafast" })).serviceTier, "ultrafast");
  assert.equal(codexThreadFields(tiered({ kind: "fast" })).fast, true);
  assert.equal(codexThreadFields(tiered({ kind: "fast" })).serviceTier, undefined);
});

test("#oar-raft:#7: on Windows anything under .codex\\.sandbox-bin is a sandbox helper, whatever its file name", async () => {
  const helper = "C:\\Users\\user\\.codex\\.sandbox-bin\\codex.exe";
  const deps = {
    platform: "win32" as const,
    env: { CODEX_BIN: helper, PATH: "" },
    existsSyncFn: (p: string) => String(p) === helper,
    execFileSyncFn: (() => Buffer.from("")) as unknown as typeof execFileSync,
    runProbeChildFn: (async () => ({ stdout: "", stderr: "" })) as typeof runProbeChild,
  };
  assert.throws(() => resolveCodexSpawn(["app-server"], deps), /CODEX_BIN.*sandbox helper \(codex-command-runner or \.sandbox-bin\)/s);
  await assert.rejects(resolveCodexSpawnAsync(["app-server"], deps), /CODEX_BIN.*sandbox helper \(codex-command-runner or \.sandbox-bin\)/s);
});
