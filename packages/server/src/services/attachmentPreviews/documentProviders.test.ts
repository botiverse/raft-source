import assert from "node:assert/strict";
import { test } from "vitest";
import { CSV_PREVIEW_MAX_FILE_SIZE_BYTES } from "@botiverse/raft-shared";
import { buildCsvPreview, CSV_PREVIEW_MAX_ROWS, CSV_PREVIEW_PAYLOAD_BYTE_LIMIT, csvPreviewProvider, isCsvAttachment, parseCsvRows } from "./providers/csv.js";
import { buildMarkdownPreview, isMarkdownAttachment, markdownPreviewProvider } from "./providers/markdown.js";
import { isPdfAttachment, pdfPreviewProvider } from "./providers/pdf.js";
import { buildTextPreview, decodeUtf8Text, isTextAttachment, textPreviewProvider } from "./providers/text.js";
import { buildXlsxPreview, isXlsxAttachment, xlsxPreviewProvider, XLSX_PREVIEW_MAX_ROWS } from "./providers/xlsx.js";
import * as XLSX from "xlsx";

test("CSV provider classifies by extension and MIME", () => {
  assert.equal(isCsvAttachment("metrics.csv", "application/octet-stream"), true);
  assert.equal(isCsvAttachment("metrics", "text/csv; charset=utf-8"), true);
  assert.equal(isCsvAttachment("metrics.xls", "application/vnd.ms-excel"), false);
  assert.equal(isCsvAttachment("metrics.xls", "text/csv"), false);
  assert.equal(isCsvAttachment("metrics", "application/vnd.ms-excel"), false);
  assert.equal(isCsvAttachment("notes.md", "text/markdown"), false);
});

test("CSV provider rejects binary legacy Excel bytes instead of rendering a table", async () => {
  const legacyExcelHeader = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);

  assert.equal(await csvPreviewProvider.buildPreview({
    attachment: { filename: "legacy.xls", mimeType: "application/vnd.ms-excel" } as never,
    buffer: legacyExcelHeader,
    truncated: false,
  }), null);
});

test("CSV provider rejects malformed UTF-8 and binary control characters", async () => {
  const attachment = { filename: "export.csv", mimeType: "application/vnd.ms-excel" } as never;

  assert.equal(await csvPreviewProvider.buildPreview({
    attachment,
    buffer: Buffer.from([0xc3, 0x28]),
    truncated: false,
  }), null);
  assert.equal(await csvPreviewProvider.buildPreview({
    attachment,
    buffer: Buffer.from("name\nalpha\u0000\n", "utf8"),
    truncated: false,
  }), null);
});

test("CSV provider keeps text CSV labelled as legacy Excel MIME previewable", async () => {
  assert.equal(csvPreviewProvider.canPreview({
    filename: "legacy.xls",
    mimeType: "application/vnd.ms-excel",
    sizeBytes: 1024,
  } as never), false);
  assert.equal(csvPreviewProvider.canPreview({
    filename: "export.csv",
    mimeType: "application/vnd.ms-excel",
    sizeBytes: 1024,
  } as never), true);
  assert.deepEqual(await csvPreviewProvider.buildPreview({
    attachment: { filename: "export.csv", mimeType: "application/vnd.ms-excel" } as never,
    buffer: Buffer.from("name,count\nalpha,1\n", "utf8"),
    truncated: false,
  }), {
    kind: "csv",
    delimiter: ",",
    headers: ["name", "count"],
    rows: [["alpha", "1"]],
    rowCount: 1,
    columnCount: 2,
  });
});

