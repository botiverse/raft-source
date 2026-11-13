import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { ASSISTANT_OWNER_SSO_REQUIRED_BODY, assistantOwnerPassesSso, checkAccountSso, SSO_REQUIRED_CODE, SSO_REQUIRED_TEXT, type SsoSessionFacts } from "../services/sso/ssoEnforcement";
import { eq, and, isNull, ne } from "drizzle-orm";
import { getDb } from "../db/index";
import { isPilotServer } from "../raftbench/contract";
import { resolveProviderConfig } from "../services/agentRuntimeProviderService";
import { UUID_RE } from "../lib/messageId";
import { users, serverMembers, servers, sessionFamilies, agents, appBotBindings, oauthClientInstalls, raftbenchServiceAgents, agentRuntimeProvisions, accountDeletionRequests, type SessionScope, type RequestSessionScope } from "../db/schema";
import { ASSISTANT_ROUTE_NOT_ALLOWED_BODY, isAssistantAgentApiRequestAllowed } from "../services/assistantRouteAllowlist";
import { findMachineByApiKey, getMachine } from "../services/machineService";
import {
  AGENT_CREDENTIAL_EXPIRED_CODE,
  authenticateAgentApiKey,
  isAgentApiKey,
} from "../services/agentCredentialService";
import { refusalBody } from "../lib/refusal";
import { recordAgentApiSeen } from "../services/externalAgentPresence";
import { addTraceEvent, createTraceDbQueryTracer, runWithTraceAttrs, traceMiddlewarePhase } from "../tracing/semanticTrace";
import { agentIdHashAttrs, serverIdHashAttrs } from "../tracing/traceIdentity";
import {
  findComputerByApiKey,
  isComputerApiKey,
  recordComputerUse,
} from "../services/computerCredentialService";
import { accountNeedsIdentitySetup, asServerId, isExternalAgentRuntime, asMachineId, isOwnerRole, type ServerId, type MachineId } from "@botiverse/raft-shared";
import { rememberTraceUserId } from "../tracing/traceUserId";
import { setRequestTraceMachineKeyKind } from "./requestObservability";

const JWT_SECRET = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is required");
  return secret;
};

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      sessionFamilyId?: string;
      /**
       * Set by requireAuth: `device` for a device login's session (DEVICE_SESSION_ROUTES only);
       * `assistant_as_owner` when a personal assistant acts as its owner (middleware/assistantAsOwner.ts).
       */
      sessionScope?: RequestSessionScope;
      /** Set only with sessionScope `assistant_as_owner`: the assistant acting as `userId`, and the table entry. */
      viaAssistant?: { agentId: string; serverId: string; actionKey: string };
      /** What the session family says about SSO (RFC 083 §6.2); set by requireAuth. */
      ssoSession?: SsoSessionFacts;
      /**
       * The account fields requireVerified / requireProfileSetupComplete
       * check, from the same row read that verified the access token in
       * requireAuth (one read per request instead of three). Absent for any
       * other auth path: those checks then read the row themselves.
       */
      authAccount?: AuthAccountState;
      serverId?: ServerId;
      machineId?: MachineId;
      daemonVersion?: string | null;
      htmlPreviewAttachmentId?: string;
      // `rfcs/034-slock-credential-rfc.zh.html#section-credential-model` —
      // `sk_agent_*` credential auth.
      // Set ONLY by `requireAgentCredentialAuth` / `authenticateAgentCredential`.
      // Downstream handlers under `/internal/agent-api/*` read `actingAgentId`
      // as the canonical "this credential's bound agent identity" — derived
      // from the credential row, NOT from any URL :id param.
      // `agent_credential` names the auth principal class (`sk_agent_*` row),
      // not the product entity. The product identity is `actingAgentId`; using
      // plain "agent" here would blur credential principal vs. agent record.
      principalKind?: "user" | "machine" | "agent_credential" | "computer";
      actingAgentId?: string;
      agentCredentialId?: string;
      agentCredentialScopes?: readonly string[];
      raftbenchServiceAgent?: boolean;
      // RFC 075 v4: set when the credential's agent is someone's personal
      // assistant (the owner's user id). Its credential reaches only the
      // assistant route allowlist (services/assistantRouteAllowlist.ts).
      actingAgentAssistantOwnerUserId?: string;
      // True when the credential's bound agent runs on the `external` runtime
      // (no daemon). Drives the `agent:seen` presence push.
      actingAgentIsExternal?: boolean;
      // `rfcs/034-slock-credential-rfc.zh.html#section-credential-model` —
      // `sk_computer_*` auth.
      // Set ONLY by `requireComputerAuth`. Downstream handlers under
      // `/internal/computer/*` read `computerId` as the canonical "this is
      // the Computer host calling" identity.
      computerId?: string;
    }
  }
}

export interface JwtPayload {
  sub: string; // userId
  type: "access" | "refresh";
  familyId?: string;
}

/**
 * Every access token belongs to a session family (design v8 §5): the family
 * is where revocation, scope and the second-factor state live, and a token
 * without one is refused (verifyActiveAccessTokenWithAccount).
 */
export function signAccessToken(userId: string, familyId: string): string {
  return jwt.sign({ sub: userId, type: "access", familyId }, JWT_SECRET(), { expiresIn: "15m" });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "refresh" }, JWT_SECRET(), { expiresIn: "30d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET()) as JwtPayload;
}

/**
 * Signature only, expiry not checked. For POST /api/computer/retire-session
 * alone (computerRetireSession.ts): its other proof is a live machine key that
 * the token's family issued, and retiring only takes access away, so a Computer
 * that has been off past the token's 15 minutes can retire without refreshing
 * (a refresh could rotate a copied Desktop session and sign the app out). Every
 * other route keeps `verifyToken`.
 */
export function verifyTokenSignatureIgnoringExpiry(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET(), { ignoreExpiration: true }) as JwtPayload;
}

/** The account fields the verified / profile-setup checks read. */
export type AuthAccountState = {
  /** Whose row this is: used only while it is still `req.userId`. */
  userId: string;
  emailVerified: boolean;
  profileSetupCompletedAt: Date | null;
  name: string;
};

