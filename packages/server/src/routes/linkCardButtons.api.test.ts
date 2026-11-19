import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { Database } from "../db";
import {
  agents, integrationAuditEvents, linkCardOperations, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthUserConsents, officialAppRegistry, serverAgentMembers, users,
} from "../db/schema";
import { addMember } from "../services/serverService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { createAgent } from "../services/agentService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { __resetLinkCardActionLimitsForTests, admitLinkCardAppExecute, LINK_CARD_EXECUTE_PER_APP_PER_MINUTE } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests } from "../services/linkCardActionService";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { unreviewedActionsBasis } from "../services/linkCardExecuteEligibility";
import { uninstallMarketplaceOAuthClient } from "../services/oauthService";
import { ALL_CAPABILITIES, appAnswer, cardFixture, clientRequestId, handleFor, post, stubApp, type CardFixture } from "../test/linkCardActionFixture";
import { UNREVIEWED_APP_CAPABILITY } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkCardViewBinding } from "../services/linkCardTokens";

// RFC 076 §17: the card buttons of an App that is not official, per Server,
// decided by its installation there. On a server_local App's own Server they
// act by default and follow its endpoint, until someone with
// manageIntegrations there switches them off; on any other Server (or for a
// shared App on its own) only once someone with manageIntegrations there
// allowed the exact endpoint in force. The routes (switch, allow, withdraw,
// the admin read), execute's checks (live and under the installation row's
// lock), uninstall and reinstall, and the per-App execute limit.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(async () => {
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  __setLinkCardActionHooksForTests(null);
  __resetLinkCardActionLimitsForTests();
  __resetLinkCardReadBudgetForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

type Seed = Parameters<typeof cardFixture>[1];
const unofficial = (db: Database, fx: CardFixture) => db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
const appType = (db: Database, fx: CardFixture, type: "server_local" | "third_party_global") => db.update(oauthClients).set({ appType: type }).where(eq(oauthClients.id, fx.client.id));

/** The card fixture's App as a Server builds it for itself: server_local, not official, its source installation on its own Server. */
async function ownApp(db: Database, seed: Seed) {
  const fx = await cardFixture(db, seed);
  await unofficial(db, fx);
  await appType(db, fx, "server_local");
  return fx;
}

/** A shared App (not official) installed on another Server `elsewhere`, owned by the same person, who consented there and posts the same link. */
async function installedElsewhere(db: Database, seed: Seed) {
  const fx = await cardFixture(db, seed);
  await unofficial(db, fx);
  const server = await seed.server({ owner: fx.owner });
  const channel = await seed.channel({ server, members: [fx.owner] });
  const message = await seed.message({ channel, author: fx.owner, content: fx.content });
  const [install] = await db.insert(oauthClientInstalls).values({ clientId: fx.client.id, serverId: server.id, installedByUserId: fx.owner.id }).returning();
  await db.insert(oauthUserConsents).values({ serverId: server.id, userId: fx.owner.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  const elsewhere = { server, message, install: install!, headers: { ...fx.headers, "X-Server-Id": server.id } };
  return { fx, elsewhere };
}
type Elsewhere = Awaited<ReturnType<typeof installedElsewhere>>["elsewhere"];

const actionEndpointUrl = (baseUrl: string, fx: CardFixture) => `${baseUrl}/api/integrations/clients/${fx.client.id}/action-endpoint`;
async function call(baseUrl: string, fx: CardFixture, method: "PUT" | "DELETE" | "GET", headers: Record<string, string>, body?: unknown) {
  const url = method === "GET" ? actionEndpointUrl(baseUrl, fx) : `${actionEndpointUrl(baseUrl, fx)}/own-server-actions`;
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as Record<string, any> };
}
const installRow = async (db: Database, id: string) => (await db.select({
  allowed: oauthClientInstalls.allowedActionEndpoint, allowedAt: oauthClientInstalls.actionsAllowedAt, offAt: oauthClientInstalls.actionsOffAt,
}).from(oauthClientInstalls).where(eq(oauthClientInstalls.id, id)))[0];
const audits = (db: Database, fx: CardFixture, eventType: string) => db.select().from(integrationAuditEvents)
  .where(and(eq(integrationAuditEvents.clientId, fx.client.id), eq(integrationAuditEvents.eventType, eventType)));
const setEndpoint = (db: Database, fx: CardFixture, values: Partial<typeof oauthAppLinkPreviews.$inferInsert>) =>
  db.update(oauthAppLinkPreviews).set(values).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
const pick = (view: unknown) => { const { mode, state, in_force } = view as { mode: string; state: string; in_force: boolean }; return { mode, state, in_force }; };
const execute = (baseUrl: string, fx: { headers: Record<string, string> }, handle: string) => post(baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle });
/** A handle as the read signs it for a client that declared unreviewed_app.v1 (what an unofficial App's acting buttons need). */
const unreviewedHandle = (fx: CardFixture, binding: Partial<LinkCardViewBinding> = {}) =>
  handleFor(fx, { binding: { capabilities: [...ALL_CAPABILITIES, UNREVIEWED_APP_CAPABILITY].sort(), ...binding } }).handle;
