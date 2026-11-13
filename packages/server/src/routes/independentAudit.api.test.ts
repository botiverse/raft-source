import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import argon2 from "argon2";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import { verifyToken } from "../middleware/auth";
import { accessTokenForTest } from "../test/integration/credentials";
import { machines } from "../db/schema";
import { clearAuthCache, findMachineByApiKey, registerMachine } from "../services/machineService";

const test = createApiTest();

for (const change of ["migration", "rotation", "deletion"] as const) {
  test(`machine auth rechecks ${change} committed during key verification`, async ({ seed, db }) => {
    const owner = await seed.human();
    const server = await seed.server({ owner });
    const { machine, apiKey } = await registerMachine(server.id, owner.id, "audit-racing-machine");
    const verify = argon2.verify.bind(argon2);
    const spy = vi.spyOn(argon2, "verify").mockImplementationOnce(async (hash, key, options) => {
      const valid = await verify(hash, key, options);
      if (change === "migration") {
        await db.update(machines).set({ legacyKeyMigratedAt: new Date() }).where(eq(machines.id, machine.id));
      } else if (change === "rotation") {
        await db.update(machines).set({ apiKeyHash: await argon2.hash("rotated-test-key") }).where(eq(machines.id, machine.id));
      } else {
        await db.delete(machines).where(eq(machines.id, machine.id));
      }
      clearAuthCache(machine.id); // invalidation happens before the old verify returns
      return valid;
    });
    try {
      const result = await findMachineByApiKey(apiKey);
      if (change === "migration") assert.ok(result?.legacyKeyMigratedAt);
      else assert.equal(result, null);
      const cached = await findMachineByApiKey(apiKey);
      if (change === "migration") assert.ok(cached?.legacyKeyMigratedAt);
      else assert.equal(cached, null);
    } finally {
      spy.mockRestore();
      clearAuthCache(machine.id);
    }
  });
}

test("migration rejects a legacy machine key even when another worker's cache is warm", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const { machine, apiKey } = await registerMachine(server.id, owner.id, "audit-cache-machine");
  // Machine keys no longer read attachments at all (#proj-raft-computer:8e6a4629);
  // the legacy machine surface goes through the same requireMachineAuth cache.
  const read = () => fetch(`${app.baseUrl}/internal/machine/agents`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  try {
    const before = await read();
    assert.equal(before.status, 200);
    await before.json();
    // Model the state visible on worker B after worker A commits adoption:
    // shared DB has the marker, but B's process-local cache is untouched.
    // This is a single-process stale-cache reproduction, not a two-worker test.
    await db.update(machines).set({ legacyKeyMigratedAt: new Date() }).where(eq(machines.id, machine.id));
    const stale = await read();
    const staleStatus = stale.status;
    await stale.json();
    clearAuthCache(machine.id);
    const cold = await read();
    assert.equal(cold.status, 401, "control: authoritative migrated state must reject this key");
    await cold.json();
    assert.equal(staleStatus, 401, "a cached pre-migration identity must not authorize the machine surface");
  } finally {
    clearAuthCache(machine.id);
  }
});

test("logging out a device-issued token prevents it from creating a fresh session", async ({ app, seed }) => {
  vi.stubEnv("AGENT_BOOTSTRAP_TOKEN_PEPPER", "audit-device-pepper-0123456789abcdef0123456789");
  try {
    const owner = await seed.human();
    const post = (path: string, body: object, token?: string) => fetch(`${app.baseUrl}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const authorize = async () => {
      const response = await post("device/authorize", { clientName: "audit-device" });
      assert.equal(response.status, 201);
      return await response.json() as { userCode: string; deviceCode: string };
    };
    const grant = await authorize();
    // Approving takes describe's ticket, as the approval page does.
    const ownerToken = await accessTokenForTest(owner.id);
    const described = await post("device/describe", { userCode: grant.userCode }, ownerToken);
    assert.equal(described.status, 200);
    const { approvalTicket } = await described.json() as { approvalTicket: string };
    const approved = await post("device/approve", { userCode: grant.userCode, approvalTicket }, ownerToken);
    assert.equal(approved.status, 200);
    await approved.json();
    const issued = await post("device/token", { deviceCode: grant.deviceCode });
    assert.equal(issued.status, 200);
    const original = await issued.json() as { accessToken: string; refreshToken: string };
    const loggedOut = await post("logout", { refreshToken: original.refreshToken });
    assert.equal(loggedOut.status, 200);
    await loggedOut.json();
    const oldRefresh = await post("refresh", { refreshToken: original.refreshToken });
    assert.equal(oldRefresh.status, 401, "control: the original refresh session really was revoked");
    await oldRefresh.json();

    const attackerGrant = await authorize();
    const attempted = await post("device/approve", { userCode: attackerGrant.userCode }, original.accessToken);
    const approvalStatus = attempted.status;
    await attempted.json();
    let freshSessionIssued = false;
    if (approvalStatus === 200) {
      const newSession = await post("device/token", { deviceCode: attackerGrant.deviceCode });
      assert.equal(newSession.status, 200);
      const replacement = await newSession.json() as { refreshToken?: string };
      if (replacement.refreshToken) {
        const refreshed = await post("refresh", { refreshToken: replacement.refreshToken });
        freshSessionIssued = refreshed.status === 200;
        await refreshed.json();
      }
    }
    assert.deepEqual({
      familyBound: Boolean(verifyToken(original.accessToken).familyId), approvalStatus, freshSessionIssued,
    }, { familyBound: true, approvalStatus: 401, freshSessionIssued: false });
  } finally {
    vi.unstubAllEnvs();
  }
});

test("guest global sync cannot return a channel denied by scoped history", async ({ app, seed, db }) => {
  const owner = await seed.human();
  const guest = await seed.human();
  const server = await seed.server({ owner, members: [guest] });
  // Bound to its own private channel, never the hidden one.
  await seedBoundGuest({ serverId: server.id, userId: guest.id }, db);
  const hidden = await seed.channel({ server, members: [owner], visibility: "channel" });
  const message = await seed.message({ channel: hidden, author: owner, content: "audit-hidden-from-guest" });
  const headers = { Authorization: `Bearer ${await accessTokenForTest(guest.id)}`, "X-Server-Id": server.id };
  const scoped = await fetch(`${app.baseUrl}/api/messages/channel/${hidden.id}`, { headers });
  assert.ok([403, 404].includes(scoped.status), `control: guest must be denied, got ${scoped.status}`);
  await scoped.json();
  const synced = await fetch(`${app.baseUrl}/api/messages/sync?since_seq=0&limit=500`, { headers });
  assert.equal(synced.status, 200);
  const body = await synced.json() as Array<{ id: string }>;
  assert.equal(body.some((item) => item.id === message.id), false,
    "omitting channel_id must not broaden a guest's visibility");
});
