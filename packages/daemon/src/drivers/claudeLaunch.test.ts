import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import path from "node:path";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import {
  buildClaudeArgs,
  buildClaudeSpawnSpec,
  CLAUDE_DESKTOP_CLI_RELATIVE_PATH,
  CLAUDE_DISALLOWED_TOOLS,
  writeClaudeSystemPromptFile,
  probeClaude,
  probeClaudeLaunch,
  resolveClaudeCommand,
  resolveClaudeLaunchCommand,
} from "./claudeLaunch";

const config = {
  name: "hao",
  displayName: "Hao",
  description: "runtime tester",
  model: "sonnet",
  runtime: "claude",
  reasoningEffort: null,
  envVars: null,
  sessionId: null,
  serverUrl: "https://api.slock.ai",
  authToken: null,
};

test("claude launch config disallows provider-native cron and claude.ai Artifact tools", () => {
  assert.equal(
    CLAUDE_DISALLOWED_TOOLS,
    "EnterPlanMode,ExitPlanMode,ScheduleWakeup,CronCreate,CronList,CronDelete,Artifact,ArtifactComments,ArtifactData,ArtifactCheck,SendFeedback",
  );
  const args = buildClaudeArgs(config as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });
  const disallowed = args[args.indexOf("--disallowed-tools") + 1].split(",");
  for (const tool of ["Artifact", "ArtifactComments", "ArtifactData", "ArtifactCheck", "SendFeedback"]) {
    assert.ok(disallowed.includes(tool), `${tool} should be disallowed at launch`);
  }
});

test("claude launch args pass the exact Opus 5 model from structured runtimeConfig", () => {
  const args = buildClaudeArgs({
    ...config,
    model: "stale-legacy-model",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "claude-opus-5" },
      mode: { kind: "default" },
    },
  } as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-5");
  assert.equal(args.includes("claude-opus-4-8"), false);
});

test("claude launch command prefers structured runtimeConfig command", () => {
  const command = resolveClaudeLaunchCommand({
    ...config,
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      command: "claude-p",
    },
  } as any, {
    execFileSyncFn: () => {
      throw new Error("should not search PATH when command is configured");
    },
  });

  assert.equal(command, "claude-p");
});

test("claude launch args pass reasoning effort and fast mode to Claude Code", () => {
  const args = buildClaudeArgs({
    ...config,
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "opus" },
      mode: { kind: "fast" },
      reasoningEffort: "high",
    },
  } as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args.includes("--bare"), false);
  assert.equal(args[args.indexOf("--settings") + 1], JSON.stringify({ fastMode: true }));
});

test("claude launch args launch Opus 4.8 at the standard speed when fast mode is saved", () => {
  // Claude Code removes Opus 4.8 fast mode on 2026-11-30: a fast request for it fails.
  const args = buildClaudeArgs({
    ...config,
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "claude-opus-4-8" },
      mode: { kind: "fast" },
      reasoningEffort: null,
    },
  } as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.equal(args[args.indexOf("--model") + 1], "claude-opus-4-8");
  assert.equal(args.includes("--settings"), false);
});

test("claude launch args leave reasoning effort unset by default", () => {
  const args = buildClaudeArgs({
    ...config,
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      reasoningEffort: null,
    },
  } as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.equal(args.includes("--effort"), false);
  assert.equal(args.includes("--settings"), false);
});

