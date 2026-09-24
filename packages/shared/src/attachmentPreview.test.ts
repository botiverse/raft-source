import assert from "node:assert/strict";
import test from "node:test";
import { isTextPreviewCandidate } from "./attachmentPreview.js";

test("isTextPreviewCandidate classifies shared text preview formats", () => {
  assert.equal(isTextPreviewCandidate("notes.txt", "application/octet-stream"), true);
  assert.equal(isTextPreviewCandidate("build.log", "application/octet-stream"), true);
  assert.equal(isTextPreviewCandidate("data.json", "application/octet-stream"), true);
  assert.equal(isTextPreviewCandidate("payload", "application/json"), true);
  assert.equal(isTextPreviewCandidate("service.yml", null), true);
  assert.equal(isTextPreviewCandidate("readme", "text/x-readme"), true);

  assert.equal(isTextPreviewCandidate("notes.md", "text/markdown"), false);
  assert.equal(isTextPreviewCandidate("table.csv", "text/csv"), false);
  assert.equal(isTextPreviewCandidate("page", "text/html"), false);
  assert.equal(isTextPreviewCandidate("page.html", "application/octet-stream"), false);
  assert.equal(isTextPreviewCandidate("archive.zip", "application/octet-stream"), false);
});
