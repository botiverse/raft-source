import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index";
import { serverMembers, servers, users } from "../db/schema";
import { registerMachine } from "../services/machineService";
import { createServer } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: label,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

async function seedRoles(label: string) {
  const [owner, admin, member, guest] = await Promise.all([
    seedUser(`${label}-owner`),
    seedUser(`${label}-admin`),
    seedUser(`${label}-member`),
    seedUser(`${label}-guest`),
  ]);
  const server = await createServer(label, `${label}-${randomUUID()}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const tokens = {
    owner: await tokenForHuman(owner.email),
    admin: await tokenForHuman(admin.email),
    member: await tokenForHuman(member.email),
    guest: await tokenForHuman(guest.email),
  };
  return { owner, admin, member, guest, server, tokens };
}

function authHeaders(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

test("Server details give Owner/Admin/Member the member profile and Guest only the public projection", async ({ app }) => {
  const { owner, server, tokens } = await seedRoles("phase2-server-profile");
  const unsafeAvatarUrl = "https://third-party.example/signed-private-avatar";
  await getDb().update(servers).set({
    avatarUrl: unsafeAvatarUrl,
    plan: "founder",
    translationEnabled: true,
    publiclyVisible: true,
  }).where(eq(servers.id, server.id));

  for (const role of ["owner", "admin", "member"] as const) {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
      headers: authHeaders(tokens[role], server.id),
    });
    assert.equal(response.status, 200, `${role} retains server.profile.readDetails`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.id, server.id);
    assert.equal(body.ownerId, owner.id);
    assert.equal(body.plan, "founder");
    assert.equal(body.translationEnabled, true);
    assert.equal(body.avatarUrl, unsafeAvatarUrl);
  }

  const guestResponse = await fetch(`${app.baseUrl}/api/servers/${server.id}`, {
    headers: authHeaders(tokens.guest, server.id),
  });
  assert.equal(guestResponse.status, 200, "Guest retains server.profile.readPublic");
  const guestBody = await guestResponse.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(guestBody).sort(), ["avatarUrl", "id", "name", "slug"]);
  assert.deepEqual(guestBody, {
    id: server.id,
    name: "phase2-server-profile",
    slug: server.slug,
    avatarUrl: null,
  });
  for (const forbidden of [
    "ownerId",
    "kind",
    "onboardingAgentId",
    "agentAllChannelGreetingEnabled",
    "hideHumansFromMembers",
    "publiclyVisible",
    "publicGuestJoinEnabled",
    "plan",
    "translationEnabled",
    "planDowngradedAt",
    "createdAt",
    "updatedAt",
  ]) {
    assert.equal(forbidden in guestBody, false, `Guest projection must omit ${forbidden}`);
  }
});

test("Server settings require Owner/Admin while member self-state routes stay readable", async ({ app }) => {
  const { server, tokens } = await seedRoles("phase2-server-settings");

  for (const role of ["owner", "admin"] as const) {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/settings`, {
      headers: authHeaders(tokens[role], server.id),
    });
    assert.equal(response.status, 200, `${role} retains server.settings.read`);
  }

  for (const role of ["member", "guest"] as const) {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/settings`, {
      headers: authHeaders(tokens[role], server.id),
    });
    assert.equal(response.status, 403, `${role} must not receive durable Server settings`);

    const notificationResponse = await fetch(`${app.baseUrl}/api/servers/${server.id}/notification-settings`, {
      headers: authHeaders(tokens[role], server.id),
    });
    assert.equal(notificationResponse.status, 200, `${role} retains exact-self notification state`);
  }

  const memberLegacyPreferences = await fetch(`${app.baseUrl}/api/servers/${server.id}/onboarding-settings`, {
    headers: authHeaders(tokens.member, server.id),
  });
  assert.equal(memberLegacyPreferences.status, 200, "Member onboarding self-state remains separate from Server settings");
});

test("Machine list requires machine.read while a Guest registrant keeps exact-object management", async ({ app }) => {
  const { owner, guest, server, tokens } = await seedRoles("phase2-machine-profile");
  await getDb().update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  const guestMachine = (await registerMachine(server.id, guest.id, "Guest-owned machine")).machine;
  const ownerMachine = (await registerMachine(server.id, owner.id, "Owner-owned machine")).machine;

  for (const role of ["owner", "admin", "member"] as const) {
    const response = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
      headers: authHeaders(tokens[role], server.id),
    });
    assert.equal(response.status, 200, `${role} retains machine.read`);
  }

  const guestList = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines`, {
    headers: authHeaders(tokens.guest, server.id),
  });
  assert.equal(guestList.status, 403, "Guest must not receive the Server-wide Machine list");

  const ownPatch = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${guestMachine.id}`, {
    method: "PATCH",
    headers: authHeaders(tokens.guest, server.id),
    body: JSON.stringify({ description: "still managed by its exact registrant" }),
  });
  assert.equal(ownPatch.status, 200, "Guest registrant retains exact-object machine.update");
  assert.equal(
    (await ownPatch.json() as { description: string | null }).description,
    "still managed by its exact registrant",
  );

  const foreignPatch = await fetch(`${app.baseUrl}/api/servers/${server.id}/machines/${ownerMachine.id}`, {
    method: "PATCH",
    headers: authHeaders(tokens.guest, server.id),
    body: JSON.stringify({ description: "must not widen from one Machine to the collection" }),
  });
  assert.equal(foreignPatch.status, 403);
});
