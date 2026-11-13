import { registerAppLinkPreview, readAppLinkPreview, deleteAppLinkPreview, AppLinkPreviewConfigError } from "../services/appLinkPreviewService";
import { coalesceWakeIntoUnreadItem } from "../services/appItemWakeCoalescing";
import { getAppInstallationSetup, updateAppInstallationSetup, AppSetupConflictError } from "../services/appSetupService";
import {
  deriveAppBotHandle,
  issueManagedAppBotCredential,
  readAppFacingInstallationBot,
  setManagedAppBotStatus,
  type ManagedAppBotCredentialRefusal,
} from "../services/appBotIdentityService";
import { asAppSetupInstallationId, AppSetupValidationError } from "@botiverse/raft-shared";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import {
  currentDate,
  noopTracer,
  type ActiveSpan,
  type ServerRole,
  type TraceAttributes,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";
import { requireAuth } from "../middleware/auth";
import { projectCoarseServerPlan } from "../services/serverPlanProjection";
import * as oauthService from "../services/oauthService";
import * as integrationAuditService from "../services/integrationAuditService";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { encodePixelAvatarKey, humanAvatarSvgPath } from "../services/pixelAvatarService";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { errorClassOf, getCurrentTraceContext } from "../tracing/semanticTrace";
import {
  APP_INSTALLATION_TOKEN_AUDIENCE,
  discoverActiveAppInstallation,
  mintAppInstallationCredential,
} from "../services/appInstallationCredentialService";
import {
  AppOutboundPermissionError,
  updateAppInstallationSubscriptions,
} from "../services/appOutboundPermissionService";
import { getAppUrl } from "../config/appUrl";
import { getServer } from "../services/serverService";
import { UUID_RE } from "../lib/messageId";
import { broadcastAgentUpdated } from "./agentUpdatedBroadcast";
import {
  decodeOidcAuthorizationCode,
  encodeOidcAuthorizationCode,
  getOidcJwks,
  oidcDiscoveryDocument,
  oidcIssuer,
  OIDC_SERVER_SEGMENT_PATTERN,
  signOidcAccountIdToken,
  signOidcIdToken,
  validateOidcAuthorizationCode,
  type OidcAuthorizationContext,
} from "../services/oidcService";
import { sendJsonServerError } from "./errorResponse";
import { refuseUnverifiedApprover } from "./secondFactor";
import { webSessionFamilyOf } from "../services/sessionService";
import { acceptLinkCardUpdate, LINK_CARD_UPDATE_INVALID_CLIENT, parseLinkCardUpdateBody } from "../services/linkCardUpdateService";
import {
  checkAccountAppServerAccess,
  getAccountIdentityByAccessToken,
  getOAuthClientLoginMode,
  isAccountIdentity,
  isAccountLoginEnabledFor,
  isServerInAccountAudience,
  issueAccountAuthorizationCode,
  listAccountAppServers,
  OAuthGrantNotServerBoundError,
  OAuthLoginModeChangedError,
  OAuthRootIssuerRequiredError,
  type OAuthAccountAccessTokenIdentity,
} from "../services/oauthAccountLogin";
import { requestLinkCardHints, sendLinkCardResponse } from "./linkCards";
import { resolveOAuthClientByKey } from "../services/oauthClientKeys";
import { resolveRelatedConversationForAgent } from "../services/agentInboxItems";

// mergeParams: the OIDC endpoints are additionally mounted under
// /oidc/:server/api/oauth, and the handlers read that segment as the
// authoritative server scope.
export const oauthRouter: RouterType = Router({ mergeParams: true });


type OAuthSpanOutcome = TraceAttributes & {
  outcome: string;
  http_status: number;
};

function parseClientCredentials(req: Request) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator > 0) {
        return {
          clientId: decoded.slice(0, separator),
          clientSecret: decoded.slice(separator + 1),
        };
      }
    } catch {
      // fall through
    }
  }

  const bodyClientId = typeof req.body?.client_id === "string"
    ? req.body.client_id
    : typeof req.body?.clientId === "string"
      ? req.body.clientId
      : null;
  const bodyClientSecret = typeof req.body?.client_secret === "string"
    ? req.body.client_secret
    : typeof req.body?.clientSecret === "string"
      ? req.body.clientSecret
      : null;
  if (bodyClientId && bodyClientSecret) {
    return { clientId: bodyClientId, clientSecret: bodyClientSecret };
  }
  return null;
}

function startOAuthSpan(req: Request, name: string, attrs: TraceAttributes = {}): ActiveSpan {
  const tracer = (req.app.get("serverTracer") as Tracer | undefined) ?? noopTracer;
  return tracer.startSpan(name, {
    parent: getCurrentTraceContext(),
    surface: "server",
    kind: "server",
    attrs,
  });
}

function finishOAuthSpan(span: ActiveSpan, status: TraceStatus, attrs: OAuthSpanOutcome): void {
  span.addEvent("oauth.outcome", attrs);
  span.end(status, { attrs });
}

function hashedOAuthRequestIdForAudit(requestId: string): string {
  return `sha256:${createHash("sha256").update(requestId).digest("hex")}`;
}

function errorClass(error: unknown): string {
  return errorClassOf(error);
}

function requestedScopeCount(scopes: unknown): number {
  if (typeof scopes === "string") {
    return scopes.trim() ? scopes.trim().split(/\s+/).length : 0;
  }
  if (Array.isArray(scopes)) {
    return scopes.filter((scope) => typeof scope === "string" && scope.trim()).length;
  }
  return 0;
}

function requestedAgentInboundScopePresent(scopes: unknown): boolean {
  const values = typeof scopes === "string" ? scopes.trim().split(/\s+/) : Array.isArray(scopes) ? scopes : [];
  return values.some((scope) => scope === "agent:event:write" || scope === "agent:notification:write");
}

function eventKindAttr(kind: unknown): "event" | "notification" | "invalid" | "missing" {
  if (kind === "event" || kind === "notification") return kind;
  return kind === undefined || kind === null ? "missing" : "invalid";
}

function grantTypeAttr(grantType: unknown): "authorization_code" | "agent_request" | "unsupported" | "missing" {
  if (grantType === "authorization_code") return "authorization_code";
  if (grantType === "urn:slock:grant-type:agent_request") return "agent_request";
  return grantType === undefined || grantType === null || grantType === "" ? "missing" : "unsupported";
}

type OAuthLifecycleStage = "authorization" | "token_exchange";
type OAuthLifecycleResult =
  | "issued"
  | "client_auth_failed"
  | "unsupported_grant_type"
  | "missing_request"
  | "authorization_pending"
  | "access_denied"
  | "request_already_consumed"
  | "authorization_code_expired"
  | "not_found"
  | "invalid_request"
  | "invalid_resource"
  | "internal_error";

function auditClientKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z][a-z0-9-]{2,63}$/.test(normalized) ? normalized : undefined;
}

function tokenExchangeLifecycleResult(message: string): OAuthLifecycleResult {
  // RFC 079 phase 3a (Q3): a code issued before its App switched to account mode.
  if (message === "login_mode_changed") return "invalid_request";
  if (message === "authorization_pending") return "authorization_pending";
  if (message === "access_denied" || message === "installation_suspended") return "access_denied";
  if (message === "request_already_consumed") return "request_already_consumed";
  if (message === oauthService.AUTHORIZATION_CODE_EXPIRED_ERROR || message === oauthService.AGENT_REQUEST_EXPIRED_ERROR) return "authorization_code_expired";
  if (message.includes("not found")) return "not_found";
  if (message.includes("resource")) return "invalid_resource";
  return "internal_error";
}

function safeErrorClass(error: unknown): string {
  try {
    if (error instanceof Error) {
      const name = error.name;
      return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "unknown";
    }
    const kind = typeof error;
    return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(kind) ? kind : "unknown";
  } catch {
    return "unknown";
  }
}

function authorizationLifecycleResult(message: string): OAuthLifecycleResult {
  // RFC 079 phase 3a: a Server-bound continue for an App now in account mode.
  if (message === "login_mode_changed") return "invalid_request";
  if (message === "installation_suspended") return "access_denied";
  if (message === "app_not_available") return "not_found";
  if (message.includes("not found") || message.includes("member")) return "not_found";
  if (
    message.includes("returnUrl")
    || message.includes("scope")
    || message.includes("required")
    || message.includes("server does not match")
    || message.includes("server must be")
  ) {
    return "invalid_request";
  }
  return "internal_error";
}

async function recordOAuthLifecycle(input: {
  stage: OAuthLifecycleStage;
  result: OAuthLifecycleResult;
  outcome: "success" | "failure";
  clientId?: string | null;
  clientKey?: string;
  grantType?: ReturnType<typeof grantTypeAttr>;
  principalType?: "human" | "agent";
}) {
  await integrationAuditService.recordIntegrationAuditEventBestEffort({
    clientId: input.clientId ?? null,
    eventType: "oauth.lifecycle",
    outcome: input.outcome,
    source: "api",
    actor: { type: "system" },
    target: { type: "app", id: input.clientId ?? null },
    metadata: {
      stage: input.stage,
      result: input.result,
      ...(input.clientKey ? { clientKey: input.clientKey } : {}),
      ...(input.grantType ? { grantType: input.grantType } : {}),
      ...(input.principalType ? { principalType: input.principalType } : {}),
      ...(input.outcome === "failure" ? { errorClass: input.result } : {}),
    },
  });
}

async function requireOAuthClient(req: Request, res: Response) {
  const creds = parseClientCredentials(req);
  if (!creds) {
    res.status(401).json({ error: "Client credentials are required" });
    return null;
  }
  const client = await oauthService.authenticateOAuthClient(creds.clientId, creds.clientSecret);
  if (!client) {
    res.status(401).json({ error: "Invalid client credentials" });
    return null;
  }
  return client;
}

/** The answer for a token with no live identity: revoked, expired, a lost membership, a suspended installation. */
function sendInvalidAccessToken(res: Response) {
  res.status(401).json({ error: "Invalid or expired access token" });
}

/**
 * The access token an `Authorization: Bearer` header carries, else null (no
 * header, another scheme). The one parser of this router's Bearer endpoints
 * and of their per-token rate limit (oauthIdentityTokenRateLimitKey).
 */
function bearerAccessToken(req: Pick<Request, "headers">): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

async function requireBearerIdentity(req: Request, res: Response) {
  const accessToken = bearerAccessToken(req);
  if (accessToken === null) {
    res.status(401).json({ error: "Missing bearer token" });
    return null;
  }
  // RFC 079 phase 3a: only a token the server-mode lookup does not know may
  // be an account-mode one (design rule 5).
  const token = await oauthService.getIdentityByAccessToken(accessToken)
    ?? await getAccountIdentityByAccessToken(accessToken);
  if (!token) {
    sendInvalidAccessToken(res);
    return null;
  }
  // D21: an account-mode token has no Server, so a Server-scoped issuer's path
  // never matches it: the 401 bearerTokenMatchesPathScope's callers send.
  if (isAccountIdentity(token) && pathServerScope(req) !== undefined) {
    res.status(401).json({ error: "Access token was issued for a different Server than this issuer" });
    return null;
  }
  return token;
}

// Server mode keeps today's guest rule: guests may use apps (RFC 079 D19).
const SERVER_MODE_ALLOWS_GUESTS = true;

// RFC 079 §5.8: the longest an app may cache a role or membership answer.
const SERVER_ACCESS_CACHE_CONTROL = "private, max-age=60";

