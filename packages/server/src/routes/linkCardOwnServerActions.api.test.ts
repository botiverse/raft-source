import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { Database } from "../db";
import {
  integrationAuditEvents, linkCardOperations, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthUserConsents, officialAppRegistry, users,
} from "../db/schema";
import { addMember } from "../services/serverService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { __resetLinkCardActionLimitsForTests, admitLinkCardAppExecute, LINK_CARD_EXECUTE_PER_APP_PER_MINUTE } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests } from "../services/linkCardActionService";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { ownServerActionsInForce } from "../services/linkCardExecuteEligibility";
import { ALL_CAPABILITIES, appAnswer, cardFixture, clientRequestId, handleFor, post, stubApp, type CardFixture } from "../test/linkCardActionFixture";
import { UNREVIEWED_APP_CAPABILITY } from "@botiverse/raft-shared/src/appLinkPreview";
import type { LinkCardViewBinding } from "../services/linkCardTokens";

// RFC 076 §17: a server_local App's card buttons may call its action endpoint
// on its own Server once a person with manageIntegrations there confirmed the
// endpoint in force, exactly as shown. The routes (confirm, withdraw, the
// admin read), execute's checks against it (live and under the registration
// row's lock), another Server's viewers, and the per-App execute limit.
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

/** The card fixture's App, no longer official: what a Server builds for itself. */
async function ownApp(db: Database, seed: Parameters<typeof cardFixture>[1]) {
  const fx = await cardFixture(db, seed);
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  return fx;
}

const ownServerActionsUrl = (baseUrl: string, fx: CardFixture) => `${baseUrl}/api/integrations/clients/${fx.client.id}/action-endpoint/own-server-actions`;
async function call(baseUrl: string, fx: CardFixture, method: "PUT" | "DELETE" | "GET", headers: Record<string, string>, body?: unknown) {
  const url = method === "GET" ? `${baseUrl}/api/integrations/clients/${fx.client.id}/action-endpoint` : ownServerActionsUrl(baseUrl, fx);
  const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const confirmation = async (db: Database, fx: CardFixture) => (await db.select({ endpoint: oauthAppLinkPreviews.ownServerActionEndpoint, at: oauthAppLinkPreviews.ownServerActionsConfirmedAt })
  .from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, fx.client.id)))[0]!;
const audits = (db: Database, fx: CardFixture, eventType: "app.link_card_actions_confirmed" | "app.link_card_actions_withdrawn") => db.select().from(integrationAuditEvents)
  .where(and(eq(integrationAuditEvents.clientId, fx.client.id), eq(integrationAuditEvents.eventType, eventType)));