/**
 * Verify the live account/session at every user-token entry point, in one
 * read: the user row, the token's session family and the person's pending
 * account deletion request, if any (both left-joined; the request through
 * its partial unique index). Refused: a token with no family (design v8 §5:
 * outside any family's revocation and second-factor state; production issued
 * none), no account or a retired one, then a missing, revoked or retired
 * family, then a person whose account is scheduled for deletion unless the
 * caller opts in (`accountDeletionPending: "allow"`, requireAuth only, which
 * admits such a person on ACCOUNT_DELETION_PENDING_ROUTES only): sockets,
 * attachment links and optional-auth reads see no session at all.
 * A person with no request reads exactly as before.
 */
export async function verifyActiveAccessTokenWithAccount(
  token: string,
  options: {
    deviceSession?: "deny" | "allow";
    accountDeletionPending?: "deny" | "allow";
    /** Read "require SSO" without its 10 s candidate cache (the socket handshake). */
    ssoFresh?: boolean;
  } = {},
): Promise<{
  payload: JwtPayload;
  account: AuthAccountState;
  scope: SessionScope;
  accountDeletionScheduledFor: Date | null;
  sso: SsoSessionFacts;
  /** RFC 083 §6.2: a Server requiring SSO manages this person and this session does not satisfy it (sign in with that Server's SSO). */
  ssoRequiredBy: string | null;
  /** When this session's accepted SSO sign-in stops counting (a live socket closes then). */
  ssoExpiresAt: Date | null;
} | null> {
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  if (payload.type !== "access") return null;
  const familyId = payload.familyId;
  if (typeof familyId !== "string" || !familyId) return null;
  const db = getDb();
  // `db.query.finished` on the request span (phase `auth`), so the time before
  // the handler is attributed; a no-op outside a request (sockets).
  const [row] = await createTraceDbQueryTracer("auth")("auth.user_by_id", async () => db.select({
    id: users.id,
    retiredAt: users.retiredAt,
    traceUserId: users.traceUserId,
    email: users.email,
    emailVerified: users.emailVerified,
    profileSetupCompletedAt: users.profileSetupCompletedAt,
    name: users.name,
    familyId: sessionFamilies.id,
    familyRevokedAt: sessionFamilies.revokedAt,
    familyRetiredAt: sessionFamilies.retiredAt,
    familyScope: sessionFamilies.scope,
    familySsoConnectionId: sessionFamilies.ssoConnectionId,
    familySsoAuthenticatedAt: sessionFamilies.ssoAuthenticatedAt,
    accountDeletionScheduledFor: accountDeletionRequests.scheduledFor,
  })
    .from(users)
    .leftJoin(sessionFamilies, and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, users.id)))
    .leftJoin(accountDeletionRequests, and(eq(accountDeletionRequests.userId, users.id), eq(accountDeletionRequests.state, "pending")))
    .where(eq(users.id, payload.sub))
    .limit(1));
  if (!row || row.retiredAt) return null;
  // Same row read, so this request's spans export the user as trace_user_id.
  rememberTraceUserId(row.id, row.traceUserId);
  // A retired family (a device session a Computer ended for its own key,
  // POST /api/computer/retire-session) is as unusable as a revoked one.
  if (!row.familyId || !row.familyScope || row.familyRevokedAt || row.familyRetiredAt) return null;
  const scope = row.familyScope;
  // A device login's session is refused everywhere but requireAuth, which
  // admits it on DEVICE_SESSION_ROUTES only: sockets, attachment links,
  // optional-auth reads and everything else see no session at all.
  // Fail closed: anything but a person's own `full` session needs the opt-in.
  if (scope !== "full" && options.deviceSession !== "allow") return null;
  if (row.accountDeletionScheduledFor && options.accountDeletionPending !== "allow") return null;
  const sso = { connectionId: row.familySsoConnectionId, authenticatedAt: row.familySsoAuthenticatedAt };
  const ssoCheck = await checkAccountSso({ userId: row.id, email: row.email, facts: sso, fresh: options.ssoFresh }, db);
  return {
    payload,
    scope,
    accountDeletionScheduledFor: row.accountDeletionScheduledFor,
    sso,
    ssoRequiredBy: ssoCheck.ok ? null : ssoCheck.serverId,
    ssoExpiresAt: ssoCheck.ok ? ssoCheck.expiresAt : null,
    account: {
      userId: row.id,
      emailVerified: row.emailVerified,
      profileSetupCompletedAt: row.profileSetupCompletedAt,
      name: row.name,
    },
  };
}

/** A live access token's payload; null too when a Server requiring SSO refuses this session (optional-auth reads see no session). */
export async function verifyActiveAccessToken(token: string): Promise<JwtPayload | null> {
  const verified = await verifyActiveAccessTokenWithAccount(token);
  return verified && !verified.ssoRequiredBy ? verified.payload : null;
}

/** 403 SSO_REQUIRED with the stable link of the Server whose SSO to sign in with (RFC 083 §6.2). */
export function respondSsoRequired(res: Response, serverId: string): void {
  res.status(403).json({
    error: SSO_REQUIRED_TEXT,
    code: SSO_REQUIRED_CODE,
    signInUrl: `${(process.env.SERVER_URL || "").replace(/\/$/, "")}/api/auth/sso/servers/${serverId}/start`,
  });
}

/** Signing out always works, also for a session SSO no longer accepts. */
function isSsoExemptRoute(method: string, originalUrl: string): boolean {
  const path = originalUrl.split("?")[0]!.replace(/\/+$/, "");
  return method.toUpperCase() === "POST" && path === "/api/auth/logout";
}

export async function getBearerAccessUserId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return (await verifyActiveAccessToken(authHeader.slice(7)))?.sub ?? null;
}

/**
 * Like getBearerAccessUserId, plus the sign-in it belongs to, for an optional
 * bearer on a route without requireAuth that may need step-up
 * (routes/secondFactor.ts refuseWithoutRecentSecondFactor): `webFamilyId` is
 * the token's own session family, a person's live `full` one (a device
 * login's session is refused here, as by getBearerAccessUserId), read from
 * the verified token, never from the body.
 */
export async function getBearerAccessSession(authHeader: string | undefined): Promise<{ userId: string; webFamilyId: string } | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const verified = await verifyActiveAccessTokenWithAccount(authHeader.slice(7));
  const familyId = verified?.payload.familyId;
  if (!verified || verified.scope !== "full" || !familyId || verified.ssoRequiredBy) return null;
  return { userId: verified.payload.sub, webFamilyId: familyId };
}

export function respondInvalidOrExpiredToken(res: Response): void {
  res.status(401).json({ error: "Invalid or expired token", code: "auth_required" });
}

