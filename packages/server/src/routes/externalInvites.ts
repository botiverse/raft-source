import { Router, type Request, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { requireAuth, requireVerified } from "../middleware/auth";
import { kickAppNotificationDelivery } from "../services/appNotificationDeliveryService";
import { broadcastSystemMessageToLocalSurfaces } from "../services/messageService";
import { getUser } from "../services/userService";
import * as externalInviteService from "../services/externalInviteService";
import * as externalInviteConnectService from "../services/externalInviteConnectService";
import { AttributedJointChannelLimitError, ExternalChannelLimitError } from "../services/externalChannelLimitService";
import { ChannelConversionInProgressError } from "../services/channelConversionFenceService";
import { ChannelConversionError, ChannelConversionUploadsInFlightError } from "../services/channelConversionService";
import { JointChannelLimitError } from "../services/jointChannelLimitService";
import { createServerAsOwner, ServerCreateInputError } from "../services/serverCreateService";
import { DeploymentUserLimitError } from "../services/deploymentUserLimit";
import { recordServerCreated } from "../services/onboardingProductEvents";
import { likelyBotUserAgent, recordExternalInviteLinkOpened, recordExternalInvitePageViewed } from "../services/externalInviteProductEvents";
import {
  recordExternalConnectFinished,
  refusedOutcome,
  type ConnectFinishedOutcome,
  type ConnectFinishedRow,
  type ConnectFinishedServer,
} from "../services/externalConnectProductEvents";
import { getProductEventSink } from "../services/productEventIngest";
import { setRequestTraceErrorCode, setRequestTraceLimitSide, setRequestTraceRefusedCodes } from "../middleware/requestObservability";
import { sendJsonServerError } from "./errorResponse";
import { noteLimitPaywallHit } from "./paywallHit";

/**
 * /api/external-invites/:token: the invitee's side of an external channel
 * invite (#wg-rbac:#16, P2a-2). Beside /api/auth/accept-invite, not under the
 * channel router: the invitee is not a member of the host Server yet. Every
 * invite the caller may not use is the same 404 (externalInviteService).
 */
export const externalInviteRouter: RouterType = Router();

const INVALID_INVITE_BODY = { error: externalInviteService.INVALID_EXTERNAL_INVITE_MESSAGE };

const CONNECT_ERROR_STATUS: Record<externalInviteConnectService.ExternalConnectErrorCode, number> = {
  invalid_server: 400,
  invalid_approver: 400,
  server_admin_required: 403,
  server_membership_required: 403,
  approver_lost_role: 403,
  request_not_found: 404,
  guests_present: 409,
  connect_in_progress: 409,
  approval_in_progress: 409,
  already_connected: 409,
  channel_archived: 409,
  request_not_pending: 409,
  request_expired: 409,
  requester_left: 409,
  membership_changed: 409,
  guest_has_computer: 409,
  connect_unavailable: 409,
};

/**
 * A refusal the invitee's or approver's actions can meet, as its status and
 * body; null for anything else (a 500). The body names whose limit a limit
 * refusal is: only the connecting server's is the caller's to lift (upgrade).
 */
export function externalConnectRefusal(err: unknown): { status: number; body: { error: string; code?: string; limitSide?: string; limitServerId?: string | null } } | null {
  if (err instanceof externalInviteService.ExternalInviteAcceptError) {
    return err.code === "invalid" ? { status: 404, body: INVALID_INVITE_BODY } : { status: 409, body: { error: err.message, code: err.code } };
  }
  if (err instanceof externalInviteConnectService.ExternalConnectError) {
    return { status: CONNECT_ERROR_STATUS[err.code], body: { error: err.message, code: err.code } };
  }
  if (err instanceof ExternalChannelLimitError || err instanceof AttributedJointChannelLimitError) {
    return { status: 409, body: { error: err.message, code: err.code, limitSide: err.limitSide, limitServerId: err.limitServerId } };
  }
  if (err instanceof JointChannelLimitError
    || err instanceof ChannelConversionInProgressError || err instanceof ChannelConversionUploadsInFlightError
    || err instanceof ChannelConversionError) {
    return { status: 409, body: { error: err.message, code: err.code } };
  }
  // The Raft License's user limit (source-available): a second Guest seat, or a new server's owner.
  if (err instanceof DeploymentUserLimitError) {
    return { status: err.status, body: { error: err.refusal.error, code: err.code } };
  }
  return null;
}

/**
 * The request span's error_code for the invalid-invite 404, which has no code
 * of its own: one value for every reason an invite cannot be used (unknown,
 * expired, revoked, another address), as the answer is one body.
 */
export const INVALID_INVITE_TRACE_CODE = "external_invite_unusable";

/**
 * A refusal on the request's span: its code, and whose limit a limit refusal
 * is (a side, never the server). Nothing here reaches the caller.
 */
export function traceExternalConnectRefusal(res: Response, refusal: NonNullable<ReturnType<typeof externalConnectRefusal>>): void {
  setRequestTraceErrorCode(res, refusal.body.code ?? INVALID_INVITE_TRACE_CODE);
  const side = refusal.body.limitSide;
  if (side === "host" || side === "connecting") setRequestTraceLimitSide(res, side);
}

/** `extra`: added to a refusal's body (the new server a refused connect-new-server created). */
function sendAcceptError(req: Request, res: Response, err: unknown, action = "accept invite", extra: Record<string, string> = {}): void {
  const refusal = externalConnectRefusal(err);
  if (refusal) {
    traceExternalConnectRefusal(res, refusal);
    noteLimitPaywallHit(req, err);
    res.status(refusal.status).json({ ...refusal.body, ...extra });
    return;
  }
  sendJsonServerError(req, res, {
    error: `Failed to ${action}`,
    logPrefix: `[ExternalInvites] Failed to ${action}:`,
    err,
    extraBody: extra,
  });
}

/**
 * How a refused or failed attempt finished, as external_channel_connect_finished
 * records it: the code its answer and span name (`invite_unusable` for the one
 * invalid-invite 404) and a limit's side; anything else answered is an error.
 */
export function connectFinishedOutcomeOf(err: unknown): ConnectFinishedOutcome {
  const refusal = externalConnectRefusal(err);
  if (!refusal) return { result: "error" };
  return refusedOutcome(refusal.body.code ?? "invite_unusable", refusal.body.limitSide);
}

/** The request's rows of external_channel_connect_finished (never the worker's), after its answer is decided. */
export function recordConnectFinished(req: Request, rows: ReadonlyArray<Omit<ConnectFinishedRow, "async">>): void {
  recordExternalConnectFinished(getProductEventSink(req.app), req.userId ?? null, rows.map((row) => ({ ...row, async: false })));
}

/** A connecting server the request named, for a row kept under it only when the caller is its full member. */
function namedServer(serverId: unknown): ConnectFinishedServer {
  return typeof serverId === "string" ? serverId : null;
}

/** More than one server chosen: the list the request sent (its parse refuses anything else). */
export function choseSeveral(list: unknown): boolean {
  return Array.isArray(list) && list.length > 1;
}

/**
 * A multi-connect's rows, one per chosen server as it resolved (the server
 * the caller belongs to, when they do): `path` for the servers they connect
 * (one asked of an approver is request_approval; host_direct and
 * self_connect name their own route), and the channel's host (`host`: its
 * analytics switch and plan). The span names the refused servers' codes.
 */
export function recordServerConnectOutcomes(
  req: Request,
  res: Response,
  input: { path: "connect" | "host_direct" | "self_connect"; outcomes: readonly externalInviteConnectService.ServerConnectOutcome[]; multi: boolean; server?: ConnectFinishedServer; host: ConnectFinishedRow["host"] },
): void {
  const refused: string[] = [];
  recordConnectFinished(req, input.outcomes.map((outcome) => {
    const askedApproval = outcome.state === "awaiting_approval" || (outcome.state === "refused" && outcome.askedApproval === true);
    let finished: ConnectFinishedOutcome;
    if (outcome.state === "refused") {
      finished = connectFinishedOutcomeOf(outcome.error);
      const refusal = externalConnectRefusal(outcome.error);
      refused.push(refusal ? refusal.body.code ?? INVALID_INVITE_TRACE_CODE : "internal_error");
    } else {
      finished = { result: outcome.state };
    }
    return {
      path: input.path === "connect" && askedApproval ? "request_approval" : input.path,
      outcome: finished,
      multi: input.multi,
      server: input.server !== undefined ? input.server : outcome.serverId,
      host: input.host,
    };
  }));
  setRequestTraceRefusedCodes(res, refused);
}

/**
 * One chosen server's outcome as the multi-connect answers it: a refusal
 * carries the status and body it would have had alone (an unexpected one is
 * logged and answered `internal_error`).
 */
export function serializeServerConnectOutcome(outcome: externalInviteConnectService.ServerConnectOutcome) {
  if (outcome.state !== "refused") return outcome;
  const refusal = externalConnectRefusal(outcome.error);
  if (!refusal) {
    console.error("[ExternalInvites] Failed to connect a server:", { serverId: outcome.serverId, err: outcome.error });
    return { serverId: outcome.serverId, state: "refused" as const, status: 500, error: "Failed to connect the server", code: "internal_error" };
  }
  return { serverId: outcome.serverId, state: "refused" as const, status: refusal.status, ...refusal.body };
}

/**
 * A multi-connect's refused servers, each a paywall hit where its refusal is
 * one (noteLimitPaywallHit: counted for the server whose limit it is, when
 * the caller is its member). The answer is a 200 listing each outcome, so
 * the span carries no error_code (recordServerConnectOutcomes sets
 * refused_codes).
 */
export function noteServerConnectPaywallHits(req: Request, outcomes: readonly externalInviteConnectService.ServerConnectOutcome[]): void {
  for (const outcome of outcomes) {
    if (outcome.state === "refused") noteLimitPaywallHit(req, outcome.error);
  }
}

function connectionEffects(req: Request): externalInviteConnectService.ExternalConnectionEffects {
  return { io: req.app.get("io") as SocketServer | undefined, orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined };
}

/** Post-commit: each connection that committed, to the projections and the joiner, and its system message in the channel. */
export async function publishExternalConnections(req: Request, connections: readonly externalInviteConnectService.ExternalConnection[]): Promise<void> {
  for (const connection of connections) await externalInviteConnectService.publishExternalConnection(connectionEffects(req), connection);
}

/** 202 while the channel is first converted (the worker connects after it); 200 once connected. `extra` joins either body. */
async function sendConnectResult(req: Request, res: Response, result: externalInviteConnectService.ExternalConnectResult, extra: Record<string, string> = {}): Promise<void> {
  if (result.state === "connecting") {
    res.status(202).json({ state: "connecting", ...extra });
    return;
  }
  await externalInviteConnectService.publishExternalConnection(connectionEffects(req), result.connection);
  res.json({ state: "connected", serverId: result.connection.targetServerId, channelId: result.connection.localChannelId });
}

function connectDeps(req: Request): externalInviteConnectService.ExternalConnectDeps {
  return { revalidateExternalPrivacy: req.app.get("slackBridgePrivacyRevalidator") };
}

// The signed-out landing page of an invite link (#wg-rbac:#39): no sign-in,
// rate limited with the rest of the invite flow (app.ts), and only what the
// invite email already says. Every invite that can't be accepted now gets
// the one invalid-invite body.
externalInviteRouter.get("/:token/preview", async (req, res) => {
  try {
    const found = await externalInviteService.getExternalInviteLinkPreviewOf(String(req.params.token));
    if (!found) {
      setRequestTraceErrorCode(res, INVALID_INVITE_TRACE_CODE);
      // refusal-ok: must stay byte-identical to the invitee page's invalid-invite 404 so a link holder can't tell why an invite is unavailable
      res.status(404).json(INVALID_INVITE_BODY);
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(found.preview);
    // After the answer, which it never changes: the link opened, once per invite and day.
    // The User-Agent is judged here and dropped: only the boolean goes on.
    recordExternalInviteLinkOpened(req, found.inviteId, found.hostRecordsInviteEvents, likelyBotUserAgent(req.header("user-agent")));
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get invite",
      logPrefix: "[ExternalInvites] Failed to get invite preview:",
      err,
    });
  }
});

