import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach } from "vitest";
import { createApiTest } from "../test/integration/apiTest";
import type { Database } from "../db";
import {
  integrationAuditEvents, linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews,
  type LinkCardOperationState,
} from "../db/schema";
import { __setPreviewHttpForTests } from "./appLinkPreviewService";
import { __resetLinkCardActionLimitsForTests } from "./linkCardActionLimits";
import { linkCardReceiptHints } from "./linkCardReceiptHints";
import { startLinkCardSweepWorker, sweepLinkCardFirstSendDeadlines, sweepLinkCardReconciliation, sweepLinkCardViews, trimLinkCardRecords } from "./linkCardSweeps";
import { linkCardActionEndpointSha256, linkCardExecuteJti, linkCardUrlSha256 } from "./linkCardTokens";
import { appAnswer, cardFixture, clientRequestId, handleFor, post, receiptHints, recordEmits, stubApp, type CardFixture } from "../test/linkCardActionFixture";

// The interactive link card sweeps (protocol v3.2.3 §5.3.4, §7.3; RFC 076
// §3.7, §5.2): the first-send deadline sweep and the view sweep. Both decide
// under the row's own lock or inside the statement, so repeating them changes
// nothing (Tenny 52bb9eb4).
const test = createApiTest();
const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(() => {
  __setPreviewHttpForTests(null);
  __resetLinkCardActionLimitsForTests();
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

/** An operation written `minutesAgo` minutes ago (whole second), in `state`. */
async function operation(db: Database, fx: CardFixture, state: LinkCardOperationState, minutesAgo: number, extra: Partial<typeof linkCardOperations.$inferInsert> = {}) {
  const createdAt = new Date(Math.floor((Date.now() - minutesAgo * 60_000) / 1000) * 1000);
  const [row] = await db.insert(linkCardOperations).values({
    operationId: randomUUID(), viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app", providerKey: fx.client.clientId, installationKey: fx.install.id,
    registrationRevision: fx.registration.revision, viewNonce: randomUUID(), messageId: fx.message.id, urlSha256: linkCardUrlSha256(fx.url),
    actionEndpointSha256: linkCardActionEndpointSha256(fx.actionEndpoint), actionOrigin: fx.origin, actionId: "approve", requestSha256: "0".repeat(64),
    state, createdAt, firstSendDeadline: new Date(createdAt.getTime() + 600_000), ...extra,
  }).returning();
  return row!;
}
const stateOf = async (db: Database, operationId: string) =>
  (await db.select({ state: linkCardOperations.state, receiptRevision: linkCardOperations.receiptRevision }).from(linkCardOperations)
    .where(eq(linkCardOperations.operationId, operationId)))[0];

test("first-send deadline sweep: sent and never dispatched past the deadline -> failed_not_sent (audited); dispatched -> unknown; idempotent; nothing else moves", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const neverSent = await operation(db, fx, "sent", 11);
  const dispatched = await operation(db, fx, "sent", 11);
  await db.insert(linkCardAttempts).values({ jti: linkCardExecuteJti(dispatched.operationId), viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app",
    providerKey: fx.client.clientId, installationKey: fx.install.id, operationId: dispatched.operationId, phase: "execute" });
  const inTime = await operation(db, fx, "sent", 9);
  const accepted = await operation(db, fx, "accepted", 11);

  assert.deepEqual(await sweepLinkCardFirstSendDeadlines(), { due: 2, failedNotSent: 1, unknown: 1, skipped: 0 });
  assert.deepEqual(await stateOf(db, neverSent.operationId), { state: "failed_not_sent", receiptRevision: 1 }, "proved never sent");
  assert.deepEqual(await stateOf(db, dispatched.operationId), { state: "unknown", receiptRevision: 1 }, "may have been sent: never failed_not_sent");
  assert.deepEqual(await stateOf(db, inTime.operationId), { state: "sent", receiptRevision: 0 });
  assert.deepEqual(await stateOf(db, accepted.operationId), { state: "accepted", receiptRevision: 0 });
  const audit = await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "link_card.operation_first_send_expired"));
  assert.equal(audit.length, 1);
  assert.deepEqual(audit[0]!.metadata, { operationId: neverSent.operationId, actionId: "approve", providerKind: "app", providerKey: fx.client.clientId });
  assert.equal(audit[0]!.serverId, fx.server.id);
  assert.deepEqual([audit[0]!.actorType, audit[0]!.source, audit[0]!.eventCategory, audit[0]!.targetId], ["system", "system", "runtime", neverSent.operationId]);

  // Again, and through the worker: the same result, nothing more written; the worker hints its viewer.
  assert.deepEqual(await sweepLinkCardFirstSendDeadlines(), { due: 0, failedNotSent: 0, unknown: 0, skipped: 0 });
  const late = await operation(db, fx, "sent", 12);
  const emits = recordEmits(app.io);
  const worker = startLinkCardSweepWorker({ intervalMs: 3600_000, io: app.io });
  try { await worker.tick(); await worker.tick(); } finally { worker.stop(); }
  assert.equal((await stateOf(db, late.operationId))?.state, "failed_not_sent");
  assert.deepEqual(receiptHints(emits).map((hint) => [hint.room, hint.payload]), [[`user:${fx.owner.id}:server:${fx.server.id}`, { operation_id: late.operationId, receipt_revision: 1 }]]);
  assert.equal((await db.select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "link_card.operation_first_send_expired"))).length, 2);
  assert.equal((await stateOf(db, neverSent.operationId))?.receiptRevision, 1, "a closed operation is never touched again");
});

