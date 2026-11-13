import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { Database, DatabaseExecutor } from "../db";
import {
  integrationAuditEvents, linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardOperations, linkCardUpdateTokens, linkCardViews,
  messages, oauthAppLinkPreviews, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, officialAppRegistry,
} from "../db/schema";
import { linkCardOpenOperations } from "../metrics";
import { addHuman, removeHuman } from "../services/channelService";
import { addMember } from "../services/serverService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { PreviewNotSentError } from "../services/appLinkPreviewHttp";
import { __resetLinkCardActionLimitsForTests, admitLinkCardAction, LINK_CARD_EXECUTE_PER_MINUTE, LINK_CARD_RECOVERY_PER_MINUTE } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests, LINK_CARD_STATE_HINTS, linkCardRequestSha256 } from "../services/linkCardActionService";
import { __observeLinkCardLiveStateForTests } from "../services/linkCardLiveState";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { sweepLinkCardFirstSendDeadlines } from "../services/linkCardSweeps";
import { linkCardActionEndpointSha256, linkCardExecuteJti, linkCardUrlSha256, nativeInstallationKey } from "../services/linkCardTokens";
import { oidcIssuer } from "../services/oidcService";
import {
  ALL_CAPABILITIES, appAnswer, barrier, cardFixture, clientRequestId, handleFor, insertOperations, post, stubApp, type CardFixture,
} from "../test/linkCardActionFixture";
import { seedBoundGuest } from "../test/guestFixture";

// POST /api/link-cards/execute (RFC 076 §6.3; protocol v3.2.3 §5.3.2-§5.3.4):
// recovery first, the new-intent order, one admission transaction, then one
// dispatch record, a deadline-capped JWT over the exact bytes, and the
// synchronous answer as a transition. The App is the substituted preview
// transport; real HTTP and an isolated PGlite (which serializes transactions,
// so the concurrency cases pin the interleavings with test seams).
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
  __observeLinkCardLiveStateForTests(null);
  __resetLinkCardActionLimitsForTests();
  __resetLinkCardReadBudgetForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** The fixed hints as defined, copied before any request runs. */
const HINTS = structuredClone(LINK_CARD_STATE_HINTS) as Record<string, { tone: string; text: string }>;
const execute = (baseUrl: string, fx: { headers: Record<string, string> }, body: unknown) => post(baseUrl, "execute", fx, body);
const actionCalls = <T extends { url: string }>(calls: T[], fx: CardFixture) => calls.filter((call) => call.url === fx.actionEndpoint);
const countRows = async (db: Database) => ({
  operations: (await db.select().from(linkCardOperations)).length,
  requests: (await db.select().from(linkCardClientRequests)).length,
  uses: (await db.select().from(linkCardHandleUses)).length,
  attempts: (await db.select().from(linkCardAttempts)).length,
  tokens: (await db.select().from(linkCardUpdateTokens)).length,
});
const openFor = async (db: Database, viewerId: string) => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${linkCardOperations}
  WHERE viewer_id = ${viewerId} AND state IN ('sent', 'accepted', 'unknown')`)).rows[0]!.n);
/** The handle's payload rewritten without a new MAC: what a forger can do. */
function forge(handle: string, change: (payload: Record<string, unknown>) => void) {
  const [v, kid, payload, mac] = handle.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
  change(claims);
  return `${v}.${kid}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${mac}`;
}
const lockTimeout = () => Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });

test("execute end to end: a read's handle, one transaction, one dispatch record, a deadline-capped JWT over the exact bytes, and the answer as a transition", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const approve = { type: "Button", props: { label: "Approve", action: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } } };
  const calls = stubApp((call) => call.url.endsWith("/callback")
    ? JSON.stringify({ version: 2, display: "card", title: "PR #1", card_revision: "cr-1", business_revision: "br-1",
      card: { root: "root", elements: { root: { type: "Stack", props: {}, children: ["approve"] }, approve } } })
    : appAnswer({ status: "accepted", code: "APPROVED", attribution: "alice@private-repo", toast: { tone: "success", text: "Approved PR #1 in private-repo" } }));
  const read = await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/link-cards/read`, {
    method: "POST", headers: fx.headers, body: JSON.stringify({ view_instance_id: randomUUID(), capabilities: ALL_CAPABILITIES, locale: "zh-CN" }),
  });
  const handle = ((await read.json()) as { items: { actions: { handle: string }[] }[] }).items[0]!.actions[0]!.handle;
  const crid = clientRequestId();
  const res = await execute(app.baseUrl, fx, { client_request_id: crid, handle });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const operationId = res.body.operation_id as string;
  assert.deepEqual(res.body, { operation_id: operationId, state: "accepted", toast: HINTS.accepted },
    "only the fixed hint for the state: the App's toast, code and attribution never reach the client from the synchronous answer");

  const [call, ...more] = actionCalls(calls, fx);
  assert.ok(call); assert.equal(more.length, 0, "sent once");
  assert.deepEqual(Object.keys(call.body).sort(), ["action_id", "card_revision", "claimed", "locale", "operation_id", "phase", "update_token", "url", "version"],
    "no client_request_id, no prepared fields for an undo action");
  assert.deepEqual({ ...call.body, update_token: "x" }, {
    version: 2, phase: "execute", url: fx.url, action_id: "approve", card_revision: "cr-1", claimed: { business_revision: "br-1" },
    operation_id: operationId, locale: "zh-CN", update_token: "x",
  });
  assert.match(call.body.update_token as string, /^lcu_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(call.options, { response: "text", acceptLanguage: "zh-CN", timeoutMs: 2500 }, "a 2.5 s budget, raw text for the strict parser");
  assert.equal(call.header.typ, "raft-card-action+jwt");
  const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, operationId));
  assert.ok(op);
  assert.deepEqual({ ...call.claims, iat: 0, nbf: 0, exp: 0 }, {
    iss: oidcIssuer(undefined, fx.server.id), aud: `urn:raft:card-action:${fx.client.clientId}`, sub: fx.owner.id, iat: 0, nbf: 0, exp: 0,
    jti: linkCardExecuteJti(operationId), token_use: "card_action", type: "human", phase: "execute", server_id: fx.server.id, server_role: "owner",
    installation_id: fx.install.id, message_id: fx.message.id, url_sha256: linkCardUrlSha256(fx.url), body_sha256: sha256(call.raw),
  }, "iss by Server id, body_sha256 over the exact bytes sent, the one execute jti of this operation");
  assert.ok(Number(call.claims.exp) - Number(call.claims.iat) <= 30);
  assert.ok(Number(call.claims.exp) <= Math.floor(op.firstSendDeadline.getTime() / 1000), "exp never passes the first-send deadline");

  // The operation, written first, with a whole-second created_at and its deadline from the same reading.
  assert.equal(op.state, "accepted"); assert.equal(op.receiptRevision, 1);
  assert.equal(op.createdAt.getTime() % 1000, 0);
  assert.equal(op.firstSendDeadline.getTime() - op.createdAt.getTime(), 600_000);
  assert.equal(op.urlSha256, linkCardUrlSha256(fx.url));
  assert.equal(op.actionEndpointSha256, linkCardActionEndpointSha256(fx.actionEndpoint), "where execute went (T2)");
  assert.equal(op.actionOrigin, fx.origin);
  assert.deepEqual([op.viewerId, op.serverId, op.providerKind, op.providerKey, op.installationKey, op.registrationRevision, op.messageId, op.actionId],
    [fx.owner.id, fx.server.id, "app", fx.client.clientId, fx.install.id, fx.registration.revision, fx.message.id, "approve"]);
  assert.equal(op.requestSha256, linkCardRequestSha256({ urlSha256: linkCardUrlSha256(fx.url), actionId: "approve", handleSha256: sha256(handle), prepared: null }));
  const [mapping] = await db.select().from(linkCardClientRequests);
  assert.deepEqual([mapping?.clientRequestId, mapping?.operationId, mapping?.requestSha256], [crid, operationId, op.requestSha256]);
  const [use] = await db.select().from(linkCardHandleUses);
  assert.deepEqual([use?.handleSha256, use?.operationId], [sha256(handle), operationId], "the handle is consumed");
  const [view] = await db.select().from(linkCardViews);
  assert.equal(view?.viewNonce, op.viewNonce); assert.equal(view?.pendingOperationId, operationId, "the view's one pending slot");
  const attempts = await db.select().from(linkCardAttempts);
  assert.deepEqual(attempts.map((row) => [row.jti, row.phase, row.operationId, row.outcome]), [[linkCardExecuteJti(operationId), "execute", operationId, "answered:accepted"]]);
  const [token] = await db.select().from(linkCardUpdateTokens);
  assert.equal(token?.tokenSha256, sha256(call.body.update_token as string), "only the token's SHA-256 is stored");
  assert.deepEqual([token?.operationId, token?.registrationRevision, token?.consumedUpdateId], [operationId, fx.registration.revision, null]);
  const lifetime = token!.expiresAt.getTime() - attempts[0]!.sentAt.getTime();
  assert.ok(lifetime >= 599_000 && lifetime <= 601_000, `update token lives 10 minutes from the dispatch (${lifetime})`);
});

