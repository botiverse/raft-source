import assert from "node:assert/strict";
import { getServerCapabilities } from "@botiverse/raft-shared";
import {
  earliestVersionDeadline,
  machinesNeedingReinstall,
  machinesNeedingReinstallAnyStatus,
  machinesNeedingUpgradeByDeadline,
  machinesNeedingUpgradeByDeadlineAnyStatus,
  reinstallDismissalKey,
  reinstallNoticeKind,
} from "../src/utils/computersNeedingReinstall";

// The Notification Center's reinstall entry lists online machines the user
// manages that need a one-time step: a reinstall for a Computer below the web's
// one-click upgrade minimum, a migration for a legacy standalone daemon. Its
// dismissal fingerprint covers those machines whatever their status.

const ME = "user-me";
const member = getServerCapabilities("member");
const admin = getServerCapabilities("admin");

type TestMachine = Parameters<typeof machinesNeedingReinstall>[0][number] & { id: string };

function computer(id: string, computerVersion: string | null, extra: Partial<TestMachine> = {}): TestMachine {
  return {
    id,
    isComputer: true,
    status: "online",
    computerVersion,
    computerAttachedByCurrentUser: true,
    creator: null,
    ...extra,
  };
}

const ids = (machines: readonly { id: string }[]) => machines.map((m) => m.id);

test("counts an online Computer that needs a reinstall, and a legacy daemon", () => {
  const machines = [
    computer("too-old", "1.0.30"),
    computer("one-click", "1.0.46"),
    computer("current", "1.0.47"),
    computer("legacy", null, { isComputer: false }),
    computer("legacy-old-server", null, { isComputer: undefined }),
  ];
  assert.deepEqual(ids(machinesNeedingReinstall(machines, ME, member)), ["too-old", "legacy", "legacy-old-server"]);
});

test("follows the server's versionGate when it sends one", () => {
  const gate = { reason: "computer_version_unsupported" as const, minVersion: "1.0.50", enforced: false, enforcedAt: null };
  const machines = [
    computer("gated-too-old", "1.0.44", { versionGate: gate }),
    computer("gated-upgradable", "1.0.48", { versionGate: gate }),
    computer("not-gated", "1.0.30", { versionGate: null }),
  ];
  assert.deepEqual(ids(machinesNeedingReinstall(machines, ME, member)), ["gated-too-old"]);
});

test("skips offline machines and Computers that have not reported a version yet", () => {
  const machines = [
    computer("offline-too-old", "1.0.30", { status: "offline" }),
    computer("offline-legacy", null, { isComputer: false, status: "offline" }),
    computer("unreported", null),
    computer("unreported-blank", "  "),
  ];
  assert.deepEqual(machinesNeedingReinstall(machines, ME, member), []);
});

test("counts only machines the user manages: attached, created, or a managing role", () => {
  const machines = [
    computer("attached", "1.0.30"),
    computer("created", null, { isComputer: false, computerAttachedByCurrentUser: false, creator: { id: ME } as TestMachine["creator"] }),
    computer("someone-else", "1.0.30", { computerAttachedByCurrentUser: false, creator: { id: "user-other" } as TestMachine["creator"] }),
    computer("no-creator", null, { isComputer: false, computerAttachedByCurrentUser: false }),
  ];
  assert.deepEqual(ids(machinesNeedingReinstall(machines, ME, member)), ["attached", "created"]);
  assert.deepEqual(ids(machinesNeedingReinstall(machines, ME, admin)), ["attached", "created", "someone-else", "no-creator"]);
  // Signed out (no user id): a null creator id never matches.
  assert.deepEqual(ids(machinesNeedingReinstall(machines, null, member)), ["attached"]);
  assert.deepEqual(machinesNeedingReinstall(machines, ME, getServerCapabilities("guest")).length, 2);
});

