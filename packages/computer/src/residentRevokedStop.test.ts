// Reconciler step 15 (B15): when the server refuses this runner's Computer
// key for good (the terminal 401 `computer_revoked` /
// `computer_machine_unlinked`), the runner stops its agents, bounded, before
// it exits 77. A socket close or any other rejection keeps today's reconnect.
//
// RED proof: drop the `stopAfterMachineKeyRevoked` call in runResident's
// onHandshakeRejected (exit 77 right after the marker, as before) and the
// first test sees exit 77 with `stop` never called.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTerminalUnlinked } from "./health";
import type { MachineKeyRevokedStopResult } from "./residentRevokedStop";
import { MACHINE_KEY_REVOKED_STOP_DEADLINE_MS } from "./residentRevokedStop";
import { serverRunnerStopIntentPath } from "./paths";
import { writeResidentStopIntent } from "./residentStopIntent";
import { writeServerAttachment } from "./serverState";
import { EXTERNAL_STOP_EXIT_CODE, runResident, type ResidentCore, type ResidentLifecycleHooks } from "./service";

const SERVER = "11111111-1111-4111-8111-111111111111";
const MACHINE = "mach-1";

interface Harness {
  home: string;
  hooks: ResidentLifecycleHooks;
  order: string[];
  stops: Array<Record<string, unknown> | undefined>;
  traces: MachineKeyRevokedStopResult[];
  exited: Promise<number>;
  exitCodes: number[];
  agents: string[];
  finishStop: () => void;
}

