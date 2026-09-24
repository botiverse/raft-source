import Stripe from "stripe";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { subscriptions, servers, webhookEvents } from "../db/schema.js";
import type { Server as SocketIOServer } from "socket.io";
import {
  PRO_AGENT_SEAT_BLOCK_SIZE,
  PLAN_CONFIG,
  DEFAULT_BILLING_INTERVAL,
  calculateAgentSeatBlockQuantity,
  calculateProPrice,
  calculateProPackQuantity,
  calculateProSeatPrice,
  currentTimeMs,
  normalizeBillingInterval,
  type BillingInterval,
  type BillingPriceSummary,
  type ServerPlan,
} from "@botiverse/raft-shared";
import { getServerBillingEntitlement, getServerBillingUsage } from "./planService.js";
import { getWebFrameAncestorOrigins } from "../config/appUrl.js";
import { addTraceEvent, traceAttrs } from "../tracing/semanticTrace.js";

// ── Socket.io reference for broadcasting plan changes ──

let _io: SocketIOServer | null = null;

export function setIO(io: SocketIOServer) {
  _io = io;
}

function broadcastPlanChange(serverId: string, plan: string) {
  if (_io) {
    _io.to(`server:${serverId}`).emit("server:plan-updated", { serverId, plan });
  }
}

function traceBillingEvent(name: string, attrs?: Record<string, unknown>): void {
  addTraceEvent(name, attrs);
}

function traceStripeBillingState(): Record<string, unknown> {
  return {
    stripe_billing_flag_enabled: isStripeBillingFlagEnabled(),
    stripe_configured: isStripeConfigured(),
  };
}

function traceRequestedSeatQuantity(request: BillingPackQuantityRequest): number | string | null {
  const value = request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity;
  if (value == null || value === "") return null;
  if (typeof value === "number" || typeof value === "string") return value;
  return "invalid";
}

// ── Stripe Client (lazy init — only created when env vars are present) ──

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY missing)");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

export function __setStripeForTests(stripe: Stripe | null): void {
  _stripe = stripe;
}

export function __resetStripeForTests(): void {
  _stripe = null;
}

const REQUIRED_STRIPE_BILLING_ENV = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRO_SEAT_MONTHLY_PRICE_ID",
  "STRIPE_PRO_SEAT_ANNUAL_PRICE_ID",
] as const;

function isStripeBillingFlagEnabled(): boolean {
  return process.env.STRIPE_BILLING_ENABLED?.trim().toLowerCase() === "true";
}

/** Returns true if Stripe billing is explicitly enabled and all required env vars are set. */
export function isStripeConfigured(): boolean {
  return isStripeBillingFlagEnabled() && REQUIRED_STRIPE_BILLING_ENV.every((key) => !!process.env[key]?.trim());
}

const PASSIVE_SUBSCRIPTION_REFRESH_MS = 6 * 60 * 60 * 1000;

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

type PaidBillingPlan = "pro";

interface StripePriceIds {
  proSeatMonthly: string;
  proSeatAnnual: string;
}

function getStripePriceIds(): StripePriceIds {
  return {
    proSeatMonthly: getRequiredEnv("STRIPE_PRO_SEAT_MONTHLY_PRICE_ID"),
    proSeatAnnual: getRequiredEnv("STRIPE_PRO_SEAT_ANNUAL_PRICE_ID"),
  };
}

// ── Billing Summary ──

function priceForSummary(plan: string, seatQuantity: number, billingInterval: BillingInterval): BillingPriceSummary | null {
  if (plan === "pro") return calculateProPrice(seatQuantity, billingInterval);
  return null;
}

export async function getBillingSummary(serverId: string) {
  traceBillingEvent("billing.summary.requested", {
    server_id: serverId,
    ...traceStripeBillingState(),
  });
  const db = getDb();
  await refreshSubscriptionForServer(serverId);
  const { getFileUploadQuotaSummary } = await import("./fileUploadQuotaService.js");
  const [server] = await db
    .select({ plan: servers.plan })
    .from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  const entitlement = await getServerBillingEntitlement(db, serverId);
  const usage = await getServerBillingUsage(db, serverId);
  const fileUploadQuota = await getFileUploadQuotaSummary(serverId);
  const sub = await getSubscription(serverId);
  const billingInterval = normalizeBillingInterval(entitlement.billingInterval ?? sub?.billingInterval ?? DEFAULT_BILLING_INTERVAL);
  const provisionedHumans = entitlement.provisionedHumanSeats ?? (entitlement.plan === "pro" ? entitlement.capacity.maxHumans : usage.humans);
  const provisionedAgents = entitlement.provisionedAgentSeats ?? (entitlement.plan === "pro" ? entitlement.capacity.maxAgents : usage.agents);
  const isInternalUnlimitedPlan = entitlement.plan === "founder" || entitlement.plan === "partner";

  const summary = {
    plan: entitlement.plan,
    displayName: PLAN_CONFIG[entitlement.plan].displayName,
    serverPlan: server?.plan ?? "free",
    source: entitlement.source,
    capacity: entitlement.capacity,
    usage,
    fileUploadQuota,
    provisioned: {
      humans: provisionedHumans,
      agents: provisionedAgents,
      proPackQuantity: entitlement.proPackQuantity ?? 0,
      trialFreePackQuantity: entitlement.trialFreePackQuantity ?? 0,
      firstPackTrialEndsAt: entitlement.firstPackTrialEndsAt ?? null,
    },
    price: priceForSummary(entitlement.plan, entitlement.proPackQuantity ?? 0, billingInterval),
    subscription: sub && !isInternalUnlimitedPlan
      ? {
          status: sub.status,
          billingInterval: sub.billingInterval,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null,
    stripeConfigured: isStripeConfigured(),
  };
  traceBillingEvent("billing.summary.ready", {
    server_id: serverId,
    plan: summary.plan,
    server_plan: summary.serverPlan,
    entitlement_source: summary.source,
    stripe_configured: summary.stripeConfigured,
    subscription_status: summary.subscription?.status ?? "none",
    billing_interval: billingInterval,
    seat_quantity: summary.provisioned.proPackQuantity,
    provisioned_human_seats: summary.provisioned.humans,
    provisioned_agent_seats: summary.provisioned.agents,
  });
  return summary;
}

// ── Redirect URL Validation ──

/** Get allowed origins from CORS_ORIGIN env (for redirect URL validation). */
function getAllowedOrigins(): string[] {
  return getWebFrameAncestorOrigins();
}

/** Validate that a redirect URL's origin is in our CORS allowlist. */
export function validateRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return getAllowedOrigins().includes(parsed.origin);
  } catch {
    return false;
  }
}

// ── Checkout ──

export interface BillingCheckoutRequest {
  targetPlan?: unknown;
  billingTraceId?: unknown;
  billingInterval?: unknown;
  interval?: unknown;
  seatQuantity?: unknown;
  packQuantity?: unknown;
  proPackQuantity?: unknown;
  humanSeatQuantity?: unknown;
  agentSeatQuantity?: unknown;
  humanSeats?: unknown;
  agentSeats?: unknown;
  provisionedAgentSeats?: unknown;
  provisionedHumanSeats?: unknown;
}

export interface BillingPackQuantityRequest {
  seatQuantity?: unknown;
  packQuantity?: unknown;
  proPackQuantity?: unknown;
  humanSeatQuantity?: unknown;
  agentSeatQuantity?: unknown;
  humanSeats?: unknown;
  agentSeats?: unknown;
  provisionedHumanSeats?: unknown;
  provisionedAgentSeats?: unknown;
  promotionCode?: unknown;
  previewToken?: unknown;
}

export interface BillingPackQuantityUpdateResult {
  status: "unchanged" | "updated" | "reactivated" | "pending_payment" | "pending_webhook" | "scheduled_period_end";
  currentPackQuantity: number;
  requestedPackQuantity: number;
  effectiveAt: "current" | "after_payment" | "period_end";
  currentPeriodEnd: Date | null;
}

export interface BillingPackQuantityPreviewResult {
  status: "preview";
  currentPackQuantity: number;
  requestedPackQuantity: number;
  currency: string;
  prorationAmount: number;
  recurringAmount: number;
  discountAmount: number;
  promotion: {
    code: string;
    name: string | null;
    percentOff: number | null;
    amountOff: number | null;
    currency: string | null;
  } | null;
  previewToken: string;
  expiresAt: string;
}

interface CheckoutContract {
  lineItems: Array<{ price: string; quantity: number }>;
  metadata: Record<string, string>;
  subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData;
}