externalInviteRouter.get("/:token", requireAuth, async (req, res) => {
  try {
    const found = await externalInviteService.getExternalInvitePageForInvitee(String(req.params.token), req.userId!);
    if (!found) {
      setRequestTraceErrorCode(res, INVALID_INVITE_TRACE_CODE);
      res.status(404).json(INVALID_INVITE_BODY);
      return;
    }
    res.json(found.page);
    // After the answer, which it never changes: the invitee's view of an open invite, once a day.
    recordExternalInvitePageViewed(req, req.userId!, { id: found.inviteId, hostServerId: found.hostServerId }, found.page);
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get invite",
      logPrefix: "[ExternalInvites] Failed to get invite:",
      err,
    });
  }
});

/** What the channel says when a Guest joins it (#wg-rbac:#40), from the channel's point of view. */
export function guestJoinedSystemMessageText(handle: string): string {
  return `@${handle} joined as a guest.`;
}

/**
 * Post-commit, only for the acceptance that made them the channel's Guest (a
 * retry joins nobody): the channel's system message, stored once and shown on
 * every connected server's copy of a joint channel
 * (broadcastSystemMessageToLocalSurfaces), as a server's connect and
 * disconnect are. Read for the Guest, who joined.
 */
async function announceGuestJoined(req: Request, channelId: string, guestUserId: string): Promise<void> {
  const { io, orchestrator } = connectionEffects(req);
  if (!io || !orchestrator) return;
  const guest = await getUser(guestUserId);
  if (!guest) return;
  await broadcastSystemMessageToLocalSurfaces(io, orchestrator, channelId, guestJoinedSystemMessageText(guest.name), {
    inboxFactPolicy: {
      mode: "record",
      producer: "channel.human_membership",
      reason: "a Guest joining the channel is shared channel activity",
      causalActor: { type: "user", id: guestUserId },
    },
  });
}

