import { create } from "zustand";
import type { Message, MessageAttachment } from "./messageStore";

export { type MessageAttachment };

/**
 * An image the lightbox can display. Normally a message {@link MessageAttachment}
 * whose full-resolution URL is fetched lazily from `/attachments/{id}/url`. For
 * images that already have a ready-to-use URL and no attachment record (e.g. a
 * profile avatar), set {@link directUrl} so the lightbox renders it without the
 * attachment fetch.
 */
export type LightboxImage = MessageAttachment & {
  /** Pre-resolved image URL. When set, the lightbox skips the attachment fetch. */
  directUrl?: string;
};

/**
 * Host-message context for attachment comments on the lightbox surface
 * (attachment-comments F10, task #10). Keyed per attachment id because some
 * openers (ChannelFilesPanel) mix images from many messages; openers that
 * lack host context simply omit entries and those images render without a
 * comment affordance.
 */
export type LightboxCommentContext = {
  parentMessage: Pick<Message, "id" | "channelId" | "senderId" | "senderType">;
};

interface ImageLightboxState {
  /** Whether the lightbox is open */
  isOpen: boolean;
  /** All images currently in the lightbox (same message, or a single avatar) */
  images: LightboxImage[];
  /** Index of the currently displayed image */
  currentIndex: number;
  /** Session-scoped mapping so reopening the same attachment can reuse a still-valid URL. */
  imageUrlCache: Record<string, { url: string; expiresAt: string | null }>;
  /** Per-attachment comment context for THIS open (see LightboxCommentContext). */
  commentContexts: Record<string, LightboxCommentContext>;

  open: (
    images: LightboxImage[],
    startIndex: number,
    commentContexts?: Record<string, LightboxCommentContext>,
  ) => void;
  /** Open a single image that already has a resolved URL (e.g. an avatar). */
  openImage: (url: string, filename: string) => void;
  close: () => void;
  next: () => void;
  prev: () => void;
  goTo: (index: number) => void;
  cacheImageUrl: (attachmentId: string, value: { url: string; expiresAt: string | null }) => void;
}

export const useImageLightboxStore = create<ImageLightboxState>((set, get) => ({
  isOpen: false,
  images: [],
  currentIndex: 0,
  imageUrlCache: {},
  commentContexts: {},

  open: (images, startIndex, commentContexts) =>
    set({ isOpen: true, images, currentIndex: startIndex, commentContexts: commentContexts ?? {} }),

  openImage: (url, filename) =>
    set({
      isOpen: true,
      currentIndex: 0,
      commentContexts: {},
      images: [
        {
          id: `direct:${url}`,
          filename,
          mimeType: "image/*",
          sizeBytes: 0,
          directUrl: url,
        },
      ],
    }),

  close: () => set({ isOpen: false, images: [], currentIndex: 0, commentContexts: {} }),

  next: () => {
    const { currentIndex, images } = get();
    if (currentIndex < images.length - 1) {
      set({ currentIndex: currentIndex + 1 });
    }
  },

  prev: () => {
    const { currentIndex } = get();
    if (currentIndex > 0) {
      set({ currentIndex: currentIndex - 1 });
    }
  },

  goTo: (index) => {
    const { images } = get();
    if (index >= 0 && index < images.length) {
      set({ currentIndex: index });
    }
  },

  cacheImageUrl: (attachmentId, value) =>
    set((state) => ({
      imageUrlCache: {
        ...state.imageUrlCache,
        [attachmentId]: value,
      },
    })),
}));