/**
 * The one answer when oauthService.checkAppServerAccess refuses (RFC 079 §5.5):
 * the same status, headers and bytes whether the server_id is unknown or
 * malformed, names another Server, a Server outside the app's audience or one
 * the principal may not act on, or the token lacks a scope. Names no Server.
 */
const SERVER_ACCESS_DENIED = Object.freeze({
  error: "server_access_denied",
  error_description: "This token cannot be used for this request on that Server.",
});

function sendServerAccessDenied(res: Response) {
  res.status(403).set("Cache-Control", "no-store").json(SERVER_ACCESS_DENIED);
}

/**
 * `?server_id=` (RFC 079 D12) as sent: undefined when absent, else the raw
 * value. A repeated or nested parameter is no Server id; it becomes "", which
 * the access check refuses like any malformed id.
 */
function namedServerId(req: Request): string | undefined {
  const value = req.query.server_id;
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : "";
}

/** A Server as `/servers` and `/membership` show it: exactly these four fields (RFC 079 §5.3). */
function serverAccessEntry(server: oauthService.AppServerAccessServer) {
  return { id: server.id, slug: server.slug, name: server.name, role: server.role };
}

/**
 * The access check for an account-mode token on serverinfo and agents. It has
 * no Server of its own, so `?server_id=` is required: without it, the 400
 * /membership answers (sent here; null). Otherwise checkAccountAppServerAccess.
 */
async function checkNamedAccountServerAccess(
  req: Request,
  res: Response,
  token: OAuthAccountAccessTokenIdentity,
  requiredScopes: readonly string[],
): Promise<oauthService.AppServerAccess | null> {
  const serverId = namedServerId(req);
  if (serverId === undefined) {
    oidcJsonError(res, "invalid_request", "server_id is required");
    return null;
  }
  return checkAccountAppServerAccess({ token, serverId, requiredScopes });
}

/** userinfo for an account-mode token: server mode's human claims, in its order, without server_id, server_slug and server_role. */
function accountUserinfo(token: OAuthAccountAccessTokenIdentity, req: Request) {
  const emailClaims = oauthService.accessTokenHasScope(token, "email") && token.humanEmail
    ? {
        email: token.humanEmail,
        email_verified: token.humanEmailVerified === true,
      }
    : {};
  return {
    scope: token.scopes.join(" "),
    client_id: token.clientKey,
    client_name: token.clientName,
    sub: token.humanId,
    type: "human",
    preferred_username: token.humanName,
    name: token.humanDisplayName || token.humanName,
    avatar_url: token.humanAvatarUrl,
    picture: userinfoHumanPictureUrl(token.humanAvatarUrl, req),
    description: token.humanDescription,
    ...emailClaims,
  };
}

function requiredScopeForEventKind(kind: unknown): string | null {
  if (kind === "notification") return "agent:notification:write";
  if (kind === "event") return "agent:event:write";
  return null;
}

function queryString(req: Request, name: string): string {
  const value = req.query[name];
  return typeof value === "string" ? value : "";
}

function oidcJsonError(res: Response, error: string, description: string, status = 400) {
  res.status(status).json({ error, error_description: description });
}

/**
 * The `:server` segment when the OIDC endpoints are reached through their
 * server-scoped mount, else undefined. Express types route params from the
 * path literal, so the unscoped mounts legitimately have no such key.
 */
function pathServerScope(req: Pick<Request, "params">): string | undefined {
  const params = req.params as Record<string, string | undefined> | undefined;
  const value = params?.server;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// Only the endpoints the scoped discovery document advertises are reachable
// under /oidc/:server/api/oauth. Mounting the whole router there would also
// expose routes that never read the segment -- agent requests, installation
// tokens, client lookup -- so they would answer under any Server prefix.
const OIDC_SCOPED_ROUTES = new Set([
  "GET /.well-known/openid-configuration",
  "GET /authorize",
  "POST /token",
  "GET /userinfo",
  "GET /jwks",
  "GET /serverinfo",
  "GET /agents",
]);

/** `METHOD /path` of a request beneath either mount, as the sets above name routes: HEAD as GET, no trailing slash. */
function mountRouteKey(req: Pick<Request, "method" | "path">): string {
  const method = req.method === "HEAD" ? "GET" : req.method;
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, "") : req.path;
  return `${method} ${path}`;
}

/**
 * Guards the whole server-scoped OIDC mount before any handler runs: a
 * malformed segment fails closed with 400 for every endpoint in the family, and
 * routes the scoped discovery document does not advertise are 404. Handlers
 * keep their own checks; this makes the path one authority for the family
 * instead of relying on each handler remembering to validate it.
 */
export function oidcScopedMountGuard(req: Request, res: Response, next: () => void) {
  const segment = pathServerScope(req);
  if (segment === undefined || !OIDC_SERVER_SEGMENT_PATTERN.test(segment)) {
    oidcJsonError(res, "invalid_request", "server must be a Server ID or slug");
    return;
  }
  if (!OIDC_SCOPED_ROUTES.has(mountRouteKey(req))) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  next();
}

/**
 * The Bearer identity endpoints (RFC 079 1a follow-up, Tenny,
 * #proj-apps:769a57d4). Apps call them from their own backend, so every user
 * of an App shares one IP: app.ts limits them per access token, and every
 * other route of this router keeps the per-IP auth limit.
 */
const OAUTH_IDENTITY_ROUTES = new Set([
  "GET /userinfo",
  "GET /servers",
  "GET /membership",
  "GET /serverinfo",
  "GET /agents",
]);

/**
 * The per-token rate-limit key of a request beneath either mount: the SHA-256
 * (hex) of its access token, never the token, which would sit in the limiter's
 * store. Null when the request is not for an identity endpoint the mount
 * serves (the Server-scoped mount has no `servers` or `membership`) or carries
 * no Bearer token (no header, another scheme, an empty token): the per-IP
 * limit takes it. Read before the token is looked up, so an invalid token is
 * counted by its hash too.
 */
export function oauthIdentityTokenRateLimitKey(req: Pick<Request, "method" | "path" | "headers" | "params">): string | null {
  const route = mountRouteKey(req);
  if (!OAUTH_IDENTITY_ROUTES.has(route)) return null;
  if (pathServerScope(req) !== undefined && !OIDC_SCOPED_ROUTES.has(route)) return null;
  const accessToken = bearerAccessToken(req);
  if (!accessToken) return null;
  return createHash("sha256").update(accessToken).digest("hex");
}

/**
 * On a server-scoped mount, a bearer token must belong to that Server. Without
 * this, a valid path for Server B would answer userinfo/serverinfo for a token
 * issued on Server A. The unscoped mount has no segment and is unaffected.
 */
function bearerTokenMatchesPathScope(
  req: Request,
  token: { serverId: string; serverSlug: string | null },
): boolean {
  const scope = pathServerScope(req);
  return scope === undefined || scope === token.serverId || scope === token.serverSlug;
}

export function oidcDiscoveryHandler(req: Request, res: Response) {
  const serverSegment = pathServerScope(req);
  if (serverSegment !== undefined && !OIDC_SERVER_SEGMENT_PATTERN.test(serverSegment)) {
    res.status(400).json({ error: "invalid_request", error_description: "server must be a Server ID or slug" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      ...oidcDiscoveryDocument(serverSegment),
      scopes_supported: oauthService.PUBLIC_RAFT_OAUTH_SCOPES,
    });
  } catch (error) {
    console.error("OIDC discovery configuration error:", error);
    res.status(503).json({ error: "oidc_not_configured" });
  }
}

export function oidcJwksHandler(_req: Request, res: Response) {
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(getOidcJwks());
  } catch (error) {
    console.error("OIDC JWKS configuration error:", error);
    res.status(503).json({ error: "oidc_not_configured" });
  }
}

oauthRouter.get("/.well-known/openid-configuration", oidcDiscoveryHandler);
oauthRouter.get("/jwks", oidcJwksHandler);

oauthRouter.get("/authorize", (req, res) => {
  const responseType = queryString(req, "response_type");
  const clientId = queryString(req, "client_id").trim();
  const redirectUri = queryString(req, "redirect_uri").trim();
  const scope = queryString(req, "scope").trim() || "openid profile";
  const state = queryString(req, "state");
  const nonce = queryString(req, "nonce");
  const codeChallenge = queryString(req, "code_challenge");
  const codeChallengeMethod = queryString(req, "code_challenge_method");
  const responseMode = queryString(req, "response_mode");
  // Server scope is taken from the mount path (/oidc/:server/...), never
  // from a query parameter: clients that reject query components could not
  // supply one. An unscoped mount leaves this undefined.
  const serverScope = pathServerScope(req) ?? "";

  if (responseType !== "code") {
    oidcJsonError(res, "unsupported_response_type", "Only response_type=code is supported");
    return;
  }
  if (!clientId) {
    oidcJsonError(res, "invalid_request", "client_id is required");
    return;
  }
  if (!redirectUri) {
    oidcJsonError(res, "invalid_request", "redirect_uri is required");
    return;
  }
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("invalid protocol");
    if (parsed.hash || parsed.username || parsed.password) throw new Error("invalid redirect URI components");
  } catch {
    oidcJsonError(res, "invalid_request", "redirect_uri must be an absolute HTTP(S) URL without credentials or a fragment");
    return;
  }
  if (!scope.split(/\s+/).includes("openid")) {
    oidcJsonError(res, "invalid_scope", "The openid scope is required for OIDC authorization");
    return;
  }
  if (responseMode && responseMode !== "query") {
    oidcJsonError(res, "invalid_request", "Only response_mode=query is supported");
    return;
  }
  if (codeChallenge && codeChallengeMethod !== "S256") {
    oidcJsonError(res, "invalid_request", "Only code_challenge_method=S256 is supported");
    return;
  }
  if (codeChallenge && !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    oidcJsonError(res, "invalid_request", "code_challenge must be a valid S256 challenge");
    return;
  }
  if (!codeChallenge && codeChallengeMethod) {
    oidcJsonError(res, "invalid_request", "code_challenge is required when code_challenge_method is set");
    return;
  }
  if (nonce.length > 512) {
    oidcJsonError(res, "invalid_request", "nonce must be no longer than 512 characters");
    return;
  }
  if (serverScope && !OIDC_SERVER_SEGMENT_PATTERN.test(serverScope)) {
    oidcJsonError(res, "invalid_request", "server must be a Server ID or slug");
    return;
  }
  // `?server=` used to carry the scope and no longer does. Reject it loudly
  // instead of ignoring it: a client that still sends one believes it is
  // restricting the login, and silently honouring the wrong scope is exactly
  // the failure this change exists to remove.
  if (Object.prototype.hasOwnProperty.call(req.query, "server")) {
    oidcJsonError(
      res,
      "invalid_request",
      "The server query parameter is no longer supported; use the server-scoped issuer at /oidc/<server>",
    );
    return;
  }

  const setup = new URL("/login-with-raft/setup", getAppUrl());
  setup.searchParams.set("flow", "oidc");
  setup.searchParams.set("client_id", clientId);
  setup.searchParams.set("return_to", redirectUri);
  setup.searchParams.set("scope", scope);
  if (state) setup.searchParams.set("state", state);
  if (nonce) setup.searchParams.set("nonce", nonce);
  if (codeChallenge) setup.searchParams.set("code_challenge", codeChallenge);
  if (codeChallengeMethod) setup.searchParams.set("code_challenge_method", codeChallengeMethod);
  if (serverScope) setup.searchParams.set("server", serverScope);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, setup.toString());
});

