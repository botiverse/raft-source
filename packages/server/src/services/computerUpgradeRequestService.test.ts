import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { computers, computerUpgradeRequests, servers, users } from "../db/schema";
import { sql } from "drizzle-orm";
import { createServer } from "./serverService";
import { registerMachine } from "./machineService";
import { computerControlRefusal } from "./computerControlAuthorization";
import {
  computerUpgradeRequestTraceAttrs,
  createComputerUpgradeRequest,
  expireComputerUpgradeRequests,
  isUnresolvedUpgradeRefusal,
  traceSafeUpgradeReason,
  listLatestComputerUpgradeRequests,
  observeComputerVersionForUpgradeRequests,
  projectComputerUpgradeRequest,
  recordComputerUpgradeDrainFinished,
  settleRefusedComputerUpgradeRequest,
  UPGRADE_REQUEST_DEADLINE_MS,
  UPGRADE_REQUEST_LATE_SETTLE_MS,
  UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS,
  UPGRADE_REQUEST_REVERT_WINDOW_MS,
  upgradeFailureHintFromReason,
  upgradeRequestReasonCode,
  UPGRADE_REQUEST_REASON_CODES,
  UPGRADE_AUTO_RETRY_DELAY_MS,
  UPGRADE_AUTO_RETRY_FAILURE_CODES,
  UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS,
  claimDueComputerUpgradeAutoRetries,
  settleAbandonedComputerUpgradeAutoRetries,
  recordComputerUpgradeAutoRetryResult,
  UPGRADE_AUTO_RETRY_ABANDON_MS,
  failUndeliveredComputerUpgradeRequest,
  runClaimedComputerUpgradeAutoRetry,
  skipOfflineComputerUpgradeAutoRetries,
  upgradeAutoRetryFailureCode,
  type ComputerUpgradeAutoRetryDeps,
  type ComputerUpgradeRequestRow,
} from "./computerUpgradeRequestService";
import type { ComputerLastUpgradeReceipt, ComputerUpgradeInstallerReport } from "@botiverse/raft-shared";

const now = new Date("2026-09-22T12:00:00Z");
const machineId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function seed() {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email: "upgrade-request@example.com",
    name: "upgrade-request-operator",
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "upgrade-request",
    slug: "upgrade-request",
    ownerId: user!.id,
  }).returning();
  return { userId: user!.id, serverId: server!.id };
}

test("one open request per machine; the reported version settles it as done", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const first = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.40", requestedByUserId: userId, now });
    assert.equal(first.created, true);
    assert.equal(first.row.outcome, null);
    assert.equal(first.row.deadlineAt.getTime(), now.getTime() + UPGRADE_REQUEST_DEADLINE_MS);

    // A second request while one is open returns the open one, unchanged.
    const again = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.41", requestedByUserId: userId, now });
    assert.equal(again.created, false);
    assert.equal(again.row.id, first.row.id);
    assert.equal(again.row.targetVersion, "1.0.40");

    // A reconnect with a different version does not close it as done: it is a failure with the reason the successor carried.
    const unrelated = await observeComputerVersionForUpgradeRequests({ machineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", reportedVersion: "1.0.40", now });
    assert.equal(unrelated, null, "another machine's version settles nothing");

    const done = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.40", now: new Date(now.getTime() + 60_000) });
    assert.ok(done);
    assert.equal(done.outcome, "done");
    assert.equal(done.observedVersion, "1.0.40");
    assert.equal(done.reason, null);
    assert.equal(projectComputerUpgradeRequest(done).state, "done");

    // Settled rows are never re-settled (an older version coming back is a revert, covered below).
    const settledAgain = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.41", now });
    assert.equal(settledAgain, null);
    const [row] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, first.row.id));
    assert.equal(row!.outcome, "done");
  } finally {
    await closeTestDatabase();
  }
});

test("a reconnect with the old version fails the request only with the installer's receipt for it; a silent machine expires", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.40", requestedByUserId: userId, now });
    const failed = await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.36",
      receipt: { targetVersion: "1.0.40", outcome: "rolled_back", reason: "download checksum mismatch" },
      now,
    });
    assert.ok(failed);
    assert.equal(failed.id, row.id);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.observedVersion, "1.0.36");
    assert.equal(failed.reason, "download checksum mismatch");

    const second = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.41", requestedByUserId: userId, now: new Date(now.getTime() + 1) });
    assert.equal(second.created, true);
    // An old-version `ready` with no receipt for THIS target is not an outcome:
    // a connection blip mid-download reconnects on the old version. The request
    // stays pending (xxchan 10-12: the page dropped to "offline" mid-upgrade).
    for (const receipt of [null, { targetVersion: "9.9.9", outcome: "failed" as const, reason: "stale" }]) {
      const blip = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.36", receipt, now });
      assert.equal(blip, null, "old version without this target's receipt settles nothing");
    }
    const [stillOpen] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, second.row.id));
    assert.equal(stillOpen!.outcome, null);
    assert.equal(projectComputerUpgradeRequest(stillOpen!).state, "pending");
    const secondDone = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.41", now });
    assert.equal(secondDone?.outcome, "done");

    // Expiry: only open rows past their deadline become no_response.
    const thirdAt = new Date(now.getTime() + 2);
    const third = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.42", requestedByUserId: userId, now: thirdAt });
    assert.equal(third.created, true);
    assert.deepEqual(await expireComputerUpgradeRequests(new Date(thirdAt.getTime() + UPGRADE_REQUEST_DEADLINE_MS - 1)), []);
    const expired = await expireComputerUpgradeRequests(new Date(thirdAt.getTime() + UPGRADE_REQUEST_DEADLINE_MS));
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.id, third.row.id);
    assert.equal(expired[0]!.outcome, "no_response");
    assert.deepEqual(computerUpgradeRequestTraceAttrs(expired[0]!), {
      request_id: third.row.id,
      server_id: serverId,
      machine_id: machineId,
      target_version: "1.0.42",
      observed_version: "",
      outcome: "no_response",
      reason: "no_reconnect_before_deadline",
      reason_code: "no_reconnect_before_deadline",
      duration_ms: UPGRADE_REQUEST_DEADLINE_MS,
    });
    assert.equal("duration_ms" in computerUpgradeRequestTraceAttrs(second.row), false, "an open request has no duration yet");
    assert.equal(
      traceSafeUpgradeReason("EACCES: /Users/alice/Library/raft and C:\\Users\\Bob Smith\\AppData and /home/carol/.raft"),
      "EACCES: /Users/~/Library/raft and C:\\Users\\~\\AppData and /home/~/.raft",
    );
    assert.equal(traceSafeUpgradeReason("x".repeat(500)).length, 120);
    assert.equal(traceSafeUpgradeReason(null), "");

    // Projection picks the open request first, otherwise the most recent.
    const latest = await listLatestComputerUpgradeRequests([machineId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
    assert.equal(latest.size, 1);
    assert.equal(latest.get(machineId)!.id, third.row.id);
    const fourth = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.43", requestedByUserId: userId, now: new Date(now.getTime() + 3) });
    const latestOpen = await listLatestComputerUpgradeRequests([machineId]);
    assert.equal(latestOpen.get(machineId)!.id, fourth.row.id);
    assert.equal(projectComputerUpgradeRequest(fourth.row).state, "pending");
  } finally {
    await closeTestDatabase();
  }
});

// What Computers send today (no code, only text): the refusal of a unit whose
// KillMode would kill the installer (computer describeKillModeRequirement), and
// the installer's `installation_held` when it cannot leave the unit
// (installer systemd.rs confinement_reason).
const KILL_MODE_REFUSAL = "UPGRADE_START_REJECTED: The Computer service runs under systemd unit raft-computer.service with KillMode=control-group. "
  + "A remote upgrade launches the installer inside that unit's control group, and systemd would kill it together with the service when the installer stops the service. "
  + "Set `KillMode=process` in the unit's [Service] section, run `systemctl daemon-reload` (with `--user` for a user unit), restart the unit, then retry the upgrade.";
const confinedInUnit = (manager: string, unit: string) => `The Computer service runs in systemd unit ${unit}, which would stop the upgrade together with the service, `
  + `and the upgrade could not move out of it. Upgrade from the host: \`${manager} stop ${unit}\`, run the install command, then \`${manager} start ${unit}\`.`;

test("the latest failed request carries a hint when its reason is a systemd unit only the install command gets past", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const latestHint = async () => {
      const row = (await listLatestComputerUpgradeRequests([machineId])).get(machineId)!;
      return projectComputerUpgradeRequest(row).failureHint;
    };
    // Refused before the installer ran: settled with the version the Computer runs.
    const first = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now });
    const refused = await settleRefusedComputerUpgradeRequest({ machineId, requestId: first.row.id, reason: KILL_MODE_REFUSAL, observedVersion: "1.0.51", now });
    assert.equal(refused?.observedVersion, "1.0.51");
    assert.deepEqual(await latestHint(), { reason: "unsafe_kill_mode", unit: "raft-computer.service", killMode: "control-group" });

    // The installer held it inside the unit: the receipt the next `ready` carries.
    await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now: new Date(now.getTime() + 1) });
    await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.53",
      receipt: { targetVersion: "1.0.60", outcome: "held", reason: confinedInUnit("systemctl --user", "raft@agent.service") },
      now,
    });
    assert.deepEqual(await latestHint(), { reason: "installation_held", unit: "raft@agent.service", scope: "user" });

    // A later attempt that fails for another reason, or that is still open, replaces it.
    const third = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now: new Date(now.getTime() + 2) });
    assert.equal(await latestHint(), null, "an open request has no hint");
    await settleRefusedComputerUpgradeRequest({ machineId, requestId: third.row.id, reason: "installer_download_failed: ECONNRESET", observedVersion: "1.0.53", now });
    assert.equal(await latestHint(), null, "another failure has none");

    // A success replaces it too.
    await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now: new Date(now.getTime() + 3) });
    await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.60", now });
    assert.equal(await latestHint(), null, "done has none");
  } finally {
    await closeTestDatabase();
  }
});

