import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AvailableInstallation, Runtime } from "@botiverse/oar";
import type { AgentConfig } from "@botiverse/raft-shared";
import type { SpawnContext } from "../drivers/types";
import { OarLaunchDeclined } from "./oarLaunch";
import {
  genericOarLaunch,
  hasPiWorkspaceSkillsOrPrompts,
  migrateLegacyPiSessionFile,
  piOarAgentDir,
  piOarSessionDir,
  preparePiOarLaunch,
} from "./oarGenericLaunch";

function makeSpawnContext(workingDirectory: string, overrides: Partial<AgentConfig> = {}): SpawnContext {
  const config: AgentConfig = {
    name: "pi-agent",
    displayName: "Pi Agent",
    description: "test",
    model: "anthropic/claude-sonnet-4-6",
    runtime: "pi",
    reasoningEffort: null,
    envVars: null,
    sessionId: null,
    serverUrl: "https://raft.example.com",
    authToken: "",
    agentCredentialKey: "sk_agent_test",
    ...overrides,
  };
  return {
    agentId: "agent-1",
    config,
    workingDirectory,
    standingPrompt: "You are Pi.",
    prompt: "hello",
    daemonApiKey: "sk_daemon_test",
    slockCliPath: "/usr/local/bin/raft",
    launchId: "launch-1",
    processInstanceId: "proc-1",
  };
}

const BUNDLED_INSTALLATION: AvailableInstallation = { kind: "available", via: "bundled" };

