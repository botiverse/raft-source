import assert from "node:assert/strict";
import type { ExternalSupervisorRecord, SupervisorScope, SystemctlResult } from "./externalSupervisor";
import { probeUpgradeScope, upgradeScopeForReady, upgradeScopeFromProbe } from "./upgradeScope";

const DENIED = "Failed to start transient scope unit: Access denied as the requested operation requires interactive authentication.";
const SERVICE_PID = 4242;
const record = (scope: SupervisorScope = "system", pid = SERVICE_PID): ExternalSupervisorRecord => ({
  kind: "systemd", scope, unit: "raft-computer.service", invocationId: "inv-1", pid, recordedAt: "2026-11-17T00:00:00.000Z",
});

/** Probe deps for a non-root runner whose service runs in `record`; `probed` lists each probe's scope. */
function deps(result: SystemctlResult | Error, overrides: Partial<Parameters<typeof probeUpgradeScope>[1]> = {}) {
  const probed: SupervisorScope[] = [];
  return {
    probed,
    deps: {
      platform: "linux" as const,
      uid: 1000,
      parentPid: SERVICE_PID,
      readSupervisorRecord: async () => record(),
      probe: async (scope: SupervisorScope) => {
        probed.push(scope);
        if (result instanceof Error) throw result;
        return result;
      },
      ...overrides,
    },
  };
}

test("a refusal (non-zero exit) is not-allowed, with systemd-run's first line as the reason", async () => {
  const { deps: d, probed } = deps({ code: 1, stdout: "", stderr: `${DENIED}\nsecond line\n` });
  assert.deepEqual(await probeUpgradeScope("/home", d), { ok: false, reason: DENIED });
  assert.deepEqual(probed, ["system"], "the unit's own manager is asked");
});

test("allowed (exit 0) reports nothing", async () => {
  const { deps: d, probed } = deps({ code: 0, stdout: "", stderr: "" });
  assert.equal(await probeUpgradeScope("/home", d), null);
  assert.deepEqual(probed, ["system"]);
});

test("a probe that did not run is unknown, never not-allowed", async () => {
  // runBounded: a spawn error (systemd-run missing) and a kill on the bound both end without an exit code.
  assert.equal(await probeUpgradeScope("/home", deps({ code: null, stdout: "", stderr: "spawn systemd-run ENOENT" }).deps), null);
  assert.equal(await probeUpgradeScope("/home", deps({ code: null, stdout: "", stderr: "systemd-run did not finish within 15 s\n" }).deps), null);
  assert.equal(await probeUpgradeScope("/home", deps(new Error("boom")).deps), null);
});

test("not probed: root, not Linux, no supervisor record, or a record that is not this runner's own service", async () => {
  for (const overrides of [
    { uid: 0 },
    { uid: undefined },
    { platform: "darwin" as const },
    { readSupervisorRecord: async () => null },
    { readSupervisorRecord: async () => { throw new Error("unreadable"); } },
    { readSupervisorRecord: async () => record("system", SERVICE_PID + 1) },
  ]) {
    const { deps: d, probed } = deps({ code: 1, stdout: "", stderr: DENIED }, overrides);
    assert.equal(await probeUpgradeScope("/home", d), null, JSON.stringify(overrides));
    assert.deepEqual(probed, [], JSON.stringify(overrides));
  }
});

test("a user unit is probed with --user's manager", async () => {
  const { deps: d, probed } = deps({ code: 1, stdout: "", stderr: "Failed to connect to bus: No medium found" }, { readSupervisorRecord: async () => record("user") });
  assert.deepEqual(await probeUpgradeScope("/home", d), { ok: false, reason: "Failed to connect to bus: No medium found" });
  assert.deepEqual(probed, ["user"]);
});

test("the reason is one bounded line; a silent refusal still says something", () => {
  const long = upgradeScopeFromProbe({ code: 1, stdout: "", stderr: `x\u0007${"y".repeat(500)}` });
  assert.equal(long?.ok, false);
  assert.ok(long!.reason.length <= 200);
  assert.ok(!long!.reason.includes("\u0007"));
  assert.deepEqual(upgradeScopeFromProbe({ code: 4, stdout: "", stderr: "" }), { ok: false, reason: "systemd-run exited with 4" });
});

test("a ready waits for the probe only briefly: a slow probe is unknown for that ready, a quick one is carried", async () => {
  const refused = { ok: false as const, reason: "Access denied" };
  assert.equal(await upgradeScopeForReady(new Promise(() => {}), 10), null);
  assert.deepEqual(await upgradeScopeForReady(Promise.resolve(refused), 10), refused);
  assert.equal(await upgradeScopeForReady(Promise.reject(new Error("boom")), 10), null);
});
