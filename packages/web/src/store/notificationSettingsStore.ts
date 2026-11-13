// The unified notification settings on the client (docs/contracts/notifications.md §2):
// the account settings (pause, quiet hours, preview, sound), every server's
// level, and each loaded server's explicit channel / thread levels. Written
// only through the notification API; realtime `notification_prefs:updated`
// frames (type account / server / channel / thread) are folded in with stale
// versions dropped.

import { create } from "zustand";
import { isNotificationLevel, isNotificationLevelSetting } from "@botiverse/raft-shared";
import type {
  NotificationAccountSettings,
  NotificationLevel,
  NotificationLevelScope,
  NotificationLevelSetting,
} from "@botiverse/raft-shared";
import {
  fetchAccountNotificationSettings,
  fetchServerExplicitLevels,
  parseNotificationAccountSettings,
  patchAccountNotificationSettings,
  putNotificationLevel,
} from "../notifications/notificationApi";
import type { AccountNotificationSettingsPatch, PatchAccountSettingsResult } from "../notifications/notificationApi";
import { useServerStore } from "./serverStore";
import { isAccountDeletionPending } from "./accountDeletionPending";

export interface ServerExplicitLevelState {
  channels: Record<string, NotificationLevel>;
  threads: Record<string, NotificationLevel>;
  loaded: boolean;
}

interface NotificationSettingsState {
  account: NotificationAccountSettings | null;
  accountLoaded: boolean;
  /** Server levels (server_members.server_push_mode). */
  serverLevels: Record<string, NotificationLevel>;
  /** Explicit (non-default) channel / thread levels per server. */
  explicit: Record<string, ServerExplicitLevelState>;
  /**
   * Last version applied per key: `server:<id>` / `channel:<id>` / `thread:<id>`
   * (prefsVersion of the level frames). The account uses `account` (its
   * settings.version). The untyped Activity-mute frame has its own sequence
   * and is deduped apart, as `mute:<channelId>` (notificationPrefsSyncDomain),
   * so a mute version never drops a level update or the reverse.
   */
  scopeVersions: Record<string, number>;

  loadAccount(): Promise<void>;
  loadServerLevels(serverId: string): Promise<void>;
  patchAccount(patch: AccountNotificationSettingsPatch): Promise<PatchAccountSettingsResult>;
  setLevel(input: { scope: NotificationLevelScope; id: string; serverId: string; level: NotificationLevelSetting }): Promise<boolean>;
  /** A `notification_prefs:updated` frame with a `type` of account / server / channel / thread. True when applied. */
  applyPrefsUpdate(payload: unknown): boolean;
  /**
   * A legacy server frame (boolean serverPushMuted only, from an older server
   * or route): muted = none; unmuted moves a held `none` back to `all` and
   * keeps `mentions`.
   */
  noteLegacyServerMuted(serverId: string, muted: boolean): void;
  /** A level another write path just set (thread Follow / Unfollow); the server's frame confirms it. */
  noteLocalLevel(serverId: string, scope: "channel" | "thread", id: string, level: NotificationLevelSetting): void;
  /**
   * `notificationLevel` read off channel / thread payloads (lists, details).
   * Unversioned, so a scope a realtime frame already set is left alone.
   */
  seedLevelsFromPayloads(serverId: string, scope: "channel" | "thread", rows: Iterable<{ id: string; notificationLevel?: unknown }>): void;
  reset(): void;
}

