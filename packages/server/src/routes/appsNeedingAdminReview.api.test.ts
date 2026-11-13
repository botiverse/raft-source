import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { oauthClientMaintainers, oauthClients, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import {
  APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY,
  createFeatureFlag,
  createFeatureFlagRule,
} from "../services/featureFlagService";
import { __setPromptTextConsentEvaluatorForTests, backfillAppPromptTextRevisions } from "../services/appPromptTextService";
import { updateOAuthClientForAgent } from "../services/oauthService";

// #proj-apps task #24: the Apps page shows owners/admins a dot on the rail
// entry (`needsAdminReview` on GET /api/integrations/permission-updates) and
// on each installed App row (`needsAdminReview` on GET /marketplace and
// GET /clients) that has something only this Server's admin can handle: a
// permission update to approve, or (app_prompt_text_consent on) new prompt
// text to confirm. Opening the page does not clear it; handling does.
const test = createApiTest();

const BASE = ["openid", "profile"];
const WIDER = ["openid", "profile", "email"];

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

async function consentOn(...serverIds: string[]) {
  await createFeatureFlag({ key: APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await createFeatureFlagRule({ flagKey: APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, stage: "server", decision: "allow", values: serverIds });
}

type Headers = Record<string, string>;
type Row = { id: string; needsAdminReview?: boolean; permissionApprovalRequired?: boolean; promptTextConfirmationRequired?: boolean };

/** A Server with an owner, an admin and a member, and what its Apps page reads. */
async function seedTeam(baseUrl: string, label: string) {
  const owner = await seedUser(`${label}-owner`);
  const admin = await seedUser(`${label}-admin`);
  const member = await seedUser(`${label}-member`);
  const server = await createServer("Team", `${label}-${randomUUID().slice(0, 8)}`, owner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const headersFor = async (email: string): Promise<Headers> => ({
    Authorization: `Bearer ${await tokenForHuman(email)}`,
    "X-Server-Id": server.id,
    "Content-Type": "application/json",
  });
  const adminHeaders = await headersFor(admin.email);
  const memberHeaders = await headersFor(member.email);
  const api = (path: string, headers: Headers, init: RequestInit = {}) =>
    fetch(`${baseUrl}/api/integrations${path}`, { ...init, headers });
  const rail = async (headers = adminHeaders) => {
    const res = await api("/permission-updates", headers);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as { count: number; needsAdminReview: boolean };
  };
  const rows = async (list: "/marketplace" | "/clients", headers = adminHeaders) => {
    const res = await api(list, headers);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as Row[];
  };
  // The installed App rows that show the dot.
  const dotted = async (list: "/marketplace" | "/clients" = "/marketplace", headers = adminHeaders) =>
    (await rows(list, headers)).filter((row) => row.needsAdminReview === true).map((row) => row.id).sort();
  const installState = async (clientId: string) => {
    const res = await api(`/marketplace/${clientId}/install/app-notifications`, adminHeaders);
    assert.equal(res.status, 200, await res.clone().text());
    return await res.json() as {
      requested_scopes: string[];
      requested_groups: string[];
      approval_required: boolean;
      prompt_text: { current: { id: string } | null; confirmation_required: boolean };
    };
  };
  // Approve update from the installed App's detail; `confirmText` also confirms the text it shows.
  const approve = async (clientId: string, options: { confirmText: boolean }) => {
    const state = await installState(clientId);
    const res = await api(`/marketplace/${clientId}/install/app-notifications/grant`, adminHeaders, {
      method: "PUT",
      body: JSON.stringify({
        expected_scopes: state.requested_scopes,
        expected_groups: state.requested_groups,
        ...(options.confirmText ? { expected_text_revision_id: state.prompt_text.current!.id } : {}),
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const install = async (clientId: string) => {
    const [client] = await getDb().select({ revisionId: oauthClients.textCurrentRevisionId }).from(oauthClients)
      .where(eq(oauthClients.id, clientId));
    const res = await api(`/marketplace/${clientId}/install`, adminHeaders, {
      method: "POST",
      body: JSON.stringify({ expected_scopes: BASE, expected_groups: [], expected_text_revision_id: client!.revisionId }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const uninstall = async (clientId: string) => {
    const res = await api(`/marketplace/${clientId}/install`, adminHeaders, { method: "DELETE" });
    assert.equal(res.status, 200, await res.clone().text());
  };
  // A server-local App an admin registers here (its text is confirmed by writing it).
  const createLocalApp = async (name: string) => {
    const res = await api("/clients", adminHeaders, {
      method: "POST",
      body: JSON.stringify({ name, whenToUse: "use it for local notes", returnUrl: "https://local.example.test/callback", allowedScopes: BASE }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return (await res.json() as { client: { id: string; clientId: string } }).client;
  };
  return { owner, admin, member, server, adminHeaders, memberHeaders, api, rail, rows, dotted, installState, approve, install, uninstall, createLocalApp };
}

/** A published App on another Server; its developer edits its text there. */
async function seedMarketplaceApp(baseUrl: string, name: string) {
  const suffix = randomUUID().slice(0, 8);
  const developer = await seedUser(`${name}-developer`);
  const publisher = await createServer("Publisher", `t24-pub-${suffix}`, developer.id);
  const [client] = await getDb().insert(oauthClients).values({
    serverId: publisher.id,
    createdByUserId: developer.id,
    clientId: `t24-${name}-${suffix}`,
    clientSecretHash: createHash("sha256").update(randomUUID()).digest("hex"),
    appType: "third_party_global",
    enabled: true,
    publishStatus: "published",
    humanMarketplaceVisible: true,
    name,
    description: "An app from another Server",
    whenToUse: "use it for meeting notes",
    returnUrl: "https://market.example.test/callback",
    allowedScopes: BASE,
  }).returning();
  // Revision 1, as migration 0382 leaves every App.
  await backfillAppPromptTextRevisions(getDb(), true);
  const developerHeaders = {
    Authorization: `Bearer ${await tokenForHuman(developer.email)}`,
    "X-Server-Id": publisher.id,
    "Content-Type": "application/json",
  };
  // The publisher's flag is off, so the edit is current at once (no marketplace review).
  const editText = async (whenToUse: string) => {
    const res = await fetch(`${baseUrl}/api/integrations/clients/${client!.id}`, {
      method: "PATCH", headers: developerHeaders, body: JSON.stringify({ whenToUse }),
    });
    assert.equal(res.status, 200, await res.clone().text());
  };
  const widenScopes = () => getDb().update(oauthClients).set({ allowedScopes: WIDER }).where(eq(oauthClients.id, client!.id));
  return { client: client!, editText, widenScopes };
}

const NOTHING = { count: 0, needsAdminReview: false };

test("nothing waiting: no dot, on the rail or any row", async ({ app }) => {
  const t = await seedTeam(app.baseUrl, "t24-none");
  await consentOn(t.server.id);
  const market = await seedMarketplaceApp(app.baseUrl, "none");
  await t.install(market.client.id);
  // A person writing an App's text confirms it: nothing to confirm afterwards.
  const local = await t.createLocalApp("Local none");

  assert.deepEqual(await t.rail(), NOTHING);
  const marketRow = (await t.rows("/marketplace")).find((row) => row.id === market.client.id)!;
  assert.equal(marketRow.needsAdminReview, false, "an admin reads the field on every row, false here");
  assert.equal((await t.rows("/clients")).find((row) => row.id === local.id)!.needsAdminReview, false);
});

test("a permission update only: dot until an admin approves it", async ({ app }) => {
  const t = await seedTeam(app.baseUrl, "t24-perm");
  const market = await seedMarketplaceApp(app.baseUrl, "perm");
  await t.install(market.client.id);
  await market.widenScopes();

  assert.deepEqual(await t.rail(), { count: 1, needsAdminReview: true });
  assert.deepEqual(await t.dotted(), [market.client.id]);
  // Opening the page and the App's detail is not handling it.
  await t.installState(market.client.id);
  assert.deepEqual(await t.rail(), { count: 1, needsAdminReview: true });

  await t.approve(market.client.id, { confirmText: false });
  assert.deepEqual(await t.rail(), NOTHING);
  assert.deepEqual(await t.dotted(), []);
});

test("new prompt text only (flag on): dot until an admin confirms it; flag off, nothing to confirm", async ({ app }) => {
  const t = await seedTeam(app.baseUrl, "t24-text");
  const off = await seedTeam(app.baseUrl, "t24-text-off");
  await consentOn(t.server.id);
  const market = await seedMarketplaceApp(app.baseUrl, "text");
  await t.install(market.client.id);
  await off.install(market.client.id);
  await market.editText("use it for standups");

  // Not a permission update: the notice count stays 0, the dot shows.
  assert.deepEqual(await t.rail(), { count: 0, needsAdminReview: true });
  assert.deepEqual(await t.dotted(), [market.client.id]);
  const row = (await t.rows("/marketplace")).find((candidate) => candidate.id === market.client.id)!;
  assert.equal(row.promptTextConfirmationRequired, true);
  assert.equal(row.permissionApprovalRequired, false);
  // A Server with the flag off took the edit as confirmed: nothing waits there.
  assert.deepEqual(await off.rail(), NOTHING);
  assert.deepEqual(await off.dotted(), []);
  // The flag decides on its own: the same unconfirmed row is no dot while it reads off.
  __setPromptTextConsentEvaluatorForTests(async () => false);
  try {
    assert.deepEqual(await t.rail(), NOTHING);
    assert.deepEqual(await t.dotted(), []);
  } finally {
    __setPromptTextConsentEvaluatorForTests(null);
  }

  await t.approve(market.client.id, { confirmText: true });
  assert.deepEqual(await t.rail(), NOTHING);
  assert.deepEqual(await t.dotted(), []);
});

test("an agent's edit to a server-local App (flag on): its row on GET /clients dots until a person confirms", async ({ app }) => {
  const t = await seedTeam(app.baseUrl, "t24-local");
  await consentOn(t.server.id);
  const local = await t.createLocalApp("Local edited");
  const agent = await createAgent(t.server.id, `t24-maintainer-${randomUUID().slice(0, 6)}`, { runtime: "external", model: "external" });
  await getDb().insert(oauthClientMaintainers).values({
    clientId: local.id, principalType: "agent", agentId: agent.id, role: "owner", assignedByType: "system",
  });
  const edited = await updateOAuthClientForAgent({
    serverId: t.server.id, clientKey: local.clientId, actorAgentId: agent.id, whenToUse: "use it for everything",
  });
  assert.equal(edited.status, "ok");

  assert.deepEqual(await t.rail(), { count: 0, needsAdminReview: true });
  assert.deepEqual(await t.dotted("/clients"), [local.id]);

  const [current] = await getDb().select({ id: oauthClients.textCurrentRevisionId }).from(oauthClients).where(eq(oauthClients.id, local.id));
  const confirmed = await t.api(`/clients/${local.id}/prompt-text/confirm`, t.adminHeaders, {
    method: "PUT", body: JSON.stringify({ expected_revision_id: current!.id }),
  });
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.deepEqual(await t.rail(), NOTHING);
  assert.deepEqual(await t.dotted("/clients"), []);
});

test("both on one App: approving the permissions alone leaves the text's dot; uninstalling clears it", async ({ app }) => {
  const t = await seedTeam(app.baseUrl, "t24-both");
  await consentOn(t.server.id);
  const both = await seedMarketplaceApp(app.baseUrl, "both");
  const textOnly = await seedMarketplaceApp(app.baseUrl, "text-only");
  await t.install(both.client.id);
  await t.install(textOnly.client.id);
  await both.widenScopes();
  await both.editText("use it for standups");
  await textOnly.editText("use it for retros");

  assert.deepEqual(await t.rail(), { count: 1, needsAdminReview: true });
  assert.deepEqual(await t.dotted(), [both.client.id, textOnly.client.id].sort());

  await t.approve(both.client.id, { confirmText: false });
  assert.deepEqual(await t.rail(), { count: 0, needsAdminReview: true }, "the text still waits");
  assert.deepEqual(await t.dotted(), [both.client.id, textOnly.client.id].sort());

  await t.approve(both.client.id, { confirmText: true });
  assert.deepEqual(await t.dotted(), [textOnly.client.id]);
  assert.deepEqual(await t.rail(), { count: 0, needsAdminReview: true });

  await t.uninstall(textOnly.client.id);
  assert.deepEqual(await t.rail(), NOTHING);
  assert.deepEqual(await t.dotted(), []);
});

test("a member gets no needsAdminReview field and no rail read, while an admin sees the dot", async ({ app }) => {
  const t = await seedTeam(app.baseUrl, "t24-member");
  await consentOn(t.server.id);
  const market = await seedMarketplaceApp(app.baseUrl, "member");
  await t.install(market.client.id);
  await market.widenScopes();
  const local = await t.createLocalApp("Local member");

  assert.deepEqual(await t.dotted(), [market.client.id]);
  assert.equal((await t.api("/permission-updates", t.memberHeaders)).status, 403);
  for (const list of ["/marketplace", "/clients"] as const) {
    const memberRows = await t.rows(list, t.memberHeaders);
    assert.ok(memberRows.some((row) => row.id === market.client.id || row.id === local.id), `${list} lists the App to the member`);
    assert.equal(memberRows.some((row) => "needsAdminReview" in row), false, list);
  }
});
