import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import {
  linkCardAttempts, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, oauthAppLinkPreviews, officialAppRegistry,
} from "../db/schema";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { __resetLinkCardActionLimitsForTests, LINK_CARD_PREPARE_PER_MINUTE } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests, LINK_CARD_STATE_HINTS } from "../services/linkCardActionService";
import { __resetLinkCardReadBudgetForTests } from "../services/linkCardReadService";
import { linkCardUrlSha256 } from "../services/linkCardTokens";
import { oidcIssuer } from "../services/oidcService";
import {
  appAnswer, cardFixture, clientRequestId, handleFor, post, stubApp, type ActionCall, type CardFixture,
} from "../test/linkCardActionFixture";

// POST /api/link-cards/prepare (RFC 076 §6.2; protocol v3.2.3 §5.2, §10;
// addenda 1 §6 and 4 §4): the flag first, the handle, requiresPrepare, the
// live state and pre-call checks, then `phase: prepare` to the action endpoint
// and a new immutable prepared record from a strictly parsed description.
// Execute then consumes it (protocol §5.3.2 (f)).
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

const mergeHandle = (fx: CardFixture, overrides: Parameters<typeof handleFor>[1] = {}) => handleFor(fx, { requiresPrepare: true, actionId: "merge", ...overrides });
const prepare = (baseUrl: string, fx: CardFixture, handle: string, businessRevision = "br-1") =>
  post(baseUrl, "prepare", fx, { handle, claimed: { business_revision: businessRevision } });
/** A valid description for this prepare call, echoing its ids. */
const describe = (call: ActionCall, extra: Record<string, unknown> = {}) => ({
  prepared_action_id: call.body.prepared_action_id, action_id: call.body.action_id, business_revision: "br-1", locale: "zh-CN",
  read_at: "2026-10-21T08:15:30.120Z", title: "Merge PR #1", rows: [{ label: "Base", value: "staging" }], confirm_label: "Merge", cancel_label: "Cancel",
  target: "staging", execution_mode: "squash", execution_account: "github:42",
  // An own data key, as the strict parser keeps it (protocol §10.1).
  terms: JSON.parse('{"__proto__":"kept as data"}') as Record<string, string>, ...extra,
});
const actionCalls = (calls: ActionCall[], fx: CardFixture) => calls.filter((call) => call.url === fx.actionEndpoint);

