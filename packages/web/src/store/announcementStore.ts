import { create } from "zustand";
import type { Announcement } from "@botiverse/raft-shared";
import api from "../api/client";

interface AnnouncementState {
  pending: Announcement[];
  loaded: boolean;
  /**
   * Ids already reported to the server as read-complete this session. `markRead`
   * is idempotent against this so repeated explicit confirmation cannot create
   * duplicate writes for the same row.
   */
  markedReadIds: string[];
  /**
   * Ids whose read-complete write FAILED this session. Two jobs, deliberately
   * one list:
   *   1. `load()` filters them out, so one failing write cannot wedge the queue.
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
  reset: () => void;
}

// Visibilitychange and focus usually arrive as a pair. Share their request so
// one foreground transition cannot race two /active snapshots against itself.
// reset() advances the generation so a response from a prior account/session
// can never write into the new one.
let announcementLoadInFlight: Promise<void> | null = null;
let announcementLoadGeneration = 0;

export const useAnnouncementStore = create<AnnouncementState>((set, get) => ({
  pending: [],
  loaded: false,
  markedReadIds: [],
  writeFailedIds: [],

  load: () => {
    // Once this tab presents a row, it owns that presentation until the user
    // closes it. Account-level dismissal from another tab must not make a
    // focused/refocused modal disappear underneath this reader.
    if (get().pending.length > 0) return Promise.resolve();
    if (announcementLoadInFlight) return announcementLoadInFlight;

    const generation = announcementLoadGeneration;
    const request = (async () => {
      try {
        const skipped = get().writeFailedIds;
        const after = skipped.at(-1);
        const { data } = await api.get("/announcements/active", {
          params: after ? { after } : undefined,
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
          const hiddenIds = new Set([...state.writeFailedIds, ...state.markedReadIds]);
          return {
            pending: announcements.filter((announcement) => !hiddenIds.has(announcement.id)),
            loaded: true,
          };
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

  // Records an explicit confirmation. Navigation and rendering never call this:
  // otherwise one tab could persist account-level dismissal while another tab
  // is still presenting the same row.
  markRead: async (id) => {
    if (get().markedReadIds.includes(id)) return;
    set((state) => ({ markedReadIds: [...state.markedReadIds, id] }));
    try {
      await api.post(`/announcements/${id}/dismiss`);
    } catch (err) {
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
    set((state) => ({ pending: state.pending.filter((a) => a.id !== id) }));
  },

  // Explicit confirmation + hide, i.e. clicking OK on the last page. Kept as
  // one call for the user action and the slockdev auto-dismiss.
  dismiss: async (id) => {
    get().close(id);
    await get().markRead(id);
  },

  reset: () => {
    announcementLoadGeneration += 1;
    announcementLoadInFlight = null;
    set({ pending: [], loaded: false, markedReadIds: [], writeFailedIds: [] });
  },
}));
