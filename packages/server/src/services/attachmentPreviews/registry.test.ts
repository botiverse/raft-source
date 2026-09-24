import assert from "node:assert/strict";
import { test } from "vitest";
import { attachmentPreviewProviders, isAttachmentPreviewTruncated } from "./registry.js";

test("attachment preview providers are ordered and declare resource/trust contract", () => {
  assert.deepEqual(attachmentPreviewProviders.map((provider) => provider.kind), ["diff", "csv", "xlsx", "markdown", "pdf", "text"]);
  for (const provider of attachmentPreviewProviders) {
    assert.ok(provider.trustLevel === "data" || provider.trustLevel === "sandbox");
    assert.ok(provider.streamByteCap > 0);
    assert.ok(provider.payloadByteCap > 0);
  }
});

test("CSV previews trimmed for payload budget are reported as truncated", () => {
  assert.equal(isAttachmentPreviewTruncated({
    kind: "csv",
    delimiter: ",",
    headers: ["name"],
    rows: [["alpha"]],
    rowCount: 3,
    columnCount: 1,
  }, false), true);
});

test("non-CSV previews still use stream truncation as their truncation signal", () => {
  assert.equal(isAttachmentPreviewTruncated({ kind: "text", text: "hello" }, false), false);
  assert.equal(isAttachmentPreviewTruncated({ kind: "text", text: "hello" }, true), true);
});

test("XLSX sheet truncation is preserved in the shared response signal", () => {
  assert.equal(isAttachmentPreviewTruncated({
    kind: "xlsx",
    sheets: [{ name: "Data", headers: ["A"], rows: [["1"]], rowCount: 3, columnCount: 1, truncated: true }],
    sheetCount: 1,
    truncated: true,
  }, false), true);
});