test("prepare: phase prepare within 2.5 s; the description parsed strictly and stored as a new immutable record (read_at = Raft's receive time, at most 5 min and the handle's exp); the handle is not consumed", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp((call) => appAnswer({ status: "prepared", description: describe(call) }));
  const { handle, claims, handleSha256 } = mergeHandle(fx);
  const before = Date.now();
  const res = await prepare(app.baseUrl, fx, handle);
  const after = Date.now();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const [call] = actionCalls(calls, fx);
  assert.ok(call);
  assert.deepEqual(Object.keys(call.body).sort(), ["action_id", "card_revision", "claimed", "locale", "phase", "prepared_action_id", "url", "version"],
    "no operation_id and no update_token: prepare can't reach a write");
  assert.deepEqual(call.body, { version: 2, phase: "prepare", url: fx.url, action_id: "merge", card_revision: "cr-1", claimed: { business_revision: "br-1" },
    prepared_action_id: call.body.prepared_action_id, locale: "zh-CN" });
  assert.deepEqual(call.options, { response: "text", acceptLanguage: "zh-CN", timeoutMs: 2500 });
  assert.equal(call.header.typ, "raft-card-action+jwt");
  assert.equal(call.claims.phase, "prepare");
  assert.equal(call.claims.iss, oidcIssuer(undefined, fx.server.id));
  assert.equal(Number(call.claims.exp) - Number(call.claims.iat), 30);
  assert.equal(call.claims.url_sha256, linkCardUrlSha256(fx.url));

  const description = describe(call);
  const digest = canonicalJsonSha256(description);
  assert.deepEqual(res.body, { prepared_action_id: call.body.prepared_action_id, prepared_digest: digest, description });
  const [record] = await db.select().from(linkCardPreparedActions);
  assert.ok(record);
  assert.equal(record.preparedActionId, call.body.prepared_action_id);
  assert.deepEqual([record.viewerId, record.serverId, record.providerKind, record.providerKey, record.installationKey, record.viewNonce, record.handleSha256],
    [fx.owner.id, fx.server.id, "app", fx.client.clientId, fx.install.id, claims.viewNonce, handleSha256]);
  assert.deepEqual([record.descriptionSha256, record.businessRevision, record.target, record.executionMode, record.executionAccountLink],
    [digest, "br-1", "staging", "squash", "github:42"]);
  assert.ok(record.readAt.getTime() >= before && record.readAt.getTime() <= after, "read_at is Raft's receive time, not the App's 2026-10-21 read_at");
  assert.equal(record.expiresAt.getTime() - record.readAt.getTime(), 5 * 60_000);
  assert.equal(record.consumedByOperationId, null);
  const [attempt] = await db.select().from(linkCardAttempts);
  assert.deepEqual([attempt?.jti, attempt?.phase, attempt?.preparedActionId, attempt?.operationId, attempt?.outcome],
    [call.claims.jti, "prepare", call.body.prepared_action_id, null, "prepared"], "the attempt, recorded before sending");
  assert.equal((await db.select().from(linkCardHandleUses)).length, 0, "prepare never consumes the handle");
  assert.equal((await db.select().from(linkCardOperations)).length, 0, "and creates no operation");

  // Two prepares at once: two records, neither chosen for the user.
  const [a, b] = await Promise.all([prepare(app.baseUrl, fx, handle), prepare(app.baseUrl, fx, handle)]);
  assert.notEqual(a.body.prepared_action_id, b.body.prepared_action_id);
  assert.equal((await db.select().from(linkCardPreparedActions)).length, 3);

  // A handle with a minute left caps the record's lifetime (addendum 1 §6).
  const iat = Math.floor(Date.now() / 1000);
  const short = await prepare(app.baseUrl, fx, mergeHandle(fx, { iat, exp: iat + 60 }).handle);
  const [capped] = await db.select().from(linkCardPreparedActions).where(eq(linkCardPreparedActions.preparedActionId, short.body.prepared_action_id as string));
  assert.equal(capped?.expiresAt.getTime(), (iat + 60) * 1000);
});

