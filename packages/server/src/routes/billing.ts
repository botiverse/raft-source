import { hasAppSumoBillingReservation } from "../services/appSumoLicenseService";
import { getDb } from "../db/index";
import { CheckoutPromotionUnavailableError } from "../services/checkoutPromotion";
import { BillingSourceCheckBusyError, CheckoutOutcomeUnknownError, PrepaidActiveError, PrepaidPaidSourceError } from "../services/billingCheckoutCustody";
import { Router, type Router as RouterType, type Request, type Response } from "express";
import { BILLING_PORTAL_FROM, PRO_PREPAID_FEATURE_FLAG_KEY, canMutateBilling, canReadBillingSummary, type BillingPortalFrom } from "@botiverse/raft-shared";
import { evaluateFeatureFlag } from "../services/featureFlagService";
import { PrepaidRequestError, parsePrepaidCheckoutBody } from "../services/prepaidProBilling";
import { parsePrepaidSeatQuantity } from "../services/prepaidProSeats";
import { refuse } from "../lib/refusal";
import { getActivePrepaidGrant } from "../services/prepaidProService";
import * as billingService from "../services/billingService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { sendJsonServerError } from "./errorResponse";
import { isAgentRuntimeProviderEnabledForServer, isAgentRuntimeProviderKillSwitched, serverHasHostedProvision } from "../services/agentRuntimeProviderFeature";
import { getHostedRuntimeSpend, parseHostedSpendQuery } from "../services/hostedRuntimeSpendService";
import { addTraceEvent } from "../tracing/semanticTrace";
import { getProductEventSink } from "../services/productEventIngest";
import { recordServerProductEvent } from "../services/serverProductEvents";

export const billingRouter: RouterType = Router();

// License changes belong to AppSumo. A direct API call cannot start a second paid source.
billingRouter.use(async (req, res, next) => {
  if (req.method !== "POST") return next();
  try {
    const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(role)) {
      res.status(403).json({ error: "Only the server owner can manage billing" });
      return;
    }
    if (await hasAppSumoBillingReservation(getDb(), req.serverId!)) {
      res.status(409).json({ code: "APPSUMO_BILLING_MANAGED", error: "Manage this lifetime license in AppSumo. Contact support for a billing conflict." });
      return;
    }
    // Prepaid time (task #19) has no subscription to change; a subscription
    // checkout would charge for time already paid. The portal (invoices) and
    // the prepaid routes stay open.
    // Express routes are case-insensitive and ignore a trailing slash; so does this.
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    if (SUBSCRIPTION_ONLY_POSTS.has(path) && await getActivePrepaidGrant(getDb(), req.serverId!, new Date())) {
      if (path === "/checkout") {
        const err = new PrepaidActiveError();
        res.status(409).json({ code: err.code, error: err.message });
      } else {
        res.status(409).json({ code: "PREPAID_BILLING_MANAGED", error: "This server has prepaid Pro time, not a subscription. Renew or add seats from Plan & Billing." });
      }
      return;
    }
    next();
  } catch (error) { next(error); }
});

const SUBSCRIPTION_ONLY_POSTS = new Set([
  "/checkout",
  "/seat-pack-quantity/preview",
  "/seat-pack-quantity",
  "/pack-quantity/preview",
  "/pack-quantity",
  "/cancel",
]);

/** The button that opened the portal, for billing_portal_opened; `unknown` from older clients. */
function toBillingPortalFrom(value: unknown): BillingPortalFrom {
  return typeof value === "string" && (BILLING_PORTAL_FROM as readonly string[]).includes(value)
    ? value as BillingPortalFrom
    : "unknown";
}

function isSeatPackQuantityRequestError(message: string): boolean {
  return message.includes("must be")
    || message.includes("required")
    || message.includes("does not have")
    || message.includes("not supported")
    || message.startsWith("Promotion code")
    || message.startsWith("First-purchase promotion code")
    || message.startsWith("Minimum-purchase promotion code")
    || message.startsWith("Preview the promotion code")
    || message.startsWith("Seat update preview")
    || message.startsWith("Seat update changed")
    || message.startsWith("A seat update is already pending")
    || message.startsWith("This subscription already has a discount");
}

