import express, { type Express, type Request, type RequestHandler } from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { channelRouter } from "./routes/channels.js";
import { publicServerRouter } from "./routes/publicServer.js";
import { messageRouter, messageV2Router } from "./routes/messages.js";
import { agentRouter, agentAvatarRouter } from "./routes/agents.js";
import { agentCredentialsHandler, listAgentCredentialsHandler, revokeAgentCredentialHandler } from "./routes/agentCredentials.js";
import { listManageableAgentsHandler } from "./routes/agentDiscovery.js";
import { internalRouter } from "./routes/internal.js";
import { authRouter } from "./routes/auth.js";
import { agentLoginRouter } from "./routes/agentLogin.js";
import { deviceAuthRouter } from "./routes/deviceAuth.js";
import { computerAttachRouter } from "./routes/computerAttach.js";
import { computerAdoptRouter } from "./routes/computerAdopt.js";
import { computerLegacyMachinesRouter } from "./routes/computerLegacyMachines.js";
import { isDeviceAuthSurfaceEnabled } from "./services/deviceAuthService.js";
import { internalComputerRouter } from "./routes/internalComputer.js";
import { internalAgentApiRouter } from "./routes/internalAgentApi.js";
import { serverRouter } from "./routes/servers.js";
import { billingRouter, stripeWebhookHandler } from "./routes/billing.js";
import { resendNewsletterWebhookHandler } from "./routes/newsletterWebhooks.js";
import { taskRouter } from "./routes/tasks.js";
import { workflowRouter } from "./routes/workflows.js";
import { reminderRouter } from "./routes/reminders.js";
import { attachmentRouter, attachmentPublicRouter } from "./routes/attachments.js";
import { externalAvatarPublicRouter } from "./routes/externalAvatars.js";
import {
  attachmentUploadRateLimitedResponse,
  createAttachmentUploadSessionRouter,
  type AttachmentUploadSessionService,
} from "./routes/attachmentUploadSessions.js";
import { shareArtifactPublicRouter, shareArtifactRouter } from "./routes/shareArtifacts.js";
import { pushRouter } from "./routes/push.js";
import { notificationRouter } from "./routes/notifications.js";
import { announcementRouter } from "./routes/announcements.js";
import { integrationInviteRouter, integrationLogoPublicRouter, integrationRouter } from "./routes/integrations.js";
import { appInstallationRouter } from "./routes/appInstallations.js";
import { actionsRouter } from "./routes/actions.js";
import { productEventsRouter } from "./routes/productEvents.js";
import { managedMcpOAuthCallbackRouter, managedMcpRouter } from "./routes/managedMcp.js";
import { providerConnectionRouter } from "./routes/providerConnections.js";
import { productFeedbackRouter } from "./routes/productFeedback.js";
import { mobileDownloadRouter } from "./routes/mobileDownload.js";
import { featureFlagsRouter } from "./routes/featureFlags.js";
import { readMutationRouter } from "./routes/readMutations.js";
import { wikiRouter } from "./routes/wiki.js";
import { oauthRouter, oidcDiscoveryHandler } from "./routes/oauth.js";
import { messageTranslationBatchHandler } from "./routes/messageTranslations.js";
import { otlpRelayHandler } from "./routes/otlpRelay.js";
import {
  createSlackBridgeRouteHandlers,
  type SlackBridgeRouteDependencies,
} from "./routes/slackBridge.js";
import { requireAuth, requireVerified, requireServer, requireMachineAuth, requireFlexAuth, requireServerForFlex } from "./middleware/auth.js";
import { authFromRegistry } from "./middleware/authFromRegistry.js";
import { perfAttributionMiddleware } from "./middleware/perfAttribution.js";
import { requestObservabilityMiddleware } from "./middleware/requestObservability.js";
import {
  forwardAdmissionTraceMiddleware,
  markForwardAdmissionStage,
} from "./tracing/messageForwardTrace.js";
import { raftdevActivityMiddleware } from "./middleware/raftdevActivity.js";
import { inboxRouteBackpressureMiddleware } from "./middleware/inboxRouteBackpressure.js";
import { AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV, isAgentBootstrapSurfaceEnabled } from "./services/agentCredentialService.js";
import { getWebCorsOriginOption } from "./config/appUrl.js";
import { globalJsonServerErrorHandler } from "./routes/errorResponse.js";
import { readBuildIdentityStatus } from "./version.js";

export function rateLimitUserOrIpKey(req: Pick<Request, "ip" | "userId">): string {
  return req.userId || ipKeyGenerator(req.ip ?? "unknown");
}

export function rateLimitUserMachineOrIpKey(req: Pick<Request, "ip" | "machineId" | "userId">): string {
  return req.userId || req.machineId || ipKeyGenerator(req.ip ?? "unknown");
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
}): boolean {
  if (input.path === "/invite-info" || input.path === "/accept-invite") return true;
  return input.isTestEnv && input.skipInTestHarness;
}

