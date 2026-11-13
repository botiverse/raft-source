import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  INTENTIONAL_STOP_EXIT_CODES,
  RELAUNCH_EXIT_CODES,
  SUPERVISED_RELAUNCH_EXIT_CODE,
  UPGRADE_SAFE_KILL_MODES,
  clearSupervisorRecord,
  describeKillModeRequirement,
  describeOomPolicyRequirement,
  detectSystemdSupervisor,
  externalSupervisorOptIn,
  inspectSupervisor,
  parseSystemdUnitFromCgroup,
  readSupervisorOomPolicy,
  readSupervisorRecord,
  writeSupervisorRecord,
  type SystemctlRunner,
} from "./externalSupervisor";

const V2_USER = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/raft-computer.service\n";
const V2_SYSTEM = "0::/system.slice/raft-computer-ci.service\n";
const V1 = [
  "12:pids:/user.slice/user-1000.slice/session-3.scope",
  "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/raft-computer.service",
  "0::/user.slice/user-1000.slice/user@1000.service/raft-computer.service",
].join("\n");

test("task #917: the owning unit and scope are read from the cgroup, v2 and v1", () => {
  assert.deepEqual(parseSystemdUnitFromCgroup(V2_USER), { unit: "raft-computer.service", scope: "user" });
  assert.deepEqual(parseSystemdUnitFromCgroup(V2_SYSTEM), { unit: "raft-computer-ci.service", scope: "system" });
  assert.deepEqual(parseSystemdUnitFromCgroup(V1), { unit: "raft-computer.service", scope: "user" });
  // A login session scope, a bare slice, or the per-user manager itself is not a service unit of ours.
  assert.equal(parseSystemdUnitFromCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), null);
  assert.equal(parseSystemdUnitFromCgroup("0::/user.slice/user-1000.slice/user@1000.service\n"), null);
  assert.equal(parseSystemdUnitFromCgroup("0::/\n"), null);
  assert.equal(parseSystemdUnitFromCgroup(""), null);
});

function fakeSystemctl(answers: Record<string, string | { code: number; stdout?: string } | null>): { runner: SystemctlRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: SystemctlRunner = async (scope, args) => {
    const key = `${scope}:${args.join(" ")}`;
    calls.push(key);
    const answer = answers[key];
    if (answer === undefined) return { code: 1, stdout: "", stderr: `unexpected ${key}` };
    if (answer === null) return { code: null, stdout: "", stderr: "Failed to connect to bus" };
    if (typeof answer === "string") return { code: 0, stdout: `${answer}\n`, stderr: "" };
    return { code: answer.code, stdout: `${answer.stdout ?? ""}\n`, stderr: "" };
  };
  return { runner, calls };
}

test("task #917: detection needs Linux, INVOCATION_ID, a service cgroup and MainPID == us", async () => {
  const base = {
    platform: "linux" as const,
    env: { INVOCATION_ID: "abc" },
    pid: 4242,
    readCgroup: async () => V2_USER,
    now: () => new Date("2026-10-12T06:40:00Z"),
  };
  const match = fakeSystemctl({ "user:show -P MainPID raft-computer.service": "4242" });
  assert.deepEqual(await detectSystemdSupervisor({ ...base, systemctl: match.runner }), {
    kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "abc", pid: 4242, recordedAt: "2026-10-12T06:40:00.000Z",
  });
  // Not us as the main process (a helper or a terminal under the unit).
  const other = fakeSystemctl({ "user:show -P MainPID raft-computer.service": "99" });
  assert.equal(await detectSystemdSupervisor({ ...base, systemctl: other.runner }), null);
  // No INVOCATION_ID: a terminal `start --foreground` keeps today's behaviour, and systemctl is never consulted.
  const untouched = fakeSystemctl({});
  assert.equal(await detectSystemdSupervisor({ ...base, env: {}, systemctl: untouched.runner }), null);
  assert.deepEqual(untouched.calls, []);
  assert.equal(await detectSystemdSupervisor({ ...base, platform: "darwin", systemctl: match.runner }), null);
  assert.equal(await detectSystemdSupervisor({ ...base, readCgroup: async () => { throw new Error("no procfs"); }, systemctl: match.runner }), null);
});

test("task #917: the generic opt-in is explicit", () => {
  assert.equal(externalSupervisorOptIn({}), false);
  assert.equal(externalSupervisorOptIn({ RAFT_COMPUTER_EXTERNAL_SUPERVISOR: "1" }), true);
  assert.equal(externalSupervisorOptIn({ RAFT_COMPUTER_EXTERNAL_SUPERVISOR: "true" }), true);
  assert.equal(externalSupervisorOptIn({ RAFT_COMPUTER_EXTERNAL_SUPERVISOR: "0" }), false);
});

