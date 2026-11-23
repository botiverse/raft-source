import assert from "node:assert/strict";

import type { Runtime, UpgradeResult } from "@botiverse/oar";
import type { RuntimeAuthRuntime, RuntimeUpgradeResult } from "@botiverse/raft-shared";

import { RuntimeAuthHost } from "./runtimeAuth/runtimeAuthHost";
import { RuntimeUpgradeHost, upgradeResultForServer } from "./runtimeUpgrade";

const SECRET_OUTPUT = "installing to /home/someone/.local/bin with token=abc123";

function host(runtime: Partial<Runtime> | (() => Promise<Runtime>)) {
  const sent: Array<{ requestId: string; result: RuntimeUpgradeResult }> = [];
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  let rescans = 0;
  const upgradeHost = new RuntimeUpgradeHost({
    loadRuntime: typeof runtime === "function" ? runtime : async () => runtime as Runtime,
    send: (message) => sent.push({ requestId: message.requestId, result: message.result }),
    rescan: () => { rescans += 1; },
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => 1_000,
  });
  return { upgradeHost, sent, events, rescans: () => rescans };
}

const available = async () => ({ kind: "available" as const, via: "executable" as const, command: "/usr/bin/claude", version: "2.0.1" });

test("an upgrade answers its versions only, rescans, and traces the output's length, never the output", async () => {
  const t = host({ installation: available, upgrade: async () => ({ kind: "upgraded", from: "2.0.1", to: "2.0.5", output: SECRET_OUTPUT }) });
  await t.upgradeHost.upgrade("req-1", "claude");
  assert.deepEqual(t.sent, [{ requestId: "req-1", result: { kind: "upgraded", from: "2.0.1", to: "2.0.5" } }]);
  assert.equal(t.rescans(), 1);
  assert.equal(t.events[0]!.name, "daemon.runtime.upgrade");
  assert.equal(t.events[0]!.attrs.output_length, SECRET_OUTPUT.length);
  assert.ok(!JSON.stringify([t.sent, t.events]).includes("token=abc123"));
  assert.ok(!JSON.stringify([t.sent, t.events]).includes("/home/someone"));
});

test("current and unchanged rescan (a CLI that updated itself shows its new version); failed and unsupported carry no output or detail", async () => {
  const cases: Array<[UpgradeResult, RuntimeUpgradeResult, number]> = [
    [{ kind: "current", version: "2.0.5", check: { kind: "ok", installed: "2.0.5", latest: "2.0.5", updateAvailable: false, source: "/usr/bin/claude" } }, { kind: "current", version: "2.0.5" }, 1],
    [{ kind: "unchanged", version: "2.0.5", output: SECRET_OUTPUT }, { kind: "unchanged", version: "2.0.5" }, 1],
    [{ kind: "failed", exitCode: 1, output: SECRET_OUTPUT }, { kind: "failed", exitCode: 1 }, 0],
    [{ kind: "unsupported", reason: "requires_terminal", detail: "/opt/homebrew/bin/claude" }, { kind: "unsupported", reason: "requires_terminal" }, 0],
  ];
  for (const [outcome, expected, rescans] of cases) {
    const t = host({ installation: available, upgrade: async () => outcome });
    await t.upgradeHost.upgrade("req", "claude");
    assert.deepEqual(t.sent[0]!.result, expected);
    assert.equal(t.rescans(), rescans, outcome.kind);
  }
});

test("a runtime without an updater, a missing CLI, Kimi Code and a throw each answer without running anything", async () => {
  const noUpgrade = host({ installation: available });
  await noUpgrade.upgradeHost.upgrade("a", "qoder");
  assert.deepEqual(noUpgrade.sent[0]!.result, { kind: "unsupported", reason: "unsupported_installation" });

  const missing = host({ installation: async () => ({ kind: "not_found" as const }), upgrade: async () => assert.fail("must not run") });
  await missing.upgradeHost.upgrade("b", "codex");
  assert.deepEqual(missing.sent[0]!.result, { kind: "not_installed" });

  const kimi = host(async () => assert.fail("Kimi Code is the bundled SDK: nothing to load"));
  await kimi.upgradeHost.upgrade("c", "kimi");
  assert.deepEqual(kimi.sent[0]!.result, { kind: "unsupported", reason: "unsupported_installation" });

  const threw = host(async () => { throw new Error("load failed at /secret/path"); });
  await threw.upgradeHost.upgrade("d", "claude");
  assert.deepEqual(threw.sent[0]!.result, { kind: "error", code: "internal" });
  assert.equal(threw.rescans(), 0);
});