const elsewhereHandle = (fx: CardFixture, elsewhere: Elsewhere) =>
  unreviewedHandle(fx, { serverId: elsewhere.server.id, installationKey: elsewhere.install.id, messageId: elsewhere.message.id });
const personName = async (db: Database, id: string) => {
  const [row] = await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, id));
  return row!.displayName || row!.name;
};

test("the rule: on a server_local App's own Server, on unless switched off and following its endpoint; anywhere else, only the allowed endpoint in force; never without one or when suspended", () => {
  const own = "8a6e0c4e-0d1f-4b7a-9c2d-3e4f5a6b7c8d";
  const other = "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b";
  const entry = (patch: { appType?: "server_local" | "slock_builtin" | "third_party_global"; actionEndpoint?: string | null; allowed?: string | null; off?: boolean; suspended?: boolean } = {}) => ({
    app: { serverId: own, appType: patch.appType ?? "server_local" as const },
    config: { actionEndpoint: patch.actionEndpoint === undefined ? "https://a.example/act" : patch.actionEndpoint, suspendedAt: patch.suspended ? new Date() : null },
    installation: { allowedActionEndpoint: patch.allowed ?? null, actionsOffAt: patch.off ? new Date() : null },
  });
  assert.equal(unreviewedActionsBasis(entry(), own), "own_server", "on by default");
  assert.equal(unreviewedActionsBasis(entry(), own.toUpperCase()), "own_server", "ids compare without case");
  assert.equal(unreviewedActionsBasis(entry({ actionEndpoint: "https://a.example/act2" }), own), "own_server", "follows the endpoint");
  assert.equal(unreviewedActionsBasis(entry({ off: true }), own), null, "switched off");
  assert.equal(unreviewedActionsBasis(entry({ actionEndpoint: null }), own), null, "no endpoint");
  assert.equal(unreviewedActionsBasis(entry({ suspended: true }), own), null, "suspended");
  assert.equal(unreviewedActionsBasis(entry({ allowed: "https://a.example/act", off: true }), own), null, "an allow does not override the switch on its own Server");
  // Elsewhere, and a shared or published App on its own Server: the allow.
  for (const [serverId, type] of [[other, "server_local"], [other, "third_party_global"], [own, "third_party_global"]] as const) {
    assert.equal(unreviewedActionsBasis(entry({ appType: type }), serverId), null, `${type} on ${serverId === own ? "its own" : "another"} Server: not allowed`);
    assert.equal(unreviewedActionsBasis(entry({ appType: type, allowed: "https://a.example/act" }), serverId), "allowed");
    assert.equal(unreviewedActionsBasis(entry({ appType: type, allowed: "https://a.example/act", actionEndpoint: "https://a.example/act2" }), serverId), null, "endpoint changed");
    assert.equal(unreviewedActionsBasis(entry({ appType: type, allowed: "https://a.example/act", suspended: true }), serverId), null, "suspended");
    assert.equal(unreviewedActionsBasis(entry({ appType: type, allowed: "https://a.example/act", off: true }), serverId), "allowed", "the off switch is only the own Server's");
  }
});

