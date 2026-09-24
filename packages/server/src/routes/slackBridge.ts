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
  setExternalAuthorPolicyState,
  type ExternalAuthorPolicyRuntimeAuthority,
} from "../services/externalAppControlPlaneService.js";
import {
  ExternalAppIngressError,
  type ExternalAppIngressErrorCode,
  type ExternalIngressPayloadSealer,
  type ExternalIngressRuntimeResolver,
  type ExternalIngressSecretResolver,
} from "../services/externalAppIngressService.js";
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
} from "../services/slackProviderAdapter.js";
import { slackBridgeIngressObservationsTotal } from "../metrics.js";
import { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../services/slackBridgeProductionAppContract.js";

export { SLACK_BRIDGE_REQUIRED_BOT_SCOPES } from "../services/slackBridgeProductionAppContract.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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
  admitSlackIngress?: SlackIngressAuthorityAdapter;
  provisioning?: SlackBridgeProvisioningControlPlane;
  resolveAuthorPolicyAuthority?(input: {
    serverId: string;
    bindingId: string;
    now: Date;
  }): Promise<ExternalAuthorPolicyRuntimeAuthority | null>;
  materializeAuthorAvatar?(policyId: string): Promise<unknown>;
  requestLifecycleReconcile?(): Promise<unknown> | void;
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
  startOAuth: RequestHandler;
  completeOAuth: RequestHandler;
  setAuthorPolicy: RequestHandler;
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
      || error.code === "external_app_scope_mismatch"
      ? 409
      : error.code === "external_app_invalid_state"
        ? 400
        : 503;
  noStore(res);
  res.status(status).json({ ok: false, code: error.code });
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
}): string {
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", input.providerOAuthClientId);
  url.searchParams.set("scope", SLACK_BRIDGE_REQUIRED_BOT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
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

function sendOAuthOutcome(
  outcome: Exclude<SlackOAuthExchangeOutcome, { kind: "authorized" }>,
  res: Response,
): void {
  noStore(res);
  if (outcome.kind === "rate_limited" || outcome.kind === "transient_failure") {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1_000))));
    res.status(503).json({ ok: false, code: "slack_oauth_retryable" });
    return;
  }
  if (outcome.kind === "outcome_unknown") {
    res.status(202).json({ ok: false, code: "slack_oauth_reconciliation_required" });
    return;
  }
  if (outcome.kind === "identity_conflict") {
    res.status(409).json({ ok: false, code: "slack_oauth_identity_conflict" });
    return;
  }
  if (outcome.kind === "deterministic_failure") {
    res.status(400).json({ ok: false, code: "slack_oauth_rejected" });
    return;
  }
  res.status(503).json({ ok: false, code: "slack_oauth_preflight_rejected" });
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

export function createSlackBridgeRouteHandlers(
  dependencies?: SlackBridgeRouteDependencies,
): SlackBridgeRouteHandlers {
  const loadProvisioning: RequestHandler = async (req, res) => {
    await handleProvisioningOperation(req, res, dependencies, (controlPlane, authority) =>
      controlPlane.load(authority));
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

  const setAuthorPolicy: RequestHandler = async (req, res) => {
    if (
      !runtimeReady(dependencies)
      || typeof dependencies.resolveAuthorPolicyAuthority !== "function"
    ) {
      unavailable(res);
      return;
    }
    const now = safeNow(dependencies);
    const body = objectBody(req);
    const bindingId = uuid(body.bindingId);
    const authorId = uuid(body.authorId);
    const authorType = body.authorType === "user" || body.authorType === "agent"
      ? body.authorType
      : null;
    const state = body.state === "granted" || body.state === "revoked"
      ? body.state
      : null;
    if (!now || !req.userId || !req.serverId || !bindingId || !authorId || !authorType || !state) {
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_author_policy_invalid" });
      return;
    }
    if (
      state === "granted"
      && !await launchEnabled(dependencies, req.serverId, now)
    ) {
      launchDisabled(res);
      return;
    }

    try {
      const authority = await dependencies.resolveAuthorPolicyAuthority({
        serverId: req.serverId,
        bindingId,
        now,
      });
      if (!authority) {
        throw new ExternalAppControlPlaneError(
          "External author policy runtime authority is unavailable",
          "external_app_not_authorized",
        );
      }
      const result = await setExternalAuthorPolicyState({
        serverId: req.serverId,
        requestingUserId: req.userId,
        authority,
        authorType,
        authorId,
        state,
      });
      if (state === "granted" && dependencies.materializeAuthorAvatar) {
        try {
          await dependencies.materializeAuthorAvatar(result.policy.id);
        } catch (error) {
          dependencies.onLifecycleError?.(error);
        }
      }
      noStore(res);
      res.status(result.created ? 201 : 200).json({
        ok: true,
        policy: {
          id: result.policy.id,
          bindingId: result.policy.bindingId,
          bindingEpoch: result.policy.bindingEpoch,
          authorType: result.policy.authorType,
          authorId: result.policy.authorId,
          displayName: result.policy.displayName,
          consentRevision: result.policy.consentRevision,
          state: result.policy.state,
        },
      });
    } catch (error) {
      if (error instanceof ExternalAppControlPlaneError) {
        controlPlaneError(error, res);
        return;
      }
      unavailable(res);
    }
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
      res.status(201).json({
        authorizationUrl: oauthAuthorizationUrl({
          providerOAuthClientId: begun.providerOAuthClientId,
          redirectUri: dependencies.oauthRedirectUri,
          state: begun.state,
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

    if (!await launchEnabled(dependencies, claimed.serverId, now)) {
      await fenceUnknown(claimed.attemptId);
      launchDisabled(res);
      return;
    }

    const providerError = queryString(req.query.error, 256);
    const authorizationCode = queryString(req.query.code, OAUTH_CODE_MAX_LENGTH);
    if (providerError || !authorizationCode) {
      await fenceUnknown(claimed.attemptId);
      noStore(res);
      res.status(400).json({ ok: false, code: "slack_oauth_provider_rejected" });
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
      sendOAuthOutcome(outcome, res);
      return;
    }

    try {
      await completeExternalOAuthAttempt({
        attemptId: claimed.attemptId,
        providerAppId: outcome.providerAppId,
        providerTeamId: outcome.providerTeamId,
        providerEnterpriseId: outcome.providerEnterpriseId,
        providerUserId: outcome.providerUserId,
        botUserId: outcome.botUserId,
        providerBotId: outcome.providerBotId,
        workspaceName: outcome.workspaceName,
        installedScopes: outcome.installedScopes,
        sealedCredential: outcome.sealedCredential,
      });
      noStore(res);
      res.redirect(302, completionRedirectUri);
    } catch (error) {
      await fenceUnknown(claimed.attemptId);
      if (error instanceof ExternalAppControlPlaneError) {
        controlPlaneError(error, res);
        return;
      }
      unavailable(res);
    }
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
      // Durable admission is the acknowledgement boundary. Lifecycle refresh
      // is best-effort after that boundary: its failure must not turn an
      // accepted Slack event into a provider retry and duplicate admission.
      if (result.body.kind === "event" && dependencies.requestLifecycleReconcile) {
        try {
          void Promise.resolve(dependencies.requestLifecycleReconcile())
            .catch((error) => dependencies.onLifecycleError?.(error));
        } catch (error) {
          dependencies.onLifecycleError?.(error);
        }
      }
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
    startOAuth,
    completeOAuth,
    setAuthorPolicy,
    observeEventsArrival,
    handleEventsRawBodyError,
    receiveEvents,
  };
}
