import { create } from "zustand";
import { z } from "zod";
import api from "../api/client";

// A viewer's own list of answers to the link-preview prompt on one Server
// (GET /integrations/link-preview-consents), read once by Settings ›
// Applications and shared by everything there that shows it: the Link
// Previews row at the bottom, its Manage dialog, and the line in an installed
// App's details. One list, so the three always agree. The answers themselves
// go through linkPreviewConsentStore; after one, the list is read again.
// Keyed like that store (`${viewer}:${server}`); nothing survives a reload.

const appSchema = z.object({ id: z.string().min(1), name: z.string(), icon: z.string().nullable() });
const choicesSchema = z.object({
  allowed: z.array(z.object({ app: appSchema, granted_at: z.string() })),
  declined: z.array(z.object({ app: appSchema, declined_at: z.string() })),
});

export type LinkPreviewChoices = z.infer<typeof choicesSchema>;
export type LinkPreviewChoicesLoad = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; choices: LinkPreviewChoices };

/** One App's recorded answer, as the dialog row and the App's detail line show it. */
export type LinkPreviewChoice =
  | { kind: "allowed"; app: LinkPreviewChoices["allowed"][number]["app"]; at: string }
  | { kind: "declined"; app: LinkPreviewChoices["declined"][number]["app"]; at: string };

/** The list as rows: each App's answer and when it was given. */
export function linkPreviewChoiceRows(choices: LinkPreviewChoices): { allowed: LinkPreviewChoice[]; declined: LinkPreviewChoice[] } {
  return {
    allowed: choices.allowed.map((row): LinkPreviewChoice => ({ kind: "allowed", app: row.app, at: row.granted_at })),
    declined: choices.declined.map((row): LinkPreviewChoice => ({ kind: "declined", app: row.app, at: row.declined_at })),
  };
}

export function findLinkPreviewChoice(choices: LinkPreviewChoices, appId: string): LinkPreviewChoice | null {
  const { allowed, declined } = linkPreviewChoiceRows(choices);
  return allowed.find((row) => row.app.id === appId) ?? declined.find((row) => row.app.id === appId) ?? null;
}

interface LinkPreviewChoicesState {
  byViewer: Record<string, LinkPreviewChoicesLoad>;
  /**
   * Reads the list again. `quiet`: keep showing what is there while it
   * reads (after an answer), and keep it if the read fails.
   */
  read: (viewerKey: string, options?: { quiet?: boolean }) => Promise<void>;
}

// The latest read per viewer wins: an older answer arriving late is dropped.
const latestRead: Record<string, number> = {};
let readSeq = 0;

export const useLinkPreviewChoicesStore = create<LinkPreviewChoicesState>()((set) => ({
  byViewer: {},

  read: async (viewerKey, { quiet = false } = {}) => {
    readSeq += 1;
    const seq = readSeq;
    latestRead[viewerKey] = seq;
    const put = (load: LinkPreviewChoicesLoad) => set((state) => ({ byViewer: { ...state.byViewer, [viewerKey]: load } }));
    if (!quiet) put({ kind: "loading" });
    try {
      const { data } = await api.get("/integrations/link-preview-consents");
      if (latestRead[viewerKey] !== seq) return;
      const parsed = choicesSchema.safeParse(data);
      if (parsed.success) put({ kind: "ready", choices: parsed.data });
      else if (!quiet) put({ kind: "failed" });
    } catch {
      if (latestRead[viewerKey] === seq && !quiet) put({ kind: "failed" });
    }
  },
}));
