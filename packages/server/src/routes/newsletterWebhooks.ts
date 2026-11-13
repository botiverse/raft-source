import type { Request, Response } from "express";
import { handleNewsletterWebhookPayload, verifyResendWebhookSignature } from "../services/newsletterService";
import { handlePaidLifecycleWebhookPayload } from "../services/paidLifecycleService";

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
    // Independent receipt replay: newsletter event dedupe must not swallow a
    // retry of a failed paid-mail detail fetch / CRM write. Verify before parsing
    // or fetching any email, even when the newsletter ledger has seen this ID.
    const secret = process.env.RESEND_NEWSLETTER_WEBHOOK_SECRET ?? process.env.RESEND_WEBHOOK_SECRET;
    if (secret) {
      verifyResendWebhookSignature(req.body as Buffer, { id, timestamp, signature }, secret);
      try { await handlePaidLifecycleWebhookPayload(req.body as Buffer); }
      catch {
        // Provider/driver errors may contain private response bodies or SQL
        // parameters. Retry this receipt without logging their raw messages.
        console.error("[Newsletter] Paid email receipt remains pending");
        res.status(503).json({ error: "Paid email receipt remains pending" });
        return;
      }
    }
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