// App-owned configuration; the Basic credentials select the App, never a body ID.
oauthRouter.get("/link-preview", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const client = await requireOAuthClient(req, res);
  if (!client) return;
  res.json({ registration: await readAppLinkPreview(client.id) });
});
oauthRouter.put("/link-preview", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const client = await requireOAuthClient(req, res);
  if (!client) return;
  try { res.json({ registration: await registerAppLinkPreview(client, req.body) }); }
  catch (error) {
    res.status(error instanceof AppLinkPreviewConfigError ? error.status : 502).json({ error: error instanceof AppLinkPreviewConfigError ? error.message : "Link preview registration unavailable" });
  }
});
oauthRouter.delete("/link-preview", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const client = await requireOAuthClient(req, res);
  if (!client) return;
  await deleteAppLinkPreview(client);
  res.status(204).end();
});
// The App's terminal update for one interactive link card operation (RFC 076
// §6.5; services/linkCardUpdateService.ts). Basic client credentials only (the
// body is raw bytes, parsed strictly, and carries no client fields); not on the
// server-scoped mount. 401 before the body is read as JSON.
oauthRouter.post("/link-preview/card-updates", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  const creds = parseClientCredentials(req);
  const client = creds ? await oauthService.authenticateOAuthClient(creds.clientId, creds.clientSecret) : null;
  if (!client) { sendLinkCardResponse(res, LINK_CARD_UPDATE_INVALID_CLIENT); return; }
  const request = parseLinkCardUpdateBody(req.body);
  if (!request) { res.status(400).json({ error: "Invalid card update", code: "INVALID_REQUEST" }); return; }
  try {
    sendLinkCardResponse(res, await acceptLinkCardUpdate({ client: { id: client.id, clientId: client.clientId }, request, hints: requestLinkCardHints(req) }));
  } catch (error) {
    // Never log the token, body or operation.
    console.error("[LinkCardUpdate] failed", error instanceof Error ? error.name : "unknown");
    res.status(500).json({ error: "Couldn't record this update. Retry with the same update_id.", code: "INTERNAL" });
  }
});

// RFC 051: client-authenticated mint for a distinct installation credential.
// This token class is opaque/hash-only and is rejected by principal routes.
oauthRouter.post("/installation-token", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const client = await requireOAuthClient(req, res);
    if (!client) return;
    const installationId = typeof req.body?.installation_id === "string"
      ? req.body.installation_id
      : typeof req.body?.installationId === "string"
        ? req.body.installationId
        : "";
    if (!installationId) {
      res.status(400).json({ error: "installation_id is required" });
      return;
    }
    const credential = await mintAppInstallationCredential({
      clientId: client.id,
      installationId,
      requestedGroups: req.body?.groups,
      audience: APP_INSTALLATION_TOKEN_AUDIENCE,
    });
    if (!credential) {
      res.status(404).json({ error: "Active installation not found" });
      return;
    }
    res.json({
      access_token: credential.token,
      token_type: credential.tokenType,
      expires_in: credential.expiresIn,
      installation_id: credential.installationId,
      server_id: credential.serverId,
      grant_revision: credential.grantRevision,
      groups: credential.groups,
      audience: credential.audience,
    });
  } catch (error) {
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to mint installation credential",
      logPrefix: "Mint app installation credential error:",
      err: error,
    });
  }
});

// Client-authenticated discovery for Apps installed across many Servers. The
// authenticated client identity is the App boundary; callers never select a
// client and a miss does not disclose another App's installation.
oauthRouter.post("/installations/lookup", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const client = await requireOAuthClient(req, res);
    if (!client) return;
    const serverId = typeof req.body?.server_id === "string"
      ? req.body.server_id.trim()
      : typeof req.body?.serverId === "string"
        ? req.body.serverId.trim()
        : "";
    if (!serverId) {
      res.status(400).json({ error: "server_id is required" });
      return;
    }
    if (!UUID_RE.test(serverId)) {
      res.status(400).json({ error: "server_id must be a Server ID" });
      return;
    }

    const installation = await discoverActiveAppInstallation({
      clientId: client.id,
      serverId,
    });
    if (!installation) {
      res.status(404).json({ error: "Active installation not found" });
      return;
    }
    res.json({
      installation_id: installation.installationId,
      server_id: installation.serverId,
      setup: await getAppInstallationSetup({ clientId: client.id, serverId: installation.serverId }),
      // The App's bot here (null when it ships none). Read it again right
      // before showing `add_url` to a person; never store the link.
      bot: await readAppFacingInstallationBot({
        installationId: installation.installationId,
        clientId: client.id,
      }),
    });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to discover installation",
      logPrefix: "Discover app installation error:",
      err: error,
    });
  }
});

const BOT_TOKEN_REFUSALS: Record<ManagedAppBotCredentialRefusal, { status: number; error: string }> = {
  installation_not_found: { status: 404, error: "Active installation not found" },
  bot_not_granted: { status: 403, error: "Bot grant not active for this installation" },
  bot_not_active: { status: 404, error: "No active bot for this installation" },
  credential_exists: { status: 409, error: "The bot already has a live key; send rotate: true to replace it" },
};

// An App's own client credentials buy its managed Bot's
// `sk_agent_*` key on one installation. A user's or agent's OAuth access token
// is not accepted: the Bot's authority is the admin's per-installation bot
// grant, and a one-hour delegated token must not become a long-lived Bot key.
// The key is returned once; only its hash is stored.
oauthRouter.post("/installations/:installationId/bot-token", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const client = await requireOAuthClient(req, res);
    if (!client) return;
    const installationId = req.params.installationId;
    if (!UUID_RE.test(installationId)) {
      res.status(404).json({ error: BOT_TOKEN_REFUSALS.installation_not_found.error, code: "installation_not_found" });
      return;
    }
    const result = await issueManagedAppBotCredential({
      clientId: client.id,
      installationId,
      rotate: req.body?.rotate === true || req.body?.rotate === "true",
    });
    if (!result.ok) {
      const refusal = BOT_TOKEN_REFUSALS[result.reason];
      // bot_not_granted adds `state` (not_added, declined, installation_suspended) and `add_url`.
      res.status(refusal.status).json({ error: refusal.error, code: result.reason, ...("bot" in result ? result.bot : {}) });
      return;
    }
    res.json({
      credentialId: result.credentialId,
      apiKey: result.apiKey,
      agentId: result.agentId,
      scopes: result.scopes,
      rotated: result.rotated,
    });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to issue bot key",
      logPrefix: "Issue app bot key error:",
      err: error,
    });
  }
});

// P4b: the app publishes its managed Bot's status with the same client
// credentials that issue its key — Slack's App Home "what the bot is doing".
// The line renders on the Bot's identity card; NULL clears it. Presence is
// still never fabricated: this is app-published text, not a liveness signal.
const BOT_STATUS_MAX_LENGTH = 160;
oauthRouter.put("/installations/:installationId/bot-status", async (req, res) => {
  try {
    const client = await requireOAuthClient(req, res);
    if (!client) return;
    const installationId = req.params.installationId;
    if (!UUID_RE.test(installationId)) {
      res.status(404).json({ error: "Active installation not found" });
      return;
    }
    const { text } = req.body ?? {};
    if (text !== null && text !== undefined && (typeof text !== "string" || text.trim().length === 0 || text.length > BOT_STATUS_MAX_LENGTH)) {
      res.status(400).json({ error: "text must be null or a non-empty string up to 160 characters" });
      return;
    }
    const updated = await setManagedAppBotStatus({
      clientId: client.id,
      installationId,
      text: text == null ? null : (text as string).trim(),
    });
    if (!updated.ok) {
      if (updated.reason === "installation_not_found") {
        res.status(404).json({ error: "Active installation not found", code: updated.reason });
        return;
      }
      res.status(403).json({ error: "Bot grant not active for this installation", code: updated.reason, ...updated.bot });
      return;
    }
    broadcastAgentUpdated(req, updated.serverId, updated.agentId);
    res.json({ ok: true });
  } catch (error) {
    sendJsonServerError(req, res, {
      error: "Failed to set bot status",
      logPrefix: "Set app bot status error:",
      err: error,
    });
  }
});

// Completion comes from the authenticated App backend, never from a browser
// return URL. Installation IDs are identifiers and cannot authenticate a user.
oauthRouter.put("/installations/:installationId/setup", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const client = await requireOAuthClient(req, res);
    if (!client) return;
    const installationId = asAppSetupInstallationId(req.params.installationId);
    const { revision, status } = req.body ?? {};
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647
      || (status !== "pending" && status !== "complete")) {
      res.status(400).json({ error: "revision and status (pending or complete) are required" }); return;
    }
    const setup = await updateAppInstallationSetup({ clientId: client.id, installationId, revision, status });
    if (!setup) { res.status(404).json({ error: "Active installation not found" }); return; }
    res.json(setup);
  } catch (err) {
    if (err instanceof AppSetupValidationError) { res.status(400).json({ error: err.message }); return; }
    if (err instanceof AppSetupConflictError) { res.status(409).json({ error: err.message }); return; }
    sendJsonServerError(req, res, { error: "Failed to update App setup", logPrefix: "Update App setup error:", err });
  }
});

oauthRouter.put("/installations/:installationId/subscriptions", async (req, res) => {
  try {
    const client = await requireOAuthClient(req, res);
    if (!client) return;
    const updated = await updateAppInstallationSubscriptions({
      installationId: req.params.installationId,
      clientId: client.id,
      subscribedEvents: req.body?.events,
      actor: { type: "app", id: client.id },
    });
    if (!updated) {
      res.status(404).json({ error: "Active installation not found" });
      return;
    }
    res.json({
      installation_id: updated.id,
      subscribed_events: updated.subscribedEvents,
      subscription_revision: updated.subscriptionRevision,
    });
  } catch (error) {
    if (error instanceof AppOutboundPermissionError) {
      res.status(400).json({ error: error.message });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to update installation subscription",
      logPrefix: "Update app installation subscription error:",
      err: error,
    });
  }
});

// A human login the app is not available for on that Server (RFC 079 §5.6):
// the same bytes on the lookup and the continue, whether the client is
// unknown, the Server is outside its audience, or the person is not a member
// there. Nothing in it names, counts or hints at a Server (D4).
const APP_NOT_AVAILABLE_BODY = Object.freeze({
  error: "This app isn't available to you.",
  code: "app_not_available",
});

type HumanLoginAvailability =
  | { kind: "refused" }
  | { kind: "outside_audience"; role: ServerRole }
  | {
    kind: "suspended";
    role: ServerRole;
    client: Awaited<ReturnType<typeof oauthService.listSuspendedThirdPartyOAuthClients>>[number];
  }
  | {
    kind: "available";
    role: ServerRole;
    client: NonNullable<Awaited<ReturnType<typeof oauthService.getOAuthClientForServer>>>;
  };

/**
 * Membership, then audience, then suspension (RFC 079 L1); each is read only
 * when the one before it passed. A non-member is refused after one read,
 * whatever the client, so never learns whether an app is installed or
 * suspended there; for a member, an unknown client and one outside the
 * audience take the same reads.
 */
async function resolveHumanLoginAvailability(input: {
  clientKey: string;
  serverId: string;
  userId: string;
}): Promise<HumanLoginAvailability> {
  // Not a Server id: no one is a member of it.
  if (!UUID_RE.test(input.serverId)) return { kind: "refused" };
  const role = await getActorServerRoleInServer(input.serverId, "user", input.userId);
  if (!role) return { kind: "refused" };
  const client = await oauthService.getOAuthClientForServer({
    clientKey: input.clientKey,
    serverId: input.serverId,
  });
  if (client) return { kind: "available", role, client };
  const resolvedKey = await resolveOAuthClientByKey(input.clientKey);
  const suspended = (await oauthService.listSuspendedThirdPartyOAuthClients(input.serverId))
    .find((candidate) => candidate.id === resolvedKey?.id);
  if (suspended) return { kind: "suspended", role, client: suspended };
  return { kind: "outside_audience", role };
}

