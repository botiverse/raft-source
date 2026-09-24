/**
 * Agent credential bootstrap-token exchange primitive
 * (`rfcs/034-slock-credential-rfc.zh.html#section-credential-model`).
 *
 * `POST /api/agent/login` — gated by SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED.
 * Self-hosted runner CLI onboarding is intentionally not published by #1836.
 * The body's `bootstrapToken` was issued by the web admin UI and is the only
 * auth carried by this request. On success the
 * response returns a fresh long-lived `sk_agent_*` key plus the context the
 * CLI needs to write `~/.slock/profiles/<name>/credential.json`.
 *
 * Surface contract:
 *   - Public (no auth required) — bootstrapToken is the only credential
 *   - Single-use — concurrent racers contract per base RFC §2.2 Agent Runner surface
 *   - Raw `sk_agent_*` returned exactly once (never logged, never re-fetchable)
 *
 * Out of the `routeAuthPolicy` registry by design: `/api/*` is intentionally
 * outside the registry per Hao msg=dbbf2b90 + ApplePI msg=94e72249 — the
 * registry's fail-closed contract only governs `/internal/*` + `/daemon/*`.
 *
 * Error code matrix (Tier-1 stable codes per base RFC
 * `#section-error-code-tiers`):
 *   400 missing_bootstrap_token   — body lacked the token
 *   401 token_invalid             — unknown / wrong shape
 *   401 token_revoked             — admin voided before exchange
 *   401 token_expired             — TTL passed
 *   403 token_scope_invalid       — reserved
 *   410 token_consumed            — another racer already exchanged it
 *   410 agent_missing             — agent was soft-deleted between issue + exchange
 *   500 (no code)                 — unexpected
 *
 * The CLI relies on the `code` field to render the right user-visible
 * message ("token already used", "token expired", ...) without parsing the
 * prose `error` field.
 */

import { Router, type Router as RouterType } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { servers } from "../db/schema.js";
import { consumeAgentBootstrapToken, isAgentBootstrapSurfaceEnabled } from "../services/agentCredentialService.js";

export const agentLoginRouter: RouterType = Router();

interface AgentLoginBody {
  bootstrapToken?: unknown;
}

agentLoginRouter.post("/login", async (req, res) => {
  if (!isAgentBootstrapSurfaceEnabled()) {
    res.status(404).json({
      error: "Self-hosted runner bootstrap is not enabled",
      code: "self_hosted_runner_bootstrap_disabled",
    });
    return;
  }

  const body = (req.body ?? {}) as AgentLoginBody;
  const rawToken =
    typeof body.bootstrapToken === "string" ? body.bootstrapToken.trim() : "";
  if (!rawToken) {
    res.status(400).json({
      error: "bootstrapToken is required",
      code: "missing_bootstrap_token",
    });
    return;
  }

  try {
    const result = await consumeAgentBootstrapToken(rawToken, {
      ip: typeof req.ip === "string" ? req.ip : null,
      userAgent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : null,
    });

    if (!result.ok) {
      // Distinct status codes per RFC §7 — see error code matrix above.
      const status =
        result.error === "token_invalid" ? 401 :
        result.error === "token_revoked" ? 401 :
        result.error === "token_expired" ? 401 :
        result.error === "token_consumed" ? 410 :
        result.error === "agent_missing" ? 410 :
        500;
      res.status(status).json({
        error: result.error,
        code: result.error,
      });
      return;
    }

    // Resolve serverSlug so the CLI can render the paste-ready `export
    // RAFT_PROFILE=...` line (RFC §9 Footgun Mitigations / login output is
    // paste-ready).
    const db = getDb();
    const [serverRow] = await db
      .select({ slug: servers.slug })
      .from(servers)
      .where(eq(servers.id, result.serverId));

    res.json({
      apiKey: result.apiKey,
      credentialId: result.credentialId,
      agentId: result.agentId,
      agentName: result.agentName,
      serverId: result.serverId,
      serverSlug: serverRow?.slug ?? null,
      scopes: result.scopes,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes("AGENT_BOOTSTRAP_TOKEN_PEPPER")) {
      res.status(503).json({
        error: "Agent bootstrap token exchange is not configured",
        code: "bootstrap_token_pepper_missing",
      });
      return;
    }
    console.error("agent.login error:", err);
    res.status(500).json({ error: "Failed to exchange bootstrap token" });
  }
});
