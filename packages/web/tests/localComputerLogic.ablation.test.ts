// Ablation study for the "This Computer" self-card hardening fixes.
//
// Each fix is proven necessary by an ON/OFF pair: with the fix OFF (the `ablate`
// flag) the defect reproduces; with it ON the defect is gone. If a fix were
// over-engineering, its OFF case would NOT reproduce a real defect — every case
// below does. (The purely-dev DISABLE-inert polish was CUT, not kept.)
import assert from "node:assert/strict";
import { classifyHostError, correlateSelfMachine, deriveControls } from "../src/components/machine/localComputer/localComputerLogic";
import type { MachineLike } from "../src/components/machine/localComputer/localComputerLogic";

const NOW = Date.parse("2026-09-08T10:00:00Z");
const TEN_MIN = 10 * 60 * 1000;

// ── Fix #2: which row is this machine — the attachment id, a hostname only as a guarded fallback ─
const byHostname = (hostname: string) => ({ machineIds: [], hostname });

test("#2 hostname correlation — OFF binds to an arbitrary same-named machine; ON returns null", () => {
  const machines: MachineLike[] = [
    { id: "A", hostname: "MacBook-Pro.local", computerVersion: "1.0.1", computerAttachedByCurrentUser: true },
    { id: "B", hostname: "MacBook-Pro.local", computerVersion: "1.0.2", computerAttachedByCurrentUser: true }, // duplicate hostname
  ];
  const OFF = correlateSelfMachine(machines, byHostname("MacBook-Pro.local"), { uniqueHostname: false });
  const ON = correlateSelfMachine(machines, byHostname("MacBook-Pro.local"));
  assert.equal(OFF?.id, "A", "DEFECT: mis-binds the self-card to an arbitrary duplicate-hostname machine (and hides it)");
  assert.equal(ON, null, "FIXED: ambiguous hostname → no self-correlation");
});

test("#2 hostname correlation — OFF matches another member's same-named machine; ON only the current user's", () => {
  // Server B: a teammate's Mac has the default hostname this Mac also has.
  const machines: MachineLike[] = [
    { id: "theirs", hostname: "MacBook-Pro.local", computerAttachedByCurrentUser: false },
  ];
  const OFF = correlateSelfMachine(machines, byHostname("MacBook-Pro.local"), { attachedByCurrentUser: false });
  const ON = correlateSelfMachine(machines, byHostname("MacBook-Pro.local"));
  assert.equal(OFF?.id, "theirs", "DEFECT: their machine is This device, and its panel gets this Mac's Stop / Restart");
  assert.equal(ON, null, "FIXED: a hostname match needs a machine the current user attached");
  // Absent (an older server): not known to be mine, so no match either.
  assert.equal(correlateSelfMachine([{ id: "x", hostname: "MacBook-Pro.local" }], byHostname("MacBook-Pro.local")), null);
});

test("#2 hostname correlation — OFF falls back to the hostname though attachments name ids; ON does not", () => {
  // Attached to another server with an id; on this one, a same-named machine of mine.
  const machines: MachineLike[] = [
    { id: "mine-other-mac", hostname: "MacBook-Pro.local", computerAttachedByCurrentUser: true },
  ];
  const identity = { machineIds: ["m-on-server-a"], hostname: "MacBook-Pro.local" };
  const OFF = correlateSelfMachine(machines, identity, { hostnameOnlyWithoutIds: false });
  const ON = correlateSelfMachine(machines, identity);
  assert.equal(OFF?.id, "mine-other-mac", "DEFECT: another machine of mine is taken for this one");
  assert.equal(ON, null, "FIXED: with an id known, the hostname is not an identity");
});

test("#2 hostname correlation — a legacy attachment (no id), unique hostname, attached by me still correlates", () => {
  const machines: MachineLike[] = [
    { id: "A", hostname: "studio.local", computerVersion: "1.0.1", computerAttachedByCurrentUser: true },
    { id: "B", hostname: "other.local", computerVersion: "1.0.2", computerAttachedByCurrentUser: true },
    { id: "C", hostname: "studio.local", computerAttachedByCurrentUser: false }, // a teammate's: not a candidate
  ];
  assert.equal(correlateSelfMachine(machines, byHostname("studio.local"))?.id, "A");
});

