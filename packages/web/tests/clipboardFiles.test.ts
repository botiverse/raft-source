import assert from "node:assert/strict";
import test from "node:test";
import { extractClipboardFiles } from "../src/utils/clipboardFiles.js";

function makeFile(name: string, type: string, body = "x", lastModified = 1): File {
  return new File([body], name, { type, lastModified });
}

test("extractClipboardFiles returns file-kind clipboard items", () => {
  const image = makeFile("image.png", "image/png");
  const pdf = makeFile("doc.pdf", "application/pdf");

  const files = extractClipboardFiles({
    items: [
      { kind: "string", getAsFile: () => null },
      { kind: "file", getAsFile: () => image },
      { kind: "file", getAsFile: () => pdf },
    ],
  });

  assert.deepEqual(files.map((file) => file.name), ["image.png", "doc.pdf"]);
});

test("extractClipboardFiles falls back to clipboardData.files and de-dupes repeats", () => {
  const copiedFile = makeFile("report.txt", "text/plain", "report");

  const files = extractClipboardFiles({
    items: [{ kind: "file", getAsFile: () => copiedFile }],
    files: [copiedFile],
  });

  assert.equal(files.length, 1);
  assert.equal(files[0]?.name, "report.txt");
});

test("extractClipboardFiles de-dupes the same clipboard image even when lastModified differs", () => {
  const itemImage = makeFile("image.png", "image/png", "same-image", 1);
  const fallbackImage = makeFile("image.png", "image/png", "same-image", 2);

  const files = extractClipboardFiles({
    items: [{ kind: "file", getAsFile: () => itemImage }],
    files: [fallbackImage],
  });

  assert.equal(files.length, 1);
  assert.equal(files[0], itemImage);
});

test("extractClipboardFiles returns empty for text-only paste", () => {
  const files = extractClipboardFiles({
    items: [{ kind: "string", getAsFile: () => null }],
    files: [],
  });

  assert.deepEqual(files, []);
});