function isHtmlPreviewRequestForAttachment(req: Request, attachmentId: string): boolean {
  const [pathAttachmentId, previewPath, ...rest] = req.path.split("/").filter(Boolean);
  return pathAttachmentId === attachmentId && previewPath === "html-preview" && rest.length === 0;
}

/**
 * What a device login's session may call: the routes Raft Computer
 * (`raft-computer login` / attach / adopt / start-stop / doctor) and the raft
 * CLI (`raft agent login wait`, `raft agent list`) use it for, and nothing
 * else — not sockets, not another device code's approval, not the web app.
 * Matched on the request's own path (Express routes are case-insensitive).
 */
const DEVICE_SESSION_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/auth\/me$/i },
  { method: "POST", path: /^\/api\/computer\/attach$/i },
  { method: "POST", path: /^\/api\/computer\/adopt-legacy$/i },
  { method: "GET", path: /^\/api\/computer\/legacy-machines$/i },
  { method: "GET", path: /^\/api\/servers$/i },
  { method: "GET", path: /^\/api\/servers\/[^/]+\/machines$/i },
  { method: "POST", path: /^\/api\/servers\/[^/]+\/machines\/[^/]+\/computer-lifecycle-operations$/i },
  { method: "GET", path: /^\/api\/agents\/manageable$/i },
  { method: "POST", path: /^\/api\/agents\/[^/]+\/credentials$/i },
];

/**
 * The request path must be one the router reads exactly as this check does:
 * a request target with `#`, `\`, whitespace or a control character is
 * parsed differently by Express (parseurl falls back to url.parse, which cuts
 * at `#` and turns `\` into `/`), so `/api/servers/S\invites#/machines`
 * would pass as an allowed path and run another handler. Such a target is
 * never admitted for a device session.
 */
export function isUnambiguousTarget(target: string): boolean {
  if (!target.startsWith("/")) return false;
  for (const ch of target) {
    const code = ch.codePointAt(0)!;
    if (ch === "#" || ch === "\\" || code <= 0x20 || code === 0x7f || /\s/.test(ch)) return false;
  }
  return true;
}

const DEVICE_SESSION_NOT_ALLOWED_TEXT =
  "This sign-in came from a device login and only works for Raft Computer and the raft CLI. Sign in on the web to do this.";

export function isDeviceSessionRoute(method: string, originalUrl: string): boolean {
  if (!isUnambiguousTarget(originalUrl)) return false;
  const path = originalUrl.split("?")[0]!.replace(/\/+$/, "") || "/";
  return DEVICE_SESSION_ROUTES.some((route) => route.method === method.toUpperCase() && route.path.test(path));
}

/**
 * What a person whose account is scheduled for deletion may call (design §6):
 * read the deletion and cancel it. Signing out (POST /api/auth/logout) needs
 * no access token. Everything else answers 403 `account_deletion_pending`
 * with `scheduledFor`, which the web and the app show as the "your account
 * will be deleted" page. Matched like DEVICE_SESSION_ROUTES.
 */
const ACCOUNT_DELETION_PENDING_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/me\/account\/deletion$/i },
  { method: "DELETE", path: /^\/api\/me\/account\/deletion$/i },
  { method: "DELETE", path: /^\/api\/me\/account\/deletion\/requests\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i },
];

export function isAccountDeletionPendingRoute(method: string, originalUrl: string): boolean {
  if (!isUnambiguousTarget(originalUrl)) return false;
  const path = originalUrl.split("?")[0]!.replace(/\/+$/, "") || "/";
  return ACCOUNT_DELETION_PENDING_ROUTES.some((route) => route.method === method.toUpperCase() && route.path.test(path));
}

/**
 * Require a valid JWT access token. Sets req.userId. A device login's session
 * passes only on DEVICE_SESSION_ROUTES (403 `device_session_not_allowed`); a
 * person whose account is scheduled for deletion only on
 * ACCOUNT_DELETION_PENDING_ROUTES (403 `account_deletion_pending`).
 */
export function requireAuth(req: Request, res: Response, untracedNext: NextFunction): void {
  const next = traceMiddlewarePhase("auth", untracedNext);
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header", code: "auth_required" });
    return;
  }

  // A personal assistant acting as its owner on one of the owner's own routes
  // (services/assistantOwnerActions.ts); refused there for anything else.
  if (isAgentApiKey(authHeader.slice(7))) {
    void import("./assistantAsOwner")
      .then(({ authenticateAssistantAsOwner }) => authenticateAssistantAsOwner(req, res, next, authHeader.slice(7)))
      .catch(next);
    return;
  }

  void verifyActiveAccessTokenWithAccount(authHeader.slice(7), { deviceSession: "allow", accountDeletionPending: "allow" }).then((verified) => {
    if (!verified) { respondInvalidOrExpiredToken(res); return; }
    if (verified.scope !== "full" && !isDeviceSessionRoute(req.method, req.originalUrl)) {
      res.status(403).json({ error: DEVICE_SESSION_NOT_ALLOWED_TEXT, code: "device_session_not_allowed" });
      return;
    }
    if (verified.accountDeletionScheduledFor && !isAccountDeletionPendingRoute(req.method, req.originalUrl)) {
      res.status(403).json({
        error: "This account is scheduled for deletion. Cancel the deletion to use it again.",
        code: "account_deletion_pending",
        scheduledFor: verified.accountDeletionScheduledFor.toISOString(),
      });
      return;
    }
    if (verified.ssoRequiredBy && !isSsoExemptRoute(req.method, req.originalUrl)) {
      respondSsoRequired(res, verified.ssoRequiredBy);
      return;
    }
    req.userId = verified.payload.sub;
    req.sessionFamilyId = verified.payload.familyId;
    req.sessionScope = verified.scope;
    req.authAccount = verified.account;
    req.ssoSession = verified.sso;
    next();
  }).catch(next);
}

/** Retirement is deliberately idempotent: the caller's access token remains the
 * actor handle for the terminal receipt after refresh/session state is revoked. */
export function requireRetirementAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { respondInvalidOrExpiredToken(res); return; }
  let payload: JwtPayload;
  try {
    payload = verifyToken(authHeader.slice(7));
  } catch { respondInvalidOrExpiredToken(res); return; }
  // Every access token has a family (design v8 §5); one without is refused like elsewhere.
  if (payload.type !== "access" || !payload.familyId) { respondInvalidOrExpiredToken(res); return; }
  // Still no live-session check (a revoked family may retire), but a device
  // login's session never retires an account: its scope is read, revoked or not.
  void retirementFamilyScope(payload.familyId).then((scope) => {
    if (scope !== "full") {
      res.status(403).json({ error: DEVICE_SESSION_NOT_ALLOWED_TEXT, code: "device_session_not_allowed" });
      return;
    }
    req.userId = payload.sub;
    req.sessionFamilyId = payload.familyId;
    next();
  }).catch(next);
}

