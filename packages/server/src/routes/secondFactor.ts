/**
 * /api/auth/second-factor: a person managing their own two-step verification
 * (design v8 §3, §5; rollout PR 2). The logic is
 * services/secondFactor/management.ts.
 *
 *   GET  /status                  { enabled, methods: { totp, passkeys, backupCodesRemaining }, sessionVerified, recovery }
 *                                 (sessionVerified: this sign-in passed the second factor;
 *                                 recovery: RecoveryView | null, below)
 *   POST /totp/setup              { code? | backupCode? | webauthn? } -> { secret, otpauthUri } (once)
 *   POST /totp/confirm            { code }                -> { confirmed, enabled }
 *   POST /enable                  { code | webauthn }     -> { backupCodes } (once)
 *   POST /disable                 { code | backupCode | webauthn } -> { enabled: false }
 *   POST /backup-codes/regenerate { code | webauthn }     -> { backupCodes } (once)
 *   POST /reauth/password         { password }            -> 204 (this sign-in re-authenticated, 10 minutes)
 *   POST /step-up                 { code | backupCode | webauthn } -> { verified, backupCodesRemaining? } (this sign-in verified)
 *
 * Passkeys (PR 4a, services/secondFactor/passkeyManagement.ts; 503
 * `passkeys_unavailable` without WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS):
 *   POST   /passkeys/registration/options { code? | backupCode? | webauthn? } -> { options, expiresAt }
 *   POST   /passkeys/registration/verify  { challenge?, response, name? } -> { passkey }
 *   GET    /passkeys                      -> { passkeys: [{ id, name, createdAt, lastUsedAt, synced }] }
 *   PATCH  /passkeys/:id                  { name } -> { passkey }
 *   DELETE /passkeys/:id                  { code? | backupCode? | webauthn? } -> { removed: true }
 *   POST   /passkeys/assertion/options    {} -> { options } (bound to this sign-in)
 * `webauthn` is the browser's `PublicKeyCredential.toJSON()` from an
 * assertion with those options.
 *
 * The unauthenticated second step of a sign-in, POST /verify
 * { challenge, code (or totp) | backupCode | webauthn }, is mounted ahead of this
 * router (app.ts; routes/auth.ts secondFactorVerifyHandler), and so is
 * POST /passkeys/assertion/options with `{ challenge }` (a sign-in's
 * challenge; signInPasskeyAssertionOptions below): options bound to that
 * sign-in, for the person it belongs to.
 *
 * Email recovery of two-step verification (rollout PR 6,
 * services/secondFactor/recovery.ts), for someone who lost every factor:
 *   Unauthenticated (secondFactorRecoveryRouter, mounted ahead of this router
 *   in app.ts behind authLimiter; the start also behind a per-address hourly
 *   limit, 429 from either):
 *   POST /recovery         { email }  -> 200 { ok: true, message } always, the
 *                          same body for every address (unknown, no two-step
 *                          verification, flag off, eligible); only an eligible
 *                          person is emailed a link (30 minutes, single use)
 *                          400 invalid_request without an email
 *   POST /recovery/confirm { token }  -> 200 { recovery: RecoveryView } (the
 *                          72-hour wait starts; "someone asked" email with a
 *                          cancel link; one mobile push)
 *                          400 recovery_token_invalid (unknown, used, expired,
 *                          person no longer eligible or flag off)
 *   POST /recovery/cancel  { token }  -> 200 { cancelled: true } (the emailed
 *                          cancel link, while the request waits)
 *                          400 recovery_token_invalid
 *   Signed in (this router; 404 with the flag off, like everything here):
 *   GET    /recovery       -> { recovery: RecoveryView | null }
 *   DELETE /recovery       -> { cancelled: boolean, recovery: null } (one
 *                          step, no step-up: cancelling is the safe direction;
 *                          also ends a link not used yet)
 *   GET /status also carries `recovery: RecoveryView | null`. RecoveryView,
 *   the same for web and mobile:
 *     { status: "waiting" | "ready",   // ready: eligibleAt has passed
 *       requestedAt: ISO, eligibleAt: ISO, expiresAt: ISO,  // expiresAt = eligibleAt + 7 days
 *       firstFactorRequired: "set_password" | null }  // set_password: no password and
 *                          // no connected sign-in method; set one with forgot-password first
 *   Every session shows it with Cancel (DELETE /recovery) while it is there.
 *   Finishing is at sign-in: a first-factor sign-in's challenge lists
 *   `recovery` in `methods` once it is ready, and POST /verify
 *   { challenge, recovery: true } (+ codeVerifier for mobile) answers it like
 *   a code: the sign-in's usual success body; 409 recovery_not_ready (with
 *   eligibleAt) or recovery_not_found otherwise. It removes every factor,
 *   turns two-step verification off and signs out every other sign-in.
 *   Any right second-factor answer (sign-in, step-up, management, passkey
 *   sign-in) cancels the request.
 *
 * Wrong codes count toward the person's second-step lock (429
 * `second_factor_locked`); wrong passwords at /reauth/password count apart,
 * toward their own lock (429 `reauth_locked`, with `lockedUntil`), so they
 * never lock the second step at sign-in.
 *
 * TOTP setup with a confirmed secret already there (re-bind) stores the new
 * secret as pending beside it; the confirmed secret keeps working until a
 * code from the new one confirms it (user_totp.pending_secret_ciphertext).
 *
 * Turning two-step verification on here records it, marks this sign-in
 * verified and signs out the person's other web sign-ins; from then on
 * password and social sign-ins ask for a second step, and approving a device or app login needs a
 * verified sign-in (POST /step-up marks one). Changing the password,
 * connecting or disconnecting a sign-in method and creating an agent key or
 * bootstrap token need one verified in the last 10 minutes
 * (refuseWithoutRecentSecondFactor; POST /step-up stamps the time again).
 *
 * Who may call:
 *   - Any signed-in person (two-step verification is on for everyone since
 *     `auth_second_factor_v1` was retired, #raft-architecture:#32; a leftover
 *     flag row changes nothing). Unauthenticated calls get requireAuth's 401.
 *   - A person's own web (`full`) sign-in only: requireAuth already refuses a
 *     device login's session (403 `device_session_not_allowed`: none of these
 *     paths is in DEVICE_SESSION_ROUTES) and a token with no session family
 *     (401); requireWebSessionFamily below narrows the family the rest reads
 *     (re-authentication and the verified mark live on it).
 */