test("upgradeFailureHintFromReason reads the unit, KillMode and scope only from the two known texts", () => {
  assert.deepEqual(upgradeFailureHintFromReason(KILL_MODE_REFUSAL.replace("control-group", "unknown")), { reason: "unsafe_kill_mode", unit: "raft-computer.service", killMode: "unknown" });
  assert.deepEqual(upgradeFailureHintFromReason(confinedInUnit("systemctl", "raft-computer.service")), { reason: "installation_held", unit: "raft-computer.service", scope: "system" });
  for (const reason of [
    null,
    "installer_held",
    // installation_held for a reason that is not the unit (Raft Desktop's registration).
    "Raft Desktop keeps Raft Computer running with the service manager, which needs Computer 1.0.58 or newer; 1.0.57 would start beside it. Nothing was changed.",
    "The Computer service runs under an external supervisor (RAFT_COMPUTER_EXTERNAL_SUPERVISOR) that relaunches it on every exit",
    // A unit name that is not one is not passed on.
    "The Computer service runs under systemd unit <b>x</b>.service with KillMode=control-group.",
    // Nothing a pasted `systemctl stop <unit>` would run or read as an option.
    "The Computer service runs under systemd unit a;rm.service with KillMode=control-group.",
    "The Computer service runs under systemd unit $(id).service with KillMode=control-group.",
    "The Computer service runs under systemd unit `id`.service with KillMode=control-group.",
    "The Computer service runs under systemd unit -Hroot@evil.service with KillMode=control-group.",
    "The Computer service runs in systemd unit raft\\x2dc.service, which would stop the upgrade together with the service",
  ]) assert.equal(upgradeFailureHintFromReason(reason), null, String(reason));
});

test("upgradeFailureHintFromReason reads the stored production reasons (AndyLok, #proj-raft-computer:4b80a56d)", () => {
  // As stored in computer_upgrade_requests.reason for the four Computers on
  // 1.0.51/1.0.53 that never upgraded from the web (truncated as recorded).
  assert.deepEqual(
    upgradeFailureHintFromReason("The Computer service runs under systemd unit raft-computer.service with KillMode=control-group. A remote upgrade launches the installer inside that unit's control group, and systemd would kill it toge"),
    { reason: "unsafe_kill_mode", unit: "raft-computer.service", killMode: "control-group" },
  );
  assert.deepEqual(
    upgradeFailureHintFromReason("UPGRADE_INSTALLER_FAILED: The Computer service runs in systemd unit raft-computer-lab2.service, which would stop the upgrade together with the service, and the upgrade could not move out of it. Upgrade fro"),
    { reason: "installation_held", unit: "raft-computer-lab2.service" },
  );
  // Computer refusing before the spawn because systemd denied the scope (#67) carries the unit and the manager too.
  assert.deepEqual(
    upgradeFailureHintFromReason("The Computer service runs in systemd unit raft-computer.service, which would stop the upgrade together with the service, and the upgrade could not move out of it (systemd-run: Failed to start transient scope unit: Access denied). Upgrade from the host: `systemctl stop raft-computer.service`, run the install command, then `systemctl start raft-computer.service`."),
    { reason: "installation_held", unit: "raft-computer.service", scope: "system" },
  );
});

test("upgradeRequestReasonCode maps every stored reason to a fixed code (#proj-o11y:#29)", () => {
  const cases: Array<[string | null, string]> = [
    [null, ""],
    ["", ""],
    ["reverted_after_upgrade: 1.0.50", "reverted_after_upgrade"],
    ["recovery_unresolved: UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.", "recovery_unresolved"],
    ["installer_left_no_result: Raft Computer came back on 1.0.68 without a result from the installer.", "installer_left_no_result"],
    ["late_after_deadline", "late_after_deadline"],
    ["no_reconnect_before_deadline", "no_reconnect_before_deadline"],
    ["command_not_delivered", "command_not_delivered"],
    ["installer_promoted", "installer_promoted"],
    ["installer_failed", "installer_failed"],
    ["installer_rolled_back", "installer_rolled_back"],
    ["installer_held", "installer_held"],
    ["installer_unresolved", "installer_unresolved"],
    ["UPGRADE_INSTALLER_FAILED: The Computer service runs in systemd unit raft-computer.service, which would stop the upgrade together with the service, and the upgrade could not move out of it.", "installation_held"],
    // Computer's own pre-spawn refusal when systemd denies the installer its scope (externalSupervisor.ts describeScopeUnavailable, #67): the same class.
    ["The Computer service runs in systemd unit raft-computer.service, which would stop the upgrade together with the service, and the upgrade could not move out of it (systemd-run: Failed to start transient scope unit: Access denied as the requested operation requires interactive authentication.). Upgrade from the host: `systemctl stop raft-computer.service`, run the install command, then `systemctl start raft-computer.service`.", "installation_held"],
    ["The Computer service runs under systemd unit raft-computer.service with KillMode=control-group. A remote upgrade", "unsafe_kill_mode"],
    ["Raft Computer 1.0.51 didn't start correctly. See /home/alice/.raft/computer/x.log", "candidate_start_failed"],
    // raft-computer-installer#82 codes, stored as `<code>: <reason>` from the receipt's code.
    ["earlier_recovery_pending: UPGRADE_INSTALLER_FAILED: An earlier installation on this computer is unfinished and needs a repair, so nothing was changed.", "earlier_recovery_pending"],
    ["candidate_check_timed_out: Some future wording", "candidate_check_timed_out"],
    ["candidate_check_failed: Some future wording", "candidate_check_failed"],
    // raft-computer-installer#85.
    ["download_stalled: The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.", "download_stalled"],
    // Fallback for Computers that send no code: the installer's fixed texts.
    ["UPGRADE_INSTALLER_FAILED: An earlier installation on this computer is unfinished and needs a repair, so nothing was changed.", "earlier_recovery_pending"],
    ["UPGRADE_INSTALLER_FAILED: The new Raft Computer version did not answer its first check in time; this is often the operating system scanning a newly downloaded file. Try again.", "candidate_check_timed_out"],
    ["UPGRADE_INSTALLER_FAILED: The downloaded Raft Computer version failed its first check.", "candidate_check_failed"],
    ["UPGRADE_INSTALLER_FAILED: The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.", "download_stalled"],
    ["EACCES: /Users/alice/Library/raft", "other"],
    ["computer_refused", "other"],
    // A prefix only counts as the server's own reason, not inside other text.
    ["installer_failed and more", "other"],
    ["something reverted_after_upgrade: 1.0.50", "other"],
  ];
  for (const [reason, code] of cases) assert.equal(upgradeRequestReasonCode(reason), code, String(reason));
  // Every enum value is reachable, and nothing outside the enum comes back.
  const seen = new Set(cases.map(([reason]) => upgradeRequestReasonCode(reason)).filter(Boolean));
  assert.deepEqual([...seen].sort(), [...UPGRADE_REQUEST_REASON_CODES].sort());

});

const EARLIER_RECOVERY_PENDING_TEXT = "UPGRADE_INSTALLER_FAILED: An earlier installation on this computer is unfinished and needs a repair, so nothing was changed.";

