// Attachment operations: upload bytes into a conversation, download an
// attachment (its bytes, or a short-lived URL for runtimes that cannot take
// binary results), list its comments. Upload is the one multipart route in the
// Agent API; it goes through `fetch` + `FormData` (Workers-safe) rather than
// the JSON transport. The Server still requires a `channelId`, so the target
// is resolved first through `POST /resolve-channel`, exactly as the CLI does.

import { foldAgentOneLineText } from "../agentMessageText";
import { z } from "zod";
import { lazySchema } from "../lazySchema";

import type { AgentApiClient } from "../agentApiClient";
import type { AgentApiAttachmentCommentsResponse, AgentApiAttachmentDownloadUrlResponse, AgentApiAttachmentUploadResponse } from "../agentApiContract";
import { agentApiContract } from "../agentApiContract";
import { formatAgentAttachmentComments, formatAgentAttachmentUploaded, type AgentAttachmentCommentRow } from "../agentText/attachments";
import { formatHint, hintStep, RAFT_HINTS, type RaftHintOptions } from "./hint";
import { failureFromClientResult, failureOutcome, opError, opErrorFromClientError, validateOpRequest, type RaftNextStep, type RaftOutcome } from "./outcome";
import { requestSchema } from "./requestSchema";

export const attachmentCommentsRequestSchema = lazySchema("attachmentCommentsRequestSchema", () => requestSchema<{ attachmentId: string; limit?: number }>()(z.object({
  attachmentId: z.string().describe("The attachment id."),
  limit: z.number().int().positive().optional().describe("Maximum comments to return."),
})));

export const downloadAttachmentUrlRequestSchema = lazySchema("downloadAttachmentUrlRequestSchema", () => requestSchema<{ attachmentId: string }>()(z.object({
  attachmentId: z.string().describe("The attachment id, as message lines show it (`id:…`)."),
})));

/** Compatibility fallback for Servers that predate the capability endpoint (the CLI's constant). */
export const AGENT_ATTACHMENT_UPLOAD_FALLBACK_MAX_BYTES = 50 * 1024 * 1024;

const FILENAME_MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
};
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

function sniffMimeType(bytes: Uint8Array): string | null {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.subarray(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Explicit type wins; otherwise sniff the bytes, then the filename extension, then octet-stream. */
export function inferAttachmentMimeType(filename: string, bytes: Uint8Array, explicit?: string | null): string {
  const normalized = explicit?.trim().toLowerCase();
  if (normalized && MIME_TYPE_RE.test(normalized)) return normalized;
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  return sniffMimeType(bytes) ?? FILENAME_MIME_MAP[ext] ?? "application/octet-stream";
}

export interface UploadAttachmentRequest {
  /** Conversation the attachment will be used in: `#channel`, `dm:@peer`, or a thread target. */
  target: string;
  filename: string;
  bytes: Uint8Array;
  /** Explicit MIME type; inferred from the bytes and filename when omitted. */
  mimeType?: string;
}

export interface AttachmentTransport {
  serverUrl: string;
  fetch: typeof fetch;
  headers: Record<string, string>;
  authorization: string;
}

export type RaftAttachmentUploaded = AgentApiAttachmentUploadResponse & { target: string; mimeType: string | null };

/**
 * Upload bytes into a conversation, choosing the path the CLI would: multipart
 * `POST /upload` below the Server's direct-upload threshold, an upload session
 * (create → PUT to a presigned URL → complete) at or above it.
 */
export async function uploadAttachment(
  client: Pick<AgentApiClient, "channels" | "attachments">,
  transport: AttachmentTransport,
  request: UploadAttachmentRequest,
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftAttachmentUploaded, "uploaded">> {
  if (!request.target?.trim() || !request.filename?.trim()) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "A target and a filename are required to upload." }));
  }
  if (!(request.bytes instanceof Uint8Array) || request.bytes.byteLength === 0) {
    return failureOutcome(opError("INVALID_REQUEST", { message: "Refusing to upload a 0-byte attachment." }));
  }
  if (request.mimeType !== undefined && !MIME_TYPE_RE.test(request.mimeType.trim())) {
    return failureOutcome(opError("INVALID_REQUEST", { message: `mimeType must look like type/subtype, got: ${request.mimeType}` }));
  }

  const capability = await client.attachments.uploadCapabilities();
  const maxBytes = capability.ok ? capability.data.maxBytes : AGENT_ATTACHMENT_UPLOAD_FALLBACK_MAX_BYTES;
  const threshold = capability.ok && capability.data.directUploadEnabled ? capability.data.directUploadThresholdBytes : null;
  if (request.bytes.byteLength > maxBytes) {
    return failureOutcome(opError("INVALID_REQUEST", { message: `Attachment is ${request.bytes.byteLength} bytes; the Server's maximum is ${maxBytes}.` }));
  }
  const resolved = await client.channels.resolve({ target: request.target });
  if (!resolved.ok) return failureFromClientResult(resolved);
  const channelId = resolved.data.channelId;
  const mimeType = inferAttachmentMimeType(request.filename, request.bytes, request.mimeType);

  if (threshold !== null && request.bytes.byteLength >= threshold) {
    return uploadThroughSession(client, transport, request, channelId, mimeType, options);
  }

  const copy = new Uint8Array(request.bytes.byteLength);
  copy.set(request.bytes);
  const form = new FormData();
  form.append("file", new Blob([copy.buffer], { type: mimeType }), request.filename);
  form.append("channelId", channelId);
  if (request.mimeType) form.append("mimeType", mimeType);

  const headers = new Headers(transport.headers);
  headers.delete("content-type"); // fetch sets the multipart boundary itself
  headers.set("accept", "application/json");
  headers.set("authorization", transport.authorization);
  let response: Response;
  try {
    response = await transport.fetch(`${transport.serverUrl}${agentApiContract.attachmentUpload.fullPath}`, { method: "POST", headers, body: form });
  } catch {
    return failureOutcome(opError("TRANSPORT_ERROR"));
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const b = (body && typeof body === "object" ? body : {}) as { error?: unknown; errorCode?: unknown; code?: unknown; suggestedNextAction?: unknown };
    return failureOutcome(opErrorFromClientError({
      kind: "http",
      reason: "http_error",
      message: typeof b.error === "string" ? b.error : `HTTP ${response.status}`,
      status: response.status,
      errorCode: typeof b.errorCode === "string" ? b.errorCode : typeof b.code === "string" ? b.code : null,
      suggestedNextAction: typeof b.suggestedNextAction === "string" ? b.suggestedNextAction : null,
    }));
  }
  const parsed = agentApiContract.attachmentUpload.response.body.safeParse(body);
  if (!parsed.success) return failureOutcome(opError("INVALID_RESPONSE"));
  return uploadedOutcome(request.target, parsed.data as AgentApiAttachmentUploadResponse, mimeType, options);
}