externalInviteRouter.post("/:token/accept-as-guest", requireAuth, requireVerified, async (req, res) => {
  try {
    const accepted = await externalInviteService.acceptExternalInviteAsGuest(String(req.params.token), req.userId!);
    if (accepted.joined) {
      // Committed: deliver the server.member_added App Notification now.
      kickAppNotificationDelivery();
      // A Guest is outside #all and onboarding: no onboarding triggers here.
      const io = req.app.get("io") as SocketServer | undefined;
      io?.to(`server:${accepted.serverId}`).emit("server:member-added", { serverId: accepted.serverId, userId: req.userId! });
      io?.to(`server:${accepted.serverId}`).emit("channel:members-updated", { channelId: accepted.channelId });
      await announceGuestJoined(req, accepted.channelId, req.userId!).catch((err: unknown) => {
        console.error("[ExternalInvites] failed to post the guest-joined system message:", { channelId: accepted.channelId, err });
      });
    }
    res.json({ serverId: accepted.serverId, channelId: accepted.channelId });
    // A repeated accept (already their Guest) joined nobody: not an attempt that finished.
    if (accepted.joined) recordConnectFinished(req, [{ path: "guest", outcome: { result: "connected" }, multi: false, server: null, host: { hostServerId: accepted.serverId } }]);
  } catch (err) {
    recordConnectFinished(req, [{ path: "guest", outcome: connectFinishedOutcomeOf(err), multi: false, server: null, host: { inviteToken: String(req.params.token) } }]);
    sendAcceptError(req, res, err);
  }
});