test("isUnresolvedUpgradeRefusal: the installer's code first, then its outcome; the text only without them", () => {
  const oldText = "UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.";
  // earlier_recovery_pending is never held open, whatever the outcome or the text say.
  for (const installerOutcome of ["failed", "unresolved"] as const) {
    assert.equal(isUnresolvedUpgradeRefusal({ code: "upgrade_installer_failed", reason: oldText, installer: { installerOutcome, installerCode: "earlier_recovery_pending" } }), false, installerOutcome);
  }
  // With the fields, the text is never read: a failed receipt whose text has the old phrase fails at once.
  assert.equal(isUnresolvedUpgradeRefusal({ code: "upgrade_installer_failed", reason: oldText, installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" } }), false);
  assert.equal(isUnresolvedUpgradeRefusal({ code: "upgrade_installer_failed", reason: "x", installer: { installerOutcome: "unresolved" } }), true);
  assert.equal(isUnresolvedUpgradeRefusal({ code: "upgrade_installer_failed", reason: "x", installer: { installerOutcome: "failed", installerCode: "recovery_unresolved" } }), true);
  // Fallback for Computers that send no fields (before 1.25.4): the text of installers before raft-computer-installer#82.
  assert.equal(isUnresolvedUpgradeRefusal({ code: "upgrade_installer_failed", reason: oldText }), true);
  assert.equal(isUnresolvedUpgradeRefusal({ code: "upgrade_installer_failed", reason: EARLIER_RECOVERY_PENDING_TEXT }), false);
});

test("earlier_recovery_pending fails the request at once with the repair hint; the candidate check codes get their own class", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    let i = 0;
    const open = async () => {
      const machine = `edededed-eded-4ded-8ded-${String(i++).padStart(12, "0")}`;
      const { row } = await createComputerUpgradeRequest({ serverId, machineId: machine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      return { machine, row };
    };

    // computer:upgrade:done from a Computer that sends the code (1.25.4 on).
    const earlier = await open();
    const settled = await settleRefusedComputerUpgradeRequest({
      machineId: earlier.machine,
      requestId: earlier.row.id,
      code: "upgrade_installer_failed",
      reason: EARLIER_RECOVERY_PENDING_TEXT,
      installer: { installerOutcome: "failed", installerCode: "earlier_recovery_pending" },
      observedVersion: "1.0.59",
      now,
    });
    assert.equal(settled?.outcome, "failed", "settled now, not at the deadline");
    assert.equal(settled?.reason, `earlier_recovery_pending: ${EARLIER_RECOVERY_PENDING_TEXT}`);
    assert.equal(settled?.autoRetryFailureCode, null, "a retry would hit the same refusal");
    assert.deepEqual(projectComputerUpgradeRequest(settled!).failureHint, { reason: "earlier_recovery_pending" });
    assert.equal(computerUpgradeRequestTraceAttrs(settled!).reason_code, "earlier_recovery_pending");

    // The code decides over any text: a future wording still gets the hint.
    const reworded = await open();
    const rewordedRow = await settleRefusedComputerUpgradeRequest({
      machineId: reworded.machine, requestId: reworded.row.id, code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: Something else entirely.",
      installer: { installerOutcome: "failed", installerCode: "earlier_recovery_pending" }, now,
    });
    assert.equal(rewordedRow?.outcome, "failed");
    assert.deepEqual(projectComputerUpgradeRequest(rewordedRow!).failureHint, { reason: "earlier_recovery_pending" });

    // The same refusal on `ready.lastUpgradeReceipt` (the Computer reconnected meanwhile).
    const ready = await open();
    const fromReady = await observeComputerVersionForUpgradeRequests({
      machineId: ready.machine, reportedVersion: "1.0.59", now,
      receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "An earlier installation on this computer is unfinished and needs a repair, so nothing was changed.", code: "earlier_recovery_pending" },
    });
    assert.equal(fromReady?.outcome, "failed");
    assert.equal(fromReady?.reason, "earlier_recovery_pending: An earlier installation on this computer is unfinished and needs a repair, so nothing was changed.");
    assert.deepEqual(projectComputerUpgradeRequest(fromReady!).failureHint, { reason: "earlier_recovery_pending" });

    // A recovery this request's own workers may still finish stays open, from either path.
    const unresolvedDone = await open();
    const heldByCode = await settleRefusedComputerUpgradeRequest({
      machineId: unresolvedDone.machine, requestId: unresolvedDone.row.id, code: "upgrade_installer_failed",
      reason: "UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.",
      installer: { installerOutcome: "unresolved", installerCode: "recovery_unresolved" }, now,
    });
    assert.equal(heldByCode?.outcome, null);
    assert.equal(heldByCode?.reason, "recovery_unresolved: UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.");
    const unresolvedReady = await open();
    const heldOnReady = await observeComputerVersionForUpgradeRequests({
      machineId: unresolvedReady.machine, reportedVersion: "1.0.59", now,
      receipt: { targetVersion: "1.0.60", outcome: "unresolved", reason: "An earlier installation could not be recovered.", code: "recovery_unresolved" },
    });
    assert.equal(heldOnReady?.outcome, null);
    assert.equal((await listLatestComputerUpgradeRequests([unresolvedReady.machine])).get(unresolvedReady.machine)?.outcome, null, "still open in the database");

    // A Computer that sends no code (1.25.3 and older) with an installer from #82 on: the installer's fixed text, as a fallback.
    const oldComputer = await open();
    const fallback = await settleRefusedComputerUpgradeRequest({
      machineId: oldComputer.machine, requestId: oldComputer.row.id, code: "upgrade_installer_failed", reason: EARLIER_RECOVERY_PENDING_TEXT, observedVersion: "1.0.59", now,
    });
    assert.equal(fallback?.outcome, "failed");
    assert.equal(fallback?.reason, EARLIER_RECOVERY_PENDING_TEXT);
    assert.deepEqual(projectComputerUpgradeRequest(fallback!).failureHint, { reason: "earlier_recovery_pending" });

    // An installer before #82 refusing behind an earlier installation (unresolved, its old text), no code: still held open, as before.
    const oldInstaller = await open();
    const held = await settleRefusedComputerUpgradeRequest({
      machineId: oldInstaller.machine, requestId: oldInstaller.row.id, code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.", now,
    });
    assert.equal(held?.outcome, null);

    // Candidate check codes: failed at once, their own class, no hint (Try again from the web).
    for (const code of ["candidate_check_timed_out", "candidate_check_failed"] as const) {
      const check = await open();
      const row = await settleRefusedComputerUpgradeRequest({
        machineId: check.machine, requestId: check.row.id, code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: The new version did not pass.",
        installer: { installerOutcome: "failed", installerCode: code }, now,
      });
      assert.equal(row?.outcome, "failed", code);
      assert.equal(computerUpgradeRequestTraceAttrs(row!).reason_code, code);
      assert.equal(projectComputerUpgradeRequest(row!).failureHint, null, code);
    }

    // Any other code keeps the reason as sent.
    const other = await open();
    const otherRow = await settleRefusedComputerUpgradeRequest({
      machineId: other.machine, requestId: other.row.id, code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: x",
      installer: { installerOutcome: "failed", installerCode: "install_failed" }, now,
    });
    assert.equal(otherRow?.reason, "UPGRADE_INSTALLER_FAILED: x");
  } finally {
    await closeTestDatabase();
  }
});

test("a machine that comes back on the target after the deadline settles the expired request as a late success", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.50", requestedByUserId: userId, now });
    const deadline = now.getTime() + UPGRADE_REQUEST_DEADLINE_MS;
    assert.equal((await expireComputerUpgradeRequests(new Date(deadline)))[0]?.outcome, "no_response");

    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.47", now: new Date(deadline + 1_000) }), null, "still the old version");
    const late = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.50", now: new Date(deadline + 240_000) });
    assert.equal(late?.id, row.id);
    assert.equal(late?.outcome, "succeeded_late");
    assert.equal(late?.reason, "late_after_deadline");
    assert.equal(late?.observedVersion, "1.0.50");
    assert.equal(late && "replacedOutcome" in late ? late.replacedOutcome : null, "no_response");
    assert.equal(projectComputerUpgradeRequest(late!).state, "succeeded_late");
    assert.equal(computerUpgradeRequestTraceAttrs(late!).late_ms, 240_000);
    assert.equal(computerUpgradeRequestTraceAttrs(late!).reason_code, "late_after_deadline");
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.50", now: new Date(deadline + 300_000) }), null, "settled once");

    // Only the latest request, and not after the window.
    const next = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.51", requestedByUserId: userId, now: new Date(deadline + 400_000) });
    await expireComputerUpgradeRequests(new Date(next.row.deadlineAt.getTime()));
    assert.equal(
      await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.51", now: new Date(next.row.deadlineAt.getTime() + UPGRADE_REQUEST_LATE_SETTLE_MS + 1_000) }),
      null,
    );
    const [kept] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, next.row.id));
    assert.equal(kept!.outcome, "no_response");

    // A no_response keeps its longer window: past the unresolved one, it still lifts.
    const third = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.52", requestedByUserId: userId, now: new Date(next.row.deadlineAt.getTime() + UPGRADE_REQUEST_LATE_SETTLE_MS + 2_000) });
    await expireComputerUpgradeRequests(new Date(third.row.deadlineAt.getTime()));
    const lifted = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.52", now: new Date(third.row.deadlineAt.getTime() + UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS + 1_000) });
    assert.equal(lifted?.id, third.row.id);
    assert.equal(lifted?.outcome, "succeeded_late");
  } finally {
    await closeTestDatabase();
  }
});

test("an older version reconnecting within the window after done reverts the request to failed, once", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    // 88602a54 (2026-10-20): two Computer services on one key, one upgraded to 1.0.51, the other still 1.0.50.
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.51", requestedByUserId: userId, now });
    const doneAt = new Date(now.getTime() + 74_000);
    assert.equal((await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.51", now: doneAt }))?.outcome, "done");
    // The upgraded service and the old one alternate on the same key.
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.51", now: new Date(doneAt.getTime() + 10_000) }), null);
    const reverted = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.50", now: new Date(doneAt.getTime() + 60_000) });
    assert.equal(reverted?.id, row.id);
    assert.equal(reverted?.outcome, "failed");
    assert.equal(reverted?.reason, "reverted_after_upgrade: 1.0.50");
    assert.equal(reverted?.observedVersion, "1.0.50");
    assert.equal(projectComputerUpgradeRequest(reverted!).state, "failed");
    // Once: neither the target nor the old version flips it again.
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.51", now: new Date(doneAt.getTime() + 120_000) }), null);
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.50", now: new Date(doneAt.getTime() + 180_000) }), null);
    const [stored] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, row.id));
    assert.equal(stored!.outcome, "failed");

    // f21d311b: done for 1.0.51 but the machine keeps reporting 1.0.47; outside the window it stays done.
    const second = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.52", requestedByUserId: userId, now: new Date(doneAt.getTime() + 600_000) });
    const secondDone = new Date(second.row.requestedAt.getTime() + 30_000);
    await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.52", now: secondDone });
    assert.equal(
      await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.47", now: new Date(secondDone.getTime() + UPGRADE_REQUEST_REVERT_WINDOW_MS + 1_000) }),
      null,
      "after the window an old version is not attributed to this upgrade",
    );
    const [kept] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, second.row.id));
    assert.equal(kept!.outcome, "done");
  } finally {
    await closeTestDatabase();
  }
});

// #proj-raft-computer:#51: an installer `unresolved` receipt (exit 3,
// `recovery_unresolved`) can be followed by a later installer worker for the
// same request that repairs and finishes the upgrade.
const UNRESOLVED_RECEIPT = { targetVersion: "1.0.64", outcome: "unresolved" as const, reason: "An earlier installation could not be recovered." };

test("an unresolved receipt before the deadline only records; the target version connecting then settles done", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.64", requestedByUserId: userId, now });
    const recorded = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.63", receipt: UNRESOLVED_RECEIPT, now: new Date(now.getTime() + 60_000) });
    assert.equal(recorded?.id, row.id);
    assert.equal(recorded?.outcome, null, "not settled");
    assert.equal(recorded?.reason, "recovery_unresolved: An earlier installation could not be recovered.");
    assert.equal(projectComputerUpgradeRequest(recorded!).state, "pending", "the web keeps it in progress");
    assert.equal(projectComputerUpgradeRequest(recorded!).failureHint, null);

    // The same receipt through computer:upgrade:done (what the daemon sends today).
    const refused = await settleRefusedComputerUpgradeRequest({
      machineId,
      requestId: row.id,
      reason: "UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.",
      code: "upgrade_installer_failed",
      observedVersion: "1.0.63",
      now: new Date(now.getTime() + 90_000),
    });
    assert.equal(refused?.outcome, null, "upgrade:done does not settle it either");
    assert.equal(refused?.reason, "recovery_unresolved: UPGRADE_INSTALLER_FAILED: An earlier installation could not be recovered.");

    const done = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.64", now: new Date(now.getTime() + 300_000) });
    assert.equal(done?.id, row.id);
    assert.equal(done?.outcome, "done");
    assert.equal(done?.reason, null);
    assert.deepEqual(await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime())), [], "nothing left to expire");
  } finally {
    await closeTestDatabase();
  }
});

test("an unresolved receipt with no success by the deadline settles failed with its reason; other refusals still settle at once", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.64", requestedByUserId: userId, now });
    const recorded = await settleRefusedComputerUpgradeRequest({ machineId, requestId: row.id, reason: "x", code: "recovery_unresolved", observedVersion: "1.0.63", now });
    assert.equal(recorded?.outcome, null);
    assert.deepEqual(await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime() - 1)), []);
    const expired = await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime()));
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.id, row.id);
    assert.equal(expired[0]!.outcome, "failed", "not no_response");
    assert.equal(expired[0]!.reason, "recovery_unresolved: x");
    assert.equal(expired[0]!.observedVersion, "1.0.63");
    assert.equal(projectComputerUpgradeRequest(expired[0]!).state, "failed");

    // A failure that is not `unresolved` is not held back.
    const second = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.65", requestedByUserId: userId, now: new Date(row.deadlineAt.getTime() + 1) });
    const rolledBack = await settleRefusedComputerUpgradeRequest({ machineId, requestId: second.row.id, reason: "UPGRADE_INSTALLER_FAILED: download checksum mismatch", code: "upgrade_installer_failed" });
    assert.equal(rolledBack?.outcome, "failed");
    assert.equal(rolledBack?.reason, "UPGRADE_INSTALLER_FAILED: download checksum mismatch");
    // No classifiable text: `other`, whatever code the Computer sent (that stays in `code`).
    assert.equal(computerUpgradeRequestTraceAttrs(rolledBack!).reason_code, "other");
    assert.equal(computerUpgradeRequestTraceAttrs(expired[0]!).reason_code, "recovery_unresolved");
  } finally {
    await closeTestDatabase();
  }
});

