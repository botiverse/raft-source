import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import {
  integrationAuditEvents,
  oauthClientInstalls,
  oauthClientMaintainers,
  oauthClients,
  serverAgentMembers,
  serverMembers,
  users,
} from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  createOAuthClientShareLink,
  installMarketplaceOAuthClient,
  updateOAuthClient,
  updateOAuthClientForAgent,
} from "../services/oauthService";
import { ensureLocalAppSourceInstallation } from "../services/appSourceInstallationService";
import { createAppOutboundPermissionRevision } from "../services/appOutboundPermissionService";
import { decidePublishReview } from "../test/marketplaceReviewFixture";
import { setListChangedRealtimeIO } from "../services/listChangedRealtime";
import { PERMISSION_UPDATES_CHANGED_EVENT, type ListChangedEvent } from "@botiverse/raft-shared";

// #triage:59b61529 (xxchan): the admin notice "App permission updates"
// (GET /api/integrations/permission-updates) stayed after another admin
// approved the update. The notice counted every active third-party
// installation on the Server whose app asks for more than it approved; the
// Settings page (GET /api/integrations/marketplace, permissionApprovalRequired)
// offered Approve update only for the installations it listed, and it never
// listed a Server's own non-public App (private share, in review, rejected,
// unlisted). The developer's own scope edit never updated that installation,
// so no admin could clear it. Now one function decides both, and an own-App
// scope edit approves that installation only for a human admin of the Server.
const test = createApiTest();

const BASE = ["openid", "profile"];
const WIDER = ["openid", "profile", "email"];

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@raft.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

