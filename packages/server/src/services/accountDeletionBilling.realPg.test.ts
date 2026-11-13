// Real PostgreSQL proves waiting writers and the shared Server row fence;
// Stripe and email are synthetic. Competitors are bound outside ambient txs.
import assert from "node:assert/strict";
import { vi } from "vitest";
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { and, eq, sql } from "drizzle-orm";
import type pg from "pg";
import { withBillingDeletionIsolation } from "../test/integration/billingDeletionIsolation";
import type Stripe from "stripe";
let getDb: typeof import("../db/index")["getDb"];
let accountDeletionRequests: typeof import("../db/schema")["accountDeletionRequests"];
let servers: typeof import("../db/schema")["servers"];
let subscriptions: typeof import("../db/schema")["subscriptions"];
let users: typeof import("../db/schema")["users"];

let createServer: typeof import("./serverService")["createServer"];
let cancelAccountDeletion: typeof import("./accountDeletion/requests")["cancelAccountDeletion"];
let requestAccountDeletionInTransaction: typeof import("./accountDeletion/requests")["requestAccountDeletionInTransaction"];
let runAccountDeletionRequestedEffects: typeof import("./accountDeletion/requests")["runAccountDeletionRequestedEffects"];
let __setStripeForTests: typeof import("./billingService")["__setStripeForTests"];
let cancelSubscriptionAtPeriodEnd: typeof import("./billingService")["cancelSubscriptionAtPeriodEnd"];
let cancelSubscriptionForAccountDeletion: typeof import("./billingService")["cancelSubscriptionForAccountDeletion"];
let resumeSubscriptionAfterCancelledDeletion: typeof import("./billingService")["resumeSubscriptionAfterCancelledDeletion"];


const url = process.env.BILLING_DELETION_REAL_PG_URL;
const realTest = test.skipIf(!url && process.env.BILLING_DELETION_REAL_PG_REQUIRED !== "1");

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function withPg(run: (pool: pg.Pool) => Promise<void>) {
  return withBillingDeletionIsolation(process.env, async target => {
    // No runtime business/email imports above this validated isolation boundary.
    assert.equal(process.env.RESEND_API_KEY, "", "mail is disabled before its module captures configuration");
    assert.equal(Object.keys(process.env).some(key => key.startsWith("PG")), false, "no inherited pg credentials or settings reach either driver");
    const db = await import("../db/index"); getDb = db.getDb;
    const tables = await import("../db/schema");
    ({ accountDeletionRequests, servers, subscriptions, users } = tables);
    ({ createServer } = await import("./serverService"));
    ({ cancelAccountDeletion, requestAccountDeletionInTransaction, runAccountDeletionRequestedEffects } = await import("./accountDeletion/requests"));
    const billing = await import("./billingService");
    ({ __setStripeForTests, cancelSubscriptionAtPeriodEnd, cancelSubscriptionForAccountDeletion, resumeSubscriptionAfterCancelledDeletion } = billing);
    const email = await import("./emailService");
    const { migrateRealPgTestDatabase } = await import("../test/integration/realPgMigrate");
    const driver = (await import("pg")).default;
    const pool = new driver.Pool(target.pool);
    try {
      await migrateRealPgTestDatabase(pool, fileURLToPath(new URL("../../drizzle", import.meta.url)));
      await db.initDatabase(target.url, target.url);
      email.__setEmailDeliveryObserverForTests(() => {});
      await run(pool);
    } finally {
      billing.__resetStripeForTests(); email.__setEmailDeliveryObserverForTests(null);
      await db.closeDatabase(); await pool.end();
    }
  });
}