/** A token's family scope for retirement; null (refused) for a family that no longer exists. */
async function retirementFamilyScope(familyId: string): Promise<SessionScope | null> {
  const [family] = await getDb().select({ scope: sessionFamilies.scope }).from(sessionFamilies)
    .where(eq(sessionFamilies.id, familyId)).limit(1);
  return family?.scope ?? null;
}

/**
 * Require that the authenticated user has verified their email.
 * Must be used after requireAuth.
 */
/**
 * requireAuth's read of this request's account, only while it is still the
 * request's user (a later delegation / proxy identity reads its own row).
 */
function authAccountOf(req: Request): AuthAccountState | undefined {
  return req.authAccount && req.authAccount.userId === req.userId ? req.authAccount : undefined;
}

export async function requireVerified(req: Request, res: Response, untracedNext: NextFunction): Promise<void> {
  const next = traceMiddlewarePhase("verified", untracedNext);
  const user = authAccountOf(req) ?? (await getDb()
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, req.userId!)))[0];

  if (!user) {
    respondInvalidOrExpiredToken(res);
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ error: "Email verification required" });
    return;
  }

  // The untraced check: this phase (`verified`) already covers it.
  await profileSetupComplete(req, res, next);
}

/**
 * Require the account-global identity setup to be complete.
 * Must be used after requireAuth. Recovery routes under /api/auth deliberately
 * do not use this middleware so a pending user can finish setup or sign out.
 */
export async function requireProfileSetupComplete(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await profileSetupComplete(req, res, traceMiddlewarePhase("profile_setup", next));
}

async function profileSetupComplete(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const user = authAccountOf(req) ?? (await getDb()
    .select({ profileSetupCompletedAt: users.profileSetupCompletedAt, name: users.name })
    .from(users)
    .where(eq(users.id, req.userId!)))[0];

  if (!user) {
    respondInvalidOrExpiredToken(res);
    return;
  }

  // Same rule as the client, from the same place: a NULL stamp on an account that already
  // has a real handle is a row the backfill missed, not a person who never set up. Locking
  // them out of the API while the UI lets them in would be the worst of both.
  if (accountNeedsIdentitySetup(user)) {
    res.status(403).json({
      error: "Profile setup required",
      code: "PROFILE_SETUP_REQUIRED",
    });
    return;
  }

  next();
}

/**
 * Require X-Server-Id header and verify user is a member. Sets req.serverId.
 * Must be used after requireAuth.
 */
export async function requireServer(req: Request, res: Response, untracedNext: NextFunction): Promise<void> {
  const next = traceMiddlewarePhase("server_membership", untracedNext);
  const serverId = req.headers["x-server-id"] as string;
  if (!serverId) {
    res.status(400).json({ error: "Missing X-Server-Id header" });
    return;
  }
  const db = getDb();
  // An id that is no UUID names no server: it is answered as one the caller
  // isn't in, without the membership query (which would fail on it, as a 500).
  const [membership] = typeof serverId !== "string" || !UUID_RE.test(serverId) ? [] : await createTraceDbQueryTracer("server_membership")(
    "server_members.membership_by_user",
    async () => db
      .select({ serverId: serverMembers.serverId })
      .from(serverMembers)
      .innerJoin(servers, eq(serverMembers.serverId, servers.id))
      .where(and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, req.userId!),
        ne(servers.kind, "joint_storage"),
        isNull(servers.deletedAt),
      )),
  );

  if (!membership) {
    res.status(403).json({ error: "Not a member of this server" });
    return;
  }

  req.serverId = asServerId(serverId);
  // Spans opened for the rest of the request carry the server's keyed hash.
  runWithTraceAttrs(serverIdHashAttrs(req.serverId), next);
}

/**
 * Flexible auth for endpoints that need to support multiple auth methods.
 * Accepts: JWT via Authorization header or machine API key.
 * Sets req.userId or req.machineId accordingly.
 */
export async function requireFlexAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  // 1. Try Authorization header (JWT or machine key)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Machine credentials no longer read attachments (#proj-raft-computer:8e6a4629):
    // the machine branch granted every attachment on the server, private channels
    // and DMs included, and no daemon calls it. Agents download through
    // /internal/agent-api/attachments with their own credential.
    if (token.startsWith("sk_machine_") || token.startsWith("sk_daemon_") || isComputerApiKey(token)) {
      const keyKind = isComputerApiKey(token) ? "computer" : "legacy_machine";
      setRequestTraceMachineKeyKind(res, keyKind);
      addTraceEvent("machine_auth.retired_route.rejected", { surface: "attachments", key_kind: keyKind });
      res.status(403).json({ error: "Machine credentials cannot read attachments", code: "machine_key_route_retired" });
      return;
    }

    const verified = await verifyActiveAccessTokenWithAccount(token);
    if (verified?.ssoRequiredBy) { respondSsoRequired(res, verified.ssoRequiredBy); return; }
    if (verified) {
      req.userId = verified.payload.sub;
      req.sessionFamilyId = verified.payload.familyId;
      req.ssoSession = verified.sso;
      next();
      return;
    }
  }

  // Fresh-tab downloads cannot send headers; apply the same live-session
  // check to their query bearer as to Authorization.
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  if (queryToken) {
    const verified = await verifyActiveAccessTokenWithAccount(queryToken);
    if (verified?.ssoRequiredBy) { respondSsoRequired(res, verified.ssoRequiredBy); return; }
    if (verified) {
      req.userId = verified.payload.sub;
      req.sessionFamilyId = verified.payload.familyId;
      req.ssoSession = verified.sso;
      next();
      return;
    }
  }

  const previewToken = typeof req.query.previewToken === "string" ? req.query.previewToken : null;
  if (previewToken) {
    try {
      const payload = jwt.verify(previewToken, JWT_SECRET(), {
        audience: "attachment-html-preview",
        issuer: "slock-server",
      }) as jwt.JwtPayload & {
        type?: string;
        attachmentId?: string;
        serverId?: string;
        actorType?: string;
        actorId?: string;
      };
      if (
        payload.type === "attachment-html-preview" &&
        typeof payload.attachmentId === "string" &&
        typeof payload.serverId === "string" &&
        typeof payload.actorId === "string" &&
        payload.sub === payload.actorId &&
        // Preview tokens are bearer-visible inside hostile HTML. They must
        // never become general attachment/API auth; accept them only for the
        // exact HTML preview document they were minted for.
        isHtmlPreviewRequestForAttachment(req, payload.attachmentId)
      ) {
        req.htmlPreviewAttachmentId = payload.attachmentId;
        req.serverId = asServerId(payload.serverId);
        if (payload.actorType === "user") {
          req.userId = payload.actorId;
          next();
          return;
        }
        if (payload.actorType === "machine") {
          req.machineId = asMachineId(payload.actorId);
          next();
          return;
        }
      }
    } catch {
      // fall through
    }
  }

  res.status(401).json({ error: "Authentication required" });
}

