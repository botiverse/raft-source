import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { afterEach, test as unitTest } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import { decideActionEndpointReview, decidePublishReview } from "../test/marketplaceReviewFixture";
import { createOAuthClient } from "../services/oauthService";
import { integrationAuditEvents, oauthAppLinkPreviews, oauthClients } from "../db/schema";
import { __setPreviewHttpForTests, nextActionEndpointState } from "../services/appLinkPreviewService";

// RFC 076 §4: an action endpoint rides on the link-preview registration. For a
// published App, adding or changing it waits for marketplace review (decided
// in App Admin) while the approved one stays in force; removing it applies at
// once.
const test = createApiTest();
afterEach(() => { __setPreviewHttpForTests(null); });

const origin = "https://cards.example.test";
const base = { origin, endpoint: `${origin}/preview`, paths: ["/requests"] };

unitTest("action endpoint state: review only for published Apps, removal and origin changes apply at once", () => {
  const live = `${origin}/actions`;
  const next = `${origin}/actions-v2`;
  assert.deepEqual(nextActionEndpointState({ origin, requested: next, live, pending: null, reviewed: true }), { live, pending: next, requestedReview: true });
  assert.deepEqual(nextActionEndpointState({ origin, requested: next, live, pending: next, reviewed: true }), { live, pending: next, requestedReview: false });
  assert.deepEqual(nextActionEndpointState({ origin, requested: next, live, pending: null, reviewed: false }), { live: next, pending: null, requestedReview: false });
  assert.deepEqual(nextActionEndpointState({ origin, requested: live, live, pending: next, reviewed: true }), { live, pending: null, requestedReview: false });
  assert.deepEqual(nextActionEndpointState({ origin, requested: null, live, pending: next, reviewed: true }), { live: null, pending: null, requestedReview: false });
  assert.deepEqual(nextActionEndpointState({ origin: "https://moved.example.test", requested: "https://moved.example.test/a", live, pending: next, reviewed: true }),
    { live: null, pending: "https://moved.example.test/a", requestedReview: true });
});

