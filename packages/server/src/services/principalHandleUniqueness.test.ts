import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { agents, serverMembers, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { addMember, createServer } from "./serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
  }).returning();
  return user;
}

test("createAgent rejects a handle already used by an active agent in the same server", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("principal-owner@slock.test", "principal-owner");
  const server = await createServer("Principal Server", "principal-server", owner.id);
  await createAgent(server.id, "duplicate-agent", { runtime: "codex" });

  await assert.rejects(
    createAgent(server.id, "duplicate-agent", { runtime: "codex" }),
    /already taken/i,
  );

  const activeAgents = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.serverId, server.id), eq(agents.name, "duplicate-agent"), isNull(agents.deletedAt)));
  assert.equal(activeAgents.length, 1);
});

test("createAgent rejects reserved mention-like handles", async ({ app }) => {
  const owner = await seedUser("principal-reserved-owner@slock.test", "principal-reserved-owner");
  const server = await createServer("Principal Reserved", "principal-reserved", owner.id);

  for (const name of ["all", "Human", "HUMANS", "agent", "Agents", "here", "Idle", "BUSY", "system"]) {
    await assert.rejects(
      createAgent(server.id, name, { runtime: "codex" }),
      /is reserved\. Choose another name\./i,
    );
  }

  const agent = await createAgent(server.id, "agent-helper", { runtime: "codex" });
  assert.equal(agent.name, "agent-helper");
});

test("createAgent allows a handle already used by a human in the same server", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("principal-human-owner@slock.test", "principal-human-owner");
  const human = await seedUser("principal-human@slock.test", "principal-human");
  const server = await createServer("Principal Human", "principal-human", owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: human.id, role: "member" });

  const agent = await createAgent(server.id, human.name, { runtime: "codex" });

  assert.equal(agent.serverId, server.id);
  assert.equal(agent.name, human.name);
});

test("createAgent allows the same agent handle in a different server", async ({ app }) => {
  const ownerA = await seedUser("principal-a-owner@slock.test", "principal-a-owner");
  const ownerB = await seedUser("principal-b-owner@slock.test", "principal-b-owner");
  const serverA = await createServer("Principal A", "principal-a", ownerA.id);
  const serverB = await createServer("Principal B", "principal-b", ownerB.id);
  await createAgent(serverA.id, "cross-server-agent", { runtime: "codex" });

  const agent = await createAgent(serverB.id, "cross-server-agent", { runtime: "codex" });

  assert.equal(agent.serverId, serverB.id);
  assert.equal(agent.name, "cross-server-agent");
});

test("addMember allows a human whose handle is already used by an active agent in the server", async ({ app }) => {
  const db = getDb();
  const owner = await seedUser("principal-join-owner@slock.test", "principal-join-owner");
  const human = await seedUser("principal-join-agent@slock.test", "principal-join-agent");
  const server = await createServer("Principal Join", "principal-join", owner.id);
  await createAgent(server.id, human.name, { runtime: "codex" });

  const joined = await addMember(server.id, human.id);

  assert.equal(joined, true);
  const [membership] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, human.id)));
  assert.equal(membership?.userId, human.id);
});
