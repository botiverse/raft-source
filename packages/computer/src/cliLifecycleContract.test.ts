import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import { program, runRestartCommand, type RestartCommandDeps } from "./cli.js";

test("CLI lifecycle contract: ordinary command surface excludes destructive and reversal-only verbs", () => {
  const commands = program.commands.map((cmd) => cmd.name());
  assert.ok(!commands.includes("detach"), "ordinary CLI must not expose detach");
  assert.ok(!commands.includes("revoke"), "ordinary CLI must not expose destructive revoke");
  assert.ok(!commands.includes("delete"), "ordinary CLI must not expose destructive delete");
  assert.ok(!commands.includes("switch"), "ordinary CLI must not expose regret-state switch");
});

test("CLI lifecycle contract: verb table documents the four-axis invariant", async () => {
  const src = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
  assert.match(src, /Lifecycle contract \(task #151 P0\)/);
  assert.match(src, /Axis 1: process actual state/);
  assert.match(src, /Axis 2: local desired policy/);
  assert.match(src, /Axis 3: local credential proof/);
  assert.match(src, /Axis 4: server identity/);
  assert.match(src, /Names are\s+\*\s+display labels only, never identity proof/s);
  assert.match(src, /old user-facing `detach`\s+\*\s+command and implementation are intentionally absent/s);
});

test("CLI lifecycle contract: detach implementation is absent from ordinary package surface", async () => {
  const [serviceSrc, apiSrc, eventSrc, indexSrc] = await Promise.all([
    readFile(new URL("./service.ts", import.meta.url), "utf8"),
    readFile(new URL("./lib/api.ts", import.meta.url), "utf8"),
    readFile(new URL("./lib/events.ts", import.meta.url), "utf8"),
    readFile(new URL("./cli.ts", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(serviceSrc, /\brunDetach\b/);
  assert.doesNotMatch(apiSrc, /services\/detach/);
  assert.doesNotMatch(apiSrc, /\bdetach\s*\(/);
  assert.doesNotMatch(eventSrc, /"detach\./);
  assert.doesNotMatch(indexSrc, /\.command\("detach"\)/);
});

test("CLI restart records one restart operation and does not kill a live service from the caller", async () => {
  const src = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
  const restartStart = src.indexOf('.command("restart")');
  const restartEnd = src.indexOf("// --- status", restartStart);
  const restartBlock = src.slice(restartStart, restartEnd);

  assert.match(src, /recordRestartIntent\(plan, runtime\)/);
  assert.match(src, /prepareLifecycle\(plan\.slockHome, "restart", plan\.targets\)/);
  assert.match(restartBlock, /runRestartCommand\(serverSlug, opts, signal\)/);
  assert.doesNotMatch(restartBlock, /\brunStop\(/);
});

test("CLI restart live-service path requests IPC handoff and never starts from the caller", async () => {
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
      return {
        pid: 4242,
        pidfilePath: "/tmp/raft-home/computer/run/service.pid",
        firstStalePidfile: null,
        firstStalePid: null,
      };
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
    runStart: async () => {
      calls.push("forbidden-start");
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
    "list:/tmp/raft-home",
    "intent:/tmp/raft-home:restart:server-a,server-b",
    "find:/tmp/raft-home",
    "prepare:/tmp/raft-home:server-a,server-b",
    "ipc:/tmp/raft-home",
    "info:Service restart requested (pid 4242); replacement service will take over without relying on this shell.",
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
      return {
        pid: null,
        pidfilePath: "/tmp/raft-home/computer/run/service.pid",
        firstStalePidfile: null,
        firstStalePid: null,
      };
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
    "intent:/tmp/raft-home:restart:server-a",
    "find:/tmp/raft-home",
    "start:server-a:/alpha:true:false:cli",
  ]);
});

test("CLI restart live-service path fails loud when IPC handoff is unavailable", async () => {
  const signal = new AbortController().signal;
  const deps = {
    resolveRaftHome: () => "/tmp/raft-home",
    listAttachedServerIds: async () => ["server-a"],
    prepareLocalLifecycleOperations: async () => [],
    findLiveServicePidReadOnly: async () => ({
      pid: 4242,
      pidfilePath: "/tmp/raft-home/computer/run/service.pid",
      firstStalePidfile: null,
      firstStalePid: null,
    }),
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