test("the synchronous answer table: accepted|executing -> accepted, done|refused|failed_not_sent -> terminal, unknown/timeout/failure/invalid -> unknown, nothing sent -> failed_not_sent; the toast is always the fixed hint", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  __setLinkCardActionHooksForTests({ budgetMs: 100 });
  const appToast = { toast: { tone: "success", text: "Merged secret-repo#9" }, code: "X", attribution: "bob" };
  const cases: [string, () => unknown, string, string][] = [
    ["accepted", () => appAnswer({ status: "accepted", ...appToast }), "accepted", "answered:accepted"],
    ["executing", () => appAnswer({ status: "executing" }), "accepted", "answered:executing"],
    ["done", () => appAnswer({ status: "done", ...appToast }), "done", "answered:done"],
    ["refused", () => appAnswer({ status: "refused", code: "STALE" }), "refused", "answered:refused"],
    ["failed_not_sent", () => appAnswer({ status: "failed_not_sent" }), "failed_not_sent", "answered:failed_not_sent"],
    ["unknown", () => appAnswer({ status: "unknown" }), "unknown", "answered:unknown"],
    ["no answer within the budget", () => new Promise(() => undefined), "unknown", "timeout"],
    ["a transport failure after sending", () => { throw new Error("socket hang up"); }, "unknown", "transport_error"],
    ["refused before any byte left (DNS, address policy)", () => { throw new PreviewNotSentError("Preview host unavailable"); }, "failed_not_sent", "not_sent"],
    ["not JSON", () => "accepted", "unknown", "invalid_answer"],
    ["an unknown status", () => appAnswer({ status: "maybe" }), "unknown", "invalid_answer"],
    ["an unknown field", () => appAnswer({ status: "done", card: {} }), "unknown", "invalid_answer"],
    ["a duplicate key", () => '{"status":"refused","status":"done"}', "unknown", "invalid_answer"],
    ["a C0 key", () => '{"status":"done","\\u001b":"x"}', "unknown", "invalid_answer"],
    ["a parsed object instead of text", () => ({ status: "done" }), "unknown", "transport_error"],
  ];
  for (const [name, answer, state, outcome] of cases) {
    const calls = stubApp(answer);
    const { handle, claims } = handleFor(fx);
    const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle });
    assert.equal(res.status, 200, name);
    assert.deepEqual(res.body, { operation_id: res.body.operation_id, state, toast: HINTS[state] }, name);
    for (const leaked of ["secret-repo", "bob", "STALE"]) assert.ok(!JSON.stringify(res.body).includes(leaked), `${name}: no App text (${leaked})`);
    assert.equal(actionCalls(calls, fx).length, 1, `${name}: sent exactly once`);
    const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, res.body.operation_id as string));
    assert.equal(op?.state, state, name);
    const [attempt] = await db.select().from(linkCardAttempts).where(eq(linkCardAttempts.operationId, op!.operationId));
    assert.equal(attempt?.outcome, outcome, name);
    const [view] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, claims.viewNonce));
    const terminal = ["done", "refused", "failed_not_sent"].includes(state);
    assert.equal(view?.pendingOperationId, terminal ? null : op!.operationId, `${name}: a terminal state releases the view`);
  }
});

