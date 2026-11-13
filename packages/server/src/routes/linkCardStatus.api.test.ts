import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { and, desc, eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import { tokenForHuman } from "../test/integration/credentials";
import type { Database } from "../db";
import {
  linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews, messages,
  oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, officialAppRegistry,
} from "../db/schema";
import { addHuman } from "../services/channelService";
import { addMember } from "../services/serverService";
import { __settleAppLinkPreviewRechecksForTests, __setPreviewHttpForTests } from "../services/appLinkPreviewService";
import { __resetLinkCardActionLimitsForTests, admitLinkCardAction, LINK_CARD_LOOKUP_PER_MINUTE, LINK_CARD_STATUS_PER_MINUTE } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests, LINK_CARD_STATE_HINTS } from "../services/linkCardActionService";
import { __setLinkCardReceiptHooksForTests, LINK_CARD_LOOKUP_PAGE_SIZE } from "../services/linkCardReceiptService";
import { linkCardActionEndpointSha256, linkCardUrlSha256 } from "../services/linkCardTokens";
import { createOAuthClient } from "../services/oauthService";
import { oidcIssuer } from "../services/oidcService";
import {
  appAnswer, cardFixture, executedOperation, lookupOperations, receiptHints, recordEmits, statusOf, stubApp, type CardFixture,
} from "../test/linkCardActionFixture";

// After the send (RFC 076 §6.4, rules 6-8; protocol v3.2.3 §5.4, §7.4, §8.1,
// §8.2 (2)-(3)): POST /api/link-cards/status, its forward to the App and the
// two gates for an App's private result, and GET /api/link-cards/operations
// by id, by client request id and by message + URL with a signed cursor. Real
// HTTP and an isolated PGlite; the App is the substituted preview transport.
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
  __setLinkCardReceiptHooksForTests(null);
  __resetLinkCardActionLimitsForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
/** The fixed hints as defined, copied before any request runs. */
const HINTS = structuredClone(LINK_CARD_STATE_HINTS) as Record<string, { tone: string; text: string }>;
const actionCalls = <T extends { url: string }>(calls: T[], fx: CardFixture) => calls.filter((call) => call.url === fx.actionEndpoint);
const opRow = async (db: Database, operationId: string) =>
  (await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, operationId)))[0]!;