test("after a deadline failed from an unresolved receipt, the target version connecting within the window settles succeeded_late, once", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.64", requestedByUserId: userId, now });
    await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.63", receipt: UNRESOLVED_RECEIPT, now });
    const deadline = row.deadlineAt.getTime();
    assert.equal((await expireComputerUpgradeRequests(new Date(deadline)))[0]?.outcome, "failed");

    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.63", now: new Date(deadline + 60_000) }), null, "still the old version");
    const late = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.64", now: new Date(deadline + 600_000) });
    assert.equal(late?.id, row.id);
    assert.equal(late?.outcome, "succeeded_late");
    assert.equal(late?.reason, "late_after_deadline");
    assert.equal(late?.observedVersion, "1.0.64");
    assert.equal(late && "replacedOutcome" in late ? late.replacedOutcome : null, "failed");
    assert.equal(computerUpgradeRequestTraceAttrs(late!).outcome, "succeeded_late");
    assert.equal(computerUpgradeRequestTraceAttrs(late!).late_ms, 600_000);
    assert.equal(projectComputerUpgradeRequest(late!).failureHint, null);
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.64", now: new Date(deadline + 700_000) }), null, "settled once");

    // A failure that was not an unresolved receipt stays failed.
    const second = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.65", requestedByUserId: userId, now: new Date(deadline + 800_000) });
    await settleRefusedComputerUpgradeRequest({ machineId, requestId: second.row.id, reason: "download checksum mismatch", now: new Date(deadline + 800_000) });
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.65", now: new Date(second.row.deadlineAt.getTime() + 60_000) }), null);
  } finally {
    await closeTestDatabase();
  }
});

// c85f4355 (#proj-raft-computer:#94): the drain finished, the installer ran
// and left no receipt, and the old Computer came back on its old version.
test("after the drain finished, the old version coming back with no receipt is recorded, and the deadline settles it failed: no result from the installer", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.69", requestedByUserId: userId, now });
    assert.equal((await recordComputerUpgradeDrainFinished({ machineId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", requestId: row.id })), null, "only the machine's own request");
    const marked = await recordComputerUpgradeDrainFinished({ machineId, requestId: row.id });
    assert.equal(marked?.reason, "drain_finished");
    assert.equal(marked?.outcome, null);
    assert.equal(projectComputerUpgradeRequest(marked!).reason, null, "the internal marker is never shown as a reason");

    const recorded = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.68", now: new Date(now.getTime() + 11 * 60_000) });
    assert.equal(recorded?.id, row.id);
    assert.equal(recorded?.outcome, null, "not settled early: a healthy installer keeps the old service up for minutes");
    assert.equal(recorded?.reason, "installer_left_no_result: Raft Computer came back on 1.0.68 without a result from the installer.");
    assert.equal(recorded?.observedVersion, "1.0.68");
    assert.equal(projectComputerUpgradeRequest(recorded!).state, "pending");
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.68", now: new Date(now.getTime() + 12 * 60_000) }), null, "recorded once");

    assert.deepEqual(await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime() - 1)), []);
    const expired = await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime()));
    assert.equal(expired.length, 1);
    assert.equal(expired[0]!.outcome, "failed", "not no_response: the machine did come back");
    assert.equal(expired[0]!.reason, "installer_left_no_result: Raft Computer came back on 1.0.68 without a result from the installer.");
    assert.equal(expired[0]!.autoRetryFailureCode, null);
    assert.equal(projectComputerUpgradeRequest(expired[0]!).failureHint, null);
    assert.equal(computerUpgradeRequestTraceAttrs(expired[0]!).reason_code, "installer_left_no_result");
  } finally {
    await closeTestDatabase();
  }
});

test("a recorded \"no result from the installer\" still becomes succeeded_late when the target version comes after the deadline", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.69", requestedByUserId: userId, now });
    await recordComputerUpgradeDrainFinished({ machineId, requestId: row.id });
    await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.68", now: new Date(now.getTime() + 60_000) });
    const deadline = row.deadlineAt.getTime();
    assert.equal((await expireComputerUpgradeRequests(new Date(deadline)))[0]?.outcome, "failed");

    // Past the shorter unresolved window: this one keeps the no_response window it replaces.
    const lateAt = deadline + UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS + 60_000;
    const late = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.69", now: new Date(lateAt) });
    assert.equal(late?.id, row.id);
    assert.equal(late?.outcome, "succeeded_late");
    assert.equal(late?.reason, "late_after_deadline");
    assert.equal(late && "replacedOutcome" in late ? late.replacedOutcome : null, "failed");

    // The upper bound: past UPGRADE_REQUEST_LATE_SETTLE_MS after the deadline it stays failed.
    const second = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.70", requestedByUserId: userId, now: new Date(lateAt) });
    await recordComputerUpgradeDrainFinished({ machineId, requestId: second.row.id });
    await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.69", now: new Date(lateAt + 60_000) });
    const secondDeadline = second.row.deadlineAt.getTime();
    assert.equal((await expireComputerUpgradeRequests(new Date(secondDeadline)))[0]?.outcome, "failed");
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.70", now: new Date(secondDeadline + UPGRADE_REQUEST_LATE_SETTLE_MS + 1_000) }), null);
    const [kept] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, second.row.id));
    assert.equal(kept!.outcome, "failed");
    assert.equal(kept!.reason, "installer_left_no_result: Raft Computer came back on 1.0.69 without a result from the installer.");
  } finally {
    await closeTestDatabase();
  }
});

test("later evidence before the deadline replaces a recorded \"no result from the installer\"", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    let at = now.getTime();
    const recordedRequest = async (targetVersion: string) => {
      const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion, requestedByUserId: userId, now: new Date(at) });
      await recordComputerUpgradeDrainFinished({ machineId, requestId: row.id });
      const recorded = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.68", now: new Date(at + 60_000) });
      assert.match(recorded?.reason ?? "", /^installer_left_no_result: /);
      return row;
    };

    // The target version comes: done.
    const reached = await recordedRequest("1.0.69");
    const done = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.69", now: new Date(at + 120_000) });
    assert.deepEqual([done?.id, done?.outcome, done?.reason], [reached.id, "done", null]);

    // A receipt comes: it settles with its own reason.
    at = reached.deadlineAt.getTime() + UPGRADE_REQUEST_REVERT_WINDOW_MS + 1;
    const receipted = await recordedRequest("1.0.70");
    const failed = await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.68",
      receipt: { targetVersion: "1.0.70", outcome: "rolled_back", reason: "Raft Computer 1.0.70 didn't start correctly." },
      now: new Date(at + 120_000),
    });
    assert.deepEqual([failed?.id, failed?.outcome, failed?.reason], [receipted.id, "failed", "Raft Computer 1.0.70 didn't start correctly."]);

    // An unresolved receipt comes: recorded in its place; the deadline settles it as unresolved.
    at = receipted.deadlineAt.getTime() + 1;
    const unresolved = await recordedRequest("1.0.71");
    const held = await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.68",
      receipt: { targetVersion: "1.0.71", outcome: "unresolved", reason: "An earlier installation could not be recovered." },
      now: new Date(at + 120_000),
    });
    assert.deepEqual([held?.id, held?.outcome, held?.reason], [unresolved.id, null, "recovery_unresolved: An earlier installation could not be recovered."]);
    const expired = await expireComputerUpgradeRequests(new Date(unresolved.deadlineAt.getTime()));
    assert.deepEqual(expired.map((each) => [each.id, each.outcome, computerUpgradeRequestTraceAttrs(each).reason_code]), [[unresolved.id, "failed", "recovery_unresolved"]]);
  } finally {
    await closeTestDatabase();
  }
});

test("the version in a recorded \"no result from the installer\" is only a Computer semver", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    let at = now.getTime();
    for (const reported of ["1.0.68\u0007\nrm -rf /", `1.0.${"9".repeat(80)}`, "not-a-version"]) {
      const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.69", requestedByUserId: userId, now: new Date(at) });
      await recordComputerUpgradeDrainFinished({ machineId, requestId: row.id });
      const recorded = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: reported, now: new Date(at + 60_000) });
      assert.equal(recorded?.reason, "installer_left_no_result: Raft Computer came back on its old version without a result from the installer.", JSON.stringify(reported));
      await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime()));
      at = row.deadlineAt.getTime() + 1;
    }
  } finally {
    await closeTestDatabase();
  }
});

test("without a finished drain the old version coming back records nothing and the deadline stays no_response; a receipt still decides", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    // Never got to the installer: no drain marker.
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.69", requestedByUserId: userId, now });
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.68", now: new Date(now.getTime() + 60_000) }), null);
    const expired = await expireComputerUpgradeRequests(new Date(row.deadlineAt.getTime()));
    assert.deepEqual(expired.map((each) => [each.outcome, each.reason]), [["no_response", "no_reconnect_before_deadline"]]);

    // Drain finished but the Computer never came back: no_response too.
    const silent = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.69", requestedByUserId: userId, now: new Date(row.deadlineAt.getTime() + 1) });
    await recordComputerUpgradeDrainFinished({ machineId, requestId: silent.row.id });
    const silentExpired = await expireComputerUpgradeRequests(new Date(silent.row.deadlineAt.getTime()));
    assert.deepEqual(silentExpired.map((each) => [each.outcome, each.reason]), [["no_response", "no_reconnect_before_deadline"]]);

    // Drain finished, then a receipt: the receipt settles it as before.
    const withReceipt = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.69", requestedByUserId: userId, now: new Date(silent.row.deadlineAt.getTime() + 1) });
    await recordComputerUpgradeDrainFinished({ machineId, requestId: withReceipt.row.id });
    const settled = await observeComputerVersionForUpgradeRequests({
      machineId,
      reportedVersion: "1.0.68",
      receipt: { targetVersion: "1.0.69", outcome: "rolled_back", reason: "Raft Computer 1.0.69 didn't start correctly." },
      now: new Date(withReceipt.row.requestedAt.getTime() + 60_000),
    });
    assert.equal(settled?.outcome, "failed");
    assert.equal(settled?.reason, "Raft Computer 1.0.69 didn't start correctly.");
  } finally {
    await closeTestDatabase();
  }
});

