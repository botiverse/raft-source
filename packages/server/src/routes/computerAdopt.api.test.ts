import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

import argon2 from "argon2";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { computers, integrationAuditEvents, users, machines } from "../db/schema";
import { openTestApp } from "../test/integration/app";
import { accessTokenForTest } from "../test/integration/credentials";
import { createServer, addMember, transitionMemberRole } from "../services/serverService";
import { extractApiKeyFingerprint, extractApiKeyPrefix, registerMachine } from "../services/machineService";
import { __setMachinePrincipalFenceHandlerForTests } from "../replicaRouter";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

// task #39 PR-J1 regression guard — legacy daemon adoption surface
// (RFC v0.8 v8.2 §5.11 / §10.13).
//
// Acceptance matrix from Jianwei (#wg-raft-computer:6f7ff4d2):
//   A. valid key + first call → 201 with sk_computer_* + legacyKeyMigratedAt set
//   A2. valid roster identity + first call → same adoption without raw legacy key
//   A3. valid daemonId identity + manageMachines → same adoption without
//       raw key, fingerprint bytes, or legacy-row ownership
//   B. same key reused → 409 legacy_machine_key_migrated
//   C. invalid/unknown key → 401 legacy_key_invalid
//   D. non-member of server → 403 not_authorized
//   E. feature flag off → 404 computer_adopt_disabled
//   F. cache invalidation: legacy sk_machine_* fails immediately post-adoption
//   G. concurrent: two parallel POSTs → exactly one 201, the other 409

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "Content-Type": "application/json", ...extra };
}

async function withEnv<T>(
  enabled: boolean,
  fn: (app: Awaited<ReturnType<typeof openTestApp>>) => Promise<T>,
): Promise<T> {
  const oldGate = process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  if (enabled) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
  else process.env.SLOCK_DEVICE_LOGIN_ENABLED = "false";
  const app = await openTestApp("pglite://", 0, { humanActivityMuteFlagDefaultEnabled: true });
  try {
    return await fn(app);
  } finally {
    await app.close();
    if (oldGate === undefined) delete process.env.SLOCK_DEVICE_LOGIN_ENABLED;
    else process.env.SLOCK_DEVICE_LOGIN_ENABLED = oldGate;
  }
}

async function seedUser(label = "adopt"): Promise<{ id: string; bearer: string }> {
  const db = getDb();
  const suffix = randomUUID();
  const [u] = await db
    .insert(users)
    .values({
      email: `${label}-${suffix}@slock.test`,
      name: `${label}-${suffix}`,
      displayName: "Adopt Tester",
      passwordHash: await argon2.hash("password123"),
      emailVerified: true,
    })
    .returning();
  return { id: u.id, bearer: await accessTokenForTest(u.id) };
}

test("adopt-legacy: surface 404 when gate explicitly disabled", async () => {
  await withEnv(false, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: `sk_machine_${"a".repeat(64)}` }),
    });
    // When the gate is off the entire /api/computer router isn't mounted, so
    // Express's default HTML 404 handler fires (not a JSON body from us).
    assert.equal(res.status, 404);
  });
});

test("adopt-legacy: requires user auth — unauthenticated rejected", async () => {
  await withEnv(true, async (app) => {
    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ legacyApiKey: `sk_machine_${"a".repeat(64)}` }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { code?: string }).code, "auth_required");
  });
});

test("adopt-legacy: missing legacyApiKey → 400 legacy_api_key_required", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ name: "raft-computer" }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { code?: string }).code, "legacy_api_key_required");
  });
});

