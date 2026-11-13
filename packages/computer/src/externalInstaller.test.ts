import assert from "node:assert/strict";
import * as externalInstaller from "./externalInstaller";
import { runService } from "./service";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { describeNetworkError, INSTALLER_DOWNLOAD_ATTEMPTS, setInstallerDownloadRetryDelayForTests, installerArgs, installerCommand, readInstallerUpgradeEvidence, readInstallerVersion, readLastRemoteUpgradeReceipt, recordRemoteUpgradeLaunch, waitForRemoteUpgradeFailureReceipt, watchRemoteUpgradeOutcome } from "./externalInstaller";
import { appendRemoteUpgradeStep, collectRemoteUpgradeSteps, noteServiceTransitionForRemoteUpgrade, noteStartCommandForRemoteUpgrade, startReadinessSummary, traceSafeDiagnostic } from "./remoteUpgradeTrace";
import { existsSync, utimesSync } from "node:fs";
import { createHash } from "node:crypto";
import { bindUpgradeReadyAcknowledgement, prepareResidentLifecycleBridge, probeServiceIpc } from "./residentLifecycleBridge";
import { COMPUTER_VERSION } from "./version";
import type { MachineServiceAttestation } from "./lib/types";
import type { Channel } from "./lib/channelState";

test("installerArgs: latest maps to the installer's main channel", () => {
  assert.deepEqual(installerArgs({ channel: "latest" }), ["upgrade", "--channel", "main"]);
  assert.deepEqual(installerArgs({}), ["upgrade", "--channel", "main"]);
});

test("installerArgs: alpha and named feature channels are forwarded as their own slug", () => {
  assert.deepEqual(installerArgs({ channel: "alpha" }), ["upgrade", "--channel", "alpha"]);
  assert.deepEqual(
    installerArgs({ channel: "fresh-install-flow" as Channel }),
    ["upgrade", "--channel", "fresh-install-flow"],
  );
});

test("installerArgs: an exact version wins over the saved channel", () => {
  assert.deepEqual(installerArgs({ targetVersion: "1.0.33", channel: "alpha" }), ["upgrade", "--version", "1.0.33"]);
  assert.deepEqual(installerArgs({ channel: "pinned:1.0.31" }), ["upgrade", "--version", "1.0.31"]);
  assert.deepEqual(
    installerArgs({ targetVersion: "1.0.30", allowDowngrade: true }),
    ["upgrade", "--version", "1.0.30", "--allow-downgrade"],
  );
});


