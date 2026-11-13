import { DEPLOYMENT_USER_LIMIT_REACHED_CODE, SERVER_SLUG_MIN_LENGTH, validateNewServerSlugReason } from "@botiverse/raft-shared";
import type { ServerSlugValidationReason, UpgradeGate } from "@botiverse/raft-shared";
import api from "../../api/client";
import type { MessageId } from "../../i18n/messages";

/**
 * External channel invites, the invitee's and the approver's side
 * (#wg-rbac:#16, P2b-2, design v5.0 B1–B5). The invite email links
 * /external-invite/:token (emailService externalChannelInviteUrl) and the
 * approval email /server-connect-requests/:id (serverConnectRequestUrl).
 * Every route answers 404 while external_channels_v1 is off for the host
 * Server, and one neutral 404 for any invite the caller may not use, so the
 * pages read the flag through the server's answer rather than a client flag.
 */

/** The web routes the server's emails link to. */
export const EXTERNAL_INVITE_ROUTE = "/external-invite/:token";
export const SERVER_CONNECT_REQUEST_ROUTE = "/server-connect-requests/:id";

/**
 * Signed out at one of those links: the line Sign In shows there (why), and
 * for the invite link its token (the landing page, #wg-rbac:#39). The page
 * itself opens at the same address once signed in (and verified).
 */
export function externalLinkSignIn(pathname: string): { purpose: MessageId | null; inviteToken: string | null } {
  const invite = pathname.match(/^\/external-invite\/([^/]+)\/?$/);
  if (invite) {
    let inviteToken: string | null = null;
    try {
      inviteToken = decodeURIComponent(invite[1]!);
    } catch {
      // A malformed address: Sign In alone, as before.
    }
    return { purpose: "externalInvite.signInPrompt", inviteToken };
  }
  const approval = /^\/server-connect-requests\/[^/]+\/?$/.test(pathname);
  return { purpose: approval ? "serverConnectRequest.signInPrompt" : null, inviteToken: null };
}

/** One of a server's owners, as a limit names who can lift it (`owners`). */
export interface ServerOwnerRef {
  id: string;
  name: string;
  avatarUrl?: string | null;
}

/** A server the invitee belongs to that could connect to the channel (GET options.connect.servers). */
export interface ConnectableServer {
  id: string;
  name: string;
  /** Its slug and tile, as the caller's own server list has them (absent from an older server). */
  slug?: string;
  avatarUrl?: string | null;
  /** They own or administer it: connecting needs nobody's approval. */
  canConnectDirectly: boolean;
  /** A member only: an owner or admin of it must approve. */
  needsApproval: boolean;
  /** Who can approve, when it needs approval. */
  approvers: Array<{ id: string; name: string; avatarUrl?: string | null }>;
  /**
   * The free plan's one external channel keeps it out (it is already in
   * one): listed, not chosen. Absent from an older server.
   */
  atLimit?: boolean;
  /**
   * At its limit, and the caller owns it: Upgrade is theirs (only an owner
   * pays). An older server also set it for an admin; `owners` tells the two apart.
   */
  canUpgrade?: boolean;
  /**
   * At its limit: who can upgrade it, so the page can name them (it may
   * include the caller). Absent when not at its limit, and from an older server.
   */
  owners?: ServerOwnerRef[];
}

/**
 * A server at the free plan's one external channel that the viewer can
 * upgrade from the page they're on (design v4 C, E): they own it (`canUpgrade`,
 * which an older server also set for an admin, so their own role too). Anyone
 * else asks an owner.
 */
export function upgradesHere(server: { atLimit?: boolean; canUpgrade?: boolean }, role: string | null | undefined): boolean {
  return server.atLimit === true && server.canUpgrade === true && role === "owner";
}

/** The most owners a limit line names; more, and it says "an owner" (design v4 D). */
const MAX_NAMED_OWNERS = 3;

/** The owners a limit line names: not the viewer, and none when the server doesn't say or there are too many to list. */
export function limitOwnerNames(owners: readonly ServerOwnerRef[] | undefined, viewerId: string | null | undefined): string[] {
  const names = (owners ?? []).filter((owner) => owner.id !== viewerId && owner.name).map((owner) => owner.name);
  return names.length <= MAX_NAMED_OWNERS ? names : [];
}

