import { appSumoHandlers } from "./routes/appSumo";
import { ssoRouter } from "./routes/sso";
import {
  RUNTIME_AUTH_CODE_PATH,
  RUNTIME_AUTH_CONNECT_PROVIDER_PATH,
  runtimeAuthCodeBodyErrorHandler,
  runtimeAuthCodeBodyParser,
  runtimeAuthConnectProviderBodyErrorHandler,
  runtimeAuthConnectProviderBodyParser,
} from "./routes/runtimeAuthRoutes";
import express, { type Express, type Request, type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import { AGENT_CONTEXT_VIEW_RESULT_ROUTE, aiTrainingCrawlerRobotsLines } from "@botiverse/raft-shared";
import { sharedRateLimit } from "./services/sharedRateLimitStore";
import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { channelRouter } from "./routes/channels";
import { syncRouter } from "./routes/sync";
import { publicServerRouter } from "./routes/publicServer";
import { publicFeatureFlagsRouter } from "./routes/publicFeatureFlags";
import { publicClientConfigRouter } from "./routes/publicClientConfig";
import { publicSearchRouter } from "./routes/publicSearch";
import { createPublicSearchAccess, type PublicSearchServiceBucketStore, type PublicSearchServiceKeySource } from "./lib/publicSearchServiceAccess";
import {
  PUBLIC_VISITS_PATH,
  publicVisitsBodyErrorHandler,
  publicVisitsBodyParser,
  publicVisitsRouter,
} from "./routes/publicVisits";
import { countIngest } from "./services/productEventIngest";
import { SYNC_HORIZON_HEADER, SYNC_HORIZON_RESET_HEADER } from "./services/syncHorizon";
import { getPublicContentBaseUrl } from "./services/storageService";
import { STALE_RESPONSE_HEADER } from "./routes/rwStaleRead";
import { isLinkCardReadRequest, LINK_CARD_READ_PATH, linkCardReadBodyErrorHandler, linkCardReadBodyParser, messageRouter, messageV2Router } from "./routes/messages";
import {
  LINK_CARD_EXECUTE_PATH, LINK_CARD_PREPARE_PATH, LINK_CARD_STATUS_PATH, LINK_CARD_UPDATES_PATH, linkCardBodyErrorHandler, linkCardExecuteBodyParser,
  linkCardPrepareBodyParser, linkCardRouter, linkCardStatusBodyParser, linkCardUpdatesBodyParser,
} from "./routes/linkCards";
import { agentRouter, agentAvatarRouter } from "./routes/agents";
import { agentMigrationLogRouter } from "./routes/agentMigrationLog";
import { agentCredentialsHandler, listAgentCredentialsHandler, revokeAgentCredentialHandler } from "./routes/agentCredentials";
import { listManageableAgentsHandler } from "./routes/agentDiscovery";
import { internalRouter } from "./routes/internal";
import { createOpsCpuProfileRouter, type OpsCpuProfileDeps } from "./routes/opsCpuProfile";
import {
  SCOPE_ATTESTATION_PATH,
  SCOPE_ATTESTATION_REQUEST_MAX_BYTES,
  scopeAttestationBodyErrorHandler,
} from "./routes/scopeAttestationRequestLimits";
import {
  AGENT_MIGRATION_CONTROL_PATH,
  AGENT_MIGRATION_CONTROL_REQUEST_MAX_BYTES,
  agentMigrationControlBodyErrorHandler,
} from "./routes/agentMigrationControlRequestLimits";
import { authRouter, invitesRouter, secondFactorVerifyHandler } from "./routes/auth";
import { secondFactorRecoveryRouter, secondFactorRouter, signInPasskeyAssertionOptions } from "./routes/secondFactor";
import { accountDeletionCancelLinkHandler, accountDeletionRouter } from "./routes/accountDeletion";
import { externalInviteRouter, serverConnectRequestRouter } from "./routes/externalInvites";
import { agentLoginRouter } from "./routes/agentLogin";
import { deviceAuthRouter, deviceLoginRevokeHandler } from "./routes/deviceAuth";
import { appLoginRouter } from "./routes/appLogin";
import { computerAttachRouter } from "./routes/computerAttach";
import { computerRetireSessionHandler } from "./routes/computerRetireSession";
import { computerAdoptRouter } from "./routes/computerAdopt";
import { computerLegacyMachinesRouter } from "./routes/computerLegacyMachines";
import { isDeviceAuthSurfaceEnabled } from "./services/deviceAuthService";
import { internalComputerRouter } from "./routes/internalComputer";
import { firstPartyAppAgentApiLargeBodies, internalAgentApiRouter } from "./routes/internalAgentApi";
import { appBodyErrorHandler, appEnabledBeforeBody, appWebLimitAcrossReplicas, mountFirstPartyAppInternals, mountFirstPartyAppPublicApis, mountFirstPartyAppPublicPages, mountFirstPartyAppWebApis } from "./routes/firstPartyAppRoutes";
import { objectsRouter } from "./routes/objects";
import { mentionsRouter } from "./routes/mentions";
import { searchRouter } from "./routes/search";
import { agentApiErrorTrace } from "./routes/agentApiErrorTrace";
import { serverRouter } from "./routes/servers";
import { billingRouter, isBillingPreviewPath, stripeWebhookHandler } from "./routes/billing";
import { resendNewsletterWebhookHandler } from "./routes/newsletterWebhooks";
import { raftbenchRouter } from "./routes/raftbench";
import { taskRouter } from "./routes/tasks";
import { reminderRouter } from "./routes/reminders";
import { attachmentRouter, attachmentPublicRouter } from "./routes/attachments";
import { externalAvatarPublicRouter } from "./routes/externalAvatars";
import {
  attachmentUploadRateLimitedResponse,
  createAttachmentUploadSessionRouter,
  type AttachmentUploadSessionService,
} from "./routes/attachmentUploadSessions";
import { shareArtifactPublicRouter, shareArtifactRouter } from "./routes/shareArtifacts";
import { pushRouter } from "./routes/push";
import { notificationRouter } from "./routes/notifications";
import { notificationLevelsRouter } from "./routes/notificationLevels";
import { meRouter } from "./routes/me";
import { announcementRouter } from "./routes/announcements";
import { integrationInviteRouter, integrationLogoPublicRouter, integrationRouter } from "./routes/integrations";
import { appInstallationRouter } from "./routes/appInstallations";
import { actionsRouter, PRODUCT_FEEDBACK_LIMITER, QUESTION_ANSWER_LIMITER, QUESTION_ANSWER_RATE_LIMIT_PER_HOUR } from "./routes/actions";
import { ACTOR_RESOLVE_PATH, actorResolveBodyErrorHandler, actorResolveBodyParser, actorRouter } from "./routes/actors";
import { productEventsRouter } from "./routes/productEvents";
import { managedMcpOAuthCallbackRouter, managedMcpRouter } from "./routes/managedMcp";
import { agentConnectionCallbackRouter } from "./routes/agentConnectionCallback";
import { providerConnectionRouter } from "./routes/providerConnections";
import { agentRuntimeProviderRouter } from "./routes/agentRuntimeProviders";
import { runtimeProviderControlRouter } from "./routes/runtimeProviderControl";
import { productFeedbackRouter } from "./routes/productFeedback";
import { releaseNotesRouter } from "./routes/releaseNotes";
import { mobileDownloadRouter } from "./routes/mobileDownload";
import { desktopDownloadRouter } from "./routes/desktopDownload";
import { mobileAppEmailUnsubscribeRouter } from "./routes/mobileAppEmailUnsubscribe";
import { featureFlagsRouter } from "./routes/featureFlags";
import { readMutationRouter } from "./routes/readMutations";
import { oauthIdentityTokenRateLimitKey, oauthRouter, oidcDiscoveryHandler, oidcScopedMountGuard } from "./routes/oauth";
import { messageTranslationBatchHandler } from "./routes/messageTranslations";
import { otlpRelayHandler } from "./routes/otlpRelay";
import {
  createSlackBridgeRouteHandlers,
  type SlackBridgeRouteDependencies,
} from "./routes/slackBridge";
import { requireAuth, requireVerified, requireServer, requireMachineAuth, requireFlexAuth, requireServerForFlex } from "./middleware/auth";
import { authFromRegistry } from "./middleware/authFromRegistry";
import { agentContextViewForwardHandler, agentContextViewResultHandler } from "./routes/agentContextViewResult";
import { AGENT_CONTEXT_VIEW_FORWARD_ROUTE } from "./services/agentContextViewRelay";
import { createAgentContextViewRelay } from "./services/agentContextViewService";
import { perfAttributionMiddleware } from "./middleware/perfAttribution";
import { requestObservabilityMiddleware, TRACE_ID_RESPONSE_HEADER } from "./middleware/requestObservability";
import {
  forwardAdmissionTraceMiddleware,
  markForwardAdmissionStage,
} from "./tracing/messageForwardTrace";
import { withMiddlewarePhaseTrace } from "./tracing/semanticTrace";
import { raftdevActivityMiddleware } from "./middleware/raftdevActivity";
import { inboxRouteBackpressureMiddleware } from "./middleware/inboxRouteBackpressure";
import { AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV, isAgentBootstrapSurfaceEnabled } from "./services/agentCredentialService";
import { getWebCorsOriginOption, getWebCorsOrigins } from "./config/appUrl";
import { globalJsonServerErrorHandler } from "./routes/errorResponse";
import { readBuildIdentityStatus } from "./version";
import { clientIpForRateLimit } from "./lib/clientIpForRateLimit";
import { receiveAntiprotonApprovalHint } from "./routes/antiprotonApprovals";


export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 7200;
export function rateLimitUserOrIpKey(req: Pick<Request, "ip" | "userId"> & { headers?: Request["headers"] }): string {
  return req.userId || ipKeyGenerator(clientIpForRateLimit(req));
}

export function rateLimitUserMachineOrIpKey(req: Pick<Request, "ip" | "machineId" | "userId"> & { headers?: Request["headers"] }): string {
  return req.userId || req.machineId || ipKeyGenerator(clientIpForRateLimit(req));
}

export function shouldSkipAttachmentRateLimit(input: {
  isTestEnv: boolean;
  method: string;
  surface: "upload" | "download";
}): boolean {
  if (input.isTestEnv) return true;
  return input.surface === "upload" && input.method === "GET";
}

export function shouldSkipProductFeedbackRateLimit(input: {
  isSlockdev: boolean;
  isTestEnv: boolean;
  method: string;
}): boolean {
  if (input.isTestEnv || input.isSlockdev) return true;
  return input.method === "GET"
    || input.method === "HEAD"
    || input.method === "OPTIONS";
}

export function shouldSkipAuthRateLimit(input: {
  isTestEnv: boolean;
  skipInTestHarness: boolean;
  path: string;
  /** The OAuth identity endpoints' per-token limit counted this request (oauthIdentityTokenLimiter). */
  countedPerAccessToken?: boolean;
}): boolean {
  if (input.countedPerAccessToken) return true;
  if (input.path === "/invite-info" || input.path === "/accept-invite") return true;
  return input.isTestEnv && input.skipInTestHarness;
}

/** The auth limiter's requests per IP a minute; the OAuth identity endpoints' invalid tokens get the same, on their own counter. */
const AUTH_RATE_LIMIT_PER_MINUTE = 200;

/** The auth limiter's 429 body; the OAuth identity endpoints' limits answer the same. */
const AUTH_RATE_LIMITED_BODY = { error: "Too many requests, please try again later" };

/**
 * Requests per access token a minute, per replica, on the OAuth identity
 * endpoints (RFC 079 1a follow-up; Tenny, #proj-apps:769a57d4: tune after
 * launch from real hits).
 */
export const OAUTH_IDENTITY_TOKEN_RATE_LIMIT_PER_MINUTE = 600;

/** res.locals: the per-token key a request was counted by; the auth limiter then skips it. */
const OAUTH_IDENTITY_TOKEN_RATE_LIMIT_KEY = "oauthIdentityTokenRateLimitKey";

/**
 * Mounted ahead of the auth limiter on both OAuth mounts. A request for one of
 * the five Bearer identity endpoints that carries a Bearer token
 * (oauthIdentityTokenRateLimitKey) is counted here, before the token is looked
 * up, and the auth limiter then skips it: Apps call these from their own
 * backend, so all of an App's users share one IP. Two limits, in this order:
 *
 * - Invalid tokens per IP (`invalidTokensPerIp`, the auth limit's 200 a minute
 *   in production, on its own counter): every such request is counted on
 *   entry and given back once the route answers anything but 401, so a valid
 *   token never spends it, while a spray of new invalid tokens from one IP is
 *   refused here, before their lookups, once it is spent. Being checked before
 *   the lookup, a spent budget also holds back that IP's valid tokens until
 *   the window resets.
 * - Per access token (`perToken`), keyed by the token's hash; its RateLimit-*
 *   headers replace the first limit's on a request that passes both.
 *
 * Any other request passes uncounted to the auth limiter, as before. Past
 * either limit: the auth limiter's 429 body, with Retry-After and the
 * RateLimit-* headers. `enforce` false (the pglite harness unless a test sets
 * the limit): nothing is counted here, so the auth limiter counts these routes
 * per IP. `store` (the per-token limit's) is for tests.
 */
export function oauthIdentityTokenLimiter(input: {
  perToken: number;
  invalidTokensPerIp: number;
  enforce: boolean;
  validate: false | undefined;
  store?: Store;
}): RequestHandler {
  // replica-local: abuse guard only, per-replica budget is acceptable
  const invalidTokenLimiter = rateLimit({
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000, // 1 minute
    max: input.invalidTokensPerIp,
    validate: input.validate,
    standardHeaders: true,
    legacyHeaders: false,
    message: AUTH_RATE_LIMITED_BODY,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  });
  // replica-local: abuse guard only, per-replica budget is acceptable
  const tokenLimiter = rateLimit({
    keyGenerator: (_req, res) => res.locals[OAUTH_IDENTITY_TOKEN_RATE_LIMIT_KEY] as string,
    windowMs: 60 * 1000, // 1 minute
    max: input.perToken,
    validate: input.validate,
    standardHeaders: true,
    legacyHeaders: false,
    message: AUTH_RATE_LIMITED_BODY,
    ...(input.store ? { store: input.store } : {}),
  });
  return (req, res, next) => {
    const key = input.enforce ? oauthIdentityTokenRateLimitKey(req) : null;
    if (key === null) {
      next();
      return;
    }
    res.locals[OAUTH_IDENTITY_TOKEN_RATE_LIMIT_KEY] = key;
    return invalidTokenLimiter(req, res, (error?: unknown) => {
      if (error) next(error);
      else void tokenLimiter(req, res, next);
    });
  };
}

export type CreateAppOptions = Readonly<{
  testHarness?: {
    skipAuthRateLimit?: boolean;
    enforceMessageRateLimit?: boolean;
    messageRateLimitMax?: number;
    /**
     * Enforce first-party apps' web rate limits (skipped in the pglite harness
     * otherwise) at this many a minute, by `<app id>.<limit name>`; core's
     * object summaries by `objects.summaries`; core's mention audience by
     * `mentions.audience`. (Their agent API writes are core's agent write
     * budgets: __setAgentApiWriteBudgetsForTests.)
     */
    appRateLimitMax?: Readonly<Record<string, number>>;
    /** Apply the product feedback limit in the pglite harness, which otherwise skips it. */
    enforceProductFeedbackRateLimit?: boolean;
    /** Apply the per-person question-card answer limit in the pglite harness, at this many an hour (skipped otherwise). */
    questionAnswerRateLimitMax?: number;
    /**
     * Enforce the OAuth identity endpoints' limits (skipped in the pglite
     * harness otherwise): this many a minute per access token, and invalid
     * tokens per IP at `oauthIdentityInvalidTokenRateLimitMax` (default: the
     * production 200).
     */
    oauthIdentityTokenRateLimitMax?: number;
    oauthIdentityInvalidTokenRateLimitMax?: number;
    publicSearchKeySource?: PublicSearchServiceKeySource;
    publicSearchBucketStore?: PublicSearchServiceBucketStore;
    opsCpuProfile?: Partial<OpsCpuProfileDeps>;
  };
  attachmentUploadSessionService?: AttachmentUploadSessionService;
  /** The process's `service.instance.id`, named in ops CPU profile keys. */
  serviceInstanceId?: string;
  slackBridge?: SlackBridgeRouteDependencies;
}>;

// Advisory contract marker for the new v0.8 internal surfaces. It lets
// daemon/CLI clients and operator diagnostics tell "new surface exists but is
// disabled/version-mismatched" apart from legacy `/internal/*` behavior.
const INTERNAL_EXPERIMENTAL_API_VERSION = "1";

function experimentalInternalSurfaceContract(surface: "computer" | "agent-api"): RequestHandler {
  return (req, res, next) => {
    res.setHeader("Sec-Slock-Api-Version", INTERNAL_EXPERIMENTAL_API_VERSION);
    if ((process.env.SLOCK_EXPERIMENTAL_SURFACES_DISABLED ?? "").trim().toLowerCase() === "true") {
      console.warn("[experimental-surface-disabled]", {
        surface,
        path: req.originalUrl,
      });
      res.status(503).json({
        error: "Experimental internal surface is disabled",
        code: "experimental_surface_disabled",
        retry_after: null,
      });
      return;
    }
    next();
  };
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  if (options.attachmentUploadSessionService) {
    app.set("attachmentUploadSessionService", options.attachmentUploadSessionService);
  }
  // The e2e / unit harness runs the API against pglite (prod never does), which
  // is a more robust test signal than NODE_ENV: `ensureTestEnv` only sets
  // NODE_ENV=test when it's unset, so an environment that pre-sets
  // NODE_ENV=production (e.g. an agent VM) would silently miss a NODE_ENV-gated
  // branch. Gate test-only rate-limit handling on the pglite DB URL instead.
  const isTestEnv = process.env.DATABASE_URL?.startsWith("pglite") ?? false;
  // `raftdev` sets this path for its isolated local runtime. Product feedback
  // there is disposable preview data, so repeated UI review must not inherit a
  // one-hour production submission bucket. Deployed servers never set it.
  const isSlockdev = Boolean(process.env.SLOCKDEV_LAST_ACTIVITY_FILE);
  const rateLimitValidate = isTestEnv ? false : undefined;
  const slackBridgeHandlers = createSlackBridgeRouteHandlers(options.slackBridge);

  if (process.env.NODE_ENV === "production") {
    app.set("trust proxy", 1);
  }

  // Configure Helmet with CSP that allows public derived images: legacy keys are
  // served via CDN_BASE_URL and content/v2 keys via getPublicContentBaseUrl()
  // (CDN_BASE_URL too, else the deprecated PUBLIC_CONTENT_BASE_URL).
  const imgSrc = ["'self'"];
  for (const publicBaseUrl of [process.env.CDN_BASE_URL, getPublicContentBaseUrl()]) {
    if (!publicBaseUrl) continue;
    try {
      const publicHost = new URL(publicBaseUrl).origin;
      if (!imgSrc.includes(publicHost)) imgSrc.push(publicHost);
    } catch {
      // Invalid URL — skip adding to CSP
    }
  }
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "img-src": imgSrc,
      },
    },
  }));

  const corsOrigin = getWebCorsOriginOption();
  // The web app calls the API cross-origin with an Authorization header, so
  // every request needs a preflight. Without Access-Control-Max-Age Chrome
  // caches each one for 5s (per URL + method + headers): on prod a channel
  // switch sent 13 OPTIONS round trips ahead of its GETs. 7200s is Chrome's cap.
  // A cross-origin script reads only the safelisted response headers unless
  // they are exposed: the web client reads the sync horizon of /messages/sync,
  // and X-Raft-Stale / Retry-After of the unread and Activity reads to say
  // they may be out of date and to pace its retries (routes/rwStaleRead.ts),
  // and X-Trace-Id to show a reportable id on errors (#proj-o11y:#18).
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    exposedHeaders: [SYNC_HORIZON_HEADER, SYNC_HORIZON_RESET_HEADER, STALE_RESPONSE_HEADER, "Retry-After", TRACE_ID_RESPONSE_HEADER],
  }));
  // Resource Timing gives a cross-origin page only the total duration of a
  // request unless the response allows its origin: echo the request's Origin
  // when it is one of ours (the web, Raft Desktop's app://raft), never `*`, so
  // the web's view-switch and HTTP spans get queue / ttfb / download segments
  // and nobody else does (AndyLok, #triage:8c0d2318). cors() already varies on Origin.
  const timingOrigins = new Set(getWebCorsOrigins().filter((origin) => origin !== "*"));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin === "string" && timingOrigins.has(origin)) res.setHeader("Timing-Allow-Origin", origin);
    next();
  });
  app.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send([
      "# Raft API host: authenticated API surface. Only public Artifacts' Markdown versions may be fetched by crawlers (they carry noindex).",
      "# AI training crawlers may fetch nothing (shared aiTrainingCrawlers.ts).",
      ...aiTrainingCrawlerRobotsLines(),
      "User-agent: *",
      "Allow: /api/public/artifacts/",
      "Disallow: /",
      "",
    ].join("\n"));
  });

  app.post("/api/appsumo/webhook", express.raw({ type: "application/json", limit: "64kb" }), appSumoHandlers.webhook);
  // Stripe webhook must be registered BEFORE express.json() to preserve raw body for signature verification
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookHandler);
  // Resend webhook must also use the raw body because Svix signatures are payload-sensitive.
  app.post("/api/webhooks/resend", express.raw({ type: "application/json" }), resendNewsletterWebhookHandler);
  // antiproton's signed approval hints (routes/antiprotonApprovals.ts): ids
  // only, each one at most a pull; the raw body is what the signature covers.
  const antiprotonApprovalHintLimiter = rateLimit({
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTestEnv,
  });
  app.post(
    "/api/integrations/antiproton/approvals",
    antiprotonApprovalHintLimiter,
    express.raw({ type: "application/json", limit: "16kb" }),
    receiveAntiprotonApprovalHint,
  );
  app.post(
    "/api/slack-bridge/events",
    slackBridgeHandlers.observeEventsArrival,
    express.raw({ type: "application/json", limit: "1mb" }),
    slackBridgeHandlers.handleEventsRawBodyError,
    slackBridgeHandlers.receiveEvents,
  );
  // Cloudflare Workers cannot reach Fly private networking directly. This
  // endpoint is a narrow authenticated OTLP pass-through to internal Telescope.
  app.post(
    "/internal/trace-ingest/otlp/v1/traces",
    express.raw({ type: "*/*", limit: process.env.OTLP_RELAY_MAX_BYTES ?? "10mb" }),
    (req, res, next) => {
      otlpRelayHandler(req, res).catch(next);
    },
  );

  // Tighter body bound for the release-notes admin mutations: must run before
  // the global JSON parser, which would otherwise parse the request first and make a
  // router-level limit a no-op.
  app.use("/api/release-notes", express.json({ limit: "4mb" }));
  // Public Server visit beacons: unauthenticated, so parse at most 1 KB and
  // answer a bad body with the route's uniform 204 (routes/publicVisits.ts).
  app.post(PUBLIC_VISITS_PATH, publicVisitsBodyParser, publicVisitsBodyErrorHandler);
  // Route-scoped 1 MiB JSON limit for machine scope attestation (old daemons
  // send ~180 KB of now-stripped diagnostics). Machine auth runs BEFORE the
  // parser; registered ahead of the global parser, which then skips the
  // already-parsed body. The generic `/internal` auth below still runs again
  // for the route itself. No rate limit is added: the route had none.
  app.post(
    SCOPE_ATTESTATION_PATH,
    requireMachineAuth,
    express.json({ limit: SCOPE_ATTESTATION_REQUEST_MAX_BYTES }),
    scopeAttestationBodyErrorHandler,
  );
  // Same pattern for the migration control manifest (up to 512 KB): computer
  // auth first, then a route-scoped parser the global one then skips.
  app.post(
    AGENT_MIGRATION_CONTROL_PATH,
    authFromRegistry(),
    express.json({ limit: AGENT_MIGRATION_CONTROL_REQUEST_MAX_BYTES }),
    agentMigrationControlBodyErrorHandler,
  );
  // First-party apps' routes whose JSON body is over the global limit
  // (apps/firstPartyApps.ts; files sent inline): the caller's
  // auth first (the agent), then the app's client gate and the route's write
  // budget (refused: the body never read), then the app's flag for its server
  // (off: the app's refusal, the body never read), then a route-scoped parser
  // the global one then skips.
  for (const body of firstPartyAppAgentApiLargeBodies()) {
    app[body.method.toLowerCase() as "post"](
      body.path,
      authFromRegistry(),
      body.clientGate,
      ...(body.limit ? [body.limit] : []),
      appEnabledBeforeBody(body.flag, body.notEnabled),
      express.json({ limit: body.maxBytes }),
      appBodyErrorHandler(body.onBodyError),
    );
  }
  // Rate limiter for message sending (120 writes/minute/user, counted across
  // replicas); first-party apps' routes that post messages are behind it too
  // (`messageLimit`). The fleet-wide peak of a real person's writes here
  // (messages, thread replies, task writes) was 46 a minute over 7 days
  // (2026-11-08), so 60 left too little room once it is counted as written.
  const skipMessageLimit = (req: Request) => (!options.testHarness?.enforceMessageRateLimit && isTestEnv) || req.method === "GET" || isLinkCardReadRequest(req);
  const countingMessageLimiter = rateLimit({
    // Counted across replicas (SharedRateLimitStore; memory if Redis is down); a 429 names the limiter on the span.
    ...sharedRateLimit("message"),
    windowMs: 60 * 1000,
    max: options.testHarness?.messageRateLimitMax ?? 120,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many messages, please slow down" },
    // e2e seeds many messages quickly (it exercises UI, not rate-limiting). Under
    // the prod-like vite-preview e2e webServer the faster page loads burst past
    // 60/min and 429 the thread specs (dev mode's slower loads stayed under). The
    // limit is irrelevant to what e2e tests, so skip it in the pglite test
    // harness; prod (postgres) keeps the 60/min limit unchanged.
    // The link-card read is a POST but sends nothing: it has its own limiters.
    skip: skipMessageLimit,
    keyGenerator: rateLimitUserOrIpKey,
  });
  // A request the limiter counts (a shared-store round trip) records the
  // `rate_limit.message` middleware phase; a skipped one records nothing.
  const tracedMessageLimiter = withMiddlewarePhaseTrace("rate_limit.message", countingMessageLimiter);
  const messageLimiter: RequestHandler = (req, res, next) =>
    (skipMessageLimit(req) ? countingMessageLimiter : tracedMessageLimiter)(req, res, next);

  const firstPartyAppWeb = mountFirstPartyAppWebApis((key, limit) => {
    const max = options.testHarness?.appRateLimitMax?.[key];
    // Skipped in the pglite harness (shared by Playwright shards) unless a test sets the limit.
    const skip = () => isTestEnv && max === undefined;
    // A person's writes (Artifacts' `write`, `commentImages`): one count across replicas.
    if (limit.acrossReplicas) return appWebLimitAcrossReplicas(key, max ?? limit.perMinute, limit.message, rateLimitUserOrIpKey, skip);
    // replica-local: abuse guard only, per-replica budget is acceptable
    return rateLimit({
      windowMs: 60 * 1000,
      max: max ?? limit.perMinute,
      validate: rateLimitValidate,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: limit.message, code: "RATE_LIMITED" },
      keyGenerator: rateLimitUserOrIpKey,
      skip,
    });
  }, messageLimiter, [requireAuth, requireVerified]);
  // task #17: the runtime login code route parses its own small body, so a
  // malformed one is answered without the parser's error text (it can quote
  // the body, and the body is a one-time code).
  app.post(RUNTIME_AUTH_CODE_PATH, runtimeAuthCodeBodyParser, runtimeAuthCodeBodyErrorHandler);
  // So does the Qwen provider connect route: its body is a provider's API key.
  app.post(RUNTIME_AUTH_CONNECT_PROVIDER_PATH, runtimeAuthConnectProviderBodyParser, runtimeAuthConnectProviderBodyErrorHandler);
  // The batched link-card read refuses a body over its own bound before parsing
  // it (Tenny, RFC 076 §6.1); the global parser then skips the parsed body.
  app.post(LINK_CARD_READ_PATH, linkCardReadBodyParser, linkCardReadBodyErrorHandler);
  // The batched actor resolve read is bounded the same way (routes/actors.ts).
  app.post(ACTOR_RESOLVE_PATH, actorResolveBodyParser, actorResolveBodyErrorHandler);
  // So do the link-card actions and status (RFC 076 §6.2-§6.4), and the App's
  // terminal update (§6.5), kept as raw bytes for the strict parser (the
  // /api/oauth form parser then skips it too).
  app.post(LINK_CARD_PREPARE_PATH, linkCardPrepareBodyParser, linkCardBodyErrorHandler);
  app.post(LINK_CARD_EXECUTE_PATH, linkCardExecuteBodyParser, linkCardBodyErrorHandler);
  app.post(LINK_CARD_STATUS_PATH, linkCardStatusBodyParser, linkCardBodyErrorHandler);
  app.post(LINK_CARD_UPDATES_PATH, linkCardUpdatesBodyParser, linkCardBodyErrorHandler);
  // View Context: the daemon's result POST and its hop to the viewer's
  // replica stream the raw body through (agentContextViewRelay.ts); no parser
  // may read it first, so both are registered before the global one.
  app.set("agentContextViewRelay", createAgentContextViewRelay());
  app.post(
    AGENT_CONTEXT_VIEW_RESULT_ROUTE,
    experimentalInternalSurfaceContract("computer"),
    authFromRegistry(),
    agentContextViewResultHandler,
  );
  app.post(AGENT_CONTEXT_VIEW_FORWARD_ROUTE, agentContextViewForwardHandler);
  app.use(express.json());
  // Default freshness policy for the whole authenticated API surface (human
  // /api and agent /internal alike): per-user JSON with no explicit policy is
  // storable by any HTTP cache and may be served with heuristic freshness —
  // observed in prod (2026-09-21) as a stale /channels/inbox body replayed by
  // an intermediate cache. Cacheable-by-design responses (immutable
  // attachments, release notes, share artifacts) override this by setting
  // their own Cache-Control in the route.
  app.use(["/api", "/internal"], (_req, res, next) => {
    res.setHeader("Cache-Control", "private, no-store");
    next();
  });
  app.use(raftdevActivityMiddleware);
  app.use(requestObservabilityMiddleware);
  app.use(perfAttributionMiddleware);

  // Public-unlisted share pages made by the retired Share to X: existing links
  // answer 410 "no longer available" while SHARE_ARTIFACTS_RETIRED is on
  // (docs/contracts/share-artifacts.md).
  app.use("/share", shareArtifactPublicRouter);

  // Rate limiter for auth endpoints (general)
  const authLimiter = rateLimit({
    // replica-local for now: keyed by IP, and spans carry no client IP to
    // check a shared budget against (many Computers or an office behind one
    // address). Moves to sharedRateLimit once that can be measured.
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000, // 1 minute
    max: AUTH_RATE_LIMIT_PER_MINUTE,
    standardHeaders: true,
    legacyHeaders: false,
    message: AUTH_RATE_LIMITED_BODY,
    // Invite join flow can legitimately burst from one IP (e.g. admin onboarding multiple users).
    // Keep auth brute-force protection strict for login/register/etc, but exclude invite routes.
    // Playwright explicitly opts out because every shard shares one pglite API
    // process and IP bucket; production cannot take this branch, even if the
    // test-harness option is accidentally passed there.
    // The OAuth identity endpoints' requests counted per access token
    // (oauthIdentityLimiter, below) are not counted again here.
    skip: (req, res) => shouldSkipAuthRateLimit({
      isTestEnv,
      skipInTestHarness: options.testHarness?.skipAuthRateLimit ?? false,
      path: req.path,
      countedPerAccessToken: typeof res.locals[OAUTH_IDENTITY_TOKEN_RATE_LIMIT_KEY] === "string",
    }),
  });

  // The OAuth identity endpoints' limits, ahead of authLimiter on both OAuth
  // mounts: per access token, and invalid tokens per IP. Skipped in the
  // pglite harness unless a test sets the per-token limit; authLimiter then
  // counts those routes per IP, as before.
  const oauthIdentityTokenRateLimitMax = options.testHarness?.oauthIdentityTokenRateLimitMax;
  const oauthIdentityLimiter = oauthIdentityTokenLimiter({
    perToken: oauthIdentityTokenRateLimitMax ?? OAUTH_IDENTITY_TOKEN_RATE_LIMIT_PER_MINUTE,
    invalidTokensPerIp: options.testHarness?.oauthIdentityInvalidTokenRateLimitMax ?? AUTH_RATE_LIMIT_PER_MINUTE,
    enforce: !isTestEnv || oauthIdentityTokenRateLimitMax !== undefined,
    validate: rateLimitValidate,
  });

  // Separate (more lenient) limiter for join-link invite flow endpoints.
  const inviteFlowLimiter = rateLimit({
    // replica-local for now: keyed by IP, and spans carry no client IP to
    // check a shared budget against (many Computers or an office behind one
    // address). Moves to sharedRateLimit once that can be measured.
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many invite requests, please try again in a minute" },
  });

  // Stricter rate limiter for forgot-password (5 requests/hour/IP)
  const forgotPasswordLimiter = rateLimit({
    // Counted across replicas (SharedRateLimitStore; memory if Redis is down); a 429 names the limiter on the span.
    ...sharedRateLimit("forgot-password"),
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many password reset requests. Please try again later." },
  });

  // Starting a two-step verification recovery by email (PR 6): per address,
  // like forgot-password; the answer is the same for every email, so a 429
  // here says nothing about any account. Per person: services/secondFactor/recovery.ts.
  const secondFactorRecoveryStartLimiter = rateLimit({
    // Counted across replicas (SharedRateLimitStore; memory if Redis is down); a 429 names the limiter on the span.
    ...sharedRateLimit("second-factor-recovery"),
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method !== "POST" || req.path !== "/",
    message: { error: "Too many requests. Please try again later.", code: "rate_limited" },
  });

  // Auth routes (rate limited, no auth required)
  // Apply stricter limiter specifically to forgot-password before the general auth limiter
  app.use("/api/auth/forgot-password", forgotPasswordLimiter);
  app.use("/api/auth/invite-info", inviteFlowLimiter);
  app.use("/api/auth/accept-invite", inviteFlowLimiter);
  // task #30 PR-A2 (RFC v0.8 contract v3 §3): shared device-code login
  // grant. Mounted BEFORE the generic `/api/auth` router so the device
  // sub-paths take precedence. OUT of `routeAuthPolicy` BY DESIGN — `/api/*`
  // pre-credential surface, not a claimed `/internal/*` principal surface
  // (documented intentional, mirrors `/api/agent/login`). Default-on after
  // PR-G; operators set `SLOCK_DEVICE_LOGIN_ENABLED=false` as emergency
  // kill switch only.
  // App login handoff (HarmonyOS web login): app → web login → one-time
  // code back to the app. Same pre-credential, rate-limited shape as the
  // device grant; mounted before the generic `/api/auth` router.
  app.use("/api/auth/app-login", authLimiter, appLoginRouter);
  // A device login's revoke link (mailed on approval) works even with the
  // device surface switched off: a link already in someone's inbox must
  // still sign that program out.
  app.post("/api/auth/device/revoke", authLimiter, deviceLoginRevokeHandler);
  // The one-time link in the "scheduled for deletion" email: cancels that
  // request without signing in (routes/accountDeletion.ts).
  app.post("/api/auth/account-deletion/cancel", authLimiter, accountDeletionCancelLinkHandler);
  // A Computer with its own key retiring the device session it logged in
  // with (device-auth design v2 §4 step 2): ending a session is allowed with
  // the device surface switched off too.
  app.post("/api/computer/retire-session", authLimiter, computerRetireSessionHandler);
  if (isDeviceAuthSurfaceEnabled()) {
    app.use("/api/auth/device", authLimiter, deviceAuthRouter);
    // task #30 PR-B 3/n: user-authed Computer attach. Same Computer-login
    // feature gate (login + attach ship together). OUT of routeAuthPolicy
    // BY DESIGN (/api/* user-authed pre-attach, not /internal/* principal
    // surface; documented intentional, mirrors /api/agent/login).
    app.use("/api/computer", authLimiter, computerAttachRouter);
    // task #39 PR-J1: legacy machine → Computer adoption (RFC v8.2 §5.11).
    // Same Computer-login feature gate — adoption is the migration path FROM
    // legacy sk_machine_* INTO the sk_computer_* control plane this gate
    // governs, so it lives behind the same flag.
    app.use("/api/computer", authLimiter, computerAdoptRouter);
    // RFC v9.9 §X.2: legacy daemon roster for the migration setup picker.
    // Same Computer-login feature gate — the picker is the UX entry point
    // for the same adoption flow `/api/computer/adopt-legacy` serves.
    app.use("/api/computer", authLimiter, computerLegacyMachinesRouter);
  } else {
    console.warn("[device-login-disabled] SLOCK_DEVICE_LOGIN_ENABLED is explicitly off — Computer attach + device authorize are disabled");
  }
  // The second step of a password or social sign-in (design v8 §3, PR 3):
  // unauthenticated, rate-limited like /login. Ahead of the management
  // router below, which requires a session for everything under it.
  app.post("/api/auth/second-factor/verify", authLimiter, secondFactorVerifyHandler);
  // Its passkey options (PR 4a): `{ challenge }` (a sign-in's) is answered
  // here without a session; without one it falls through to the signed-in
  // route of the same path in the router below.
  app.use("/api/auth/second-factor/passkeys/assertion/options", signInPasskeyAssertionOptions(authLimiter));
  // Email recovery of two-step verification (PR 6): POST /, /confirm and
  // /cancel without a session; GET and DELETE fall through to the signed-in
  // routes of the router below.
  app.use("/api/auth/second-factor/recovery", authLimiter, secondFactorRecoveryStartLimiter, secondFactorRecoveryRouter);
  // A person managing their own two-step verification (design v8, PR 2) and
  // stepping up a session (PR 3). Mounted before the generic `/api/auth` router; one
  // authLimiter, like the device and app-login sub-paths.
  app.use("/api/auth/second-factor", authLimiter, secondFactorRouter);
  // SSO sign-in (rfcs/083-server-sso.md §5): ahead of authRouter, whose /:provider/start would see "sso".
  app.use("/api/auth/sso", authLimiter, ssoRouter);
  app.use("/api/auth", authLimiter, authRouter);
  app.get("/api/appsumo/oauth/callback", authLimiter, appSumoHandlers.callback);
  app.get("/api/appsumo/redemption", authLimiter, requireAuth, requireVerified, appSumoHandlers.status);
  app.post("/api/appsumo/redemption/bind", authLimiter, requireAuth, requireVerified, appSumoHandlers.bind);
  app.use("/api/invites", inviteFlowLimiter, authLimiter, invitesRouter);
  // The invitee's side of an external channel invite (#wg-rbac:#16): by token, before they are a member.
  app.use("/api/external-invites", inviteFlowLimiter, authLimiter, externalInviteRouter);
  // An owner/admin approving another member's request to connect their server to an external channel (P2a-3).
  app.use("/api/server-connect-requests", inviteFlowLimiter, authLimiter, serverConnectRequestRouter);
  app.get("/.well-known/openid-configuration", authLimiter, oidcDiscoveryHandler);
  app.use("/api/oauth", oauthIdentityLimiter, authLimiter, express.urlencoded({ extended: false }), oauthRouter);
  // Server-scoped OIDC (task #150): clients that reject query components cannot
  // carry `?server=`, so the server rides in the path and the whole endpoint
  // family is mounted a second time beneath it. The unscoped mounts above stay
  // live for existing integrations; retiring them is a separate cutover.
  app.get("/oidc/:server/.well-known/openid-configuration", authLimiter, oidcDiscoveryHandler);
  app.use("/oidc/:server/api/oauth", oauthIdentityLimiter, authLimiter, oidcScopedMountGuard, express.urlencoded({ extended: false }), oauthRouter);
  app.post(
    "/api/slack-bridge/oauth/start",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.startOAuth,
  );
  app.get(
    "/api/slack-bridge/provisioning",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.loadProvisioning,
  );
  app.post(
    "/api/slack-bridge/provisioning/connect",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.connectProvisioning,
  );
  app.put(
    "/api/slack-bridge/provisioning/channel-pairs",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.saveChannelPairs,
  );
  app.delete(
    "/api/slack-bridge/provisioning/channel-pairs",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.removeChannelPairs,
  );
  app.post(
    "/api/slack-bridge/provisioning/disconnect",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.disconnectProvisioning,
  );
  app.post(
    "/api/slack-bridge/provisioning/preflight",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.runPreflight,
  );
  app.post(
    "/api/slack-bridge/provisioning/enable",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.enable,
  );
  app.post(
    "/api/slack-bridge/provisioning/retry-delivery",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.retryDelivery,
  );
  app.post(
    "/api/slack-bridge/provisioning/replay-inbound",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.replayInbound,
  );
  app.get(
    "/api/slack-bridge/oauth/callback",
    authLimiter,
    slackBridgeHandlers.completeOAuth,
  );
  app.use("/api/app-installation", authLimiter, appInstallationRouter);
  // `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`:
  // self-hosted bootstrap primitive. The code path stays testable, but the
  // external login/onboarding surface is not published in this PR. Production
  // must explicitly opt in before `/api/agent/login` is mounted; managed-runner
  // launch uses `/internal/computer/*` instead.
  if (isAgentBootstrapSurfaceEnabled()) {
    console.warn(`[self-hosted-runner-bootstrap-enabled] ${AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV}=true`);
    app.use("/api/agent", authLimiter, agentLoginRouter);
  }
  app.use("/api/push", pushRouter);
  app.use("/api/notifications", notificationRouter);
  app.use("/api/announcements", announcementRouter);
  app.get("/api/version", (_req, res) => {
    const status = readBuildIdentityStatus();
    if (!status.ok) {
      res.status(503).json({
        error: "Build identity unavailable",
        code: status.code,
        detail: status.reason,
        ...status.identity,
      });
      return;
    }
    res.json(status.identity);
  });

  // Ops-only CPU profile capture (docs/operations/server-cpu-profile.md).
  // Holds the request for the capture (at most 60s), well inside the server's
  // default 300s requestTimeout and the ALB's 300s idle timeout. Refusals
  // fall through to the JSON 404 below.
  app.use("/api/ops", createOpsCpuProfileRouter({
    serviceInstanceId: options.serviceInstanceId,
    ...options.testHarness?.opsCpuProfile,
  }));

  // Server routes (auth + verified required, no server context needed)
  app.use("/api/servers", requireAuth, requireVerified, serverRouter);
  // A person deleting their own account (routes/accountDeletion.ts). Ahead of
  // /api/me and without requireVerified: any account may be deleted, and a
  // person whose deletion is scheduled reaches only GET / DELETE here
  // (requireAuth). Rate-limited like the other re-authentication routes.
  app.use("/api/me/account/deletion", authLimiter, requireAuth, accountDeletionRouter);
  // Unified notification settings (docs/contracts/notifications.md §2) and
  // the person's account-mode app logins (docs/raft-app/README.md).
  app.use("/api/me", requireAuth, requireVerified, meRouter);
  app.use("/api/notification-levels", requireAuth, requireVerified, notificationLevelsRouter);
  app.use("/api/feature-flags", requireAuth, requireVerified, featureFlagsRouter);

  const productFeedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    // `code` for the dialog's readers; `errorCode` too, as every other refusal of
    // /api/actions/:messageId/execute (a feedback card's form submit runs this
    // limiter, routes/actions.ts), so one field serves both paths (Tenny, L3).
    message: { error: "Too many feedback submissions. Please try again later.", code: "feedback_rate_limited", errorCode: "feedback_rate_limited" },
    keyGenerator: rateLimitUserOrIpKey,
    skip: (req) => shouldSkipProductFeedbackRateLimit({
      isSlockdev,
      isTestEnv: isTestEnv && !options.testHarness?.enforceProductFeedbackRateLimit,
      method: req.method,
    }),
  });
  // A feedback card's form submit (POST /api/actions/:messageId/execute) runs
  // this same instance, so the dialog and the form share one budget.
  app.set(PRODUCT_FEEDBACK_LIMITER, productFeedbackLimiter);
  // A question card's answer (POST /api/actions/:messageId/execute with its
  // form) per person, run before execute (routes/actions.ts).
  app.set(QUESTION_ANSWER_LIMITER, rateLimit({
    windowMs: 60 * 60 * 1000,
    max: options.testHarness?.questionAnswerRateLimitMax ?? QUESTION_ANSWER_RATE_LIMIT_PER_HOUR,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many answers to question cards. Please try again later.", code: "question_answers_rate_limited", errorCode: "question_answers_rate_limited" },
    keyGenerator: rateLimitUserOrIpKey,
    skip: () => isTestEnv && options.testHarness?.questionAnswerRateLimitMax === undefined,
  }));
  // Public by design: the desktop Settings surface shows a QR code, and the
  // phone scanning it has no session. Requiring auth would land every scan on a
  // login wall. Artifacts behind it are public app builds.
  app.use("/api/mobile-download", authLimiter, mobileDownloadRouter);
  // Same reason: the /download page is anonymous. Public desktop-beta builds.
  app.use("/api/desktop-download", authLimiter, desktopDownloadRouter);
  app.use("/api/email/mobile-app", authLimiter, mobileAppEmailUnsubscribeRouter);
  // Global product release notes: public read of published revisions (anonymous
  // projection). Writes no longer go through the server API; the Release App
  // maintains release notes via direct database access (see
  // services/releaseNotesMutation.ts for the shared mutation primitive).
  app.use("/api/release-notes", authLimiter, releaseNotesRouter);
  app.use("/api/product-feedback", requireAuth, requireVerified, productFeedbackLimiter, productFeedbackRouter);

  // Rate limiter for billing mutation endpoints (checkout/portal create Stripe sessions)
  const billingLimiter = rateLimit({
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many billing requests, please try again later" },
    // Allow reads (subscription info); seat price previews have their own budget below.
    skip: (req) => req.method === "GET" || isBillingPreviewPath(req.path),
  });
  // A seat price preview only asks Stripe for an estimate (no session, no
  // charge), and the add-seats dialog asks again each time the owner changes
  // the count, so it gets a larger budget than the mutations.
  const billingPreviewLimiter = rateLimit({
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000, // 1 minute
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many billing requests, please try again later" },
    skip: (req) => req.method === "GET" || !isBillingPreviewPath(req.path),
  });

  // Rate limiter for file uploads (10 uploads/minute/IP to prevent abuse).
  // This covers both human `/api/attachments/upload` and agent `/internal/.../upload`.
  const uploadLimiter = rateLimit({
    // replica-local for now: keyed by IP, and spans carry no client IP to
    // check a shared budget against (many Computers or an office behind one
    // address). Moves to sharedRateLimit once that can be measured.
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000, // 1 minute
    max: 10,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many uploads, please try again later" },
    // Playwright shards share one pglite server and seed with the same owner.
    // A finite in-memory bucket therefore measures suite order, not product
    // behavior. Production (postgres) keeps the 10/min mutation limit.
    skip: (req) => shouldSkipAttachmentRateLimit({ isTestEnv, method: req.method, surface: "upload" }),
  });

  const directUploadLimiter = rateLimit({
    // Counted across replicas (SharedRateLimitStore; memory if Redis is down); a 429 names the limiter on the span.
    ...sharedRateLimit("direct-upload"),
    windowMs: 60 * 1000,
    max: 10,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: attachmentUploadRateLimitedResponse,
    keyGenerator: (req) => req.userId || req.actingAgentId || ipKeyGenerator(clientIpForRateLimit(req)),
    skip: () => isTestEnv,
  });
  app.set("attachmentUploadSessionCreateLimiter", directUploadLimiter);

  // Keep capability discovery registered even when durable direct uploads are
  // unavailable, so narrow upload-session paths never fall through to the broad
  // legacy attachment download route.
  app.use(
    "/api/attachments",
    createAttachmentUploadSessionRouter(options.attachmentUploadSessionService ?? null, {
      securityMiddleware: [requireAuth, requireVerified, requireServer],
      createLimiter: directUploadLimiter,
    }),
  );

  // Attachment serving — requires auth + rate limited
  const downloadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many download requests, please try again later" },
    // Attachment-heavy Playwright shards can legitimately exceed 120 reads
    // while exercising unrelated UI contracts. Keep the production limiter
    // unchanged and isolate only the pglite test harness from its shared bucket.
    skip: (req) => shouldSkipAttachmentRateLimit({ isTestEnv, method: req.method, surface: "download" }),
    keyGenerator: rateLimitUserMachineOrIpKey,
  });
  app.use("/api/attachments", requireFlexAuth, requireServerForFlex, downloadLimiter, attachmentPublicRouter);
  // Intentionally unauthenticated static-asset fallback for local dev.
  // Production serves avatars directly from the CDN (`CDN_BASE_URL`) which
  // is also public. URLs are capability-based (`/avatars/:namespace/:hash.webp`
  // where `:hash` is 32 hex chars of sha256(content)) — membership is the
  // only thing that reveals the URL in the first place. This is a documented
  // exception to the X-Server-Id contract added in #proj-security task #10.
  app.use("/api/avatars", agentAvatarRouter);
  app.use("/api/external-avatars", externalAvatarPublicRouter);
  app.use("/api/integration-logos", integrationLogoPublicRouter);

  const translationLimiter = rateLimit({
    // replica-local for now: no traffic on this route in the last 7 days to
    // check a shared budget against.
    windowMs: 60 * 1000,
    max: 120,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many translation requests, please slow down" },
    keyGenerator: rateLimitUserOrIpKey,
  });

  // Public translation can invoke the provider without a principal. Keep a
  // separate IP-only bucket so signing in cannot multiply the public allowance.
  // A quarter of the member endpoint's budget (Tenny, 2026-11-08): a logged-out
  // reader translating a page stays well under it.
  const publicTranslationLimiter = rateLimit({
    // Counted across replicas (SharedRateLimitStore; memory if Redis is down); a 429 names the limiter on the span.
    ...sharedRateLimit("public-translation"),
    windowMs: 60 * 1000,
    max: 30,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many public translation requests, please slow down" },
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
  });

  // Public attachment bytes are fetched without a principal, one request per
  // image on a public page. Keep a separate IP-only bucket sized like the
  // member download limiter so anonymous reads cannot borrow other budgets.
  const publicAttachmentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many public attachment requests, please slow down" },
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
  });

  // Resource routes (auth + verified + server required)
  app.post(/^\/api\/message-translations:batch$/, requireAuth, requireVerified, requireServer, translationLimiter, messageTranslationBatchHandler);
  app.post(/^\/api\/public\/servers\/[^/]+\/message-translations:batch$/, publicTranslationLimiter);
  app.get(/^\/api\/public\/servers\/[^/]+\/attachments\/[^/]+$/, publicAttachmentLimiter);
  // Authenticate the JWT without DB work, then admit Inbox requests before
  // verified-profile, server-membership, policy, and serving-row queries. This
  // bounds all PostgreSQL work caused by one authenticated Inbox request, not
  // only the final serving query inside the route handler.
  // Task #70: the ONLY unauthenticated read surface for server content.
  // No router-wide requireAuth/requireVerified/requireServer on purpose — its GETs
  // serve logged-out visitors. Task #74's one membership write attaches auth and
  // verification on that route itself; see routes/publicServer.ts.
  // Public server SEO: the read-only search API raft.build renders from. A
  // narrower predicate than the guest view (owner search switch + indexing
  // master switch); see routes/publicSearch.ts. Mounted before /api/public so
  // the guest router never sees these paths.
  // Every service-scheme request is limited per client IP before its key
  // lookup (task #4), so forged credentials cannot drive unbounded reads of
  // the key table. Above the shared service bucket, so it never binds first
  // for genuine raft.build traffic spread over Cloudflare egress addresses.
  const publicSearchVerifyLimiter = rateLimit({
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
  });
  // Anonymous callers keep the per-IP authLimiter; raft.build's service
  // credential gets its own finite bucket instead (lib/publicSearchServiceAccess.ts).
  app.use("/api/public/search", createPublicSearchAccess({
    anonymousLimiter: authLimiter,
    verifyLimiter: publicSearchVerifyLimiter,
    // Test harnesses inject these explicitly; production never falls back to
    // a process-local bucket or an unchecked key source.
    ...(options.testHarness?.publicSearchKeySource ? { keySource: options.testHarness.publicSearchKeySource } : {}),
    ...(options.testHarness?.publicSearchBucketStore ? { bucketStore: options.testHarness.publicSearchBucketStore } : {}),
  }), publicSearchRouter);
  // Before-login feature flags (task #205): pre_auth_evaluable flags only, no credentials read.
  app.use("/api/public/feature-flags", authLimiter, publicFeatureFlagsRouter);
  // Per-deploy client config (Raft's app hosts): no credentials read, the same answer for everyone.
  app.use("/api/public/client-config", authLimiter, publicClientConfigRouter);
  // First-party apps' signed-out routes (apps/firstPartyApps.ts), each at
  // /api/public/<id>, before /api/public so the guest router never sees them
  // and they don't spend its authLimiter budget: no auth, no credential read,
  // each route behind its own per-client-address limit (the
  // publicAttachmentLimiter pattern; routes/firstPartyAppRoutes.ts).
  // replica-local: abuse guard only, per-replica budget is acceptable
  const appPublicRateLimit = (key: string, limit: { perMinute: number; message: string }) => {
    const max = options.testHarness?.appRateLimitMax?.[key];
    return rateLimit({
      windowMs: 60 * 1000,
      max: max ?? limit.perMinute,
      validate: rateLimitValidate,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: limit.message, code: "RATE_LIMITED" },
      keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
      // Skipped in the pglite harness (shared by Playwright shards, one address) unless a test sets the limit.
      skip: () => isTestEnv && max === undefined,
    });
  };
  for (const { path, router } of mountFirstPartyAppPublicApis(appPublicRateLimit)) {
    app.use(path, router);
  }
  // First-party apps' signed-out pages (the public Artifact page at
  // /artifacts/*, which app.raft.build's CloudFront sends here): each at
  // /<id>, answering only requests that carry the app edge marker, a plain
  // 404 to the rest (routes/firstPartyAppRoutes.ts), each behind its own
  // per-client-address limit as above.
  for (const { path, router } of mountFirstPartyAppPublicPages(appPublicRateLimit)) {
    app.use(path, router);
  }
  app.use("/api/public", authLimiter, publicServerRouter);
  // Count-only visit beacons from public server pages: unauthenticated, always
  // 204 (routes/publicVisits.ts). Outside authLimiter so visits do not spend
  // the public read budget. replica-local: per-task budget (20/min/IP, Tenny
  // 2026-10-14); the per-server daily cap is shared in Redis. The key is the
  // visitor address only once TRUST_CLOUDFRONT_VIEWER_HEADERS is on (until then
  // the CloudFront edge); never parse forwarding headers here.
  const publicVisitsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 20,
    validate: rateLimitValidate,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIpForRateLimit(req)),
    // 204 like every other outcome there; the metric is the only trace.
    handler: (_req, res) => {
      countIngest("public_visit_rate_limited", 1);
      res.set("Cache-Control", "no-store");
      res.status(204).end();
    },
    skip: () => isTestEnv,
  });
  app.use("/api/public-visits", publicVisitsLimiter, publicVisitsRouter);

  // Creating a thread with its first reply (POST /api/channels/:id/threads)
  // posts a message: it spends the same message budget as /api/messages.
  const threadReplyLimiter: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && /^\/[^/]+\/threads\/?$/.test(req.path)) {
      return messageLimiter(req, res, next);
    }
    return next();
  };
  app.use(
    "/api/channels",
    inboxRouteBackpressureMiddleware,
    requireAuth,
    requireVerified,
    requireServer,
    threadReplyLimiter,
    channelRouter,
  );
  app.use("/api/sync", requireAuth, requireVerified, requireServer, syncRouter);
  app.use("/api/read-mutations", requireAuth, requireVerified, requireServer, readMutationRouter);
  app.use(
    "/api/messages",
    forwardAdmissionTraceMiddleware,
    requireAuth,
    markForwardAdmissionStage("verified"),
    requireVerified,
    markForwardAdmissionStage("server"),
    requireServer,
    markForwardAdmissionStage("limiter"),
    messageLimiter,
    markForwardAdmissionStage("handler"),
    messageRouter,
  );
  app.use("/api/v2/messages", requireAuth, requireVerified, requireServer, messageLimiter, messageV2Router);
  // Mount the agent CLI resource-explicit surfaces BEFORE the generic
  // agentRouter so Express's first-match wins and we skip `requireServer`.
  // These routes derive server context from the subject (agent row /
  // user's memberships); requiring `X-Server-Id` would force CLI callers
  // like `slock agent login` / `slock agent list` to know a serverId
  // out-of-band, which defeats the agent-facing UX. §3 invariant: CLI
  // resource-explicit surfaces never use the web active-server header.
  // See `#proj-runtime:3d515727` (XX msg=dc316ca3 / Hao msg=b50c93bd).
  app.get("/api/agents/manageable", requireAuth, requireVerified, listManageableAgentsHandler);
  app.post("/api/agents/:id/credentials", requireAuth, requireVerified, agentCredentialsHandler);
  app.get("/api/agents/:id/credentials", requireAuth, requireVerified, listAgentCredentialsHandler);
  app.delete("/api/agents/:id/credentials/:credentialId", requireAuth, requireVerified, revokeAgentCredentialHandler);
  app.use("/api/raftbench", requireAuth, requireVerified, requireServer, raftbenchRouter);
  app.use("/api/agents", requireAuth, requireVerified, requireServer, agentRouter);
  app.use("/api/agent-migrations", requireAuth, requireVerified, requireServer, agentMigrationLogRouter);
  app.use("/api/billing", requireAuth, requireVerified, requireServer, billingLimiter, billingPreviewLimiter, billingRouter);
  // Task writes post messages (a created task's system message, claim and
  // status notices) and wake agents: they spend the message budget too. The
  // limiter skips GETs, so reading the board is not counted.
  app.use("/api/tasks", requireAuth, requireVerified, requireServer, messageLimiter, taskRouter);
  app.use("/api/reminders", requireAuth, requireVerified, requireServer, reminderRouter);
  // Attachment-comment creation is MESSAGE-shaped traffic, not an upload:
  // it must ride the message limiter (120/min/user, skipped in the pglite
  // harness), not the 10/min/IP upload limiter — otherwise a review session
  // hits 429 after ten comments (surfaced by the task #15 anchor tests).
  const attachmentWriteLimiter: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && /^\/[^/]+\/comments$/.test(req.path)) {
      return messageLimiter(req, res, next);
    }
    return uploadLimiter(req, res, next);
  };
  app.use("/api/attachments", requireAuth, requireVerified, requireServer, attachmentWriteLimiter, attachmentRouter);
  // Only the retired create route is left, a 410 for older clients.
  app.use("/api/share-artifacts", requireAuth, shareArtifactRouter);
  // First-party apps' web APIs (apps/firstPartyApps.ts), each at /api/<id>, with
  // their own per-user limits (routes/firstPartyAppRoutes.ts). An app's account
  // routes first: each behind requireAuth and requireVerified of its own, no
  // requireServer (the person across their servers); any other request passes
  // through to the server-scoped router.
  for (const { path, router } of firstPartyAppWeb.accountRouters) {
    app.use(path, router);
  }
  for (const { path, router } of firstPartyAppWeb.routers) {
    app.use(path, requireAuth, requireVerified, requireServer, router);
  }
  // First-party objects of any app (routes/objects.ts): core decides who sees
  // what by the objects' homes, the app summarizes what is left; core serves
  // the objects' files by the same rule (one budget for both).
  // replica-local: abuse guard only, per-replica budget is acceptable
  const objectSummariesMax = options.testHarness?.appRateLimitMax?.["objects.summaries"];
  const objectSummariesLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: objectSummariesMax ?? 300,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many object summary lookups", code: "RATE_LIMITED" },
    keyGenerator: rateLimitUserOrIpKey,
    // Skipped in the pglite harness unless a test sets the limit.
    skip: () => isTestEnv && objectSummariesMax === undefined,
  });
  app.use("/api/objects", requireAuth, requireVerified, requireServer, objectSummariesLimiter, objectsRouter);
  // Who can be @-mentioned in a conversation or on an app's object
  // (routes/mentions.ts, platform/mentions.ts): asked as the picker opens and
  // as a name is typed, limited per user like summaries.
  // replica-local: abuse guard only, per-replica budget is acceptable
  const mentionAudienceMax = options.testHarness?.appRateLimitMax?.["mentions.audience"];
  const mentionAudienceLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: mentionAudienceMax ?? 300,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many mention lookups", code: "RATE_LIMITED" },
    keyGenerator: rateLimitUserOrIpKey,
    // Skipped in the pglite harness unless a test sets the limit.
    skip: () => isTestEnv && mentionAudienceMax === undefined,
  });
  app.use("/api/mentions", requireAuth, requireVerified, requireServer, mentionAudienceLimiter, mentionsRouter);
  // Search across the first-party apps (routes/search.ts): one group per app
  // that searches, in the reader's current server. Each request holds a
  // primary connection per app searching: limited per user like summaries.
  // replica-local: abuse guard only, per-replica budget is acceptable
  const searchMax = options.testHarness?.appRateLimitMax?.["search"];
  const searchLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: searchMax ?? 300,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many searches", code: "RATE_LIMITED" },
    keyGenerator: rateLimitUserOrIpKey,
    // Skipped in the pglite harness unless a test sets the limit.
    skip: () => isTestEnv && searchMax === undefined,
  });
  app.use("/api/search", requireAuth, requireVerified, requireServer, searchLimiter, searchRouter);
  app.use("/api/integration-invites", requireAuth, requireVerified, integrationInviteRouter);
  app.use("/api/integrations", requireAuth, requireVerified, requireServer, integrationRouter);
  app.use("/api/actions", requireAuth, requireVerified, requireServer, actionsRouter);
  app.use("/api/actors", requireAuth, requireVerified, requireServer, actorRouter);
  // Interactive link card actions: their own cross-replica limits (services/linkCardActionLimits.ts).
  app.use("/api/link-cards", requireAuth, requireVerified, requireServer, linkCardRouter);
  // RFC-067 client events: a tab flushes about every 10s, so this only stops
  // runaway or abusive senders.
  // replica-local: abuse guard only, per-replica budget is acceptable
  const productEventsLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many product event batches.", code: "product_events_rate_limited" },
    keyGenerator: rateLimitUserOrIpKey,
    skip: () => isTestEnv,
  });
  app.use("/api/product-events", requireAuth, requireVerified, requireServer, productEventsLimiter, productEventsRouter);
  // The remote provider returns here without a Raft browser session. The
  // callback consumes a one-time hashed state and derives Server scope from it.
  app.use("/api/mcp/oauth", authLimiter, managedMcpOAuthCallbackRouter);
  app.use("/api/mcp", requireAuth, requireVerified, requireServer, managedMcpRouter);
  app.use("/api/provider-connections", requireAuth, requireVerified, requireServer, providerConnectionRouter);
  app.use("/api/agent-runtime-providers", requireAuth, requireVerified, requireServer, agentRuntimeProviderRouter);
  // A hosted runtime provider returns the browser here after an account-connection
  // OAuth round trip; the route only forwards the outcome to the web landing page.
  app.use("/api/connections", authLimiter, agentConnectionCallbackRouter);

  // Apply the same upload concurrency guard to the agent upload surface before
  // the general internal router. Uploads can now be up to 50MB and still use the
  // server-proxy path, so the agent path must not bypass the upload limiter.
  app.use("/internal/agent/:id/upload", requireMachineAuth, uploadLimiter);

  // `rfcs/034-slock-credential-rfc.zh.html#section-api-auth-surface` —
  // `/internal/computer/*` sk_computer_* surface. Mounted BEFORE the generic
  // `/internal` machine-auth route so the more specific prefix wins.
  // SLOCK_EXPERIMENTAL_SURFACES_DISABLED is a hard-disable switch for these
  // v0.8 surfaces. New daemon builds must fail managed-runner startup loudly
  // when this surface is disabled; rollback the daemon binary for release
  // safety instead of falling back in-process to `/internal/agent/:id/*`.
  // Cross-principal rejection (sk_machine_* / sk_agent_* keys presented here)
  // is handled inside `requireComputerAuth` via the `isComputerApiKey` shape
  // check.
  app.use("/internal/computer", experimentalInternalSurfaceContract("computer"), authFromRegistry(), internalComputerRouter);

  // `rfcs/034-slock-credential-rfc.zh.html#section-api-auth-surface` —
  // `/internal/agent-api/*` sk_agent_* surface. Mounted BEFORE the generic
  // `/internal` machine-auth route so the more specific prefix wins. The
  // bound agentId is read from the credential row — there is NO `:id` path
  // param. Cross-principal rejection (sk_machine_* / sk_computer_* / JWT) is
  // handled inside `requireAgentCredentialAuth`.
  // agentApiErrorTrace before auth: auth refusals (401/403) are classified too.
  app.use("/internal/agent-api", experimentalInternalSurfaceContract("agent-api"), agentApiErrorTrace, authFromRegistry(), internalAgentApiRouter);

  // First-party apps' internal routes (apps/firstPartyApps.ts): callers the app
  // authenticates itself (its own bearer tokens, never a machine, agent or
  // user credential). Before the generic `/internal` machine-auth route so
  // the more specific prefix wins.
  for (const { path, router } of mountFirstPartyAppInternals()) {
    app.use(path, router);
  }

  // The hosted runtime provider's own control routes (routes/runtimeProviderControl.ts):
  // authenticated by the provider's provisioning token, never by an agent,
  // machine or user credential. Before the generic `/internal` machine-auth
  // route so the more specific prefix wins.
  app.use("/internal/runtime-provider", runtimeProviderControlRouter);

  // Internal routes (machine auth)
  app.use("/internal", requireMachineAuth, internalRouter);

  // Liveness for the ALB/ECS health check: no database query on the request
  // path, so a Neon pause cannot fail every task at once. See dbLiveness.ts.
  app.get("/livez", async (_req, res) => {
    const { getDbLivenessTracker, livezStatus } = await import("./dbLiveness");
    const verdict = getDbLivenessTracker().verdict();
    const status = livezStatus(verdict);
    // The ALB polls this route, not /health, so the int4 seq-headroom tripwire
    // rides here too or it would stop running. Same contract as on /health:
    // throttled, fail-open, fire-and-forget, never part of the verdict. Its
    // one MAX(seq) query per ten minutes runs off the request path.
    if (status === 200) {
      const { probeSeqHeadroom } = await import("./services/seqHeadroomTripwire");
      probeSeqHeadroom();
    }
    res.status(status).json({ status: status === 200 ? "ok" : "error", ...verdict });
  });

  // Health check (readiness) — verifies DB connectivity right now. Deploy
  // smoke checks, the Web deploy gate and canary smoke depend on this meaning.
  app.get("/health", async (_req, res) => {
    try {
      const { pingDatabase } = await import("./db/index");
      await pingDatabase();
      // Piggyback the read-only int4 seq-headroom tripwire on health polling.
      // Throttled + fail-open inside; must never affect the health verdict.
      const { probeSeqHeadroom } = await import("./services/seqHeadroomTripwire");
      probeSeqHeadroom();
      res.json({ status: "ok" });
    } catch (err) {
      console.error("Health check DB query failed:", (err as Error).message);
      res.status(503).json({ status: "error", detail: "database unreachable" });
    }
  });

  app.use((req, res) => {
    res.status(404).json({
      error: "Not found",
      code: "not_found",
      path: req.path,
    });
  });

  app.use(globalJsonServerErrorHandler);

  return app;
}
