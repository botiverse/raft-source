// Sending product feedback to Hands, as POST /api/product-feedback does it
// (routes/productFeedback.ts), plus the one way a `feedback:submit` action
// card's feedback is filed: sendFeedbackCard. Its two callers are the card's
// dialog (POST /api/product-feedback with action_card_message_id) and the
// card's form (POST /api/actions/:messageId/execute with `form`,
// services/feedbackCardForm.ts), so both file the same ticket the same way:
// the sender's membership of the card's server, the server-derived
// attribution, the Hands app for the client, the route binding, the
// submission_id fixed per card and sender, and the same result for the card.

import { and, eq, isNull, ne } from "drizzle-orm";
import type { ActionCardResult, ServerId } from "@botiverse/raft-shared";
import { currentTimeMs } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { serverMembers, servers } from "../db/schema";
import {
  ProductFeedbackConfigurationError,
  ProductFeedbackUpstreamError,
  agentFeedbackCardSubmissionId,
  isPresignedRejection,
  isProductFeedbackConfigured,
  isSubmissionAlreadyFiledWithOtherContent,
  submitProductFeedback,
  type ProductFeedbackAttachment,
  type ProductFeedbackKind,
  type ProductFeedbackNormalizedMetadata,
  type ProductFeedbackPresignedAttachment,
  type ProductFeedbackReceipt,
  type ProductFeedbackReporterAttribution,
  type ProductFeedbackSubmission,
} from "./productFeedbackService";
import {
  ensureProductFeedbackRouteBinding,
  forgetProductFeedbackRouteBinding,
  isHandsAuthRejectionStatus,
  isProductFeedbackRouteConfigured,
  ProductFeedbackRouteBindingError,
} from "./productFeedbackRouteBindingService";
import { isProductFeedbackConversationConfigured } from "./productFeedbackConversationService";
import { ProductFeedbackSourceUnavailableError, resolveProductFeedbackApp } from "./productFeedbackApps";
import { notifyProductFeedbackTriage } from "./productFeedbackTriageNotice";

/**
 * Whether this deployment has Hands product feedback configured: sending,
 * the reporter's conversations and the route binding (HANDS_FEEDBACK_*,
 * which self-hosted and local deployments usually leave unset). Only then is
 * the sidebar's feedback entry shown (serverSettingsService) and may an agent
 * prepare a `feedback:submit` card (actionCardsService).
 */
export function isProductFeedbackEnabled(): boolean {
  return isProductFeedbackConfigured()
    && isProductFeedbackConversationConfigured()
    && isProductFeedbackRouteConfigured();
}

/**
 * The caller's membership row for a server, by the same predicate as the
 * server-scoped middleware (`requireServer`): joint-storage pseudo-servers are
 * excluded as well as soft-deleted ones. `serverService.isMember` is
 * deliberately NOT used because it does not filter `joint_storage`, which would
 * let a storage pseudo-server become a reporter attribution.
 */
export async function findFeedbackServerMembership(
  serverId: string,
  userId: string,
): Promise<{ serverId: string; slug: string } | undefined> {
  const [membership] = await getDb()
    .select({ serverId: serverMembers.serverId, slug: servers.slug })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, userId),
      ne(servers.kind, "joint_storage"),
      isNull(servers.deletedAt),
    ));
  return membership;
}

/**
 * Resolve the reporter attribution block for a submission.
 *
 * ORDER IS LOAD-BEARING: the submitted server id is validated against the
 * caller's membership BEFORE `server_slug` is ever looked up. Reversing this
 * would write a server slug the caller has no access to into the ticket, which
 * is an information-disclosure bug rather than a validation nit.
 *
 * Failure is deliberately non-fatal: attribution is best-effort context, and a
 * reporter must never be blocked from submitting feedback because the context
 * could not be derived. Returns null when there is nothing trustworthy to send.
 */
export async function resolveReporterAttribution(input: {
  serverId: string | null;
  userId: string;
  handle: string;
}): Promise<ProductFeedbackReporterAttribution | null> {
  const { serverId, userId, handle } = input;
  if (!serverId) return null;
  // 1. Validate membership FIRST — never look anything up before this passes
  //    (the slug comes from the same validated row).
  const membership = await findFeedbackServerMembership(serverId, userId);
  // 2. Only now read the values, and ONLY from the validated membership row.
  //    `server_id` is taken from the row too rather than from the raw input so
  //    that id and slug provably describe the same validated server. Sourcing
  //    them differently would let the two fields drift apart, and a mis-recorded
  //    attribution is worse than a missing one.
  const validatedServerId = membership?.serverId;
  const validatedSlug = membership?.slug;
  if (!validatedServerId || !validatedSlug) return null;
  return {
    v: 1,
    server_id: validatedServerId,
    server_slug: validatedSlug,
    user_id: userId,
    handle,
  };
}

export function buildProductFeedbackContact(user: {
  email: string;
  name: string;
  displayName: string | null;
}): string {
  return `${user.displayName?.trim() || user.name} (@${user.name}) <${user.email}>`;
}

