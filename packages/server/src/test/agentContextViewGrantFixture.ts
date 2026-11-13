// View Context grants (#wg-ax:#15): one server with every kind of person and
// agent the grant rules name, for agentContextViewGrants.api.test.ts and
// agentContextViewGrantQuery.api.test.ts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agents, appBotBindings, featureFlagRules, featureFlags, oauthClientInstalls, serverMembers, users } from "../db/schema";
import { attachComputer } from "../services/computerCredentialService";
import { createOAuthClient } from "../services/oauthService";
import { createServer } from "../services/serverService";
import { seedBoundGuest } from "./guestFixture";
import { fixturePasswordHash } from "./integration/credentials";

export async function seedGrantUser(label: string) {
  const suffix = randomUUID();
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@slock.test`,
    name: `${label}-${suffix.slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

export async function enableContextViewFlag(serverId: string) {
  await getDb().insert(featureFlags)
    .values({ key: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: AGENT_CONTEXT_VIEW_FEATURE_FLAG_KEY,
    stage: "server",
    priority: 0,
    decision: "allow",
    values: [serverId],
  });
}

/**
 * Owner, admin, member, Guest; on one Computer: the viewer (an ordinary
 * agent), the target (an ordinary agent the member created), an App Bot, an
 * agent the Guest is recorded as creating and one the viewer agent created.
 * Off it, hosted as in production (agents_assistant_not_on_machine): a
 * personal assistant (the member's).
 */
export async function seedGrantWorld(options: { flag?: boolean } = {}) {
  const owner = await seedGrantUser("grant-owner");
  const admin = await seedGrantUser("grant-admin");
  const member = await seedGrantUser("grant-member");
  const guest = await seedGrantUser("grant-guest");
  const short = randomUUID().slice(0, 8);
  const server = await createServer("Context Grants", `grants-${short}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  await seedBoundGuest({ serverId: server.id, userId: guest.id });
  const attached = await attachComputer({ userId: owner.id, serverSlug: server.slug, name: `grant-mac-${short}` });
  assert.ok(attached.ok, "attach the Computer");
  const machineId = attached.machineId;
  const newAgent = async (name: string, creator: { type: "user" | "agent"; id: string }) => {
    const [row] = await getDb().insert(agents).values({
      serverId: server.id,
      name: `${name}${randomUUID().slice(0, 6)}`,
      status: "inactive",
      runtime: "claude",
      model: "sonnet",
      executionMode: "byoc",
      machineId,
      creatorType: creator.type,
      creatorId: creator.id,
    }).returning();
    return row!;
  };
  const viewer = await newAgent("viewer", { type: "user", id: member.id });
  const target = await newAgent("target", { type: "user", id: member.id });
  const assistant = await newAgent("assistant", { type: "user", id: member.id });
  await getDb().update(agents).set({ assistantOwnerUserId: member.id, machineId: null }).where(eq(agents.id, assistant.id));
  const guestCreated = await newAgent("guestmade", { type: "user", id: guest.id });
  const agentCreated = await newAgent("agentmade", { type: "agent", id: viewer.id });
  const { client } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: `grant-bot-${short}`, name: "grant-bot", enableBot: true });
  const [install] = await getDb().insert(oauthClientInstalls).values({ serverId: server.id, clientId: client.id, installedByUserId: owner.id, status: "active", botGrant: "pending" }).returning();
  const bot = await newAgent("bot", { type: "user", id: owner.id });
  await getDb().update(agents).set({ managedByAppInstallId: install!.id }).where(eq(agents.id, bot.id));
  await getDb().insert(appBotBindings).values({ agentId: bot.id, installId: install!.id, serverId: server.id, handle: bot.name, state: "active" });
  if (options.flag !== false) await enableContextViewFlag(server.id);
  return { owner, admin, member, guest, server, machineId, computerKey: attached.apiKey, viewer, target, assistant, guestCreated, agentCreated, bot };
}

export type GrantWorld = Awaited<ReturnType<typeof seedGrantWorld>>;
