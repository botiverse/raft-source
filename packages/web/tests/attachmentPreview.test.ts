import assert from "node:assert/strict";
import { CSV_PREVIEW_MAX_FILE_SIZE_BYTES } from "@botiverse/raft-shared";
import { isAudioPreviewAttachment, isCsvAttachment, isDiffPatchAttachment, isDocumentPreviewAttachment, isMarkdownAttachment, isPdfAttachment, isTextAttachment, isVideoPreviewAttachment } from "../src/components/message/attachmentPreview";

test("isDiffPatchAttachment classifies patch previews by filename and MIME", () => {
  assert.equal(isDiffPatchAttachment({ filename: "changes.diff", mimeType: "text/plain" }), true);
  assert.equal(isDiffPatchAttachment({ filename: "changes", mimeType: "text/x-patch" }), true);
  assert.equal(isDiffPatchAttachment({ filename: "screenshot.png", mimeType: "image/png" }), false);
});


test("document attachment classifiers cover csv markdown pdf and text", () => {
  assert.equal(isCsvAttachment({ filename: "data.csv", mimeType: "text/plain", sizeBytes: CSV_PREVIEW_MAX_FILE_SIZE_BYTES }), true);
  assert.equal(isCsvAttachment({ filename: "data.csv", mimeType: "text/plain", sizeBytes: CSV_PREVIEW_MAX_FILE_SIZE_BYTES + 1 }), false);
  assert.equal(isCsvAttachment({ filename: "export.csv", mimeType: "application/vnd.ms-excel", sizeBytes: 1024 }), true);
  assert.equal(isCsvAttachment({ filename: "legacy.xls", mimeType: "application/vnd.ms-excel", sizeBytes: 1024 }), false);
  assert.equal(isCsvAttachment({ filename: "legacy.xls", mimeType: "text/csv", sizeBytes: 1024 }), false);
  assert.equal(isMarkdownAttachment({ filename: "README.md", mimeType: "text/plain" }), true);
  assert.equal(isPdfAttachment({ filename: "paper", mimeType: "application/pdf" }), true);
  assert.equal(isTextAttachment({ filename: "notes.txt", mimeType: "application/octet-stream" }), true);
  assert.equal(isTextAttachment({ filename: "notes", mimeType: "text/plain; charset=utf-8" }), true);
  assert.equal(isTextAttachment({ filename: "trace.log", mimeType: "application/octet-stream" }), true);
  assert.equal(isTextAttachment({ filename: "data.json", mimeType: "application/octet-stream" }), true);
  assert.equal(isTextAttachment({ filename: "payload", mimeType: "application/json" }), true);
  assert.equal(isTextAttachment({ filename: "service.yml", mimeType: "application/octet-stream" }), true);
  assert.equal(isTextAttachment({ filename: "readme", mimeType: "text/x-readme" }), true);
  assert.equal(isTextAttachment({ filename: "page.html", mimeType: "application/octet-stream" }), false);
  assert.equal(isTextAttachment({ filename: "page", mimeType: "text/html" }), false);
  assert.equal(isDocumentPreviewAttachment({ filename: "paper.pdf", mimeType: "application/octet-stream", sizeBytes: 1024 }), true);
  assert.equal(isDocumentPreviewAttachment({ filename: "data.json", mimeType: "application/octet-stream", sizeBytes: 1024 }), true);
  assert.equal(isDocumentPreviewAttachment({ filename: "notes.txt", mimeType: "application/octet-stream", sizeBytes: 1024 }), true);
  assert.equal(isDocumentPreviewAttachment({ filename: "image.png", mimeType: "image/png", sizeBytes: 1024 }), false);
});

test("isVideoPreviewAttachment classifies supported video previews by filename and MIME", () => {
  assert.equal(isVideoPreviewAttachment({ filename: "demo.mp4", mimeType: "application/octet-stream" }), true);
  assert.equal(isVideoPreviewAttachment({ filename: "demo", mimeType: "video/mp4" }), true);
  assert.equal(isVideoPreviewAttachment({ filename: "demo.webm", mimeType: "application/octet-stream" }), true);
  assert.equal(isVideoPreviewAttachment({ filename: "demo", mimeType: "video/webm" }), true);
  assert.equal(isVideoPreviewAttachment({ filename: "demo.mov", mimeType: "application/octet-stream" }), true);
  assert.equal(isVideoPreviewAttachment({ filename: "demo", mimeType: "video/quicktime" }), true);
});

test("isAudioPreviewAttachment classifies supported audio previews by filename and MIME", () => {
  for (const filename of ["voice.mp3", "voice.wav", "voice.m4a", "voice.aac", "voice.ogg", "voice.oga", "voice.opus", "voice.weba", "voice.flac"]) {
    assert.equal(isAudioPreviewAttachment({ filename, mimeType: "application/octet-stream" }), true, filename);
  }
  for (const mimeType of ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave", "audio/aac", "audio/mp4", "audio/x-m4a", "audio/ogg", "audio/opus", "audio/webm", "audio/flac", "audio/x-flac"]) {
    assert.equal(isAudioPreviewAttachment({ filename: "voice", mimeType }), true, mimeType);
  }
  assert.equal(isAudioPreviewAttachment({ filename: "demo.mp4", mimeType: "video/mp4" }), false);
  assert.equal(isAudioPreviewAttachment({ filename: "voice.aiff", mimeType: "audio/aiff" }), false);
});
