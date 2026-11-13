/**
 * `POST /api/agents/:id/credentials` — mint a fresh `sk_agent_*` agent
 * credential bound to a specific agent, consuming a normal user session.
 * GET at the same path lists safe credential metadata; DELETE /:credentialId
 * revokes one credential using the same subject authority. Management remains
 * available when the mint feature gate is disabled.
 *
 * Lives in its own router (not under `agentRouter`) because — unlike every
 * other `/api/agents/*` route — it MUST NOT require an `X-Server-Id`
 * request header. The path parameter `:id` IS the subject, and an agent
 * belongs to exactly one server, so the server context is derived from the
 * agent row, not from the header. Requiring the header here would force
 * the caller (e.g. `slock agent login`) to know the serverId out-of-band,
 * which defeats the agent-facing "give me a credential for agent X on
 * server URL Y" UX. See `#proj-runtime:3d515727` — Hao + XX + Dayu signed
 * off on this carve-out (XX msg=833d1fb8 §5 axis, Hao msg=b50c93bd review
 * gate).
 *
 * Per-subject mint endpoint that consumes a normal user session
 * (`requireAuth` runs ahead). The user session may have been minted by
 * any of: legacy email/password login, OAuth, or the device-code grant
 * (`/api/auth/device/*` from PR-A2 #1916 — see Computer RFC §4.2 for the
 * device-code surface; the credential model itself is anchored at base
 * RFC `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`).
 * This is the agent-side mirror of the Computer side's
 * `/api/computer/attach`: device-code → user session → per-subject
 * credential mint.
 *
 * "external agent" intent (xxchan msg=edbc4976): the resulting
 * `sk_agent_*` is for a human user to wear the agent's identity via the
 * CLI. No "runner" / daemon spawning Claude or Codex locally — the
 * runner concept lives on the managed-daemon path only.
 *
 * Gated by `SLOCK_DEVICE_LOGIN_ENABLED` so the surface ships together
 * with the device-code grant; deployments that don't want `sk_agent_*`
 * to be mintable via web session simply don't flip the flag.
 *
 * Request body: { scopes?: string[], name?: string, replacesCredentialId?: string }
 *   - scopes: subset of ALLOWED_AGENT_CAPABILITIES. Defaults to the
 *     least-privilege DEFAULT_EXTERNAL_AGENT_CAPABILITIES (no `server`, no
 *     `mcp`); elevated scopes must be named explicitly.
 *   - name: optional human-readable label for the credential row.
 *   - replacesCredentialId: rotation — the credential this client's profile
 *     held until now (`raft agent login` re-login). It is revoked in the
 *     same transaction as the mint. Other credentials of the agent (other
 *     devices/profiles) are left alone.
 *
 * Error contract (anti-enumeration):
 *   - 404 `agent_missing` covers BOTH "agent id does not exist" AND
 *     "user is not a member of the agent's server". Merging these
 *     prevents cross-server enumeration: a logged-in user can't probe
 *     which other servers an agent exists on by hitting this endpoint.
 *   - 403 `insufficient_role` is only returned when the user IS a
 *     member of the agent's server but is neither the creator nor a holder of
 *     `issueAgentCredentials`. This is
 *     the standard "you're authenticated but not authorized" signal.
 *   - 400 `scopes_invalid` / `scopes_empty` / `name_invalid` /
 *     `replaces_credential_invalid` for body validation failures.
 *   - 400 `agent_not_external` when the agent is managed: its credentials
 *     come only from its Computer (`/internal/computer/runners/...`).
 *   - 404 `device_login_disabled` when the feature gate is off.
 *   - 429 `agent_credential_mint_rate_limited` (Retry-After) past the per-person
 *     or per-agent mint rate, 409 `agent_credential_limit_reached` when the
 *     agent already holds the most live person-issued keys
 *     (services/agentCredentialMintLimits.ts).
 *   - A non-UUID `:id` is the same 404 `agent_missing`; a non-UUID
 *     `:credentialId` the same 404 `credential_missing` as an unknown one.
 */

