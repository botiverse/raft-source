import type { AttachmentPreviewData, AttachmentPreviewResponse, XlsxAttachmentPreviewData } from "@botiverse/raft-shared";
import { getStorage } from "../storageService";
import { WorkerCircuitOpen, WorkerCrashed, WorkerPoolBusy, WorkerTaskTimeout } from "../workerPool/errors";
import { getServerWorkerPool } from "../workerPool/serverWorkerPool";
import type { WorkerPoolService } from "../workerPool/workerPoolService";
import { readStreamPrefix } from "./utils";
import type { AttachmentPreviewProvider } from "./types";
import { XLSX_PREVIEW_WORKER_KIND } from "./workerBootstrap";
import { diffPatchPreviewProvider } from "./providers/diffPatch";
import { csvPreviewProvider } from "./providers/csv";
import { isXlsxAttachment, xlsxPreviewProvider } from "./providers/xlsx";
import { markdownPreviewProvider } from "./providers/markdown";
import { pdfPreviewProvider } from "./providers/pdf";
import { textPreviewProvider } from "./providers/text";
import type { ResolvedAttachment } from "../attachmentRecord";

// Preview providers are ordered by specificity. The first matching provider
// owns the response shape, so generic text-like previews should stay last.
// Preview JSON is intentionally on-demand and recomputable; expensive upload-
// time artifacts such as image thumbnails remain attachment-row fields.
export const attachmentPreviewProviders: AttachmentPreviewProvider[] = [
  diffPatchPreviewProvider,
  csvPreviewProvider,
  xlsxPreviewProvider,
  markdownPreviewProvider,
  pdfPreviewProvider,
  textPreviewProvider,
];

export function getAttachmentPreviewProvider(attachment: ResolvedAttachment): AttachmentPreviewProvider | null {
  return attachmentPreviewProviders.find((provider) => provider.canPreview(attachment)) ?? null;
}

export function isAttachmentPreviewTruncated(data: AttachmentPreviewData, streamTruncated: boolean): boolean {
  return streamTruncated || (data.kind === "csv" && data.rows.length < data.rowCount)
    || (data.kind === "xlsx" && (
      data.truncated
      || data.sheets.length < data.sheetCount
      || data.sheets.some((sheet) => sheet.truncated || sheet.rows.length < sheet.rowCount)
    ));
}

/**
 * Where a preview build spent its time, filled in by
 * `buildAttachmentPreviewResponse`. `fetchMs` is the storage download (async
 * I/O, never blocks the event loop); `parseMs` is building the preview from the
 * bytes, the part the cache exists to avoid repeating.
 */
export interface AttachmentPreviewBuildTimings {
  fetchMs?: number;
  parseMs?: number;
}

export interface AttachmentPreviewBuildDeps {
  /** Pool injection for tests; the default is the server's shared pool. */
  workerPool?: Pick<WorkerPoolService, "submit">;
  /** Receives the fetch/parse split when given. */
  timings?: AttachmentPreviewBuildTimings;
  now?: () => number;
}

/**
 * Xlsx parsing runs through the worker pool (its first consumer) so zip
 * inflate + SheetJS stay off the request event loop. Queue-full, enqueue/task
 * timeout, worker crash and circuit-open all degrade to the SAME transient
 * response — an interactive caller never sees a 5xx from pool saturation, and
 * the cache must not pin the outage (previewCache skips reason "unavailable").
 * A handler error (a buildXlsxPreview bug) is not pool backpressure: it
 * propagates as a real failure.
 */
async function buildXlsxPreviewWithPool(buffer: Buffer, workerPool: Pick<WorkerPoolService, "submit">): Promise<XlsxAttachmentPreviewData | null | "unavailable"> {
  try {
    return await workerPool.submit<XlsxAttachmentPreviewData | null>(XLSX_PREVIEW_WORKER_KIND, buffer);
  } catch (error) {
    if (error instanceof WorkerPoolBusy || error instanceof WorkerTaskTimeout
      || error instanceof WorkerCrashed || error instanceof WorkerCircuitOpen) {
      return "unavailable";
    }
    throw error;
  }
}

export async function buildAttachmentPreviewResponse(
  attachment: ResolvedAttachment,
  deps: AttachmentPreviewBuildDeps = {},
): Promise<AttachmentPreviewResponse> {
  const provider = getAttachmentPreviewProvider(attachment);
  if (!provider) {
    return {
      status: "unsupported",
      reason: isXlsxAttachment(attachment.filename, attachment.mimeType) ? "too_large" : "unsupported",
    };
  }

  const storage = getStorage();
  if (!storage) throw new Error("File storage is not configured on this server");

  const now = deps.now ?? (() => performance.now());
  const fetchStarted = now();
  const stream = await storage.get(attachment.storageKey);
  const { buffer, truncated } = await readStreamPrefix(stream, provider.streamByteCap);
  const parseStarted = now();
  if (deps.timings) deps.timings.fetchMs = Math.round(parseStarted - fetchStarted);
  const recordParse = () => { if (deps.timings) deps.timings.parseMs = Math.round(now() - parseStarted); };
  const data = provider.kind === "xlsx"
    ? await buildXlsxPreviewWithPool(buffer, deps.workerPool ?? getServerWorkerPool())
    : await provider.buildPreview({ attachment, buffer, truncated });
  if (data === "unavailable") { recordParse(); return { status: "unsupported", reason: "unavailable" }; }
  if (!data) recordParse();
  if (!data) return {
    status: "unsupported",
    reason: provider.kind === "xlsx" ? "unreadable" : "unsupported",
  };

  const payloadSize = Buffer.byteLength(JSON.stringify(data), "utf8");
  recordParse();
  if (payloadSize > provider.payloadByteCap) return { status: "unsupported", reason: "too_large" };

  return { status: "ok", data, truncated: isAttachmentPreviewTruncated(data, truncated) };
}