const EMPTY_EXPLICIT: ServerExplicitLevelState = { channels: {}, threads: {}, loaded: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scopeKey(scope: NotificationLevelScope, id: string): string {
  return `${scope}:${id}`;
}

function withExplicit(
  explicit: Record<string, ServerExplicitLevelState>,
  serverId: string,
  scope: "channel" | "thread",
  id: string,
  level: NotificationLevelSetting,
): Record<string, ServerExplicitLevelState> {
  const current = explicit[serverId] ?? EMPTY_EXPLICIT;
  const key = scope === "channel" ? "channels" : "threads";
  const map = { ...current[key] };
  if (level === "default") delete map[id];
  else map[id] = level;
  return { ...explicit, [serverId]: { ...current, [key]: map } };
}

function readVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Keeps useServerStore's legacy boolean in step for surfaces that still read it. */
function mirrorServerPushMuted(serverId: string, level: NotificationLevel) {
  const server = useServerStore.getState();
  const known = server.servers.some((s) => s.id === serverId) || server.current?.id === serverId;
  if (known) server.applyServerPatch({ id: serverId, serverPushMuted: level === "none" });
}

let accountRequest = 0;

/** In-flight level writes per scope key: the latest request and the server's last confirmed value. */
const levelRequests = new Map<string, { latest: number; confirmed: NotificationLevelSetting }>();

function readLevel(
  state: Pick<NotificationSettingsState, "serverLevels" | "explicit">,
  scope: NotificationLevelScope,
  serverId: string,
  id: string,
): NotificationLevelSetting {
  if (scope === "server") return state.serverLevels[id] ?? serverNotificationLevel(id, state.serverLevels);
  const server = state.explicit[serverId];
  return (scope === "channel" ? server?.channels[id] : server?.threads[id]) ?? "default";
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  account: null,
  accountLoaded: false,
  serverLevels: {},
  explicit: {},
  scopeVersions: {},

  async loadAccount() {
    // A scheduled account deletion refuses it (403); the pending page stands in.
    if (isAccountDeletionPending()) return;
    const at = ++accountRequest;
    const result = await fetchAccountNotificationSettings().catch(() => null);
    if (at !== accountRequest) return;
    if (!result) {
      set({ accountLoaded: true });
      return;
    }
    const held = get().account;
    const levels: Record<string, NotificationLevel> = { ...get().serverLevels };
    for (const row of result.servers) levels[row.serverId] = row.level;
    set({
      account: held && held.version > result.settings.version ? held : result.settings,
      accountLoaded: true,
      serverLevels: levels,
    });
  },

  async loadServerLevels(serverId) {
    const result = await fetchServerExplicitLevels(serverId).catch(() => null);
    if (!result) return;
    set((state) => ({
      serverLevels: { ...state.serverLevels, [serverId]: result.server },
      explicit: { ...state.explicit, [serverId]: { channels: result.channels, threads: result.threads, loaded: true } },
    }));
  },

  async patchAccount(patch) {
    const held = get().account;
    const body = held && patch.version === undefined ? { ...patch, version: held.version } : patch;
    const result = await patchAccountNotificationSettings(body);
    if (result.kind === "ok" || (result.kind === "conflict" && result.settings)) {
      const settings = result.settings!;
      const current = get().account;
      if (!current || settings.version >= current.version) set({ account: settings, accountLoaded: true });
    }
    return result;
  },

  async setLevel({ scope, id, serverId, level }) {
    if (scope === "server" && !isNotificationLevel(level)) return false;
    const key = scopeKey(scope, id);
    const request = (levelRequests.get(key)?.latest ?? 0) + 1;
    const pending = levelRequests.get(key);
    // What the server is known to hold: kept across overlapping requests, so
    // a failure restores the last confirmed value, not an optimistic one.
    const confirmed = pending ? pending.confirmed : readLevel(get(), scope, serverId, id);
    levelRequests.set(key, { latest: request, confirmed });
    const versionAtStart = get().scopeVersions[key];
    const write = (value: NotificationLevelSetting, version: number | null) => set((state) => {
      const versions = version === null ? state.scopeVersions : { ...state.scopeVersions, [key]: version };
      if (scope === "server") {
        return { serverLevels: { ...state.serverLevels, [id]: value as NotificationLevel }, scopeVersions: versions };
      }
      return { explicit: withExplicit(state.explicit, serverId, scope, id, value), scopeVersions: versions };
    });
    // Optimistic: the menus show the new value at once.
    write(level, null);
    const isLatest = () => levelRequests.get(key)?.latest === request;
    const settle = () => { if (isLatest()) levelRequests.delete(key); };
    try {
      const result = await putNotificationLevel({ scope, id, level, serverId });
      const held = get().scopeVersions[key];
      const stale = result.prefsVersion !== null && held !== undefined && result.prefsVersion <= held;
      const entry = levelRequests.get(key);
      if (!stale && entry) entry.confirmed = result.level;
      // An older request than the latest, or a realtime frame newer than this
      // response: neither may overwrite what is shown.
      if (isLatest() && !stale) {
        write(result.level, result.prefsVersion);
        if (scope === "server" && isNotificationLevel(result.level)) mirrorServerPushMuted(id, result.level);
      }
      settle();
      return true;
    } catch {
      const entry = levelRequests.get(key);
      // Only the latest request rolls back, and not over a realtime frame that
      // arrived meanwhile (it is the server's word).
      if (isLatest() && get().scopeVersions[key] === versionAtStart && entry) write(entry.confirmed, null);
      settle();
      return false;
    }
  },

  applyPrefsUpdate(payload) {
    if (!isRecord(payload)) return false;
    const type = payload.type;
    if (type === "account") {
      const settings = parseNotificationAccountSettings(payload.settings);
      if (!settings) return false;
      const held = Math.max(get().account?.version ?? -1, get().scopeVersions.account ?? -1);
      if (settings.version <= held) return false;
      set((state) => ({ account: settings, accountLoaded: true, scopeVersions: { ...state.scopeVersions, account: settings.version } }));
      return true;
    }
    if (type !== "server" && type !== "channel" && type !== "thread") return false;
    const serverId = payload.serverId;
    const scopeId = payload.scopeId;
    if (typeof serverId !== "string" || typeof scopeId !== "string") return false;
    const level = payload.level;
    if (type === "server" ? !isNotificationLevel(level) : !isNotificationLevelSetting(level)) return false;
    const version = readVersion(payload.prefsVersion);
    const key = scopeKey(type, scopeId);
    const held = get().scopeVersions[key];
    if (version !== null && held !== undefined && version <= held) return false;
    set((state) => {
      const versions = version === null ? state.scopeVersions : { ...state.scopeVersions, [key]: version };
      if (type === "server") {
        return { serverLevels: { ...state.serverLevels, [scopeId]: level as NotificationLevel }, scopeVersions: versions };
      }
      return { explicit: withExplicit(state.explicit, serverId, type, scopeId, level as NotificationLevelSetting), scopeVersions: versions };
    });
    const inFlight = levelRequests.get(key);
    if (inFlight) inFlight.confirmed = level as NotificationLevelSetting;
    if (type === "server") mirrorServerPushMuted(scopeId, level as NotificationLevel);
    return true;
  },

  noteLegacyServerMuted(serverId, muted) {
    const held = get().serverLevels[serverId];
    const next: NotificationLevel | undefined = muted ? "none" : held === "none" ? "all" : held;
    if (!next || next === held) return;
    set((state) => ({ serverLevels: { ...state.serverLevels, [serverId]: next } }));
  },

  noteLocalLevel(serverId, scope, id, level) {
    set((state) => ({ explicit: withExplicit(state.explicit, serverId, scope, id, level) }));
  },

  seedLevelsFromPayloads(serverId, scope, rows) {
    const state = get();
    let explicit = state.explicit;
    let changed = false;
    for (const row of rows) {
      // null = no explicit level (default); undefined = an older server that sends none.
      const level = row.notificationLevel === null ? "default" : row.notificationLevel;
      if (!isNotificationLevelSetting(level)) continue;
      if (state.scopeVersions[scopeKey(scope, row.id)] !== undefined) continue;
      const current = scope === "channel" ? explicit[serverId]?.channels[row.id] : explicit[serverId]?.threads[row.id];
      if ((current ?? "default") === level) continue;
      explicit = withExplicit(explicit, serverId, scope, row.id, level);
      changed = true;
    }
    if (changed) set({ explicit });
  },

  reset() {
    accountRequest += 1;
    levelRequests.clear();
    set({ account: null, accountLoaded: false, serverLevels: {}, explicit: {}, scopeVersions: {} });
  },
}));