import { Router, type NextFunction, type Request, type RequestHandler, type Response, type Router as RouterType } from "express";
import { currentDate } from "@botiverse/raft-shared";

import { requireAuth } from "../middleware/auth";
import {
  finishPasskeyRegistration,
  listPasskeys,
  parsePasskeyName,
  removePasskey,
  renamePasskey,
  startPasskeyRegistration,
  startStepUpPasskeyAssertion,
} from "../services/secondFactor/passkeyManagement";
import { parseAuthChallengeToken } from "../services/secondFactor/authChallenges";
import {
  SecondFactorError,
  confirmTotp,
  disableSecondFactor,
  enableSecondFactor,
  getSessionSecondFactorStatus,
  parseStepUpAnswer,
  reauthenticateWithPassword,
  regenerateBackupCodes,
  setUpTotp,
  stepUpSession,
  type StepUpAnswer,
} from "../services/secondFactor/management";
import {
  RecoveryError,
  cancelRecoveryBySession,
  cancelRecoveryByToken,
  confirmRecovery,
  getRecoveryView,
  parseRecoveryToken,
  startRecovery,
} from "../services/secondFactor/recovery";
import { SecondFactorSignInError, signInSecondFactorMethods, startSignInPasskeyAssertion } from "../services/secondFactor/signIn";
import { parsePasskeyRegistrationResponse } from "../services/secondFactor/webauthn";
import { approverSecondFactorCheck } from "../services/sessionIssueGate";
import { STEP_UP_ACTIONS, recentSecondFactorCheck, type StepUpAction } from "../services/secondFactor/stepUpGate";
import { webSessionFamilyOf } from "../services/sessionService";
import { sendJsonServerError } from "./errorResponse";