test("after a deadline failed from an unresolved receipt, the target version connecting outside the window changes nothing", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.64", requestedByUserId: userId, now });
    await settleRefusedComputerUpgradeRequest({ machineId, requestId: row.id, reason: "An earlier installation could not be recovered.", code: "upgrade_installer_failed", now });
    const deadline = row.deadlineAt.getTime();
    assert.equal((await expireComputerUpgradeRequests(new Date(deadline)))[0]?.outcome, "failed");
    assert.equal(
      await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.64", now: new Date(deadline + UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS + 1_000) }),
      null,
    );
    const [kept] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, row.id));
    assert.equal(kept!.outcome, "failed");
    assert.equal(kept!.reason, "recovery_unresolved: An earlier installation could not be recovered.");
  } finally {
    await closeTestDatabase();
  }
});

test("an older version reconnecting within the window after succeeded_late reverts it to failed, like done", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.64", requestedByUserId: userId, now });
    await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.63", receipt: UNRESOLVED_RECEIPT, now });
    const deadline = row.deadlineAt.getTime();
    await expireComputerUpgradeRequests(new Date(deadline));
    const lateAt = new Date(deadline + 600_000);
    assert.equal((await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.64", now: lateAt }))?.outcome, "succeeded_late");
    const reverted = await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.63", now: new Date(lateAt.getTime() + 60_000) });
    assert.equal(reverted?.id, row.id);
    assert.equal(reverted?.outcome, "failed");
    assert.equal(reverted?.reason, "reverted_after_upgrade: 1.0.63");
    // Once: the target connecting again does not lift a revert.
    assert.equal(await observeComputerVersionForUpgradeRequests({ machineId, reportedVersion: "1.0.64", now: new Date(lateAt.getTime() + 120_000) }), null);
    const [stored] = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.id, row.id));
    assert.equal(stored!.outcome, "failed");
  } finally {
    await closeTestDatabase();
  }
});

// ---------------------------------------------------------------------------
// One automatic retry after a download-step failure (UPGRADE_AUTO_RETRY_FAILURE_CODES).
// ---------------------------------------------------------------------------

