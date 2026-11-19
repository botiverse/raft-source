// GET /api/integrations/marketplace's `uninstalledHereAt` (oauthClientUninstalls.ts):
// a person's uninstall records when this Server removed the App, in the
// uninstall's transaction; a reinstall keeps it; another uninstall moves it
// forward; the closed-server purge's system uninstall records nothing; and
// one Server's uninstall never shows on another Server's list.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { integrationAuditEvents, oauthClientInstalls, oauthClients, oauthClientUninstalls } from "../db/schema";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { recordPersonOAuthClientUninstall } from "./oauthClientUninstalls";
import {
  createOAuthClient,
  listMarketplaceOAuthClients,
  uninstallMarketplaceOAuthClient,
  uninstallOAuthClientInstallsOfClosedServer,
} from "./oauthService";

type Seed = ReturnType<typeof createSeed>;

/** A published Marketplace App on its publisher's Server, installed on `here` and `elsewhere`. */
async function seedInstalledApp(seed: Seed) {
  const owner = await seed.human();
  const publisher = await seed.server({ owner });
  const here = await seed.server({ owner });
  const elsewhere = await seed.server({ owner });
  const { client } = await createOAuthClient({
    serverId: publisher.id,
    createdByUserId: owner.id,
    clientId: `uninstalled-here-${randomUUID().slice(0, 8)}`,
    name: "Uninstalled Here",
    appType: "third_party_global",
  });
  await getDb().update(oauthClients).set({ publishStatus: "published", humanMarketplaceVisible: true }).where(eq(oauthClients.id, client.id));
  await install(client.id, here.id, owner.id);
  await install(client.id, elsewhere.id, owner.id);
  return { owner, here, elsewhere, app: client };
}

async function install(clientId: string, serverId: string, userId: string) {
  await getDb().insert(oauthClientInstalls).values({ serverId, clientId, installedByUserId: userId });
}

/** The App's Marketplace record on a Server, as GET /api/integrations/marketplace lists it. */
async function recordOn(serverId: string, clientId: string) {
  const record = (await listMarketplaceOAuthClients(serverId)).find((client) => client.id === clientId);
  assert.ok(record, "the Marketplace lists the App");
  return record;
}

async function uninstallEventTimes(serverId: string, clientId: string) {
  return (await getDb().select({ at: integrationAuditEvents.createdAt, actorType: integrationAuditEvents.actorType })
    .from(integrationAuditEvents)
    .where(and(
      eq(integrationAuditEvents.serverId, serverId),
      eq(integrationAuditEvents.clientId, clientId),
      eq(integrationAuditEvents.eventType, "marketplace.uninstalled"),
    )));
}

test("a person's uninstall shows on this Server only; a reinstall keeps it; uninstalling again moves it forward", async ({ seed }) => {
  const { owner, here, elsewhere, app } = await seedInstalledApp(seed);
  const before = await recordOn(here.id, app.id);
  assert.equal(before.uninstalledHereAt, null, "never uninstalled here");
  assert.ok(before.installationId);

  assert.ok(await uninstallMarketplaceOAuthClient({ serverId: here.id, clientId: app.id, revokedByUserId: owner.id }));
  const afterUninstall = await recordOn(here.id, app.id);
  assert.equal(afterUninstall.installationId, null);
  assert.equal(typeof afterUninstall.uninstalledHereAt, "string", "an ISO time");
  const first = Date.parse(afterUninstall.uninstalledHereAt!);
  assert.ok(Number.isFinite(first));
  assert.equal(new Date(first).toISOString(), afterUninstall.uninstalledHereAt);
  const [row] = await getDb().select().from(oauthClientUninstalls).where(eq(oauthClientUninstalls.serverId, here.id));
  assert.deepEqual(row, { serverId: here.id, clientId: app.id, uninstalledAt: new Date(first), actorUserId: owner.id });
  assert.equal((await uninstallEventTimes(here.id, app.id)).length, 1, "beside the uninstall's audit event");

  const other = await recordOn(elsewhere.id, app.id);
  assert.equal(other.uninstalledHereAt, null, "another Server's uninstall doesn't leak");
  assert.ok(other.installationId, "and its installation is untouched");

  await install(app.id, here.id, owner.id);
  const reinstalled = await recordOn(here.id, app.id);
  assert.ok(reinstalled.installationId, "installed again");
  assert.equal(reinstalled.uninstalledHereAt, afterUninstall.uninstalledHereAt, "a reinstall keeps the last uninstall; readers compare with the installation");

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(await uninstallMarketplaceOAuthClient({ serverId: here.id, clientId: app.id, revokedByUserId: owner.id }));
  const again = await recordOn(here.id, app.id);
  assert.ok(Date.parse(again.uninstalledHereAt!) > first, "a later uninstall moves it forward");
  assert.equal((await getDb().select().from(oauthClientUninstalls).where(eq(oauthClientUninstalls.clientId, app.id))).length, 1, "one row per Server and App");

  // Uninstalling what is not installed here writes neither an audit event nor a time.
  assert.ok(await uninstallMarketplaceOAuthClient({ serverId: here.id, clientId: app.id, revokedByUserId: owner.id }));
  assert.equal((await recordOn(here.id, app.id)).uninstalledHereAt, again.uninstalledHereAt);
  assert.equal((await uninstallEventTimes(here.id, app.id)).length, 2);
});

test("the closed-server purge's system uninstall records no uninstall time", async ({ db, seed }) => {
  const { elsewhere, app } = await seedInstalledApp(seed);
  const uninstalled = await db.transaction((tx) => uninstallOAuthClientInstallsOfClosedServer(tx, { serverId: elsewhere.id, limit: 10 }));
  assert.deepEqual(uninstalled.map((result) => result.clientId), [app.id]);
  assert.deepEqual((await uninstallEventTimes(elsewhere.id, app.id)).map((event) => event.actorType), ["system"], "audited as the system");
  assert.deepEqual(await db.select().from(oauthClientUninstalls).where(eq(oauthClientUninstalls.serverId, elsewhere.id)), []);
  const record = await recordOn(elsewhere.id, app.id);
  assert.equal(record.installationId, null);
  assert.equal(record.uninstalledHereAt, null, "no one here chose to remove it");
});

test("the newer time wins: an older write never moves it back", async ({ db, seed }) => {
  const { owner, here, app } = await seedInstalledApp(seed);
  const other = await seed.human();
  const newer = new Date("2026-11-10T12:00:00.000Z");
  const older = new Date("2026-11-01T12:00:00.000Z");
  await recordPersonOAuthClientUninstall(db, { serverId: here.id, clientId: app.id, actorUserId: owner.id, uninstalledAt: newer });
  await recordPersonOAuthClientUninstall(db, { serverId: here.id, clientId: app.id, actorUserId: other.id, uninstalledAt: older });
  const rows = () => db.select({ at: oauthClientUninstalls.uninstalledAt, actor: oauthClientUninstalls.actorUserId }).from(oauthClientUninstalls).where(eq(oauthClientUninstalls.serverId, here.id));
  assert.deepEqual(await rows(), [{ at: newer, actor: owner.id }]);
  const newest = new Date("2026-11-12T12:00:00.000Z");
  await recordPersonOAuthClientUninstall(db, { serverId: here.id, clientId: app.id, actorUserId: other.id, uninstalledAt: newest });
  assert.deepEqual(await rows(), [{ at: newest, actor: other.id }]);
});