// P2a-3: connect a server the caller owns or administers with the invite.
externalInviteRouter.post("/:token/connect", requireAuth, requireVerified, async (req, res) => {
  const serverId = (req.body as { serverId?: unknown } | null)?.serverId;
  const row = { path: "connect", multi: false, server: namedServer(serverId) } as const;
  try {
    const result = await externalInviteConnectService.connectServerWithInvite(String(req.params.token), req.userId!, serverId, connectDeps(req));
    await sendConnectResult(req, res, result);
    recordConnectFinished(req, [{ ...row, outcome: { result: result.state }, host: { inviteToken: String(req.params.token) } }]);
  } catch (err) {
    recordConnectFinished(req, [{ ...row, outcome: connectFinishedOutcomeOf(err), host: { inviteToken: String(req.params.token) } }]);
    sendAcceptError(req, res, err, "connect a server");
  }
});

// Several servers at once (the invite page's multi-select): each decided on
// its own, connected now, being connected, waiting for its approver, or
// refused with the answer it would have had alone. 404 for an invite the
// caller cannot use; 409 when it is not pending (something under way).
externalInviteRouter.post("/:token/connect-servers", requireAuth, requireVerified, async (req, res) => {
  const selections = (req.body as { servers?: unknown } | null)?.servers;
  try {
    const result = await externalInviteConnectService.connectServersWithInvite(String(req.params.token), req.userId!, selections, connectDeps(req));
    await publishExternalConnections(req, result.connections);
    noteServerConnectPaywallHits(req, result.servers);
    res.json({ servers: result.servers.map(serializeServerConnectOutcome) });
    recordServerConnectOutcomes(req, res, { path: "connect", outcomes: result.servers, multi: choseSeveral(selections), host: { inviteToken: String(req.params.token) } });
  } catch (err) {
    // Refused as a whole (the invite, the list): one row, no server decided.
    recordConnectFinished(req, [{ path: "connect", outcome: connectFinishedOutcomeOf(err), multi: choseSeveral(selections), server: null, host: { inviteToken: String(req.params.token) } }]);
    sendAcceptError(req, res, err, "connect servers");
  }
});

