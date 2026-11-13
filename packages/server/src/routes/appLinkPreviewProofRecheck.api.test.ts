import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import type { createSeed } from "../test/integration/seed";
import type { Database as Db } from "../db";
import { tokenForHuman } from "../test/integration/credentials";
import { createOAuthClient } from "../services/oauthService";
import { integrationAuditEvents, oauthAppLinkPreviews, oauthClientInstalls, oauthUserConsents } from "../db/schema";
import {
  __setPreviewHttpForTests,
  __settleAppLinkPreviewRechecksForTests,
  LINK_PREVIEW_PROOF_HARD_TTL_MS,
  LINK_PREVIEW_PROOF_RETRY_MS,
  LINK_PREVIEW_PROOF_SOFT_TTL_MS,
  recheckAppLinkPreview,
  resumeAppLinkPreview,
  suspendAppLinkPreview,
} from "../services/appLinkPreviewService";
import { startAppLinkPreviewRecheckWorker } from "../services/appLinkPreviewRecheckWorker";

// An App's domain proof is rechecked, not trusted forever. A stale
// registration is rechecked in the background when used (and by the sweep);
// another App's client_id stops it at once, an unreachable proof stops it after
// HARD_TTL, a later proof resumes it, and another App proving the origin takes
// it over. Suspension moves the revision; consent is untouched.
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(async () => {
  await __settleAppLinkPreviewRechecksForTests();
  __setPreviewHttpForTests(null);
  if (originalKey === undefined) delete process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY; else process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = originalKey;
});

const card = { version: 1, title: "Private PR", card: { root: "status", elements: { status: { type: "Badge", props: { text: "Approved" } } } } };
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);
type Seed = ReturnType<typeof createSeed>;

/** A connected viewer, a message linking the App's origin, and the App's registration with the given proof times. */
async function connectedApp(db: Db, seed: Seed, key: string, origin: string, proof: { verifiedAt: Date; lastCheckedAt?: Date | null }) {
  const owner = await seed.human(); const server = await seed.server({ owner }); const channel = await seed.channel({ server, members: [owner] });
  const message = await seed.message({ channel, author: owner, content: `See ${origin}/pr/1` });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: key, name: key });
  await db.insert(oauthClientInstalls).values({ clientId: client.id, serverId: server.id, installedByUserId: owner.id }).onConflictDoNothing();
  await db.insert(oauthUserConsents).values({ serverId: server.id, userId: owner.id, clientId: client.id, scopes: ["openid", "profile"] });
  await db.insert(oauthAppLinkPreviews).values({ clientId: client.id, origin, endpoint: `${origin}/callback`, paths: ["/pr"], verifiedAt: proof.verifiedAt, lastCheckedAt: proof.lastCheckedAt ?? null });
  const headers = { Authorization: `Bearer ${await tokenForHuman(owner.email)}`, "X-Server-Id": server.id };
  const basic = { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" };
  return { owner, server, message, client, headers, basic };
}

async function row(db: Db, clientId: string) {
  return (await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, clientId)))[0];
}

async function linkPreviewAudits(db: Db, clientId: string) {
  return (await db.select().from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, clientId), eq(integrationAuditEvents.eventType, "app.updated")))
    .orderBy(integrationAuditEvents.createdAt)).map((event) => ({ metadata: event.metadata as Record<string, unknown>, correlationId: event.correlationId }));
}