import type { Request, Response } from "express";

import * as agentService from "../services/agentService";
import {
  DEFAULT_EXTERNAL_AGENT_CAPABILITIES,
  mintAgentCredential,
  listAgentCredentials,
  revokeAgentCredentialWithOutcome,
  resolveRequestedAgentCapabilities,
} from "../services/agentCredentialService";
import { newAuditOperationId, recordIntegrationAuditEvent, serverAuditContextMetadata } from "../services/integrationAuditService";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import { broadcastAgentCredentialRevocation } from "../replicaRouter";
import { isDeviceAuthSurfaceEnabled, notifyDeviceSessionAction } from "../services/deviceAuthService";
import { DeviceSessionRevokedError, deviceSessionFamilyOf, lockLiveSessionFamily, webSessionFamilyOf } from "../services/sessionService";
import { respondInvalidOrExpiredToken } from "../middleware/auth";
import { addTraceEvent } from "../tracing/semanticTrace";
import { isAgentFindableBy } from "../services/agentMemberListPolicy";
import { resolveActorContext, userCanActOnAgentResource } from "../lib/actorPermissions";
import { sendJsonServerError } from "./errorResponse";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";
import { enforceAgentCredentialMintRate } from "../services/agentCredentialMintLimits";
import { and, eq, isNull } from "drizzle-orm";
import { agents as agentsTable } from "../db/schema";
import type { DatabaseTransaction } from "../db/index";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError, withActorMembershipFence } from "../lib/actorMembershipFence";

// Shared 404 response for both "agent does not exist" and "user is not a
// member of the agent's server". Going through one helper keeps the two
// anti-enumeration branches byte-identical (same status, same body, same
// `code`) — see XX msg=1a7c8105 / Hao msg=b50c93bd. Timing-side leakage
// (one branch is one DB roundtrip slower) is a separate concern, not
// addressed here.
function respondAgentMissing(res: Response): void {
  res.status(404).json({ error: "Agent not found", code: "agent_missing" });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function respondAgentNotExternal(res: Response): void {
  res.status(400).json({
    error: "Credentials can only be issued for external agents; a managed agent's credentials come from its computer",
    code: "agent_not_external",
  });
}

function respondReplacesCredentialInvalid(res: Response): void {
  res.status(400).json({
    error: "replacesCredentialId must be the id of one of this agent's credentials",
    code: "replaces_credential_invalid",
  });
}

// Mint, list and revoke use the same subject-derived authority boundary.
async function authorizedAgent(req: Request<{ id: string }>, res: Response) {
  // A non-UUID id names no agent: the same 404, not the uuid cast's error.
  const agent = UUID_RE.test(req.params.id) ? await agentService.getAgent(req.params.id) : null;
  // Another person's personal assistant is missing, for every role (agentFindableBy).
  if (!agent || !isAgentFindableBy({ userId: req.userId }, agent)) { respondAgentMissing(res); return null; }
  const actor = await resolveActorContext(agent.serverId, "user", req.userId!);
  if (actor.serverRole === null) { respondAgentMissing(res); return null; }
  if (!userCanActOnAgentResource(actor.serverRole, req.userId!, agent, "issueAgentCredentials")) {
    res.status(403).json({
      error: "The `issueAgentCredentials` capability or human creator authority is required to manage agent credentials",
      code: "insufficient_role",
    });
    return null;
  }
  return agent;
}

// Task #91: credential writes re-authorize inside the write transaction under a share lock on the caller's membership
// row (member row first), then a share lock on the agent row (agent row second).
async function withFencedCredentialAuthority<T>(
  agent: { id: string; serverId: string },
  userId: string,
  run: (tx: DatabaseTransaction, lockedRole: Parameters<typeof userCanActOnAgentResource>[0]) => Promise<T>,
): Promise<T> {
  return withActorMembershipFence(agent.serverId, userId, async (tx, lockedRole) => {
    const [locked] = await tx
      .select({
        id: agentsTable.id,
        serverId: agentsTable.serverId,
        creatorType: agentsTable.creatorType,
        creatorId: agentsTable.creatorId,
        assistantOwnerUserId: agentsTable.assistantOwnerUserId,
      })
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agent.id), isNull(agentsTable.deletedAt)))
      .for("share");
    if (!locked || locked.serverId !== agent.serverId) throw new FencedAuthorizationDeniedError("not_found");
    if (!userCanActOnAgentResource(lockedRole, userId, locked, "issueAgentCredentials")) {
      throw new FencedAuthorizationDeniedError("forbidden");
    }
    return run(tx, lockedRole);
  });
}

