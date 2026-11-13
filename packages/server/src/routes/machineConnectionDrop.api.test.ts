import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { computers, machines, serverMembers, users } from "../db/schema";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { REPLICA_ID, handleReplicaMessage, setMachineConnectionDropHandler, type MachineConnectionDropReason } from "../replicaRouter";

// A rotated or revoked machine key is refused at the next handshake, but an open
// socket used to keep working until it dropped on its own. Rotating a key and
// revoking Computers in a setup reset now close the live connection on every
// replica (#proj-raft-computer:8e6a4629).

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as { accessToken: string }).accessToken;
}

function headers(token: string, serverId: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Server-Id": serverId };
}

async function captureDrops<T>(work: (drops: Array<[string, MachineConnectionDropReason]>) => Promise<T>): Promise<T> {
  const drops: Array<[string, MachineConnectionDropReason]> = [];
  setMachineConnectionDropHandler((machineId, reason) => {
    drops.push([machineId, reason]);
  });
  try {
    return await work(drops);
  } finally {
    setMachineConnectionDropHandler(null);
  }
}

test("rotating a machine key drops its live connection", async ({ app }) => {
  const owner = await seedUser("drop-rotate-owner");
  const server = await createServer("Drop Rotate", `drop-rotate-${randomUUID()}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "drop-rotate-machine");
  const token = await login(app.baseUrl, owner.email);

  await captureDrops(async (drops) => {
    const rotate = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/rotate-key`, {
      method: "POST",
      headers: headers(token, server.id),
    });
    assert.equal(rotate.status, 200);
    assert.deepEqual(drops, [[machine.id, "credential_rotated"]]);
  });
});

test("a setup reset drops the connection of every Computer it revokes", async ({ app }) => {
  const owner = await seedUser("drop-reset-owner");
  const server = await createServer("Drop Reset", `drop-reset-${randomUUID()}`, owner.id);
  const linked = await registerMachine(server.id, owner.id, "drop-reset-machine");
  await getDb().insert(computers).values([
    {
      serverId: server.id,
      name: "linked",
      attachedByUserId: owner.id,
      machineId: linked.machine.id,
      apiKeyHash: "argon2-placeholder",
      apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 6)}`,
    },
    {
      // Never linked to a machine: revoked, but there is no connection to drop.
      serverId: server.id,
      name: "unlinked",
      attachedByUserId: owner.id,
      apiKeyHash: "argon2-placeholder",
      apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 6)}`,
    },
  ]);
  await getDb().update(serverMembers).set({ setupStatus: "in_progress" }).where(eq(serverMembers.serverId, server.id));
  const token = await login(app.baseUrl, owner.email);

  await captureDrops(async (drops) => {
    const reset = await fetch(`${app.baseUrl}/api/servers/${server.id}/setup-reset`, {
      method: "POST",
      headers: headers(token, server.id),
    });
    assert.equal(reset.status, 200, await reset.clone().text());
    assert.equal(((await reset.json()) as { revokedComputers: number }).revokedComputers, 2);
    assert.deepEqual(drops, [[linked.machine.id, "credential_revoked"]]);
  });
});

test("subscriber dispatch: a connection drop is foreign-only, typed and content-free", async () => {
  await captureDrops(async (drops) => {
    const channel = "slock:replica:machine-connection-drop";
    handleReplicaMessage(channel, JSON.stringify({ machineId: "machine-1", reason: "credential_revoked", from: REPLICA_ID }));
    assert.deepEqual(drops, [], "a self-published drop is handled only by the direct local call");
    handleReplicaMessage(channel, JSON.stringify({ machineId: "machine-1", reason: "credential_revoked", from: "other-replica" }));
    assert.deepEqual(drops, [["machine-1", "credential_revoked"]]);
    handleReplicaMessage(channel, JSON.stringify({ machineId: "machine-1", reason: "unlinked", from: "other-replica" }));
    handleReplicaMessage(channel, JSON.stringify({ reason: "credential_rotated", from: "other-replica" }));
    handleReplicaMessage(channel, "not json");
    assert.equal(drops.length, 1, "unknown reasons, missing machine ids and malformed frames are ignored");
  });
});

// A revoked Computer's machine too: a fresh sk_machine_* key there would mint
// runner credentials a per-Computer revoke could not tell from the revoked key's.
for (const state of ["live", "revoked"] as const) {
test(`rotate-key refuses a ${state} Computer: its own key is untouched, so nothing is rotated or dropped (B15)`, async ({ app }) => {
  const owner = await seedUser("drop-b15-owner");
  const server = await createServer("Drop B15", `drop-b15-${randomUUID()}`, owner.id);
  const { machine } = await registerMachine(server.id, owner.id, "drop-b15-computer");
  await getDb().insert(computers).values({
    serverId: server.id,
    name: "drop-b15-computer",
    attachedByUserId: owner.id,
    machineId: machine.id,
    apiKeyHash: "argon2-placeholder",
    apiKeyPrefix: `sk_computer_${randomUUID().slice(0, 6)}`,
    ...(state === "revoked" ? { revokedAt: new Date(), revokedReason: "computer_key_revoked" } : {}),
  });
  const [before] = await getDb().select({ apiKeyHash: machines.apiKeyHash }).from(machines).where(eq(machines.id, machine.id));
  const token = await login(app.baseUrl, owner.email);

  await captureDrops(async (drops) => {
    const rotate = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machine.id}/rotate-key`, {
      method: "POST",
      headers: headers(token, server.id),
    });
    assert.equal(rotate.status, 409);
    const body = await rotate.json() as { code?: string; apiKey?: string };
    assert.equal(body.code, "computer_key_rotation_unsupported");
    assert.equal(body.apiKey, undefined, "no key is handed out");
    assert.deepEqual(drops, []);
  });
  const [after] = await getDb().select({ apiKeyHash: machines.apiKeyHash }).from(machines).where(eq(machines.id, machine.id));
  assert.equal(after?.apiKeyHash, before?.apiKeyHash, "the legacy key is not rotated either");
});
}