async function fixture() {
  const suffix = randomUUID();
  const [person] = await getDb().insert(users).values({ name: `billing-${suffix}`, email: `${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true }).returning();
  const server = await createServer("Billing deletion", `billing-${suffix}`, person.id);
  const id = `sub_${suffix}`;
  await seedLocalProSubscription({ serverId: server.id, userId: person.id, subscriptionId: id, packQuantity: 1 });
  return { person, server, id };
}
async function pendingRequest(userId: string) {
  const result = await getDb().transaction(tx => requestAccountDeletionInTransaction(tx, { userId, source: "self", actorUserId: userId }));
  assert.equal(result.kind, "scheduled");
  if (result.kind !== "scheduled" || !result.effects) assert.fail("expected a new request and effects");
  return { request: result.request, effects: result.effects };
}
async function blockedBy(pool: pg.Pool, pid: number) {
  for (let i = 0; i < 80; i++) {
    const { rows } = await pool.query<{ waiting: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS waiting", [pid]);
    if (rows[0]?.waiting) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("the competing writer did not actually wait on the holder");
}

function stripeSub(input: {
  id: string;
  serverId: string;
  userId: string;
  status: Stripe.Subscription.Status;
  customer?: string;
  packQuantity?: number;
  itemQuantity?: number;
  pendingUpdate?: boolean;
  schedule?: string | { id: string; current_phase?: { start_date?: number } | null } | null;
  trialEnd?: number | null;
  billingInterval?: "monthly" | "annual";
  cancelAtPeriodEnd?: boolean;
  canceledAt?: number | null;
  cancelAt?: number | null;
  billingTraceId?: string;
  discounts?: Array<string | Stripe.Discount>;
}): Stripe.Subscription {
  const packQuantity = input.packQuantity ?? 1;
  const itemQuantity = input.itemQuantity ?? packQuantity;
  const billingInterval = input.billingInterval ?? "monthly";
  const priceId = billingInterval === "annual" ? "price_pro_seat_annual" : "price_pro_seat";
  return {
    id: input.id,
    customer: input.customer ?? "cus_test",
    status: input.status,
    cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
    canceled_at: input.canceledAt ?? null,
    cancel_at: input.cancelAt ?? null,
    pending_update: input.pendingUpdate ? { expires_at: 1_700_010_000 } : null,
    schedule: input.schedule ?? null,
    trial_end: input.trialEnd ?? null,
    discounts: input.discounts ?? [],
    metadata: {
      pricingContract: "raft-pro-seat-v1",
      serverId: input.serverId,
      userId: input.userId,
      targetPlan: "pro",
      billingInterval,
      seatQuantity: String(packQuantity),
      humanSeatQuantity: String(packQuantity),
      requestedAgentSeats: "0",
      agentSeatBlockQuantity: "0",
      proPackQuantity: String(packQuantity),
      packQuantity: String(packQuantity),
      stripeInitialPaidPackQuantity: String(packQuantity),
      provisionedHumanSeats: String(packQuantity),
      provisionedAgentSeats: String(packQuantity * PRO_AGENT_SEAT_BLOCK_SIZE),
      trialFreePackQuantity: "0",
      ...(input.billingTraceId ? { billingTraceId: input.billingTraceId } : {}),
    },
    items: {
      data: [
        {
          id: "si_pro_seat",
          quantity: itemQuantity,
          current_period_start: 1_700_000_000,
          current_period_end: 1_702_592_000,
          price: { id: priceId, product: "prod_pro_seat", recurring: { interval: billingInterval === "annual" ? "year" : "month" } },
        },
      ],
    },
  } as unknown as Stripe.Subscription;
}


async function seedLocalProSubscription(input: {
  serverId: string;
  userId: string;
  subscriptionId: string;
  packQuantity: number;
  customerId?: string;
  billingInterval?: "monthly" | "annual";
  cancelAtPeriodEnd?: boolean;
}) {
  await getDb().insert(subscriptions).values({
    serverId: input.serverId,
    stripeCustomerId: input.customerId ?? `cus_${input.subscriptionId}`,
    stripeSubscriptionId: input.subscriptionId,
    stripeProPackItemId: "si_pro_seat",
    billingInterval: input.billingInterval ?? "monthly",
    status: "active",
    cancelAtPeriodEnd: input.cancelAtPeriodEnd ?? false,
    provisionedHumanSeats: input.packQuantity,
    provisionedAgentSeats: input.packQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: input.packQuantity,
    trialFreePackQuantity: 0,
    firstPackTrialEndsAt: null,
    currentPeriodStart: new Date("2026-06-01T00:00:00Z"),
    // Far-future on purpose: getSubscription() has an "active but currentPeriodEnd
    // in the past -> verify with Stripe" refresh branch. A near/fixed end date is a
    // time-bomb — this was "2026-07-01", which went stale on 2026-07-01T00:00Z and
    // made getSubscription fire an unexpected stripe.subscriptions.retrieve, breaking
    // retrieveCalls==0 assertions (e.g. the usage-floor reject test). Keep it decades out.
    currentPeriodEnd: new Date("2099-01-01T00:00:00Z"),
    createdByUserId: input.userId,
  });
  await getDb().update(servers).set({ plan: "pro" }).where(eq(servers.id, input.serverId));
}



realTest("new deletion committed before old cancellation proof is recorded keeps its cancellation", async () => withPg(async () => {
  const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
  const { person, server, id } = await fixture();
  const entered = gate(), release = gate();
  let scheduled = false;
  const updates: boolean[] = [];
  const current = () => stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: scheduled, canceledAt: scheduled ? 123 : null });
  __setStripeForTests({ subscriptions: {
    retrieve: async () => current(),
    update: async (_id: string, body: Stripe.SubscriptionUpdateParams) => {
      scheduled = body.cancel_at_period_end === true; updates.push(scheduled);
      return current();
    },
  } } as unknown as Stripe);
  const first = await pendingRequest(person.id);
  const effects = runAccountDeletionRequestedEffects(first.effects, {
    cancelSubscriptionAtPeriodEnd: async (serverId, userId, subscriptionId, requestId) => {
      const proof = await cancelSubscriptionForAccountDeletion(serverId, userId, subscriptionId, requestId);
      // The capture committed its user/Server locks. Delay only the response
      // to the request-effects caller, before it can persist that proof.
      entered.release(); await release.promise;
      return proof;
    },
  });
  let nextEffects: Promise<unknown> | undefined;
  try {
    await Promise.race([entered.promise, effects.then(() => { throw new Error("capture finished without reaching the proof delay"); })]);
    const undo = await cancelAccountDeletion({ userId: person.id });
    assert.equal(undo.cancelled, true);
    const second = await pendingRequest(person.id);
    nextEffects = outside(() => runAccountDeletionRequestedEffects(second.effects));
    await nextEffects;
    release.release();
    await effects; await nextEffects;
    const [pending] = await getDb().select().from(accountDeletionRequests).where(and(eq(accountDeletionRequests.userId, person.id), eq(accountDeletionRequests.state, "pending")));
    assert.equal(pending?.id, second.request.id);
    assert.equal(scheduled, true);
    assert.equal(updates.includes(false), false, "old compensation cannot resume a newer pending deletion");
  } finally { release.release(); await effects; await nextEffects; }
}), 60_000);

for (const competitor of ["new deletion", "billing page cancellation"] as const) {
  realTest(`${competitor} waits until admitted restoration commits, then cancels again`, async () => withPg(async pool => {
    const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
    const { person, server, id } = await fixture();
    let scheduled = true, pid = 0;
    await getDb().update(subscriptions).set({ cancelAtPeriodEnd: true }).where(eq(subscriptions.serverId, server.id));
    const entered = gate(), release = gate(); const updates: boolean[] = [];
    const current = () => stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: scheduled, canceledAt: scheduled ? 123 : null });
    __setStripeForTests({ subscriptions: {
      retrieve: async () => current(),
      update: async (_id: string, body: Stripe.SubscriptionUpdateParams) => {
        scheduled = body.cancel_at_period_end === true; updates.push(scheduled);
        if (updates.length === 1) { pid = Number((await getDb().execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid); entered.release(); await release.promise; }
        return current();
      },
    } } as unknown as Stripe);
    const restore = resumeSubscriptionAfterCancelledDeletion(server.id, person.id, { stripeSubscriptionId: id, canceledAt: 123 });
    let other: Promise<unknown> | undefined;
    try {
      await entered.promise;
      other = outside(async () => {
        if (competitor === "new deletion") { const next = await pendingRequest(person.id); await runAccountDeletionRequestedEffects(next.effects); }
        else await cancelSubscriptionAtPeriodEnd(server.id, person.id);
      });
      await blockedBy(pool, pid);
      assert.deepEqual(updates, [false], "waiting writer cannot enter Stripe before restoration finishes");
      release.release();
      assert.equal(await restore, "restored");
      await other;
      assert.deepEqual(updates, [false, true]);
      assert.equal(scheduled, true);
      assert.equal((await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id)))[0].cancelAtPeriodEnd, true);
    } finally { release.release(); await restore; await other; }
  }), 60_000);
}

realTest("provider failure releases both fences and records an unknown outcome", async () => withPg(async () => {
  const { person, server, id } = await fixture();
  __setStripeForTests({ subscriptions: {
    retrieve: async () => stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: true, canceledAt: 123 }),
    update: async () => { throw new Error("synthetic provider response lost"); },
  } } as unknown as Stripe);
  assert.equal(await resumeSubscriptionAfterCancelledDeletion(server.id, person.id, { stripeSubscriptionId: id, canceledAt: 123 }), "unknown");
  const next = await pendingRequest(person.id);
  assert.equal(next.request.state, "pending", "a failed restoration must not strand the user's creation lock");
}), 60_000);

realTest("a user-lock timeout persists an unconfirmed cancellation and never promises no charge", async () => withPg(async pool => {
  const { person, server, id } = await fixture();
  const { serverMembers } = await import("../db/schema");
  const { __setEmailDeliveryObserverForTests } = await import("./emailService");
  const suffix = randomUUID();
  const [coOwner] = await getDb().insert(users).values({ name: `review-coowner-${suffix}`, email: `${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: coOwner.id, role: "owner" });
  const requested = await pendingRequest(person.id);
  assert.equal(requested.effects.paidServersEnding.length, 1);
  const emails: Array<{ text?: string }> = [];
  __setEmailDeliveryObserverForTests(delivery => emails.push(delivery));
  let providerUpdates = 0;
  const current = () => stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: false });
  __setStripeForTests({ subscriptions: {
    retrieve: async () => current(),
    update: async () => { providerUpdates++; return stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: true, canceledAt: 123 }); },
  } } as unknown as Stripe);
  const locker = await pool.connect();
  let lockHeld = false;
  try {
    await locker.query("BEGIN"); lockHeld = true;
    await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [person.id]);
    await runAccountDeletionRequestedEffects(requested.effects);
    const [record] = await getDb().select().from(accountDeletionRequests).where(eq(accountDeletionRequests.id, requested.request.id));
    assert.equal(record.state, "pending");
    assert.ok(emails.every(email => !/card is not charged again/i.test(email.text ?? "")));
    assert.equal(providerUpdates, 0, "the held user lock prevents reaching the synthetic provider");
    const { getAccountDeletionStatus } = await import("./accountDeletion/requests");
    const unconfirmed = await getAccountDeletionStatus(person.id);
    assert.equal(unconfirmed.status, "scheduled");
    assert.ok(unconfirmed.status === "scheduled" && unconfirmed.subscriptionCancellationUnconfirmed);
    assert.match(emails.at(-1)?.text ?? "", /could not confirm cancellation of subscription renewal/i);
    await locker.query("ROLLBACK"); lockHeld = false;
    // An explicit retry uses the same request and its stored proof; this is
    // not evidence of a background retry worker.
    await runAccountDeletionRequestedEffects(requested.effects);
    const confirmed = await getAccountDeletionStatus(person.id);
    assert.equal(confirmed.status, "scheduled");
    assert.ok(confirmed.status === "scheduled" && !confirmed.subscriptionCancellationUnconfirmed);
    assert.equal(providerUpdates, 1);
    assert.match(emails.at(-1)?.text ?? "", /subscription was scheduled to end with the current period/i);
    assert.doesNotMatch(emails.at(-1)?.text ?? "", /card is not charged again/i);
  } finally {
    if (lockHeld) await locker.query("ROLLBACK");
    locker.release();
  }
}), 60_000);