test("own Server: on by default with an endpoint, switched off and on by manageIntegrations there (audited with the Server and person), following endpoint changes", async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const actionCalls = (url = fx.actionEndpoint) => calls.filter((c) => c.url === url).length;

  // Nobody allowed anything: it acts.
  const first = await execute(app.baseUrl, fx, unreviewedHandle(fx));
  assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.state, "accepted");
  assert.equal(actionCalls(), 1);
  const read = await call(app.baseUrl, fx, "GET", fx.headers);
  assert.deepEqual(read.body.card_buttons, {
    mode: "own_server", state: "on", in_force: true, action_endpoint: fx.actionEndpoint, pending_action_endpoint: null, allowed_action_endpoint: null,
    changed_at: null, changed_by: null,
  });
  // The web's earlier shape: on reads as allowed, from when the registration last changed, by nobody known.
  assert.deepEqual(read.body.own_server_actions, {
    state: "allowed", confirmed_action_endpoint: fx.actionEndpoint, confirmed_at: fx.registration.updatedAt.toISOString(), confirmed_by: null, in_force: true,
  });

  // Switched off: stored as a time, never a URL; refused before any call; one audit event naming the Server and the person.
  const off = await call(app.baseUrl, fx, "DELETE", fx.headers);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual([off.body.confirmed_action_endpoint, off.body.confirmed_at, pick(off.body.card_buttons)], [null, null, { mode: "own_server", state: "off", in_force: false }]);
  const offRow = await installRow(db, fx.install.id);
  assert.ok(offRow?.offAt instanceof Date); assert.equal(offRow.allowed, null);
  assert.equal(off.body.card_buttons.changed_at, offRow.offAt.toISOString());
  const refused = await execute(app.baseUrl, fx, unreviewedHandle(fx));
  assert.equal(refused.status, 410); assert.equal(refused.body.code, "PROVIDER_NOT_ELIGIBLE");
  assert.equal(actionCalls(), 1);
  assert.equal((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions.state, "not_allowed");
  const [offEvent, ...moreOff] = await audits(db, fx, "app.link_card_actions_off");
  assert.equal(moreOff.length, 0);
  assert.deepEqual([offEvent!.serverId, offEvent!.actorType, offEvent!.actorId, offEvent!.metadata], [fx.server.id, "human", fx.owner.id, { clientKey: fx.client.clientId }]);
  assert.equal((await call(app.baseUrl, fx, "DELETE", fx.headers)).status, 200);
  assert.equal((await audits(db, fx, "app.link_card_actions_off")).length, 1, "off again writes nothing");
  // The App moves its endpoint while off: still off.
  const v2 = `${fx.actionEndpoint}-v2`;
  await setEndpoint(db, fx, { actionEndpoint: v2 });
  assert.equal((await execute(app.baseUrl, fx, unreviewedHandle(fx))).status, 410);

  // Switched on, sending the endpoint as shown (a stale one is 409, nothing written).
  const stale = await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: fx.actionEndpoint });
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "OWN_SERVER_ACTIONS_ENDPOINT_CHANGED");
  assert.ok((await installRow(db, fx.install.id))?.offAt instanceof Date);
  const on = await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: v2 });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.confirmed_action_endpoint, v2);
  assert.equal((await installRow(db, fx.install.id))?.offAt, null);
  const [onEvent] = await audits(db, fx, "app.link_card_actions_on");
  assert.deepEqual([onEvent!.serverId, onEvent!.actorId], [fx.server.id, fx.owner.id]);
  const name = await personName(db, fx.owner.id);
  assert.deepEqual(on.body.card_buttons, {
    mode: "own_server", state: "on", in_force: true, action_endpoint: v2, pending_action_endpoint: null, allowed_action_endpoint: null,
    changed_at: onEvent!.createdAt.toISOString(), changed_by: { type: "human", id: fx.owner.id, name },
  });
  assert.deepEqual((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions, {
    state: "allowed", confirmed_action_endpoint: v2, confirmed_at: onEvent!.createdAt.toISOString(), confirmed_by: { id: fx.owner.id, name }, in_force: true,
  });
  assert.equal((await execute(app.baseUrl, fx, unreviewedHandle(fx))).body.state, "accepted");
  assert.equal(actionCalls(v2), 1);
  // It follows the next change on its own: nobody allows anything.
  const v3 = `${fx.actionEndpoint}-v3`;
  await setEndpoint(db, fx, { actionEndpoint: v3 });
  assert.equal((await execute(app.baseUrl, fx, unreviewedHandle(fx))).body.state, "accepted");
  assert.equal(actionCalls(v3), 1);
  assert.equal((await audits(db, fx, "app.link_card_actions_on")).length, 1);

  // Suspended, no endpoint: the read says so; with none there is nothing to switch on to.
  await setEndpoint(db, fx, { suspendedAt: new Date(), suspendedReason: "proof_unavailable" });
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", fx.headers)).body.card_buttons), { mode: "own_server", state: "suspended", in_force: false });
  assert.equal((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions.state, "suspended");
  await setEndpoint(db, fx, { suspendedAt: null, suspendedReason: null, actionEndpoint: null });
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", fx.headers)).body.card_buttons), { mode: "own_server", state: "no_endpoint", in_force: false });
  assert.equal((await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: v3 })).body.code, "OWN_SERVER_ACTIONS_NO_ENDPOINT");
  await setEndpoint(db, fx, { actionEndpoint: fx.actionEndpoint });

  // Shared (no longer server_local): the default ends; on its own Server it now needs an allow like anywhere else.
  await appType(db, fx, "third_party_global");
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", fx.headers)).body.card_buttons), { mode: "allow", state: "not_allowed", in_force: false });
  assert.equal((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions, null);
  assert.equal((await execute(app.baseUrl, fx, unreviewedHandle(fx))).status, 410);
  // Official: nothing to switch (§4 decides), no section.
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.deepEqual([(await call(app.baseUrl, fx, "GET", fx.headers)).body.card_buttons, (await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions], [null, null]);
  // The CHECK: an allowed endpoint without a time (or the reverse) is refused.
  await assert.rejects(db.update(oauthClientInstalls).set({ allowedActionEndpoint: fx.actionEndpoint }).where(eq(oauthClientInstalls.id, fx.install.id)),
    (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("oauth_client_installs_actions_allowed"));
});

test("another Server: links only until allowed; the allow binds the exact reviewed endpoint in force; a change drops it to links until allowed again or reverted; withdrawn", async ({ app, db, seed }) => {
  const { fx, elsewhere } = await installedElsewhere(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const actionCalls = (url = fx.actionEndpoint) => calls.filter((c) => c.url === url).length;
  const get = async () => (await call(app.baseUrl, fx, "GET", elsewhere.headers)).body;
  const allow = (actionEndpoint: string) => call(app.baseUrl, fx, "PUT", elsewhere.headers, { action_endpoint: actionEndpoint });

  const before = await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere));
  assert.equal(before.status, 410, JSON.stringify(before.body)); assert.equal(before.body.code, "PROVIDER_NOT_ELIGIBLE");
  const read = await get();
  assert.deepEqual(read.card_buttons, {
    mode: "allow", state: "not_allowed", in_force: false, action_endpoint: fx.actionEndpoint, pending_action_endpoint: null, allowed_action_endpoint: null,
    changed_at: null, changed_by: null,
  });
  assert.deepEqual([read.action_endpoint, read.own_server_actions, read.reject_reason], [fx.actionEndpoint, null, null]);

  // A change waiting for review is not allowable, while the reviewed one in force is.
  const pending = `${fx.actionEndpoint}-pending`;
  await setEndpoint(db, fx, { pendingActionEndpoint: pending, pendingActionEndpointRequestedAt: new Date() });
  const notYet = await allow(pending);
  assert.equal(notYet.status, 409); assert.equal(notYet.body.code, "OWN_SERVER_ACTIONS_PENDING_REVIEW");
  const stale = await allow(`${fx.actionEndpoint}-old`);
  assert.equal(stale.status, 409); assert.equal(stale.body.code, "OWN_SERVER_ACTIONS_ENDPOINT_CHANGED");
  assert.deepEqual(await installRow(db, elsewhere.install.id), { allowed: null, allowedAt: null, offAt: null });
  // Its only endpoint pending: nothing to allow yet.
  await setEndpoint(db, fx, { actionEndpoint: null });
  assert.deepEqual(pick((await get()).card_buttons), { mode: "allow", state: "pending_review", in_force: false });
  assert.equal((await allow(pending)).body.code, "OWN_SERVER_ACTIONS_PENDING_REVIEW");
  assert.equal((await allow(fx.actionEndpoint)).body.code, "OWN_SERVER_ACTIONS_NO_ENDPOINT");
  await setEndpoint(db, fx, { actionEndpoint: fx.actionEndpoint });

  // Allowed: the exact endpoint, audited with this Server and the person; it acts here, and only here.
  const allowed = await allow(fx.actionEndpoint);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const row = await installRow(db, elsewhere.install.id);
  assert.equal(row?.allowed, fx.actionEndpoint); assert.ok(row?.allowedAt instanceof Date);
  assert.deepEqual([allowed.body.confirmed_action_endpoint, allowed.body.confirmed_at], [fx.actionEndpoint, row.allowedAt.toISOString()]);
  assert.deepEqual(allowed.body.card_buttons, {
    mode: "allow", state: "allowed", in_force: true, action_endpoint: fx.actionEndpoint, pending_action_endpoint: pending, allowed_action_endpoint: fx.actionEndpoint,
    changed_at: row.allowedAt.toISOString(), changed_by: { type: "human", id: fx.owner.id, name: await personName(db, fx.owner.id) },
  });
  const [event, ...more] = await audits(db, fx, "app.link_card_actions_allowed");
  assert.equal(more.length, 0);
  assert.deepEqual([event!.serverId, event!.actorType, event!.actorId, event!.metadata], [elsewhere.server.id, "human", fx.owner.id, { clientKey: fx.client.clientId, actionEndpoint: fx.actionEndpoint }]);
  assert.equal((await allow(fx.actionEndpoint)).status, 200);
  assert.equal((await audits(db, fx, "app.link_card_actions_allowed")).length, 1, "allowing it again writes nothing");
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).body.state, "accepted");
  assert.equal(actionCalls(), 1);
  assert.equal((await execute(app.baseUrl, fx, unreviewedHandle(fx))).status, 410, "the App's own Server (shared App, nothing allowed there) is not affected");

  // The App changes its endpoint (the pending one is approved): links only, said as endpoint_changed.
  await setEndpoint(db, fx, { actionEndpoint: pending, pendingActionEndpoint: null, pendingActionEndpointRequestedAt: null });
  assert.deepEqual(pick((await get()).card_buttons), { mode: "allow", state: "endpoint_changed", in_force: false });
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).status, 410);
  assert.equal(actionCalls(pending), 0);
  // Reverted to the allowed one: it acts again without anyone allowing.
  await setEndpoint(db, fx, { actionEndpoint: fx.actionEndpoint });
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).body.state, "accepted");
  // Changed again and allowed again: bound to the new one.
  await setEndpoint(db, fx, { actionEndpoint: pending });
  assert.equal((await allow(pending)).status, 200);
  assert.equal((await installRow(db, elsewhere.install.id))?.allowed, pending);
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).body.state, "accepted");
  assert.equal(actionCalls(pending), 1);

  // Withdrawn: links only again, audited with what was allowed; again writes nothing.
  const withdrawn = await call(app.baseUrl, fx, "DELETE", elsewhere.headers);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual([withdrawn.body.confirmed_action_endpoint, pick(withdrawn.body.card_buttons)], [null, { mode: "allow", state: "not_allowed", in_force: false }]);
  assert.deepEqual(await installRow(db, elsewhere.install.id), { allowed: null, allowedAt: null, offAt: null });
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).status, 410);
  assert.equal((await call(app.baseUrl, fx, "DELETE", elsewhere.headers)).status, 200);
  const withdrawals = await audits(db, fx, "app.link_card_actions_withdrawn");
  assert.equal(withdrawals.length, 1);
  assert.deepEqual([withdrawals[0]!.serverId, withdrawals[0]!.metadata], [elsewhere.server.id, { clientKey: fx.client.clientId, actionEndpoint: pending }]);
});