test("claude custom provider launch args ignore user settings provider state", () => {
  const args = buildClaudeArgs({
    ...config,
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
      model: { kind: "custom", name: "deepseek-v4-flash" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  } as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.equal(args[args.indexOf("--model") + 1], "deepseek-v4-flash");
  assert.equal(args[args.indexOf("--setting-sources") + 1], "project,local");
});

test("claude launch resume passes the session id directly", () => {
  const args = buildClaudeArgs({
    ...config,
    sessionId: "0618f17e-577e-4e6a-a7f0-31dc50611388",
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "custom", apiUrl: "https://gateway.example.test/v1", apiKey: "sk-ant-test" },
      model: { kind: "preset", id: "opus" },
      mode: { kind: "default" },
      reasoningEffort: null,
      envVars: null,
    },
  } as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.equal(args[args.indexOf("--resume") + 1], "0618f17e-577e-4e6a-a7f0-31dc50611388");
});

test("claude launch args append standing instructions via prompt file only", () => {
  const args = buildClaudeArgs(config as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });

  assert.ok(args.includes("--append-system-prompt-file"));
  assert.equal(
    args[args.indexOf("--append-system-prompt-file") + 1],
    "/tmp/slock-agent/.slock/claude-system-prompt.md",
  );
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(!args.includes("--append-system-prompt"));
  assert.ok(!args.includes("--system-prompt-file"));
  assert.ok(!args.includes("--system-prompt"));

  assert.ok(args.includes("--disallowed-tools"));
  assert.equal(args[args.indexOf("--disallowed-tools") + 1], CLAUDE_DISALLOWED_TOOLS);
  assert.ok(args.includes("--permission-mode"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
});

test("claude launch args do not pass chat-MCP config flags", () => {
  const args = buildClaudeArgs(config as any, {
    standingPromptFilePath: "/tmp/slock-agent/.slock/claude-system-prompt.md",
  });
  assert.ok(!args.includes("--mcp-config"));
  assert.ok(!args.includes("--strict-mcp-config"));
  assert.ok(!args.includes("--runtime-actions-only"));
});

test("claude spawn spec never uses a shell on Windows", () => {
  const npmBin = "C:\\Users\\tester\\AppData\\Roaming\\npm";
  const shim = `${npmBin}\\claude.cmd`;
  const exe = `${npmBin}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const args = ["--settings", JSON.stringify({ fastMode: true }), "--model", "opus & echo x"];
  const deps = {
    platform: "win32" as const,
    existsSyncFn: (file: string) => file === shim || file === exe,
    readFileSyncFn: () => 'CALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
    windowsEnvironmentReaderFn: () => ({}),
    execFileSyncFn: ((command: string) => {
      assert.equal(command, "powershell.exe");
      return Buffer.from(`${shim}\r\n`);
    }) as any,
  };

  assert.deepEqual(buildClaudeSpawnSpec(shim, args, deps), { command: exe, args, shell: false });
  assert.deepEqual(buildClaudeSpawnSpec(null, args, deps), { command: exe, args, shell: false });
  assert.deepEqual(buildClaudeSpawnSpec("claude", args, deps), { command: exe, args, shell: false });
  assert.deepEqual(buildClaudeSpawnSpec("C:\\tools\\claude.exe", args, deps), {
    command: "C:\\tools\\claude.exe",
    args,
    shell: false,
  });
  assert.throws(
    () => buildClaudeSpawnSpec("C:\\tools\\claude.BAT", args, { ...deps, readFileSyncFn: () => "@echo off\r\n" }),
    /batch wrapper/,
  );
});

test("claude spawn spec passes the command through off Windows", () => {
  assert.deepEqual(buildClaudeSpawnSpec("/usr/local/bin/claude", ["--model", "opus"], { platform: "darwin" }), {
    command: "/usr/local/bin/claude",
    args: ["--model", "opus"],
    shell: false,
  });
  assert.deepEqual(buildClaudeSpawnSpec(null, [], { platform: "linux" }), { command: "claude", args: [], shell: false });
});

test("resolveClaudeCommand falls back to Claude Desktop URL handler on macOS", () => {
  const expectedPath = path.join("/Users/tester", CLAUDE_DESKTOP_CLI_RELATIVE_PATH);
  const resolved = resolveClaudeCommand({
    platform: "darwin",
    env: { HOME: "/Users/tester" },
    execFileSyncFn: () => {
      throw new Error("not on path");
    },
    existsSyncFn: (candidate) => candidate === expectedPath,
  });

  assert.equal(resolved, expectedPath);
});

test("probeClaude reports version from Claude Desktop URL handler fallback", () => {
  const expectedPath = path.join("/Users/tester", CLAUDE_DESKTOP_CLI_RELATIVE_PATH);
  const result = probeClaude({
    platform: "darwin",
    env: { HOME: "/Users/tester" },
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[] | object, maybeOptions?: object) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      if (command === "which") throw new Error("not on path");
      assert.equal(command, expectedPath);
      assert.deepEqual(args, ["--version"]);
      return Buffer.from("2.1.112 (Claude Code)\n");
    }) as typeof import("node:child_process").execFileSync,
    existsSyncFn: (candidate) => candidate === expectedPath,
  });

  assert.deepEqual(result, { available: true, version: "2.1.112 (Claude Code)" });
});

test("probeClaudeLaunch versions the exact structured custom command without falling back to PATH", () => {
  const result = probeClaudeLaunch({
    ...config,
    runtimeConfig: {
      version: 1,
      runtime: "claude",
      provider: { kind: "default" },
      model: { kind: "preset", id: "sonnet" },
      mode: { kind: "default" },
      command: "/opt/custom/claude-p",
      envVars: { PATH: "/custom/bin", CLAUDE_PROBE_SECRET: "must-not-be-logged" },
    },
  } as any, {
    env: { PATH: "/host/bin", CLAUDECODE: "nested-runtime" },
    cwd: "/tmp/agent-workspace",
    execFileSyncFn: ((command: string, argsOrOptions?: readonly string[], maybeOptions?: { env?: NodeJS.ProcessEnv; cwd?: string }) => {
      const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
      assert.equal(command, "/opt/custom/claude-p");
      assert.deepEqual(args, ["--version"]);
      assert.equal(maybeOptions?.env?.PATH, "/host/bin");
      assert.equal(maybeOptions?.env?.CLAUDECODE, undefined);
      assert.equal(maybeOptions?.env?.CLAUDE_PROBE_SECRET, undefined);
      assert.equal(maybeOptions?.cwd, "/tmp/agent-workspace");
      return Buffer.from("2.1.220 (Claude Code)\n");
    }) as typeof import("node:child_process").execFileSync,
  });

  assert.deepEqual(result, { available: true, version: "2.1.220 (Claude Code)" });
});

test("probeClaude recovers on the next Windows detection after a command lookup timeout", () => {
  const claudePath = "C:\\Program Files\\Claude\\claude.exe";
  let lookupCount = 0;
  const execFileSyncFn = ((command: string, argsOrOptions?: readonly string[]) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    if (command === "powershell.exe") {
      lookupCount += 1;
      if (lookupCount === 1) {
        const error = new Error("probe timed out") as NodeJS.ErrnoException;
        error.code = "ETIMEDOUT";
        throw error;
      }
      return Buffer.from(`${claudePath}\r\n`);
    }

    assert.equal(command, claudePath);
    assert.deepEqual(args, ["--version"]);
    return Buffer.from("2.1.210 (Claude Code)\r\n");
  }) as typeof import("node:child_process").execFileSync;
  const deps = {
    platform: "win32" as const,
    env: { PATH: "C:\\Windows\\System32" },
    execFileSyncFn,
    windowsEnvironmentReaderFn: () => null,
  };

  // A timed-out lookup is undecided, not "not installed". (task #1240: the
  // lookup timing rides along as `diagnostic`; it is asserted separately.)
  const { diagnostic: timedOutDiagnostic, lookupTiming: timedOutTiming, ...timedOut } = probeClaude(deps);
  assert.deepEqual(timedOut, { available: false, unavailableReason: "probe_timeout" });
  assert.match(timedOutDiagnostic ?? "", /^lookup: /);
  assert.ok(timedOutTiming);
  const { lookupTiming: recoveredTiming, ...recovered } = probeClaude(deps);
  assert.ok(recoveredTiming);
  assert.deepEqual(recovered, {
    available: true,
    version: "2.1.210 (Claude Code)",
  });
});


// task #302 sibling arm: kimi.ts was the file that lacked an explicit mode, but
// the invariant belongs to the whole runtime prompt-file family, so pin it here
// too rather than leaving the sibling unguarded.
test("claude system prompt file is written owner-only (task #302)", () => {
  if (process.platform === "win32") return; // POSIX permission bits do not apply
  const dir = mkdtempSync(path.join(os.tmpdir(), "claude-mode-"));
  try {
    const promptPath = writeClaudeSystemPromptFile("standing prompt body", dir);
    assert.equal(statSync(promptPath).mode & 0o777, 0o600, "claude system prompt file must be 0600");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task #1240: probeClaude carries the Windows lookup timing as a bounded diagnostic, available or not", () => {
  const execFileSyncFn = ((_command: string, args?: readonly string[]) => {
    if (args?.includes("--version")) return Buffer.from("2.1.0\r\n");
    if (args?.some((arg) => typeof arg === "string" && arg.includes("Get-Command"))) return Buffer.from("C:\\Users\\secret-user\\AppData\\Roaming\\npm\\claude.cmd\r\n");
    throw Object.assign(new Error("unexpected"), { status: 1 });
  }) as unknown as typeof execFileSync;
  const available = probeClaude({ platform: "win32", env: { PATH: "C:\\Windows\\System32" }, execFileSyncFn, windowsEnvironmentReaderFn: () => null, existsSyncFn: () => true });
  assert.equal(available.available, true);
  assert.equal(available.diagnostic, undefined, "a healthy runtime carries no diagnostic (ready-time diagnostics warn)");
  assert.match(available.lookupTiming ?? "", /^environment \d+ ms spawn_error \(budget 5000 ms\), get-command \d+ ms ok \(budget 5000 ms\)$/);
  assert.doesNotMatch(available.lookupTiming ?? "", /secret-user|AppData/);

  const timedOut = probeClaude({
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    execFileSyncFn: (() => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); }) as unknown as typeof execFileSync,
    windowsEnvironmentReaderFn: () => null,
  });
  assert.equal(timedOut.available, false);
  assert.equal(timedOut.unavailableReason, "probe_timeout");
  assert.match(timedOut.diagnostic ?? "", /^lookup: .*get-command \d+ ms timeout \(truncated\) \(budget 5000 ms\)/);
  assert.equal(timedOut.lookupTiming, timedOut.diagnostic?.replace(/^lookup: /, ""));
});