realTest("removed subscription cannot be mistaken for confirmed cancellation", async () => withPg(async () => {
  const { person, server, id } = await fixture();
  const { serverMembers } = await import("../db/schema");
  const { deleteServer } = await import("./serverService");
  const { getAccountDeletionStatus } = await import("./accountDeletion/requests");
  const { __setEmailDeliveryObserverForTests } = await import("./emailService");
  const suffix = randomUUID();
  const [coOwner] = await getDb().insert(users).values({ name: `review-coowner-${suffix}`, email: `${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: coOwner.id, role: "owner" });
  const entered = gate(), release = gate();
  const emails: Array<{ text?: string }> = [];
  __setEmailDeliveryObserverForTests(delivery => emails.push(delivery));
  let providerCancels = 0, periodEndUpdates = 0;
  __setStripeForTests({ subscriptions: {
    cancel: async () => { providerCancels++; throw new Error("synthetic cancellation failure"); },
    update: async () => { periodEndUpdates++; throw new Error("unexpected synthetic period-end update"); },
  } } as unknown as Stripe);
  // Pause the real SELECT only after PostgreSQL returned its selected rows.
  // The hook belongs to this isolated driver, not the production request API.
  const { getRootDb } = await import("../db/index");
  // The trace adapter binds client.query on each instance; intercept acquired
  // clients after that adapter, before the transaction issues its SELECT.
  const requestPool = (getRootDb() as ReturnType<typeof getRootDb> & { $client: pg.Pool }).$client;
  const wrapped = new Set<pg.PoolClient>();
  const restoreQueries: Array<() => void> = [];
  let paused = false;
  const intercept = (client: pg.PoolClient) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const originalQuery = client.query;
    const pause = vi.spyOn(client, "query").mockImplementation((function(this: pg.Client, ...args: unknown[]) {
      const query = args[0];
      const text = typeof query === "string" ? query : query && typeof query === "object" && "text" in query ? String(query.text) : "";
      if (!paused && text.startsWith("select ") && text.includes('"subscriptions"."cancel_at_period_end"') && text.includes('join "servers"')) {
        paused = true;
        const callbackIndex = args.length - 1;
        const callback = args[callbackIndex];
        if (typeof callback === "function") {
          args[callbackIndex] = (error: unknown, rows: pg.QueryResult) => {
            if (error) { Reflect.apply(callback, undefined, [error, rows]); return; }
            entered.release();
            void release.promise.then(() => Reflect.apply(callback, undefined, [error, rows]));
          };
          return Reflect.apply(originalQuery, this, args);
        }
        return (Reflect.apply(originalQuery, this, args) as Promise<pg.QueryResult>).then(async rows => { entered.release(); await release.promise; return rows; });
      }
      return Reflect.apply(originalQuery, this, args);
    }) as typeof originalQuery);
    restoreQueries.push(() => pause.mockRestore());
  };
  requestPool.on("acquire", intercept);
  const requestOutside = AsyncResource.bind(() => getDb().transaction(tx => requestAccountDeletionInTransaction(tx, { userId: person.id, source: "self", actorUserId: person.id })));
  const deleteOutside = AsyncResource.bind(() => deleteServer(server.id, { deletedByUserId: coOwner.id }));
  const requested = requestOutside();
  try {
    await Promise.race([entered.promise, requested.then(() => { throw new Error("request did not reach the selected-subscription pause"); })]);
    const deleted = await deleteOutside();
    assert.ok(deleted);
    assert.equal(providerCancels, 1);
    release.release();
    const outcome = await requested;
    assert.equal(outcome.kind, "scheduled");
    if (outcome.kind !== "scheduled" || !outcome.effects) assert.fail("expected new deletion request");
    assert.equal(outcome.effects.paidServersEnding.length, 1);

    await runAccountDeletionRequestedEffects(outcome.effects);
    assert.equal(periodEndUpdates, 0);
    assert.deepEqual(outcome.effects.subscriptionSnapshots[server.id], { stripeSubscriptionId: id, canceledAt: null }, "the selected subscription remains an unconfirmed intent after its local row disappears");
    const status = await getAccountDeletionStatus(person.id);
    assert.equal(emails.length, 1);
    const falselyScheduled = /subscription was scheduled to end with the current period/i.test(emails[0].text ?? "");
    assert.ok(status.status === "scheduled" && status.subscriptionCancellationUnconfirmed, `missing subscription cannot count as confirmed; misleadingEmail=${falselyScheduled}`);
    assert.match(emails.at(-1)?.text ?? "", /could not confirm cancellation of subscription renewal/i);
  } finally {
    requestPool.off("acquire", intercept);
    for (const restore of restoreQueries) restore();
    release.release();
    await Promise.allSettled([requested]);
  }
}), 60_000);


realTest("an inherited admission transaction keeps its changes when passive refresh cannot lock a different payer", async () => withPg(async pool => {
  const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
  const { person, server, id } = await fixture();
  const { computers, serverMembers } = await import("../db/schema");
  const { addMember } = await import("./serverService");
  const suffix = randomUUID();
  const [inviter, invitee] = await getDb().insert(users).values([
    { name: `review-inviter-${suffix}`, email: `inviter-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
    { name: `review-invitee-${suffix}`, email: `invitee-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
  ]).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: inviter.id, role: "owner" });
  // This case isolates refresh inside an established Server's admission.
  // First revealing #all also inserts other existing members' FK rows; that
  // separate ordering path has its own preserved diagnostic reproduction.
  const { channels } = await import("../db/schema");
  const { ensureAllChannelHumanRows } = await import("./allChannelMembership");
  await getDb().update(channels).set({ type: "channel" }).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
  await ensureAllChannelHumanRows(getDb(), server.id);
  await getDb().update(serverMembers).set({ allChannelUnlockInstructionSentAt: new Date() }).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, person.id)));
  await getDb().insert(computers).values({ serverId: server.id, name: "synthetic-computer", apiKeyHash: "synthetic-hash", apiKeyPrefix: "synthetic-prefix", attachedByUserId: person.id });
  const expiredAt = new Date(Date.now() - 1_000);
  await getDb().update(subscriptions).set({ currentPeriodEnd: expiredAt, provisionedHumanSeats: 5, proPackQuantity: 5 }).where(eq(subscriptions.serverId, server.id));
  const entered = gate(), release = gate();
  let admissionPid = 0, deletionPid = 0, cycleObserved = false;
  let cycleQueries = "";
  __setStripeForTests({ subscriptions: {
    retrieve: async () => { entered.release(); await release.promise; return stripeSub({ id, serverId: server.id, userId: person.id, status: "active", packQuantity: 5 }); },
  } } as unknown as Stripe);
  const admission = outside(() => getDb().transaction(async tx => {
    for (const userId of [inviter.id, invitee.id].sort()) await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("key share");
    await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, server.id)).for("update");
    admissionPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    const member = await addMember(server.id, invitee.id, "member", { executor: tx });
    await tx.execute(sql`SELECT 1`); // the refresh's failed savepoint did not abort this transaction
    return member;
  }));
  let deletion: Promise<unknown> | undefined;
  try {
    await entered.promise;
    deletion = outside(() => getDb().transaction(async tx => {
      deletionPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      return requestAccountDeletionInTransaction(tx, { userId: person.id, source: "self", actorUserId: person.id });
    }));
    await blockedBy(pool, admissionPid);
    const settled = Promise.allSettled([admission, deletion]);
    release.release();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ cycle: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AND $2::int = ANY(pg_blocking_pids($1::int)) AS cycle", [admissionPid, deletionPid]);
      if (rows[0]?.cycle) {
        cycleObserved = true;
        const observed = await pool.query("SELECT pid, left(query, 240) AS query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ANY($1::int[])", [[admissionPid, deletionPid]]);
        cycleQueries = JSON.stringify(observed.rows); break;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const results = await settled;
    const codes = results.map(result => {
      if (result.status === "fulfilled") return "ok";
      const found: string[] = [];
      for (let error: unknown = result.reason; error && typeof error === "object"; error = (error as { cause?: unknown }).cause) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") found.push(code);
      }
      return found.join(",") || "no code";
    });
    assert.ok(!cycleObserved && results.every(result => result.status === "fulfilled"), `cycleObserved=${cycleObserved}; codes=${codes.join(" | ")}; queries=${cycleQueries}`);
    const [member] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
    assert.equal(member?.role, "member", "the outer admission committed its write");
    const [cached] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(cached.currentPeriodEnd?.getTime(), expiredAt.getTime(), "failed passive refresh retains the old cache, not a newly verified entitlement");
    const [pending] = await getDb().select().from(accountDeletionRequests).where(and(eq(accountDeletionRequests.userId, person.id), eq(accountDeletionRequests.state, "pending")));
    assert.ok(pending, "the deletion also committed");
  } finally {
    release.release();
    await Promise.allSettled([admission, ...(deletion ? [deletion] : [])]);
  }
}), 60_000);

realTest("billing cancellation and a deleting computer owner serialize without deadlock", async () => withPg(async pool => {
  const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
  const { person, server, id } = await fixture();
  const { computers } = await import("../db/schema");
  await getDb().insert(computers).values({ serverId: server.id, name: "synthetic-computer", apiKeyHash: "synthetic-hash", apiKeyPrefix: "synthetic-prefix", attachedByUserId: person.id });
  const entered = gate(), release = gate();
  let billingPid = 0, deletionPid = 0, cycleObserved = false;
  __setStripeForTests({ subscriptions: {
    update: async () => {
      billingPid = Number((await getDb().execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      entered.release();
      await release.promise;
      return stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: true, canceledAt: 123 });
    },
  } } as unknown as Stripe);
  const billing = cancelSubscriptionAtPeriodEnd(server.id, person.id);
  let deletion: Promise<unknown> | undefined;
  try {
    await entered.promise;
    deletion = outside(() => getDb().transaction(async tx => {
      deletionPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      return requestAccountDeletionInTransaction(tx, { userId: person.id, source: "self", actorUserId: person.id });
    }));
    await blockedBy(pool, billingPid);
    const settled = Promise.allSettled([billing, deletion]);
    release.release();
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const { rows } = await pool.query<{ cycle: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AND $2::int = ANY(pg_blocking_pids($1::int)) AS cycle", [billingPid, deletionPid]);
      if (rows[0]?.cycle) { cycleObserved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const results = await settled;
    const codes = results.map(result => {
      if (result.status === "fulfilled") return "ok";
      const found: string[] = [];
      for (let error: unknown = result.reason; error && typeof error === "object"; error = (error as { cause?: unknown }).cause) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") found.push(code);
      }
      return found.join(",") || "no code";
    });
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], `cycleObserved=${cycleObserved}; codes=${codes.join(" | ")}`);
  } finally {
    release.release();
    await Promise.allSettled([billing, ...(deletion ? [deletion] : [])]);
  }
}), 60_000);


realTest("subscription webhook and deleting computer owner serialize without deadlock", async () => withPg(async pool => {
  const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
  const { person, server, id } = await fixture();
  const { computers } = await import("../db/schema");
  const { handleWebhookEvent } = await import("./billingService");
  await getDb().insert(computers).values({ serverId: server.id, name: "synthetic-computer", apiKeyHash: "synthetic-hash", apiKeyPrefix: "synthetic-prefix", attachedByUserId: person.id });
  await getDb().execute(sql`CREATE FUNCTION review_pause_subscription() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$`);
  await getDb().execute(sql`CREATE TRIGGER review_pause_subscription BEFORE INSERT ON subscriptions FOR EACH ROW EXECUTE FUNCTION review_pause_subscription()`);
  const event = { id: `evt_synthetic_${randomUUID()}`, type: "customer.subscription.updated", data: { object: stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: true, canceledAt: 123 }) } } as unknown as Stripe.Event;
  const webhook = handleWebhookEvent(event);
  let deletion: Promise<unknown> | undefined;
  let deletionPid = 0, cycleObserved = false;
  try {
    let webhookPid = 0;
    const pauseDeadline = Date.now() + 2_000;
    while (Date.now() < pauseDeadline && !webhookPid) {
      const { rows } = await pool.query<{ pid: number }>("SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'PgSleep' AND query ILIKE '%subscriptions%'");
      webhookPid = Number(rows[0]?.pid ?? 0);
      if (!webhookPid) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(webhookPid, "the actual webhook projection reaches the synthetic pause after taking its Server lock");
    deletion = outside(() => getDb().transaction(async tx => {
      deletionPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      return requestAccountDeletionInTransaction(tx, { userId: person.id, source: "self", actorUserId: person.id });
    }));
    await blockedBy(pool, webhookPid);
    const settled = Promise.allSettled([webhook, deletion]);
    const deadline = Date.now() + 4_500;
    while (Date.now() < deadline) {
      const { rows: blocked } = await pool.query<{ cycle: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AND $2::int = ANY(pg_blocking_pids($1::int)) AS cycle", [webhookPid, deletionPid]);
      if (blocked[0]?.cycle) { cycleObserved = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const results = await settled;
    const codes = results.map(result => {
      if (result.status === "fulfilled") return "ok";
      const found: string[] = [];
      for (let error: unknown = result.reason; error && typeof error === "object"; error = (error as { cause?: unknown }).cause) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === "string") found.push(code);
      }
      return found.join(",") || "no code";
    });
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"], `cycleObserved=${cycleObserved}; codes=${codes.join(" | ")}`);
  } finally {
    await Promise.allSettled([webhook, ...(deletion ? [deletion] : [])]);
    await getDb().execute(sql`DROP TRIGGER IF EXISTS review_pause_subscription ON subscriptions`);
    await getDb().execute(sql`DROP FUNCTION IF EXISTS review_pause_subscription()`);
  }
}), 60_000);

realTest("passive refresh of a different payer finishes before a billing mutation takes Server", async () => withPg(async () => {
  const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
  const { person, server, id } = await fixture();
  const { computers, serverMembers } = await import("../db/schema");
  const suffix = randomUUID();
  const [actor] = await getDb().insert(users).values({ name: `billing-actor-${suffix}`, email: `${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true }).returning();
  await getDb().insert(serverMembers).values({ serverId: server.id, userId: actor.id, role: "owner" });
  await getDb().insert(computers).values({ serverId: server.id, name: "synthetic-computer", apiKeyHash: "synthetic-hash", apiKeyPrefix: "synthetic-prefix", attachedByUserId: person.id });
  await getDb().update(subscriptions).set({ currentPeriodEnd: new Date(Date.now() - 1_000) }).where(eq(subscriptions.serverId, server.id));
  const entered = gate(), release = gate();
  __setStripeForTests({ subscriptions: {
    retrieve: async () => {
      entered.release(); await release.promise;
      return stripeSub({ id, serverId: server.id, userId: person.id, status: "active" });
    },
    update: async () => stripeSub({ id, serverId: server.id, userId: actor.id, status: "active", cancelAtPeriodEnd: true, canceledAt: 123 }),
  } } as unknown as Stripe);
  const billing = cancelSubscriptionAtPeriodEnd(server.id, actor.id);
  let deletion: Promise<unknown> | undefined, deletionCommitted = false;
  try {
    await Promise.race([entered.promise, billing.then(() => { throw new Error("billing skipped the intended passive refresh"); })]);
    deletion = outside(async () => { const result = await pendingRequest(person.id); deletionCommitted = true; return result; });
    const deadline = Date.now() + 3_000;
    while (!deletionCommitted && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(deletionCommitted, true, "the deleting payer can commit while the other owner's passive provider read is paused");
    release.release();
    const results = await Promise.allSettled([billing, deletion]);
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "fulfilled"]);
    const [current] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(current.cancelAtPeriodEnd, true);
    assert.equal(current.updatedByUserId, actor.id, "the explicit billing actor overrides the passive refresh's payer metadata");
  } finally {
    release.release();
    await Promise.allSettled([billing, ...(deletion ? [deletion] : [])]);
  }
}), 60_000);

realTest("a non-passive webhook propagates a busy-user failure and can be retried", async () => withPg(async pool => {
  const { person, server, id } = await fixture();
  const { handleWebhookEvent } = await import("./billingService");
  const { webhookEvents } = await import("../db/schema");
  const live = stripeSub({ id, serverId: server.id, userId: person.id, status: "active", cancelAtPeriodEnd: true, canceledAt: 123 });
  __setStripeForTests({ subscriptions: { retrieve: async () => live } } as unknown as Stripe);
  const event = { id: `evt_retry_${randomUUID()}`, type: "customer.subscription.updated", data: { object: live } } as unknown as Stripe.Event;
  const locker = await pool.connect(); let lockHeld = false;
  try {
    await locker.query("BEGIN"); lockHeld = true;
    await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [person.id]);
    await assert.rejects(getDb().transaction(async tx => {
      await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, server.id)).for("update");
      await handleWebhookEvent(event);
    }), error => {
      for (let cause: unknown = error; cause && typeof cause === "object"; cause = "cause" in cause ? cause.cause : undefined) {
        if ("code" in cause && cause.code === "55P03") return true;
      }
      return false;
    });
    const [claimed] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, event.id));
    assert.equal(claimed, undefined, "the failed inherited transaction did not leave a processed receipt");
    await locker.query("ROLLBACK"); lockHeld = false;
    await handleWebhookEvent(event);
    const [processed] = await getDb().select().from(webhookEvents).where(eq(webhookEvents.id, event.id));
    assert.equal(processed?.status, "processed", "the same event can complete after the conflicting user lock is released");
    const [current] = await getDb().select().from(subscriptions).where(eq(subscriptions.serverId, server.id));
    assert.equal(current.cancelAtPeriodEnd, true);
  } finally { if (lockHeld) await locker.query("ROLLBACK"); locker.release(); }
}), 60_000);


