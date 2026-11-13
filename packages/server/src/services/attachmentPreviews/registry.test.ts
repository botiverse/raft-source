import assert from "node:assert/strict";
import { Readable } from "node:stream";
import * as XLSX from "xlsx";
import type { ResolvedAttachment } from "../attachmentRecord";
import { __setStorageForTests, resetStorageForTests } from "../storageService";
import { WorkerCircuitOpen, WorkerCrashed, WorkerPoolBusy, WorkerTaskTimeout } from "../workerPool/errors";
import { attachmentPreviewProviders, buildAttachmentPreviewResponse, isAttachmentPreviewTruncated } from "./registry";
import { buildXlsxPreview } from "./providers/xlsx";
import { XLSX_PREVIEW_WORKER_KIND } from "./workerBootstrap";
import { MARKDOWN_PREVIEW_BYTE_LIMIT } from "./providers/markdown";
import { TEXT_PREVIEW_BYTE_LIMIT } from "./providers/text";

type Attachment = ResolvedAttachment;

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

// --- Worker-pool routing (xlsx is the pool's first consumer) -----------------

const xlsxPoolAttachment = {
  filename: "scores.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 1024,
  storageKey: "srv/att/scores.xlsx",
} as Attachment;

function workbookBuffer(): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Name", "Score"], ["Alice", 10]]), "Scores");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function storageReturning(buffer: Buffer): void {
  __setStorageForTests({
    async put() {},
    async get() { return Readable.from([buffer]); },
    async delete() {},
  });
}

function recordingPool(result: (payload: unknown) => unknown) {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const workerPool = {
    submit: <T>(kind: string, payload: unknown): Promise<T> => {
      calls.push({ kind, payload });
      return Promise.resolve(result(payload) as T);
    },
  };
  return { workerPool, calls };
}

function rejectingPool(error: unknown) {
  return { submit: <T>(): Promise<T> => Promise.reject(error) };
}

test("xlsx previews are submitted to the worker pool, other providers stay direct", async () => {
  storageReturning(workbookBuffer());
  try {
    const { workerPool, calls } = recordingPool((payload) => buildXlsxPreview(payload as Buffer));
    const response = await buildAttachmentPreviewResponse(xlsxPoolAttachment, { workerPool });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, XLSX_PREVIEW_WORKER_KIND);
    assert.ok(Buffer.isBuffer(calls[0].payload));
    assert.equal(response.status, "ok");
    if (response.status === "ok") assert.equal(response.data.kind, "xlsx");

    // A non-xlsx provider never touches the pool: this fake fails if used.
    const csvAttachment = {
      filename: "export.csv",
      mimeType: "text/csv",
      sizeBytes: 1024,
      storageKey: "srv/att/export.csv",
    } as Attachment;
    storageReturning(Buffer.from("name,count\nalpha,1\n", "utf8"));
    const csvResponse = await buildAttachmentPreviewResponse(csvAttachment, {
      workerPool: rejectingPool(new Error("pool must not be used")),
    });
    assert.equal(csvResponse.status, "ok");
    if (csvResponse.status === "ok") assert.equal(csvResponse.data.kind, "csv");
  } finally {
    resetStorageForTests();
  }
});

test("pool busy, task timeout, worker crash and circuit-open all degrade to the same transient unavailable", async () => {
  storageReturning(workbookBuffer());
  try {
    for (const error of [
      new WorkerPoolBusy(XLSX_PREVIEW_WORKER_KIND, "queue_full", "queue full"),
      new WorkerPoolBusy(XLSX_PREVIEW_WORKER_KIND, "enqueue_timeout", "enqueue deadline"),
      new WorkerTaskTimeout(XLSX_PREVIEW_WORKER_KIND, 8000),
      new WorkerCrashed("worker exited unexpectedly with code 1"),
      new WorkerCircuitOpen(XLSX_PREVIEW_WORKER_KIND),
    ]) {
      const response = await buildAttachmentPreviewResponse(xlsxPoolAttachment, { workerPool: rejectingPool(error) });
      assert.deepEqual(response, { status: "unsupported", reason: "unavailable" });
    }
  } finally {
    resetStorageForTests();
  }
});

test("a handler failure inside the pool is not swallowed as backpressure", async () => {
  storageReturning(workbookBuffer());
  try {
    await assert.rejects(
      buildAttachmentPreviewResponse(xlsxPoolAttachment, { workerPool: rejectingPool(new Error("sheetjs exploded")) }),
      /sheetjs exploded/,
    );
  } finally {
    resetStorageForTests();
  }
});

test("an unparseable workbook from the pool stays unreadable, not unavailable", async () => {
  storageReturning(workbookBuffer());
  try {
    const { workerPool, calls } = recordingPool(() => null);
    const response = await buildAttachmentPreviewResponse(xlsxPoolAttachment, { workerPool });
    assert.equal(calls.length, 1);
    assert.deepEqual(response, { status: "unsupported", reason: "unreadable" });
  } finally {
    resetStorageForTests();
  }
});

