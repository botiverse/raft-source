import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { eq } from "drizzle-orm";

import { serverAgentMembers, serverMembers, users } from "../db/schema.js";
import { getDb } from "../db/index.js";
import { createAgent } from "../services/agentService.js";
import { createServer } from "../services/serverService.js";
import { actorHasServerCapabilityInServer, resolveActorContext } from "./actorPermissions.js";
import { assertActorServerCapabilityMatrix } from "../test/actorCapabilityMatrix.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

test("actor permissions resolve human and agent server roles through the shared capability matrix", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("actor-permissions-owner");
  const admin = await seedUser("actor-permissions-admin");
  const member = await seedUser("actor-permissions-member");
  const server = await createServer("Actor Permissions", "actor-permissions", owner.id);
  await db.insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);

  const agent = await createAgent(server.id, "actor-permissions-agent", { runtime: "codex" });

  await assertActorServerCapabilityMatrix({
    surface: "mention Add member-management authority",
    serverId: server.id,
    capability: "addChannelMembers",
    cases: [
      { label: "human owner", actorType: "user", actorId: owner.id, expected: true },
      { label: "human admin", actorType: "user", actorId: admin.id, expected: true },
      { label: "human member", actorType: "user", actorId: member.id, expected: true },
      { label: "agent member", actorType: "agent", actorId: agent.id, expected: true },
    ],
  });
  await assertActorServerCapabilityMatrix({
    surface: "agent runtime-control authority",
    serverId: server.id,
    capability: "controlAgentRuntime",
    cases: [
      { label: "human owner", actorType: "user", actorId: owner.id, expected: true },
      { label: "human admin", actorType: "user", actorId: admin.id, expected: true },
      { label: "human member", actorType: "user", actorId: member.id, expected: true },
      { label: "agent member", actorType: "agent", actorId: agent.id, expected: true },
    ],
  });
  for (const capability of ["manageIntegrations", "editAgents"] as const) {
    await assertActorServerCapabilityMatrix({
      surface: `integrations ${capability} authority`,
      serverId: server.id,
      capability,
      cases: [
        { label: "human owner", actorType: "user", actorId: owner.id, expected: true },
        { label: "human admin", actorType: "user", actorId: admin.id, expected: true },
        { label: "human member", actorType: "user", actorId: member.id, expected: false },
        { label: "agent member", actorType: "agent", actorId: agent.id, expected: false },
      ],
    });
  }
  assert.equal(await actorHasServerCapabilityInServer(server.id, "agent", agent.id, "joinPublicChannels"), true);

  await db.delete(serverAgentMembers).where(eq(serverAgentMembers.agentId, agent.id));

  const missingMembershipActor = await resolveActorContext(server.id, "agent", agent.id);
  assert.deepEqual(missingMembershipActor, {
    type: "agent",
    id: agent.id,
    serverId: server.id,
    serverRole: null,
  });
  assert.equal(await actorHasServerCapabilityInServer(server.id, "agent", agent.id, "joinPublicChannels"), false);
});
