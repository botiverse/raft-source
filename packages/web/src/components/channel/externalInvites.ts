import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import api from "../../api/client";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import type { MessageId } from "../../i18n/messages";
import { apiErrorCode, apiErrorStatus } from "../externalInvite/externalInviteAccept";
import type { ConnectableServer, ServerConnectOutcome } from "../externalInvite/externalInviteAccept";
import type { Channel } from "../../store/channelStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useServerStore } from "../../store/serverStore";

/**
 * External channel invites, the host side (#wg-rbac:#16, P2b-1): a host
 * Server owner or admin invites people outside the Server to a channel by
 * email (POST /channels/:id/external-invites[/preview]) and manages the open
 * invites (GET, resend, DELETE). Every route answers 404 while
 * external_channels_v1 is off for the host Server, so the web reads the same
 * flag before it shows any of it.
 */

/** The server's EXTERNAL_INVITE_MAX_ENTRIES: raw entries per send, duplicates included. */
export const EXTERNAL_INVITE_MAX_EMAILS = 20;

/** What the server makes of the entries before anything is sent. */
export interface ExternalInvitePreview {
  /** Normalized addresses that will be invited. */
  valid: string[];
  /** A second (or later) copy of an address already in the list. */
  duplicates: string[];
  /** Entries that are not an email address, as typed. */
  invalid: string[];
  /** Addresses this channel already has an open invite for. */
  alreadyPending: string[];
  /** Members of the host Server not in the channel yet: the send adds them to it. */
  alreadyMembers: string[];
  /** People already in the channel. Absent from an older server. */
  alreadyInChannel?: string[];
  /**
   * Guests of another channel of the host Server, who can't be invited; the
   * channel is named only when the viewer can see it. Absent from an older server.
   */
  guestsElsewhere?: Array<{ email: string; channelName: string | null }>;
  /**
   * How many people the channel can still be invited, before these: its 30
   * slots less the host, its Guests and connected servers, and its open
   * invites. Absent from an older server.
   */
  slotsLeft?: number;
}

export interface SendExternalInvitesResult {
  sent: Array<{ id: string; email: string; expiresAt: string }>;
  /** The host Server's members the send added to the channel. Absent from an older server. */
  added?: string[];
  skipped: Omit<ExternalInvitePreview, "valid" | "slotsLeft">;
  /** "Your servers" chosen with it: where each stands (connected, connecting, or refused and why). */
  servers?: ServerConnectOutcome[];
  /** Connecting the servers failed as a whole (after the invites were sent): each is refused, and the dialog says so. */
  serversFailed?: boolean;
}

/** The review of a choice with no emails, only servers: nothing to classify. */
export const NO_EMAILS_PREVIEW: ExternalInvitePreview = {
  valid: [], duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: [],
};

/** One open invite (pending, awaiting approval or connecting) in the channel's Invited group. */
export interface ChannelExternalInvite {
  id: string;
  email: string;
  /** The invitee asked an owner or admin of one of their servers to connect it. */
  awaitingApproval: boolean;
  /** A server is being connected with it; revoking is refused (409 `connecting`) until the conversion ends. */
  connecting: boolean;
  /** While connecting: `conversion` (the channel is being converted) or `connection`. */
  connectPhase?: "conversion" | "connection" | null;
  /** False while the conversion it started can't be interrupted (revoke answers 409 `connecting`). Absent from older servers: treated as revocable. */
  revocable?: boolean;
  invitedBy: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
}

/**
 * Splits pasted text into one entry per address: commas, semicolons, spaces
 * and new lines all separate. Entries are kept as typed (the server
 * normalizes them and reports duplicates and malformed ones in the preview),
 * so the count matches what the server counts against the 20.
 */
export function parseEmailEntries(text: string): string[] {
  return text.split(/[\s,;]+/).filter((entry) => entry.length > 0);
}

/** The channel fields the external-invite gates read. */
type InvitableChannelFields = Pick<Channel, "type" | "name" | "archivedAt" | "serverId" | "jointRole">;

/**
 * A live channel of the current Server that people outside it can be invited
 * to: an ordinary one (not #all, DMs or threads), or a joint channel this
 * Server hosts (`jointRole` host; another server's projection is the host's
 * to share).
 */
export function isExternallyInvitableChannel(
  channel: InvitableChannelFields | null | undefined,
  currentServerId: string | null | undefined,
): boolean {
  if (!channel || !currentServerId) return false;
  if (channel.type === "joint") {
    if (channel.jointRole !== "host") return false;
  } else if (channel.type !== "channel" && channel.type !== "private") {
    return false;
  } else if (channel.name === "all") {
    return false;
  }
  if (channel.archivedAt) return false;
  return !channel.serverId || channel.serverId === currentServerId;
}

