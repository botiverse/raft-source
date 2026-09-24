import assert from "node:assert/strict";
import type { execFileSync } from "node:child_process";
import { test } from "vitest";

import {
  readCommandVersion,
  resolveCommandOnPath,
  withWindowsUserEnvironment,
} from "./probe.js";

const noWindowsEnvironment = () => null;

test("Windows environment reader executes newline-separated PowerShell and parses its scopes", () => {
  let capturedArgs: readonly string[] = [];
  const warnings: string[] = [];
  const execFileSyncFn: typeof execFileSync = ((_command: string, args?: readonly string[]) => {
    capturedArgs = args ?? [];
    return Buffer.from(JSON.stringify({
      Machine: { Path: "C:\\MachineBin", MACHINE_ONLY: "machine" },
      User: { Path: "C:\\UserBin", USER_ONLY: "user" },
    }));
  }) as typeof execFileSync;

  const merged = withWindowsUserEnvironment(
    { Path: "C:\\ExplicitBin", BASE_ONLY: "base" },
    {
      platform: "win32",
      execFileSyncFn,
      warn: (message) => warnings.push(message),
    },
  );

  assert.equal(capturedArgs[0], "-NoProfile");
  assert.equal(capturedArgs[3]?.includes("\n  foreach ($scope"), true);
  assert.equal(capturedArgs[3]?.includes("{}   foreach"), false);
  assert.equal(merged.Path, "C:\\ExplicitBin;C:\\MachineBin;C:\\UserBin");
  assert.equal(merged.MACHINE_ONLY, "machine");
  assert.equal(merged.USER_ONLY, "user");
  assert.equal(merged.BASE_ONLY, "base");
  assert.deepEqual(warnings, []);
});

test("Windows environment reader fallback emits bounded child failure evidence", () => {
  const env = { Path: "C:\\ExplicitBin", BASE_ONLY: "base" };
  const warnings: string[] = [];
  const execFileSyncFn: typeof execFileSync = (() => {
    const error = new Error("PowerShell failed") as Error & {
      status: number;
      stderr: Buffer;
    };
    error.status = 1;
    error.stderr = Buffer.from(`Unexpected token 'foreach' ${"x".repeat(400)}`);
    throw error;
  }) as typeof execFileSync;

  const merged = withWindowsUserEnvironment(env, {
    platform: "win32",
    execFileSyncFn,
    warn: (message) => warnings.push(message),
  });

  assert.equal(merged, env);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /Windows environment refresh failed \(exit=1, code=unknown, signal=none\)/);
  assert.match(warnings[0] ?? "", /Unexpected token 'foreach'/);
  assert.ok((warnings[0]?.length ?? 0) < 400);
});

test(
  "Windows environment reader executes and parses on Windows PowerShell 5.1",
  { skip: process.platform !== "win32" },
  () => {
    const warnings: string[] = [];
    const merged = withWindowsUserEnvironment(
      { ...process.env, TASK305_SENTINEL: "present" },
      { platform: "win32", warn: (message) => warnings.push(message) },
    );

    assert.equal(merged.TASK305_SENTINEL, "present");
    assert.ok(merged.Path ?? merged.PATH);
    assert.deepEqual(warnings, []);
  },
);

test("Windows environment reader leaves non-Windows environments untouched", () => {
  const env = { PATH: "/usr/local/bin", BASE_ONLY: "base" };
  let executed = false;
  let warned = false;

  const result = withWindowsUserEnvironment(env, {
    platform: "darwin",
    execFileSyncFn: ((_command: string) => {
      executed = true;
      return Buffer.from("");
    }) as typeof execFileSync,
    warn: () => {
      warned = true;
    },
  });

  assert.equal(result, env);
  assert.equal(executed, false);
  assert.equal(warned, false);
});

test("resolveCommandOnPath passes the runtime name directly to powershell on Windows", () => {
  let capturedCommand: string | null = null;
  let capturedArgs: readonly string[] | null = null;

  const execFileSyncFn: typeof execFileSync = ((command: string, argsOrOptions?: readonly string[] | object) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    capturedCommand = command;
    capturedArgs = args;
    return Buffer.from("C:\\Program Files\\Codex\\codex.exe\r\n");
  }) as typeof execFileSync;

  const resolved = resolveCommandOnPath("codex", {
    platform: "win32",
    env: { PATH: "C:\\Windows\\System32" },
    execFileSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, "C:\\Program Files\\Codex\\codex.exe");
  assert.equal(capturedCommand, "powershell.exe");
  assert.deepEqual(capturedArgs, [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "& {$cmd = Get-Command -Name $args[0] -ErrorAction Stop | Select-Object -First 1; if ($cmd.Path) { $cmd.Path } elseif ($cmd.Source) { $cmd.Source } elseif ($cmd.Definition) { $cmd.Definition } }",
    "codex",
  ]);
});

