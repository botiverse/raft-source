import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest";
import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { computerUpgradeRequests, servers, users } from "../db/schema";
import {
  computerUpgradeRequestTraceAttrs,
  createComputerUpgradeRequest,
  expireComputerUpgradeRequests,
  traceSafeUpgradeReason,
  listLatestComputerUpgradeRequests,
  observeComputerVersionForUpgradeRequests,
  projectComputerUpgradeRequest,
  settleRefusedComputerUpgradeRequest,
  UPGRADE_REQUEST_DEADLINE_MS,
  UPGRADE_REQUEST_LATE_SETTLE_MS,
  UPGRADE_REQUEST_UNRESOLVED_LATE_SETTLE_MS,
  UPGRADE_REQUEST_REVERT_WINDOW_MS,
  upgradeFailureHintFromReason,
} from "./computerUpgradeRequestService";

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