test("recovery first: the same id and intent returns the same operation without a second call or write (handle expired, eligibility revoked too); a different intent is 409", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const iat = Math.floor(Date.now() / 1000);
  const { handle } = handleFor(fx, { iat, exp: iat + 2 });
  const crid = clientRequestId();
  const body = { client_request_id: crid, handle };
  const first = await execute(app.baseUrl, fx, body);
  assert.equal(first.status, 200);
  const rows = await countRows(db);
  const phases: string[] = [];
  __observeLinkCardLiveStateForTests((phase) => phases.push(phase));
  const again = await execute(app.baseUrl, fx, JSON.stringify({ handle, client_request_id: crid }));
  assert.deepEqual(again.body, first.body, "an equivalent JSON spelling is the same intent");
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.deepEqual((await execute(app.baseUrl, fx, body)).body, first.body, "the handle has expired: recovery checks no handle");
  assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle })).status, 410, "but a new intent with it is 410");
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.deepEqual((await execute(app.baseUrl, fx, body)).body, first.body, "eligibility revoked: recovery comes before eligibility");
  assert.equal(actionCalls(calls, fx).length, 1, "never sent again");
  assert.deepEqual(await countRows(db), rows, "and nothing written");
  assert.deepEqual(phases, [], "recovery compares nothing with live state (the expired new intent stopped at its MAC check)");

  const conflict = await execute(app.baseUrl, fx, { client_request_id: crid, handle: handleFor(fx).handle });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "CLIENT_REQUEST_CONFLICT");
  assert.equal(conflict.headers.get("cache-control"), "private, no-store");
  const withPrepared = await execute(app.baseUrl, fx, { ...body, prepared_action_id: randomUUID(), prepared_digest: "a".repeat(64) });
  assert.equal(withPrepared.status, 409, "the digest covers the prepared fields");

  // Read access is current: a revoked consent hides the operation, never reveals or replays it.
  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.userId, fx.owner.id));
  assert.deepEqual((await execute(app.baseUrl, fx, body)).body, { state: "not_visible" });
  assert.equal(actionCalls(calls, fx).length, 1);
});

test("the viewer and Server come from the session: another member replaying a viewer's exact request gets nothing of theirs", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  stubApp(() => appAnswer({ status: "accepted" }));
  const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  assert.equal((await execute(app.baseUrl, fx, body)).status, 200);
  const other = await seed.human();
  await addMember(fx.server.id, other.id);
  await addHuman(fx.channel.id, other.id);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: other.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  const asOther = { headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(other.email)}` } };
  const replay = await execute(app.baseUrl, asOther, body);
  assert.equal(replay.status, 410, "the handle names another viewer; the session decides who is asking");
  assert.ok(!("operation_id" in replay.body));
  assert.equal((await db.select().from(linkCardOperations)).length, 1);
});

test("new-intent order: MAC and expiry (410) before requiresPrepare (400) before the limits (429) before the other bindings (410); no App is called", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const prepared = { prepared_action_id: randomUUID(), prepared_digest: "b".repeat(64) };
  const confirm = handleFor(fx, { requiresPrepare: true, actionId: "merge" });
  // A forged requiresPrepare: false that "matches" the request's prepared fields is still 410, never 400.
  const forged = forge(confirm.handle, (claims) => { claims.requiresPrepare = false; });
  const expect = async (body: Record<string, unknown>, status: number, code: string, why: string) => {
    const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), ...body });
    assert.equal(res.status, status, `${why}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  };
  await expect({ handle: forged }, 410, "HANDLE_INVALID", "forged field, no prepared fields");
  await expect({ handle: forge(confirm.handle, (claims) => { claims.actionId = "approve"; }), ...prepared }, 410, "HANDLE_INVALID", "forged field with prepared fields");
  const nowSeconds = Math.floor(Date.now() / 1000);
  await expect({ handle: handleFor(fx, { iat: nowSeconds - 700, exp: nowSeconds - 100, requiresPrepare: true }).handle }, 410, "HANDLE_INVALID", "expired, before the 400");
  await expect({ handle: confirm.handle }, 400, "PREPARE_REQUIRED", "requiresPrepare without prepared fields");
  await expect({ handle: handleFor(fx).handle, ...prepared }, 400, "PREPARED_NOT_ALLOWED", "prepared fields on an undo action");
  // The limits come before the other bindings: stale handles spend the budget.
  for (let i = 0; i < LINK_CARD_EXECUTE_PER_MINUTE; i++) {
    await expect({ handle: handleFor(fx, { binding: { registrationRevision: randomUUID() } }).handle }, 410, "HANDLE_INVALID", `stale ${i}`);
  }
  await expect({ handle: handleFor(fx, { binding: { registrationRevision: randomUUID() } }).handle }, 429, "RATE_LIMITED", "over the limit, before the stale binding");
  assert.equal(actionCalls(calls, fx).length, 0);
  assert.deepEqual(await countRows(db), { operations: 0, requests: 0, uses: 0, attempts: 0, tokens: 0 });
});

test("a handle that no longer matches live state is 410 and calls no App", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const stale = async (handle: string, why: string) => {
    const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle });
    assert.equal(res.status, 410, `${why}: ${JSON.stringify(res.body)}`);
  };
  await stale(handleFor(fx, { binding: { registrationRevision: randomUUID() } }).handle, "another registration revision");
  await stale(handleFor(fx, { binding: { installationKey: randomUUID() } }).handle, "another installation");
  await stale(handleFor(fx, { binding: { providerKey: "cards-someone-else" } }).handle, "another provider");
  await stale(handleFor(fx, { binding: { viewerId: randomUUID() } }).handle, "another viewer");
  await stale(handleFor(fx, { binding: { serverId: randomUUID() } }).handle, "another Server");
  await stale(handleFor(fx, { binding: { messageId: randomUUID() } }).handle, "another message");
  await stale(handleFor(fx, { binding: { urlSha256: linkCardUrlSha256(`${fx.origin}/pr/2`) } }).handle, "a link the message doesn't have");
  await stale(handleFor(fx, { binding: { capabilities: ["button.v1", "card.v2", "confirm.v1"] } }).handle, "a client without undo.v1");
  await stale(handleFor(fx, { messageContentSha256: sha256("older text") }).handle, "an older message version");
  await stale(handleFor(fx, { binding: { providerKind: "native", installationKey: nativeInstallationKey(fx.server.id, fx.client.clientId) } }).handle, "a native identity (none registered)");
  const edited = handleFor(fx);
  await db.update(messages).set({ content: `${fx.content} (edited)` }).where(eq(messages.id, fx.message.id));
  await stale(edited.handle, "the message was edited");
  assert.equal(actionCalls(calls, fx).length, 0);
  assert.equal((await db.select().from(linkCardOperations)).length, 0);
});

