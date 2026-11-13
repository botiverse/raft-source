import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { integrationAuditEvents, oauthClients, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";

// A publish request still waiting for marketplace review can be withdrawn
// (#proj-apps:482662d3): the app goes back to private and keeps its
// registration and credentials. Before this, deleting the app was the only
// way to take the request back.
const test = createApiTest();

async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@raft.test`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

test("a pending publish request can be withdrawn back to private; nothing else can be", async ({ app }) => {
  const owner = await seedUser("withdraw-owner");
  const server = await createServer("Publisher", `withdraw-${randomUUID().slice(0, 8)}`, owner.id);
  const { client, clientSecret } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    name: "Withdraw Me",
    description: "An app whose developer changes their mind",
    clientId: `withdraw-${randomUUID().slice(0, 8)}`,
    homepageUrl: "https://withdraw.example.test",
    returnUrl: "https://withdraw.example.test/callback",
  });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  const post = (path: string) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/${path}`, { method: "POST", headers });

  assert.equal((await post("withdraw-publish")).status, 404, "a private app has no request to withdraw");

  const requested = await post("request-publish");
  assert.equal(requested.status, 200, await requested.clone().text());
  const [pending] = await getDb().select().from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(pending!.publishStatus, "publish_requested");

  const withdrawn = await post("withdraw-publish");
  assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
  assert.equal((await withdrawn.json() as { publishStatus: string }).publishStatus, "private");
  const [after] = await getDb().select().from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.equal(after!.publishStatus, "private");
  assert.equal(after!.publishRequestedAt, null);
  assert.equal(after!.clientSecretHash, pending!.clientSecretHash, "credentials are kept");
  assert.ok(clientSecret);
  const audit = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.clientId, client.id),
    eq(integrationAuditEvents.eventType, "app.publish_withdrawn"),
  ));
  assert.equal(audit.length, 1);

  assert.equal((await post("withdraw-publish")).status, 404, "withdrawing twice finds nothing pending");
  assert.equal((await post("request-publish")).status, 200, "the app can request review again");

  // A published app is past review: it requests offline review instead.
  await getDb().update(oauthClients).set({ publishStatus: "published", appType: "third_party_global" }).where(eq(oauthClients.id, client.id));
  assert.equal((await post("withdraw-publish")).status, 404);

  // Only the publishing Server's owners and admins can withdraw.
  const member = await seedUser("withdraw-member");
  const memberHeaders = { Authorization: `Bearer ${await tokenForHuman(member.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  const other = await createServer("Other", `withdraw-other-${randomUUID().slice(0, 8)}`, member.id);
  const otherHeaders = { ...memberHeaders, "X-Server-Id": other.id };
  await getDb().update(oauthClients).set({ publishStatus: "publish_requested", appType: "server_local" }).where(eq(oauthClients.id, client.id));
  const foreign = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/withdraw-publish`, { method: "POST", headers: otherHeaders });
  assert.equal(foreign.status, 404, "an admin of another Server can't withdraw it");
  assert.equal((await getDb().select().from(oauthClients).where(eq(oauthClients.id, client.id)))[0]!.publishStatus, "publish_requested");
});
