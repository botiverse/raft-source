import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import api from "../../api/client";
import type { MessageId } from "../../i18n/messages";
import type { Channel } from "../../store/channelStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { Server } from "../../store/serverStore";
import { useServerStore } from "../../store/serverStore";
import { DEFAULT_COMMUNITY_SERVER_SLUG, CHINESE_COMMUNITY_SERVER_SLUG } from "../../utils/communityServers";
import { apiErrorCode, apiErrorStatus, approverErrorMessage, refusalAsError } from "../externalInvite/externalInviteAccept";
import type { ServerConnectOutcome, ServerOwnerRef } from "../externalInvite/externalInviteAccept";

/**
 * A channel member connects a server they own or administer to the channel,
 * no host approval (#wg-rbac:#36, design Wef3ZksBhcoE6GVV4nCskn, entry C:
 * the Connected servers ⋯ menu). POST /channels/:id/connect-my-servers
 * (`:id` the viewer's own copy) answers each chosen server on its own. The
 * route is behind the host's external_channels_v1 and answers 404 for anyone
 * not in the channel; there is no list endpoint for a member, so the servers offered are derived here from the viewer's
 * own servers and the channel's connected ones, by the server's rule
 * (listConnectableServers: not the host, not connected, no community server,
 * owner or admin to connect it).
 */

type MemberConnectChannel = Pick<Channel, "id" | "name" | "type" | "serverId" | "archivedAt" | "joined" | "jointServers">;

/** Why a server of the viewer's is listed but can't be chosen. */
export type MemberConnectRowState = "eligible" | "connected" | "notAdmin";

export interface MemberConnectRow {
  server: Pick<Server, "id" | "name" | "slug" | "avatarUrl" | "role">;
  state: MemberConnectRowState;
}

const COMMUNITY_SLUGS = new Set<string>([DEFAULT_COMMUNITY_SERVER_SLUG, CHINESE_COMMUNITY_SERVER_SLUG]);

/** Private channels and channels shared with other servers take a member's server; never #all, an archived one or one the viewer isn't in. */
function isMemberConnectChannel(channel: MemberConnectChannel | null | undefined, currentServerId: string | null): channel is MemberConnectChannel {
  if (!channel || !currentServerId || channel.archivedAt || channel.joined !== true) return false;
  if (channel.type === "joint") return Boolean(channel.jointServers?.some((server) => server.status === "active"));
  return channel.type === "private" && channel.name !== "all" && (!channel.serverId || channel.serverId === currentServerId);
}

/** The host: the joint's host row, else (a private channel) the current server. */
export function memberConnectHostServerId(channel: MemberConnectChannel, currentServerId: string): string {
  if (channel.type !== "joint") return currentServerId;
  return channel.jointServers?.find((server) => server.role === "host")?.serverId ?? currentServerId;
}

/**
 * The viewer's servers the dialog lists, chosen ones first: those they own or
 * administer and that aren't in the channel (eligible), then those in it
 * already, then those they only belong to. Never the host, a server they are
 * a Guest of, or a community server. Empty when the channel takes none.
 */
export function memberConnectRows(
  channel: MemberConnectChannel | null | undefined,
  servers: readonly Pick<Server, "id" | "name" | "slug" | "avatarUrl" | "role">[],
  currentServerId: string | null,
): MemberConnectRow[] {
  if (!isMemberConnectChannel(channel, currentServerId) || !currentServerId) return [];
  const hostServerId = memberConnectHostServerId(channel, currentServerId);
  const connected = new Set((channel.jointServers ?? []).filter((server) => server.status === "active").map((server) => server.serverId));
  if (channel.type !== "joint") connected.add(currentServerId);
  const rank: Record<MemberConnectRowState, number> = { eligible: 0, connected: 1, notAdmin: 2 };
  return servers
    .filter((server) => server.id !== hostServerId && server.role !== "guest" && !COMMUNITY_SLUGS.has(server.slug))
    .map((server): MemberConnectRow => ({
      server,
      state: connected.has(server.id) ? "connected" : server.role === "owner" || server.role === "admin" ? "eligible" : "notAdmin",
    }))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.server.name.localeCompare(b.server.name));
}

/**
 * Whether the Connected servers ⋯ offers Connect your servers, and what the
 * dialog lists: external_channels_v1 on (read for the current server), the
 * viewer in the channel, and at least one server they can connect. Off, the entry is
 * not drawn at all (no greyed item).
 */
export function useMemberConnectRows(channel: MemberConnectChannel | null | undefined): { available: boolean; rows: MemberConnectRow[] } {
  const external = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const servers = useServerStore((s) => s.servers);
  const currentServerId = useServerStore((s) => s.current?.id ?? null);
  if (!external) return { available: false, rows: NO_ROWS };
  const rows = memberConnectRows(channel, servers, currentServerId);
  return { available: rows.some((row) => row.state === "eligible"), rows };
}

const NO_ROWS: MemberConnectRow[] = [];

/**
 * A server of the viewer's at the free plan's one external channel (design v4
 * F): it can't connect until it is upgraded. `canUpgrade`: the viewer owns it
 * (Upgrade); otherwise they ask an owner. `owners`: who can.
 */
export interface MemberConnectLimit {
  atLimit: boolean;
  canUpgrade: boolean;
  owners: ServerOwnerRef[];
}