/** The setup page's lookup adds this to an account-mode App's answer (RFC 079 Q1); a server-mode answer is unchanged. */
const ACCOUNT_LOGIN_MODE_FIELD = Object.freeze({ loginMode: "account" as const });

/**
 * RFC 079 phase 3a: what the App's login mode makes of a Server-bound login
 * step the membership read let through (design §1 rows 3 and 4), read after
 * it (L1). "server": the App is in server mode (or unknown); today's answer.
 * "account": in account mode, the kill switch on for the person, no guest on
 * S (D7) and, with `inAudience`, S in the App's account-mode audience.
 * "refused": in account mode otherwise; the one refusal, the bytes a person
 * outside the audience gets, so neither the switch nor the mode shows.
 */
async function accountModeOnServer(input: {
  clientKey: string;
  serverId: string;
  userId: string;
  role: ServerRole;
  inAudience: boolean;
}): Promise<"server" | "account" | "refused"> {
  if ((await getOAuthClientLoginMode(input.clientKey)) !== "account") return "server";
  if (input.role === "guest" || !(await isAccountLoginEnabledFor(input.userId))) return "refused";
  if (input.inAudience && !(await isServerInAccountAudience(input))) return "refused";
  return "account";
}

oauthRouter.get("/clients/lookup", requireAuth, async (req, res) => {
  const clientId = typeof req.query.client_id === "string"
    ? req.query.client_id
    : typeof req.query.clientId === "string"
      ? req.query.clientId
      : "";
  const serverId = typeof req.query.server_id === "string"
    ? req.query.server_id
    : typeof req.query.serverId === "string"
      ? req.query.serverId
      : "";
  const requestedScopes = typeof req.query.scope === "string"
    ? req.query.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean)
    : [];

  if (!clientId.trim()) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  if (!serverId.trim()) {
    res.status(400).json({ error: "serverId is required" });
    return;
  }

  try {
    const availability = await resolveHumanLoginAvailability({
      clientKey: clientId,
      serverId,
      userId: req.userId!,
    });
    if (availability.kind === "refused") {
      res.status(403).json(APP_NOT_AVAILABLE_BODY);
      return;
    }
    if (availability.kind === "suspended") {
      // Installed here but suspended: say so to a member (the picker shows it
      // as unavailable), never offer an install, and never issue a code.
      const suspended = availability.client;
      const loginMode = await accountModeOnServer({
        clientKey: suspended.clientId,
        serverId,
        userId: req.userId!,
        role: availability.role,
        inAudience: false,
      });
      if (loginMode === "refused") {
        res.status(403).json(APP_NOT_AVAILABLE_BODY);
        return;
      }
      res.json({
        clientId: suspended.clientId,
        appType: suspended.appType,
        name: suspended.name,
        description: suspended.description,
        homepageUrl: suspended.homepageUrl,
        returnUrl: suspended.returnUrl,
        logoUrl: suspended.logoUrl,
        allowedScopes: suspended.allowedScopes,
        availability: "suspended",
        ...(loginMode === "account" ? ACCOUNT_LOGIN_MODE_FIELD : {}),
      });
      return;
    }
    const publicClients = availability.kind === "outside_audience" || availability.client.appType === "third_party_global"
      ? await oauthService.listPublicMarketplaceOAuthClients()
      : [];
    const resolvedMarketplaceKey = publicClients.length > 0 ? await resolveOAuthClientByKey(clientId) : null;
    const marketplaceClient = publicClients.find((candidate) => (
      candidate.id === clientId || candidate.id === resolvedMarketplaceKey?.id
    ));
    if (availability.kind === "outside_audience") {
      // Outside the audience: only a public Marketplace app gets an answer
      // other than the refusal (install inline, D5).
      if (!marketplaceClient) {
        res.status(403).json(APP_NOT_AVAILABLE_BODY);
        return;
      }
      const loginMode = await accountModeOnServer({
        clientKey: marketplaceClient.clientId,
        serverId,
        userId: req.userId!,
        role: availability.role,
        inAudience: false,
      });
      if (loginMode === "refused") {
        res.status(403).json(APP_NOT_AVAILABLE_BODY);
        return;
      }
      const scopeValidation = requestedScopes.length > 0
        ? oauthService.validateOAuthScopesForClient(requestedScopes, marketplaceClient)
        : null;
      res.json({
        id: marketplaceClient.id,
        clientId: marketplaceClient.clientId,
        appType: marketplaceClient.appType,
        name: marketplaceClient.name,
        description: marketplaceClient.description,
        homepageUrl: marketplaceClient.homepageUrl,
        returnUrl: marketplaceClient.returnUrl,
        logoUrl: marketplaceClient.logoUrl,
        setupUrl: marketplaceClient.setupUrl,
        setupDescription: marketplaceClient.setupDescription,
        allowedScopes: marketplaceClient.allowedScopes,
        // Installing from this page approves these with the login scopes,
        // and confirms this prompt-text revision (task #4).
        appNotificationGroups: marketplaceClient.appNotificationGroups,
        promptTextRevisionId: marketplaceClient.promptTextRevisionId,
        marketplace: true,
        availability: "install_required",
        installation: {
          serverId,
          canInstall: availability.role === "owner" || availability.role === "admin",
        },
        // The App ships a bot: the page's install offers "Also add @handle"
        // and sends `bot`, as Settings > Apps does. Not installed here, so the
        // handle is the one a grant would take.
        ...(marketplaceClient.enableBot ? { bot: { handle: deriveAppBotHandle(marketplaceClient.clientId) } } : {}),
        ...(scopeValidation ? { scopeValidation } : {}),
        ...(loginMode === "account" ? ACCOUNT_LOGIN_MODE_FIELD : {}),
      });
      return;
    }

    const { client } = availability;
    // An account-mode App is ready only where its account-mode audience holds
    // the person (no guest, the App enabled): where POST /authorize/account
    // would let them in.
    const loginMode = await accountModeOnServer({
      clientKey: client.clientId,
      serverId,
      userId: req.userId!,
      role: availability.role,
      inAudience: true,
    });
    if (loginMode === "refused") {
      res.status(403).json(APP_NOT_AVAILABLE_BODY);
      return;
    }
    const scopeValidation = requestedScopes.length > 0
      ? oauthService.validateOAuthScopesForClient(requestedScopes, client)
      : null;

    res.json({
      clientId: client.clientId,
      appType: client.appType,
      name: client.name,
      description: client.description,
      homepageUrl: client.homepageUrl,
      returnUrl: client.returnUrl,
      logoUrl: client.logoUrl,
      setupUrl: client.setupUrl,
      setupDescription: client.setupDescription,
      allowedScopes: client.allowedScopes,
      marketplace: marketplaceClient ? true : undefined,
      availability: "ready",
      ...(scopeValidation ? { scopeValidation } : {}),
      ...(loginMode === "account" ? ACCOUNT_LOGIN_MODE_FIELD : {}),
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load OAuth client",
      logPrefix: "Lookup OAuth client error:",
      err,
    });
  }
});

oauthRouter.post("/requests/agent", async (req, res) => {
  const span = startOAuthSpan(req, "server.oauth.agent_request.create", {
    client_credentials_present: Boolean(parseClientCredentials(req)),
    server_slug_present: typeof req.body?.serverSlug === "string" && Boolean(req.body.serverSlug.trim()),
    agent_name_present: typeof req.body?.agentName === "string" && Boolean(req.body.agentName.trim()),
    requested_scope_count: requestedScopeCount(req.body?.scopes),
    agent_inbound_scope_present: requestedAgentInboundScopePresent(req.body?.scopes),
  });
  const client = await requireOAuthClient(req, res);
  if (!client) {
    await recordOAuthLifecycle({
      stage: "authorization",
      result: "client_auth_failed",
      outcome: "failure",
      clientKey: auditClientKey(parseClientCredentials(req)?.clientId),
      grantType: "agent_request",
      principalType: "agent",
    });
    finishOAuthSpan(span, "ok", { outcome: "client_auth_failed", http_status: 401 });
    return;
  }

  try {
    const { serverSlug, agentName, agentId, scopes } = req.body ?? {};
    // `agentId` (stable across renames) wins over `agentName` when both are sent.
    if (agentId !== undefined && (typeof agentId !== "string" || !UUID_RE.test(agentId))) {
      throw new Error("Agent not found");
    }
    const result = await oauthService.requestAgentAccess({
      clientId: client.id,
      serverSlug,
      agentName,
      agentId: agentId?.toLowerCase(),
      scopes,
    });
    await recordOAuthLifecycle({
      stage: "authorization",
      result: result.status === "approved" ? "issued" : "authorization_pending",
      outcome: "success",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: "agent_request",
      principalType: "agent",
    });
    res.json({
      requestId: result.request.id,
      status: result.status,
      client: {
        clientId: client.clientId,
        appType: client.appType,
        name: result.client.name,
        description: result.client.description,
        homepageUrl: result.client.homepageUrl,
      },
      agent: {
        id: result.agent.agentId,
        name: result.agent.agentName,
        displayName: result.agent.agentDisplayName,
        serverId: result.agent.serverId,
        serverSlug: result.agent.serverSlug,
      },
      scopes: result.request.scopes ?? [],
    });
    finishOAuthSpan(span, "ok", {
      outcome: result.status,
      http_status: 200,
      grant_status: result.grantStatus,
      scope_count: result.request.scopes?.length ?? 0,
      agent_inbound_scope_present: requestedAgentInboundScopePresent(result.request.scopes),
    });
  } catch (err: any) {
    const message = err?.message || "Failed to request agent access";
    await recordOAuthLifecycle({
      stage: "authorization",
      result: authorizationLifecycleResult(message),
      outcome: "failure",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: "agent_request",
      principalType: "agent",
    });
    if (err instanceof oauthService.OAuthInstallationSuspendedError) {
      finishOAuthSpan(span, "ok", { outcome: "installation_suspended", http_status: 403, error_class: errorClass(err) });
      res.status(403).json({
        error: "installation_suspended",
        error_description: "This App's installation on the agent's Server is suspended. A Server owner or admin must restore it first.",
      });
      return;
    }
    if (message.includes("not found") || message.includes("server")) {
      finishOAuthSpan(span, "ok", { outcome: "not_found", http_status: 404, error_class: errorClass(err) });
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes("scope") || message.includes("required")) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_request", http_status: 400, error_class: errorClass(err) });
      res.status(400).json({ error: message });
      return;
    }
    console.error("Request agent access error:", err);
    finishOAuthSpan(span, "error", { outcome: "error", http_status: 500, error_class: errorClass(err) });
    res.status(500).json({ error: "Failed to request agent access" });
  }
});

/** A requested scope the App may not ask for, or Raft does not support: the continue's 400, for the human and the account-mode login alike. */
function sendOAuthScopeNotAllowed(res: Response, err: oauthService.OAuthScopeNotAllowedError) {
  const { reason, disallowedScopes } = err.validation;
  const scopeList = disallowedScopes.join(", ");
  const errorCode = reason === "unsupported"
    ? "OAUTH_SCOPE_UNSUPPORTED"
    : reason === "not_allowed"
      ? "OAUTH_SCOPE_NOT_ALLOWED"
      : "OAUTH_SCOPE_INVALID";
  const errorDescription = reason === "unsupported"
    ? `Raft does not support the requested OAuth scope: ${scopeList}. Update the requested scopes and try again.`
    : reason === "not_allowed"
      ? `This OAuth client is not allowed to request: ${scopeList}. Update the client's allowed scopes and try again.`
      : `Some requested OAuth scopes are unsupported or not allowed for this client: ${scopeList}. Update the requested scopes or client permissions and try again.`;
  res.status(400).json({
    error: "invalid_scope",
    errorCode,
    error_description: errorDescription,
    disallowedScopes,
  });
}

