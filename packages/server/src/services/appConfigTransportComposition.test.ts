import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
/**
 * Composition integration teeth (task #204).
 *
 * These run against a real PGlite database with a durable override at a
 * non-zero revision, because the defect they exist to catch is precisely the
 * one a stub cannot see: a source that returns manifest defaults at revision 0
 * looks correct in isolation and is wrong on the wire.
 *
 * Deleting the `getRapAppConfig` read and returning defaults/revision 0 must
 * turn these RED.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach } from "vitest";

import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { listBuiltInAppConfigSnapshotsForAgent } from "./appConfigTransportComposition.js";
import { patchRapAppConfig } from "./rapAppConfigService.js";


const CLEANER = "system.cleaner";

afterEach(async () => {
  await closeTestDatabase();
});

async function seed() {
  await openTestDatabase("pglite://");
  const db = getDb();
  const suffix = randomUUID();
  const [owner] = await db.insert(users).values({
    email: `composition-${suffix}@slock.test`,
    name: `composition-${suffix}`,
    displayName: "Composition Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    name: `Composition ${suffix.slice(0, 6)}`,
    slug: `composition-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    serverId: server.id,
    name: `agent-${suffix.slice(0, 6)}`,
    runtime: "codex",
  }).returning();
  const [other] = await db.insert(agents).values({
    serverId: server.id,
    name: `other-${suffix.slice(0, 6)}`,
    runtime: "codex",
  }).returning();
  return { serverId: server.id, agentId: agent.id, otherAgentId: other.id };
}

test("the snapshot carries the durable revision and overrides, not manifest defaults", async () => {
  const { serverId, agentId } = await seed();

  // Two mutations, so revision 2 cannot be confused with a hardcoded 0 or 1.
  await patchRapAppConfig({
    serverId,
    subjectAgentId: agentId,
    appId: CLEANER,
    expectedRevision: 0,
    set: { interval_seconds: 1800 },
    unset: [],
  });
  await patchRapAppConfig({
    serverId,
    subjectAgentId: agentId,
    appId: CLEANER,
    expectedRevision: 1,
    set: { threshold_bytes: 131072, enabled: false },
    unset: [],
  });

  const result = await listBuiltInAppConfigSnapshotsForAgent({
    serverId,
    ownerAgentId: agentId,
  });

  assert.deepEqual(result.terminals, []);
  assert.equal(result.envelopes.length, 1);
  const [snapshot] = result.envelopes.map((envelope) => envelope.value);
  assert.equal(snapshot!.appId, CLEANER);
  assert.equal(snapshot!.ownerAgentId, agentId, "envelope must be owner-bound");
  assert.equal(snapshot!.revision, 2, "must carry the durable revision, not 0");
  assert.deepEqual(
    snapshot!.effective,
    { enabled: false, thresholdBytes: 131072, intervalMs: 1_800_000 },
    "stored overrides must reach the wire, with seconds converted to ms",
  );
});

test("seconds are converted, never forwarded raw", async () => {
  const { serverId, agentId } = await seed();
  await patchRapAppConfig({
    serverId,
    subjectAgentId: agentId,
    appId: CLEANER,
    expectedRevision: 0,
    set: { interval_seconds: 900 },
    unset: [],
  });

  const result = await listBuiltInAppConfigSnapshotsForAgent({
    serverId,
    ownerAgentId: agentId,
  });
  const [snapshot] = result.envelopes.map((envelope) => envelope.value);

  assert.equal(snapshot!.effective.intervalMs, 900_000);
  assert.notEqual(snapshot!.effective.intervalMs, 900, "raw seconds leaked onto the wire");
  for (const key of Object.keys(snapshot!.effective)) {
    assert.ok(!key.includes("_"), `store casing leaked onto the wire: ${key}`);
  }
});

test("an untouched owner still gets defaults at revision 0, bound to itself", async () => {
  const { serverId, agentId, otherAgentId } = await seed();
  await patchRapAppConfig({
    serverId,
    subjectAgentId: agentId,
    appId: CLEANER,
    expectedRevision: 0,
    set: { threshold_bytes: 131072 },
    unset: [],
  });

  const result = await listBuiltInAppConfigSnapshotsForAgent({
    serverId,
    ownerAgentId: otherAgentId,
  });
  const [snapshot] = result.envelopes.map((envelope) => envelope.value);

  assert.equal(snapshot!.ownerAgentId, otherAgentId, "one owner's override must not leak to another");
  assert.equal(snapshot!.revision, 0);
  assert.equal(snapshot!.effective.thresholdBytes, 65_536, "must be this owner's effective config");
  assert.equal(snapshot!.effective.intervalMs, 3_600_000);
});
