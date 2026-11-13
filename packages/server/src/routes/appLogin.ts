/**
 * App login handoff routes (see appLoginService).
 *
 * `POST /api/auth/app-login/start`              — public: app sends returnUri + PKCE challenge
 *                                                  (+ optional clientId, checked against the registry).
 * `GET  /api/auth/app-login/requests/:id`       — signed-in web: is the request still usable.
 * `POST /api/auth/app-login/requests/:id/approve` — signed-in web: explicit confirm → code redirect.
 * `POST /api/auth/app-login/requests/:id/deny`  — signed-in web: cancel → error redirect.
 * `POST /api/auth/app-login/complete`           — public: app exchanges code + verifier for a session.
 *
 * Pre-credential surfaces like /api/auth/device, outside the routeAuthPolicy
 * registry by design; mounted behind the auth rate limiter.
 */
import { Router, type Router as RouterType } from "express";
import {
  approveAppLogin,
  denyAppLogin,
  describeAppLogin,
  exchangeAppLoginCode,
  startAppLogin,
} from "../services/appLoginService";
import { getDb } from "../db/index";
import { requireAuth, signAccessToken } from "../middleware/auth";
import { attachAuthTraceIdentity } from "../middleware/requestObservability";
import * as sessionService from "../services/sessionService";
import * as userService from "../services/userService";
import { getConfiguredAppUrl } from "../config/appUrl";
import { recordAuthSessionIssuedTrace } from "./authRefreshTrace";
import { sendJsonServerError } from "./errorResponse";
import { proofForAppLogin } from "../services/sessionIssueGate";
import { refuseUnverifiedApprover } from "./secondFactor";

export const appLoginRouter: RouterType = Router();

const APP_LOGIN_PATH = "/login/app";

function resolveErrorStatus(error: string): number {
  return error === "request_expired" ? 410 : error === "request_already_resolved" ? 409 : 404;
}

appLoginRouter.post("/start", async (req, res) => {
  try {
    // Clients may also send platform / appEnv (informational, ignored) and
    // codeChallengeMethod, which must be S256 when present, and clientId,
    // which must match the registry client of returnUri when present.
    const body = (req.body ?? {}) as { returnUri?: unknown; codeChallenge?: unknown; codeChallengeMethod?: unknown; clientId?: unknown };
    if (typeof body.returnUri !== "string" || typeof body.codeChallenge !== "string") {
      res.status(400).json({ error: "returnUri and codeChallenge are required", code: "invalid_request" });
      return;
    }
    if (body.clientId !== undefined && typeof body.clientId !== "string") {
      res.status(400).json({ error: "clientId must be a string", code: "invalid_request" });
      return;
    }
    if (body.codeChallengeMethod !== undefined && body.codeChallengeMethod !== "S256") {
      res.status(400).json({ error: "codeChallengeMethod must be S256", code: "code_challenge_invalid" });
      return;
    }
    const base = getConfiguredAppUrl();
    if (!base) {
      res.status(503).json({ error: "App login URL is not configured", code: "app_login_url_unavailable" });
      return;
    }
    const started = await startAppLogin({ returnUri: body.returnUri, codeChallenge: body.codeChallenge, clientId: body.clientId });
    if (!started.ok) {
      res.status(400).json({ error: "App login request is invalid", code: started.error });
      return;
    }
    const loginUrl = new URL(`${base}${APP_LOGIN_PATH}`);
    loginUrl.searchParams.set("request", started.requestId);
    res.status(201).json({
      requestId: started.requestId,
      loginUrl: loginUrl.toString(),
      expiresAt: started.expiresAt.toISOString(),
      client: started.client,
    });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to start app login", logPrefix: "api.auth.app-login.start error:", err });
  }
});

