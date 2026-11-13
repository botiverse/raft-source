// Prepaid Pro with Stripe (task #19, #proj-commercial; docs/billing/prepaid-pro.md):
// the offer (one-time Prices read by lookup_key), the Alipay Checkout, and the
// webhook writer of `prepaid_pro_purchases`. Provider calls never run inside a
// transaction; the server row lock serializes every write with the other paid
// sources. billingService owns the Stripe client and passes it in.
import { and, desc, eq, gt, inArray, isNotNull } from "drizzle-orm";
import type Stripe from "stripe";
import {
  PRO_PREPAID_GRACE_DAYS,
  PRO_PREPAID_MONTHS,
  isProPrepaidMonths,
  type PrepaidOffer,
  type PrepaidOfferPeriod,
  type ProPrepaidMonths,
  type ServerPlan,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { billingCheckoutAttempts, prepaidProPurchases, servers, subscriptions } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import { hasAppSumoBillingReservation } from "./appSumoLicenseService";
import { projectPaidSourceServerPlan } from "./appSumoLifecycleService";
import { CheckoutOutcomeUnknownError, canBuyPrepaid, markCheckoutAmbiguous, markCheckoutKnown, reserveStripeCheckout } from "./billingCheckoutCustody";
import { getServerBillingUsage } from "./planService";
import { PREPAID_PRO_PRICE_LOOKUP_KEYS, PREPAID_PRO_PRICING_CONTRACT, isPrepaidCheckoutSession } from "./prepaidProContracts";
import { parsePrepaidSeatsCheckoutTerms, prepaidSeatsAmountMatches } from "./prepaidProSeatsPricing";
import { getActivePrepaidGrant, getPrepaidPaidThrough, prepaidPeriodWindow } from "./prepaidProService";

const PREPAID_CURRENCY = "usd";
const PRICE_CACHE_MS = 5 * 60 * 1000;
/** Stripe allows 30 minutes to 24 hours; a little over the minimum keeps a slow clock inside the range. */
const SESSION_LIFETIME_S = 35 * 60;
/** Open Checkout sessions of the other kind younger than Stripe's 24-hour maximum are expired at checkout start. */
const OPEN_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const PREPAID_REQUEST_OPTIONS = { timeout: 15_000, maxNetworkRetries: 0 } as const;

export class PrepaidRequestError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, readonly code: string, message: string) { super(message); }
}

/** `product`: the Price's Stripe product, which seats added mid-period are sold under (prepaidProSeats.ts). */
type PrepaidPrice = { id: string; months: ProPrepaidMonths; unitAmount: number; currency: string; product: string | null };

let priceCache: { at: number; prices: Map<ProPrepaidMonths, PrepaidPrice> } | null = null;

export function __resetPrepaidPriceCacheForTests(): void {
  priceCache = null;
}

function validPrice(price: Stripe.Price, months: ProPrepaidMonths): PrepaidPrice | null {
  if (!price || typeof price.id !== "string" || !price.active || price.type !== "one_time"
    || price.currency !== PREPAID_CURRENCY || price.lookup_key !== PREPAID_PRO_PRICE_LOOKUP_KEYS[months]
    || !Number.isSafeInteger(price.unit_amount) || (price.unit_amount ?? 0) <= 0) return null;
  const product = typeof price.product === "string" ? price.product : price.product?.id ?? null;
  return { id: price.id, months, unitAmount: price.unit_amount!, currency: price.currency, product };
}

/** Both Prices, or null when either is missing or not what the contract expects (no partial offer). */
export async function getPrepaidPrices(stripe: Stripe, now = Date.now()): Promise<Map<ProPrepaidMonths, PrepaidPrice> | null> {
  if (priceCache && now - priceCache.at < PRICE_CACHE_MS) return priceCache.prices;
  const keys = PRO_PREPAID_MONTHS.map(months => PREPAID_PRO_PRICE_LOOKUP_KEYS[months]);
  const list = await stripe.prices.list({ lookup_keys: keys, active: true, limit: 10 }, PREPAID_REQUEST_OPTIONS);
  const prices = new Map<ProPrepaidMonths, PrepaidPrice>();
  for (const months of PRO_PREPAID_MONTHS) {
    const matches = (list?.data ?? []).filter(price => price?.lookup_key === PREPAID_PRO_PRICE_LOOKUP_KEYS[months]);
    const price = matches.length === 1 ? validPrice(matches[0], months) : null;
    if (!price) {
      addTraceEvent("billing.prepaid.price_invalid", { months, matches: matches.length });
      return null;
    }
    prices.set(months, price);
  }
  priceCache = { at: now, prices };
  return prices;
}