const receipt = (operationId: string, state: string, receiptRevision: number) => ({ operation_id: operationId, state, receipt_revision: receiptRevision, hint: HINTS[state] });
const roomOf = (fx: CardFixture) => `user:${fx.owner.id}:server:${fx.server.id}`;
/** Every link_card_* row, as text: what Raft stores, to show nothing private is. */
async function storedRows(db: Database) {
  const tables = [linkCardOperations, linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews];
  return JSON.stringify(await Promise.all(tables.map((table) => db.select().from(table))));
}
/** An operation written directly, at `createdAt` or `secondsAgo` before now (whole second). */
async function insertOperation(db: Database, fx: CardFixture, input: Partial<typeof linkCardOperations.$inferInsert> & { secondsAgo?: number } = {}) {
  const { secondsAgo = 60, createdAt: at, ...extra } = input;
  const createdAt = at ?? new Date(Math.floor((Date.now() - secondsAgo * 1000) / 1000) * 1000);
  const [row] = await db.insert(linkCardOperations).values({
    operationId: randomUUID(), viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app", providerKey: fx.client.clientId, installationKey: fx.install.id,
    registrationRevision: fx.registration.revision, viewNonce: randomUUID(), messageId: fx.message.id, urlSha256: linkCardUrlSha256(fx.url),
    actionEndpointSha256: linkCardActionEndpointSha256(fx.actionEndpoint), actionOrigin: fx.origin, actionId: "approve", requestSha256: "0".repeat(64),
    state: "accepted", createdAt, firstSendDeadline: new Date(createdAt.getTime() + 600_000), ...extra,
  }).returning();
  return row!;
}
/** Another human of the fixture's Server, in its channel and consented to its App. */
async function otherViewer(db: Database, seed: Parameters<typeof cardFixture>[1], fx: CardFixture) {
  const human = await seed.human();
  await addMember(fx.server.id, human.id, "member");
  await addHuman(fx.channel.id, human.id);
  await db.insert(oauthUserConsents).values({ serverId: fx.server.id, userId: human.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
  return { human, headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(human.email)}` } };
}

test("status forwards phase status to where the execute went, signed for the operation's own executor; the App's answer moves the state forward only, and its toast is shown only from that request", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const emits = recordEmits(app.io);
  const op = await executedOperation(app.baseUrl, fx);
  assert.equal(op.state, "unknown");
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  const toast = { tone: "success", text: "Approved PR #1 in private-repo" };
  let reply: Record<string, unknown> = { status: "executing", toast, code: "APPROVING", attribution: "alice@private-repo" };
  const calls = stubApp(() => appAnswer(reply));

  const first = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(first.body, { ...receipt(op.operationId, "accepted", 2), app_result: { toast, code: "APPROVING", attribution: "alice@private-repo" } },
    "unknown -> accepted on executing; the App's result passed both gates in this request");
  const [call, ...more] = actionCalls(calls, fx);
  assert.ok(call); assert.equal(more.length, 0);
  assert.equal(call.raw, JSON.stringify({ version: 2, phase: "status", operation_id: op.operationId, locale: "zh-CN" }), "no URL, no token, no client_request_id");
  assert.deepEqual(call.options, { response: "text", acceptLanguage: "zh-CN", timeoutMs: 2500 }, "the 2.5 s budget, raw text for the strict parser");
  assert.equal(call.header.typ, "raft-card-action+jwt");
  const [attempt] = await db.select().from(linkCardAttempts).where(and(eq(linkCardAttempts.operationId, op.operationId), eq(linkCardAttempts.phase, "status")));
  assert.ok(attempt, "the status attempt is recorded before anything is sent");
  assert.equal(attempt.outcome, "answered:executing");
  assert.deepEqual({ ...call.claims, iat: 0, nbf: 0, exp: 0 }, {
    iss: oidcIssuer(undefined, fx.server.id), aud: `urn:raft:card-action:${fx.client.clientId}`, sub: fx.owner.id, iat: 0, nbf: 0, exp: 0,
    jti: attempt.jti, token_use: "card_action", type: "human", phase: "status", server_id: fx.server.id, server_role: "owner",
    installation_id: fx.install.id, message_id: fx.message.id, url_sha256: linkCardUrlSha256(fx.url), body_sha256: sha256(call.raw),
  }, "sub is the operation's executor; the original installation, message and URL digest");
  assert.ok(Number(call.claims.exp) - Number(call.claims.iat) <= 30);
  assert.ok((await opRow(db, op.operationId)).lastStatusAt, "last_status_at moves with each forward");

  reply = { status: "done", toast: { tone: "success", text: "Merged" } };
  const second = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual(second.body, { ...receipt(op.operationId, "done", 3), app_result: { toast: { tone: "success", text: "Merged" } } });
  const [view] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, op.claims.viewNonce));
  assert.equal(view?.pendingOperationId, null, "a terminal answer releases the view on the expected id");

  for (const late of ["accepted", "executing", "refused", "unknown"]) {
    reply = { status: late };
    const again = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.deepEqual(again.body, receipt(op.operationId, "done", 3), `a late ${late} never moves a terminal state`);
  }
  assert.equal(actionCalls(calls, fx).length, 6, "terminal operations are still forwarded: their private result needs the App");

  // Inside the forward interval the records answer, without the App and with nothing private.
  __setLinkCardReceiptHooksForTests(null);
  const records = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual(records.body, receipt(op.operationId, "done", 3));
  assert.equal(actionCalls(calls, fx).length, 6);

  const hints = receiptHints(emits);
  assert.deepEqual(hints.map((hint) => [hint.room, hint.payload]), [
    [roomOf(fx), { operation_id: op.operationId, receipt_revision: 1 }],
    [roomOf(fx), { operation_id: op.operationId, receipt_revision: 2 }],
    [roomOf(fx), { operation_id: op.operationId, receipt_revision: 3 }],
  ], "one hint per receipt change (execute, then each status that moved it), to the viewer's own room, with no content");
});

test("the App's private result needs both gates in the same request: never when the App says not_visible or the viewer lost access meanwhile, never replayed from Raft's records, never stored", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx, { status: "accepted", toast: { tone: "success", text: "secret-sync-toast" } });
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  const secret = { tone: "success", text: "secret-status-toast" };
  let reply: Record<string, unknown> = { status: "not_visible", toast: secret, code: "SECRET_CODE" };
  const calls = stubApp(() => appAnswer(reply));

  const hidden = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual(hidden.body, receipt(op.operationId, "accepted", 1), "not_visible: the App's object-read check failed; nothing private, nothing moves");

  // The viewer's consent is revoked while the App is being asked: the answer is
  // still recorded (recording is separate from showing), nothing private is shown.
  reply = { status: "done", toast: secret, attribution: "secret-attribution" };
  __setLinkCardReceiptHooksForTests({
    forwardIntervalMs: 0,
    afterStatusAnswer: async () => { await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.userId, fx.owner.id)); },
  });
  const lost = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual(lost.body, receipt(op.operationId, "done", 2));
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  assert.deepEqual((await statusOf(app.baseUrl, fx, { operation_id: op.operationId })).body, { operation_id: op.operationId, state: "not_visible" });
  await db.update(oauthUserConsents).set({ revokedAt: null }).where(eq(oauthUserConsents.userId, fx.owner.id));

  // Raft's own records never replay one: not the lookup, not execute's recovery.
  const byId = await lookupOperations(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual(byId.body, { operations: [receipt(op.operationId, "done", 2)], next_cursor: null });
  const stored = await storedRows(db);
  for (const text of ["secret-sync-toast", "secret-status-toast", "SECRET_CODE", "secret-attribution"]) assert.ok(!stored.includes(text), `Raft stores no App text (${text})`);
  assert.equal(actionCalls(calls, fx).length, 2);
});

test("an App status answer that is not exactly the schema, or none in time, moves nothing and shows nothing private", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx);
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  __setLinkCardActionHooksForTests({ budgetMs: 100 });
  const cases: [string, () => unknown, string][] = [
    ["an unknown field", () => appAnswer({ status: "done", card: {} }), "invalid_answer"],
    ["a C0-control key", () => '{"status":"done","\\u001b":"x"}', "invalid_answer"],
    ["a duplicate key", () => '{"status":"unknown","status":"done"}', "invalid_answer"],
    ["a toast tone outside the protocol", () => appAnswer({ status: "done", toast: { tone: "error", text: "x" } }), "invalid_answer"],
    ["a toast over 200 code points", () => appAnswer({ status: "done", toast: { tone: "info", text: "x".repeat(201) } }), "invalid_answer"],
    ["a code over 64", () => appAnswer({ status: "done", code: "C".repeat(65) }), "invalid_answer"],
    ["an empty attribution", () => appAnswer({ status: "done", attribution: "" }), "invalid_answer"],
    ["Raft's own state as an answer", () => appAnswer({ status: "needs_reconciliation" }), "invalid_answer"],
    ["an unknown status", () => appAnswer({ status: "maybe" }), "invalid_answer"],
    ["not JSON", () => "done", "invalid_answer"],
    ["no answer within the budget", () => new Promise(() => undefined), "timeout"],
    ["a transport failure", () => { throw new Error("socket hang up"); }, "transport_error"],
  ];
  for (const [name, reply, outcome] of cases) {
    const calls = stubApp(reply);
    const res = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.deepEqual(res.body, receipt(op.operationId, "unknown", 1), name);
    assert.equal(actionCalls(calls, fx).length, 1, name);
    const [attempt] = await db.select().from(linkCardAttempts).where(and(eq(linkCardAttempts.operationId, op.operationId), eq(linkCardAttempts.phase, "status")))
      .orderBy(desc(linkCardAttempts.sentAt)).limit(1);
    assert.equal(attempt?.outcome, outcome, name);
  }
});

test("status checks the viewer's live access only: never 410; eligibility revoked and a paths-only re-registration still forward; lost access is not_visible and forwards nothing; another viewer's operation is 404", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx, { status: "accepted" });
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  const calls = stubApp(() => appAnswer({ status: "accepted" }));
  const forwarded = async (why: string) => {
    const before = actionCalls(calls, fx).length;
    const res = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.deepEqual(res.body, receipt(op.operationId, "accepted", 1), why);
    assert.equal(actionCalls(calls, fx).length, before + 1, `${why}: forwarded`);
  };
  await forwarded("baseline");
  await db.delete(officialAppRegistry).where(eq(officialAppRegistry.oauthClientId, fx.client.id));
  await forwarded("official eligibility revoked");
  // T2: a change to paths alone moves the revision but keeps the endpoint and
  // origin, so the operation is not pushed into reconciliation.
  await db.update(oauthAppLinkPreviews).set({ paths: ["/pr", "/issues"], revision: randomUUID() as typeof fx.registration.revision }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await forwarded("a new revision with the same approved endpoint and origin");

  const hidden = async (why: string, change: () => Promise<unknown>, restore: () => Promise<unknown>) => {
    await change();
    const before = calls.length;
    const res = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.equal(res.status, 200, why);
    assert.deepEqual(res.body, { operation_id: op.operationId, state: "not_visible" }, why);
    assert.equal(calls.length, before, `${why}: nothing forwarded`);
    await restore();
    await forwarded(`${why}, restored`);
  };
  await hidden("consent revoked",
    () => db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.userId, fx.owner.id)),
    () => db.update(oauthUserConsents).set({ revokedAt: null }).where(eq(oauthUserConsents.userId, fx.owner.id)));
  await hidden("previews declined",
    () => db.insert(oauthLinkPreviewDeclines).values({ userId: fx.owner.id, serverId: fx.server.id, clientId: fx.client.id }),
    () => db.delete(oauthLinkPreviewDeclines).where(eq(oauthLinkPreviewDeclines.userId, fx.owner.id)));
  await hidden("the App uninstalled",
    () => db.delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, fx.install.id)),
    () => db.insert(oauthClientInstalls).values(fx.install));
  await hidden("the App disabled",
    () => db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, fx.client.id)),
    () => db.update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, fx.client.id)));
  const outsider = await seed.human();
  await addMember(fx.server.id, outsider.id, "member");
  const privateChannel = await seed.channel({ server: fx.server, members: [outsider], visibility: "private" });
  await hidden("the message no longer readable by the viewer",
    () => db.update(messages).set({ channelId: privateChannel.id }).where(eq(messages.id, fx.message.id)),
    () => db.update(messages).set({ channelId: fx.channel.id }).where(eq(messages.id, fx.message.id)));

  const other = await otherViewer(db, seed, fx);
  const before = calls.length;
  const statuses = [
    await statusOf(app.baseUrl, other, { operation_id: op.operationId }),
    await statusOf(app.baseUrl, fx, { operation_id: randomUUID() }),
  ];
  const elsewhere = await seed.server({ owner: fx.owner });
  statuses.push(await statusOf(app.baseUrl, { headers: { ...fx.headers, "X-Server-Id": elsewhere.id } }, { operation_id: op.operationId }));
  assert.deepEqual(statuses.map((res) => [res.status, res.body.code]), [[404, "NOT_FOUND"], [404, "NOT_FOUND"], [404, "NOT_FOUND"]],
    "another viewer's operation, none, and the viewer's own on another Server look the same");
  assert.equal(calls.length, before);
});

test("status goes only to the endpoint the execute went to, while it is approved and in force for the operation's own App; otherwise nothing is sent anywhere and accepted/unknown become needs_reconciliation", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const emits = recordEmits(app.io);
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  const restore = () => db.update(oauthAppLinkPreviews).set({
    origin: fx.origin, actionEndpoint: fx.actionEndpoint, pendingActionEndpoint: null, pendingActionEndpointRequestedAt: null,
    suspendedAt: null, suspendedReason: null, verifiedAt: new Date(),
  }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const cases: [string, "accepted" | "unknown", () => Promise<unknown>][] = [
    ["a different approved action endpoint", "accepted",
      () => db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${fx.origin}/v2/card-actions` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id))],
    ["only a pending (unreviewed) endpoint", "unknown",
      () => db.update(oauthAppLinkPreviews).set({ actionEndpoint: null, pendingActionEndpoint: fx.actionEndpoint, pendingActionEndpointRequestedAt: new Date() })
        .where(eq(oauthAppLinkPreviews.clientId, fx.client.id))],
    ["the registration suspended", "accepted",
      () => db.update(oauthAppLinkPreviews).set({ suspendedAt: new Date(), suspendedReason: "proof_unavailable" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id))],
    ["the origin's proof older than 72 h", "unknown",
      () => db.update(oauthAppLinkPreviews).set({ verifiedAt: new Date(Date.now() - 73 * 3600_000) }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id))],
  ];
  for (const [why, start, change] of cases) {
    const op = await executedOperation(app.baseUrl, fx, { status: start });
    await change();
    const calls = stubApp(() => appAnswer({ status: "done" }));
    const res = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.deepEqual(res.body, receipt(op.operationId, "needs_reconciliation", 2), why);
    assert.equal(calls.length, 0, `${why}: credentials go nowhere`);
    assert.deepEqual(receiptHints(emits).at(-1)?.payload, { operation_id: op.operationId, receipt_revision: 2 }, `${why}: hinted`);
    const again = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.deepEqual(again.body, receipt(op.operationId, "needs_reconciliation", 2), `${why}: stays, still not forwarded`);
    assert.equal(calls.length, 0);
    await restore();
    // Back in force: status leaves reconciliation with the App's verified terminal answer (protocol §13.3 exit 1).
    const exit = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
    assert.deepEqual(exit.body, receipt(op.operationId, "done", 3), `${why}: the reconciliation exit`);
    assert.equal(actionCalls(calls, fx).length, 1);
  }

  // The registration deleted.
  const deleted = await executedOperation(app.baseUrl, fx, { status: "accepted" });
  const [registration] = await db.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, fx.client.id)).returning();
  let calls = stubApp(() => appAnswer({ status: "done" }));
  assert.deepEqual((await statusOf(app.baseUrl, fx, { operation_id: deleted.operationId })).body, receipt(deleted.operationId, "needs_reconciliation", 2));
  assert.equal(calls.length, 0);
  // Back as it was (a test shortcut: a real re-registration would get a new revision and void the fixture's handles).
  await db.insert(oauthAppLinkPreviews).values(registration!);

  // The origin taken over by another App, registered with the very
  // same action endpoint URL. The old owner's operation is never asked about at
  // the new owner's endpoint: its own App has no registration in force.
  const taken = await executedOperation(app.baseUrl, fx, { status: "unknown" });
  const { client: newOwner } = await createOAuthClient({ serverId: fx.server.id, createdByUserId: fx.owner.id, clientId: `taker-${randomUUID().slice(0, 8)}`, name: "Taker" });
  await db.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  await db.insert(oauthAppLinkPreviews).values({ clientId: newOwner.id, origin: fx.origin, endpoint: `${fx.origin}/callback`, paths: ["/pr"], actionEndpoint: fx.actionEndpoint });
  calls = stubApp(() => appAnswer({ status: "done" }));
  assert.deepEqual((await statusOf(app.baseUrl, fx, { operation_id: taken.operationId })).body, receipt(taken.operationId, "needs_reconciliation", 2));
  assert.equal(calls.length, 0, "nothing is sent to the new owner's endpoint, even at the same URL");
});

