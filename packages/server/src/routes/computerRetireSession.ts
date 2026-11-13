/**
 * `POST /api/computer/retire-session` (device-auth design v2 §4 step 2): a
 * Computer that already holds its own key ends the device session it logged
 * in with, so nothing on the machine still acts for the person.
 *
 * Two proofs, both required: the device session's access token
 * (`Authorization: Bearer <access token>`) and an `sk_computer_*` key of this
 * machine (`X-Raft-Computer-Key`) whose `key_issued_by_session_family_id` is
 * that session's family: the machine retiring its own session, not anyone
 * holding just one of them. A key that records no issuer at all (no session
 * family, web session family or grant: attached before #11934 started
 * recording it) is accepted instead when the session's own person attached
 * it: that Computer is theirs, and retiring only takes their access away
 * (#wg-device-auth:#1: most Computers still holding a device session have
 * only such keys). A key that records any issuer still has to name this
 * session's family.
 *
 * Retiring is not unbinding: the family is marked retired (no access token of
 * it authenticates, no refresh token refreshes; its sessions are deleted), and
 * every key it issued keeps naming it, so its revoke link, a password change
 * or the account's retirement still revokes them (deviceSessionKeys.ts reads
 * `revoked_at` only). It issues nothing. A family already retired answers ok
 * again; a revoked one is refused.
 *
 * Mounted on its own (app.ts), outside the device-login kill switch: ending a
 * session is always allowed. Out of `routeAuthPolicy` by design, like the other
 * pre-credential `/api/computer/*` routes.
 */
import type { Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { computers, sessionFamilies } from "../db/schema";
import { respondInvalidOrExpiredToken, verifyTokenSignatureIgnoringExpiry, type JwtPayload } from "../middleware/auth";
import { setRequestTraceComputerCaller, setRequestTraceErrorCode } from "../middleware/requestObservability";
import { findComputerByApiKeyWithReason } from "../services/computerCredentialService";
import { recordIntegrationAuditEvent } from "../services/integrationAuditService";
import { retireDeviceSessionFamilyInTransaction, type RetireDeviceSessionFamilyResult } from "../services/sessionService";
import { trustedViewerIp } from "../lib/clientIpForRateLimit";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { addTraceEvent } from "../tracing/semanticTrace";
import { sendJsonServerError } from "./errorResponse";

export const COMPUTER_KEY_HEADER = "x-raft-computer-key";
const MAX_COMPUTER_KEY_LENGTH = 200;

/** Which rule accepted the key: the session issued it, or it records no issuer and the person attached it. */
type KeyMatch = "issued_by_session" | "unrecorded_same_person";

function accessTokenOf(req: Request): JwtPayload | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  try {
    const payload = verifyTokenSignatureIgnoringExpiry(header.slice(7));
    return payload.type === "access" && typeof payload.sub === "string" && typeof payload.familyId === "string" ? payload : null;
  } catch {
    return null;
  }
}

function refuse(res: Response, status: number, code: string, error: string): void {
  addTraceEvent("auth.device.session.retire_rejected", { reason: code });
  setRequestTraceErrorCode(res, code);
  res.status(status).json({ error, code });
}

