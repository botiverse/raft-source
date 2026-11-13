import { channelTypeSupportsActivityMute } from "@botiverse/raft-shared";
import type { ApiChannel, Channel } from "./channelStore";

export interface ChannelDomainState {
  channels: Channel[];
  dmChannels: Channel[];
  /**
   * Agent Lounges (Agent Lounge v0). A Lounge is a public channel on the wire;
   * every reducer here keeps it out of `channels` so no channel list, ⌘K,
   * forward target or browse view can show it. Optional so a state without
   * it reads as having none.
   */
  loungeChannels?: Channel[];
  channelActivity: Record<string, string | null>;
  channelLocalMembership?: Record<string, boolean>;
  /**
   * Per row, the patch-clock value its local data was observed at (#239):
   * see `nextPatchSeq`. A GET /channels answer does not undo a row stamped
   * after that request started (see hydrateChannels). Absent: none.
   */
  channelPatchStamps?: Record<string, number>;
}

let patchClock = 0;

/**
 * The next value of the local patch clock (#239). It only counts up, across
 * servers. A read (GET /channels, a single-row GET) takes one when its request
 * starts; a write that is not a read answer (a mutation result, a socket row)
 * takes one when it applies. A row's stamp is the value its data was observed at.
 */
export function nextPatchSeq(): number {
  patchClock += 1;
  return patchClock;
}

/** The state with `channelId` stamped as observed at `seq` (default: now). */
function stampPatch<S extends ChannelDomainState>(state: S, channelId: string, seq = nextPatchSeq()): S {
  return { ...state, channelPatchStamps: { ...state.channelPatchStamps, [channelId]: seq } };
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
    // A missing/legacy payload means the default: long messages render in full.
    collapseLongMessages: record.collapseLongMessages === true,
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

/** An agent's Lounge (Agent Lounge v0): the server names its agent on the row. */
export function isLoungeChannel(channel: { loungeAgentId?: string | null } | null | undefined): boolean {
  return typeof channel?.loungeAgentId === "string" && channel.loungeAgentId.length > 0;
}

/** The Lounge slice with this row merged in (or added). */
function upsertLounge(loungeChannels: Channel[], channel: Channel): Channel[] {
  const exists = loungeChannels.some((c) => c.id === channel.id);
  return exists
    ? loungeChannels.map((c) => (c.id === channel.id ? { ...c, ...channel } : c))
    : [...loungeChannels, channel];
}

export function sortChannels(channels: Channel[]): Channel[] {
  const allCh = channels.filter((c) => c.name === "all");
  const rest = channels.filter((c) => c.name !== "all");
  return [...allCh, ...rest];
}

/** Plain JSON values (what the API returns) compared by content. */
function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((value, index) => sameJsonValue(value, other[index]));
  }
  const aKeys = Object.keys(a);
  const bRecord = b as Record<string, unknown>;
  if (aKeys.length !== Object.keys(bRecord).length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(bRecord, key)
    && sameJsonValue((a as Record<string, unknown>)[key], bRecord[key]));
}

/**
 * A fresh list keeps the previous record for every channel whose content is
 * unchanged, and the previous array when nothing changed: a heavy account
 * reads /channels and /channels/dm more than once at boot, and new records for
 * unchanged channels re-rendered every sidebar row (web perf; as
 * reconcileAgentsList does for agents).
 */
export function reconcileChannelList(prev: Channel[], next: Channel[]): Channel[] {
  const prevById = new Map(prev.map((channel) => [channel.id, channel]));
  const reconciled = next.map((incoming) => {
    const previous = prevById.get(incoming.id);
    return previous && sameJsonValue(previous, incoming) ? previous : incoming;
  });
  return reconciled.length === prev.length && reconciled.every((channel, index) => channel === prev[index])
    ? prev
    : reconciled;
}

/** The activity map with these entries, or the same map when none changes. */
function mergeChannelActivity(
  current: ChannelDomainState["channelActivity"],
  incoming: ChannelDomainState["channelActivity"],
): ChannelDomainState["channelActivity"] {
  for (const [id, value] of Object.entries(incoming)) {
    if (current[id] !== value) return { ...current, ...incoming };
  }
  return current;
}

/**
 * Applies a GET /channels answer. `requestSeq` is the patch clock its request
 * took when it started (#239): a row whose local data was observed after that
 * (a create or other mutation result, `channel:updated`, a single-row read
 * started later, a removal) is newer than the answer, so the local state wins
 * for it: the local row stays where the answer has it, one the answer lacks is
 * kept at the end, and a removed one stays removed. Every other row follows
 * the answer, so a channel the server no longer lists goes. (Joins and leaves
 * are not stamped: `channelLocalMembership` covers them.) Omitted: the answer
 * is newer than every local write (a plain hydrate).
 */