export interface ExternalInviteForInvitee {
  channelName: string;
  serverName: string;
  inviterName: string;
  expiresAt: string;
  /**
   * awaiting_approval or connecting: a connection with this invite is under
   * way. accepted: only the person who accepted it is told (see `accepted`).
   */
  status: "pending" | "awaiting_approval" | "connecting" | "accepted";
  /**
   * `newServer`: they may create a server and connect it (POST connect-new-server).
   * `connect.slotsLeft`: how many of the servers the channel can still take, with servers to connect. Absent from an older server.
   * Absent for an account the invite wasn't sent to (`addressedToYou: false`): that answer carries only the masked address.
   */
  options?: { guest: boolean; connect: { servers: ConnectableServer[]; slotsLeft?: number }; newServer?: boolean };
  /** To the invitee: which step a connection under way is in. */
  connectPhase?: "conversion" | "connection";
  /** A connecting invite, to the invitee only: the server being connected (theirs). Absent from an older server. */
  connectServerId?: string;
  /** To the requester, while their request waits for approval (the first, when several do). */
  pendingRequest?: PendingConnectRequest;
  /** To the requester: every request of theirs waiting for approval, one per server. Absent from an older server. */
  pendingRequests?: PendingConnectRequest[];
  /**
   * To the invitee: their servers this invite connected, is connecting
   * (the conversion first, or queued behind another) or waits on. An
   * invite connects several, and stays open until each is done. Absent from
   * an older server.
   */
  servers?: InviteServerProgress[];
  /** To the requester: their latest request was declined (rejected) or cancelled. */
  lastRequest?: { status: "rejected" | "cancelled"; decidedAt: string | null; serverName: string; cancelReason: string | null };
  /** To the person who accepted it: where they landed (the host channel, or their server's projection of it). */
  accepted?: { outcome: "guest" | "server" | "new_server"; serverId: string; channelId: string; channelName: string };
  /** False: the invite wasn't sent to this account's verified address (an older server leaves it out). */
  addressedToYou?: boolean;
  /** To an account it isn't addressed to: the invited address, its local part masked ("l•••@contoso.com"). */
  invitedEmailMasked?: string;
  /** The channel has no slot left: every option is off, and the page says it is full. */
  channelFull?: boolean;
}

export interface PendingConnectRequest {
  id: string;
  serverId: string;
  serverName: string;
  approverUserId: string;
  approverName: string;
  expiresAt: string;
}

/** One of the invitee's servers and where it stands with the invite (GET `servers`). */
export interface InviteServerProgress {
  serverId: string;
  serverName: string;
  state: "connected" | "connecting" | "awaiting_approval";
  /** awaiting_approval: their request, and whom they asked. */
  requestId?: string;
  approverName?: string;
}

/** A chosen server and, for one that needs approval, who is asked. */
export interface ServerSelection {
  serverId: string;
  approverUserId?: string;
}

/**
 * Where one chosen server stands once connect-servers answered: connected
 * (its channel there), being connected, waiting for its approver, or refused
 * with the status and body it would have had alone.
 */
export type ServerConnectOutcome =
  | { serverId: string; state: "connected"; channelId: string }
  | { serverId: string; state: "connecting" }
  | { serverId: string; state: "awaiting_approval"; requestId: string }
  | { serverId: string; state: "refused"; status: number; error: string; code?: string; limitSide?: string; limitServerId?: string | null };

/** A refused outcome as the request error it would have been alone, for the error mapping (inviteeErrorMessage). */
export function refusalAsError(outcome: Extract<ServerConnectOutcome, { state: "refused" }>): unknown {
  const { serverId: _serverId, state: _state, status, ...data } = outcome;
  return { response: { status, data } };
}

/** 200: connected now; 202: the channel is converted first and the server connects after it. */
export type ConnectResult =
  | { state: "connected"; serverId: string; channelId: string }
  | { state: "connecting" };

/** connect-new-server: as ConnectResult, and the server it created when still connecting. */
export type NewServerConnectResult =
  | { state: "connected"; serverId: string; channelId: string }
  | { state: "connecting"; serverId: string };

export interface ServerConnectRequestView {
  id: string;
  status: "pending" | "approved" | "rejected" | "cancelled" | "expired";
  channelName: string;
  hostServerName: string;
  /**
   * `atLimit`: the free plan's one external channel keeps it out (it is in
   * one already), known when the page opens; `canUpgrade`: the approver owns
   * it, so upgrading is theirs; `owners`: who can, at its limit (may include
   * the approver). All three absent from an older server.
   */
  targetServer: { id: string; name: string; atLimit?: boolean; canUpgrade?: boolean; owners?: ServerOwnerRef[] };
  requester: { id: string; name: string };
  expiresAt: string;
  /** The approver's server's channel once it is connected (its projection); null before. Absent from an older server. */
  targetChannelId?: string | null;
  /** The approver may approve it, apart from the limit. Absent from an older server. */
  canApprove?: boolean;
}