const confirmInDb = (db: Database, fx: CardFixture) => db.update(oauthAppLinkPreviews)
  .set({ ownServerActionEndpoint: fx.actionEndpoint, ownServerActionsConfirmedAt: new Date() }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
const withdrawInDb = (db: Database, fx: CardFixture) => db.update(oauthAppLinkPreviews)
  .set({ ownServerActionEndpoint: null, ownServerActionsConfirmedAt: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
const pick = (view: unknown) => { const { state, in_force } = view as { state: string; in_force: boolean }; return { state, in_force }; };
const execute = (baseUrl: string, fx: { headers: Record<string, string> }, handle: string) => post(baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle });
/** A handle as the read signs it for a client that declared unreviewed_app.v1 (what an own-Server App's acting buttons need). */
const ownHandle = (fx: CardFixture, binding: Partial<LinkCardViewBinding> = {}) =>
  handleFor(fx, { binding: { capabilities: [...ALL_CAPABILITIES, UNREVIEWED_APP_CAPABILITY].sort(), ...binding } }).handle;

test("the rule: server_local, the App's own Server, the endpoint in force equal to the confirmed one, not suspended", () => {
  const entry = (patch: { serverId?: string; appType?: "server_local" | "slock_builtin" | "third_party_global"; actionEndpoint?: string | null; confirmed?: string | null; suspended?: boolean } = {}) => ({
    app: { serverId: patch.serverId ?? "8a6e0c4e-0d1f-4b7a-9c2d-3e4f5a6b7c8d", appType: patch.appType ?? "server_local" as const },
    config: {
      actionEndpoint: patch.actionEndpoint === undefined ? "https://a.example/act" : patch.actionEndpoint,
      ownServerActionEndpoint: patch.confirmed === undefined ? "https://a.example/act" : patch.confirmed,
      suspendedAt: patch.suspended ? new Date() : null,
    },
  });
  const own = "8a6e0c4e-0d1f-4b7a-9c2d-3e4f5a6b7c8d";
  assert.equal(ownServerActionsInForce(entry(), own), true);
  assert.equal(ownServerActionsInForce(entry(), own.toUpperCase()), true, "ids compare without case");
  assert.equal(ownServerActionsInForce(entry(), "1b2c3d4e-5f60-4718-8a9b-0c1d2e3f4a5b"), false, "another Server");
  assert.equal(ownServerActionsInForce(entry({ appType: "third_party_global" }), own), false, "published");
  assert.equal(ownServerActionsInForce(entry({ appType: "slock_builtin" }), own), false, "built in");
  assert.equal(ownServerActionsInForce(entry({ confirmed: null }), own), false, "not confirmed");
  assert.equal(ownServerActionsInForce(entry({ actionEndpoint: "https://a.example/act2" }), own), false, "the App changed its endpoint");
  assert.equal(ownServerActionsInForce(entry({ actionEndpoint: null, confirmed: null }), own), false, "no endpoint");
  assert.equal(ownServerActionsInForce(entry({ suspended: true }), own), false, "suspended");
});

test("confirm and withdraw: only a person with manageIntegrations on the App's own Server, the endpoint exactly as shown, each change audited once", async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  // A member without manageIntegrations, and the owner acting on another of their Servers: the same 404 as an unknown App.
  const member = await seed.human();
  await addMember(fx.server.id, member.id);
  const memberHeaders = { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(member.email)}` };
  const elsewhere = await seed.server({ owner: fx.owner });
  const elsewhereHeaders = { ...fx.headers, "X-Server-Id": elsewhere.id };
  for (const headers of [memberHeaders, elsewhereHeaders]) {
    assert.equal((await call(app.baseUrl, fx, "PUT", headers, { action_endpoint: fx.actionEndpoint })).status, 404);
    assert.equal((await call(app.baseUrl, fx, "DELETE", headers)).status, 404);
    assert.equal((await call(app.baseUrl, fx, "GET", headers)).status, 404);
  }
  // Strict body.
  for (const body of [{}, { action_endpoint: 1 }, { action_endpoint: fx.actionEndpoint, extra: true }]) {
    const res = await call(app.baseUrl, fx, "PUT", fx.headers, body);
    assert.equal(res.status, 400, JSON.stringify(body)); assert.equal(res.body.code, "OWN_SERVER_ACTIONS_INVALID");
  }
  // Not what is in force: 409 with the one that is, nothing written.
  const changed = await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: `${fx.actionEndpoint}-old` });
  assert.equal(changed.status, 409); assert.equal(changed.body.code, "OWN_SERVER_ACTIONS_ENDPOINT_CHANGED");
  assert.equal((await call(app.baseUrl, fx, "GET", fx.headers)).body.action_endpoint, fx.actionEndpoint, "the one in force, to show again");
  assert.deepEqual(await confirmation(db, fx), { endpoint: null, at: null });
  assert.deepEqual((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions, { state: "not_allowed", confirmed_action_endpoint: null, confirmed_at: null, confirmed_by: null, in_force: false });

  // Confirmed: the row, the read, one audit event naming the person.
  const confirmed = await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: fx.actionEndpoint });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.confirmed_action_endpoint, fx.actionEndpoint);
  const row = await confirmation(db, fx);
  assert.equal(row.endpoint, fx.actionEndpoint); assert.equal(row.at?.toISOString(), confirmed.body.confirmed_at);
  const ownerName = (await db.select({ name: users.name, displayName: users.displayName }).from(users).where(eq(users.id, fx.owner.id)))[0]!;
  assert.deepEqual((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions, {
    state: "allowed", confirmed_action_endpoint: fx.actionEndpoint, confirmed_at: confirmed.body.confirmed_at,
    confirmed_by: { id: fx.owner.id, name: ownerName.displayName || ownerName.name }, in_force: true,
  });
  // Suspended: the same confirmation, not in force until the registration resumes.
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: "proof_unavailable" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions), { state: "suspended", in_force: false });
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: null, suspendedReason: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const [audit, ...more] = await audits(db, fx, "app.link_card_actions_confirmed");
  assert.equal(more.length, 0);
  assert.equal(audit!.actorType, "human"); assert.equal(audit!.actorId, fx.owner.id); assert.equal(audit!.serverId, fx.server.id);
  assert.deepEqual(audit!.metadata, { clientKey: fx.client.clientId, actionEndpoint: fx.actionEndpoint });
  // Again: the same confirmation, no second event.
  const again = await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: fx.actionEndpoint });
  assert.equal(again.body.confirmed_at, confirmed.body.confirmed_at);
  assert.equal((await audits(db, fx, "app.link_card_actions_confirmed")).length, 1);
  // The App moved its endpoint: the read says it is no longer in force.
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${fx.actionEndpoint}-v2` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions), { state: "endpoint_changed", in_force: false });
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: null }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(pick((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions), { state: "no_endpoint", in_force: false });
  assert.equal((await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: fx.actionEndpoint })).body.code, "OWN_SERVER_ACTIONS_NO_ENDPOINT");
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: fx.actionEndpoint }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));

  // Withdrawn: cleared, one event with what was confirmed; again writes nothing.
  assert.deepEqual((await call(app.baseUrl, fx, "DELETE", fx.headers)).body, { confirmed_action_endpoint: null, confirmed_at: null });
  assert.deepEqual(await confirmation(db, fx), { endpoint: null, at: null });
  assert.equal((await call(app.baseUrl, fx, "DELETE", fx.headers)).status, 200);
  const withdrawn = await audits(db, fx, "app.link_card_actions_withdrawn");
  assert.equal(withdrawn.length, 1);
  assert.deepEqual(withdrawn[0]!.metadata, { clientKey: fx.client.clientId, actionEndpoint: fx.actionEndpoint });

  // A published App can't be confirmed, and its read has no such section.
  await db.update(oauthClients).set({ appType: "third_party_global" }).where(eq(oauthClients.id, fx.client.id));
  const published = await call(app.baseUrl, fx, "PUT", fx.headers, { action_endpoint: fx.actionEndpoint });
  assert.equal(published.status, 409); assert.equal(published.body.code, "OWN_SERVER_ACTIONS_NOT_SERVER_LOCAL");
  assert.equal((await call(app.baseUrl, fx, "GET", fx.headers)).body.own_server_actions, null);
  // The CHECK: an endpoint without a time (or the reverse) is refused.
  await assert.rejects(db.update(oauthAppLinkPreviews).set({ ownServerActionEndpoint: fx.actionEndpoint }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id)),
    (error: unknown) => JSON.stringify(error, Object.getOwnPropertyNames(error)).includes("oauth_app_link_previews_own_server_actions"));
});