test("a published App's action endpoint waits for review; approval in App Admin puts it in force under a new revision", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const reviewer = await seed.human();
  const outsider = await seed.human();
  const server = await seed.server({ owner, members: [outsider] });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "cards-fixture", name: "Cards" });
  await db.update(oauthClients).set({ appType: "third_party_global", publishStatus: "published" }).where(eq(oauthClients.id, client.id));
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const put = (body: unknown) => fetch(`${app.baseUrl}/api/oauth/link-preview`, {
    method: "PUT",
    headers: { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const row = async () => (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)))[0]!;
  const asUser = async (user: { id: string; email: string }) => ({
    Authorization: `Bearer ${await tokenForHuman(user.email)}`, "X-Server-Id": server.id, "Content-Type": "application/json",
  });
  const state = async (user: { id: string; email: string }) => fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/action-endpoint`, { headers: await asUser(user) });
  // App Admin decides card URL reviews; Raft has no review route (#proj-apps task #19).
  const review = (decision: "approve" | "reject", expectedActionEndpoint: string, reason?: string) =>
    decideActionEndpointReview({ clientId: client.id, reviewerUserId: reviewer.id, decision, expectedActionEndpoint, reason });

  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions` })).status, 200);
  let current = await row();
  assert.equal(current.actionEndpoint, null, "not in force before review");
  assert.equal(current.pendingActionEndpoint, `${origin}/actions`);
  const requested = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "app.action_endpoint_requested"));
  assert.equal(requested.length, 1);

  const shown = await state(owner);
  assert.equal(shown.status, 200, "the App's own Server admin reads it");
  assert.deepEqual({ ...(await shown.json()), requested_at: "x" }, {
    origin, action_endpoint: null, pending_action_endpoint: `${origin}/actions`, requested_at: "x", reject_reason: null,
    own_server_actions: null, // a published App (RFC 076 §17 is for server_local ones)
  });
  assert.equal((await state(outsider)).status, 404, "a member who is not the App's admin");
  const reviewRoute = await fetch(`${app.baseUrl}/api/integrations/clients/${client.id}/action-endpoint/review`, {
    method: "POST", headers: await asUser(owner), body: JSON.stringify({ decision: "approve", expected_action_endpoint: `${origin}/actions` }),
  });
  assert.equal(reviewRoute.status, 404, "no review route in Raft");
  assert.equal((await row()).pendingActionEndpoint, `${origin}/actions`);
  // An identical re-PUT keeps the request time and does not ask again.
  const requestedAt = (await row()).pendingActionEndpointRequestedAt;
  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions` })).status, 200);
  assert.deepEqual((await row()).pendingActionEndpointRequestedAt, requestedAt);
  assert.equal((await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "app.action_endpoint_requested"))).length, 1);

  const revisionBefore = (await row()).revision;
  await review("approve", `${origin}/actions`);
  current = await row();
  assert.equal(current.actionEndpoint, `${origin}/actions`);
  assert.equal(current.pendingActionEndpoint, null);
  assert.notEqual(current.revision, revisionBefore, "approval voids outstanding handles");

  // A change waits again while the approved endpoint stays in force; a rejection leaves a reason the developer reads.
  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions-v2` })).status, 200);
  current = await row();
  assert.equal(current.actionEndpoint, `${origin}/actions`);
  assert.equal(current.pendingActionEndpoint, `${origin}/actions-v2`);
  const revisionBeforeReject = (await row()).revision;
  await review("reject", `${origin}/actions-v2`, "Same path with a version suffix only");
  current = await row();
  assert.equal(current.revision, revisionBeforeReject, "a rejection changes nothing in force");
  assert.equal(current.actionEndpoint, `${origin}/actions`);
  assert.equal(current.pendingActionEndpoint, null);
  assert.equal(current.actionEndpointRejectReason, "Same path with a version suffix only");
  const afterReject = await state(owner);
  assert.equal(afterReject.status, 200);
  assert.equal((await afterReject.json()).reject_reason, "Same path with a version suffix only");
  // A new request clears the earlier rejection.
  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions-v3` })).status, 200);
  current = await row();
  assert.equal(current.actionEndpointRejectReason, null);
  assert.equal(current.pendingActionEndpoint, `${origin}/actions-v3`);
  // Moving the origin drops what was in force; the new endpoint waits for review.
  const moved = "https://moved.example.test";
  assert.equal((await put({ origin: moved, endpoint: `${moved}/preview`, paths: ["/requests"], action_endpoint: `${moved}/actions` })).status, 200);
  current = await row();
  assert.equal(current.actionEndpoint, null);
  assert.equal(current.pendingActionEndpoint, `${moved}/actions`);
  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions` })).status, 200, "back to the first origin");
  current = await row();
  assert.equal(current.actionEndpoint, null, "an endpoint approved before the move needs review again");

  // Removing it applies at once, no review.
  await review("approve", `${origin}/actions`);
  assert.equal((await row()).actionEndpoint, `${origin}/actions`);
  assert.equal((await put(base)).status, 200);
  current = await row();
  assert.equal(current.actionEndpoint, null);
  assert.equal(current.pendingActionEndpoint, null);
  const reviewed = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "app.action_endpoint_reviewed"));
  assert.deepEqual(reviewed.map((event) => (event.metadata as { decision: string }).decision).sort(), ["approve", "approve", "reject"]);
});