test("live state counts a message's links as the read does: an App link after ten Artifact links executes with the read's handle; after ten other links it is past the read and 410", async ({ app, db, seed }) => {
  const artifacts = Array.from({ length: 10 }, () => `https://app.raft.build/artifacts/pt_${randomUUID()}`).join(" ");
  const fx = await cardFixture(db, seed, { content: (url) => `${artifacts} ${url}` });
  const approve = { type: "Button", props: { label: "Approve", action: { kind: "execute", action_id: "approve", undoWindowMs: 5000 } } };
  const calls = stubApp((call) => call.url.endsWith("/callback")
    ? JSON.stringify({ version: 2, display: "card", title: "PR #1", card_revision: "cr-1", business_revision: "br-1",
      card: { root: "root", elements: { root: { type: "Stack", props: {}, children: ["approve"] }, approve } } })
    : appAnswer({ status: "accepted" }));
  const read = await fetch(`${app.baseUrl}/api/messages/${fx.message.id}/link-cards/read`, {
    method: "POST", headers: fx.headers, body: JSON.stringify({ view_instance_id: randomUUID(), capabilities: ALL_CAPABILITIES, locale: "zh-CN" }),
  });
  const items = ((await read.json()) as { items: { url: string; actions: { handle: string }[] }[] }).items;
  assert.deepEqual(items.map((item) => item.url), [fx.url], "the read covers the App link after the ten Artifact links");
  const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: items[0]!.actions[0]!.handle });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(actionCalls(calls, fx).length, 1);

  // The reverse: links that aren't Raft's own (an Artifact's path on another host) count, so the App link is the eleventh.
  const others = Array.from({ length: 10 }, (_, i) => `https://lookalike.example.test/artifacts/pt_${i}`).join(" ");
  const past = await cardFixture(db, seed, { content: (url) => `${others} ${url}` });
  const stale = await execute(app.baseUrl, past, { client_request_id: clientRequestId(), handle: handleFor(past).handle });
  assert.equal(stale.status, 410, JSON.stringify(stale.body));
  assert.equal(actionCalls(calls, past).length, 0);
});

test("before any App call: official, an approved endpoint in force, not suspended, proven within 72 h; eligibility is decided again under FOR SHARE in the transaction", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const refused = async (why: string, change: () => Promise<unknown>, undo: () => Promise<unknown>) => {
    await change();
    const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
    assert.equal(res.status, 410, `${why}: ${JSON.stringify(res.body)}`);
    await undo();
  };
  const registry = (status: "approved" | "disabled") => db.update(officialAppRegistry).set({ status }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  const registration = (values: Partial<typeof oauthAppLinkPreviews.$inferInsert>) => db.update(oauthAppLinkPreviews).set(values).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await refused("not an approved official App", () => registry("disabled"), () => registry("approved"));
  await refused("suspended", () => registration({ suspendedAt: new Date(), suspendedReason: "proof_unavailable" }), () => registration({ suspendedAt: null, suspendedReason: null }));
  await refused("proof older than 72 h", () => registration({ verifiedAt: new Date(Date.now() - 73 * 3600_000) }), () => registration({ verifiedAt: new Date() }));
  await refused("no approved action endpoint in force", () => registration({ actionEndpoint: null, pendingActionEndpoint: fx.actionEndpoint, pendingActionEndpointRequestedAt: new Date() }),
    () => registration({ actionEndpoint: fx.actionEndpoint, pendingActionEndpoint: null, pendingActionEndpointRequestedAt: null }));
  await refused("the App is disabled", () => db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, fx.client.id)),
    () => db.update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, fx.client.id)));
  assert.equal(actionCalls(calls, fx).length, 0);

  // Revoked after the live check, before the transaction: the FOR SHARE re-check refuses it.
  __setLinkCardActionHooksForTests({ beforeAdmission: async () => { await registry("disabled"); } });
  const late = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(late.status, 410); assert.equal(late.body.code, "PROVIDER_NOT_ELIGIBLE");
  assert.equal(actionCalls(calls, fx).length, 0);
  assert.deepEqual(await countRows(db), { operations: 0, requests: 0, uses: 0, attempts: 0, tokens: 0 }, "rolled back whole");
  await registry("approved");

  // Committed before a revocation: still sent (the decision is made at commit, RFC 076 §3.3).
  __setLinkCardActionHooksForTests({ beforeDispatch: async () => { await registry("disabled"); } });
  const committed = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(committed.body.state, "accepted");
  assert.equal(actionCalls(calls, fx).length, 1);
  await registry("approved");

  // Suspended between commit and dispatch: the endpoint is checked right before sending; proved never sent.
  __setLinkCardActionHooksForTests({ beforeDispatch: async () => { await registration({ suspendedAt: new Date(), suspendedReason: "proof_mismatch" }); } });
  const suspended = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.state, "failed_not_sent");
  assert.equal(actionCalls(calls, fx).length, 1, "not sent");
  const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, suspended.body.operation_id as string));
  assert.equal(op?.state, "failed_not_sent");
  assert.equal((await db.select().from(linkCardAttempts).where(eq(linkCardAttempts.operationId, op!.operationId))).length, 0, "no dispatch record");
  assert.equal((await db.select().from(linkCardUpdateTokens).where(eq(linkCardUpdateTokens.operationId, op!.operationId))).length, 0, "no update token");
});