test("uninstall ends the allow; a reinstall starts from nothing (the allow is the installation row's, not the App's on that Server)", async ({ app, db, seed }) => {
  const { fx, elsewhere } = await installedElsewhere(db, seed);
  stubApp(() => appAnswer({ status: "accepted" }));
  assert.equal((await call(app.baseUrl, fx, "PUT", elsewhere.headers, { action_endpoint: fx.actionEndpoint })).status, 200);
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).body.state, "accepted");

  assert.ok(await uninstallMarketplaceOAuthClient({ serverId: elsewhere.server.id, clientId: fx.client.id, revokedByUserId: fx.owner.id }));
  assert.equal((await db.select().from(oauthClientInstalls).where(eq(oauthClientInstalls.id, elsewhere.install.id))).length, 0);
  assert.equal((await call(app.baseUrl, fx, "GET", elsewhere.headers)).status, 404, "not installed here: nothing to read");
  assert.equal((await call(app.baseUrl, fx, "PUT", elsewhere.headers, { action_endpoint: fx.actionEndpoint })).status, 404, "nor to allow");

  // Installed again (and consented again): links only until someone allows again.
  const [again] = await db.insert(oauthClientInstalls).values({ clientId: fx.client.id, serverId: elsewhere.server.id, installedByUserId: fx.owner.id }).returning();
  await db.update(oauthUserConsents).set({ revokedAt: null }).where(and(eq(oauthUserConsents.clientId, fx.client.id), eq(oauthUserConsents.serverId, elsewhere.server.id)));
  assert.deepEqual(await installRow(db, again!.id), { allowed: null, allowedAt: null, offAt: null });
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", elsewhere.headers)).body.card_buttons), { mode: "allow", state: "not_allowed", in_force: false });
  const reinstalled = { ...elsewhere, install: again! };
  const refused = await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, reinstalled));
  assert.equal(refused.status, 410, JSON.stringify(refused.body)); assert.equal(refused.body.code, "PROVIDER_NOT_ELIGIBLE");
  assert.equal((await call(app.baseUrl, fx, "PUT", elsewhere.headers, { action_endpoint: fx.actionEndpoint })).status, 200);
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, reinstalled))).body.state, "accepted");
});

