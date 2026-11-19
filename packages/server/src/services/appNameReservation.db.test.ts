import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterEach } from "vitest";

import { APP_NAME_RESERVED_CODE } from "@botiverse/raft-shared";
import { fixturePasswordHash } from "../test/integration/credentials";
import { dbTest as test } from "../test/integration/dbTest";
import { getDb } from "../db/index";
import { oauthClients, officialAppRegistry, users } from "../db/schema";
import { RefusalError } from "../lib/refusal";
import { createServer } from "./serverService";
import { createOAuthClient, updateOAuthClient } from "./oauthService";

// #proj-apps:#69: an App outside an official publisher can't be named as Raft
// (toasts and confirm dialogs read "{App name}: …"), at creation or rename.
// An App that already has such a name keeps saving its other fields.


const originalPrimary = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
const originalExtra = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
afterEach(() => {
  for (const [key, value] of [["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalPrimary], ["RAFT_OFFICIAL_PUBLISHER_SERVER_IDS", originalExtra]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function seedServer(label: string) {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(label, `${label}-${suffix.slice(0, 8)}`, owner!.id);
  return { owner: owner!, server };
}

function assertReserved(err: unknown): true {
  assert.ok(err instanceof RefusalError, String(err));
  assert.equal(err.status, 400);
  assert.equal(err.refusal.code, APP_NAME_RESERVED_CODE);
  return true;
}

test("creating or renaming an App to a name that reads as Raft is refused outside an official publisher", async ({ db }) => {
  void db;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  const { owner, server } = await seedServer("reserved-name");
  const short = randomUUID().slice(0, 8);

  for (const name of ["Raft", "R a f t", "Rаft", "Raft Official"]) {
    await assert.rejects(createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `r-${short}-${name.length}`, name }), assertReserved);
  }
  assert.equal((await getDb().select().from(oauthClients).where(eq(oauthClients.serverId, server.id))).length, 0);

  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `own-${short}`, name: "Raft Notes Sync" });
  await assert.rejects(updateOAuthClient({ serverId: server.id, clientId: client.id, actorUserId: owner.id, name: "RAFT" }), assertReserved);
  const [after] = await getDb().select({ name: oauthClients.name }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(after!.name, "Raft Notes Sync");
});

test("an App that already has a reserved name still saves its other fields, and can't move to another reserved name", async ({ db }) => {
  void db;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  const { owner, server } = await seedServer("legacy-name");
  const short = randomUUID().slice(0, 8);
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `legacy-${short}`, name: "Placeholder" });
  // As it was before the rule: written directly.
  await getDb().update(oauthClients).set({ name: "Raft" }).where(eq(oauthClients.id, client.id));

  // The settings form sends the name unchanged with every save.
  const saved = await updateOAuthClient({ serverId: server.id, clientId: client.id, actorUserId: owner.id, name: "Raft", description: "Edited" });
  assert.equal(saved?.name, "Raft");
  assert.equal(saved?.description, "Edited");

  await assert.rejects(updateOAuthClient({ serverId: server.id, clientId: client.id, actorUserId: owner.id, name: "Raft Bot" }), assertReserved);
  const renamed = await updateOAuthClient({ serverId: server.id, clientId: client.id, actorUserId: owner.id, name: "Notes Sync" });
  assert.equal(renamed?.name, "Notes Sync");
});

test("an official publisher's Apps may use the name", async ({ db }) => {
  void db;
  const { owner, server } = await seedServer("publisher");
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID = server.id;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  const short = randomUUID().slice(0, 8);
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `official-${short}`, name: "Raft" });
  assert.equal(client.name, "Raft");
  const renamed = await updateOAuthClient({ serverId: server.id, clientId: client.id, actorUserId: owner.id, name: "Raft Bot" });
  assert.equal(renamed?.name, "Raft Bot");

  const extra = await seedServer("extra-publisher");
  process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS = extra.server.id;
  const { client: extraClient } = await createOAuthClient({ serverId: extra.server.id, createdByUserId: extra.owner.id, clientId: `extra-${short}`, name: "Slock" });
  assert.equal(extraClient.name, "Slock");
});

test("only an approved official registry entry lets an App be renamed to such a name off a publisher Server", async ({ db }) => {
  void db;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
  delete process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_IDS;
  const { owner, server } = await seedServer("registered");
  const short = randomUUID().slice(0, 8);
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `reg-${short}`, name: "Placeholder" });
  const rename = () => updateOAuthClient({ serverId: server.id, clientId: client.id, actorUserId: owner.id, name: "Raft Billing" });
  // No entry, a pending entry, a disabled entry: refused (Raft hasn't vouched, or no longer does).
  await assert.rejects(rename(), assertReserved);
  await getDb().insert(officialAppRegistry).values({ oauthClientId: client.id, clientKey: client.clientId, publisherServerId: server.id, purpose: "Test" });
  await assert.rejects(rename(), assertReserved);
  await getDb().update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, client.id));
  await assert.rejects(rename(), assertReserved);
  // Approved: allowed. Creation keeps the publisher-Server rule.
  await getDb().update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, client.id));
  assert.equal((await rename())?.name, "Raft Billing");
});