test("adopt-legacy A: valid key + first call → 201 sk_computer_* and machine row marked migrated", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Adopt Co", `adopt-${randomUUID()}`, userId);
    const { machine, apiKey: legacyKey } = await registerMachine(server.id, userId, "legacy-daemon");
    const fences: Array<{ machineId: string; principalKind: string }> = [];
    __setMachinePrincipalFenceHandlerForTests((machineId, principalKind) => {
      fences.push({ machineId, principalKind });
    });

    let res!: Response;
    try {
      res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
        body: JSON.stringify({ legacyApiKey: legacyKey, name: "adopted-computer" }),
      });
    } finally {
      __setMachinePrincipalFenceHandlerForTests(null);
    }
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      serverId: string;
      resumed: boolean;
    };
    assert.ok(body.apiKey.startsWith("sk_computer_"));
    assert.equal(body.machineId, machine.id);
    assert.equal(body.serverId, server.id);
    assert.equal(body.resumed, false);
    assert.deepEqual(fences, [{ machineId: machine.id, principalKind: "legacy_machine" }]);

    const db = getDb();
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);

    // End-to-end: fresh sk_computer_* authenticates the §9 preflight surface.
    const pre = await fetch(`${app.baseUrl}/internal/computer/preflight`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${body.apiKey}` }),
      body: "{}",
    });
    assert.equal(pre.status, 200);
    const pj = (await pre.json()) as { ok?: boolean; principal?: { kind?: string } };
    assert.equal(pj.ok, true);
    assert.equal(pj.principal?.kind, "computer");
  });
});

test("adopt-legacy A2: roster identity + first call → 201 without raw legacy key", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `adopt-fp-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, userId);
    const { machine, apiKey: legacyKey } = await registerMachine(server.id, userId, "legacy-daemon");
    const fp = extractApiKeyFingerprint(legacyKey);

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({
        serverSlug: slug,
        legacyMachineId: machine.id,
        apiKeyFingerprint: fp,
        name: "adopted-computer",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      serverId: string;
      resumed: boolean;
    };
    assert.ok(body.apiKey.startsWith("sk_computer_"));
    assert.equal(body.machineId, machine.id);
    assert.equal(body.serverId, server.id);
    assert.equal(body.resumed, false);

    const db = getDb();
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);
  });
});

test("adopt-legacy A3: daemonId identity + NULL fingerprint → 201 without raw legacy key", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, userId);
    const { machine } = await registerMachine(server.id, userId, "legacy-daemon");
    const db = getDb();
    await db
      .update(machines)
      .set({ apiKeyFingerprint: null })
      .where(eq(machines.id, machine.id));

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({
        serverSlug: slug,
        daemonId: machine.id,
        name: "adopted-computer",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      serverId: string;
      resumed: boolean;
    };
    assert.ok(body.apiKey.startsWith("sk_computer_"));
    assert.equal(body.machineId, machine.id);
    assert.equal(body.serverId, server.id);
    assert.equal(body.resumed, false);

    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);
  });
});

test("adopt-legacy A2: roster identity is user-scoped, not raw possession", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const outsider = await seedUser("outsider");
    const slug = `adopt-fp-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, owner.id);
    await addMember(server.id, outsider.id);
    const { machine, apiKey: legacyKey } = await registerMachine(server.id, owner.id, "owner-daemon");
    const fp = extractApiKeyFingerprint(legacyKey);

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${outsider.bearer}` }),
      body: JSON.stringify({
        serverSlug: slug,
        legacyMachineId: machine.id,
        apiKeyFingerprint: fp,
        name: "outsider-computer",
      }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { code?: string }).code, "legacy_key_invalid");

    const db = getDb();
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.equal(row.legacyKeyMigratedAt, null);
  });
});