// POST /api/billing/checkout — create Stripe Checkout session (owner only)
billingRouter.post("/checkout", async (req: Request, res: Response) => {
  try {
    if (!billingService.isStripeConfigured()) {
      res.status(503).json({ error: "Billing is not configured" });
      return;
    }

    // Verify owner
    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(member)) {
      res.status(403).json({ error: "Only the server owner can manage billing" });
      return;
    }

    // Check if already subscribed
    const existing = await billingService.getSubscription(req.serverId!);
    if (existing && (existing.status === "active" || existing.status === "past_due")) {
      res.status(400).json({ error: "Server already has an entitling subscription" });
      return;
    }

    const { successUrl, cancelUrl } = req.body;
    if (!successUrl || !cancelUrl) {
      res.status(400).json({ error: "successUrl and cancelUrl are required" });
      return;
    }
    if (!billingService.validateRedirectUrl(successUrl) || !billingService.validateRedirectUrl(cancelUrl)) {
      res.status(400).json({ error: "Invalid redirect URL" });
      return;
    }

    const url = await billingService.createCheckoutSession(
      req.serverId!,
      req.userId!,
      successUrl,
      cancelUrl,
      req.body,
      { productEvents: getProductEventSink(req.app) },
    );

    res.json({ url });
  } catch (err: any) {
    if (err instanceof CheckoutOutcomeUnknownError || err instanceof BillingSourceCheckBusyError || err instanceof PrepaidActiveError) {
      res.status(409).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof CheckoutPromotionUnavailableError) {
      res.status(400).json({ error: "Promotion code is unavailable", code: err.code });
      return;
    }
    console.error("[Billing] Checkout error:", err);
    const message = err?.message ?? "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (message.includes("must be")) {
      res.status(400).json({ error: message });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to create checkout session",
        logPrefix: "[Billing] Checkout error:",
        err,
      });
    }
  }
});

async function handleSeatPackQuantityUpdate(req: Request, res: Response) {
  try {
    if (!billingService.isStripeConfigured()) {
      res.status(503).json({ error: "Billing is not configured" });
      return;
    }

    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(member)) {
      res.status(403).json({ error: "Only the server owner can manage billing" });
      return;
    }

    const { cancellationWithdrawn, ...result } = await billingService.updateProPackQuantity(req.serverId!, req.userId!, req.body);
    const entry = billingService.toBillingEntry(req.body?.entry);
    if (result.status === "updated" || result.status === "pending_payment" || result.status === "pending_webhook") {
      void recordServerProductEvent(getProductEventSink(req.app), {
        event: "billing_seats_updated",
        userId: req.userId!,
        serverId: req.serverId!,
        properties: {
          entry,
          previous_seat_quantity: result.currentPackQuantity,
          seat_quantity: result.requestedPackQuantity,
          result: result.status,
        },
      });
    }
    if (cancellationWithdrawn) {
      void recordServerProductEvent(getProductEventSink(req.app), {
        event: "billing_cancellation_withdrawn",
        userId: req.userId!,
        serverId: req.serverId!,
        properties: {
          entry,
          seat_quantity: result.currentPackQuantity,
          billing_interval: cancellationWithdrawn.billingInterval,
        },
      });
    }
    res.json(result);
  } catch (err: any) {
    console.error("[Billing] Seat pack quantity update error:", err);
    const message = err?.message ?? "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (isSeatPackQuantityRequestError(message)) {
      res.status(400).json({ error: message });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to update pack quantity",
        logPrefix: "[Billing] Seat pack quantity update error:",
        err,
      });
    }
  }
}