test("the viewer's side is decided again inside the transaction, after its lock waits: consent revoked, declined, removed from the private channel, the message edited or deleted while execute waits is 410, writes nothing and calls no App", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const viewer = await seed.human();
  await addMember(fx.server.id, viewer.id, "member");
  const privateChannel = await seed.channel({ server: fx.server, members: [fx.owner, viewer], visibility: "private" });
  const [consent] = await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: viewer.id, clientId: fx.client.id, scopes: ["openid", "profile"] }).returning();
  const asViewer = { headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(viewer.email)}` } };
  const card = async (why: string) => {
    const content = `please approve ${fx.url} (${why})`;
    const message = await seed.message({ channel: privateChannel, author: fx.owner, content });
    return { message, content, handle: handleFor(fx, { binding: { viewerId: viewer.id, messageId: message.id }, messageContentSha256: sha256(content) }).handle };
  };
  // Control: nothing changes while it waits, so it runs.
  const control = await card("control");
  assert.equal((await execute(app.baseUrl, asViewer, { client_request_id: clientRequestId(), handle: control.handle })).status, 200);
  assert.equal(actionCalls(calls, fx).length, 1);
  const before = await countRows(db);
  // Each change lands while execute waits on its admission locks, after the
  // check before the transaction passed. PGlite has one connection, so the
  // change is made inside the waiting transaction and rolls back with it; the
  // real lock waits are in linkCardExecuteConcurrency.realPg.test.ts.
  const changes: [string, (tx: DatabaseExecutor, message: { id: string }, content: string) => Promise<unknown>][] = [
    ["consent revoked", (tx) => tx.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.id, consent!.id))],
    ["previews declined", (tx) => tx.insert(oauthLinkPreviewDeclines).values({ serverId: fx.server.id, userId: viewer.id, clientId: fx.client.id })],
    ["removed from the private channel", (tx) => removeHuman(privateChannel.id, viewer.id, { self: true }, tx)],
    ["the message edited", (tx, message, content) => tx.update(messages).set({ content: `${content} (edited)` }).where(eq(messages.id, message.id))],
    ["the message deleted", (tx, message) => tx.delete(messages).where(eq(messages.id, message.id))],
  ];
  for (const [why, change] of changes) {
    const { message, content, handle } = await card(why);
    __setLinkCardActionHooksForTests({ underAdmissionLocks: (tx) => change(tx, message, content).then(() => undefined) });
    const res = await execute(app.baseUrl, asViewer, { client_request_id: clientRequestId(), handle });
    assert.equal(res.status, 410, `${why}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "HANDLE_INVALID", why);
  }
  assert.equal(actionCalls(calls, fx).length, 1, "the App was never called for them");
  assert.deepEqual(await countRows(db), before, "nothing written");
});

test("the same id twice at once with one slot left under the cap: both get the one operation (recovered under the admission locks), no 429, one App call", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  await insertOperations(db, fx, 19);
  __setLinkCardActionHooksForTests({ afterRecoveryMiss: barrier(2) });
  const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  const [a, b] = await Promise.all([execute(app.baseUrl, fx, body), execute(app.baseUrl, fx, body)]);
  assert.deepEqual([a.status, b.status], [200, 200], JSON.stringify([a.body, b.body]));
  assert.equal(a.body.operation_id, b.body.operation_id, "one operation per client_request_id");
  assert.equal(await openFor(db, fx.owner.id), 20);
  assert.equal((await db.select().from(linkCardClientRequests)).length, 1);
  assert.equal(actionCalls(calls, fx).length, 1);
});

test("caps are admitted atomically: 19 open plus two concurrent new executes never exceed 20; needs_reconciliation counts only toward the installation", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  await insertOperations(db, fx, 19);
  __setLinkCardActionHooksForTests({ afterRecoveryMiss: barrier(2) });
  const results = await Promise.all([1, 2].map(() => execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle })));
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 429]);
  const capped = results.find((res) => res.status === 429)!;
  assert.deepEqual(capped.body, { error: "Can't run this right now, try later", code: "OPEN_OPERATIONS_CAP" });
  assert.equal(capped.headers.get("cache-control"), "private, no-store");
  assert.equal(await openFor(db, fx.owner.id), 20);
  assert.equal(actionCalls(calls, fx).length, 1);
  __setLinkCardActionHooksForTests(null);
  assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle })).status, 429, "at the cap");

  const other = await cardFixture(db, seed);
  await insertOperations(db, other, 20, { state: "needs_reconciliation" });
  const res = await execute(app.baseUrl, other, { client_request_id: clientRequestId(), handle: handleFor(other).handle });
  assert.equal(res.status, 200, "20 operations stuck in reconciliation do not block their viewer");
});

test("the installation cap counts needs_reconciliation too; past half its cap the installation's open count is reported", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  stubApp(() => appAnswer({ status: "accepted" }));
  const gauge = async () => (await linkCardOpenOperations.get()).values.find((value) => value.labels.installation_key === fx.install.id)?.value;
  await insertOperations(db, fx, 400, { state: "unknown", viewerId: randomUUID() });
  assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle })).status, 200);
  assert.equal(await gauge(), undefined, "at or under half the cap: no series");
  await insertOperations(db, fx, 598, { state: "needs_reconciliation", viewerId: randomUUID() });
  assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle })).status, 200, "999 open: one slot left");
  assert.equal(await gauge(), 999);
  const capped = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(capped.status, 429); assert.equal(capped.body.code, "OPEN_OPERATIONS_CAP");
  assert.equal(await gauge(), 1000);
});

test("lock_timeout bounds each wait at 2 s; a lock timeout is 429 LOCK_TIMEOUT, writes nothing, and a same-id winner found by the final check is returned instead", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const seen: string[] = [];
  __setLinkCardActionHooksForTests({
    underAdmissionLocks: async (tx) => {
      seen.push(String((await tx.execute<{ lock_timeout: string }>(sql`SHOW lock_timeout`)).rows[0]?.lock_timeout));
      throw lockTimeout();
    },
  });
  const timedOut = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(timedOut.status, 429); assert.equal(timedOut.body.code, "LOCK_TIMEOUT");
  assert.deepEqual(seen, ["2s"]);
  assert.deepEqual(await countRows(db), { operations: 0, requests: 0, uses: 0, attempts: 0, tokens: 0 });

  // B misses the fast lookup; A (same id) commits; B's lock wait then times out: B gets A's operation.
  const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  let misses = 0; let locks = 0; let winner: Awaited<ReturnType<typeof execute>> | null = null;
  __setLinkCardActionHooksForTests({
    afterRecoveryMiss: async () => { if (misses++ === 0) winner = await execute(app.baseUrl, fx, body); },
    underAdmissionLocks: () => { if (locks++ === 1) throw lockTimeout(); },
  });
  const loser = await execute(app.baseUrl, fx, body);
  assert.equal(winner!.status, 200);
  assert.equal(loser.status, 200, JSON.stringify(loser.body));
  assert.equal(loser.body.operation_id, winner!.body.operation_id);
  assert.equal(actionCalls(calls, fx).length, 1);
});