test("execute consumes the prepared record the viewer confirmed: its digest, this handle, unexpired, once; prepared_action_id and the digest reach the App", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp((call) => (call.body.phase === "prepare" ? appAnswer({ status: "prepared", description: describe(call) }) : appAnswer({ status: "accepted" })));
  const merge = mergeHandle(fx);
  const prepared = (await prepare(app.baseUrl, fx, merge.handle)).body;
  const pair = { prepared_action_id: prepared.prepared_action_id, prepared_digest: prepared.prepared_digest };
  const refused = async (body: Record<string, unknown>, why: string) => {
    const res = await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), ...body });
    assert.equal(res.status, 410, `${why}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "PREPARED_INVALID", why);
  };
  await refused({ handle: merge.handle, ...pair, prepared_digest: "0".repeat(64) }, "another digest than the one shown");
  await refused({ handle: merge.handle, ...pair, prepared_action_id: randomUUID() }, "an unknown prepared record");
  const otherHandle = mergeHandle(fx);
  await refused({ handle: otherHandle.handle, ...pair }, "another handle's prepared record");
  assert.equal((await db.select().from(linkCardOperations)).length, 0, "each refusal rolled back");
  assert.equal(actionCalls(calls, fx).filter((call) => call.body.phase === "execute").length, 0);

  const res = await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: merge.handle, ...pair });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sent = actionCalls(calls, fx).find((call) => call.body.phase === "execute")!;
  assert.equal(sent.body.prepared_action_id, prepared.prepared_action_id);
  assert.equal(sent.body.prepared_digest, prepared.prepared_digest);
  const [record] = await db.select().from(linkCardPreparedActions).where(eq(linkCardPreparedActions.preparedActionId, prepared.prepared_action_id as string));
  assert.equal(record?.consumedByOperationId, res.body.operation_id);

  // Expired: prepared now, then past its expiry (moved back as time would).
  const late = mergeHandle(fx);
  const latePrepared = (await prepare(app.baseUrl, fx, late.handle)).body;
  const now = Date.now();
  await db.update(linkCardPreparedActions).set({ readAt: new Date(now - 6 * 60_000), expiresAt: new Date(now - 61_000) })
    .where(eq(linkCardPreparedActions.preparedActionId, latePrepared.prepared_action_id as string));
  await refused({ handle: late.handle, prepared_action_id: latePrepared.prepared_action_id, prepared_digest: latePrepared.prepared_digest }, "an expired prepared record");
});

test("prepare stores and signs nothing from a description with a C0-control key (K1), any schema violation, mismatched ids, a refusal or no answer", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  __setLinkCardActionHooksForTests({ budgetMs: 100 });
  const valid = (call: ActionCall) => JSON.stringify({ status: "prepared", description: describe(call) });
  const cases: [string, (call: ActionCall) => unknown, number, string][] = [
    ["K1: a description key \\u001b", (call) => valid(call).replace('"title":', '"\\u001b":"x","title":'), 502, "invalid"],
    ["a C0 key nested in terms", (call) => valid(call).replace('"terms":{', '"terms":{"a\\tb":"x",'), 502, "invalid"],
    ["a duplicate key", (call) => valid(call).replace('"title":"Merge PR #1"', '"title":"Merge PR #1","title":"Merge PR #2"'), 502, "invalid"],
    ["a lone surrogate", (call) => valid(call).replace("Merge PR #1", "Merge \\ud83d"), 502, "invalid"],
    ["a number in terms", (call) => appAnswer({ status: "prepared", description: describe(call, { terms: { n: 1 } }) }), 502, "invalid"],
    ["read_at not on a real date", (call) => appAnswer({ status: "prepared", description: describe(call, { read_at: "2026-02-30T12:00:00Z" }) }), 502, "invalid"],
    ["read_at with an offset", (call) => appAnswer({ status: "prepared", description: describe(call, { read_at: "2026-10-21T08:15:30+00:00" }) }), 502, "invalid"],
    ["an unknown description field", (call) => appAnswer({ status: "prepared", description: describe(call, { color: "red" }) }), 502, "invalid"],
    ["another prepared_action_id", (call) => appAnswer({ status: "prepared", description: describe(call, { prepared_action_id: randomUUID() }) }), 502, "invalid"],
    ["another action_id", (call) => appAnswer({ status: "prepared", description: describe(call, { action_id: "approve" }) }), 502, "invalid"],
    ["an unknown answer field", (call) => appAnswer({ status: "prepared", description: describe(call), card: {} }), 502, "invalid"],
    ["not JSON", () => "prepared", 502, "invalid"],
    ["no answer within the budget", () => new Promise(() => undefined), 502, "timeout"],
    ["a transport failure", () => { throw new Error("socket hang up"); }, 502, "failed"],
  ];
  for (const [name, answer, status, outcome] of cases) {
    const calls = stubApp(answer);
    const res = await prepare(app.baseUrl, fx, mergeHandle(fx).handle);
    assert.equal(res.status, status, `${name}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, "PREPARE_FAILED", name);
    assert.equal(actionCalls(calls, fx).length, 1, name);
    const [attempt] = await db.select().from(linkCardAttempts).where(eq(linkCardAttempts.preparedActionId, actionCalls(calls, fx)[0]!.body.prepared_action_id as string));
    assert.equal(attempt?.outcome, outcome, name);
  }
  assert.equal((await db.select().from(linkCardPreparedActions)).length, 0, "no prepared record from any of them");

  // A refusal: Raft's fixed hint, never the App's toast or code.
  stubApp(() => appAnswer({ status: "refused", code: "NOT_MERGEABLE", toast: { tone: "warning", text: "secret-repo#9 has conflicts" } }));
  const refused = await prepare(app.baseUrl, fx, mergeHandle(fx).handle);
  assert.deepEqual(refused.body, { status: "refused", toast: LINK_CARD_STATE_HINTS.refused });
  assert.equal((await db.select().from(linkCardPreparedActions)).length, 0);
});