function uploadedOutcome(target: string, data: AgentApiAttachmentUploadResponse, mimeType: string, options: RaftHintOptions): RaftOutcome<RaftAttachmentUploaded, "uploaded"> {
  const uploaded: RaftAttachmentUploaded = { ...data, target, mimeType: data.mimeType ?? mimeType };
  const next: RaftNextStep = hintStep(
    "send_with_attachment",
    RAFT_HINTS.messageSend({ target, attachmentId: data.id }),
    "The upload alone posts nothing; send a message that links the attachment id.",
    options.hints,
    { target, attachmentIds: [data.id] },
  );
  return { ok: true, state: "uploaded", data: uploaded, next, text: formatAgentAttachmentUploaded(data, options.hints) };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Direct upload for files at or above the Server's threshold, mirroring the
 * CLI: create a session, PUT the bytes to the presigned URL (fetch; one retry
 * when the object store may have committed), then complete, which the Server
 * verifies against the object store. A PUT that definitely failed cancels the
 * session; a PUT whose outcome is unknown leaves it for completion to verify.
 */
async function uploadThroughSession(
  client: Pick<AgentApiClient, "attachments">,
  transport: AttachmentTransport,
  request: UploadAttachmentRequest,
  channelId: string,
  mimeType: string,
  options: RaftHintOptions,
): Promise<RaftOutcome<RaftAttachmentUploaded, "uploaded">> {
  const created = await client.attachments.createUploadSession({
    channelId,
    filename: request.filename,
    mimeType,
    sizeBytes: request.bytes.byteLength,
    clientRequestId: crypto.randomUUID(),
  });
  if (!created.ok) return failureFromClientResult(created);
  const { uploadId, upload } = created.data;

  const body = new Uint8Array(request.bytes.byteLength);
  body.set(request.bytes);
  let definitelyFailed: number | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await transport.fetch(upload.url, { method: upload.method ?? "PUT", headers: { ...upload.headers }, body: body.buffer, redirect: "error" });
    } catch {
      if (attempt === 0) continue;
      break; // outcome unknown: let completion verify whether the write exists
    }
    if (response.ok || response.status === 412) { definitelyFailed = null; break; } // 412: the conditional PUT already landed
    const mayExist = response.status === 408 || response.status === 429 || response.status >= 500;
    if (mayExist && attempt === 0) continue;
    if (!mayExist) definitelyFailed = response.status;
    break;
  }
  if (definitelyFailed !== null) {
    await client.attachments.cancelUploadSession({ uploadId }).catch(() => undefined);
    return failureOutcome(opError("HTTP_ERROR", {
      message: `Direct object upload failed with HTTP ${definitelyFailed}; the upload session was cancelled.`,
      status: definitelyFailed,
      nextAction: "Retry the upload; nothing was attached.",
    }));
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const completed = await client.attachments.completeUploadSession({ uploadId });
    if (completed.ok) {
      const attachment = completed.data.attachment as AgentApiAttachmentUploadResponse;
      return uploadedOutcome(request.target, attachment, mimeType, options);
    }
    const code = completed.error.kind === "http" ? completed.error.errorCode : null;
    const retryable = code === "UPLOAD_OBJECT_NOT_FOUND" || code === "UPLOAD_VERIFICATION_IN_PROGRESS";
    if (!retryable || attempt === 2) return failureFromClientResult(completed);
    await wait(250 * (attempt + 1));
  }
  return failureOutcome(opError("UNAVAILABLE", { message: "Direct upload completion ended without a terminal response." }));
}