/**
 * A server's level: the loaded one, else the legacy boolean on the server row
 * (muted = none), else the default `all`.
 */
export function serverNotificationLevel(
  serverId: string,
  levels: Readonly<Record<string, NotificationLevel>> = useNotificationSettingsStore.getState().serverLevels,
): NotificationLevel {
  const loaded = levels[serverId];
  if (loaded) return loaded;
  const server = useServerStore.getState();
  const row = server.current?.id === serverId ? server.current : server.servers.find((s) => s.id === serverId);
  return row?.serverPushMuted ? "none" : "all";
}

export function useServerNotificationLevel(serverId: string | null | undefined): NotificationLevel {
  const loaded = useNotificationSettingsStore((s) => (serverId ? s.serverLevels[serverId] : undefined));
  const muted = useServerStore((s) => {
    if (!serverId) return false;
    const row = s.current?.id === serverId ? s.current : s.servers.find((server) => server.id === serverId);
    return row?.serverPushMuted === true;
  });
  if (loaded) return loaded;
  return muted ? "none" : "all";
}

/** The explicit level of a channel or thread (`default` when none is set). */
export function useExplicitNotificationLevel(
  serverId: string | null | undefined,
  scope: "channel" | "thread",
  id: string | null | undefined,
): NotificationLevelSetting {
  return useNotificationSettingsStore((s) => {
    if (!serverId || !id) return "default";
    const server = s.explicit[serverId];
    return (scope === "channel" ? server?.channels[id] : server?.threads[id]) ?? "default";
  });
}
