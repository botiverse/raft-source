import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { JointChannelAccessChangedError, lockJointPostingAuthority } from "../lib/channelActorPermissions";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { oauthClientInstalls, serverAgentMembers, channelAgents, appBotBindings } from "../db/schema";
import { createOAuthClient } from "../services/oauthService";
import { createManagedAppBot } from "../services/appBotIdentityService";
import { mintAgentCredential, MANAGED_APP_BOT_CAPABILITIES } from "../services/agentCredentialService";
import { addAgent, canAgentPostToChannel } from "../services/channelService";
import { createServer, headers, installFakeIo, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

test("a joined App Bot can send in a joint channel without ordinary server membership, but loses access on revocation", async ({ app }) => {
  const suffix = randomUUID().slice(0, 8);
  const hostOwner = await seedUser(`bot-joint-host-${suffix}@slock.test`, `bot-joint-host-${suffix}`);
  const targetOwner = await seedUser(`bot-joint-target-${suffix}@slock.test`, `bot-joint-target-${suffix}`);
  const host = await createServer("Bot joint host", `bot-joint-host-${suffix}`, hostOwner.id);
  const target = await createServer("Bot joint target", `bot-joint-target-${suffix}`, targetOwner.id);
  const hostToken = await tokenForHuman(hostOwner.email);
  const targetToken = await tokenForHuman(targetOwner.email);
  const channelName = `bot-joint-${suffix}`;
  const created = await fetch(`${app.baseUrl}/api/channels`, {
    method: "POST", headers: headers(hostToken, host.id),
    body: JSON.stringify({ name: channelName, visibility: "joint", targetServerSlug: target.slug,
      invitedPeople: [`@${targetOwner.name}`] }),
  });
  assert.equal(created.status, 200);
  const hostChannel = await created.json() as { jointInvite: { id: string } };
  const accepted = await fetch(`${app.baseUrl}/api/channels/joint-invites/${hostChannel.jointInvite.id}/accept`, {
    method: "POST", headers: headers(targetToken, target.id),
  });
  assert.equal(accepted.status, 200);
  const targetChannel = await accepted.json() as { id: string };
  const client = await createOAuthClient({ serverId: target.id, createdByUserId: targetOwner.id,
    clientId: `bot-app-${suffix}`, name: "Joint Bot", enableBot: true });
  const db = getDb();
  const [install] = await db.insert(oauthClientInstalls).values({ serverId: target.id,
    clientId: client.client.id, installedByUserId: targetOwner.id, status: "active", botGrant: "granted" }).returning();
  const bot = await db.transaction(tx => createManagedAppBot(tx, { installId: install!.id, serverId: target.id }));
  await addAgent(targetChannel.id, bot.agentId);
  const credential = await mintAgentCredential({ agentId: bot.agentId, scopes: MANAGED_APP_BOT_CAPABILITIES,
    name: "joint-repro", issuedVia: "app", createdByUserId: null });
  installFakeIo(app.app);

  assert.equal(await canAgentPostToChannel(targetChannel.id, bot.agentId), true);
  assert.equal((await db.select().from(serverAgentMembers).where(and(
    eq(serverAgentMembers.serverId, target.id), eq(serverAgentMembers.agentId, bot.agentId),
  ))).length, 0);
  const send = () => fetch(`${app.baseUrl}/internal/agent-api/v2/send`, {
    method: "POST", headers: { Authorization: `Bearer ${credential.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target: `#${channelName}`, content: "App Bot joint test", idempotencyKey: `test-${suffix}` }),
  });
  const first = await send();
  assert.equal(first.status, 200, JSON.stringify(await first.json()));
  // Replays do not invent another membership or bypass the commit check.
  const replay = await send();
  assert.equal(replay.status, 200);
  const check = () => db.transaction(tx => lockJointPostingAuthority(targetChannel.id, "agent", bot.agentId, tx));
  await check();
  await db.update(oauthClientInstalls).set({ botGrant: "revoked" }).where(eq(oauthClientInstalls.id, install!.id));
  await assert.rejects(check(), JointChannelAccessChangedError);
  await db.update(oauthClientInstalls).set({ botGrant: "granted" }).where(eq(oauthClientInstalls.id, install!.id));
  await db.update(appBotBindings).set({ state: "disabled" }).where(eq(appBotBindings.agentId, bot.agentId));
  await assert.rejects(check(), JointChannelAccessChangedError);
  await db.update(appBotBindings).set({ state: "active" }).where(eq(appBotBindings.agentId, bot.agentId));
  await check();
  await db.delete(channelAgents).where(and(eq(channelAgents.channelId, targetChannel.id), eq(channelAgents.agentId, bot.agentId)));
  await assert.rejects(check(), JointChannelAccessChangedError);
});