/**
 * RFC 079 phase 3a: the continue of a setup page opened before its App
 * switched to account mode. Only sent where the account-mode login is open to
 * the person (design §1 row 4); the page looks the App up again.
 */
const LOGIN_MODE_CHANGED_BODY = Object.freeze({
  error: "This app now signs you in with your Raft account. Reload this page to continue.",
  code: "login_mode_changed",
});

oauthRouter.post("/authorize/human", requireAuth, async (req, res) => {
  const {
    clientId,
    serverId,
    returnUrl,
    scopes,
    oidc,
    nonce,
    codeChallenge,
    codeChallengeMethod,
    server: serverHint,
  } = req.body ?? {};
  if (typeof clientId !== "string" || !clientId.trim()) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  if (typeof serverId !== "string" || !serverId.trim()) {
    await recordOAuthLifecycle({
      stage: "authorization",
      result: "invalid_request",
      outcome: "failure",
      clientKey: auditClientKey(clientId),
      grantType: "authorization_code",
      principalType: "human",
    });
    res.status(400).json({ error: "serverId is required" });
    return;
  }
  if (oidc === true) {
    if (typeof returnUrl !== "string" || !returnUrl.trim()) {
      res.status(400).json({ error: "returnUrl is required for OIDC authorization" });
      return;
    }
    if (nonce !== undefined && (typeof nonce !== "string" || nonce.length > 512)) {
      res.status(400).json({ error: "nonce must be a string no longer than 512 characters" });
      return;
    }
    if (codeChallenge !== undefined && (
      typeof codeChallenge !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
      || codeChallengeMethod !== "S256"
    )) {
      res.status(400).json({ error: "OIDC PKCE requires a valid S256 code challenge" });
      return;
    }
    if (codeChallenge === undefined && codeChallengeMethod !== undefined) {
      res.status(400).json({ error: "codeChallenge is required when codeChallengeMethod is set" });
      return;
    }
  }

  try {
    // Issuing an app a code for this person needs a verified sign-in when
    // their two-step verification is on (the same check as approving a login).
    if (await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), "Confirm it's you with your second step before signing in to this app.")) return;
    // Before anything else reads the Server or the app (RFC 079 L1).
    const availability = await resolveHumanLoginAvailability({
      clientKey: clientId,
      serverId,
      userId: req.userId!,
    });
    // RFC 079 phase 3a: an App in account mode takes no Server-bound login
    // (design §1 row 4). A page opened before the switch is told to reload
    // (409), only where the account-mode login is open to the person on S
    // (audience, no guest, the kill switch on); anywhere else the one
    // refusal. Before any write: the database refuses a Server-bound code for
    // it (migration 0560, rule (b)).
    if (availability.kind === "available" || availability.kind === "suspended") {
      const loginMode = await accountModeOnServer({
        clientKey: availability.client.clientId,
        serverId,
        userId: req.userId!,
        role: availability.role,
        inAudience: true,
      });
      if (loginMode === "account") throw new OAuthLoginModeChangedError();
      if (loginMode === "refused") throw new oauthService.OAuthAppNotAvailableError();
    }
    if (availability.kind === "suspended") throw new oauthService.OAuthInstallationSuspendedError();
    // The continue never installs, so a public Marketplace app not installed
    // here is refused like any other app outside the audience.
    if (availability.kind !== "available") throw new oauthService.OAuthAppNotAvailableError();
    if (oidc === true) {
      if (serverHint !== undefined) {
        if (typeof serverHint !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(serverHint)) {
          throw new Error("server must be a Server ID or slug");
        }
        const hintedServer = await getServer(serverId);
        if (!hintedServer || (serverHint !== hintedServer.id && serverHint !== hintedServer.slug)) {
          throw new Error("server does not match the selected Server");
        }
      }
      const registeredClient = availability.client;
      if (!registeredClient.returnUrl || registeredClient.returnUrl !== returnUrl.trim()) {
        throw new Error("returnUrl does not match registered OAuth client");
      }
    }
    const result = await oauthService.issueHumanAuthorizationCode({
      clientKey: clientId,
      userId: req.userId!,
      serverId,
      returnUrl,
      scopes,
      approverSessionFamilyId: webSessionFamilyOf(req),
    });

    const authorizationCode = oidc === true
      ? encodeOidcAuthorizationCode({
          requestId: result.code,
          clientId: clientId.trim(),
          redirectUri: result.returnUrl || returnUrl,
          ...(typeof nonce === "string" && nonce ? { nonce } : {}),
          ...(typeof codeChallenge === "string" && codeChallenge
            ? { codeChallenge, codeChallengeMethod: "S256" as const }
            : {}),
        })
      : result.code;

    res.json({
      code: authorizationCode,
      client: {
        clientId: result.client.clientId,
        appType: result.client.appType,
        name: result.client.name,
        description: result.client.description,
        homepageUrl: result.client.homepageUrl,
      },
      server: result.server,
      scopes: result.scopes,
      returnUrl: result.returnUrl,
    });
  } catch (err: any) {
    const message = err?.message || "Failed to issue Login with Raft code";
    await recordOAuthLifecycle({
      stage: "authorization",
      result: authorizationLifecycleResult(message),
      outcome: "failure",
      clientKey: auditClientKey(clientId),
      grantType: "authorization_code",
      principalType: "human",
    });
    if (err instanceof oauthService.OAuthAppNotAvailableError) {
      res.status(403).json(APP_NOT_AVAILABLE_BODY);
      return;
    }
    if (err instanceof OAuthLoginModeChangedError) {
      res.status(409).json(LOGIN_MODE_CHANGED_BODY);
      return;
    }
    if (err instanceof oauthService.OAuthInstallationSuspendedError) {
      res.status(403).json({
        error: "installation_suspended",
        errorCode: "OAUTH_INSTALLATION_SUSPENDED",
        error_description: "This App's installation on the selected Server is suspended. Ask a Server owner or admin, or choose another Server.",
      });
      return;
    }
    if (err instanceof oauthService.OAuthScopeNotApprovedError) {
      // Sent back to the app (RFC 6749 §4.1.2.1), not shown on Raft: the
      // setup page redirects to `returnUrl`, the registered URL that
      // issueHumanAuthorizationCode already matched, with error and state.
      const scopeList = err.unapprovedScopes.join(", ");
      res.status(400).json({
        error: "invalid_scope",
        errorCode: "OAUTH_SCOPE_NOT_APPROVED",
        error_description: scopeList
          ? `This Server's admin has not approved these scopes for the app: ${scopeList}.`
          : "This Server's admin has not approved any of the requested scopes for the app.",
        unapprovedScopes: err.unapprovedScopes,
        returnUrl: err.returnUrl,
      });
      return;
    }
    if (err instanceof oauthService.OAuthScopeNotAllowedError) {
      sendOAuthScopeNotAllowed(res, err);
      return;
    }
    if (
      message.includes("returnUrl")
      || message.includes("scope")
      || message.includes("required")
      || message.includes("server does not match")
      || message.includes("server must be")
    ) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to issue Login with Raft code",
      logPrefix: "Human authorization code error:",
      err,
    });
  }
});

// RFC 079 phase 3a, account mode: past the audience check, an App whose
// installations on every one of the person's (non-guest) Servers are
// suspended (Q4), and a Server-scoped issuer's page (D21).
const ACCOUNT_INSTALLATION_SUSPENDED_BODY = Object.freeze({
  error: "installation_suspended",
  errorCode: "OAUTH_INSTALLATION_SUSPENDED",
  error_description: "This App's installations on your Servers are suspended. Ask a Server owner or admin to restore it.",
});
const ROOT_ISSUER_REQUIRED_BODY = Object.freeze({ error: "invalid_request", code: "root_issuer_required" });

// RFC 079 phase 3a: an account-mode Login with Raft (design §3.1 step 2), a
// code for the person's login to the App that names no Server. Root mount
// only: it is not in OIDC_SCOPED_ROUTES, so a Server-scoped issuer answers 404
// (D21). Every refusal that could tell Apps apart is APP_NOT_AVAILABLE_BODY
// (D4/D11): an unknown App, one in server mode, a person outside its audience
// or a guest only, the kill switch off. root_issuer_required, the return URL
// and the scopes answer only past that check.
oauthRouter.post("/authorize/account", requireAuth, async (req, res) => {
  const {
    clientId,
    returnUrl,
    scopes,
    oidc,
    nonce,
    codeChallenge,
    codeChallengeMethod,
  } = req.body ?? {};
  // Sent at all, whatever its value: only a Server-scoped issuer's page sends it.
  const serverHinted = req.body?.server !== undefined;
  if (typeof clientId !== "string" || !clientId.trim()) {
    res.status(400).json({ error: "clientId is required" });
    return;
  }
  if (typeof returnUrl !== "string" || !returnUrl.trim()) {
    res.status(400).json({ error: "returnUrl is required" });
    return;
  }
  if (oidc === true) {
    if (nonce !== undefined && (typeof nonce !== "string" || nonce.length > 512)) {
      res.status(400).json({ error: "nonce must be a string no longer than 512 characters" });
      return;
    }
    if (codeChallenge !== undefined && (
      typeof codeChallenge !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)
      || codeChallengeMethod !== "S256"
    )) {
      res.status(400).json({ error: "OIDC PKCE requires a valid S256 code challenge" });
      return;
    }
    if (codeChallenge === undefined && codeChallengeMethod !== undefined) {
      res.status(400).json({ error: "codeChallenge is required when codeChallengeMethod is set" });
      return;
    }
  }

  try {
    // As /authorize/human: issuing an app a code for this person needs a
    // verified sign-in when their two-step verification is on.
    if (await refuseUnverifiedApprover(res, req.userId!, webSessionFamilyOf(req), "Confirm it's you with your second step before signing in to this app.")) return;
    const result = await issueAccountAuthorizationCode({
      clientKey: clientId,
      userId: req.userId!,
      returnUrl,
      scopes,
      serverHinted,
      approverSessionFamilyId: webSessionFamilyOf(req),
    });
    const authorizationCode = oidc === true
      ? encodeOidcAuthorizationCode({
          requestId: result.code,
          clientId: clientId.trim(),
          redirectUri: result.returnUrl,
          ...(typeof nonce === "string" && nonce ? { nonce } : {}),
          ...(typeof codeChallenge === "string" && codeChallenge
            ? { codeChallenge, codeChallengeMethod: "S256" as const }
            : {}),
        })
      : result.code;
    res.json({
      code: authorizationCode,
      client: result.client,
      scopes: result.scopes,
      returnUrl: result.returnUrl,
    });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : "Failed to issue Login with Raft code";
    await recordOAuthLifecycle({
      stage: "authorization",
      result: authorizationLifecycleResult(message),
      outcome: "failure",
      clientKey: auditClientKey(clientId),
      grantType: "authorization_code",
      principalType: "human",
    });
    if (err instanceof oauthService.OAuthAppNotAvailableError) {
      res.status(403).json(APP_NOT_AVAILABLE_BODY);
      return;
    }
    if (err instanceof oauthService.OAuthInstallationSuspendedError) {
      res.status(403).json(ACCOUNT_INSTALLATION_SUSPENDED_BODY);
      return;
    }
    if (err instanceof OAuthRootIssuerRequiredError) {
      res.status(400).json(ROOT_ISSUER_REQUIRED_BODY);
      return;
    }
    if (err instanceof oauthService.OAuthScopeNotApprovedError) {
      // Sent back to the app at its registered URL, as /authorize/human's;
      // the account-mode wording names no Server.
      const scopeList = err.unapprovedScopes.join(", ");
      res.status(400).json({
        error: "invalid_scope",
        errorCode: "OAUTH_SCOPE_NOT_APPROVED",
        error_description: scopeList
          ? `No Server where you can use this app has approved: ${scopeList}.`
          : "No Server where you can use this app has approved any of the requested scopes.",
        unapprovedScopes: err.unapprovedScopes,
        returnUrl: err.returnUrl,
      });
      return;
    }
    if (err instanceof oauthService.OAuthScopeNotAllowedError) {
      sendOAuthScopeNotAllowed(res, err);
      return;
    }
    if (message.includes("returnUrl") || message.includes("scope") || message.includes("required")) {
      res.status(400).json({ error: message });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to issue Login with Raft code",
      logPrefix: "Account authorization code error:",
      err,
    });
  }
});

