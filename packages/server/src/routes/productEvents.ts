import { Router, type Router as RouterType } from "express";
import * as productEventsService from "../services/productEventsService.js";

export const productEventsRouter: RouterType = Router();

const ONBOARDING_WIZARD_EVENT_TYPES = new Set([
  "onboarding_wizard.step_shown",
  "onboarding_wizard.primary_clicked",
  "onboarding_wizard.skip_clicked",
  "onboarding_wizard.dismissed",
  "onboarding_wizard.completed",
  "onboarding_wizard.error",
]);

const ONBOARDING_WIZARD_STEP_IDS = new Set([
  "add-computer",
  "detect-runtime",
  "create-agent",
  "referral-source",
  "invite-teammates",
  "join-community",
]);

function shortField(value: unknown, maxLength = 64): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

// POST /api/product-events/onboarding-wizard
//
// Client-emitted interaction events for the owner onboarding wizard. This is
// intentionally narrower than a generic event ingest endpoint: event_type and
// step_id are whitelisted, metadata is reduced to low-cardinality fields, and
// `subject_id` is always the current server id from `requireServer`.
productEventsRouter.post("/onboarding-wizard", async (req, res) => {
  try {
    const body = (req.body ?? {}) as {
      eventType?: unknown;
      idempotencyKey?: unknown;
      metadata?: unknown;
    };

    if (
      typeof body.eventType !== "string" ||
      !ONBOARDING_WIZARD_EVENT_TYPES.has(body.eventType)
    ) {
      res.status(400).json({
        error:
          "eventType must be one of onboarding_wizard.step_shown, onboarding_wizard.primary_clicked, onboarding_wizard.skip_clicked, onboarding_wizard.dismissed, onboarding_wizard.completed, onboarding_wizard.error",
      });
      return;
    }

    const rawMetadata = (body.metadata ?? {}) as Record<string, unknown>;
    const stepId = shortField(rawMetadata.step_id);
    if (!stepId || !ONBOARDING_WIZARD_STEP_IDS.has(stepId)) {
      res.status(400).json({ error: "metadata.step_id must be a tracked onboarding wizard step" });
      return;
    }

    const wizardVersion = shortField(rawMetadata.wizard_version) ?? "unknown";
    const sessionId = shortField(rawMetadata.session_id) ?? "unknown";
    const metadata: productEventsService.OnboardingWizardEventMetadata = {
      step_id: stepId as productEventsService.OnboardingWizardStepId,
      wizard_version: wizardVersion,
      session_id: sessionId,
    };

    const action = shortField(rawMetadata.action);
    const result = shortField(rawMetadata.result);
    const reason = shortField(rawMetadata.reason);
    if (action) metadata.action = action;
    if (result) metadata.result = result;
    if (reason) metadata.reason = reason;
    if (
      typeof rawMetadata.latency_ms === "number" &&
      rawMetadata.latency_ms >= 0 &&
      rawMetadata.latency_ms < 1_000_000
    ) {
      metadata.latency_ms = Math.round(rawMetadata.latency_ms);
    }

    const idempotencyKey = shortField(body.idempotencyKey, 128);

    await productEventsService.recordOnboardingWizardEvent({
      serverId: req.serverId!,
      eventType: body.eventType as productEventsService.OnboardingWizardEventType,
      actor: { type: "human", id: req.userId! },
      source: "web",
      idempotencyKey,
      metadata,
    });

    res.status(204).end();
  } catch (err) {
    console.error("[product-events] unexpected error:", err);
    res.status(500).json({ error: "Failed to record product event" });
  }
});
