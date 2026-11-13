/**
 * What a message row needs from the attachment previews without their code:
 * the previews themselves load when one opens (attachmentPreviewChunk.ts).
 */

export const DOCUMENT_PREVIEW_LABEL_ID = {
  csv: "message.messageItem.docPreviewCsv",
  xlsx: "message.messageItem.docPreviewXlsx",
  markdown: "message.messageItem.docPreviewMarkdown",
  text: "message.messageItem.docPreviewText",
  pdf: "message.messageItem.docPreviewPdf",
} as const;

/** The inline audio player's raft-ui Card: its width and inset. */
export const INLINE_AUDIO_PREVIEW_CARD_CLASS = "w-full max-w-[min(28rem,calc(100vw-7rem))] p-2.5 text-left";
