import assert from "node:assert/strict";
import {
  type ChildProcessWithoutNullStreams,
  type spawn,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import {
  BasicTracer,
  createSpanAttrContractTracer,
  MemoryTraceSink,
} from "@botiverse/raft-shared";

import { DAEMON_CORE_TRACE_ATTR_CONTRACTS } from "../core";
import { buildRaftCliGuideSections } from "./raftCliGuide";
import {
  buildPiPowerShellScript,
  createPiCommandTool,
  createPiPosixOperations,
  createPiPowerShellOperations,
} from "./piCommandTool";
import {
  createPiToolExecutionObserver,
  type PiToolExecutionObserver,
} from "./piToolExecutionObservability";
import { traceRows } from "../testing/traceRows";

class FakeChildProcess extends EventEmitter {
  // Never a real pid: an uninjected kill path sends process.kill(-pid, SIGKILL) for real.
  readonly pid = 2_000_004_242;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

test("Pi command tool keeps Bash on POSIX", () => {
  const tool = createPiCommandTool(
    "/workspace",
    { TASK_ENV: "present" },
    { platform: "linux" },
  );

  assert.equal(tool.name, "bash");
  assert.equal(tool.label, "bash");
  assert.match(tool.description, /bash command/i);
});

test("Pi command tool overrides Bash with native PowerShell on Windows", () => {
  const tool = createPiCommandTool(
    "C:\\workspace",
    { TASK_ENV: "present" },
    { platform: "win32" },
  );

  assert.equal(
    tool.name,
    "bash",
    "the custom tool must override Pi's active built-in Bash tool",
  );
  assert.equal(tool.label, "PowerShell");
  assert.match(tool.description, /Windows PowerShell 5\.1/);
  assert.match(tool.description, /not Bash syntax/);
});

test("observed POSIX operations preserve Pi spawn semantics and surface payload-free lifecycle facts", async () => {
  const child = new FakeChildProcess();
  const lifecycle: string[] = [];
  const observer: PiToolExecutionObserver = {
    beginRuntimeTurn: () => "turn",
    observeRuntimeTurnStart: () => "turn",
    observeRuntimeTurnEnd: () => undefined,
    setRuntimeSessionId: () => undefined,
    runToolExecution: async (_id, _signal, invoke) => invoke(),
    observeRuntimeUpdate: () => undefined,
    observeProcessSpawned: () => lifecycle.push("spawned"),
    observeProcessProgress: (bytes) => lifecycle.push(`progress:${bytes}`),
    observeProcessExit: ({ code, signal }) => lifecycle.push(`exited:${code}:${signal}`),
    observeTimeout: () => undefined,
    observeAbortRequested: () => undefined,
    emitDiagnosticSnapshots: () => [],
  };
  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedOptions: Record<string, unknown> | undefined;
  const spawnStub = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedOptions = options;
    queueMicrotask(() => {
      child.stdout.end("ok\n");
      child.stderr.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
  const output: Buffer[] = [];

  const result = await createPiPosixOperations({
    spawn: spawnStub,
    observer,
  }).exec("printf 'ok\\n'", process.cwd(), {
    env: { PATH: process.env.PATH },
    onData: (data) => output.push(data),
  });

  assert.match(capturedCommand, /(?:^|\/)bash$|^sh$/);
  assert.deepEqual(capturedArgs, ["-c", "printf 'ok\\n'"]);
  assert.equal(capturedOptions?.detached, true);
  assert.deepEqual(capturedOptions?.stdio, ["ignore", "pipe", "pipe"]);
  assert.deepEqual(result, { exitCode: 0 });
  assert.equal(Buffer.concat(output).toString("utf8"), "ok\n");
  assert.deepEqual(lifecycle, ["spawned", "progress:3", "exited:0:null"]);
});

test(
  "Pi command tool real entrypoint emits joinable lifecycle facts without command, output, or upstream id",
  { skip: process.platform === "win32" },
  async () => {
    const sink = new MemoryTraceSink();
    const tracer = createSpanAttrContractTracer(
      new BasicTracer({ sink }),
      DAEMON_CORE_TRACE_ATTR_CONTRACTS,
    );
    const observer = createPiToolExecutionObserver({
      tracer,
      serverId: "11111111-1111-4111-8111-111111111111",
      machineId: "22222222-2222-4222-8222-222222222222",
      agentId: "33333333-3333-4333-8333-333333333333",
      launchId: "44444444-4444-4444-8444-444444444444",
      runtimeVersion: "0.82.1",
      runtimeSessionId: "session-real-entrypoint",
    });
    observer.beginRuntimeTurn();
    const tool = createPiCommandTool(process.cwd(), process.env, {
      platform: process.platform,
      observer,
    });
    const rawToolCallId = "upstream-tool-id-must-not-export";
    const rawCommand = "printf '%s\\n' 'fixture-output-must-not-export'";

    const result = await tool.execute(rawToolCallId, { command: rawCommand });
    assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /fixture-output/);

    const spans = traceRows(sink);
    assert.deepEqual(spans.map((span) => span.name), [
      "daemon.runtime.tool.execution.started",
      "daemon.runtime.tool.process.spawned",
      "daemon.runtime.tool.progress.observed",
      "daemon.runtime.tool.process.exited",
      "daemon.runtime.tool.execution.finished",
    ]);
    const executionIds = new Set(spans.map((span) => span.attrs?.tool_execution_instance_id));
    assert.equal(executionIds.size, 1, "all lifecycle facts must join on one daemon execution id");
    const processFacts = spans.filter((span) =>
      span.name === "daemon.runtime.tool.process.spawned"
      || span.name === "daemon.runtime.tool.process.exited"
    );
    assert.equal(
      new Set(processFacts.map((span) => span.attrs?.process_instance_id)).size,
      1,
      "spawn and exit must join on one daemon process id",
    );
    const serialized = JSON.stringify(spans);
    assert.doesNotMatch(serialized, /upstream-tool-id-must-not-export/);
    assert.doesNotMatch(serialized, /fixture-output-must-not-export/);
    assert.doesNotMatch(serialized, /printf/);
    assert.doesNotMatch(serialized, /"pid"/i);
  },
);

test("PowerShell script preserves the command and propagates native failures", () => {
  const command = "@'\nhello `$world\n'@ | raft message send --target '#test'";
  const script = buildPiPowerShellScript(command);

  assert.match(script, /\$ErrorActionPreference = 'Stop'/);
  assert.ok(script.includes(command));
  assert.match(script, /\r\n\}\r\n\$raftCommandSucceeded = \$\?/);
  assert.match(
    script,
    /if \(\$raftNativeExitCode -ne 0\) \{ exit \$raftNativeExitCode \}/,
  );
  assert.match(script, /if \(-not \$raftCommandSucceeded\) \{ exit 1 \}/);
});

test("PowerShell operations use fixed argv, stream output, and inject the launch env", async () => {
  const child = new FakeChildProcess();
  let capturedCommand = "";
  let capturedArgs: readonly string[] = [];
  let capturedOptions: Record<string, unknown> | undefined;
  let encodedScript = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    encodedScript += chunk;
  });
  child.stdin.on("finish", () => {
    child.stdout.write("stdout\r\n");
    child.stderr.write("stderr\r\n");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);
  });

  const spawnStub = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    capturedCommand = command;
    capturedArgs = args;
    capturedOptions = options;
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
  const chunks: string[] = [];
  const operations = createPiPowerShellOperations({ spawn: spawnStub });
  const launchEnv = {
    TASK_ENV: "present",
    PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules",
    pSmOdUlEpAtH: "C:\\Users\\test\\Documents\\PowerShell\\Modules",
  };
  const result = await operations.exec("raft message check", "C:\\workspace", {
    env: launchEnv,
    onData: (data) => chunks.push(data.toString("utf8")),
  });

  assert.equal(capturedCommand, "powershell.exe");
  assert.deepEqual(capturedArgs.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  const loader = capturedArgs.at(-1) ?? "";
  assert.match(loader, /\[Console\]::OpenStandardInput\(\)/);
  assert.match(loader, /\[System\.Text\.Encoding\]::ASCII/);
  assert.match(loader, /\.ReadToEnd\(\)/);
  assert.match(loader, /\.Dispose\(\)/);
  assert.match(loader, /\[System\.Text\.Encoding\]::Unicode\.GetString/);
  assert.doesNotMatch(loader, /raft message check/);
  assert.ok(
    capturedArgs.join(" ").length < 2_048,
    "only the fixed loader belongs in argv",
  );
  assert.equal(capturedOptions?.cwd, "C:\\workspace");
  assert.deepEqual(capturedOptions?.env, { TASK_ENV: "present" });
  assert.equal(launchEnv.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
  assert.match(encodedScript, /^[A-Za-z0-9+/]+=*$/);
  assert.match(
    Buffer.from(encodedScript, "base64").toString("utf16le"),
    /raft message check/,
  );
  assert.deepEqual(chunks, ["stdout\r\n", "stderr\r\n"]);
  assert.deepEqual(result, { exitCode: 0 });
});

test("PowerShell stdin payload is well-formed padded base64 even for an empty user command", () => {
  const wrapped = buildPiPowerShellScript("");
  const encoded = Buffer.from(wrapped, "utf16le").toString("base64");

  assert.notEqual(encoded, "");
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/);
  // Whether `=` appears depends on the wrapper's length; what the loader's
  // FromBase64String needs is complete 4-character groups.
  assert.equal(encoded.length % 4, 0);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), wrapped);
});

