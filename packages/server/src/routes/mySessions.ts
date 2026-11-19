// A person's own sign-ins (services/mySessions.ts):
//
//   GET    /api/me/sessions                      -> { sessions, othersLostDeviceReach }
//   DELETE /api/me/sessions/:familyId            { reason }  -> { cascade }
//   POST   /api/me/sessions/revoke-others        { reason }  -> { revoked, cascade }
//
// `cascade`: whether `lost_device`'s revoke of what the session(s) approved
// or issued finished: `done`, `pending` (it failed after the revoke
// committed; the hourly repair does it), or `none` (`sign_out`). A
// revoke-others `lost_device` that revoked nothing new has no stored revoke
// for the repair to retry from: its failure is a 5xx, not `pending`.
//
// `reason` is required on both writes: `sign_out` (logout-like: what the
// session issued or approved keeps working) or `lost_device` (a security
// revoke: it goes too). 400 `reason_required` without one. A sign-in signed
// out with `sign_out` leaves the list, so it can't be turned into a
// `lost_device` revoke later from here.
//
// Who may call: a signed-in person on their own `full` sign-in only (web,
// desktop, mobile; guests included: it is their own account). requireAuth
// already answers 401 to anything that is not a Raft access token (an App's
// OAuth token, a Computer or machine key) and 403 `device_session_not_allowed`
// to a device login's session (Raft Computer, the raft CLI); an agent key
// (a personal assistant acting as its owner) reaches here with no session
// family and is refused 403 `session_family_required` below, on every route,
// reads included.
//
// Not yours: an id that is unknown, another person's, a device family, or
// already revoked all get the same 404 `session_not_found`. The asking sign-in
// itself is 400 `current_session` (sign out instead).
//
// Step-up on both writes, by reason. Either reason: a recent sign-in or
// password re-authentication on THIS sign-in (403 `reauth_required`, as
// adding a passkey without two-step verification; POST
// /api/auth/second-factor/reauth/password, 10 minutes). `lost_device` also:
// for a person with two-step verification on, a second factor passed on this
// sign-in within 10 minutes (403 `second_factor_step_up_required` with the
// methods, stepUpGate.ts; POST /api/auth/second-factor/step-up). `sign_out`
// needs no second factor (#triage:#386): every live full sign-in already
// passed it to exist, and a sign-out is logout-like and recoverable (what it
// approved keeps working; signing in again brings it back), so a person whose
// authenticator went with the lost device can still sign it out with the
// password alone. Disconnecting what it approved stays behind the second factor.

import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import { currentDate } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import {
  listMySessions,
  parseMySessionRevokeReason,
  revokeMyOtherSessions,
  revokeMySession,
} from "../services/mySessions";
import { isRecentlyReauthenticated } from "../services/secondFactor/reauthentication";
import { sessionClientOf } from "../services/sessionClient";
import { webSessionFamilyOf } from "../services/sessionService";
import { refuse } from "../lib/refusal";
import { sendJsonServerError } from "./errorResponse";
import { refuseWithoutRecentSecondFactor } from "./secondFactor";

export const mySessionsRouter: RouterType = Router();

function requireOwnWebSession(req: Request, res: Response, next: NextFunction): void {
  if (!webSessionFamilyOf(req)) {
    refuse(res, 403, { error: "Sign in on the web or in the Raft app to manage your sign-ins.", code: "session_family_required" });
    return;
  }
  next();
}

mySessionsRouter.use(requireOwnWebSession);

const NOT_FOUND = { error: "That sign-in was not found.", code: "session_not_found" } as const;

/** The reason, or a 400 sent. */
function reasonOf(req: Request, res: Response) {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as { reason?: unknown };
  const reason = parseMySessionRevokeReason(body.reason);
  if (!reason) {
    refuse(res, 400, { error: "Say why: \"sign_out\" or \"lost_device\".", code: "reason_required" });
  }
  return reason;
}

/** Both writes' re-authentication, either reason (the second factor, `lost_device` only, is the route's own call); true when a refusal was sent. */
async function refuseWithoutRecentReauthentication(res: Response, familyId: string): Promise<boolean> {
  if (await isRecentlyReauthenticated(getDb(), familyId, currentDate())) return false;
  refuse(res, 403, { error: "Confirm it's you again before signing out a sign-in.", code: "reauth_required" });
  return true;
}

mySessionsRouter.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await listMySessions(req.userId!, webSessionFamilyOf(req)!, sessionClientOf(req)));
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to list your sign-ins", logPrefix: "[my-sessions] list failed:", err });
  }
});

mySessionsRouter.post("/revoke-others", async (req, res) => {
  try {
    const userId = req.userId!;
    const familyId = webSessionFamilyOf(req)!;
    const reason = reasonOf(req, res);
    if (!reason) return;
    if (await refuseWithoutRecentReauthentication(res, familyId)) return;
    if (reason === "lost_device" && await refuseWithoutRecentSecondFactor(res, userId, familyId, "session_revoke")) return;
    const { revoked, cascade } = await revokeMyOtherSessions({ userId, currentFamilyId: familyId, reason });
    res.json({ revoked: revoked.length, cascade });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to sign out your other sign-ins", logPrefix: "[my-sessions] revoke-others failed:", err });
  }
});

mySessionsRouter.delete("/:familyId", async (req, res) => {
  try {
    const userId = req.userId!;
    const familyId = webSessionFamilyOf(req)!;
    const reason = reasonOf(req, res);
    if (!reason) return;
    if (await refuseWithoutRecentReauthentication(res, familyId)) return;
    if (reason === "lost_device" && await refuseWithoutRecentSecondFactor(res, userId, familyId, "session_revoke")) return;
    const outcome = await revokeMySession({ userId, currentFamilyId: familyId, familyId: String(req.params.familyId), reason });
    if (outcome.result === "current") {
      refuse(res, 400, { error: "This is the sign-in you are using. Use Sign out instead.", code: "current_session" });
      return;
    }
    if (outcome.result === "not_found") {
      refuse(res, 404, NOT_FOUND);
      return;
    }
    res.json({ cascade: outcome.cascade });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to sign out that sign-in", logPrefix: "[my-sessions] revoke failed:", err });
  }
});
