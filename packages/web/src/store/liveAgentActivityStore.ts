import { create } from "zustand";
import type { Agent } from "./agentStore";
import {
  applyStatusActivityEvent,
  pruneExpiredLiveAgentActivityItems,
} from "../utils/liveAgentActivity";
import type {
  LiveAgentActivityItem,
} from "../utils/liveAgentActivity";

export interface LiveAgentActivityEvent {
  agentId: string;
  activity: string;
  activityKind?: string;
  detail?: string;
  detailKind?: string;
  timestamp?: number;
  isHeartbeat?: boolean;
  isRefreshOnly?: boolean;
}

interface LiveAgentActivityState {
  items: LiveAgentActivityItem[];
  recordStatusActivity: (event: LiveAgentActivityEvent, agents: Agent[]) => void;
  clear: () => void;
  pruneExpired: () => void;
}

export const useLiveAgentActivityStore = create<LiveAgentActivityState>((set) => ({
  items: [],
  recordStatusActivity: (event, agents) => {
    set((state) => ({
      items: applyStatusActivityEvent(state.items, event, agents),
    }));
  },
  clear: () => set({ items: [] }),
  pruneExpired: () => {
    set((state) => ({
      items: pruneExpiredLiveAgentActivityItems(state.items),
    }));
  },
}));
