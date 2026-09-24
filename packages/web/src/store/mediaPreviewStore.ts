import { create } from "zustand";
import type { Message, MessageAttachment } from "./messageStore";

/**
 * Global host for the html / video / audio attachment previews.
 *
 * These lived in MessageItem's local state alongside the document preview,
 * which is why only a message could open them. Same store shape as the
 * document preview so all four behave identically from any surface.
 */
export type MediaPreviewKind = "html" | "video" | "audio";

export type MediaPreviewCommentContext = {
  parentMessage: Pick<Message, "id" | "channelId" | "senderId" | "senderType">;
};

export type MediaPreviewEntry = {
  kind: MediaPreviewKind;
  attachment: MessageAttachment;
  url: string;
  /** Absent when the opener has no host message (e.g. a forward snapshot). */
  commentContext?: MediaPreviewCommentContext;
};

interface MediaPreviewState {
  entry: MediaPreviewEntry | null;
  loadingId: string | null;
  open: (entry: MediaPreviewEntry) => void;
  close: () => void;
  setLoadingId: (id: string | null) => void;
}

export const useMediaPreviewStore = create<MediaPreviewState>((set) => ({
  entry: null,
  loadingId: null,
  open: (entry) => set({ entry }),
  close: () => set({ entry: null }),
  setLoadingId: (loadingId) => set({ loadingId }),
}));