test("execute: an App that is not official calls its endpoint only with its own-Server actions in force; withdrawn while execute waits, it is refused under the lock", async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const actionCalls = () => calls.filter((c) => c.url === fx.actionEndpoint).length;

  const unconfirmed = await execute(app.baseUrl, fx, ownHandle(fx));
  assert.equal(unconfirmed.status, 410); assert.equal(unconfirmed.body.code, "PROVIDER_NOT_ELIGIBLE");
  assert.equal(actionCalls(), 0);

  await confirmInDb(db, fx);
  const accepted = await execute(app.baseUrl, fx, ownHandle(fx));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body)); assert.equal(accepted.body.state, "accepted");
  assert.equal(actionCalls(), 1);

  // Withdrawn after the live check, before the transaction: refused under the registration row's lock; nothing written, nothing sent.
  const operations = (await db.select().from(linkCardOperations)).length;
  __setLinkCardActionHooksForTests({ beforeAdmission: async () => { await withdrawInDb(db, fx); } });
  const late = await execute(app.baseUrl, fx, ownHandle(fx));
  assert.equal(late.status, 410); assert.equal(late.body.code, "PROVIDER_NOT_ELIGIBLE");
  assert.equal((await db.select().from(linkCardOperations)).length, operations);
  assert.equal(actionCalls(), 1);
  __setLinkCardActionHooksForTests(null);

  // Confirmed again, but no longer server_local, or confirmed for another endpoint: refused before any call.
  await confirmInDb(db, fx);
  await db.update(oauthClients).set({ appType: "third_party_global" }).where(eq(oauthClients.id, fx.client.id));
  assert.equal((await execute(app.baseUrl, fx, ownHandle(fx))).status, 410);
  await db.update(oauthClients).set({ appType: "server_local" }).where(eq(oauthClients.id, fx.client.id));
  await db.update(oauthAppLinkPreviews).set({ ownServerActionEndpoint: `${fx.actionEndpoint}-old` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.equal((await execute(app.baseUrl, fx, ownHandle(fx))).status, 410);
  assert.equal(actionCalls(), 1);
});