export function hydrateChannels(
  state: ChannelDomainState,
  apiChannels: ApiChannel[],
  requestSeq = Number.POSITIVE_INFINITY,
): ChannelDomainState {
  const stamps = state.channelPatchStamps ?? {};
  const isNewer = (id: string) => (stamps[id] ?? 0) > requestSeq;
  const newerIds = Object.keys(stamps).filter(isNewer);
  const answered = newerIds.length > 0 ? apiChannels.filter((c) => !isNewer(c.id)) : apiChannels;
  const channelLocalMembership = reconcileLocalMembership(
    state.channelLocalMembership ?? {},
    answered,
  );
  // GET /channels is not meant to list Lounges; one that does still never
  // reaches the channel list (it goes to the Lounge slice instead).
  const lounges = answered.filter(isLoungeChannel);
  const listed = apiChannels.filter((c) => !isLoungeChannel(c));
  let channels = listed
    .map((c) => (isNewer(c.id)
      ? state.channels.find((local) => local.id === c.id)
      : applyLocalMembership(toChannel(c), channelLocalMembership)))
    .filter((c): c is Channel => c !== undefined);
  if (newerIds.length > 0) {
    const listedIds = new Set(listed.map((c) => c.id));
    channels = [...channels, ...state.channels.filter((c) => isNewer(c.id) && !listedIds.has(c.id))];
  }
  return {
    ...state,
    channels: reconcileChannelList(state.channels, sortChannels(channels)),
    ...(lounges.length > 0
      ? {
        loungeChannels: lounges.reduce(
          (slice, c) => upsertLounge(slice, applyLocalMembership(toChannel(c), channelLocalMembership)),
          state.loungeChannels ?? [],
        ),
      }
      : {}),
    channelActivity: mergeChannelActivity(state.channelActivity, activityFrom(answered)),
    channelLocalMembership,
    // The answer settles every stamp up to its start; only newer ones stay.
    ...(Object.keys(stamps).length > newerIds.length
      ? { channelPatchStamps: Object.fromEntries(newerIds.map((id) => [id, stamps[id]])) }
      : {}),
  };
}

export function hydrateDmChannels(state: ChannelDomainState, apiDms: ApiChannel[]): ChannelDomainState {
  const fetched = apiDms.map((c) => toChannel(c, "dm"));
  const fetchedIds = new Set(fetched.map((c) => c.id));
  const localOnly = state.dmChannels.filter((c) => !fetchedIds.has(c.id));
  return {
    ...state,
    dmChannels: reconcileChannelList(state.dmChannels, [...fetched, ...localOnly]),
    channelActivity: mergeChannelActivity(state.channelActivity, activityFrom(apiDms)),
  };
}

export function patchChannel(
  state: ChannelDomainState,
  apiChannel: ApiChannel,
  defaultType: Channel["type"] = "channel",
  /** For a read answer: the patch clock its request took (`nextPatchSeq`). Default: now. */
  observedSeq?: number,
): ChannelDomainState {
  return patchRow(stampPatch(state, apiChannel.id, observedSeq), apiChannel, defaultType);
}

function patchRow(
  state: ChannelDomainState,
  apiChannel: ApiChannel,
  defaultType: Channel["type"],
): ChannelDomainState {
  const channel = toChannel(apiChannel, apiChannel.type === "dm" ? "dm" : defaultType);
  const channelWithMembership = applyLocalMembership(channel, state.channelLocalMembership ?? {});
  const nextActivity = apiChannel.lastMessageAt ?? state.channelActivity[channel.id] ?? null;
  // A Lounge, or a row already kept as one (a later patch may leave the
  // field off), goes to the Lounge slice and never into `channels`.
  if (channelWithMembership.type !== "dm" && (
    isLoungeChannel(channelWithMembership)
    || (state.loungeChannels ?? []).some((c) => c.id === channelWithMembership.id)
  )) {
    return {
      ...state,
      channels: state.channels.some((c) => c.id === channelWithMembership.id)
        ? state.channels.filter((c) => c.id !== channelWithMembership.id)
        : state.channels,
      loungeChannels: upsertLounge(state.loungeChannels ?? [], channelWithMembership),
      channelActivity: { ...state.channelActivity, [channelWithMembership.id]: nextActivity },
    };
  }
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

export function removeChannel(
  state: ChannelDomainState,
  channelId: string,
  opts?: { includeDm?: boolean; observedSeq?: number },
): ChannelDomainState {
  const { [channelId]: _removed, ...channelActivity } = state.channelActivity;
  void _removed;
  return {
    ...stampPatch(state, channelId, opts?.observedSeq),
    channels: state.channels.filter((c) => c.id !== channelId),
    dmChannels: opts?.includeDm === false ? state.dmChannels : state.dmChannels.filter((c) => c.id !== channelId),
    ...(state.loungeChannels ? { loungeChannels: state.loungeChannels.filter((c) => c.id !== channelId) } : {}),
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
    ...(state.loungeChannels ? { loungeChannels: state.loungeChannels.map(apply) } : {}),
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
    ...(state.loungeChannels ? { loungeChannels: state.loungeChannels.map(apply) } : {}),
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
  channel: Pick<Channel, "type" | "joined" | "activityMuted" | "activityMuteSupported"> | undefined,
) {
  // A DM: the server decides which DMs can be muted (a DM with an App bot) and
  // says so in `activityMuteSupported`; it is not recomputed here. A stored
  // mute keeps its Unmute even when the DM no longer qualifies (its bot was
  // removed), so a mute can always be undone.
  if (channel?.type === "dm") return channel.activityMuteSupported === true || channel.activityMuted === true;
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
    ...(state.loungeChannels
      ? {
        loungeChannels: state.loungeChannels.map((channel) =>
          channel.id === channelId ? { ...channel, joined } : channel,
        ),
      }
      : {}),
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
