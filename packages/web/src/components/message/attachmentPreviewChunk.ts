import type { ComponentProps } from "react";
import { deferredDialog, deferredModule } from "../../boot/deferredUi";
import type {
  AudioAttachmentPreviewModal as AudioModal,
  DocumentAttachmentPreviewModal as DocumentModal,
  HtmlAttachmentPreviewModal as HtmlModal,
  VideoAttachmentPreviewModal as VideoModal,
} from "./attachmentPreviewSurfaces";

/**
 * The attachment previews (document, html, video, audio, with their comment
 * margin and panel), off the first download (boot/deferredUi): a click opens
 * one. One load shared by every preview; fetched in the background after the
 * first screen, so it is normally in before the first click.
 */
const loadAttachmentPreviewSurfaces = deferredModule(() => import("./attachmentPreviewSurfaces"));

export const DocumentAttachmentPreviewModal = deferredDialog<ComponentProps<typeof DocumentModal>>(
  () => loadAttachmentPreviewSurfaces().then((module) => ({ default: module.DocumentAttachmentPreviewModal })),
);
export const HtmlAttachmentPreviewModal = deferredDialog<ComponentProps<typeof HtmlModal>>(
  () => loadAttachmentPreviewSurfaces().then((module) => ({ default: module.HtmlAttachmentPreviewModal })),
);
export const VideoAttachmentPreviewModal = deferredDialog<ComponentProps<typeof VideoModal>>(
  () => loadAttachmentPreviewSurfaces().then((module) => ({ default: module.VideoAttachmentPreviewModal })),
);
export const AudioAttachmentPreviewModal = deferredDialog<ComponentProps<typeof AudioModal>>(
  () => loadAttachmentPreviewSurfaces().then((module) => ({ default: module.AudioAttachmentPreviewModal })),
);