/**
 * Whether the viewer may invite people outside the Server to this channel and
 * manage its invites: external_channels_v1 is on for the host Server (the
 * current one), the viewer is its owner or admin (channel admins are not),
 * and the channel is an invitable one. The server checks the same.
 */
export function useExternalInviteAccess(
  channel: InvitableChannelFields | null | undefined,
): boolean {
  const enabled = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const { isAdminOrOwner } = useServerPermissions();
  const currentServerId = useServerStore((s) => s.current?.id ?? null);
  return enabled && isAdminOrOwner && isExternallyInvitableChannel(channel, currentServerId);
}

/**
 * Whether Create Channel offers External (design v5.0 E1): the same gate as
 * inviting to an existing channel (useExternalInviteAccess), for the channel
 * about to be created in the current Server.
 */
export function useExternalChannelCreateAccess(): boolean {
  const enabled = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const { isAdminOrOwner } = useServerPermissions();
  const currentServerId = useServerStore((s) => s.current?.id ?? null);
  return enabled && isAdminOrOwner && currentServerId !== null;
}

/**
 * Whether Create Channel may offer a new External channel on the current
 * Server (GET /channels/external-availability): `freeLimit` when the free
 * plan's one external channel is taken (one of its channels is external or
 * has an open invite, and it is on the Free plan), `loading` until the
 * answer is in, so External is never offered and then taken back. A failed
 * read is `open`: the send refuses with the same rule anyway. Asked only
 * while `enabled` (the viewer has useExternalChannelCreateAccess).
 */
export type ExternalChannelAvailability = "loading" | "open" | "freeLimit";

/** The current Server's answer: whether the free plan's one external channel is taken. */
export async function readExternalChannelFreeLimit(): Promise<boolean> {
  const { data } = await api.get<{ freeLimitReached?: boolean }>("/channels/external-availability");
  return data?.freeLimitReached === true;
}

export function useExternalChannelAvailability(enabled: boolean): ExternalChannelAvailability {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const [answer, setAnswer] = useState<{ serverId: string; reached: boolean } | null>(null);
  useEffect(() => {
    if (!enabled || !serverId) return;
    let cancelled = false;
    readExternalChannelFreeLimit()
      .then((reached) => {
        if (!cancelled) setAnswer({ serverId, reached });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ serverId, reached: false });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, serverId]);
  if (!enabled || answer === null || answer.serverId !== serverId) return enabled ? "loading" : "open";
  return answer.reached ? "freeLimit" : "open";
}

/**
 * Whether the viewer may see and withdraw the channel's open invites: a host
 * owner or admin of an invitable channel, with external_channels_v1 on, or,
 * with it off, while the channel is still external (`hasExternalRelation`),
 * so turning the flag off never strands an invite (plan §2a; the server lists
 * and revokes without the flag). Inviting and resending need the flag
 * (useExternalInviteAccess).
 */
export function useExternalInviteManagement(
  channel: (InvitableChannelFields & Pick<Channel, "hasExternalRelation">) | null | undefined,
): boolean {
  const enabled = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY).enabled;
  const { isAdminOrOwner } = useServerPermissions();
  const currentServerId = useServerStore((s) => s.current?.id ?? null);
  return (enabled || channel?.hasExternalRelation === true)
    && isAdminOrOwner
    && isExternallyInvitableChannel(channel, currentServerId);
}

/**
 * A private channel that has to stay private (the server refuses Make Public
 * with external_members_keep_private): the row's `hasExternalRelation` when
 * the server sent it, else what the viewer can see, a local Guest in the
 * roster or an open invite in the list.
 */
export function channelKeepsPrivateForExternal(
  channel: Pick<Channel, "type" | "serverId" | "hasExternalRelation"> | null | undefined,
  invites: readonly unknown[],
  humans: ReadonlyArray<{ role: string | null; serverId?: string }>,
): boolean {
  if (channel?.type !== "private") return false;
  if (channel.hasExternalRelation !== undefined) return channel.hasExternalRelation;
  return invites.length > 0 || humans.some((human) => human.role === "guest"
    && (!human.serverId || !channel.serverId || human.serverId === channel.serverId));
}

export async function previewExternalInvites(channelId: string, emails: string[]): Promise<ExternalInvitePreview> {
  const { data } = await api.post<ExternalInvitePreview>(`/channels/${channelId}/external-invites/preview`, { emails });
  return data;
}

