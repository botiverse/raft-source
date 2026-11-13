// Real PostgreSQL teeth for interactive link-card execute (RFC 076 §5.2, §6.3;
// protocol v3.2.3 §5.3.2-§5.3.3), required by Tenny before the
// interactive_link_cards flag is turned on (#10971). PGlite serializes
// transactions on one connection, so linkCardExecute.api.test.ts pins the
// interleavings with seams and simulates the lock timeout; only a
// multi-connection Postgres shows that the admission advisory locks, the
// FOR SHARE re-checks and lock_timeout hold under genuinely parallel requests:
// - the viewer cap under a race (19 open + concurrent new intents never pass 20);
// - one operation per client_request_id under a race;
// - lock_timeout 2 s firing for real -> 429 LOCK_TIMEOUT, and the final mapping
//   check returning a same-id winner that committed while the loser waited;
// - one pending operation per view under a race;
// - the viewer's side re-checked after a real lock wait (consent revoked,
//   declined, removed from a private channel, message edited or deleted), and a
//   decline or revocation that starts during the transaction waiting for it;
// - after the send (C2c): one terminal update per token under a race, an App
//   update racing a forwarded status on one operation (one terminal state,
//   never moved back), and disabling the App ordered with an update.
//
// Default-skipped. Run it with a server you can create tables in:
//   LINK_CARD_ACTIONS_REAL_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres \
//     pnpm --filter @botiverse/raft-server test:link-card-actions-real-pg
// CI: `probe-concurrency-real-pg`.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterEach, beforeEach } from "vitest";
import { getDb, type Database } from "../db/index";
import { linkCardClientRequests, linkCardOperations, linkCardUpdateTokens, linkCardViews, messages, oauthLinkPreviewDeclines, oauthUserConsents } from "../db/schema";
import { declineLinkPreviews } from "../services/appLinkPreviewConsentService";
import { __setPreviewHttpForTests, __settleAppLinkPreviewRechecksForTests } from "../services/appLinkPreviewService";
import { addHuman, removeHuman } from "../services/channelService";
import { __resetLinkCardActionLimitsForTests } from "../services/linkCardActionLimits";
import { __setLinkCardActionHooksForTests } from "../services/linkCardActionService";
import { __setLinkCardReceiptHooksForTests } from "../services/linkCardReceiptService";
import { __setLinkCardUpdateHooksForTests } from "../services/linkCardUpdateService";
import { linkCardMessageContentSha256 } from "../services/linkCardTokens";
import { addMember } from "../services/serverService";
import { createApiTest } from "../test/integration/apiTest";
import { openTestApp } from "../test/integration/app";
import { tokenForHuman } from "../test/integration/credentials";
import { migrateRealPgTestDatabase } from "../test/integration/realPgMigrate";
import { createSeed } from "../test/integration/seed";
import {
  appAnswer, appAuth, barrier, cardFixture, clientRequestId, executedOperation, handleFor, insertOperations, post, sendCardUpdate, statusOf, stubApp, type CardFixture,
} from "../test/linkCardActionFixture";

const test = createApiTest();

const REAL_PG_URL = process.env.LINK_CARD_ACTIONS_REAL_PG_URL;
const REAL_PG_REQUIRED = process.env.LINK_CARD_ACTIONS_REAL_PG_REQUIRED === "1";
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));
const REAL_PG_TEST = { skip: !(REAL_PG_URL || REAL_PG_REQUIRED), timeout: 120_000 };

type TestApp = Awaited<ReturnType<typeof openTestApp>>;
type World = { app: TestApp; db: Database; seed: ReturnType<typeof createSeed>; holder: pg.Client };

const originalKey = process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY;
const originalOfficialServer = process.env.RAFT_OFFICIAL_PUBLISHER_SERVER_ID;
beforeEach(() => {
  process.env.RAFT_OIDC_SIGNING_PRIVATE_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});
