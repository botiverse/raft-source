import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { dbTest as test } from "../test/integration/dbTest";
import { oauthClients, oauthClientInstalls, users } from "../db/schema";
import { createServer } from "./serverService";
import { createOAuthClient } from "./oauthService";
import {
  createAppOutboundPermissionRevision,
  updateAppInstallationGrant,
} from "./appOutboundPermissionService";
import { getAppNotificationInstallationState } from "./appNotificationManagementService";
import { approvePermissionReview } from "../test/marketplaceReviewFixture";

// Regression for the production-confirmed defect (staging 2026-09-16, prod
// 2026-09-21): activating a permission revision updated approved_groups but
// left oauth_client_installs.subscribed_events=[] and subscription_revision=0,
// so every check looked green while the outbound fan-out produced zero rows.

const GROUPS = ["agent", "computer"] as const;
const EVENTS_V1 = ["agent.status_changed", "computer.online"] as const;
const EVENTS_V2 = ["agent.status_changed"] as const;

async function seedOwnerAndServer(label: string) {
  const db = (await import("../db/index")).getDb();
  const [owner] = await db.insert(users).values({
    name: "owner",
    email: `sub-sync-${label}@slock.test`,
    passwordHash: "unused",
  }).returning();
  const server = await createServer(`Sub sync ${label}`, `sub-sync-${label}`, owner.id);
  return { owner, server };
}

test("activating a revision syncs install subscribed_events and bumps subscription_revision only on event change", async ({ db }) => {
  const { owner, server } = await seedOwnerAndServer("create");
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    name: "Sub sync create",
    clientId: "sub-sync-create",
    appType: "server_local",
  });
  // Mirror the production shape: an active install whose subscription was never synced.
  const [install] = await db.insert(oauthClientInstalls).values({
    clientId: client.id,
    serverId: server.id,
    installedByUserId: owner.id,
    status: "active",
    approvedGroups: [],
    subscribedEvents: [],
    subscriptionRevision: 0,
  }).returning();

  const first = await createAppOutboundPermissionRevision({
    clientId: client.id,
    actor: { type: "human", id: owner.id },
    groups: [...GROUPS],
    events: [...EVENTS_V1],
  });
  assert.ok(first);

  let [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual([...row.subscribedEvents].sort(), [...EVENTS_V1].sort(),
    "activation must write the effective events onto the install (was left [] in production)");
  assert.equal(row.subscriptionRevision, 1, "first sync bumps subscription_revision 0 -> 1");
  assert.deepEqual([...row.approvedGroups].sort(), [...GROUPS].sort());

  // Same events again: no churn.
  await createAppOutboundPermissionRevision({
    clientId: client.id,
    actor: { type: "human", id: owner.id },
    groups: [...GROUPS],
    events: [...EVENTS_V1],
  });
  [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.equal(row.subscriptionRevision, 1, "unchanged events must not bump the revision");

  // Event set changes: sync again and bump.
  await createAppOutboundPermissionRevision({
    clientId: client.id,
    actor: { type: "human", id: owner.id },
    groups: ["agent"],
    events: [...EVENTS_V2],
  });
  [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual(row.subscribedEvents, [...EVENTS_V2]);
  assert.equal(row.subscriptionRevision, 2);
});

test("approving a pending revision syncs install subscribed_events (review path)", async ({ db }) => {
  const { owner, server } = await seedOwnerAndServer("review");
  const { client } = await createOAuthClient({
    serverId: server.id,
    createdByUserId: owner.id,
    name: "Sub sync review",
    clientId: "sub-sync-review",
    appType: "third_party_global",
  });
  await db.update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, client.id));
  const [install] = await db.insert(oauthClientInstalls).values({
    clientId: client.id,
    serverId: server.id,
    installedByUserId: owner.id,
    status: "active",
    approvedGroups: [],
    subscribedEvents: [],
    subscriptionRevision: 0,
  }).returning();

  const created = await createAppOutboundPermissionRevision({
    clientId: client.id,
    actor: { type: "human", id: owner.id },
    groups: [...GROUPS],
    events: [...EVENTS_V1],
  });
  assert.ok(created);
  assert.equal(created.revision.state, "pending_review", "published third-party additions must require review");

  let [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual(row.subscribedEvents, [], "no sync before approval");
  assert.equal(row.subscriptionRevision, 0);

  const approved = await approvePermissionReview({
    clientId: client.id,
    reviewerUserId: owner.id,
  });
  assert.ok(approved);

  [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, install.id));
  assert.deepEqual([...row.subscribedEvents].sort(), [...EVENTS_V1].sort(),
    "approval must write the reviewed events onto the install");
  assert.equal(row.subscriptionRevision, 1);
  assert.deepEqual([...row.approvedGroups].sort(), [...GROUPS].sort());
  const [clientRow] = await db.select().from(oauthClients).where(and(
    eq(oauthClients.id, client.id),
  ));
  assert.equal(clientRow.outboundPendingRevisionId, null);
});