test("sent, resolved_manually and never-dispatched operations are answered from Raft's records without the App", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  const calls = stubApp(() => appAnswer({ status: "done" }));
  await db.update(oauthAppLinkPreviews).set({ actionEndpoint: `${fx.origin}/v2/card-actions` }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const sent = await insertOperation(db, fx, { state: "sent" });
  const neverSent = await insertOperation(db, fx, { state: "failed_not_sent" });
  const unsentAccepted = await insertOperation(db, fx, { state: "accepted" });
  const manual = await insertOperation(db, fx, { state: "resolved_manually", resolvedByUserId: fx.owner.id, resolutionReason: "checked by hand", resolvedAt: new Date() });
  for (const [row, state] of [[sent, "sent"], [neverSent, "failed_not_sent"], [unsentAccepted, "accepted"], [manual, "resolved_manually"]] as const) {
    const res = await statusOf(app.baseUrl, fx, { operation_id: row.operationId });
    assert.deepEqual(res.body, receipt(row.operationId, state, 0), `${state}: from the records, unmoved even with the endpoint changed`);
  }
  assert.equal(calls.length, 0);
});

test("lookups by operation_id and client_request_id: the viewer's own operations on this Server only, any state, ids and coarse state only; calls no App and writes nothing", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const done = await executedOperation(app.baseUrl, fx, { status: "done", toast: { tone: "success", text: "secret" } });
  const open = await executedOperation(app.baseUrl, fx, { status: "accepted" });
  const calls = stubApp(() => appAnswer({ status: "done" }));
  const before = await storedRows(db);

  assert.deepEqual((await lookupOperations(app.baseUrl, fx, { operation_id: done.operationId })).body, { operations: [receipt(done.operationId, "done", 1)], next_cursor: null });
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, { client_request_id: open.clientRequestId })).body, { operations: [receipt(open.operationId, "accepted", 1)], next_cursor: null });
  const other = await otherViewer(db, seed, fx);
  const notTheirs = await lookupOperations(app.baseUrl, other, { operation_id: done.operationId });
  assert.deepEqual([notTheirs.status, notTheirs.body.code], [404, "NOT_FOUND"]);
  assert.deepEqual((await lookupOperations(app.baseUrl, other, { client_request_id: open.clientRequestId })).body, { operations: [], next_cursor: null },
    "the same request id from another viewer names nothing of the first");
  assert.equal((await lookupOperations(app.baseUrl, fx, { operation_id: randomUUID() })).status, 404);

  await db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.userId, fx.owner.id));
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, { operation_id: done.operationId })).body, { operations: [{ operation_id: done.operationId, state: "not_visible" }], next_cursor: null });
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, { client_request_id: open.clientRequestId })).body, { operations: [{ state: "not_visible" }], next_cursor: null },
    "like execute's recovery: not_visible without the id");
  assert.equal(calls.length, 0, "no App is called");
  await db.update(oauthUserConsents).set({ revokedAt: null }).where(eq(oauthUserConsents.userId, fx.owner.id));
  assert.equal(await storedRows(db), before, "nothing is written");
});

