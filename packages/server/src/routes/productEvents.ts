import { PRODUCT_EVENT_STRING_TOKEN } from "@botiverse/raft-shared";
import { Router, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { users } from "../db/schema";
import { legacyProductEventsAllowed, resolveProductAnalyticsGate } from "../services/productAnalyticsGate";
import {
  buildClientEventRows,
  clientEventBatchSchema,
  countIngest,
  getProductEventSink,
} from "../services/productEventIngest";
import { accountAgeBucket, productEventContext } from "../services/productEventContext";
import * as productEventsService from "../services/productEventsService";
import { sendJsonServerError } from "./errorResponse";

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

// Client-sent strings are kept only as tokens ([a-z0-9_-], as for every
// product-event string), so no typed text can be stored: the usage-data notice
// promises it (Tenny, Arkbriar, 2026-10-21). Anything else is dropped. Old
// desktop builds and cached pages may still call this route.
function tokenField(value: unknown, maxLength = 64): string | undefined {
  const field = shortField(value, maxLength);
  return field !== undefined && PRODUCT_EVENT_STRING_TOKEN.test(field) ? field : undefined;
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

    const wizardVersion = tokenField(rawMetadata.wizard_version) ?? "unknown";
    const sessionId = tokenField(rawMetadata.session_id) ?? "unknown";
    const metadata: productEventsService.OnboardingWizardEventMetadata = {
      step_id: stepId as productEventsService.OnboardingWizardStepId,
      wizard_version: wizardVersion,
      session_id: sessionId,
    };

    const action = tokenField(rawMetadata.action);
    const result = tokenField(rawMetadata.result);
    const reason = tokenField(rawMetadata.reason);
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

    const idempotencyKey = tokenField(body.idempotencyKey, 128);

    // RFC-067 controls: an explicit "no" (workspace switch off, or the user
    // turned "Share usage data" off) means nothing is recorded.
    if (!(await legacyProductEventsAllowed(getDb(), { userId: req.userId!, serverId: req.serverId! }))) {
      res.status(204).end();
      return;
    }

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
    sendJsonServerError(req, res, {
      error: "Failed to record product event",
      logPrefix: "[product-events] unexpected error:",
      err,
    });
  }
});

// RFC-067 client behavior events. Clients ask first and send only when this
// says yes (the user's "share usage data" choice, their analytics id, the
// workspace switch, and a configured store); the batch route enforces the same
// gate again.
//
// GET /api/product-events/config
productEventsRouter.get("/config", async (req, res) => {
  try {
    const gate = await resolveProductAnalyticsGate(getDb(), { userId: req.userId!, serverId: req.serverId! });
    res.json({ clientEventsAllowed: gate.clientEventsAllowed && getProductEventSink(req.app) !== null });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to read product event config",
      logPrefix: "[product-events] config error:",
      err,
    });
  }
});

// Web and desktop builds before 1.21.28 show "Share usage data" as off for an
// account that never chose, but since default on (2026-10-21) the server says
// yes and they send. Their user sees "off", so for them not chosen stays off
// until they reload into 1.21.28 or later (Tenny, #proj-analytics:63b84f03).
// Old desktop builds bundle their own web page, so they report `web` too;
// newer ones report `desktop` with the embedded web build in `web_version`
// (their own app_version is numbered differently). A batch without a web
// version counts as old. The native apps have no switch and follow the
// server, so they are not affected.
//
// Builds from #10790 on say so themselves: the web sends `display_mode` and the
// desktop app `web_version`, fields no older build can send (the batch schema
// is strict). They are judged by that, not by their version label, which comes
// from a release stamp: v1.21.30 was first cut still labelled 1.21.26 (AndyLok,
// #proj-analytics:3d10cdf1), and staging builds carry the last stamped label.
const FIRST_WEB_VERSION_SHOWING_SHARING_ON = [1, 21, 28] as const;

function webBuildShowsNotChosenAsOff(batch: { source: string; app_version?: string; web_version?: string; display_mode?: string }): boolean {
  if (batch.source !== "web" && batch.source !== "desktop") return false;
  if (batch.display_mode !== undefined || batch.web_version !== undefined) return false;
  if (batch.source === "desktop") return true; // its own app_version is not a web version
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(batch.app_version ?? "");
  if (!match) return true;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== FIRST_WEB_VERSION_SHOWING_SHARING_ON[i]) return version[i] < FIRST_WEB_VERSION_SHOWING_SHARING_ON[i];
  }
  return false;
}

// POST /api/product-events/batch
//
// Always 202 once the body is well-formed: the client drops its batch either
// way. `accepted` is how many rows were queued for the store (`duplicates`:
// how many this replica had already queued), answered before the background
// write; counts of what was written, lost, gated or rejected live in metrics.
productEventsRouter.post("/batch", async (req, res) => {
  const parsed = clientEventBatchSchema.safeParse(req.body);
  if (!parsed.success) {
    countIngest("rejected_malformed", 1);
    res.status(400).json({ error: "Invalid product event batch" });
    return;
  }
  const batch = parsed.data;
  try {
    const sink = getProductEventSink(req.app);
    if (sink === null) {
      countIngest("unconfigured", batch.events.length);
      res.status(202).json({ accepted: 0 });
      return;
    }
    const gate = await resolveProductAnalyticsGate(getDb(), { userId: req.userId!, serverId: req.serverId! });
    if (!gate.clientEventsAllowed || gate.analyticsId === null) {
      countIngest("gated", batch.events.length);
      res.status(202).json({ accepted: 0 });
      return;
    }
    const [user] = await getDb()
      .select({ shareUsageData: users.shareUsageData, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, req.userId!))
      .limit(1);
    if (webBuildShowsNotChosenAsOff(batch) && (user?.shareUsageData ?? null) === null) {
      countIngest("gated", batch.events.length);
      res.status(202).json({ accepted: 0 });
      return;
    }
    const receivedAt = new Date();
    const { rows, rejected } = buildClientEventRows({
      batch,
      analyticsId: gate.analyticsId,
      serverId: req.serverId!,
      receivedAt,
      context: {
        ...productEventContext({ userAgent: req.get("user-agent"), country: req.get("cloudfront-viewer-country") }),
        ...(user ? { $account_age: accountAgeBucket(user.createdAt, receivedAt) } : {}),
      },
    });
    for (const [reason, count] of Object.entries(rejected)) {
      countIngest(`rejected_${reason as keyof typeof rejected}`, count);
    }
    // Queued for the background writer, which counts written and lost rows.
    sink.enqueue(rows);
    // `duplicates`: events this replica already queued (their uuid queued
    // recently; a refused event is not remembered, so it is judged again).
    // Like `accepted`, it means queued for the background writer, not
    // written: a row the writer loses is only counted in metrics. Desktop's
    // migration reports stop sending on either. Absent when 0.
    res.status(202).json({ accepted: rows.length, ...(rejected.duplicate ? { duplicates: rejected.duplicate } : {}) });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to record product events",
      logPrefix: "[product-events] batch error:",
      err,
    });
  }
});