test("XLSX provider classifies and returns bounded multi-sheet cell data", () => {
  assert.equal(isXlsxAttachment("book.xlsx", "application/octet-stream"), true);
  assert.equal(isXlsxAttachment("book", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), true);
  assert.equal(isXlsxAttachment("book.xls", "application/vnd.ms-excel"), false);
  const workbook = XLSX.utils.book_new();
  const firstRows = [["Name", "Score"], ["Alice", 10], ["Bob", 20]];
  const first = XLSX.utils.aoa_to_sheet(firstRows);
  XLSX.utils.book_append_sheet(workbook, first, "Scores");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Note"], ["ready"]]), "Notes");
  const preview = buildXlsxPreview(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  assert.ok(preview);
  assert.equal(preview.kind, "xlsx");
  assert.equal(preview.sheetCount, 2);
  assert.deepEqual(preview.sheets[0], {
    name: "Scores",
    headers: ["Name", "Score"],
    rows: [["Alice", "10"], ["Bob", "20"]],
    rowCount: 2,
    columnCount: 2,
    truncated: false,
  });
  assert.equal(preview.sheets[1]?.name, "Notes");
});

test("XLSX preview does not expose formulas and truncates oversized sheets", () => {
  const workbook = XLSX.utils.book_new();
  const rows: unknown[][] = [["Value"]];
  for (let i = 0; i < XLSX_PREVIEW_MAX_ROWS + 20; i += 1) rows.push([i]);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet.A2.f = "SUM(A1:A2)";
  XLSX.utils.book_append_sheet(workbook, sheet, "Data");
  const preview = buildXlsxPreview(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  assert.ok(preview);
  assert.equal(preview.truncated, true);
  assert.equal(preview.sheets[0]?.rows.length, XLSX_PREVIEW_MAX_ROWS);
  assert.equal(preview.sheets[0]?.rows[0]?.[0], "0");
  assert.equal(JSON.stringify(preview).includes("SUM(A1:A2)"), false);
  assert.equal(xlsxPreviewProvider.canPreview({ filename: "large.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sizeBytes: 10 * 1024 * 1024 + 1 } as never), false);
});

test("XLSX preview preserves middle blank rows without false truncation", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["Value"],
    ["A"],
    [],
    ["B"],
  ]), "Sparse");

  const preview = buildXlsxPreview(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  assert.ok(preview);
  assert.deepEqual(preview.sheets[0], {
    name: "Sparse",
    headers: ["Value"],
    rows: [["A"], [""], ["B"]],
    rowCount: 3,
    columnCount: 1,
    truncated: false,
  });
});

test("XLSX preview fails closed for corrupt bytes and keeps an empty sheet as an empty state", () => {
  assert.equal(buildXlsxPreview(Buffer.from("not a zip")), null);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([]), "Empty");
  const preview = buildXlsxPreview(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  assert.ok(preview);
  assert.deepEqual(preview.sheets[0], {
    name: "Empty",
    headers: [],
    rows: [],
    rowCount: 0,
    columnCount: 0,
    truncated: false,
  });
});

test("CSV parser handles quoted fields", () => {
  assert.deepEqual(parseCsvRows('name,count\n"hello, world",2\n"escaped ""quote""",3\n'), [
    ["name", "count"],
    ["hello, world", "2"],
    ['escaped "quote"', "3"],
  ]);
});

test("CSV preview returns bounded headers and rows", () => {
  const preview = buildCsvPreview("name,count,owner\nalpha,1,koda\nbeta,2,martin\n");
  assert.deepEqual(preview, {
    kind: "csv",
    delimiter: ",",
    headers: ["name", "count", "owner"],
    rows: [["alpha", "1", "koda"], ["beta", "2", "martin"]],
    rowCount: 2,
    columnCount: 3,
  });
});

test("CSV preview accepts one-column CSV files", () => {
  assert.deepEqual(buildCsvPreview("email\nalpha@example.com\nbeta@example.com\n"), {
    kind: "csv",
    delimiter: ",",
    headers: ["email"],
    rows: [["alpha@example.com"], ["beta@example.com"]],
    rowCount: 2,
    columnCount: 1,
  });
});

test("CSV preview trims rows to stay within the preview payload budget", () => {
  const longCell = "x".repeat(160);
  const csv = [
    "name,email,notes",
    ...Array.from({ length: CSV_PREVIEW_MAX_ROWS }, (_, index) => (
      `candidate-${index},candidate-${index}@example.com,${longCell}-${index}`
    )),
  ].join("\n");
  const preview = buildCsvPreview(csv);

  assert.ok(preview);
  assert.equal(preview.rowCount, CSV_PREVIEW_MAX_ROWS);
  assert.ok(preview.rows.length > 0);
  assert.ok(preview.rows.length < CSV_PREVIEW_MAX_ROWS);
  assert.ok(Buffer.byteLength(JSON.stringify(preview), "utf8") <= CSV_PREVIEW_PAYLOAD_BYTE_LIMIT);
});

test("CSV preview refuses payloads that cannot include any data rows within budget", () => {
  const hugeCell = "x".repeat(CSV_PREVIEW_PAYLOAD_BYTE_LIMIT);

  assert.equal(buildCsvPreview(`name,notes\nalpha,${hugeCell}`), null);
});

test("CSV preview refuses files above the hard size threshold", () => {
  assert.equal(csvPreviewProvider.canPreview({
    filename: "metrics.csv",
    mimeType: "text/csv",
    sizeBytes: CSV_PREVIEW_MAX_FILE_SIZE_BYTES,
  } as never), true);
  assert.equal(csvPreviewProvider.canPreview({
    filename: "metrics.csv",
    mimeType: "text/csv",
    sizeBytes: CSV_PREVIEW_MAX_FILE_SIZE_BYTES + 1,
  } as never), false);
});

test("Markdown provider classifies and preserves raw markdown as data", async () => {
  assert.equal(isMarkdownAttachment("README.md", "text/plain"), true);
  assert.equal(isMarkdownAttachment("README", "text/markdown"), true);
  assert.deepEqual(buildMarkdownPreview("# Title\n\n<script>alert(1)</script>"), {
    kind: "markdown",
    markdown: "# Title\n\n<script>alert(1)</script>",
  });
  assert.deepEqual(await markdownPreviewProvider.buildPreview({ attachment: { filename: "x.md", mimeType: "text/markdown" } as never, buffer: Buffer.from("hello"), truncated: false }), {
    kind: "markdown",
    markdown: "hello",
  });
});

test("PDF provider classifies by type but only previews real PDF signatures", async () => {
  assert.equal(isPdfAttachment("paper.pdf", "application/octet-stream"), true);
  assert.equal(isPdfAttachment("paper", "application/pdf"), true);
  assert.deepEqual(await pdfPreviewProvider.buildPreview({ attachment: { filename: "paper.pdf", mimeType: "application/pdf" } as never, buffer: Buffer.from("%PDF"), truncated: true }), { kind: "pdf" });
  assert.equal(await pdfPreviewProvider.buildPreview({ attachment: { filename: "paper.pdf", mimeType: "application/pdf" } as never, buffer: Buffer.from("nope"), truncated: false }), null);
});

test("Text provider classifies txt/plain attachments and preserves plain text", async () => {
  assert.equal(isTextAttachment("notes.txt", "application/octet-stream"), true);
  assert.equal(isTextAttachment("notes", "text/plain; charset=utf-8"), true);
  assert.equal(isTextAttachment("notes.md", "text/markdown"), false);
  // Broadened whitelist: common text-like extensions with generic MIME.
  assert.equal(isTextAttachment("build.log", "application/octet-stream"), true);
  assert.equal(isTextAttachment("Config.kt", "application/octet-stream"), true);
  assert.equal(isTextAttachment("service.yml", null), true);
  assert.equal(isTextAttachment("data.json", "application/json"), true);
  assert.equal(isTextAttachment("readme", "text/x-readme"), true);
  // Types owned by other providers or the sandboxed HTML path stay excluded.
  assert.equal(isTextAttachment("table.csv", "text/csv"), false); // csvProvider owns csv
  assert.equal(isTextAttachment("page", "text/html"), false);
  assert.equal(isTextAttachment("page.html", "application/octet-stream"), false);
  assert.equal(isTextAttachment("archive.zip", "application/octet-stream"), false);
  assert.deepEqual(buildTextPreview("hello\nworld"), {
    kind: "text",
    text: "hello\nworld",
  });
  assert.deepEqual(await textPreviewProvider.buildPreview({ attachment: { filename: "x.txt", mimeType: "text/plain" } as never, buffer: Buffer.from("hello"), truncated: false }), {
    kind: "text",
    text: "hello",
  });
});

test("Text provider refuses invalid UTF-8 and empty text", () => {
  assert.equal(decodeUtf8Text(Buffer.from([0xff, 0xfe, 0xfd])), null);
  assert.equal(buildTextPreview(" \n\t"), null);
});

test("document providers expose resource and trust contracts", () => {
  assert.equal(csvPreviewProvider.trustLevel, "data");
  assert.equal(markdownPreviewProvider.trustLevel, "data");
  assert.equal(pdfPreviewProvider.trustLevel, "sandbox");
  assert.equal(textPreviewProvider.trustLevel, "data");
});