test("adopt-legacy A3: server admin can adopt another user's row and retry resumes the same Computer", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const admin = await seedUser("admin");
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, owner.id);
    await addMember(server.id, admin.id, "admin");
    const { machine } = await registerMachine(server.id, owner.id, "owner-daemon");
    const body = JSON.stringify({
      serverSlug: slug,
      daemonId: machine.id,
      name: "admin-adopted-computer",
    });

    const first = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${admin.bearer}` }),
      body,
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      resumed: boolean;
    };
    assert.equal(firstBody.machineId, machine.id);
    assert.equal(firstBody.resumed, false);

    const second = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${admin.bearer}` }),
      body,
    });
    assert.equal(second.status, 201);
    const secondBody = (await second.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      resumed: boolean;
    };
    assert.equal(secondBody.computerId, firstBody.computerId);
    assert.equal(secondBody.machineId, machine.id);
    assert.equal(secondBody.resumed, true);
    assert.notEqual(secondBody.apiKey, firstBody.apiKey);

    const db = getDb();
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);

    // The first adoption moved another member's machine: audited once (the
    // retry is a resume, not a second move), naming who moved it and whose it was.
    const moved = await db.select().from(integrationAuditEvents).where(and(
      eq(integrationAuditEvents.serverId, server.id),
      eq(integrationAuditEvents.eventType, "computer.legacy_adopted_by_other"),
    ));
    assert.equal(moved.length, 1);
    assert.equal(moved[0]!.actorId, admin.id);
    assert.equal(moved[0]!.subjectId, owner.id);
    assert.equal(moved[0]!.targetId, firstBody.computerId);
    assert.equal(moved[0]!.metadata.via, "session");
    assert.equal(moved[0]!.metadata.machineAddedByUserId, owner.id);
    assert.equal(moved[0]!.metadata.grantId, undefined);

    // Only the resume rotated a key: one computer.key_rotated, without the key.
    const rotated = await db.select().from(integrationAuditEvents).where(and(
      eq(integrationAuditEvents.serverId, server.id),
      eq(integrationAuditEvents.eventType, "computer.key_rotated"),
    ));
    assert.equal(rotated.length, 1);
    assert.equal(rotated[0]!.actorType, "human");
    assert.equal(rotated[0]!.actorId, admin.id);
    assert.equal(rotated[0]!.requesterId, admin.id, "the admin attached the Computer on the first adoption");
    assert.equal(rotated[0]!.targetType, "computer");
    assert.equal(rotated[0]!.targetId, firstBody.computerId);
    assert.deepEqual(rotated[0]!.metadata, {
      computerId: firstBody.computerId,
      computerName: "admin-adopted-computer",
      machineId: machine.id,
      reason: "adoption_resume",
      actorRole: "admin",
    });
    assert.ok(!JSON.stringify(rotated).includes(secondBody.apiKey));
  });
});

test("adopt-legacy A3: row creator keeps adoption authority after demotion to member", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const rowOwner = await seedUser("row-owner");
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, owner.id);
    await addMember(server.id, rowOwner.id, "member");
    const { machine } = await registerMachine(server.id, rowOwner.id, "member-daemon");

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${rowOwner.bearer}` }),
      body: JSON.stringify({ serverSlug: slug, daemonId: machine.id }),
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json() as { machineId?: string }).machineId, machine.id);

    const missing = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${rowOwner.bearer}` }),
      body: JSON.stringify({ serverSlug: slug, daemonId: randomUUID() }),
    });
    assert.equal(missing.status, 403, "creator override must not allow a member to enumerate other row identities");
    assert.equal((await missing.json() as { code?: string }).code, "requires_admin");

    const db = getDb();
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);
  });
});

async function adoptByDaemonId(app: Awaited<ReturnType<typeof openTestApp>>, bearer: string, serverSlug: string, daemonId: string) {
  const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
    body: JSON.stringify({ serverSlug, daemonId }),
  });
  return { status: res.status, body: (await res.json()) as { code?: string; apiKey?: string; computerId?: string; resumed?: boolean } };
}

async function computerPreflightStatus(app: Awaited<ReturnType<typeof openTestApp>>, apiKey: string): Promise<number> {
  const res = await fetch(`${app.baseUrl}/internal/computer/preflight`, {
    method: "POST",
    headers: jsonHeaders({ Authorization: `Bearer ${apiKey}` }),
    body: "{}",
  });
  return res.status;
}