export interface RaftAttachmentBytes {
  attachmentId: string;
  bytes: Uint8Array;
}

export async function downloadAttachment(
  client: Pick<AgentApiClient, "attachments">,
  request: { attachmentId: string },
): Promise<RaftOutcome<RaftAttachmentBytes, "downloaded">> {
  if (!request.attachmentId?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "An attachment id is required." }));
  const result = await client.attachments.download({ attachmentId: request.attachmentId });
  if (!result.ok) return failureFromClientResult(result);
  const bytes = result.data as Uint8Array;
  return {
    ok: true,
    state: "downloaded",
    data: { attachmentId: request.attachmentId, bytes },
    next: null,
    text: `Downloaded attachment ${request.attachmentId.slice(0, 8)} (${bytes.byteLength} bytes).`,
  };
}

/** A short-lived download URL: what a runtime fetches the bytes from itself (`attachments.downloadUrl`). */
export type RaftAttachmentDownloadUrl = Pick<AgentApiAttachmentDownloadUrlResponse, "url" | "expiresAt" | "filename" | "mimeType">;

/**
 * Mint a short-lived URL for an attachment's bytes, for runtimes whose tools
 * cannot return binary data: the runtime (not the model) fetches `url` before
 * `expiresAt`. The URL is a bearer capability; do not log it. A Server whose
 * storage cannot presign answers 409 `download_url_unavailable`; that failure's
 * `next` points at the binary download (`attachments.download`).
 */
export async function downloadAttachmentUrl(
  client: Pick<AgentApiClient, "attachments">,
  request: { attachmentId: string },
  options: RaftHintOptions = {},
): Promise<RaftOutcome<RaftAttachmentDownloadUrl, "url">> {
  const invalid = validateOpRequest(downloadAttachmentUrlRequestSchema, request); if (invalid) return invalid;
  const attachmentId = request.attachmentId?.trim();
  if (!attachmentId) return failureOutcome(opError("INVALID_REQUEST", { message: "An attachment id is required." }));
  const result = await client.attachments.downloadUrl({ attachmentId });
  if (!result.ok) {
    const failure = failureFromClientResult(result);
    if (failure.error.serverCode !== "download_url_unavailable") return failure;
    const download = RAFT_HINTS.attachmentDownload(attachmentId);
    const nextAction = `This Server's storage cannot mint download URLs; download the bytes instead: \`${formatHint(download, options.hints)}\`.`;
    return {
      ...failureOutcome({ ...failure.error, nextAction }),
      next: hintStep("download_bytes", download, nextAction, options.hints, { attachmentId }),
    };
  }
  const { url, expiresAt, filename, mimeType } = result.data;
  return {
    ok: true,
    state: "url",
    data: { url, expiresAt, filename, mimeType },
    next: null,
    text: `Download URL for ${foldAgentOneLineText(filename)} (${mimeType}), valid until ${expiresAt}:\n${url}`,
  };
}

export async function attachmentComments(
  client: Pick<AgentApiClient, "attachments">,
  request: { attachmentId: string; limit?: number },
): Promise<RaftOutcome<AgentApiAttachmentCommentsResponse & { attachmentId: string }, "comments" | "empty">> {
  const invalid = validateOpRequest(attachmentCommentsRequestSchema, request); if (invalid) return invalid;
  if (!request.attachmentId?.trim()) return failureOutcome(opError("INVALID_REQUEST", { message: "An attachment id is required." }));
  const result = await client.attachments.comments(
    { attachmentId: request.attachmentId },
    request.limit === undefined ? {} : { limit: String(request.limit) },
  );
  if (!result.ok) return failureFromClientResult(result);
  const data = result.data;
  return {
    ok: true,
    state: data.comments.length > 0 ? "comments" : "empty",
    data: { ...data, attachmentId: request.attachmentId },
    next: null,
    text: formatAgentAttachmentComments(request.attachmentId, data.comments as unknown as AgentAttachmentCommentRow[], data.threadChannelId),
  };
}