/**
 * Require X-Server-Id scope after `requireFlexAuth`.
 *
 * Two auth shapes feed in:
 *   - machine-auth (req.machineId set): `req.serverId` is already bound to the
 *     machine's server by `requireFlexAuth`; no extra check required.
 *   - user-auth (req.userId set): X-Server-Id is mandatory, either as a
 *     header or as a `serverId` query param (for `<img src>` / new-tab
 *     downloads that cannot set headers). The user must be a member of that
 *     (non-deleted) server; `req.serverId` is then populated.
 *
 * Introduced 2026-04-19 for #proj-security task #10. Download endpoints
 * previously ran under `requireFlexAuth` alone and accepted cross-server
 * access via an attachment UUID — `canUserAccessChannel` returned true for
 * any `type="channel"` without a serverId check. Pair this middleware with
 * the new `canUserAccessChannel(id, uid, serverId)` signature to close that
 * hole end-to-end.
 */
export async function requireServerForFlex(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.machineId && req.serverId) {
    next();
    return;
  }
  if (!req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const headerServerId = req.headers["x-server-id"];
  const queryServerId = req.query.serverId;
  const serverId = typeof headerServerId === "string" && headerServerId
    ? headerServerId
    : typeof queryServerId === "string" && queryServerId
      ? queryServerId
      : null;

  if (!serverId) {
    res.status(400).json({ error: "Missing X-Server-Id" });
    return;
  }
  const db = getDb();
  // As in requireServer: an id that is no UUID names no server.
  const [membership] = !UUID_RE.test(serverId) ? [] : await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, req.userId),
      ne(servers.kind, "joint_storage"),
      isNull(servers.deletedAt),
    ));

  if (!membership) {
    res.status(403).json({ error: "Not a member of this server" });
    return;
  }

  req.serverId = asServerId(serverId);
  // Spans opened for the rest of the request carry the server's keyed hash.
  runWithTraceAttrs(serverIdHashAttrs(req.serverId), next);
}

/**
 * Require X-Server-Id to match the `:id` path parameter, and verify the
 * authenticated user is a non-deleted member of that server. A DELETE retry
 * is the sole exception: an owner may re-enter an already soft-deleted server
 * so the deletion service can finish cleaning up legacy partial residue.
 *
 * Sits in the middleware chain AFTER `requireAuth` + `requireVerified` for
 * server-scoped sub-routes like `/api/servers/:id/*`. Closes the case where
 * the caller is a member of server A (valid X-Server-Id=A) but fetches
 * `/api/servers/B/<anything>` — the per-handler `isMember(req.params.id,
 * req.userId)` check would return true for any server the user happens to
 * belong to, silently crossing scope. This middleware refuses that before
 * the handler runs.
 *
 * Introduced 2026-04-19 for #proj-security task #10 alongside
 * `requireServerForFlex`. stdrc's contract (msg=256c4eda): "所有
 * authenticated API 都必须带 X-Server-Id 且限定到那个 server".
 */
export async function requireServerMatchesParam(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const paramId = req.params.id;
  if (!paramId) {
    // Route doesn't actually carry `:id` — nothing to match. This shouldn't
    // happen if the middleware is mounted correctly, but fail closed.
    res.status(400).json({ error: "Server id is required" });
    return;
  }
  // A non-UUID :id names no server; let it reach the membership query and the
  // uuid cast error comes back as a 500 (task #12). Uniform 404 instead.
  if (typeof paramId !== "string" || !UUID_RE.test(paramId)) {
    res.status(404).json({ error: "Server not found" });
    return;
  }

  const headerServerId = req.headers["x-server-id"];
  if (typeof headerServerId !== "string" || !headerServerId) {
    res.status(400).json({ error: "Missing X-Server-Id header" });
    return;
  }
  if (headerServerId !== paramId) {
    res.status(400).json({ error: "X-Server-Id must match server id in URL" });
    return;
  }

  if (!req.userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const db = getDb();
  const [membership] = await db
    .select({
      serverId: serverMembers.serverId,
      role: serverMembers.role,
      serverDeletedAt: servers.deletedAt,
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, paramId),
      eq(serverMembers.userId, req.userId),
      ne(servers.kind, "joint_storage"),
    ));

  const isDeletedServerOwnerRetry = req.method === "DELETE"
    && req.path === "/"
    && membership?.serverDeletedAt != null
    && isOwnerRole(membership.role);
  if (!membership || (membership.serverDeletedAt != null && !isDeletedServerOwnerRetry)) {
    res.status(403).json({ error: "Not a member of this server" });
    return;
  }

  req.serverId = asServerId(paramId);
  // Spans opened for the rest of the request carry the server's keyed hash.
  runWithTraceAttrs(serverIdHashAttrs(req.serverId), next);
}

/** The only machine-auth routes (method + path) a Computer (sk_computer_*) key may call. */
export const COMPUTER_KEY_MACHINE_AUTH_ROUTES: ReadonlySet<string> = new Set([
  "POST /internal/machine/scope-attestation",
]);

/** Bounded trace value: the surface, never ids from the path. */
function retiredRouteSurface(route: string): string {
  const [, root, surface] = route.split("/");
  return root === "internal" && (surface === "agent" || surface === "machine") ? `internal_${surface}` : "other";
}

/**
 * Require machine API key authentication for /internal/* routes.
 * Sets req.machineId and req.serverId.
 * Accepts both sk_machine_ and sk_daemon_ key prefixes (backward compat).
 */