test("adopt-legacy A3: registrant without registerMachines cannot re-adopt a machine whose attached Computer was revoked", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const registrant = await seedUser("registrant");
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, owner.id);
    await addMember(server.id, registrant.id, "admin");

    // Attached through the regular attach flow while admin: legacyKeyMigratedAt stays NULL.
    const attach = await fetch(`${app.baseUrl}/api/computer/attach`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${registrant.bearer}` }),
      body: JSON.stringify({ serverSlug: slug, name: "attached-computer" }),
    });
    assert.equal(attach.status, 201);
    const { machineId } = (await attach.json()) as { machineId: string };

    await transitionMemberRole({ serverId: server.id, actorUserId: owner.id, targetUserId: registrant.id, nextRole: "member" });
    const revoke = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${machineId}/revoke-computer-key`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${owner.bearer}`, "X-Server-Id": server.id }),
      body: "{}",
    });
    assert.equal(revoke.status, 200);

    const db = getDb();
    const before = await db.select({ id: computers.id }).from(computers).where(eq(computers.machineId, machineId));

    const refused = await adoptByDaemonId(app, registrant.bearer, slug, machineId);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "requires_admin");

    const after = await db.select({ id: computers.id }).from(computers).where(eq(computers.machineId, machineId));
    assert.equal(after.length, before.length, "no new Computer row");
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machineId));
    assert.equal(row.legacyKeyMigratedAt, null, "refusal leaves the machine row untouched");

    // An admin keeps the authority to adopt it.
    const adopted = await adoptByDaemonId(app, owner.bearer, slug, machineId);
    assert.equal(adopted.status, 201);
    assert.equal(adopted.body.resumed, false);
  });
});

test("adopt-legacy A2/A3: registrant without registerMachines cannot rotate a Computer an admin attached", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const registrant = await seedUser("registrant");
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, owner.id);
    await addMember(server.id, registrant.id, "member");
    const { machine, apiKey: legacyKey } = await registerMachine(server.id, registrant.id, "member-daemon");

    const adminAdopted = await adoptByDaemonId(app, owner.bearer, slug, machine.id);
    assert.equal(adminAdopted.status, 201);
    const adminKey = adminAdopted.body.apiKey!;

    const byDaemonId = await adoptByDaemonId(app, registrant.bearer, slug, machine.id);
    assert.equal(byDaemonId.status, 403);
    assert.equal(byDaemonId.body.code, "requires_admin");

    const byFingerprint = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${registrant.bearer}` }),
      body: JSON.stringify({ serverSlug: slug, legacyMachineId: machine.id, apiKeyFingerprint: extractApiKeyFingerprint(legacyKey) }),
    });
    assert.equal(byFingerprint.status, 403);
    assert.equal((await byFingerprint.json() as { code?: string }).code, "requires_admin");

    assert.equal(await computerPreflightStatus(app, adminKey), 200, "the admin's Computer key still authenticates");
    const db = getDb();
    const rotated = await db.select().from(integrationAuditEvents).where(and(
      eq(integrationAuditEvents.serverId, server.id),
      eq(integrationAuditEvents.eventType, "computer.key_rotated"),
    ));
    assert.equal(rotated.length, 0);

    // The admin can still resume their own adoption.
    const resumed = await adoptByDaemonId(app, owner.bearer, slug, machine.id);
    assert.equal(resumed.status, 201);
    assert.equal(resumed.body.resumed, true);
    assert.equal(resumed.body.computerId, adminAdopted.body.computerId);
  });
});

test("adopt-legacy A3: member registrant adopts a never-migrated machine and resumes their own adoption", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const registrant = await seedUser("registrant");
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, owner.id);
    await addMember(server.id, registrant.id, "member");
    const { machine } = await registerMachine(server.id, registrant.id, "member-daemon");

    const first = await adoptByDaemonId(app, registrant.bearer, slug, machine.id);
    assert.equal(first.status, 201);
    assert.equal(first.body.resumed, false);

    const second = await adoptByDaemonId(app, registrant.bearer, slug, machine.id);
    assert.equal(second.status, 201);
    assert.equal(second.body.resumed, true);
    assert.equal(second.body.computerId, first.body.computerId);
    assert.notEqual(second.body.apiKey, first.body.apiKey);
    assert.equal(await computerPreflightStatus(app, second.body.apiKey!), 200);
  });
});

test("adopt-legacy A3: manager gets typed legacy_machine_not_found for missing or wrong-server row", async () => {
  await withEnv(true, async (app) => {
    const manager = await seedUser("manager");
    const otherOwner = await seedUser("other-owner");
    const slug = `adopt-daemon-${randomUUID()}`;
    const targetServer = await createServer("Target Co", slug, manager.id);
    const otherServer = await createServer("Other Co", `other-${randomUUID()}`, otherOwner.id);
    const { machine: otherMachine } = await registerMachine(otherServer.id, otherOwner.id, "other-daemon");

    for (const daemonId of [randomUUID(), otherMachine.id]) {
      const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
        method: "POST",
        headers: jsonHeaders({ Authorization: `Bearer ${manager.bearer}` }),
        body: JSON.stringify({ serverSlug: slug, daemonId }),
      });
      assert.equal(res.status, 404);
      assert.equal((await res.json() as { code?: string }).code, "legacy_machine_not_found");
    }

    const db = getDb();
    const [otherRow] = await db
      .select({ serverId: machines.serverId, legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, otherMachine.id));
    assert.equal(otherRow.serverId, otherServer.id);
    assert.equal(otherRow.legacyKeyMigratedAt, null);
    assert.notEqual(otherRow.serverId, targetServer.id);
  });
});

