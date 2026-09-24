import { create } from "zustand";
import api from "../api/client";
import { registerServerReset } from "./serverResetRegistry";

export type ThreadAgentFollower = {
  id: string;
  name: string;
  displayName: string | null;
  status: string;
  avatarUrl: string | null;
  serverId?: string;
  serverName?: string;
  serverSlug?: string;
  isCurrentServer?: boolean;
  canRemove?: boolean;
};

export type ThreadAgentFollowerRoster = {
  agents: ThreadAgentFollower[];
  canManage: boolean;
  loading: boolean;
  loaded: boolean;
  error: boolean;
};

type ThreadAgentFollowerState = {
  rosters: Record<string, ThreadAgentFollowerRoster>;
  load: (threadChannelIds: string[], force?: boolean) => Promise<void>;
  remove: (threadChannelId: string, agentId: string) => Promise<string | null>;
  restore: (threadChannelId: string, agentId: string, undoToken: string) => Promise<boolean>;
  reset: () => void;
};

const EMPTY_ROSTER: ThreadAgentFollowerRoster = {
  agents: [], canManage: false, loading: false, loaded: false, error: false,
};

export const useThreadAgentFollowerStore = create<ThreadAgentFollowerState>((set, get) => ({
  rosters: {},
  load: async (threadChannelIds, force = false) => {
    const ids = [...new Set(threadChannelIds)].filter((id) => {
      const roster = get().rosters[id];
      return force || !roster?.loaded && !roster?.loading;
    });
    if (ids.length === 0) return;
    set((state) => ({
      rosters: Object.fromEntries(Object.entries(state.rosters).concat(ids.map((id) => [id, {
        ...(state.rosters[id] ?? EMPTY_ROSTER), loading: true, error: false,
      }]))),
    }));
    try {
      const { data } = await api.get("/channels/threads/followers", {
        params: { threadChannelIds: ids.join(",") },
      });
      const rows = new Map<string, { agents: ThreadAgentFollower[]; canManage: boolean }>(
        (data.threads as Array<{ threadChannelId: string; agents: ThreadAgentFollower[]; canManage: boolean }>)
          .map((row) => [row.threadChannelId, row]),
      );
      set((state) => ({
        rosters: Object.fromEntries(Object.entries(state.rosters).concat(ids.map((id) => {
          const row = rows.get(id);
          return [id, {
            agents: row?.agents ?? [], canManage: row?.canManage ?? false,
            loading: false, loaded: true, error: false,
          }];
        }))),
      }));
    } catch {
      set((state) => ({
        rosters: Object.fromEntries(Object.entries(state.rosters).concat(ids.map((id) => [id, {
          ...(state.rosters[id] ?? EMPTY_ROSTER), loading: false, loaded: false, error: true,
        }]))),
      }));
    }
  },
  remove: async (threadChannelId, agentId) => {
    const { data } = await api.delete(`/channels/threads/${threadChannelId}/followers/agents/${agentId}`);
    if (!data.removed || typeof data.undoToken !== "string") return null;
    set((state) => ({
      rosters: {
        ...state.rosters,
        [threadChannelId]: {
          ...(state.rosters[threadChannelId] ?? EMPTY_ROSTER),
          agents: (state.rosters[threadChannelId]?.agents ?? []).filter((agent) => agent.id !== agentId),
        },
      },
    }));
    return data.undoToken;
  },
  restore: async (threadChannelId, agentId, undoToken) => {
    const { data } = await api.post(
      `/channels/threads/${threadChannelId}/followers/agents/${agentId}/restore`,
      { undoToken },
    );
    if (!data.restored) return false;
    await get().load([threadChannelId], true);
    return true;
  },
  reset: () => set({ rosters: {} }),
}));

let queuedIds = new Map<string, boolean>();
let queued = false;

/** Coalesce every roster mounted in one render into one bulk request. */
export function requestThreadAgentFollowers(threadChannelId: string, force = false): void {
  queuedIds.set(threadChannelId, (queuedIds.get(threadChannelId) ?? false) || force);
  if (queued) return;
  queued = true;
  queueMicrotask(() => {
    const entries = [...queuedIds];
    queuedIds = new Map();
    queued = false;
    const cachedIds = entries.filter(([, shouldForce]) => !shouldForce).map(([id]) => id);
    const forcedIds = entries.filter(([, shouldForce]) => shouldForce).map(([id]) => id);
    if (cachedIds.length > 0) void useThreadAgentFollowerStore.getState().load(cachedIds);
    if (forcedIds.length > 0) void useThreadAgentFollowerStore.getState().load(forcedIds, true);
  });
}

registerServerReset(() => {
  queuedIds.clear();
  queued = false;
  useThreadAgentFollowerStore.getState().reset();
});