// One warn line per reason per minute: a missing config (every e2e and dev
// server) or an open breaker otherwise logs once per request. The trace span
// `server.product_feedback.route_binding` keeps the per-call count.
const ROUTE_BINDING_LOG_INTERVAL_MS = 60_000;
const routeBindingLogState = new Map<string, { loggedAt: number; suppressed: number }>();

export function productFeedbackRouteBindingLog(error: ProductFeedbackRouteBindingError): void {
  const now = currentTimeMs();
  const state = routeBindingLogState.get(error.reason);
  if (state && now - state.loggedAt < ROUTE_BINDING_LOG_INTERVAL_MS) {
    state.suppressed += 1;
    return;
  }
  const suppressed = state?.suppressed ?? 0;
  routeBindingLogState.set(error.reason, { loggedAt: now, suppressed: 0 });
  // A fixed reason code (an upstream status at most); never a value.
  // `upstreamCode` is Hands' identifier-shaped error code, read from the first non-suppressed failure.
  const upstream = error.upstreamCode ? `; hands code ${error.upstreamCode}` : "";
  console.warn(`[product-feedback] route binding failed (${error.reason}${upstream})${suppressed > 0 ? `; ${suppressed} more since the last line` : ""}`);
}

export function productFeedbackSourceUnavailableLog(error: ProductFeedbackSourceUnavailableError): void {
  // Source and a fixed reason code (field names at most); never a value.
  console.warn(`[product-feedback] source unavailable (${error.source}: ${error.reason})`);
}

export function mapProductFeedbackUpstreamError(
  error: ProductFeedbackUpstreamError,
  options: { withDiagnostics?: boolean } = {},
): { status: number; code: string } {
  if (options.withDiagnostics && isPresignedRejection(error)) {
    return { status: 400, code: "feedback_diagnostics_rejected" };
  }
  if (error.upstreamStatus === 401 || error.upstreamStatus === 403) {
    return { status: 503, code: "feedback_integration_unavailable" };
  }
  if (error.upstreamStatus === 409) return { status: 409, code: "feedback_submission_conflict" };
  if (error.upstreamStatus === 413) return { status: 413, code: "feedback_attachment_too_large" };
  if (error.upstreamStatus === 429) return { status: 429, code: "feedback_rate_limited" };
  if (error.upstreamStatus === 400) return { status: 400, code: "feedback_invalid" };
  return { status: 503, code: "feedback_service_unavailable" };
}

/** How a failed send is answered: status, code and English text (plus Hands' own words for an upstream refusal). */
export interface ProductFeedbackSendFailure {
  status: number;
  code: string;
  error: string;
  retryAfter: string | null;
  upstreamStatus: number | null;
  upstreamError: string | null;
}

/**
 * The answer to a send that failed on the way to Hands, or null for any other
 * error (a 500). Logs the operator line for an unavailable source or route
 * binding, never a value.
 */
export function productFeedbackSendFailure(error: unknown, options: { withDiagnostics?: boolean } = {}): ProductFeedbackSendFailure | null {
  const plain = (status: number, code: string, text: string): ProductFeedbackSendFailure =>
    ({ status, code, error: text, retryAfter: null, upstreamStatus: null, upstreamError: null });
  if (error instanceof ProductFeedbackSourceUnavailableError) productFeedbackSourceUnavailableLog(error);
  if (error instanceof ProductFeedbackRouteBindingError) productFeedbackRouteBindingLog(error);
  if (error instanceof ProductFeedbackRouteBindingError || error instanceof ProductFeedbackSourceUnavailableError) {
    return plain(503, "feedback_integration_unavailable", "Feedback service is temporarily unavailable");
  }
  if (error instanceof ProductFeedbackConfigurationError) {
    return plain(503, "feedback_not_configured", "Product feedback is not configured");
  }
  if (!(error instanceof ProductFeedbackUpstreamError)) return null;
  const mapped = mapProductFeedbackUpstreamError(error, options);
  return {
    status: mapped.status,
    code: mapped.code,
    error: mapped.code === "feedback_diagnostics_rejected"
      ? "Hands rejected the diagnostics attachment; no feedback was created"
      : mapped.status === 429
        ? "Too many feedback submissions. Please try again later."
        : mapped.status === 409
          ? "This feedback draft changed after it was submitted. Start a new draft and try again."
          : mapped.status === 400
            ? "Hands rejected this feedback submission"
            : "Feedback service is temporarily unavailable",
    retryAfter: error.retryAfter,
    upstreamStatus: error.upstreamStatus,
    upstreamError: error.upstreamError,
  };
}

/** A card's sender is no member of the card's server (its attribution): 403 NOT_A_MEMBER, nothing reaches Hands. */
export class FeedbackCardSenderNotMemberError extends Error {
  readonly status = 403;
  readonly code = "NOT_A_MEMBER";
  constructor() {
    super("You are not a member of this server");
    this.name = "FeedbackCardSenderNotMemberError";
  }
}

export type ProductFeedbackCardResult = Extract<ActionCardResult, { kind: "product-feedback" }>;