test("adopt-legacy A3: migrated daemon-id row without a linked Computer stays typed stale-row conflict", async () => {
  await withEnv(true, async (app) => {
    const manager = await seedUser("manager");
    const slug = `adopt-daemon-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, manager.id);
    const { machine } = await registerMachine(server.id, manager.id, "stale-daemon");
    const db = getDb();
    await db
      .update(machines)
      .set({ legacyKeyMigratedAt: new Date() })
      .where(eq(machines.id, machine.id));

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${manager.bearer}` }),
      body: JSON.stringify({ serverSlug: slug, daemonId: machine.id }),
    });
    assert.equal(res.status, 409);
    assert.equal((await res.json() as { code?: string }).code, "legacy_machine_key_migrated");

    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);
  });
});

test("adopt-legacy A2: roster identity retry resumes existing Computer instead of requiring raw key", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const slug = `adopt-fp-${randomUUID()}`;
    const server = await createServer("Adopt Co", slug, userId);
    const { machine, apiKey: legacyKey } = await registerMachine(server.id, userId, "legacy-daemon");
    const fp = extractApiKeyFingerprint(legacyKey);
    const body = JSON.stringify({
      serverSlug: slug,
      legacyMachineId: machine.id,
      apiKeyFingerprint: fp,
      name: "adopted-computer",
    });

    const first = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body,
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      resumed: boolean;
    };
    assert.equal(firstBody.machineId, machine.id);
    assert.equal(firstBody.resumed, false);

    const second = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body,
    });
    assert.equal(second.status, 201);
    const secondBody = (await second.json()) as {
      apiKey: string;
      computerId: string;
      machineId: string;
      resumed: boolean;
    };
    assert.equal(secondBody.computerId, firstBody.computerId);
    assert.equal(secondBody.machineId, machine.id);
    assert.equal(secondBody.resumed, true);
    assert.notEqual(secondBody.apiKey, firstBody.apiKey, "retry rotates the Computer credential");
  });
});

test("adopt-legacy B: same key reused → 409 legacy_machine_key_migrated", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Adopt Co", `adopt-${randomUUID()}`, userId);
    const { apiKey: legacyKey } = await registerMachine(server.id, userId, "legacy-daemon");

    const first = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(first.status, 201);

    const second = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(second.status, 409);
    assert.equal((await second.json() as { code?: string }).code, "legacy_machine_key_migrated");
  });
});

test("adopt-legacy C: unknown sk_machine_* → 401 legacy_key_invalid", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: `sk_machine_${"f".repeat(64)}` }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { code?: string }).code, "legacy_key_invalid");
  });
});

test("adopt-legacy: sk_daemon_* legacy key is accepted (auth middleware prefix parity)", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Adopt Daemon Co", `adopt-${randomUUID()}`, userId);

    // The legacy auth middleware (packages/server/src/middleware/auth.ts)
    // accepts both `sk_machine_*` and the older `sk_daemon_*` prefix. Seed a
    // machine row with a `sk_daemon_*` key to confirm adopt-legacy doesn't
    // silently exclude that slice of legacy daemons.
    const legacyKey = `sk_daemon_${randomBytes(32).toString("hex")}`;
    const apiKeyHash = await argon2.hash(legacyKey);
    const apiKeyPrefix = extractApiKeyPrefix(legacyKey);
    const db = getDb();
    const [machine] = await db
      .insert(machines)
      .values({
        serverId: server.id,
        userId,
        name: "legacy-sk-daemon",
        apiKeyHash,
        apiKeyPrefix,
      })
      .returning();

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      apiKey: string;
      machineId: string;
      serverId: string;
    };
    assert.ok(body.apiKey.startsWith("sk_computer_"));
    assert.equal(body.machineId, machine.id);
    assert.equal(body.serverId, server.id);

    // And the machine row is now marked migrated, just like the sk_machine_* path.
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);
  });
});