test("an unpublished App's action endpoint applies at once and must stay on the registered origin", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "cards-private", name: "Cards private" });
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const put = (body: unknown) => fetch(`${app.baseUrl}/api/oauth/link-preview`, {
    method: "PUT",
    headers: { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const [{ publishStatus }] = await db.select({ publishStatus: oauthClients.publishStatus }).from(oauthClients).where(eq(oauthClients.id, client.id));
  assert.notEqual(publishStatus, "published");
  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions` })).status, 200);
  const [saved] = await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id));
  assert.equal(saved!.actionEndpoint, `${origin}/actions`);
  assert.equal(saved!.pendingActionEndpoint, null);
  assert.equal((await put({ ...base, action_endpoint: "https://elsewhere.example.test/actions" })).status, 400);
  const read = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { headers: { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64") } });
  assert.equal((await read.json()).registration.actionEndpoint, `${origin}/actions`);
});

test("an endpoint set before publishing stops being in force at publish approval and waits for review", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const publishReviewer = await seed.human();
  const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "cards-prepublish", name: "Cards prepublish" });
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const put = (body: unknown) => fetch(`${app.baseUrl}/api/oauth/link-preview`, {
    method: "PUT",
    headers: { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal((await put({ ...base, action_endpoint: `${origin}/actions` })).status, 200);
  const row = async () => (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)))[0]!;
  assert.equal((await row()).actionEndpoint, `${origin}/actions`, "unpublished: in force at once");

  await db.update(oauthClients).set({ appType: "third_party_global", publishStatus: "in_review", description: "Cards that ask a person to confirm." })
    .where(eq(oauthClients.id, client.id));
  const revisionBefore = (await row()).revision;
  assert.ok(await decidePublishReview({ reviewerUserId: publishReviewer.id, clientId: client.id, decision: "approve" }));
  const after = await row();
  assert.equal(after.actionEndpoint, null, "never reviewed, so not in force once published");
  assert.equal(after.pendingActionEndpoint, `${origin}/actions`);
  assert.ok(after.pendingActionEndpointRequestedAt);
  assert.notEqual(after.revision, revisionBefore, "outstanding handles are void");
  const requested = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "app.action_endpoint_requested"));
  assert.equal(requested.length, 1);
});

test("a repeat registration is harmless: only a change in force moves the revision (Tenny 2108c37c)", async ({ app, db, seed }) => {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "cards-repeat", name: "Cards" });
  __setPreviewHttpForTests(async () => ({ client_id: client.clientId }));
  const headers = { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" };
  const put = async (body: unknown) => {
    const response = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: "PUT", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return (await response.json()).registration as { revision: string };
  };
  const row = async () => (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)))[0]!;
  const audits = async () => (await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.clientId, client.id))).length;
  const config = { ...base, paths: ["/requests", "/grants"], action_endpoint: `${origin}/actions` };

  const first = await put(config);
  const stored = await row();
  const auditCount = await audits();
  assert.equal((await put(config)).revision, first.revision, "the same registration keeps the revision");
  assert.equal((await row()).updatedAt.getTime(), stored.updatedAt.getTime(), "and writes nothing");
  assert.equal(await audits(), auditCount, "nor audits a change that did not happen");
  assert.equal((await put({ ...config, paths: ["/grants", "/requests"] })).revision, first.revision, "path order is not a change, so nothing is written");
  // Endpoints are compared and stored in their WHATWG form (new URL(x).href).
  const port443 = (url: string) => url.replace(origin, `${origin}:443`);
  const samePort = await put({ ...config, endpoint: port443(base.endpoint), action_endpoint: port443(config.action_endpoint) });
  assert.equal(samePort.revision, first.revision, "an explicit :443 is the same registration");
  assert.deepEqual([(await row()).endpoint, (await row()).actionEndpoint], [base.endpoint, config.action_endpoint], "stored canonical");
  assert.equal((await row()).updatedAt.getTime(), stored.updatedAt.getTime(), "and nothing is written");

  const paths = await put({ ...config, paths: ["/requests"] });
  assert.notEqual(paths.revision, first.revision, "a paths change is in force");
  const endpoint = await put({ ...config, paths: ["/requests"], endpoint: `${origin}/preview-v2` });
  assert.notEqual(endpoint.revision, paths.revision);
  const action = await put({ ...config, paths: ["/requests"], endpoint: `${origin}/preview-v2`, action_endpoint: `${origin}/actions-v2` });
  assert.notEqual(action.revision, endpoint.revision, "unpublished: a new action endpoint is in force at once");

  // Published: a requested endpoint waits for review and is not in force, so it moves nothing.
  await db.update(oauthClients).set({ appType: "third_party_global", publishStatus: "published" }).where(eq(oauthClients.id, client.id));
  const pending = await put({ ...config, paths: ["/requests"], endpoint: `${origin}/preview-v2`, action_endpoint: `${origin}/actions-v3` });
  assert.equal(pending.revision, action.revision, "a pending endpoint is not in force");
  assert.equal((await row()).pendingActionEndpoint, `${origin}/actions-v3`);
  assert.equal(await audits(), auditCount + 5, "the pending request is still recorded (updated + requested)");

  // Removal applies at once, and re-registering after a delete is a new identity.
  const removed = await put({ ...config, paths: ["/requests"], endpoint: `${origin}/preview-v2`, action_endpoint: null });
  assert.notEqual(removed.revision, action.revision);
  const deleted = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: "DELETE", headers });
  assert.ok(deleted.ok);
  const again = await put({ ...config, paths: ["/requests"], endpoint: `${origin}/preview-v2`, action_endpoint: null });
  assert.notEqual(again.revision, removed.revision, "delete then register is a new revision");

  // A URL stored before canonicalization is rewritten, keeping the revision.
  await db.update(oauthAppLinkPreviews).set({ endpoint: `${origin}:443/preview-v2` }).where(eq(oauthAppLinkPreviews.clientId, client.id));
  const canonical = await put({ ...config, paths: ["/requests"], endpoint: `${origin}/preview-v2`, action_endpoint: null });
  assert.equal(canonical.revision, again.revision);
  assert.equal((await row()).endpoint, `${origin}/preview-v2`);
});