test("lookup by message and URL: open operations of the identity domain the link matches now, 20 per page ascending by (created_at, operation_id) with ties, a signed cursor, no duplicates or gaps", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const calls = stubApp(() => appAnswer({ status: "done" }));
  const base = Math.floor(Date.now() / 1000) - 3600;
  const expected: string[] = [];
  for (let i = 0; i < 45; i++) {
    const state = (["sent", "accepted", "unknown", "needs_reconciliation"] as const)[i % 4];
    const row = await insertOperation(db, fx, { state, createdAt: new Date((base + Math.floor(i / 3)) * 1000) });
    expected.push(`${row.createdAt.getTime()}|${row.operationId}`);
  }
  expected.sort((a, b) => {
    const [ta, ia] = a.split("|"); const [tb, ib] = b.split("|");
    return Number(ta) - Number(tb) || (ia! < ib! ? -1 : ia! > ib! ? 1 : 0);
  });
  // Never listed: terminal operations, another viewer's, another link's, another installation's.
  for (const state of ["done", "refused", "failed_not_sent"] as const) await insertOperation(db, fx, { state });
  const other = await otherViewer(db, seed, fx);
  await insertOperation(db, fx, { viewerId: other.human.id });
  await insertOperation(db, fx, { urlSha256: linkCardUrlSha256(`${fx.origin}/pr/2`) });
  await insertOperation(db, fx, { installationKey: randomUUID() });
  const before = await storedRows(db);

  const query = { message_id: fx.message.id, url_sha256: linkCardUrlSha256(fx.url) };
  const seen: string[] = [];
  const cursors: string[] = [];
  let cursor: string | null = null;
  for (const size of [LINK_CARD_LOOKUP_PAGE_SIZE, LINK_CARD_LOOKUP_PAGE_SIZE, 5]) {
    const res = await lookupOperations(app.baseUrl, fx, cursor ? { ...query, cursor } : query);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const items = res.body.operations as { operation_id: string; state: string; receipt_revision: number; hint: unknown }[];
    assert.equal(items.length, size);
    for (const item of items) {
      assert.deepEqual(Object.keys(item).sort(), ["hint", "operation_id", "receipt_revision", "state"]);
      assert.deepEqual(item.hint, HINTS[item.state]);
      const row = await opRow(db, item.operation_id);
      seen.push(`${row.createdAt.getTime()}|${row.operationId}`);
    }
    cursor = res.body.next_cursor as string | null;
    if (cursor) cursors.push(cursor);
  }
  assert.equal(cursor, null, "the last page has no cursor");
  assert.deepEqual(seen, expected, "every open operation once, in order");
  assert.equal(cursors.length, 2);
  assert.equal(calls.length, 0, "no App is called");
  assert.equal(await storedRows(db), before, "nothing is written");

  assert.equal(((await lookupOperations(app.baseUrl, fx, query)).body.operations as unknown[]).length, LINK_CARD_LOOKUP_PAGE_SIZE);
});

