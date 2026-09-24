import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { eq, and, isNull, ne } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, serverMembers, servers, sessionFamilies } from "../db/schema.js";
import { findMachineByApiKey, getMachine } from "../services/machineService.js";
import {
  findAgentCredentialByApiKey,
  isAgentApiKey,
  recordAgentCredentialUse,
} from "../services/agentCredentialService.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import {
  findComputerByApiKey,
  isComputerApiKey,
  recordComputerUse,
} from "../services/computerCredentialService.js";
import { accountNeedsIdentitySetup, asServerId, asMachineId, isOwnerRole, type ServerId, type MachineId } from "@botiverse/raft-shared";
import { agents } from "../db/schema.js";

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

export function signAccessToken(userId: string, familyId?: string): string {
  return jwt.sign({ sub: userId, type: "access", ...(familyId ? { familyId } : {}) }, JWT_SECRET(), { expiresIn: "15m" });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ sub: userId, type: "refresh" }, JWT_SECRET(), { expiresIn: "30d" });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET()) as JwtPayload;
}

/** Verify the live account/session at every user-token entry point. Legacy
 * access tokens without a family remain supported until their normal expiry. */
export async function verifyActiveAccessToken(token: string): Promise<JwtPayload | null> {
  let payload: JwtPayload;
  try {
    payload = verifyToken(token);
  } catch {
    return null;
  }
  if (payload.type !== "access") return null;
  const db = getDb();
  const [user] = await db.select({ id: users.id, retiredAt: users.retiredAt })
    .from(users).where(eq(users.id, payload.sub)).limit(1);
  if (!user || user.retiredAt) return null;
  if (payload.familyId) {
    const [family] = await db.select({ revokedAt: sessionFamilies.revokedAt })
      .from(sessionFamilies).where(and(
        eq(sessionFamilies.id, payload.familyId),
        eq(sessionFamilies.userId, payload.sub),
      )).limit(1);
    if (!family || family.revokedAt) return null;
  }
  return payload;
}

export async function getBearerAccessUserId(authHeader: string | undefined): Promise<string | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return (await verifyActiveAccessToken(authHeader.slice(7)))?.sub ?? null;
}

export function respondInvalidOrExpiredToken(res: Response): void {
  res.status(401).json({ error: "Invalid or expired token", code: "auth_required" });
}

function isHtmlPreviewRequestForAttachment(req: Request, attachmentId: string): boolean {
  const [pathAttachmentId, previewPath, ...rest] = req.path.split("/").filter(Boolean);
  return pathAttachmentId === attachmentId && previewPath === "html-preview" && rest.length === 0;
}

/**
 * Require a valid JWT access token. Sets req.userId.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header", code: "auth_required" });
    return;
  }

  void verifyActiveAccessToken(authHeader.slice(7)).then((payload) => {
    if (!payload) { respondInvalidOrExpiredToken(res); return; }
    req.userId = payload.sub;
    req.sessionFamilyId = payload.familyId;
    next();
  }).catch(next);
}

/** Retirement is deliberately idempotent: the caller's access token remains the
 * actor handle for the terminal receipt after refresh/session state is revoked. */
export function requireRetirementAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) { respondInvalidOrExpiredToken(res); return; }
  try {
    const payload = verifyToken(authHeader.slice(7));
    if (payload.type !== "access") { respondInvalidOrExpiredToken(res); return; }
    req.userId = payload.sub;
    req.sessionFamilyId = payload.familyId;
    next();
  } catch { respondInvalidOrExpiredToken(res); }
}

/**
 * Require that the authenticated user has verified their email.
 * Must be used after requireAuth.
 */
export async function requireVerified(req: Request, res: Response, next: NextFunction): Promise<void> {
  const db = getDb();
  const [user] = await db
    .select({ emailVerified: users.emailVerified })
    .from(users)
    .where(eq(users.id, req.userId!));

  if (!user) {
    respondInvalidOrExpiredToken(res);
    return;
  }

  if (!user.emailVerified) {
    res.status(403).json({ error: "Email verification required" });
    return;
  }

  await requireProfileSetupComplete(req, res, next);
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
  const db = getDb();
  const [user] = await db
    .select({ profileSetupCompletedAt: users.profileSetupCompletedAt, name: users.name })
    .from(users)
    .where(eq(users.id, req.userId!));

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
export async function requireServer(req: Request, res: Response, next: NextFunction): Promise<void> {
  const serverId = req.headers["x-server-id"] as string;
  if (!serverId) {
    res.status(400).json({ error: "Missing X-Server-Id header" });
    return;
  }

  const db = getDb();
  const [membership] = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(and(
      eq(serverMembers.serverId, serverId),
      eq(serverMembers.userId, req.userId!),
      ne(servers.kind, "joint_storage"),
      isNull(servers.deletedAt),
    ));

  if (!membership) {
    res.status(403).json({ error: "Not a member of this server" });
    return;
  }

  req.serverId = asServerId(serverId);
  next();
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

    // Keep credential retirement identical to the internal machine surface.
    if (token.startsWith("sk_machine_") || token.startsWith("sk_daemon_") || isComputerApiKey(token)) {
      await requireMachineAuth(req, res, next);
      return;
    }

    const payload = await verifyActiveAccessToken(token);
    if (payload) {
      req.userId = payload.sub;
      req.sessionFamilyId = payload.familyId;
      next();
      return;
    }
  }

  // Fresh-tab downloads cannot send headers; apply the same live-session
  // check to their query bearer as to Authorization.
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  if (queryToken) {
    const payload = await verifyActiveAccessToken(queryToken);
    if (payload) {
      req.userId = payload.sub;
      req.sessionFamilyId = payload.familyId;
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
  const [membership] = await db
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
  next();
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
  next();
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
  const credential = await findAgentCredentialByApiKey(apiKey);
  if (!credential) {
    return { ok: false, status: 401, body: { error: "Invalid agent credential" } };
  }

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
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, credential.agentId), isNull(agents.deletedAt)));
  addTraceEvent("agent_credential_auth.agent_liveness.checked", {
    duration_ms: Date.now() - agentLivenessStart,
    outcome: agentRow ? "found" : "missing",
  });
  if (!agentRow) {
    return { ok: false, status: 401, body: { error: "Agent no longer exists" } };
  }

  req.principalKind = "agent_credential";
  req.agentCredentialId = credential.credentialId;
  req.agentCredentialScopes = credential.scopes;
  req.actingAgentId = credential.agentId;
  req.serverId = asServerId(credential.serverId);

  // Best-effort observability triple — fire and forget. Failure does not
  // affect the request path; see `recordAgentCredentialUse` notes.
  void recordAgentCredentialUse({
    credentialId: credential.credentialId,
    ip: typeof req.ip === "string" ? req.ip : null,
    userAgent:
      typeof req.headers["user-agent"] === "string"
        ? req.headers["user-agent"]
        : null,
  });

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
  next();
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