async function seedTeam(baseUrl: string) {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser("notice-owner");
  const otherAdmin = await seedUser("notice-admin");
  const member = await seedUser("notice-member");
  const server = await createServer("Team", `notice-team-${suffix}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: otherAdmin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const headersFor = async (email: string) => ({
    Authorization: `Bearer ${await tokenForHuman(email)}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  });
  const ownerHeaders = await headersFor(owner.email);
  const adminHeaders = await headersFor(otherAdmin.email);
  const memberHeaders = await headersFor(member.email);
  const api = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
    fetch(`${baseUrl}/api/integrations${path}`, { ...init, headers });
  const noticeCount = async (headers = ownerHeaders) => {
    const res = await api("/permission-updates", headers);
    assert.equal(res.status, 200);
    return (await res.json() as { count: number }).count;
  };
  type ListingRow = { id: string; permissionApprovalRequired?: boolean; privateShared: boolean; installStatus: string | null };
  const listing = async (headers = ownerHeaders) => {
    const res = await api("/marketplace", headers);
    assert.equal(res.status, 200);
    return await res.json() as ListingRow[];
  };
  // What the Settings page flags: the installed apps with a Review permissions button.
  const pageFlagged = async (headers = ownerHeaders) =>
    (await listing(headers)).filter((row) => row.permissionApprovalRequired === true).map((row) => row.id).sort();
  // Approve update from the installed-app detail, with what it shows.
  const approveInSettings = async (clientId: string, headers = adminHeaders) => {
    const stateRes = await api(`/marketplace/${clientId}/install/app-notifications`, headers);
    assert.equal(stateRes.status, 200, await stateRes.clone().text());
    const state = await stateRes.json() as { requested_scopes: string[]; requested_groups: string[]; approval_required: boolean };
    assert.equal(state.approval_required, true, "the detail asks for the approval the list flags");
    const approved = await api(`/marketplace/${clientId}/install/app-notifications/grant`, headers, {
      method: "PUT",
      body: JSON.stringify({ expected_scopes: state.requested_scopes, expected_groups: state.requested_groups }),
    });
    assert.equal(approved.status, 200, await approved.clone().text());
  };
  // Invariant: the notice counts exactly the rows Settings flags for review.
  const assertCountMatchesPage = async () => {
    const [count, flagged] = await Promise.all([noticeCount(), pageFlagged()]);
    assert.equal(count, flagged.length, `notice ${count} vs Settings ${JSON.stringify(flagged)}`);
    return flagged;
  };
  // An App built in the App editor and shared privately: the share link turns
  // it into a third-party app with this Server's own installation.
  const createOwnApp = async (name: string, options: { share?: boolean } = {}) => {
    const created = await api("/clients", ownerHeaders, {
      method: "POST",
      body: JSON.stringify({ name, returnUrl: "https://own-tool.example.test/callback", allowedScopes: BASE }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const { client } = await created.json() as { client: { id: string; clientId: string } };
    if (options.share !== false) {
      const shared = await api(`/clients/${client.id}/share-links`, ownerHeaders, { method: "POST", body: JSON.stringify({ targetServerSlug: "share-target" }) });
      assert.equal(shared.status, 200, await shared.clone().text());
    }
    return client;
  };
  const ownInstall = async (clientId: string) => {
    const [row] = await getDb().select().from(oauthClientInstalls)
      .where(and(eq(oauthClientInstalls.clientId, clientId), eq(oauthClientInstalls.serverId, server.id)));
    return row!;
  };
  const seedAgent = async (role: "admin" | "maintainer", clientId: string) => {
    const agent = await createAgent(server.id, `notice-${role}-${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external" });
    if (role === "admin") {
      await getDb().update(serverAgentMembers).set({ role: "admin" })
        .where(and(eq(serverAgentMembers.serverId, server.id), eq(serverAgentMembers.agentId, agent.id)));
    } else {
      await getDb().insert(oauthClientMaintainers).values({
        clientId, principalType: "agent", agentId: agent.id, role: "owner", assignedByType: "system",
      });
    }
    return agent;
  };
  return {
    owner, otherAdmin, member, server, ownerHeaders, adminHeaders, memberHeaders, api,
    noticeCount, listing, pageFlagged, approveInSettings, assertCountMatchesPage, createOwnApp, ownInstall, seedAgent,
  };
}

async function seedMarketplaceApp(name: string, options: {
  publishStatus?: "published" | "private";
  enabled?: boolean;
} = {}) {
  const suffix = randomUUID().slice(0, 8);
  const publisherOwner = await seedUser(`${name}-publisher`);
  const publisher = await createServer("Publisher", `notice-pub-${suffix}`, publisherOwner.id);
  const [client] = await getDb().insert(oauthClients).values({
    serverId: publisher.id,
    createdByUserId: publisherOwner.id,
    clientId: `notice-${name}-${suffix}`,
    clientSecretHash: createHash("sha256").update(randomUUID()).digest("hex"),
    appType: "third_party_global",
    enabled: options.enabled ?? true,
    publishStatus: options.publishStatus ?? "published",
    humanMarketplaceVisible: (options.publishStatus ?? "published") === "published",
    name,
    description: "An app from another Server",
    returnUrl: "https://market.example.test/callback",
    allowedScopes: BASE,
  }).returning();
  return client!;
}

async function installThenWiden(serverId: string, installedByUserId: string, clientId: string) {
  // Installed directly, as an accepted marketplace install or private-share invite leaves it.
  await getDb().insert(oauthClientInstalls).values({ serverId, clientId, installedByUserId, approvedScopes: BASE });
  await getDb().update(oauthClients).set({ allowedScopes: WIDER }).where(eq(oauthClients.id, clientId));
}

// What an own-App scope edit made before this fix (or an agent's edit now)
// leaves behind: the App asks for a scope its own installation never approved.
async function widenWithoutApproval(clientId: string) {
  await getDb().update(oauthClients).set({ allowedScopes: WIDER }).where(eq(oauthClients.id, clientId));
}

test("a stuck own-App installation is listed with Review, and the notice clears once an admin approves it in Settings", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  const ownApp = await t.createOwnApp("Own Tool");
  await widenWithoutApproval(ownApp.id);

  const marketApp = await seedMarketplaceApp("market");
  assert.ok(await installMarketplaceOAuthClient({
    serverId: t.server.id,
    clientId: marketApp.id,
    installedByUserId: t.owner.id,
    expected: { scopes: BASE, groups: [] },
  }));
  await getDb().update(oauthClients).set({ allowedScopes: WIDER }).where(eq(oauthClients.id, marketApp.id));

  // Settings flags both: the Server's own private App is now in the list
  // (privately shared, so not in the Marketplace tab).
  assert.deepEqual(await t.assertCountMatchesPage(), [ownApp.id, marketApp.id].sort());
  assert.equal(await t.noticeCount(), 2);
  const ownRow = (await t.listing()).find((row) => row.id === ownApp.id)!;
  assert.equal(ownRow.privateShared, true);
  assert.equal(ownRow.installStatus, "active");
  assert.equal(ownRow.permissionApprovalRequired, true);

  // The other admin approves the marketplace App: one left, for both admins.
  await t.approveInSettings(marketApp.id);
  assert.deepEqual(await t.pageFlagged(t.adminHeaders), [ownApp.id]);
  assert.equal(await t.noticeCount(), 1);

  // ...and approves the own App from the same Settings path: nothing left.
  await t.approveInSettings(ownApp.id);
  assert.deepEqual((await t.ownInstall(ownApp.id)).approvedScopes.sort(), [...WIDER].sort());
  assert.deepEqual(await t.pageFlagged(t.adminHeaders), []);
  assert.deepEqual(await t.pageFlagged(t.ownerHeaders), []);
  assert.equal(await t.noticeCount(t.ownerHeaders), 0);
});

test("an admin's own-App scope edit approves them for the Server's own installation: no notice", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  const ownApp = await t.createOwnApp("Admin Edited");
  // The other admin, not only the owner, saves the new scope in the App editor.
  const edited = await t.api(`/clients/${ownApp.id}`, t.adminHeaders, {
    method: "PATCH",
    body: JSON.stringify({ allowedScopes: WIDER }),
  });
  assert.equal(edited.status, 200, await edited.clone().text());

  const install = await t.ownInstall(ownApp.id);
  assert.deepEqual([...install.approvedScopes].sort(), [...WIDER].sort());
  assert.deepEqual(await t.assertCountMatchesPage(), []);
  const audit = await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.clientId, ownApp.id),
    eq(integrationAuditEvents.eventType, "installation.outbound_grant_updated"),
  ));
  assert.equal(audit.length, 1, "the approval is recorded like Approve update");
  assert.equal(audit[0]!.actorType, "human");
  assert.equal(audit[0]!.actorId, t.otherAdmin.id);
  assert.deepEqual((audit[0]!.metadata as { approvedScopes: string[] }).approvedScopes.sort(), [...WIDER].sort());

  // A save that leaves the scopes as they are writes nothing more.
  const again = await t.api(`/clients/${ownApp.id}`, t.ownerHeaders, {
    method: "PATCH",
    body: JSON.stringify({ allowedScopes: WIDER, description: "same scopes" }),
  });
  assert.equal(again.status, 200);
  assert.equal((await getDb().select().from(integrationAuditEvents).where(and(
    eq(integrationAuditEvents.clientId, ownApp.id),
    eq(integrationAuditEvents.eventType, "installation.outbound_grant_updated"),
  ))).length, 1);
});

test("an agent's own-App scope edit stays pending, even for an admin agent, and is approvable in Settings", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  for (const role of ["maintainer", "admin"] as const) {
    const ownApp = await t.createOwnApp(`Agent Edited ${role}`);
    const agent = await t.seedAgent(role, ownApp.id);
    const result = await updateOAuthClientForAgent({
      serverId: t.server.id,
      clientKey: ownApp.clientId,
      actorAgentId: agent.id,
      allowedScopes: WIDER,
    });
    assert.equal(result.status, "ok", role);
    assert.deepEqual([...(await t.ownInstall(ownApp.id)).approvedScopes].sort(), [...BASE].sort(), `${role}: not self-approved`);
    assert.deepEqual(await t.assertCountMatchesPage(), [ownApp.id], role);
    await t.approveInSettings(ownApp.id);
    assert.deepEqual(await t.assertCountMatchesPage(), [], role);
  }
});

test("a scope edit by anyone but a human admin of the Server leaves its own installation pending", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  const ownApp = await t.createOwnApp("Member Edited");
  const denied = await t.api(`/clients/${ownApp.id}`, t.memberHeaders, {
    method: "PATCH",
    body: JSON.stringify({ allowedScopes: WIDER }),
  });
  assert.equal(denied.status, 403);
  // The service holds the same line on its own: a member, an admin of
  // another Server, or a system write never approves the installation.
  const outsider = await seedUser("notice-outsider");
  await createServer("Elsewhere", `notice-else-${randomUUID().slice(0, 8)}`, outsider.id);
  for (const actorUserId of [t.member.id, outsider.id, undefined]) {
    assert.ok(await updateOAuthClient({ serverId: t.server.id, clientId: ownApp.id, actorUserId, allowedScopes: WIDER }));
    assert.deepEqual([...(await t.ownInstall(ownApp.id)).approvedScopes].sort(), [...BASE].sort(), String(actorUserId));
  }
  assert.deepEqual(await t.assertCountMatchesPage(), [ownApp.id]);
  await t.approveInSettings(ownApp.id);
  assert.deepEqual(await t.assertCountMatchesPage(), []);
});

test("share link over an older source installation: an admin brings its scopes up to date, an agent does not", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  // Server-local Apps whose source installation was made early (outbound
  // permissions, webhook, bot grant), then an agent added a scope.
  const viaAdmin = await t.createOwnApp("Shared By Admin", { share: false });
  const viaAgent = await t.createOwnApp("Shared By Agent", { share: false });
  const agent = await t.seedAgent("maintainer", viaAgent.id);
  await getDb().insert(oauthClientMaintainers).values({
    clientId: viaAdmin.id, principalType: "agent", agentId: agent.id, role: "owner", assignedByType: "system",
  });
  for (const client of [viaAdmin, viaAgent]) {
    await getDb().transaction(async (tx) => { assert.ok(await ensureLocalAppSourceInstallation(client.id, tx)); });
    assert.equal((await updateOAuthClientForAgent({
      serverId: t.server.id, clientKey: client.clientId, actorAgentId: agent.id, allowedScopes: WIDER,
    })).status, "ok");
    assert.deepEqual([...(await t.ownInstall(client.id)).approvedScopes].sort(), [...BASE].sort());
  }

  const byAdmin = await t.api(`/clients/${viaAdmin.id}/share-links`, t.ownerHeaders, { method: "POST", body: JSON.stringify({ targetServerSlug: "share-target" }) });
  assert.equal(byAdmin.status, 200, await byAdmin.clone().text());
  assert.ok(await createOAuthClientShareLink({ serverId: t.server.id, clientId: viaAgent.id, targetServerSlug: "share-target", createdByAgentId: agent.id }));

  assert.deepEqual([...(await t.ownInstall(viaAdmin.id)).approvedScopes].sort(), [...WIDER].sort());
  assert.deepEqual([...(await t.ownInstall(viaAgent.id)).approvedScopes].sort(), [...BASE].sort());
  assert.deepEqual(await t.assertCountMatchesPage(), [viaAgent.id]);
  await t.approveInSettings(viaAgent.id);
  assert.deepEqual(await t.assertCountMatchesPage(), []);
});

test("publish approval over a stale source installation leaves it pending unless the reviewer is an admin there", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  const reviewer = await seedUser("notice-reviewer");
  const unlisted = await t.createOwnApp("Published Unlisted");
  const listed = await t.createOwnApp("Published Listed");
  const reviewedByAdmin = await t.createOwnApp("Reviewed By Admin");
  for (const client of [unlisted, listed, reviewedByAdmin]) {
    await widenWithoutApproval(client.id);
    await getDb().update(oauthClients).set({ publishStatus: "publish_requested", description: "A tool" })
      .where(eq(oauthClients.id, client.id));
  }
  assert.ok(await decidePublishReview({ reviewerUserId: reviewer.id, clientId: unlisted.id, decision: "approve" }));
  assert.ok(await decidePublishReview({ reviewerUserId: reviewer.id, clientId: listed.id, decision: "approve" }));
  assert.ok(await decidePublishReview({ reviewerUserId: t.otherAdmin.id, clientId: reviewedByAdmin.id, decision: "approve" }));
  await getDb().update(oauthClients).set({ humanMarketplaceVisible: false }).where(eq(oauthClients.id, unlisted.id));

  assert.deepEqual([...(await t.ownInstall(reviewedByAdmin.id)).approvedScopes].sort(), [...WIDER].sort());
  assert.deepEqual(await t.assertCountMatchesPage(), [unlisted.id, listed.id].sort());
  // A published but unlisted own App is listed only as installed here.
  const unlistedRow = (await t.listing()).find((row) => row.id === unlisted.id)!;
  assert.equal(unlistedRow.privateShared, false);
  for (const client of [unlisted, listed]) await t.approveInSettings(client.id);
  assert.deepEqual(await t.assertCountMatchesPage(), []);
});

test("the notice count equals the installations Settings flags, across every kind of installation", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  const counted: string[] = [];
  // This Server's own Apps, in each distribution state the editor allows.
  for (const status of ["private", "publish_requested", "in_review", "rejected"] as const) {
    const client = await t.createOwnApp(`Own ${status}`);
    await widenWithoutApproval(client.id);
    await getDb().update(oauthClients).set({ publishStatus: status }).where(eq(oauthClients.id, client.id));
    counted.push(client.id);
  }
  const upToDate = await t.createOwnApp("Own up to date");
  // Other Servers' Apps installed here: published, and privately shared.
  for (const publishStatus of ["published", "private"] as const) {
    const client = await seedMarketplaceApp(`other-${publishStatus}`, { publishStatus });
    await installThenWiden(t.server.id, t.owner.id, client.id);
    counted.push(client.id);
  }
  // Not counted, not flagged: a suspended installation, a disabled App, and
  // a server-local App's source installation (no approval applies to it).
  const suspended = await seedMarketplaceApp("suspended");
  await installThenWiden(t.server.id, t.owner.id, suspended.id);
  await getDb().update(oauthClientInstalls).set({ status: "suspended" })
    .where(and(eq(oauthClientInstalls.clientId, suspended.id), eq(oauthClientInstalls.serverId, t.server.id)));
  const disabled = await seedMarketplaceApp("disabled", { enabled: false });
  await installThenWiden(t.server.id, t.owner.id, disabled.id);
  const local = await t.createOwnApp("Local", { share: false });
  await getDb().transaction(async (tx) => { assert.ok(await ensureLocalAppSourceInstallation(local.id, tx)); });
  await widenWithoutApproval(local.id);
  const localState = await t.api(`/marketplace/${local.id}/install/app-notifications`, t.adminHeaders);
  assert.equal(localState.status, 200);
  assert.equal((await localState.json() as { approval_required: boolean }).approval_required, false);

  assert.deepEqual(await t.assertCountMatchesPage(), [...counted].sort());
  const rows = await t.listing();
  for (const id of [upToDate.id, suspended.id]) {
    assert.equal(rows.find((row) => row.id === id)?.permissionApprovalRequired, false, id);
  }
  // Every counted installation is approvable from Settings, one by one.
  for (const id of counted) {
    await t.approveInSettings(id);
    await t.assertCountMatchesPage();
  }
  assert.equal(await t.noticeCount(), 0);
});

/** The permission-updates:changed frames sent since the last take, as `room serverId` lines. */
function capturePermissionPings(app: unknown) {
  const frames: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string, payload: ListChangedEvent) => {
    if (event === PERMISSION_UPDATES_CHANGED_EVENT) frames.push(`${room} ${JSON.stringify(payload)}`);
    return true;
  } }) } as never);
  return {
    take: () => frames.splice(0).sort(),
    restore: () => setListChangedRealtimeIO((app as { app: { get(key: string): never } }).app.get("io")),
  };
}
const ping = (serverId: string) => `server:${serverId} ${JSON.stringify({ serverId })}`;

test("permission-updates:changed: each change pings the servers it touches, once, after it commits; a rollback pings nothing", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  const elsewhereOwner = await seedUser("notice-elsewhere");
  const elsewhere = await createServer("Elsewhere", `notice-elsewhere-${randomUUID().slice(0, 8)}`, elsewhereOwner.id);
  const marketApp = await seedMarketplaceApp("pinged");
  const install = () => installMarketplaceOAuthClient({
    serverId: t.server.id, clientId: marketApp.id, installedByUserId: t.owner.id, expected: { scopes: BASE, groups: [] },
  });
  const pings = capturePermissionPings(app);
  try {
    await assert.rejects(getDb().transaction(async () => {
      assert.ok(await install());
      assert.deepEqual(pings.take(), [], "nothing while the transaction is open");
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(pings.take(), [], "a rolled-back install pings nothing");

    assert.ok(await install());
    assert.deepEqual(pings.take(), [ping(t.server.id)], "an install: that server");
    await getDb().insert(oauthClientInstalls).values({ serverId: elsewhere.id, clientId: marketApp.id, installedByUserId: elsewhereOwner.id, approvedScopes: BASE });

    // The developer's scope edit: every server it is installed on.
    assert.ok(await updateOAuthClient({ serverId: marketApp.serverId, clientId: marketApp.id, allowedScopes: WIDER }));
    assert.deepEqual(pings.take(), [ping(t.server.id), ping(elsewhere.id)].sort());

    await t.approveInSettings(marketApp.id);
    assert.deepEqual(pings.take(), [ping(t.server.id)], "Approve update: that server only");

    // A permission request reaches every installing server. Its marketplace
    // review is decided in App Admin, which pings nothing.
    assert.ok(await createAppOutboundPermissionRevision({ clientId: marketApp.id, actor: { type: "system" }, groups: ["agent"], events: [] }));
    assert.deepEqual(pings.take(), [ping(t.server.id), ping(elsewhere.id)].sort());

    const uninstalled = await t.api(`/marketplace/${marketApp.id}/install`, t.ownerHeaders, { method: "DELETE" });
    assert.equal(uninstalled.status, 200, await uninstalled.clone().text());
    assert.deepEqual(pings.take(), [ping(t.server.id)], "an uninstall: that server");

    // This server's own App: an edit of its prompt text and a scope in one save is one ping.
    const ownApp = await t.createOwnApp("Own Pinged");
    pings.take();
    const edited = await t.api(`/clients/${ownApp.id}`, t.ownerHeaders, {
      method: "PATCH",
      body: JSON.stringify({ description: "Says more now", allowedScopes: WIDER }),
    });
    assert.equal(edited.status, 200, await edited.clone().text());
    assert.deepEqual(pings.take(), [ping(t.server.id)]);

    // Deleting it: the servers its installs were on (read before the cascade).
    const deleted = await t.api(`/clients/${ownApp.id}`, t.ownerHeaders, { method: "DELETE" });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.deepEqual(pings.take(), [ping(t.server.id)]);
  } finally {
    pings.restore();
  }
});

test("permission-updates:changed: a share link that makes an own App shareable pings its server when that brings an update to approve; a rolled-back one pings nothing (review F3)", async ({ app }) => {
  const t = await seedTeam(app.baseUrl);
  // A server-local App with an early source installation, then an agent's
  // scope edit: pending, but not counted while the App is server-local.
  const ownApp = await t.createOwnApp("Shared Later", { share: false });
  const agent = await t.seedAgent("maintainer", ownApp.id);
  await getDb().transaction(async (tx) => { assert.ok(await ensureLocalAppSourceInstallation(ownApp.id, tx)); });
  assert.equal((await updateOAuthClientForAgent({
    serverId: t.server.id, clientKey: ownApp.clientId, actorAgentId: agent.id, allowedScopes: WIDER,
  })).status, "ok");
  assert.equal(await t.noticeCount(), 0);
  const share = () => createOAuthClientShareLink({ serverId: t.server.id, clientId: ownApp.id, targetServerSlug: "share-target", createdByAgentId: agent.id });
  const pings = capturePermissionPings(app);
  try {
    await assert.rejects(getDb().transaction(async () => {
      assert.ok(await share());
      throw new Error("roll back");
    }), /roll back/);
    assert.deepEqual(pings.take(), [], "a rolled-back share link pings nothing");

    assert.ok(await share());
    assert.deepEqual(pings.take(), [ping(t.server.id)], "made global: the notice now counts it");
    assert.equal(await t.noticeCount(), 1);
  } finally {
    pings.restore();
  }
});