test("a CLI OAR finds too old is upgraded as it is (the web's update notice, #oar-raft:#21); another unusable install is not", async () => {
  const tooOld = { kind: "unsupported" as const, code: "version_unsupported" as const, via: "executable" as const, command: "/usr/local/bin/agy", reason: "needs agy 1.5.0", installedVersion: "1.4.9", requiredVersion: "1.5.0" };
  const given: unknown[] = [];
  const old = host({
    installation: async () => tooOld,
    upgrade: async (installation) => { given.push(installation); return { kind: "upgraded", from: "1.4.9", to: "1.5.9", output: SECRET_OUTPUT }; },
  });
  await old.upgradeHost.upgrade("old", "antigravity");
  assert.deepEqual(given, [tooOld], "OAR's updater gets the too-old installation itself");
  assert.deepEqual(old.sent[0]!.result, { kind: "upgraded", from: "1.4.9", to: "1.5.9" });
  assert.equal(old.rescans(), 1);

  const other = host({ installation: async () => ({ kind: "unsupported" as const, reason: "unrecognized build" }), upgrade: async () => assert.fail("must not run") });
  await other.upgradeHost.upgrade("other", "antigravity");
  assert.deepEqual(other.sent[0]!.result, { kind: "unsupported", reason: "unsupported_installation" });
});

test("one upgrade per runtime at a time: a second request while one runs answers in_progress", async () => {
  let finish!: (result: UpgradeResult) => void;
  const t = host({ installation: available, upgrade: () => new Promise<UpgradeResult>((resolve) => { finish = resolve; }) });
  const first = t.upgradeHost.upgrade("first", "claude");
  await new Promise((resolve) => setImmediate(resolve));
  await t.upgradeHost.upgrade("second", "claude");
  assert.deepEqual(t.sent, [{ requestId: "second", result: { kind: "error", code: "in_progress" } }]);
  finish({ kind: "current", version: "2.0.5", check: { kind: "unavailable", reason: "lookup_failed" } });
  await first;
  assert.deepEqual(t.sent[1], { requestId: "first", result: { kind: "current", version: "2.0.5" } });

  const runtime: RuntimeAuthRuntime = "claude";
  const third = t.upgradeHost.upgrade("third", runtime);
  await new Promise((resolve) => setImmediate(resolve));
  finish({ kind: "failed", exitCode: 2, output: SECRET_OUTPUT });
  await third;
  assert.deepEqual(t.sent[2], { requestId: "third", result: { kind: "failed", exitCode: 2 } }, "the runtime is free again once the first ended");
});

test("a version that is not a plain release version is left out", () => {
  assert.deepEqual(upgradeResultForServer({ kind: "upgraded", from: "/usr/local/bin/x 1.0", to: "1.0.1", output: "" }), { kind: "upgraded", to: "1.0.1" });
});

test("the per-runtime guard is released after a throw: the next request runs", async () => {
  let calls = 0;
  const t = host(async () => {
    calls += 1;
    if (calls === 1) throw new Error("load failed");
    return { installation: available, upgrade: async () => ({ kind: "upgraded", from: "2.0.1", to: "2.0.5", output: "" }) } as unknown as Runtime;
  });
  await t.upgradeHost.upgrade("first", "claude");
  await t.upgradeHost.upgrade("second", "claude");
  assert.deepEqual(t.sent.map((message) => message.result.kind), ["error", "upgraded"]);
});

function authHost(serverReadsUpgradable: boolean) {
  const loads: string[] = [];
  const runtimes: Record<string, Partial<Runtime>> = {
    claude: { installation: available, authStatus: async () => ({ kind: "logged_out", source: "x" }), upgrade: async () => assert.fail("never run by a report") },
    codex: { installation: available, authStatus: async () => ({ kind: "logged_out", source: "x" }) },
    grok: { installation: available, authStatus: async () => ({ kind: "logged_out", source: "x" }), upgrade: async () => assert.fail("never run by a report") },
  };
  const authHostInstance = new RuntimeAuthHost({
    loadRuntime: async (id) => { loads.push(id); return (runtimes[id] ?? {}) as Runtime; },
    loadProviderAuth: async () => null,
    kimiStatus: async () => ({ kind: "logged_out" }),
    loadKimiAuth: async () => assert.fail("no Kimi sign-in here"),
    send: () => {},
    recordEvent: () => {},
    now: () => 1_000,
    serverReads: () => ["claude", "codex", "kimi", "grok"],
    serverReadsUpgradable: () => serverReadsUpgradable,
    platform: "linux",
  });
  return { authHostInstance, loads };
}

test("a status report names the installed runtimes whose updater runs from the web, only for a server that reads it", async () => {
  const reading = authHost(true);
  const report = await reading.authHostInstance.collectStatus(["claude", "codex", "kimi", "grok"], ["claude", "codex", "kimi-sdk"]);
  assert.deepEqual(report.upgradable, ["claude"], "codex has no updater, Kimi Code is the bundled SDK, grok is not installed");
  assert.ok(!reading.loads.includes("kimi"), "Kimi Code is never loaded as a CLI");

  const older = authHost(false);
  const plain = await older.authHostInstance.collectStatus(["claude", "codex"], ["claude", "codex"]);
  assert.equal("upgradable" in plain, false, "an older server's strict schema would refuse the field");
});