test("PowerShell operations abort the whole child tree", async () => {
  const child = new FakeChildProcess();
  const killed: number[] = [];
  const spawnStub = (() =>
    child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn;
  const controller = new AbortController();
  const operations = createPiPowerShellOperations({
    spawn: spawnStub,
    killProcessTree: (pid) => {
      killed.push(pid);
      child.emit("close", null, null);
    },
  });

  const running = operations.exec("Start-Sleep -Seconds 30", "C:\\workspace", {
    env: {},
    onData: () => undefined,
    signal: controller.signal,
  });
  controller.abort();

  await assert.rejects(running, /aborted/);
  assert.deepEqual(killed, [2_000_004_242]);
});

test("PowerShell operations report their own timeout to the observer as failure_reason timeout", async () => {
  const child = new FakeChildProcess();
  const sink = new MemoryTraceSink();
  const observer = createPiToolExecutionObserver({
    tracer: createSpanAttrContractTracer(new BasicTracer({ sink }), DAEMON_CORE_TRACE_ATTR_CONTRACTS),
    serverId: "11111111-1111-4111-8111-111111111111",
    machineId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    launchId: "44444444-4444-4444-8444-444444444444",
    runtimeVersion: "0.82.1",
  });
  observer.beginRuntimeTurn();
  const operations = createPiPowerShellOperations({
    spawn: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
    killProcessTree: () => child.emit("close", 1, null),
    observer,
  });

  await assert.rejects(
    observer.runToolExecution("call-ps-timeout", undefined, () =>
      operations.exec("Start-Sleep -Seconds 30", "C:\\workspace", { env: {}, onData: () => undefined, timeout: 0.05 })),
    /timeout:0.05/,
  );
  const finished = traceRows(sink).find((row) => row.name === "daemon.runtime.tool.execution.finished");
  assert.equal(finished?.attrs?.failure_reason, "timeout");
});

const longCjkText = "长".repeat(65_536);

test("PowerShell operations keep a 64 KiB CJK command off argv", async () => {
  const child = new FakeChildProcess();
  const command = `Write-Output '${longCjkText}'`;
  let capturedArgs: readonly string[] = [];
  let encodedScript = "";
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk) => {
    encodedScript += chunk;
  });
  child.stdin.on("finish", () => {
    child.emit("close", 0, null);
  });

  const spawnStub = ((_command: string, args: readonly string[]) => {
    capturedArgs = args;
    return child as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
  const operations = createPiPowerShellOperations({ spawn: spawnStub });

  const result = await operations.exec(command, "C:\\workspace", {
    env: {},
    onData: () => undefined,
  });

  assert.deepEqual(capturedArgs.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
  ]);
  assert.match(capturedArgs.at(-1) ?? "", /OpenStandardInput/);
  assert.ok(capturedArgs.join(" ").length < 2_048);
  assert.doesNotMatch(capturedArgs.join(" "), /长/);
  assert.equal(
    Buffer.from(encodedScript, "base64").toString("utf16le"),
    buildPiPowerShellScript(command),
  );
  assert.deepEqual(result, { exitCode: 0 });
});