export async function requireMachineAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing machine API key" });
    return;
  }

  const apiKey = authHeader.slice(7);

  // Check if this is a machine API key (sk_machine_ or legacy sk_daemon_ prefix)
  if (apiKey.startsWith("sk_daemon_") || apiKey.startsWith("sk_machine_")) {
    setRequestTraceMachineKeyKind(res, "legacy_machine");
    const machine = await findMachineByApiKey(apiKey);
    if (machine) {
      // RFC v8.2 §5.11.3: once a machine has been adopted into a Computer,
      // its legacy sk_machine_*/sk_daemon_* key MUST fail closed everywhere.
      // The cache carries `legacyKeyMigratedAt` so the rejection is immediate;
      // a successful adoption also calls `clearAuthCache(machineId)`.
      if ("legacyKeyMigratedAt" in machine && machine.legacyKeyMigratedAt) {
        res.status(401).json({
          error: "Legacy machine key has been migrated to a Computer attachment",
          code: "legacy_machine_key_migrated",
        });
        return;
      }
      // Reject if the machine's server has been deleted
      const db = getDb();
      const [srv] = await db
        .select({ id: servers.id })
        .from(servers)
        .where(and(eq(servers.id, machine.serverId), isNull(servers.deletedAt)));
      if (!srv) {
        res.status(401).json({ error: "Server no longer exists" });
        return;
      }
      req.machineId = asMachineId(machine.id);
      req.serverId = asServerId(machine.serverId);
      req.daemonVersion = "daemonVersion" in machine ? machine.daemonVersion ?? null : null;
      next();
      return;
    }
    res.status(401).json({ error: "Invalid machine API key" });
    return;
  }

  // Computer-attached daemon principals: sk_computer_* keys present the same
  // machine identity as /daemon/connect. Resolve the linked machine so that
  // adopted daemons can use /internal/machine/* HTTP endpoints (e.g. scope
  // attestation for trace-bundle upload) without falling back to a migrated
  // legacy sk_machine_* key.
  if (isComputerApiKey(apiKey)) {
    setRequestTraceMachineKeyKind(res, "computer");
    const computer = await findComputerByApiKey(apiKey);
    if (!computer) {
      res.status(401).json({ error: "Invalid computer credential" });
      return;
    }
    const machine = await getMachine(asMachineId(computer.machineId));
    if (!machine) {
      res.status(401).json({ error: "Machine linked to computer credential not found" });
      return;
    }
    const db = getDb();
    const [srv] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, machine.serverId), isNull(servers.deletedAt)));
    if (!srv) {
      res.status(401).json({ error: "Server no longer exists" });
      return;
    }
    // A Computer key reaches /internal/* only for what Computers use there.
    // Everything else on this surface (the legacy /internal/agent/:id/* API acting
    // as any agent on the machine, /internal/machine/* start/stop) is for legacy
    // sk_machine_* daemons; Computer daemons go through sk_agent_* instead.
    const route = `${req.baseUrl}${req.path}`;
    if (!COMPUTER_KEY_MACHINE_AUTH_ROUTES.has(`${req.method} ${route}`)) {
      addTraceEvent("machine_auth.retired_route.rejected", {
        surface: retiredRouteSurface(route),
        key_kind: "computer",
      });
      res.status(403).json({ error: "Computer credentials cannot call this route", code: "machine_key_route_retired" });
      return;
    }
    req.machineId = asMachineId(machine.id);
    req.serverId = asServerId(machine.serverId);
    req.daemonVersion = "daemonVersion" in machine ? machine.daemonVersion ?? null : null;
    req.principalKind = "computer";
    req.computerId = computer.computerId;
    next();
    return;
  }

  res.status(401).json({ error: "Invalid authentication: machine API key required" });
}

// =============================================================================
// `rfcs/034-slock-credential-rfc.zh.html#section-credential-model` —
// `sk_agent_*` credential auth.
//
// Surface model (base RFC §1 credential model + §2.2 Agent Runner surface):
//   `sk_agent_*` credentials reach `/internal/agent-api/*` ONLY. No `:id`
//   path param — the credential row encodes its bound `agentId` and that
//   is the only agent identity the credential can act as.
//
// Two principals, two namespaces (base RFC
// `#section-api-auth-surface`):
//   sk_machine_*  → /internal/machine/*, /daemon/connect, legacy /internal/agent/:id/*
//   sk_computer_* → /internal/computer/*   (Phase 1 also accepts sk_machine_* as an alias)
//   sk_agent_*    → /internal/agent-api/*  (this middleware)
//
// Wrong-principal denial (base RFC §2.4 wrong-principal semantics): a
// `sk_agent_*` key presented at a non-`/internal/agent-api/*` path returns
// 401 `invalid_principal`, not 404. Reciprocal on the other side. The
// dispatcher that selects which auth applies lives in
// `middleware/authFromRegistry.ts` — this middleware is the leaf for paths
// the registry maps to `sk_agent` principal.
//
// Key isolation (base RFC §1.4 runner key isolation): the raw key value
// never leaves the agent runner's private env (the raft CLI wrapper).
// This middleware reads it from `Authorization: Bearer`
// header on a single inbound request; it is not persisted anywhere on the
// server side except via the argon2id hash on the credential row.
//
// Capability enforcement (RFC §7.2):
//   authorized_for(request) := request.capability
//     ∈ (credential.max_capabilities ∩ session.active_capabilities)
// `req.agentCredentialScopes` is the MAX side of that intersection. Active
// capabilities (per-session) live on a separate runtime channel. v0 enforces
// MAX via the route allowlist; the intersection wiring lands once
// `session.active_capabilities` ship.
// =============================================================================