const RAFT_PRO_SEAT_PRICING_CONTRACT = "raft-pro-seat-v1";

function toNonNegativeInteger(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function toPositiveInteger(value: unknown, label: string): number | null {
  if (value == null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function toBillingInterval(value: unknown): BillingInterval {
  if (value == null || value === "") return DEFAULT_BILLING_INTERVAL;
  if (value === "monthly" || value === "annual") return value;
  throw new Error("billingInterval must be monthly or annual");
}

function toBillingTraceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(trimmed)) return null;
  return trimmed;
}

function proSeatPriceIdForInterval(priceIds: StripePriceIds | Partial<StripePriceIds>, billingInterval: BillingInterval): string | undefined {
  return billingInterval === "annual" ? priceIds.proSeatAnnual : priceIds.proSeatMonthly;
}

function buildCheckoutContract(input: BillingCheckoutRequest, userId: string, serverId: string): CheckoutContract {
  const plan = input.targetPlan;
  if (plan !== "pro") {
    throw new Error("targetPlan must be pro");
  }

  const priceIds = getStripePriceIds();
  const billingInterval = toBillingInterval(input.billingInterval ?? input.interval);
  const explicitSeats = toPositiveInteger(input.seatQuantity ?? input.packQuantity ?? input.proPackQuantity, "seatQuantity");
  const requestedHumans = toPositiveInteger(
    input.humanSeatQuantity ?? input.humanSeats ?? input.provisionedHumanSeats,
    "humanSeatQuantity",
  ) ?? 1;
  const requestedAgents = toNonNegativeInteger(
    input.agentSeatQuantity ?? input.agentSeats ?? input.provisionedAgentSeats,
    "agentSeatQuantity",
  ) ?? 0;
  const seatQuantity = explicitSeats ?? calculateProPackQuantity(requestedHumans, requestedAgents);
  const provisionedAgentSeats = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  const billingTraceId = toBillingTraceId(input.billingTraceId);
  const metadata = {
    pricingContract: RAFT_PRO_SEAT_PRICING_CONTRACT,
    serverId,
    userId,
    targetPlan: "pro",
    billingInterval,
    seatQuantity: String(seatQuantity),
    humanSeatQuantity: String(requestedHumans),
    requestedAgentSeats: String(requestedAgents),
    agentSeatBlockQuantity: String(calculateAgentSeatBlockQuantity(requestedAgents)),
    proPackQuantity: String(seatQuantity),
    packQuantity: String(seatQuantity),
    stripeInitialPaidPackQuantity: String(seatQuantity),
    provisionedHumanSeats: String(seatQuantity),
    provisionedAgentSeats: String(provisionedAgentSeats),
    trialFreePackQuantity: "0",
    ...(billingTraceId ? { billingTraceId } : {}),
  };
  const subscriptionData: Stripe.Checkout.SessionCreateParams.SubscriptionData = {
    metadata,
  };
  const lineItems = [{ price: proSeatPriceIdForInterval(priceIds, billingInterval)!, quantity: seatQuantity }];
  return {
    lineItems,
    metadata,
    subscriptionData,
  };
}

export async function createCheckoutSession(
  serverId: string,
  userId: string,
  successUrl: string,
  cancelUrl: string,
  request: BillingCheckoutRequest = {},
): Promise<string> {
  traceBillingEvent("billing.checkout.requested", {
    server_id: serverId,
    billing_trace_id: toBillingTraceId(request.billingTraceId),
    user_id_present: Boolean(userId),
    target_plan: typeof request.targetPlan === "string" ? request.targetPlan : "unknown",
    requested_seat_quantity: request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity ?? null,
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const stripe = getStripe();
    const contract = buildCheckoutContract(request, userId, serverId);
    traceBillingEvent("billing.checkout.contract_built", {
      server_id: serverId,
      billing_trace_id: contract.metadata.billingTraceId ?? null,
      target_plan: contract.metadata.targetPlan,
      billing_interval: contract.metadata.billingInterval,
      pricing_contract: contract.metadata.pricingContract,
      seat_quantity: Number(contract.metadata.seatQuantity),
      requested_human_seats: Number(contract.metadata.humanSeatQuantity),
      requested_agent_seats: Number(contract.metadata.requestedAgentSeats),
      provisioned_human_seats: Number(contract.metadata.provisionedHumanSeats),
      provisioned_agent_seats: Number(contract.metadata.provisionedAgentSeats),
    });
    const existing = await getSubscription(serverId);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: serverId,
      customer: existing?.stripeCustomerId,
      allow_promotion_codes: true,
      line_items: contract.lineItems,
      metadata: contract.metadata,
      subscription_data: contract.subscriptionData,
    });

    if (!session.url) {
      traceBillingEvent("billing.checkout.session.missing_url", {
        server_id: serverId,
        billing_trace_id: contract.metadata.billingTraceId ?? null,
      });
      throw new Error("Stripe Checkout did not return a URL");
    }
    traceBillingEvent("billing.checkout.session.created", {
      server_id: serverId,
      billing_trace_id: contract.metadata.billingTraceId ?? null,
      existing_customer_present: Boolean(existing?.stripeCustomerId),
      promotion_codes_enabled: true,
      stripe_session_url_present: Boolean(session.url),
      line_item_count: contract.lineItems.length,
    });
    return session.url;
  } catch (error) {
    traceBillingEvent("billing.checkout.failed", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(request.billingTraceId),
      stage: "checkout_session_create",
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

// ── Existing Subscription Seat Quantity Updates ──

function subscriptionMetadataForSeatQuantity(
  stripeSub: Stripe.Subscription,
  seatQuantity: number,
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  const metadata = stripeSub.metadata ?? {};
  const provisionedAgentSeats = seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE;
  return {
    pricingContract: RAFT_PRO_SEAT_PRICING_CONTRACT,
    serverId: overrides.serverId ?? metadata.serverId ?? "",
    userId: overrides.userId ?? metadata.userId ?? "",
    targetPlan: "pro",
    billingInterval: overrides.billingInterval ?? metadata.billingInterval ?? DEFAULT_BILLING_INTERVAL,
    seatQuantity: String(seatQuantity),
    humanSeatQuantity: overrides.humanSeatQuantity ?? metadata.humanSeatQuantity ?? String(seatQuantity),
    requestedAgentSeats: overrides.requestedAgentSeats ?? metadata.requestedAgentSeats ?? "0",
    agentSeatBlockQuantity: String(calculateAgentSeatBlockQuantity(Number(overrides.requestedAgentSeats ?? metadata.requestedAgentSeats ?? 0))),
    provisionedHumanSeats: String(seatQuantity),
    provisionedAgentSeats: String(provisionedAgentSeats),
    proPackQuantity: String(seatQuantity),
    packQuantity: String(seatQuantity),
    stripeInitialPaidPackQuantity: String(seatQuantity),
    trialFreePackQuantity: "0",
  };
}

function getSubscriptionItemByPrice(stripeSub: Stripe.Subscription, priceId: string | undefined): Stripe.SubscriptionItem | null {
  if (!priceId) return null;
  return stripeSub.items.data.find((item) => item.price.id === priceId) ?? null;
}

function getProSeatSubscriptionItem(
  stripeSub: Stripe.Subscription,
  priceIds: Partial<StripePriceIds> = getConfiguredPriceIdsBestEffort(),
): Stripe.SubscriptionItem | null {
  return getSubscriptionItemByPrice(stripeSub, priceIds.proSeatMonthly)
    ?? getSubscriptionItemByPrice(stripeSub, priceIds.proSeatAnnual);
}

function billingIntervalFromPriceId(priceId: string | undefined, priceIds: Partial<StripePriceIds>): BillingInterval | null {
  if (!priceId) return null;
  if (priceIds.proSeatAnnual && priceId === priceIds.proSeatAnnual) return "annual";
  if (priceIds.proSeatMonthly && priceId === priceIds.proSeatMonthly) return "monthly";
  return null;
}

function billingIntervalFromStripeSubscription(
  stripeSub: Stripe.Subscription,
  priceIds: Partial<StripePriceIds> = getConfiguredPriceIdsBestEffort(),
): BillingInterval {
  const primaryItem = getProSeatSubscriptionItem(stripeSub, priceIds);
  const priceInterval = billingIntervalFromPriceId(primaryItem?.price.id, priceIds);
  if (priceInterval) return priceInterval;
  const recurringInterval = primaryItem?.price.recurring?.interval;
  if (recurringInterval === "year") return "annual";
  if (recurringInterval === "month") return "monthly";
  return normalizeBillingInterval(stripeSub.metadata?.billingInterval ?? DEFAULT_BILLING_INTERVAL);
}

function hasPendingUpdate(stripeSub: Stripe.Subscription): boolean {
  return stripeSub.pending_update != null;
}

const BILLING_SEAT_PREVIEW_TOKEN_VERSION = 1;
const BILLING_SEAT_PREVIEW_TTL_MS = 5 * 60 * 1000;
const BILLING_SEAT_PREVIEW_SIGNATURE_DOMAIN = "raft-billing-seat-preview-v1";
const BILLING_SEAT_PREVIEW_CONFIRM_DOMAIN = "raft-billing-seat-preview-confirm-v1";
let billingPreviewNow = currentTimeMs;

interface BillingSeatPreviewClaims {
  version: typeof BILLING_SEAT_PREVIEW_TOKEN_VERSION;
  serverId: string;
  userId: string;
  subscriptionId: string;
  itemId: string;
  currentPackQuantity: number;
  requestedPackQuantity: number;
  promotionCodeId: string | null;
  promotionCode: string | null;
  prorationDate: number;
  expiresAtMs: number;
}

export function __setBillingPreviewClockForTests(now: () => number): void {
  billingPreviewNow = now;
}

export function __resetBillingPreviewClockForTests(): void {
  billingPreviewNow = currentTimeMs;
}

function getBillingPreviewSigningSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("Billing preview signing is not configured (JWT_SECRET missing)");
  return secret;
}

function signBillingSeatPreviewClaims(claims: BillingSeatPreviewClaims): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", getBillingPreviewSigningSecret())
    .update(`${BILLING_SEAT_PREVIEW_SIGNATURE_DOMAIN}.${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function billingSeatPreviewConfirmIdempotencyKey(
  previewToken: unknown,
  operation: "reactivate" | "quantity",
): string {
  if (typeof previewToken !== "string") {
    throw new Error("Seat update preview is invalid or expired");
  }
  const digest = createHmac("sha256", getBillingPreviewSigningSecret())
    .update(`${BILLING_SEAT_PREVIEW_CONFIRM_DOMAIN}.${operation}.${previewToken}`)
    .digest("hex");
  return `billing-seat-preview-${operation}-${digest}`;
}

function isBillingSeatPreviewClaims(value: unknown): value is BillingSeatPreviewClaims {
  if (!value || typeof value !== "object") return false;
  const claims = value as Partial<BillingSeatPreviewClaims>;
  return claims.version === BILLING_SEAT_PREVIEW_TOKEN_VERSION
    && typeof claims.serverId === "string"
    && typeof claims.userId === "string"
    && typeof claims.subscriptionId === "string"
    && typeof claims.itemId === "string"
    && Number.isInteger(claims.currentPackQuantity)
    && Number.isInteger(claims.requestedPackQuantity)
    && (claims.promotionCodeId === null || typeof claims.promotionCodeId === "string")
    && (claims.promotionCode === null || typeof claims.promotionCode === "string")
    && Number.isInteger(claims.prorationDate)
    && Number.isInteger(claims.expiresAtMs);
}

function verifyBillingSeatPreviewToken(value: unknown): BillingSeatPreviewClaims {
  if (typeof value !== "string" || value.length < 32 || value.length > 4096) {
    throw new Error("Seat update preview is invalid or expired");
  }
  const dotIndex = value.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === value.length - 1) {
    throw new Error("Seat update preview is invalid or expired");
  }
  try {
    const payload = value.slice(0, dotIndex);
    const suppliedSignatureText = value.slice(dotIndex + 1);
    const suppliedSignature = Buffer.from(suppliedSignatureText, "base64url");
    const payloadBytes = Buffer.from(payload, "base64url");
    // Bind the exact encoded text, not just the decoded bytes: Node's base64url
    // decoder tolerates non-canonical spellings (unused low bits, stray padding,
    // '+'/'/' in place of '-'/'_'), which would otherwise let an altered token
    // pass timingSafeEqual and mint duplicate idempotency representations of one
    // signed claim.
    if (
      suppliedSignature.toString("base64url") !== suppliedSignatureText
      || payloadBytes.toString("base64url") !== payload
    ) {
      throw new Error();
    }
    const expectedSignature = createHmac("sha256", getBillingPreviewSigningSecret())
      .update(`${BILLING_SEAT_PREVIEW_SIGNATURE_DOMAIN}.${payload}`)
      .digest();
    if (suppliedSignature.length !== expectedSignature.length || !timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new Error();
    }
    const claims = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    if (!isBillingSeatPreviewClaims(claims) || billingPreviewNow() >= claims.expiresAtMs) {
      throw new Error();
    }
    return claims;
  } catch {
    throw new Error("Seat update preview is invalid or expired");
  }
}

function normalizePromotionCode(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("Promotion code must be a string");
  const code = value.trim();
  if (!/^[A-Za-z0-9-]{1,128}$/.test(code)) throw new Error("Promotion code is invalid");
  return code;
}

function stripeCustomerId(customer: string | Stripe.Customer | Stripe.DeletedCustomer): string {
  return typeof customer === "string" ? customer : customer.id;
}

function promotionCoupon(promotionCode: Stripe.PromotionCode): Stripe.Coupon {
  const coupon = promotionCode.promotion.coupon;
  if (!coupon || typeof coupon === "string" || "deleted" in coupon) {
    throw new Error("Promotion code is invalid or expired");
  }
  return coupon;
}

function promotionAllowsSeatUpdates(promotionCode: Stripe.PromotionCode, coupon: Stripe.Coupon): boolean {
  return promotionCode.metadata?.raft_use === "seat_update"
    || coupon.metadata?.raft_use === "seat_update";
}

function validateSeatUpdatePromotionCode(
  promotionCode: Stripe.PromotionCode,
  expectedCode: string,
  customerId: string,
  proSeatItem: Stripe.SubscriptionItem,
): Stripe.Coupon {
  const nowSeconds = Math.floor(billingPreviewNow() / 1000);
  const coupon = promotionCoupon(promotionCode);
  if (!promotionCode.active
    || promotionCode.code.toLowerCase() !== expectedCode.toLowerCase()
    || (promotionCode.expires_at != null && promotionCode.expires_at <= nowSeconds)
    || (promotionCode.max_redemptions != null && promotionCode.times_redeemed >= promotionCode.max_redemptions)
    || !coupon.valid
    || (coupon.redeem_by != null && coupon.redeem_by <= nowSeconds)
    || (coupon.max_redemptions != null && coupon.times_redeemed >= coupon.max_redemptions)) {
    throw new Error("Promotion code is invalid or expired");
  }
  if (promotionCode.customer && stripeCustomerId(promotionCode.customer) !== customerId) {
    throw new Error("Promotion code is not valid for this customer");
  }
  if (promotionCode.customer_account) {
    throw new Error("Promotion code is not valid for this customer");
  }
  if (promotionCode.restrictions.first_time_transaction) {
    throw new Error("First-purchase promotion codes cannot be used for seat updates");
  }
  if (promotionCode.restrictions.minimum_amount != null
    || Object.keys(promotionCode.restrictions.currency_options ?? {}).length > 0) {
    throw new Error("Minimum-purchase promotion codes cannot be used for seat updates");
  }
  if (!promotionAllowsSeatUpdates(promotionCode, coupon)) {
    throw new Error("Promotion code is not valid for seat updates");
  }
  const restrictedProducts = coupon.applies_to?.products ?? [];
  const priceProduct = proSeatItem.price.product;
  const priceProductId = typeof priceProduct === "string" ? priceProduct : priceProduct?.id;
  if (restrictedProducts.length > 0 && (!priceProductId || !restrictedProducts.includes(priceProductId))) {
    throw new Error("Promotion code does not apply to Pro seats");
  }
  return coupon;
}

async function resolveSeatUpdatePromotionCode(
  stripe: Stripe,
  code: string,
  customerId: string,
  proSeatItem: Stripe.SubscriptionItem,
): Promise<{ promotionCode: Stripe.PromotionCode; coupon: Stripe.Coupon }> {
  const customerScopedResult = await stripe.promotionCodes.list({
    active: true,
    code,
    customer: customerId,
    expand: ["data.promotion.coupon"],
    limit: 1,
  });
  let promotionCode = customerScopedResult.data.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase()
    && candidate.customer != null
    && stripeCustomerId(candidate.customer) === customerId);
  if (!promotionCode) {
    const publicResult = await stripe.promotionCodes.list({
      active: true,
      code,
      expand: ["data.promotion.coupon"],
      limit: 100,
    });
    promotionCode = publicResult.data.find((candidate) => candidate.code.toLowerCase() === code.toLowerCase()
      && candidate.customer == null
      && candidate.customer_account == null);
  }
  if (!promotionCode) throw new Error("Promotion code is invalid or expired");
  return {
    promotionCode,
    coupon: validateSeatUpdatePromotionCode(promotionCode, code, customerId, proSeatItem),
  };
}

async function retrieveSeatUpdatePromotionCode(
  stripe: Stripe,
  promotionCodeId: string,
  expectedCode: string,
  customerId: string,
  proSeatItem: Stripe.SubscriptionItem,
): Promise<Stripe.PromotionCode> {
  const promotionCode = await stripe.promotionCodes.retrieve(promotionCodeId, {
    expand: ["promotion.coupon"],
  });
  if (promotionCode.id !== promotionCodeId) throw new Error("Promotion code is invalid or expired");
  validateSeatUpdatePromotionCode(promotionCode, expectedCode, customerId, proSeatItem);
  return promotionCode;
}

function subscriptionHasDiscounts(stripeSub: Stripe.Subscription, proSeatItem: Stripe.SubscriptionItem): boolean {
  return (Array.isArray(stripeSub.discounts) && stripeSub.discounts.length > 0)
    || (Array.isArray(proSeatItem.discounts) && proSeatItem.discounts.length > 0);
}

function prorationAmountFromInvoice(invoice: Stripe.Invoice): number {
  return invoice.lines.data.reduce((total, line) => {
    if (line.parent?.type !== "subscription_item_details" || line.parent.subscription_item_details?.proration !== true) {
      return total;
    }
    const taxAmount = (line.taxes ?? []).reduce((sum, tax) => sum + tax.amount, 0);
    return total + line.amount + taxAmount;
  }, 0);
}

function discountAmountFromInvoice(invoice: Stripe.Invoice): number {
  return (invoice.total_discount_amounts ?? []).reduce((total, discount) => total + discount.amount, 0);
}

export async function previewProPackQuantityUpdate(
  serverId: string,
  userId: string,
  request: BillingPackQuantityRequest,
): Promise<BillingPackQuantityPreviewResult> {
  traceBillingEvent("billing.seat_update.preview_requested", {
    server_id: serverId,
    user_id_present: Boolean(userId),
    requested_seat_quantity: traceRequestedSeatQuantity(request),
    promotion_code_present: request.promotionCode != null && request.promotionCode !== "",
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const requestedPackQuantity = toPositiveInteger(
      request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity,
      "seatQuantity",
    );
    if (!requestedPackQuantity) throw new Error("seatQuantity is required");
    const promotionCodeInput = normalizePromotionCode(request.promotionCode);
    const sub = await getSubscription(serverId);
    if (!sub || !isEntitlingStatus(sub.status)) throw new Error("Server does not have an active Pro subscription");
    if (sub.plan !== "pro") throw new Error("Server does not have a Pro subscription");
    const currentPackQuantity = Math.max(1, sub.proPackQuantity);
    if (requestedPackQuantity <= currentPackQuantity) {
      throw new Error("Seat update preview is only available when adding seats");
    }
    const usage = await getServerBillingUsage(getDb(), serverId);
    const minimumSeatQuantity = Math.max(1, Math.ceil(usage.universalSeats));
    if (requestedPackQuantity < minimumSeatQuantity) {
      throw new Error(`seatQuantity must be at least ${minimumSeatQuantity} to cover current server usage`);
    }
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    if (hasPendingUpdate(stripeSub)) throw new Error("A seat update is already pending Stripe payment confirmation");
    const proSeatItem = getProSeatSubscriptionItem(stripeSub, getStripePriceIds());
    if (!proSeatItem) throw new Error("Server does not have a Pro Seat subscription item");
    if ((proSeatItem.quantity ?? 0) !== currentPackQuantity) {
      throw new Error("Seat update changed after preview; review the latest price before confirming");
    }
    const customerId = stripeCustomerId(stripeSub.customer);
    if (promotionCodeInput && subscriptionHasDiscounts(stripeSub, proSeatItem)) {
      throw new Error("This subscription already has a discount; it will not be replaced automatically");
    }
    const resolvedPromotion = promotionCodeInput
      ? await resolveSeatUpdatePromotionCode(stripe, promotionCodeInput, customerId, proSeatItem)
      : null;
    const discounts = resolvedPromotion
      ? [{ promotion_code: resolvedPromotion.promotionCode.id }]
      : undefined;
    const prorationDate = Math.floor(billingPreviewNow() / 1000);
    const items = [{ id: proSeatItem.id, quantity: requestedPackQuantity }];
    const nextInvoice = await stripe.invoices.createPreview({
      customer: customerId,
      subscription: sub.stripeSubscriptionId,
      ...(discounts ? { discounts } : {}),
      subscription_details: {
        items,
        proration_behavior: "always_invoice",
        proration_date: prorationDate,
      },
    });
    const recurringInvoice = await stripe.invoices.createPreview({
      customer: customerId,
      subscription: sub.stripeSubscriptionId,
      ...(discounts ? { discounts } : {}),
      preview_mode: "recurring",
      subscription_details: { items },
    });
    if (nextInvoice.currency !== recurringInvoice.currency) {
      throw new Error("Stripe returned inconsistent preview currencies");
    }
    const expiresAtMs = billingPreviewNow() + BILLING_SEAT_PREVIEW_TTL_MS;
    const claims: BillingSeatPreviewClaims = {
      version: BILLING_SEAT_PREVIEW_TOKEN_VERSION,
      serverId,
      userId,
      subscriptionId: sub.stripeSubscriptionId,
      itemId: proSeatItem.id,
      currentPackQuantity,
      requestedPackQuantity,
      promotionCodeId: resolvedPromotion?.promotionCode.id ?? null,
      promotionCode: resolvedPromotion?.promotionCode.code ?? null,
      prorationDate,
      expiresAtMs,
    };
    return {
      status: "preview",
      currentPackQuantity,
      requestedPackQuantity,
      currency: nextInvoice.currency,
      prorationAmount: prorationAmountFromInvoice(nextInvoice),
      recurringAmount: recurringInvoice.total,
      discountAmount: discountAmountFromInvoice(recurringInvoice),
      promotion: resolvedPromotion
        ? {
            code: resolvedPromotion.promotionCode.code,
            name: resolvedPromotion.coupon.name,
            percentOff: resolvedPromotion.coupon.percent_off,
            amountOff: resolvedPromotion.coupon.amount_off,
            currency: resolvedPromotion.coupon.currency,
          }
        : null,
      previewToken: signBillingSeatPreviewClaims(claims),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  } catch (error) {
    traceBillingEvent("billing.seat_update.preview_failed", {
      server_id: serverId,
      requested_seat_quantity: traceRequestedSeatQuantity(request),
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

export async function updateProPackQuantity(
  serverId: string,
  userId: string,
  request: BillingPackQuantityRequest,
): Promise<BillingPackQuantityUpdateResult> {
  traceBillingEvent("billing.seat_update.requested", {
    server_id: serverId,
    user_id_present: Boolean(userId),
    requested_seat_quantity: traceRequestedSeatQuantity(request),
    requested_human_seats: request.humanSeatQuantity ?? request.humanSeats ?? request.provisionedHumanSeats ?? null,
    requested_agent_seats: request.agentSeatQuantity ?? request.agentSeats ?? request.provisionedAgentSeats ?? null,
    ...traceStripeBillingState(),
  });
  try {
  if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
  const requestedSeatQuantity = toPositiveInteger(request.seatQuantity ?? request.packQuantity ?? request.proPackQuantity, "seatQuantity") ?? null;
  const requestedHumanSeatQuantity = toPositiveInteger(
    request.humanSeatQuantity ?? request.humanSeats ?? request.provisionedHumanSeats,
    "humanSeatQuantity",
  );
  const requestedAgentSeats = requestedSeatQuantity != null
    ? requestedSeatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE
    : toNonNegativeInteger(
      request.agentSeatQuantity ?? request.agentSeats ?? request.provisionedAgentSeats,
      "agentSeatQuantity",
    );
  const promotionCodeInput = normalizePromotionCode(request.promotionCode);
  if (promotionCodeInput && request.previewToken == null) {
    throw new Error("Preview the promotion code before confirming the seat update");
  }
  const previewClaims = request.previewToken == null
    ? null
    : verifyBillingSeatPreviewToken(request.previewToken);
  if (previewClaims && promotionCodeInput
    && previewClaims.promotionCode?.toLowerCase() !== promotionCodeInput.toLowerCase()) {
    throw new Error("Seat update preview is invalid or expired");
  }

  const sub = await getSubscription(serverId);
  if (!sub || !isEntitlingStatus(sub.status)) {
    throw new Error("Server does not have an active Pro subscription");
  }
  if (sub.plan !== "pro") {
    throw new Error("Server does not have a Pro subscription");
  }
  if (previewClaims && (previewClaims.serverId !== serverId
    || previewClaims.userId !== userId
    || previewClaims.subscriptionId !== sub.stripeSubscriptionId)) {
    throw new Error("Seat update preview is invalid or expired");
  }

  const currentHumanSeats = Math.max(1, sub.provisionedHumanSeats);
  const currentAgentSeats = Math.max(0, sub.provisionedAgentSeats);
  const currentPackQuantity = Math.max(1, sub.proPackQuantity);
  const requestedPackQuantity = requestedSeatQuantity
    ?? (requestedHumanSeatQuantity == null && requestedAgentSeats == null
      ? null
      : calculateProPackQuantity(requestedHumanSeatQuantity ?? currentHumanSeats, requestedAgentSeats ?? currentAgentSeats));
  if (!requestedPackQuantity) {
    throw new Error("seatQuantity is required");
  }
  if (previewClaims && previewClaims.requestedPackQuantity !== requestedPackQuantity) {
    throw new Error("Seat update preview is invalid or expired");
  }
  const usage = await getServerBillingUsage(getDb(), serverId);
  const minimumSeatQuantity = Math.max(1, Math.ceil(usage.universalSeats));
  if (requestedPackQuantity < minimumSeatQuantity) {
    throw new Error(`seatQuantity must be at least ${minimumSeatQuantity} to cover current server usage`);
  }
  const currentPeriodEnd = sub.currentPeriodEnd;
  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
  const shouldReactivate = sub.cancelAtPeriodEnd || stripeSub.cancel_at_period_end;
  const priceIds = getStripePriceIds();
  const proSeatItem = getProSeatSubscriptionItem(stripeSub, priceIds);
  if (proSeatItem) {
    const nextPackQuantity = requestedPackQuantity;
    if (nextPackQuantity > currentPackQuantity && hasPendingUpdate(stripeSub)) {
      throw new Error("A seat update is already pending Stripe payment confirmation");
    }
    let confirmedPromotionCodeId: string | null = null;
    if (previewClaims) {
      if (nextPackQuantity <= currentPackQuantity
        || previewClaims.currentPackQuantity !== currentPackQuantity
        || previewClaims.itemId !== proSeatItem.id
        || (proSeatItem.quantity ?? 0) !== previewClaims.currentPackQuantity) {
        throw new Error("Seat update changed after preview; review the latest price before confirming");
      }
      if (previewClaims.promotionCodeId) {
        if (!previewClaims.promotionCode || subscriptionHasDiscounts(stripeSub, proSeatItem)) {
          throw new Error("Seat update changed after preview; review the latest price before confirming");
        }
        const customerId = stripeCustomerId(stripeSub.customer);
        const promotionCode = await retrieveSeatUpdatePromotionCode(
          stripe,
          previewClaims.promotionCodeId,
          previewClaims.promotionCode,
          customerId,
          proSeatItem,
        );
        confirmedPromotionCodeId = promotionCode.id;
      }
    }
    if (nextPackQuantity === currentPackQuantity) {
      if (shouldReactivate) {
        const reactivated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
          cancel_at_period_end: false,
          metadata: {
            ...stripeSub.metadata,
            reactivatedByUserId: userId,
            reactivatedAt: new Date().toISOString(),
          },
        });
        await syncStripeSubscriptionProjection(reactivated, {
          serverId,
          userId,
        });
        return {
          status: "reactivated",
          currentPackQuantity,
          requestedPackQuantity: nextPackQuantity,
          effectiveAt: "current",
          currentPeriodEnd: getPeriodEnd(reactivated) ?? currentPeriodEnd,
        };
      }
      return {
        status: "unchanged",
        currentPackQuantity,
        requestedPackQuantity: nextPackQuantity,
        effectiveAt: "current",
        currentPeriodEnd,
      };
    }
    let stripeSubForQuantityUpdate = stripeSub;
    if (shouldReactivate) {
      stripeSubForQuantityUpdate = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: false,
        metadata: {
          ...stripeSub.metadata,
          reactivatedByUserId: userId,
          reactivatedAt: new Date().toISOString(),
        },
      }, previewClaims ? {
        idempotencyKey: billingSeatPreviewConfirmIdempotencyKey(request.previewToken, "reactivate"),
      } : undefined);
      await syncStripeSubscriptionProjection(stripeSubForQuantityUpdate, {
        serverId,
        userId,
      });
    }
    if (nextPackQuantity < currentPackQuantity) {
      const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        items: [{ id: proSeatItem.id, quantity: nextPackQuantity }],
        metadata: subscriptionMetadataForSeatQuantity(stripeSubForQuantityUpdate, nextPackQuantity, {
          serverId,
          userId,
          billingInterval: billingIntervalFromStripeSubscription(stripeSubForQuantityUpdate, priceIds),
          humanSeatQuantity: String(requestedHumanSeatQuantity ?? nextPackQuantity),
          requestedAgentSeats: String(requestedAgentSeats ?? 0),
        }),
        proration_behavior: "create_prorations",
      });
      await syncStripeSubscriptionProjection(updated, {
        serverId,
        userId,
      });
      return {
        status: "updated",
        currentPackQuantity,
        requestedPackQuantity: nextPackQuantity,
        effectiveAt: "current",
        currentPeriodEnd: getPeriodEnd(updated) ?? currentPeriodEnd,
      };
    }
    const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: proSeatItem.id, quantity: nextPackQuantity }],
      metadata: subscriptionMetadataForSeatQuantity(stripeSubForQuantityUpdate, nextPackQuantity, {
        serverId,
        userId,
        billingInterval: billingIntervalFromStripeSubscription(stripeSubForQuantityUpdate, priceIds),
        humanSeatQuantity: String(requestedHumanSeatQuantity ?? nextPackQuantity),
        requestedAgentSeats: String(requestedAgentSeats ?? 0),
      }),
      ...(confirmedPromotionCodeId ? { discounts: [{ promotion_code: confirmedPromotionCodeId }] } : {}),
      payment_behavior: "pending_if_incomplete",
      proration_behavior: "always_invoice",
      ...(previewClaims ? { proration_date: previewClaims.prorationDate } : {}),
    }, previewClaims ? {
      idempotencyKey: billingSeatPreviewConfirmIdempotencyKey(request.previewToken, "quantity"),
    } : undefined);
    if (hasPendingUpdate(updated)) {
      return {
        status: "pending_payment",
        currentPackQuantity,
        requestedPackQuantity: nextPackQuantity,
        effectiveAt: "after_payment",
        currentPeriodEnd,
      };
    }
    return {
      status: "pending_webhook",
      currentPackQuantity,
      requestedPackQuantity: nextPackQuantity,
      effectiveAt: "after_payment",
      currentPeriodEnd,
    };
  }
  throw new Error("Server does not have a Pro Seat subscription item");
  } catch (error) {
    traceBillingEvent("billing.seat_update.failed", {
      server_id: serverId,
      requested_seat_quantity: traceRequestedSeatQuantity(request),
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

// ── Customer Portal ──

export async function createPortalSession(
  serverId: string,
  returnUrl: string,
): Promise<string> {
  traceBillingEvent("billing.portal.requested", {
    server_id: serverId,
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const stripe = getStripe();
    const sub = await getSubscription(serverId);
    if (!sub) {
      traceBillingEvent("billing.portal.rejected", { server_id: serverId, reason: "missing_subscription" });
      throw new Error("No active subscription");
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: returnUrl,
    });

    traceBillingEvent("billing.portal.session.created", {
      server_id: serverId,
      stripe_customer_present: Boolean(sub.stripeCustomerId),
      stripe_portal_url_present: Boolean(session.url),
    });
    return session.url;
  } catch (error) {
    traceBillingEvent("billing.portal.failed", {
      server_id: serverId,
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

export async function cancelSubscriptionAtPeriodEnd(
  serverId: string,
  userId: string,
): Promise<{ status: "scheduled_period_end"; currentPeriodEnd: Date | null }> {
  traceBillingEvent("billing.cancel.requested", {
    server_id: serverId,
    user_id_present: Boolean(userId),
    ...traceStripeBillingState(),
  });
  try {
    if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
    const sub = await getSubscription(serverId);
    if (!sub || !isEntitlingStatus(sub.status)) {
      traceBillingEvent("billing.cancel.rejected", {
        server_id: serverId,
        reason: "missing_entitling_subscription",
        subscription_status: sub?.status ?? "none",
      });
      throw new Error("Server does not have an active Pro subscription");
    }

    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
      metadata: {
        cancelRequestedByUserId: userId,
        cancelRequestedAt: new Date().toISOString(),
      },
    });
    await syncStripeSubscriptionProjection(stripeSub, {
      serverId,
      userId,
    });
    traceBillingEvent("billing.cancel.scheduled", {
      server_id: serverId,
      cancel_at_period_end: true,
      current_period_end_present: Boolean(getPeriodEnd(stripeSub) ?? sub.currentPeriodEnd),
    });
    return {
      status: "scheduled_period_end",
      currentPeriodEnd: getPeriodEnd(stripeSub) ?? sub.currentPeriodEnd,
    };
  } catch (error) {
    traceBillingEvent("billing.cancel.failed", {
      server_id: serverId,
      ...traceAttrs.error(error),
    });
    throw error;
  }
}

// ── Subscription CRUD ──

export async function getSubscription(serverId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!row) return null;

  // If subscription looks active but period has expired, verify with Stripe
  if (
    row.status === "active" &&
    row.currentPeriodEnd &&
    new Date(row.currentPeriodEnd) < new Date()
  ) {
    await refreshSubscriptionStatus(row);
    // Re-fetch after refresh
    const [updated] = await db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.serverId, serverId));
    return updated ?? null;
  }

  return row;
}

export async function refreshSubscriptionForServer(serverId: string): Promise<void> {
  if (!isStripeConfigured()) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: "stripe_not_configured",
      ...traceStripeBillingState(),
    });
    return;
  }
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!sub) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: "missing_subscription",
    });
    return;
  }
  await refreshSubscriptionStatus(sub);
}

function shouldRefreshSubscriptionProjection(sub: typeof subscriptions.$inferSelect, now: Date): boolean {
  if (sub.status !== "active" && sub.status !== "past_due") return false;
  if (sub.currentPeriodEnd && sub.currentPeriodEnd < now) return true;
  return sub.updatedAt < new Date(now.getTime() - PASSIVE_SUBSCRIPTION_REFRESH_MS);
}

export async function refreshSubscriptionForServerIfStale(serverId: string, now: Date = new Date()): Promise<void> {
  if (!isStripeConfigured()) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: "stripe_not_configured",
      ...traceStripeBillingState(),
    });
    return;
  }
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!sub || !shouldRefreshSubscriptionProjection(sub, now)) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: serverId,
      reason: sub ? "not_stale" : "missing_subscription",
    });
    return;
  }
  await refreshSubscriptionStatus(sub);
}

/**
 * Verify subscription status with Stripe and update local record.
 * Used by billing reads and stale entitlement checks to recover from missed
 * Stripe webhooks before making local plan/capacity decisions.
 */
async function refreshSubscriptionStatus(sub: typeof subscriptions.$inferSelect): Promise<void> {
  if (!isStripeConfigured()) {
    traceBillingEvent("billing.subscription_refresh.skipped", {
      server_id: sub.serverId,
      reason: "stripe_not_configured",
      ...traceStripeBillingState(),
    });
    return;
  }

  try {
    traceBillingEvent("billing.subscription_refresh.started", {
      server_id: sub.serverId,
      subscription_status: sub.status,
      stripe_subscription_present: Boolean(sub.stripeSubscriptionId),
    });
    const stripe = getStripe();
    const stripeSub = await stripe.subscriptions.retrieve(sub.stripeSubscriptionId);
    await syncStripeSubscriptionProjection(stripeSub, {
      serverId: sub.serverId,
      fallbackPlan: sub.plan as PaidBillingPlan,
    });
    traceBillingEvent("billing.subscription_refresh.completed", {
      server_id: sub.serverId,
      stripe_subscription_present: true,
    });
  } catch (err) {
    traceBillingEvent("billing.subscription_refresh.failed", {
      server_id: sub.serverId,
      ...traceAttrs.error(err),
    });
    console.error(`[Billing] Failed to refresh subscription for server ${sub.serverId}:`, err);
  }
}

// ── [UNUSED] Extra-Agent Quantity Sync ──
// Agent seats are no longer billed or synced separately.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _unusedSyncAgentQuantity() { /* see git history */ }

// ── Helpers ──

const STRIPE_STATUS_MAP: Record<string, "active" | "past_due" | "canceled" | "incomplete"> = {
  active: "active",
  past_due: "past_due",
  canceled: "canceled",
  incomplete: "incomplete",
  incomplete_expired: "canceled",
  trialing: "active",
  unpaid: "past_due",
};

function mapStripeStatus(status: string): "active" | "past_due" | "canceled" | "incomplete" {
  return STRIPE_STATUS_MAP[status] || "incomplete";
}

function isEntitlingStatus(status: "active" | "past_due" | "canceled" | "incomplete"): boolean {
  return status === "active" || status === "past_due";
}

function isStripeSubscriptionScheduledToCancel(stripeSub: Stripe.Subscription): boolean {
  if (stripeSub.cancel_at_period_end) return true;
  return stripeSub.status !== "canceled" && stripeSub.cancel_at != null;
}

function sameTimestamp(a: Date | null | undefined, b: Date | null | undefined): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/** Extract current_period_end from a Stripe subscription (lives on items in v20+). */
function getPeriodEnd(stripeSub: Stripe.Subscription): Date | null {
  const firstItem = stripeSub.items.data[0];
  if (firstItem?.current_period_end) {
    return new Date(firstItem.current_period_end * 1000);
  }
  return null;
}

function getPeriodStart(stripeSub: Stripe.Subscription): Date | null {
  const firstItem = stripeSub.items.data[0];
  if (firstItem?.current_period_start) {
    return new Date(firstItem.current_period_start * 1000);
  }
  return null;
}

function metadataInt(metadata: Stripe.Metadata | undefined, key: string): number | null {
  const value = metadata?.[key];
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function metadataPlan(metadata: Stripe.Metadata | undefined): PaidBillingPlan | null {
  const plan = metadata?.targetPlan ?? metadata?.plan;
  return plan === "pro" ? plan : null;
}

function getStripeCustomerId(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "id" in value && typeof value.id === "string") return value.id;
  return null;
}

function inferPlanFromItems(stripeSub: Stripe.Subscription, priceIds: Partial<StripePriceIds>): PaidBillingPlan | null {
  const priceIdSet = new Set(stripeSub.items.data.map((item) => item.price.id));
  if ((priceIds.proSeatMonthly && priceIdSet.has(priceIds.proSeatMonthly))
    || (priceIds.proSeatAnnual && priceIdSet.has(priceIds.proSeatAnnual))) return "pro";
  return null;
}

function getConfiguredPriceIdsBestEffort(): Partial<StripePriceIds> {
  return {
    proSeatMonthly: process.env.STRIPE_PRO_SEAT_MONTHLY_PRICE_ID?.trim(),
    proSeatAnnual: process.env.STRIPE_PRO_SEAT_ANNUAL_PRICE_ID?.trim(),
  };
}

function buildProjectionFromStripeSubscription(stripeSub: Stripe.Subscription, fallbackPlan?: PaidBillingPlan | null) {
  const metadata = stripeSub.metadata;
  const priceIds = getConfiguredPriceIdsBestEffort();
  const plan = metadataPlan(metadata) ?? inferPlanFromItems(stripeSub, priceIds) ?? fallbackPlan;
  if (!plan) return null;

  const proSeatItem = getProSeatSubscriptionItem(stripeSub, priceIds);
  const billingInterval = billingIntervalFromStripeSubscription(stripeSub, priceIds);
  const isSeatContract = metadata?.pricingContract === RAFT_PRO_SEAT_PRICING_CONTRACT
    || proSeatItem != null;
  if (!isSeatContract) return null;

  const seatQuantity = Math.max(
    1,
    proSeatItem?.quantity
      ?? metadataInt(metadata, "seatQuantity")
      ?? metadataInt(metadata, "proPackQuantity")
      ?? metadataInt(metadata, "packQuantity")
      ?? 1,
  );
  return {
    plan,
    billingInterval,
    stripeProPackItemId: proSeatItem?.id ?? null,
    provisionedHumanSeats: seatQuantity,
    provisionedAgentSeats: seatQuantity * PRO_AGENT_SEAT_BLOCK_SIZE,
    proPackQuantity: seatQuantity,
    trialFreePackQuantity: 0,
    firstPackTrialEndsAt: null,
  };
}

/** Extract subscription ID from an Invoice (parent.subscription_details in v20+). */
function getInvoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const subDetails = invoice.parent?.subscription_details;
  if (!subDetails) return null;
  const sub = subDetails.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && "id" in sub) return sub.id;
  return null;
}

// ── Cancel subscription on server deletion ──

/**
 * Cancel a server's Stripe subscription (if any) when the server is deleted.
 * Local record removal is intentionally owned by deleteServer's transaction so
 * it commits atomically with the server tombstone.
 */
export async function cancelSubscriptionForDeletedServer(serverId: string): Promise<void> {
  const db = getDb();
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.serverId, serverId));
  if (!sub) return; // No subscription — nothing to cancel

  if (isStripeConfigured()) {
    try {
      const stripe = getStripe();
      await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
      console.log(`[Billing] Canceled Stripe subscription ${sub.stripeSubscriptionId} for deleted server ${serverId}`);
    } catch (err) {
      console.error(`[Billing] Failed to cancel Stripe subscription for server ${serverId}:`, err);
      // Deletion remains best-effort at the provider boundary. The local row is
      // removed atomically with the server tombstone by deleteServer.
    }
  }
}

// ── Webhook Handling ──

export function constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  if (!isStripeBillingFlagEnabled()) throw new Error("Billing is not configured (STRIPE_BILLING_ENABLED must be true)");
  const stripe = getStripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET!;
  return stripe.webhooks.constructEvent(payload, signature, secret);
}

const WEBHOOK_PROCESSING_STALE_MS = 5 * 60 * 1000;

/**
 * Process a Stripe webhook event with idempotency protection.
 * Only processed events are final; stale processing claims can be retried.
 */
export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  traceBillingEvent("billing.webhook.received", {
    event_type: event.type,
    stripe_event_id_present: Boolean(event.id),
  });
  const db = getDb();

  const now = new Date();
  const processingToken = randomUUID();
  let ownsClaim = false;
  const [claimed] = await db.insert(webhookEvents).values({
    id: event.id,
    type: event.type,
    status: "processing",
    processingToken,
    processedAt: now,
  }).onConflictDoNothing().returning({ id: webhookEvents.id });
  if (claimed) {
    ownsClaim = true;
    traceBillingEvent("billing.webhook.claim.created", {
      event_type: event.type,
      stripe_event_id_present: true,
    });
  } else {
    const [existing] = await db
      .select({
        status: webhookEvents.status,
        processedAt: webhookEvents.processedAt,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.id, event.id));

    if (!existing || existing.status === "processed") {
      traceBillingEvent("billing.webhook.duplicate_skipped", {
        event_type: event.type,
        existing_status: existing?.status ?? "missing",
      });
      console.log(`[Billing] Skipping duplicate webhook event ${event.id} (${event.type})`);
      return;
    }

    const staleCutoff = new Date(Date.now() - WEBHOOK_PROCESSING_STALE_MS);
    if (existing.processedAt >= staleCutoff) {
      traceBillingEvent("billing.webhook.concurrent_skipped", {
        event_type: event.type,
        existing_status: existing.status,
      });
      console.log(`[Billing] Skipping concurrent webhook event ${event.id} (${event.type})`);
      return;
    }

    const [reclaimed] = await db
      .update(webhookEvents)
      .set({
        type: event.type,
        processingToken,
        processedAt: now,
      })
      .where(and(
        eq(webhookEvents.id, event.id),
        eq(webhookEvents.status, "processing"),
        lt(webhookEvents.processedAt, staleCutoff),
      ))
      .returning({ id: webhookEvents.id });

    if (!reclaimed) {
      traceBillingEvent("billing.webhook.reclaim_lost", { event_type: event.type });
      console.log(`[Billing] Skipping concurrently reclaimed webhook event ${event.id} (${event.type})`);
      return;
    }
    ownsClaim = true;
    traceBillingEvent("billing.webhook.claim.reclaimed", {
      event_type: event.type,
      stale_claim: true,
    });

    console.log(`[Billing] Reclaimed stale webhook event ${event.id} (${event.type})`);
  }

  if (!ownsClaim) {
    traceBillingEvent("billing.webhook.claim.missing", { event_type: event.type });
    console.warn(`[Billing] Webhook event ${event.id} (${event.type}) had no owned processing claim`);
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, event.id);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event.data.object as Stripe.Invoice, event.id);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice, event.id);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, event.id);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, event.id);
        break;
    }
    const [processed] = await db
      .update(webhookEvents)
      .set({
        type: event.type,
        status: "processed",
        processingToken: null,
        processedAt: new Date(),
      })
      .where(and(
        eq(webhookEvents.id, event.id),
        eq(webhookEvents.status, "processing"),
        eq(webhookEvents.processingToken, processingToken),
      ))
      .returning({ id: webhookEvents.id });
    if (!processed) {
      traceBillingEvent("billing.webhook.claim_lost_after_processing", {
        event_type: event.type,
      });
      console.warn(`[Billing] Webhook event ${event.id} (${event.type}) was processed but its claim was no longer owned`);
    }
    traceBillingEvent("billing.webhook.processed", {
      event_type: event.type,
      claim_marked_processed: Boolean(processed),
    });
  } catch (err) {
    traceBillingEvent("billing.webhook.failed", {
      event_type: event.type,
      ...traceAttrs.error(err),
    });
    await db.delete(webhookEvents).where(and(
      eq(webhookEvents.id, event.id),
      eq(webhookEvents.status, "processing"),
      eq(webhookEvents.processingToken, processingToken),
    ));
    throw err;
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, eventId: string): Promise<void> {
  const serverId = session.metadata?.serverId;
  const billingTraceId = toBillingTraceId(session.metadata?.billingTraceId);
  traceBillingEvent("billing.checkout.completed.received", {
    server_id_present: Boolean(serverId),
    billing_trace_id: billingTraceId,
    mode: session.mode,
    stripe_subscription_present: Boolean(session.subscription),
    stripe_customer_present: Boolean(session.customer),
    stripe_event_id_present: Boolean(eventId),
  });
  if (!serverId || session.mode !== "subscription") {
    traceBillingEvent("billing.checkout.completed.skipped", {
      reason: !serverId ? "missing_server_id" : "non_subscription_mode",
      billing_trace_id: billingTraceId,
      mode: session.mode,
    });
    return;
  }

  // Skip if server has been deleted
  const db0 = getDb();
  const [srv] = await db0.select({ id: servers.id }).from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!srv) {
    traceBillingEvent("billing.checkout.completed.skipped", {
      server_id: serverId,
      billing_trace_id: billingTraceId,
      reason: "deleted_server",
    });
    console.log(`[Billing] Skipping checkout for deleted server ${serverId}`);
    return;
  }

  const stripe = getStripe();
  const subscriptionId = session.subscription as string;

  // Fetch the full subscription to verify real status + get line item IDs
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  await syncStripeSubscriptionProjection(stripeSub, {
    serverId,
    customerId: getStripeCustomerId(session.customer),
    userId: session.metadata?.userId ?? null,
    eventId,
  });
}

async function handleInvoicePaid(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  traceBillingEvent("billing.invoice.paid.received", {
    stripe_subscription_present: Boolean(subscriptionId),
    stripe_event_id_present: Boolean(eventId),
  });
  if (!subscriptionId) return;

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  await syncStripeSubscriptionProjection(stripeSub, { eventId });
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice, eventId: string): Promise<void> {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  traceBillingEvent("billing.invoice.payment_failed.received", {
    stripe_subscription_present: Boolean(subscriptionId),
    stripe_event_id_present: Boolean(eventId),
  });
  if (!subscriptionId) return;

  const stripe = getStripe();
  const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
  await syncStripeSubscriptionProjection(stripeSub, {
    eventId,
    overrideStatus: "past_due",
  });
}

async function handleSubscriptionUpdated(stripeSub: Stripe.Subscription, eventId: string): Promise<void> {
  traceBillingEvent("billing.subscription.updated.received", {
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_status: stripeSub.status,
    stripe_event_id_present: Boolean(eventId),
  });
  await syncStripeSubscriptionProjection(stripeSub, { eventId });
}

async function handleSubscriptionDeleted(stripeSub: Stripe.Subscription, eventId: string): Promise<void> {
  traceBillingEvent("billing.subscription.deleted.received", {
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_status: stripeSub.status,
    stripe_event_id_present: Boolean(eventId),
  });
  await syncStripeSubscriptionProjection(stripeSub, {
    eventId,
    overrideStatus: "canceled",
  });
}

async function syncStripeSubscriptionProjection(
  stripeSub: Stripe.Subscription,
  opts: {
    serverId?: string | null;
    customerId?: string | null;
    userId?: string | null;
    eventId?: string | null;
    fallbackPlan?: PaidBillingPlan | null;
    overrideStatus?: "active" | "past_due" | "canceled" | "incomplete";
  } = {},
): Promise<void> {
  traceBillingEvent("billing.subscription_projection.sync_started", {
    server_id_present: Boolean(opts.serverId ?? stripeSub.metadata?.serverId),
    billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_customer_present: Boolean(stripeSub.customer ?? opts.customerId),
    stripe_status: stripeSub.status,
    stripe_event_id_present: Boolean(opts.eventId),
    override_status: opts.overrideStatus ?? null,
  });
  const db = getDb();
  const [existing] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.stripeSubscriptionId, stripeSub.id));

  const serverId = opts.serverId ?? stripeSub.metadata?.serverId ?? existing?.serverId;
  if (!serverId) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      reason: "missing_server_id",
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      stripe_subscription_present: Boolean(stripeSub.id),
    });
    console.warn(`[Billing] Cannot reconcile Stripe subscription ${stripeSub.id}: missing serverId metadata`);
    return;
  }
  const [srv] = await db.select({ id: servers.id, plan: servers.plan }).from(servers)
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));
  if (!srv) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      reason: "deleted_server",
    });
    console.log(`[Billing] Skipping subscription sync for deleted server ${serverId}`);
    return;
  }

  const existingPlan = existing?.plan === "pro" ? existing.plan : null;
  const projection = buildProjectionFromStripeSubscription(stripeSub, opts.fallbackPlan ?? existingPlan);
  if (!projection) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      reason: "missing_projection",
      stripe_subscription_present: Boolean(stripeSub.id),
    });
    console.warn(`[Billing] Cannot reconcile Stripe subscription ${stripeSub.id}: missing plan metadata or recognized price id`);
    return;
  }

  const status = opts.overrideStatus ?? mapStripeStatus(stripeSub.status);
  const customerId = opts.customerId ?? getStripeCustomerId(stripeSub.customer) ?? existing?.stripeCustomerId;
  if (!customerId) {
    traceBillingEvent("billing.subscription_projection.skipped", {
      server_id: serverId,
      billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
      reason: "missing_customer_id",
      stripe_subscription_present: Boolean(stripeSub.id),
    });
    console.warn(`[Billing] Cannot reconcile Stripe subscription ${stripeSub.id}: missing customer id`);
    return;
  }
  const userId = opts.userId ?? stripeSub.metadata?.userId ?? existing?.createdByUserId ?? null;
  const now = new Date();
  const currentPeriodStart = getPeriodStart(stripeSub);
  const currentPeriodEnd = getPeriodEnd(stripeSub);
  const cancelAtPeriodEnd = isStripeSubscriptionScheduledToCancel(stripeSub);
  const serverInternalPlan = srv.plan === "founder" || srv.plan === "partner" ? srv.plan : null;
  const nextPlan: ServerPlan = serverInternalPlan ?? (isEntitlingStatus(status) ? projection.plan : "free");
  const shouldBroadcast = !existing
    || srv.plan !== nextPlan
    || existing.provider !== "stripe"
    || existing.stripeCustomerId !== customerId
    || existing.stripeSubscriptionId !== stripeSub.id
    || existing.plan !== projection.plan
    || existing.billingInterval !== projection.billingInterval
    || existing.stripeProPackItemId !== projection.stripeProPackItemId
    || existing.status !== status
    || existing.provisionedHumanSeats !== projection.provisionedHumanSeats
    || existing.provisionedAgentSeats !== projection.provisionedAgentSeats
    || existing.proPackQuantity !== projection.proPackQuantity
    || existing.trialFreePackQuantity !== projection.trialFreePackQuantity
    || !sameTimestamp(existing.firstPackTrialEndsAt, projection.firstPackTrialEndsAt)
    || !sameTimestamp(existing.currentPeriodStart, currentPeriodStart)
    || !sameTimestamp(existing.currentPeriodEnd, currentPeriodEnd)
    || existing.cancelAtPeriodEnd !== cancelAtPeriodEnd;

  await db.insert(subscriptions).values({
    serverId,
    provider: "stripe",
    stripeCustomerId: customerId,
    stripeSubscriptionId: stripeSub.id,
    plan: projection.plan,
    billingInterval: projection.billingInterval,
    stripeProPackItemId: projection.stripeProPackItemId,
    status,
    provisionedHumanSeats: projection.provisionedHumanSeats,
    provisionedAgentSeats: projection.provisionedAgentSeats,
    proPackQuantity: projection.proPackQuantity,
    trialFreePackQuantity: projection.trialFreePackQuantity,
    firstPackTrialEndsAt: projection.firstPackTrialEndsAt,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd,
    createdByUserId: userId,
    updatedByUserId: userId,
    lastProviderEventId: opts.eventId ?? null,
  }).onConflictDoUpdate({
    target: subscriptions.serverId,
    set: {
      provider: "stripe",
      stripeCustomerId: customerId,
      stripeSubscriptionId: stripeSub.id,
      plan: projection.plan,
      billingInterval: projection.billingInterval,
      stripeProPackItemId: projection.stripeProPackItemId,
      status,
      provisionedHumanSeats: projection.provisionedHumanSeats,
      provisionedAgentSeats: projection.provisionedAgentSeats,
      proPackQuantity: projection.proPackQuantity,
      trialFreePackQuantity: projection.trialFreePackQuantity,
      firstPackTrialEndsAt: projection.firstPackTrialEndsAt,
      currentPeriodStart,
      currentPeriodEnd,
      cancelAtPeriodEnd,
      updatedByUserId: userId,
      lastProviderEventId: opts.eventId ?? null,
      updatedAt: now,
    },
  });

  await db
    .update(servers)
    .set({
      plan: nextPlan,
      planDowngradedAt: isEntitlingStatus(status) ? null : new Date(),
      updatedAt: now,
    })
    .where(and(eq(servers.id, serverId), isNull(servers.deletedAt)));

  if (shouldBroadcast) {
    console.log(`[Billing] Synced Stripe subscription ${stripeSub.id} for server ${serverId}: ${projection.plan}/${status}`);
    broadcastPlanChange(serverId, nextPlan);
  }
  traceBillingEvent("billing.subscription_projection.synced", {
    server_id: serverId,
    billing_trace_id: toBillingTraceId(stripeSub.metadata?.billingTraceId),
    previous_server_plan: srv.plan,
    next_server_plan: nextPlan,
    plan: projection.plan,
    status,
    billing_interval: projection.billingInterval,
    provisioned_human_seats: projection.provisionedHumanSeats,
    provisioned_agent_seats: projection.provisionedAgentSeats,
    seat_quantity: projection.proPackQuantity,
    trial_free_pack_quantity: projection.trialFreePackQuantity,
    first_pack_trial_ends_at_present: Boolean(projection.firstPackTrialEndsAt),
    current_period_start_present: Boolean(currentPeriodStart),
    current_period_end_present: Boolean(currentPeriodEnd),
    cancel_at_period_end: cancelAtPeriodEnd,
    stripe_subscription_present: Boolean(stripeSub.id),
    stripe_customer_present: Boolean(customerId),
    stripe_event_id_present: Boolean(opts.eventId),
    broadcast_sent: shouldBroadcast,
  });
}

// ── Webhook Event Cleanup ──

/** Delete webhook events older than 48 hours. Called periodically from server.ts. */
export async function cleanupWebhookEvents(): Promise<void> {
  const db = getDb();
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - 48);
  const result = await db.delete(webhookEvents).where(and(
    eq(webhookEvents.status, "processed"),
    lt(webhookEvents.processedAt, cutoff),
  ));
  if (result.rowCount && result.rowCount > 0) {
    console.log(`[Billing] Cleaned up ${result.rowCount} old webhook events`);
  }
  traceBillingEvent("billing.webhook.cleanup.finished", {
    deleted_event_count: result.rowCount ?? 0,
  });
}
