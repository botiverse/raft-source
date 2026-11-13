import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import type { Database } from "../db";
import {
  linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews,
  oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthUserConsents, officialAppRegistry,
} from "../db/schema";
import { __settleAppLinkPreviewRechecksForTests, __setPreviewHttpForTests } from "../services/appLinkPreviewService";
import { __resetLinkCardActionLimitsForTests, admitLinkCardUpdate, LINK_CARD_UPDATE_PER_INSTALLATION_PER_MINUTE } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests, LINK_CARD_STATE_HINTS } from "../services/linkCardActionService";
import { __setLinkCardReceiptHooksForTests } from "../services/linkCardReceiptService";
import { __setLinkCardUpdateHooksForTests } from "../services/linkCardUpdateService";
import { createOAuthClient } from "../services/oauthService";
import {
  appAnswer, appAuth, cardFixture, clientRequestId, executedOperation, handleFor, post, receiptHints, recordEmits, sendCardUpdate, statusOf, stubApp,
} from "../test/linkCardActionFixture";

// POST /api/oauth/link-preview/card-updates (RFC 076 §6.5, rule 6; protocol
// v3.2.3 §8.1, §8.2 (1)): the App's one terminal update per operation, accepted
// on the update token's own bindings alone, never once the App's credentials
// are disabled. Recording shows nothing by itself. Real HTTP, isolated PGlite.
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
  __setLinkCardUpdateHooksForTests(null);
  __resetLinkCardActionLimitsForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const HINTS = structuredClone(LINK_CARD_STATE_HINTS) as Record<string, { tone: string; text: string }>;
const opRow = async (db: Database, operationId: string) =>
  (await db.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, operationId)))[0]!;
const tokenRow = async (db: Database, token: string) =>
  (await db.select().from(linkCardUpdateTokens).where(eq(linkCardUpdateTokens.tokenSha256, sha256(token))))[0]!;
const updateId = () => `upd-${randomUUID()}`;
async function storedRows(db: Database) {
  const tables = [linkCardOperations, linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews];
  return JSON.stringify(await Promise.all(tables.map((table) => db.select().from(table))));
}

test("a terminal update moves the operation forward on the token's bindings, once: the receipt, the released view and a hint; the toast is digested, never stored or shown", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const emits = recordEmits(app.io);
  const op = await executedOperation(app.baseUrl, fx, { status: "accepted" });
  const id = updateId();
  const toast = { tone: "success", text: "Merged secret-repo#9" };
  const res = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: op.updateToken, update_id: id, outcome: "done", toast });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(res.body, { operation_id: op.operationId, state: "done", receipt_revision: 2 });
  const row = await opRow(db, op.operationId);
  assert.deepEqual([row.state, row.receiptRevision], ["done", 2]);
  const [view] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, op.claims.viewNonce));
  assert.equal(view?.pendingOperationId, null, "the view is released on the expected id");
  const token = await tokenRow(db, op.updateToken);
  assert.equal(token.consumedUpdateId, id);
  assert.match(token.contentSha256!, /^[0-9a-f]{64}$/);
  assert.deepEqual(token.receipt, { operationId: op.operationId, state: "done", receiptRevision: 2 });
  assert.ok(!(await storedRows(db)).includes("secret-repo"), "Raft stores no App text and no card");
  assert.deepEqual(receiptHints(emits).map((hint) => [hint.room, hint.payload]), [
    [`user:${fx.owner.id}:server:${fx.server.id}`, { operation_id: op.operationId, receipt_revision: 1 }],
    [`user:${fx.owner.id}:server:${fx.server.id}`, { operation_id: op.operationId, receipt_revision: 2 }],
  ], "the hint carries no content");

  // What the viewer sees follows status under current access: the App now
  // says not_visible for its object, so nothing private is shown, and the
  // update's toast is never replayed.
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  stubApp(() => appAnswer({ status: "not_visible" }));
  const seen = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual(seen.body, { operation_id: op.operationId, state: "done", receipt_revision: 2, hint: HINTS.done });
});

