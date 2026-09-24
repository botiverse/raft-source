import assert from "node:assert/strict";
import { dbTest as test } from "../test/integration/dbTest.js";
import { eq } from "drizzle-orm";
import { machines, servers, users } from "../db/schema.js";
import { recordMachineComputerVersion } from "./machineService.js";

test("Computer version inventory writes changes immediately and refreshes unchanged reports after 24 hours", async ({ db }) => {
  const [user] = await db.insert(users).values({
    email: "machine-computer-version@example.com",
    name: "machine-computer-version",
    passwordHash: "test",
  }).returning();
  const [server] = await db.insert(servers).values({
    name: "machine-computer-version",
    slug: "machine-computer-version",
    ownerId: user!.id,
  }).returning();
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: user!.id,
    name: "version-source",
    apiKeyHash: "test",
  }).returning();

  const firstReportedAt = new Date("2026-07-17T00:00:00.000Z");
  assert.equal(
    await recordMachineComputerVersion(machine!.id, " 1.0.4 ", firstReportedAt),
    true,
  );

  const readMachine = async () => {
    const [row] = await db.select({
      computerVersion: machines.computerVersion,
      computerVersionReportedAt: machines.computerVersionReportedAt,
    }).from(machines).where(eq(machines.id, machine!.id));
    return row!;
  };

  assert.deepEqual(await readMachine(), {
    computerVersion: "1.0.4",
    computerVersionReportedAt: firstReportedAt,
  });

  const beforeRefresh = new Date("2026-07-17T23:59:59.999Z");
  assert.equal(await recordMachineComputerVersion(machine!.id, "1.0.4", beforeRefresh), false);
  assert.equal((await readMachine()).computerVersionReportedAt?.toISOString(), firstReportedAt.toISOString());

  const exactRefreshBoundary = new Date("2026-07-18T00:00:00.000Z");
  assert.equal(
    await recordMachineComputerVersion(machine!.id, "1.0.4", exactRefreshBoundary),
    false,
    "the contract says older than 24h, not at least 24h",
  );

  const changedReportedAt = new Date("2026-07-18T00:00:00.001Z");
  assert.equal(
    await recordMachineComputerVersion(machine!.id, "0.0.0-dev", changedReportedAt),
    true,
  );
  assert.deepEqual(await readMachine(), {
    computerVersion: "0.0.0-dev",
    computerVersionReportedAt: changedReportedAt,
  });

  const refreshedReportedAt = new Date("2026-07-19T00:00:00.002Z");
  assert.equal(
    await recordMachineComputerVersion(machine!.id, "0.0.0-dev", refreshedReportedAt),
    true,
  );
  assert.equal(
    (await readMachine()).computerVersionReportedAt?.toISOString(),
    refreshedReportedAt.toISOString(),
  );

  assert.equal(await recordMachineComputerVersion(machine!.id, "   ", new Date()), false);
  assert.equal((await readMachine()).computerVersion, "0.0.0-dev");
});