test("prepare order: the handle (410), then requiresPrepare (400); the limit, the claim and the live state before any App call", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp((call) => appAnswer({ status: "prepared", description: describe(call) }));
  const expect = async (handle: string, status: number, code: string, why: string, businessRevision = "br-1") => {
    const res = await prepare(app.baseUrl, fx, handle, businessRevision);
    assert.equal(res.status, status, `${why}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.code, code, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  };
  await expect("v1.k1.garbage.mac", 410, "HANDLE_INVALID", "forged");
  const nowSeconds = Math.floor(Date.now() / 1000);
  await expect(handleFor(fx, { iat: nowSeconds - 700, exp: nowSeconds - 100 }).handle, 410, "HANDLE_INVALID", "expired, before the 400");
  await expect(handleFor(fx).handle, 400, "PREPARED_NOT_ALLOWED", "an undo action takes no confirmation");
  await expect(mergeHandle(fx).handle, 410, "HANDLE_INVALID", "a claim that is not the signed business revision", "br-2");
  await expect(mergeHandle(fx, { binding: { registrationRevision: randomUUID() } }).handle, 410, "HANDLE_INVALID", "a stale binding");
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: "proof_unavailable" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await expect(mergeHandle(fx).handle, 410, "HANDLE_INVALID", "suspended: no App call");
  await db.update(oauthAppLinkPreviews).set({ suspendedAt: null, suspendedReason: null, verifiedAt: new Date(Date.now() - 73 * 3600_000) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await expect(mergeHandle(fx).handle, 410, "HANDLE_INVALID", "proof older than 72 h: no App call");
  await db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date() }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await db.update(officialAppRegistry).set({ status: "disabled" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  await expect(mergeHandle(fx).handle, 410, "PROVIDER_NOT_ELIGIBLE", "not official any more");
  await db.update(officialAppRegistry).set({ status: "approved" }).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  assert.equal(actionCalls(calls, fx).length, 0);

  // Its own budget of 30 a minute, spent before the live check.
  __resetLinkCardActionLimitsForTests();
  for (let i = 0; i < LINK_CARD_PREPARE_PER_MINUTE; i++) {
    await expect(mergeHandle(fx, { binding: { registrationRevision: randomUUID() } }).handle, 410, "HANDLE_INVALID", `stale ${i}`);
  }
  const over = await prepare(app.baseUrl, fx, mergeHandle(fx).handle);
  assert.equal(over.status, 429); assert.equal(over.body.code, "RATE_LIMITED");
  assert.equal(over.headers.get("retry-after"), String(over.body.retry_after));
  assert.equal((await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle })).status, 200,
    "execute keeps its own budget");
});

test("prepare bodies are strict, own fields only, and refused above 16 KiB before parsing", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp((call) => appAnswer({ status: "prepared", description: describe(call) }));
  const { handle } = mergeHandle(fx);
  const bad: [unknown, string][] = [
    [{}, "empty"],
    [{ handle }, "no claimed"],
    [{ handle, claimed: {} }, "no business_revision"],
    [{ handle, claimed: { business_revision: "" } }, "an empty business_revision"],
    [{ handle, claimed: { business_revision: "br-1", extra: 1 } }, "an unknown claimed field"],
    [{ handle, claimed: { business_revision: "br-1" }, locale: "en" }, "an unknown field"],
    [{ handle: 7, claimed: { business_revision: "br-1" } }, "a handle that is not a string"],
    [`{"__proto__":{"business_revision":"br-1"},"handle":"${handle}","claimed":{"business_revision":"br-1"}}`, "a __proto__ key"],
    [`{"handle":"${handle}","claimed":{"business_revision":"br-1"},"claimed":{"business_revision":"br-1"}`, "broken JSON"],
    ["[]", "an array"],
  ];
  for (const [body, why] of bad) {
    const res = await post(app.baseUrl, "prepare", fx, body);
    assert.equal(res.status, 400, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  const huge = await post(app.baseUrl, "prepare", fx, { handle, claimed: { business_revision: "br-1" }, pad: "x".repeat(17 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal(actionCalls(calls, fx).length, 0);
});