test("upgradeAutoRetryFailureCode: only the allow-listed download-step codes qualify, from the structured report", () => {
  // Each allow-listed code, as each transport delivers it.
  const qualifying: Array<[Parameters<typeof upgradeAutoRetryFailureCode>[0], string]> = [
    // Computer: installer release lookup at hands.build (externalInstaller.ts installerCommand), done code computer_control_failed.
    [{ via: "upgrade_done", code: "computer_control_failed", reason: "installer_release_unavailable: TimeoutError" }, "installer_release_unavailable"],
    [{ via: "upgrade_done", code: "computer_control_failed", reason: "installer_release_unavailable: HTTP 503 after 3 attempts" }, "installer_release_unavailable"],
    // Computer: installer download (externalInstaller.ts download).
    [{ via: "upgrade_done", code: "computer_control_failed", reason: "installer_download_failed: TimeoutError" }, "installer_download_failed"],
    [{ via: "upgrade_done", code: "computer_control_failed", reason: "installer_download_failed: ECONNRESET after 3 attempts" }, "installer_download_failed"],
    // Installer: Computer artifact download, relayed by the runner (service.ts `UPGRADE_INSTALLER_FAILED: <reason>`).
    [{ via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: DOWNLOAD_FAILED: idle timeout" }, "DOWNLOAD_FAILED"],
    [{ via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: DOWNLOAD_FAILED: overall timeout" }, "DOWNLOAD_FAILED"],
    // Installer: the same receipt carried on the next `ready`.
    [{ via: "receipt", outcome: "failed", reason: "DOWNLOAD_FAILED: idle timeout" }, "DOWNLOAD_FAILED"],
    // Installer receipt as fixed fields (Computers from the fixed-fields change on).
    [{ via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: The requested Raft Computer release could not be resolved.", installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" } }, "release_resolution_failed"],
    // raft-computer-installer#85: a stalled artifact download, its own receipt code.
    [{ via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.", installer: { installerOutcome: "failed", installerCode: "download_stalled" } }, "download_stalled"],
  ];
  for (const [input, code] of qualifying) assert.equal(upgradeAutoRetryFailureCode(input), code, JSON.stringify(input));
  assert.deepEqual(new Set(qualifying.map(([, code]) => code)), new Set(UPGRADE_AUTO_RETRY_FAILURE_CODES));

  const notQualifying: Array<Parameters<typeof upgradeAutoRetryFailureCode>[0]> = [
    // Unknown codes, in the same step or elsewhere.
    { via: "upgrade_done", code: "computer_control_failed", reason: "installer_checksum_mismatch" },
    { via: "upgrade_done", code: "computer_control_failed", reason: "installer_download_too_large" },
    { via: "upgrade_done", code: "computer_control_failed", reason: "installer_launch_failed: spawn EBADF (2 attempts)" },
    { via: "upgrade_done", code: "computer_control_failed", reason: "SOMETHING_NEW: download timed out" },
    { via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: VERIFY_FAILED: digest" },
    // Missing step/code.
    { via: "upgrade_done", code: null, reason: "installer_download_failed: TimeoutError" },
    { via: "upgrade_done", code: "computer_control_failed", reason: null },
    { via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: installer_failed" },
    { via: "receipt", outcome: "failed", reason: null },
    // Free text is not a code: the phrase inside, or the installer's version-lookup sentence.
    { via: "upgrade_done", code: "computer_control_failed", reason: "The upgrade failed: installer_download_failed: TimeoutError" },
    { via: "receipt", outcome: "failed", reason: "Could not upgrade: the release server could not be reached. Nothing changed." },
    { via: "receipt", outcome: "failed", reason: "version lookup could not reach hands.build" },
    // A start failure / rollback / held / unresolved: something changed or the installer held it.
    { via: "upgrade_done", code: "upgrade_rolled_back", reason: "DOWNLOAD_FAILED: idle timeout" },
    { via: "upgrade_done", code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: Raft Computer 1.0.60 didn't start correctly." },
    { via: "receipt", outcome: "rolled_back", reason: "DOWNLOAD_FAILED: idle timeout" },
    { via: "receipt", outcome: "rolled_back", reason: "Raft Computer 1.0.60 didn't start correctly." },
    { via: "receipt", outcome: "held", reason: "DOWNLOAD_FAILED: idle timeout" },
    { via: "receipt", outcome: "unresolved", reason: "DOWNLOAD_FAILED: idle timeout" },
    // Refusals before the installer.
    { via: "upgrade_done", code: "upgrade_start_rejected", reason: "installer_download_failed: TimeoutError" },
    { via: "upgrade_done", code: "control_busy", reason: "CONTROL_BUSY: x" },
  ];
  for (const input of notQualifying) assert.equal(upgradeAutoRetryFailureCode(input), null, JSON.stringify(input));
});

// The installer receipt's outcome and codes as fixed fields
// (computer:upgrade:done installerOutcome / installerCode /
// installerDiagnosticCode, ready.lastUpgradeReceipt code / diagnosticCode).
// Codes as raft-computer-installer 0.4.2 writes them (rust/report.rs
// FailureCode; rust/operation.rs: a release lookup failure is
// `release_resolution_failed`, a download the engine failed is
// `install_failed` with the engine's `DOWNLOAD_FAILED: …` in detail.diagnostic).
test("upgradeAutoRetryFailureCode: the installer's fixed fields decide when present", () => {
  const relayed = (reason: string) => ({ via: "upgrade_done" as const, code: "upgrade_installer_failed", reason: `UPGRADE_INSTALLER_FAILED: ${reason}` });
  // Each allow-listed installer code, on both transports.
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("The requested Raft Computer release could not be resolved."), installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" } }), "release_resolution_failed");
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("The network redirected the release request to another host."), installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" } }), "release_resolution_failed");
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("Raft Computer could not be upgraded to 1.0.60."), installer: { installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED" } }), "DOWNLOAD_FAILED");
  assert.equal(upgradeAutoRetryFailureCode({ via: "receipt", outcome: "failed", reason: "The requested Raft Computer release could not be resolved.", installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" } }), "release_resolution_failed");
  assert.equal(upgradeAutoRetryFailureCode({ via: "receipt", outcome: "failed", reason: "Raft Computer could not be upgraded to 1.0.60.", installer: { installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED" } }), "DOWNLOAD_FAILED");
  // The late-receipt path: no prefix on the text, the fields still decide.
  assert.equal(upgradeAutoRetryFailureCode({ via: "upgrade_done", code: "upgrade_installer_failed", reason: "The requested Raft Computer release could not be resolved.", installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" } }), "release_resolution_failed");
  // raft-computer-installer#85: a stalled download, with the engine's diagnostic or without one, on both transports.
  const stalled = "The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.";
  for (const installer of [
    { installerOutcome: "failed", installerCode: "download_stalled", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    { installerOutcome: "failed", installerCode: "download_stalled" },
  ] as const) {
    assert.equal(upgradeAutoRetryFailureCode({ ...relayed(stalled), installer }), "download_stalled", JSON.stringify(installer));
    assert.equal(upgradeAutoRetryFailureCode({ via: "receipt", outcome: "failed", reason: stalled, installer }), "download_stalled", JSON.stringify(installer));
  }
  // An older Computer relays only the text: not retried, as before.
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed(stalled), installer: null }), null);

  const none: Array<ComputerUpgradeInstallerReport> = [
    // Not `failed`: a rolled_back / held / unresolved receipt, whatever the codes.
    { installerOutcome: "rolled_back", installerCode: "release_resolution_failed" },
    { installerOutcome: "rolled_back", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    { installerOutcome: "unresolved", installerCode: "download_stalled", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    { installerOutcome: "held", installerCode: "installation_held", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    { installerOutcome: "unresolved", installerCode: "recovery_unresolved", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    // `install_failed` that is not a download: verify or prepare.
    { installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "SHA256_MISMATCH" },
    { installerOutcome: "failed", installerCode: "install_failed" },
    // Unknown or other installer codes; no code at all (the Computer's own refusal receipt).
    { installerOutcome: "failed", installerCode: "something_new", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    { installerOutcome: "failed", installerCode: "candidate_start_failed" },
    { installerOutcome: "failed", installerCode: "downgrade_not_allowed" },
    { installerOutcome: "failed", installerDiagnosticCode: "DOWNLOAD_FAILED" },
    { installerOutcome: "failed" },
  ];
  for (const installer of none) {
    assert.equal(upgradeAutoRetryFailureCode({ ...relayed("Raft Computer could not be upgraded to 1.0.60."), installer }), null, JSON.stringify(installer));
    assert.equal(upgradeAutoRetryFailureCode({ via: "receipt", outcome: "failed", reason: "x", installer }), null, JSON.stringify(installer));
  }
  // With the fields, the text no longer decides: a rolled_back receipt whose reason starts with DOWNLOAD_FAILED.
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("DOWNLOAD_FAILED: idle timeout"), installer: { installerOutcome: "rolled_back", installerCode: "candidate_start_failed" } }), null);
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("DOWNLOAD_FAILED: idle timeout"), installer: { installerOutcome: "failed", installerCode: "install_failed" } }), null);
  // Absent (older Computers): the text decides as before.
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("DOWNLOAD_FAILED: idle timeout"), installer: null }), "DOWNLOAD_FAILED");
  assert.equal(upgradeAutoRetryFailureCode({ ...relayed("The requested Raft Computer release could not be resolved.") }), null);
});

const otherMachineId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

async function failedDownloadRequest(serverId: string, userId: string, at: Date = now): Promise<ComputerUpgradeRequestRow> {
  const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now: at });
  const failed = await settleRefusedComputerUpgradeRequest({
    machineId,
    requestId: row.id,
    code: "computer_control_failed",
    reason: "installer_download_failed: TimeoutError",
    observedVersion: "1.0.59",
    now: new Date(at.getTime() + 60_000),
  });
  assert.ok(failed);
  return failed;
}

function retryDeps(overrides: Partial<ComputerUpgradeAutoRetryDeps> = {}) {
  const sent: Array<{ machineId: string; targetVersion: string; requestId: string }> = [];
  const deps: ComputerUpgradeAutoRetryDeps = {
    readComputerVersion: async () => "1.0.59",
    checkTarget: async () => "offered",
    controlRefusal: async () => null,
    drainMs: async () => null,
    send: async (machineId, targetVersion, requestId) => { sent.push({ machineId, targetVersion, requestId }); return true; },
    ...overrides,
  };
  return { deps, sent };
}

test("a download-step failure schedules one retry, shown on the request; other failures schedule none", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const failed = await failedDownloadRequest(serverId, userId);
    assert.equal(failed.outcome, "failed");
    assert.equal(failed.autoRetryFailureCode, "installer_download_failed");
    assert.equal(failed.autoRetryDueAt?.getTime(), failed.resolvedAt!.getTime() + UPGRADE_AUTO_RETRY_DELAY_MS);
    // Visible: the web shows the failure and that Raft tries once more.
    assert.deepEqual(projectComputerUpgradeRequest(failed).autoRetry, { state: "scheduled", dueAt: failed.autoRetryDueAt!.toISOString() });
    assert.equal(computerUpgradeRequestTraceAttrs(failed).auto_retry_failure_code, "installer_download_failed");

    // The installer's DOWNLOAD_FAILED on the next ready's receipt schedules too.
    const viaReceipt = await createComputerUpgradeRequest({ serverId, machineId: otherMachineId, targetVersion: "1.0.60", requestedByUserId: userId, now });
    const settled = await observeComputerVersionForUpgradeRequests({
      machineId: otherMachineId, reportedVersion: "1.0.59", now,
      receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "DOWNLOAD_FAILED: overall timeout" },
    });
    assert.equal(settled?.autoRetryFailureCode, "DOWNLOAD_FAILED");
    assert.ok(settled?.autoRetryDueAt);
    assert.equal(settled?.id, viaReceipt.row.id);
  } finally {
    await closeTestDatabase();
  }
});

test("no retry for an unknown code, a missing code, a start failure or a rollback", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const cases: Array<{ code?: string | null; reason: string }> = [
      { code: "computer_control_failed", reason: "installer_checksum_mismatch" },
      { code: null, reason: "installer_download_failed: TimeoutError" },
      { code: "upgrade_installer_failed", reason: "UPGRADE_INSTALLER_FAILED: Raft Computer 1.0.60 didn't start correctly." },
      { code: "upgrade_rolled_back", reason: "Raft Computer 1.0.60 didn't start correctly." },
    ];
    let i = 0;
    for (const input of cases) {
      const machine = `dddddddd-dddd-4ddd-8ddd-${String(i++).padStart(12, "0")}`;
      const { row } = await createComputerUpgradeRequest({ serverId, machineId: machine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      const failed = await settleRefusedComputerUpgradeRequest({ machineId: machine, requestId: row.id, ...input, now });
      assert.equal(failed?.outcome, "failed");
      assert.equal(failed?.autoRetryFailureCode, null, JSON.stringify(input));
      assert.equal(failed?.autoRetryDueAt, null);
      assert.equal(projectComputerUpgradeRequest(failed!).autoRetry, undefined);
    }
    // A rolled-back receipt on reconnect.
    const { row } = await createComputerUpgradeRequest({ serverId, machineId: otherMachineId, targetVersion: "1.0.60", requestedByUserId: userId, now });
    const rolled = await observeComputerVersionForUpgradeRequests({
      machineId: otherMachineId, reportedVersion: "1.0.59", now,
      receipt: { targetVersion: "1.0.60", outcome: "rolled_back", reason: "Raft Computer 1.0.60 didn't start correctly." },
    });
    assert.equal(rolled?.id, row.id);
    assert.equal(rolled?.autoRetryDueAt, null);
  } finally {
    await closeTestDatabase();
  }
});

test("computer:upgrade:done with the installer's fixed fields: the allow-listed codes schedule, the rest and malformed values do not", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const cases: Array<{ name: string; reason: string; code?: string; installer?: Record<string, unknown> | null; expect: string | null }> = [
      // 77ce1c3a's class: the installer's own version lookup, relayed by the launching runner.
      { name: "release lookup", reason: "UPGRADE_INSTALLER_FAILED: The requested Raft Computer release could not be resolved.", installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" }, expect: "release_resolution_failed" },
      // 0bb758f3 / e8cda16b / e61f18bc's class: the engine's artifact download, `install_failed` + DOWNLOAD_FAILED.
      { name: "artifact download", reason: "UPGRADE_INSTALLER_FAILED: Raft Computer could not be upgraded to 1.0.60.", installer: { installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED" }, expect: "DOWNLOAD_FAILED" },
      // The late-receipt path: no prefix.
      { name: "late receipt", reason: "The requested Raft Computer release could not be resolved.", installer: { installerOutcome: "failed", installerCode: "release_resolution_failed" }, expect: "release_resolution_failed" },
      // A rolled_back receipt whose reason happens to start with DOWNLOAD_FAILED.
      { name: "rolled back", reason: "UPGRADE_INSTALLER_FAILED: DOWNLOAD_FAILED: idle timeout", installer: { installerOutcome: "rolled_back", installerCode: "candidate_start_failed" }, expect: null },
      { name: "unknown code", reason: "UPGRADE_INSTALLER_FAILED: DOWNLOAD_FAILED: idle timeout", installer: { installerOutcome: "failed", installerCode: "brand_new_code", installerDiagnosticCode: "DOWNLOAD_FAILED" }, expect: null },
      // Absent: an older Computer, the text decides as before.
      { name: "absent, legacy text", reason: "UPGRADE_INSTALLER_FAILED: DOWNLOAD_FAILED: idle timeout", installer: null, expect: "DOWNLOAD_FAILED" },
      { name: "absent, free text", reason: "UPGRADE_INSTALLER_FAILED: The requested Raft Computer release could not be resolved.", expect: null },
      // Malformed: an outcome outside the closed set is ignored as a whole (the text decides, as for an older Computer).
      { name: "malformed outcome", reason: "UPGRADE_INSTALLER_FAILED: DOWNLOAD_FAILED: idle timeout", installer: { installerOutcome: "FAILED", installerCode: "release_resolution_failed" }, expect: "DOWNLOAD_FAILED" },
      { name: "malformed outcome type", reason: "UPGRADE_INSTALLER_FAILED: x", installer: { installerOutcome: { failed: true }, installerCode: "release_resolution_failed" }, expect: null },
      // Malformed codes are dropped: no allow-listed code, no retry.
      { name: "code with text", reason: "UPGRADE_INSTALLER_FAILED: x", installer: { installerOutcome: "failed", installerCode: "release_resolution_failed: the server said no" }, expect: null },
      { name: "code upper case", reason: "UPGRADE_INSTALLER_FAILED: x", installer: { installerOutcome: "failed", installerCode: "RELEASE_RESOLUTION_FAILED" }, expect: null },
      { name: "code too long", reason: "UPGRADE_INSTALLER_FAILED: x", installer: { installerOutcome: "failed", installerCode: `install_failed${"_x".repeat(40)}` }, expect: null },
      { name: "diagnostic with text", reason: "UPGRADE_INSTALLER_FAILED: x", installer: { installerOutcome: "failed", installerCode: "install_failed", installerDiagnosticCode: "DOWNLOAD_FAILED: idle timeout" }, expect: null },
      { name: "code not a string", reason: "UPGRADE_INSTALLER_FAILED: x", installer: { installerOutcome: "failed", installerCode: ["release_resolution_failed"] }, expect: null },
    ];
    let i = 0;
    for (const input of cases) {
      const machine = `eeeeeeee-eeee-4eee-8eee-${String(i++).padStart(12, "0")}`;
      const { row } = await createComputerUpgradeRequest({ serverId, machineId: machine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      const failed = await settleRefusedComputerUpgradeRequest({
        machineId: machine,
        requestId: row.id,
        code: input.code ?? "upgrade_installer_failed",
        reason: input.reason,
        installer: input.installer ?? null,
        now,
      });
      assert.equal(failed?.outcome, "failed", input.name);
      assert.equal(failed?.reason, input.reason, `${input.name}: the stored reason is the text, unchanged`);
      assert.equal(failed?.autoRetryFailureCode, input.expect, input.name);
      assert.equal(Boolean(failed?.autoRetryDueAt), input.expect !== null, input.name);
    }

    // An `unresolved` outcome is recorded on the still-open request, whatever the text says.
    const unresolvedMachine = "eeeeeeee-eeee-4eee-8eee-ffffffffffff";
    const { row: open } = await createComputerUpgradeRequest({ serverId, machineId: unresolvedMachine, targetVersion: "1.0.60", requestedByUserId: userId, now });
    const recorded = await settleRefusedComputerUpgradeRequest({
      machineId: unresolvedMachine,
      requestId: open.id,
      code: "upgrade_installer_failed",
      reason: "UPGRADE_INSTALLER_FAILED: The installation could not finish.",
      installer: { installerOutcome: "unresolved", installerCode: "recovery_unresolved" },
      now,
    });
    assert.equal(recorded?.outcome, null);
    assert.equal(recorded?.autoRetryFailureCode, null);
  } finally {
    await closeTestDatabase();
  }
});

// Behaviour change: an exit-3 (`unresolved`) receipt whose reason is not one
// of UNRESOLVED_RECEIPT_TEXTS was settled failed at once; with
// installerOutcome it is held open until the deadline, as the `ready` path
// already holds any unresolved receipt. Reasons from raft-computer-installer
// rust/operation.rs (:1404, :1442, recovery_hint_copy :364-382).
test("computer:upgrade:done with installerOutcome unresolved holds the request open whatever the reason; without it, as before", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const reasons = [
      "An earlier upgrade could not be recovered yet.",
      "The installation requires repair.",
      "Raft Computer 1.0.59 is running.",
    ];
    let i = 0;
    for (const text of reasons) {
      const reason = `UPGRADE_INSTALLER_FAILED: ${text}`;
      const machine = `abababab-abab-4bab-8bab-${String(i++).padStart(12, "0")}`;
      const { row } = await createComputerUpgradeRequest({ serverId, machineId: machine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      const held = await settleRefusedComputerUpgradeRequest({
        machineId: machine,
        requestId: row.id,
        code: "upgrade_installer_failed",
        reason,
        installer: { installerOutcome: "unresolved", installerCode: "recovery_unresolved" },
        now,
      });
      assert.equal(held?.outcome, null, `${text}: held open`);
      assert.equal(held?.reason, `recovery_unresolved: ${reason}`);
      assert.equal(held?.autoRetryFailureCode, null);
      assert.equal(held?.autoRetryDueAt, null);
      // The person cannot start another upgrade meanwhile: the open request is returned.
      const again = await createComputerUpgradeRequest({ serverId, machineId: machine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      assert.equal(again.created, false);
      assert.equal(again.row.id, row.id);

      // The same report from an older Computer (no fields) fails at once, as before.
      const oldMachine = `cdcdcdcd-cdcd-4dcd-8dcd-${String(i).padStart(12, "0")}`;
      const { row: old } = await createComputerUpgradeRequest({ serverId, machineId: oldMachine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      const failed = await settleRefusedComputerUpgradeRequest({ machineId: oldMachine, requestId: old.id, code: "upgrade_installer_failed", reason, now });
      assert.equal(failed?.outcome, "failed", `${text}: older Computer`);
      assert.equal(failed?.autoRetryFailureCode, null);
    }
  } finally {
    await closeTestDatabase();
  }
});

test("ready receipt with the installer's code: the fields decide; without a code, the text decides as before", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const cases: Array<{ receipt: ComputerLastUpgradeReceipt; expect: string | null }> = [
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "The requested Raft Computer release could not be resolved.", code: "release_resolution_failed" }, expect: "release_resolution_failed" },
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "Raft Computer could not be upgraded to 1.0.60.", code: "install_failed", diagnosticCode: "DOWNLOAD_FAILED" }, expect: "DOWNLOAD_FAILED" },
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "Raft Computer could not be upgraded to 1.0.60.", code: "install_failed", diagnosticCode: "SHA256_MISMATCH" }, expect: null },
      // raft-computer-installer#85: a stalled download, with or without the engine's diagnostic.
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.", code: "download_stalled", diagnosticCode: "DOWNLOAD_FAILED" }, expect: "download_stalled" },
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.", code: "download_stalled" }, expect: "download_stalled" },
      // The code decides over a text that would have matched.
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "DOWNLOAD_FAILED: idle timeout", code: "install_failed" }, expect: null },
      { receipt: { targetVersion: "1.0.60", outcome: "rolled_back", reason: "DOWNLOAD_FAILED: idle timeout", code: "candidate_start_failed" }, expect: null },
      // Without a (valid) code: as before.
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "DOWNLOAD_FAILED: idle timeout" }, expect: "DOWNLOAD_FAILED" },
      { receipt: { targetVersion: "1.0.60", outcome: "failed", reason: "DOWNLOAD_FAILED: idle timeout", code: "Not A Code" }, expect: "DOWNLOAD_FAILED" },
    ];
    let i = 0;
    for (const { receipt, expect } of cases) {
      const machine = `ffffffff-ffff-4fff-8fff-${String(i++).padStart(12, "0")}`;
      await createComputerUpgradeRequest({ serverId, machineId: machine, targetVersion: "1.0.60", requestedByUserId: userId, now });
      const settled = await observeComputerVersionForUpgradeRequests({ machineId: machine, reportedVersion: "1.0.59", now, receipt });
      assert.equal(settled?.outcome, "failed", JSON.stringify(receipt));
      assert.equal(settled?.autoRetryFailureCode, expect, JSON.stringify(receipt));
    }
  } finally {
    await closeTestDatabase();
  }
});

test("the due retry is claimed exactly once: two concurrent claimers, one wins; not before it is due", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const failed = await failedDownloadRequest(serverId, userId);
    const early = await claimDueComputerUpgradeAutoRetries([machineId], new Date(failed.autoRetryDueAt!.getTime() - 1));
    assert.equal(early.length, 0);
    const due = new Date(failed.autoRetryDueAt!.getTime() + 1_000);
    const [a, b] = await Promise.all([
      claimDueComputerUpgradeAutoRetries([machineId], due),
      claimDueComputerUpgradeAutoRetries([machineId], due),
    ]);
    assert.equal(a.length + b.length, 1);
    // A later sweep (another replica, a restart) finds nothing.
    assert.equal((await claimDueComputerUpgradeAutoRetries([machineId], new Date(due.getTime() + 60_000))).length, 0);
    // A replica without the machine connected claims nothing.
    assert.equal((await claimDueComputerUpgradeAutoRetries([otherMachineId], due)).length, 0);
  } finally {
    await closeTestDatabase();
  }
});

test("the retry sends the same target once, linked to the failed request and marked automatic; a failed retry schedules no other", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const failed = await failedDownloadRequest(serverId, userId);
    const due = new Date(failed.autoRetryDueAt!.getTime() + 1_000);
    const [claimed] = await claimDueComputerUpgradeAutoRetries([machineId], due);
    const { deps, sent } = retryDeps();
    const outcome = await runClaimedComputerUpgradeAutoRetry(claimed!, deps, due);
    assert.equal(outcome.result, "retried");
    assert.ok(outcome.retry);
    assert.equal(outcome.retry.targetVersion, failed.targetVersion);
    assert.equal(outcome.retry.requestedByUserId, userId);
    assert.equal(outcome.retry.autoRetryOfRequestId, failed.id);
    assert.deepEqual(sent, [{ machineId, targetVersion: "1.0.60", requestId: outcome.retry.id }]);
    // Audit: the retry is marked automatic and links the failed request.
    const attrs = computerUpgradeRequestTraceAttrs(outcome.retry);
    assert.equal(attrs.automatic, 1);
    assert.equal(attrs.auto_retry_of_request_id, failed.id);
    assert.equal(projectComputerUpgradeRequest(outcome.retry).autoRetryOfRequestId, failed.id);
    assert.deepEqual(projectComputerUpgradeRequest(outcome.original!).autoRetry, { state: "retried" });

    // The retry fails at the download again: settled failed, no second retry.
    const again = await settleRefusedComputerUpgradeRequest({
      machineId, requestId: outcome.retry.id, code: "computer_control_failed", reason: "installer_download_failed: TimeoutError", now: due,
    });
    assert.equal(again?.outcome, "failed");
    assert.equal(again?.autoRetryDueAt, null);
    assert.equal(again?.autoRetryFailureCode, null);
    assert.equal(projectComputerUpgradeRequest(again!).autoRetry, undefined);
    assert.equal((await claimDueComputerUpgradeAutoRetries([machineId], new Date(due.getTime() + 2 * UPGRADE_AUTO_RETRY_DELAY_MS))).length, 0);
    // One retry row for the failed request.
    const receiptRetry = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.autoRetryOfRequestId, failed.id));
    assert.equal(receiptRetry.length, 1);
  } finally {
    await closeTestDatabase();
  }
});

