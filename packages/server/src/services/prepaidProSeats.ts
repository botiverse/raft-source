// Seats added to prepaid Pro time mid-period (task #19 PR4, #proj-commercial;
// docs/billing/prepaid-pro.md): the quote and the Alipay Checkout. The amount
// comes from prepaidProSeatsPricing.ts (by the days left, each paid period at
// its current Price); the webhook writes the `seats` row (prepaidProBilling.ts
// recordPrepaidCheckout), which prepaidGrantOf already counts.
import { eq } from "drizzle-orm";
import type Stripe from "stripe";
import type { PrepaidSeatsQuote, PrepaidSeatsQuoteUnavailableReason } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { servers } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import { hasAppSumoBillingReservation } from "./appSumoLicenseService";
import { CheckoutOutcomeUnknownError, canBuyPrepaid, markCheckoutAmbiguous, markCheckoutKnown, reserveStripeCheckout } from "./billingCheckoutCustody";
import { PREPAID_REQUEST_OPTIONS, PrepaidRequestError, expireOpenSessions, getPrepaidPrices, knownStripeCustomerId } from "./prepaidProBilling";
import { PREPAID_PRO_PRICING_CONTRACT } from "./prepaidProContracts";
import { getActivePrepaidGrant, listPrepaidPeriodsAhead } from "./prepaidProService";
import {
  encodePrepaidSeatSegments,
  prepaidSeatSegments,
  prepaidSeatUnitAmount,
  prepaidSeatsCheckoutLine,
  type PrepaidSeatsCheckoutTerms,
} from "./prepaidProSeatsPricing";

const CURRENCY = "usd";
/**
 * The price is for the days left when the Checkout is created, so it lives as
 * short as Stripe allows (30 minutes) and is quoted again after. A few minutes
 * over keep a slow clock inside Stripe's range (a refused create would leave
 * the attempt ambiguous and hold the Server's checkouts).
 */
const SEATS_SESSION_LIFETIME_S = 33 * 60;
/** Stripe's largest Checkout amount (USD 999,999.99). */
const STRIPE_MAX_AMOUNT = 99_999_999;
/** Keeps the `segments` metadata well inside Stripe's 500 characters per value. */
const MAX_SEGMENTS = 20;

/** The body's seats, checked at the route. */
export function parsePrepaidSeatQuantity(value: unknown): number {
  const seatQuantity = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof seatQuantity !== "number" || !Number.isSafeInteger(seatQuantity) || seatQuantity < 1 || seatQuantity > 10_000) {
    throw new PrepaidRequestError(400, "invalid_seat_quantity", "seatQuantity must be a positive integer");
  }
  return seatQuantity;
}

type SeatsTerms = PrepaidSeatsCheckoutTerms & { product: string; previousSeatQuantity: number };

/** What `seatQuantity` more seats cost now, or why they can't be added. */
async function currentSeatsTerms(stripe: Stripe | null, serverId: string, seatQuantity: number, now: Date): Promise<SeatsTerms | PrepaidSeatsQuoteUnavailableReason> {
  const db = getDb();
  const [server] = await db.select({ id: servers.id, plan: servers.plan }).from(servers).where(eq(servers.id, serverId));
  const grant = await getActivePrepaidGrant(db, serverId, now);
  if (!server || !grant) return "not_prepaid";
  if (grant.inGrace) return "in_grace";
  if (!await canBuyPrepaid(db, server, now) || await hasAppSumoBillingReservation(db, serverId)) return "not_prepaid";
  if (!stripe) return "not_configured";
  let prices: Awaited<ReturnType<typeof getPrepaidPrices>>;
  try {
    prices = await getPrepaidPrices(stripe);
  } catch (err) {
    addTraceEvent("billing.prepaid.price_lookup_failed", { error: err instanceof Error ? err.message : String(err) });
    return "not_configured";
  }
  const product = prices?.get(1)?.product;
  if (!prices || !product) return "not_configured";
  const endsAt = new Date(grant.endsAt);
  // Null when some of the paid time can't be priced (a gap, or a period with no Price): no seats for days not charged.
  const segments = prepaidSeatSegments(await listPrepaidPeriodsAhead(db, serverId, now), now, endsAt, months => prices.get(months)!.unitAmount);
  if (!segments || segments.length === 0 || segments.length > MAX_SEGMENTS) {
    addTraceEvent("billing.prepaid.seats_unpriceable", { server_id: serverId, segments: segments?.length ?? -1 });
    return "not_configured";
  }
  return { seatQuantity, unitAmount: prepaidSeatUnitAmount(segments), endsAt, segments, product, previousSeatQuantity: grant.seatQuantity };
}

export async function getPrepaidSeatsQuote(input: { stripe: Stripe | null; serverId: string; enabled: boolean; seatQuantity: number; now?: Date }): Promise<PrepaidSeatsQuote> {
  const terms = input.enabled ? await currentSeatsTerms(input.stripe, input.serverId, input.seatQuantity, input.now ?? new Date()) : "disabled";
  if (typeof terms === "string") {
    return { unavailableReason: terms, seatQuantity: input.seatQuantity, unitAmount: 0, amountTotal: 0, currency: CURRENCY, endsAt: null, days: 0, minimumApplied: false };
  }
  const line = prepaidSeatsCheckoutLine(terms.unitAmount, terms.seatQuantity);
  return {
    unavailableReason: null,
    seatQuantity: terms.seatQuantity,
    unitAmount: terms.unitAmount,
    amountTotal: line.amountTotal,
    currency: CURRENCY,
    endsAt: terms.endsAt.toISOString(),
    days: terms.segments.reduce((sum, segment) => sum + segment.daysLeft, 0),
    minimumApplied: line.minimumApplied,
  };
}