oauthRouter.post("/token", async (req, res) => {
  // The mount path decides which issuer this token claims. Validated here so a
  // malformed segment is rejected outright rather than silently widening `iss`
  // to the unscoped issuer.
  const tokenServerScope = pathServerScope(req);
  if (tokenServerScope !== undefined && !OIDC_SERVER_SEGMENT_PATTERN.test(tokenServerScope)) {
    oidcJsonError(res, "invalid_request", "server must be a Server ID or slug");
    return;
  }
  const requestedGrantType = typeof req.body?.grantType === "string" ? req.body.grantType : typeof req.body?.grant_type === "string" ? req.body.grant_type : "";
  const presentedClientId = parseClientCredentials(req)?.clientId ?? "";
  const span = startOAuthSpan(req, "server.oauth.token.exchange", {
    client_credentials_present: Boolean(parseClientCredentials(req)),
    grant_type: grantTypeAttr(requestedGrantType),
    request_present: Boolean(req.body?.code || req.body?.requestId || req.body?.request_id),
    resource_present: Boolean(req.body?.resource),
  });
  const client = await requireOAuthClient(req, res);
  if (!client) {
    await recordOAuthLifecycle({
      stage: "token_exchange",
      result: "client_auth_failed",
      outcome: "failure",
      clientKey: auditClientKey(parseClientCredentials(req)?.clientId),
      grantType: grantTypeAttr(requestedGrantType),
    });
    finishOAuthSpan(span, "ok", { outcome: "client_auth_failed", http_status: 401 });
    return;
  }

  if (requestedGrantType !== "authorization_code" && requestedGrantType !== "urn:slock:grant-type:agent_request") {
    await recordOAuthLifecycle({
      stage: "token_exchange",
      result: "unsupported_grant_type",
      outcome: "failure",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: grantTypeAttr(requestedGrantType),
    });
    finishOAuthSpan(span, "ok", { outcome: "unsupported_grant_type", http_status: 400 });
    res.status(400).json({ error: "Unsupported grant type" });
    return;
  }

  const grantType = requestedGrantType;
  let requestId = grantType === "authorization_code"
    ? typeof req.body?.code === "string" ? req.body.code : ""
    : typeof req.body?.requestId === "string" ? req.body.requestId : typeof req.body?.request_id === "string" ? req.body.request_id : "";
  if (!requestId) {
    await recordOAuthLifecycle({
      stage: "token_exchange",
      result: "missing_request",
      outcome: "failure",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: grantTypeAttr(grantType),
    });
    finishOAuthSpan(span, "ok", { outcome: "missing_request", http_status: 400, grant_type: grantType });
    res.status(400).json({ error: grantType === "authorization_code" ? "code is required" : "requestId is required" });
    return;
  }

  let oidcContext: OidcAuthorizationContext | null = null;
  try {
    if (grantType === "authorization_code") {
      oidcContext = decodeOidcAuthorizationCode(requestId);
    }
    // RFC 084 §4: a code issued before a rename stays valid when the App
    // exchanges it under its other id; the secret was checked on `client`.
    const codeClientKey = oidcContext && oidcContext.clientId !== presentedClientId
      && (await resolveOAuthClientByKey(oidcContext.clientId))?.id === client.id
      ? oidcContext.clientId : presentedClientId;
    // All accepted code shapes share the downgrade check, including legacy
    // human/Agent UUIDs and the agent_request grant, which have no challenge.
    validateOidcAuthorizationCode({
      context: oidcContext,
      clientId: codeClientKey,
      redirectUri: req.body?.redirect_uri,
      codeVerifier: req.body?.code_verifier,
    });
    if (oidcContext) requestId = oidcContext.requestId;
  } catch {
    await recordOAuthLifecycle({
      stage: "token_exchange",
      result: "invalid_request",
      outcome: "failure",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: grantTypeAttr(grantType),
    });
    finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
    oidcJsonError(res, "invalid_grant", "The authorization code, redirect URI, or PKCE verifier is invalid");
    return;
  }

  // Both legacy authorization codes and agent access requests resolve to the
  // UUID primary key on oauth_access_requests. Reject malformed values before
  // Drizzle binds them to PostgreSQL's uuid type: otherwise a caller-controlled
  // string becomes a driver error and the token endpoint returns a 500 with the
  // generated SELECT instead of a bounded OAuth error.
  if (!UUID_RE.test(requestId)) {
    await recordOAuthLifecycle({
      stage: "token_exchange",
      result: "invalid_request",
      outcome: "failure",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: grantTypeAttr(grantType),
      principalType: grantType === "authorization_code" ? "human" : "agent",
    });
    finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
    oidcJsonError(res, "invalid_grant", "The authorization request is invalid or has expired");
    return;
  }

  try {
    const exchanged = await oauthService.exchangeAccessRequest({
      clientId: client.id,
      requestId,
      codeVerifier: req.body?.agent_handoff_verifier,
      resource: req.body?.resource,
      requireServerBound: tokenServerScope !== undefined,
    });
    const expiresIn = Math.max(
      1,
      Math.floor((exchanged.expiresAt.getTime() - currentDate().getTime()) / 1000),
    );
    // RFC 079 phase 3a: an account-mode login (design §3.1 step 3). Only the
    // root issuer gets here (requireServerBound refuses it on a Server-scoped
    // one, D21), so `iss` is the root's. An hour at most, no refresh token
    // (D15); the ID token is server mode's without the server claims.
    if ("mode" in exchanged) {
      const account = exchanged.identity;
      const idToken = account
        ? signOidcAccountIdToken({
            issuer: oidcIssuer(),
            identity: {
              sub: account.humanId,
              // RFC 084 §4: the id the App presented, not the current one.
              clientId: oidcContext?.clientId ?? presentedClientId,
              scopes: account.scopes,
              type: "human",
              name: account.humanDisplayName || account.humanName,
              preferredUsername: account.humanName,
              picture: userinfoHumanPictureUrl(account.humanAvatarUrl, req),
              email: account.humanEmail,
              emailVerified: account.humanEmailVerified,
            },
            nonce: oidcContext?.nonce,
            expiresInSeconds: expiresIn,
          })
        : null;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        access_token: exchanged.accessToken,
        token_type: "Bearer",
        expires_in: expiresIn,
        scope: exchanged.scopes.join(" "),
        ...(idToken ? { id_token: idToken } : {}),
      });
      finishOAuthSpan(span, "ok", {
        outcome: "issued",
        http_status: 200,
        grant_type: grantType,
        principal_type: "human",
        scope_count: exchanged.scopes.length,
        resource_bound: false,
        grant_bound: false,
      });
      return;
    }
    const identity = exchanged.identity;
    // A server-scoped token endpoint must only mint for a grant that belongs to
    // that server. The path decides `iss`, so without this check a client could
    // exchange a code at /oidc/<other>/api/oauth/token and receive a token whose
    // issuer names one Server while `server_id` names another. The client's own
    // `server_id` is not the right comparison: installed third-party apps
    // authorize on servers other than the one they were registered on, so the
    // grant's identity is the source of truth. Checked after the exchange
    // because that is where the grant's server is known; the minted token is
    // never returned, so rejecting here fails closed.
    if (tokenServerScope !== undefined) {
      const scopeMatchesGrant = identity != null
        && (tokenServerScope === identity.serverId || tokenServerScope === identity.serverSlug);
      if (!scopeMatchesGrant) {
        // Lifecycle results are a closed telemetry set with no grant-mismatch
        // member; `invalid_request` is the nearest existing value, so the
        // contract is not widened here. The client still gets `invalid_grant`.
        await recordOAuthLifecycle({
          stage: "token_exchange",
          result: "invalid_request",
          outcome: "failure",
          clientId: client.id,
          clientKey: client.clientId,
          grantType: grantTypeAttr(grantType),
          principalType: grantType === "authorization_code" ? "human" : "agent",
        });
        finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
        oidcJsonError(res, "invalid_grant", "The authorization was granted for a different Server than this issuer");
        return;
      }
    }
    const idToken = identity
      ? signOidcIdToken({
          // `iss` must equal the issuer of the discovery document this client
          // was configured from, or verification fails on their side. The mount
          // path is exactly that signal: a token requested at
          // /oidc/<server>/api/oauth/token gets the matching scoped issuer,
          // and an unscoped request keeps the legacy issuer.
          issuer: oidcIssuer(undefined, tokenServerScope),
          identity: {
            sub: identity.principalType === "human" ? identity.humanId! : identity.agentId!,
            clientId: oidcContext?.clientId ?? presentedClientId,
            scopes: identity.scopes ?? [],
            type: identity.principalType,
            serverId: identity.serverId,
            serverSlug: identity.serverSlug,
            serverRole: identity.principalType === "human" ? identity.humanRole! : identity.agentRole!,
            name: identity.principalType === "human"
              ? identity.humanDisplayName || identity.humanName
              : identity.agentDisplayName || identity.agentName,
            preferredUsername: identity.principalType === "human" ? identity.humanName : identity.agentName,
            picture: identity.principalType === "human"
              ? userinfoHumanPictureUrl(identity.humanAvatarUrl, req)
              : userinfoAgentPictureUrl(identity.agentAvatarUrl, req),
            email: identity.principalType === "human" ? identity.humanEmail : null,
            emailVerified: identity.principalType === "human" ? identity.humanEmailVerified : null,
          },
          nonce: oidcContext?.nonce,
          expiresInSeconds: expiresIn,
        })
      : null;

    res.setHeader("Cache-Control", "no-store");
    res.json({
      access_token: exchanged.accessToken,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: exchanged.scopes.join(" "),
      ...(idToken ? { id_token: idToken } : {}),
      ...(exchanged.resource ? { resource: exchanged.resource } : {}),
    });
    finishOAuthSpan(span, "ok", {
      outcome: "issued",
      http_status: 200,
      grant_type: grantType,
      principal_type: exchanged.token.principalType,
      scope_count: exchanged.scopes.length,
      resource_bound: Boolean(exchanged.resource),
      grant_bound: Boolean(exchanged.token.grantId),
    });
  } catch (err: any) {
    // D21: an account-mode code at a Server-scoped issuer gets the answer of a
    // grant for another Server, recorded as that one is. Refused before the
    // exchange wrote anything, so the code still works at the root issuer.
    if (err instanceof OAuthGrantNotServerBoundError) {
      await recordOAuthLifecycle({
        stage: "token_exchange",
        result: "invalid_request",
        outcome: "failure",
        clientId: client.id,
        clientKey: client.clientId,
        grantType: grantTypeAttr(grantType),
        principalType: "human",
      });
      finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "The authorization was granted for a different Server than this issuer");
      return;
    }
    const message = err?.message || "Failed to exchange access request";
    const lifecycleResult = tokenExchangeLifecycleResult(message);
    const auditRequestId = hashedOAuthRequestIdForAudit(requestId);
    const context = await oauthService.getOAuthAccessRequestAuditContext({
      clientId: client.id,
      requestId,
    }).catch(() => null);
    const legacyAuditErrorCode = lifecycleResult === "internal_error" ? "internal_error" : message;
    await recordOAuthLifecycle({
      stage: "token_exchange",
      result: lifecycleResult,
      outcome: "failure",
      clientId: client.id,
      clientKey: client.clientId,
      grantType: grantTypeAttr(grantType),
    });
    await integrationAuditService.recordIntegrationAuditEventBestEffort({
      serverId: context?.serverId ?? null,
      clientId: context?.clientId ?? client.id,
      eventType: "oauth.token_exchange_failed",
      outcome: "failure",
      source: "api",
      actor: { type: "system" },
      requester: context
        ? { type: context.principalType === "human" ? "human" : "agent", id: context.userId ?? context.agentId ?? null }
        : { type: "app", id: client.id },
      subject: context
        ? { type: context.principalType === "human" ? "human" : "agent", id: context.userId ?? context.agentId ?? null }
        : null,
      target: { type: "oauth_access_request", id: null },
      correlationId: auditRequestId,
      requestId: auditRequestId,
      metadata: {
        clientKey: client.clientId,
        grantType,
        errorCode: legacyAuditErrorCode,
        requestIdHash: auditRequestId,
      },
    });
    // RFC 079 phase 3a (Q3): a person's Server-bound code issued before its
    // App switched to account mode is dead, whatever its shape: a dead code's
    // invalid_grant.
    if (err instanceof OAuthLoginModeChangedError) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "The authorization code is invalid, expired, or has already been used");
      return;
    }
    if (
      oidcContext
      && (
        message === "request_already_consumed"
        || message === oauthService.AUTHORIZATION_CODE_EXPIRED_ERROR
        || message === oauthService.AGENT_REQUEST_EXPIRED_ERROR
        || message.includes("not found")
      )
    ) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "The authorization code is invalid, expired, or has already been used");
      return;
    }
    if (err instanceof oauthService.OAuthInstallationSuspendedError) {
      finishOAuthSpan(span, "ok", { outcome: "installation_suspended", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "This App's installation on the Server is suspended; the authorization can no longer be exchanged");
      return;
    }
    if (message === "authorization_pending") {
      finishOAuthSpan(span, "ok", { outcome: "authorization_pending", http_status: 400, grant_type: grantType });
      res.status(400).json({ error: "authorization_pending" });
      return;
    }
    if (message === "access_denied") {
      finishOAuthSpan(span, "ok", { outcome: "access_denied", http_status: 403, grant_type: grantType });
      res.status(403).json({ error: "access_denied" });
      return;
    }
    if (message === "request_already_consumed") {
      finishOAuthSpan(span, "ok", { outcome: "request_already_consumed", http_status: 409, grant_type: grantType });
      res.status(409).json({
        error: message,
        error_description:
          "This Login with Raft request is one-time and has already been exchanged. Discard it and obtain a fresh request before retrying.",
        next_action: "obtain_fresh_request",
      });
      return;
    }
    if (message === oauthService.AGENT_REQUEST_EXPIRED_ERROR) {
      finishOAuthSpan(span, "ok", { outcome: "agent_request_expired", http_status: 400, grant_type: grantType });
      // refusal-ok: OAuth token endpoint keeps its OAuth error envelope.
      res.status(400).json({
        error: message,
        error_description: "This Agent Login request has expired. Obtain a fresh request before retrying.",
        next_action: "obtain_fresh_request",
      });
      return;
    }
    if (message === oauthService.AUTHORIZATION_CODE_EXPIRED_ERROR) {
      finishOAuthSpan(span, "ok", { outcome: "authorization_code_expired", http_status: 400, grant_type: grantType });
      res.status(400).json({
        error: message,
        error_description:
          "This Login with Raft authorization code has expired. Obtain a fresh human authorization before retrying.",
        next_action: "obtain_fresh_authorization",
      });
      return;
    }
    if (message === "openid_identity_unavailable") {
      finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "The authorization identity is no longer available");
      return;
    }
    if (message.includes("not found")) {
      finishOAuthSpan(span, "ok", { outcome: "not_found", http_status: 404, grant_type: grantType, error_class: errorClass(err) });
      res.status(404).json({ error: message });
      return;
    }
    if (message.includes("resource")) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_resource", http_status: 400, grant_type: grantType, error_class: errorClass(err) });
      res.status(400).json({ error: message });
      return;
    }
    const loggedErrorClass = safeErrorClass(err);
    console.error("[oauth] token_exchange_unexpected_error", { errorClass: loggedErrorClass });
    finishOAuthSpan(span, "error", { outcome: "error", http_status: 500, grant_type: grantType, error_class: loggedErrorClass });
    res.status(500).json({ error: "Failed to issue access token" });
  }
});