// P2a-5: create a server (as POST /api/servers does, the caller its owner) and
// connect it with the invite. An invite the caller cannot use, or a refusal the
// preflight sees, creates nothing; a refusal after creation names the new
// server (serverId) the caller keeps.
// Once the server exists, every failure answer names it (serverId), a 500 too.
externalInviteRouter.post("/:token/connect-new-server", requireAuth, requireVerified, async (req, res) => {
  let serverId: string | null = null;
  try {
    const created = await externalInviteConnectService.connectNewServerWithInvite(
      String(req.params.token), req.userId!, async () => {
        const server = await createServerAsOwner(req.body, req.userId!);
        recordServerCreated(req, server, req.userId!);
        return server;
      }, connectDeps(req),
    );
    serverId = created.serverId;
    await sendConnectResult(req, res, created.result, { serverId });
    recordConnectFinished(req, [{ path: "new_server", outcome: { result: created.result.state }, multi: false, server: serverId, host: { inviteToken: String(req.params.token) } }]);
  } catch (err) {
    if (err instanceof ServerCreateInputError) {
      recordConnectFinished(req, [{ path: "new_server", outcome: refusedOutcome("invalid_input"), multi: false, server: null, host: { inviteToken: String(req.params.token) } }]);
      res.status(err.status).json({ error: err.message });
      return;
    }
    const refused = err instanceof externalInviteConnectService.NewServerNotConnectedError;
    if (refused) serverId = err.serverId;
    const cause = refused ? err.cause : err;
    // Once the server exists it is the caller's own (they own it), refused or not.
    recordConnectFinished(req, [{ path: "new_server", outcome: connectFinishedOutcomeOf(cause), multi: false, server: serverId, host: { inviteToken: String(req.params.token) } }]);
    sendAcceptError(req, res, cause, "create and connect a server", serverId ? { serverId } : {});
  }
});