// Keeps this surface's anti-enumeration contract: membership lost mid-request is byte-identical to "agent does not exist".
function respondFencedCredentialError(error: unknown, res: Response): boolean {
  if (error instanceof ServerMembershipRevokedError
    || (error instanceof FencedAuthorizationDeniedError && error.reason === "not_found")) {
    respondAgentMissing(res);
    return true;
  }
  if (error instanceof FencedAuthorizationDeniedError) {
    res.status(403).json({
      error: "The `issueAgentCredentials` capability or human creator authority is required to manage agent credentials",
      code: "insufficient_role",
    });
    return true;
  }
  return false;
}

// Listing and revocation must still work when new issuance is disabled.
export async function listAgentCredentialsHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
  try {
    const agent = await authorizedAgent(req, res);
    if (!agent) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ agentId: agent.id, credentials: await listAgentCredentials(agent.id) });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list agent credentials", logPrefix: "agents.credentials.list error:", err });
  }
}

export async function revokeAgentCredentialHandler(req: Request<{ id: string; credentialId: string }>, res: Response): Promise<void> {
  try {
    const agent = await authorizedAgent(req, res);
    if (!agent) return;
    const credentialId = req.params.credentialId;
    const validId = UUID_RE.test(credentialId);
    const revoked = validId && await withFencedCredentialAuthority(agent, req.userId!, async (tx, lockedRole) => {
      const outcome = await revokeAgentCredentialWithOutcome({
        credentialId, agentId: agent.id, serverId: agent.serverId,
        reason: "user_revoked", revokedByUserId: req.userId!,
      }, { executor: tx });
      // An idempotent repeat revokes nothing, so it records nothing.
      if (outcome === "revoked") {
        await recordIntegrationAuditEvent({
          serverId: agent.serverId,
          eventType: "agent_credential.revoked",
          outcome: "success",
          source: "web",
          actor: { type: "human", id: req.userId! },
          subject: { type: "agent", id: agent.id },
          target: { type: "agent_credential", id: credentialId },
          metadata: { agentId: agent.id, credentialId, reason: "user_revoked", ...serverAuditContextMetadata({ actorRole: lockedRole }) },
        }, tx);
      }
      return outcome !== null;
    });
    if (!revoked) {
      res.status(404).json({ error: "Credential not found", code: "credential_missing" });
      return;
    }
    // After commit: close this agent's open streams on every replica now.
    await broadcastAgentCredentialRevocation(agent.id);
    addTraceEvent("agents.credentials.revoked", { agent_id: agent.id, server_id: agent.serverId, credential_id: credentialId, user_id: req.userId! });
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  } catch (error) {
    if (respondFencedCredentialError(error, res)) return;
    res.status(500).json({ error: "Failed to revoke agent credential" });
  }
}