test("upgrade readiness requires the matching settled installer proof and a live successor", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-proof-"));
  try {
    const directory = join(home, "computer", "installer", "receipts");
    mkdirSync(directory, { recursive: true });
    const id = "request-a";
    const path = join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);
    const receipt = { protocol: "raft-computer-installer/v3", id, operation: "upgrade", outcome: "promoted", exitCode: 0,
      targetVersion: COMPUTER_VERSION, detail: { deadProcessIdentities: JSON.stringify(["pid:42:created:old"]) } };
    assert.equal(await readInstallerUpgradeEvidence(home, id), null);
    writeFileSync(path, JSON.stringify(receipt));
    const proof = await readInstallerUpgradeEvidence(home, id);
    assert.deepEqual(proof, { targetVersion: COMPUTER_VERSION, deadProcessIdentities: ["pid:42:created:old"] });
    const ack = { action: "upgrade" as const, phase: "ready" as const, operationId: id, loadedComputerVersion: COMPUTER_VERSION };
    const service = { computerVersion: COMPUTER_VERSION, servicePid: 99, serviceGeneration: "new", managedSetRevision: "set" } as MachineServiceAttestation;
    const bind = (actual: Awaited<ReturnType<typeof readInstallerUpgradeEvidence>> = proof, version = COMPUTER_VERSION, alive = true) => bindUpgradeReadyAcknowledgement({
      acknowledgement: { ...ack, loadedComputerVersion: version }, service, proof: actual, isAlive: () => alive,
    });
    assert.deepEqual(bind()?.deadProcessIdentities, ["pid:42:created:old"]);
    assert.equal(bind(null), null);
    assert.equal(bind({ targetVersion: COMPUTER_VERSION, deadProcessIdentities: [] }), null);
    writeFileSync(path, JSON.stringify({ ...receipt, detail: { deadProcessIdentities: "[]" } }));
    assert.equal(await readInstallerUpgradeEvidence(home, id), null);
    assert.equal(bind(proof, "0.0.1"), null);
    assert.equal(bind(proof, COMPUTER_VERSION, false), null);
    assert.equal(bind({ targetVersion: "0.0.1", deadProcessIdentities: ["old"] }), null);
    for (const patch of [{ id: "other" }, { outcome: "unresolved", exitCode: 3 }, { detail: {} }]) {
      writeFileSync(path, JSON.stringify({ ...receipt, ...patch }));
      assert.equal(await readInstallerUpgradeEvidence(home, id), null);
    }
    writeFileSync(path, "x".repeat(65_537));
    assert.equal(await readInstallerUpgradeEvidence(home, id), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("service upgrade mutation returns a channel selector without inventing a target version", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-service-mutation-"));
  const oldRaftHome = process.env.RAFT_HOME;
  const oldSlockHome = process.env.SLOCK_HOME;
  const launch = vi.spyOn(externalInstaller, "launchInstallerDetached").mockResolvedValue(4321);
  try {
    process.env.RAFT_HOME = home;
    process.env.SLOCK_HOME = home;
    mkdirSync(join(home, "computer"), { recursive: true });
    writeFileSync(join(home, "computer", "channel"), "alpha");
    let exercised = false;
    await runService({ stopAfterMutationsReady: true, onMutationsReady: async (mutations) => {
      const remote = { scope: "remote" as const, requestId: "channel-request", originServerId: "test-server", trigger: "web" as const };
      assert.deepEqual(await mutations.upgradeStart!(remote), { status: "started", upgradeId: remote.requestId, channel: "alpha" });
      assert.deepEqual(launch.mock.calls.at(-1)?.slice(0, 3), [home, ["upgrade", "--channel", "alpha"], remote.requestId]);
      const steps = (await collectRemoteUpgradeSteps(home, { serverId: "test-server" })).events.filter((event) => event.requestId === remote.requestId);
      assert.deepEqual(steps.map((event) => [event.step, event.outcome, event.supervisor]), [
        ["received", "ok", "none"],
        ["download", "ok", undefined],
        ["installer_spawned", "ok", "none"],
      ]);
      assert.equal(steps[0].fromVersion, COMPUTER_VERSION);
      const exact = { ...remote, requestId: "exact-request", targetVersion: "1.0.33" };
      assert.deepEqual(await mutations.upgradeStart!(exact), { status: "started", upgradeId: exact.requestId, targetVersion: "1.0.33" });
      assert.deepEqual(launch.mock.calls.at(-1)?.slice(0, 3), [home, ["upgrade", "--version", "1.0.33"], exact.requestId]);
      exercised = true;
    } });
    assert.equal(exercised, true);
  } finally {
    launch.mockRestore();
    if (oldRaftHome === undefined) delete process.env.RAFT_HOME; else process.env.RAFT_HOME = oldRaftHome;
    if (oldSlockHome === undefined) delete process.env.SLOCK_HOME; else process.env.SLOCK_HOME = oldSlockHome;
    rmSync(home, { recursive: true, force: true });
  }
});


test("native installer resolver freezes one release, checks bytes, caches and executes without a shell", async () => {
  const home = mkdtempSync(join(tmpdir(), "native-installer-"));
  const windows = process.platform === "win32";
  // System Mach-O executables can be killed by macOS after copying. Build a
  // controlled native fixture instead, so downloaded bytes remain executable
  // on both POSIX hosts and argument boundaries can be asserted exactly.
  const bytes = (() => {
    if (windows) return readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"));
    const fixture = mkdtempSync(join(tmpdir(), "installer-native-fixture-"));
    try {
      const source = join(fixture, "args.c");
      const binary = join(fixture, "args");
      writeFileSync(source, '#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\nint main(int argc, char **argv) { if (argc >= 3 && strcmp(argv[1], "--caller-env") == 0) { FILE *f = fopen(argv[2], "w"); if (!f) return 3; const char *names[] = { "RAFT_COMPUTER_INSTALLER_CALLER", "RAFT_COMPUTER_OPERATION_ID", "RAFT_COMPUTER_APPROVED_BY", "RAFT_COMPUTER_NON_INTERACTIVE" }; for (int n = 0; n < 4; ++n) { const char *v = getenv(names[n]); if (n) fputs("|", f); fputs(v ? v : "absent", f); } fclose(f); return 17; } for (int i = 1; i < argc; ++i) { fwrite(argv[i], 1, strlen(argv[i]) + 1, stdout); } return ferror(stdout) ? 1 : 0; }\n');
      const compiled = spawnSync("cc", [source, "-o", binary], { encoding: "utf8" });
      assert.equal(compiled.status, 0, `native fixture compilation failed: ${compiled.error ?? compiled.stderr}`);
      return readFileSync(binary);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  })();
  const hash = createHash("sha256").update(bytes).digest("hex");
  const target = `${process.platform}-${process.arch}`;
  const name = `raft-computer-installer${windows ? ".exe" : ""}`;
  const requests: string[] = [];
  let mode = "good";
  const server = createServer((request, response) => {
    const url = request.url!;
    requests.push(url);
    if (url === `/dl/raft-computer-installer/main/${target}`) {
      response.writeHead(302, { location: mode === "mutable" ? `/dl/raft-computer-installer/alpha/${target}` : `/dl/raft-computer-installer/releases/frozen/${target}` });
      response.end();
    } else if (url.endsWith("?kind=sha256sums")) {
      response.end(`${hash}  native/${target}/${name}\n`.repeat(mode === "duplicate" ? 2 : 1));
    } else if (url === `/dl/raft-computer-installer/releases/frozen/${target}` || url === `/dl/raft-computer-installer/alpha/${target}`) {
      if (mode === "http-error") { response.writeHead(404); response.end("no"); } // a final answer: a 5xx would be retried
      else response.end(mode === "tampered" ? Buffer.from("not an installer") : bytes);
    } else { response.writeHead(404); response.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const env = { ...process.env, RAFT_HOME: home, RAFT_COMPUTER_INSTALLER_DL_BASE: `http://127.0.0.1:${(server.address() as { port: number }).port}/dl/raft-computer-installer` };
    const args = windows ? ["cmd.exe"] : ["name'with space", "$(must-not-run)", "", "line\nend", "semi;colon"];
    const invocation = await installerCommand(args, env);
    assert.deepEqual(invocation.args, args);
    assert.equal(invocation.command.endsWith(name), true);
    const executed = spawnSync(invocation.command, invocation.args, { env, encoding: "utf8" });
    assert.equal(executed.status, 0, executed.stderr);
    if (windows) assert.match(executed.stdout, /cmd\.exe/i);
    else assert.deepEqual(executed.stdout.split("\0"), [...args, ""]);
    if (!windows) {
      const attendedOutput = join(home, "attended-caller");
      // A Computer the installer once started may still carry that web
      // upgrade's operation variables (#proj-raft-computer:#32). A local
      // upgrade is a new operation and must not reuse any of them.
      const leaked = { ...env, RAFT_COMPUTER_OPERATION_ID: "0af33d21-old-web-upgrade",
        RAFT_COMPUTER_APPROVED_BY: "remote:0af33d21-old-web-upgrade", RAFT_COMPUTER_NON_INTERACTIVE: "1" };
      assert.equal(await externalInstaller.runInstallerAttended(["--caller-env", attendedOutput], leaked), 17);
      assert.equal(readFileSync(attendedOutput, "utf8"), "waiting-cli-v1|absent|absent|absent");
      // `raft-computer upgrade --yes` (Raft Desktop's Update Now): explicitly
      // unattended, whatever the environment said before.
      const unattendedOutput = join(home, "unattended-caller");
      assert.equal(await externalInstaller.runInstallerAttended(["--caller-env", unattendedOutput], leaked, { unattended: true }), 17);
      assert.equal(readFileSync(unattendedOutput, "utf8"), "waiting-cli-v1|absent|absent|1");
      const remoteOutput = join(home, "remote-caller");
      await externalInstaller.launchInstallerDetached(home, ["--caller-env", remoteOutput], "caller-env-test",
        { ...env, RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1" });
      for (let retry = 0; retry < 100; retry++) {
        try { if (readFileSync(remoteOutput, "utf8").startsWith("absent|")) break; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(readFileSync(remoteOutput, "utf8"), "absent|caller-env-test|remote:caller-env-test|1",
        "remote service must never inherit the waiting CLI exemption");
    }
    const binaryRequests = () => requests.filter((url) => url.endsWith(`/releases/frozen/${target}`)).length;
    const count = binaryRequests();
    assert.deepEqual(await installerCommand(args, env), invocation);
    assert.equal(binaryRequests(), count, "verified cached bytes should be reused");
    writeFileSync(invocation.command, "corrupted cache");
    assert.deepEqual(await installerCommand(args, env), invocation);
    assert.equal(binaryRequests(), count + 1, "corrupt cache must be downloaded and reverified");
    for (const bad of ["mutable", "duplicate", "tampered", "http-error"]) {
      mode = bad;
      rmSync(invocation.command, { force: true });
      await assert.rejects(installerCommand(args, env), /invalid_immutable|invalid_installer_checksum|installer_checksum_mismatch|installer_download_failed/);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote upgrade v2: the launching runner relays an installer that gave up without stopping it, never a promotion", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru2-watch-"));
  try {
    const receipts = join(home, "computer", "installer", "receipts");
    mkdirSync(receipts, { recursive: true });
    const name = (id: string) => join(receipts, `${createHash("sha256").update(id).digest("hex")}.json`);
    let clock = 0;
    const polls: number[] = [];
    // The installer writes its receipt on the third poll; another request's receipt is ignored.
    writeFileSync(name("req-other"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-other", operation: "upgrade", outcome: "failed", exitCode: 1, targetVersion: "1.0.49" }));
    const sleep = async (ms: number) => {
      polls.push(ms);
      clock += ms;
      if (polls.length === 2) {
        writeFileSync(name("req-held"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-held", operation: "upgrade", outcome: "held", exitCode: 2, targetVersion: "1.0.49", detail: { reason: "owned by another package manager" } }));
      }
    };
    assert.deepEqual(
      await waitForRemoteUpgradeFailureReceipt(home, "req-held", { targetVersion: "1.0.49", pollMs: 1_000, sleep, now: () => clock }),
      { targetVersion: "1.0.49", outcome: "held", reason: "owned by another package manager" },
    );
    assert.deepEqual(polls, [1_000, 1_000]);

    writeFileSync(name("req-ok"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-ok", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.49" }));
    assert.equal(await waitForRemoteUpgradeFailureReceipt(home, "req-ok", { sleep, now: () => clock }), null, "a promotion is the successor's to report");

    clock = 0;
    polls.length = 0;
    assert.equal(
      await waitForRemoteUpgradeFailureReceipt(home, "req-silent", { timeoutMs: 10_000, pollMs: 4_000, sleep, now: () => clock }),
      null,
      "no receipt by the deadline → nothing, the server's deadline settles it",
    );
    assert.deepEqual(polls, [4_000, 4_000, 4_000]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote upgrade v2: the successor reads the launched request's receipt through the marker, never another request's", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru2-receipt-"));
  try {
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "no marker → nothing");
    await recordRemoteUpgradeLaunch(home, { requestId: "req-1", targetVersion: "1.0.40" });
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "marker without a receipt → nothing yet");
    const receipts = join(home, "computer", "installer", "receipts");
    mkdirSync(receipts, { recursive: true });
    const name = (id: string) => join(receipts, `${createHash("sha256").update(id).digest("hex")}.json`);
    writeFileSync(name("req-0"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-0", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.39" }));
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "another request's receipt is not this launch's");
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "rolled_back", exitCode: 1, targetVersion: "1.0.40", reason: "download checksum mismatch" }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "rolled_back", reason: "download checksum mismatch" });
    // The shape the installer actually writes: kebab-case outcome, reason under detail (rust/report.rs).
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "rolled-back", exitCode: 1, targetVersion: "1.0.40", detail: { reason: "candidate was not started successfully" } }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "rolled_back", reason: "candidate was not started successfully" });
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.40" }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "promoted" });
    writeFileSync(name("req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "held", exitCode: 2, targetVersion: "1.0.40", detail: { reason: "owned by another package manager" } }));
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.40", outcome: "held", reason: "owned by another package manager" });
    writeFileSync(name("req-1"), "{not json");
    assert.equal(await readLastRemoteUpgradeReceipt(home), null, "unparseable receipt → nothing, never a guess");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const receiptPath = (home: string, id: string) => {
  const dir = join(home, "computer", "installer", "receipts");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${createHash("sha256").update(id).digest("hex")}.json`);
};

test("upgrade step log: steps go out once with the installer's outcome, and only from the origin server", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-steps-"));
  try {
    const t0 = 1_000_000;
    const base = { requestId: "req-rb", originServerId: "srv-a", fromVersion: "1.0.50", targetVersion: "1.0.51" };
    await appendRemoteUpgradeStep(home, { ...base, step: "received", outcome: "ok", atMs: t0, supervisor: "systemd-user", killMode: "process" });
    await appendRemoteUpgradeStep(home, { ...base, step: "download", outcome: "ok", atMs: t0 + 10, durationMs: 900, bytes: 4096 });
    await appendRemoteUpgradeStep(home, { ...base, step: "installer_spawned", outcome: "ok", atMs: t0 + 1_000 });

    const first = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: t0 + 2_000 });
    assert.deepEqual(first.events.map((event) => event.step), ["received", "download", "installer_spawned"]);
    assert.equal(first.events[0].deliveredLateMs, 2_000);
    assert.equal(first.events[0].afterDeadline, false);
    assert.equal((await collectRemoteUpgradeSteps(home, { serverId: "srv-b", nowMs: t0 + 2_000 })).events.length, 0, "another server's runner leaves it alone");
    await first.ack();
    assert.equal((await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: t0 + 2_000 })).events.length, 0, "acked steps are not sent again");

    // The restored service writes its own restart, then the receipt lands.
    await appendRemoteUpgradeStep(home, { ...base, step: "service_stopped", outcome: "ok", atMs: t0 + 5_000, version: "1.0.50" });
    await appendRemoteUpgradeStep(home, { ...base, step: "service_started", outcome: "ok", atMs: t0 + 9_000, version: "1.0.50" });
    await appendRemoteUpgradeStep(home, { ...base, step: "service_started", outcome: "ok", atMs: t0 + 9_500, version: "1.0.50" });
    writeFileSync(receiptPath(home, "req-rb"), JSON.stringify({
      protocol: "raft-computer-installer/v3", id: "req-rb", operation: "upgrade", outcome: "rolled-back", exitCode: 1,
      code: "candidate_start_failed", reason: "Raft Computer 1.0.51 didn't start\ncorrectly. See /home/alice/.raft/computer/x.log", finishedAtMs: t0 + 12_000, targetVersion: "1.0.51",
    }));
    const late = t0 + 31 * 60 * 1000;
    const second = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: late });
    assert.deepEqual(second.events.map((event) => event.step), ["service_stopped", "service_started", "rolled_back", "installer_finished"], "one event per step");
    const rolledBack = second.events.find((event) => event.step === "rolled_back")!;
    assert.equal(rolledBack.outcome, "failed");
    assert.equal(rolledBack.errorCode, "candidate_start_failed");
    assert.equal(rolledBack.durationMs, 12_000);
    assert.equal(rolledBack.reason, "Raft Computer 1.0.51 didn't start correctly. See /home/~/.raft/computer/x.log", "one line, account masked");
    assert.equal(rolledBack.fromVersion, "1.0.50");
    assert.equal(rolledBack.afterDeadline, true);
    assert.equal(rolledBack.deliveredLateMs, late - (t0 + 12_000));
    await second.ack();
    assert.equal(readdirSync(join(home, "computer", "installer", "upgrade-trace")).length, 0, "a finished request's log is removed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upgrade step log: a ready that carried the receipt adds `reported`; a silent installer past the deadline reports its last phase", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-steps2-"));
  try {
    const now = Date.now();
    await recordRemoteUpgradeLaunch(home, { requestId: "req-ok", targetVersion: "1.0.51", originServerId: "srv-a" });
    await appendRemoteUpgradeStep(home, { requestId: "req-ok", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    writeFileSync(receiptPath(home, "req-ok"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-ok", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.51", finishedAtMs: now - 1_000 }));
    const promoted = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", relayedInReady: true, nowMs: now });
    assert.deepEqual(promoted.events.map((event) => [event.step, event.outcome, event.via]), [
      ["installer_spawned", "ok", undefined],
      ["new_version_started", "ok", undefined],
      ["installer_finished", "ok", undefined],
      ["reported", "ok", "ready"],
    ]);

    const t0 = now - 40 * 60 * 1000;
    await appendRemoteUpgradeStep(home, { requestId: "req-stuck", originServerId: "srv-a", step: "received", outcome: "ok", atMs: t0 });
    const early = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: t0 + 60_000 });
    assert.ok(!early.events.some((event) => event.step === "installer_stalled"), "never stalled before an installer was started");
    await appendRemoteUpgradeStep(home, { requestId: "req-stuck", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: t0 + 1_000 });
    const plan = join(home, "computer", "installer", "operations", createHash("sha256").update("req-stuck").digest("hex"));
    mkdirSync(plan, { recursive: true });
    writeFileSync(join(plan, "plan.json"), JSON.stringify({ phase: "upgrading" }));
    utimesSync(join(plan, "plan.json"), new Date(t0 + 5_000), new Date(t0 + 5_000));
    assert.ok(!(await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: t0 + 10 * 60_000 })).events.some((event) => event.step === "installer_stalled"), "inside the deadline it may still finish");
    const stalled = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.step === "installer_stalled");
    assert.equal(stalled?.phase, "upgrading");
    assert.equal(stalled?.errorCode, "installer_no_receipt");
    assert.equal(stalled?.atMs, t0 + 5_000);

    // A failed receipt names the phase the installer reached.
    await appendRemoteUpgradeStep(home, { requestId: "req-unresolved", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    const unresolvedPlan = join(home, "computer", "installer", "operations", createHash("sha256").update("req-unresolved").digest("hex"));
    mkdirSync(unresolvedPlan, { recursive: true });
    writeFileSync(join(unresolvedPlan, "plan.json"), JSON.stringify({ phase: "stopping" }));
    writeFileSync(receiptPath(home, "req-unresolved"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-unresolved", operation: "upgrade", outcome: "unresolved", exitCode: 3, code: "recovery_unresolved", reason: "Raft Computer 1.0.47 is running.", finishedAtMs: now - 1_000 }));
    const unresolved = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.requestId === "req-unresolved" && event.step === "installer_finished");
    assert.equal(unresolved?.outcome, "failed");
    assert.equal(unresolved?.errorCode, "recovery_unresolved");
    assert.equal(unresolved?.phase, "stopping");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer `repaired` (exit 0) is an upgrade that also repaired: success to the server and in the step log", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-repaired-"));
  try {
    const now = Date.now();
    const write = (id: string, extra: Record<string, unknown>) =>
      writeFileSync(receiptPath(home, id), JSON.stringify({ protocol: "raft-computer-installer/v3", id, operation: "upgrade", targetVersion: "1.0.51", finishedAtMs: now - 1_000, ...extra }));
    write("req-repaired", { outcome: "repaired", exitCode: 0 });
    // The launching runner does not report it as a failure; the successor's ready settles it.
    assert.equal(await waitForRemoteUpgradeFailureReceipt(home, "req-repaired", { now: () => now, sleep: async () => {} }), null);
    await recordRemoteUpgradeLaunch(home, { requestId: "req-repaired", targetVersion: "1.0.51", originServerId: "srv-a" });
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.51", outcome: "promoted" });
    await appendRemoteUpgradeStep(home, { requestId: "req-repaired", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    const steps = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now });
    assert.deepEqual(steps.events.filter((event) => event.step !== "installer_spawned").map((event) => [event.step, event.outcome, event.errorCode]), [
      ["new_version_started", "ok", "repaired"],
      ["installer_finished", "ok", "repaired"],
    ]);

    // A repair that did not finish cleanly is still a failure.
    write("req-repair-failed", { outcome: "repaired", exitCode: 1, code: "recovery_unresolved", reason: "x" });
    const failed = await waitForRemoteUpgradeFailureReceipt(home, "req-repair-failed", { now: () => now, sleep: async () => {} });
    assert.equal(failed?.outcome, "failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer `installed` (exit 0) is a fresh install of the target: success to the server and in the step log", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-installed-"));
  try {
    const now = Date.now();
    const write = (id: string, extra: Record<string, unknown>) =>
      writeFileSync(receiptPath(home, id), JSON.stringify({ protocol: "raft-computer-installer/v3", id, operation: "upgrade", targetVersion: "1.0.59", finishedAtMs: now - 1_000, ...extra }));
    write("req-installed", { outcome: "installed", exitCode: 0, detail: { readback: "service" } });
    assert.equal(await waitForRemoteUpgradeFailureReceipt(home, "req-installed", { now: () => now, sleep: async () => {} }), null);
    await recordRemoteUpgradeLaunch(home, { requestId: "req-installed", targetVersion: "1.0.59", originServerId: "srv-a" });
    assert.deepEqual(await readLastRemoteUpgradeReceipt(home), { targetVersion: "1.0.59", outcome: "promoted" });
    await appendRemoteUpgradeStep(home, { requestId: "req-installed", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    const steps = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now });
    assert.deepEqual(steps.events.filter((event) => event.step !== "installer_spawned").map((event) => [event.step, event.outcome, event.errorCode]), [
      ["new_version_started", "ok", "installed"],
      ["installer_finished", "ok", "installed"],
    ]);

    // Installed but nothing started (readback "candidate"): whatever ran before may still run.
    write("req-installed-candidate", { outcome: "installed", exitCode: 0, detail: { readback: "candidate" } });
    const candidate = await waitForRemoteUpgradeFailureReceipt(home, "req-installed-candidate", { now: () => now, sleep: async () => {} });
    assert.equal(candidate?.outcome, "failed");
    await appendRemoteUpgradeStep(home, { requestId: "req-installed-candidate", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    const candidateStep = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.requestId === "req-installed-candidate" && event.step !== "installer_spawned");
    assert.deepEqual([candidateStep?.step, candidateStep?.outcome, candidateStep?.errorCode], ["installer_finished", "failed", "installed"]);

    // A fresh install that did not exit cleanly is still a failure.
    write("req-install-failed", { outcome: "installed", exitCode: 1, code: "recovery_unresolved", reason: "x" });
    const failed = await waitForRemoteUpgradeFailureReceipt(home, "req-install-failed", { now: () => now, sleep: async () => {} });
    assert.equal(failed?.outcome, "failed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Reconciler step 13: a web upgrade that waited for its agents first has the
// drain on top of its deadline; the stall check and the service transitions
// follow it. RED proof: put the bare REMOTE_UPGRADE_FAILURE_WATCH_MS back in
// collectRemoteUpgradeSteps and `installer_stalled` is reported at 35 min.
test("upgrade step log: a drained upgrade is not stalled, and still records its restart, until 30 min plus its drain", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-steps-drain-"));
  try {
    const now = Date.now();
    const t0 = now - 35 * 60 * 1000;
    await recordRemoteUpgradeLaunch(home, { requestId: "req-drained", targetVersion: "1.0.51", originServerId: "srv-a", drainMs: 10 * 60 * 1000 });
    await appendRemoteUpgradeStep(home, { requestId: "req-drained", originServerId: "srv-a", step: "received", outcome: "ok", atMs: t0 });
    await appendRemoteUpgradeStep(home, { requestId: "req-drained", originServerId: "srv-a", step: "drain", outcome: "ok", atMs: t0 + 1_000, durationMs: 9 * 60 * 1000, phase: "deadline" });
    await appendRemoteUpgradeStep(home, { requestId: "req-drained", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: t0 + 10 * 60 * 1000 });
    const inside = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events;
    assert.ok(!inside.some((event) => event.step === "installer_stalled"), "35 min after a 10 min drain it may still finish");
    assert.equal(inside.find((event) => event.step === "received")?.afterDeadline, false);
    const past = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: t0 + 41 * 60 * 1000 })).events;
    assert.equal(past.find((event) => event.step === "installer_stalled")?.errorCode, "installer_no_plan", "past 30 + 10 min it is stalled");

    // The marker was written at launch (≈ now here): its restart counts until 30 + 10 min.
    await noteServiceTransitionForRemoteUpgrade(home, "service_stopped", "1.0.50", now + 35 * 60 * 1000);
    assert.ok((await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.some((event) => event.step === "service_stopped"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// #proj-raft-computer:#77: the installer judges a version by `raft-computer
// start`'s exit code; a rolled-back upgrade left only "start (exit 1)" behind.
test("upgrade step log: the installer's start is a step; the candidate's and the rollback's are both sent, counts and codes only", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-start-cmd-"));
  const traceFiles = () => existsSync(join(home, "computer", "installer", "upgrade-trace")) ? readdirSync(join(home, "computer", "installer", "upgrade-trace")) : [];
  const failed = {
    outcome: "failed" as const,
    errorCode: "START_DAEMON_TIMEOUT",
    readiness: { targets: 3, ready: 1, notReady: { "runner-absent": 2 }, partial: false, unlinked: 0, waitedMs: 30_012.6 },
  };
  try {
    await noteStartCommandForRemoteUpgrade(home, { version: "1.25.0", ...failed });
    assert.equal(traceFiles().length, 0, "no upgrade → nothing");
    await recordRemoteUpgradeLaunch(home, { requestId: "req-s", targetVersion: "1.25.0", originServerId: "srv-a" });
    await appendRemoteUpgradeStep(home, { requestId: "req-s", originServerId: "srv-a", step: "received", outcome: "ok", atMs: Date.now() });
    await noteStartCommandForRemoteUpgrade(home, { version: "1.25.0", ...failed });
    // The same version failing again (a supervisor retry) is not sent twice.
    await noteStartCommandForRemoteUpgrade(home, { version: "1.25.0", ...failed });
    // The rollback's start of the previous version, which never reached its wait.
    await noteStartCommandForRemoteUpgrade(home, { version: "1.22.0", outcome: "failed", errorCode: "DUPLICATE_KEY_HOLDER", readiness: null });
    const first = await collectRemoteUpgradeSteps(home, { serverId: "srv-a" });
    assert.deepEqual(
      first.events.filter((event) => event.step === "start_command").map((event) => [event.version, event.outcome, event.errorCode, event.reason, event.targetVersion]),
      [
        ["1.25.0", "failed", "START_DAEMON_TIMEOUT", "targets=3 ready=1 not_ready=runner-absent:2 partial=false unlinked=0 waited_ms=30012", "1.25.0"],
        ["1.22.0", "failed", "DUPLICATE_KEY_HOLDER", undefined, "1.25.0"],
      ],
    );
    await first.ack();
    // A later start of the candidate that works is a different outcome: sent.
    await noteStartCommandForRemoteUpgrade(home, { version: "1.25.0", outcome: "ok", readiness: { ...failed.readiness, ready: 3, notReady: {} } });
    const second = await collectRemoteUpgradeSteps(home, { serverId: "srv-a" });
    assert.deepEqual(second.events.map((event) => [event.step, event.version, event.outcome, event.reason]), [
      ["start_command", "1.25.0", "ok", "targets=3 ready=3 not_ready=none partial=false unlinked=0 waited_ms=30012"],
    ]);
    await second.ack();
    assert.deepEqual((await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).events, [], "nothing is sent twice");

    // Once the receipt exists the start is marked, like a service transition.
    writeFileSync(receiptPath(home, "req-s"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-s", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.25.0" }));
    await (await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).ack();
    await noteStartCommandForRemoteUpgrade(home, { version: "1.25.0", outcome: "failed", errorCode: "START_DAEMON_TIMEOUT", readiness: null });
    const after = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).events;
    assert.deepEqual(after.map((event) => [event.step, event.afterReceipt]), [["start_command", true]], "the receipt's own steps are not sent again");

    // An error code is an identifier; text in its place is not sent.
    await noteStartCommandForRemoteUpgrade(home, { version: "1.24.0", outcome: "failed", errorCode: "cannot read /Users/someone/.slock", readiness: null });
    assert.deepEqual((await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).events.filter((event) => event.version === "1.24.0").map((event) => event.errorCode), ["unknown"]);

    const traceSizes = () => traceFiles().map((name) => [name, readFileSync(join(home, "computer", "installer", "upgrade-trace", name), "utf8").length]);
    const before = traceSizes();
    // Another installer operation owns the product now (a local upgrade): its start is not this request's.
    mkdirSync(join(home, "computer", "installer"), { recursive: true });
    writeFileSync(join(home, "computer", "installer", "product-state.json"), JSON.stringify({ operationId: "local-upgrade-1" }));
    await noteStartCommandForRemoteUpgrade(home, { version: "1.26.0", ...failed });
    assert.deepEqual(traceSizes(), before, "another operation's start is not recorded");
    rmSync(join(home, "computer", "installer", "product-state.json"));
    await noteStartCommandForRemoteUpgrade(home, { version: "1.25.0", ...failed }, Date.now() + 31 * 60 * 1000);
    assert.deepEqual(traceSizes(), before, "a start past the deadline is not recorded");
    // The same start inside the window is: the two checks above did not pass for another reason.
    await noteStartCommandForRemoteUpgrade(home, { version: "1.26.0", ...failed });
    assert.notDeepEqual(traceSizes(), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upgrade step log: a start's readiness summary carries reason codes and whole numbers, nothing else", () => {
  assert.equal(
    startReadinessSummary({
      targets: 4,
      ready: 1,
      // A key that is not a reason code can only come from a caller ignoring the type: it is dropped.
      notReady: { "runner-disconnected": 1, "runner-absent": 2, "/Users/someone/.slock": 1, "runner-unattested": 0, "runner-lock-conflict": undefined } as Record<string, number | undefined>,
      partial: true,
      unlinked: -1,
      waitedMs: Number.NaN,
    }),
    "targets=4 ready=1 not_ready=runner-absent:2,runner-disconnected:1 partial=true unlinked=0 waited_ms=0",
  );
});

test("upgrade step log: service stop/start is a step of the launched upgrade inside its deadline, marked once the receipt exists", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-steps3-"));
  const traceFiles = () => existsSync(join(home, "computer", "installer", "upgrade-trace")) ? readdirSync(join(home, "computer", "installer", "upgrade-trace")) : [];
  try {
    await noteServiceTransitionForRemoteUpgrade(home, "service_stopped", "1.0.50");
    assert.equal(traceFiles().length, 0, "no upgrade → nothing");
    await recordRemoteUpgradeLaunch(home, { requestId: "req-1", targetVersion: "1.0.51", originServerId: "srv-a" });
    await noteServiceTransitionForRemoteUpgrade(home, "service_stopped", "1.0.50");
    const steps = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).events;
    assert.deepEqual(steps.map((event) => [event.step, event.version, event.targetVersion]), [["service_stopped", "1.0.50", "1.0.51"]]);
    writeFileSync(receiptPath(home, "req-1"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-1", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.51" }));
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.51", Date.now(), 4242);
    const after = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).events.find((event) => event.step === "service_started");
    assert.deepEqual([after?.version, after?.afterReceipt], ["1.0.51", true], "a start after the receipt is sent, marked");
    const traces = traceFiles();
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.51", Date.now() + 31 * 60 * 1000);
    assert.deepEqual(traceFiles(), traces, "past the deadline nothing is recorded");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 6e69cc4a (11-11): a web upgrade rolled back at 08:44; a local upgrade
// started 1.0.69 at 08:52 and that start was sent under the web request's id.
// RED proof: drop the anotherInstallerOperationOwnsProduct check and the
// local operation's start is recorded under req-web.
test("upgrade step log: after the receipt, a start made by another installer operation is not the request's", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-steps-foreign-"));
  const started = async () => (await collectRemoteUpgradeSteps(home, { serverId: "srv-a" })).events.filter((event) => event.step === "service_started");
  try {
    await recordRemoteUpgradeLaunch(home, { requestId: "req-web", targetVersion: "1.0.69", originServerId: "srv-a" });
    writeFileSync(receiptPath(home, "req-web"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-web", operation: "upgrade", outcome: "rolled-back", exitCode: 1, targetVersion: "1.0.69" }));
    const productState = join(home, "computer", "installer", "product-state.json");
    writeFileSync(productState, JSON.stringify({ operationId: "req-web", lastStart: null }));
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.65", Date.now(), 100);
    assert.deepEqual((await started()).map((event) => event.version), ["1.0.65"], "the request's own installer still owns the product: sent");

    writeFileSync(productState, JSON.stringify({ operationId: "local-op", lastStart: null }));
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.69", Date.now(), 200);
    assert.deepEqual((await started()).map((event) => event.version), ["1.0.65"], "a local installer operation's start is not sent");

    rmSync(productState);
    mkdirSync(join(home, "computer", "k"), { recursive: true });
    writeFileSync(join(home, "computer", "k", "operation.json"), JSON.stringify({ id: "local-op", phase: "upgrading" }));
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.69", Date.now(), 300);
    assert.deepEqual((await started()).map((event) => event.version), ["1.0.65"], "K running another operation: not sent");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("remote upgrade: a restored service reports the receipt its installer writes after it connected", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-watch-"));
  try {
    let clock = Date.now();
    const sleep = async (ms: number) => {
      clock += ms;
      if (clock - start >= 10_000) {
        writeFileSync(receiptPath(home, "req-rb"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-rb", operation: "upgrade", outcome: "rolled-back", exitCode: 1, reason: "1.0.51 didn't start correctly; 1.0.50 is running again.", targetVersion: "1.0.51" }));
      }
    };
    const start = clock;
    assert.equal(await watchRemoteUpgradeOutcome(home, "srv-a", { sleep, now: () => clock }), null, "no marker → nothing to watch");
    await recordRemoteUpgradeLaunch(home, { requestId: "req-rb", targetVersion: "1.0.51", originServerId: "srv-a" });
    assert.equal(await watchRemoteUpgradeOutcome(home, "srv-b", { sleep, now: () => clock }), null, "another server's upgrade");
    assert.deepEqual(await watchRemoteUpgradeOutcome(home, "srv-a", { pollMs: 5_000, sleep, now: () => clock }), {
      requestId: "req-rb", outcome: "rolled_back", reason: "1.0.51 didn't start correctly; 1.0.50 is running again.",
    });
    assert.equal(await watchRemoteUpgradeOutcome(home, "srv-a", { sleep, now: () => clock }), null, "the receipt was already there for ready to carry");

    await recordRemoteUpgradeLaunch(home, { requestId: "req-old", targetVersion: "1.0.51" });
    assert.equal(await watchRemoteUpgradeOutcome(home, "srv-a", { sleep, now: () => clock }), null, "a marker without its origin is left to the deadline");
    await recordRemoteUpgradeLaunch(home, { requestId: "req-late", targetVersion: "1.0.51", originServerId: "srv-a" });
    assert.equal(await watchRemoteUpgradeOutcome(home, "srv-a", { sleep, now: () => clock + 31 * 60 * 1000 }), null, "past the deadline the server has settled it");
    // Reconciler step 13: a drained upgrade's window is longer by its drain.
    await recordRemoteUpgradeLaunch(home, { requestId: "req-drained", targetVersion: "1.0.51", originServerId: "srv-a", drainMs: 10 * 60 * 1000 });
    writeFileSync(receiptPath(home, "req-drained"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-drained", operation: "upgrade", outcome: "failed", exitCode: 1, reason: "held", targetVersion: "1.0.51" }));
    const watchAt = (offsetMs: number) => watchRemoteUpgradeOutcome(home, "srv-a", { sleep, now: () => Date.now() + offsetMs });
    assert.equal(await watchAt(39 * 60 * 1000), null, "the receipt is already there: ready carried it");
    rmSync(receiptPath(home, "req-drained"));
    let writes = 0;
    const late = watchRemoteUpgradeOutcome(home, "srv-a", {
      sleep: async () => {
        writes += 1;
        writeFileSync(receiptPath(home, "req-drained"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-drained", operation: "upgrade", outcome: "failed", exitCode: 1, reason: "held", targetVersion: "1.0.51" }));
      },
      now: () => Date.now() + 35 * 60 * 1000,
    });
    assert.deepEqual(await late, { requestId: "req-drained", outcome: "failed", reason: "held" }, "35 min after launch, inside 30 min + the 10 min drain");
    assert.equal(writes, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});


test("installer download: a network failure is named by its cause, not just `fetch failed`", () => {
  const reset = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET", cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) }) });
  assert.equal(describeNetworkError(reset), "UND_ERR_SOCKET/ECONNRESET");
  assert.equal(describeNetworkError(new TypeError("fetch failed")), "network_error");
  assert.equal(describeNetworkError(Object.assign(new Error("t"), { name: "TimeoutError" })), "TimeoutError");
});

test("installer download: a 5xx answer is retried until a final answer; a lasting 5xx names the attempts", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-retry-5xx-"));
  let sumsHits = 0;
  let failSums = 1;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/dl/main/")) {
      response.writeHead(302, { location: "/dl/releases/rel-1/linux-arm64" });
      response.end();
      return;
    }
    sumsHits += 1;
    // Like Hands answering 500 when its storage briefly fails.
    response.writeHead(sumsHits <= failSums ? 500 : 404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const env = { ...process.env, RAFT_HOME: home, RAFT_COMPUTER_INSTALLER_DL_BASE: `http://127.0.0.1:${port}/dl` };
  setInstallerDownloadRetryDelayForTests(async () => {});
  try {
    // One 500, then the next answer (404 here) is final: the 500 was retried.
    await assert.rejects(installerCommand(["upgrade"], env, "linux", "arm64"), /^Error: installer_download_failed: HTTP 404$/);
    assert.equal(sumsHits, 2, "a 500 is retried once, then the 404 is final");

    sumsHits = 0;
    failSums = Number.POSITIVE_INFINITY;
    await assert.rejects(installerCommand(["upgrade"], env, "linux", "arm64"), /^Error: installer_download_failed: HTTP 500 after 3 attempts$/);
    assert.equal(sumsHits, INSTALLER_DOWNLOAD_ATTEMPTS);
  } finally {
    setInstallerDownloadRetryDelayForTests(null);
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer download: dropped connections are retried; HTTP answers are not, and the last failure names its cause", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-retry-"));
  let channelHits = 0;
  let sumsHits = 0;
  let dropEveryChannelRequest = false;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/dl/main/")) {
      channelHits += 1;
      // Like a proxy that resets the first connections.
      if (dropEveryChannelRequest || channelHits <= 2) {
        request.socket.destroy();
        return;
      }
      response.writeHead(302, { location: "/dl/releases/rel-1/linux-arm64" });
      response.end();
      return;
    }
    sumsHits += 1;
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const env = { ...process.env, RAFT_HOME: home, RAFT_COMPUTER_INSTALLER_DL_BASE: `http://127.0.0.1:${port}/dl` };
  setInstallerDownloadRetryDelayForTests(async () => {});
  try {
    await assert.rejects(installerCommand(["upgrade"], env, "linux", "arm64"), /^Error: installer_download_failed: HTTP 404$/);
    assert.equal(channelHits, 3, "two resets, then the redirect");
    assert.equal(sumsHits, 1, "an HTTP answer is final");

    channelHits = 0;
    dropEveryChannelRequest = true;
    await assert.rejects(
      installerCommand(["upgrade"], env, "linux", "arm64"),
      (error: Error) => /^installer_release_unavailable: [A-Za-z_/]+ after 3 attempts$/.test(error.message) && !error.message.includes("fetch failed"),
    );
    assert.equal(channelHits, INSTALLER_DOWNLOAD_ATTEMPTS);
  } finally {
    setInstallerDownloadRetryDelayForTests(null);
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer channel: a non-redirect answer names its status; a 5xx is retried and a 4xx is not", async () => {
  const home = mkdtempSync(join(tmpdir(), "installer-channel-status-"));
  let channelHits = 0;
  let status = 503;
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/dl/main/")) {
      channelHits += 1;
      response.writeHead(status, { "content-type": "text/html" });
      response.end("<html>busy</html>");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const env = { ...process.env, RAFT_HOME: home, RAFT_COMPUTER_INSTALLER_DL_BASE: `http://127.0.0.1:${port}/dl` };
  setInstallerDownloadRetryDelayForTests(async () => {});
  try {
    await assert.rejects(installerCommand(["upgrade"], env, "linux", "arm64"), /^Error: installer_release_unavailable: HTTP 503 after 3 attempts$/);
    assert.equal(channelHits, INSTALLER_DOWNLOAD_ATTEMPTS, "a 5xx is retried");

    channelHits = 0;
    status = 404;
    await assert.rejects(installerCommand(["upgrade"], env, "linux", "arm64"), /^Error: installer_release_unavailable: HTTP 404$/);
    assert.equal(channelHits, 1, "a 4xx is final");
  } finally {
    setInstallerDownloadRetryDelayForTests(null);
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("readInstallerVersion reads the installer's own --version and is null when it cannot", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "raft-installer-version-"));
  try {
    const script = (name: string, body: string) => {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
      return file;
    };
    assert.equal(await readInstallerVersion(script("ok", 'test "$1" = --version && echo 0.3.21')), "0.3.21");
    assert.equal(await readInstallerVersion(script("named", "echo raft-computer-installer 0.3.20")), "0.3.20");
    assert.equal(await readInstallerVersion(script("unknown-flag", "echo 'unexpected argument' >&2; exit 2")), null);
    assert.equal(await readInstallerVersion(script("garbage", "echo hello")), null);
    assert.equal(await readInstallerVersion(join(dir, "missing")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrade step log: a failed receipt carries the installer's own error and its failed-start record, redacted", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-diagnostic-"));
  try {
    const now = Date.now();
    // "Could not resolve the requested release": the receipt's reason is copy;
    // detail.diagnostic is the error behind it (rust/operation.rs).
    await appendRemoteUpgradeStep(home, { requestId: "req-resolve", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    writeFileSync(receiptPath(home, "req-resolve"), JSON.stringify({
      protocol: "raft-computer-installer/v3", id: "req-resolve", operation: "upgrade", outcome: "failed", exitCode: 1,
      code: "release_resolution_failed", reason: "The requested Raft Computer release could not be resolved.", finishedAtMs: now - 1_000,
      detail: { diagnostic: "error sending request for url (https://hands.build/api/releases/1.0.53?sig=SECRET123): invalid peer certificate: UnknownIssuer" },
    }));
    // A rolled-back candidate: the receipt names the installer's start record.
    const diagnosticId = "6f1c2d4e-0a1b-4c5d-8e9f-0123456789ab";
    mkdirSync(join(home, "computer", "installer", "diagnostics"), { recursive: true });
    writeFileSync(join(home, "computer", "installer", "diagnostics", `${diagnosticId}.json`), JSON.stringify({
      formatVersion: 1, operationId: "req-rolled", action: "start", argv: ["start"], failure: "exited",
      exitCode: 1, stderrTail: "Error: EACCES: permission denied, open 'C:\\Users\\alice\\.slock\\computer\\run\\service.log'", stderrTruncated: false,
    }));
    await appendRemoteUpgradeStep(home, { requestId: "req-rolled", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    writeFileSync(receiptPath(home, "req-rolled"), JSON.stringify({
      protocol: "raft-computer-installer/v3", id: "req-rolled", operation: "upgrade", outcome: "rolled-back", exitCode: 1,
      code: "candidate_start_failed", reason: "Raft Computer 1.0.53 didn't start correctly.", finishedAtMs: now - 1_000,
      detail: { diagnostic: "candidate did not become ready", startFailureDiagnostic: `diagnostics/${diagnosticId}.json` },
    }));
    const { events } = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now });
    const resolve = events.find((event) => event.requestId === "req-resolve" && event.step === "installer_finished");
    assert.equal(resolve?.errorCode, "release_resolution_failed");
    assert.equal(resolve?.diagnostic, "error sending request for url (https://hands.build/api/releases/1.0.53?…): invalid peer certificate: UnknownIssuer");
    const rolled = events.find((event) => event.requestId === "req-rolled" && event.step === "rolled_back");
    assert.equal(rolled?.diagnostic, "candidate did not become ready");
    assert.equal(rolled?.startFailure, "exited");
    assert.equal(rolled?.startExitCode, 1);
    // The installer keeps the start's stderr local (mode 0600); it never reaches the trace.
    assert.ok(!JSON.stringify(rolled).includes("EACCES"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const installerFile = (home: string, ...parts: string[]) => {
  const path = join(home, "computer", ...parts);
  mkdirSync(join(path, ".."), { recursive: true });
  return path;
};
const planPath = (home: string, id: string) => installerFile(home, "installer", "operations", createHash("sha256").update(id).digest("hex"), "plan.json");
const kOperation = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  formatVersion: 1, id, startedAtMs: 1, updatedAtMs: 2, fromVersion: "1.0.63", targetVersion: "1.0.64", previousStableVersion: "1.0.63",
  phase: "recovering", outcome: null, reason: null, provenance: null, metadata: {}, ...extra,
});
const productState = (id: string, lastStart: Record<string, unknown> | null) => JSON.stringify({
  formatVersion: 1, operationId: id, targetVersion: "1.0.64", fromVersion: "1.0.63", running: true, setupKnown: true, nextStep: null,
  initialProcesses: [], forcedStops: [], lastStart,
});

test("upgrade step log: an unresolved receipt names the engine's own error, K's operation and the installer's last start", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-engine-"));
  try {
    const now = Date.now();
    await appendRemoteUpgradeStep(home, { requestId: "req-u", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    // rust/operation.rs resume(): the receipt's diagnostic is the installer's
    // own fixed text; plan.json, not saved again, keeps the engine's error.
    writeFileSync(receiptPath(home, "req-u"), JSON.stringify({
      protocol: "raft-computer-installer/v3", installerVersion: "0.4.0", id: "req-u", operation: "upgrade", outcome: "unresolved", exitCode: 3,
      code: "recovery_unresolved", reason: "An earlier installation could not be recovered.", finishedAtMs: now - 1_000, targetVersion: "1.0.64",
      detail: { diagnostic: "upgrade still requires recovery" },
    }));
    writeFileSync(planPath(home, "req-u"), JSON.stringify({ phase: "upgrading", detail: { diagnostic: "restore-stable failed: open /home/alice/.slock/computer/k/slots/stable/VERSION: token=abc123" } }));
    writeFileSync(installerFile(home, "k", "operation.json"), kOperation("req-u", { phase: "recovering", reason: "stable start failed at /Users/bob/x" }));
    const diagnosticId = "0a1b2c3d-0a1b-4c5d-8e9f-0123456789ab";
    writeFileSync(installerFile(home, "installer", "product-state.json"), productState("req-u", { slot: "stable", version: "1.0.63", succeeded: false, failureDiagnostic: `diagnostics/${diagnosticId}.json` }));
    writeFileSync(installerFile(home, "installer", "diagnostics", `${diagnosticId}.json`), JSON.stringify({
      formatVersion: 1, operationId: "req-u", slot: "stable", version: "1.0.63", action: "start", argv: ["start"], failure: "timed_out",
      exitCode: 137, stderrTail: "secret stderr", stderrTruncated: false, recordedAtMs: now - 2_000,
    }));
    const { events } = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now });
    const finished = events.find((event) => event.step === "installer_finished");
    assert.deepEqual({ ...finished, deliveredLateMs: undefined, durationMs: undefined, atMs: undefined, afterDeadline: undefined }, {
      requestId: "req-u", step: "installer_finished", outcome: "failed", errorCode: "recovery_unresolved",
      reason: "An earlier installation could not be recovered.", phase: "upgrading", diagnostic: "upgrade still requires recovery",
      installerVersion: "0.4.0", receiptOutcome: "unresolved",
      engineDiagnostic: "restore-stable failed: open /home/~/.slock/computer/k/slots/stable/VERSION: token=…",
      enginePhase: "recovering", engineReason: "stable start failed at /Users/~/x",
      lastStartSlot: "previous", lastStartVersion: "1.0.63", lastStartSucceeded: false, lastStartFailure: "timed_out", lastStartExitCode: 137,
      deliveredLateMs: undefined, durationMs: undefined, atMs: undefined, afterDeadline: undefined,
    });
    assert.ok(!JSON.stringify(events).includes("secret stderr"), "the start's stderr stays local");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upgrade step log: the success receipt carries its outcome; another request's or a missing record adds nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-engine-ok-"));
  try {
    const now = Date.now();
    const receipt = (id: string) => writeFileSync(receiptPath(home, id), JSON.stringify({
      protocol: "raft-computer-installer/v3", installerVersion: "0.3.21", id, operation: "upgrade", outcome: "promoted", exitCode: 0, finishedAtMs: now - 1_000, targetVersion: "1.0.64",
    }));
    // No plan, no K operation, no product state: only the receipt's own fields.
    await appendRemoteUpgradeStep(home, { requestId: "req-bare", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    receipt("req-bare");
    const bare = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.step === "installer_finished");
    assert.deepEqual([bare?.outcome, bare?.installerVersion, bare?.receiptOutcome], ["ok", "0.3.21", "promoted"]);
    for (const key of ["engineDiagnostic", "enginePhase", "engineOutcome", "engineReason", "lastStartSlot", "lastStartVersion", "lastStartSucceeded", "lastStartFailure", "lastStartExitCode", "phase", "diagnostic"]) {
      assert.equal(key in bare!, false, `${key} absent without its file`);
    }

    // The candidate started; no failure file. K's and the start's records belong to this request.
    await appendRemoteUpgradeStep(home, { requestId: "req-ok", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    receipt("req-ok");
    writeFileSync(installerFile(home, "k", "operation.json"), kOperation("req-ok", { phase: "promoted", outcome: "promoted" }));
    writeFileSync(installerFile(home, "installer", "product-state.json"), productState("req-ok", { slot: "experiment", version: "1.0.64", succeeded: true }));
    const ok = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.requestId === "req-ok" && event.step === "installer_finished");
    assert.deepEqual([ok?.enginePhase, ok?.engineOutcome, ok?.lastStartSlot, ok?.lastStartVersion, ok?.lastStartSucceeded, ok?.lastStartFailure], ["promoted", "promoted", "candidate", "1.0.64", true, undefined]);

    // Records of a later operation are not this request's.
    await appendRemoteUpgradeStep(home, { requestId: "req-old", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    receipt("req-old");
    const old = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.requestId === "req-old" && event.step === "installer_finished");
    assert.deepEqual([old?.receiptOutcome, old?.enginePhase, old?.lastStartSlot], ["promoted", undefined, undefined]);

    // A dangling failure reference: the start is still reported, without the file's fields.
    writeFileSync(installerFile(home, "installer", "product-state.json"), productState("req-old", { slot: "experiment", version: "1.0.64", succeeded: false, failureDiagnostic: "diagnostics/0a1b2c3d-0a1b-4c5d-8e9f-0123456789ab.json" }));
    const dangling = (await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.find((event) => event.requestId === "req-old" && event.step === "installer_finished");
    assert.deepEqual([dangling?.lastStartSlot, dangling?.lastStartSucceeded, dangling?.lastStartFailure, dangling?.lastStartExitCode], ["candidate", false, undefined, undefined]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upgrade step log: an unresolved receipt a supervisor retry rewrites is reported once more", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-rewrite-"));
  const traceDir = join(home, "computer", "installer", "upgrade-trace");
  try {
    const now = Date.now();
    const receipt = (extra: Record<string, unknown>) => writeFileSync(receiptPath(home, "req-r"), JSON.stringify({
      protocol: "raft-computer-installer/v3", installerVersion: "0.4.0", id: "req-r", operation: "upgrade", targetVersion: "1.0.64", ...extra,
    }));
    await appendRemoteUpgradeStep(home, { requestId: "req-r", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    receipt({ outcome: "unresolved", exitCode: 3, code: "recovery_unresolved", reason: "x", finishedAtMs: now - 30_000 });
    const first = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now - 20_000 });
    assert.deepEqual(first.events.map((event) => [event.step, event.receiptOutcome]), [["installer_spawned", undefined], ["installer_finished", "unresolved"]]);
    await first.ack();
    assert.equal(readdirSync(traceDir).length, 2, "an unresolved request's log is kept");
    const still = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now - 10_000 });
    assert.equal(still.events.length, 0, "an unchanged receipt is not sent again");
    await still.ack();

    receipt({ outcome: "promoted", exitCode: 0, finishedAtMs: now - 5_000 });
    const second = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now });
    assert.deepEqual(second.events.map((event) => [event.step, event.outcome, event.receiptOutcome]), [
      ["new_version_started", "ok", "promoted"],
      ["installer_receipt_updated", "ok", "promoted"],
    ], "the first installer_finished is not repeated");
    await second.ack();
    assert.equal(existsSync(traceDir) ? readdirSync(traceDir).length : 0, 0, "settled: the log is removed");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upgrade step log: restarts after the receipt are sent once per step, version and process, never resending the receipt", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-after-"));
  try {
    const now = Date.now();
    await recordRemoteUpgradeLaunch(home, { requestId: "req-a", targetVersion: "1.0.64", originServerId: "srv-a" });
    await appendRemoteUpgradeStep(home, { requestId: "req-a", originServerId: "srv-a", step: "installer_spawned", outcome: "ok", atMs: now - 60_000 });
    writeFileSync(receiptPath(home, "req-a"), JSON.stringify({ protocol: "raft-computer-installer/v3", id: "req-a", operation: "upgrade", outcome: "promoted", exitCode: 0, targetVersion: "1.0.64", finishedAtMs: now - 50_000 }));
    const first = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now - 40_000 });
    assert.ok(first.events.some((event) => event.step === "installer_finished"));
    await first.ack();

    // The log was removed; later restarts start a continuation log.
    await noteServiceTransitionForRemoteUpgrade(home, "service_stopped", "1.0.64", now - 30_000, 100);
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.63", now - 20_000, 200);
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.63", now - 20_000, 200);
    await noteServiceTransitionForRemoteUpgrade(home, "service_started", "1.0.64", now - 10_000, 300);
    const second = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now });
    assert.deepEqual(second.events.map((event) => [event.step, event.version, event.afterReceipt]), [
      ["service_stopped", "1.0.64", true],
      ["service_started", "1.0.63", true],
      ["service_started", "1.0.64", true],
    ], "deduped by step, version and process; the receipt is not sent again");
    await second.ack();
    assert.equal((await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: now })).events.length, 0, "acked transitions are not sent again");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("traceSafeDiagnostic drops URL queries, credentials, tokens, user dirs and emails", () => {
  assert.equal(
    traceSafeDiagnostic("GET https://r2.example/x.tar.gz?X-Amz-Signature=abc&X-Amz-Credential=def failed; Authorization: Bearer eyJhbGciOi; key sk_computer_2a8ece0123456789"),
    "GET https://r2.example/x.tar.gz?… failed; Authorization: Bearer …; key sk_…",
  );
  assert.equal(
    traceSafeDiagnostic("proxy http://alice:hunter2@proxy.corp:8080 refused; Authorization: Basic YWxpY2U6aHVudGVy; token=abc123 password: p4ss api_key=xyz"),
    "proxy http://…@proxy.corp:8080 refused; Authorization: Basic …; token=… password: … api_key=…",
  );
  assert.equal(
    traceSafeDiagnostic("open C:/Users/alice/x, C:\\\\Users\\\\bob\\\\y, /Users/carol/z; contact dev@corp.example; ghp_0123456789abcdef sk-ant-api03-abcdefgh AKIA0123456789ABCDEF eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"),
    "open C:/Users/~/x, C:\\\\Users\\\\~\\\\y, /Users/~/z; contact …@…; … … … …",
  );
  // macOS and Linux user dirs, mid-path, at the end and after `~` expansion.
  assert.equal(
    traceSafeDiagnostic("open '/Users/alice/Library/Raft/x.json': EACCES; HOME=/home/bob; cert at /Users/carol"),
    "open '/Users/~/Library/Raft/x.json': EACCES; HOME=/home/~; cert at /Users/~",
  );
  // Redacted over the whole text before the bound: a cut never strands a key's tail.
  const long = `${"x".repeat(290)} sk_computer_2a8ece0123456789`;
  assert.ok(!traceSafeDiagnostic(long).includes("2a8ece"));
});

test("traceSafeDiagnostic stays fast on a huge unbroken token and is still bounded", () => {
  // A plan.json diagnostic may be up to the file's 1 MB; the redaction must
  // not scan all of it (its patterns grow with the square of a long token).
  // An unbroken run with no "@" is the worst case for the email pattern.
  const huge = "a".repeat(128 * 1024);
  const started = Date.now();
  const out = traceSafeDiagnostic(huge);
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
  assert.ok(out.length <= 300);
  // Still redacted after the cut.
  assert.equal(traceSafeDiagnostic(`${"x".repeat(100)} token=secretvalue ${"y".repeat(8 * 1024)}`).includes("secretvalue"), false);
});

test("upgrade step log: a log too large to send is removed, not kept forever", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-oversize-"));
  try {
    const dir = join(home, "computer", "installer", "upgrade-trace");
    mkdirSync(dir, { recursive: true });
    const name = `${"a".repeat(64)}.jsonl`;
    writeFileSync(join(dir, name), `${JSON.stringify({ requestId: "req-big", step: "received", outcome: "ok", atMs: 1 })}\n${"x".repeat(70 * 1024)}\n`);
    const collected = await collectRemoteUpgradeSteps(home, { serverId: "srv-a", nowMs: 2 });
    assert.equal(collected.events.length, 0);
    await collected.ack();
    assert.equal(existsSync(join(dir, name)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a runner that cannot reach its Computer service says so; one that can does not", async () => {
  const home = mkdtempSync(join(tmpdir(), "ru-ipc-"));
  try {
    // No service listens for this install root: the real probe fails fast.
    assert.equal(await probeServiceIpc(home, 1_000), false);
    const unreachable = await prepareResidentLifecycleBridge(home, "srv-a", { probeServiceIpc: async () => false });
    assert.equal(unreachable.serviceIpcUnreachable, true);
    const reachable = await prepareResidentLifecycleBridge(home, "srv-a", { probeServiceIpc: async () => true });
    assert.equal(reachable.serviceIpcUnreachable, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("installer operation variables: scrubbed in place, configuration kept", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", RAFT_COMPUTER_INSTALLER_CHANNEL: "alpha",
    RAFT_COMPUTER_OPERATION_ID: "id", RAFT_COMPUTER_APPROVED_BY: "remote:id",
    RAFT_COMPUTER_NON_INTERACTIVE: "1", RAFT_COMPUTER_INSTALLER_CALLER: "waiting-cli-v1" };
  assert.equal(externalInstaller.scrubInstallerOperationEnv(env), env);
  assert.deepEqual(env, { PATH: "/usr/bin", RAFT_COMPUTER_INSTALLER_CHANNEL: "alpha" });
});