test("#2 machineId always wins over hostname (authoritative), whoever attached it", () => {
  const machines: MachineLike[] = [
    { id: "A", hostname: "dup.local", computerVersion: "1.0.1" },
    { id: "B", hostname: "dup.local", computerVersion: "1.0.2" },
  ];
  assert.equal(correlateSelfMachine(machines, { machineIds: ["B"], hostname: "dup.local" })?.id, "B");
});

// ── Fix #3: "Updating…" must be bounded (a crashed upgrade leaves outcome:null) ─
test("#3 stale upgrade — OFF shows Updating forever (hides all controls); ON treats it as done", () => {
  const staleUpgrade = {
    phase: "applying",
    percent: null,
    outcome: null, // never completed (service died mid-upgrade)
    targetVersion: "1.0.9",
    updatedAt: new Date(NOW - 60 * 60 * 1000).toISOString(), // 1h ago → stale
  };
  const input = { service: { running: true }, upgrade: staleUpgrade };
  const OFF = deriveControls(input, NOW, { staleBound: false });
  const ON = deriveControls(input, NOW);
  assert.notEqual(OFF.upgrading, null, "DEFECT: stuck 'Updating…' forever, all local controls hidden");
  assert.equal(ON.upgrading, null, "FIXED: a stale in-flight record is no longer treated as live → controls return");
});

test("#3 a FRESH in-flight upgrade still shows Updating (fix doesn't hide real progress)", () => {
  const liveUpgrade = {
    phase: "downloading",
    percent: 40,
    outcome: null,
    targetVersion: "1.0.9",
    updatedAt: new Date(NOW - 5000).toISOString(), // just now
  };
  const r = deriveControls({ service: { running: true }, upgrade: liveUpgrade }, NOW);
  assert.notEqual(r.upgrading, null);
  assert.ok(NOW - Date.parse(liveUpgrade.updatedAt) < TEN_MIN);
});

// ── How a failed operation reads: the desktop's stable error prefixes ───────
test("the desktop's rejections, IPC-wrapped, read as the codes the copy words", () => {
  const wrap = (message: string) => `Error invoking remote method 'computer:enable': Error: ${message}`;
  assert.deepEqual(classifyHostError(wrap("computer_install_held: Raft Computer here is managed by Homebrew")), { code: "install_held", command: null, detail: "Raft Computer here is managed by Homebrew" });
  assert.equal(classifyHostError(wrap("computer_install_download_failed: HTTP 503")).code, "install_download_failed");
  assert.equal(classifyHostError(wrap("computer_install_unsupported: freebsd-x64")).code, "install_unsupported");
  assert.equal(classifyHostError(wrap("computer_install_failed: installer exited 1")).code, "install_failed");
  assert.equal(classifyHostError(wrap("computer_too_old: update it first")).code, "too_old");
  assert.equal(classifyHostError(wrap("computer_migration_not_running: did not start")).code, "migration_failed");
  assert.deepEqual(classifyHostError(wrap("computer_cli:NOT_SIGNED_IN:attach: sign in first")), { code: "cli_failed", command: null, detail: "NOT_SIGNED_IN" });
  assert.equal(classifyHostError("attach_grant_failed:server_unsupported").code, "server_unsupported");
});

test("a duplicate machine key keeps its own handling, through the CLI's code too", () => {
  const raw = "computer_cli:DUPLICATE_KEY_HOLDER:start: another service already holds this machine key (RAFT_HOME=/x raft-computer stop)";
  assert.deepEqual(classifyHostError(raw), { code: "duplicate_key", command: "RAFT_HOME=/x raft-computer stop" });
});

test("the desktop's terminal outcomes are told apart: still finishing (not failed), unreadable (unknown, not missing), busy, a missing capability", () => {
  assert.equal(classifyHostError("Error invoking remote method 'computer:update': Error: computer_install_still_finishing: timed out after 1200000 ms").code, "install_still_finishing");
  assert.equal(classifyHostError("Error: computer_unreadable: Raft Computer is installed but did not answer `--version`").code, "unreadable");
  assert.equal(classifyHostError("Error: computer_busy:update: Raft Computer is busy (update)").code, "busy");
  assert.equal(classifyHostError("Error: computer_capability_missing:doctor-json: update Raft Computer").code, "capability_missing");
  assert.equal(classifyHostError("Error: computer_install_failed: rolled back").code, "install_failed");
});
