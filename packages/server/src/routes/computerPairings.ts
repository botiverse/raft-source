/**
 * Computer pairings: the Add Computer window's side (contract
 * docs/contracts/computer-pairing.md, service computerPairingService.ts).
 * Every route needs the person's own full sign-in, and every route but create
 * answers only the sign-in that created the pairing (404 to anyone else).
 * The raw pairing id travels in POST bodies only, never in a URL.
 *
 *   POST /api/servers/:id/computer-pairings → {pairingId, pairingRef, serverId, expiresAt}
 *   POST /api/computer-pairings/renew   {pairingId}  → {expiresAt}
 *   POST /api/computer-pairings/cancel  {pairingId}  → {state}
 *   POST /api/computer-pairings/status  {pairingId}  → {pairingRef, state, expiresAt, request?}
 *   POST /api/computer-pairings/approve {pairingId, approvalTicket?, approve?}
 *        → the device approve's answer, for the authorization the server linked
 *
 * Mounted with the device-login surface (same kill switch) behind authLimiter.
 */
import { Router, type Request, type Response, type Router as RouterType } from "express";
import { webSessionFamilyOf } from "../services/sessionService";
import {
  cancelComputerPairing,
  COMPUTER_PAIRING_MIN_COMPUTER_VERSION,
  claimComputerPairing,
  createComputerPairing,
  findOwnComputerPairing,
  renewComputerPairing,
  type OwnComputerPairing,
  type PairingOwner,
} from "../services/computerPairingService";
import { approveDeviceAuthorization, describeDeviceAuthorization } from "../services/deviceAuthService";
import { refuse } from "../lib/refusal";
import { sendJsonServerError } from "./errorResponse";
import { refuseUnverifiedApprover } from "./secondFactor";
import { answerApproval, surfaceDisabled } from "./deviceAuth";
import { COMPUTER_INSTALL_CHANNELS, computerVersionAtLeast, getInstallableComputerVersion, type ComputerInstallChannel } from "../services/computerVersionService";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The caller's own full sign-in; refused (403) for anything else (a device session, a token with no family). */
function ownerOf(req: Request, res: Response): PairingOwner | null {
  const sessionFamilyId = webSessionFamilyOf(req);
  if (!req.userId || !sessionFamilyId) {
    refuse(res, 403, { code: "computer_pairing_sign_in_required", error: "Adding a Computer from a window needs your own sign-in to Raft on the web or desktop." });
    return null;
  }
  return { userId: req.userId, sessionFamilyId };
}

function refuseNotFound(res: Response): void {
  refuse(res, 404, { code: "computer_pairing_not_found", error: "This setup command is not known to this window. Make a new one." });
}

/** The caller's pairing named in the body, or a uniform 404. */
async function ownPairing(req: Request, res: Response): Promise<{ owner: PairingOwner; pairing: OwnComputerPairing } | null> {
  if (surfaceDisabled(res)) return null;
  const owner = ownerOf(req, res);
  if (!owner) return null;
  const pairing = await findOwnComputerPairing((req.body ?? {}).pairingId, owner);
  if (!pairing) {
    refuseNotFound(res);
    return null;
  }
  return { owner, pairing };
}

function refuseEnded(res: Response, pairing: OwnComputerPairing): void {
  if (pairing.state === "conflict") {
    refuse(res, 409, { code: "computer_pairing_conflict", error: "This setup command may have been seen by someone else: another machine used it too. Make a new one." });
    return;
  }
  refuse(res, 409, { code: "computer_pairing_ended", error: `This setup command can no longer be used (${pairing.state}). Make a new one.` });
}