async function handleSeatPackQuantityPreview(req: Request, res: Response) {
  try {
    if (!billingService.isStripeConfigured()) {
      res.status(503).json({ error: "Billing is not configured" });
      return;
    }

    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(member)) {
      res.status(403).json({ error: "Only the server owner can manage billing" });
      return;
    }

    const result = await billingService.previewProPackQuantityUpdate(req.serverId!, req.userId!, req.body);
    res.json(result);
  } catch (err: unknown) {
    console.error("[Billing] Seat pack quantity preview error:", err);
    const message = err instanceof Error ? err.message : "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (isSeatPackQuantityRequestError(message)) {
      res.status(400).json({ error: message });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to preview pack quantity update",
        logPrefix: "[Billing] Seat pack quantity preview error:",
        err,
      });
    }
  }
}

/** The seat price previews below, as paths relative to the billing mount: they get their own rate limit (app.ts). */
export function isBillingPreviewPath(path: string): boolean {
  return /^\/(?:seat-)?pack-quantity\/preview\/?$/.test(path);
}

// POST /api/billing/seat-pack-quantity — update existing Pro seat subscription quantity (owner only)
billingRouter.post("/seat-pack-quantity/preview", handleSeatPackQuantityPreview);
billingRouter.post("/seat-pack-quantity", handleSeatPackQuantityUpdate);
// Backward-compatible alias for clients that still use the old pack slug.
billingRouter.post("/pack-quantity/preview", handleSeatPackQuantityPreview);
billingRouter.post("/pack-quantity", handleSeatPackQuantityUpdate);

// POST /api/billing/cancel — schedule whole-subscription cancellation at period end (owner only)
billingRouter.post("/cancel", async (req: Request, res: Response) => {
  try {
    if (!billingService.isStripeConfigured()) {
      res.status(503).json({ error: "Billing is not configured" });
      return;
    }

    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(member)) {
      res.status(403).json({ error: "Only the server owner can manage billing" });
      return;
    }

    const { seatQuantity, billingInterval, ...result } = await billingService.cancelSubscriptionAtPeriodEnd(req.serverId!, req.userId!);
    void recordServerProductEvent(getProductEventSink(req.app), {
      event: "billing_cancellation_scheduled",
      userId: req.userId!,
      serverId: req.serverId!,
      properties: {
        entry: billingService.toBillingEntry(req.body?.entry),
        seat_quantity: seatQuantity,
        billing_interval: billingInterval,
      },
    });
    res.json(result);
  } catch (err: any) {
    console.error("[Billing] Cancellation error:", err);
    const message = err?.message ?? "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (message.includes("does not have")) {
      res.status(400).json({ error: message });
    } else {
      sendJsonServerError(req, res, {
        error: "Failed to cancel subscription",
        logPrefix: "[Billing] Cancellation error:",
        err,
      });
    }
  }
});

// POST /api/billing/portal — create Stripe Customer Portal session (owner only)
billingRouter.post("/portal", async (req: Request, res: Response) => {
  try {
    if (!billingService.isStripeConfigured()) {
      res.status(503).json({ error: "Billing is not configured" });
      return;
    }

    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(member)) {
      res.status(403).json({ error: "Only the server owner can manage billing" });
      return;
    }

    const { returnUrl } = req.body;
    if (!returnUrl) {
      res.status(400).json({ error: "returnUrl is required" });
      return;
    }
    if (!billingService.validateRedirectUrl(returnUrl)) {
      res.status(400).json({ error: "Invalid redirect URL" });
      return;
    }

    const url = await billingService.createPortalSession(req.serverId!, returnUrl);
    void recordServerProductEvent(getProductEventSink(req.app), {
      event: "billing_portal_opened",
      userId: req.userId!,
      serverId: req.serverId!,
      properties: {
        entry: billingService.toBillingEntry(req.body?.entry),
        from: toBillingPortalFrom(req.body?.from),
      },
    });
    res.json({ url });
  } catch (err: any) {
    sendJsonServerError(req, res, {
      error: "Failed to create portal session",
      logPrefix: "[Billing] Portal error:",
      err,
    });
  }
});