const shellContractCases = [
  {
    name: "preserves quotes and literal dollar signs",
    posix: `printf '%s\\n' "double quote: \\\"" "single quote: '" '$literal'`,
    powershell: `Write-Output 'double quote: "'; Write-Output "single quote: '"; Write-Output '$literal'`,
    output: `double quote: "\nsingle quote: '\n$literal\n`,
    exitCode: 0,
  },
  {
    name: "preserves multiline output",
    posix: "printf 'line one\\nline two\\n'",
    powershell:
      "@('line one', 'line two') | ForEach-Object { Write-Output $_ }",
    output: "line one\nline two\n",
    exitCode: 0,
  },
  {
    name: "round-trips CJK command text as UTF-8 output",
    posix: "printf '%s\\n' '中文往返：你好，世界'",
    powershell: "Write-Output '中文往返：你好，世界'",
    output: "中文往返：你好，世界\n",
    exitCode: 0,
  },
  {
    name: "propagates a native nonzero exit code",
    posix: "printf 'native failure\\n'; sh -c 'exit 23'",
    powershell: "Write-Output 'native failure'; & cmd.exe /d /c 'exit /b 23'",
    output: "native failure\n",
    exitCode: 23,
  },
] as const;

for (const contract of shellContractCases) {
  test(`Pi command shell contract ${contract.name}`, async () => {
    const operations =
      process.platform === "win32"
        ? createPiPowerShellOperations()
        : createPiPosixOperations();
    const command =
      process.platform === "win32" ? contract.powershell : contract.posix;
    const output: Buffer[] = [];

    const result = await operations.exec(command, process.cwd(), {
      env: process.env,
      onData: (data) => output.push(data),
    });

    assert.equal(
      Buffer.concat(output)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .replaceAll("\r\n", "\n"),
      contract.output,
    );
    assert.equal(result.exitCode, contract.exitCode);
  });
}