// raft-computer-installer#85: a stall used to arrive as `install_failed` +
// DOWNLOAD_FAILED and was retried; as its own receipt code it is retried too.
test("a failed web upgrade whose receipt code is download_stalled gets the one-time retry, classed download_stalled", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const stalled = "The Raft Computer download stopped receiving data. Check this computer's internet connection and try again.";
    const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now });
    const failed = await settleRefusedComputerUpgradeRequest({
      machineId, requestId: row.id, code: "upgrade_installer_failed", reason: `UPGRADE_INSTALLER_FAILED: ${stalled}`,
      installer: { installerOutcome: "failed", installerCode: "download_stalled" }, observedVersion: "1.0.59", now,
    });
    assert.equal(failed?.outcome, "failed");
    assert.equal(failed?.reason, `download_stalled: UPGRADE_INSTALLER_FAILED: ${stalled}`);
    assert.equal(failed?.autoRetryFailureCode, "download_stalled");
    assert.equal(failed?.autoRetryDueAt?.getTime(), failed!.resolvedAt!.getTime() + UPGRADE_AUTO_RETRY_DELAY_MS);
    const attrs = computerUpgradeRequestTraceAttrs(failed!);
    assert.equal(attrs.reason_code, "download_stalled");
    assert.equal(attrs.auto_retry_failure_code, "download_stalled");
    assert.equal(projectComputerUpgradeRequest(failed!).failureHint, null);

    const due = new Date(failed!.autoRetryDueAt!.getTime() + 1_000);
    const [claimed] = await claimDueComputerUpgradeAutoRetries([machineId], due);
    const { deps, sent } = retryDeps();
    const outcome = await runClaimedComputerUpgradeAutoRetry(claimed!, deps, due);
    assert.equal(outcome.result, "retried");
    assert.equal(outcome.retry?.autoRetryOfRequestId, failed!.id);
    assert.deepEqual(sent, [{ machineId, targetVersion: "1.0.60", requestId: outcome.retry!.id }]);

    // The retry stalls again: failed, no second retry.
    const again = await settleRefusedComputerUpgradeRequest({
      machineId, requestId: outcome.retry!.id, code: "upgrade_installer_failed", reason: `UPGRADE_INSTALLER_FAILED: ${stalled}`,
      installer: { installerOutcome: "failed", installerCode: "download_stalled", installerDiagnosticCode: "DOWNLOAD_FAILED" }, now: due,
    });
    assert.equal(again?.outcome, "failed");
    assert.equal(again?.autoRetryFailureCode, null);
    assert.equal(again?.autoRetryDueAt, null);
    assert.equal(computerUpgradeRequestTraceAttrs(again!).reason_code, "download_stalled");
  } finally {
    await closeTestDatabase();
  }
});