test("a stale holder whose proof now names another App is suspended at once: revision moves, audit written, no further callbacks", async ({ app, db, seed }) => {
  const origin = "https://mismatch.example.test";
  const fx = await connectedApp(db, seed, "recheck-mismatch", origin, { verifiedAt: hoursAgo(25), lastCheckedAt: hoursAgo(25) });
  const before = (await row(db, fx.client.id))!;
  let proofs = 0; let callbacks = 0;
  __setPreviewHttpForTests(async (_url, body) => {
    if (!body) { proofs++; return { client_id: "the-domains-new-owner" }; }
    callbacks++; return card;
  });
  const read = async () => (await (await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/app-link-previews`, { headers: fx.headers })).json()).previews;
  await read(); // Within HARD_TTL: this view may still be served; it starts the recheck.
  await __settleAppLinkPreviewRechecksForTests();
  assert.equal(proofs, 1);
  const after = (await row(db, fx.client.id))!;
  assert.ok(after.suspendedAt);
  assert.equal(after.suspendedReason, "proof_mismatch");
  assert.notEqual(after.revision, before.revision);
  assert.deepEqual(after.verifiedAt, before.verifiedAt, "a failed proof never refreshes verified_at");
  assert.deepEqual((await linkPreviewAudits(db, fx.client.id)).map((a) => a.metadata),
    [{ changedFields: ["linkPreview"], clientKey: "recheck-mismatch", linkPreview: "suspended", reason: "proof_mismatch" }]);
  // Consent is untouched; the suspension alone stops callbacks.
  assert.equal((await db.select().from(oauthUserConsents).where(eq(oauthUserConsents.clientId, fx.client.id)))[0]!.revokedAt, null);
  const callbacksBefore = callbacks;
  assert.deepEqual(await read(), []);
  await __settleAppLinkPreviewRechecksForTests();
  assert.equal(callbacks, callbacksBefore, "no assertion is sent to a suspended registration");
  assert.equal(proofs, 1, "a suspended registration is not rechecked from the read path");
});

test("an unavailable proof keeps serving until HARD_TTL, sends nothing past it even before the suspension is written, then suspends", async ({ app, db, seed }) => {
  const origin = "https://unavailable.example.test";
  const fx = await connectedApp(db, seed, "recheck-unavailable", origin, { verifiedAt: hoursAgo(25), lastCheckedAt: hoursAgo(25) });
  let proofs = 0; let callbacks = 0;
  __setPreviewHttpForTests(async (_url, body) => {
    if (!body) { proofs++; throw new Error("Preview timeout"); }
    callbacks++; return card;
  });
  const read = async () => (await (await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/app-link-previews`, { headers: fx.headers })).json()).previews.length;
  assert.equal(await read(), 1);
  await __settleAppLinkPreviewRechecksForTests();
  let current = (await row(db, fx.client.id))!;
  assert.equal(proofs, 1); assert.equal(current.suspendedAt, null);
  assert.ok(current.lastCheckedAt!.getTime() > hoursAgo(1).getTime(), "the attempt is recorded");
  assert.ok(current.verifiedAt.getTime() < hoursAgo(24).getTime(), "verified_at is left alone");
  assert.equal(await read(), 1, "still within HARD_TTL");
  await __settleAppLinkPreviewRechecksForTests();
  assert.equal(proofs, 1, "RETRY spaces the attempts");

  // Past HARD_TTL, while the last attempt is within RETRY so no recheck can
  // write the suspension yet: no assertion is sent anyway.
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date(Date.now() - LINK_PREVIEW_PROOF_HARD_TTL_MS - 60_000) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const served = callbacks;
  assert.equal(await read(), 0);
  await __settleAppLinkPreviewRechecksForTests();
  assert.equal(callbacks, served);
  assert.equal((await row(db, fx.client.id))!.suspendedAt, null);

  await db.update(oauthAppLinkPreviews).set({ lastCheckedAt: new Date(Date.now() - LINK_PREVIEW_PROOF_RETRY_MS - 60_000) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.equal(await read(), 0);
  await __settleAppLinkPreviewRechecksForTests();
  current = (await row(db, fx.client.id))!;
  assert.equal(proofs, 2); assert.equal(callbacks, served);
  assert.equal(current.suspendedReason, "proof_unavailable");
  assert.equal((await linkPreviewAudits(db, fx.client.id)).at(-1)!.metadata.reason, "proof_unavailable");
});

test("a proof that matches again resumes a suspended registration under a new revision; suspend and resume are no-ops without a change", async ({ app, db, seed }) => {
  const origin = "https://resume.example.test";
  const fx = await connectedApp(db, seed, "recheck-resume", origin, { verifiedAt: hoursAgo(1), lastCheckedAt: new Date(Date.now() - 60_000) });
  const initial = (await row(db, fx.client.id))!;
  // No change, nothing written.
  assert.equal(await resumeAppLinkPreview(fx.client.id), false);
  assert.equal((await row(db, fx.client.id))!.revision, initial.revision);
  assert.deepEqual(await linkPreviewAudits(db, fx.client.id), []);
  assert.equal(await suspendAppLinkPreview(fx.client.id, "proof_unavailable"), true);
  const suspended = (await row(db, fx.client.id))!;
  assert.notEqual(suspended.revision, initial.revision);
  assert.ok(suspended.updatedAt.getTime() > initial.updatedAt.getTime(), "a suspension updates the registration's updated_at");
  assert.equal(await suspendAppLinkPreview(fx.client.id, "proof_mismatch"), false);
  assert.equal(await suspendAppLinkPreview(fx.client.id, "proof_unavailable"), false);
  const still = (await row(db, fx.client.id))!;
  assert.equal(still.revision, suspended.revision); assert.equal(still.suspendedReason, "proof_unavailable");
  assert.equal((await linkPreviewAudits(db, fx.client.id)).length, 1);

  let callbacks = 0;
  __setPreviewHttpForTests(async (_url, body) => { if (!body) return { client_id: "recheck-resume" }; callbacks++; return card; });
  const read = async () => (await (await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/app-link-previews`, { headers: fx.headers })).json()).previews.length;
  assert.equal(await read(), 0); assert.equal(callbacks, 0);
  assert.equal(await recheckAppLinkPreview(fx.client.id), null, "attempted within RETRY: not claimed");
  await db.update(oauthAppLinkPreviews).set({ lastCheckedAt: hoursAgo(1) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual(await recheckAppLinkPreview(fx.client.id), { proof: "match", suspensionChanged: true });
  const resumed = (await row(db, fx.client.id))!;
  assert.equal(resumed.suspendedAt, null); assert.equal(resumed.suspendedReason, null);
  assert.notEqual(resumed.revision, suspended.revision);
  assert.ok(resumed.updatedAt.getTime() > suspended.updatedAt.getTime(), "so does a resume");
  assert.ok(resumed.verifiedAt.getTime() > hoursAgo(0.1).getTime());
  assert.deepEqual((await linkPreviewAudits(db, fx.client.id)).map((a) => a.metadata.linkPreview), ["suspended", "resumed"]);
  assert.equal(await resumeAppLinkPreview(fx.client.id), false);
  assert.equal((await row(db, fx.client.id))!.revision, resumed.revision);
  assert.equal(await read(), 1); assert.equal(callbacks, 1);
});

test("concurrent rechecks of one registration claim it once and fetch the proof once", async ({ db, seed }) => {
  const origin = "https://claim.example.test";
  const fx = await connectedApp(db, seed, "recheck-claim", origin, { verifiedAt: hoursAgo(30), lastCheckedAt: null });
  let proofs = 0; let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  __setPreviewHttpForTests(async () => { proofs++; await gate; return { client_id: "recheck-claim" }; });
  const checks = [recheckAppLinkPreview(fx.client.id), recheckAppLinkPreview(fx.client.id), recheckAppLinkPreview(fx.client.id)];
  // Let every claim land before the winner's fetch completes.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const results = await Promise.all(checks);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(proofs, 1);
  assert.ok((await row(db, fx.client.id))!.verifiedAt.getTime() > hoursAgo(0.1).getTime());
});

test("another App proving the origin takes it over: the holder's registration is deleted and both Apps are audited", async ({ app, db, seed }) => {
  const origin = "https://takeover.example.test";
  const registration = { origin, endpoint: `${origin}/callback`, paths: ["/pr"] };
  const holder = await connectedApp(db, seed, "takeover-holder", origin, { verifiedAt: hoursAgo(2), lastCheckedAt: hoursAgo(2) });
  const owner = await seed.human(); const server = await seed.server({ owner });
  const next = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "takeover-next", name: "Next owner" });
  const nextBasic = { Authorization: "Basic " + Buffer.from(`${next.client.clientId}:${next.clientSecret}`).toString("base64"), "Content-Type": "application/json" };
  const endpoint = `${app.baseUrl}/api/oauth/link-preview`;
  let callbacks = 0;
  __setPreviewHttpForTests(async (_url, body) => { if (!body) return { client_id: "takeover-next" }; callbacks++; return card; });
  const put = await fetch(endpoint, { method: "PUT", headers: nextBasic, body: JSON.stringify(registration) });
  assert.equal(put.status, 200, await put.clone().text());
  assert.equal((await put.json()).registration.clientId, next.client.id);
  assert.deepEqual(await (await fetch(endpoint, { headers: holder.basic })).json(), { registration: null });
  assert.equal((await (await fetch(endpoint, { headers: nextBasic })).json()).registration.origin, origin);
  const rows = await db.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.origin, origin));
  assert.deepEqual(rows.map((r) => r.clientId), [next.client.id]);
  const [lost] = await linkPreviewAudits(db, holder.client.id);
  const [won] = await linkPreviewAudits(db, next.client.id);
  assert.deepEqual(lost!.metadata, { changedFields: ["linkPreview"], clientKey: "takeover-holder", linkPreview: "taken_over" });
  assert.deepEqual(won!.metadata, { changedFields: ["linkPreview"], clientKey: "takeover-next", takeover: true });
  assert.ok(lost!.correlationId); assert.equal(lost!.correlationId, won!.correlationId);
  // The former holder's viewers get no callbacks for the origin.
  assert.deepEqual((await (await fetch(`${app.baseUrl}/api/messages/${holder.message.id}/app-link-previews`, { headers: holder.headers })).json()).previews, []);
  assert.equal(callbacks, 0);
  // The former holder cannot take it back without the proof naming it.
  assert.equal((await fetch(endpoint, { method: "PUT", headers: holder.basic, body: JSON.stringify(registration) })).status, 400);
});

test("a repeat registration refreshes the proof time without moving the revision; on a suspended registration it resumes under a new one", async ({ app, db, seed }) => {
  const origin = "https://repeat.example.test";
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "repeat-put", name: "Repeat" });
  const headers = { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" };
  const put = () => fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: "PUT", headers, body: JSON.stringify({ origin, endpoint: `${origin}/callback`, paths: ["/pr"] }) });
  __setPreviewHttpForTests(async () => ({ client_id: "repeat-put" }));
  assert.equal((await put()).status, 200);
  const first = (await row(db, client.id))!;
  assert.ok(first.lastCheckedAt); assert.equal(first.verifiedAt.getTime(), first.lastCheckedAt.getTime());
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: hoursAgo(30), lastCheckedAt: hoursAgo(30) }).where(eq(oauthAppLinkPreviews.clientId, client.id));
  assert.equal((await put()).status, 200);
  const repeated = (await row(db, client.id))!;
  assert.equal(repeated.revision, first.revision);
  assert.ok(repeated.verifiedAt.getTime() > hoursAgo(0.1).getTime()); assert.ok(repeated.lastCheckedAt!.getTime() > hoursAgo(0.1).getTime());
  assert.deepEqual(repeated.updatedAt, first.updatedAt);
  assert.equal((await linkPreviewAudits(db, client.id)).length, 1, "only the first registration is audited");

  assert.equal(await suspendAppLinkPreview(client.id, "proof_mismatch"), true);
  const suspended = (await row(db, client.id))!;
  assert.equal((await put()).status, 200);
  const resumed = (await row(db, client.id))!;
  assert.equal(resumed.suspendedAt, null); assert.equal(resumed.suspendedReason, null);
  assert.notEqual(resumed.revision, suspended.revision);
  assert.deepEqual((await linkPreviewAudits(db, client.id)).map((a) => a.metadata.linkPreview), [undefined, "suspended", "resumed"]);
});

test("the sweep rechecks a bounded batch of due registrations: stale active ones and suspended ones, not fresh or recently attempted ones", async ({ db, seed }) => {
  const stale = await connectedApp(db, seed, "sweep-stale", "https://sweep-stale.example.test", { verifiedAt: new Date(Date.now() - LINK_PREVIEW_PROOF_SOFT_TTL_MS - 60_000), lastCheckedAt: hoursAgo(25) });
  const suspended = await connectedApp(db, seed, "sweep-suspended", "https://sweep-suspended.example.test", { verifiedAt: hoursAgo(80), lastCheckedAt: hoursAgo(1) });
  await suspendAppLinkPreview(suspended.client.id, "proof_unavailable");
  const mismatched = await connectedApp(db, seed, "sweep-mismatch", "https://sweep-mismatch.example.test", { verifiedAt: hoursAgo(26), lastCheckedAt: null });
  await connectedApp(db, seed, "sweep-fresh", "https://sweep-fresh.example.test", { verifiedAt: hoursAgo(2), lastCheckedAt: null });
  await connectedApp(db, seed, "sweep-attempted", "https://sweep-attempted.example.test", { verifiedAt: hoursAgo(30), lastCheckedAt: new Date(Date.now() - 60_000) });
  const owners: Record<string, string> = {
    "sweep-stale.example.test": "sweep-stale", "sweep-suspended.example.test": "sweep-suspended", "sweep-mismatch.example.test": "someone-else",
    "sweep-fresh.example.test": "sweep-fresh", "sweep-attempted.example.test": "sweep-attempted",
  };
  const fetched: string[] = [];
  __setPreviewHttpForTests(async (url) => { const host = new URL(url).hostname; fetched.push(host); return { client_id: owners[host] }; });
  const worker = startAppLinkPreviewRecheckWorker({ intervalMs: 3600_000, batchSize: 2 });
  try {
    await worker.tick();
    assert.equal(fetched.length, 2, "bounded by the batch size");
    await worker.tick();
    await worker.tick();
  } finally {
    worker.stop();
  }
  assert.deepEqual(fetched.sort(), ["sweep-mismatch.example.test", "sweep-stale.example.test", "sweep-suspended.example.test"]);
  assert.ok((await row(db, stale.client.id))!.verifiedAt.getTime() > hoursAgo(0.1).getTime());
  assert.equal((await row(db, suspended.client.id))!.suspendedAt, null, "a suspension for an unavailable proof lifts once it proves again");
  assert.equal((await row(db, mismatched.client.id))!.suspendedReason, "proof_mismatch");
});

test("a registration whose proof can't be fetched is a 400 that says so, and changes nothing", async ({ app, db, seed }) => {
  const origin = "https://unreachable.example.test";
  const owner = await seed.human(); const server = await seed.server({ owner });
  const { client, clientSecret } = await createOAuthClient({ serverId: server.id, createdByUserId: owner.id, clientId: "unreachable-put", name: "Unreachable" });
  const headers = { Authorization: "Basic " + Buffer.from(`${client.clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/json" };
  __setPreviewHttpForTests(async () => { throw new Error("Preview host unavailable"); });
  const put = await fetch(`${app.baseUrl}/api/oauth/link-preview`, { method: "PUT", headers, body: JSON.stringify({ origin, endpoint: `${origin}/callback`, paths: ["/pr"] }) });
  assert.equal(put.status, 400);
  assert.match(await put.text(), /could not be fetched/);
  assert.equal(await row(db, client.id), undefined);
});
