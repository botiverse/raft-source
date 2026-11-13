import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildResidentSpawn } from "./service";

import { program, runRestartCommand, type RestartCommandDeps } from "./cli";
import { ServiceClientError } from "./lib/types";

// The restart tests replace runStop/runStart, but a regression that falls
// through to a real stop must never reach the developer's own Computer: pin
// the default Raft home for this file to a throwaway directory.
const isolatedRaftHome = mkdtempSync(join(tmpdir(), "raft-cli-lifecycle-contract-"));
process.env.RAFT_HOME = isolatedRaftHome;
process.env.SLOCK_HOME = isolatedRaftHome;
afterAll(() => rmSync(isolatedRaftHome, { recursive: true, force: true }));

test("CLI lifecycle contract: ordinary command surface excludes destructive and reversal-only verbs", () => {
  const commands = program.commands.map((cmd) => cmd.name());
  // `detach <server>` is back (device-auth §3.2) only as the server-first
  // revoke-then-forget verb (detach.test.ts pins that order); it takes a
  // required server and asks before doing anything.
  const detach = program.commands.find((cmd) => cmd.name() === "detach");
  assert.ok(detach, "detach revokes this machine's key on one server");
  assert.equal(detach.registeredArguments[0]?.required, true, "detach needs an explicit server");
  assert.ok(detach.options.some((option) => option.long === "--yes"), "detach asks unless --yes");
  assert.ok(!commands.includes("revoke"), "ordinary CLI must not expose destructive revoke");
  assert.ok(!commands.includes("delete"), "ordinary CLI must not expose destructive delete");
  assert.ok(!commands.includes("switch"), "ordinary CLI must not expose regret-state switch");
});


const LIVE_SERVICE = {
  pid: 4242,
  pidfilePath: "/tmp/raft-home/computer/run/service.pid",
  firstStalePidfile: null,
  firstStalePid: null,
};