afterEach(() => {
  for (const [name, value] of [["RAFT_OIDC_SIGNING_PRIVATE_KEY", originalKey], ["RAFT_OFFICIAL_PUBLISHER_SERVER_ID", originalOfficialServer]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

/** The app on the real database, plus one raw connection of the test's own to hold locks with. */
async function withRealPgApp(run: (world: World) => Promise<void>) {
  assert.ok(REAL_PG_URL, "LINK_CARD_ACTIONS_REAL_PG_URL is required");
  const migrator = new pg.Pool({ connectionString: REAL_PG_URL, max: 2 });
  try {
    await migrateRealPgTestDatabase(migrator, MIGRATIONS_FOLDER);
  } finally {
    await migrator.end();
  }
  const app = await openTestApp(REAL_PG_URL, 0, { skipAuthRateLimit: true });
  const holder = new pg.Client({ connectionString: REAL_PG_URL, application_name: "link-card-real-pg-holder" });
  holder.on("error", () => {});
  await holder.connect();
  try {
    await run({ app, db: getDb(), seed: createSeed(getDb()), holder });
  } finally {
    __setLinkCardActionHooksForTests(null);
    __setLinkCardReceiptHooksForTests(null);
    __setLinkCardUpdateHooksForTests(null);
    await __settleAppLinkPreviewRechecksForTests();
    __setPreviewHttpForTests(null);
    __resetLinkCardActionLimitsForTests();
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end().catch(() => {});
    await app.close();
  }
}

const execute = (baseUrl: string, fx: { headers: Record<string, string> }, body: unknown) => post(baseUrl, "execute", fx, body);
const actionCalls = <T extends { url: string }>(calls: T[], fx: CardFixture) => calls.filter((call) => call.url === fx.actionEndpoint);
const openFor = async (db: Database, viewerId: string, serverId: string) => Number((await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n
  FROM ${linkCardOperations} WHERE viewer_id = ${viewerId} AND server_id = ${serverId} AND state IN ('sent', 'accepted', 'unknown')`)).rows[0]!.n);
const operationsOf = async (db: Database, viewerId: string) => db.select().from(linkCardOperations).where(eq(linkCardOperations.viewerId, viewerId));
/** The admission lock key for a viewer on a Server (linkCardActionService.admitInTransaction (b)). */
const viewerLockKey = (viewerId: string, serverId: string) => `link_card:viewer:${viewerId}:${serverId}`;

/** Polls until `count` backends of this database wait on a heavyweight lock (optionally of one kind). */
async function waitForLockWaiters(count: number, event?: "advisory" | "transactionid" | "tuple") {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await getDb().execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND (${event ?? null}::text IS NULL OR wait_event = ${event ?? null}::text)`);
    if (Number(rows[0]!.n) >= count) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} lock waiter(s)${event ? ` on ${event}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** A promise that resolves when `release()` is called. */
function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}

test("real PG: the viewer cap holds under a race: 19 open plus concurrent new executes never pass 20", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed }) => {
    for (const racers of [2, 6]) {
      const fx = await cardFixture(db, seed);
      const calls = stubApp(() => appAnswer({ status: "accepted" }));
      await insertOperations(db, fx, 19);
      // Every racer passes the recovery lookup before any of them admits.
      __setLinkCardActionHooksForTests({ afterRecoveryMiss: barrier(racers) });
      const results = await Promise.all(Array.from({ length: racers }, () => execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle })));
      __setLinkCardActionHooksForTests(null);
      assert.deepEqual(results.map((res) => res.status).sort(), [200, ...Array<number>(racers - 1).fill(429)], JSON.stringify(results.map((res) => res.body)));
      for (const res of results.filter((each) => each.status === 429)) assert.equal(res.body.code, "OPEN_OPERATIONS_CAP");
      assert.equal(await openFor(db, fx.owner.id, fx.server.id), 20, `${racers} racers`);
      assert.equal(actionCalls(calls, fx).length, 1);
    }
  });
});

test("real PG: concurrent executes with one client_request_id make one operation, and every racer gets it", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed }) => {
    const fx = await cardFixture(db, seed);
    const calls = stubApp(() => appAnswer({ status: "accepted" }));
    const racers = 6;
    const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
    __setLinkCardActionHooksForTests({ afterRecoveryMiss: barrier(racers) });
    const results = await Promise.all(Array.from({ length: racers }, () => execute(app.baseUrl, fx, body)));
    __setLinkCardActionHooksForTests(null);
    for (const res of results) assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(new Set(results.map((res) => res.body.operation_id)).size, 1, "one operation_id for every racer");
    assert.equal((await operationsOf(db, fx.owner.id)).length, 1);
    assert.equal((await db.select().from(linkCardClientRequests).where(eq(linkCardClientRequests.viewerId, fx.owner.id))).length, 1);
    assert.equal(actionCalls(calls, fx).length, 1, "sent once");
  });
});

test("real PG: lock_timeout 2 s fires on a real wait: 429 LOCK_TIMEOUT with nothing written, unless the final mapping check finds a same-id winner", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed, holder }) => {
    const fx = await cardFixture(db, seed);
    const calls = stubApp(() => appAnswer({ status: "accepted" }));

    // 1. A revocation-like writer holds the official registry row FOR UPDATE:
    // execute's FOR SHARE on it waits 2 s, then gives up.
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM official_app_registry WHERE oauth_client_id = $1 FOR UPDATE", [fx.client.id]);
    const started = Date.now();
    const timedOut = await execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle: handleFor(fx).handle });
    const waited = Date.now() - started;
    await holder.query("ROLLBACK");
    assert.equal(timedOut.status, 429, JSON.stringify(timedOut.body));
    assert.deepEqual(timedOut.body, { error: "Busy. Try again with the same request.", code: "LOCK_TIMEOUT" });
    assert.ok(waited >= 1900 && waited < 10_000, `waited ${waited} ms`);
    assert.equal((await operationsOf(db, fx.owner.id)).length, 0, "nothing written");
    assert.equal(actionCalls(calls, fx).length, 0);

    // 2. The same id twice. The winner parks under its admission locks; the
    // holder queues for the viewer's advisory lock, then the loser queues
    // behind the holder. The winner commits, the holder takes the lock and
    // keeps it, and the loser's wait times out: its final mapping check finds
    // the winner, so it answers with the winner's operation, not 429.
    const body = { client_request_id: clientRequestId(), handle: handleFor(fx).handle };
    const park = gate();
    let parked = false; let admissions = 0;
    __setLinkCardActionHooksForTests({
      underAdmissionLocks: async () => {
        if (admissions++ > 0) return;
        parked = true;
        await park.opened;
      },
    });
    const winner = execute(app.baseUrl, fx, body);
    let loser: ReturnType<typeof execute> | null = null;
    let loserStarted = 0;
    let holding: Promise<unknown> = Promise.resolve();
    try {
      while (!parked) await new Promise((resolve) => setTimeout(resolve, 10));
      await holder.query("BEGIN");
      holding = holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [viewerLockKey(fx.owner.id, fx.server.id)]);
      await waitForLockWaiters(1, "advisory");
      loserStarted = Date.now();
      loser = execute(app.baseUrl, fx, body);
      await waitForLockWaiters(2, "advisory");
    } finally {
      park.release();
    }
    const won = await winner;
    await holding;
    const lost = await loser!;
    const loserWaited = Date.now() - loserStarted;
    await holder.query("ROLLBACK");
    __setLinkCardActionHooksForTests(null);
    assert.equal(won.status, 200, JSON.stringify(won.body));
    assert.equal(lost.status, 200, `the final check returns the winner, not 429: ${JSON.stringify(lost.body)}`);
    assert.equal(lost.body.operation_id, won.body.operation_id);
    assert.ok(loserWaited >= 1900, `the loser waited out lock_timeout (${loserWaited} ms) while the holder kept the lock`);
    assert.equal(admissions, 1, "the loser never got the viewer's lock: its answer came from the final mapping check");
    assert.equal((await operationsOf(db, fx.owner.id)).length, 1);
    assert.equal(actionCalls(calls, fx).length, 1);
  });
});

test("real PG: one pending operation per view under a race: two handles of one view at once give one operation and one 409 VIEW_PENDING", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed }) => {
    const fx = await cardFixture(db, seed);
    const calls = stubApp(() => appAnswer({ status: "accepted" }));
    const x = handleFor(fx);
    // The same view after a refresh: same nonce and instance, the next epoch.
    const y = handleFor(fx, { viewNonce: x.claims.viewNonce, viewInstanceId: x.claims.viewInstanceId, epoch: 2 });
    __setLinkCardActionHooksForTests({ afterRecoveryMiss: barrier(2) });
    const results = await Promise.all([x, y].map(({ handle }) => execute(app.baseUrl, fx, { client_request_id: clientRequestId(), handle })));
    __setLinkCardActionHooksForTests(null);
    assert.deepEqual(results.map((res) => res.status).sort(), [200, 409], JSON.stringify(results.map((res) => res.body)));
    assert.equal(results.find((res) => res.status === 409)!.body.code, "VIEW_PENDING");
    const ops = await operationsOf(db, fx.owner.id);
    assert.equal(ops.length, 1, "the loser's operation, mapping and handle use rolled back");
    const [view] = await db.select().from(linkCardViews).where(eq(linkCardViews.viewNonce, x.claims.viewNonce));
    assert.equal(view?.pendingOperationId, ops[0]!.operationId);
    assert.equal(actionCalls(calls, fx).length, 1);
  });
});

test("real PG: the viewer's side is re-checked after a real lock wait: a revocation, decline, removal, edit or deletion committed while execute waited is 410 and nothing is sent", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed, holder }) => {
    const fx = await cardFixture(db, seed);
    const calls = stubApp(() => appAnswer({ status: "accepted" }));
    const changes: [string, (viewer: { id: string }, message: { id: string }, privateChannelId: string) => Promise<unknown>][] = [
      ["consent revoked", (viewer) => getDb().update(oauthUserConsents).set({ revokedAt: new Date() })
        .where(and(eq(oauthUserConsents.userId, viewer.id), eq(oauthUserConsents.clientId, fx.client.id)))],
      ["previews declined", (viewer) => declineLinkPreviews({ serverId: fx.server.id, userId: viewer.id, clientId: fx.client.id })],
      ["removed from the private channel", (viewer, _message, privateChannelId) => removeHuman(privateChannelId, viewer.id, { self: true })],
      ["the message edited", (_viewer, message) => getDb().update(messages).set({ content: "edited, no link" }).where(eq(messages.id, message.id))],
      ["the message deleted", (_viewer, message) => getDb().delete(messages).where(eq(messages.id, message.id))],
    ];
    for (const [why, change] of [["nothing (control)", async () => undefined] as (typeof changes)[number], ...changes]) {
      // A fresh member each time, in a private channel with the owner, consented.
      const viewer = await seed.human();
      await addMember(fx.server.id, viewer.id, "member");
      const privateChannel = await seed.channel({ server: fx.server, members: [fx.owner, viewer], visibility: "private" });
      await getDb().insert(oauthUserConsents).values({ serverId: fx.server.id, userId: viewer.id, clientId: fx.client.id, scopes: ["openid", "profile"] });
      const content = `please approve ${fx.url}`;
      const message = await seed.message({ channel: privateChannel, author: fx.owner, content });
      const { handle } = handleFor(fx, { binding: { viewerId: viewer.id, messageId: message.id }, messageContentSha256: linkCardMessageContentSha256(content) });
      const asViewer = { headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(viewer.email)}` } };

      // The holder takes the viewer's admission lock; execute passes its live
      // check and waits for it in the transaction; the change commits on its
      // own connection meanwhile; then the holder lets go.
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [viewerLockKey(viewer.id, fx.server.id)]);
      const pending = execute(app.baseUrl, asViewer, { client_request_id: clientRequestId(), handle });
      await waitForLockWaiters(1, "advisory");
      await change(viewer, message, privateChannel.id);
      await holder.query("ROLLBACK");
      const res = await pending;
      if (why === "nothing (control)") {
        assert.equal(res.status, 200, `${why}: ${JSON.stringify(res.body)}`);
        assert.equal((await operationsOf(db, viewer.id)).length, 1);
        continue;
      }
      assert.equal(res.status, 410, `${why}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "HANDLE_INVALID", why);
      assert.equal((await operationsOf(db, viewer.id)).length, 0, `${why}: nothing written`);
    }
    assert.equal(actionCalls(calls, fx).length, 1, "only the control was sent");
  });
});

test("real PG: a decline or a consent revocation that starts during execute's transaction waits for its commit (decided at commit)", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed, holder }) => {
    const fx = await cardFixture(db, seed);
    const calls = stubApp(() => appAnswer({ status: "accepted" }));
    const viewer = await seed.human();
    await addMember(fx.server.id, viewer.id, "member");
    await addHuman(fx.channel.id, viewer.id);
    const [consent] = await getDb().insert(oauthUserConsents).values({ serverId: fx.server.id, userId: viewer.id, clientId: fx.client.id, scopes: ["openid", "profile"] }).returning();
    const asViewer = { headers: { ...fx.headers, Authorization: `Bearer ${await tokenForHuman(viewer.email)}` } };
    const { handle } = handleFor(fx, { binding: { viewerId: viewer.id } });

    // Execute parks right after its re-check, holding the consent row FOR SHARE and the choice lock shared.
    const park = gate();
    let parked = false;
    __setLinkCardActionHooksForTests({ afterViewerRecheck: async () => { parked = true; await park.opened; } });
    const pending = execute(app.baseUrl, asViewer, { client_request_id: clientRequestId(), handle });
    const settled: string[] = [];
    let decline: Promise<Awaited<ReturnType<typeof declineLinkPreviews>>> = Promise.resolve({ kind: "not_found" });
    let revoke: Promise<void> = Promise.resolve();
    try {
      while (!parked) await new Promise((resolve) => setTimeout(resolve, 10));
      decline = declineLinkPreviews({ serverId: fx.server.id, userId: viewer.id, clientId: fx.client.id }).then((result) => { settled.push("decline"); return result; });
      await holder.query("SET statement_timeout = '15s'");
      revoke = holder.query("UPDATE oauth_user_consents SET revoked_at = now(), updated_at = now() WHERE id = $1", [consent!.id]).then(() => { settled.push("revoke"); });
      await waitForLockWaiters(2);
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(settled, [], "both writers wait for the execute's transaction");
    } finally {
      park.release();
    }
    const res = await pending;
    assert.equal((await decline).kind, "declined");
    await revoke;
    __setLinkCardActionHooksForTests(null);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.state, "accepted", "committed before the decline and the revocation: still sent");
    assert.equal(actionCalls(calls, fx).length, 1);
    assert.equal((await db.select().from(oauthLinkPreviewDeclines).where(eq(oauthLinkPreviewDeclines.userId, viewer.id))).length, 1);
    // And now both are in force: a new execute is refused before anything is sent.
    const after = await execute(app.baseUrl, asViewer, { client_request_id: clientRequestId(), handle: handleFor(fx, { binding: { viewerId: viewer.id } }).handle });
    assert.equal(after.status, 410);
    assert.equal(actionCalls(calls, fx).length, 1);
  });
});

test("real PG: one terminal update per token under a race; an update racing a forwarded status leaves one terminal state; disabling the App is ordered with an update", REAL_PG_TEST, async () => {
  await withRealPgApp(async ({ app, db, seed, holder }) => {
    const fx = await cardFixture(db, seed);
    const update = (updateToken: string, outcome: string) => sendCardUpdate(app.baseUrl, appAuth(fx), { update_token: updateToken, update_id: `upd-${clientRequestId()}`, outcome });
    const stateOf = async (operationId: string) => {
      const [row] = await db.select({ state: linkCardOperations.state, receiptRevision: linkCardOperations.receiptRevision }).from(linkCardOperations)
        .where(eq(linkCardOperations.operationId, operationId));
      return row;
    };
    const parkFirst = () => {
      const park = gate();
      const seen = { parked: false, entered: 0 };
      __setLinkCardUpdateHooksForTests({ underUpdateLocks: async () => { if (seen.entered++ > 0) return; seen.parked = true; await park.opened; } });
      return { park, seen };
    };

    // 1. Six updates with different update_ids on one token: the first holds
    // the token row FOR UPDATE while the other five queue on it.
    const raced = await executedOperation(app.baseUrl, fx);
    let { park, seen } = parkFirst();
    const first = update(raced.updateToken, "done");
    let rest: ReturnType<typeof update>[] = [];
    try {
      while (!seen.parked) await new Promise((resolve) => setTimeout(resolve, 10));
      rest = ["refused", "failed_not_sent", "done", "refused", "done"].map((outcome) => update(raced.updateToken, outcome));
      await waitForLockWaiters(5);
    } finally {
      park.release();
    }
    const results = [await first, ...await Promise.all(rest)];
    assert.deepEqual(results.map((res) => res.status), [200, 409, 409, 409, 409, 409], JSON.stringify(results.map((res) => res.body)));
    for (const res of results.slice(1)) assert.equal(res.body.code, "UPDATE_CONFLICT");
    assert.deepEqual(await stateOf(raced.operationId), { state: "done", receiptRevision: 2 }, "applied once");

    // 2. A forwarded status whose App answer (done) is applied while the App's
    // terminal update (refused) holds the operation row: the update commits
    // first and the status's conditional UPDATE then moves nothing.
    const both = await executedOperation(app.baseUrl, fx);
    __setLinkCardReceiptHooksForTests({ forwardIntervalMs: 0 });
    ({ park, seen } = parkFirst());
    let racing: ReturnType<typeof update> | null = null;
    stubApp(async () => {
      racing = update(both.updateToken, "refused");
      while (!seen.parked) await new Promise((resolve) => setTimeout(resolve, 10));
      return appAnswer({ status: "done" });
    });
    const status = statusOf(app.baseUrl, fx, { operation_id: both.operationId });
    try {
      await waitForLockWaiters(1, "transactionid");
    } finally {
      park.release();
    }
    const [statusRes, updateRes] = [await status, await racing!];
    assert.equal(updateRes.status, 200, JSON.stringify(updateRes.body));
    assert.deepEqual(updateRes.body, { operation_id: both.operationId, state: "refused", receipt_revision: 2 });
    assert.deepEqual([statusRes.body.state, statusRes.body.receipt_revision], ["refused", 2], "the status reports the state it found, never moves it back");
    assert.deepEqual(await stateOf(both.operationId), { state: "refused", receiptRevision: 2 });
    __setLinkCardReceiptHooksForTests(null);

    // 3. Disabling the App while an update holds its row FOR SHARE waits for
    // that update; an update that starts while the disable is uncommitted
    // waits for it and is then refused.
    const kept = await executedOperation(app.baseUrl, fx);
    const refusedLater = await executedOperation(app.baseUrl, fx);
    ({ park, seen } = parkFirst());
    const accepted = update(kept.updateToken, "done");
    let disabled: Promise<unknown> = Promise.resolve();
    try {
      while (!seen.parked) await new Promise((resolve) => setTimeout(resolve, 10));
      await holder.query("BEGIN");
      await holder.query("SET LOCAL statement_timeout = '15s'");
      disabled = holder.query("UPDATE oauth_clients SET enabled = false WHERE id = $1", [fx.client.id]);
      await waitForLockWaiters(1);
    } finally {
      park.release();
    }
    assert.equal((await accepted).status, 200, "it held the App row first: accepted");
    await disabled;
    __setLinkCardUpdateHooksForTests(null);
    const waiting = update(refusedLater.updateToken, "done");
    await waitForLockWaiters(1);
    await holder.query("COMMIT");
    const refused = await waiting;
    assert.deepEqual([refused.status, refused.body.code], [401, "INVALID_CLIENT"], "the disable committed while it waited: refused");
    assert.deepEqual(await stateOf(refusedLater.operationId), { state: "unknown", receiptRevision: 1 });
    const [token] = await db.select().from(linkCardUpdateTokens).where(eq(linkCardUpdateTokens.operationId, refusedLater.operationId));
    assert.equal(token?.consumedUpdateId, null);
  });
});
