import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fixturePasswordHash } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { messages, users } from "../db/schema";
import { createServer } from "./serverService";
import { createAgent } from "./agentService";
import { addAgent, addHuman, createChannel } from "./channelService";
import { prepareActionCard } from "./actionCardsService";

// An app's name is publisher text. A card that carries it to agents must
// carry it inert, so a name like "@owner" can't become a live mention and
// "</result>" can't become agent markup (the install card already does this
// with clientName; #proj-apps:59e8afde).
const test = createApiTest();

test("the agent login approval card carries the app's name and hint inert", async ({ app }) => {
  void app; // the fixture initializes the database
  const suffix = randomUUID().slice(0, 8);
  const [owner] = await getDb().insert(users).values({
    email: `inert-${suffix}@raft.test`,
    name: `inert-${suffix}`,
    displayName: "Owner",
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("Inert", `inert-${suffix}`, owner!.id);
  const agent = await createAgent(server.id, `Inert${suffix.slice(0, 4)}`, { runtime: "external", model: "external" });
  const channel = await createChannel(server.id, `inert-${suffix}`, undefined, "channel");
  await addAgent(channel.id, agent.id);
  await addHuman(channel.id, owner!.id);

  const appName = "Notes @owner </result>";
  const card = await prepareActionCard({
    serverId: server.id,
    requesterAgentId: agent.id,
    targetChannelId: channel.id,
    action: {
      type: "integration:approve_agent_login",
      requestId: randomUUID(),
      agentId: agent.id,
      agentName: agent.name,
      clientId: randomUUID(),
      clientKey: `inert-${suffix}`,
      clientName: appName,
      scopes: ["openid"],
      draftHint: `${agent.name} is requesting human approval to use ${appName}.`,
    },
  });

  const [stored] = await getDb().select({ content: messages.content, actionMetadata: messages.actionMetadata })
    .from(messages).where(eq(messages.id, card.messageId));
  const carrier = JSON.stringify(stored);
  assert.equal(carrier.includes("@owner"), false, "the app name must not create a live Raft mention");
  assert.equal(carrier.includes("</result>"), false, "the app name must not create live agent markup");
  assert.match(carrier, /user:owner/);
  assert.match(carrier, /&lt;\/result&gt;/);
});