// P2a-3: ask an owner or admin of a server the caller belongs to to connect it.
externalInviteRouter.post("/:token/request-approval", requireAuth, requireVerified, async (req, res) => {
  const body = req.body as { serverId?: unknown; approverUserId?: unknown } | null;
  const row = { path: "request_approval", multi: false, server: namedServer(body?.serverId) } as const;
  try {
    const { requestId } = await externalInviteConnectService.requestServerConnectApproval(
      String(req.params.token), req.userId!, body?.serverId, body?.approverUserId,
    );
    res.status(201).json({ requestId, status: "awaiting_approval" });
    recordConnectFinished(req, [{ ...row, outcome: { result: "awaiting_approval" }, host: { inviteToken: String(req.params.token) } }]);
  } catch (err) {
    recordConnectFinished(req, [{ ...row, outcome: connectFinishedOutcomeOf(err), host: { inviteToken: String(req.params.token) } }]);
    sendAcceptError(req, res, err, "request approval");
  }
});

// The requester withdraws a pending request of theirs (`requestId`; without
// one, all of theirs): the invite rests on what is left.
externalInviteRouter.post("/:token/cancel-request", requireAuth, requireVerified, async (req, res) => {
  try {
    await externalInviteConnectService.cancelServerConnectRequestByRequester(
      String(req.params.token), req.userId!, (req.body as { requestId?: unknown } | null)?.requestId,
    );
    res.json({ status: "cancelled" });
  } catch (err) {
    sendAcceptError(req, res, err, "cancel the request");
  }
});

/**
 * /api/server-connect-requests/:id: the approver's side of a request to
 * connect their server to an external channel (#wg-rbac:#16, P2a-3). Only
 * the named approver sees or decides it; anyone else gets 404.
 */
export const serverConnectRequestRouter: RouterType = Router();

serverConnectRequestRouter.get("/:id", requireAuth, requireVerified, async (req, res) => {
  try {
    res.json(await externalInviteConnectService.getServerConnectRequest(String(req.params.id), req.userId!));
  } catch (err) {
    sendAcceptError(req, res, err, "get the request");
  }
});

/**
 * The approver's decision as external_channel_connect_finished records it:
 * under the request's connecting server once it is known to be theirs to
 * decide (and they are its full member). The host is the request's, also for
 * a request answered "not found" (read after the answer, never told).
 */
function approverRow(path: "approve" | "decline", requestId: string) {
  const seen: { request?: { hostServerId: string; targetServerId: string } } = {};
  return {
    observe: (request: { hostServerId: string; targetServerId: string }) => { seen.request = request; },
    row: (outcome: ConnectFinishedOutcome): Omit<ConnectFinishedRow, "async"> => {
      const known = seen.request;
      return {
        path,
        outcome,
        multi: false,
        server: known ? known.targetServerId : null,
        host: known ? { hostServerId: known.hostServerId } : { connectRequestId: requestId },
      };
    },
  };
}

serverConnectRequestRouter.post("/:id/approve", requireAuth, requireVerified, async (req, res) => {
  const finished = approverRow("approve", String(req.params.id));
  try {
    const result = await externalInviteConnectService.approveServerConnectRequest(String(req.params.id), req.userId!, connectDeps(req), finished.observe);
    await sendConnectResult(req, res, result);
    recordConnectFinished(req, [finished.row({ result: result.state })]);
  } catch (err) {
    recordConnectFinished(req, [finished.row(connectFinishedOutcomeOf(err))]);
    sendAcceptError(req, res, err, "approve the request");
  }
});

serverConnectRequestRouter.post("/:id/reject", requireAuth, requireVerified, async (req, res) => {
  const finished = approverRow("decline", String(req.params.id));
  try {
    await externalInviteConnectService.rejectServerConnectRequest(String(req.params.id), req.userId!, finished.observe);
    res.json({ status: "rejected" });
    recordConnectFinished(req, [finished.row({ result: "declined" })]);
  } catch (err) {
    recordConnectFinished(req, [finished.row(connectFinishedOutcomeOf(err))]);
    sendAcceptError(req, res, err, "reject the request");
  }
});