// No injected pool: the default singleton resolves the in-process executor
// under tests (NODE_ENV=test), so this pins the whole main-thread wiring —
// handler registration, kind timeout config and submission — without a thread.
test("the default pool wiring builds an xlsx preview end to end", async () => {
  storageReturning(workbookBuffer());
  try {
    const response = await buildAttachmentPreviewResponse(xlsxPoolAttachment);
    assert.equal(response.status, "ok");
    if (response.status === "ok") {
      assert.equal(response.data.kind, "xlsx");
      if (response.data.kind === "xlsx") {
        assert.deepEqual(response.data.sheets[0], {
          name: "Scores",
          headers: ["Name", "Score"],
          rows: [["Alice", "10"]],
          rowCount: 1,
          columnCount: 2,
          truncated: false,
        });
      }
    }
  } finally {
    resetStorageForTests();
  }
});

test("a build reports the storage download and the parse separately", async () => {
  // Scripted clock: 0 start, 40 after the download, 47 after the parse.
  const ticks = [0, 40, 47];
  const now = () => ticks.shift() ?? 47;
  const textAttachment = { filename: "notes.txt", mimeType: "text/plain", sizeBytes: 12, storageKey: "srv/att/notes.txt" } as Attachment;
  storageReturning(Buffer.from("hello world\n", "utf8"));
  try {
    const timings: { fetchMs?: number; parseMs?: number } = {};
    const response = await buildAttachmentPreviewResponse(textAttachment, { timings, now });
    assert.equal(response.status, "ok");
    assert.deepEqual(timings, { fetchMs: 40, parseMs: 7 });
  } finally {
    resetStorageForTests();
  }
});

// Task #164: markdown over the limit used to be refused (`too_large`) and the
// viewer silently downloaded it. It now previews a line-cut prefix.
function markdownOfBytes(targetBytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < targetBytes; i += 1) {
    const line = i % 10 === 0 ? `## Section ${i}` : `- item ${i}: \`code\` and "quoted" text ✓`;
    lines.push(line);
    size += Buffer.byteLength(line, "utf8") + 1;
  }
  return lines.join("\n") + "\n";
}

test("markdown under the preview limit is returned whole and not truncated", async () => {
  const source = markdownOfBytes(MARKDOWN_PREVIEW_BYTE_LIMIT - 4 * 1024);
  const bytes = Buffer.from(source, "utf8");
  assert.ok(bytes.byteLength > 64 * 1024, "covers the old 64 KB refusal");
  const attachment = { filename: "report.md", mimeType: "text/markdown", sizeBytes: bytes.byteLength, storageKey: "srv/att/report.md" } as Attachment;
  storageReturning(bytes);
  try {
    const response = await buildAttachmentPreviewResponse(attachment);
    assert.deepEqual(response, { status: "ok", data: { kind: "markdown", markdown: source.trim() }, truncated: false });
  } finally {
    resetStorageForTests();
  }
});

test("markdown over the preview limit returns a prefix cut at a whole line, flagged truncated with sizes", async () => {
  const source = markdownOfBytes(3 * MARKDOWN_PREVIEW_BYTE_LIMIT);
  const bytes = Buffer.from(source, "utf8");
  const attachment = { filename: "report.md", mimeType: "text/markdown", sizeBytes: bytes.byteLength, storageKey: "srv/att/report.md" } as Attachment;
  storageReturning(bytes);
  try {
    const response = await buildAttachmentPreviewResponse(attachment);
    assert.equal(response.status, "ok");
    if (response.status !== "ok" || response.data.kind !== "markdown") throw new Error("expected a markdown preview");
    assert.equal(response.truncated, true);
    const { markdown, previewByteLength, sourceByteLength } = response.data;
    assert.equal(sourceByteLength, bytes.byteLength);
    assert.ok(previewByteLength !== undefined && previewByteLength <= MARKDOWN_PREVIEW_BYTE_LIMIT);
    assert.ok(previewByteLength > MARKDOWN_PREVIEW_BYTE_LIMIT - 100, "cut at the last line before the cap, not earlier");
    // A whole-line prefix of the original: the shown bytes end on a newline
    // and every shown line is a complete line of the source.
    assert.equal(bytes.subarray(previewByteLength - 1, previewByteLength).toString("utf8"), "\n");
    assert.equal(markdown, bytes.subarray(0, previewByteLength).toString("utf8").trim());
    assert.ok(source.startsWith(`${markdown}\n`));
    assert.ok(!markdown.includes("�"), "no split UTF-8 character at the cut");
  } finally {
    resetStorageForTests();
  }
});

test("a truncated text preview ends on a whole line, so a split character cannot void it", async () => {
  // ✓ is three bytes; pad so the byte cap lands inside one.
  const line = "check ✓ ok\n";
  const repeated = line.repeat(Math.ceil((TEXT_PREVIEW_BYTE_LIMIT + 2 * line.length) / Buffer.byteLength(line)));
  const bytes = Buffer.from(`${"x".repeat(4)}${repeated}`, "utf8");
  assert.equal(bytes[TEXT_PREVIEW_BYTE_LIMIT]! & 0xc0, 0x80, "the cap falls inside a multi-byte character");
  const attachment = { filename: "build.log", mimeType: "text/plain", sizeBytes: bytes.byteLength, storageKey: "srv/att/build.log" } as Attachment;
  storageReturning(bytes);
  try {
    const response = await buildAttachmentPreviewResponse(attachment);
    assert.equal(response.status, "ok");
    if (response.status !== "ok" || response.data.kind !== "text") throw new Error("expected a text preview");
    assert.equal(response.truncated, true);
    assert.ok(response.data.text.endsWith("check ✓ ok\n"));
  } finally {
    resetStorageForTests();
  }
});
