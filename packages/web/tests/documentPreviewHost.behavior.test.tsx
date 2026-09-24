import "./helpers/domSetup";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import DocumentPreviewHost from "../src/components/message/DocumentPreviewHost";
import type { DocumentAttachmentPreview } from "../src/components/message/attachmentPreview";
import { useDocumentPreviewStore } from "../src/store/documentPreviewStore";
import { TestIntlProvider } from "./helpers/intl";

afterEach(() => {
  cleanup();
  useDocumentPreviewStore.getState().close();
});

// Protect actual rendered content instead of the retired kind-only registry.
// Diff previews use the separate message diff surface, not this document host.
test("document preview host renders each supported data kind and closes", () => {
  Element.prototype.scrollIntoView ??= () => {};
  render(<MemoryRouter><TestIntlProvider><DocumentPreviewHost /></TestIntlProvider></MemoryRouter>);
  const cases: DocumentAttachmentPreview[] = [
    { kind: "text", text: "Text routing witness" },
    { kind: "markdown", markdown: "# Markdown routing witness" },
    { kind: "csv", delimiter: ",", headers: ["Column"], rows: [["CSV routing witness"]], rowCount: 1, columnCount: 1 },
    { kind: "pdf" },
  ];
  for (const preview of cases) {
    act(() => useDocumentPreviewStore.getState().open({
      attachment: { id: "preview-1", filename: "routing.pdf", mimeType: "application/pdf", sizeBytes: 128 },
      preview,
      truncated: false,
      url: preview.kind === "pdf" ? "https://example.invalid/routing.pdf" : null,
    }));
    if (preview.kind === "text") assert.ok(screen.getByText("Text routing witness"));
    if (preview.kind === "markdown") assert.ok(screen.getByRole("heading", { name: "Markdown routing witness" }));
    if (preview.kind === "csv") assert.ok(screen.getByRole("cell", { name: "CSV routing witness" }));
    if (preview.kind === "pdf") {
      const frame = document.querySelector("iframe");
      assert.equal(frame?.getAttribute("src"), "https://example.invalid/routing.pdf");
      assert.equal(frame?.getAttribute("sandbox"), "allow-scripts");
    }
    act(() => useDocumentPreviewStore.getState().close());
    assert.equal(document.querySelector("iframe"), null);
    assert.equal(screen.queryByText("routing.pdf"), null);
  }
});