test("one update per token: the same update_id and content (any spelling) gets the original receipt and changes nothing; other content or another update_id is 409", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const emits = recordEmits(app.io);
  const op = await executedOperation(app.baseUrl, fx);
  const id = updateId();
  const first = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: op.updateToken, update_id: id, outcome: "refused", toast: { tone: "warning", text: "Stale" } });
  assert.deepEqual(first.body, { operation_id: op.operationId, state: "refused", receipt_revision: 2 });
  const hintsAfterFirst = receiptHints(emits).length;
  // The same content, keys reordered and spaced differently: the JCS digest is the same.
  const respelled = `{ "toast" : {"text":"Stale","tone":"warning"}, "outcome":"refused", "update_id":"${id}", "update_token":"${op.updateToken}" }`;
  for (const body of [respelled, { update_token: op.updateToken, update_id: id, outcome: "refused", toast: { tone: "warning", text: "Stale" } }]) {
    const again = await sendCardUpdate(app.baseUrl, appAuth(fx), body);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body, "the original receipt");
  }
  for (const [body, why] of [
    [{ update_token: op.updateToken, update_id: id, outcome: "refused" }, "same id, the toast dropped"],
    [{ update_token: op.updateToken, update_id: id, outcome: "done", toast: { tone: "warning", text: "Stale" } }, "same id, another outcome"],
    [{ update_token: op.updateToken, update_id: updateId(), outcome: "refused", toast: { tone: "warning", text: "Stale" } }, "another update_id"],
  ] as [unknown, string][]) {
    const res = await sendCardUpdate(app.baseUrl, appAuth(fx), body);
    assert.deepEqual([res.status, res.body.code], [409, "UPDATE_CONFLICT"], why);
  }
  const row = await opRow(db, op.operationId);
  assert.deepEqual([row.state, row.receiptRevision], ["refused", 2], "applied once");
  assert.equal(receiptHints(emits).length, hintsAfterFirst, "replays and conflicts hint nothing");

  // Two different updates on one token at once: exactly one is accepted.
  const raced = await executedOperation(app.baseUrl, fx);
  const results = await Promise.all(["done", "refused"].map((outcome) =>
    sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: raced.updateToken, update_id: updateId(), outcome })));
  assert.deepEqual(results.map((res) => res.status).sort(), [200, 409]);
  assert.equal((await opRow(db, raced.operationId)).receiptRevision, 2);
});

test("accepted on its own bindings: after an uninstall, eligibility revoked, a registration change or revoked consent; then the viewer reads it under their live access", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const changes: [string, () => Promise<unknown>, "readable" | "not_visible"][] = [
    ["official eligibility revoked", () => db.delete(officialAppRegistry).where(eq(officialAppRegistry.oauthClientId, fx.client.id)), "readable"],
    ["a registration change (new revision, endpoint and paths)", () => db.update(oauthAppLinkPreviews)
      .set({ revision: randomUUID() as typeof fx.registration.revision, actionEndpoint: `${fx.origin}/v2/card-actions`, paths: ["/issues"] })
      .where(eq(oauthAppLinkPreviews.clientId, fx.client.id)), "readable"],
    ["the viewer's consent revoked", () => db.update(oauthUserConsents).set({ revokedAt: new Date() }).where(eq(oauthUserConsents.userId, fx.owner.id)), "not_visible"],
    ["the App uninstalled", () => db.delete(oauthClientInstalls).where(eq(oauthClientInstalls.id, fx.install.id)), "not_visible"],
  ];
  // Every operation is made first, while everything is in force; then each change lands before its update.
  const ops = [];
  for (const _ of changes) ops.push(await executedOperation(app.baseUrl, fx, { status: "accepted" }));
  const calls = stubApp(() => appAnswer({ status: "done" }));
  for (const [i, [why, change, view]] of changes.entries()) {
    await change();
    const before = calls.length;
    const res = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: ops[i]!.updateToken, update_id: updateId(), outcome: "done" });
    assert.deepEqual(res.body, { operation_id: ops[i]!.operationId, state: "done", receipt_revision: 2 }, why);
    assert.equal(calls.length, before, `${why}: accepting calls no App`);
    const status = await statusOf(app.baseUrl, fx, { operation_id: ops[i]!.operationId });
    assert.equal(status.status, 200, why);
    assert.equal(status.body.state, view === "readable" ? "done" : "not_visible", `${why}: the receipt follows the viewer's live access`);
  }
});