test("re-checks at retry time skip, and record why", async () => {
  type Case = { name: string; expect: string; setup?: (ctx: { serverId: string; userId: string; failed: ComputerUpgradeRequestRow }) => Promise<void>; deps?: Partial<ComputerUpgradeAutoRetryDeps> };
  const cases: Case[] = [
    { name: "machine already on the target", expect: "already_on_target", deps: { readComputerVersion: async () => "1.0.60" } },
    { name: "machine on a newer version", expect: "already_on_target", deps: { readComputerVersion: async () => "1.0.61" } },
    {
      name: "another request for the machine after the original",
      expect: "superseded",
      setup: async ({ serverId, userId }) => {
        const { row } = await createComputerUpgradeRequest({ serverId, machineId, targetVersion: "1.0.60", requestedByUserId: userId, now: new Date(now.getTime() + 120_000) });
        await failUndeliveredComputerUpgradeRequest(row.id, now);
      },
    },
    { name: "target no longer offered", expect: "target_withdrawn", deps: { checkTarget: async () => "target_withdrawn" } },
    { name: "policy could not be read now (Hands unavailable)", expect: "policy_unavailable", deps: { checkTarget: async () => "policy_unavailable" } },
    { name: "requester lost control", expect: "not_permitted", deps: { controlRefusal: async () => "not_permitted" } },
    { name: "Computer detached during the wait", expect: "not_a_computer", deps: { controlRefusal: async () => "not_a_computer" } },
  ];
  for (const c of cases) {
    await openTestDatabase("pglite://:memory:");
    try {
      const { userId, serverId } = await seed();
      const failed = await failedDownloadRequest(serverId, userId);
      await c.setup?.({ serverId, userId, failed });
      const due = new Date(failed.autoRetryDueAt!.getTime() + 1_000);
      const [claimed] = await claimDueComputerUpgradeAutoRetries([machineId], due);
      assert.ok(claimed, c.name);
      const { deps, sent } = retryDeps(c.deps);
      const outcome = await runClaimedComputerUpgradeAutoRetry(claimed, deps, due);
      assert.equal(outcome.result, c.expect, c.name);
      assert.equal(outcome.retry, null, c.name);
      assert.deepEqual(sent, [], c.name);
      assert.equal(outcome.original?.autoRetryResult, c.expect, c.name);
      assert.deepEqual(projectComputerUpgradeRequest(outcome.original!).autoRetry, { state: "skipped", skipReason: c.expect }, c.name);
      const retries = await getDb().select().from(computerUpgradeRequests).where(eq(computerUpgradeRequests.autoRetryOfRequestId, failed.id));
      assert.equal(retries.length, 0, c.name);
    } finally {
      await closeTestDatabase();
    }
  }
});

test("a retry whose Computer stays offline past the grace is skipped as computer_offline, once", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const failed = await failedDownloadRequest(serverId, userId);
    const due = failed.autoRetryDueAt!;
    assert.equal((await skipOfflineComputerUpgradeAutoRetries(new Date(due.getTime() + UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS - 1))).length, 0);
    const skipped = await skipOfflineComputerUpgradeAutoRetries(new Date(due.getTime() + UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS));
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.autoRetryResult, "computer_offline");
    assert.equal((await claimDueComputerUpgradeAutoRetries([machineId], new Date(due.getTime() + 2 * UPGRADE_AUTO_RETRY_OFFLINE_GRACE_MS))).length, 0);
  } finally {
    await closeTestDatabase();
  }
});

test("a retry the Computer did not receive is recorded not_delivered, not retried", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const failed = await failedDownloadRequest(serverId, userId);
    const due = new Date(failed.autoRetryDueAt!.getTime() + 1_000);
    const [claimed] = await claimDueComputerUpgradeAutoRetries([machineId], due);
    const { deps } = retryDeps({ send: async () => false });
    const outcome = await runClaimedComputerUpgradeAutoRetry(claimed!, deps, due);
    assert.equal(outcome.result, "not_delivered");
    assert.equal(outcome.original?.autoRetryResult, "not_delivered");
    assert.deepEqual(projectComputerUpgradeRequest(outcome.original!).autoRetry, { state: "skipped", skipReason: "not_delivered" });
    // The retry request exists, linked, and is settled like any undelivered request.
    assert.equal(outcome.retry?.autoRetryOfRequestId, failed.id);
    assert.equal(outcome.retry?.outcome, "failed");
    assert.equal(outcome.retry?.reason, "command_not_delivered");
  } finally {
    await closeTestDatabase();
  }
});

test("a claimed retry with no result never stays scheduled: shown skipped after the grace, then settled abandoned", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const { userId, serverId } = await seed();
    const failed = await failedDownloadRequest(serverId, userId);
    const claimedAt = new Date(failed.autoRetryDueAt!.getTime() + 1_000);
    const [claimed] = await claimDueComputerUpgradeAutoRetries([machineId], claimedAt);
    // The claiming replica dies here: nothing recorded.
    assert.deepEqual(projectComputerUpgradeRequest(claimed!, null, new Date(claimedAt.getTime() + 60_000)).autoRetry, { state: "scheduled", dueAt: failed.autoRetryDueAt!.toISOString() });
    const past = new Date(claimedAt.getTime() + UPGRADE_AUTO_RETRY_ABANDON_MS);
    assert.deepEqual(projectComputerUpgradeRequest(claimed!, null, past).autoRetry, { state: "skipped", skipReason: "abandoned" });
    assert.equal((await settleAbandonedComputerUpgradeAutoRetries(new Date(past.getTime() - 1))).length, 0);
    const abandoned = await settleAbandonedComputerUpgradeAutoRetries(past);
    assert.equal(abandoned.length, 1);
    assert.equal(abandoned[0]!.autoRetryResult, "abandoned");
    assert.equal((await settleAbandonedComputerUpgradeAutoRetries(new Date(past.getTime() + 60_000))).length, 0, "once");
    // A failure while running a claimed retry is recorded the same way (the orchestrator's catch).
    const second = await createComputerUpgradeRequest({ serverId, machineId: otherMachineId, targetVersion: "1.0.60", requestedByUserId: userId, now });
    await settleRefusedComputerUpgradeRequest({ machineId: otherMachineId, requestId: second.row.id, code: "computer_control_failed", reason: "installer_download_failed: TimeoutError", now });
    const [claimedSecond] = await claimDueComputerUpgradeAutoRetries([otherMachineId], new Date(now.getTime() + UPGRADE_AUTO_RETRY_DELAY_MS));
    const internal = await recordComputerUpgradeAutoRetryResult(claimedSecond!.id, "failed_internal");
    assert.deepEqual(projectComputerUpgradeRequest(internal!).autoRetry, { state: "skipped", skipReason: "failed_internal" });
  } finally {
    await closeTestDatabase();
  }
});

test("a retry result reaches delta-synced clients through the change log (machine upsert)", async ({ db }) => {
  const watermark = async () => Number((await db.execute(sql`SELECT COALESCE(max(seq), 0) AS m FROM change_log`)).rows[0]!.m);
  const since = async (from: number) => (await db.execute(sql`
    SELECT entity, entity_id, op FROM change_log WHERE seq > ${from} ORDER BY seq`)).rows as Array<{ entity: string; entity_id: string; op: string }>;
  const [user] = await db.insert(users).values({ email: "auto-retry-cl@example.com", name: "autoRetryCl", passwordHash: "x" }).returning();
  const server = await createServer("auto-retry-cl", "auto-retry-cl", user!.id);
  const failed = await failedDownloadRequest(server.id, user!.id);
  const due = new Date(failed.autoRetryDueAt!.getTime() + 1_000);
  const [claimed] = await claimDueComputerUpgradeAutoRetries([machineId], due);
  const mark = await watermark();
  const { deps } = retryDeps({ checkTarget: async () => "target_withdrawn" });
  const outcome = await runClaimedComputerUpgradeAutoRetry(claimed!, deps, due);
  assert.equal(outcome.result, "target_withdrawn");
  assert.equal(outcome.original?.observedVersion, "1.0.59", "the touch keeps the observed version");
  assert.deepEqual((await since(mark)).map((r) => [r.entity, r.entity_id, r.op]), [["machine", machineId, "upsert"]]);
});

test("computerControlRefusal: the endpoint's checks, including the managed-Computer one, for the retry", async ({ db }) => {
  const [owner] = await db.insert(users).values({ email: "auto-retry-ctl@example.com", name: "autoRetryCtl", passwordHash: "x" }).returning();
  const [stranger] = await db.insert(users).values({ email: "auto-retry-ctl2@example.com", name: "autoRetryCtl2", passwordHash: "x" }).returning();
  const server = await createServer("auto-retry-ctl", "auto-retry-ctl", owner!.id);
  const { machine: registered } = await registerMachine(server.id, owner!.id, "auto-retry-ctl-machine");
  const machine = { id: registered.id, userId: owner!.id };
  // No computers row: the machine is not presented by a managed Computer.
  assert.equal(await computerControlRefusal(server.id, owner!.id, machine), "not_a_computer");
  const [computer] = await db.insert(computers).values({
    serverId: server.id, name: "laptop", apiKeyHash: "x", apiKeyPrefix: "sk_computer_t", machineId: machine.id, attachedByUserId: owner!.id,
  }).returning();
  assert.equal(await computerControlRefusal(server.id, owner!.id, machine), null);
  // Not a member of the server: not permitted.
  assert.equal(await computerControlRefusal(server.id, stranger!.id, machine), "not_permitted");
  // Detached (revoked) during the 10 minutes: not a Computer any more.
  await db.update(computers).set({ revokedAt: new Date() }).where(eq(computers.id, computer!.id));
  assert.equal(await computerControlRefusal(server.id, owner!.id, machine), "not_a_computer");
});
