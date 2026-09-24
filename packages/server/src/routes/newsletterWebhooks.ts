import type { Request, Response } from "express";
import { handleNewsletterWebhookPayload } from "../services/newsletterService.js";

// POST /api/webhooks/resend — Resend webhook (registered in app.ts with raw body)
export async function resendNewsletterWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = req.headers["svix-signature"];
  const timestamp = req.headers["svix-timestamp"];
  const id = req.headers["svix-id"];
  if (!signature || !timestamp || !id) {
    res.status(400).json({ error: "Missing Resend webhook signature headers" });
    return;
  }

  try {
    const result = await handleNewsletterWebhookPayload(req.body as Buffer, {
      id,
      timestamp,
      signature,
    });
    res.json({ received: true, ...result });
  } catch (err: any) {
    console.error("[Newsletter] Resend webhook error:", err?.message ?? err);
    res.status(400).json({ error: "Resend webhook verification failed" });
  }
}