async function lockedServer(tx: DatabaseExecutor, serverId: string) {
  const [server] = await tx.select({ id: servers.id, plan: servers.plan, kind: servers.kind, deletedAt: servers.deletedAt })
    .from(servers).where(eq(servers.id, serverId)).for("update");
  return server ?? null;
}

/**
 * Seats priced to `endsAt` still join paid time at `now`: there is prepaid
 * time, not in its grace days, and it runs at least to `endsAt` (a period
 * refunded since would leave the seats paid for time the Server lacks).
 */
async function seatsFitPaidTime(tx: DatabaseExecutor, serverId: string, endsAt: Date, now: Date): Promise<boolean> {
  const grant = await getActivePrepaidGrant(tx, serverId, now);
  return Boolean(grant && !grant.inGrace && endsAt.getTime() > now.getTime() && endsAt.getTime() <= Date.parse(grant.endsAt));
}

async function minimumSeatQuantity(serverId: string): Promise<number> {
  const usage = await getServerBillingUsage(getDb(), serverId);
  return Math.max(1, Math.ceil(usage.universalSeats));
}

export async function getPrepaidOffer(input: { stripe: Stripe | null; serverId: string; enabled: boolean; now?: Date }): Promise<PrepaidOffer> {
  const now = input.now ?? new Date();
  const db = getDb();
  const [server] = await db.select({ id: servers.id, plan: servers.plan }).from(servers).where(eq(servers.id, input.serverId));
  const grant = await getActivePrepaidGrant(db, input.serverId, now);
  const minimum = await minimumSeatQuantity(input.serverId);
  let periods: PrepaidOfferPeriod[] = [];
  let unavailableReason: PrepaidOffer["unavailableReason"] = null;
  if (!input.enabled) unavailableReason = "disabled";
  else if (!server || !await canBuyPrepaid(db, server, now) || await hasAppSumoBillingReservation(db, input.serverId)) unavailableReason = "other_paid_source";
  if (input.stripe && unavailableReason !== "disabled") {
    try {
      const prices = await getPrepaidPrices(input.stripe);
      if (prices) periods = PRO_PREPAID_MONTHS.map(months => ({ months, unitAmount: prices.get(months)!.unitAmount, currency: prices.get(months)!.currency }));
    } catch (err) {
      addTraceEvent("billing.prepaid.price_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (!unavailableReason && periods.length === 0) unavailableReason = "not_configured";
  const paidThrough = grant ? new Date(grant.endsAt) : null;
  return {
    unavailableReason,
    periods,
    graceDays: PRO_PREPAID_GRACE_DAYS,
    minimumSeatQuantity: minimum,
    defaultSeatQuantity: Math.max(minimum, grant?.seatQuantity ?? 0),
    renewalStartsAt: paidThrough ? prepaidPeriodWindow(paidThrough, now, 1).startsAt.toISOString() : null,
  };
}

/** Best effort: an open Checkout of the other kind (or an older prepaid one) would let the Server pay twice. */
export async function expireOpenSessions(stripe: Stripe, serverId: string, expire: (session: Stripe.Checkout.Session) => boolean): Promise<void> {
  const since = new Date(Date.now() - OPEN_SESSION_WINDOW_MS);
  let attempts: Array<{ sessionId: string | null }>;
  try {
    attempts = await getDb().select({ sessionId: billingCheckoutAttempts.stripeSessionId }).from(billingCheckoutAttempts).where(and(
      eq(billingCheckoutAttempts.serverId, serverId), eq(billingCheckoutAttempts.state, "known"),
      isNotNull(billingCheckoutAttempts.stripeSessionId), gt(billingCheckoutAttempts.createdAt, since),
    )).orderBy(desc(billingCheckoutAttempts.createdAt)).limit(20);
  } catch (err) {
    addTraceEvent("billing.prepaid.open_session_expire_failed", { server_id: serverId, error: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const { sessionId } of attempts) {
    if (!sessionId) continue;
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {}, PREPAID_REQUEST_OPTIONS);
      if (session?.status !== "open" || !expire(session)) continue;
      await stripe.checkout.sessions.expire(sessionId, {}, PREPAID_REQUEST_OPTIONS);
      addTraceEvent("billing.prepaid.open_session_expired", { server_id: serverId, mode: session.mode });
    } catch (err) {
      // Completed in the meantime, or Stripe unreachable: the webhook's conflict check is the backstop.
      addTraceEvent("billing.prepaid.open_session_expire_failed", { server_id: serverId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Called by the subscription checkout: an open prepaid Checkout must not complete beside it. */
export async function expireOpenPrepaidSessions(stripe: Stripe, serverId: string): Promise<void> {
  await expireOpenSessions(stripe, serverId, isPrepaidCheckoutSession);
}

export async function knownStripeCustomerId(serverId: string): Promise<string | null> {
  const db = getDb();
  const [subscription] = await db.select({ customer: subscriptions.stripeCustomerId }).from(subscriptions).where(eq(subscriptions.serverId, serverId));
  if (subscription?.customer) return subscription.customer;
  const [purchase] = await db.select({ customer: prepaidProPurchases.stripeCustomerId }).from(prepaidProPurchases).where(and(
    eq(prepaidProPurchases.serverId, serverId), isNotNull(prepaidProPurchases.stripeCustomerId),
  )).orderBy(desc(prepaidProPurchases.createdAt)).limit(1);
  return purchase?.customer ?? null;
}

export interface PrepaidCheckoutRequest {
  months: ProPrepaidMonths;
  seatQuantity: number;
  successUrl: string;
  cancelUrl: string;
  entry: string;
  openedFrom: string | null;
  /** The surface the paywall that opened the dialog was on (analytics only; parsed by the caller). */
  surface?: string | null;
  defaultSeatQuantity: number | null;
}

/** The body's period and seats, checked at the route. */
export function parsePrepaidCheckoutBody(body: { months?: unknown; seatQuantity?: unknown } | null | undefined): { months: ProPrepaidMonths; seatQuantity: number } {
  const months = body?.months;
  if (!isProPrepaidMonths(months)) throw new PrepaidRequestError(400, "invalid_months", "months must be 1 or 12");
  const seatQuantity = body?.seatQuantity;
  if (typeof seatQuantity !== "number" || !Number.isSafeInteger(seatQuantity) || seatQuantity < 1 || seatQuantity > 10_000) {
    throw new PrepaidRequestError(400, "invalid_seat_quantity", "seatQuantity must be a positive integer");
  }
  return { months, seatQuantity };
}

export interface PrepaidCheckoutStarted {
  url: string;
  months: ProPrepaidMonths;
  seatQuantity: number;
  renewal: boolean;
}

export async function createPrepaidCheckout(stripe: Stripe, serverId: string, userId: string, request: PrepaidCheckoutRequest): Promise<PrepaidCheckoutStarted> {
  const { months, seatQuantity } = request;
  const minimum = await minimumSeatQuantity(serverId);
  if (seatQuantity < minimum) {
    throw new PrepaidRequestError(400, "seat_quantity_below_usage", `seatQuantity must be at least ${minimum} to cover current server usage`);
  }
  const prices = await getPrepaidPrices(stripe);
  const price = prices?.get(months);
  if (!price) throw new PrepaidRequestError(503, "prepaid_not_configured", "Prepaid Pro is not configured");

  // Everything that can fail runs before the reservation: a `creating`
  // attempt left behind would hold every later checkout of this Server.
  const grant = await getActivePrepaidGrant(getDb(), serverId, new Date());
  const customerId = await knownStripeCustomerId(serverId);
  await expireOpenSessions(stripe, serverId, () => true);
  const attemptId = await reserveStripeCheckout(getDb(), serverId, "prepaid");
  const metadata: Record<string, string> = {
    pricingContract: PREPAID_PRO_PRICING_CONTRACT,
    serverId,
    userId,
    months: String(months),
    seatQuantity: String(seatQuantity),
    priceId: price.id,
    raftCheckoutAttemptId: attemptId,
    checkoutEntry: request.entry,
    renewal: String(Boolean(grant)),
    ...(request.openedFrom ? { checkoutOpenedFrom: request.openedFrom } : {}),
    ...(request.surface ? { checkoutSurface: request.surface } : {}),
    ...(request.defaultSeatQuantity ? { defaultSeatQuantity: String(request.defaultSeatQuantity) } : {}),
  };
  const description = `Raft Pro, ${months === 1 ? "1 month" : `${months} months`}, prepaid`;
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["alipay"],
    line_items: [{ price: price.id, quantity: seatQuantity }],
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    client_reference_id: serverId,
    ...(customerId ? { customer: customerId } : { customer_creation: "always" as const }),
    invoice_creation: { enabled: true, invoice_data: { description, metadata: { pricingContract: PREPAID_PRO_PRICING_CONTRACT, serverId } } },
    payment_intent_data: { description, metadata: { pricingContract: PREPAID_PRO_PRICING_CONTRACT, serverId, months: String(months), seatQuantity: String(seatQuantity) } },
    metadata,
    // The webhook checks a USD amount; Adaptive Pricing would charge in CNY.
    adaptive_pricing: { enabled: false },
    expires_at: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_S,
  };
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(params, { idempotencyKey: `raft-prepaid-checkout-${attemptId}`, ...PREPAID_REQUEST_OPTIONS });
  } catch {
    await markCheckoutAmbiguous(getDb(), { id: attemptId, serverId }).catch(() => {});
    throw new CheckoutOutcomeUnknownError();
  }
  if (typeof session.id !== "string" || !session.id.trim()
    || !await markCheckoutKnown(getDb(), { id: attemptId, serverId, stripeSessionId: session.id })) {
    await markCheckoutAmbiguous(getDb(), { id: attemptId, serverId }).catch(() => {});
    throw new CheckoutOutcomeUnknownError();
  }
  if (!session.url) throw new CheckoutOutcomeUnknownError();
  addTraceEvent("billing.prepaid.checkout.session.created", { server_id: serverId, months, seat_quantity: seatQuantity, renewal: Boolean(grant) });
  return { url: session.url, months, seatQuantity, renewal: Boolean(grant) };
}

// ── Webhook ──

type ConflictReason = "paid_source" | "amount_mismatch" | "server_unavailable";

/** A period of Pro, or seats added to the paid time (no months). */
export type PrepaidCheckoutRecorded = {
  serverId: string | null;
  userId: string | null;
  result: "granted" | "refunded";
  seatQuantity: number;
  renewal: boolean;
  previousPlan: ServerPlan | null;
  nextPlan: ServerPlan | null;
  metadata: Stripe.Metadata;
} & ({ kind: "period"; months: ProPrepaidMonths } | { kind: "seats"; months: null });

function stripeId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string" && value.id.trim()) return value.id;
  return null;
}

/**
 * Whether Stripe charged exactly the contract: one line, the Price checkout
 * chose (its id is in the metadata; it may have been archived since, which
 * drops its lookup_key), the seats, no discount.
 */
async function amountMatches(stripe: Stripe, session: Stripe.Checkout.Session, seatQuantity: number): Promise<boolean> {
  const priceId = session.metadata?.priceId;
  if (!priceId || session.currency !== PREPAID_CURRENCY || !Number.isSafeInteger(session.amount_total)) return false;
  if ((session.total_details?.amount_discount ?? 0) !== 0) return false;
  const lines = await stripe.checkout.sessions.listLineItems(session.id, { limit: 5 }, PREPAID_REQUEST_OPTIONS);
  if (!lines || lines.data.length !== 1 || lines.has_more) return false;
  const [line] = lines.data;
  const price = line.price;
  if (!price || price.id !== priceId || line.quantity !== seatQuantity) return false;
  if (price.type !== "one_time" || price.currency !== PREPAID_CURRENCY) return false;
  if (!Number.isSafeInteger(price.unit_amount) || (price.unit_amount ?? 0) <= 0) return false;
  return session.amount_total === price.unit_amount! * seatQuantity;
}

function isAlreadyRefunded(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "charge_already_refunded");
}

/** The refund on a payment, for a refund Stripe says already happened (an idempotency key past 24 hours, or support). */
async function existingRefundId(stripe: Stripe, paymentIntentId: string): Promise<string | null> {
  const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 1 }, PREPAID_REQUEST_OPTIONS);
  return refunds?.data?.[0]?.id ?? null;
}

/** Refund a payment once; Stripe answering "already refunded" counts as done. Exported for the subscription side. */
export async function refundPaymentOnce(stripe: Stripe, input: { paymentIntentId?: string | null; chargeId?: string | null; idempotencyKey: string; metadata: Record<string, string> }): Promise<string | null> {
  try {
    const refund = await stripe.refunds.create(
      { ...(input.paymentIntentId ? { payment_intent: input.paymentIntentId } : { charge: input.chargeId! }), reason: "duplicate", metadata: input.metadata },
      { idempotencyKey: input.idempotencyKey, ...PREPAID_REQUEST_OPTIONS },
    );
    return refund.id;
  } catch (err) {
    if (!isAlreadyRefunded(err)) throw err;
    return input.paymentIntentId ? existingRefundId(stripe, input.paymentIntentId) : null;
  }
}

async function refundConflict(stripe: Stripe, row: { id: string; sessionId: string; paymentIntentId: string | null }): Promise<void> {
  if (!row.paymentIntentId) throw new Error("A conflicting prepaid payment has no payment intent to refund");
  const refundId = await refundPaymentOnce(stripe, {
    paymentIntentId: row.paymentIntentId,
    idempotencyKey: `raft-prepaid-conflict-refund-${row.sessionId}`,
    metadata: { pricingContract: PREPAID_PRO_PRICING_CONTRACT, raftPrepaidPurchaseId: row.id },
  });
  await getDb().update(prepaidProPurchases).set({ stripeRefundId: refundId, updatedAt: new Date() })
    .where(and(eq(prepaidProPurchases.id, row.id), eq(prepaidProPurchases.status, "conflict")));
}

/** Whether support (or anyone) already refunded the whole payment before its Checkout was recorded. */
async function alreadyFullyRefunded(stripe: Stripe, paymentIntentId: string | null): Promise<boolean> {
  if (!paymentIntentId) return false;
  const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] }, PREPAID_REQUEST_OPTIONS);
  const charge = intent?.latest_charge;
  if (!charge || typeof charge === "string") return false;
  return charge.refunded === true || (charge.amount_refunded ?? 0) >= charge.amount;
}