test("adopt-legacy C: non-machine prefix → 401 legacy_key_invalid", async () => {
  await withEnv(true, async (app) => {
    const { bearer } = await seedUser();
    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: `sk_computer_${"a".repeat(64)}` }),
    });
    assert.equal(res.status, 401);
    assert.equal((await res.json() as { code?: string }).code, "legacy_key_invalid");
  });
});

test("adopt-legacy D: caller not member of machine's server → 403 not_authorized", async () => {
  await withEnv(true, async (app) => {
    const owner = await seedUser("owner");
    const stranger = await seedUser("stranger");
    const server = await createServer("Closed Co", `closed-${randomUUID()}`, owner.id);
    const { apiKey: legacyKey } = await registerMachine(server.id, owner.id, "legacy-daemon");

    const res = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { code?: string }).code, "not_authorized");

    // Added as a plain member, the SAME raw-key request is still rejected —
    // key possession alone is NOT enough; adoption mints a Computer attachment
    // and so requires the manageMachines capability (owner/admin). The member
    // gets the distinct `requires_admin` code, not `not_authorized`.
    await addMember(server.id, stranger.id, "member");
    const plainMember = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(plainMember.status, 403);
    assert.equal((await plainMember.json() as { code?: string }).code, "requires_admin");

    // Elevated to admin (manageMachines = true), the SAME request succeeds —
    // proves the 403s were authorization (not malformed key + not enumeration).
    await transitionMemberRole({
      serverId: server.id,
      actorUserId: owner.id,
      targetUserId: stranger.id,
      nextRole: "admin",
    });
    const nowAdmin = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${stranger.bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(nowAdmin.status, 201);
  });
});

test("adopt-legacy F: post-adoption the legacy sk_machine_* fails immediately on /internal/machine/*", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Adopt Co", `adopt-${randomUUID()}`, userId);
    const { apiKey: legacyKey } = await registerMachine(server.id, userId, "legacy-daemon");

    // Warm the auth cache by exercising the legacy key on a machine-authed route.
    const warm = await fetch(`${app.baseUrl}/internal/machine/agents`, {
      method: "GET",
      headers: { Authorization: `Bearer ${legacyKey}` },
    });
    assert.notEqual(warm.status, 401, "legacy key must work before adoption");

    const adopt = await fetch(`${app.baseUrl}/api/computer/adopt-legacy`, {
      method: "POST",
      headers: jsonHeaders({ Authorization: `Bearer ${bearer}` }),
      body: JSON.stringify({ legacyApiKey: legacyKey }),
    });
    assert.equal(adopt.status, 201);

    // Immediately after adoption — no TTL window — legacy key must be rejected.
    const post = await fetch(`${app.baseUrl}/internal/machine/agents`, {
      method: "GET",
      headers: { Authorization: `Bearer ${legacyKey}` },
    });
    assert.equal(post.status, 401);
    const pj = (await post.json().catch(() => ({}))) as { code?: string };
    assert.equal(pj.code, "legacy_machine_key_migrated");
  });
});

test("adopt-legacy G: concurrent requests with same key → exactly one 201, the other 409", async () => {
  await withEnv(true, async (app) => {
    const { id: userId, bearer } = await seedUser();
    const server = await createServer("Adopt Co", `adopt-${randomUUID()}`, userId);
    const { machine, apiKey: legacyKey } = await registerMachine(server.id, userId, "legacy-daemon");

    const headers = jsonHeaders({ Authorization: `Bearer ${bearer}` });
    const body = JSON.stringify({ legacyApiKey: legacyKey });
    const [a, b] = await Promise.all([
      fetch(`${app.baseUrl}/api/computer/adopt-legacy`, { method: "POST", headers, body }),
      fetch(`${app.baseUrl}/api/computer/adopt-legacy`, { method: "POST", headers, body }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected exactly one winner; got ${statuses.join(",")}`);

    const loser = a.status === 409 ? a : b;
    assert.equal((await loser.json() as { code?: string }).code, "legacy_machine_key_migrated");

    // DB invariant: machine row marked migrated exactly once.
    const db = getDb();
    const [row] = await db
      .select({ legacyKeyMigratedAt: machines.legacyKeyMigratedAt })
      .from(machines)
      .where(eq(machines.id, machine.id));
    assert.notEqual(row.legacyKeyMigratedAt, null);
  });
});