const token = (value: string) => encodeURIComponent(value);

export async function getExternalInvite(inviteToken: string): Promise<ExternalInviteForInvitee> {
  const { data } = await api.get<ExternalInviteForInvitee>(`/external-invites/${token(inviteToken)}`);
  return data;
}

/**
 * What a signed-out link holder may see of an invite (GET preview, no auth),
 * for the landing page before they sign in or create an account. Every
 * unavailable invite is the same 404 (no reason), as for the invitee page.
 * A forwarded link reveals nothing of the invite but the masked address
 * (#wg-rbac): the page reads no other field, and an older server's extra
 * fields (inviter, host server, channel, expiry) are ignored.
 */
export interface ExternalInviteLinkPreview {
  status: "valid";
  /** The invited address, its local part masked ("l•••@contoso.com"). */
  invitedEmailMasked: string;
}

export async function getExternalInvitePreview(inviteToken: string): Promise<ExternalInviteLinkPreview> {
  const { data } = await api.get<ExternalInviteLinkPreview>(`/external-invites/${token(inviteToken)}/preview`);
  return data;
}

export async function acceptExternalInviteAsGuest(inviteToken: string): Promise<{ serverId: string; channelId: string }> {
  const { data } = await api.post<{ serverId: string; channelId: string }>(`/external-invites/${token(inviteToken)}/accept-as-guest`);
  return data;
}

export async function connectServerWithInvite(inviteToken: string, serverId: string): Promise<ConnectResult> {
  const response = await api.post<ConnectResult>(`/external-invites/${token(inviteToken)}/connect`, { serverId });
  return response.status === 202 ? { state: "connecting" } : response.data;
}

/** Several servers at once: each decided on its own (ServerConnectOutcome), in the order chosen. */
export async function connectServersWithInvite(inviteToken: string, servers: ServerSelection[]): Promise<ServerConnectOutcome[]> {
  const { data } = await api.post<{ servers: ServerConnectOutcome[] }>(`/external-invites/${token(inviteToken)}/connect-servers`, { servers });
  return data.servers;
}

/** Create a server (the caller its owner, as POST /api/servers) and connect it with the invite. */
export async function connectNewServerWithInvite(inviteToken: string, input: { name: string; slug: string }): Promise<NewServerConnectResult> {
  const { data } = await api.post<NewServerConnectResult>(`/external-invites/${token(inviteToken)}/connect-new-server`, input);
  return data;
}

export async function requestServerConnectApproval(inviteToken: string, serverId: string, approverUserId: string): Promise<{ requestId: string }> {
  const { data } = await api.post<{ requestId: string }>(
    `/external-invites/${token(inviteToken)}/request-approval`,
    { serverId, approverUserId },
  );
  return data;
}

/** The requester withdraws a pending request (`requestId`; without one, all of theirs): the invite rests on what is left. */
export async function cancelServerConnectRequest(inviteToken: string, requestId?: string): Promise<void> {
  await api.post(`/external-invites/${token(inviteToken)}/cancel-request`, requestId ? { requestId } : undefined);
}

export async function getServerConnectRequest(requestId: string): Promise<ServerConnectRequestView> {
  const { data } = await api.get<ServerConnectRequestView>(`/server-connect-requests/${token(requestId)}`);
  return data;
}

export async function approveServerConnectRequest(requestId: string): Promise<ConnectResult> {
  const response = await api.post<ConnectResult>(`/server-connect-requests/${token(requestId)}/approve`);
  return response.status === 202 ? { state: "connecting" } : response.data;
}

export async function rejectServerConnectRequest(requestId: string): Promise<void> {
  await api.post(`/server-connect-requests/${token(requestId)}/reject`);
}

type ApiError = { response?: { status?: number; data?: { code?: unknown; serverId?: unknown; limitSide?: unknown; limitServerId?: unknown } } };

export function apiErrorStatus(err: unknown): number | null {
  const status = (err as ApiError | null)?.response?.status;
  return typeof status === "number" ? status : null;
}

export function apiErrorCode(err: unknown): string | null {
  const code = (err as ApiError | null)?.response?.data?.code;
  return typeof code === "string" ? code : null;
}

/** connect-new-server refused after creating the server: the server the caller keeps. */
export function apiErrorServerId(err: unknown): string | null {
  const serverId = (err as ApiError | null)?.response?.data?.serverId;
  return typeof serverId === "string" && serverId ? serverId : null;
}

/**
 * Whose limit a limit refusal is (409 limitSide / limitServerId): the host's,
 * or the connecting server's (`serverId` null for one not created yet). Null
 * when the answer doesn't say (not a limit refusal).
 */
