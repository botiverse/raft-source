/**
 * Device-code login grant — task #30 PR-A2 (RFC v0.8 contract v3 §3/§5/§9).
 *
 * `POST /api/auth/device/authorize` — unauthenticated public, env/feature
 *     gated. Issues device_code + user_code.
 * `POST /api/auth/device/approve`   — USER-authenticated (the only
 *     authenticated phase). Binds the approving user identity.
 * `POST /api/auth/device/token`     — unauthenticated public poll. On a
 *     legitimately approved + unconsumed grant, single-consumes it and
 *     issues a normal user session (accessToken + refreshToken).
 *
 * OUT of the `routeAuthPolicy` registry BY DESIGN (contract v3 §3): these
 * are `/api/*` pre-credential surfaces, not claimed `/internal/*` principal
 * surfaces. Documented intentional — not an auth-policy omission. Mirrors
 * the `/api/agent/login` bootstrap-token surface 1:1 (public + gated +
 * stable fail-closed codes + zero existence enumeration); the shared grant
 * lifecycle lives in deviceAuthService (same pepper, no parallel auth path).
 *
 * This grant does NOT mint `sk_computer_*` / `sk_agent_*` (contract §5). It
 * establishes a user session; `raft-computer attach` / external-agent
 * bootstrap later consume that identity under their own principal contract.
 */
import { Router, type Router as RouterType } from "express";
import {
  createDeviceAuthorization,
  approveDeviceAuthorization,
  consumeDeviceAuthorization,
  isDeviceAuthSurfaceEnabled,
} from "../services/deviceAuthService.js";
import { signAccessToken, requireAuth } from "../middleware/auth.js";
import { attachAuthTraceIdentity } from "../middleware/requestObservability.js";
import * as sessionService from "../services/sessionService.js";
import { getConfiguredAppUrl } from "../config/appUrl.js";
import { recordAuthSessionIssuedTrace } from "./authRefreshTrace.js";

export const deviceAuthRouter: RouterType = Router();
const DEVICE_LOGIN_PATH = "/login/device";

function appUrl(): string | null {
  return getConfiguredAppUrl();
}

function buildVerificationUri(userCode: string): { verificationUri: string; verificationUriComplete: string } | null {
  const base = appUrl();
  if (!base) return null;
  const uri = `${base}${DEVICE_LOGIN_PATH}`;
  const complete = new URL(uri);
  complete.searchParams.set("user_code", userCode);
  return { verificationUri: uri, verificationUriComplete: complete.toString() };
}

function surfaceDisabled(res: import("express").Response): boolean {
  if (isDeviceAuthSurfaceEnabled()) return false;
  // Defense-in-depth: even though app.ts mounts this behind the same gate,
  // re-check so a misconfigured mount cannot expose the surface.
  res.status(404).json({
    error: "Device login is not enabled",
    code: "device_login_disabled",
  });
  return true;
}

// --- authorize: unauthenticated public ---
deviceAuthRouter.post("/authorize", async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { clientName?: unknown };
    let clientName: string | null = null;
    if (body.clientName !== undefined && body.clientName !== null) {
      if (typeof body.clientName !== "string" || body.clientName.length > 200) {
        res.status(400).json({ error: "clientName must be a string up to 200 chars", code: "client_name_invalid" });
        return;
      }
      clientName = body.clientName;
    }
    const grant = await createDeviceAuthorization({ clientName });
    const verification = buildVerificationUri(grant.userCode);
    if (!verification) {
      res.status(503).json({
        error: "Device login URL is not configured",
        code: "DEVICE_LOGIN_URL_UNAVAILABLE",
      });
      return;
    }
    res.status(201).json({
      deviceCode: grant.deviceCode,
      userCode: grant.userCode,
      // Human approval happens on the web origin, not the API/server origin.
      // `verificationUriComplete` pre-fills the public user_code; no device
      // secret is embedded in either URL.
      ...verification,
      expiresIn: grant.expiresInSeconds,
      interval: grant.pollIntervalSeconds,
    });
  } catch (err) {
    console.error("api.auth.device.authorize error:", err);
    res.status(500).json({ error: "Failed to start device authorization" });
  }
});

// --- approve: USER-authenticated (only authenticated phase) ---
deviceAuthRouter.post("/approve", requireAuth, async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { userCode?: unknown; approve?: unknown };
    if (typeof body.userCode !== "string" || body.userCode.trim().length === 0) {
      res.status(400).json({ error: "userCode is required", code: "user_code_required" });
      return;
    }
    const approve = body.approve === undefined ? true : body.approve === true;
    const userId = req.userId;
    if (!userId) {
      // requireAuth should guarantee this; fail closed if not.
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    const result = await approveDeviceAuthorization({ userCode: body.userCode, userId, approve });
    if (!result.ok) {
      const status = result.error === "expired" ? 410 : result.error === "already_resolved" ? 409 : 404;
      res.status(status).json({ error: "Device authorization could not be updated", code: result.error });
      return;
    }
    res.status(200).json({ ok: true, action: approve ? "approved" : "denied" });
  } catch (err) {
    console.error("api.auth.device.approve error:", err);
    res.status(500).json({ error: "Failed to update device authorization" });
  }
});

// --- token: unauthenticated public poll → issues user session on success ---
deviceAuthRouter.post("/token", async (req, res) => {
  if (surfaceDisabled(res)) return;
  try {
    const body = (req.body ?? {}) as { deviceCode?: unknown };
    if (typeof body.deviceCode !== "string" || body.deviceCode.length === 0) {
      res.status(400).json({ error: "deviceCode is required", code: "device_code_required" });
      return;
    }
    const result = await consumeDeviceAuthorization(body.deviceCode, {
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    if (!result.ok) {
      // RFC-8628-ish: pending/slow_down are 400; terminal failures map to
      // their own status. All are stable codes, zero enumeration.
      const status = result.error === "authorization_pending" ? 400
        : result.error === "expired_token" ? 410
        : result.error === "access_denied" ? 403
        : result.error === "device_code_consumed" ? 410
        : 400; // device_code_invalid
      res.status(status).json({ error: "Device authorization not ready", code: result.error });
      return;
    }
    // Grant established a user identity → issue a normal user session.
    // (This grant never mints sk_* itself — contract §5.)
    const { sessionId, familyId, refreshToken } = await sessionService.createSession(result.approvedByUserId);
    const accessToken = signAccessToken(result.approvedByUserId, familyId);
    attachAuthTraceIdentity(req, { userId: result.approvedByUserId, sessionId, source: "device_auth" });
    recordAuthSessionIssuedTrace({ flow: "device_auth", userId: result.approvedByUserId, sessionId });
    res.status(200).json({ accessToken, refreshToken, userId: result.approvedByUserId });
  } catch (err) {
    console.error("api.auth.device.token error:", err);
    res.status(500).json({ error: "Failed to complete device authorization" });
  }
});