export async function agentCredentialsHandler(
  req: Request<{ id: string }>,
  res: Response,
): Promise<void> {
  if (!isDeviceAuthSurfaceEnabled()) {
    res.status(404).json({
      error: "Device login (and the agent credential mint surface that depends on it) is not enabled",
      code: "device_login_disabled",
    });
    return;
  }

  try {
    // `includeDeleted: false` is intentional. Soft-deleted agents must
    // be indistinguishable from never-existed agents at this surface —
    // otherwise a member who lacks `issueAgentCredentials` could probe deletion
    // state by observing 403 vs 404, and bad-body callers could see
    // 400 `scopes_invalid` before the anti-enum 404. Hao caught this
    // in #proj-runtime:3d515727 msg=db4ddd50.
    const agent = await authorizedAgent(req, res);

    // Anti-enumeration: collapse "agent doesn't exist" + "not a member of
    // its server" into the same 404 response. A logged-in user MUST NOT be
    // able to probe which other servers an agent exists on.
    if (!agent) {
      return;
    }

    // Managed agents get credentials only from their Computer; a key minted
    // here could drain/ack the daemon's delivery buffer via `/events`.
    if (!isExternalAgentRuntime(agent.runtime)) {
      respondAgentNotExternal(res);
      return;
    }

    const body = (req.body ?? {}) as { scopes?: unknown; name?: unknown; replacesCredentialId?: unknown };

    const requested = resolveRequestedAgentCapabilities(body.scopes, DEFAULT_EXTERNAL_AGENT_CAPABILITIES);
    if (!requested.ok) {
      res.status(400).json({ error: requested.error, code: requested.code });
      return;
    }
    const scopes = requested.scopes;

    let replacesCredentialId: string | null = null;
    if (body.replacesCredentialId !== undefined && body.replacesCredentialId !== null) {
      if (typeof body.replacesCredentialId !== "string" || !UUID_RE.test(body.replacesCredentialId)) {
        respondReplacesCredentialInvalid(res);
        return;
      }
      replacesCredentialId = body.replacesCredentialId;
    }

    let name: string | null = null;
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length > 200) {
        res.status(400).json({
          error: "name must be a string up to 200 chars",
          code: "name_invalid",
        });
        return;
      }
      name = body.name;
    }

    // The raw key is generated inside the fenced transaction and returned only after it commits.
    // A device login's session records itself on the credential (any revoke
    // of it revokes the credential); a person's own web session records itself
    // in its own column (a security revoke of it revokes the credential,
    // webSessionIssuedKeys.ts). Either fences its live family for the write.
    const deviceFamilyId = deviceSessionFamilyOf(req);
    const webFamilyId = webSessionFamilyOf(req);
    // From the web, with two-step verification on: this sign-in passed it in
    // the last 10 minutes (stepUpGate.ts). Not a device login's session (the
    // CLI's `raft agent login`): it cannot step up, and its approval already
    // needed a verified sign-in (approverSecondFactorCheck).
    if (!deviceFamilyId && await refuseWithoutRecentSecondFactor(res, req.userId!, webFamilyId, "agent_credential_mint")) return;
    // Which kind of session minted it (a device login's is not gated above):
    // on the audit event and the trace. Its family id goes only in the trace
    // (Tenny): server admins see the audit event and can't act on a member's
    // sign-in id.
    const sessionSource = deviceFamilyId ? "device_session" : webFamilyId ? "web_session" : null;
    const sessionFamilyId = deviceFamilyId ?? webFamilyId;
    // Per person and per agent (agentCredentialMintLimits.ts); the live-key cap
    // is checked inside mintAgentCredential's transaction.
    await enforceAgentCredentialMintRate({ userId: req.userId!, agentId: agent.id });
    const minted = await withFencedCredentialAuthority(agent, req.userId!, async (tx, lockedRole) => {
      if (sessionFamilyId) await lockLiveSessionFamily(tx, sessionFamilyId, req.userId!);
      const credential = await mintAgentCredential({
        agentId: agent.id,
        scopes,
        issuedVia: "human",
        createdByUserId: req.userId!,
        issuedBySessionFamilyId: deviceFamilyId,
        issuedByWebSessionFamilyId: webFamilyId,
        requireExternalRuntime: true,
        replacesCredentialId,
        ...(name !== null ? { name } : {}),
      }, { executor: tx });
      // Ids and scopes only: never the key, its prefix or its hash. A rotation's
      // revoke and issue are one operation.
      const audit = serverAuditContextMetadata({
        actorRole: lockedRole,
        ...(credential.replacedCredentialId ? { operationId: newAuditOperationId() } : {}),
      });
      if (credential.replacedCredentialId) {
        await recordIntegrationAuditEvent({
          serverId: credential.serverId,
          eventType: "agent_credential.revoked",
          outcome: "success",
          source: "web",
          actor: { type: "human", id: req.userId! },
          subject: { type: "agent", id: credential.agentId },
          target: { type: "agent_credential", id: credential.replacedCredentialId },
          metadata: { agentId: credential.agentId, credentialId: credential.replacedCredentialId, reason: "rotated", ...audit },
        }, tx);
      }
      await recordIntegrationAuditEvent({
        serverId: credential.serverId,
        eventType: "agent_credential.issued",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: req.userId! },
        subject: { type: "agent", id: credential.agentId },
        target: { type: "agent_credential", id: credential.credentialId },
        metadata: {
          agentId: credential.agentId,
          credentialId: credential.credentialId,
          scopes: credential.scopes,
          issuedVia: credential.issuedVia,
          replacedCredentialId: credential.replacedCredentialId,
          sessionSource,
          ...audit,
        },
      }, tx);
      return credential;
    });
    if (minted.replacedCredentialId) {
      await broadcastAgentCredentialRevocation(minted.agentId);
      addTraceEvent("agents.credentials.revoked", {
        agent_id: minted.agentId,
        server_id: minted.serverId,
        credential_id: minted.replacedCredentialId,
        user_id: req.userId!,
      });
    }

    // Request-path audit trace event (sister to `credential_issued`
    // domain lifecycle event emitted inside the service). XX msg=2cb5b485:
    // both coexist on purpose — this one is the who/when/derived-serverId
    // record for security trace; the lifecycle event is the domain fact.
    // Derived serverId is logged explicitly so audit can correlate "user
    // X minted cred for agent Y in server Z" without joining back through
    // the agent row.
    addTraceEvent("agents.credentials.minted", {
      agent_id: minted.agentId,
      server_id: minted.serverId,
      credential_id: minted.credentialId,
      user_id: req.userId!,
      scopes_count: minted.scopes.length,
      ...(sessionSource ? { session_source: sessionSource, session_family_id: sessionFamilyId } : {}),
    });

    // Minted by a device login's session (`raft agent login wait`): the
    // person gets told, with a revoke link (part C of the phishing fix).
    void notifyDeviceSessionAction({
      userId: req.userId,
      familyId: req.sessionFamilyId,
      scope: req.sessionScope,
      event: "agent_credential",
      target: { label: "Agent", value: minted.agentName },
    });

    // Raw `sk_agent_*` is surfaced exactly once. The client (e.g.
    // `slock agent login`) must write it to local secret state
    // immediately and forget the value — only the hash persists.
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      credentialId: minted.credentialId,
      apiKey: minted.apiKey,
      scopes: minted.scopes,
      agentId: minted.agentId,
      agentName: minted.agentName,
      serverId: minted.serverId,
    });
  } catch (err) {
    if (err instanceof DeviceSessionRevokedError) {
      respondInvalidOrExpiredToken(res);
      return;
    }
    if (respondFencedCredentialError(err, res)) return;
    if (err instanceof Error && err.message === "agent_missing") {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }
    if (err instanceof Error && err.message === "agent_not_external") {
      respondAgentNotExternal(res);
      return;
    }
    if (err instanceof Error && err.message === "replaces_credential_invalid") {
      respondReplacesCredentialInvalid(res);
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to mint agent credential", logPrefix: "agents.credentials.mint error:", err });
  }
}