export function apiErrorLimit(err: unknown): { side: "host" | "connecting"; serverId: string | null } | null {
  const data = (err as ApiError | null)?.response?.data;
  if (data?.limitSide !== "host" && data?.limitSide !== "connecting") return null;
  return { side: data.limitSide, serverId: typeof data.limitServerId === "string" && data.limitServerId ? data.limitServerId : null };
}

/** The new server's name and slug fields; a refusal of either is shown on its field. */
export type NewServerFieldErrors = { name?: MessageId; slug?: MessageId };

/** Values the field errors take: {count}, the shortest slug. */
export const NEW_SERVER_FIELD_ERROR_VALUES = { count: SERVER_SLUG_MIN_LENGTH };

const SLUG_ERROR_IDS: Record<ServerSlugValidationReason["code"], MessageId> = {
  required: "externalInvite.newServer.slugRequired",
  too_short: "externalInvite.newServer.slugTooShort",
  pattern: "externalInvite.newServer.slugPattern",
};

/** What POST /api/servers would refuse in a name and slug, checked before asking (the same shared slug rules). */
export function newServerFieldErrors(name: string, slug: string): NewServerFieldErrors {
  const errors: NewServerFieldErrors = {};
  if (!name.trim()) errors.name = "externalInvite.newServer.nameRequired";
  const reason = validateNewServerSlugReason(slug);
  if (reason) errors.slug = SLUG_ERROR_IDS[reason.code];
  return errors;
}

/**
 * A refusal of the name or slug themselves (POST /api/servers' 400, or 409 for
 * a slug taken; neither has a `code`), on its field; null for any other refusal.
 */
export function newServerInputRefusal(err: unknown, name: string, slug: string): NewServerFieldErrors | null {
  if (apiErrorCode(err) !== null || apiErrorServerId(err) !== null) return null;
  const status = apiErrorStatus(err);
  if (status === 409) return { slug: "externalInvite.newServer.slugTaken" };
  if (status !== 400) return null;
  const errors = newServerFieldErrors(name, slug);
  return errors.name || errors.slug ? errors : { slug: "externalInvite.newServer.slugPattern" };
}

/**
 * A limit refusal names whose limit it is (apiErrorLimit). Upgrade is offered
 * only for the connecting server's, and only when that server is the caller's
 * own (`target`, from their server list): the host's limit is the inviter's to
 * lift. An answer without the side (an older server) falls back to the plan:
 * a paid connecting server means the limit was the host's.
 */
export function isFreePlan(plan: string | null | undefined): boolean {
  return !plan || plan === "free";
}

type LimitTarget = { id: string; plan?: string | null } | null;

/** Whose free_external_limit / joint_free_server_limit this is, for the caller: theirs to upgrade, the host's, or a server not created yet. */
function limitOwner(err: unknown, target: LimitTarget): "mine" | "host" | "unborn" {
  const limit = apiErrorLimit(err);
  if (!limit) return target && !isFreePlan(target.plan) ? "host" : "mine";
  // The host's limit names the host, never a server the caller connects.
  if (limit.side === "connecting" && !limit.serverId) return "unborn";
  return target?.id === limit.serverId ? "mine" : "host";
}

/**
 * Friendly text for each refusal the invitee's actions can get. Values take
 * {channel} (with its #), {server} (the host), {target} (the server being
 * connected), {inviter} and {max} (a joint channel's party cap).
 */
const INVITEE_ERROR_IDS: Record<string, MessageId> = {
  // accept-as-guest
  guest_unavailable: "externalInvite.error.guestUnavailable",
  already_member: "externalInvite.error.alreadyMember",
  guest_elsewhere: "externalInvite.error.guestElsewhere",
  channel_full: "externalInvite.error.channelFull",
  // accept-as-guest (a second Guest seat) or a new server's owner: the Raft License's user limit (source-available)
  [DEPLOYMENT_USER_LIMIT_REACHED_CODE]: "deploymentUserLimit.refused",
  // connect / request-approval
  invalid_server: "externalInvite.error.invalidServer",
  server_admin_required: "externalInvite.error.serverAdminRequired",
  server_membership_required: "externalInvite.error.serverMembershipRequired",
  invalid_approver: "externalInvite.error.invalidApprover",
  guests_present: "externalInvite.error.guestsPresent",
  joint_party_limit: "externalInvite.error.jointPartyLimit",
  already_connected: "externalInvite.error.alreadyConnected",
  joint_server_limit: "externalInvite.error.jointServerLimit",
  joint_channel_free_limit_reached: "externalInvite.error.hostLimit",
  joint_channel_plan_limit_reached: "externalInvite.error.hostLimit",
  // both
  connect_in_progress: "externalInvite.error.connectInProgress",
  channel_archived: "externalInvite.error.archived",
  channel_conversion_in_progress: "externalInvite.error.busy",
  channel_conversion_fence_conflict: "externalInvite.error.busy",
  channel_conversion_ledger_conflict: "externalInvite.error.busy",
};

