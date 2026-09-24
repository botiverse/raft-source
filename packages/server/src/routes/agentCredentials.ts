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
 * Request body: { scopes?: string[], name?: string }
 *   - scopes: subset of ALLOWED_AGENT_CAPABILITIES. Defaults to ALL.
 *   - name: optional human-readable label for the credential row.
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
 *   - 400 `scopes_invalid` / `scopes_empty` / `name_invalid` for body
 *     validation failures.
 *   - 404 `device_login_disabled` when the feature gate is off.
 */

import type { Request, Response } from "express";

import * as agentService from "../services/agentService.js";
import {
  ALLOWED_AGENT_CAPABILITIES,
  mintAgentCredential,
  listAgentCredentials,
  revokeAgentCredential,
  normalizeAgentCapabilities,
  type AgentCapability,
} from "../services/agentCredentialService.js";
import { isDeviceAuthSurfaceEnabled } from "../services/deviceAuthService.js";
import { addTraceEvent } from "../tracing/semanticTrace.js";
import { resolveActorContext, userCanActOnAgentResource } from "../lib/actorPermissions.js";

// Shared 404 response for both "agent does not exist" and "user is not a
// member of the agent's server". Going through one helper keeps the two
// anti-enumeration branches byte-identical (same status, same body, same
// `code`) — see XX msg=1a7c8105 / Hao msg=b50c93bd. Timing-side leakage
// (one branch is one DB roundtrip slower) is a separate concern, not
// addressed here.
function respondAgentMissing(res: Response): void {
  res.status(404).json({ error: "Agent not found", code: "agent_missing" });
}

// Mint, list and revoke use the same subject-derived authority boundary.
async function authorizedAgent(req: Request<{ id: string }>, res: Response) {
  const agent = await agentService.getAgent(req.params.id);
  if (!agent) { respondAgentMissing(res); return null; }
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

// Listing and revocation must still work when new issuance is disabled.
export async function listAgentCredentialsHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
  try {
    const agent = await authorizedAgent(req, res);
    if (!agent) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ agentId: agent.id, credentials: await listAgentCredentials(agent.id) });
  } catch {
    res.status(500).json({ error: "Failed to list agent credentials" });
  }
}

export async function revokeAgentCredentialHandler(req: Request<{ id: string; credentialId: string }>, res: Response): Promise<void> {
  try {
    const agent = await authorizedAgent(req, res);
    if (!agent) return;
    const credentialId = req.params.credentialId;
    const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(credentialId);
    if (!validId || !await revokeAgentCredential({
      credentialId, agentId: agent.id, serverId: agent.serverId,
      reason: "user_revoked", revokedByUserId: req.userId!,
    })) {
      res.status(404).json({ error: "Credential not found", code: "credential_missing" });
      return;
    }
    addTraceEvent("agents.credentials.revoked", { agent_id: agent.id, server_id: agent.serverId, credential_id: credentialId, user_id: req.userId! });
    res.setHeader("Cache-Control", "no-store");
    res.status(204).end();
  } catch {
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

    const body = (req.body ?? {}) as { scopes?: unknown; name?: unknown };

    let scopes: AgentCapability[];
    if (body.scopes === undefined) {
      scopes = [...ALLOWED_AGENT_CAPABILITIES];
    } else if (!Array.isArray(body.scopes)) {
      res.status(400).json({
        error: "scopes must be an array of capability literals",
        code: "scopes_invalid",
      });
      return;
    } else {
      try {
        scopes = normalizeAgentCapabilities(body.scopes as readonly string[]);
      } catch {
        res.status(400).json({
          error: `scopes must each be one of: ${ALLOWED_AGENT_CAPABILITIES.join(", ")}`,
          code: "scopes_invalid",
        });
        return;
      }
      if (scopes.length === 0) {
        res.status(400).json({
          error: "scopes must include at least one capability",
          code: "scopes_empty",
        });
        return;
      }
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

    const minted = await mintAgentCredential({
      agentId: agent.id,
      scopes,
      createdByUserId: req.userId!,
      ...(name !== null ? { name } : {}),
    });

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
    if (err instanceof Error && err.message === "agent_missing") {
      res.status(404).json({ error: "Agent not found", code: "agent_missing" });
      return;
    }
    console.error("agents.credentials.mint error:", err);
    res.status(500).json({ error: "Failed to mint agent credential" });
  }
}
