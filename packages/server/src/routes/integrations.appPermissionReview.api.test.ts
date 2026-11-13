import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { users, oauthClients } from "../db/schema";
import { createServer } from "../services/serverService";
import { createOAuthClient } from "../services/oauthService";
import { createAppOutboundPermissionRevision } from "../services/appOutboundPermissionService";

const test = createApiTest();

// App permission updates are reviewed in App Admin (#proj-apps task #19):
// Raft lists what waits but has no route to approve it, not even for a
// prompt-text reviewer (SLOCK_MARKETPLACE_REVIEWER_USER_IDS).
test("a pending permission update is listed with the revision to review, and Raft has no route to approve it", async ({ app }) => {
  const suffix = randomUUID();
  const [owner] = await getDb().insert(users).values({
    email: `review-${suffix}@example.test`,
    name: `review-${suffix}`,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer("review", `review-${suffix}`, owner.id);
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    appType: "third_party_global",
    clientId: `review-${suffix.slice(0, 8)}`,
    name: "Review fixture",
  });
  await getDb().update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.id));

  const first = await createAppOutboundPermissionRevision({ clientId: client.id, actor: { type: "human", id: owner.id }, groups: ["agent"], events: [] });
  assert.ok(first);
  const firstRevisionId = first.revision.id;

  const token = await tokenForHuman(owner.email);
  const headers = {
    Authorization: `Bearer ${token}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  };
  const prior = process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS;
  process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS = owner.id;
  try {
    const listing = await (await fetch(`${app.baseUrl}/api/integrations/marketplace`, { headers })).json();
    const row = listing.find((entry: { id: string }) => entry.id === client.id);
    assert.equal(row.appNotificationReviewPending, true);
    assert.deepEqual(row.appNotificationPendingGroups, ["agent"]);
    assert.equal(row.appNotificationPendingRevisionId, firstRevisionId);
    assert.equal("canReviewAppNotifications" in row, false);

    const approveResponse = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/app-notifications/permissions/review`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expected_revision_id: firstRevisionId }),
    });
    assert.equal(approveResponse.status, 404);
    const [stored] = await getDb().select({
      groups: oauthClients.outboundCurrentGroups,
      pending: oauthClients.outboundPendingRevisionId,
    }).from(oauthClients).where(eq(oauthClients.id, client.id));
    assert.equal(stored.pending, firstRevisionId, "nothing was approved");
    assert.deepEqual(stored.groups, []);
  } finally {
    if (prior === undefined) delete process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS;
    else process.env.SLOCK_MARKETPLACE_REVIEWER_USER_IDS = prior;
  }
});