export const secondFactorRouter: RouterType = Router();

/**
 * Approving a device or app login (POST /api/auth/device/approve, POST
 * /api/auth/app-login/requests/:id/approve), consenting to Login with Raft
 * (POST /api/oauth/authorize/human) or approving an app's agent access
 * request (POST /api/integrations/requests/:requestId/approve), installing
 * an app (POST /api/integrations/marketplace/:clientId/install, POST
 * /api/integration-invites/:token/install), approving an installed app's new
 * permissions (PUT .../install/app-notifications/grant) or adding its bot
 * (POST /api/integrations/clients/:clientId/install/bot, grant), and executing
 * an `approver` action card (services/actionCardSecondFactor.ts, the same
 * check without this helper): with two-step verification on
 * for the approver, the approving sign-in must have passed it (at sign-in or
 * by POST /step-up); otherwise 403 `second_factor_step_up_required` with the
 * methods to step up with. Answers and returns true when it refused; anyone
 * without two-step verification is never refused here.
 */
export async function refuseUnverifiedApprover(
  res: Response,
  userId: string,
  familyId: string | null,
  error = "Confirm it's you with your second step before approving this sign-in.",
): Promise<boolean> {
  if (await approverSecondFactorCheck(userId, familyId) === "ok") return false;
  res.status(403).json({
    error,
    code: "second_factor_step_up_required",
    methods: await signInSecondFactorMethods(userId),
  });
  return true;
}

/**
 * A sensitive action (services/secondFactor/stepUpGate.ts: changing the
 * password, connecting or disconnecting a sign-in method, creating an agent
 * key or bootstrap token, attaching or adopting a computer, registering a
 * machine or creating a new machine key): with two-step verification on for the person, this
 * sign-in must have passed it within the last 10 minutes; otherwise the same
 * 403 `second_factor_step_up_required` (with the methods) as an unverified
 * approver gets, so the client steps up (POST /step-up) and retries. Answers
 * and returns true when it refused; anyone without two-step verification is
 * never refused here. Call it before any side effect.
 */
export async function refuseWithoutRecentSecondFactor(
  res: Response,
  userId: string,
  familyId: string | null,
  action: StepUpAction,
): Promise<boolean> {
  if (await recentSecondFactorCheck(userId, familyId) === "ok") return false;
  res.status(403).json({
    error: STEP_UP_ACTIONS[action],
    code: "second_factor_step_up_required",
    methods: await signInSecondFactorMethods(userId),
  });
  return true;
}

function requireWebSessionFamily(req: Request, res: Response, next: NextFunction): void {
  if (!webSessionFamilyOf(req)) {
    res.status(403).json({ error: "Sign in again to manage two-step verification.", code: "session_family_required" });
    return;
  }
  next();
}

secondFactorRouter.use(requireAuth, requireWebSessionFamily);

function sendSecondFactorError(req: Request, res: Response, err: unknown, failure: string): void {
  if (err instanceof SecondFactorError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return;
  }
  sendJsonServerError(req, res, { error: failure, logPrefix: `[second-factor] ${failure}:`, err });
}

type ManagementCall<T> = (input: { userId: string; familyId: string; answer: StepUpAnswer }) => Promise<T>;

function managementRoute<T>(call: ManagementCall<T>, failure: string) {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      const result = await call({ userId: req.userId!, familyId: webSessionFamilyOf(req)!, answer: parseStepUpAnswer(req.body) });
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    } catch (err) {
      sendSecondFactorError(req, res, err, failure);
    }
  };
}

