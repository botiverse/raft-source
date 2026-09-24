import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");
const strykerBackupSrc = () => {
  const tmp = resolve(repoRoot, ".stryker-tmp");
  if (!existsSync(tmp)) return null;
  const backup = readdirSync(tmp).find((entry) => entry.startsWith("backup-"));
  return backup ? resolve(tmp, backup, "src") : null;
};
const readSource = (path: string) => {
  const backupSrc = strykerBackupSrc();
  const backupPath = backupSrc ? resolve(backupSrc, path) : null;
  return readFileSync(backupPath && existsSync(backupPath) ? backupPath : resolve(srcRoot, path), "utf8");
};

test("document previews do not fetch signed URLs for markdown csv or text before opening", () => {
  // Fetching + dedupe moved out of MessageItem into the shared opener so every
  // surface opens the same preview; the contract itself is unchanged.
  const source = readSource("components/message/openDocumentPreview.ts");

  // Concurrent opens of the same attachment must collapse to one request.
  assert.match(source, /const inFlight = new Map<string, Promise<void>>\(\);/);
  assert.match(source, /if \(inFlight\.has\(attachment\.id\)\) return;/);
  // Only pdf resolves a signed inline URL; text/markdown/csv must not.
  assert.match(
    source,
    /const url = preview\.kind === "pdf"\s*\? \(await api\.get<\{ url: string \}>\(`\/attachments\/\$\{attachment\.id\}\/url\?disposition=inline`\)\)\.data\.url\s*: null;/,
  );
  assert.doesNotMatch(source, /const inlinePdfQuery = previewResponse\.data\.kind === "pdf"/);
  assert.doesNotMatch(source, /api\.get\(`\/attachments\/\$\{attachment\.id\}\/url\$\{inlinePdfQuery\}`\)/);
});