test("view sweep: only rows idle 15 minutes and free (no pending operation, or a terminal one), checked inside the DELETE; a swept row is rebuilt empty by a valid handle for the same nonce", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  stubApp(() => appAnswer({ status: "accepted" }));
  const idle = new Date(Date.now() - 20 * 60_000);
  const view = async (pendingOperationId: string | null, updatedAt: Date, viewNonce: string = randomUUID(), viewInstanceId: string = randomUUID()) => {
    await db.insert(linkCardViews).values({ viewNonce, viewInstanceId, viewerId: fx.owner.id, serverId: fx.server.id, providerKind: "app",
      providerKey: fx.client.clientId, installationKey: fx.install.id, messageId: fx.message.id, urlSha256: linkCardUrlSha256(fx.url), pendingOperationId, updatedAt });
    return viewNonce;
  };
  const done = await operation(db, fx, "done", 30);
  const resolved = await operation(db, fx, "resolved_manually", 30, { resolvedByUserId: fx.owner.id, resolvedAt: new Date(), resolutionReason: "closed by an operator" });
  const open = await operation(db, fx, "unknown", 30);
  const rebuilt = handleFor(fx);
  const idleFree = await view(null, idle, rebuilt.claims.viewNonce, rebuilt.claims.viewInstanceId);
  const idleDone = await view(done.operationId, idle);
  const idleResolved = await view(resolved.operationId, idle);
  const idleOpen = await view(open.operationId, idle);
  const freshFree = await view(null, new Date());
  const almostIdle = await view(null, new Date(Date.now() - 14 * 60_000));

  assert.equal(await sweepLinkCardViews(), 3);
  const left = (await db.select({ viewNonce: linkCardViews.viewNonce }).from(linkCardViews)).map((row) => row.viewNonce).sort();
  assert.deepEqual(left, [idleOpen, freshFree, almostIdle].sort(), "an open operation keeps its view however idle; young rows stay");
  assert.ok(![idleFree, idleDone, idleResolved].some((nonce) => left.includes(nonce)));
  assert.equal(await sweepLinkCardViews(), 0, "idempotent");

  // A row claimed after any scan is protected by the DELETE's own conditions.
  await db.update(linkCardViews).set({ updatedAt: idle }).where(eq(linkCardViews.viewNonce, freshFree));
  await db.update(linkCardViews).set({ pendingOperationId: open.operationId }).where(eq(linkCardViews.viewNonce, freshFree));
  assert.equal(await sweepLinkCardViews(), 0, "pending a non-terminal operation: kept");

  // The swept row comes back for a valid handle of the same view, empty, then claimed.
  const res = await post(app.baseUrl, "execute", fx, { client_request_id: clientRequestId(), handle: rebuilt.handle });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [row] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, idleFree));
  assert.equal(row?.pendingOperationId, res.body.operation_id);
  assert.equal(row?.viewInstanceId, rebuilt.claims.viewInstanceId);
});