test("resolveCommandOnPath isolates both Windows PowerShell probes from inherited PSModulePath", () => {
  const sourceEnv: NodeJS.ProcessEnv = {
    Path: "C:\\ExplicitBin",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    TASK_ENV: "present",
  };
  const capturedEnvs: NodeJS.ProcessEnv[] = [];
  let callCount = 0;
  const execFileSyncFn: typeof execFileSync = ((
    command: string,
    _args?: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    assert.equal(command, "powershell.exe");
    assert.ok(options?.env);
    capturedEnvs.push(options.env);
    callCount += 1;
    if (callCount === 1) {
      return Buffer.from(JSON.stringify({
        Machine: {
          Path: "C:\\MachineBin",
          PSModulePath: "C:\\WindowsPowerShell\\Modules",
        },
        User: {
          Path: "C:\\UserBin",
          pSmOdUlEpAtH: "C:\\UserPowerShell\\Modules",
        },
      }));
    }
    return Buffer.from("C:\\Program Files\\Codex\\codex.exe\r\n");
  }) as typeof execFileSync;

  assert.equal(
    resolveCommandOnPath("codex", {
      platform: "win32",
      env: sourceEnv,
      execFileSyncFn,
    }),
    "C:\\Program Files\\Codex\\codex.exe",
  );
  assert.equal(capturedEnvs.length, 2);
  for (const childEnv of capturedEnvs) {
    assert.equal(
      Object.keys(childEnv).some((key) => key.toLowerCase() === "psmodulepath"),
      false,
    );
    assert.equal(childEnv.TASK_ENV, "present");
  }
  assert.equal(capturedEnvs[0]?.Path, "C:\\ExplicitBin");
  assert.equal(capturedEnvs[1]?.Path, "C:\\ExplicitBin;C:\\MachineBin;C:\\UserBin");
  assert.equal(sourceEnv.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
});

test("resolveCommandOnPath preserves PSModulePath for non-Windows child processes", () => {
  const sourceEnv: NodeJS.ProcessEnv = {
    PATH: "/usr/local/bin:/usr/bin",
    PSModulePath: "/opt/microsoft/powershell/7/Modules",
  };
  let capturedEnv: NodeJS.ProcessEnv | undefined;
  const execFileSyncFn: typeof execFileSync = ((
    command: string,
    _args?: readonly string[],
    options?: { env?: NodeJS.ProcessEnv },
  ) => {
    assert.equal(command, "which");
    capturedEnv = options?.env;
    return Buffer.from("/usr/local/bin/codex\n");
  }) as typeof execFileSync;

  assert.equal(
    resolveCommandOnPath("codex", {
      platform: "linux",
      env: sourceEnv,
      execFileSyncFn,
    }),
    "/usr/local/bin/codex",
  );
  assert.strictEqual(capturedEnv, sourceEnv);
  assert.equal(capturedEnv?.PSModulePath, "/opt/microsoft/powershell/7/Modules");
});

test("resolveCommandOnPath bounds a slow Windows probe and retries fresh after a timeout", () => {
  const capturedTimeouts: Array<number | undefined> = [];
  let callCount = 0;
  const execFileSyncFn: typeof execFileSync = ((_command: string, _args?: readonly string[], options?: { timeout?: number }) => {
    capturedTimeouts.push(options?.timeout);
    callCount += 1;
    if (callCount === 1) {
      const error = new Error("probe timed out") as NodeJS.ErrnoException;
      error.code = "ETIMEDOUT";
      throw error;
    }
    return Buffer.from("C:\\Program Files\\Codex\\codex.exe\r\n");
  }) as typeof execFileSync;

  const deps = {
    platform: "win32" as const,
    env: { PATH: "C:\\Windows\\System32" },
    execFileSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  };

  assert.equal(resolveCommandOnPath("codex", deps), null);
  assert.equal(resolveCommandOnPath("codex", deps), "C:\\Program Files\\Codex\\codex.exe");
  assert.deepEqual(capturedTimeouts, [1000, 1000]);
});

test("resolveCommandOnPath on Windows prefers .cmd over .ps1 from Get-Command", () => {
  const execFileSyncFn: typeof execFileSync = ((_command: string, _argsOrOptions?: readonly string[] | object) => {
    return Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n");
  }) as typeof execFileSync;

  const existsSyncFn = (filePath: string) => filePath === "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd";

  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.cmd");
});

test("resolveCommandOnPath on Windows prefers .bat over .exe when .cmd is absent", () => {
  const execFileSyncFn: typeof execFileSync = ((_command: string, _argsOrOptions?: readonly string[] | object) => {
    return Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n");
  }) as typeof execFileSync;

  const existsSyncFn = (filePath: string) => filePath === "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.bat";

  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.bat");
});

test("resolveCommandOnPath on Windows prefers .exe when .cmd and .bat are absent", () => {
  const execFileSyncFn: typeof execFileSync = ((_command: string, _argsOrOptions?: readonly string[] | object) => {
    return Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n");
  }) as typeof execFileSync;

  const existsSyncFn = (filePath: string) => filePath === "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.exe";

  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, "C:\\Users\\test\\AppData\\Roaming\\npm\\claude.exe");
});

