import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { parseRuntimeReadinessReport, type ReadinessFact } from "@botiverse/raft-shared";
import { computerOutageOccurrences, computerReadinessReports, computers, computerUpgradeRequests, machines } from "../db/schema";
import { eq } from "drizzle-orm";
import { loadComputerReadinessInputs, loadRuntimeReadinessFacts, releaseReadinessNotices, serverFactsForComputer, storeRuntimeReadinessReport } from "./runtimeReadinessService";

const verify: ReadinessFact = { resource: { kind: "login", key: "shared:claude" }, code: "verification_required", behaviour: "blocked", since: 5_000 };

test("#68: a Computer's report is stored only when its seq is above the stored one; the replaced facts come back for the notice", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [machine] = await db.insert(machines).values({ serverId: server.id, userId: owner.id, name: "box", apiKeyHash: "hash" }).returning({ id: machines.id });
  const machineId = machine!.id;
  const at = new Date("2026-11-12T12:00:00Z");

  assert.deepEqual(await storeRuntimeReadinessReport(machineId, { seq: 10, facts: [verify] }, at, db), { previous: [], toNotify: [verify] });
  assert.deepEqual((await loadRuntimeReadinessFacts([machineId], db)).get(machineId), [verify]);

  // The same seq again (a reconnect resending it) and an older one are dropped.
  assert.equal(await storeRuntimeReadinessReport(machineId, { seq: 10, facts: [] }, at, db), null);
  assert.equal(await storeRuntimeReadinessReport(machineId, { seq: 9, facts: [] }, at, db), null);
  assert.deepEqual((await loadRuntimeReadinessFacts([machineId], db)).get(machineId), [verify]);

  // A newer one replaces it, and returns what it replaced.
  assert.deepEqual(await storeRuntimeReadinessReport(machineId, { seq: 11, facts: [] }, at, db), { previous: [verify], toNotify: [] });
  assert.deepEqual((await loadRuntimeReadinessFacts([machineId], db)).get(machineId), []);
  // It comes back within 24 h of the claim: not told again.
  assert.deepEqual(await storeRuntimeReadinessReport(machineId, { seq: 12, facts: [verify] }, new Date(at.getTime() + 60_000), db), { previous: [], toNotify: [] });
  assert.equal((await loadRuntimeReadinessFacts(["00000000-0000-4000-8000-000000000000"], db)).size, 0);
});

test("#68: an offline Computer's readiness reads its open outage occurrence: pending, notified, or none (planned)", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const offlineOrchestrator = {
    getMachineStatus: async () => "offline" as const,
    getMachineRuntimeDetection: async () => null,
    isMachineAgentWorkHeld: async () => false,
  };
  const facts = async (state: "pending" | "notified" | null) => {
    const [machine] = await db.insert(machines).values({ serverId: server.id, userId: owner.id, name: `box-${state}`, apiKeyHash: "hash" }).returning({ id: machines.id });
    const [computer] = await db.insert(computers).values({ serverId: server.id, machineId: machine!.id, name: "box", apiKeyHash: `hash-${state}`, apiKeyPrefix: `sk-${state}` }).returning({ id: computers.id });
    if (state) {
      await db.insert(computerOutageOccurrences).values({
        serverId: server.id, computerId: computer!.id, machineId: machine!.id, connectionEpochId: "epoch",
        state, firstOfflineAt: new Date(5_000), notifyAfter: new Date(65_000),
      });
    }
    const inputs = (await loadComputerReadinessInputs([machine!.id], offlineOrchestrator, undefined, db)).get(machine!.id)!;
    return serverFactsForComputer(inputs.server, [], 100_000).map((fact) => `${fact.code}:${fact.behaviour}`);
  };
  assert.deepEqual(await facts("pending"), ["computer_reconnecting:advisory"]);
  assert.deepEqual(await facts("notified"), ["computer_offline:blocked"]);
  assert.deepEqual(await facts(null), ["computer_restarting:waiting"]);
});

test("#68: two reports at once with the same new block claim its notice once; a claim nobody was told about is given back", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [machine] = await db.insert(machines).values({ serverId: server.id, userId: owner.id, name: "racy", apiKeyHash: "hash" }).returning({ id: machines.id });
  const machineId = machine!.id;
  const at = new Date("2026-11-12T12:00:00Z");
  const results = await Promise.all([
    storeRuntimeReadinessReport(machineId, { seq: 20, facts: [verify] }, at, db),
    storeRuntimeReadinessReport(machineId, { seq: 21, facts: [verify] }, at, db),
  ]);
  const told = results.flatMap((result) => result?.toNotify ?? []);
  assert.equal(told.length, 1, "exactly one report tells the owner");

  const key = "shared:claude|verification_required";
  const notified = async () => (await db.select({ notified: computerReadinessReports.notified }).from(computerReadinessReports).where(eq(computerReadinessReports.machineId, machineId)))[0]!.notified;
  assert.equal((await notified())[key], at.getTime());
  // Another claim's time is not this one's: kept.
  await releaseReadinessNotices(machineId, [key], at.getTime() + 1, db);
  assert.equal((await notified())[key], at.getTime());
  await releaseReadinessNotices(machineId, [key], at.getTime(), db);
  assert.equal((await notified())[key], undefined);
});

test("#68: an offline Computer with an open upgrade request is updating until its deadline", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [machine] = await db.insert(machines).values({ serverId: server.id, userId: owner.id, name: "upgrading", apiKeyHash: "hash", lastHeartbeat: new Date(90_000) }).returning({ id: machines.id });
  await db.insert(computers).values({ serverId: server.id, machineId: machine!.id, name: "upgrading", apiKeyHash: "hash-up", apiKeyPrefix: "sk-up" });
  await db.insert(computerUpgradeRequests).values({ serverId: server.id, machineId: machine!.id, targetVersion: "1.2.3", requestedByUserId: owner.id, requestedAt: new Date(95_000), deadlineAt: new Date(200_000) });
  const offlineOrchestrator = {
    getMachineStatus: async () => "offline" as const,
    getMachineRuntimeDetection: async () => null,
    isMachineAgentWorkHeld: async () => false,
  };
  const inputs = (await loadComputerReadinessInputs([machine!.id], offlineOrchestrator, undefined, db)).get(machine!.id)!;
  assert.deepEqual(inputs.server.upgrade, { requestedAtMs: 95_000, deadlineAtMs: 200_000 });
  assert.ok(inputs.ownerName, "the owner's member display name");
  assert.deepEqual(serverFactsForComputer(inputs.server, [], 100_000).map((fact) => fact.code), ["computer_updating"]);
  assert.deepEqual(serverFactsForComputer(inputs.server, [], 200_000).map((fact) => fact.code), ["computer_offline"]);
});

test("#68 F1: a frame with 1,000 made-up codes stores 50 facts and tells nobody", async ({ db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [machine] = await db.insert(machines).values({ serverId: server.id, userId: owner.id, name: "flood", apiKeyHash: "hash" }).returning({ id: machines.id });
  const report = parseRuntimeReadinessReport({
    seq: 5,
    facts: Array.from({ length: 1_000 }, (_, index) => ({ resource: { kind: "login", key: "shared:claude" }, code: `made_up_${index}`, behaviour: "blocked", since: 1 })),
  })!;
  const stored = await storeRuntimeReadinessReport(machine!.id, report, new Date("2026-11-12T12:00:00Z"), db);
  assert.deepEqual(stored?.toNotify, []);
  assert.equal((await loadRuntimeReadinessFacts([machine!.id], db)).get(machine!.id)?.length, 50);
});
