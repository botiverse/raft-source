// Ablation study for the "This Computer" self-card hardening fixes.
//
// Each fix is proven necessary by an ON/OFF pair: with the fix OFF (the `ablate`
// flag) the defect reproduces; with it ON the defect is gone. If a fix were
// over-engineering, its OFF case would NOT reproduce a real defect — every case
// below does. (The purely-dev DISABLE-inert polish was CUT, not kept.)
import assert from "node:assert/strict";
import test from "node:test";
import {
  correlateSelfMachine,
  deriveControls,
  routeUpdateAction,
  type MachineLike,
} from "./thisComputerLogic.js";

const NOW = Date.parse("2026-09-08T10:00:00Z");
const TEN_MIN = 10 * 60 * 1000;

// ── Fix #2: hostname correlation must be UNIQUE ──────────────────────────────
test("#2 hostname correlation — OFF binds to an arbitrary same-named machine; ON returns null", () => {
  const machines: MachineLike[] = [
    { id: "A", hostname: "MacBook-Pro.local", computerVersion: "1.0.1" },
    { id: "B", hostname: "MacBook-Pro.local", computerVersion: "1.0.2" }, // duplicate hostname
  ];
  const OFF = correlateSelfMachine(machines, [], "MacBook-Pro.local", { uniqueHostname: false });
  const ON = correlateSelfMachine(machines, [], "MacBook-Pro.local");
  assert.equal(OFF?.id, "A", "DEFECT: mis-binds the self-card to an arbitrary duplicate-hostname machine (and hides it)");
  assert.equal(ON, null, "FIXED: ambiguous hostname → no self-correlation");
});

test("#2 hostname correlation — a UNIQUE hostname still correlates (fix doesn't break the good case)", () => {
  const machines: MachineLike[] = [
    { id: "A", hostname: "kabi.local", computerVersion: "1.0.1" },
    { id: "B", hostname: "other.local", computerVersion: "1.0.2" },
  ];
  assert.equal(correlateSelfMachine(machines, [], "kabi.local")?.id, "A");
});

test("#2 machineId always wins over hostname (authoritative)", () => {
  const machines: MachineLike[] = [
    { id: "A", hostname: "dup.local", computerVersion: "1.0.1" },
    { id: "B", hostname: "dup.local", computerVersion: "1.0.2" },
  ];
  assert.equal(correlateSelfMachine(machines, ["B"], "dup.local")?.id, "B");
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
  const input = { service: { running: true }, upgrade: staleUpgrade, latestVersion: "1.0.9", serverVersion: "1.0.8" };
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
  const r = deriveControls({ service: { running: true }, upgrade: liveUpgrade, latestVersion: "1.0.9", serverVersion: "1.0.8" }, NOW);
  assert.notEqual(r.upgrading, null);
  assert.ok(NOW - Date.parse(liveUpgrade.updatedAt) < TEN_MIN);
});

// ── Fix #5: update availability must use the LOCAL running version ────────────
test("#5 stale server version — OFF offers Update for an already-updated service; ON hides it", () => {
  // Local service already runs 1.0.20 (fresh); the server row still says 1.0.17.
  const input = {
    service: { running: true, version: { version: "1.0.20" } },
    upgrade: null,
    latestVersion: "1.0.20",
    serverVersion: "1.0.17",
  };
  const OFF = deriveControls(input, NOW, { localVersionCompare: false });
  const ON = deriveControls(input, NOW);
  assert.equal(OFF.updateAvailable, true, "DEFECT: offers an update for a service already on the latest version");
  assert.equal(ON.updateAvailable, false, "FIXED: compares against the fresh local version → no bogus update");
});

// ── Fix #6: don't offer a version that already rolled back on this machine ────
test("#6 rolled-back target — OFF offers a silent no-op Update; ON hides it", () => {
  const input = {
    service: { running: true, version: { version: "1.0.17" } },
    upgrade: { phase: "rolled-back", percent: null, outcome: "rolled-back", targetVersion: "1.0.18", updatedAt: new Date(NOW).toISOString() },
    latestVersion: "1.0.18",
    serverVersion: "1.0.17",
  };
  const OFF = deriveControls(input, NOW, { rolledBackHide: false });
  const ON = deriveControls(input, NOW);
  assert.equal(OFF.updateAvailable, true, "DEFECT: shows Update for a version the service will silently no-op (rolled back)");
  assert.equal(ON.updateAvailable, false, "FIXED: a previously-rolled-back target is not offered");
});

// ── Happy path sanity (all fixes ON): a genuine update is still offered ───────
test("happy path — a real newer version IS offered", () => {
  const r = deriveControls(
    { service: { running: true, version: { version: "1.0.17" } }, upgrade: null, latestVersion: "1.0.19", serverVersion: "1.0.17" },
    NOW,
  );
  assert.equal(r.updateAvailable, true);
  assert.equal(r.running, true);
  assert.equal(r.upgrading, null);
});

// ── Upgrade routing: one [Update] button, auto-selected per management model ──
test("route: app-embedded computer never shows a computer-plane update (the app updater owns it)", () => {
  // Even with a newer version + an eligible policy, an embedded computer routes
  // to "none" — it upgrades WITH the app, not via the computer button.
  assert.equal(routeUpdateAction({ managementModel: "app", eligibility: "eligible", updateAvailable: true }), "none");
  assert.equal(routeUpdateAction({ managementModel: "app", eligibility: "no_broadcast", updateAvailable: true }), "none");
});

test("route: standalone + server-eligible + newer → remote self-upgrade", () => {
  assert.equal(routeUpdateAction({ managementModel: "standalone", eligibility: "eligible", updateAvailable: true }), "remote");
});

test("route: standalone + no_broadcast + newer → app-run fresh install (the desktop advantage)", () => {
  assert.equal(routeUpdateAction({ managementModel: "standalone", eligibility: "no_broadcast", updateAvailable: true }), "fresh-install");
  // Unknown eligibility (no policy) also falls back to fresh-install, not a dead end.
  assert.equal(routeUpdateAction({ managementModel: "standalone", eligibility: null, updateAvailable: true }), "fresh-install");
});

test("route: no newer version → no update button (any model)", () => {
  assert.equal(routeUpdateAction({ managementModel: "standalone", eligibility: "eligible", updateAvailable: false }), "none");
  assert.equal(routeUpdateAction({ managementModel: "unknown", eligibility: "no_broadcast", updateAvailable: false }), "none");
});

test("route: unknown model allows the SAFE remote path but NEVER the destructive fresh-install", () => {
  // Remote self-upgrade is non-destructive → still offered when eligible.
  assert.equal(routeUpdateAction({ managementModel: "unknown", eligibility: "eligible", updateAvailable: true }), "remote");
  // Fresh install provisions a standalone binary — if we can't CONFIRM the
  // computer is standalone, do nothing (an app-embedded machine would fork a
  // competing owner). Unknown must NOT route to fresh-install.
  assert.equal(routeUpdateAction({ managementModel: "unknown", eligibility: "no_broadcast", updateAvailable: true }), "none");
  assert.equal(routeUpdateAction({ managementModel: "unknown", eligibility: null, updateAvailable: true }), "none");
});