test("an official App can't be allowed (409, nothing written): Raft decides its buttons everywhere, and a stored allow would start working undecided if it stopped being official", async ({ app, db, seed }) => {
  const { fx, elsewhere } = await installedElsewhere(db, seed);
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  const refused = await call(app.baseUrl, fx, "PUT", elsewhere.headers, { action_endpoint: fx.actionEndpoint });
  assert.equal(refused.status, 409, JSON.stringify(refused.body)); assert.equal(refused.body.code, "OWN_SERVER_ACTIONS_OFFICIAL_APP");
  assert.deepEqual(await installRow(db, elsewhere.install.id), { allowed: null, allowedAt: null, offAt: null });
  assert.equal((await audits(db, fx, "app.link_card_actions_allowed")).length, 0);
  // Once it is no longer official, nothing was granted: links only until someone allows it then.
  await unofficial(db, fx);
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", elsewhere.headers)).body.card_buttons), { mode: "allow", state: "not_allowed", in_force: false });
});

test("execute: a switch-off or a withdrawal after the live check is refused under the installation row's lock; nothing written, nothing sent", async ({ app, db, seed }) => {
  const own = await ownApp(db, seed);
  const { fx, elsewhere } = await installedElsewhere(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  await db.update(oauthClientInstalls).set({ allowedActionEndpoint: fx.actionEndpoint, actionsAllowedAt: new Date() }).where(eq(oauthClientInstalls.id, elsewhere.install.id));
  const operations = async () => (await db.select().from(linkCardOperations)).length;
  const before = await operations();
  for (const [why, viewer, handle, change] of [
    ["switched off on the App's own Server", own, unreviewedHandle(own), () => db.update(oauthClientInstalls).set({ actionsOffAt: new Date() }).where(eq(oauthClientInstalls.id, own.install.id))],
    ["withdrawn on another Server", elsewhere, elsewhereHandle(fx, elsewhere), () => db.update(oauthClientInstalls).set({ allowedActionEndpoint: null, actionsAllowedAt: null }).where(eq(oauthClientInstalls.id, elsewhere.install.id))],
  ] as const) {
    __setLinkCardActionHooksForTests({ beforeAdmission: async () => { await change(); } });
    const late = await execute(app.baseUrl, viewer, handle);
    __setLinkCardActionHooksForTests(null);
    assert.equal(late.status, 410, `${why}: ${JSON.stringify(late.body)}`); assert.equal(late.body.code, "PROVIDER_NOT_ELIGIBLE", why);
  }
  assert.equal(await operations(), before);
  assert.equal(calls.filter((c) => c.url === fx.actionEndpoint || c.url === own.actionEndpoint).length, 0);
});

test("who may: only manageIntegrations on the Server that holds the installation (others, and Servers without it, get the read's 404)", async ({ app, db, seed }) => {
  const { fx, elsewhere } = await installedElsewhere(db, seed);
  const member = await seed.human();
  await addMember(elsewhere.server.id, member.id);
  await addMember(fx.server.id, member.id);
  const token = await tokenForHuman(member.email);
  const notInstalled = await seed.server({ owner: fx.owner });
  for (const [why, headers] of [
    ["a member without manageIntegrations, elsewhere", { ...elsewhere.headers, Authorization: `Bearer ${token}` }],
    ["a member without manageIntegrations, the App's own Server", { ...fx.headers, Authorization: `Bearer ${token}` }],
    ["a Server the App is not installed on", { ...fx.headers, "X-Server-Id": notInstalled.id }],
  ] as const) {
    assert.equal((await call(app.baseUrl, fx, "PUT", headers, { action_endpoint: fx.actionEndpoint })).status, 404, why);
    assert.equal((await call(app.baseUrl, fx, "DELETE", headers)).status, 404, why);
    assert.equal((await call(app.baseUrl, fx, "GET", headers)).status, 404, why);
  }
  assert.deepEqual(await installRow(db, elsewhere.install.id), { allowed: null, allowedAt: null, offAt: null });
  // Strict body.
  for (const body of [{}, { action_endpoint: 1 }, { action_endpoint: fx.actionEndpoint, extra: true }]) {
    const res = await call(app.baseUrl, fx, "PUT", elsewhere.headers, body);
    assert.equal(res.status, 400, JSON.stringify(body)); assert.equal(res.body.code, "OWN_SERVER_ACTIONS_INVALID");
  }
});

test("an agent with manageIntegrations on the Server allows and withdraws like a person (agent API); one without it gets the 404", async ({ app, db, seed }) => {
  const { fx, elsewhere } = await installedElsewhere(db, seed);
  stubApp(() => appAnswer({ status: "accepted" }));
  const agent = await createAgent(elsewhere.server.id, `cards-admin-${Date.now()}`, { runtime: "claude", model: "sonnet" });
  const key = (await mintAgentCredential({ agentId: agent.id, scopes: ["send", "read"], name: "cards", issuedVia: "computer", createdByUserId: null })).apiKey;
  const cardButtons = async (body: Record<string, unknown>) => {
    const res = await fetch(`${app.baseUrl}/internal/agent-api/integrations/app/card-buttons`, {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ clientKey: fx.client.clientId, ...body }),
    });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };

  // A member agent: the same 404 as an unknown App, nothing written.
  for (const body of [{ action: "show" }, { action: "allow", actionEndpoint: fx.actionEndpoint }, { action: "withdraw" }]) {
    const refused = await cardButtons(body);
    assert.equal(refused.status, 404, JSON.stringify(refused.body)); assert.equal(refused.body.code, "app_not_found");
  }
  assert.deepEqual(await installRow(db, elsewhere.install.id), { allowed: null, allowedAt: null, offAt: null });

  // An admin agent (manageIntegrations): show, then allow exactly what it showed.
  await db.update(serverAgentMembers).set({ role: "admin" }).where(and(eq(serverAgentMembers.serverId, elsewhere.server.id), eq(serverAgentMembers.agentId, agent.id)));
  const shown = await cardButtons({ action: "show" });
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.deepEqual([shown.body.clientKey, shown.body.cardButtons.mode, shown.body.cardButtons.state, shown.body.cardButtons.actionEndpoint], [fx.client.clientId, "allow", "not_allowed", fx.actionEndpoint]);
  for (const body of [{ action: "allow" }, { action: "show", actionEndpoint: fx.actionEndpoint }]) {
    assert.equal((await cardButtons(body)).status, 400, JSON.stringify(body));
  }
  const stale = await cardButtons({ action: "allow", actionEndpoint: `${fx.actionEndpoint}-old` });
  assert.deepEqual([stale.status, stale.body.code], [409, "OWN_SERVER_ACTIONS_ENDPOINT_CHANGED"]);
  const allowed = await cardButtons({ action: "allow", actionEndpoint: fx.actionEndpoint });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  const row = await installRow(db, elsewhere.install.id);
  assert.equal(row?.allowed, fx.actionEndpoint);
  const [agentRow] = await db.select({ name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, agent.id));
  assert.deepEqual(allowed.body.cardButtons, {
    mode: "allow", state: "allowed", inForce: true, actionEndpoint: fx.actionEndpoint, pendingActionEndpoint: null, allowedActionEndpoint: fx.actionEndpoint,
    changedAt: row!.allowedAt!.toISOString(), changedBy: { type: "agent", id: agent.id, name: agentRow!.displayName || agentRow!.name },
  });
  const [event] = await audits(db, fx, "app.link_card_actions_allowed");
  assert.deepEqual([event!.serverId, event!.actorType, event!.actorId, event!.source], [elsewhere.server.id, "agent", agent.id, "cli"]);
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).body.state, "accepted");
  // The person's read names the agent too.
  assert.deepEqual((await call(app.baseUrl, fx, "GET", elsewhere.headers)).body.card_buttons.changed_by, { type: "agent", id: agent.id, name: agentRow!.displayName || agentRow!.name });

  const withdrawn = await cardButtons({ action: "withdraw" });
  assert.deepEqual([withdrawn.status, withdrawn.body.cardButtons.state], [200, "not_allowed"]);
  assert.equal((await audits(db, fx, "app.link_card_actions_withdrawn"))[0]!.actorId, agent.id);
  assert.equal((await execute(app.baseUrl, elsewhere, elsewhereHandle(fx, elsewhere))).status, 410);
});