/** The review before Create Channel makes an External channel: the same preview, for the current Server, with no channel yet. */
export async function previewExternalInvitesForNewChannel(emails: string[]): Promise<ExternalInvitePreview> {
  const { data } = await api.post<ExternalInvitePreview>("/channels/external-invites/preview", { emails });
  return data;
}

export async function sendExternalInvites(
  channelId: string,
  emails: string[],
  makePrivate: boolean,
): Promise<SendExternalInvitesResult> {
  const { data } = await api.post<SendExternalInvitesResult>(
    `/channels/${channelId}/external-invites`,
    makePrivate ? { emails, makePrivate: true } : { emails },
  );
  void loadChannelExternalInvites(channelId);
  return data;
}

/**
 * "Your servers" (GET /channels/external-connect-servers): the current
 * Server's owner/admin's other servers they own or administer that could
 * connect to one of its channels, read once per mount while `enabled`. Empty
 * until the answer is in, and when the read fails (the section isn't shown).
 */
export function useOwnConnectableServers(enabled: boolean): ConnectableServer[] {
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const [answer, setAnswer] = useState<{ serverId: string; servers: ConnectableServer[] } | null>(null);
  useEffect(() => {
    if (!enabled || !serverId) return;
    let cancelled = false;
    api.get<{ servers?: ConnectableServer[] }>("/channels/external-connect-servers")
      .then(({ data }) => {
        if (!cancelled) setAnswer({ serverId, servers: data?.servers ?? [] });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ serverId, servers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, serverId]);
  return enabled && answer?.serverId === serverId ? answer.servers : NO_OWN_SERVERS;
}

const NO_OWN_SERVERS: ConnectableServer[] = [];

/** Connect servers the viewer owns or administers to the channel now (no email, no approval): each one's outcome. */
export async function connectOwnServers(channelId: string, serverIds: string[], makePrivate: boolean): Promise<ServerConnectOutcome[]> {
  const { data } = await api.post<{ servers: ServerConnectOutcome[] }>(
    `/channels/${channelId}/external-connect-servers`,
    makePrivate ? { serverIds, makePrivate: true } : { serverIds },
  );
  void loadChannelExternalInvites(channelId);
  return data.servers;
}

/**
 * The review's confirm: the invites first (a channel being converted for a
 * server takes no send), then the servers. Either may be empty. A failed
 * connect never hides the send that went through: it answers each server
 * refused (`serversFailed`).
 */
export async function sendInvitesAndConnectServers(
  channelId: string,
  addresses: string[],
  serverIds: string[],
  makePrivate: boolean,
): Promise<SendExternalInvitesResult> {
  const sent: SendExternalInvitesResult = addresses.length > 0
    ? await sendExternalInvites(channelId, addresses, makePrivate)
    : { sent: [], skipped: { duplicates: [], invalid: [], alreadyPending: [], alreadyMembers: [] } };
  if (serverIds.length === 0) return sent;
  try {
    return { ...sent, servers: await connectOwnServers(channelId, serverIds, makePrivate) };
  } catch (err) {
    // The invites went out: they stay sent. Each server is refused with the
    // answer's code when it had one (else the generic reason), and the
    // dialog says the servers weren't connected.
    const code = apiErrorCode(err);
    return {
      ...sent,
      serversFailed: true,
      servers: serverIds.map((serverId) => ({
        serverId, state: "refused" as const, status: apiErrorStatus(err) ?? 0, error: "", ...(code ? { code } : {}),
      })),
    };
  }
}

// ── The channel's open invites, shared by every surface that shows them ──

/** `slotsLeft`: how many more people the channel can be invited (as the preview counts them); absent from an older server. */
type InvitesEntry = { invites: ChannelExternalInvite[]; slotsLeft?: number; loaded: boolean; failed: boolean };
const EMPTY_ENTRY: InvitesEntry = Object.freeze({ invites: [], loaded: false, failed: false }) as InvitesEntry;
const entries = new Map<string, InvitesEntry>();
const generations = new Map<string, number>();
const listeners = new Set<() => void>();

function publish(channelId: string, entry: InvitesEntry): void {
  entries.set(channelId, entry);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reads the channel's open invites again; an older answer that lands after a newer request is dropped. */
export async function loadChannelExternalInvites(channelId: string): Promise<void> {
  const generation = (generations.get(channelId) ?? 0) + 1;
  generations.set(channelId, generation);
  try {
    const { data } = await api.get<{ invites: ChannelExternalInvite[]; slotsLeft?: number }>(`/channels/${channelId}/external-invites`);
    if (generations.get(channelId) !== generation) return;
    publish(channelId, { invites: data.invites ?? [], slotsLeft: data.slotsLeft, loaded: true, failed: false });
  } catch {
    if (generations.get(channelId) !== generation) return;
    const previous = entries.get(channelId) ?? EMPTY_ENTRY;
    publish(channelId, { ...previous, failed: true });
  }
}

export async function resendExternalInvite(channelId: string, inviteId: string): Promise<void> {
  await api.post(`/channels/${channelId}/external-invites/${inviteId}/resend`);
  await loadChannelExternalInvites(channelId);
}

export async function revokeExternalInvite(channelId: string, inviteId: string): Promise<void> {
  await api.delete(`/channels/${channelId}/external-invites/${inviteId}`);
  const previous = entries.get(channelId);
  if (previous) publish(channelId, { ...previous, invites: previous.invites.filter((invite) => invite.id !== inviteId) });
  await loadChannelExternalInvites(channelId);
}

export function resetChannelExternalInvitesForTests(): void {
  entries.clear();
  generations.clear();
  for (const listener of listeners) listener();
}

/**
 * The channel's open invites, read once per mount while `enabled` (the
 * viewer has useExternalInviteAccess). Disabled, it reads as no invites and
 * sends nothing.
 */
export function useChannelExternalInvites(channelId: string, enabled: boolean): InvitesEntry & { reload: () => void } {
  const getSnapshot = useCallback(() => entries.get(channelId) ?? EMPTY_ENTRY, [channelId]);
  // Read on subscribe, as useServerFeatureFlag prefetches: once per mount,
  // and again when the channel or the access changes.
  const subscribeAndLoad = useCallback((listener: () => void) => {
    const unsubscribe = subscribe(listener);
    if (enabled) void loadChannelExternalInvites(channelId);
    return unsubscribe;
  }, [channelId, enabled]);
  const entry = useSyncExternalStore(subscribeAndLoad, getSnapshot, getSnapshot);
  const reload = useCallback(() => {
    void loadChannelExternalInvites(channelId);
  }, [channelId]);
  return { ...(enabled ? entry : EMPTY_ENTRY), reload };
}

/** Whole days left before an invite expires, at least 1 while it is still open. */
export function externalInviteDaysLeft(expiresAt: string, nowMs: number): number {
  const msLeft = Date.parse(expiresAt) - nowMs;
  return Math.max(1, Math.ceil(msLeft / (24 * 60 * 60 * 1000)));
}

type ApiError = { response?: { status?: number; data?: { code?: unknown } } };

/** The server's error code, if the request failed with one. */
export function externalInviteErrorCode(err: unknown): string | null {
  const code = (err as ApiError | null)?.response?.data?.code;
  return typeof code === "string" ? code : null;
}

/** The refusal codes the dialog has a sentence for; product events name the same ones (EXTERNAL_INVITE_SEND_ERROR_CODES). */
export const ERROR_MESSAGE_IDS: Record<string, MessageId> = {
  daily_cap: "channel.externalInvite.error.dailyCap",
  free_external_limit: "channel.externalInvite.error.freeLimit",
  channel_full: "channel.externalInvite.error.channelFull",
  external_members_keep_private: "channel.externalInvite.error.keepPrivate",
  channel_membership_required: "channel.externalInvite.error.membershipRequired",
  make_private_required: "channel.externalInvite.error.makePrivateRequired",
  channel_archived: "channel.externalInvite.error.archived",
  channel_not_invitable: "channel.externalInvite.error.notInvitable",
  forbidden: "channel.externalInvite.error.forbidden",
  connecting: "channel.externalInvite.error.connecting",
  invite_not_pending: "channel.externalInvite.error.notPending",
  invalid_input: "channel.externalInvite.error.invalidInput",
  not_found: "channel.externalInvite.error.notFound",
};

/** The friendly message for a failed external-invite request: by the server's code, else by status. */
export function externalInviteErrorMessageId(err: unknown): MessageId {
  const code = externalInviteErrorCode(err);
  if (code && ERROR_MESSAGE_IDS[code]) return ERROR_MESSAGE_IDS[code];
  const status = (err as ApiError | null)?.response?.status;
  if (status === 429) return "channel.externalInvite.error.dailyCap";
  if (status === 404) return "channel.externalInvite.error.notFound";
  if (status === 403) return "channel.externalInvite.error.forbidden";
  return "channel.externalInvite.error.generic";
}