test("reconciliation sweep: accepted or unknown 24 hours after it was sent -> needs_reconciliation, in one conditional UPDATE; idempotent; hinted; nothing else moves", async ({ app, db, seed }) => {
  const fx = await cardFixture(db, seed);
  const emits = recordEmits(app.io);
  const hints = linkCardReceiptHints(app.io);
  const oldAccepted = await operation(db, fx, "accepted", 24 * 60 + 1);
  const oldUnknown = await operation(db, fx, "unknown", 25 * 60);
  const youngUnknown = await operation(db, fx, "unknown", 24 * 60 - 1);
  const oldSent = await operation(db, fx, "sent", 25 * 60);
  const oldDone = await operation(db, fx, "done", 25 * 60);
  const oldStuck = await operation(db, fx, "needs_reconciliation", 25 * 60);

  assert.equal(await sweepLinkCardReconciliation(100, hints), 2);
  assert.deepEqual(await stateOf(db, oldAccepted.operationId), { state: "needs_reconciliation", receiptRevision: 1 });
  assert.deepEqual(await stateOf(db, oldUnknown.operationId), { state: "needs_reconciliation", receiptRevision: 1 });
  for (const [row, state] of [[youngUnknown, "unknown"], [oldSent, "sent"], [oldDone, "done"], [oldStuck, "needs_reconciliation"]] as const) {
    assert.deepEqual(await stateOf(db, row.operationId), { state, receiptRevision: 0 }, `${state} stays (sent never goes straight to reconciliation)`);
  }
  assert.deepEqual(receiptHints(emits).map((hint) => hint.payload).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    [{ operation_id: oldAccepted.operationId, receipt_revision: 1 }, { operation_id: oldUnknown.operationId, receipt_revision: 1 }]
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.equal(await sweepLinkCardReconciliation(100, hints), 0, "idempotent");
  assert.equal(receiptHints(emits).length, 2);

  // An operation that a status or terminal update closes first is left alone (the
  // conditions are in the UPDATE); the worker runs this sweep too.
  const closed = await operation(db, fx, "unknown", 25 * 60);
  await db.update(linkCardOperations).set({ state: "done" }).where(eq(linkCardOperations.operationId, closed.operationId));
  const due = await operation(db, fx, "accepted", 25 * 60);
  const worker = startLinkCardSweepWorker({ intervalMs: 3600_000, io: app.io });
  try { await worker.tick(); } finally { worker.stop(); }
  assert.equal((await stateOf(db, closed.operationId))?.state, "done");
  assert.equal((await stateOf(db, due.operationId))?.state, "needs_reconciliation");
});

test("trim sweep: expired handle uses and prepared records, unusable update tokens and receipts past their operation's 24 hours go (each five minutes after expiry); operations, mappings, attempts and open receipts stay", async ({ app, db, seed }) => {
  void app;
  const fx = await cardFixture(db, seed);
  const identity = { serverId: fx.server.id, providerKind: "app" as const, providerKey: fx.client.clientId, installationKey: fx.install.id };
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
  const op = await operation(db, fx, "unknown", 30);
  const doneLongAgo = await operation(db, fx, "done", 26 * 60, { updatedAt: minutesAgo(25 * 60) });
  const doneRecently = await operation(db, fx, "done", 120, { updatedAt: minutesAgo(60) });
  await db.insert(linkCardClientRequests).values({ viewerId: fx.owner.id, ...identity, clientRequestId: clientRequestId(), operationId: op.operationId,
    urlSha256: linkCardUrlSha256(fx.url), actionId: "approve", requestSha256: "0".repeat(64) });
  await db.insert(linkCardAttempts).values({ jti: linkCardExecuteJti(op.operationId), viewerId: fx.owner.id, ...identity, operationId: op.operationId, phase: "execute" });

  const use = (expiresAt: Date) => db.insert(linkCardHandleUses).values({ handleSha256: randomUUID(), operationId: op.operationId, expiresAt }).returning();
  const [oldUse] = await use(minutesAgo(6));
  const [graceUse] = await use(minutesAgo(4));
  const [liveUse] = await use(minutesAgo(-5));
  const prepared = (readAt: Date) => db.insert(linkCardPreparedActions).values({ preparedActionId: randomUUID(), viewerId: fx.owner.id, ...identity, viewNonce: "v",
    handleSha256: randomUUID(), descriptionSha256: "0".repeat(64), businessRevision: "br-1", readAt, expiresAt: new Date(readAt.getTime() + 5 * 60_000) }).returning();
  const [oldPrepared] = await prepared(minutesAgo(11));
  const [gracePrepared] = await prepared(minutesAgo(9));
  const token = (operationId: string, expiresAt: Date, consumed: boolean) => db.insert(linkCardUpdateTokens).values({
    tokenSha256: randomUUID(), operationId, ...identity, registrationRevision: fx.registration.revision, expiresAt,
    ...(consumed ? { consumedUpdateId: "u-1", contentSha256: "0".repeat(64), receipt: { operationId, state: "done" as const, receiptRevision: 1 } } : {}),
  }).returning();
  const [unusable] = await token(op.operationId, minutesAgo(6), false);
  const [inGrace] = await token(op.operationId, minutesAgo(4), false);
  const [live] = await token(op.operationId, minutesAgo(-5), false);
  const [oldReceipt] = await token(doneLongAgo.operationId, minutesAgo(25 * 60), true);
  const [recentReceipt] = await token(doneRecently.operationId, minutesAgo(50), true);

  assert.deepEqual(await trimLinkCardRecords(), { handleUses: 1, preparedActions: 1, updateTokens: 2 });
  const keys = async <T>(rows: Promise<T[]>, key: (row: T) => string) => (await rows).map(key).sort();
  assert.deepEqual(await keys(db.select().from(linkCardHandleUses), (row) => row.handleSha256), [graceUse!.handleSha256, liveUse!.handleSha256].sort());
  assert.ok(!(await keys(db.select().from(linkCardHandleUses), (row) => row.handleSha256)).includes(oldUse!.handleSha256));
  assert.deepEqual(await keys(db.select().from(linkCardPreparedActions), (row) => row.preparedActionId), [gracePrepared!.preparedActionId]);
  void oldPrepared;
  assert.deepEqual(await keys(db.select().from(linkCardUpdateTokens), (row) => row.tokenSha256),
    [inGrace!.tokenSha256, live!.tokenSha256, recentReceipt!.tokenSha256].sort(), "an expired unconsumed token and a receipt past its operation's 24 hours go");
  void unusable; void oldReceipt;
  assert.equal((await db.select().from(linkCardOperations)).length, 3, "operations are never deleted");
  assert.equal((await db.select().from(linkCardClientRequests)).length, 1);
  assert.equal((await db.select().from(linkCardAttempts)).length, 1);
  assert.deepEqual(await trimLinkCardRecords(), { handleUses: 0, preparedActions: 0, updateTokens: 0 }, "idempotent");
});