realTest("a real third-human invitation first reveals all while the original owner requests deletion", async () => {
  const pauses = await import("../test/pgQueryPause");
  pauses.installQueryPauseHook();
  try {
    await withPg(async pool => {
      const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
      const { person, server } = await fixture();
      const { computers, channels, channelHumans, serverMembers } = await import("../db/schema");
      const { createJoinLink, acceptInvite } = await import("./inviteService");
      const { transitionMemberRole } = await import("./serverService");
      const suffix = randomUUID();
      const [inviter, invitee] = await getDb().insert(users).values([
        { name: `inviter-${suffix}`, email: `inviter-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
        { name: `invitee-${suffix}`, email: `invitee-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
      ]).returning();
      await getDb().update(subscriptions).set({ currentPeriodEnd: new Date("2099-01-01T00:00:00Z"), provisionedHumanSeats: 5, proPackQuantity: 5 }).where(eq(subscriptions.serverId, server.id));
      // A real first invitation and owner promotion, rather than inserting a co-owner row.
      const first = await createJoinLink(server.id, person.id);
      assert.equal((await acceptInvite(first.token, inviter.id)).serverId, server.id);
      assert.equal((await transitionMemberRole({ serverId: server.id, actorUserId: person.id, targetUserId: inviter.id, nextRole: "owner" })).changed, true);
      const [all] = await getDb().select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
      assert.equal(all.type, "private", "the two-human team has not revealed all");
      assert.equal((await getDb().select().from(channelHumans).where(eq(channelHumans.channelId, all.id))).length, 0);
      assert.equal((await getDb().select().from(serverMembers).where(eq(serverMembers.serverId, server.id))).length, 2);
      await getDb().insert(computers).values({ serverId: server.id, name: "synthetic-computer", apiKeyHash: "synthetic-hash", apiKeyPrefix: "synthetic-prefix", attachedByUserId: person.id });
      let providerReads = 0;
      __setStripeForTests({ subscriptions: { retrieve: async () => { providerReads++; throw new Error("unexpected provider read"); } } } as unknown as Stripe);
      const third = await createJoinLink(server.id, inviter.id);
      const pause = pauses.pauseQuery((text, values) => /insert into "server_members"/i.test(text) && values.includes(invitee.id));
      const admission = outside(() => acceptInvite(third.token, invitee.id));
      let deletion: Promise<unknown> | undefined;
      let deletionPid = 0, admissionPid = 0, cycleObserved = false, waitQueries = "";
      let pauseTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        try {
          await Promise.race([pause.atPause, admission.then(() => { throw new Error("admission did not pause"); }), new Promise((_, reject) => { pauseTimer = setTimeout(() => reject(new Error("pause timed out")), 10_000); })]);
        } finally {
          clearTimeout(pauseTimer);
        }
        deletion = outside(() => getDb().transaction(async tx => {
          deletionPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
          return requestAccountDeletionInTransaction(tx, { userId: person.id, source: "self", actorUserId: person.id });
        }));
        const settled = Promise.allSettled([admission, deletion]);
        for (let i = 0; i < 200; i++) {
          const { rows } = await pool.query("SELECT pg_blocking_pids($1::int) AS blockers", [deletionPid]);
          admissionPid = rows[0]?.blockers?.[0] ?? 0;
          if (admissionPid) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(admissionPid, "the deletion really waits on the admission's locks");
        pause.release();
        const deadline = Date.now() + 1_500;
        while (Date.now() < deadline) {
          const { rows } = await pool.query("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AND $2::int = ANY(pg_blocking_pids($1::int)) AS cycle", [admissionPid, deletionPid]);
          if (rows[0]?.cycle) {
            cycleObserved = true;
            waitQueries = JSON.stringify((await pool.query("SELECT pid, left(query, 300) AS query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ANY($1::int[])", [[admissionPid, deletionPid]])).rows);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        const results = await settled;
        const errors = results.map(r => {
          if (r.status === "fulfilled") return "ok";
          const codes: string[] = [];
          for (let e: unknown = r.reason; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
            const code = (e as { code?: unknown }).code;
            if (typeof code === "string") codes.push(code);
          }
          return codes.join(",");
        });
        assert.equal(providerReads, 0);
        assert.ok(!cycleObserved && results.every(r => r.status === "fulfilled"), `cycle=${cycleObserved}; codes=${errors.join("|")}; queries=${waitQueries}`);
        const [member] = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
        assert.equal(member?.role, "member", "the third person's admission committed");
        assert.deepEqual((await getDb().select({ id: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, all.id))).map(r => r.id).sort(), [person.id, inviter.id, invitee.id].sort());
        const [pending] = await getDb().select().from(accountDeletionRequests).where(and(eq(accountDeletionRequests.userId, person.id), eq(accountDeletionRequests.state, "pending")));
        assert.ok(pending, "the deletion request also committed");
      } finally {
        pause.restore();
        await Promise.allSettled([admission, ...(deletion ? [deletion] : [])]);
      }
    });
  } finally {
    pauses.uninstallQueryPauseHook();
  }
}, 60_000);

realTest("real membership added after the unlocked audience guess forces a fresh invite transaction", async () => {
  const pauses = await import("../test/pgQueryPause");
  pauses.installQueryPauseHook();
  try {
    await withPg(async () => {
      const allMembership = await import("./allChannelMembership");
      const guess = vi.spyOn(allMembership, "missingAllChannelHumanUserIds");
      const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
      const { person, server } = await fixture();
      const { channels, channelHumans, serverMembers, serverJoinLinks } = await import("../db/schema");
      const { createJoinLink, acceptInvite } = await import("./inviteService");
      const { addMember } = await import("./serverService");
      const suffix = randomUUID();
      const [newMember, invitee] = await getDb().insert(users).values([
        { name: `new-member-${suffix}`, email: `new-member-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
        { name: `invitee-${suffix}`, email: `invitee-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
      ]).returning();
      await getDb().update(subscriptions).set({ currentPeriodEnd: new Date("2099-01-01T00:00:00Z"), provisionedHumanSeats: 5, proPackQuantity: 5 }).where(eq(subscriptions.serverId, server.id));
      const [all] = await getDb().select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all")));
      assert.equal(all.type, "private");
      const link = await createJoinLink(server.id, person.id);
      const pause = pauses.pauseQuery((text, values) => /select u\.id from users u[\s\S]*for key share/i.test(text) && values.includes(invitee.id));
      const admission = outside(() => acceptInvite(link.token, invitee.id));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pause.atPause, admission.then(() => { throw new Error("admission did not pause"); }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("pause timed out")), 10_000); })]);
        clearTimeout(timer);
        assert.equal(await outside(() => addMember(server.id, newMember.id)), true);
        const [hidden] = await getDb().select({ type: channels.type }).from(channels).where(eq(channels.id, all.id));
        assert.equal(hidden.type, "private");
        pause.release();
        await admission;
        assert.equal(guess.mock.calls.length, 2);
        const rows = await getDb().select({ id: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, all.id));
        assert.deepEqual(rows.map(row => row.id).sort(), [person.id, newMember.id, invitee.id].sort());
        const [linkRow] = await getDb().select({ uses: serverJoinLinks.useCount }).from(serverJoinLinks).where(eq(serverJoinLinks.id, link.link.id));
        assert.equal(linkRow.uses, 1);
        const members = await getDb().select().from(serverMembers).where(and(eq(serverMembers.serverId, server.id), eq(serverMembers.userId, invitee.id)));
        assert.equal(members.length, 1);
      } finally {
        clearTimeout(timer);
        pause.restore();
        await Promise.allSettled([admission]);
        guess.mockRestore();
      }
    });
  } finally {
    pauses.uninstallQueryPauseHook();
  }
}, 60_000);

