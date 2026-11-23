import assert from "node:assert/strict";

import type { InstallationSnapshot, Runtime, UpdateCheck, UpgradeResult } from "@botiverse/oar";
import type { RuntimeAuthRuntime, RuntimeAuthStatusReport } from "@botiverse/raft-shared";

import { RuntimeAuthHost } from "./runtimeAuth/runtimeAuthHost";
import {
  RUNTIME_UPDATE_CHECK_CACHE_MS,
  RUNTIME_UPDATE_CHECK_FAILURE_CACHE_MS,
  RuntimeUpdateChecks,
  updateCheckForServer,
} from "./runtimeUpdateCheck";
import { RuntimeUpgradeHost } from "./runtimeUpgrade";

const AT = Date.parse("2026-11-18T10:00:00.000Z");
const AT_ISO = "2026-11-18T10:00:00.000Z";

function installed(version: string, command = "/usr/local/bin/agy"): () => Promise<InstallationSnapshot> {
  return async () => ({ kind: "available", via: "executable", command, version });
}

function clock(start = AT) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

test("OAR's answer leaves without its source, channel or detail; an odd version or reason is never passed on", () => {
  assert.deepEqual(
    updateCheckForServer({ kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, channel: "stable", source: "https://example.com/agy/latest" }, AT),
    { kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, checkedAt: AT_ISO },
  );
  assert.deepEqual(
    updateCheckForServer({ kind: "unavailable", reason: "package_manager", detail: "brew at /opt/homebrew/bin/agy", source: "/opt/homebrew/bin/agy" }, AT),
    { kind: "unavailable", reason: "package_manager", checkedAt: AT_ISO },
  );
  assert.deepEqual(
    updateCheckForServer({ kind: "ok", installed: "/home/someone/agy 1.5.10", latest: "1.5.11", updateAvailable: true, source: "x" }, AT),
    { kind: "unavailable", reason: "version_unreadable", checkedAt: AT_ISO },
  );
  assert.deepEqual(
    updateCheckForServer({ kind: "unavailable", reason: "some_future_reason" } as unknown as UpdateCheck, AT),
    { kind: "unavailable", reason: "lookup_failed", checkedAt: AT_ISO },
  );
});

