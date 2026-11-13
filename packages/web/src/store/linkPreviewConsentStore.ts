import { create } from "zustand";
import api from "../api/client";

// A viewer's answers to the first-view link-preview prompt
// (docs/development/app-link-previews.md#first-view-prompt), shared by every
// message on screen and by Settings › Applications, so that one answer updates
// them all. Keys carry the viewer and the Server: an answer is for one person
// on one Server, and nothing here survives a reload (the server is the record).

export type LinkPreviewApp = { id: string; name: string; icon: string | null };

/**
 * - `allowing` / `declining`: the answer is on its way.
 * - `failed`: allowing failed (offline, 5xx); the prompt offers Retry.
 * - `allowed`: consent recorded. `epoch` moved, so messages that were asked
 *   reload their previews.
 * - `declined`: no prompt anywhere; the links stay plain.
 * - `unavailable`: the App can no longer be answered for here (uninstalled,
 *   no link-preview registration, not allowed the profile scopes); like
 *   declined, the prompt goes away.
 */
export type LinkPreviewAnswerStatus = "allowing" | "declining" | "failed" | "allowed" | "declined" | "unavailable";

export type LinkPreviewAnswerResult = "allowed" | "declined" | "failed" | "unavailable";

/** `${viewer}:${server}`: whose answers on which Server. */
export function linkPreviewViewerKey(viewer: string | undefined, server: string | undefined): string {
  return `${viewer ?? ""}:${server ?? ""}`;
}

export function linkPreviewAppKey(viewerKey: string, appId: string): string {
  return `${viewerKey}:${appId}`;
}

/** One conversation (channel, DM or thread) of one viewer on one Server. */
export function linkPreviewConversationKey(viewerKey: string, conversationId: string): string {
  return `${viewerKey}:${conversationId}`;
}

interface LinkPreviewConsentState {
  status: Record<string, LinkPreviewAnswerStatus>;
  /** Moves each time an App is allowed; a message whose previews were read before is stale. */
  epoch: Record<string, number>;
  /**
   * `${conversationKey}:${appId}` -> the message that asks. An App is asked
   * once per conversation, on the first message whose previews come back with
   * its prompt; the others keep the plain link. A claim stays for the session,
   * so scrolling on does not ask again further down.
   */
  claims: Record<string, string>;
  /** Claims the prompts of one message's answer; returns nothing, read `claims`. */
  claimPrompts: (conversationKey: string, appIds: string[], messageId: string) => void;
  allow: (viewerKey: string, app: LinkPreviewApp) => Promise<LinkPreviewAnswerResult>;
  decline: (viewerKey: string, app: LinkPreviewApp) => Promise<LinkPreviewAnswerResult>;
}

let epochSeq = 0;

function errorStatus(error: unknown): number | undefined {
  return (error as { response?: { status?: number } } | null)?.response?.status;
}

/** 404 LINK_PREVIEW_APP_NOT_FOUND, 409 LINK_PREVIEW_SCOPES_NOT_ALLOWED: asking again cannot help. */
function cannotAnswer(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 404 || status === 409;
}

export const useLinkPreviewConsentStore = create<LinkPreviewConsentState>()((set, get) => ({
  status: {},
  epoch: {},
  claims: {},

  claimPrompts: (conversationKey, appIds, messageId) => {
    const claims = get().claims;
    const missing = appIds.filter((appId) => !claims[`${conversationKey}:${appId}`]);
    if (!missing.length) return;
    set((state) => {
      const next = { ...state.claims };
      for (const appId of missing) next[`${conversationKey}:${appId}`] ??= messageId;
      return { claims: next };
    });
  },

  allow: async (viewerKey, app) => {
    const key = linkPreviewAppKey(viewerKey, app.id);
    const setStatus = (status: LinkPreviewAnswerStatus) => set((state) => ({ status: { ...state.status, [key]: status } }));
    setStatus("allowing");
    try {
      await api.post(`/integrations/clients/${encodeURIComponent(app.id)}/link-preview-consent`);
      epochSeq += 1;
      set((state) => ({ status: { ...state.status, [key]: "allowed" }, epoch: { ...state.epoch, [key]: epochSeq } }));
      return "allowed";
    } catch (error) {
      if (cannotAnswer(error)) {
        setStatus("unavailable");
        return "unavailable";
      }
      setStatus("failed");
      return "failed";
    }
  },

  decline: async (viewerKey, app) => {
    const key = linkPreviewAppKey(viewerKey, app.id);
    const previous = get().status[key];
    set((state) => ({ status: { ...state.status, [key]: "declining" } }));
    try {
      await api.post(`/integrations/clients/${encodeURIComponent(app.id)}/link-preview-decline`);
      set((state) => ({ status: { ...state.status, [key]: "declined" } }));
      return "declined";
    } catch (error) {
      if (cannotAnswer(error)) {
        set((state) => ({ status: { ...state.status, [key]: "unavailable" } }));
        return "unavailable";
      }
      // Nothing changed on the server: put the prompt back as it was.
      set((state) => {
        const status = { ...state.status };
        if (previous && previous !== "declining") status[key] = previous;
        else delete status[key];
        return { status };
      });
      return "failed";
    }
  },
}));