export type InviteeAction = "guest" | "connect" | "request" | "newServer" | "cancel";

/**
 * The upgrade dialog's gate a refusal's Upgrade opens: the Free plan's one
 * external channel, or, for a joint's free-server cap, the dialog for no
 * specific limit as before (its own gate, `joint_channel_free_cap`, would
 * change what the dialog says).
 */
export type RefusalUpgradeGate = Extract<UpgradeGate, "external_channel_free_limit" | "general">;

/** A refusal as a banner says it: its text, and the gate Upgrade opens where the connecting server's plan can lift it (`false`: no Upgrade). */
export type RefusalMessage = { id: MessageId; upgrade: RefusalUpgradeGate | false };

/** An invitee refusal: its text, and whether Upgrade (the connecting server's plan) can lift it. */
export function inviteeErrorMessage(
  err: unknown,
  action: InviteeAction,
  target: LimitTarget,
): RefusalMessage {
  const code = apiErrorCode(err);
  if (code === "free_external_limit") {
    // Joining as a Guest only ever meets the host's limit, and so does a new
    // server (it shares no channel yet).
    if (action === "guest" || action === "newServer" || limitOwner(err, target) !== "mine") return { id: "externalInvite.error.hostLimit", upgrade: false };
    return { id: "externalInvite.error.targetFreeLimit", upgrade: "external_channel_free_limit" };
  }
  if (code === "joint_free_server_limit") {
    // The free server being added is over the channel's free-server cap: the caller's to upgrade when it is theirs.
    const owner = limitOwner(err, target);
    if (owner === "mine" && apiErrorLimit(err)) return { id: "externalInvite.error.jointFreeServerLimit", upgrade: "general" };
    return { id: owner === "unborn" ? "externalInvite.error.jointServerLimit" : "externalInvite.error.hostLimit", upgrade: false };
  }
  if (code && INVITEE_ERROR_IDS[code]) return { id: INVITEE_ERROR_IDS[code], upgrade: false };
  if (apiErrorStatus(err) === 429) return { id: "externalInvite.error.tooManyAttempts", upgrade: false };
  return { id: "externalInvite.error.generic", upgrade: false };
}

/** The approver's banner refusals (decided states are pages of their own: see ServerConnectRequestPage). */
const APPROVER_ERROR_IDS: Record<string, MessageId> = {
  guests_present: "serverConnectRequest.error.guestsPresent",
  joint_party_limit: "serverConnectRequest.error.jointPartyLimit",
  connect_in_progress: "serverConnectRequest.error.connectInProgress",
  channel_full: "serverConnectRequest.error.channelFull",
  joint_server_limit: "serverConnectRequest.error.channelFull",
  joint_channel_free_limit_reached: "serverConnectRequest.error.hostLimit",
  joint_channel_plan_limit_reached: "serverConnectRequest.error.hostLimit",
  channel_conversion_in_progress: "serverConnectRequest.error.busy",
  channel_conversion_fence_conflict: "serverConnectRequest.error.busy",
  channel_conversion_ledger_conflict: "serverConnectRequest.error.busy",
};

export function approverErrorMessage(err: unknown, target: LimitTarget): RefusalMessage {
  const code = apiErrorCode(err);
  if (code === "free_external_limit") {
    if (limitOwner(err, target) !== "mine") return { id: "serverConnectRequest.error.hostLimit", upgrade: false };
    return { id: "serverConnectRequest.error.targetFreeLimit", upgrade: "external_channel_free_limit" };
  }
  if (code === "joint_free_server_limit") {
    if (limitOwner(err, target) === "mine" && apiErrorLimit(err)) return { id: "serverConnectRequest.error.jointFreeServerLimit", upgrade: "general" };
    return { id: "serverConnectRequest.error.hostLimit", upgrade: false };
  }
  if (code && APPROVER_ERROR_IDS[code]) return { id: APPROVER_ERROR_IDS[code], upgrade: false };
  if (apiErrorStatus(err) === 429) return { id: "externalInvite.error.tooManyAttempts", upgrade: false };
  return { id: "serverConnectRequest.error.generic", upgrade: false };
}