test("lookup by message and URL pages through more than a page of operations created in the same second with no duplicates or gaps (created_at is whole seconds by CHECK, so the seconds cursor plus operation_id is exact)", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  stubApp(() => appAnswer({ status: "done" }));
  const second = new Date((Math.floor(Date.now() / 1000) - 600) * 1000);
  const expected: string[] = [];
  for (let i = 0; i < LINK_CARD_LOOKUP_PAGE_SIZE + 5; i++) expected.push((await insertOperation(db, fx, { state: "accepted", createdAt: second })).operationId);
  expected.sort();
  const query = { message_id: fx.message.id, url_sha256: linkCardUrlSha256(fx.url) };
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const res = await lookupOperations(app.baseUrl, fx, cursor ? { ...query, cursor } : query);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    for (const item of res.body.operations as { operation_id: string }[]) seen.push(item.operation_id);
    cursor = res.body.next_cursor as string | null;
    pages++;
  } while (cursor && pages < 5);
  assert.equal(pages, 2, "two pages, then no cursor");
  assert.deepEqual(seen, expected, "every operation once, by operation_id within the second");
});

test("lookup by message and URL is re-authorized on every page and its cursor is bound: tampered, another link, message or viewer, or a changed identity domain is 400; lost read access is an empty page; a link matching no provider lists nothing but ids still work", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const ops = [];
  for (let i = 0; i < LINK_CARD_LOOKUP_PAGE_SIZE + 2; i++) ops.push(await insertOperation(db, fx, { secondsAgo: 100 - i }));
  const query = { message_id: fx.message.id, url_sha256: linkCardUrlSha256(fx.url) };
  const first = await lookupOperations(app.baseUrl, fx, query);
  const cursor = first.body.next_cursor as string;
  assert.ok(cursor);
  const page2 = await lookupOperations(app.baseUrl, fx, { ...query, cursor });
  assert.equal((page2.body.operations as unknown[]).length, 2);

  const [v, kid, payload, mac] = cursor.split(".");
  const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as Record<string, unknown>;
  const forged = `${v}.${kid}.${Buffer.from(JSON.stringify({ ...claims, lastCreatedAt: 0 })).toString("base64url")}.${mac}`;
  const other = await otherViewer(db, seed, fx);
  const refusals: [string, Promise<{ status: number; body: Record<string, unknown> }>][] = [
    ["a tampered cursor", lookupOperations(app.baseUrl, fx, { ...query, cursor: forged })],
    ["garbage", lookupOperations(app.baseUrl, fx, { ...query, cursor: "not-a-cursor" })],
    ["another link", lookupOperations(app.baseUrl, fx, { ...query, url_sha256: linkCardUrlSha256(`${fx.origin}/pr/2`), cursor })],
    ["another message", lookupOperations(app.baseUrl, fx, { ...query, message_id: randomUUID(), cursor })],
    ["another viewer", lookupOperations(app.baseUrl, other, { ...query, cursor })],
  ];
  for (const [why, pending] of refusals) {
    const res = await pending;
    assert.deepEqual([res.status, res.body.code], [400, "INVALID_CURSOR"], why);
  }

  // Read access lost between pages: the next page is empty, not an error.
  const outsider = await seed.human();
  await addMember(fx.server.id, outsider.id, "member");
  const privateChannel = await seed.channel({ server: fx.server, members: [outsider], visibility: "private" });
  await db.update(messages).set({ channelId: privateChannel.id }).where(eq(messages.id, fx.message.id));
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, { ...query, cursor })).body, { operations: [], next_cursor: null });
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, query)).body, { operations: [], next_cursor: null });
  await db.update(messages).set({ channelId: fx.channel.id }).where(eq(messages.id, fx.message.id));

  // The link's paths no longer match the App: nothing is listed, ids still answer (protocol case 92).
  await db.update(oauthAppLinkPreviews).set({ paths: ["/issues"] }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, query)).body, { operations: [], next_cursor: null });
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, { operation_id: ops[0]!.operationId })).body.operations, [receipt(ops[0]!.operationId, "accepted", 0)]);
  await db.update(oauthAppLinkPreviews).set({ paths: ["/pr"] }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));

  // Reinstalled (a new installation id): the link now matches another identity
  // domain. The old cursor is 400 and the old operations are not listed under the new one.
  await db.delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, fx.install.id));
  await db.insert(oauthClientInstalls).values({ clientId: fx.client.id, serverId: fx.server.id, installedByUserId: fx.owner.id });
  const changed = await lookupOperations(app.baseUrl, fx, { ...query, cursor });
  assert.deepEqual([changed.status, changed.body.code], [400, "INVALID_CURSOR"]);
  assert.deepEqual((await lookupOperations(app.baseUrl, fx, query)).body, { operations: [], next_cursor: null });
});