test("unreviewed_app.v1: an own-Server App's execute and prepare refuse a handle that doesn't carry it (410), and call nothing; an official App's don't need it", async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  await confirmInDb(db, fx);
  const without = await execute(app.baseUrl, fx, handleFor(fx).handle);
  assert.equal(without.status, 410); assert.equal(without.body.code, "HANDLE_INVALID");
  const prepare = await post(app.baseUrl, "prepare", fx, { handle: handleFor(fx, { requiresPrepare: true }).handle, claimed: { business_revision: "br-1" } });
  assert.equal(prepare.status, 410);
  assert.equal(calls.filter((c) => c.url === fx.actionEndpoint).length, 0);
  assert.equal((await execute(app.baseUrl, fx, ownHandle(fx))).body.state, "accepted");
  // Official again: its handles never needed the capability.
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.equal((await execute(app.baseUrl, fx, handleFor(fx).handle)).body.state, "accepted");
});

test("another Server: its viewers get no execute from a server_local App, even with the confirmation in force on the App's own Server", async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  await confirmInDb(db, fx);
  // The same person, on a second Server where the App is installed and they consented, reading the same link.
  const other = await seed.server({ owner: fx.owner });
  const channel = await seed.channel({ server: other, members: [fx.owner] });
  const message = await seed.message({ channel, author: fx.owner, content: fx.content });
  const [install] = await db.insert(oauthClientInstalls).values({ clientId: fx.client.id, serverId: other.id, installedByUserId: fx.owner.id }).returning();
  await db.insert(oauthUserConsents).values({ serverId: other.id, userId: fx.owner.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  const handle = ownHandle(fx, { serverId: other.id, installationKey: install!.id, messageId: message.id });
  const res = await execute(app.baseUrl, { headers: { ...fx.headers, "X-Server-Id": other.id } }, handle);
  assert.equal(res.status, 410, JSON.stringify(res.body)); assert.equal(res.body.code, "PROVIDER_NOT_ELIGIBLE");
  assert.equal(calls.filter((c) => c.url === fx.actionEndpoint).length, 0);
  // Its own Server, same link: accepted.
  assert.equal((await execute(app.baseUrl, fx, ownHandle(fx))).body.state, "accepted");
});

test(`limits: an App acting under its own-Server confirmation gets ${LINK_CARD_EXECUTE_PER_APP_PER_MINUTE} executes per viewer per Server per App per minute; the next is 429 and calls nothing; official Apps keep only the per-Server budget`, async ({ app, db, seed }) => {
  const fx = await ownApp(db, seed);
  await confirmInDb(db, fx);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  for (let i = 0; i < LINK_CARD_EXECUTE_PER_APP_PER_MINUTE; i++) {
    const res = await execute(app.baseUrl, fx, ownHandle(fx));
    assert.equal(res.status, 200, `execute ${i + 1}: ${JSON.stringify(res.body)}`);
  }
  const over = await execute(app.baseUrl, fx, ownHandle(fx));
  assert.equal(over.status, 429); assert.equal(over.body.code, "RATE_LIMITED");
  assert.equal(calls.filter((c) => c.url === fx.actionEndpoint).length, LINK_CARD_EXECUTE_PER_APP_PER_MINUTE);
  assert.equal((await admitLinkCardAppExecute(fx.owner.id, fx.server.id, "another-app")).admitted, true, "another App's budget is its own");

  // Official again: past the per-App count, still admitted.
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  await withdrawInDb(db, fx);
  assert.equal((await execute(app.baseUrl, fx, handleFor(fx).handle)).body.state, "accepted");
});
