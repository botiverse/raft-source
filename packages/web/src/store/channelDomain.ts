import { channelTypeSupportsActivityMute } from "@botiverse/raft-shared";
import type { ApiChannel, Channel } from "./channelStore";

export interface ChannelDomainState {
  channels: Channel[];
  dmChannels: Channel[];
  channelActivity: Record<string, string | null>;
  channelLocalMembership?: Record<string, boolean>;
}

export interface ActivityMuteState {
  activityMuted: boolean;
  muteFromSeq: string | number | null;
  activityMuteSupported?: boolean;
  prefsVersion?: number;
}

export interface MessageDisplayPrefsState {
  collapseLongMessages: boolean;
  prefsVersion?: number;
}

export function normalizeMessageDisplayPrefs(data: unknown): MessageDisplayPrefsState {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const prefsVersion = typeof record.prefsVersion === "number"
    && Number.isSafeInteger(record.prefsVersion)
    && record.prefsVersion >= 0
    ? record.prefsVersion
    : undefined;
  return {
    // A missing/legacy payload means the default: long messages collapse.
    collapseLongMessages: record.collapseLongMessages !== false,
    ...(prefsVersion === undefined ? {} : { prefsVersion }),
  };
}

export function normalizeActivityMuteState(data: unknown): ActivityMuteState {
  const record = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const muteFromSeq = typeof record.muteFromSeq === "string" || typeof record.muteFromSeq === "number"
    ? record.muteFromSeq
    : null;
  const prefsVersion = typeof record.prefsVersion === "number"
    && Number.isSafeInteger(record.prefsVersion)
    && record.prefsVersion >= 0
    ? record.prefsVersion
    : undefined;
  return {
    activityMuted: record.activityMuted === true,
    muteFromSeq,
    activityMuteSupported: record.activityMuteSupported === true,
    ...(prefsVersion === undefined ? {} : { prefsVersion }),
  };
}

export function activityFrom(channels: ApiChannel[]): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  for (const c of channels) patch[c.id] = c.lastMessageAt ?? null;
  return patch;
}

export function toChannel(c: ApiChannel, defaultType: Channel["type"] = "channel"): Channel {
  // #632 C1: `readState` is wire-only. The adapter has already consumed it by
  // the time we get here, and it must NOT ride the spread into the domain
  // object — otherwise the store holds a second copy of the union the adapter
  // is supposed to be the only interpreter of.
  const { lastMessageAt: _drop, readState: _rawUnion, type, ...rest } = c;
  void _drop;
  void _rawUnion;
  return { ...rest, type: (type as Channel["type"]) || defaultType };
}

export function sortChannels(channels: Channel[]): Channel[] {
  const allCh = channels.filter((c) => c.name === "all");
  const rest = channels.filter((c) => c.name !== "all");
  return [...allCh, ...rest];
}

export function hydrateChannels(state: ChannelDomainState, apiChannels: ApiChannel[]): ChannelDomainState {
  const channelLocalMembership = reconcileLocalMembership(
    state.channelLocalMembership ?? {},
    apiChannels,
  );
  return {
    ...state,
    channels: sortChannels(apiChannels.map((c) => applyLocalMembership(toChannel(c), channelLocalMembership))),
    channelActivity: { ...state.channelActivity, ...activityFrom(apiChannels) },
    channelLocalMembership,
  };
}

export function hydrateDmChannels(state: ChannelDomainState, apiDms: ApiChannel[]): ChannelDomainState {
  const fetched = apiDms.map((c) => toChannel(c, "dm"));
  const fetchedIds = new Set(fetched.map((c) => c.id));
  const localOnly = state.dmChannels.filter((c) => !fetchedIds.has(c.id));
  return {
    ...state,
    dmChannels: [...fetched, ...localOnly],
    channelActivity: { ...state.channelActivity, ...activityFrom(apiDms) },
  };
}

export function patchChannel(
  state: ChannelDomainState,
  apiChannel: ApiChannel,
  defaultType: Channel["type"] = "channel",
): ChannelDomainState {
  const channel = toChannel(apiChannel, apiChannel.type === "dm" ? "dm" : defaultType);
  const channelWithMembership = applyLocalMembership(channel, state.channelLocalMembership ?? {});
  const nextActivity = apiChannel.lastMessageAt ?? state.channelActivity[channel.id] ?? null;
  if (channelWithMembership.type === "dm") {
    const exists = state.dmChannels.some((c) => c.id === channelWithMembership.id);
    return {
      ...state,
      dmChannels: exists
        ? state.dmChannels.map((c) => (c.id === channelWithMembership.id ? channelWithMembership : c))
        : [...state.dmChannels, channelWithMembership],
      channelActivity: { ...state.channelActivity, [channelWithMembership.id]: nextActivity },
    };
  }

  const hiddenAllChannel = channelWithMembership.name === "all" && channelWithMembership.type === "private";
  if (hiddenAllChannel) {
    const { [channelWithMembership.id]: _removed, ...channelActivity } = state.channelActivity;
    void _removed;
    return {
      ...state,
      channels: state.channels.filter((c) => c.id !== channelWithMembership.id),
      channelActivity,
    };
  }

  const exists = state.channels.some((c) => c.id === channelWithMembership.id);
  return {
    ...state,
    channels: sortChannels(
      exists
        ? state.channels.map((c) => (c.id === channelWithMembership.id ? { ...c, ...channelWithMembership } : c))
        : [...state.channels, channelWithMembership],
    ),
    channelActivity: { ...state.channelActivity, [channelWithMembership.id]: nextActivity },
  };
}