/** Told to an app whose agent event carries a payload (docs/raft-app/agent-events.md). */
const THIRD_PARTY_EVENT_PAYLOAD_WARNING = "payload is deprecated: agents see only the summary, and see the payload only if they read this event. Put what the agent needs in summary; payload will be removed.";

/** RFC 081 D7/D11: told to an app whose agent event has no `object.ref`. */
function thirdPartyEventObjectRefWarning(clientKey: string): string {
  return `object.ref is missing: this notice goes into the app's catch-all item app:${clientKey}. Send object.ref (the thing it is about, e.g. a PR) so notices about one object are read together.`;
}

/** RFC 081 D8: told to an app whose `object.conversation` the receiving agent can't open (or that does not exist: the same words). */
const THIRD_PARTY_EVENT_CONVERSATION_DROPPED_WARNING = "object.conversation was not kept: the receiving agent can't open that conversation. The notice was accepted without it.";

oauthRouter.post("/agent-events", async (req, res) => {
  const span = startOAuthSpan(req, "server.oauth.agent_event.ingest", {
    bearer_present: typeof req.headers.authorization === "string" && req.headers.authorization.startsWith("Bearer "),
    requested_kind: eventKindAttr(req.body?.kind),
    target_override_present: Boolean(req.body?.agentId || req.body?.agent_id),
    external_event_id_present: Boolean(req.body?.externalEventId || req.body?.external_event_id),
    ttl_present: req.body?.ttlSeconds !== undefined || req.body?.ttl_seconds !== undefined,
    payload_present: req.body?.payload !== undefined,
  });
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) {
      finishOAuthSpan(span, "ok", { outcome: "bearer_auth_failed", http_status: 401 });
      return;
    }
    // An account-mode token (RFC 079 phase 3a) is a person's: this answer too.
    if (token.principalType !== "agent" || !token.agentId) {
      finishOAuthSpan(span, "ok", {
        outcome: "non_agent_token",
        http_status: 403,
        principal_type: token.principalType,
      });
      res.status(403).json({ error: "agent token required" });
      return;
    }

    const expectedResource = oauthService.getAgentInboundOAuthResource(token.serverId);
    if (token.resource !== expectedResource) {
      finishOAuthSpan(span, "ok", {
        outcome: "resource_bound_token_required",
        http_status: 403,
        principal_type: token.principalType,
        resource_bound: Boolean(token.resource),
      });
      res.status(403).json({ error: "resource-bound token required", resource: expectedResource });
      return;
    }

    const kind = req.body?.kind;
    const requiredScope = requiredScopeForEventKind(kind);
    if (!requiredScope) {
      finishOAuthSpan(span, "ok", {
        outcome: "invalid_kind",
        http_status: 400,
        principal_type: token.principalType,
        resource_bound: true,
      });
      res.status(400).json({ error: "kind must be event or notification" });
      return;
    }
    if (!oauthService.accessTokenHasScope(token, requiredScope)) {
      finishOAuthSpan(span, "ok", {
        outcome: "insufficient_scope",
        http_status: 403,
        principal_type: token.principalType,
        resource_bound: true,
        required_scope: requiredScope,
      });
      res.status(403).json({ error: "insufficient_scope", required_scope: requiredScope });
      return;
    }

    const targetAgentId = typeof req.body?.agentId === "string"
      ? req.body.agentId
      : typeof req.body?.agent_id === "string"
        ? req.body.agent_id
        : token.agentId;
    if (targetAgentId !== token.agentId) {
      finishOAuthSpan(span, "ok", {
        outcome: "target_agent_mismatch",
        http_status: 403,
        principal_type: token.principalType,
        resource_bound: true,
        required_scope: requiredScope,
      });
      res.status(403).json({ error: "token cannot target a different agent" });
      return;
    }

    // RFC 079 §5.4: server-mode agent-events keeps every answer above (the
    // resource binds the token's own Server). The shared checks run last, so
    // they only refuse what had no answer before (a disabled app, say), with
    // the one Server-access refusal.
    const access = await oauthService.checkAppServerAccess({
      token,
      serverId: token.serverId,
      requiredScopes: [requiredScope],
      allowGuests: SERVER_MODE_ALLOWS_GUESTS,
    });
    if (!access.ok) {
      finishOAuthSpan(span, "ok", {
        outcome: "server_access_denied",
        http_status: 403,
        principal_type: token.principalType,
        resource_bound: true,
        required_scope: requiredScope,
      });
      sendServerAccessDenied(res);
      return;
    }

    // RFC 081: what the notice is about. A malformed object is refused below
    // (400); a conversation the agent can't open is dropped with a warning,
    // never refused, so the answer says nothing about other conversations.
    const object = oauthService.normalizeThirdPartyEventObject(req.body?.object);
    const relatedChannelId = object.conversation
      ? await resolveRelatedConversationForAgent(token.serverId, token.agentId, object.conversation)
      : null;
    const created = await oauthService.createThirdPartyAgentEvent({
      serverId: token.serverId,
      agentId: token.agentId,
      clientId: token.clientRecordId,
      accessTokenId: token.tokenId,
      clientKey: token.clientKey,
      clientName: token.clientName,
      kind,
      summary: req.body?.summary,
      payload: req.body?.payload ?? {},
      externalEventId: req.body?.externalEventId ?? req.body?.external_event_id,
      ttlSeconds: req.body?.ttlSeconds ?? req.body?.ttl_seconds,
      resource: expectedResource,
      objectRef: object.objectRef,
      relatedChannelId,
    });

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    let deliveryClaimed = false;
    // An event on an inbox item that is already unread joins it without a new wake (#wg-ax:#24).
    const wakeCoalesced = created.created && await coalesceWakeIntoUnreadItem(created.event, token.clientKey);
    if ((created.created || created.shouldDeliver) && !wakeCoalesced) {
      deliveryClaimed = Boolean(await oauthService.claimQueuedThirdPartyAgentEventForDelivery(created.event.id));
    }
    if (deliveryClaimed) {
      try {
        await agentOrchestrator.deliverMessage(token.agentId, created.message);
      } catch (err) {
        await oauthService.releaseThirdPartyAgentEventDeliveryClaim(created.event.id);
        throw err;
      }
    }
    const responseStatus = deliveryClaimed || wakeCoalesced
      ? "queued"
      : "duplicate";
    const warnings = [
      // An app that sends a payload learns agents don't see it unless they
      // read the event, and that it is going away.
      ...(oauthService.thirdPartyEventHasPayload(created.event.payload) ? [THIRD_PARTY_EVENT_PAYLOAD_WARNING] : []),
      ...(created.event.objectRef ? [] : [thirdPartyEventObjectRefWarning(token.clientKey)]),
      ...(object.conversation && !relatedChannelId ? [THIRD_PARTY_EVENT_CONVERSATION_DROPPED_WARNING] : []),
    ];

    res.status(created.created ? 202 : 200).json({
      id: created.event.id,
      status: responseStatus,
      deduped: !created.created,
      expiresAt: created.event.expiresAt.toISOString(),
      payloadHash: created.event.payloadHash,
      ...(created.event.objectRef ? { objectRef: created.event.objectRef } : {}),
      // Added to its inbox item, which is unread: the agent was not woken again for it.
      ...(wakeCoalesced ? { wake: "merged" } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    });
    finishOAuthSpan(span, "ok", {
      outcome: deliveryClaimed ? "queued" : "duplicate",
      http_status: created.created ? 202 : 200,
      principal_type: token.principalType,
      resource_bound: true,
      event_kind: created.event.kind,
      required_scope: requiredScope,
      deduped: !created.created,
      delivered: false,
      enqueued: deliveryClaimed,
      wake_coalesced: wakeCoalesced,
      payload_present_nonempty: oauthService.thirdPartyEventHasPayload(created.event.payload),
      external_event_id_present: Boolean(created.event.externalEventId),
      object_ref_present: Boolean(created.event.objectRef),
      object_conversation_present: Boolean(object.conversation),
      object_conversation_kept: Boolean(relatedChannelId),
    });
  } catch (err: unknown) {
    // Only the validation errors the event's fields raise are the app's to
    // fix (400); anything else is Raft's (500), whatever its message says.
    if (err instanceof oauthService.ThirdPartyAgentEventValidationError) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_request", http_status: 400, error_class: errorClass(err), invalid_field: err.field });
      res.status(400).json({ error: err.message });
      return;
    }
    console.error("Third-party agent event error:", err);
    finishOAuthSpan(span, "error", { outcome: "error", http_status: 500, error_class: errorClass(err) });
    res.status(500).json({ error: "Failed to enqueue agent event" });
  }
});