secondFactorRouter.get("/status", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getSessionSecondFactorStatus({ userId: req.userId!, familyId: webSessionFamilyOf(req)! }));
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to load two-step verification");
  }
});

secondFactorRouter.post("/totp/setup", managementRoute(setUpTotp, "Failed to set up an authenticator app"));
secondFactorRouter.post("/totp/confirm", managementRoute(confirmTotp, "Failed to confirm the authenticator app"));
secondFactorRouter.post("/enable", managementRoute(enableSecondFactor, "Failed to turn on two-step verification"));
secondFactorRouter.post("/disable", managementRoute(disableSecondFactor, "Failed to turn off two-step verification"));
secondFactorRouter.post("/backup-codes/regenerate", managementRoute(regenerateBackupCodes, "Failed to create new backup codes"));
secondFactorRouter.post("/step-up", managementRoute(stepUpSession, "Failed to verify this sign-in"));

/**
 * POST /api/auth/second-factor/passkeys/assertion/options with
 * `{ challenge }`: the unauthenticated half (a sign-in's second step, before
 * there is a session). Mounted with app.use ahead of secondFactorRouter,
 * rate-limited by `limiter` (only this half: the rest passes the router's
 * own); anything else (no `challenge`) falls through to the signed-in route
 * below.
 */
export function signInPasskeyAssertionOptions(limiter: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.method !== "POST" || req.path !== "/" || req.body?.challenge === undefined) { next(); return; }
    void Promise.resolve(limiter(req, res, (err?: unknown) => {
      if (err) { next(err); return; }
      answerSignInPasskeyAssertionOptions(req, res);
    })).catch(next);
  };
}

function answerSignInPasskeyAssertionOptions(req: Request, res: Response): void {
  const challenge = parseAuthChallengeToken(req.body?.challenge);
  if (!challenge) {
    res.status(400).json({ error: "Send the sign-in challenge.", code: "invalid_request" });
    return;
  }
  void startSignInPasskeyAssertion(challenge).then((started) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(started);
  }).catch((err: unknown) => {
    if (err instanceof SecondFactorSignInError) {
      res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
      return;
    }
    sendJsonServerError(req, res, { error: "Failed to start passkey verification", logPrefix: "[second-factor] passkey sign-in options:", err });
  });
}

secondFactorRouter.post("/passkeys/assertion/options", managementRoute(startStepUpPasskeyAssertion, "Failed to start passkey verification"));
secondFactorRouter.post("/passkeys/registration/options", managementRoute(startPasskeyRegistration, "Failed to start adding a passkey"));

secondFactorRouter.post("/passkeys/registration/verify", async (req, res) => {
  const response = parsePasskeyRegistrationResponse(req.body?.response);
  const name = parsePasskeyName(req.body?.name);
  const challenge = req.body?.challenge;
  if (!response || name === null || (challenge !== undefined && typeof challenge !== "string")) {
    res.status(400).json({ error: "Send the passkey from your browser (and a name of up to 64 characters).", code: "invalid_request" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await finishPasskeyRegistration({ userId: req.userId!, familyId: webSessionFamilyOf(req)!, challenge, response, name }));
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to add the passkey");
  }
});

secondFactorRouter.get("/passkeys", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await listPasskeys(req.userId!));
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to load passkeys");
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function passkeyIdParam(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? "");
  if (UUID_RE.test(id)) return id;
  res.status(404).json({ error: "That passkey was not found.", code: "passkey_not_found" });
  return null;
}

secondFactorRouter.patch("/passkeys/:id", async (req, res) => {
  const passkeyId = passkeyIdParam(req, res);
  if (!passkeyId) return;
  const name = parsePasskeyName(req.body?.name);
  if (!name) {
    res.status(400).json({ error: "Enter a name of up to 64 characters.", code: "invalid_request" });
    return;
  }
  try {
    res.json(await renamePasskey({ userId: req.userId!, passkeyId, name }));
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to rename the passkey");
  }
});