async function authenticateAgentCredential(
  req: Request,
  apiKey: string,
): Promise<
  | { ok: true }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const outcome = await authenticateAgentApiKey(apiKey);
  if (!outcome.ok) {
    // An expired key (#wg-rbac:#27) has its own code: its holder renews it
    // and retries; nothing else is renewed. The request runs nothing.
    if (outcome.reason === "expired") {
      return {
        ok: false,
        status: 401,
        body: { ...refusalBody({
          code: AGENT_CREDENTIAL_EXPIRED_CODE,
          error: "This agent credential has expired: renew it, or issue a new one, then send the request again.",
        }) },
      };
    }
    return { ok: false, status: 401, body: { error: "Invalid agent credential" } };
  }
  const credential = outcome.credential;

  // Reject if the credential's server has been deleted. Mirrors the
  // post-auth liveness check used by `requireMachineAuth`.
  const db = getDb();
  const serverLivenessStart = Date.now();
  const [serverRow] = await db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.id, credential.serverId), isNull(servers.deletedAt)));
  addTraceEvent("agent_credential_auth.server_liveness.checked", {
    duration_ms: Date.now() - serverLivenessStart,
    outcome: serverRow ? "found" : "missing",
  });
  if (!serverRow) {
    return { ok: false, status: 401, body: { error: "Server no longer exists" } };
  }

  // Defense-in-depth: the lookup already joins on `agents.deletedAt IS NULL`,
  // but verify again so semantics stay correct if the JOIN is removed.
  const agentLivenessStart = Date.now();
  const [agentRow] = await db
    .select({ id: agents.id, runtime: agents.runtime, managedByAppInstallId: agents.managedByAppInstallId, assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, credential.agentId), isNull(agents.deletedAt)));
  addTraceEvent("agent_credential_auth.agent_liveness.checked", {
    duration_ms: Date.now() - agentLivenessStart,
    outcome: agentRow ? "found" : "missing",
  });
  if (!agentRow) {
    return { ok: false, status: 401, body: { error: "Agent no longer exists" } };
  }

  // An App-minted key belongs to a managed App Bot. Once its installation is
  // gone (managed_by_app_install_id SET NULL by the cascade) the Bot is no
  // longer managed by anything, and its key must not live on as an ordinary
  // agent's.
  if (credential.issuedVia === "app" && !agentRow.managedByAppInstallId) {
    return { ok: false, status: 401, body: { error: "App bot binding not active" } };
  }

  // Managed app bot: verify the binding + install grant are still live.
  // Without this, a revoked install's bot key would stay valid until the
  // per-request binding check catches it — too late.
  if (agentRow.managedByAppInstallId) {
    const botCheckStart = Date.now();
    const [bindingRow] = await db
      .select({
        state: appBotBindings.state,
        installStatus: oauthClientInstalls.status,
        botGrant: oauthClientInstalls.botGrant,
      })
      .from(appBotBindings)
      .innerJoin(oauthClientInstalls, eq(appBotBindings.installId, oauthClientInstalls.id))
      .where(and(
        eq(appBotBindings.agentId, agentRow.id),
        eq(appBotBindings.installId, agentRow.managedByAppInstallId),
      ))
      .limit(1);
    addTraceEvent("agent_credential_auth.app_bot_binding.checked", {
      duration_ms: Date.now() - botCheckStart,
      outcome: bindingRow ? "found" : "missing",
    });
    const bindingLive = bindingRow
      && bindingRow.state === "active"
      && bindingRow.installStatus === "active"
      && bindingRow.botGrant === "granted";
    if (!bindingLive) {
      return { ok: false, status: 401, body: { error: "App bot binding not active" } };
    }
  }

  req.principalKind = "agent_credential";
  req.agentCredentialId = credential.credentialId;
  req.agentCredentialScopes = credential.scopes;
  req.actingAgentId = credential.agentId;
  req.serverId = asServerId(credential.serverId);

  // Bind read-only service restrictions to identity, including alternate credentials.
  const [raftbenchBinding] = await getDb().select({ agentId: raftbenchServiceAgents.agentId })
    .from(raftbenchServiceAgents).where(and(eq(raftbenchServiceAgents.serverId, credential.serverId),
      eq(raftbenchServiceAgents.agentId, credential.agentId))).limit(1);
  if (raftbenchBinding || credential.scopes.includes("raftbench")) {
    req.raftbenchServiceAgent = true;
    if (!isPilotServer(credential.serverId, process.env.DEPLOYMENT_ENV)) {
      return { ok: false, status: 403, body: { error: "RaftBench is unavailable on this server or deployment.", code: "raftbench_server_not_allowed", suggestedNextAction: "Use an enrolled staging server. Production is not enrolled." } };
    }
    const path = req.originalUrl.split("?")[0].replace(/\/$/, "");
    const webhookPath = path === "/internal/agent-api/push-webhook";
    let providerWebhook = false;
    if (webhookPath && req.method === "PUT" && typeof req.body?.url === "string") {
      try {
        const endpoint = new URL(req.body.url);
        const [provision] = await getDb().select({ provider: agentRuntimeProvisions.provider, target: agentRuntimeProvisions.providerTarget })
          .from(agentRuntimeProvisions).where(and(eq(agentRuntimeProvisions.agentId, credential.agentId), eq(agentRuntimeProvisions.serverId, credential.serverId))).limit(1);
        const provider = provision ? resolveProviderConfig(provision.provider, process.env, provision.target) : null;
        providerWebhook = !!provider && endpoint.origin === new URL(provider.baseUrl).origin
          && endpoint.pathname.startsWith("/hooks/") && endpoint.pathname.length > "/hooks/".length
          && !endpoint.search && !endpoint.hash && !endpoint.username && !endpoint.password;
      } catch { /* Malformed or non-provider destinations remain refused. */ }
    }
    if (webhookPath && req.method === "PUT" && !providerWebhook) {
      return { ok: false, status: 403, body: { error: "Inbox delivery for this service agent must use the configured staging provider origin with a /hooks/<id> path and no query, fragment or credentials; this URL was refused.", code: "raftbench_read_only", suggestedNextAction: "Use the configured Antiproton provider hook URL. If provider configuration is unavailable, ask the deployment owner to restore it; do not try another destination." } };
    }
    const allowed = (req.method === "GET" && ["/internal/agent-api", "/internal/agent-api/events", "/internal/agent-api/context", "/internal/agent-api/raftbench/context"].includes(path)) ||
      (webhookPath && ["GET", "DELETE"].includes(req.method)) || providerWebhook ||
      (req.method === "POST" && path === "/internal/agent-api/raftbench/submit");
    if (!allowed) {
      return { ok: false, status: 403, body: { error: "This service agent can only check its identity, configure inbox delivery on its staging provider, receive run assignments, read its RaftBench context and submit its result.", code: "raftbench_read_only", suggestedNextAction: "Use the assigned RaftBench run to read context and submit a result. Do not send messages, edit tasks or try other operations; retrying will not help." } };
    }
  }

  if (agentRow.assistantOwnerUserId) {
    req.actingAgentAssistantOwnerUserId = agentRow.assistantOwnerUserId;
    if (!isAssistantAgentApiRequestAllowed(req.method, req.originalUrl.split("?")[0])) {
      addTraceEvent("agent_credential_auth.assistant_route_refused", { method: req.method });
      return { ok: false, status: 403, body: { ...ASSISTANT_ROUTE_NOT_ALLOWED_BODY } };
    }
    // It acts as its owner: only while the owner's organization lets the owner (RFC 083 §6.2).
    const [owner] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, agentRow.assistantOwnerUserId));
    if (owner && !(await assistantOwnerPassesSso({ userId: agentRow.assistantOwnerUserId, email: owner.email })).ok) {
      addTraceEvent("agent_credential_auth.assistant_owner_sso_required", {});
      return { ok: false, status: 403, body: { ...ASSISTANT_OWNER_SSO_REQUIRED_BODY } };
    }
  }

  req.actingAgentIsExternal = isExternalAgentRuntime(agentRow.runtime);

  // Best-effort observability triple + external-agent presence — fire and
  // forget, throttled per credential. Failure does not affect the request
  // path; see `recordAgentCredentialUse` notes.
  recordAgentApiSeen(req);

  return { ok: true };
}

