import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import {
  labDefinitions,
  serverLabAccess,
  serverLabEnrollments,
  users,
} from "../db/schema.js";
import { getServerLabsForActor } from "./serverLabService.js";
import { createServer } from "./serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

test("Labs GET reads membership, cursor, catalog, and enrollments in one snapshot", async ({ app }) => {
  const db = getDb();
  const suffix = randomUUID();
  const labKey = `read_consistency_${suffix.replaceAll("-", "")}`;
  const [owner] = await db.insert(users).values({
    email: `labs-read-consistency-${suffix}@slock.test`,
    name: `labs-read-consistency-${suffix}`,
    passwordHash: "review-probe",
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(
    "Labs read consistency",
    `labs-read-consistency-${suffix}`,
    owner.id,
  );
  await db.insert(labDefinitions).values({
    key: labKey,
    name: "Read consistency",
    description: "Canonical interleaving tooth",
    state: "open",
  });
  await db.insert(serverLabAccess).values({
    serverId: server.id,
    enabled: true,
    version: 1,
  });
  await db.insert(serverLabEnrollments).values({
    serverId: server.id,
    labKey,
    enabled: false,
    version: 1,
  });

  const client = (db as unknown as {
    $client: { query: (...args: unknown[]) => Promise<unknown> };
  }).$client;
  const originalQuery = client.query.bind(client);
  let snapshotReadResolve!: () => void;
  const snapshotRead = new Promise<void>((resolve) => { snapshotReadResolve = resolve; });
  let allowSnapshotResolve!: () => void;
  const allowSnapshot = new Promise<void>((resolve) => { allowSnapshotResolve = resolve; });
  let labsSnapshotQueryCount = 0;

  client.query = async (...args: unknown[]) => {
    const text = typeof args[0] === "string"
      ? args[0]
      : String((args[0] as { text?: unknown } | undefined)?.text ?? "");
    const normalized = text.trimStart().toLowerCase();
    const requiredTables = [
      'from "servers"',
      '"server_members"',
      '"server_lab_access"',
      '"lab_definitions"',
      '"server_lab_enrollments"',
    ];
    const isSelect = normalized.startsWith("select");
    const isLabsSnapshot = isSelect
      && requiredTables.every((table) => normalized.includes(table));
    if (isSelect
      && requiredTables.some((table) => normalized.includes(table))
      && !isLabsSnapshot) {
      snapshotReadResolve();
      throw new Error("Labs read model must use one combined snapshot query");
    }
    if (isLabsSnapshot) {
      labsSnapshotQueryCount += 1;
      snapshotReadResolve();
      await allowSnapshot;
    }
    return originalQuery(...args);
  };

  try {
    const read = getServerLabsForActor(server.id, { type: "human", id: owner.id });
    await snapshotRead;
    await db.transaction(async (tx) => {
      await tx.update(serverLabEnrollments).set({ enabled: true, version: 2 }).where(and(
        eq(serverLabEnrollments.serverId, server.id),
        eq(serverLabEnrollments.labKey, labKey),
      ));
      await tx.update(serverLabAccess).set({ version: 2 }).where(
        eq(serverLabAccess.serverId, server.id),
      );
    });
    allowSnapshotResolve();

    const model = await read;
    assert.equal(labsSnapshotQueryCount, 1);
    assert.deepEqual(
      {
        version: model.version,
        enrolled: model.labs.find((lab) => lab.labKey === labKey)?.enrolled,
      },
      { version: 2, enrolled: true },
      "the cursor and enrollment must come from the same post-commit statement snapshot",
    );
  } finally {
    client.query = originalQuery;
  }
});