appLoginRouter.get("/requests/:id", requireAuth, async (req, res) => {
  try {
    const described = await describeAppLogin(String(req.params.id));
    if (!described.ok) {
      res.status(resolveErrorStatus(described.error)).json({
        error: "App login request is not usable",
        code: described.error,
        ...(described.cancelUrl ? { redirectUrl: described.cancelUrl } : {}),
      });
      return;
    }
    res.json({
      expiresAt: described.expiresAt.toISOString(),
      createdAt: described.createdAt.toISOString(),
      client: described.client,
    });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to load app login", logPrefix: "api.auth.app-login.describe error:", err });
  }
});

appLoginRouter.post("/requests/:id/approve", requireAuth, async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required", code: "auth_required" });
      return;
    }
    // requireAuth admits only a person's own full session here (not a
    // device-session route); record the family it verified.
    const approverFamilyId = req.sessionScope === "full" ? req.sessionFamilyId ?? null : null;
    if (await refuseUnverifiedApprover(res, userId, approverFamilyId)) return;
    const approved = await approveAppLogin(String(req.params.id), userId, approverFamilyId);
    if (!approved.ok) {
      res.status(resolveErrorStatus(approved.error)).json({
        error: "App login request is not usable",
        code: approved.error,
        ...(approved.redirectUrl ? { redirectUrl: approved.redirectUrl } : {}),
      });
      return;
    }
    res.json({ redirectUrl: approved.redirectUrl });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to approve app login", logPrefix: "api.auth.app-login.approve error:", err });
  }
});

appLoginRouter.post("/requests/:id/deny", requireAuth, async (req, res) => {
  try {
    const denied = await denyAppLogin(String(req.params.id));
    if (!denied.ok) {
      res.status(resolveErrorStatus(denied.error)).json({ error: "App login request is not usable", code: denied.error });
      return;
    }
    res.json({ redirectUrl: denied.redirectUrl });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to cancel app login", logPrefix: "api.auth.app-login.deny error:", err });
  }
});

appLoginRouter.post("/complete", async (req, res) => {
  try {
    // returnUri is optional (RFC 6749 §4.1.3 redirect_uri); when sent it must
    // equal the one saved at start.
    const { code, codeVerifier, returnUri } = (req.body ?? {}) as { code?: unknown; codeVerifier?: unknown; returnUri?: unknown };
    if (typeof code !== "string" || typeof codeVerifier !== "string") {
      res.status(400).json({ error: "code and codeVerifier are required", code: "invalid_request" });
      return;
    }
    if (returnUri !== undefined && typeof returnUri !== "string") {
      res.status(400).json({ error: "returnUri must be a string", code: "invalid_request" });
      return;
    }
    // One transaction: the code is consumed, under the person's row lock,
    // only while the sign-in that approved it is live, and the session is
    // issued before a revoke of that sign-in can commit. The new session
    // inherits the approving sign-in's second factor (as of the approver's
    // time) when that family still qualifies; the gate reads it here too.
    const issued = await getDb().transaction(async (tx) => {
      const exchanged = await exchangeAppLoginCode(tx, code, codeVerifier, returnUri);
      if (!exchanged.ok) return exchanged;
      const user = await userService.getUser(exchanged.userId);
      if (!user) return { ok: false as const, error: "code_not_found" as const };
      const session = await sessionService.createSession(await proofForAppLogin(user.id, exchanged.approverFamilyId, tx), tx);
      return { ok: true as const, user, ...session };
    });
    if (!issued.ok) {
      const status = issued.error === "code_expired" || issued.error === "code_consumed" ? 410
        : issued.error === "pkce_mismatch" || issued.error === "return_uri_mismatch" ? 400
        : 404;
      res.status(status).json({ error: "App login code could not be exchanged", code: issued.error });
      return;
    }
    const { user, sessionId, familyId, refreshToken } = issued;
    const accessToken = signAccessToken(user.id, familyId);
    attachAuthTraceIdentity(req, { userId: user.id, sessionId, source: "app_login" });
    recordAuthSessionIssuedTrace({ flow: "app_login", userId: user.id, sessionId });
    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to complete app login", logPrefix: "api.auth.app-login.complete error:", err });
  }
});
