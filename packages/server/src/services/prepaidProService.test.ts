import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase } from "../test/integration/database";
import { seedPrepaidPurchase } from "../test/prepaidProFixture";
import type { Database } from "../db/index";
import { appSumoLicenseBindings, appSumoLicenses, prepaidProPurchases, servers, subscriptions, users } from "../db/schema";
import { parseAppSumoLicenseKey } from "./appSumoContracts";
import { projectPaidSourceServerPlan } from "./appSumoLifecycleService";
import { getServerBillingEntitlement } from "./planService";
import {
  addCalendarMonthsUtc,
  getActivePrepaidGrant,
  getActivePrepaidGrants,
  listLapsedPrepaidServerIds,
  prepaidGrantOf,
  prepaidPeriodWindow,
} from "./prepaidProService";
import { sweepLapsedPrepaidServers } from "./prepaidProSweep";

afterEach(async () => {
  await closeTestDatabase();
});

const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string) => new Date(iso);
const days = (from: Date, n: number) => new Date(from.getTime() + n * DAY);

async function seedUser(db: Database, label: string) {
  return (await db.insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`, name: `${label}-${randomUUID().slice(0, 8)}`, displayName: label, passwordHash: "hash", emailVerified: true,
  }).returning())[0];
}

async function seedServer(db: Database, ownerId: string, plan: "free" | "pro" | "founder" = "free") {
  return (await db.insert(servers).values({ name: "Prepaid", slug: randomUUID(), ownerId, plan }).returning())[0];
}

async function planOf(db: Database, serverId: string) {
  const [row] = await db.select({ plan: servers.plan, downgradedAt: servers.planDowngradedAt }).from(servers).where(eq(servers.id, serverId));
  return row;
}

describe("calendar months", () => {
  test("a day the target month lacks clamps to its last day, in UTC", () => {
    assert.equal(addCalendarMonthsUtc(at("2027-01-31T10:20:30.400Z"), 1).toISOString(), "2027-02-28T10:20:30.400Z");
    assert.equal(addCalendarMonthsUtc(at("2028-01-31T00:00:00Z"), 1).toISOString(), "2028-02-29T00:00:00.000Z", "leap year");
    assert.equal(addCalendarMonthsUtc(at("2026-08-31T00:00:00Z"), 3).toISOString(), "2026-11-30T00:00:00.000Z");
    assert.equal(addCalendarMonthsUtc(at("2026-03-31T23:59:59Z"), 1).toISOString(), "2026-04-30T23:59:59.000Z");
    assert.equal(addCalendarMonthsUtc(at("2026-12-15T08:00:00Z"), 12).toISOString(), "2027-12-15T08:00:00.000Z", "across the year");
    assert.equal(addCalendarMonthsUtc(at("2028-02-29T00:00:00Z"), 12).toISOString(), "2029-02-28T00:00:00.000Z");
    assert.equal(addCalendarMonthsUtc(at("2026-11-04T09:00:00Z"), 1).toISOString(), "2026-12-04T09:00:00.000Z");
  });
});

describe("a new period's window", () => {
  const now = at("2026-11-04T00:00:00Z");
  test("starts now with nothing paid, or after the grace days ran out", () => {
    assert.deepEqual(prepaidPeriodWindow(null, now, 1), { startsAt: now, endsAt: at("2026-12-04T00:00:00Z") });
    assert.equal(prepaidPeriodWindow(days(now, -3), now, 1).startsAt.toISOString(), now.toISOString(), "exactly at the end of grace");
    assert.equal(prepaidPeriodWindow(days(now, -10), now, 12).endsAt.toISOString(), "2027-11-04T00:00:00.000Z");
  });
  test("continues from the paid end while time is left or during grace", () => {
    const paidThrough = at("2026-11-20T00:00:00Z");
    assert.deepEqual(prepaidPeriodWindow(paidThrough, now, 12), { startsAt: paidThrough, endsAt: at("2027-11-20T00:00:00Z") });
    const lapsed = days(now, -2);
    assert.equal(prepaidPeriodWindow(lapsed, now, 1).startsAt.toISOString(), lapsed.toISOString(), "grace days used are paid for");
  });
});

describe("the grant of one Server's rows", () => {
  const now = at("2026-11-04T12:00:00Z");
  const row = (startsAt: string, endsAt: string, seatQuantity = 2, kind: "period" | "seats" = "period") =>
    ({ serverId: "s", kind, seatQuantity, startsAt: at(startsAt), endsAt: at(endsAt) });

  test("covers the paid window and follows periods bought ahead", () => {
    assert.deepEqual(prepaidGrantOf([row("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 3)], now), {
      endsAt: "2026-12-01T00:00:00.000Z", graceEndsAt: "2026-12-04T00:00:00.000Z", inGrace: false, seatQuantity: 3,
    });
    const chain = [
      row("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 5),
      row("2026-12-01T00:00:00Z", "2027-03-01T00:00:00Z", 2),
      row("2027-03-01T00:00:00Z", "2028-03-01T00:00:00Z", 2),
    ];
    const grant = prepaidGrantOf(chain, now);
    assert.equal(grant?.endsAt, "2028-03-01T00:00:00.000Z");
    assert.equal(grant?.seatQuantity, 5, "a renewal with fewer seats applies only when it starts");
    assert.equal(prepaidGrantOf(chain, at("2026-12-15T00:00:00Z"))?.seatQuantity, 2);
  });

  test("keeps the end's seats through the grace days, then nothing", () => {
    const rows = [row("2026-10-01T00:00:00Z", "2026-11-03T00:00:00Z", 4)];
    assert.deepEqual(prepaidGrantOf(rows, now), {
      endsAt: "2026-11-03T00:00:00.000Z", graceEndsAt: "2026-11-06T00:00:00.000Z", inGrace: true, seatQuantity: 4,
    });
    assert.equal(prepaidGrantOf(rows, at("2026-11-05T23:59:59.999Z"))?.inGrace, true);
    assert.equal(prepaidGrantOf(rows, at("2026-11-06T00:00:00Z")), null);
  });

  test("a period that has not started grants nothing yet", () => {
    assert.equal(prepaidGrantOf([row("2026-11-05T00:00:00Z", "2026-12-05T00:00:00Z")], now), null);
    assert.equal(prepaidGrantOf([], now), null);
  });

  test("added seats count while they cover the moment", () => {
    const rows = [
      row("2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z", 2),
      row("2026-11-02T00:00:00Z", "2026-12-01T00:00:00Z", 3, "seats"),
      row("2026-11-10T00:00:00Z", "2026-12-01T00:00:00Z", 7, "seats"),
    ];
    assert.equal(prepaidGrantOf(rows, now)?.seatQuantity, 5);
    assert.equal(prepaidGrantOf(rows, at("2026-11-11T00:00:00Z"))?.seatQuantity, 12);
    assert.equal(prepaidGrantOf(rows, at("2026-12-02T00:00:00Z"))?.seatQuantity, 12, "in grace: the seats at the end");
  });
});

test("only paid purchases of a live, normal Server grant, and a deleted Server keeps the record", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-grant");
  const server = await seedServer(db, owner.id);
  const other = await seedServer(db, owner.id);
  const now = new Date();
  assert.equal(await getActivePrepaidGrant(db, server.id, now), null);
  const id = await seedPrepaidPurchase(db, { serverId: server.id, startsAt: days(now, -1), endsAt: days(now, 29), seatQuantity: 3 });
  assert.equal((await getActivePrepaidGrant(db, server.id, now))?.seatQuantity, 3);
  assert.deepEqual([...(await getActivePrepaidGrants(db, [server.id, other.id, server.id], now)).keys()], [server.id]);
  assert.equal((await getActivePrepaidGrants(db, [], now)).size, 0);

  const set = (values: Partial<typeof prepaidProPurchases.$inferInsert>) =>
    db.update(prepaidProPurchases).set(values).where(eq(prepaidProPurchases.id, id));
  await set({ status: "refunded" });
  assert.equal(await getActivePrepaidGrant(db, server.id, now), null, "a refunded period grants nothing");
  await set({ status: "conflict", conflictReason: "amount_mismatch" });
  assert.equal(await getActivePrepaidGrant(db, server.id, now), null, "a conflict is recorded, never granting");
  await set({ status: "paid", conflictReason: null });
  await db.update(servers).set({ kind: "joint_storage" }).where(eq(servers.id, server.id));
  assert.equal(await getActivePrepaidGrant(db, server.id, now), null);
  await db.update(servers).set({ kind: "normal", deletedAt: now }).where(eq(servers.id, server.id));
  assert.equal(await getActivePrepaidGrant(db, server.id, now), null);
  await db.delete(servers).where(eq(servers.id, server.id));
  const [kept] = await db.select().from(prepaidProPurchases).where(eq(prepaidProPurchases.id, id));
  assert.equal(kept.serverId, null, "a payment record outlives its Server");
});

test("through the database, added seats still count during the grace days", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-grace-seats");
  const server = await seedServer(db, owner.id);
  const now = new Date();
  const end = days(now, -1);
  await seedPrepaidPurchase(db, { serverId: server.id, startsAt: days(end, -30), endsAt: end, seatQuantity: 2 });
  await seedPrepaidPurchase(db, { serverId: server.id, kind: "seats", startsAt: days(end, -10), endsAt: end, seatQuantity: 3 });
  const grant = await getActivePrepaidGrant(db, server.id, now);
  assert.equal(grant?.inGrace, true);
  assert.equal(grant?.seatQuantity, 5);
  assert.equal(await getActivePrepaidGrant(db, server.id, days(end, 3)), null);
});

test("the schema refuses rows that cannot be a purchase", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-checks");
  const server = await seedServer(db, owner.id);
  const now = new Date();
  await assert.rejects(seedPrepaidPurchase(db, { serverId: server.id, startsAt: now, endsAt: now }), "an empty window");
  await assert.rejects(seedPrepaidPurchase(db, { serverId: server.id, startsAt: now, endsAt: days(now, 1), seatQuantity: 0 }));
  await assert.rejects(db.insert(prepaidProPurchases).values({
    serverId: server.id, kind: "period", months: 2, seatQuantity: 1, startsAt: now, endsAt: days(now, 60), status: "paid",
    stripeCheckoutSessionId: `cs_${randomUUID()}`, amountTotal: 1, currency: "usd",
  }), "months are 1, 3 or 12");
  await assert.rejects(db.insert(prepaidProPurchases).values({
    serverId: server.id, kind: "period", months: 1, seatQuantity: 1, startsAt: now, endsAt: days(now, 30), status: "conflict",
    stripeCheckoutSessionId: `cs_${randomUUID()}`, amountTotal: 1, currency: "usd",
  }), "a conflict says why");
  const sessionId = `cs_${randomUUID()}`;
  const values = { serverId: server.id, kind: "period" as const, months: 1, seatQuantity: 1, startsAt: now, endsAt: days(now, 30),
    status: "paid" as const, stripeCheckoutSessionId: sessionId, amountTotal: 1000, currency: "usd" };
  await db.insert(prepaidProPurchases).values(values);
  await assert.rejects(db.insert(prepaidProPurchases).values(values), "one row per Checkout session");
});

test("entitlement: prepaid time makes a Server Pro at its seats, below a subscription, AppSumo and founder", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-entitlement");
  const server = await seedServer(db, owner.id, "pro");
  const now = new Date();
  await seedPrepaidPurchase(db, { serverId: server.id, startsAt: days(now, -1), endsAt: days(now, 29), seatQuantity: 4 });
  // A Server that once had a subscription can still buy prepaid time.
  await db.insert(subscriptions).values({ serverId: server.id, stripeCustomerId: "cus_old", stripeSubscriptionId: "sub_old", status: "canceled" });
  let entitlement = await getServerBillingEntitlement(db, server.id, now);
  assert.equal(entitlement.source, "prepaid");
  assert.equal(entitlement.plan, "pro");
  assert.equal(entitlement.proPackQuantity, 4);
  assert.equal(entitlement.provisionedAgentSeats, 4 * PRO_AGENT_SEAT_BLOCK_SIZE);
  assert.equal(entitlement.prepaid?.inGrace, false);
  assert.deepEqual(entitlement.capacity, { maxHumans: -1, maxAgents: -1, maxUniversalSeats: 4 });

  await db.update(subscriptions).set({ status: "active", proPackQuantity: 9 }).where(eq(subscriptions.serverId, server.id));
  entitlement = await getServerBillingEntitlement(db, server.id, now);
  assert.equal(entitlement.source, "subscription", "an entitling subscription wins an overlap");
  assert.equal(entitlement.prepaid, undefined);
  assert.equal(entitlement.capacity.maxUniversalSeats, 9);

  await db.update(subscriptions).set({ status: "canceled" }).where(eq(subscriptions.serverId, server.id));
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values({ productId: "233088", licenseKey: key, tier: 2, status: "active", verifiedAt: now });
  await db.insert(appSumoLicenseBindings).values({ serverId: server.id, productId: "233088", originalLicenseKey: key, currentLicenseKey: key,
    boundByUserId: owner.id, activatedAt: now });
  entitlement = await getServerBillingEntitlement(db, server.id, now);
  assert.equal(entitlement.source, "appsumo");
  assert.equal(entitlement.prepaid, undefined);

  await db.delete(appSumoLicenseBindings).where(eq(appSumoLicenseBindings.serverId, server.id));
  await db.update(servers).set({ plan: "founder" }).where(eq(servers.id, server.id));
  entitlement = await getServerBillingEntitlement(db, server.id, now);
  assert.equal(entitlement.plan, "founder");
  assert.equal(entitlement.source, "server");

  await db.update(servers).set({ plan: "free" }).where(eq(servers.id, server.id));
  entitlement = await getServerBillingEntitlement(db, server.id, days(now, 31));
  assert.equal(entitlement.source, "prepaid", "the grace days keep Pro");
  assert.equal(entitlement.prepaid?.inGrace, true);
  entitlement = await getServerBillingEntitlement(db, server.id, days(now, 33));
  assert.equal(entitlement.plan, "free", "after the grace days the canceled subscription row reads as Free");
});

test("projecting paid sources keeps a prepaid Server Pro and drops it once the time and grace are over", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-project");
  const server = await seedServer(db, owner.id);
  const now = new Date();
  await seedPrepaidPurchase(db, { serverId: server.id, startsAt: days(now, -1), endsAt: days(now, 2) });
  await db.transaction(tx => projectPaidSourceServerPlan(tx, server.id, now));
  assert.deepEqual(await planOf(db, server.id), { plan: "pro", downgradedAt: null });
  await db.transaction(tx => projectPaidSourceServerPlan(tx, server.id, days(now, 4)));
  assert.equal((await planOf(db, server.id)).plan, "pro", "in grace");
  const later = days(now, 6);
  await db.transaction(tx => projectPaidSourceServerPlan(tx, server.id, later));
  const after = await planOf(db, server.id);
  assert.equal(after.plan, "free");
  assert.equal(after.downgradedAt?.toISOString(), later.toISOString());
});

test("the lapse sweep drops only Servers no paid source keeps Pro, and leaves Pro turned on by hand alone", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-sweep");
  const now = new Date();
  const lapsedEnd = days(now, -4);
  const lapsed = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: lapsed.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd });
  const inGrace = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: inGrace.id, startsAt: days(now, -31), endsAt: days(now, -1) });
  const renewed = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: renewed.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd });
  await seedPrepaidPurchase(db, { serverId: renewed.id, startsAt: lapsedEnd, endsAt: days(lapsedEnd, 30) });
  const founder = await seedServer(db, owner.id, "founder");
  await seedPrepaidPurchase(db, { serverId: founder.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd });
  const subscribed = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: subscribed.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd });
  await db.insert(subscriptions).values({ serverId: subscribed.id, stripeCustomerId: "cus_s", stripeSubscriptionId: `sub_${randomUUID()}`, status: "active" });
  const byHand = await seedServer(db, owner.id, "pro");
  const longAgo = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: longAgo.id, startsAt: days(now, -90), endsAt: days(now, -60) });
  const refunded = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: refunded.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd, status: "refunded" });
  const licensed = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: licensed.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd });
  const key = parseAppSumoLicenseKey(randomUUID())!;
  await db.insert(appSumoLicenses).values({ productId: "233088", licenseKey: key, tier: 1, status: "active", verifiedAt: now });
  await db.insert(appSumoLicenseBindings).values({ serverId: licensed.id, productId: "233088", originalLicenseKey: key, currentLicenseKey: key,
    boundByUserId: owner.id, activatedAt: now });
  const conflicted = await seedServer(db, owner.id, "pro");
  await seedPrepaidPurchase(db, { serverId: conflicted.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd, status: "conflict" });

  const candidates = await listLapsedPrepaidServerIds(db, now);
  assert.deepEqual(new Set(candidates), new Set([lapsed.id, refunded.id]), [
    "founder is not Pro; in-grace and renewed still grant; a subscription or AppSumo keeps the others Pro, so they are not re-projected",
    "every hour; by-hand has no record, a conflict row never granted, longAgo is past the lookback",
  ].join(" "));

  const result = await sweepLapsedPrepaidServers(() => now);
  assert.deepEqual(new Set(result.downgraded), new Set([lapsed.id, refunded.id]));
  assert.equal((await planOf(db, lapsed.id)).plan, "free");
  assert.ok((await planOf(db, lapsed.id)).downgradedAt, "the ordinary downgrade starts");
  for (const server of [inGrace, renewed, subscribed, licensed, byHand, longAgo, conflicted]) {
    assert.equal((await planOf(db, server.id)).plan, "pro", "another source, grace, a renewal or a by-hand Pro keeps it");
  }
  assert.equal((await planOf(db, founder.id)).plan, "founder", "an internal plan that once bought prepaid time is never dropped");

  const again = await sweepLapsedPrepaidServers(() => now);
  assert.deepEqual(again.downgraded, [], "idempotent");
});

test("the lapse sweep reads the time again under the row lock, so a renewal that just committed counts", async ({ db }) => {
  const owner = await seedUser(db, "prepaid-sweep-race");
  const server = await seedServer(db, owner.id, "pro");
  const listedAt = new Date();
  const lapsedEnd = days(listedAt, -4);
  await seedPrepaidPurchase(db, { serverId: server.id, startsAt: days(lapsedEnd, -30), endsAt: lapsedEnd });
  // The owner renews after grace ran out: the new period starts at payment, a moment after the sweep listed candidates.
  const paidAt = new Date(listedAt.getTime() + 1000);
  let reads = 0;
  const clock = () => {
    reads += 1;
    return reads === 1 ? listedAt : paidAt;
  };
  await seedPrepaidPurchase(db, { serverId: server.id, startsAt: paidAt, endsAt: days(paidAt, 30) });
  const result = await sweepLapsedPrepaidServers(clock);
  assert.equal(result.candidates, 1, "at the listing time the renewal had not started");
  assert.deepEqual(result.downgraded, []);
  assert.deepEqual(await planOf(db, server.id), { plan: "pro", downgradedAt: null }, "the projection saw the renewal");
});