test("the dismissal fingerprint covers offline machines too, so connectivity does not change it", () => {
  const online = [computer("b-old", "1.0.30"), computer("a-legacy", null, { isComputer: false })];
  const flapped = [computer("b-old", "1.0.30", { status: "offline" }), computer("a-legacy", null, { isComputer: false, status: "offline" })];
  assert.deepEqual(ids(machinesNeedingReinstall(flapped, ME, member)), []);
  assert.equal(reinstallDismissalKey(machinesNeedingReinstallAnyStatus(online, ME, member)), "computer-reinstall:a-legacy,b-old");
  assert.equal(reinstallDismissalKey(machinesNeedingReinstallAnyStatus(flapped, ME, member)), "computer-reinstall:a-legacy,b-old");
  // Fixed (now current) or not managed: out of the fingerprint.
  assert.equal(
    reinstallDismissalKey(machinesNeedingReinstallAnyStatus([computer("b-old", "1.0.47"), ...online.slice(1)], ME, member)),
    "computer-reinstall:a-legacy",
  );
});

test("the notice says reinstall, migrate, or both", () => {
  assert.equal(reinstallNoticeKind([{ isComputer: true }, { isComputer: true }]), "reinstall");
  assert.equal(reinstallNoticeKind([{ isComputer: false }, { isComputer: undefined }]), "migrate");
  assert.equal(reinstallNoticeKind([{ isComputer: true }, { isComputer: false }]), "mixed");
});

test("a dismissed key that covers every current machine is reused; a new machine gets a new key", () => {
  const dismissed = new Set(["computer-attention:x", "computer-reinstall:a,b"]);
  assert.equal(reinstallDismissalKey([{ id: "b" }], dismissed), "computer-reinstall:a,b");
  assert.equal(reinstallDismissalKey([{ id: "b" }, { id: "a" }], dismissed), "computer-reinstall:a,b");
  assert.equal(reinstallDismissalKey([{ id: "b" }, { id: "c" }], dismissed), "computer-reinstall:b,c");
  assert.equal(reinstallDismissalKey([{ id: "c" }], new Set()), "computer-reinstall:c");
});

// #proj-o11y:#19: a floor with a deadline also lists the Computers the web can
// still upgrade, by the earliest date not yet in effect; without a date, or
// once enforced, the Computer card's own notice is the only surface.
test("lists upgradable Computers below a floor with a deadline, until it is enforced", () => {
  const deadline = "2026-11-10T00:00:00.000Z";
  const scheduled = { reason: "computer_version_unsupported" as const, minVersion: "1.0.53", enforced: false, enforcedAt: deadline };
  const machines = [
    computer("upgradable", "1.0.50", { versionGate: scheduled }),
    computer("upgradable-offline", "1.0.48", { versionGate: scheduled, status: "offline" }),
    computer("too-old", "1.0.30", { versionGate: scheduled }),
    computer("no-date", "1.0.50", { versionGate: { ...scheduled, enforcedAt: null } }),
    computer("enforced", "1.0.50", { versionGate: { ...scheduled, enforced: true } }),
    computer("current", "1.0.53", { versionGate: null }),
    computer("not-mine", "1.0.50", { versionGate: scheduled, computerAttachedByCurrentUser: false }),
  ];
  assert.deepEqual(ids(machinesNeedingUpgradeByDeadline(machines, ME, member)), ["upgradable"]);
  assert.deepEqual(ids(machinesNeedingUpgradeByDeadlineAnyStatus(machines, ME, member)), ["upgradable", "upgradable-offline"]);
  assert.equal(earliestVersionDeadline(machines), deadline, "the reinstall entry dates itself the same way");
  assert.equal(earliestVersionDeadline([computer("no-date", "1.0.50", { versionGate: { ...scheduled, enforcedAt: null } })]), null);
  assert.equal(
    earliestVersionDeadline([
      computer("later", "1.0.50", { versionGate: { ...scheduled, enforcedAt: "2026-11-20T00:00:00.000Z" } }),
      computer("sooner", "1.0.50", { versionGate: scheduled }),
    ]),
    deadline,
  );
});

test("the deadline entry's dismissal key carries its own prefix, so a new date brings it back", () => {
  const first = reinstallDismissalKey([{ id: "b" }, { id: "a" }], new Set(), "computer-upgrade-deadline:2026-11-10:");
  assert.equal(first, "computer-upgrade-deadline:2026-11-10:a,b");
  assert.equal(reinstallDismissalKey([{ id: "a" }], new Set([first]), "computer-upgrade-deadline:2026-11-10:"), first);
  assert.equal(
    reinstallDismissalKey([{ id: "a" }], new Set([first]), "computer-upgrade-deadline:2026-11-20:"),
    "computer-upgrade-deadline:2026-11-20:a",
  );
});
