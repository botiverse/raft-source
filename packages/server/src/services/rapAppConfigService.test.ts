import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";

import { closeDatabase, getDb, initDatabase } from "../db/index.js";
import { agents, rapAppConfigs, servers, users } from "../db/schema.js";
import {
  getRapAppConfig,
  patchRapAppConfig,
  RapAppConfigError,
} from "./rapAppConfigService.js";

afterEach(async () => {
  await closeDatabase();
});

async function seed(databaseUrl = "pglite://") {
  await initDatabase(databaseUrl);
  const db = getDb();
  const [owner] = await db.insert(users).values({
    id: "10000000-0000-4000-8000-000000000193",
    email: "rap-config@example.com",
    name: "owner",
    displayName: "Owner",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: "20000000-0000-4000-8000-000000000193",
    name: "Config Server",
    slug: "config-server",
    ownerId: owner.id,
  }).returning();
  const inserted = await db.insert(agents).values([
    {
      id: "30000000-0000-4000-8000-000000000193",
      serverId: server.id,
      name: "alpha",
      runtime: "codex",
    },
    {
      id: "30000000-0000-4000-8000-000000000194",
      serverId: server.id,
      name: "beta",
      runtime: "codex",
    },
  ]).returning();
  return { serverId: server.id, alphaId: inserted[0].id, betaId: inserted[1].id };
}

test("missing row projects manifest defaults at revision zero without writing", async () => {
  const ids = await seed();
  const snapshot = await getRapAppConfig({
    serverId: ids.serverId,
    subjectAgentId: ids.alphaId,
    appId: "system.cleaner",
  });
  assert.equal(snapshot.revision, 0);
  assert.deepEqual(snapshot.overrides, {});
  assert.deepEqual(snapshot.effective, {
    enabled: true,
    threshold_bytes: 65_536,
    interval_seconds: 3_600,
  });
  assert.equal((await getDb().select().from(rapAppConfigs)).length, 0);
});

test("PATCH validates atomically, increments CAS revision, and unset returns to the default", async () => {
  const ids = await seed();
  const first = await patchRapAppConfig({
    serverId: ids.serverId,
    subjectAgentId: ids.alphaId,
    appId: "system.cleaner",
    expectedRevision: 0,
    set: { enabled: false, threshold_bytes: 131_072 },
    unset: [],
  });
  assert.equal(first.revision, 1);
  assert.deepEqual(first.overrides, { enabled: false, threshold_bytes: 131_072 });

  await assert.rejects(
    patchRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      appId: "system.cleaner",
      expectedRevision: 1,
      set: { interval_seconds: 1, unknown: true },
      unset: [],
    }),
    (error) => error instanceof RapAppConfigError && error.code === "RAP_APP_CONFIG_VALUE_INVALID",
  );
  const unchanged = await getRapAppConfig({ serverId: ids.serverId, subjectAgentId: ids.alphaId, appId: "system.cleaner" });
  assert.equal(unchanged.revision, 1);
  assert.deepEqual(unchanged.overrides, first.overrides);

  const second = await patchRapAppConfig({
    serverId: ids.serverId,
    subjectAgentId: ids.alphaId,
    appId: "system.cleaner",
    expectedRevision: 1,
    set: {},
    unset: ["enabled"],
  });
  assert.equal(second.revision, 2);
  assert.equal(second.effective.enabled, true);
  assert.deepEqual(second.overrides, { threshold_bytes: 131_072 });
});

test("stale revision fails with current revision and owner rows stay isolated", async () => {
  const ids = await seed();
  await patchRapAppConfig({
    serverId: ids.serverId,
    subjectAgentId: ids.alphaId,
    appId: "system.cleaner",
    expectedRevision: 0,
    set: { interval_seconds: 7_200 },
    unset: [],
  });
  await assert.rejects(
    patchRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      appId: "system.cleaner",
      expectedRevision: 0,
      set: { enabled: false },
      unset: [],
    }),
    (error) => error instanceof RapAppConfigError
      && error.code === "RAP_APP_CONFIG_REVISION_STALE"
      && error.currentRevision === 1,
  );
  const beta = await getRapAppConfig({
    serverId: ids.serverId,
    subjectAgentId: ids.betaId,
    appId: "system.cleaner",
  });
  assert.equal(beta.revision, 0);
  assert.equal(beta.effective.interval_seconds, 3_600);
});

test("two writers at revision zero produce exactly one commit and one typed stale conflict", async () => {
  const ids = await seed();
  const results = await Promise.allSettled([
    patchRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      appId: "system.cleaner",
      expectedRevision: 0,
      set: { threshold_bytes: 131_072 },
      unset: [],
    }),
    patchRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      appId: "system.cleaner",
      expectedRevision: 0,
      set: { threshold_bytes: 262_144 },
      unset: [],
    }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0].status === "rejected"
      && rejected[0].reason instanceof RapAppConfigError
      && rejected[0].reason.code === "RAP_APP_CONFIG_REVISION_STALE"
      && rejected[0].reason.currentRevision === 1,
  );
  const stored = await getRapAppConfig({
    serverId: ids.serverId,
    subjectAgentId: ids.alphaId,
    appId: "system.cleaner",
  });
  assert.equal(stored.revision, 1);
  assert.ok(stored.effective.threshold_bytes === 131_072 || stored.effective.threshold_bytes === 262_144);
});

test("an override and its monotonic revision survive a database restart", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "rap-app-config-restart-"));
  const databaseUrl = `pglite://${dataDir}`;
  try {
    const ids = await seed(databaseUrl);
    await patchRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      appId: "system.cleaner",
      expectedRevision: 0,
      set: { threshold_bytes: 262_144, interval_seconds: 7_200 },
      unset: [],
    });
    await closeDatabase();
    await initDatabase(databaseUrl);

    const restored = await getRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      appId: "system.cleaner",
    });
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.overrides, { threshold_bytes: 262_144, interval_seconds: 7_200 });
    assert.deepEqual(restored.effective, {
      enabled: true,
      threshold_bytes: 262_144,
      interval_seconds: 7_200,
    });
  } finally {
    await closeDatabase();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("unknown Apps, invalid values, duplicates, and cross-server owners write zero rows", async () => {
  const ids = await seed();
  const cases = [
    { appId: "x.unknown", set: { enabled: false }, unset: [] },
    { appId: "system.reminder", set: { enabled: false }, unset: [] },
    { appId: "system.canary", set: { enabled: false }, unset: [] },
    { appId: "system.cleaner", set: { threshold_bytes: 4_095 }, unset: [] },
    { appId: "system.cleaner", set: { enabled: false }, unset: ["enabled"] },
  ];
  for (const candidate of cases) {
    await assert.rejects(patchRapAppConfig({
      serverId: ids.serverId,
      subjectAgentId: ids.alphaId,
      expectedRevision: 0,
      ...candidate,
    }));
  }
  await assert.rejects(getRapAppConfig({
    serverId: "20000000-0000-4000-8000-000000000999",
    subjectAgentId: ids.alphaId,
    appId: "system.cleaner",
  }), (error) => error instanceof RapAppConfigError && error.code === "RAP_APP_CONFIG_OWNER_MISMATCH");
  assert.equal((await getDb().select().from(rapAppConfigs)).length, 0);
});