test("resolveCommandOnPath on Windows falls back to extensionless when .ps1 alternatives are absent", () => {
  const execFileSyncFn: typeof execFileSync = ((_command: string, _argsOrOptions?: readonly string[] | object) => {
    return Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n");
  }) as typeof execFileSync;

  const existsSyncFn = (filePath: string) => filePath === "C:\\Users\\test\\AppData\\Roaming\\npm\\claude";

  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, "C:\\Users\\test\\AppData\\Roaming\\npm\\claude");
});

test("resolveCommandOnPath on Windows returns null when Get-Command returns .ps1 and no alternative exists", () => {
  const execFileSyncFn: typeof execFileSync = ((_command: string, _argsOrOptions?: readonly string[] | object) => {
    return Buffer.from("C:\\Users\\test\\AppData\\Roaming\\npm\\claude.ps1\r\n");
  }) as typeof execFileSync;

  const existsSyncFn = () => false;

  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    existsSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, null);
});

test("resolveCommandOnPath on Windows returns non-.ps1 result as-is", () => {
  const execFileSyncFn: typeof execFileSync = ((_command: string, _argsOrOptions?: readonly string[] | object) => {
    return Buffer.from("C:\\Program Files\\Claude\\claude.exe\r\n");
  }) as typeof execFileSync;

  const resolved = resolveCommandOnPath("claude", {
    platform: "win32",
    env: {},
    execFileSyncFn,
    windowsEnvironmentReaderFn: noWindowsEnvironment,
  });

  assert.equal(resolved, "C:\\Program Files\\Claude\\claude.exe");
});

test("resolveCommandOnPath on Windows merges Machine and User environment before probing", () => {
  const capturedEnvs: NodeJS.ProcessEnv[] = [];

  const execFileSyncFn: typeof execFileSync = ((_command: string, _args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (options?.env) capturedEnvs.push(options.env);
    return Buffer.from("C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.exe\r\n");
  }) as typeof execFileSync;

  const resolved = resolveCommandOnPath("cursor-agent", {
    platform: "win32",
    env: {
      Path: "C:\\ExplicitBin",
      SHARED_VALUE: "base",
    },
    execFileSyncFn,
    windowsEnvironmentReaderFn: () => ({
      machine: {
        Path: "C:\\MachineBin",
        MACHINE_ONLY: "machine",
        SHARED_VALUE: "machine",
      },
      user: {
        Path: "C:\\Users\\test\\AppData\\Local\\cursor-agent",
        USER_ONLY: "user",
        SHARED_VALUE: "user",
      },
    }),
  });

  assert.equal(resolved, "C:\\Users\\test\\AppData\\Local\\cursor-agent\\cursor-agent.exe");
  const capturedEnv = capturedEnvs[0];
  assert.ok(capturedEnv);
  assert.equal(capturedEnv?.Path, "C:\\ExplicitBin;C:\\MachineBin;C:\\Users\\test\\AppData\\Local\\cursor-agent");
  assert.equal(capturedEnv?.MACHINE_ONLY, "machine");
  assert.equal(capturedEnv?.USER_ONLY, "user");
  assert.equal(capturedEnv?.SHARED_VALUE, "base");
});

test("readCommandVersion on Windows uses merged Machine and User environment", () => {
  const capturedEnvs: NodeJS.ProcessEnv[] = [];

  const execFileSyncFn: typeof execFileSync = ((_command: string, _args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    if (options?.env) capturedEnvs.push(options.env);
    return Buffer.from("cursor-agent 1.2.3\r\n");
  }) as typeof execFileSync;

  const version = readCommandVersion("cursor-agent", [], {
    platform: "win32",
    env: { Path: "C:\\ExplicitBin" },
    execFileSyncFn,
    windowsEnvironmentReaderFn: () => ({
      machine: { Path: "C:\\MachineBin" },
      user: { Path: "C:\\Users\\test\\AppData\\Local\\cursor-agent" },
    }),
  });

  assert.equal(version, "cursor-agent 1.2.3");
  const capturedEnv = capturedEnvs[0];
  assert.ok(capturedEnv);
  assert.equal(capturedEnv?.Path, "C:\\ExplicitBin;C:\\MachineBin;C:\\Users\\test\\AppData\\Local\\cursor-agent");
});
