import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { appSumoLicenseBindings, appSumoLicenses, servers } from "../db/schema";
import { getActiveAppSumoGrant, getActiveAppSumoGrants } from "./appSumoLicenseService";

import { parseAppSumoLicenseKey } from "./appSumoContracts";

const key = () => parseAppSumoLicenseKey(randomUUID())!;
const productId = "raft-appsumo-test";
const verifiedAt = new Date("2026-10-28T00:00:00Z");

test("only the bound current provider-confirmed license grants access; old-key revocation is isolated", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server, other] = await db.insert(servers).values([
    { name: "Bound", slug: randomUUID(), ownerId: owner.id },
    { name: "Other", slug: randomUUID(), ownerId: owner.id },
  ]).returning();
  const oldKey = key();
  const currentKey = key();
  await db.insert(appSumoLicenses).values({ productId, licenseKey: oldKey });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: oldKey, currentLicenseKey: oldKey, boundByUserId: owner.id });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  await db.update(appSumoLicenses).set({ status: "active", tier: 1, verifiedAt })
    .where(eq(appSumoLicenses.licenseKey, oldKey));
  assert.equal((await getActiveAppSumoGrant(db, server.id))?.tier, 1);
  assert.equal(await getActiveAppSumoGrant(db, other.id), null);
  const batch = await getActiveAppSumoGrants(db, [server.id, other.id, server.id]);
  assert.deepEqual([...batch.keys()], [server.id]);
  assert.deepEqual(batch.get(server.id), await getActiveAppSumoGrant(db, server.id));
  assert.equal((await getActiveAppSumoGrants(db, [])).size, 0);
  await db.insert(appSumoLicenses).values({ productId, licenseKey: currentKey, previousLicenseKey: oldKey, status: "active", tier: 4, verifiedAt });
  await db.update(appSumoLicenseBindings).set({ currentLicenseKey: currentKey }).where(eq(appSumoLicenseBindings.serverId, server.id));
  await db.update(appSumoLicenses).set({ status: "deactivated" }).where(eq(appSumoLicenses.licenseKey, oldKey));
  assert.equal((await getActiveAppSumoGrant(db, server.id))?.tier, 4);
  await db.update(appSumoLicenses).set({ status: "deactivated" }).where(eq(appSumoLicenses.licenseKey, currentKey));
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
});

test("database rejects unverified active licenses, unknown tiers and double bindings", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server, other] = await db.insert(servers).values([
    { name: "First", slug: randomUUID(), ownerId: owner.id },
    { name: "Second", slug: randomUUID(), ownerId: owner.id },
  ]).returning();
  await assert.rejects(db.insert(appSumoLicenses).values({ productId, licenseKey: key(), status: "active", tier: 1 }));
  await assert.rejects(db.insert(appSumoLicenses).values({ productId, licenseKey: key(), status: "active", tier: 5, verifiedAt }));
  const licenseKey = key();
  await db.insert(appSumoLicenses).values({ productId, licenseKey, status: "active", tier: 2, verifiedAt });
  const binding = { productId, originalLicenseKey: licenseKey, currentLicenseKey: licenseKey, boundByUserId: owner.id };
  await db.insert(appSumoLicenseBindings).values({ ...binding, serverId: server.id });
  await assert.rejects(db.insert(appSumoLicenseBindings).values({ ...binding, serverId: other.id }));
  await assert.rejects(db.insert(appSumoLicenseBindings).values({ ...binding, serverId: server.id }));
});

test("product namespaces cannot alias and deleted servers retain their spent license", async ({ db, seed }) => {
  const owner = await seed.human();
  const [server] = await db.insert(servers).values({ name: "Delete", slug: randomUUID(), ownerId: owner.id }).returning();
  const licenseKey = key();
  await db.insert(appSumoLicenses).values([
    { productId, licenseKey, status: "inactive" },
    { productId: "different-product", licenseKey, status: "active", tier: 4, verifiedAt },
  ]);
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId, originalLicenseKey: licenseKey, currentLicenseKey: licenseKey });
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  await db.update(appSumoLicenses).set({ status: "active", tier: 3, verifiedAt }).where(and(eq(appSumoLicenses.productId, productId), eq(appSumoLicenses.licenseKey, licenseKey)));
  assert.equal((await getActiveAppSumoGrant(db, server.id))?.tier, 3);
  await db.update(servers).set({ deletedAt: verifiedAt }).where(eq(servers.id, server.id));
  assert.equal(await getActiveAppSumoGrant(db, server.id), null);
  await db.delete(servers).where(eq(servers.id, server.id));
  const [receipt] = await db.select().from(appSumoLicenseBindings);
  assert.equal(receipt.serverId, null);
  assert.equal(receipt.originalLicenseKey, licenseKey);
  await assert.rejects(db.insert(appSumoLicenseBindings).values({ productId, originalLicenseKey: licenseKey, currentLicenseKey: licenseKey }));
});