secondFactorRouter.delete("/passkeys/:id", async (req, res) => {
  const passkeyId = passkeyIdParam(req, res);
  if (!passkeyId) return;
  try {
    res.json(await removePasskey({ userId: req.userId!, familyId: webSessionFamilyOf(req)!, passkeyId, answer: parseStepUpAnswer(req.body) }));
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to remove the passkey");
  }
});

secondFactorRouter.post("/reauth/password", async (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!password) {
    res.status(400).json({ error: "Enter your current password.", code: "invalid_request" });
    return;
  }
  try {
    await reauthenticateWithPassword({ userId: req.userId!, familyId: webSessionFamilyOf(req)!, password });
    res.status(204).end();
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to confirm the password");
  }
});

secondFactorRouter.get("/recovery", async (req, res) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ recovery: await getRecoveryView(req.userId!, currentDate()) });
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to load the two-step verification reset");
  }
});

secondFactorRouter.delete("/recovery", async (req, res) => {
  try {
    const { cancelled } = await cancelRecoveryBySession({ userId: req.userId! });
    res.setHeader("Cache-Control", "no-store");
    res.json({ cancelled, recovery: null });
  } catch (err) {
    sendSecondFactorError(req, res, err, "Failed to cancel the two-step verification reset");
  }
});

/**
 * The unauthenticated half of recovery (file comment): mounted at
 * /api/auth/second-factor/recovery ahead of secondFactorRouter; GET and
 * DELETE fall through to the signed-in routes above.
 */
export const secondFactorRecoveryRouter: RouterType = Router();

export const SECOND_FACTOR_RECOVERY_START_BODY = {
  ok: true,
  message: "If two-step verification on that account can be reset by email, we sent a link to it.",
} as const;

/** Starts run after the answer; tests wait for them here. */
const pendingStarts = new Set<Promise<void>>();

export async function __settleSecondFactorRecoveryStartsForTests(): Promise<void> {
  while (pendingStarts.size > 0) await Promise.all([...pendingStarts]);
}

function sendRecoveryError(req: Request, res: Response, err: unknown, failure: string): void {
  if (err instanceof RecoveryError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return;
  }
  sendJsonServerError(req, res, { error: failure, logPrefix: `[second-factor-recovery] ${failure}:`, err });
}

secondFactorRecoveryRouter.post("/", (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  if (!email) {
    res.status(400).json({ error: "Enter the email address of your account.", code: "invalid_request" });
    return;
  }
  // The same answer for every address, before any lookup (no enumeration,
  // no timing difference); the work runs after it and never throws.
  res.setHeader("Cache-Control", "no-store");
  res.json(SECOND_FACTOR_RECOVERY_START_BODY);
  const started = startRecovery({ email }).finally(() => { pendingStarts.delete(started); });
  pendingStarts.add(started);
});

secondFactorRecoveryRouter.post("/confirm", async (req, res) => {
  const token = parseRecoveryToken(req.body?.token);
  if (!token) {
    res.status(400).json({ error: "This link is invalid or has expired.", code: "recovery_token_invalid" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ recovery: await confirmRecovery({ token }) });
  } catch (err) {
    sendRecoveryError(req, res, err, "Failed to start the two-step verification reset");
  }
});

secondFactorRecoveryRouter.post("/cancel", async (req, res) => {
  const token = parseRecoveryToken(req.body?.token);
  if (!token) {
    res.status(400).json({ error: "This link is invalid or has expired.", code: "recovery_token_invalid" });
    return;
  }
  try {
    await cancelRecoveryByToken({ token });
    res.setHeader("Cache-Control", "no-store");
    res.json({ cancelled: true });
  } catch (err) {
    sendRecoveryError(req, res, err, "Failed to cancel the two-step verification reset");
  }
});