export async function computerPairingCreateHandler(req: Request, res: Response): Promise<void> {
  if (surfaceDisabled(res)) return;
  try {
    const owner = ownerOf(req, res);
    if (!owner) return;
    const serverId = req.params.id;
    if (typeof serverId !== "string" || !UUID_RE.test(serverId)) {
      refuse(res, 404, { code: "server_not_found", error: "That server was not found. Check the server and try again." });
      return;
    }
    // The command carrying the pairing installs the newest Computer on the
    // window's channel; make a pairing only if that Computer takes --pair.
    // Anything unknown is "no": the window shows today's command.
    const channel = (req.body ?? {}).channel;
    const installable = COMPUTER_INSTALL_CHANNELS.includes(channel as ComputerInstallChannel)
      ? await getInstallableComputerVersion(channel as ComputerInstallChannel)
      : null;
    if (!computerVersionAtLeast(installable, COMPUTER_PAIRING_MIN_COMPUTER_VERSION)) {
      refuse(res, 409, { code: "computer_pairing_unavailable", error: "Adding a Computer without a code is not available for this install yet. Enter the code the terminal shows." });
      return;
    }
    const created = await createComputerPairing({ ...owner, serverId: serverId.toLowerCase() });
    if (!created.ok) {
      if (created.error === "too_many_pairings") {
        refuse(res, 429, { code: "computer_pairing_limit", error: "Too many Add Computer windows are open. Close one and try again." });
        return;
      }
      refuse(res, 403, { code: "computer_pairing_not_allowed", error: "You can't add Computers to this server. Ask an owner or admin." });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      pairingId: created.pairingId, // raw — returned exactly once
      pairingRef: created.pairingRef,
      serverId: serverId.toLowerCase(),
      expiresAt: created.expiresAt.toISOString(),
    });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to create a computer pairing", logPrefix: "api.computer_pairings.create error:", err });
  }
}

export const computerPairingRouter: RouterType = Router();

computerPairingRouter.post("/renew", async (req, res) => {
  try {
    const found = await ownPairing(req, res);
    if (!found) return;
    const expiresAt = await renewComputerPairing(found.pairing);
    if (!expiresAt) {
      refuseEnded(res, found.pairing);
      return;
    }
    res.status(200).json({ expiresAt: expiresAt.toISOString() });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to renew the computer pairing", logPrefix: "api.computer_pairings.renew error:", err });
  }
});

computerPairingRouter.post("/cancel", async (req, res) => {
  try {
    const found = await ownPairing(req, res);
    if (!found) return;
    await cancelComputerPairing(found.pairing);
    res.status(200).json({ ok: true });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to cancel the computer pairing", logPrefix: "api.computer_pairings.cancel error:", err });
  }
});

computerPairingRouter.post("/status", async (req, res) => {
  try {
    const found = await ownPairing(req, res);
    if (!found) return;
    const { pairing, owner } = found;
    const linkedId = pairing.row.linkedDeviceAuthorizationId;
    let request: Record<string, unknown> | undefined;
    if (pairing.state === "requested" && linkedId) {
      // What the device page's describe shows for this request, and its
      // approval ticket: the window approves only after showing it.
      const described = await describeDeviceAuthorization({ linkedAuthorizationId: linkedId, userId: owner.userId });
      if (described.ok && described.grant) {
        request = {
          // The code the terminal shows, so the person can tell it is their machine.
          userCode: described.userCode,
          clientName: described.clientName,
          requestedAt: described.requestedAt.toISOString(),
          requester: described.requester,
          approvalTicket: described.approvalTicket,
          grant: {
            kind: described.grant.kind,
            machineName: described.grant.machineName,
            hostname: described.grant.hostname,
            os: described.grant.os,
          },
        };
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      pairingRef: pairing.row.id,
      serverId: pairing.row.serverId,
      state: pairing.state,
      expiresAt: pairing.row.expiresAt.toISOString(),
      ...(request ? { request } : {}),
    });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to read the computer pairing", logPrefix: "api.computer_pairings.status error:", err });
  }
});

// Approve (or deny, `approve: false`) the request the server linked to this
// pairing: the device approve's path, with the pairing's server as the pick.
computerPairingRouter.post("/approve", async (req, res) => {
  try {
    const found = await ownPairing(req, res);
    if (!found) return;
    const { pairing, owner } = found;
    const body = (req.body ?? {}) as { approvalTicket?: unknown; approve?: unknown };
    const approve = body.approve === undefined ? true : body.approve === true;
    const linkedId = pairing.row.linkedDeviceAuthorizationId;
    if (pairing.state !== "requested" || !linkedId) {
      refuseEnded(res, pairing);
      return;
    }
    if (approve && await refuseUnverifiedApprover(res, owner.userId, owner.sessionFamilyId)) return;
    const result = await approveDeviceAuthorization({
      linkedAuthorizationId: linkedId,
      userId: owner.userId,
      approve,
      approvalTicket: body.approvalTicket,
      selection: { serverId: pairing.row.serverId },
      approverSessionFamilyId: owner.sessionFamilyId,
      claim: claimComputerPairing(pairing.row.id, linkedId),
    });
    await answerApproval(res, { userId: owner.userId, approve, result, traceAttrs: { computer_pairing_ref: pairing.row.id } });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to update the computer pairing", logPrefix: "api.computer_pairings.approve error:", err });
  }
});