test("never once the App's credentials are disabled, and never without the App's own valid credentials", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx);
  const body = { update_token: op.updateToken, update_id: updateId(), outcome: "done" };
  const unauthenticated: [string, { clientId: string; secret: string } | null][] = [
    ["no credentials", null],
    ["a wrong secret", { clientId: fx.client.clientId, secret: "wrong" }],
    ["an unknown client", { clientId: "nobody", secret: fx.clientSecret }],
  ];
  for (const [why, auth] of unauthenticated) {
    const res = await sendCardUpdate(app.baseUrl, auth, body);
    assert.deepEqual([res.status, res.body.code], [401, "INVALID_CLIENT"], why);
  }
  // Another App's valid credentials: its token is unknown to it.
  const { client: other, clientSecret } = await createOAuthClient({ serverId: fx.server.id, createdByUserId: fx.owner.id, clientId: `other-${randomUUID().slice(0, 8)}`, name: "Other" });
  const foreign = await sendCardUpdate(app.baseUrl, { clientId: other.clientId, secret: clientSecret }, body);
  assert.deepEqual([foreign.status, foreign.body.code], [410, "UPDATE_TOKEN_INVALID"]);
  // Disabled: this App type still authenticates with a disabled row elsewhere, so the update re-reads it FOR SHARE.
  await db.update(oauthClients).set({ enabled: false }).where(eq(oauthClients.id, fx.client.id));
  const disabled = await sendCardUpdate(app.baseUrl, appAuth(fx), body);
  assert.deepEqual([disabled.status, disabled.body.code], [401, "INVALID_CLIENT"]);
  await db.update(oauthClients).set({ enabled: true }).where(eq(oauthClients.id, fx.client.id));
  const late = await sendCardUpdate(app.baseUrl, appAuth(fx), { ...body, update_id: updateId(), outcome: "refused" });
  assert.equal(late.status, 200, "control: enabled again, accepted");
  const second = await executedOperation(app.baseUrl, fx);
  await db.update(oauthClients).set({ appType: "third_party_global", enabled: false }).where(eq(oauthClients.id, fx.client.id));
  const global = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: second.updateToken, update_id: updateId(), outcome: "done" });
  assert.deepEqual([global.status, global.body.code], [401, "INVALID_CLIENT"]);
  assert.deepEqual([(await opRow(db, second.operationId)).state, (await tokenRow(db, second.updateToken)).consumedUpdateId], ["unknown", null], "nothing recorded");
});

test("the token's own checks: unknown, expired (the reconciliation exit closes with it) or bound to another operation, Server, domain or revision is 410", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const unknown = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: `lcu_${"A".repeat(43)}`, update_id: updateId(), outcome: "done" });
  assert.deepEqual([unknown.status, unknown.body.code], [410, "UPDATE_TOKEN_INVALID"]);

  const expired = await executedOperation(app.baseUrl, fx);
  await db.update(linkCardUpdateTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(linkCardUpdateTokens.tokenSha256, sha256(expired.updateToken)));
  const late = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: expired.updateToken, update_id: updateId(), outcome: "done" });
  assert.deepEqual([late.status, late.body.code], [410, "UPDATE_TOKEN_INVALID"], "an old token can never leave reconciliation later");
  assert.equal((await opRow(db, expired.operationId)).state, "unknown");

  const mismatches: [string, Partial<typeof linkCardUpdateTokens.$inferInsert>][] = [
    ["another registration revision", { registrationRevision: randomUUID() }],
    ["another installation", { installationKey: randomUUID() }],
    ["another Server", { serverId: randomUUID() }],
  ];
  for (const [why, change] of mismatches) {
    const op = await executedOperation(app.baseUrl, fx);
    await db.update(linkCardUpdateTokens).set(change).where(eq(linkCardUpdateTokens.tokenSha256, sha256(op.updateToken)));
    const res = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: op.updateToken, update_id: updateId(), outcome: "done" });
    assert.deepEqual([res.status, res.body.code], [410, "UPDATE_TOKEN_INVALID"], why);
    assert.equal((await opRow(db, op.operationId)).state, "unknown", why);
  }
});

test("forward only: needs_reconciliation closes within the token's life; an operation already terminal records the update and moves nothing", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const emits = recordEmits(app.io);
  const stuck = await executedOperation(app.baseUrl, fx, { status: "accepted" });
  // As the status or the 24-hour sweep would leave it (state and revision).
  await db.update(linkCardOperations).set({ state: "needs_reconciliation", receiptRevision: 2 }).where(eq(linkCardOperations.operationId, stuck.operationId));
  const exit = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: stuck.updateToken, update_id: updateId(), outcome: "failed_not_sent" });
  assert.deepEqual(exit.body, { operation_id: stuck.operationId, state: "failed_not_sent", receipt_revision: 3 }, "needs_reconciliation -> failed_not_sent");

  const terminal = await executedOperation(app.baseUrl, fx, { status: "done" });
  const hints = receiptHints(emits).length;
  const recorded = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: terminal.updateToken, update_id: updateId(), outcome: "refused" });
  assert.deepEqual(recorded.body, { operation_id: terminal.operationId, state: "done", receipt_revision: 1 }, "recorded, not applied: terminal never moves");
  assert.equal(receiptHints(emits).length, hints, "nothing moved, nothing hinted");
  assert.equal((await tokenRow(db, terminal.updateToken)).consumedUpdateId !== null, true, "the token is spent");

  // The App's terminal update may land before its synchronous answer is applied, while the operation is still sent.
  let early: Awaited<ReturnType<typeof sendCardUpdate>> | null = null;
  stubApp(async (call) => {
    early = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: call.body.update_token, update_id: updateId(), outcome: "done" });
    return appAnswer({ status: "accepted" });
  });
  const executed = await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
  assert.deepEqual(early!.body, { operation_id: executed.body.operation_id, state: "done", receipt_revision: 1 }, "sent -> done");
  assert.equal(executed.body.state, "done", "the late synchronous accepted moves nothing back");
});