// task #1202: a user whose service could not resolve DNS after a new macOS
// login session recovered only with `stop` then `start` from the new session;
// `restart`, which had the old service launch its own replacement, did not help.
// From a person's terminal, restart is now exactly that stop then start.
test("CLI restart from a person's terminal with a live service stops then starts from the caller", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => {
      calls.push("list");
      return ["server-a", "server-b"];
    },
    prepareLocalLifecycleOperations: async () => {
      throw new Error("stop and start record their own lifecycle steps");
    },
    findLiveServicePidReadOnly: async () => {
      calls.push("find");
      return LIVE_SERVICE;
    },
    callerIsRunnerHosted: () => false,
    runStop: async (stopDeps) => {
      assert.equal(stopDeps?.signal, signal);
      calls.push(`stop:${stopDeps?.hostLifecycleOwner}`);
    },
    runStart: async (opts, runtimeDeps) => {
      assert.ok(opts);
      assert.equal(runtimeDeps?.signal, signal);
      calls.push(`start:${opts.serverId}:${opts.serverLabel}:${opts.foreground}:${opts.recordLifecycleIntent}:${opts.hostLifecycleOwner}`);
    },
    prepareTargetsForServiceHandoff: async () => {
      throw new Error("a terminal restart must not hand off inside the old service");
    },
    requestServiceRestartViaIpc: async () => {
      throw new Error("a terminal restart must not ask the old service to launch its replacement");
    },
    info: (line: string) => {
      calls.push(`info:${line}`);
    },
    fail: (code: string, message: string): never => {
      throw new Error(`fail:${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, {}, signal, deps);

  assert.deepEqual(calls, [
    "list",
    "find",
    "info:Restarting from this terminal: stopping the service (pid 4242), then starting it again.",
    "stop:cli",
    "start:null:null:undefined:undefined:cli",
  ]);
});

test("CLI restart from a terminal starts nothing when the stop does not finish", async () => {
  let started = false;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => false,
    runStop: async () => {
      throw new Error("STOP_TIMEOUT: service did not exit");
    },
    runStart: async () => {
      started = true;
    },
    info: () => {},
  } satisfies RestartCommandDeps;

  await assert.rejects(
    runRestartCommand(undefined, {}, new AbortController().signal, deps),
    /STOP_TIMEOUT/,
  );
  assert.equal(started, false, "a failed stop must never be followed by a second service");
});

test("CLI restart --foreground from a terminal stops then starts in the foreground, on every platform", async () => {
  const calls: string[] = [];
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => false,
    runStop: async () => {
      calls.push("stop");
    },
    runStart: async (opts) => {
      calls.push(`start:${opts?.foreground}`);
    },
    info: () => {},
    fail: (code: string, message: string): never => {
      throw new Error(`${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, { foreground: true }, new AbortController().signal, deps);
  assert.deepEqual(calls, ["stop", "start:true"]);
});

test("CLI restart from inside an agent process requests the IPC handoff and never stops or starts from the caller", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async (slockHome: string) => {
      calls.push(`list:${slockHome}`);
      return ["server-a", "server-b"];
    },
    prepareLocalLifecycleOperations: async (
      slockHome: string,
      action: "start" | "stop" | "restart" | "upgrade",
      targets: string[],
    ) => {
      calls.push(`intent:${slockHome}:${action}:${targets.join(",")}`);
      return [];
    },
    findLiveServicePidReadOnly: async (slockHome: string) => {
      calls.push(`find:${slockHome}`);
      return LIVE_SERVICE;
    },
    prepareTargetsForServiceHandoff: async (
      slockHome: string,
      targets: string[],
      actualSignal: AbortSignal,
    ) => {
      assert.equal(actualSignal, signal);
      calls.push(`prepare:${slockHome}:${targets.join(",")}`);
    },
    requestServiceRestartViaIpc: async (slockHome: string) => {
      calls.push(`ipc:${slockHome}`);
      return { status: "accepted" as const };
    },
    runStop: async () => {
      calls.push("forbidden-stop");
    },
    runStart: async () => {
      calls.push("forbidden-start");
    },
    callerIsRunnerHosted: () => true,
    info: (line: string) => {
      calls.push(`info:${line}`);
    },
    fail: (code: string, message: string): never => {
      throw new Error(`fail:${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, {}, signal, deps);

  assert.deepEqual(calls, [
    "list:/tmp/raft-home",
    "find:/tmp/raft-home",
    "intent:/tmp/raft-home:restart:server-a,server-b",
    "prepare:/tmp/raft-home:server-a,server-b",
    "ipc:/tmp/raft-home",
    "info:Service restart requested (pid 4242); replacement service will take over without relying on this shell.",
    "info:Running inside an agent process: not waiting for runners to reconnect. Check with `raft-computer status`.",
  ]);
});

test("CLI restart cold-boot path remains start-only and preserves scoped target", async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    resolveTargetServerId: async (opts: { server?: string | null }) => {
      assert.equal(typeof opts.server, "string");
      calls.push(`resolve:${opts.server}`);
      return "server-a";
    },
    listAttachedServerIds: async () => {
      throw new Error("must not list attached servers for scoped restart");
    },
    prepareLocalLifecycleOperations: async (
      slockHome: string,
      action: "start" | "stop" | "restart" | "upgrade",
      targets: string[],
    ) => {
      calls.push(`intent:${slockHome}:${action}:${targets.join(",")}`);
      return [];
    },
    findLiveServicePidReadOnly: async (slockHome: string) => {
      calls.push(`find:${slockHome}`);
      return { ...LIVE_SERVICE, pid: null };
    },
    callerIsRunnerHosted: () => false,
    runStop: async () => {
      throw new Error("nothing to stop when no service is live");
    },
    runStart: async (opts, runtimeDeps) => {
      assert.ok(opts);
      assert.equal(runtimeDeps?.signal, signal);
      calls.push(
        `start:${opts.serverId}:${opts.serverLabel}:${opts.foreground}:${opts.recordLifecycleIntent}:${opts.hostLifecycleOwner}`,
      );
    },
    prepareTargetsForServiceHandoff: async () => {
      throw new Error("must not prepare service handoff when no service is live");
    },
    requestServiceRestartViaIpc: async () => {
      throw new Error("must not call IPC when no service is live");
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand("/alpha", { foreground: true }, signal, deps);

  assert.deepEqual(calls, [
    "resolve:/alpha",
    "find:/tmp/raft-home",
    "intent:/tmp/raft-home:restart:server-a",
    "start:server-a:/alpha:true:false:cli",
  ]);
});

test("CLI restart agent-hosted path fails loud when IPC handoff is unavailable", async () => {
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    prepareLocalLifecycleOperations: async () => [],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => true,
    runStop: async () => {
      throw new Error("forbidden-stop");
    },
    runStart: async () => {
      throw new Error("forbidden-start");
    },
    prepareTargetsForServiceHandoff: async () => undefined,
    requestServiceRestartViaIpc: async () => {
      throw new Error("socket unavailable");
    },
    fail: (code: string, message: string): never => {
      throw new Error(`${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await assert.rejects(
    runRestartCommand(undefined, {}, signal, deps),
    /RESTART_SERVICE_UNREACHABLE:Cannot restart the live Computer service via IPC \(socket unavailable\)/,
  );
});

// task #924: on Windows the service closes every IPC connection, this one
// included, so its replacement can bind the named pipe. That is the handoff
// in progress, not an unreachable service.
test("CLI restart agent-hosted path reports a closed request connection as in progress", async () => {
  const signal = new AbortController().signal;
  const infos: string[] = [];
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    prepareLocalLifecycleOperations: async () => [],
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    callerIsRunnerHosted: () => true,
    runStop: async () => {
      throw new Error("forbidden-stop");
    },
    runStart: async () => {
      throw new Error("forbidden-start");
    },
    prepareTargetsForServiceHandoff: async () => undefined,
    requestServiceRestartViaIpc: async () => {
      throw new ServiceClientError("IPC_CLIENT_CLOSED", "service client closed before response");
    },
    info: (message: string) => {
      infos.push(message);
    },
    fail: (code: string, message: string): never => {
      throw new Error(`${code}:${message}`);
    },
  } satisfies RestartCommandDeps;

  await runRestartCommand(undefined, {}, signal, deps);
  assert.ok(infos.some((message) => /Service restart in progress/.test(message)), infos.join("\n"));
});

// task #803: `raft-computer restart` records one lifecycle operation per
// server but used to request the IPC restart with no params, so the service
// wrote no pending-restart marker and the operation's ready phase was never
// acknowledged (field: op 2e6f86bd stuck at pendingPhases=[ready], Server
// reported ready_timeout while the machine was healthy).
function agentHostedDeps(onIpc: (params: unknown) => void, prepared: { serverId: string; operationId: string }[]): RestartCommandDeps {
  return {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a", "server-b"],
    prepareLocalLifecycleOperations: async () => prepared,
    findLiveServicePidReadOnly: async () => LIVE_SERVICE,
    prepareTargetsForServiceHandoff: async () => {},
    requestServiceRestartViaIpc: async (_slockHome: string, params?: unknown) => {
      onIpc(params);
      return { status: "accepted" as const };
    },
    runStop: async () => {
      throw new Error("forbidden-stop");
    },
    runStart: async () => {
      throw new Error("forbidden-start");
    },
    callerIsRunnerHosted: () => true,
    info: () => {},
    fail: (code: string, message: string): never => {
      throw new Error(`fail:${code}:${message}`);
    },
  };
}

test("CLI restart binds its prepared lifecycle operations to the IPC restart request", async () => {
  let ipcParams: unknown = "not-called";
  await runRestartCommand(undefined, {}, new AbortController().signal, agentHostedDeps((params) => {
    ipcParams = params;
  }, [
    { serverId: "server-a", operationId: "op-a" },
    { serverId: "server-b", operationId: "op-b" },
  ]));

  assert.deepEqual(ipcParams, {
    requestId: "op-a",
    originServerId: "server-a",
    requestIds: { "server-a": "op-a", "server-b": "op-b" },
  });
});

test("CLI restart with no recorded lifecycle operation still requests the IPC restart without a binding", async () => {
  let ipcParams: unknown = "not-called";
  await runRestartCommand(undefined, {}, new AbortController().signal, agentHostedDeps((params) => {
    ipcParams = params;
  }, []));
  assert.equal(ipcParams, undefined);
});

test("resident re-execution reaches the CLI service entry points", () => {
  const names = program.commands.map((command) => command.name());
  for (const name of ["__service", "__run", "__supervisor"]) {
    assert.ok(names.includes(name), `${name} must remain callable by installed supervisors`);
  }
  const home = mkdtempSync(join(tmpdir(), "computer-entry-"));
  try {
    const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
    const invocation = buildResidentSpawn("__run", "00000000-0000-4000-8000-000000000001", entry, ["--import", "@oxc-node/core/register"], false);
    const env = { ...process.env, RAFT_HOME: home, SLOCK_HOME: home };
    const child = spawnSync(invocation.command, invocation.args, { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, /No attachment for server 00000000-0000-4000-8000-000000000001/);
    assert.doesNotMatch(child.stderr, /unknown command/);
    const versions = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry, "__build-versions"], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(versions.status, 0, versions.stderr);
    assert.equal(typeof JSON.parse(versions.stdout).computerVersion, "string");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test("hidden CLI dispatch executes isolated service, takeover, supervisor and bundle probes", () => {
  const home = mkdtempSync(join(tmpdir(), "computer-hidden-entry-"));
  try {
    const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
    // Drop injected seat authentication and service controls: these probes must
    // not inherit the host's account, server, wrapper or resident identity.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:RAFT_|SLOCK_)/.test(key)));
    Object.assign(env, { HOME: home, USERPROFILE: home, RAFT_HOME: home, SLOCK_HOME: home });
    const run = (args: string[], input?: string) => {
      const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", entry, ...args], { input, env, encoding: "utf8", timeout: 20_000 });
      assert.equal(result.error, undefined, `${args}: ${result.error}`);
      assert.equal(result.signal, null, `${args}: ${result.stderr}`);
      return result;
    };
    // `--os-supervised` is deprecated: outside the retired closed form it is
    // an unknown option, never a way to boot a service.
    const service = run(["__service", "--os-supervised", "launchd-user"]);
    assert.equal(service.status, 1, service.stderr);
    assert.match(service.stderr, /unknown option '--os-supervised'/);
    // Help traverses the hidden nested command parser without retiring an OS
    // service. Removing the supervisor command must fail this subprocess.
    const supervisor = run(["__supervisor", "--help"]);
    assert.equal(supervisor.status, 0, supervisor.stderr);
    assert.match(supervisor.stdout, /Usage:.*__supervisor/);
    const cli = run(["__cli", "--version"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^Raft CLI: \d+\.\d+\.\d+/);
    const oauth = run(["__verify-bundled-oauth"]);
    assert.equal(oauth.status, 0, oauth.stderr);
    assert.equal(oauth.stdout.trim(), "oauth-bundle-ok");
    const kimi = run(["__verify-bundled-kimi"]);
    assert.equal(kimi.status, 0, kimi.stderr);
    assert.equal(kimi.stdout.trim(), "kimi-bundle-ok");
    const oar = run(["__verify-bundled-oar"]);
    assert.equal(oar.status, 0, oar.stderr);
    assert.equal(oar.stdout.trim(), "oar-bundle-ok");
    // The daemon's View Context restore child re-executes this entry: a request
    // on stdin, one header line then the result body on stdout.
    const restore = run(["__restore-context-view"], JSON.stringify({
      runtime: "claude",
      file: join(home, "no-such-session.jsonl"),
      allowedRoots: [home],
      offset: 0,
      messageId: "m-1",
      sessionId: "s-1",
      maxBytes: 1024,
    }));
    assert.equal(restore.status, 0, restore.stderr);
    const [restoreHeader, restoreBody] = restore.stdout.split("\n");
    assert.equal((JSON.parse(restoreHeader!) as { outcome: string }).outcome, "not_found");
    assert.deepEqual(JSON.parse(restoreBody!), { ok: false, reason: "not_found" });
    // task #1268: the hosted daemon's runtime detection child re-executes this
    // entry; it streams one JSON line per runtime and ends with `done`.
    const detect = run(["__detect-runtimes"]);
    assert.equal(detect.status, 0, detect.stderr);
    const lines = detect.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { event: string; runtime?: string; detection?: { ids: string[] } });
    assert.ok(lines.length >= 2, "at least one checked line and the done line");
    assert.ok(lines.slice(0, -1).every((line) => line.event === "checked" && typeof line.runtime === "string"));
    assert.equal(lines[lines.length - 1]!.event, "done");
    assert.ok(Array.isArray(lines[lines.length - 1]!.detection?.ids));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
