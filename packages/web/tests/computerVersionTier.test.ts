import assert from "node:assert/strict";
import {
  COMPUTER_REMOTE_UPGRADE_MIN_VERSION,
  COMPUTER_VERSION_FLOOR,
  evaluateComputerVersionGate,
  getComputerVersionFloorStanding,
} from "@botiverse/raft-shared";
import type { ComputerVersionGate } from "@botiverse/raft-shared";
import { computerVersionTier } from "../src/utils/computerVersionTier";

// The Computer version floor (#proj-o11y): the server's per-machine versionGate
// when it sends one; otherwise the local 1.0.47 comparison. At or above the
// floor nothing; below it "upgrade" while the web can still upgrade (>= 1.0.45),
// "reinstall" below that or without a (SemVer) version.

// An older server: no versionGate field at all.
const online = (computerVersion: string | null) => ({ isComputer: true, status: "online" as const, computerVersion });
const FALLBACK = { minVersion: "1.0.47", enforced: false, enforcedAt: null };

test("the fallback floor is 1.0.47 and the reinstall line is the one-click upgrade minimum", () => {
  assert.equal(COMPUTER_VERSION_FLOOR.minVersion, "1.0.47");
  assert.equal(COMPUTER_VERSION_FLOOR.enforcedAt, null);
  assert.equal(COMPUTER_REMOTE_UPGRADE_MIN_VERSION, "1.0.45");
});

test("old server, at or above 1.0.47 (release part, like the server): no notice", () => {
  for (const version of ["1.0.47", "1.0.48", "1.1.0", "2.0.0", "1.0.48-rc.1", "1.0.47-rc.1", "1.0.47+build.5"]) {
    assert.equal(getComputerVersionFloorStanding(version), "current", version);
    assert.deepEqual(computerVersionTier(online(version)), { kind: "none" }, version);
  }
});

test("old server, 1.0.45 to 1.0.46: upgrade (one-click works there)", () => {
  for (const version of ["1.0.45", "1.0.46", "1.0.46-rc.1", "1.0.46-staging.20261001.sha.abc"]) {
    assert.equal(getComputerVersionFloorStanding(version), "upgrade", version);
    assert.deepEqual(
      computerVersionTier(online(version)),
      { kind: "upgrade", reason: "computer_version_unsupported", ...FALLBACK },
      version,
    );
  }
});

test("old server, below 1.0.45: reinstall (too old)", () => {
  for (const version of ["1.0.44", "1.0.30", "0.0.62", "1.0.45-rc.1"]) {
    assert.equal(getComputerVersionFloorStanding(version), "reinstall", version);
    assert.deepEqual(computerVersionTier(online(version)), { kind: "reinstall", reason: "computer_version_unsupported", ...FALLBACK }, version);
  }
  // Also when the store still holds the version of a Computer gone offline.
  assert.equal(computerVersionTier({ ...online("1.0.30"), status: "offline" }).kind, "reinstall");
});

test("no version: unreported (unknown) while online, nothing offline", () => {
  for (const version of [null, "", "  "]) {
    assert.equal(getComputerVersionFloorStanding(version), "unreported");
    assert.deepEqual(computerVersionTier(online(version)), { kind: "unreported", reason: "computer_version_unknown", ...FALLBACK });
    assert.deepEqual(computerVersionTier({ ...online(version), status: "offline" }), { kind: "none" });
  }
});

test("a version that is not SemVer: reinstall, reason unknown (as the server gates it)", () => {
  for (const version of ["abc", "1.0", "v1.0.30", "1.0.030"]) {
    assert.equal(getComputerVersionFloorStanding(version), "unparseable", version);
    assert.deepEqual(computerVersionTier(online(version)), { kind: "reinstall", reason: "computer_version_unknown", ...FALLBACK }, version);
  }
});

test("raw daemon rows and rows without the run kind never get a notice", () => {
  assert.deepEqual(computerVersionTier({ isComputer: false, status: "online", computerVersion: null }), { kind: "none" });
  assert.deepEqual(computerVersionTier({ status: "online", computerVersion: "1.0.30" }), { kind: "none" });
});

// ── New server: versionGate decides ──

const gate = (overrides: Partial<ComputerVersionGate> = {}): ComputerVersionGate => ({
  reason: "computer_version_unsupported",
  minVersion: "1.0.50",
  enforcedAt: "2026-11-01T00:00:00.000Z",
  enforced: false,
  ...overrides,
});

test("new server, versionGate null: no notice, even for a version the local floor would flag", () => {
  assert.deepEqual(computerVersionTier({ ...online("1.0.30"), versionGate: null }), { kind: "none" });
  assert.deepEqual(computerVersionTier({ ...online(null), versionGate: null }), { kind: "none" });
});

test("new server, versionGate set: its reason, floor and enforcement, whatever the local floor says", () => {
  assert.deepEqual(computerVersionTier({ ...online("1.0.48"), versionGate: gate({ enforced: true }) }), {
    kind: "upgrade",
    reason: "computer_version_unsupported",
    minVersion: "1.0.50",
    enforced: true,
    enforcedAt: "2026-11-01T00:00:00.000Z",
  });
  assert.equal(computerVersionTier({ ...online("1.0.40"), versionGate: gate() }).kind, "reinstall");
  assert.deepEqual(
    computerVersionTier({ ...online("weird"), versionGate: gate({ reason: "computer_version_unknown" }) }),
    { kind: "reinstall", reason: "computer_version_unknown", minVersion: "1.0.50", enforced: false, enforcedAt: "2026-11-01T00:00:00.000Z" },
  );
  assert.equal(computerVersionTier({ ...online(null), versionGate: gate({ reason: "computer_version_unknown" }) }).kind, "unreported");
  // The server gates offline rows as unknown (it sends no version for them): no verdict.
  assert.deepEqual(
    computerVersionTier({ ...online(null), status: "offline", versionGate: gate({ reason: "computer_version_unknown" }) }),
    { kind: "none" },
  );
});

test("the client fallback agrees with the server's evaluateComputerVersionGate at the 1.0.47 floor", () => {
  const policy = { minVersion: "1.0.47", enforceAt: null, enforcementEnabled: true };
  for (const version of ["1.0.47", "1.0.47-rc.1", "1.0.48", "1.0.46", "1.0.30", "abc", null]) {
    const server = evaluateComputerVersionGate(version, policy, 0);
    const client = computerVersionTier(online(version));
    assert.equal(server === null, client.kind === "none", String(version));
    if (server && client.kind !== "none") assert.equal(client.reason, server.reason, String(version));
  }
});