/** Lets background checks and the reports they ask for run. */
async function settle(rounds = 20): Promise<void> {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

function checker(options: { timeoutMs?: number } = {}) {
  const time = clock();
  let settled = 0;
  const checks = new RuntimeUpdateChecks({ now: time.now, onSettled: () => { settled += 1; }, ...options });
  return { checks, time, settled: () => settled };
}

const AGY = { kind: "available" as const, via: "executable" as const, command: "/usr/local/bin/agy", version: "1.5.10" };

test("an answer is kept a day for the same installation; a new version, a forget or a day later checks again", async () => {
  const { checks, time, settled } = checker();
  let calls = 0;
  const runtime: Pick<Runtime, "installation" | "checkUpdate"> = {
    installation: async () => AGY,
    checkUpdate: async (installation) => {
      calls += 1;
      const current = installation.kind === "available" && installation.via === "executable" ? installation.version! : "?";
      return { kind: "ok", installed: current, latest: "1.5.11", updateAvailable: current !== "1.5.11", source: "x" };
    },
  };
  assert.equal(checks.keptFor("antigravity", AGY), null, "nothing kept yet");
  assert.equal(checks.start("antigravity", runtime, AGY), true);
  assert.equal(checks.start("antigravity", runtime, AGY), false, "one check per runtime at a time");
  await settle();
  assert.equal(settled(), 1, "one report asked for once it settled");
  assert.deepEqual(checks.keptFor("antigravity", AGY), { kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, checkedAt: AT_ISO });
  time.advance(60_000);
  assert.equal(checks.start("antigravity", runtime, AGY), false, "kept: nothing to start");
  assert.equal(calls, 1);

  const upgraded = { ...AGY, version: "1.5.11" };
  assert.equal(checks.keptFor("antigravity", upgraded), null, "another installation");
  assert.equal(checks.start("antigravity", runtime, upgraded), true);
  await settle();
  assert.equal(checks.keptFor("antigravity", upgraded)?.kind, "ok");
  assert.equal(calls, 2);

  checks.forget("antigravity");
  assert.equal(checks.keptFor("antigravity", upgraded), null, "forgotten");
  checks.start("antigravity", runtime, upgraded);
  await settle();
  time.advance(RUNTIME_UPDATE_CHECK_CACHE_MS - 1);
  assert.notEqual(checks.keptFor("antigravity", upgraded), null);
  time.advance(1);
  assert.equal(checks.keptFor("antigravity", upgraded), null, "a day later: stale");
  assert.equal(calls, 3);
});

test("a check forgotten while it runs is not kept; forgetting another runtime leaves it alone", async () => {
  const { checks, settled } = checker();
  const CLAUDE = { kind: "available" as const, via: "executable" as const, command: "/usr/bin/claude", version: "2.0.1" };
  const finish: Partial<Record<RuntimeAuthRuntime, (check: UpdateCheck) => void>> = {};
  const pending = (id: RuntimeAuthRuntime): Pick<Runtime, "installation" | "checkUpdate"> => ({
    installation: async () => AGY,
    checkUpdate: () => new Promise((resolve) => { finish[id] = resolve; }),
  });
  checks.start("antigravity", pending("antigravity"), AGY);
  checks.start("claude", pending("claude"), CLAUDE);
  await settle(2);
  checks.forget("claude");
  finish.antigravity!({ kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, source: "x" });
  finish.claude!({ kind: "ok", installed: "2.0.1", latest: "2.0.1", updateAvailable: false, source: "x" });
  await settle();
  assert.equal(checks.keptFor("antigravity", AGY)?.kind, "ok", "another runtime's forget does not touch it");
  assert.equal(checks.keptFor("claude", CLAUDE), null, "forgotten while it ran");
  assert.equal(settled(), 1);

  checks.start("antigravity", pending("antigravity"), { ...AGY, version: "1.5.11" });
  await settle(2);
  checks.forget();
  finish.antigravity!({ kind: "ok", installed: "1.5.11", latest: "1.5.11", updateAvailable: false, source: "x" });
  await settle();
  assert.equal(checks.keptFor("antigravity", { ...AGY, version: "1.5.11" }), null, "forgetting all forgets it");
  assert.equal(settled(), 2, "the next report starts it again");
});

test("an Upgrade's current check is kept for its installation, so it is not asked again", async () => {
  const { checks } = checker();
  checks.seed("antigravity", AGY, { kind: "ok", installed: "1.5.10", latest: "1.5.10", updateAvailable: false, source: "https://example.com/agy" });
  assert.deepEqual(checks.keptFor("antigravity", AGY), { kind: "ok", installed: "1.5.10", latest: "1.5.10", updateAvailable: false, checkedAt: AT_ISO });
  assert.equal(checks.start("antigravity", { installation: async () => AGY, checkUpdate: async () => assert.fail("not asked again") }, AGY), false);
  checks.seed("claude", { kind: "available", via: "bundled" }, { kind: "ok", installed: "1", latest: "1", updateAvailable: false, source: "x" });
  assert.equal(checks.keptFor("claude", { kind: "available", via: "bundled" }), null);
});

test("a check that throws or runs out of time is lookup_failed, kept an hour", async () => {
  const { checks, time } = checker({ timeoutMs: 20 });
  const claude = { kind: "available" as const, via: "executable" as const, command: "/usr/bin/claude", version: "2.0.1" };
  let calls = 0;
  const hangs: Pick<Runtime, "installation" | "checkUpdate"> = {
    installation: async () => claude,
    checkUpdate: () => { calls += 1; return new Promise<UpdateCheck>(() => {}); },
  };
  checks.start("claude", hangs, claude);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(checks.keptFor("claude", claude), { kind: "unavailable", reason: "lookup_failed", checkedAt: AT_ISO });
  assert.equal(checks.start("claude", hangs, claude), false, "kept");
  time.advance(RUNTIME_UPDATE_CHECK_FAILURE_CACHE_MS);
  assert.equal(checks.start("claude", hangs, claude), true, "a failed lookup is retried after an hour, not a day");
  assert.equal(calls, 2);

  const grok = { ...claude, command: "/usr/bin/grok" };
  checks.start("grok", { installation: async () => grok, checkUpdate: async () => { throw new Error("ENOTFOUND at /home/someone"); } }, grok);
  await settle();
  assert.equal(checks.keptFor("grok", grok)?.kind, "unavailable");
});

test("a probe that fails is kept too, so it is not started again on the report it asks for", async () => {
  const { checks, settled } = checker({ timeoutMs: 20 });
  let probes = 0;
  const probeHangs: Pick<Runtime, "installation" | "checkUpdate"> = {
    installation: () => { probes += 1; return new Promise<InstallationSnapshot>(() => {}); },
    checkUpdate: async () => assert.fail("no installation to check"),
  };
  assert.equal(checks.start("codex", probeHangs), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled(), 1);
  assert.equal(checks.keptFor("codex", undefined), null, "nothing to carry");
  assert.equal(checks.start("codex", probeHangs), false, "not started again");
  assert.equal(probes, 1);
});

test("nothing to ask: no checker, or an installation that is not an executable; a CLI too old to sign in is checked", async () => {
  const { checks, settled } = checker();
  assert.equal(checks.start("qoder", { installation: installed("1.0.0") }), false);
  assert.equal(checks.start("claude", { installation: async () => ({ kind: "available", via: "bundled" }), checkUpdate: async () => assert.fail("not run") }, { kind: "available", via: "bundled" }), false);
  checks.start("claude", { installation: async () => ({ kind: "not_found" }), checkUpdate: async () => assert.fail("not run") });
  await settle();
  assert.equal(settled(), 0, "nothing new: no report");
  const tooOld = { kind: "unsupported" as const, code: "version_unsupported" as const, via: "executable" as const, command: "/usr/local/bin/agy", reason: "old", installedVersion: "1.4.9" };
  checks.start("antigravity", { installation: async () => tooOld, checkUpdate: async () => ({ kind: "ok", installed: "1.4.9", latest: "1.5.11", updateAvailable: true, source: "x" }) }, tooOld);
  await settle();
  assert.equal(checks.keptFor("antigravity", tooOld)?.kind, "ok");
});

function authHost(options: { serverReadsUpdates: boolean; checkUpdate?: Runtime["checkUpdate"]; claudeInstallation?: Runtime["installation"] }) {
  const events: Array<{ name: string; attrs: Record<string, unknown> }> = [];
  const sent: Array<{ report: RuntimeAuthStatusReport }> = [];
  const runtimes: Record<string, Partial<Runtime>> = {
    claude: {
      installation: options.claudeInstallation ?? installed("2.0.1", "/usr/bin/claude"),
      authStatus: async () => ({ kind: "logged_out", source: "x" }),
      upgrade: async () => assert.fail("never run by a report"),
      checkUpdate: options.checkUpdate ?? (async () => ({ kind: "ok", installed: "2.0.1", latest: "2.0.1", updateAvailable: false, source: "/usr/bin/claude" })),
    },
    antigravity: {
      installation: installed("1.5.10"),
      authStatus: async () => ({ kind: "logged_out", source: "x" }),
      upgrade: async () => assert.fail("never run by a report"),
      checkUpdate: async () => ({ kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, source: "https://example.com/agy" }),
    },
    // An updater but no checker: no answer, the web offers Upgrade as before.
    grok: { installation: installed("0.9.0", "/usr/bin/grok"), authStatus: async () => ({ kind: "logged_out", source: "x" }), upgrade: async () => assert.fail("never run") },
    codex: { installation: installed("0.1.0", "/usr/bin/codex"), authStatus: async () => ({ kind: "logged_out", source: "x" }), checkUpdate: async () => assert.fail("not upgradable: not checked") },
  };
  const host = new RuntimeAuthHost({
    loadRuntime: async (id) => (runtimes[id] ?? {}) as Runtime,
    loadProviderAuth: async () => null,
    kimiStatus: async () => ({ kind: "logged_out" }),
    loadKimiAuth: async () => assert.fail("no Kimi sign-in here"),
    send: (message) => { if (message.type === "machine:runtime_auth:status") sent.push({ report: message.report }); },
    recordEvent: (name, attrs) => events.push({ name, attrs }),
    now: () => AT,
    serverReads: () => ["claude", "codex", "antigravity", "grok"],
    serverReadsUpgradable: () => true,
    serverReadsUpdates: () => options.serverReadsUpdates,
    platform: "linux",
  });
  return { host, events, sent };
}

test("a report never waits on a check: the follow-up report carries it, traced by verdict only, and no more follow", async () => {
  let finish!: (check: UpdateCheck) => void;
  const t = authHost({ serverReadsUpdates: true, checkUpdate: () => new Promise((resolve) => { finish = resolve; }) });
  await t.host.reportStatus("ready", ["claude", "codex", "antigravity", "grok"]);
  assert.equal(t.sent.length, 1, "sent while claude's check still runs");
  assert.equal(t.sent[0]!.report.updates?.claude, undefined, "not checked yet: absent (the web offers Upgrade as before)");
  assert.deepEqual(t.sent[0]!.report.upgradable, ["claude", "antigravity", "grok"]);

  finish({ kind: "ok", installed: "2.0.1", latest: "2.0.1", updateAvailable: false, source: "/usr/bin/claude" });
  await settle();
  assert.equal(t.sent.length, 2, "one follow-up once the checks settled");
  assert.deepEqual(t.sent[1]!.report.updates, {
    claude: { kind: "ok", installed: "2.0.1", latest: "2.0.1", updateAvailable: false, checkedAt: AT_ISO },
    antigravity: { kind: "ok", installed: "1.5.10", latest: "1.5.11", updateAvailable: true, checkedAt: AT_ISO },
  });
  const attrs = t.events.filter((event) => event.name === "daemon.runtime_auth.status.reported")[1]!.attrs;
  assert.equal(attrs.trigger, "update_check");
  assert.equal(attrs.claude_update_check, "latest");
  assert.equal(attrs.antigravity_update_check, "update_available");
  assert.equal(attrs.grok_update_check, undefined);
  assert.ok(!JSON.stringify([t.sent, t.events]).includes("example.com"));
  assert.ok(!JSON.stringify([t.sent, t.events]).includes("/usr/bin/claude"));

  await settle();
  assert.equal(t.sent.length, 2, "the follow-up found every answer kept and started nothing");
});

test("an older server gets no `updates` and no checks", async () => {
  const older = authHost({ serverReadsUpdates: false, checkUpdate: async () => assert.fail("not checked") });
  const plain = await older.host.collectStatus(["claude", "antigravity"], ["claude", "antigravity"]);
  assert.equal("updates" in plain, false, "an older server's strict schema would refuse the field");
  assert.deepEqual(plain.upgradable, ["claude", "antigravity"]);
});

test("a failing check or probe costs that runtime its answer only, and asks for one follow-up, not a loop", async () => {
  const t = authHost({ serverReadsUpdates: true, checkUpdate: async () => { throw new Error("boom /home/someone"); } });
  await t.host.reportStatus("ready", ["claude", "antigravity"]);
  await settle();
  assert.equal(t.sent.length, 2);
  assert.deepEqual(t.sent[1]!.report.updates?.claude, { kind: "unavailable", reason: "lookup_failed", checkedAt: AT_ISO });
  assert.equal(t.sent[1]!.report.runtimes.claude?.kind, "logged_out");

  // The status's installation read throws: the background check probes, fails, and is kept under no installation.
  let probes = 0;
  const p = authHost({ serverReadsUpdates: true, claudeInstallation: async () => { probes += 1; throw new Error("probe failed"); } });
  await p.host.reportStatus("ready", ["claude", "antigravity"]);
  await settle();
  await p.host.reportStatus("login");
  await settle();
  assert.equal(p.sent.length, 3, "the first report, one follow-up, the login's: no report loop");
  assert.equal(p.sent[2]!.report.updates?.claude, undefined);
  assert.equal(probes, 4, "the status's own reads (3) and one background probe");
});

test("an updater that ran forgets that runtime's update check; current keeps the check it ran; all three rescan (the report after it carries the check)", async () => {
  const currentCheck: UpdateCheck = { kind: "ok", installed: "1.5.10", latest: "1.5.10", updateAvailable: false, source: "x" };
  const cases: Array<[UpgradeResult, { forgot: boolean; kept: boolean; rescans: number }]> = [
    [{ kind: "upgraded", from: "1.5.10", to: "1.5.11", output: "" }, { forgot: true, kept: false, rescans: 1 }],
    [{ kind: "unchanged", version: "1.5.10", output: "" }, { forgot: true, kept: false, rescans: 1 }],
    [{ kind: "current", version: "1.5.10", check: currentCheck }, { forgot: false, kept: true, rescans: 1 }],
    [{ kind: "failed", exitCode: 1, output: "" }, { forgot: false, kept: false, rescans: 0 }],
  ];
  for (const [outcome, expected] of cases) {
    const kept: unknown[] = [];
    const forgotten: RuntimeAuthRuntime[] = [];
    let rescans = 0;
    const host = new RuntimeUpgradeHost({
      loadRuntime: async () => ({ installation: installed("1.5.10"), upgrade: async () => outcome }) as unknown as Runtime,
      send: () => {},
      rescan: () => { rescans += 1; },
      forgetUpdateCheck: (runtime) => forgotten.push(runtime),
      keepUpdateCheck: (runtime, installation, check) => kept.push([runtime, installation, check]),
      recordEvent: () => {},
      now: () => AT,
    });
    await host.upgrade("req", "antigravity");
    assert.deepEqual(forgotten, expected.forgot ? ["antigravity"] : [], outcome.kind);
    assert.deepEqual(kept, expected.kept ? [["antigravity", await installed("1.5.10")(), currentCheck]] : [], outcome.kind);
    assert.equal(rescans, expected.rescans, outcome.kind);
  }
});
