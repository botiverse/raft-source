import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { agents, users } from "../db/schema.js";
import { createAgent } from "./agentService.js";
import { addAgent, addHuman, createChannel } from "./channelService.js";
import { addMember, createServer, removeMember } from "./serverService.js";
import { createTasks, listTasks } from "./taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(name: string) {
  const [user] = await getDb().insert(users).values({
    email: `${name}-${randomUUID()}@slock.test`,
    name,
    displayName: name,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user;
}

test("task list distinguishes a departed creator without changing a live creator", async ({ app }) => {
  const owner = await seedUser("live_creator");
  const departed = await seedUser("departed_creator");
  const server = await createServer("Creator membership", `creator-membership-${randomUUID()}`, owner.id);
  await addMember(server.id, departed.id);
  const channel = await createChannel(server.id, "creator-membership");
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, departed.id);
  const liveAgent = await createAgent(server.id, "live_agent");
  const departedAgent = await createAgent(server.id, "departed_agent");
  await addAgent(channel.id, liveAgent.id);
  await addAgent(channel.id, departedAgent.id);

  await createTasks(channel.id, "user", owner.id, [{ title: "live task" }]);
  await createTasks(channel.id, "user", departed.id, [{ title: "historical task" }]);
  await createTasks(channel.id, "agent", liveAgent.id, [{ title: "live agent task" }]);
  await createTasks(channel.id, "agent", departedAgent.id, [{ title: "historical agent task" }]);

  const beforeDeparture = await listTasks(channel.id);
  assert.deepEqual(
    beforeDeparture.map((task) => [task.createdByName, task.createdByMembershipStatus]),
    [
      ["live_creator", "active"],
      ["departed_creator", "active"],
      ["live_agent", "active"],
      ["departed_agent", "active"],
    ],
    "both creators start as active server members",
  );

  await removeMember(server.id, departed.id, { reason: "left" });
  await getDb()
    .update(agents)
    .set({ deletedAt: new Date() })
    .where(eq(agents.id, departedAgent.id));

  const afterDeparture = await listTasks(channel.id);
  assert.deepEqual(
    afterDeparture.map((task) => [task.createdByName, task.createdByMembershipStatus]),
    [
      ["live_creator", "active"],
      ["departed_creator", "left"],
      ["live_agent", "active"],
      ["departed_agent", "removed"],
    ],
    "the historical handle remains readable but is no longer presented as live",
  );
});
