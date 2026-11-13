import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { COMPUTER_VERSION_ENFORCEMENT_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { featureFlagRules, featureFlags } from "../db/schema";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import { dbTest } from "../test/integration/dbTest";
import { ComputerVersionFloor, readComputerVersionFloorEnv } from "./computerVersionFloorService";

test("version floor env: no floor without a valid minimum; no deadline means hint only", () => {
  assert.equal(readComputerVersionFloorEnv({}), null);
  assert.equal(readComputerVersionFloorEnv({ COMPUTER_MIN_SUPPORTED_VERSION: "latest" }), null);
  assert.deepEqual(readComputerVersionFloorEnv({ COMPUTER_MIN_SUPPORTED_VERSION: " 1.0.47 " }), { minVersion: "1.0.47", enforceAt: null });
  assert.deepEqual(
    readComputerVersionFloorEnv({ COMPUTER_MIN_SUPPORTED_VERSION: "1.0.47", COMPUTER_MIN_VERSION_ENFORCE_AT: "2026-11-10T00:00:00Z" }),
    { minVersion: "1.0.47", enforceAt: "2026-11-10T00:00:00.000Z" },
  );
  assert.deepEqual(
    readComputerVersionFloorEnv({ COMPUTER_MIN_SUPPORTED_VERSION: "1.0.47", COMPUTER_MIN_VERSION_ENFORCE_AT: "soon" }),
    { minVersion: "1.0.47", enforceAt: null },
  );
});

test("version floor: the emergency-stop flag is read per server only after the deadline, cached a minute, and an unreadable flag never starts enforcing", async () => {
  const deadline = Date.parse("2026-11-10T00:00:00Z");
  const reads: string[] = [];
  let flag: boolean | Error = true;
  const floor = new ComputerVersionFloor(
    () => ({ minVersion: "1.0.47", enforceAt: "2026-11-10T00:00:00.000Z" }),
    async (serverId) => {
      reads.push(serverId);
      if (flag instanceof Error) throw flag;
      return flag;
    },
  );
  assert.equal(floor.enforcementDue(deadline - 1), false);
  assert.equal((await floor.policy(deadline - 1, "s1"))?.enforcementEnabled, false);
  assert.deepEqual(reads, [], "no flag read before the deadline");
  assert.equal(floor.enforcementDue(deadline), true);
  assert.equal((await floor.gate("1.0.40", deadline, "s1"))?.enforced, true);
  flag = false;
  assert.equal((await floor.gate("1.0.40", deadline + 30_000, "s1"))?.enforced, true, "cached for s1");
  assert.equal((await floor.gate("1.0.40", deadline + 30_000, "s2"))?.enforced, false, "s2 has its own answer");
  assert.equal((await floor.gate("1.0.40", deadline + 60_000, "s1"))?.enforced, false, "the flag switched off lifts it");
  assert.deepEqual(reads, ["s1", "s2", "s1"]);

  const broken = new ComputerVersionFloor(
    () => ({ minVersion: "1.0.47", enforceAt: "2026-11-10T00:00:00.000Z" }),
    async () => { throw new Error("db down"); },
  );
  assert.equal((await broken.gate("1.0.40", deadline, "s1"))?.enforced, false);
});

dbTest("version floor through the real flag: enforced for an allowed server past the deadline, off for any other", async () => {
  await openTestDatabase("pglite://:memory:");
  try {
    const allowed = randomUUID();
    await getDb().insert(featureFlags).values({
      key: COMPUTER_VERSION_ENFORCEMENT_FEATURE_FLAG_KEY,
      description: "test",
      enabled: true,
      killSwitch: false,
      randomizationUnit: "server",
      defaultEnabled: false,
      salt: "computer-version-enforcement-test",
    });
    await getDb().insert(featureFlagRules).values({
      id: randomUUID(),
      flagKey: COMPUTER_VERSION_ENFORCEMENT_FEATURE_FLAG_KEY,
      stage: "server",
      priority: 0,
      decision: "allow",
      values: [allowed],
    });
    const floor = new ComputerVersionFloor(() => ({ minVersion: "1.0.47", enforceAt: "2026-01-01T00:00:00.000Z" }));
    const now = Date.parse("2026-02-01T00:00:00Z");
    assert.equal((await floor.gate("1.0.40", now, allowed))?.enforced, true);
    assert.equal((await floor.gate("1.0.40", now, randomUUID()))?.enforced, false, "not allowed: hint only");
    assert.equal((await floor.gate("1.0.47", now, allowed)), null);
  } finally {
    await closeTestDatabase();
  }
});