type ConnectMyServersList = { servers?: Array<{ id: string; atLimit?: boolean; canUpgrade?: boolean; owners?: ServerOwnerRef[] }> };

const NO_LIMITS: ReadonlyMap<string, MemberConnectLimit> = new Map();

/**
 * GET /channels/:id/connect-my-servers: the viewer's servers as the server
 * lists them for this channel, each with the free plan's limit. Read while
 * the dialog is open; the rows stay the ones derived here (memberConnectRows)
 * and take each server's limit from it. An older server has no such route
 * (404), and nothing is at its limit until Connect is refused, as before.
 */
export function useMemberConnectLimits(channelId: string): ReadonlyMap<string, MemberConnectLimit> {
  const [limits, setLimits] = useState<{ channelId: string; byServer: ReadonlyMap<string, MemberConnectLimit> } | null>(null);
  useEffect(() => {
    let live = true;
    api.get<ConnectMyServersList>(`/channels/${channelId}/connect-my-servers`)
      .then(({ data }) => {
        if (!live || !Array.isArray(data?.servers)) return;
        const byServer = new Map(data.servers.filter((server) => typeof server.id === "string").map((server) => [server.id, {
          atLimit: server.atLimit === true,
          canUpgrade: server.canUpgrade === true,
          owners: Array.isArray(server.owners) ? server.owners : [],
        }]));
        setLimits({ channelId, byServer });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [channelId]);
  return limits?.channelId === channelId ? limits.byServer : NO_LIMITS;
}

/** POST /channels/:id/connect-my-servers: each chosen server's outcome. */
export async function connectMyServers(channelId: string, serverIds: string[]): Promise<ServerConnectOutcome[]> {
  const { data } = await api.post<{ servers: ServerConnectOutcome[] }>(`/channels/${channelId}/connect-my-servers`, { serverIds });
  return data.servers;
}

// ── What a refusal says ──

/** A whole request refused: by code, else by status. `closed`: the route is gone for this viewer (flag off, not in the channel). */
export function memberConnectRequestError(err: unknown): { id: MessageId; closed: boolean } {
  const code = apiErrorCode(err);
  if (code === "guest_has_computer") return { id: "channel.memberConnect.error.guestHasComputer", closed: true };
  if (code === "channel_not_invitable") return { id: "channel.memberConnect.error.notAllowed", closed: true };
  if (code === "invalid_input") return { id: "serverConnectRequest.error.generic", closed: false };
  const status = apiErrorStatus(err);
  if (status === 404 || status === 403) return { id: "channel.memberConnect.error.notAllowed", closed: true };
  if (status === 429) return { id: "externalInvite.error.tooManyAttempts", closed: false };
  return { id: "serverConnectRequest.error.generic", closed: false };
}

/**
 * One chosen server's refusal, as a sentence: this flow's own words where the
 * actor is the one connecting (no longer an admin, already connected, their
 * membership changed), else the approver's (serverConnectRequest), which
 * speaks to someone connecting a server they administer, and a few of the
 * invitee's (externalInvite). Values: {target}, {channel} (with #), {host}, {max}.
 */
const MEMBER_REFUSAL_IDS: Record<string, MessageId> = {
  server_admin_required: "channel.memberConnect.error.notAdmin",
  already_connected: "channel.memberConnect.error.alreadyConnected",
  membership_changed: "channel.memberConnect.error.membershipChanged",
  server_membership_required: "externalInvite.error.serverMembershipRequired",
  invalid_server: "externalInvite.error.invalidServer",
  channel_archived: "externalInvite.error.archived",
  channel_full: "serverConnectRequest.error.channelFull",
  joint_server_limit: "serverConnectRequest.error.channelFull",
};

export function memberConnectRefusalMessageId(outcome: Extract<ServerConnectOutcome, { state: "refused" }>): MessageId {
  if (outcome.code && MEMBER_REFUSAL_IDS[outcome.code]) return MEMBER_REFUSAL_IDS[outcome.code];
  // A limit refusal says whose limit it is; the target is the viewer's own
  // server, so "upgrade it" is theirs to do. No plan is known here: the
  // answer's limitServerId decides.
  return approverErrorMessage(refusalAsError(outcome), { id: outcome.serverId }).id;
}

/** After a refusal, how the row reads: chosen again only where trying again could help. */
export function memberConnectRefusalRowState(outcome: Extract<ServerConnectOutcome, { state: "refused" }>): MemberConnectRowState | null {
  if (outcome.code === "already_connected") return "connected";
  if (outcome.code === "server_admin_required") return "notAdmin";
  return null;
}

// ── Who connected a row, while this page lives ──
// The channel's server list carries no "connected by"; a server the viewer
// just connected says so on its row until the page reloads.

const connectedByYou = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();
const NO_IDS: ReadonlySet<string> = new Set();

export function markConnectedByYou(channelId: string, serverIds: readonly string[]): void {
  if (serverIds.length === 0) return;
  connectedByYou.set(channelId, new Set([...(connectedByYou.get(channelId) ?? NO_IDS), ...serverIds]));
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectedByYou(channelId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => connectedByYou.get(channelId) ?? NO_IDS, () => NO_IDS);
}

export function resetConnectedByYouForTests(): void {
  connectedByYou.clear();
}