test("any new-intent error with a committed same-id winner returns the winner (rule 5): eligibility revoked meanwhile", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "done" }));
  const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  let misses = 0; let winner: Awaited<ReturnType<typeof execute>> | null = null;
  __setLinkCardActionHooksForTests({
    afterRecoveryMiss: async () => {
      if (misses++ > 0) return;
      winner = await execute(app.baseUrl, fx, body);
      await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
    },
  });
  const res = await execute(app.baseUrl, fx, body);
  assert.equal(res.status, 200, "not 410");
  assert.deepEqual(res.body, winner!.body);
  assert.equal(actionCalls(calls, fx).length, 1);
});

test("the operation goes in first and the transaction rolls back whole; one pending operation per view, released lazily, and a refresh does not lift it", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  // The 0386 foreign keys are immediate: a handle use for an operation not yet written fails at once.
  await assert.rejects(db.insert(linkCardHandleUses).values({ handleSha256: "f".repeat(64), operationId: randomUUID(), expiresAt: new Date(Date.now() + 60_000) }),
    (error: { cause?: { code?: string } }) => error.cause?.code === "23503");
  const x = handleFor(fx);
  const first = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: x.handle });
  assert.equal(first.body.state, "accepted");
  const rows = await countRows(db);
  // The same view (same nonce: what a refresh carrying the earlier ticket gets) while X is pending.
  const y = handleFor(fx, { viewNonce: x.claims.viewNonce, viewInstanceId: x.claims.viewInstanceId, epoch: 2 });
  const yBody = { client_request_id: clientRequestId(), handle: y.handle };
  const pending = await execute(app.baseUrl, fx, yBody);
  assert.equal(pending.status, 409); assert.equal(pending.body.code, "VIEW_PENDING");
  assert.deepEqual(await countRows(db), rows, "the operation, mapping and handle use written before the view check are all rolled back");
  // A view row bound elsewhere never matches (another instance id for the same nonce).
  const crossed = handleFor(fx, { viewNonce: x.claims.viewNonce });
  assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: crossed.handle })).status, 410);
  // X reaches a terminal state: the slot is free without anyone clearing it, and Y's unconsumed handle now runs.
  await db.update(linkCardOperations).set({ state: "done" }).where(eq(linkCardOperations.operationId, first.body.operation_id as string));
  const released = await execute(app.baseUrl, fx, yBody);
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.notEqual(released.body.operation_id, first.body.operation_id);
  const [view] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, x.claims.viewNonce));
  assert.equal(view?.pendingOperationId, released.body.operation_id);
  assert.equal(actionCalls(calls, fx).length, 2);

  // resolved_manually releases a view too.
  const z = handleFor(fx);
  const resolvedId = randomUUID();
  const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
  await db.insert(linkCardOperations).values({
    operationId: resolvedId, viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app", providerKey: fx.client.clientId, installationKey: fx.install.id,
    registrationRevision: fx.registration.revision, viewNonce: z.claims.viewNonce, messageId: fx.message.id, urlSha256: linkCardUrlSha256(fx.url),
    actionEndpointSha256: linkCardActionEndpointSha256(fx.actionEndpoint), actionOrigin: fx.origin, actionId: "approve", requestSha256: "0".repeat(64),
    state: "resolved_manually", resolvedByUserId: fx.owner.id, resolvedAt: new Date(), resolutionReason: "operator closed it", createdAt,
    firstSendDeadline: new Date(createdAt.getTime() + 600_000),
  });
  await db.insert(linkCardViews).values({ viewNonce: z.claims.viewNonce, viewInstanceId: z.claims.viewInstanceId, viewerId: fx.owner.id, serverId: fx.server.id,
    providerKind: "app", providerKey: fx.client.clientId, installationKey: fx.install.id, messageId: fx.message.id, urlSha256: linkCardUrlSha256(fx.url), pendingOperationId: resolvedId });
  assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: z.handle })).status, 200);
});

test("a different intent on a used handle is 409 HANDLE_USED with the operation id the viewer can read", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  stubApp(() => appAnswer({ status: "done" }));
  const { handle } = handleFor(fx);
  const first = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle });
  const second = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle });
  assert.equal(second.status, 409);
  assert.deepEqual(second.body, { error: "This button was already used.", code: "HANDLE_USED", operation_id: first.body.operation_id });
  assert.equal((await db.select().from(linkCardOperations)).length, 1, "the loser wrote nothing");
});

test("HANDLE_USED looks the use up by the handle digest and the session's viewer and Server together: it never names another viewer's operation", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "done" }));
  // Another member who can read the same message, with an operation of their own.
  const other = await seed.human();
  await addMember(fx.server.id, other.id, "member");
  await addHuman(fx.channel.id, other.id);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: other.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  await insertOperations(db, fx, 1, { viewerId: other.id });
  const [theirs] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.viewerId, other.id));
  // A use row for this viewer's handle that points at their operation (no writer
  // makes one: the handle binds its viewer). Only the WHERE keeps it unnamed.
  const { handle, handleSha256 } = handleFor(fx);
  await db.insert(linkCardHandleUses).values({ handleSha256, operationId: theirs!.operationId, expiresAt: new Date(Date.now() + 600_000) });
  const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: "This button was already used.", code: "HANDLE_USED" });
  assert.equal(actionCalls(calls, fx).length, 0);
});

test("first-send deadline: paused past it between commit and dispatch, the sweep closes the operation as failed_not_sent and the sender signs and sends nothing", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  let swept: Awaited<ReturnType<typeof sweepLinkCardFirstSendDeadlines>> | null = null;
  __setLinkCardActionHooksForTests({
    beforeDispatch: async (operationId) => {
      // Eleven minutes pass: the trigger keeps both fixed, so the test moves them with it off.
      await db.execute(sql`ALTER TABLE ${linkCardOperations} DISABLE TRIGGER link_card_operations_send_deadline_immutable`);
      await db.execute(sql`UPDATE ${linkCardOperations} SET created_at = created_at - interval '11 minutes', first_send_deadline = first_send_deadline - interval '11 minutes'
        WHERE operation_id = ${operationId}`);
      await db.execute(sql`ALTER TABLE ${linkCardOperations} ENABLE TRIGGER link_card_operations_send_deadline_immutable`);
      swept = await sweepLinkCardFirstSendDeadlines();
    },
  });
  const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.deepEqual(swept, { due: 1, failedNotSent: 1, unknown: 0, skipped: 0 });
  assert.deepEqual(res.body, { operation_id: res.body.operation_id, state: "failed_not_sent", toast: LINK_CARD_STATE_HINTS.failed_not_sent });
  assert.equal(actionCalls(calls, fx).length, 0, "never signed, never sent");
  assert.equal((await db.select().from(linkCardAttempts)).length, 0);
  const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "link_card.operation_first_send_expired"));
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.metadata, { operationId: res.body.operation_id, actionId: "approve", providerKind: "app", providerKey: fx.client.clientId });
});

