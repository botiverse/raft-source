import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { Router, type Request, type Response, type Router as RouterType } from "express";
import {
  currentDate,
  noopTracer,
  type ActiveSpan,
  type TraceAttributes,
  type TraceStatus,
  type Tracer,
} from "@botiverse/raft-shared";
import { requireAuth } from "../middleware/auth.js";
import { projectCoarseServerPlan } from "../services/serverPlanProjection.js";
import * as oauthService from "../services/oauthService.js";
import * as integrationAuditService from "../services/integrationAuditService.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";
import { encodePixelAvatarKey } from "../services/pixelAvatarService.js";
import type { AgentOrchestrator } from "../services/agentOrchestrator.js";
import { getCurrentTraceContext } from "../tracing/semanticTrace.js";
import {
  APP_INSTALLATION_TOKEN_AUDIENCE,
  mintAppInstallationCredential,
} from "../services/appInstallationCredentialService.js";
import {
  AppOutboundPermissionError,
  updateAppInstallationSubscriptions,
} from "../services/appOutboundPermissionService.js";
import { getAppUrl } from "../config/appUrl.js";
import { getServer } from "../services/serverService.js";
import { UUID_RE } from "../lib/messageId.js";
import {
  decodeOidcAuthorizationCode,
  encodeOidcAuthorizationCode,
  getOidcJwks,
  oidcDiscoveryDocument,
  oidcIssuer,
  signOidcIdToken,
  validateOidcAuthorizationCode,
  type OidcAuthorizationContext,
} from "../services/oidcService.js";

export const oauthRouter: RouterType = Router();


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
  return error instanceof Error ? error.name : typeof error;
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
  if (message === "authorization_pending") return "authorization_pending";
  if (message === "access_denied") return "access_denied";
  if (message === "request_already_consumed") return "request_already_consumed";
  if (message === oauthService.AUTHORIZATION_CODE_EXPIRED_ERROR) return "authorization_code_expired";
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

async function requireBearerIdentity(req: Request, res: Response) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return null;
  }
  const token = await oauthService.getIdentityByAccessToken(authHeader.slice(7));
  if (!token) {
    res.status(401).json({ error: "Invalid or expired access token" });
    return null;
  }
  return token;
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