oauthRouter.get("/userinfo", async (req, res) => {
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) return;
    // RFC 079 phase 3a: the lookup has run the account-mode checks (D14
    // included); the person's claims, and no Server's.
    if (isAccountIdentity(token)) {
      res.json(accountUserinfo(token, req));
      return;
    }
    // userinfo names no Server, so the shared checks run for the token's own
    // (a disabled app, a retired account). It has no 403: a refusal answers
    // exactly as the token lookup does for a lost membership.
    const access = await oauthService.checkAppServerAccess({
      token,
      serverId: token.serverId,
      requiredScopes: [],
      allowGuests: SERVER_MODE_ALLOWS_GUESTS,
    });
    if (!access.ok) {
      sendInvalidAccessToken(res);
      return;
    }
    if (!bearerTokenMatchesPathScope(req, token)) {
      res.status(401).json({ error: "Access token was issued for a different Server than this issuer" });
      return;
    }

    const common = {
      scope: (token.scopes ?? []).join(" "),
      client_id: token.clientKey,
      client_name: token.clientName,
      server_id: token.serverId,
      server_slug: token.serverSlug,
    };

    if (token.principalType === "human") {
      const picture = userinfoHumanPictureUrl(token.humanAvatarUrl, req);
      const emailClaims = oauthService.accessTokenHasScope(token, "email") && token.humanEmail
        ? {
            email: token.humanEmail,
            email_verified: token.humanEmailVerified === true,
          }
        : {};
      res.json({
        ...common,
        sub: token.humanId,
        type: "human",
        server_role: token.humanRole,
        preferred_username: token.humanName,
        name: token.humanDisplayName || token.humanName,
        avatar_url: token.humanAvatarUrl,
        picture,
        description: token.humanDescription,
        ...emailClaims,
      });
      return;
    }

    const picture = userinfoAgentPictureUrl(token.agentAvatarUrl, req);
    res.json({
      ...common,
      sub: token.agentId,
      type: "agent",
      server_role: token.agentRole,
      preferred_username: token.agentName,
      name: token.agentDisplayName || token.agentName,
      avatar_url: token.agentAvatarUrl,
      picture,
      description: token.agentDescription,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load userinfo",
      logPrefix: "OAuth userinfo error:",
      err,
    });
  }
});

// Directory authority is an explicit login scope, never a webhook group or
// an installation credential. The Server is the token's; an explicit
// ?server_id= must name it (RFC 079 D12), and checkAppServerAccess re-reads
// the app's availability (enabled included) and the principal's membership
// there live.
oauthRouter.get("/agents", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) return;
    let access: oauthService.AppServerAccess;
    if (isAccountIdentity(token)) {
      // RFC 079 phase 3a: no Server of its own; it names one (D13 scopes).
      const named = await checkNamedAccountServerAccess(req, res, token, ["agent:read"]);
      if (!named) return;
      access = named;
    } else {
      if (!bearerTokenMatchesPathScope(req, token)) {
        res.status(401).json({ error: "Access token was issued for a different Server than this issuer" });
        return;
      }
      access = await oauthService.checkAppServerAccess({
        token,
        serverId: namedServerId(req) ?? token.serverId,
        requiredScopes: ["agent:read"],
        allowGuests: SERVER_MODE_ALLOWS_GUESTS,
      });
    }
    if (!access.ok) {
      sendServerAccessDenied(res);
      return;
    }
    const directory = await oauthService.listOAuthAgentDirectory(access.server.id);
    res.json({ agents: directory.map((agent) => ({
      ...agent,
      picture: userinfoAgentPictureUrl(agent.avatar_url, req),
    })) });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load agent directory",
      logPrefix: "OAuth agent directory error:",
      err,
    });
  }
});

oauthRouter.get("/serverinfo", async (req, res) => {
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) return;
    let access: oauthService.AppServerAccess;
    if (isAccountIdentity(token)) {
      // RFC 079 phase 3a: no Server of its own; it names one.
      const named = await checkNamedAccountServerAccess(req, res, token, []);
      if (!named) return;
      access = named;
    } else {
      if (!bearerTokenMatchesPathScope(req, token)) {
        res.status(401).json({ error: "Access token was issued for a different Server than this issuer" });
        return;
      }

      // The token's Server; an explicit ?server_id= must name it (RFC 079 D12).
      access = await oauthService.checkAppServerAccess({
        token,
        serverId: namedServerId(req) ?? token.serverId,
        requiredScopes: [],
        allowGuests: SERVER_MODE_ALLOWS_GUESTS,
      });
    }
    if (!access.ok) {
      sendServerAccessDenied(res);
      return;
    }
    const server = access.server;

    // Coarse paid-tier projection (xxchan 2026-08-12 product ruling, PM Tao):
    // the bearer token is already bound to this client+server, so plan is
    // disclosed at the same level as the server name — no installation-id
    // discovery required. The plan arrives on the SAME live read as the
    // access checks, which only return a Server that is not deleted (and the
    // token lookup before it already refuses one): a vanished server never
    // gets a "free" projection. The projection rule itself is owned by
    // serverPlanProjection (shared with the outbound projection service) so
    // the two API surfaces cannot drift apart.
    const tier = projectCoarseServerPlan(server.plan);

    res.json({
      id: server.id,
      slug: server.slug,
      name: server.name,
      avatar_url: server.avatarUrl,
      picture: userinfoPictureUrl(server.avatarUrl, req),
      is_paid: tier.is_paid,
      plan_tier: tier.plan_tier,
    });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load serverinfo",
      logPrefix: "OAuth serverinfo error:",
      err,
    });
  }
});

// RFC 079 §5.3: the Servers where this principal can use this app, read live
// through the same checks. A server-mode token reaches at most its own Server,
// so the list has at most that one. An account-mode token (phase 3a) lists the
// app's audience for the person, by name, then id.
oauthRouter.get("/servers", async (req, res) => {
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) return;
    if (isAccountIdentity(token)) {
      const audience = await listAccountAppServers(token);
      res.set("Cache-Control", SERVER_ACCESS_CACHE_CONTROL);
      res.json({ servers: audience.map(serverAccessEntry) });
      return;
    }
    const access = await oauthService.checkAppServerAccess({
      token,
      serverId: token.serverId,
      requiredScopes: [],
      allowGuests: SERVER_MODE_ALLOWS_GUESTS,
    });
    res.set("Cache-Control", SERVER_ACCESS_CACHE_CONTROL);
    res.json({ servers: access.ok ? [serverAccessEntry(access.server)] : [] });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load servers",
      logPrefix: "OAuth servers error:",
      err,
    });
  }
});

// RFC 079 §5.4 (D12): the principal's live role on the named Server. The
// Server is never implied here, so a missing server_id is a malformed request;
// any server_id that fails the checks gets the one refusal.
oauthRouter.get("/membership", async (req, res) => {
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) return;
    const serverId = namedServerId(req);
    if (serverId === undefined) {
      oidcJsonError(res, "invalid_request", "server_id is required");
      return;
    }
    const access = isAccountIdentity(token)
      ? await checkAccountAppServerAccess({ token, serverId, requiredScopes: [] })
      : await oauthService.checkAppServerAccess({
        token,
        serverId,
        requiredScopes: [],
        allowGuests: SERVER_MODE_ALLOWS_GUESTS,
      });
    if (!access.ok) {
      sendServerAccessDenied(res);
      return;
    }
    res.set("Cache-Control", SERVER_ACCESS_CACHE_CONTROL);
    res.json(serverAccessEntry(access.server));
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to load membership",
      logPrefix: "OAuth membership error:",
      err,
    });
  }
});

function userinfoPictureUrl(avatarUrl: string | null, req: Request): string | null {
  if (!avatarUrl) return null;
  if (/^https?:\/\//i.test(avatarUrl)) return avatarUrl;
  if (!avatarUrl.startsWith("/")) return null;

  const origin = process.env.SERVER_URL?.trim() || `${req.protocol}://${req.get("host")}`;
  return new URL(avatarUrl, origin).toString();
}

function userinfoAgentPictureUrl(avatarUrl: string | null, req: Request): string | null {
  const encodedPixelKey = avatarUrl ? encodePixelAvatarKey(avatarUrl) : null;
  if (encodedPixelKey) {
    return userinfoPictureUrl(`/api/avatars/pixel/${encodedPixelKey}.svg`, req);
  }
  return userinfoPictureUrl(avatarUrl, req);
}

const RAFT_USER_AVATAR_PATH_RE = /^\/(?:api\/)?avatars\/users\/[0-9a-f]+\.webp$/i;

function userinfoHumanPictureUrl(avatarUrl: string | null, req: Request): string | null {
  // A built pixel avatar has no image of its own: the Server draws it as SVG,
  // at a URL that changes with the art (humanAvatarSvgPath).
  const humanSvgPath = avatarUrl ? humanAvatarSvgPath(avatarUrl) : null;
  if (humanSvgPath) return userinfoPictureUrl(humanSvgPath, req);
  if (!avatarUrl || !isRaftUploadedUserAvatarUrl(avatarUrl)) return null;
  return userinfoPictureUrl(avatarUrl, req);
}

function isRaftUploadedUserAvatarUrl(avatarUrl: string): boolean {
  if (RAFT_USER_AVATAR_PATH_RE.test(avatarUrl)) return true;

  try {
    const parsed = new URL(avatarUrl);
    return RAFT_USER_AVATAR_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}