test("first-send deadline: dispatched, then past the deadline when signing: not signed, not sent, and the operation converges to unknown", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  // The dispatch record is written before the deadline; the sender then pauses
  // eleven minutes before signing.
  __setLinkCardActionHooksForTests({ signingNow: () => new Date(Date.now() + 11 * 60_000) });
  const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(res.body.state, "unknown");
  assert.equal(actionCalls(calls, fx).length, 0);
  const attempts = await db.select().from(linkCardAttempts);
  assert.deepEqual(attempts.map((row) => [row.phase, row.outcome]), [["execute", "past_deadline"]], "the dispatch record stays: it may have been sent");
});

test("the deadline sweep racing the App's answer: the answer to the same execute still moves unknown to what the App said; Raft's own conclusions never move unknown", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  __setLinkCardActionHooksForTests({ budgetMs: 200 });
  let answer: string | null | "not_sent" = null;
  const swept: unknown[] = [];
  const calls = stubApp(async (call) => {
    // While the request is in flight its deadline passes and the sweep finds a
    // dispatch record: it converges the operation to unknown before the answer is applied.
    const operationId = call.body.operation_id as string;
    await db.execute(sql`ALTER TABLE ${linkCardOperations} DISABLE TRIGGER link_card_operations_send_deadline_immutable`);
    await db.execute(sql`UPDATE ${linkCardOperations} SET created_at = created_at - interval '11 minutes', first_send_deadline = first_send_deadline - interval '11 minutes'
      WHERE operation_id = ${operationId}`);
    await db.execute(sql`ALTER TABLE ${linkCardOperations} ENABLE TRIGGER link_card_operations_send_deadline_immutable`);
    swept.push(await sweepLinkCardFirstSendDeadlines());
    if (answer === "not_sent") throw new PreviewNotSentError("Preview host unavailable");
    return answer === null ? new Promise<never>(() => {}) : answer;
  });
  const cases: [string | null, string, string, number][] = [
    [appAnswer({ status: "done" }), "done", "answered:done", 2],
    [appAnswer({ status: "accepted" }), "accepted", "answered:accepted", 2],
    [appAnswer({ status: "executing" }), "accepted", "answered:executing", 2],
    [appAnswer({ status: "refused", toast: { tone: "error", text: "nope" } }), "refused", "answered:refused", 2],
    [appAnswer({ status: "failed_not_sent" }), "failed_not_sent", "answered:failed_not_sent", 2],
    [appAnswer({ status: "unknown" }), "unknown", "answered:unknown", 1],
    // Raft's own conclusions: no answer within the budget, an invalid answer,
    // and even "never sent" (the sweep already said it may have been).
    [null, "unknown", "timeout", 1],
    [appAnswer({ status: "bogus" }), "unknown", "invalid_answer", 1],
    ["not_sent", "unknown", "not_sent", 1],
  ];
  for (const [given, state, outcome, receiptRevision] of cases) {
    answer = given;
    const { handle, claims } = handleFor(fx);
    const res = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle });
    const why = `${given ?? "no answer"} -> ${state}`;
    assert.deepEqual(swept.at(-1), { due: 1, failedNotSent: 0, unknown: 1, skipped: 0 }, why);
    assert.equal(res.status, 200, why);
    assert.equal(res.body.state, state, why);
    assert.deepEqual(res.body.toast, HINTS[state], why);
    const operationId = res.body.operation_id as string;
    const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, operationId));
    assert.equal(op?.state, state, why);
    assert.equal(op?.receiptRevision, receiptRevision, `${why}: the sweep's move, then the answer's`);
    const [attempt] = await db.select().from(linkCardAttempts).where(eq(linkCardAttempts.jti, linkCardExecuteJti(operationId)));
    assert.equal(attempt?.outcome, outcome, why);
    const [view] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, claims.viewNonce));
    assert.equal(view?.pendingOperationId, ["done", "refused", "failed_not_sent"].includes(state) ? null : operationId, why);
  }
  assert.equal(actionCalls(calls, fx).length, cases.length, "one call each");
});

test("one live-state entry point: prepare and execute call verifyLinkCardActionAgainstLiveState, recovery calls nothing, and no endpoint compares bindings on its own", async ({ app, db, seed }) => {
  for (const file of ["../services/linkCardActionService.ts", "./linkCards.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const tool of ["messageContentSha256", "registrationRevision !==", "registrationRevision ===", "matchesAppPreview", "registeredApps(", "messagePreviewUrls(", "appLinkReadUrls(",
      "isApprovedOfficialAppClient", "linkCardMessageContentSha256", "binding.installationKey ===", "binding.providerKey ===", "capabilities.includes"]) {
      assert.ok(!source.includes(tool), `${file} must leave "${tool}" to linkCardLiveState.ts`);
    }
  }
  const service = readFileSync(new URL("../services/linkCardActionService.ts", import.meta.url), "utf8");
  assert.equal(service.match(/verifyLinkCardActionAgainstLiveState\(\{/g)?.length, 2, "called once by prepare and once by execute");

  const fx = await cardFixture(db, seed);
  stubApp((call) => call.body.phase === "prepare"
    ? appAnswer({ status: "refused" })
    : appAnswer({ status: "accepted" }));
  const phases: string[] = [];
  __observeLinkCardLiveStateForTests((phase) => phases.push(phase));
  await post(app.baseUrl, "prepare", fx, { handle: handleFor(fx, { requiresPrepare: true, actionId: "merge" }).handle, claimed: { business_revision: "br-1" } });
  assert.deepEqual(phases, ["prepare"]);
  const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  await execute(app.baseUrl, fx, body);
  assert.deepEqual(phases, ["prepare", "execute", "execute_transaction"], "execute re-checks the viewer's side once, in its transaction");
  await execute(app.baseUrl, fx, body);
  assert.deepEqual(phases, ["prepare", "execute", "execute_transaction"], "recovery compares nothing with live state");
});

test("limits: 30 executes per viewer per Server per minute across replicas (Redis, else this process); the 31st is 429 with Retry-After; recovery spends none", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  stubApp(() => appAnswer({ status: "accepted" }));
  const done = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  assert.equal((await execute(app.baseUrl, fx, done)).status, 200);
  for (let i = 1; i < LINK_CARD_EXECUTE_PER_MINUTE; i++) {
    assert.equal((await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx, { binding: { messageId: randomUUID() } }).handle })).status, 410);
  }
  const over = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "RATE_LIMITED");
  assert.ok(Number(over.body.retry_after) >= 1 && Number(over.body.retry_after) <= 60);
  assert.equal(over.headers.get("retry-after"), String(over.body.retry_after));
  assert.equal(over.headers.get("cache-control"), "private, no-store");
  assert.equal((await execute(app.baseUrl, fx, done)).status, 200, "a retry of an existing request is recovery: no budget");
});