/** One send of a `feedback:submit` card: the card, its sender, what they send, and their client's facts. */
export interface FeedbackCardSend {
  card: { messageId: string; targetServerId: ServerId; requesterAgentId: string };
  user: { id: string; name: string; email: string; displayName: string | null };
  kind: ProductFeedbackKind;
  /** Trimmed, 1-10,000 UTF-16 units (the route's rule; productFeedbackMessage). */
  message: string;
  mayContact: boolean;
  /** The client's facts; the reporter attribution is derived here. */
  metadata: Omit<ProductFeedbackNormalizedMetadata, "reporterAttribution">;
  attachments: ProductFeedbackAttachment[];
  diagnostics?: ProductFeedbackPresignedAttachment | null;
  /** Filled in for the route's Server-Timing: when the Hands request started, and Hands' own timing. */
  upstream?: { startedAt: number; serverTiming: string | null };
}

/**
 * A filed card: the Hands receipt and the card's result from it; or, when
 * Hands says this sender already filed this card with other content (a lost
 * response, then edited text), no receipt and a result without a ticket.
 */
export type FeedbackCardSent =
  | { receipt: ProductFeedbackReceipt; result: ProductFeedbackCardResult }
  | { receipt: null; result: ProductFeedbackCardResult };

/**
 * File a `feedback:submit` card's feedback as its sender's own. The caller
 * has checked the card (the sender may operate it, it waits, its version is
 * current). Throws FeedbackCardSenderNotMemberError, or what
 * productFeedbackSendFailure maps, before or from Hands.
 */
export async function sendFeedbackCard(input: FeedbackCardSend): Promise<FeedbackCardSent> {
  const { card, user } = input;
  // Required for a card send, and server-derived: the card's server, plus who drafted it.
  const attribution = await resolveReporterAttribution({ serverId: card.targetServerId, userId: user.id, handle: user.name });
  if (!attribution) throw new FeedbackCardSenderNotMemberError();
  const metadata: ProductFeedbackNormalizedMetadata = {
    ...input.metadata,
    reporterAttribution: { ...attribution, source: "agent_card", drafted_by_agent_id: card.requesterAgentId },
  };
  // `app`: the Hands app it is filed into, which the card's result records as
  // `source` (a client opens the ticket only through that app).
  const { env, app } = await resolveProductFeedbackApp({ source: metadata.clientKind });
  if (!isProductFeedbackConfigured(env)) throw new ProductFeedbackConfigurationError();
  await ensureProductFeedbackRouteBinding({ userId: user.id, env });
  if (input.upstream) input.upstream.startedAt = performance.now();
  try {
    const receipt = await submitBoundProductFeedback({
      // Fixed per card and sender: one ticket per person per card, however
      // many tabs, retries, or ways (dialog or form) they send it.
      submissionId: agentFeedbackCardSubmissionId(card.messageId, user.id),
      kind: input.kind,
      message: input.message,
      contact: input.mayContact ? buildProductFeedbackContact(user) : null,
      userId: user.id,
      metadata,
      fromAgentFeedbackCard: true,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      attachments: input.attachments,
    }, {
      env,
      onUpstreamServerTiming: (value) => { if (input.upstream) input.upstream.serverTiming = value; },
    });
    return { receipt, result: { kind: "product-feedback", ticketId: receipt.id, reference: receipt.reference, source: app } };
  } catch (error) {
    // This person already filed this card (e.g. the response was lost, then
    // they resent edited text). Hands doesn't name the ticket, so the card
    // completes without one and links to their feedback list.
    if (error instanceof ProductFeedbackUpstreamError && isSubmissionAlreadyFiledWithOtherContent(error)) {
      return { receipt: null, result: { kind: "product-feedback", ticketId: null, reference: null, source: app } };
    }
    throw error;
  }
}

/**
 * submitProductFeedback after the route binding, as both sends (the form route
 * and sendFeedbackCard) file it. A Hands 401 or 403 drops the sender's cached
 * route binding, so the next request binds again instead of reusing one Hands
 * no longer honours; any other failure keeps it. A filed ticket also starts
 * the triage agent's inbox notice (productFeedbackTriageNotice.ts).
 */
export async function submitBoundProductFeedback(
  input: ProductFeedbackSubmission,
  options: { env: NodeJS.ProcessEnv; onUpstreamServerTiming?: (value: string | null) => void },
): Promise<ProductFeedbackReceipt> {
  try {
    const receipt = await submitProductFeedback(input, options);
    // Best effort, not awaited: the triage agent's inbox notice never fails or slows the submission.
    notifyProductFeedbackTriage(input, receipt);
    return receipt;
  } catch (error) {
    if (error instanceof ProductFeedbackUpstreamError && isHandsAuthRejectionStatus(error.upstreamStatus)) {
      forgetProductFeedbackRouteBinding({ userId: input.userId, env: options.env });
    }
    throw error;
  }
}

/** The route's message rule: trimmed, 1-10,000 UTF-16 units; anything else is null. */
export const PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH = 10_000;
export function productFeedbackMessage(raw: unknown): string | undefined {
  const message = typeof raw === "string" ? raw.trim() : "";
  return message.length > 0 && message.length <= PRODUCT_FEEDBACK_MAX_MESSAGE_LENGTH ? message : undefined;
}
