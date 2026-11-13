import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import type { Database } from "../db/index";
import { machines, servers, users } from "../db/schema";
import { recordCredentialExposure, regenerateApiKey } from "./machineService";
import { buildMachineReadModel, withoutMachineKeySecrets } from "./machineReadModel";

const FINGERPRINT = "0123456789abcdef";

async function seed(db: Database, suffix: string) {
  const [owner] = await db.insert(users).values({ email: `exposure-owner-${suffix}@example.com`, name: `owner-${suffix}`, passwordHash: "test" }).returning();
  const [server] = await db.insert(servers).values({ name: `exposure-${suffix}`, slug: `exposure-${suffix}`, ownerId: owner!.id }).returning();
  const [machine] = await db.insert(machines).values({
    serverId: server!.id,
    userId: owner!.id,
    name: "legacy",
    apiKeyHash: "test",
    apiKeyFingerprint: FINGERPRINT,
  }).returning();
  return { owner: owner!, machine: machine! };
}

const readExposure = async (db: Database, id: string) =>
  (await db.select({ at: machines.credentialExposureFoundAt }).from(machines).where(eq(machines.id, id)))[0]!.at;

test("an exposure of the current key is stored once, the first finding kept", async ({ db }) => {
  const { machine } = await seed(db, "store");
  const first = new Date("2026-11-03T11:00:00.000Z");
  assert.equal(await recordCredentialExposure(machine.id, { foundAt: first, keyFingerprint: FINGERPRINT }), true);
  assert.equal(await recordCredentialExposure(machine.id, { foundAt: new Date("2026-11-04T11:00:00.000Z"), keyFingerprint: FINGERPRINT }), true);
  assert.equal((await readExposure(db, machine.id))?.toISOString(), first.toISOString());
});

test("an exposure of a key that is no longer the stored one, or already retired, is not stored", async ({ db }) => {
  const { machine } = await seed(db, "stale");
  assert.equal(await recordCredentialExposure(machine.id, { foundAt: new Date(), keyFingerprint: "fedcba9876543210" }), false);
  assert.equal(await readExposure(db, machine.id), null);
  await db.update(machines).set({ legacyKeyMigratedAt: new Date() }).where(eq(machines.id, machine.id));
  assert.equal(await recordCredentialExposure(machine.id, { foundAt: new Date(), keyFingerprint: FINGERPRINT }), false);
  assert.equal(await readExposure(db, machine.id), null);
});

test("only the machine's owner sees the exposure, and only while the key is not retired", async ({ db }) => {
  const { owner, machine } = await seed(db, "read");
  await recordCredentialExposure(machine.id, { foundAt: new Date("2026-11-03T11:00:00.000Z"), keyFingerprint: FINGERPRINT });
  const [row] = await db.select().from(machines).where(eq(machines.id, machine.id));
  const orchestrator = {
    getMachineStatus: async () => "online" as const,
    getMachineStatusVersion: async () => 1,
    getMachineDaemonVersion: () => null,
  };
  assert.equal("credentialExposureFoundAt" in withoutMachineKeySecrets(row!), false);
  assert.equal((await buildMachineReadModel(row!, orchestrator, { viewerUserId: owner.id })).credentialExposureFoundAt, "2026-11-03T11:00:00.000Z");
  assert.equal((await buildMachineReadModel(row!, orchestrator, { viewerUserId: "someone-else" })).credentialExposureFoundAt, null);
  assert.equal((await buildMachineReadModel(row!, orchestrator)).credentialExposureFoundAt, null);
  assert.equal((await buildMachineReadModel({ ...row!, legacyKeyMigratedAt: new Date() }, orchestrator, { viewerUserId: owner.id })).credentialExposureFoundAt, null);
});

test("a key rotation through the API ends the exposure: the exposed key is no longer the key", async ({ db }) => {
  const { machine } = await seed(db, "rotate");
  await recordCredentialExposure(machine.id, { foundAt: new Date("2026-11-03T11:00:00.000Z"), keyFingerprint: FINGERPRINT });
  assert.ok(await readExposure(db, machine.id));
  await regenerateApiKey(machine.id);
  assert.equal(await readExposure(db, machine.id), null);
});

test("adopting the machine as a Computer (the key retired) ends the exposure", async ({ db }) => {
  const source = await import("node:fs").then((fs) => fs.readFileSync(new URL("./computerAdoptionService.ts", import.meta.url), "utf8"));
  assert.match(source, /\.set\(\{ legacyKeyMigratedAt: new Date\(\), credentialExposureFoundAt: null \}\)/);
  void db;
});