test("receipt hints reach only the viewer's own sockets on that Server, as { operation_id, receipt_revision }", async ({ app, db, seed }) => {
  const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
  const { io: clientIo } = requireWeb("socket.io-client") as { io: (url: string, options: Record<string, unknown>) => any };
  const fx = await cardFixture(db, seed);
  const other = await otherViewer(db, seed, fx);
  const op = await executedOperation(app.baseUrl, fx);
  const connect = async (token: string) => {
    const socket = clientIo(app.baseUrl, { auth: { token, serverId: fx.server.id, clientKind: "web" }, transports: ["websocket"], autoConnect: false });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no rooms:joined")), 4000);
      socket.once("rooms:joined", () => { clearTimeout(timer); resolve(); });
    });
    socket.connect();
    await ready;
    return socket;
  };
  const viewer = await connect(await tokenForHuman(fx.owner.email));
  const bystander = await connect(await tokenForHuman(other.human.email));
  try {
    const got: unknown[] = [];
    const leaked: unknown[] = [];
    viewer.on("link_card.operation_changed", (payload: unknown) => got.push(payload));
    bystander.on("link_card.operation_changed", (payload: unknown) => leaked.push(payload));
    __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
    stubApp(() => appAnswer({ status: "done", toast: { tone: "success", text: "secret" } }));
    assert.equal((await statusOf(app.baseUrl, fx, { operation_id: op.operationId })).body.state, "done");
    const deadline = Date.now() + 3000;
    while (got.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(got, [{ operation_id: op.operationId, receipt_revision: 2 }]);
    assert.deepEqual(leaked, [], "another member of the Server hears nothing");
  } finally {
    viewer.close();
    bystander.close();
  }
});