test("genericOarLaunch derives SessionOptions and busyDelivery from OAR runtime declarations", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "oar-generic-launch-"));
  try {
    const ctx = makeSpawnContext(tmp, { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "high", sessionId: "sess-1" });
    const fullRuntime: Pick<Runtime, "refusedSessionOptions" | "sessionCapabilities"> = {
      refusedSessionOptions: {},
      sessionCapabilities: () => ({ steer: true, images: true }),
    };
    const full = genericOarLaunch("pi", fullRuntime, BUNDLED_INSTALLATION, ctx, { PATH: "/usr/bin", NO_COLOR: "1" }, {
      inherited: { PATH: "/usr/bin", SECRET_KEY: "hidden" },
      managedMcp: { name: "raftmcp", url: "http://127.0.0.1:9999/mcp/tok-1", endpointUrl: "http://127.0.0.1:9999/mcp", token: "tok-1" },
      disallowedTools: ["ScheduleWakeup"],
      launchArgs: ["--setting-sources", "project,local"],
      userConfiguration: "exclude",
    });
    assert.equal(full.runtimeId, "pi");
    assert.equal(full.busyDelivery, "now");
    assert.equal(full.options.systemPrompt, "You are Pi.");
    assert.equal(full.options.appendSystemPrompt, undefined);
    assert.equal(full.options.model, "anthropic/claude-sonnet-4-6");
    assert.equal(full.options.effort, "high");
    assert.equal(full.options.resume, "sess-1");
    assert.equal(full.options.endTurnProcessesOnAbort, true);
    assert.equal(full.options.env?.SECRET_KEY, null);
    assert.equal(full.options.env?.NO_COLOR, "1");
    assert.equal(full.options.mcpServers?.length, 1);
    assert.deepEqual(full.options.disallowedTools, ["ScheduleWakeup"]);
    assert.deepEqual(full.options.launchArgs, ["--setting-sources", "project,local"]);
    assert.equal(full.options.userConfiguration, "exclude");

    const restrictedRuntime: Pick<Runtime, "refusedSessionOptions" | "sessionCapabilities"> = {
      refusedSessionOptions: {
        systemPrompt: "no",
        mcpServerCredentials: "no",
        endTurnProcessesOnAbort: "no",
        disallowedTools: "no",
        launchArgs: "no",
        userConfiguration: "no",
      },
      sessionCapabilities: () => ({ steer: false, images: true }),
    };
    const restricted = genericOarLaunch("pi", restrictedRuntime, BUNDLED_INSTALLATION, ctx, { PATH: "/usr/bin" }, {
      inherited: { PATH: "/usr/bin" },
      managedMcp: { name: "raftmcp", url: "http://127.0.0.1:9999/mcp/tok-1", endpointUrl: "http://127.0.0.1:9999/mcp", token: "tok-1" },
      disallowedTools: ["ScheduleWakeup"],
      launchArgs: ["--flag"],
      userConfiguration: "exclude",
    });
    assert.equal(restricted.busyDelivery, "after_turn");
    assert.equal(restricted.options.systemPrompt, undefined);
    assert.equal(restricted.options.appendSystemPrompt, "You are Pi.");
    assert.equal(restricted.options.mcpServers, undefined);
    assert.equal(restricted.options.endTurnProcessesOnAbort, undefined);
    assert.equal(restricted.options.disallowedTools, undefined);
    assert.equal(restricted.options.launchArgs, undefined);
    assert.equal(restricted.options.userConfiguration, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("piOarAgentDir and piOarSessionDir match OAR Pi RPC resolution", () => {
  assert.equal(
    piOarAgentDir({ OAR_PI_AGENT_DIR: "/custom/oar", PI_CODING_AGENT_DIR: "/custom/pi", HOME: "/home/u" }),
    path.resolve("/custom/oar"),
  );
  assert.equal(
    piOarAgentDir({ OAR_PI_AGENT_DIR: "", PI_CODING_AGENT_DIR: "/custom/pi", HOME: "/home/u" }),
    path.resolve("/custom/pi"),
  );
  assert.equal(
    piOarAgentDir({ HOME: "/home/u" }),
    path.resolve("/home/u/.pi/agent"),
  );
  assert.equal(
    piOarSessionDir("/home/ubuntu/work/agent-1", "/home/ubuntu/.pi/agent"),
    path.join(path.resolve("/home/ubuntu/.pi/agent"), "sessions", "--home-ubuntu-work-agent-1--"),
  );
});

test("migrateLegacyPiSessionFile copies legacy .pi-sessions file once without overwriting native OAR files or following symlinks", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "oar-pi-migrate-"));
  try {
    const cwd = path.join(tmp, "workspace");
    const agentDir = path.join(tmp, "pi-agent");
    const legacyDir = path.join(cwd, ".pi-sessions");
    mkdirSync(legacyDir, { recursive: true });
    const legacyContent = `${JSON.stringify({ type: "session", version: 3, id: "sess-abc", timestamp: "2026-11-19T00:00:00Z", cwd })}\n`;
    const legacyPath = path.join(legacyDir, "2026-11-19T00-00-00-000Z_sess-abc.jsonl");
    writeFileSync(legacyPath, legacyContent);

    const first = migrateLegacyPiSessionFile(cwd, "sess-abc", agentDir);
    assert.equal(first.migrated, true);
    assert.ok(first.targetPath);
    assert.equal(readFileSync(first.targetPath!, "utf8"), legacyContent);
    // Legacy file stays intact for lossless rollback.
    assert.equal(readFileSync(legacyPath, "utf8"), legacyContent);

    // Native OAR file wins on subsequent launches: never overwritten.
    writeFileSync(first.targetPath!, `${legacyContent}{"type":"message"}\n`);
    const second = migrateLegacyPiSessionFile(cwd, "sess-abc", agentDir);
    assert.equal(second.migrated, false);
    assert.match(readFileSync(first.targetPath!, "utf8"), /"type":"message"/);

    // Header-id matching works even if the filename doesn't end in _<id>.jsonl.
    const headerOnly = path.join(legacyDir, "custom-name.jsonl");
    writeFileSync(headerOnly, `${JSON.stringify({ type: "session", id: "sess-header-only" })}\n`);
    const migratedHeader = migrateLegacyPiSessionFile(cwd, "sess-header-only", agentDir);
    assert.equal(migratedHeader.migrated, true);

    // Symlinks in .pi-sessions are ignored.
    const outside = path.join(tmp, "outside.jsonl");
    writeFileSync(outside, `${JSON.stringify({ type: "session", id: "sess-symlink" })}\n`);
    symlinkSync(outside, path.join(legacyDir, "2026_sess-symlink.jsonl"));
    const symlinkResult = migrateLegacyPiSessionFile(cwd, "sess-symlink", agentDir);
    assert.equal(symlinkResult.migrated, false);

    // Corrupt suffix-matching file with a different header id is NOT copied.
    writeFileSync(
      path.join(legacyDir, "2026_sess-spoof.jsonl"),
      `${JSON.stringify({ type: "session", id: "different-id" })}\n`,
    );
    assert.equal(migrateLegacyPiSessionFile(cwd, "sess-spoof", agentDir).migrated, false);

    // Symlinked .pi-sessions directory itself is never followed.
    const cwdSymlinkDir = path.join(tmp, "workspace-symlink-dir");
    const outsideDir = path.join(tmp, "outside-sessions");
    mkdirSync(cwdSymlinkDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      path.join(outsideDir, "2026_sess-escape.jsonl"),
      `${JSON.stringify({ type: "session", id: "sess-escape" })}\n`,
    );
    symlinkSync(outsideDir, path.join(cwdSymlinkDir, ".pi-sessions"));
    assert.equal(migrateLegacyPiSessionFile(cwdSymlinkDir, "sess-escape", agentDir).migrated, false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("hasPiWorkspaceSkillsOrPrompts detects non-empty project skills/prompts and ignores empty dirs", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "oar-pi-skills-"));
  try {
    assert.equal(hasPiWorkspaceSkillsOrPrompts(tmp), false);
    mkdirSync(path.join(tmp, ".pi", "skills"), { recursive: true });
    assert.equal(hasPiWorkspaceSkillsOrPrompts(tmp), false, "empty .pi/skills does not decline");
    writeFileSync(path.join(tmp, ".pi", "skills", "custom.md"), "# skill");
    assert.equal(hasPiWorkspaceSkillsOrPrompts(tmp), true);

    rmSync(path.join(tmp, ".pi"), { recursive: true, force: true });
    mkdirSync(path.join(tmp, ".agents", "skills"), { recursive: true });
    writeFileSync(path.join(tmp, ".agents", "skills", "team.md"), "# skill");
    assert.equal(hasPiWorkspaceSkillsOrPrompts(tmp), true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preparePiOarLaunch enforces canary decline guards and builds OAR Pi launch", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "oar-pi-launch-"));
  const agentDir = path.join(tmp, "pi-agent");
  const cwd = path.join(tmp, "work");
  mkdirSync(cwd, { recursive: true });
  const fakeRuntime = {
    refusedSessionOptions: { endTurnProcessesOnAbort: "not verified", launchArgs: "not supported" },
    sessionCapabilities: () => ({ steer: true, images: true }),
    installation: async () => BUNDLED_INSTALLATION,
  } as unknown as Runtime;
  const baseDeps = {
    buildEnv: async () => ({ PATH: "/usr/bin", NO_COLOR: "1", PI_CODING_AGENT_DIR: agentDir }),
    loadRuntime: async () => fakeRuntime,
    prepareManagedMcp: async () => ({ name: "raftmcp", url: "http://127.0.0.1:4242/mcp/tok-pi", endpointUrl: "http://127.0.0.1:4242/mcp", token: "tok-pi" }),
    inheritedEnv: { PATH: "/usr/bin", DAEMON_SECRET: "strip-me" },
  };
  try {
    // Defense-in-depth: builtin never launches through Pi OAR.
    await assert.rejects(
      preparePiOarLaunch(makeSpawnContext(cwd, { runtime: "builtin" }), baseDeps),
      (err: unknown) => err instanceof OarLaunchDeclined && err.reason === "pi_runtime_mismatch",
    );

    // Custom pi-builtin provider declines during canary.
    await assert.rejects(
      preparePiOarLaunch(makeSpawnContext(cwd, {
        runtimeConfig: {
          version: 1,
          runtime: "pi",
          provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "sk-test" },
          model: { kind: "custom", name: "deepseek/deepseek-chat" },
          mode: { kind: "default" },
        },
      }), baseDeps),
      (err: unknown) => err instanceof OarLaunchDeclined && err.reason === "pi_custom_provider",
    );

    // Unqualified bare model name declines.
    await assert.rejects(
      preparePiOarLaunch(makeSpawnContext(cwd, { model: "claude-sonnet-4-6" }), baseDeps),
      (err: unknown) => err instanceof OarLaunchDeclined && err.reason === "pi_unqualified_model",
    );

    // Workspace .pi/prompts declines.
    mkdirSync(path.join(cwd, ".pi", "prompts"), { recursive: true });
    writeFileSync(path.join(cwd, ".pi", "prompts", "review.md"), "review");
    await assert.rejects(
      preparePiOarLaunch(makeSpawnContext(cwd), baseDeps),
      (err: unknown) => err instanceof OarLaunchDeclined && err.reason === "pi_workspace_skills_present",
    );
    rmSync(path.join(cwd, ".pi"), { recursive: true, force: true });

    // Happy path: migrates legacy session file + attaches managed MCP + omits refused endTurnProcessesOnAbort.
    mkdirSync(path.join(cwd, ".pi-sessions"), { recursive: true });
    writeFileSync(
      path.join(cwd, ".pi-sessions", "2026-11-19_sess-pi-1.jsonl"),
      `${JSON.stringify({ type: "session", id: "sess-pi-1" })}\n`,
    );
    const launch = await preparePiOarLaunch(
      makeSpawnContext(cwd, { model: "anthropic/claude-sonnet-4-6", reasoningEffort: "medium", sessionId: "sess-pi-1" }),
      baseDeps,
    );
    assert.equal(launch.runtimeId, "pi");
    assert.equal(launch.busyDelivery, "now");
    assert.equal(launch.options.model, "anthropic/claude-sonnet-4-6");
    assert.equal(launch.options.effort, "medium");
    assert.equal(launch.options.resume, "sess-pi-1");
    assert.equal(launch.options.systemPrompt, "You are Pi.");
    assert.equal(launch.options.endTurnProcessesOnAbort, undefined);
    assert.equal(launch.options.env?.DAEMON_SECRET, null);
    assert.equal(launch.options.mcpServers?.[0]?.name, "raftmcp");

    const migratedFile = path.join(piOarSessionDir(cwd, agentDir), "2026-11-19_sess-pi-1.jsonl");
    assert.match(readFileSync(migratedFile, "utf8"), /"id":"sess-pi-1"/);

    // Default model still preserves reasoningEffort (Pi accepts --thinking independently of --model).
    const defaultModelLaunch = await preparePiOarLaunch(
      makeSpawnContext(cwd, { model: "default", reasoningEffort: "high" }),
      baseDeps,
    );
    assert.equal(defaultModelLaunch.options.model, undefined);
    assert.equal(defaultModelLaunch.options.effort, "high");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