export async function computerRetireSessionHandler(req: Request, res: Response): Promise<void> {
  try {
    // The session's own access token, signature only: an expired one is fine
    // (the machine key is the live proof; retiring only takes access away), so
    // a Computer that was off for a while retires without refreshing. A
    // retired family's token may ask again; the transaction below decides.
    const payload = accessTokenOf(req);
    const rawKey = req.headers[COMPUTER_KEY_HEADER];
    const keyShaped = typeof rawKey === "string" && rawKey.startsWith("sk_computer_") && rawKey.length <= MAX_COMPUTER_KEY_LENGTH;
    if (!payload) {
      // The answer stays the same; the key is read only to name the Computer in
      // the trace, since a refused token is the case a Computer keeps its
      // session for and never retries (#wg-device-auth:#1).
      if (keyShaped) {
        const caller = await findComputerByApiKeyWithReason(rawKey).catch(() => null);
        if (caller?.ok) setRequestTraceComputerCaller(res, { machineId: caller.computer.machineId });
      }
      addTraceEvent("auth.device.session.retire_rejected", { reason: "session_token_invalid" });
      setRequestTraceErrorCode(res, "session_token_invalid");
      respondInvalidOrExpiredToken(res);
      return;
    }
    if (!keyShaped) {
      refuse(res, 401, "computer_key_required", "This needs the Computer's own key as well as its session");
      return;
    }
    const computer = await findComputerByApiKeyWithReason(rawKey);
    if (!computer.ok) {
      refuse(res, 401, "computer_key_invalid", "This Computer key isn't accepted");
      return;
    }
    // Every outcome from here on names the Computer in the request trace, so
    // one that keeps its session (#wg-device-auth:#1) can be looked up.
    setRequestTraceComputerCaller(res, { machineId: computer.computer.machineId });
    const familyId = payload.familyId!;
    const requestIp = trustedViewerIp(req);
    const userId = payload.sub;
    const outcome = await getDb().transaction(async (tx): Promise<
      { retired: RetireDeviceSessionFamilyResult; keyMatch: KeyMatch } | "family_mismatch" | "not_device_session"
    > => {
      // A full web session (an older Desktop copied one onto the machine) is
      // not a device login: there is nothing to retire, and the Computer only
      // drops its local copy. Said before the key check, which it would fail.
      const [family] = await tx.select({ scope: sessionFamilies.scope }).from(sessionFamilies)
        .where(and(eq(sessionFamilies.id, familyId), eq(sessionFamilies.userId, userId))).limit(1);
      if (family && family.scope !== "device") return "not_device_session";
      // The key must be one this session issued, or a key that records no
      // issuer and the same person attached (see the header). Unlocked:
      // retiring only takes access away, so a key revoked or resumed by
      // another holder a moment later leaves nothing to exploit.
      const [key] = await tx
        .select({
          familyId: computers.keyIssuedBySessionFamilyId,
          webFamilyId: computers.keyIssuedByWebSessionFamilyId,
          grantId: computers.keyIssuedByGrantId,
          attachedByUserId: computers.attachedByUserId,
          serverId: computers.serverId,
          name: computers.name,
          machineId: computers.machineId,
        })
        .from(computers)
        .where(eq(computers.id, computer.computer.computerId))
        .limit(1);
      if (!key) return "family_mismatch";
      const issuedByThisSession = key.familyId === familyId;
      const unrecordedKeyOfThisPerson = key.familyId === null && key.webFamilyId === null && key.grantId === null
        && key.attachedByUserId === userId;
      if (!issuedByThisSession && !unrecordedKeyOfThisPerson) return "family_mismatch";
      const keyMatch: KeyMatch = issuedByThisSession ? "issued_by_session" : "unrecorded_same_person";
      const retired = await retireDeviceSessionFamilyInTransaction(tx, userId, familyId);
      if (retired === "retired") {
        // Kept off every server's audit page (serverId null): the family is the
        // person's, and the address is theirs. Ids and the address only.
        await recordIntegrationAuditEvent({
          serverId: null,
          eventType: "computer.device_session_retired",
          outcome: "success",
          source: "cli",
          actor: { type: "human", id: userId },
          subject: { type: "human", id: userId },
          target: { type: "computer", id: computer.computer.computerId },
          metadata: {
            reason: "migration_retire",
            keyMatch,
            sessionFamilyId: familyId,
            computerId: computer.computer.computerId,
            computerName: key.name,
            machineId: key.machineId,
            computerServerId: key.serverId,
            // Cleared after 30 days with the device login's other requester
            // details (scrubDeviceAuthorizationRequesterDetails).
            ...(requestIp ? { requestIp } : {}),
          },
        }, tx);
      }
      return { retired, keyMatch };
    });

    if (outcome === "not_device_session") {
      refuse(res, 409, "session_not_device", "This is not a device login session; there is nothing to retire");
      return;
    }
    if (outcome === "family_mismatch") {
      refuse(res, 403, "computer_key_family_mismatch", "This Computer key wasn't issued by this session");
      return;
    }
    const { retired, keyMatch } = outcome;
    if (retired === "not_found") {
      addTraceEvent("auth.device.session.retire_rejected", { reason: "session_not_found" });
      setRequestTraceErrorCode(res, "session_not_found");
      respondInvalidOrExpiredToken(res);
      return;
    }
    if (retired === "revoked") {
      refuse(res, 409, "session_revoked", "This session was revoked; there is nothing to retire");
      return;
    }
    // A device session opens no sockets (verifyActiveAccessTokenWithAccount
    // refuses it there), so this should find none; evicting is cheap and keeps
    // retire as final as a revoke. Best effort: the retire has committed.
    try {
      await revokeSocketAccess({ userId, familyId });
    } catch (err) {
      console.error("[device-login] retire-session socket eviction failed:", err);
    }
    addTraceEvent("auth.device.session.retired", {
      computer_id: computer.computer.computerId,
      already_retired: retired === "already_retired",
      key_match: keyMatch,
    });
    res.status(200).json({ ok: true, retired: true, alreadyRetired: retired === "already_retired" });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to retire the session",
      logPrefix: "api.computer.retire-session error:",
      err,
    });
  }
}