test("one live-state module: the receipt and update services and the routes never compare bindings themselves", () => {
  for (const file of ["../services/linkCardReceiptService.ts", "../services/linkCardUpdateService.ts", "./linkCards.ts", "./oauth.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const tool of ["messageContentSha256", "matchesAppPreview", "registeredApps(", "messagePreviewUrls(", "appLinkReadUrls(", "isApprovedOfficialAppClient",
      "linkCardMessageContentSha256", "oauthAppLinkPreviews", "oauthClientInstalls", "oauthUserConsents", "linkCardActionEndpointSha256"]) {
      assert.ok(!source.includes(tool), `${file} must leave "${tool}" to linkCardLiveState.ts`);
    }
  }
  const receiptSource = readFileSync(new URL("../services/linkCardReceiptService.ts", import.meta.url), "utf8");
  assert.equal(receiptSource.match(/linkCardStatusTargetInForce\(/g)?.length, 1, "one forwarding decision");
  assert.equal(receiptSource.match(/matchLinkCardUrlIdentity\(\{/g)?.length, 1, "one URL match");
});

test("execute and status name the id the App last proved in its domain file, not its current one (RFC 084 §4)", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  await db.update(oauthAppLinkPreviews).set({ provedClientKey: "proved-old-id" }).where(eq(oauthAppLinkPreviews.clientId, fx.client.id));
  const op = await executedOperation(app.baseUrl, fx);
  assert.equal(op.executeClaims.aud, "urn:raft:card-action:proved-old-id");
  assert.equal((await opRow(db, op.operationId)).providerKey, fx.client.clientId, "the row itself carries the current id");
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  const calls = stubApp(() => appAnswer({ status: "executing" }));
  const status = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(actionCalls(calls, fx)[0]!.claims.aud, "urn:raft:card-action:proved-old-id");
});

test("limits: 120 statuses and 120 lookups per viewer per Server per minute, separately; past either, 429 with Retry-After", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await insertOperation(db, fx, { state: "sent" });
  for (let i = 1; i < LINK_CARD_STATUS_PER_MINUTE; i++) assert.deepEqual(await admitLinkCardAction("status", fx.owner.id, fx.server.id), { admitted: true });
  assert.equal((await statusOf(app.baseUrl, fx, { operation_id: op.operationId })).status, 200, "the 120th");
  const over = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual([over.status, over.body.code], [429, "RATE_LIMITED"]);
  assert.equal(over.headers.get("retry-after"), String(over.body.retry_after));
  assert.equal(over.headers.get("cache-control"), "private, no-store");
  assert.equal((await lookupOperations(app.baseUrl, fx, { operation_id: op.operationId })).status, 200, "lookups have their own budget");
  for (let i = 2; i < LINK_CARD_LOOKUP_PER_MINUTE; i++) await admitLinkCardAction("lookup", fx.owner.id, fx.server.id);
  assert.equal((await lookupOperations(app.baseUrl, fx, { operation_id: op.operationId })).status, 200);
  const lookupOver = await lookupOperations(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual([lookupOver.status, lookupOver.body.code], [429, "RATE_LIMITED"]);
  assert.ok(Number(lookupOver.headers.get("retry-after")) >= 1);
});

test("status bodies and lookup queries are strict: own fields only, one form of query, refused above 4 KiB before parsing; no session is 401", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await insertOperation(db, fx, { state: "sent" });
  for (const [body, why] of [
    [{}, "empty"], [{ operation_id: "op-1" }, "not a UUID"], [{ operation_id: op.operationId, extra: 1 }, "an unknown field"],
    [`{"__proto__":{"x":1},"operation_id":"${op.operationId}"}`, "a __proto__ key"], [[{ operation_id: op.operationId }], "an array"], ["nope", "not JSON"],
  ] as [unknown, string][]) {
    const res = await statusOf(app.baseUrl, fx, body);
    assert.equal(res.status, 400, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  const huge = await statusOf(app.baseUrl, fx, { operation_id: op.operationId, pad: "x".repeat(5 * 1024) });
  assert.equal(huge.status, 413);
  const url = linkCardUrlSha256(fx.url);
  for (const [query, why] of [
    ["", "nothing"], [`operation_id=${op.operationId}&client_request_id=crid-${randomUUID()}`, "two forms"],
    [`operation_id=${op.operationId}&operation_id=${op.operationId}`, "a repeated key"], [`operation_id=${op.operationId}&x=1`, "an unknown key"],
    ["client_request_id=short", "a malformed request id"], [`message_id=${fx.message.id}`, "no url_sha256"], [`url_sha256=${url}`, "no message_id"],
    [`message_id=${fx.message.id}&url_sha256=${url.toUpperCase()}`, "an uppercase digest"], [`message_id=${fx.message.id}&url_sha256=${url}&cursor=`, "an empty cursor"],
    [`message_id=${fx.message.id}&url_sha256=${url}&operation_id=${op.operationId}`, "mixed forms"],
  ] as [string, string][]) {
    const res = await lookupOperations(app.baseUrl, fx, query);
    assert.equal(res.status, 400, why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  const anonymous = await fetch(`${app.baseUrl}/api/link-cards/status`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation_id: op.operationId }) });
  assert.equal(anonymous.status, 401);
});