/**
 * Require a `sk_agent_*` credential. Sets `req.actingAgentId`,
 * `req.serverId`, `req.agentCredentialId`, `req.agentCredentialScopes`,
 * `req.principalKind = "agent_credential"`.
 *
 * Mounted on `/internal/agent-api/*`. Wrong-principal tokens (sk_machine_*,
 * sk_computer_*, JWT) get 401 `invalid_principal`.
 */
export async function requireAgentCredentialAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing agent credential" });
    return;
  }
  const apiKey = authHeader.slice(7);
  if (!isAgentApiKey(apiKey)) {
    // Wrong-principal class — per RFC §5.6 this is a distinct error from
    // "missing credential" / "invalid credential". The body code lets the
    // CLI distinguish "you have the wrong kind of key" from "your key is
    // bad". Status stays 401 (not 403) because the principal cannot reach
    // this surface at all.
    res.status(401).json({
      error: "Invalid authentication: agent credential required",
      code: "invalid_principal",
    });
    return;
  }
  const result = await authenticateAgentCredential(req, apiKey);
  if (!result.ok) {
    res.status(result.status).json(result.body);
    return;
  }
  // Every span under this request carries the acting agent's hash (never the
  // raw id); the request span stamps its own at end.
  const agentHash = agentIdHashAttrs(req.actingAgentId);
  runWithTraceAttrs({
    ...(agentHash.agent_id_hash ? { ...agentHash, agent_id_present: true } : {}),
    ...serverIdHashAttrs(req.serverId),
  }, next);
}

// =============================================================================
// `rfcs/034-slock-credential-rfc.zh.html#section-credential-model` —
// `sk_computer_*` host auth.
//
// Surface model (base RFC §1 credential model + §2.1 Computer surface):
//   `sk_computer_*` is the canonical credential for `/internal/computer/*`.
//   Phase 1 also accepts existing `sk_machine_*` machine keys as migration
//   aliases for this surface. The credential row encodes its bound
//   `computerId` + `serverId`. Slice-1 active surface:
//     POST /internal/computer/runners/:agentId/credentials  — runner mint
//
// Wrong-principal denial (base RFC §2.4 wrong-principal semantics): an
// `sk_computer_*` key presented at a non-`/internal/computer/*` path
// returns 401 `invalid_principal`, not 404. Reciprocal on the other side.
// The dispatcher that selects which auth applies lives in
// `middleware/authFromRegistry.ts` — this middleware is the leaf for paths
// the registry maps to `sk_computer` principal.
//
// Slice-1 minimal stub: the canonical Computer attachment lifecycle
// (attach/detach UX flow, ScopeDB triple-sink, credential-replace path on
// re-attach) is Tao's Phase 1 deliverable. This middleware will be
// reconciled with that shape when Phase 1 lands.
// =============================================================================

/**
 * Require a `sk_computer_*` credential, or a Phase 1 machine-key
 * Computer alias. Sets `req.computerId`, `req.serverId`,
 * `req.principalKind = "computer"`.
 *
 * Mounted on `/internal/computer/*`. Wrong-principal tokens (sk_agent_*,
 * JWT) get 401 `invalid_principal`; sk_machine_* is accepted only here as the
 * phase-1 Computer alias.
 */
export async function requireComputerAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing computer credential" });
    return;
  }
  const apiKey = authHeader.slice(7);
  if (apiKey.startsWith("sk_machine_")) {
    // Phase-1 migration alias: existing machine credentials are accepted as
    // Computer host principals for the new `/internal/computer/*`
    // control surface. This keeps current attached hosts usable before the
    // wire prefix is renamed to `sk_computer_*`; the alias must not be
    // accepted on `/internal/agent-api/*`.
    const machine = await findMachineByApiKey(apiKey);
    if (!machine) {
      res.status(401).json({ error: "Invalid computer credential" });
      return;
    }

    // RFC v8.2 §5.11.3: post-adoption the sk_machine_* alias must fail
    // closed. Same `legacyKeyMigratedAt` check as the canonical
    // `/internal/machine/*` path — the alias does not get a softer rule.
    if ("legacyKeyMigratedAt" in machine && machine.legacyKeyMigratedAt) {
      res.status(401).json({
        error: "Legacy machine key has been migrated to a Computer attachment",
        code: "legacy_machine_key_migrated",
      });
      return;
    }

    const db = getDb();
    const [serverRow] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, machine.serverId), isNull(servers.deletedAt)));
    if (!serverRow) {
      res.status(401).json({ error: "Server no longer exists" });
      return;
    }

    req.principalKind = "computer";
    req.computerId = machine.id;
    req.machineId = asMachineId(machine.id);
    req.serverId = asServerId(machine.serverId);
    req.daemonVersion = "daemonVersion" in machine ? machine.daemonVersion ?? null : null;
    next();
    return;
  }

  if (!isComputerApiKey(apiKey)) {
    // Wrong-principal class — per RFC §5.6 this is a distinct error from
    // "missing credential" / "invalid credential".
    res.status(401).json({
      error: "Invalid authentication: computer credential required",
      code: "invalid_principal",
    });
    return;
  }

  const computer = await findComputerByApiKey(apiKey);
  if (!computer) {
    res.status(401).json({ error: "Invalid computer credential" });
    return;
  }

  req.principalKind = "computer";
  req.computerId = computer.computerId;
  req.serverId = asServerId(computer.serverId);

  // Best-effort observability triple — fire and forget.
  void recordComputerUse({
    computerId: computer.computerId,
    ip: typeof req.ip === "string" ? req.ip : null,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : null,
  });

  next();
}