// ── Prepaid Pro (task #19, docs/billing/prepaid-pro.md) ──

// GET /api/billing/prepaid/offer — periods and prices from Stripe, the seat
// minimum, and where a renewal would start (owners and admins, like the summary).
billingRouter.get("/prepaid/offer", async (req: Request, res: Response) => {
  try {
    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canReadBillingSummary(member)) {
      res.status(403).json({ error: "Only server owners and admins can view billing" });
      return;
    }
    const flag = await evaluateFeatureFlag({ key: PRO_PREPAID_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    res.json(await billingService.getPrepaidOfferForServer(req.serverId!, flag.enabled));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to get the prepaid offer", logPrefix: "[Billing] Prepaid offer error:", err });
  }
});

// POST /api/billing/prepaid/checkout — an Alipay Checkout for 1 or 12
// months of Pro (owner only, behind pro_prepaid). Body: months, seatQuantity,
// successUrl, cancelUrl, entry?, openedFrom?, surface?, defaultSeatQuantity?. No price:
// Stripe's Price is the price.
billingRouter.post("/prepaid/checkout", async (req: Request, res: Response) => {
  try {
    const flag = await evaluateFeatureFlag({ key: PRO_PREPAID_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      res.status(403).json({ code: "FEATURE_DISABLED", error: "Prepaid Pro is not available on this server." });
      return;
    }
    const { successUrl, cancelUrl } = req.body ?? {};
    if (typeof successUrl !== "string" || typeof cancelUrl !== "string" || !successUrl || !cancelUrl) {
      res.status(400).json({ error: "successUrl and cancelUrl are required" });
      return;
    }
    if (!billingService.validateRedirectUrl(successUrl) || !billingService.validateRedirectUrl(cancelUrl)) {
      res.status(400).json({ error: "Invalid redirect URL" });
      return;
    }
    const { months, seatQuantity } = parsePrepaidCheckoutBody(req.body);
    const { entry, openedFrom, surface, defaultSeatQuantity } = req.body;
    const url = await billingService.createPrepaidCheckoutSession(req.serverId!, req.userId!, {
      months,
      seatQuantity,
      successUrl,
      cancelUrl,
      // Analytics only: invalid values are dropped by the service's parsers.
      entry: typeof entry === "string" ? entry : undefined,
      openedFrom: typeof openedFrom === "string" ? openedFrom : undefined,
      surface: typeof surface === "string" ? surface : undefined,
      defaultSeatQuantity: typeof defaultSeatQuantity === "number" ? defaultSeatQuantity : undefined,
    }, { productEvents: getProductEventSink(req.app) });
    res.json({ url });
  } catch (err) {
    if (err instanceof PrepaidRequestError) {
      res.status(err.status).json({ code: err.code, error: err.message });
      return;
    }
    if (err instanceof PrepaidPaidSourceError || err instanceof CheckoutOutcomeUnknownError || err instanceof BillingSourceCheckBusyError) {
      res.status(409).json({ code: err.code, error: err.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to create prepaid checkout", logPrefix: "[Billing] Prepaid checkout error:", err });
  }
});

/** A prepaid request the server refuses (4xx) goes out as the refusal envelope; an unconfigured Stripe stays a 503. */
function sendPrepaidRequestError(res: Response, err: PrepaidRequestError): void {
  if (err.status === 503) {
    res.status(503).json({ code: err.code, error: err.message });
    return;
  }
  refuse(res, err.status, { code: err.code, error: err.message });
}

// GET /api/billing/prepaid/seats/quote?seatQuantity=N — what N more seats
// cost now, by the days left to the end of the prepaid time (owners and
// admins, like the offer). The Checkout prices them again; this is for showing.
billingRouter.get("/prepaid/seats/quote", async (req: Request, res: Response) => {
  try {
    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canReadBillingSummary(member)) {
      refuse(res, 403, { code: "billing_read_forbidden", error: "Only server owners and admins can view billing." });
      return;
    }
    const seatQuantity = parsePrepaidSeatQuantity(req.query.seatQuantity);
    const flag = await evaluateFeatureFlag({ key: PRO_PREPAID_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    res.json(await billingService.getPrepaidSeatsQuoteForServer(req.serverId!, flag.enabled, seatQuantity));
  } catch (err) {
    if (err instanceof PrepaidRequestError) {
      sendPrepaidRequestError(res, err);
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to quote prepaid seats", logPrefix: "[Billing] Prepaid seats quote error:", err });
  }
});

// POST /api/billing/prepaid/seats/checkout — an Alipay Checkout adding seats
// to the prepaid time until it ends (owner only, behind pro_prepaid). Body:
// seatQuantity, successUrl, cancelUrl, entry?, openedFrom?. No price. Answers
// { url, expiresAt }: the Checkout lives about half an hour (the price is for now).
billingRouter.post("/prepaid/seats/checkout", async (req: Request, res: Response) => {
  try {
    const flag = await evaluateFeatureFlag({ key: PRO_PREPAID_FEATURE_FLAG_KEY, serverId: req.serverId!, userId: req.userId! });
    if (!flag.enabled) {
      refuse(res, 403, { code: "FEATURE_DISABLED", error: "Prepaid Pro is not available on this server." });
      return;
    }
    const { successUrl, cancelUrl, entry, openedFrom } = req.body ?? {};
    if (typeof successUrl !== "string" || typeof cancelUrl !== "string" || !successUrl || !cancelUrl
      || !billingService.validateRedirectUrl(successUrl) || !billingService.validateRedirectUrl(cancelUrl)) {
      refuse(res, 400, { code: "invalid_redirect_url", error: "successUrl and cancelUrl must be Raft URLs." });
      return;
    }
    const seatQuantity = parsePrepaidSeatQuantity(req.body?.seatQuantity);
    const started = await billingService.createPrepaidSeatsCheckoutSession(req.serverId!, req.userId!, {
      seatQuantity,
      successUrl,
      cancelUrl,
      // Analytics only: invalid values are dropped by the service's parsers.
      entry: typeof entry === "string" ? entry : undefined,
      openedFrom: typeof openedFrom === "string" ? openedFrom : undefined,
    }, { productEvents: getProductEventSink(req.app) });
    res.json(started);
  } catch (err) {
    if (err instanceof PrepaidRequestError) {
      sendPrepaidRequestError(res, err);
      return;
    }
    if (err instanceof PrepaidPaidSourceError || err instanceof CheckoutOutcomeUnknownError || err instanceof BillingSourceCheckBusyError) {
      refuse(res, 409, { code: err.code, error: err.message });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to create prepaid seats checkout", logPrefix: "[Billing] Prepaid seats checkout error:", err });
  }
});

// GET /api/billing/subscription — get current subscription info
billingRouter.get("/subscription", async (req: Request, res: Response) => {
  try {
    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canReadBillingSummary(member)) {
      res.status(403).json({ error: "Only server owners and admins can view billing" });
      return;
    }
    const summary = await billingService.getBillingSummary(req.serverId!);
    res.json({
      ...summary,
      permissions: {
        canReadBillingSummary: true,
        canManageBilling: canMutateBilling(member),
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to get subscription" });
  }
});

// GET /api/billing/payment-method — what Stripe charges for the subscription
// (card brand and last four, a bank's last four, or the kind), for Plan &
// Billing. Owners only, like the portal it stands beside. `paymentMethod: null`
// when there is no subscription or no method on file; 503 without Stripe.
billingRouter.get("/payment-method", async (req: Request, res: Response) => {
  try {
    const role = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canMutateBilling(role)) {
      res.status(403).json({ error: "Only the server owner can see the payment method", code: "payment_method_forbidden" });
      return;
    }
    if (!billingService.isStripeConfigured()) {
      res.status(503).json({ error: "Billing is not configured", code: "billing_not_configured" });
      return;
    }
    const paymentMethod = await billingService.getSubscriptionPaymentMethod(req.serverId!);
    res.setHeader("Cache-Control", "no-store");
    res.json({ paymentMethod });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get the payment method",
      logPrefix: "[Billing] Payment method error:",
      err,
    });
  }
});

// GET /api/billing/hosted-runtime-usage — the server's spend on its hosted
// runtime (antiproton), as the provider reports it: today against the daily
// limit and totals by UTC day or month. Owners and admins only. 404
// `hosted_runtime_spend_not_enabled` when the server has no hosted runtime (the
// Plan page hides the card); display-only, estimated, never stored.
billingRouter.get("/hosted-runtime-usage", async (req: Request, res: Response) => {
  try {
    const member = await getActorServerRoleInServer(req.serverId!, "user", req.userId!);
    if (!canReadBillingSummary(member)) {
      res.status(403).json({ error: "Only server owners and admins can view cloud agent spend", code: "hosted_runtime_spend_forbidden" });
      return;
    }
    // Spend on agents the server already has: shown while the flag is on or once it has had one
    // (a lowered rollout rule doesn't hide existing spend); the kill switch still hides it.
    const hostedSpendVisible = !await isAgentRuntimeProviderKillSwitched("antiproton")
      && (await serverHasHostedProvision(req.serverId!, "antiproton") || await isAgentRuntimeProviderEnabledForServer(req.serverId!, "antiproton"));
    if (!hostedSpendVisible) {
      res.status(404).json({ error: "This server has no cloud agents", code: "hosted_runtime_spend_not_enabled" });
      return;
    }
    const query = parseHostedSpendQuery(req.query);
    if (!query.ok) {
      res.status(400).json({ error: query.error, code: "hosted_runtime_spend_invalid_query" });
      return;
    }
    const result = await getHostedRuntimeSpend(req.serverId!, "antiproton", { from: query.from, to: query.to, bucket: query.bucket });
    res.setHeader("Cache-Control", "no-store");
    if (result.kind === "ok") {
      res.json(result.view);
      return;
    }
    let status: number;
    let code: string;
    let reason: string;
    if (result.kind === "unavailable") {
      [status, code, reason] = [404, "hosted_runtime_spend_not_enabled", result.reason];
    } else if (result.kind === "not_found") {
      [status, code, reason] = [404, "hosted_runtime_spend_not_enabled", "provider_tenant_not_found"];
    } else if (result.kind === "bad_request") {
      [status, code, reason] = [400, "hosted_runtime_spend_invalid_query", result.error?.code ?? "provider_bad_request"];
    } else {
      [status, code, reason] = [502, "hosted_runtime_spend_unavailable", result.reason];
    }
    addTraceEvent("billing.hosted_runtime_spend.failed", {
      route_action: "hosted_runtime_spend",
      outcome: "error",
      reason,
      http_status: status,
      response_code: code,
    });
    res.status(status).json({
      error: status === 502 ? "The cloud agent provider did not answer; try again later" : "Cloud agent spend is not available",
      code,
    });
  } catch {
    addTraceEvent("billing.hosted_runtime_spend.failed", {
      route_action: "hosted_runtime_spend",
      outcome: "error",
      reason: "exception",
      http_status: 500,
    });
    res.status(500).json({ error: "Failed to get cloud agent spend" });
  }
});

// POST /api/webhooks/stripe — Stripe webhook (registered separately in app.ts with raw body)
export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  if (!billingService.isStripeConfigured()) {
    res.status(503).json({ error: "Billing is not configured" });
    return;
  }

  const signature = req.headers["stripe-signature"] as string;
  if (!signature) {
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  try {
    const event = billingService.constructWebhookEvent(req.body as Buffer, signature);
    await billingService.handleWebhookEvent(event, { productEvents: getProductEventSink(req.app) });
    res.json({ received: true });
  } catch (err: any) {
    console.error("[Billing] Webhook error:", err.message);
    res.status(400).json({ error: "Webhook signature verification failed" });
  }
}
