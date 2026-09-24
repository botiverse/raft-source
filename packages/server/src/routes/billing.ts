import { Router, type Router as RouterType, type Request, type Response } from "express";
import { canMutateBilling, canReadBillingSummary } from "@botiverse/raft-shared";
import * as billingService from "../services/billingService.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";

export const billingRouter: RouterType = Router();

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
    );

    res.json({ url });
  } catch (err: any) {
    console.error("[Billing] Checkout error:", err);
    const message = err?.message ?? "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (message.includes("must be")) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: "Failed to create checkout session" });
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

    const result = await billingService.updateProPackQuantity(req.serverId!, req.userId!, req.body);
    res.json(result);
  } catch (err: any) {
    console.error("[Billing] Seat pack quantity update error:", err);
    const message = err?.message ?? "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (isSeatPackQuantityRequestError(message)) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: "Failed to update pack quantity" });
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
      res.status(500).json({ error: "Failed to preview pack quantity update" });
    }
  }
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

    const result = await billingService.cancelSubscriptionAtPeriodEnd(req.serverId!, req.userId!);
    res.json(result);
  } catch (err: any) {
    console.error("[Billing] Cancellation error:", err);
    const message = err?.message ?? "";
    if (message.includes("is not configured")) {
      res.status(503).json({ error: message });
    } else if (message.includes("does not have")) {
      res.status(400).json({ error: message });
    } else {
      res.status(500).json({ error: "Failed to cancel subscription" });
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
    res.json({ url });
  } catch (err: any) {
    console.error("[Billing] Portal error:", err);
    res.status(500).json({ error: "Failed to create portal session" });
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
    await billingService.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err: any) {
    console.error("[Billing] Webhook error:", err.message);
    res.status(400).json({ error: "Webhook signature verification failed" });
  }
}
