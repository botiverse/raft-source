import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { asServerId } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { agentMigrations, machines, serverMembers, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { prepareActionCard } from "./actionCardsService.js";
import { addAgent, addHuman, createChannel } from "./channelService.js";
import { createServer } from "./serverService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(email: string, name: string) {
  const db = getDb();
  const [user] = await db.insert(users).values({
    email,
    name,
    displayName: name,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  return user;
}

async function seedMigrationCardFixture() {
  const db = getDb();
  const suffix = randomUUID();
  const owner = await seedUser(`migration-card-owner-${suffix}@slock.test`, `migration-card-owner-${suffix}`);
  const member = await seedUser(`migration-card-member-${suffix}@slock.test`, `migration-card-member-${suffix}`);
  const server = await createServer("Migration Card Server", `migration-card-${suffix}`, owner.id);
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" }).onConflictDoNothing();
  const [sourceMachine] = await db.insert(machines).values({
    id: randomUUID(),
    serverId: server.id,
    userId: owner.id,
    name: `source-${suffix}`,
    apiKeyHash: "hash-source",
  }).returning();
  const [targetMachine] = await db.insert(machines).values({
    id: randomUUID(),
    serverId: server.id,
    userId: owner.id,
    name: `target-${suffix}`,
    apiKeyHash: "hash-target",
  }).returning();
  const agent = await createAgent(server.id, `MigrationCardAgent${suffix.slice(0, 8)}`, {
    runtime: "codex",
    machineId: sourceMachine.id,
  });
  const channel = await createChannel(server.id, `migration-card-channel-${suffix}`, undefined, "channel");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);
  await addAgent(channel.id, agent.id);
  return { owner, member, server, sourceMachine, targetMachine, agent, channel };
}

test("migration:export action cards are not supported", async ({ app }) => {
  const fixture = await seedMigrationCardFixture();
  await assert.rejects(
    () => prepareActionCard({
      serverId: asServerId(fixture.server.id),
      requesterAgentId: fixture.agent.id,
      targetChannelId: fixture.channel.id,
      action: {
        type: "migration:export",
        targetComputer: fixture.targetMachine.name,
        mode: "forensic",
        prepDeadlineMs: 60_000,
      } as any,
    }),
    /No matching discriminator|Invalid input/,
  );

  const rows = await getDb()
    .select()
    .from(agentMigrations)
    .where(eq(agentMigrations.agentId, fixture.agent.id));
  assert.equal(rows.length, 0);
});