export type CreateAppOptions = Readonly<{
  testHarness?: {
    skipAuthRateLimit?: boolean;
    enforceMessageRateLimit?: boolean;
    messageRateLimitMax?: number;
  };
  attachmentUploadSessionService?: AttachmentUploadSessionService;
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

  // Configure Helmet with CSP that allows CDN images (for thumbnails served via CDN_BASE_URL)
  const imgSrc = ["'self'"];
  if (process.env.CDN_BASE_URL) {
    try {
      const cdnHost = new URL(process.env.CDN_BASE_URL).origin;
      imgSrc.push(cdnHost);
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
  app.use(cors({ origin: corsOrigin, credentials: true }));
  app.use((_req, res, next) => {
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    next();
  });
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send([
      "# Raft API host: authenticated API surface with no indexable public pages.",
      "User-agent: *",
      "Disallow: /",
      "",
    ].join("\n"));
  });

  // Stripe webhook must be registered BEFORE express.json() to preserve raw body for signature verification
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookHandler);
  // Resend webhook must also use the raw body because Svix signatures are payload-sensitive.
  app.post("/api/webhooks/resend", express.raw({ type: "application/json" }), resendNewsletterWebhookHandler);
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

  // Wiki publication carries changed Markdown revision bodies alongside the
  // manifest. Authenticate this one larger JSON surface before parsing it;
  // the default Express JSON limit remains in force for every other route.
  app.use(
    "/internal/agent-api/wiki/publish",
    authFromRegistry(),
    express.json({ limit: "24mb" }),
  );
  app.use(express.json());
  app.use(raftdevActivityMiddleware);
  app.use(requestObservabilityMiddleware);
  app.use(perfAttributionMiddleware);

  // Public-unlisted share pages for external crawlers (X/Twitter cards).
  // Creation stays auth/member-gated under `/api/share-artifacts`.
  app.use("/share", shareArtifactPublicRouter);

  // Rate limiter for auth endpoints (general)
  const authLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later" },
    // Invite join flow can legitimately burst from one IP (e.g. admin onboarding multiple users).
    // Keep auth brute-force protection strict for login/register/etc, but exclude invite routes.
    // Playwright explicitly opts out because every shard shares one pglite API
    // process and IP bucket; production cannot take this branch, even if the
    // test-harness option is accidentally passed there.
    skip: (req) => shouldSkipAuthRateLimit({
      isTestEnv,
      skipInTestHarness: options.testHarness?.skipAuthRateLimit ?? false,
      path: req.path,
    }),
  });

  // Separate (more lenient) limiter for join-link invite flow endpoints.
  const inviteFlowLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many invite requests, please try again in a minute" },
  });

  // Stricter rate limiter for forgot-password (5 requests/hour/IP)
  const forgotPasswordLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many password reset requests. Please try again later." },
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
  app.use("/api/auth", authLimiter, authRouter);
  app.get("/.well-known/openid-configuration", authLimiter, oidcDiscoveryHandler);
  app.use("/api/oauth", authLimiter, express.urlencoded({ extended: false }), oauthRouter);
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
  app.put(
    "/api/slack-bridge/author-policies",
    authLimiter,
    requireAuth,
    requireVerified,
    requireServer,
    slackBridgeHandlers.setAuthorPolicy,
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

  // Server routes (auth + verified required, no server context needed)
  app.use("/api/servers", requireAuth, requireVerified, serverRouter);
  app.use("/api/feature-flags", requireAuth, requireVerified, featureFlagsRouter);

  const productFeedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many feedback submissions. Please try again later.", code: "feedback_rate_limited" },
    keyGenerator: rateLimitUserOrIpKey,
    skip: (req) => shouldSkipProductFeedbackRateLimit({
      isSlockdev,
      isTestEnv,
      method: req.method,
    }),
  });
  // Public by design: the desktop Settings surface shows a QR code, and the
  // phone scanning it has no session. Requiring auth would land every scan on a
  // login wall. Artifacts behind it are public app builds.
  app.use("/api/mobile-download", authLimiter, mobileDownloadRouter);
  app.use("/api/product-feedback", requireAuth, requireVerified, productFeedbackLimiter, productFeedbackRouter);

  // Rate limiter for billing mutation endpoints (checkout/portal create Stripe sessions)
  const billingLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many billing requests, please try again later" },
    skip: (req) => req.method === "GET", // Allow reads (subscription info)
  });

  // Rate limiter for file uploads (10 uploads/minute/IP to prevent abuse).
  // This covers both human `/api/attachments/upload` and agent `/internal/.../upload`.
  const uploadLimiter = rateLimit({
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
    windowMs: 60 * 1000,
    max: 10,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: attachmentUploadRateLimitedResponse,
    keyGenerator: (req) => req.userId || req.actingAgentId || ipKeyGenerator(req.ip ?? "unknown"),
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

  // Rate limiter for message sending (60 messages/minute/user)
  const messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: options.testHarness?.messageRateLimitMax ?? 60,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many messages, please slow down" },
    // e2e seeds many messages quickly (it exercises UI, not rate-limiting). Under
    // the prod-like vite-preview e2e webServer the faster page loads burst past
    // 60/min and 429 the thread specs (dev mode's slower loads stayed under). The
    // limit is irrelevant to what e2e tests, so skip it in the pglite test
    // harness; prod (postgres) keeps the 60/min limit unchanged.
    skip: (req) => (!options.testHarness?.enforceMessageRateLimit && isTestEnv) || req.method === "GET",
    keyGenerator: rateLimitUserOrIpKey,
  });

  const translationLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    validate: rateLimitValidate,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many translation requests, please slow down" },
    keyGenerator: rateLimitUserOrIpKey,
  });

  // Resource routes (auth + verified + server required)
  app.post(/^\/api\/message-translations:batch$/, requireAuth, requireVerified, requireServer, translationLimiter, messageTranslationBatchHandler);
  // Authenticate the JWT without DB work, then admit Inbox requests before
  // verified-profile, server-membership, policy, and serving-row queries. This
  // bounds all PostgreSQL work caused by one authenticated Inbox request, not
  // only the final serving query inside the route handler.
  // Task #70: the ONLY unauthenticated read surface for server content.
  // No requireAuth/requireVerified/requireServer on purpose — it serves logged-out
  // visitors. It is rate-limited and read-only; see routes/publicServer.ts for the
  // two properties it exists to guarantee.
  app.use("/api/public", authLimiter, publicServerRouter);

  app.use(
    "/api/channels",
    inboxRouteBackpressureMiddleware,
    requireAuth,
    requireVerified,
    requireServer,
    channelRouter,
  );
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
  app.use("/api/agents", requireAuth, requireVerified, requireServer, agentRouter);
  app.use("/api/billing", requireAuth, requireVerified, requireServer, billingLimiter, billingRouter);
  app.use("/api/tasks", requireAuth, requireVerified, requireServer, taskRouter);
  app.use("/api/workflows", requireAuth, requireVerified, requireServer, workflowRouter);
  app.use("/api/reminders", requireAuth, requireVerified, requireServer, reminderRouter);
  // Attachment-comment creation is MESSAGE-shaped traffic, not an upload:
  // it must ride the message limiter (60/min/user, skipped in the pglite
  // harness), not the 10/min/IP upload limiter — otherwise a review session
  // hits 429 after ten comments (surfaced by the task #15 anchor tests).
  const attachmentWriteLimiter: RequestHandler = (req, res, next) => {
    if (req.method === "POST" && /^\/[^/]+\/comments$/.test(req.path)) {
      return messageLimiter(req, res, next);
    }
    return uploadLimiter(req, res, next);
  };
  app.use("/api/attachments", requireAuth, requireVerified, requireServer, attachmentWriteLimiter, attachmentRouter);
  app.use("/api/share-artifacts", requireAuth, requireVerified, requireServer, uploadLimiter, shareArtifactRouter);
  app.use("/api/integration-invites", requireAuth, requireVerified, integrationInviteRouter);
  app.use("/api/integrations", requireAuth, requireVerified, requireServer, integrationRouter);
  app.use("/api/actions", requireAuth, requireVerified, requireServer, actionsRouter);
  app.use("/api/wiki", requireAuth, requireVerified, requireServer, wikiRouter);
  app.use("/api/product-events", requireAuth, requireVerified, requireServer, productEventsRouter);
  // The remote provider returns here without a Raft browser session. The
  // callback consumes a one-time hashed state and derives Server scope from it.
  app.use("/api/mcp/oauth", authLimiter, managedMcpOAuthCallbackRouter);
  app.use("/api/mcp", requireAuth, requireVerified, requireServer, managedMcpRouter);
  app.use("/api/provider-connections", requireAuth, requireVerified, requireServer, providerConnectionRouter);

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
  app.use("/internal/agent-api", experimentalInternalSurfaceContract("agent-api"), authFromRegistry(), internalAgentApiRouter);

  // Internal routes (machine auth)
  app.use("/internal", requireMachineAuth, internalRouter);

  // Health check — verifies DB connectivity so Fly.io can detect stale connections
  app.get("/health", async (_req, res) => {
    try {
      const { pingDatabase } = await import("./db/index.js");
      await pingDatabase();
      // Piggyback the read-only int4 seq-headroom tripwire on health polling.
      // Throttled + fail-open inside; must never affect the health verdict.
      const { probeSeqHeadroom } = await import("./services/seqHeadroomTripwire.js");
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