test(
  "Pi PowerShell ignores an inherited cross-edition PSModulePath",
  { skip: process.platform !== "win32" },
  async () => {
    const poison = "C:\\raft-test\\pwsh-only-modules";
    const output: Buffer[] = [];
    const result = await createPiPowerShellOperations().exec(
      `if ($env:PSModulePath -eq '${poison}') { throw 'inherited poisoned PSModulePath' }; Get-Command Get-ChildItem -ErrorAction Stop | Out-Null; Write-Output 'isolated'`,
      process.cwd(),
      {
        env: { ...process.env, PSModulePath: poison },
        onData: (data) => output.push(data),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(
      Buffer.concat(output).toString("utf8").replace(/^\uFEFF/, "").replaceAll("\r\n", "\n"),
      "isolated\n",
    );
  },
);

test(
  "Pi PowerShell contract round-trips a 64 KiB CJK command",
  { skip: process.platform !== "win32" },
  async () => {
    const output: Buffer[] = [];
    const result = await createPiPowerShellOperations().exec(
      `Write-Output '${longCjkText}'`,
      process.cwd(),
      {
        env: process.env,
        onData: (data) => output.push(data),
      },
    );

    assert.equal(
      Buffer.concat(output)
        .toString("utf8")
        .replace(/^\uFEFF/, "")
        .replaceAll("\r\n", "\n"),
      `${longCjkText}\n`,
    );
    assert.equal(result.exitCode, 0);
  },
);

test(
  "Pi PowerShell pipes CJK into a native command as UTF-8",
  { skip: process.platform !== "win32" },
  async () => {
    const hexer = "process.stdin.on('data',d=>process.stdout.write(Buffer.from(d).toString('hex')))";
    const output: Buffer[] = [];
    const result = await createPiPowerShellOperations().exec(
      `@'\r\n中文测试\r\n'@ | node -e "${hexer}"`,
      process.cwd(),
      {
        env: process.env,
        onData: (data) => output.push(data),
      },
    );

    assert.equal(result.exitCode, 0);
    assert.equal(
      Buffer.concat(output).toString("utf8").trim(),
      Buffer.from("中文测试\r\n", "utf8").toString("hex"),
    );
  },
);

test("PowerShell script builds a raw UTF-8 encoding for native pipes", () => {
  const script = buildPiPowerShellScript("");
  assert.match(script, /\$utf8NoBom = \[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.doesNotMatch(script, /New-Object System\.Text\.UTF8Encoding/);
  assert.match(script, /\$OutputEncoding = \$utf8NoBom/);
});

test("Windows CLI guide uses PowerShell here-strings instead of Bash heredocs", () => {
  const sections = buildRaftCliGuideSections({
    audience: "managed-runner",
    identity: { handle: "@agent", displayName: "Agent" },
    shell: "powershell",
  });

  assert.match(sections.sendingMessages, /single-quoted here-string/);
  assert.match(sections.sendingMessages, /'@ \| raft message send/);
  assert.match(sections.sendingMessages, /Do not use Bash heredoc syntax/);
  assert.doesNotMatch(sections.sendingMessages, /<<'RAFTMSG'/);
  assert.match(sections.threads, /PowerShell single-quoted here-string/);
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(file: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  for (let i = 0; i < 50; i += 1) {
    const text = await readFile(file, "utf8").catch(() => "");
    if (text.trim()) return Number(text.trim());
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no pid in ${file}`);
}

test("Pi command tool documents its default timeout", () => {
  const tool = createPiCommandTool("/workspace", {}, { platform: "linux" });

  assert.match(tool.description, /without a timeout are stopped after 600 seconds/);
  assert.match(String((tool.parameters.properties.timeout as { description?: unknown }).description), /default 600/);
});

for (const variant of ["built-in (Pi SDK operations)", "pi (observed operations)"] as const) {
  test(
    `Pi command tool stops a command without a timeout at the default, kills its process group and tells the model (${variant})`,
    { skip: process.platform === "win32" },
    async () => {
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "pi-default-timeout-"));
      const pidFile = join(dir, "child.pid");
      const observer = variant === "pi (observed operations)"
        ? createPiToolExecutionObserver({
          tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
          serverId: "11111111-1111-4111-8111-111111111111",
          machineId: "22222222-2222-4222-8222-222222222222",
          agentId: "33333333-3333-4333-8333-333333333333",
          launchId: "44444444-4444-4444-8444-444444444444",
          runtimeVersion: "0.82.1",
        })
        : undefined;
      if (observer) observer.beginRuntimeTurn();
      const tool = createPiCommandTool(dir, process.env, {
        platform: process.platform,
        defaultTimeoutSeconds: 1,
        ...(observer ? { observer } : {}),
      });

      const startedAt = Date.now();
      await assert.rejects(
        tool.execute("call-1", { command: `sleep 60 & echo $! > ${pidFile}; wait` }),
        (err: Error) => {
          assert.match(err.message, /Command timed out after 1 seconds/);
          assert.match(err.message, /default limit of 1 seconds for commands run without a timeout/);
          assert.match(err.message, /explicit timeout/);
          return true;
        },
      );
      assert.ok(Date.now() - startedAt < 10_000, "the default must end the call, not the command finishing");
      const childPid = await readPid(pidFile);
      for (let i = 0; i < 50 && processAlive(childPid); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(processAlive(childPid), false, "the command's process group must be killed");
    },
  );

  test(
    `Pi command tool keeps an explicit timeout as passed (${variant})`,
    { skip: process.platform === "win32" },
    async () => {
      const observer = variant === "pi (observed operations)"
        ? createPiToolExecutionObserver({
          tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
          serverId: "11111111-1111-4111-8111-111111111111",
          machineId: "22222222-2222-4222-8222-222222222222",
          agentId: "33333333-3333-4333-8333-333333333333",
          launchId: "44444444-4444-4444-8444-444444444444",
          runtimeVersion: "0.82.1",
        })
        : undefined;
      if (observer) observer.beginRuntimeTurn();
      const tool = createPiCommandTool(process.cwd(), process.env, {
        platform: process.platform,
        defaultTimeoutSeconds: 0.2,
        ...(observer ? { observer } : {}),
      });

      const result = await tool.execute("call-2", { command: "sleep 0.6; printf 'explicit-ok'", timeout: 30 });

      assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /explicit-ok/);
    },
  );
}

for (const variant of ["built-in", "pi (observed operations)"] as const) {
  test(
    `task #25 step 2: an aborted command's setsid child is killed with its process group (${variant})`,
    { skip: process.platform === "win32" },
    async () => {
      const { mkdtemp } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const dir = await mkdtemp(join(tmpdir(), "pi-abort-setsid-"));
      const groupPidFile = join(dir, "group.pid");
      const setsidPidFile = join(dir, "setsid.pid");
      const observer = variant === "pi (observed operations)"
        ? createPiToolExecutionObserver({
          tracer: new BasicTracer({ sink: new MemoryTraceSink() }),
          serverId: "11111111-1111-4111-8111-111111111111",
          machineId: "22222222-2222-4222-8222-222222222222",
          agentId: "33333333-3333-4333-8333-333333333333",
          launchId: "44444444-4444-4444-8444-444444444444",
          runtimeVersion: "0.82.1",
        })
        : undefined;
      observer?.beginRuntimeTurn();
      const tool = createPiCommandTool(dir, process.env, { platform: process.platform, ...(observer ? { observer } : {}) });
      const abort = new AbortController();

      const run = tool.execute(
        "call-abort",
        { command: `sleep 70 & echo $! > ${groupPidFile}; setsid sleep 71 & echo $! > ${setsidPidFile}; wait`, timeout: 60 },
        abort.signal,
      ).catch((err: Error) => err.message);
      const groupPid = await readPid(groupPidFile);
      const setsidPid = await readPid(setsidPidFile);
      abort.abort();

      assert.match(String(await run), /Command aborted/);
      for (let i = 0; i < 100 && (processAlive(groupPid) || processAlive(setsidPid)); i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(processAlive(groupPid), false, "the command's group is killed");
      assert.equal(processAlive(setsidPid), false, "a child that left the group is killed too");
    },
  );
}