export function removeChannel(state: ChannelDomainState, channelId: string, opts?: { includeDm?: boolean }): ChannelDomainState {
  const { [channelId]: _removed, ...channelActivity } = state.channelActivity;
  void _removed;
  return {
    ...state,
    channels: state.channels.filter((c) => c.id !== channelId),
    dmChannels: opts?.includeDm === false ? state.dmChannels : state.dmChannels.filter((c) => c.id !== channelId),
    channelActivity,
  };
}

export function touchChannelActivity(
  state: ChannelDomainState,
  channelId: string,
  lastMessageAt: string | null,
): ChannelDomainState {
  return {
    ...state,
    channelActivity: { ...state.channelActivity, [channelId]: lastMessageAt },
  };
}

export function refreshExistingDm(
  state: ChannelDomainState,
  channelId: string,
  lastMessageAt: string,
): ChannelDomainState {
  const existing = state.dmChannels.find((c) => c.id === channelId);
  if (!existing) return state;
  return {
    ...state,
    dmChannels: [existing, ...state.dmChannels.filter((c) => c.id !== channelId)],
    channelActivity: { ...state.channelActivity, [channelId]: lastMessageAt },
  };
}

export function applyActivityMuteState(
  state: ChannelDomainState,
  channelId: string,
  muteState: ActivityMuteState,
): ChannelDomainState {
  const apply = (channel: Channel) => {
    if (channel.id !== channelId) return channel;
    if (isStaleActivityMutePatch(channel, muteState)) return channel;
    return {
      ...channel,
      activityMuted: muteState.activityMuted,
      muteFromSeq: muteState.muteFromSeq,
      activityMuteSupported: muteState.activityMuteSupported ?? channel.activityMuteSupported,
      ...(muteState.prefsVersion === undefined ? {} : { prefsVersion: muteState.prefsVersion }),
    };
  };
  return {
    ...state,
    channels: state.channels.map(apply),
    dmChannels: state.dmChannels.map(apply),
  };
}

export function matchesActivityMuteState(
  channel: Pick<Channel, "activityMuted" | "muteFromSeq" | "prefsVersion"> | undefined,
  muteState: ActivityMuteState,
) {
  return channel?.activityMuted === muteState.activityMuted
    && (channel.muteFromSeq ?? null) === muteState.muteFromSeq
    && channel.prefsVersion === muteState.prefsVersion;
}

export function applyMessageDisplayPrefsState(
  state: ChannelDomainState,
  channelId: string,
  prefs: MessageDisplayPrefsState,
): ChannelDomainState {
  const apply = (channel: Channel) => {
    if (channel.id !== channelId) return channel;
    if (isStaleMessageDisplayPrefsPatch(channel, prefs)) return channel;
    return {
      ...channel,
      collapseLongMessages: prefs.collapseLongMessages,
      ...(prefs.prefsVersion === undefined ? {} : { displayPrefsVersion: prefs.prefsVersion }),
    };
  };
  return {
    ...state,
    channels: state.channels.map(apply),
    dmChannels: state.dmChannels.map(apply),
  };
}

export function matchesMessageDisplayPrefsState(
  channel: Pick<Channel, "collapseLongMessages" | "displayPrefsVersion"> | undefined,
  prefs: MessageDisplayPrefsState,
) {
  return channel?.collapseLongMessages === prefs.collapseLongMessages
    && channel.displayPrefsVersion === prefs.prefsVersion;
}

export function canToggleActivityMute(
  channel: Pick<Channel, "type" | "joined"> | undefined,
) {
  // Channel-type eligibility is the shared contract (`@botiverse/raft-shared`); the
  // `joined` requirement is client-side only. Both halves must hold.
  return channelTypeSupportsActivityMute(channel?.type)
    && channel?.joined === true;
}

export function setLocalChannelMembership(
  state: ChannelDomainState,
  channelId: string,
  joined: boolean,
): ChannelDomainState {
  const channelLocalMembership = {
    ...state.channelLocalMembership,
    [channelId]: joined,
  };
  return {
    ...state,
    channels: state.channels.map((channel) =>
      channel.id === channelId ? { ...channel, joined } : channel,
    ),
    channelLocalMembership,
  };
}

function isStaleActivityMutePatch(channel: Channel, muteState: ActivityMuteState) {
  return channel.prefsVersion !== undefined
    && muteState.prefsVersion !== undefined
    && muteState.prefsVersion < channel.prefsVersion;
}

function isStaleMessageDisplayPrefsPatch(channel: Channel, prefs: MessageDisplayPrefsState) {
  return channel.displayPrefsVersion !== undefined
    && prefs.prefsVersion !== undefined
    && prefs.prefsVersion < channel.displayPrefsVersion;
}

function applyLocalMembership(
  channel: Channel,
  channelLocalMembership: Record<string, boolean>,
): Channel {
  if (channelLocalMembership[channel.id] === undefined) return channel;
  return { ...channel, joined: channelLocalMembership[channel.id] };
}

function reconcileLocalMembership(
  channelLocalMembership: Record<string, boolean>,
  apiChannels: ApiChannel[],
): Record<string, boolean> {
  let next = channelLocalMembership;
  for (const apiChannel of apiChannels) {
    const localJoined = next[apiChannel.id];
    if (localJoined === undefined || apiChannel.joined !== localJoined) continue;
    if (next === channelLocalMembership) next = { ...channelLocalMembership };
    delete next[apiChannel.id];
  }
  return next;
}
