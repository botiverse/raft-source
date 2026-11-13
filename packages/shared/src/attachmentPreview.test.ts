import assert from "node:assert/strict";
import { isTextPreviewCandidate, MARKDOWN_PREVIEW_BYTE_LIMIT, MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT, previewPrefixAtLineBoundary, summarizeAttachmentPreviewResponse } from "./attachmentPreview";

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

test("previewPrefixAtLineBoundary cuts a truncated prefix after its last whole line", () => {
  const encoder = new TextEncoder();
  const decode = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assert.equal(decode(previewPrefixAtLineBoundary(encoder.encode("# Title\n\n| a | b |\n| --- | --- |\npartial li"))), "# Title\n\n| a | b |\n| --- | --- |\n");
  assert.equal(decode(previewPrefixAtLineBoundary(encoder.encode("ends on a line\n"))), "ends on a line\n");
  // CRLF files keep their \r with the line it ends.
  assert.equal(decode(previewPrefixAtLineBoundary(encoder.encode("one\r\ntwo\r\nthr"))), "one\r\ntwo\r\n");
});

test("previewPrefixAtLineBoundary never splits a UTF-8 character when there is no newline", () => {
  const encoder = new TextEncoder();
  const whole = encoder.encode("日本語🙂");
  // Every cut inside the last character falls back to the previous character.
  for (let cut = whole.length - 3; cut < whole.length; cut += 1) {
    const prefix = previewPrefixAtLineBoundary(whole.subarray(0, cut));
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(prefix), "日本語");
  }
  assert.equal(previewPrefixAtLineBoundary(whole).length, whole.length);
  assert.equal(previewPrefixAtLineBoundary(encoder.encode("ascii")).length, 5);
  assert.equal(previewPrefixAtLineBoundary(new Uint8Array()).length, 0);
});

test("the markdown preview limit is the operative cap, the payload cap only a safety net", () => {
  assert.equal(MARKDOWN_PREVIEW_BYTE_LIMIT, 512 * 1024);
  assert.ok(MARKDOWN_PREVIEW_PAYLOAD_BYTE_LIMIT >= 2 * MARKDOWN_PREVIEW_BYTE_LIMIT);
});

test("summarizeAttachmentPreviewResponse keeps only what an attachment card shows", () => {
  const markdown = "# Report\n".repeat(50_000);
  assert.deepEqual(
    summarizeAttachmentPreviewResponse({ status: "ok", data: { kind: "markdown", markdown, previewByteLength: 1, sourceByteLength: 2 }, truncated: true }),
    { status: "ok", data: { kind: "markdown" }, truncated: true },
  );
  assert.deepEqual(
    summarizeAttachmentPreviewResponse({ status: "ok", data: { kind: "text", text: "x" }, truncated: false }),
    { status: "ok", data: { kind: "text" }, truncated: false },
  );
  assert.deepEqual(
    summarizeAttachmentPreviewResponse({ status: "ok", data: { kind: "csv", delimiter: ",", headers: ["a", "b"], rows: [["1", "2"], ["3", "4"]], rowCount: 9, columnCount: 2 }, truncated: true }),
    { status: "ok", data: { kind: "csv", rowsShown: 2, rowCount: 9, columnCount: 2 }, truncated: true },
  );
  const stats = { files: 1, hunks: 2, additions: 3, deletions: 4 };
  assert.deepEqual(summarizeAttachmentPreviewResponse({ status: "ok", data: { kind: "diff", stats } }), { status: "ok", data: { kind: "diff", stats } });
  assert.deepEqual(summarizeAttachmentPreviewResponse({ status: "unsupported", reason: "too_large" }), { status: "unsupported", reason: "too_large" });
});