export function oidcDiscoveryHandler(_req: Request, res: Response) {
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json({
      ...oidcDiscoveryDocument(),
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
  const serverHint = queryString(req, "server").trim();

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
  if (serverHint && !/^[A-Za-z0-9-]{1,128}$/.test(serverHint)) {
    oidcJsonError(res, "invalid_request", "server must be a Server ID or slug");
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
  if (serverHint) setup.searchParams.set("server", serverHint);
  res.setHeader("Cache-Control", "no-store");
  res.redirect(302, setup.toString());
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
    console.error("Mint app installation credential error:", error);
    res.status(500).json({ error: "Failed to mint installation credential" });
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
    console.error("Update app installation subscription error:", error);
    res.status(500).json({ error: "Failed to update installation subscription" });
  }
});

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
    const role = await getActorServerRoleInServer(serverId, "user", req.userId!);
    if (!role) {
      res.status(404).json({ error: "OAuth client not found for server" });
      return;
    }

    const client = await oauthService.getOAuthClientForServer({
      clientKey: clientId,
      serverId,
    });
    const publicClients = !client || client.appType === "third_party_global"
      ? await oauthService.listPublicMarketplaceOAuthClients()
      : [];
    const marketplaceClient = publicClients.find((candidate) => (
      candidate.id === clientId || candidate.clientId === clientId
    ));
    if (!client) {
      if (!marketplaceClient) {
        res.status(404).json({ error: "OAuth client not found for server" });
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
        allowedScopes: marketplaceClient.allowedScopes,
        marketplace: true,
        availability: "install_required",
        installation: {
          serverId,
          canInstall: role === "owner" || role === "admin",
        },
        ...(scopeValidation ? { scopeValidation } : {}),
      });
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
      allowedScopes: client.allowedScopes,
      marketplace: marketplaceClient ? true : undefined,
      availability: "ready",
      ...(scopeValidation ? { scopeValidation } : {}),
    });
  } catch (err) {
    console.error("Lookup OAuth client error:", err);
    res.status(500).json({ error: "Failed to load OAuth client" });
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
    const { serverSlug, agentName, scopes } = req.body ?? {};
    const result = await oauthService.requestAgentAccess({
      clientId: client.id,
      serverSlug,
      agentName,
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
      const registeredClient = await oauthService.getOAuthClientForServer({
        clientKey: clientId,
        serverId,
      });
      if (!registeredClient) {
        throw new Error("OAuth client not found for server");
      }
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
    if (message.includes("not found") || message.includes("member")) {
      res.status(404).json({ error: message });
      return;
    }
    if (err instanceof oauthService.OAuthScopeNotAllowedError) {
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
    console.error("Human authorization code error:", err);
    res.status(500).json({ error: "Failed to issue Login with Raft code" });
  }
});

oauthRouter.post("/token", async (req, res) => {
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
  if (grantType === "authorization_code") {
    try {
      oidcContext = decodeOidcAuthorizationCode(requestId);
      if (oidcContext) {
        validateOidcAuthorizationCode({
          context: oidcContext,
          clientId: presentedClientId,
          redirectUri: req.body?.redirect_uri,
          codeVerifier: req.body?.code_verifier,
        });
        requestId = oidcContext.requestId;
      }
    } catch {
      await recordOAuthLifecycle({
        stage: "token_exchange",
        result: "invalid_request",
        outcome: "failure",
        clientId: client.id,
        clientKey: client.clientId,
        grantType: "authorization_code",
        principalType: "human",
      });
      finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "The authorization code, redirect URI, or PKCE verifier is invalid");
      return;
    }
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
      resource: req.body?.resource,
    });
    const expiresIn = Math.max(
      1,
      Math.floor((exchanged.expiresAt.getTime() - currentDate().getTime()) / 1000),
    );
    const identity = exchanged.identity;
    const idToken = identity
      ? signOidcIdToken({
          issuer: oidcIssuer(),
          identity: {
            sub: identity.principalType === "human" ? identity.humanId! : identity.agentId!,
            clientId: oidcContext?.clientId ?? identity.clientKey,
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
    if (
      oidcContext
      && (
        message === "request_already_consumed"
        || message === oauthService.AUTHORIZATION_CODE_EXPIRED_ERROR
        || message.includes("not found")
      )
    ) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_grant", http_status: 400, grant_type: grantType });
      oidcJsonError(res, "invalid_grant", "The authorization code is invalid, expired, or has already been used");
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
    });

    const agentOrchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator;
    let deliveryClaimed = false;
    if (created.created || created.shouldDeliver) {
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
    const responseStatus = deliveryClaimed
      ? "queued"
      : "duplicate";

    res.status(created.created ? 202 : 200).json({
      id: created.event.id,
      status: responseStatus,
      deduped: !created.created,
      expiresAt: created.event.expiresAt.toISOString(),
      payloadHash: created.event.payloadHash,
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
      external_event_id_present: Boolean(created.event.externalEventId),
    });
  } catch (err: any) {
    const message = err?.message || "Failed to enqueue agent event";
    if (
      message.includes("required")
      || message.includes("kind")
      || message.includes("payload")
      || message.includes("ttl")
      || message.includes("externalEventId")
    ) {
      finishOAuthSpan(span, "ok", { outcome: "invalid_request", http_status: 400, error_class: errorClass(err) });
      res.status(400).json({ error: message });
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
    console.error("OAuth userinfo error:", err);
    res.status(500).json({ error: "Failed to load userinfo" });
  }
});

oauthRouter.get("/serverinfo", async (req, res) => {
  try {
    const token = await requireBearerIdentity(req, res);
    if (!token) return;

    // Coarse paid-tier projection (xxchan 2026-08-12 product ruling, PM Tao):
    // the bearer token is already bound to this client+server, so plan is
    // disclosed at the same level as the server name — no installation-id
    // discovery required. The plan arrives on the SAME single live read as
    // the token's server identity (getIdentityByAccessToken), which is
    // already fail-closed for deleted servers: a vanished server yields no
    // token at all, never a "free" projection. The projection rule itself is
    // owned by serverPlanProjection (shared with the outbound projection
    // service) so the two API surfaces cannot drift apart.
    const tier = projectCoarseServerPlan(token.serverPlan);

    res.json({
      id: token.serverId,
      slug: token.serverSlug,
      name: token.serverName,
      avatar_url: token.serverAvatarUrl,
      picture: userinfoPictureUrl(token.serverAvatarUrl, req),
      is_paid: tier.is_paid,
      plan_tier: tier.plan_tier,
    });
  } catch (err) {
    console.error("OAuth serverinfo error:", err);
    res.status(500).json({ error: "Failed to load serverinfo" });
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