async function withRunner(
  opts: { stopHangs?: boolean; deadlineMs?: number },
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "raft-revoked-stop-"));
  const oldRaft = process.env.RAFT_HOME;
  const oldSlock = process.env.SLOCK_HOME;
  process.env.RAFT_HOME = home;
  process.env.SLOCK_HOME = home;
  const sigterm = process.listeners("SIGTERM");
  const sigint = process.listeners("SIGINT");
  try {
    await writeServerAttachment(home, {
      kind: "computer-attachment",
      serverId: SERVER,
      serverMachineId: MACHINE,
      apiKey: "sk_computer_test",
      serverUrl: "http://127.0.0.1:1",
    });
    const order: string[] = [];
    const stops: Array<Record<string, unknown> | undefined> = [];
    const traces: MachineKeyRevokedStopResult[] = [];
    const exitCodes: number[] = [];
    // Two fake agents, as the daemon's agent hosts would list them.
    const agents = ["agent-a", "agent-b"];
    let finishStop: () => void = () => {};
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    let hooks: ResidentLifecycleHooks | null = null;
    const core: ResidentCore = {
      start: () => {},
      stop: (options) => {
        order.push("stop");
        stops.push(options as Record<string, unknown> | undefined);
        const done = () => {
          agents.length = 0;
          order.push("agents_stopped");
        };
        if (opts.stopHangs) {
          return new Promise<void>((resolve) => { finishStop = () => { done(); resolve(); }; });
        }
        return new Promise<void>((resolve) => setTimeout(() => { done(); resolve(); }, 20));
      },
      getRunningAgentIds: () => [...agents],
      recordMachineKeyRevokedStop: (result) => { traces.push(result); },
    };
    await runResident(SERVER, {
      coreFactory: (_creds, h) => { hooks = h; return core; },
      exit: (code) => { order.push(`exit:${code}`); exitCodes.push(code); resolveExit(code); },
      ...(opts.deadlineMs !== undefined ? { machineKeyRevokedStopDeadlineMs: opts.deadlineMs } : {}),
    });
    assert.ok(hooks, "the runner hands its hooks to the core");
    await fn({ home, hooks, order, stops, traces, exited, exitCodes, agents, finishStop: () => finishStop() });
  } finally {
    for (const l of process.listeners("SIGTERM")) if (!sigterm.includes(l)) process.off("SIGTERM", l);
    for (const l of process.listeners("SIGINT")) if (!sigint.includes(l)) process.off("SIGINT", l);
    if (oldRaft === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaft;
    if (oldSlock === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlock;
    rmSync(home, { recursive: true, force: true });
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("the deadline covers one agent stop (10 s grace + 5 s confirm) with margin", () => {
  assert.ok(MACHINE_KEY_REVOKED_STOP_DEADLINE_MS > 15_000);
  assert.ok(MACHINE_KEY_REVOKED_STOP_DEADLINE_MS <= 30_000);
});

for (const reason of ["computer_revoked", "computer_machine_unlinked"] as const) {
  test(`a terminal 401 ${reason} stops every agent before exit 77`, async () => {
    await withRunner({}, async (h) => {
      h.hooks.onHandshakeRejected({ statusCode: 401, reason });
      // The reconnect loop keeps running until core.stop disconnects it; a
      // second rejection must not start a second stop.
      h.hooks.onHandshakeRejected({ statusCode: 401, reason });
      assert.equal(await h.exited, 77);
      assert.deepEqual(h.order, ["stop", "agents_stopped", "exit:77"]);
      assert.deepEqual(h.stops, [{ source: "machine_key_revoked" }]);
      assert.equal(h.traces.length, 1);
      assert.equal(h.traces[0]!.outcome, "stopped");
      assert.equal(h.traces[0]!.reason, reason);
      assert.equal(h.traces[0]!.agentCount, 2);
      assert.equal(h.traces[0]!.remainingAgentCount, 0);
      const marker = await readTerminalUnlinked(h.home, SERVER, MACHINE);
      assert.equal(marker?.reason, reason, "the service still finds the terminal marker");
      await settle();
      assert.deepEqual(h.exitCodes, [77], "exits once");
    });
  });
}

test("a stop that outlives the deadline still exits 77 at the deadline", async () => {
  await withRunner({ stopHangs: true, deadlineMs: 100 }, async (h) => {
    const startedAt = Date.now();
    h.hooks.onHandshakeRejected({ statusCode: 401, reason: "computer_revoked" });
    assert.equal(await h.exited, 77);
    assert.ok(Date.now() - startedAt >= 90, "waited for the stop up to the deadline");
    assert.deepEqual(h.order, ["stop", "exit:77"]);
    assert.equal(h.traces[0]!.outcome, "deadline");
    assert.equal(h.traces[0]!.agentCount, 2);
    assert.equal(h.traces[0]!.remainingAgentCount, 2);
    assert.equal(h.traces[0]!.deadlineMs, 100);
    h.finishStop();
    await settle();
    assert.deepEqual(h.exitCodes, [77]);
  });
});

test("a signal during the revoked stop does not start a second stop or exit 0", async () => {
  await withRunner({ stopHangs: true, deadlineMs: 5_000 }, async (h) => {
    h.hooks.onHandshakeRejected({ statusCode: 401, reason: "computer_revoked" });
    process.emit("SIGTERM", "SIGTERM");
    await settle();
    assert.deepEqual(h.stops, [{ source: "machine_key_revoked" }]);
    h.finishStop();
    assert.equal(await h.exited, 77);
    assert.deepEqual(h.exitCodes, [77]);
  });
});

test("a socket close (4004/4001, deploy, key rotation) or a non-terminal rejection stops nothing", async () => {
  await withRunner({}, async (h) => {
    // DaemonConnection reports a close (4004 credential_revoked, 4001
    // computer_machine_unlinked, ...) only through onDisconnect.
    h.hooks.onConnect();
    h.hooks.onDisconnect();
    h.hooks.onHandshakeRejected({ statusCode: 401, reason: "invalid_api_key" });
    h.hooks.onHandshakeRejected({ statusCode: 401, reason: null });
    h.hooks.onHandshakeRejected({ statusCode: 403, reason: "computer_revoked" });
    h.hooks.onHandshakeRejected({ statusCode: 503, reason: null });
    await settle();
    assert.deepEqual(h.order, [], "no stop, no exit: the daemon keeps reconnecting");
    assert.equal(h.agents.length, 2, "agents keep running");
    assert.equal(await readTerminalUnlinked(h.home, SERVER, MACHINE), null);
  });
});

// An external SIGTERM (no stop intent from the service) must not exit 0: the
// service reads 0 as graceful and respawns forever (1,718 respawns in 5.5 h on
// a Mac whose runner something else kept killing). Intent-backed stops stay 0.
test("a SIGTERM the service did not send exits EXTERNAL_STOP_EXIT_CODE", async () => {
  await withRunner({}, async (h) => {
    process.emit("SIGTERM", "SIGTERM");
    assert.equal(await h.exited, EXTERNAL_STOP_EXIT_CODE);
    assert.deepEqual(h.stops, [{ source: "external_signal", signal: "SIGTERM" }]);
    assert.deepEqual(h.exitCodes, [EXTERNAL_STOP_EXIT_CODE]);
  });
});

test("a SIGTERM backed by the service's stop intent still exits 0", async () => {
  await withRunner({}, async (h) => {
    writeResidentStopIntent(serverRunnerStopIntentPath(h.home, SERVER), { pid: process.pid, source: "service_unmanaged" });
    process.emit("SIGTERM", "SIGTERM");
    assert.equal(await h.exited, 0);
    assert.deepEqual(h.stops, [{ source: "service_unmanaged", signal: "SIGTERM" }]);
  });
});

test("an intent-less SIGINT (terminal Ctrl-C) still exits 0", async () => {
  await withRunner({}, async (h) => {
    process.emit("SIGINT", "SIGINT");
    assert.equal(await h.exited, 0);
    assert.deepEqual(h.stops, [{ source: "external_signal", signal: "SIGINT" }]);
  });
});