/**
 * Record a completed prepaid Checkout. Idempotent per session: a retried
 * webhook records nothing new, but finishes a conflict refund a crash left
 * undone. A refund that fails throws, so Stripe retries the event (and an
 * alert trace is left); the row already says `conflict`, so it never grants.
 */
export async function recordPrepaidCheckout(stripe: Stripe, session: Stripe.Checkout.Session, now: Date = new Date()): Promise<PrepaidCheckoutRecorded | null> {
  const metadata = session.metadata ?? {};
  // Seats added mid-period (prepaidProSeats.ts); a session without `kind` is a period.
  const seatTerms = metadata.kind === "seats" ? parsePrepaidSeatsCheckoutTerms(metadata) : null;
  const months = metadata.kind === "seats" ? null : Number(metadata.months);
  const seatQuantity = seatTerms ? seatTerms.seatQuantity : Number(metadata.seatQuantity);
  const serverId = typeof metadata.serverId === "string" && metadata.serverId ? metadata.serverId : null;
  if (session.payment_status !== "paid") {
    addTraceEvent("billing.prepaid.checkout.completed.skipped", { reason: "unpaid", payment_status: session.payment_status });
    return null;
  }
  const readable = metadata.kind === "seats" ? Boolean(seatTerms) : isProPrepaidMonths(months) && Number.isSafeInteger(seatQuantity) && seatQuantity >= 1;
  if (!serverId || !readable) {
    // Our contract, paid, but unreadable: nothing to grant or attribute. Needs a person.
    console.error(`[Billing] Prepaid checkout ${session.id} is paid but its metadata is invalid; refund it by hand`);
    addTraceEvent("billing.prepaid.checkout.alert", { reason: "invalid_metadata" });
    return null;
  }
  const paymentIntentId = stripeId(session.payment_intent);
  const customerId = stripeId(session.customer);
  const userId = typeof metadata.userId === "string" && metadata.userId ? metadata.userId : null;
  const db = getDb();
  // A retry needs no provider reads: the row says what happened.
  const [recorded] = await db.select({ id: prepaidProPurchases.id }).from(prepaidProPurchases).where(eq(prepaidProPurchases.stripeCheckoutSessionId, session.id));
  const amountOk = recorded ? true
    : seatTerms ? await prepaidSeatsAmountMatches(stripe, session, seatTerms, PREPAID_REQUEST_OPTIONS)
      : await amountMatches(stripe, session, seatQuantity);
  const refundedFirst = recorded ? false : await alreadyFullyRefunded(stripe, paymentIntentId);

  const outcome = await db.transaction(async tx => {
    const server = await lockedServer(tx, serverId);
    const [existing] = await tx.select().from(prepaidProPurchases).where(eq(prepaidProPurchases.stripeCheckoutSessionId, session.id));
    if (existing) return { row: existing, inserted: false, previousPlan: server?.plan ?? null, nextPlan: server?.plan ?? null };
    const usable = server && !server.deletedAt && server.kind === "normal";
    let conflict: ConflictReason | null = null;
    if (!usable) conflict = "server_unavailable";
    else if (!amountOk) conflict = "amount_mismatch";
    else if (await hasAppSumoBillingReservation(tx, serverId) || !await canBuyPrepaid(tx, server, now)) conflict = "paid_source";
    else if (seatTerms && !await seatsFitPaidTime(tx, serverId, seatTerms.endsAt, now)) conflict = "paid_source";
    // Seats run from payment to the end the Checkout priced. A conflicting row
    // grants nothing, but its window must still be a valid range.
    const window = seatTerms
      ? { startsAt: new Date(Math.min(now.getTime(), seatTerms.endsAt.getTime() - 1)), endsAt: seatTerms.endsAt }
      : prepaidPeriodWindow(await getPrepaidPaidThrough(tx, serverId), now, months as ProPrepaidMonths);
    // Refunded before the webhook landed (support): kept as history, never granting.
    const status = refundedFirst ? "refunded" : conflict ? "conflict" : "paid";
    const [row] = await tx.insert(prepaidProPurchases).values({
      serverId: server ? serverId : null,
      kind: seatTerms ? "seats" : "period",
      months: seatTerms ? null : months,
      seatQuantity,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      status,
      conflictReason: status === "conflict" ? conflict : null,
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      stripeCustomerId: customerId,
      amountTotal: Number.isSafeInteger(session.amount_total) ? session.amount_total! : 0,
      currency: session.currency ?? PREPAID_CURRENCY,
      purchasedByUserId: userId,
    }).onConflictDoNothing({ target: prepaidProPurchases.stripeCheckoutSessionId }).returning();
    if (!row) throw new Error("Prepaid purchase was recorded concurrently; retry");
    const previousPlan = server?.plan ?? null;
    if (status === "paid") await projectPaidSourceServerPlan(tx, serverId, now);
    const [after] = server ? await tx.select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId)) : [];
    return { row, inserted: true, previousPlan, nextPlan: after?.plan ?? null };
  });

  const { row } = outcome;
  let refundedNow = false;
  if (row.status === "conflict" && !row.stripeRefundId) {
    console.error(`[Billing] Prepaid checkout ${session.id} conflicts (${row.conflictReason}) on server ${serverId}; refunding`);
    addTraceEvent("billing.prepaid.checkout.conflict", { server_id: serverId, reason: row.conflictReason });
    try {
      await refundConflict(stripe, { id: row.id, sessionId: session.id, paymentIntentId: row.stripePaymentIntentId });
      refundedNow = true;
      addTraceEvent("billing.prepaid.conflict_refunded", { server_id: serverId, reason: row.conflictReason });
    } catch (err) {
      console.error(`[Billing] ALERT: refunding conflicting prepaid checkout ${session.id} failed; Stripe will retry the event. Refund it by hand within 90 days if this repeats.`);
      addTraceEvent("billing.prepaid.conflict_refund_failed", { server_id: serverId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }
  // A retry that finished the refund reports it (the first try threw before it could).
  if (!outcome.inserted && !refundedNow) return null;
  return {
    serverId: row.serverId,
    userId,
    result: row.status === "paid" ? "granted" : "refunded",
    ...(seatTerms ? { kind: "seats" as const, months: null } : { kind: "period" as const, months: months as ProPrepaidMonths }),
    seatQuantity,
    renewal: metadata.renewal === "true",
    previousPlan: outcome.previousPlan,
    nextPlan: outcome.nextPlan,
    metadata,
  };
}

/**
 * charge.refunded: a full refund ends the purchase it paid for (support
 * refunding by hand, or Raft's own conflict refund), and the Server is
 * re-projected at once. A partial refund changes nothing. Every charge's
 * `charge.refunded` comes here, so `stripe` is resolved only for a prepaid
 * payment: any other refund never needs Stripe configured.
 */
export async function recordPrepaidChargeRefunded(stripe: () => Stripe, charge: Stripe.Charge, now: Date = new Date()): Promise<{ serverId: string; previousPlan: ServerPlan; nextPlan: ServerPlan } | null> {
  const paymentIntentId = stripeId(charge.payment_intent);
  if (!paymentIntentId) return null;
  const db = getDb();
  const [row] = await db.select().from(prepaidProPurchases).where(eq(prepaidProPurchases.stripePaymentIntentId, paymentIntentId));
  if (!row) return null;
  const full = charge.refunded === true || (charge.amount_refunded ?? 0) >= charge.amount;
  if (!full) {
    addTraceEvent("billing.prepaid.partial_refund", { server_id: row.serverId });
    return null;
  }
  // Charges no longer carry their refunds: ask for the one on this payment.
  const refundId = row.stripeRefundId ?? await Promise.resolve().then(() => existingRefundId(stripe(), paymentIntentId)).catch(() => null);
  if (row.status !== "paid") {
    if (!row.stripeRefundId && refundId) await db.update(prepaidProPurchases).set({ stripeRefundId: refundId, updatedAt: now }).where(eq(prepaidProPurchases.id, row.id));
    return null;
  }
  const serverId = row.serverId;
  return db.transaction(async tx => {
    const server = serverId ? await lockedServer(tx, serverId) : null;
    await tx.update(prepaidProPurchases).set({ status: "refunded", stripeRefundId: refundId, updatedAt: now })
      .where(and(eq(prepaidProPurchases.id, row.id), eq(prepaidProPurchases.status, "paid")));
    if (!server || !serverId) return null;
    await projectPaidSourceServerPlan(tx, serverId, now);
    const [after] = await tx.select({ plan: servers.plan }).from(servers).where(eq(servers.id, serverId));
    addTraceEvent("billing.prepaid.refunded", { server_id: serverId });
    return { serverId, previousPlan: server.plan, nextPlan: after?.plan ?? server.plan };
  });
}

/** Prepaid sessions the webhook has recorded for a Server: their outcome is in the table, not in Stripe. */
export async function recordedPrepaidSessionIds(executor: DatabaseExecutor, sessionIds: readonly string[]): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const rows = await executor.select({ id: prepaidProPurchases.stripeCheckoutSessionId }).from(prepaidProPurchases)
    .where(inArray(prepaidProPurchases.stripeCheckoutSessionId, [...sessionIds]));
  return new Set(rows.map(row => row.id));
}
