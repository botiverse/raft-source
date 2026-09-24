import { create } from "zustand";
import type { DocumentAttachmentPreview } from "../components/message/attachmentPreview";
import type { Message, MessageAttachment } from "./messageStore";

/**
 * Global document-preview surface.
 *
 * Image previews already lived in a store (`imageLightboxStore`), which is why
 * any surface — including the forward composer — could open them. Document
 * previews were held in `MessageItem`'s local state, so no other surface could
 * reach them: the forward composer fell through to a download instead, and the
 * two paths drifted. Keeping this state here removes that asymmetry rather than
 * adding a second copy of the preview UI.
 */
/**
 * Host-message context for attachment comments. Optional on purpose: a forward
 * preview shows a *snapshot*, not the original message, so it has no host to
 * attribute comments to. Openers that lack a host omit this and the preview
 * renders without a comment surface — an explicit absence, not an accident.
 */
export type DocumentPreviewCommentContext = {
  parentMessage: Pick<Message, "id" | "channelId" | "senderId" | "senderType">;
};

export type DocumentPreviewEntry = {
  attachment: MessageAttachment;
  preview: DocumentAttachmentPreview;
  truncated: boolean;
  /** Resolved inline URL; only pdf previews need one. */
  url: string | null;
  commentContext?: DocumentPreviewCommentContext;
};

interface DocumentPreviewState {
  entry: DocumentPreviewEntry | null;
  /** Attachment id currently being fetched, for per-chip busy affordances. */
  loadingId: string | null;

  open: (entry: DocumentPreviewEntry) => void;
  close: () => void;
  setLoadingId: (id: string | null) => void;
}

export const useDocumentPreviewStore = create<DocumentPreviewState>((set) => ({
  entry: null,
  loadingId: null,
  open: (entry) => set({ entry }),
  close: () => set({ entry: null }),
  setLoadingId: (loadingId) => set({ loadingId }),
}));
