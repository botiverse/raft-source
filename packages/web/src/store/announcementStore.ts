import { create } from "zustand";
import { ANNOUNCEMENT_SIDEBAR_STACK_MAX } from "@botiverse/raft-shared";
import type { Announcement } from "@botiverse/raft-shared";
import { resetAnnouncementShown } from "../analytics/announcements";
import api from "../api/client";
import { useServerStore } from "./serverStore";
import { registerServerReset } from "./serverResetRegistry";

interface AnnouncementState {
  /**
   * What this entry presents: one dialog, or up to ANNOUNCEMENT_SIDEBAR_STACK_MAX
   * sidebar cards in queue order (never both). The first row is on screen.
   */
  pending: Announcement[];
  /** How many sidebar cards this entry started with, for the "2 / 5" position. */
  stackTotal: number;
  loaded: boolean;
  /** One announcement per document entry, across presentation types and server switches. */
  completedThisEntry: boolean;
  /**
   * Ids already reported to the server as read-complete this session. `markRead`
   * is idempotent against this so repeated explicit confirmation cannot create
   * duplicate writes for the same row.
   */
  markedReadIds: string[];
  /**
   * Ids whose read-complete write FAILED this session. Two jobs, deliberately
   * separate scopes:
   *   1. Per-context failure frontiers preserve legacy markRead/load recovery.
   *      Explicit UI close now holds further loads until the next entry.
   *   2. The modal raises a toast when a new id lands here.
   *
   * Memory only — never persisted. The server holds no dismissal for these, so
   * they must reappear on the next load. Anything durable here would make the
   * client more authoritative than the server about what the user has read.
   */
  writeFailedIds: string[];
  load: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  close: (id: string) => void;
  dismiss: (id: string) => Promise<void>;
  /** Marks a sidebar card read and shows the next card of this entry, if any. */
  advance: (id: string) => Promise<void>;
  reset: () => void;
}

// Visibilitychange and focus usually arrive as a pair. Share their request so
// one foreground transition cannot race two /active snapshots against itself.
// reset() advances the generation so a response from a prior account/session
// can never write into the new one.
let announcementLoadInFlight: Promise<void> | null = null;
let announcementLoadGeneration = 0;
let announcementAccountGeneration = 0;
let contextKey: string | undefined;
const failedByContext = new Map<string, string[]>();
function currentContext() { return useServerStore.getState().current?.id ?? "account"; }
function syncContext() {
  const next = currentContext();
  if (contextKey === next) return;
  contextKey = next;
  announcementLoadGeneration += 1;
  announcementLoadInFlight = null;
  useAnnouncementStore.setState((state) => ({
    pending: state.pending.filter((item) => item.deliveryScope?.type !== "server" || item.deliveryScope.serverId === next),
    loaded: false,
  }));
}

export const useAnnouncementStore = create<AnnouncementState>((set, get) => ({
  pending: [],
  stackTotal: 0,
  loaded: false,
  completedThisEntry: false,
  markedReadIds: [],
  writeFailedIds: [],

  load: () => {
    syncContext();
    if (get().completedThisEntry) return Promise.resolve();
    // Once this tab presents a row, it owns that presentation until the user
    // closes it. Account-level dismissal from another tab must not make a
    // focused/refocused modal disappear underneath this reader.
    if (get().pending.length > 0) return Promise.resolve();
    if (announcementLoadInFlight) return announcementLoadInFlight;

    const generation = announcementLoadGeneration;
    const requestContext = currentContext();
    const request = (async () => {
      try {
        const skipped = failedByContext.get(requestContext) ?? [];
        const after = skipped.at(-1);
        const { data } = await api.get("/announcements/active", {
          params: { ...(after ? { after } : {}), ...(requestContext !== "account" ? { server_id: requestContext } : {}), sidebar_limit: ANNOUNCEMENT_SIDEBAR_STACK_MAX },
        });
        if (generation !== announcementLoadGeneration) return;
        const announcements = (data.announcements as Announcement[]) ?? [];
        // Option B: a row whose write failed is skipped for the rest of this
        // session so the oldest-first queue keeps advancing. Failures are a
        // monotonic prefix of the stable queue, so the last failed id is a
        // constant-size request-only frontier; sending every prior id would
        // eventually exceed a transport cap and wedge the queue. The server
        // advances past this row before applying its oldest-first limit. It is
        // NOT dismissed, and a reload clears the memory-only frontier.
        set((state) => {
          // A modal may have opened while this request was in flight. Its local
          // presentation ownership wins over any late (especially empty)
          // response from focus recovery.
          if (state.pending.length > 0) return { loaded: true };
          const hiddenIds = new Set([...(failedByContext.get(requestContext) ?? []), ...state.markedReadIds]);
          const pending = announcements.filter((announcement) => !hiddenIds.has(announcement.id));
          return { pending, stackTotal: pending.length, loaded: true };
        });
      } catch (err) {
        if (generation !== announcementLoadGeneration) return;
        console.error("Failed to load announcements:", err);
        set({ loaded: true });
      }
    })().finally(() => {
      if (announcementLoadInFlight === request) announcementLoadInFlight = null;
    });
    announcementLoadInFlight = request;
    return request;
  },

  // Records explicit confirmation, closing, or CTA activation. Rendering
  // alone never records dismissal; already-open copies keep their local state.
  markRead: async (id) => {
    if (get().markedReadIds.includes(id)) return;
    const writeContext = currentContext();
    const accountGeneration = announcementAccountGeneration;
    set((state) => ({ markedReadIds: [...state.markedReadIds, id] }));
    try {
      await api.post(`/announcements/${id}/dismiss`, undefined, { params: writeContext !== "account" ? { server_id: writeContext } : undefined });
    } catch (err) {
      if (accountGeneration !== announcementAccountGeneration) return;
      const failed = failedByContext.get(writeContext) ?? [];
      if (!failed.includes(id)) failedByContext.set(writeContext, [...failed, id]);
      console.error("Failed to record announcement as read:", err);
      set((state) => ({
        // Allow a later trigger to retry the write for this row.
        markedReadIds: state.markedReadIds.filter((markedId) => markedId !== id),
        writeFailedIds: state.writeFailedIds.includes(id)
          ? state.writeFailedIds
          : [...state.writeFailedIds, id],
      }));
    }
  },

  close: (id) => {
    if (!get().pending.some((item) => item.id === id)) return;
    announcementLoadGeneration += 1;
    announcementLoadInFlight = null;
    set({ pending: [], completedThisEntry: true });
  },

  // Account dismissal + local hide, shared by every explicit dismissal action
  // and the slockdev auto-dismiss.
  dismiss: async (id) => {
    get().close(id);
    await get().markRead(id);
  },
  advance: async (id) => {
    if (get().pending[0]?.id !== id) return;
    const rest = get().pending.slice(1);
    if (rest.length === 0) {
      get().close(id);
    } else {
      set({ pending: rest });
    }
    await get().markRead(id);
  },

  reset: () => {
    resetAnnouncementShown();
    announcementAccountGeneration += 1;
    announcementLoadGeneration += 1;
    announcementLoadInFlight = null;
    failedByContext.clear();
    contextKey = undefined;
    set({ pending: [], stackTotal: 0, loaded: false, completedThisEntry: false, markedReadIds: [], writeFailedIds: [] });
  },
}));

registerServerReset(() => { syncContext(); void useAnnouncementStore.getState().load(); });