export interface PrepaidSeatsCheckoutRequest {
  seatQuantity: number;
  successUrl: string;
  cancelUrl: string;
  entry: string;
  openedFrom: string | null;
}

export interface PrepaidSeatsCheckoutStarted {
  url: string;
  /** When the Checkout stops taking payment (ISO): the price is for now. */
  expiresAt: string;
  seatQuantity: number;
  previousSeatQuantity: number;
  amountTotal: number;
  days: number;
}

const REFUSALS: Record<PrepaidSeatsQuoteUnavailableReason, [PrepaidRequestError["status"], string, string]> = {
  disabled: [403, "FEATURE_DISABLED", "Prepaid Pro is not available on this server."],
  not_configured: [503, "prepaid_not_configured", "Prepaid Pro is not configured"],
  not_prepaid: [409, "not_prepaid", "This server has no prepaid Pro time to add seats to."],
  in_grace: [409, "in_grace", "This server's prepaid Pro has ended. Renew it to add seats."],
};

/** Owner only, behind pro_prepaid (the route checks both). The price is computed here again, never taken from the request. */
export async function createPrepaidSeatsCheckout(stripe: Stripe, serverId: string, userId: string, request: PrepaidSeatsCheckoutRequest): Promise<PrepaidSeatsCheckoutStarted> {
  const terms = await currentSeatsTerms(stripe, serverId, request.seatQuantity, new Date());
  if (typeof terms === "string") {
    const [status, code, message] = REFUSALS[terms];
    throw new PrepaidRequestError(status, code, message);
  }
  const line = prepaidSeatsCheckoutLine(terms.unitAmount, terms.seatQuantity);
  if (line.amountTotal > STRIPE_MAX_AMOUNT) {
    throw new PrepaidRequestError(400, "invalid_seat_quantity", "That many seats is more than one payment can take. Add fewer at a time.");
  }
  const days = terms.segments.reduce((sum, segment) => sum + segment.daysLeft, 0);

  // Everything that can fail runs before the reservation (as for a period).
  const customerId = await knownStripeCustomerId(serverId);
  await expireOpenSessions(stripe, serverId, () => true);
  const attemptId = await reserveStripeCheckout(getDb(), serverId, "prepaid");
  const metadata: Record<string, string> = {
    pricingContract: PREPAID_PRO_PRICING_CONTRACT,
    kind: "seats",
    serverId,
    userId,
    seatQuantity: String(terms.seatQuantity),
    unitAmount: String(terms.unitAmount),
    endsAt: terms.endsAt.toISOString(),
    segments: encodePrepaidSeatSegments(terms.segments),
    previousSeatQuantity: String(terms.previousSeatQuantity),
    raftCheckoutAttemptId: attemptId,
    checkoutEntry: request.entry,
    ...(request.openedFrom ? { checkoutOpenedFrom: request.openedFrom } : {}),
  };
  const until = terms.endsAt.toISOString().slice(0, 10);
  const expiresAtS = Math.floor(Date.now() / 1000) + SEATS_SESSION_LIFETIME_S;
  const description = `Raft Pro, ${terms.seatQuantity === 1 ? "1 more seat" : `${terms.seatQuantity} more seats`} until ${until} (UTC), prepaid`;
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    payment_method_types: ["alipay"],
    line_items: [{ price_data: { currency: CURRENCY, product: terms.product, unit_amount: line.unitAmount }, quantity: line.quantity }],
    // The webhook checks the subtotal against the terms: no codes, no discounts.
    allow_promotion_codes: false,
    success_url: request.successUrl,
    cancel_url: request.cancelUrl,
    client_reference_id: serverId,
    ...(customerId ? { customer: customerId } : { customer_creation: "always" as const }),
    invoice_creation: { enabled: true, invoice_data: { description, metadata: { pricingContract: PREPAID_PRO_PRICING_CONTRACT, serverId } } },
    payment_intent_data: { description, metadata: { pricingContract: PREPAID_PRO_PRICING_CONTRACT, serverId, kind: "seats", seatQuantity: String(terms.seatQuantity) } },
    metadata,
    adaptive_pricing: { enabled: false },
    expires_at: expiresAtS,
  };
  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create(params, { idempotencyKey: `raft-prepaid-seats-checkout-${attemptId}`, ...PREPAID_REQUEST_OPTIONS });
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
  addTraceEvent("billing.prepaid.seats_checkout.session.created", { server_id: serverId, seat_quantity: terms.seatQuantity, days, amount_total: line.amountTotal });
  return {
    url: session.url,
    expiresAt: new Date((typeof session.expires_at === "number" ? session.expires_at : expiresAtS) * 1000).toISOString(),
    seatQuantity: terms.seatQuantity,
    previousSeatQuantity: terms.previousSeatQuantity,
    amountTotal: line.amountTotal,
    days,
  };
}
