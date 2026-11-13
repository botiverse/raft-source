import type { SlackTestIdentityObserver } from "../services/slackInboundIdentityObservation";
import type { SlackLifecycleMemberProfile } from "../services/slackChannelLifecycleObservation";
import {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import {
  currentDate,
  slackBridgeChannelPairRemovalsRequestSchema,
  slackBridgeChannelPairsRequestSchema,
  slackBridgeDisconnectRequestSchema,
  slackBridgeProvisioningResponseSchema,
  sanitizeAppLocalReturnPath,
  type SlackBridgeChannelPair,
  type SlackBridgeChannelPairRemoval,
  type SlackBridgeProvisioningResponse,
} from "@botiverse/raft-shared";
import {
  beginExternalOAuthAttempt,
  claimExternalOAuthAttempt,
  completeExternalOAuthAttempt,
  ExternalAppControlPlaneError,
  markExternalOAuthExchangeUnknown,
} from "../services/externalAppControlPlaneService";
import {
  ExternalAppIngressError,
  type ExternalAppIngressErrorCode,
  type ExternalIngressPayloadSealer,
  type ExternalIngressRuntimeResolver,
  type ExternalIngressSecretResolver,
} from "../services/externalAppIngressService";
import {
  createSlackEventsHttpAdapter,
  SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA,
  SLACK_OAUTH_CODE_HANDLE_SCHEMA,
  type SlackEventsHttpResponse,
  type SlackOAuthAppCredentialHandle,
  type SlackOAuthCodeHandle,
  type SlackOAuthExchangeOutcome,
  type SlackOAuthExchangeRequest,
  type SlackIngressAuthorityAdapter,
  type SlackIngressEventStatus,
} from "../services/slackProviderAdapter";
import { slackBridgeIngressObservationsTotal } from "../metrics";
import type { SlackVerifiedIngressPayloadCrypto } from "../services/slackVerifiedIngressContracts";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../services/slackBridgeProductionAppContract";

export { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../services/slackBridgeProductionAppContract";

import { UUID_RE as UUID_PATTERN } from "../lib/messageId";
import { addTraceEvent } from "../tracing/semanticTrace";
import {
  clearOAuthBrowserBindingCookie,
  oauthBrowserBindingCookie,
  oauthCallbackIsBound,
  type OAuthBrowserBinding,
} from "../services/oauthBrowserBinding";
const OAUTH_CODE_MAX_LENGTH = 4_096;
const OAUTH_STATE_MAX_LENGTH = 1_024;
const OAUTH_LEASE_AUDIENCE = "slack-oauth-exchange";

type SlackIngressDeliveryObservation = "initial" | "retry";
type SlackIngressOutcome =
  | "request"
  | "runtime_unavailable"
  | "raw_body_unavailable"
  | "raw_body_too_large"
  | "raw_body_encoding_unsupported"
  | "raw_body_charset_unsupported"
  | "raw_body_aborted"
  | "raw_body_size_invalid"
  | "raw_body_stream_invalid"
  | "raw_body_parse_error"
  | "url_verification"
  | "unexpected_error"
  | ExternalAppIngressErrorCode
  | `event_${SlackIngressEventStatus}`;

function slackIngressDeliveryObservation(headers: Request["headers"]): SlackIngressDeliveryObservation {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  return names.includes("x-slack-retry-num") || names.includes("x-slack-retry-reason")
    ? "retry"
    : "initial";
}

function observeSlackIngress(
  stage: "arrival" | "terminal",
  outcome: SlackIngressOutcome,
  delivery: SlackIngressDeliveryObservation,
): void {
  slackBridgeIngressObservationsTotal.labels(stage, outcome, delivery).inc();
}

function slackIngressRawBodyErrorOutcome(error: unknown): SlackIngressOutcome {
  const type = error && typeof error === "object" && "type" in error
    ? String(error.type)
    : "";
  switch (type) {
    case "entity.too.large":
      return "raw_body_too_large";
    case "encoding.unsupported":
      return "raw_body_encoding_unsupported";
    case "charset.unsupported":
      return "raw_body_charset_unsupported";
    case "request.aborted":
      return "raw_body_aborted";
    case "request.size.invalid":
      return "raw_body_size_invalid";
    case "stream.encoding.set":
    case "stream.not.readable":
      return "raw_body_stream_invalid";
    default:
      return "raw_body_parse_error";
  }
}

export interface SlackBridgeManagedOAuthLease {
  handle: SlackOAuthAppCredentialHandle;
  leaseExpiresAt: Date;
}

export interface SlackBridgeProvisioningRequestAuthority {
  serverId: string;
  requestingUserId: string;
  now: Date;
  includeDeliveryHealth?: boolean;
  includePairDeliveryHealth?: boolean;
  includeWorkspaceAdminHint?: boolean;
  /** `?confirmationHint=1`: a pair block Raft cannot confirm yet carries `detail` (strict older clients don't ask). */
  includeConfirmationHint?: boolean;
  includeAttachmentSourceHealth?: boolean;
  /** `?cardEditNotices=1`: RFC 082 §4.6 card Slack notices (strict older clients don't ask). */
  includeCardEditNotices?: boolean;
  includePrivateAuthorizerHint?: boolean;
  includeInboundRecovery?: boolean;
}

/**
 * #8-owned authority seam for the hosted setup wizard. Implementations must
 * derive every returned stage and health field from current persisted/runtime
 * authority; request bodies never mint grants, epochs, preflight, or health.
 */
export interface SlackBridgeProvisioningControlPlane {
  load(input: SlackBridgeProvisioningRequestAuthority): Promise<SlackBridgeProvisioningResponse>;
  connect(input: SlackBridgeProvisioningRequestAuthority): Promise<SlackBridgeProvisioningResponse>;
  saveChannelPairs(input: SlackBridgeProvisioningRequestAuthority & {
    pairs: readonly SlackBridgeChannelPair[];
  }): Promise<SlackBridgeProvisioningResponse>;
  removeChannelPairs(input: SlackBridgeProvisioningRequestAuthority & {
    pairs: readonly SlackBridgeChannelPairRemoval[];
  }): Promise<SlackBridgeProvisioningResponse>;
  disconnect(input: SlackBridgeProvisioningRequestAuthority & {
    expectedConnectionEpoch: number;
  }): Promise<SlackBridgeProvisioningResponse>;
  runPreflight(input: SlackBridgeProvisioningRequestAuthority): Promise<SlackBridgeProvisioningResponse>;
  enable(input: SlackBridgeProvisioningRequestAuthority): Promise<SlackBridgeProvisioningResponse>;
  retryDelivery?(input: SlackBridgeProvisioningRequestAuthority & {
    bindingId: string;
    bindingEpoch: number;
    deliveryId: string;
    expectedProviderAttempts: number;
  }): Promise<SlackBridgeProvisioningResponse>;
  replayInbound?(input: SlackBridgeProvisioningRequestAuthority & {
    bindingId: string;
    bindingEpoch: number;
    eventId?: string;
    reason?: string;
  }): Promise<SlackBridgeProvisioningResponse>;
  /** Re-activates this server's bindings paused by a re-authorization; null when none were paused. */
  resumeAfterReauthorization?(input: SlackBridgeProvisioningRequestAuthority): Promise<SlackBridgeProvisioningResponse | null>;
}

export interface SlackBridgeRouteDependencies {
  environment: "test" | "production";
  oauthRedirectUri: string;
  eventsRequestUrl: string;
  appOrigin: string;
  isLaunchEnabled(input: { serverId: string; now: Date }): Promise<boolean>;
  resolveOAuthCompletionRedirectPath(input: { serverId: string }): Promise<string | null>;
  leaseOAuthAppCredential(input: {
    registrationId: string;
    providerAppId: string;
    providerOAuthClientId: string;
    environment: "test" | "production";
    audience: typeof OAUTH_LEASE_AUDIENCE;
    attemptId: string;
    now: Date;
  }): Promise<SlackBridgeManagedOAuthLease | null>;
  captureAuthorizationCode(input: {
    attemptId: string;
    providerOAuthClientId: string;
    authorizationCode: string;
    now: Date;
  }): Promise<SlackOAuthCodeHandle>;
  exchangeOAuth(request: SlackOAuthExchangeRequest): Promise<SlackOAuthExchangeOutcome>;
  secretResolver: ExternalIngressSecretResolver;
  payloadSealer: ExternalIngressPayloadSealer;
  runtimeResolver?: ExternalIngressRuntimeResolver;
  verifiedIngressCrypto?: SlackVerifiedIngressPayloadCrypto;
  testIdentityObserver?: SlackTestIdentityObserver;
  admitSlackIngress?: SlackIngressAuthorityAdapter;
  provisioning?: SlackBridgeProvisioningControlPlane;
  requestLifecycleReconcile?(bindingId?: string): Promise<unknown> | void;
  readLifecycleMemberProfile?(bindingId: string, providerUserId: string): Promise<SlackLifecycleMemberProfile | null>;
  onLifecycleError?(error: unknown): void;
  now?(): Date;
}

export interface SlackBridgeRouteHandlers {
  loadProvisioning: RequestHandler;
  connectProvisioning: RequestHandler;
  saveChannelPairs: RequestHandler;
  removeChannelPairs: RequestHandler;
  disconnectProvisioning: RequestHandler;
  runPreflight: RequestHandler;
  enable: RequestHandler;
  retryDelivery: RequestHandler;
  replayInbound: RequestHandler;
  startOAuth: RequestHandler;
  completeOAuth: RequestHandler;
  observeEventsArrival: RequestHandler;
  handleEventsRawBodyError: ErrorRequestHandler;
  receiveEvents: RequestHandler;
}

function provisioningReady(
  dependencies: SlackBridgeRouteDependencies | undefined,
): dependencies is SlackBridgeRouteDependencies & { provisioning: SlackBridgeProvisioningControlPlane } {
  return Boolean(
    runtimeReady(dependencies)
    && dependencies.provisioning
    && typeof dependencies.provisioning.load === "function"
    && typeof dependencies.provisioning.connect === "function"
    && typeof dependencies.provisioning.saveChannelPairs === "function"
    && typeof dependencies.provisioning.removeChannelPairs === "function"
    && typeof dependencies.provisioning.disconnect === "function"
    && typeof dependencies.provisioning.runPreflight === "function"
    && typeof dependencies.provisioning.enable === "function",
  );
}

function safeNow(dependencies: SlackBridgeRouteDependencies): Date | null {
  const now = dependencies.now?.() ?? currentDate();
  return Number.isFinite(now.getTime()) ? now : null;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function trustedAppOrigin(
  value: string,
  environment: SlackBridgeRouteDependencies["environment"],
): string | null {
  try {
    const url = new URL(value);
    if (
      url.origin !== value
      || url.username
      || url.password
      || (environment === "production" && url.protocol !== "https:")
      || (environment === "test" && url.protocol !== "https:" && url.protocol !== "http:")
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isTrustedCompletionRedirectPath(value: string | null): value is string {
  if (!value || sanitizeAppLocalReturnPath(value) !== value) return false;
  try {
    const url = new URL(value, "https://app.invalid");
    return !url.search
      && !url.hash
      && /^\/s\/[^/]+\/settings\/im-bridges$/.test(url.pathname);
  } catch {
    return false;
  }
}

function runtimeReady(
  dependencies: SlackBridgeRouteDependencies | undefined,
): dependencies is SlackBridgeRouteDependencies {
  return Boolean(
    dependencies
    && (
      dependencies.environment === "test"
      || dependencies.environment === "production"
    )
    && isHttpsUrl(dependencies.oauthRedirectUri)
    && isHttpsUrl(dependencies.eventsRequestUrl)
    && trustedAppOrigin(dependencies.appOrigin, dependencies.environment) !== null
    && typeof dependencies.isLaunchEnabled === "function"
    && typeof dependencies.resolveOAuthCompletionRedirectPath === "function"
    && typeof dependencies.leaseOAuthAppCredential === "function"
    && typeof dependencies.captureAuthorizationCode === "function"
    && typeof dependencies.exchangeOAuth === "function"
    && typeof dependencies.secretResolver?.resolveSigningSecret === "function"
    && typeof dependencies.payloadSealer?.sealNormalizedPayload === "function",
  );
}

function objectBody(req: Request): Record<string, unknown> {
  return typeof req.body === "object"
      && req.body !== null
      && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value.trim())
    ? value.trim()
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number"
      && Number.isSafeInteger(value)
      && value > 0
    ? value
    : null;
}

function queryString(value: unknown, maxLength: number): string | null {
  return typeof value === "string"
      && value.trim().length > 0
      && value.length <= maxLength
    ? value
    : null;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

function unavailable(res: Response): void {
  noStore(res);
  res.status(503).json({
    ok: false,
    code: "slack_bridge_provider_unavailable",
  });
}

function launchDisabled(res: Response): void {
  noStore(res);
  res.status(403).json({
    ok: false,
    code: "slack_bridge_disabled",
  });
}

async function launchEnabled(
  dependencies: SlackBridgeRouteDependencies,
  serverId: string,
  now: Date,
): Promise<boolean> {
  try {
    return await dependencies.isLaunchEnabled({ serverId, now });
  } catch {
    return false;
  }
}

function sendProvisioningResponse(value: unknown, res: Response): void {
  const parsed = slackBridgeProvisioningResponseSchema.safeParse(value);
  if (!parsed.success) {
    unavailable(res);
    return;
  }
  noStore(res);
  res.status(200).json(parsed.data);
}

function controlPlaneError(error: ExternalAppControlPlaneError, res: Response): void {
  const status = error.code === "external_app_not_authorized"
    ? 403
    : error.code === "external_app_install_conflict"
      || error.code === "external_app_workspace_mismatch"
      || error.code === "external_app_scope_mismatch"
      ? 409
      : error.code === "external_app_invalid_state"
        ? 400
        : 503;
  addTraceEvent("slack_bridge.provisioning.rejected", {
    code: error.code,
    ...(error.reason ? { reason: error.reason } : {}),
  });
  noStore(res);
  res.status(status).json({ ok: false, code: error.code, ...(error.reason ? { reason: error.reason } : {}),
    ...(error.code === "external_app_workspace_mismatch" ? {
      message: "You selected another Slack workspace. Reauthorize the connected workspace, or disconnect it before switching.",
    } : {}),
  });
}

async function handleProvisioningOperation(
  req: Request,
  res: Response,
  dependencies: SlackBridgeRouteDependencies | undefined,
  operation: (
    controlPlane: SlackBridgeProvisioningControlPlane,
    authority: SlackBridgeProvisioningRequestAuthority,
  ) => Promise<SlackBridgeProvisioningResponse>,
  options: { requiresLaunch?: boolean } = {},
): Promise<void> {
  if (!provisioningReady(dependencies)) {
    unavailable(res);
    return;
  }
  const now = safeNow(dependencies);
  if (!now) {
    unavailable(res);
    return;
  }
  if (!req.userId || !req.serverId) {
    noStore(res);
    res.status(400).json({ ok: false, code: "slack_bridge_provisioning_invalid" });
    return;
  }
  if (
    options.requiresLaunch !== false
    && !await launchEnabled(dependencies, req.serverId, now)
  ) {
    launchDisabled(res);
    return;
  }

  try {
    const result = await operation(dependencies.provisioning, {
      serverId: req.serverId,
      requestingUserId: req.userId,
      now,
    });
    sendProvisioningResponse(result, res);
  } catch (error) {
    if (error instanceof ExternalAppControlPlaneError) {
      controlPlaneError(error, res);
      return;
    }
    unavailable(res);
  }
}

function oauthAuthorizationUrl(input: {
  providerOAuthClientId: string;
  redirectUri: string;
  state: string;
  providerTeamId: string | null;
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.providerOAuthClientId);
  url.searchParams.set("scope", SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  if (input.providerTeamId) url.searchParams.set("team", input.providerTeamId);
  return url.toString();
}

async function fenceUnknown(attemptId: string): Promise<void> {
  try {
    await markExternalOAuthExchangeUnknown(attemptId);
  } catch {
    // The callback remains fail closed even if the diagnostic fence cannot be
    // persisted. Never retry the provider exchange from this request.
  }
}

function validManagedLease(
  lease: SlackBridgeManagedOAuthLease | null,
  input: {
    expectedProviderAppId: string;
    expectedEnvironment: "test" | "production";
    now: Date;
  },
): lease is SlackBridgeManagedOAuthLease {
  const handle = lease?.handle;
  return Boolean(
    handle
    && handle.schema === SLACK_OAUTH_APP_CREDENTIAL_HANDLE_SCHEMA
    && handle.handleId.trim()
    && handle.providerAppId === input.expectedProviderAppId
    && handle.environment === input.expectedEnvironment
    && Number.isFinite(lease?.leaseExpiresAt.getTime())
    && lease!.leaseExpiresAt > input.now,
  );
}

function validCodeHandle(handle: SlackOAuthCodeHandle, now: Date): boolean {
  return Boolean(
    handle.schema === SLACK_OAUTH_CODE_HANDLE_SCHEMA
    && handle.handleId.trim()
    && Number.isFinite(handle.expiresAt.getTime())
    && handle.expiresAt > now,
  );
}

const SLACK_PROVIDER_ERROR_PATTERN = /^[a-z0-9_]{1,64}$/;

/**
 * The callback is a browser navigation back from Slack, so every failure
 * returns the installer to the IM bridges settings page with a short code the
 * page can explain, instead of a raw JSON body. Only allowlisted codes and a
 * Slack-style error identifier ever reach the URL.
 */
function redirectOAuthOutcome(
  outcome: Exclude<SlackOAuthExchangeOutcome, { kind: "authorized" }>,
  res: Response,
  completionRedirectUri: string,
): void {
  const redirect = new URL(completionRedirectUri);
  redirect.searchParams.set("slack_oauth", "error");
  if (outcome.kind === "rate_limited" || outcome.kind === "transient_failure") {
    redirect.searchParams.set("code", "slack_oauth_retryable");
  } else if (outcome.kind === "outcome_unknown") {
    redirect.searchParams.set("code", "slack_oauth_reconciliation_required");
  } else if (outcome.kind === "identity_conflict") {
    redirect.searchParams.set("code", "slack_oauth_identity_conflict");
    redirect.searchParams.set("reason", outcome.reason);
  } else if (outcome.kind === "deterministic_failure") {
    const providerError = outcome.providerError;
    console.warn(
      "[slackBridge] oauth deterministic_failure",
      { reason: outcome.reason, providerError },
    );
    redirect.searchParams.set("code", "slack_oauth_rejected");
    redirect.searchParams.set("reason", outcome.reason);
    // The provider's own refusal stays visible for diagnosis.
    if (providerError && SLACK_PROVIDER_ERROR_PATTERN.test(providerError)) {
      redirect.searchParams.set("provider_error", providerError);
    }
  } else {
    redirect.searchParams.set("code", "slack_oauth_preflight_rejected");
  }
  noStore(res);
  res.redirect(302, redirect.toString());
}

function redirectOAuthProviderRejection(
  res: Response,
  completionRedirectUri: string | null,
): void {
  if (!completionRedirectUri) {
    noStore(res);
    res.status(400).json({ ok: false, code: "slack_oauth_provider_rejected" });
    return;
  }
  const redirect = new URL(completionRedirectUri);
  redirect.searchParams.set("slack_oauth", "error");
  redirect.searchParams.set("code", "slack_oauth_provider_rejected");
  noStore(res);
  res.redirect(302, redirect.toString());
}

function ingressError(error: ExternalAppIngressError, res: Response): void {
  const status = error.code === "external_ingress_signature_invalid"
    ? 401
    : error.code === "external_ingress_payload_invalid"
      ? 400
      : error.code === "external_ingress_authority_unavailable"
        ? 403
        : 503;
  noStore(res);
  res.status(status).json({ ok: false, code: error.code });
}

function sendIngressResponse(result: SlackEventsHttpResponse, res: Response): void {
  noStore(res);
  if (result.body.kind === "url_verification") {
    res.status(result.statusCode).json({ challenge: result.body.challenge });
    return;
  }
  // eventInboxId and internal outcome state stay on the independent canonical
  // readback sink. Slack receives only an acknowledgement.
  res.status(result.statusCode).json({ ok: true });
}

/** The Slack install's browser binding: its cookie is scoped to the registered callback path. */
function slackOAuthBinding(dependencies: { oauthRedirectUri: string }): OAuthBrowserBinding {
  return { prefix: "raft_slack_oauth", callbackPath: new URL(dependencies.oauthRedirectUri).pathname };
}

export function createSlackBridgeRouteHandlers(
  dependencies?: SlackBridgeRouteDependencies,
): SlackBridgeRouteHandlers {
  const loadProvisioning: RequestHandler = async (req, res) => {
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.load({ ...authority, includeDeliveryHealth: req.query.deliveryHealth === "1",
        includePairDeliveryHealth: req.query.pairDeliveryHealth === "1", includeWorkspaceAdminHint: req.query.workspaceAdminHint === "1",
        includeConfirmationHint: req.query.confirmationHint === "1",
        includePrivateAuthorizerHint: req.query.privateAuthorizerHint === "1", includeAttachmentSourceHealth: req.query.attachmentSourceHealth === "1",
        includeCardEditNotices: req.query.cardEditNotices === "1",
        includeInboundRecovery: req.query.inboundRecovery === "1" }));
  };

  const connectProvisioning: RequestHandler = async (req, res) => {
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.connect(authority));
  };

  const saveChannelPairs: RequestHandler = async (req, res) => {
    const parsed = slackBridgeChannelPairsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_bridge_channel_pairs_invalid" });
      return;
    }
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.saveChannelPairs({ ...authority, pairs: parsed.data.pairs }));
  };

  const removeChannelPairs: RequestHandler = async (req, res) => {
    const parsed = slackBridgeChannelPairRemovalsRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_bridge_channel_pairs_invalid" });
      return;
    }
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.removeChannelPairs({ ...authority, pairs: parsed.data.pairs }), {
        requiresLaunch: false,
      });
  };

  const disconnectProvisioning: RequestHandler = async (req, res) => {
    const parsed = slackBridgeDisconnectRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_bridge_disconnect_invalid" });
      return;
    }
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.disconnect({
        ...authority,
        expectedConnectionEpoch: parsed.data.expectedConnectionEpoch,
      }), { requiresLaunch: false });
  };

  const runPreflight: RequestHandler = async (req, res) => {
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.runPreflight(authority));
  };

  const enable: RequestHandler = async (req, res) => {
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.enable(authority));
  };

  const retryDelivery: RequestHandler = async (req, res) => {
    const body = objectBody(req);
    const bindingId = uuid(body.bindingId);
    const deliveryId = uuid(body.deliveryId);
    const bindingEpoch = positiveInteger(body.bindingEpoch);
    const expectedProviderAttempts = positiveInteger(body.expectedProviderAttempts);
    if (!expectedProviderAttempts || !bindingId || !deliveryId || !bindingEpoch || body.duplicateRiskAcknowledged !== true) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_delivery_retry_invalid" });
      return;
    }
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) => {
      if (!controlPlane.retryDelivery) throw new ExternalAppControlPlaneError("Delivery retry is unavailable", "external_app_invalid_state");
      return controlPlane.retryDelivery({ ...authority, bindingId, bindingEpoch, deliveryId, expectedProviderAttempts });
    });
  };

  const replayInbound: RequestHandler = async (req, res) => {
    const body = objectBody(req);
    const bindingId = uuid(body.bindingId);
    const bindingEpoch = positiveInteger(body.bindingEpoch);
    const eventId = uuid(body.eventId);
    const reason = typeof body.reason === "string" && /^[a-z][a-z0-9_]{0,159}$/u.test(body.reason) ? body.reason : null;
    if (!bindingId || !bindingEpoch || ("eventId" in body && !eventId) || ("reason" in body && !reason)
      || (!!eventId === !!reason)) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_inbound_replay_invalid" });
      return;
    }
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) => {
      if (!controlPlane.replayInbound) throw new ExternalAppControlPlaneError("Inbound replay is unavailable", "external_app_invalid_state");
      return controlPlane.replayInbound({ ...authority, bindingId, bindingEpoch,
        ...(eventId ? { eventId } : { reason: reason! }) });
    });
  };

  const startOAuth: RequestHandler = async (req, res) => {
    if (!runtimeReady(dependencies)) {
      unavailable(res);
      return;
    }
    const now = safeNow(dependencies);
    if (!now) {
      unavailable(res);
      return;
    }
    const body = objectBody(req);
    const registrationId = uuid(body.registrationId);
    const serverGrantId = uuid(body.serverGrantId);
    const grantEpoch = positiveInteger(body.grantEpoch);
    if (!req.userId || !req.serverId || !registrationId || !serverGrantId || !grantEpoch) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_oauth_start_invalid" });
      return;
    }
    if (!await launchEnabled(dependencies, req.serverId, now)) {
      launchDisabled(res);
      return;
    }

    try {
      const begun = await beginExternalOAuthAttempt({
        serverId: req.serverId,
        registrationId,
        serverGrantId,
        grantEpoch,
        requestingUserId: req.userId,
        redirectUri: dependencies.oauthRedirectUri,
        requestedScopes: [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES],
        grantIntent: `slack_bridge_install:${req.serverId}:${registrationId}:${grantEpoch}`,
      });
      if (begun.environment !== dependencies.environment) {
        await fenceUnknown(begun.attemptId);
        unavailable(res);
        return;
      }
      noStore(res);
      // Bind the install to this browser: only it may finish the sign-in.
      res.append("Set-Cookie", oauthBrowserBindingCookie(
        slackOAuthBinding(dependencies),
        begun.state,
        (begun.expiresAt.getTime() - now.getTime()) / 1000,
      ));
      res.status(201).json({
        authorizationUrl: oauthAuthorizationUrl({
          providerOAuthClientId: begun.providerOAuthClientId,
          redirectUri: dependencies.oauthRedirectUri,
          state: begun.state,
          providerTeamId: begun.providerTeamId,
        }),
        expiresAt: begun.expiresAt.toISOString(),
      });
    } catch (error) {
      if (error instanceof ExternalAppControlPlaneError) {
        controlPlaneError(error, res);
        return;
      }
      unavailable(res);
    }
  };

  const completeOAuth: RequestHandler = async (req, res) => {
    if (!runtimeReady(dependencies)) {
      unavailable(res);
      return;
    }
    const now = safeNow(dependencies);
    const state = queryString(req.query.state, OAUTH_STATE_MAX_LENGTH);
    // One callback per sign-in: whatever happens next, this browser's binding is spent.
    if (state) res.append("Set-Cookie", clearOAuthBrowserBindingCookie(slackOAuthBinding(dependencies), state));
    if (!now || !state) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_oauth_callback_invalid" });
      return;
    }

    let claimed: Awaited<ReturnType<typeof claimExternalOAuthAttempt>>;
    try {
      claimed = await claimExternalOAuthAttempt({
        state,
        expectedEnvironment: dependencies.environment,
        expectedRedirectUri: dependencies.oauthRedirectUri,
      });
    } catch (error) {
      if (error instanceof ExternalAppControlPlaneError) {
        controlPlaneError(error, res);
        return;
      }
      unavailable(res);
      return;
    }

    // Only the browser that started the install may finish it. Anyone else who
    // opens the authorization link would otherwise connect their workspace to
    // the starter's Server; the attempt is fenced before any provider call.
    if (!oauthCallbackIsBound(slackOAuthBinding(dependencies), req.headers.cookie, state)) {
      await fenceUnknown(claimed.attemptId);
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_oauth_callback_unbound" });
      return;
    }

    if (!await launchEnabled(dependencies, claimed.serverId, now)) {
      await fenceUnknown(claimed.attemptId);
      launchDisabled(res);
      return;
    }

    let completionRedirectPath: string | null;
    try {
      completionRedirectPath = await dependencies.resolveOAuthCompletionRedirectPath({
        serverId: claimed.serverId,
      });
    } catch {
      completionRedirectPath = null;
    }
    if (!isTrustedCompletionRedirectPath(completionRedirectPath)) {
      await fenceUnknown(claimed.attemptId);
      unavailable(res);
      return;
    }
    const completionRedirectUri = new URL(
      completionRedirectPath,
      dependencies.appOrigin,
    ).toString();

    const providerError = queryString(req.query.error, 256);
    const authorizationCode = queryString(req.query.code, OAUTH_CODE_MAX_LENGTH);
    if (providerError || !authorizationCode) {
      await fenceUnknown(claimed.attemptId);
      redirectOAuthProviderRejection(res, completionRedirectUri);
      return;
    }

    const leaseRequestedAt = safeNow(dependencies);
    if (!leaseRequestedAt) {
      await fenceUnknown(claimed.attemptId);
      unavailable(res);
      return;
    }
    let lease: SlackBridgeManagedOAuthLease | null;
    try {
      lease = await dependencies.leaseOAuthAppCredential({
        registrationId: claimed.registrationId,
        providerAppId: claimed.providerAppId,
        providerOAuthClientId: claimed.providerOAuthClientId,
        environment: claimed.environment,
        audience: OAUTH_LEASE_AUDIENCE,
        attemptId: claimed.attemptId,
        now: leaseRequestedAt,
      });
    } catch {
      lease = null;
    }
    const captureStartedAt = safeNow(dependencies);
    if (
      !captureStartedAt
      || !validManagedLease(lease, {
        expectedProviderAppId: claimed.providerAppId,
        expectedEnvironment: claimed.environment,
        now: captureStartedAt,
      })
    ) {
      await fenceUnknown(claimed.attemptId);
      unavailable(res);
      return;
    }

    let authorizationCodeHandle: SlackOAuthCodeHandle;
    try {
      authorizationCodeHandle = await dependencies.captureAuthorizationCode({
        attemptId: claimed.attemptId,
        providerOAuthClientId: claimed.providerOAuthClientId,
        authorizationCode,
        now: captureStartedAt,
      });
    } catch {
      await fenceUnknown(claimed.attemptId);
      unavailable(res);
      return;
    }
    const exchangeStartedAt = safeNow(dependencies);
    if (
      !exchangeStartedAt
      || !validManagedLease(lease, {
        expectedProviderAppId: claimed.providerAppId,
        expectedEnvironment: claimed.environment,
        now: exchangeStartedAt,
      })
      || !validCodeHandle(authorizationCodeHandle, exchangeStartedAt)
    ) {
      await fenceUnknown(claimed.attemptId);
      unavailable(res);
      return;
    }

    let outcome: SlackOAuthExchangeOutcome;
    try {
      outcome = await dependencies.exchangeOAuth({
        serverId: claimed.serverId,
        authorizationCode: authorizationCodeHandle,
        appCredential: lease.handle,
        redirectUri: dependencies.oauthRedirectUri,
        expectedProviderAppId: claimed.providerAppId,
        expectedScopes: claimed.requestedScopes,
        now: exchangeStartedAt,
      });
    } catch {
      outcome = { kind: "outcome_unknown" };
    }
    if (outcome.kind !== "authorized") {
      await fenceUnknown(claimed.attemptId);
      redirectOAuthOutcome(outcome, res, completionRedirectUri);
      return;
    }

    const extraScopes = outcome.installedScopes.filter(
      (s) => !(SLACK_BRIDGE_REQUIRED_BOT_SCOPES as readonly string[]).includes(s),
    );
    if (extraScopes.length) {
      console.warn(
        "[slackBridge] oauth authorized with extra scopes beyond contract",
        { extraScopes, serverId: claimed.serverId },
      );
    }

    try {
      await completeExternalOAuthAttempt({
        attemptId: claimed.attemptId,
        providerAppId: outcome.providerAppId,
        providerTeamId: outcome.providerTeamId,
        providerEnterpriseId: outcome.providerEnterpriseId,
        providerUserId: outcome.providerUserId,
        workspaceAdminVerified: outcome.workspaceAdminVerified === true,
        botUserId: outcome.botUserId,
        providerBotId: outcome.providerBotId,
        workspaceName: outcome.workspaceName,
        installedScopes: outcome.installedScopes,
        sealedCredential: outcome.sealedCredential,
      });
    } catch (error) {
      await fenceUnknown(claimed.attemptId);
      if (error instanceof ExternalAppControlPlaneError) {
        controlPlaneError(error, res);
        return;
      }
      unavailable(res);
      return;
    }
    // Re-authorizing a connected workspace pauses its bindings. Resume this
    // server's pairs before redirecting; a failure leaves them paused for the
    // setup wizard and must not turn a completed OAuth exchange into an error.
    const resumeAt = safeNow(dependencies);
    if (resumeAt && dependencies.provisioning?.resumeAfterReauthorization) {
      try {
        await dependencies.provisioning.resumeAfterReauthorization({
          serverId: claimed.serverId,
          requestingUserId: claimed.requestingUserId,
          now: resumeAt,
        });
      } catch (error) {
        console.warn("[slackBridge] bindings stay paused after re-authorization", {
          serverId: claimed.serverId,
          code: error instanceof ExternalAppControlPlaneError ? error.code : "unknown",
        });
      }
    }
    noStore(res);
    res.redirect(302, completionRedirectUri);
  };

  const eventsAdapter = runtimeReady(dependencies)
    ? createSlackEventsHttpAdapter({ admit: dependencies.admitSlackIngress })
    : null;
  const observeEventsArrival: RequestHandler = (req, _res, next) => {
    observeSlackIngress(
      "arrival",
      "request",
      slackIngressDeliveryObservation(req.headers),
    );
    next();
  };
  const handleEventsRawBodyError: ErrorRequestHandler = (error, req, _res, next) => {
    observeSlackIngress(
      "terminal",
      slackIngressRawBodyErrorOutcome(error),
      slackIngressDeliveryObservation(req.headers),
    );
    next(error);
  };
  const receiveEvents: RequestHandler = async (req, res) => {
    const delivery = slackIngressDeliveryObservation(req.headers);
    if (!runtimeReady(dependencies) || !eventsAdapter) {
      observeSlackIngress("terminal", "runtime_unavailable", delivery);
      unavailable(res);
      return;
    }
    if (!Buffer.isBuffer(req.body)) {
      observeSlackIngress("terminal", "raw_body_unavailable", delivery);
      unavailable(res);
      return;
    }
    try {
      const result = await eventsAdapter({
        requestUrl: dependencies.eventsRequestUrl,
        environment: dependencies.environment,
        rawBody: req.body,
        headers: req.headers,
        secretResolver: dependencies.secretResolver,
        payloadSealer: dependencies.payloadSealer,
        runtimeResolver: dependencies.runtimeResolver,
        verifiedIngressCrypto: dependencies.verifiedIngressCrypto,
        testIdentityObserver: dependencies.testIdentityObserver,
        readLifecycleMemberProfile: dependencies.readLifecycleMemberProfile,
        requestLifecycleRefresh(bindingId) {
          try { Promise.resolve(dependencies.requestLifecycleReconcile?.(bindingId))
            .catch(error => dependencies.onLifecycleError?.(error)); }
          catch (error) { dependencies.onLifecycleError?.(error); }
        },
        now: safeNow(dependencies) ?? undefined,
      });
      observeSlackIngress(
        "terminal",
        result.body.kind === "url_verification"
          ? "url_verification"
          : `event_${result.body.status}`,
        delivery,
      );
      sendIngressResponse(result, res);
    } catch (error) {
      if (error instanceof ExternalAppIngressError) {
        observeSlackIngress("terminal", error.code, delivery);
        ingressError(error, res);
        return;
      }
      observeSlackIngress("terminal", "unexpected_error", delivery);
      unavailable(res);
    }
  };

  return {
    loadProvisioning,
    connectProvisioning,
    saveChannelPairs,
    removeChannelPairs,
    disconnectProvisioning,
    runPreflight,
    enable,
    retryDelivery,
    replayInbound,
    startOAuth,
    completeOAuth,
    observeEventsArrival,
    handleEventsRawBodyError,
    receiveEvents,
  };
}