test("an update that races status on one operation: one terminal state, never moved back", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx);
  __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
  // Status forwards; while the App is being asked, the App's terminal update lands.
  stubApp(async () => {
    const res = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: op.updateToken, update_id: updateId(), outcome: "refused" });
    assert.equal(res.status, 200);
    return appAnswer({ status: "done" });
  });
  const status = await statusOf(app.baseUrl, fx, { operation_id: op.operationId });
  assert.deepEqual([status.body.state, status.body.receipt_revision], ["refused", 2], "the update won; the later done answer moves nothing");
  // And the other order: status applied first, then the update is recorded only.
  const second = await executedOperation(app.baseUrl, fx);
  stubApp(() => appAnswer({ status: "done" }));
  assert.equal((await statusOf(app.baseUrl, fx, { operation_id: second.operationId })).body.state, "done");
  const recorded = await sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: second.updateToken, update_id: updateId(), outcome: "refused" });
  assert.deepEqual(recorded.body, { operation_id: second.operationId, state: "done", receipt_revision: 2 });
});

test("bodies are raw bytes parsed strictly, at most 8 KiB before parsing: C0-control and duplicate keys, unknown fields, non-terminal outcomes and bad toasts are 400", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx);
  const valid = { update_token: op.updateToken, update_id: updateId(), outcome: "done" };
  const cases: [unknown, string, Record<string, string>?][] = [
    [`{"update_token":"${op.updateToken}","update_id":"u-1","outcome":"done","\\u001b":"x"}`, "a C0-control key"],
    [`{"update_token":"${op.updateToken}","update_id":"u-1","outcome":"done","toast":{"tone":"info","text":"x","\\t":"y"}}`, "a nested C0-control key"],
    [`{"update_token":"${op.updateToken}","update_id":"u-1","outcome":"refused","outcome":"done"}`, "a duplicate key"],
    [`{"update_token":"${op.updateToken}","update_id":"u-1","outcome":"done","toast":{"tone":"info","text":"\\ud800"}}`, "a lone surrogate"],
    [{ ...valid, card: {} }, "an unknown field"],
    [{ ...valid, outcome: "accepted" }, "a non-terminal outcome"],
    [{ ...valid, outcome: "needs_reconciliation" }, "Raft's own state"],
    [{ ...valid, toast: { tone: "error", text: "x" } }, "a toast tone outside the protocol"],
    [{ ...valid, toast: { tone: "info", text: "x".repeat(201) } }, "a toast over 200 code points"],
    [{ ...valid, update_id: "" }, "an empty update_id"],
    [{ ...valid, update_id: "x y" }, "an update_id with a space"],
    [{ ...valid, update_token: "not-a-token" }, "a malformed token"],
    [{ update_token: op.updateToken, outcome: "done" }, "no update_id"],
    [[valid], "an array"],
    ["done", "not JSON"],
    [new Uint8Array([0x7b, 0xff, 0x7d]), "invalid UTF-8"],
    [`update_token=${op.updateToken}&update_id=u-1&outcome=done`, "a form body", { "Content-Type": "application/x-www-form-urlencoded" }],
  ];
  for (const [body, why, headers] of cases) {
    const res = await sendCardUpdate(app.baseUrl, appAuth(fx), body, headers);
    assert.deepEqual([res.status, res.body.code], [400, "INVALID_REQUEST"], why);
    assert.equal(res.headers.get("cache-control"), "private, no-store", why);
  }
  const huge = await sendCardUpdate(app.baseUrl, appAuth(fx), { ...valid, pad: "x".repeat(9 * 1024) });
  assert.equal(huge.status, 413);
  assert.equal((await tokenRow(db, op.updateToken)).consumedUpdateId, null, "nothing was accepted");
  const ok = await sendCardUpdate(app.baseUrl, appAuth(fx), valid, { "Content-Type": "text/plain" });
  assert.equal(ok.status, 200, "the content type does not matter: the bytes are parsed strictly either way");
});

test("each installation has a budget of 600 updates per minute; past it, 429 with Retry-After", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const op = await executedOperation(app.baseUrl, fx);
  for (let i = 1; i < LINK_CARD_UPDATE_PER_INSTALLATION_PER_MINUTE; i++) assert.deepEqual(await admitLinkCardUpdate(fx.install.id), { admitted: true });
  const body = { update_token: op.updateToken, update_id: updateId(), outcome: "done" };
  assert.equal((await sendCardUpdate(app.baseUrl, appAuth(fx), body)).status, 200, "the 600th");
  const over = await sendCardUpdate(app.baseUrl, appAuth(fx), body);
  assert.deepEqual([over.status, over.body.code], [429, "RATE_LIMITED"]);
  assert.ok(Number(over.headers.get("retry-after")) >= 1 && Number(over.headers.get("retry-after")) <= 60);
});