test("unreviewed_app.v1: an unofficial App's execute and prepare refuse a handle that doesn't carry it (410), and call nothing; an official App's don't need it", async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const without = await execute(app.baseUrl, fx, handleFor(fx).handle);
  assert.equal(without.status, 410); assert.equal(without.body.code, "HANDLE_INVALID");
  const prepare = await post(app.baseUrl, "prepare", fx, { handle: handleFor(fx, { requiresPrepare: true }).handle, claimed: { business_revision: "br-1" } });
  assert.equal(prepare.status, 410);
  assert.equal(calls.filter((c) => c.url === fx.actionEndpoint).length, 0);
  assert.equal((await execute(app.baseUrl, fx, unreviewedHandle(fx))).body.state, "accepted");
  // Official again: its handles never needed the capability.
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.equal((await execute(app.baseUrl, fx, handleFor(fx).handle)).body.state, "accepted");
});

test(`limits: an unofficial App gets ${LINK_CARD_EXECUTE_PER_APP_PER_MINUTE} executes per viewer per Server per App per minute; the next is 429 and calls nothing; official Apps keep only the per-Server budget`, async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  for (let i = 0; i < LINK_CARD_EXECUTE_PER_APP_PER_MINUTE; i++) {
    const res = await execute(app.baseUrl, fx, unreviewedHandle(fx));
    assert.equal(res.status, 200, `execute ${i + 1}: ${JSON.stringify(res.body)}`);
  }
  const over = await execute(app.baseUrl, fx, unreviewedHandle(fx));
  assert.equal(over.status, 429); assert.equal(over.body.code, "RATE_LIMITED");
  assert.equal(calls.filter((c) => c.url === fx.actionEndpoint).length, LINK_CARD_EXECUTE_PER_APP_PER_MINUTE);
  assert.equal((await admitLinkCardAppExecute(fx.owner.id, fx.server.id, "another-app")).admitted, true, "another App's budget is its own");

  // Official again: past the per-App count, still admitted.
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.equal((await execute(app.baseUrl, fx, handleFor(fx).handle)).body.state, "accepted");
});