test("document attachment cards show preview affordance and visible loading feedback", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");
  const chipSource = readSource("components/message/AttachmentChip.tsx");
  const shellSource = readSource("components/ui/PreviewShell.tsx");

  assert.match(
    messageSource,
    /variant="compact"[\s\S]{0,200}?loading=\{isHtmlLoading\}[\s\S]{0,200}?affordance="preview"[\s\S]{0,120}?affordanceName="document-preview"/,
  );
  assert.match(chipSource, /message\.attachment\.openingPreview/);
  assert.match(chipSource, /data-message-affordance="attachment-preview-loading"/);
  // Loading state overrides PreviewShell's bg-white via Tailwind important.
  // No opacity modifier — that combined with the OKlab color-mix shell bg
  // paints cyan on Chromium (stdrc 2026-05-23 #proj-theme:441c8b2b
  // cfd10230). The loading bar + spinner are the dominant busy signal.
  assert.match(chipSource, /"!bg-soft-signal\/30 cursor-wait"/);
  // Normal-state hover lives on PreviewShell's shared skin. No active token
  // — press inherits hover, matching pre-refactor QuotedMessageCard.
  assert.match(shellSource, /hover:bg-black\/5`/);
  assert.doesNotMatch(shellSource, /active:bg-soft-signal/);
  assert.doesNotMatch(shellSource, /active:opacity-90/);
  assert.match(chipSource, /const disabled = isOptimistic \|\| loading \|\| !onClick;/);
  // PreviewShell renders <div> instead of <button> when onClick is undefined,
  // so disabled state is expressed by not passing onClick rather than a
  // disabled attr. Verify the gating still flows from `disabled`.
  assert.match(chipSource, /onClick=\{disabled \? undefined : onClick\}/);
});

test("supported video attachments render an inline player and still reuse the attachment preview shell", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");
  const attachmentSource = readSource("components/message/attachmentPreview.ts");
  const cssSource = readSource("index.css");

  assert.match(attachmentSource, /export function isVideoPreviewAttachment/);
  assert.match(attachmentSource, /filename\.endsWith\("\.webm"\)/);
  assert.match(attachmentSource, /filename\.endsWith\("\.mov"\)/);
  assert.match(attachmentSource, /mimeType === "video\/webm"/);
  assert.match(attachmentSource, /mimeType === "video\/quicktime"/);
  assert.match(messageSource, /function InlineVideoAttachmentCard/);
  assert.match(messageSource, /data-message-affordance="inline-video-preview"/);
  assert.match(messageSource, /new IntersectionObserver/);
  assert.match(messageSource, /videoRef\.current\?\.pause\(\)/);
  assert.match(messageSource, /api\.get\(`\/attachments\/\$\{attachment\.id\}\/url\?disposition=inline`, \{ signal: controller\.signal \}\)/);
  assert.match(messageSource, /controller\.signal\.aborted/);
  assert.match(messageSource, /abortRef\.current\?\.abort\(\)/);
  assert.match(messageSource, /<video[\s\S]{0,220}?src=\{inlineUrl\}[\s\S]{0,220}?controls[\s\S]{0,220}?playsInline[\s\S]{0,220}?preload="metadata"/);
  assert.doesNotMatch(messageSource, /data-message-affordance="inline-video-controls"/);
  assert.doesNotMatch(messageSource, /data-message-affordance="inline-video-play-toggle"/);
  assert.doesNotMatch(messageSource, /data-message-affordance="inline-video-mute-toggle"/);
  assert.doesNotMatch(messageSource, /video-range-brutal/);
  assert.doesNotMatch(cssSource, /video-range-brutal/);
  assert.match(messageSource, /className="absolute right-1\.5 top-1\.5 flex size-6 items-center justify-center border border-black bg-white\/80 text-black\/60 hover:bg-white hover:text-black"/);
  assert.match(messageSource, /<Eye size=\{12\} \/>/);
  assert.doesNotMatch(messageSource, /<Maximize2/);
  assert.doesNotMatch(messageSource, /data-message-affordance="inline-video-download"/);
  assert.match(messageSource, /message\.messageItem\.codecWarning/);
  assert.match(messageSource, /message\.messageItem\.downloadToView/);
  assert.match(messageSource, /const videoAttachments = message\.attachments\.filter\(\(att\) => isPreviewableVideoAttachment\(att\)\);/);
  assert.match(messageSource, /\.filter\(\(att\) => !isPreviewableVideoAttachment\(att\) && !isPreviewableAudioAttachment\(att\)\)/);
  assert.match(messageSource, /function VideoAttachmentPreviewModal/);
  assert.match(messageSource, /function VideoAttachmentPreviewModal[\s\S]*?<AttachmentPreviewShell filename=\{filename\} onClose=\{onClose\} onDownload=\{onDownload\} comments=\{comments\}>/);
  assert.match(messageSource, /data-message-affordance="inline-video-expand"/);
});

test("paused video comments expose an explicit add timestamp affordance when no timestamp is attached", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");
  const panelSource = readSource("components/message/AttachmentCommentsPanel.tsx");

  assert.match(messageSource, /pendingAnchor: CommentAnchor \| null;/);
  assert.match(messageSource, /getPendingAnchor: \(\) => CommentAnchor \| null;/);
  assert.match(messageSource, /const pendingAnchorRef = useRef<CommentAnchor \| null>\(null\);/);
  assert.match(
    messageSource,
    /const commitPendingAnchor = useCallback\(\(anchor: CommentAnchor \| null\) => \{\s*pendingAnchorRef\.current = anchor;\s*setPendingAnchor\(anchor\);/,
  );
  assert.match(messageSource, /const hasTimestampAnchor = ctx\?\.pendingAnchor\?\.type === "video-timestamp";/);
  assert.match(
    messageSource,
    /const canAddPausedTimestamp =\s*commentMode && videoState\.paused && videoState\.time > 0 && !hasTimestampAnchor;/,
  );
  assert.match(messageSource, /data-message-affordance="video-comment-add-timestamp"/);
  assert.match(messageSource, /message\.messageItem\.addTimestamp[\s\S]*?formatVideoCommentTimestamp\(videoState\.time\)/);
  assert.match(messageSource, /video\.addEventListener\("pause", syncVideoState\);/);
  assert.match(messageSource, /video\.addEventListener\("seeked", syncVideoState\);/);
  assert.match(messageSource, /getPendingAnchor=\{getPendingAnchor\}/);
  assert.match(panelSource, /onAnchorCleared\?: \(\) => void;/);
  assert.match(panelSource, /getPendingAnchor\?: \(\) => CommentAnchor \| null;/);
  assert.match(panelSource, /const clearActiveAnchor = \(\) => \{/);
  assert.match(panelSource, /onAnchorCleared\?\.\(\);/);
  assert.match(panelSource, /const anchorForSend = getPendingAnchor \? getPendingAnchor\(\) : activeAnchor;/);
  assert.match(
    panelSource,
    /anchor: anchorForSend \? \{ type: anchorForSend\.type, data: anchorForSend\.data as Record<string, unknown> \} : null,/,
  );
  assert.match(panelSource, /anchor: anchorForSend \?\? undefined,/);
  assert.doesNotMatch(panelSource, /anchor: activeAnchor \?\? undefined,/);
});

test("audio attachments render custom inline players without the preview chip", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");
  const attachmentSource = readSource("components/message/attachmentPreview.ts");

  assert.match(attachmentSource, /export function isAudioPreviewAttachment/);
  assert.match(attachmentSource, /filename\.endsWith\("\.mp3"\)/);
  assert.match(attachmentSource, /filename\.endsWith\("\.wav"\)/);
  assert.match(attachmentSource, /filename\.endsWith\("\.m4a"\)/);
  assert.match(attachmentSource, /mimeType === "audio\/mpeg"/);
  assert.match(attachmentSource, /mimeType === "audio\/ogg"/);
  assert.match(messageSource, /function InlineAudioAttachmentCard/);
  assert.match(messageSource, /data-message-affordance="inline-audio-preview"/);
  assert.match(messageSource, /const audioAttachments = message\.attachments\.filter\(\(att\) => isPreviewableAudioAttachment\(att\)\);/);
  assert.match(messageSource, /\.filter\(\(att\) => !isPreviewableVideoAttachment\(att\) && !isPreviewableAudioAttachment\(att\)\)/);
  assert.match(messageSource, /<InlineAudioAttachmentCard[\s\S]{0,260}?attachment=\{att\}[\s\S]{0,260}?onDownload=\{handleDownload\}/);
  assert.match(messageSource, /isAudio=\{false\}/);
  assert.doesNotMatch(messageSource, /isAudio=\{isAudio\}/);
  assert.doesNotMatch(messageSource, /const isAudio = isPreviewableAudioAttachment\(att\);/);
  const normalAttachmentBlock = messageSource.match(/const otherAttachments = message\.attachments\.filter[\s\S]*?<AttachmentCard[\s\S]*?isAudio=\{false\}[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(normalAttachmentBlock, "normal attachment branch should render generic chips with audio excluded");
  assert.doesNotMatch(normalAttachmentBlock, /handleOpenAudioPreview/);
  assert.doesNotMatch(normalAttachmentBlock, /secondaryDownload=\{isAudio \? \{/);
  // The audio/video inline URL now comes from the shared opener's endpoint map
  // for forwarded snapshots and from the inline card in normal messages; pin
  // both so audio stays playable without returning to the preview chip path.
  assert.match(messageSource, /audio: \(id\) => `\/attachments\/\$\{id\}\/url\?disposition=inline`/);
  assert.match(messageSource, /api\.get\(`\/attachments\/\$\{attachment\.id\}\/url\?disposition=inline`, \{ signal: controller\.signal \}\)/);
  assert.match(messageSource, /function AudioAttachmentPreviewModal/);
  assert.match(messageSource, /export function AudioPreviewBody/);
  assert.match(messageSource, /function InlineAudioPlayer/);
  assert.match(messageSource, /data-message-affordance="inline-audio-player"/);
  assert.match(messageSource, /data-message-affordance="audio-play-toggle"/);
  assert.match(messageSource, /data-message-affordance="audio-seek"/);
  assert.match(messageSource, /data-message-affordance="audio-volume-control"/);
  assert.match(messageSource, /data-message-affordance="audio-volume"/);
  assert.match(messageSource, /<InlineAudioPlayer[\s\S]{0,180}?filename=\{attachment\.filename\}[\s\S]{0,180}?url=\{inlineUrl\}/);
  assert.match(messageSource, /<audio[\s\S]{0,220}?src=\{url\}[\s\S]{0,220}?controls[\s\S]{0,220}?preload="metadata"/);
  assert.match(messageSource, /<audio[\s\S]{0,260}?src=\{url\}[\s\S]{0,260}?preload="metadata"[\s\S]{0,260}?className="hidden"/);
  assert.doesNotMatch(messageSource, /<AudioPreviewBody[\s\S]{0,180}?variant="inline"/);
  const inlineAudioClass = messageSource.match(/export const INLINE_AUDIO_PREVIEW_CARD_CLASS = "([^"]+)";/)?.[1] ?? "";
  assert.ok(inlineAudioClass, "inline audio should have a named preview-card class");
  assert.match(inlineAudioClass, /max-w-\[min\(28rem,calc\(100vw-7rem\)\)\]/);
  assert.doesNotMatch(inlineAudioClass, /shadow-brutal/);
  const chipSource = readSource("components/message/AttachmentChip.tsx");
  assert.match(chipSource, /<Eye size=\{12\} \/>/);
});

test("attachment previews intercept close-tab shortcut before the browser closes the tab", () => {
  const lightboxSource = readSource("components/ui/Lightbox.tsx");

  assert.match(lightboxSource, /const closeShortcut =\s*e\.key\.toLowerCase\(\) === "w" &&\s*\(e\.metaKey \|\| e\.ctrlKey\) &&\s*!e\.shiftKey &&\s*!e\.altKey;/);
  assert.match(lightboxSource, /if \(e\.key !== "Escape" && !closeShortcut\) return;/);
  assert.match(lightboxSource, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*onClose\(\);/);
  assert.match(lightboxSource, /document\.addEventListener\("keydown", handler\);/);
  assert.match(lightboxSource, /return \(\) => document\.removeEventListener\("keydown", handler\);/);
});

test("html attachment chip uses user-facing HTML preview copy", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");

  assert.match(messageSource, /isHtml \? formatMessage\(\{ id: "message\.messageItem\.htmlPreview" \}\) : isVideo \? formatMessage\(\{ id: "message\.messageItem\.videoPreview" \}\) : isAudio \? formatMessage\(\{ id: "message\.messageItem\.audioPreview" \}\)/);
  assert.doesNotMatch(messageSource, /"Sandboxed HTML preview"/);
});

// --- MI-2 seam re-review (赵梓淇): document-preview card metadata + opening-preview
// loading copy must be locale-aware through their real consumers. No cheap DOM
// harness exists for document-kind rendering (needs async preview-fetch
// fixtures), so these pin all four kinds through the actual consumer
// expressions + the shared map + zh catalog — the false-green guard for
// "one kind right, others wrong". The audio render tooth
// (audioAttachmentPreview.behavior) proves the formatMessage→zh path renders. ---
test("i18n: document preview labels remain locale-aware in attachment card metadata", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");
  const zh = readSource("i18n/messages/zh-cn.ts");

  assert.match(messageSource, /const DOCUMENT_PREVIEW_LABEL_ID = \{[\s\S]*?csv: "message\.messageItem\.docPreviewCsv"[\s\S]*?markdown: "message\.messageItem\.docPreviewMarkdown"[\s\S]*?text: "message\.messageItem\.docPreviewText"[\s\S]*?pdf: "message\.messageItem\.docPreviewPdf"[\s\S]*?\} as const;/);
  // No hardcoded English helper remains; the attachment-card consumer formats
  // through the shared map. The modal-header kind badge was intentionally
  // removed, so the shell must not accept or render a label prop.
  assert.doesNotMatch(messageSource, /documentPreviewLabel\(/);
  assert.match(messageSource, /label=\{documentPreview \? formatMessage\(\{ id: DOCUMENT_PREVIEW_LABEL_ID\[documentPreview\.preview\.kind\] \}\)/);
  assert.doesNotMatch(messageSource, /<AttachmentPreviewShell[^>]*\blabel=/);
  assert.match(zh, /"message\.messageItem\.docPreviewCsv": "CSV 预览"/);
  assert.match(zh, /"message\.messageItem\.docPreviewMarkdown": "Markdown 预览"/);
  assert.match(zh, /"message\.messageItem\.docPreviewText": "纯文本预览"/);
  assert.match(zh, /"message\.messageItem\.docPreviewPdf": "PDF 预览"/);
});

test("i18n: attachment preview loading label is localized from MessageItem, not the shared default", () => {
  const messageSource = readSource("components/message/MessageItem.tsx") + readSource("components/message/openMediaPreview.ts") + readSource("components/message/attachmentPreviewSurfaces.tsx");
  const zh = readSource("i18n/messages/zh-cn.ts");
  const passes = messageSource.match(/loadingLabel=\{formatMessage\(\{ id: "message\.messageItem\.openingPreview" \}\)\}/g) ?? [];
  assert.equal(passes.length, 2, "both loading AttachmentChips pass the localized loadingLabel");
  assert.match(zh, /"message\.messageItem\.openingPreview": "正在打开预览…"/);
});