realTest("a historical same-name DM must not make an unrelated member block an idempotent invite", async () => {
  await withPg(async pool => {
    const outside = AsyncResource.bind((run: () => Promise<unknown>) => run());
    const { person, server } = await fixture();
    const { channels, channelHumans } = await import("../db/schema");
    const { createJoinLink, acceptInvite } = await import("./inviteService");
    const { addMember } = await import("./serverService");
    const { findOrCreateUserDM } = await import("./channelService");
    const { missingAllChannelHumanUserIds } = await import("./allChannelMembership");
    const suffix = randomUUID();
    const [legacyUser, otherMember] = await getDb().insert(users).values([
      { name: "all", email: `legacy-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
      { name: `other-${suffix}`, email: `other-${suffix}@example.test`, passwordHash: "synthetic-fixture-only", emailVerified: true },
    ]).returning();
    await getDb().update(subscriptions).set({ currentPeriodEnd: new Date("2099-01-01T00:00:00Z"), provisionedHumanSeats: 5, proPackQuantity: 5 }).where(eq(subscriptions.serverId, server.id));
    assert.equal(await addMember(server.id, legacyUser.id), true);
    assert.equal(await addMember(server.id, otherMember.id), true);
    const [all] = await getDb().select().from(channels).where(and(eq(channels.serverId, server.id), eq(channels.name, "all"), eq(channels.type, "channel")));
    assert.ok(all);
    const allRows = await getDb().select({ id: channelHumans.userId }).from(channelHumans).where(eq(channelHumans.channelId, all.id));
    assert.deepEqual(allRows.map(row => row.id).sort(), [person.id, legacyUser.id, otherMember.id].sort());
    const dm = await findOrCreateUserDM(server.id, person.id, legacyUser.id);
    assert.ok(dm);
    const [dmRow] = await getDb().select({ name: channels.name, type: channels.type }).from(channels).where(eq(channels.id, dm.id));
    assert.deepEqual(dmRow, { name: "all", type: "dm" });
    const missing = await missingAllChannelHumanUserIds(getDb(), server.id);
    const link = await createJoinLink(server.id, person.id);
    const locker = await pool.connect();
    let admission: Promise<unknown> | undefined;
    let blocked = false;
    try {
      await locker.query("BEGIN");
      const held = await locker.query("SELECT pg_backend_pid() AS pid");
      await locker.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [otherMember.id]);
      let finished = false;
      admission = outside(() => acceptInvite(link.token, person.id)).finally(() => { finished = true; });
      for (let attempt = 0; attempt < 150 && !finished; attempt++) {
        const { rows } = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked", [held.rows[0].pid]);
        if (rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(finished, true, "the idempotent invite completed while the unrelated user stayed locked");
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      if (admission) await admission;
    }
    assert.equal(blocked, false, "the unrelated member's users row must not block an existing member opening a join link");
    assert.deepEqual(missing, [], "a DM named all is not the server's #all channel");
  });
}, 60_000);