test("task #917: the record round-trips and malformed records read as absent", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-supervisor-record-"));
  try {
    assert.equal(await readSupervisorRecord(home), null);
    const record = { kind: "systemd" as const, scope: "system" as const, unit: "raft-computer-ci.service", invocationId: "x", pid: 7, recordedAt: "t" };
    await writeSupervisorRecord(home, record);
    assert.deepEqual(await readSupervisorRecord(home), record);
    const file = path.join(home, "computer", "run", "supervisor.json");
    assert.equal(JSON.parse(await readFile(file, "utf8")).unit, "raft-computer-ci.service");
    await clearSupervisorRecord(home);
    assert.equal(await readSupervisorRecord(home), null);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task #917: inspection reports loaded/enabled/active/MainPID/KillMode, a missing unit, and an unreachable manager", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-supervisor-inspect-"));
  try {
    assert.equal(await inspectSupervisor(home, { systemctl: fakeSystemctl({}).runner }), null, "no record ⇒ nothing to inspect");
    await writeSupervisorRecord(home, { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 7, recordedAt: "t" });
    const live = fakeSystemctl({
      "user:show -P LoadState raft-computer.service": "loaded",
      "user:is-enabled raft-computer.service": "enabled",
      "user:show -P ActiveState raft-computer.service": "active",
      "user:show -P MainPID raft-computer.service": "7",
      "user:show -P KillMode raft-computer.service": "process",
    });
    assert.deepEqual(await inspectSupervisor(home, { systemctl: live.runner }), {
      record: { kind: "systemd", scope: "user", unit: "raft-computer.service", invocationId: "x", pid: 7, recordedAt: "t" },
      unitLoaded: true, enabledState: "enabled", activeState: "active", mainPid: 7, killMode: "process", reachable: true,
    });
    // Unit file removed: the record is stale and nothing else is asked.
    const gone = fakeSystemctl({ "user:show -P LoadState raft-computer.service": "not-found" });
    const stale = await inspectSupervisor(home, { systemctl: gone.runner });
    assert.equal(stale?.unitLoaded, false);
    assert.equal(stale?.reachable, true);
    assert.equal(gone.calls.length, 1);
    // No session bus (ssh without a login session): reachable=false, never a guess.
    const bus = fakeSystemctl({ "user:show -P LoadState raft-computer.service": null });
    const unreachable = await inspectSupervisor(home, { systemctl: bus.runner });
    assert.equal(unreachable?.reachable, false);
    assert.equal(unreachable?.unitLoaded, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task #917: the KillMode requirement names the unit and the exact line to change", () => {
  assert.deepEqual([...UPGRADE_SAFE_KILL_MODES], ["process", "mixed"]);
  const text = describeKillModeRequirement("raft-computer.service", "control-group");
  assert.match(text, /raft-computer\.service with KillMode=control-group/);
  assert.match(text, /KillMode=process/);
  assert.match(text, /daemon-reload/);
});

test("OOMPolicy of a user's own unit is read from systemd, and the fix fits a unit file or a systemd-run unit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "raft-supervisor-oom-"));
  try {
    assert.equal(await readSupervisorOomPolicy(home, { systemctl: fakeSystemctl({}).runner }), null, "no record ⇒ not under systemd");
    const record = { kind: "systemd" as const, scope: "user" as const, unit: "raft-computer.service", invocationId: "x", pid: 7, recordedAt: "t" };
    await writeSupervisorRecord(home, record);
    const file = fakeSystemctl({
      "user:show -P LoadState raft-computer.service": "loaded",
      "user:show -P OOMPolicy raft-computer.service": "stop",
      "user:show -P Transient raft-computer.service": "no",
    });
    const fromFile = await readSupervisorOomPolicy(home, { systemctl: file.runner });
    assert.deepEqual(fromFile, { record, oomPolicy: "stop", transient: false });
    const fileFix = describeOomPolicyRequirement(fromFile!);
    assert.match(fileFix, /raft-computer\.service has OOMPolicy=stop/);
    assert.match(fileFix, /`systemctl --user edit raft-computer\.service`, add the two lines `\[Service\]` and `OOMPolicy=continue`/);

    const transient = fakeSystemctl({
      "user:show -P LoadState raft-computer.service": "loaded",
      "user:show -P OOMPolicy raft-computer.service": "stop",
      "user:show -P Transient raft-computer.service": "yes",
    });
    const fromRun = await readSupervisorOomPolicy(home, { systemctl: transient.runner });
    assert.equal(fromRun?.transient, true);
    const runFix = describeOomPolicyRequirement(fromRun!);
    assert.match(runFix, /systemctl --user reset-failed raft-computer\.service/);
    assert.match(runFix, /-p OOMPolicy=continue/);
    assert.doesNotMatch(runFix, /systemctl --user edit/);

    // A unit that is gone, or a manager without a session bus: no answer, never a guess.
    assert.equal(await readSupervisorOomPolicy(home, { systemctl: fakeSystemctl({ "user:show -P LoadState raft-computer.service": "not-found" }).runner }), null);
    assert.equal(await readSupervisorOomPolicy(home, { systemctl: fakeSystemctl({ "user:show -P LoadState raft-computer.service": null }).runner }), null);
    // A system unit is edited with sudo and no --user.
    assert.match(
      describeOomPolicyRequirement({ record: { ...record, scope: "system" }, oomPolicy: "kill", transient: false }),
      /OOMPolicy=kill: .*`sudo systemctl edit raft-computer\.service`/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("task #917: exit codes form two closed classes and the relaunch code is not a stop code", () => {
  assert.deepEqual([...INTENTIONAL_STOP_EXIT_CODES], [77, 78]);
  assert.deepEqual([...RELAUNCH_EXIT_CODES], [SUPERVISED_RELAUNCH_EXIT_CODE, 1]);
  assert.equal(SUPERVISED_RELAUNCH_EXIT_CODE, 75);
  for (const code of INTENTIONAL_STOP_EXIT_CODES) assert.ok(!RELAUNCH_EXIT_CODES.includes(code));
});