test("recovery has its own generous lookup budget (120 per viewer per Server per minute): past it, 429 with Retry-After before any query; the execute budget is separate", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const done = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
  assert.equal((await execute(app.baseUrl, fx, done)).status, 200, "spends one lookup unit and one execute unit");
  for (let i = 1; i < LINK_CARD_RECOVERY_PER_MINUTE - 1; i++) assert.deepEqual(await admitLinkCardAction("recovery", fx.owner.id, fx.server.id), { admitted: true });
  assert.equal((await execute(app.baseUrl, fx, done)).status, 200, "the 120th lookup: a retry still gets its answer");
  const over = await execute(app.baseUrl, fx, done);
  assert.equal(over.status, 429);
  assert.equal(over.body.code, "RATE_LIMITED");
  assert.ok(Number(over.body.retry_after) >= 1 && Number(over.body.retry_after) <= 60);
  assert.equal(over.headers.get("retry-after"), String(over.body.retry_after));
  assert.equal(over.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await admitLinkCardAction("execute", fx.owner.id, fx.server.id), { admitted: true }, "the execute budget was spent once");
  assert.equal(actionCalls(calls, fx).length, 1);
});

test("guests act on the existing terms: a guest who can read the message may execute; a member who can't read it gets 410; no session is 401", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const join = async (role: "guest" | "member", inChannel: boolean) => {
    const human = await seed.human();
    // A guest belongs to the card's channel, its one channel (#wg-rbac:#15).
    if (role === "guest") await seedBoundGuest({ serverId: fx.server.id, userId: human.id, channelId: fx.channel.id, member: inChannel });
    else await addMember(fx.server.id, human.id, role);
    if (inChannel) await addHuman(fx.channel.id, human.id);
    await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: human.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
    return { human, headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(human.email)}` } };
  };
  const guest = await join("guest", true);
  const asGuest = await execute(app.baseUrl, guest, { client_request_id: clientRequestId(), handle: handleFor(fx, { binding: { viewerId: guest.human.id } }).handle });
  assert.equal(asGuest.status, 200, JSON.stringify(asGuest.body));
  const [op] = await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, asGuest.body.operation_id as string));
  assert.equal(op?.viewerId, guest.human.id);
  assert.equal(actionCalls(calls, fx)[0]!.claims.server_role, "guest");

  const privateChannel = await seed.channel({ server: fx.server, members: [fx.owner], visibility: "private" });
  const secret = await seed.message({ channel: privateChannel, author: fx.owner, content: `see ${fx.url}` });
  const outsider = await join("member", true);
  const res = await execute(app.baseUrl, outsider, { client_request_id: clientRequestId(),
    handle: handleFor(fx, { binding: { viewerId: outsider.human.id, messageId: secret.id } }).handle });
  assert.equal(res.status, 410, "the viewer must still be able to read the message");
  const anonymous = await fetch(`${app.baseUrl}/api/link-cards/execute`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_request_id: clientRequestId(), handle: handleFor(fx).handle }) });
  assert.equal(anonymous.status, 401);
  assert.equal(actionCalls(calls, fx).length, 1);
});

test("execute bodies are strict, own fields only, and refused above 64 KiB before parsing; a handle without a readable selector is 400", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const { handle } = handleFor(fx);
  const bad: [unknown, string][] = [
    [{ handle }, "no client_request_id"],
    [{ client_request_id: "short", handle }, "client_request_id under 16"],
    [{ client_request_id: `${"x".repeat(15)} y`, handle }, "client_request_id with a space"],
    [{ client_request_id: "c".repeat(129), handle }, "client_request_id over 128"],
    [{ client_request_id: clientRequestId(), handle, prepared_action_id: randomUUID() }, "half a prepared pair"],
    [{ client_request_id: clientRequestId(), handle, prepared_action_id: "pa-1", prepared_digest: "a".repeat(64) }, "a prepared id that is not a UUID"],
    [{ client_request_id: clientRequestId(), handle, prepared_description: { title: "x" } }, "prepared_description (native only; none registered)"],
    [{ client_request_id: clientRequestId(), handle, extra: true }, "an unknown field"],
    [`{"__proto__":{"x":1},"client_request_id":"${clientRequestId()}","handle":"${handle}"}`, "a __proto__ key"],
    [[{ client_request_id: clientRequestId(), handle }], "an array"],
    ["not json", "not JSON"],
    [{ client_request_id: clientRequestId(), handle: "v1.k1.bm90IGpzb24.abc" }, "a handle without a selector"],
    [{ client_request_id: clientRequestId(), handle: "garbage" }, "not a handle"],
  ];
  for (const [body, why] of bad) {
    const res = await execute(app.baseUrl, fx, body);
    assert.equal(res.status, 400, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  const huge = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle, pad: "x".repeat(65 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal(huge.headers.get("cache-control"), "private, no-store");
  assert.equal(actionCalls(calls, fx).length, 0);
  assert.equal((await db.select().from(linkCardOperations).where(and(eq(linkCardOperations.viewerId, fx.owner.id)))).length, 0);
});