// installation.bot_changed is never declared, so every path that rewrites a
// subscription from the declared events must keep it (#proj-apps #35). Not yet
// the permission review approval: it is decided in App Admin, whose database
// function (marketplace_approve_permission_review) sets the source
// installation's subscription to the reviewed events and drops this one; Raft's
// removed review route put it back (docs/raft-app/README.md, installation
// permissions).
const OWN = "installation.bot_changed";

test("the installation's own event survives the declared-events sync: activation, Approve update", async ({ db }) => {
  const { owner, server } = await seedOwnerAndServer("own-event");
  const local = await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, name: "Own event local", clientId: "own-event-local", appType: "server_local",
  });
  const [localInstall] = await db.insert(oauthClientInstalls).values({
    clientId: local.client.id, serverId: server.id, installedByUserId: owner.id, status: "active", subscribedEvents: [OWN],
  }).returning();
  await createAppOutboundPermissionRevision({ clientId: local.client.id, actor: { type: "human", id: owner.id }, groups: [...GROUPS], events: [...EVENTS_V1] });
  let [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, localInstall.id));
  assert.deepEqual(row.subscribedEvents, [...EVENTS_V1, OWN].sort(), "activation keeps it");

  const published = await createOAuthClient({
    serverId: server.id, createdByUserId: owner.id, name: "Own event review", clientId: "own-event-review", appType: "third_party_global",
  });
  await db.update(oauthClients).set({ publishStatus: "published" }).where(eq(oauthClients.id, published.client.id));
  await db.insert(oauthClientInstalls).values({
    clientId: published.client.id, serverId: server.id, installedByUserId: owner.id, status: "active", subscribedEvents: [OWN],
  });
  await createAppOutboundPermissionRevision({ clientId: published.client.id, actor: { type: "human", id: owner.id }, groups: [...GROUPS], events: [...EVENTS_V1] });
  assert.ok(await approvePermissionReview({ clientId: published.client.id, reviewerUserId: owner.id }));

  // Another Server's installation approving the App's update keeps it too.
  const [otherOwner] = await db.insert(users).values({
    name: "other-owner", email: "sub-sync-own-event-other@slock.test", passwordHash: "unused",
  }).returning();
  const otherServer = await createServer("Sub sync own event other", "sub-sync-own-event-other", otherOwner.id);
  const [otherInstall] = await db.insert(oauthClientInstalls).values({
    clientId: published.client.id, serverId: otherServer.id, installedByUserId: otherOwner.id, status: "active",
    subscribedEvents: [OWN, "agent.status_changed"],
  }).returning();
  const state = await getAppNotificationInstallationState({ clientId: published.client.id, serverId: otherServer.id });
  assert.ok(state);
  assert.deepEqual(state.subscribedEvents.includes(OWN), true);
  assert.ok(await updateAppInstallationGrant({
    installationId: otherInstall.id,
    actorUserId: otherOwner.id,
    expected: { scopes: state.requestedScopes, groups: state.requestedGroups },
  }));
  [row] = await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, otherInstall.id));
  assert.deepEqual(row.subscribedEvents, ["agent.status_changed", OWN], "Approve update keeps it");
});
