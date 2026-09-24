// `raft attachment upload --path <filepath> [--target <target>]`
// → POST /internal/agent-api/resolve-channel  (target → channelId, when --target given)
// → GET  /internal/agent-api/attachment-upload-capabilities
// → POST /internal/agent-api/upload           (small files: multipart)
// → POST /internal/agent-api/attachment-upload-sessions + direct PUT + complete
//                                             (large files: streamed to object storage)
//
// Returns the attachment id; pass it to `raft message send --attachment-id`.
//
// Note: v0 server's /upload endpoint still requires a channelId in the multipart
// body. The CLI surface no longer requires --channel (per locked v0 spec), but
// callers that omit it will hit MISSING_CHANNEL until the server accepts
// channel-less uploads. Tracked separately.

import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import { finished } from "node:stream/promises";

import type { Command } from "commander";
import { setClockTimeout } from "@botiverse/raft-shared";

import { defineCommand, registerCliCommand } from "../../core/command.js";
import type { CommandRuntimeOptions } from "../../core/context.js";
import { cliError } from "../../core/errors.js";
import { writeText, adoptCliReplyText } from "../../core/renderer.js";
import { formatAttachmentUploaded } from "./_format.js";
import { createAgentApiSurfaceClient } from "../../agentApiPath.js";
import { apiFailureError } from "../_apiFailure.js";
import { resolveTargetAlias, type TargetAliasOpts } from "../_target.js";

// Compatibility fallback for servers that predate the capability endpoint.
// Current servers always project the active plan limit at command startup.
export const MAX_ATTACHMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
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

interface UploadOpts extends TargetAliasOpts {
  path: string;
  mimeType?: string;
}

export class AttachmentUploadArgError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly objectMayExist = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AttachmentUploadArgError";
  }
}

function inferMimeTypeFromFilename(filename: string): string | null {
  const index = filename.lastIndexOf(".");
  const ext = index >= 0 ? filename.slice(index).toLowerCase() : "";
  return FILENAME_MIME_MAP[ext] || null;
}

function inferMimeTypeFromBuffer(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
  ) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xFF, 0xD8, 0xFF]))) {
    return "image/jpeg";
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString("ascii");
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export function normalizeExplicitMimeType(mimeType: string | null | undefined): string | null {
  const normalized = mimeType?.trim().toLowerCase();
  if (!normalized) return null;
  if (!MIME_TYPE_RE.test(normalized)) {
    throw new AttachmentUploadArgError(
      "INVALID_ARG",
      `--mime-type must look like type/subtype, got: ${mimeType}`,
    );
  }
  return normalized;
}

export function inferUploadMimeType(
  filename: string,
  buffer: Buffer,
  explicitMimeType?: string | null,
): string {
  const explicit = normalizeExplicitMimeType(explicitMimeType);
  return explicit
    || inferMimeTypeFromBuffer(buffer)
    || inferMimeTypeFromFilename(filename)
    || "application/octet-stream";
}

export function validateUploadFileSize(size: number, maxBytes = MAX_ATTACHMENT_UPLOAD_BYTES): void {
  if (size > maxBytes) {
    throw new AttachmentUploadArgError(
      "INVALID_ARG",
      `--path is ${formatBytes(size)}; max upload size is ${formatBytes(maxBytes)}`,
    );
  }
  if (size === 0) {
    throw new AttachmentUploadArgError(
      "INVALID_ARG",
      "--path is empty; refusing to upload a 0-byte attachment",
    );
  }
}

function readFilePrefix(filePath: string, maxBytes = 16): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export async function putFileToPresignedUrl(
  filePath: string,
  sizeBytes: number,
  url: string,
  signedHeaders: Readonly<Record<string, string>>,
  fetchImpl: typeof fetch = fetch,
): Promise<"uploaded" | "already_exists"> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = createReadStream(filePath);
    try {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "PUT",
          headers: { ...signedHeaders, "Content-Length": String(sizeBytes) },
          body: body as unknown as BodyInit,
          redirect: "error",
          duplex: "half",
        } as RequestInit & { duplex: "half" });
      } catch (err) {
        if (attempt === 0) continue;
        throw new AttachmentUploadArgError(
          "UPLOAD_OBJECT_PUT_FAILED",
          "Direct object upload lost its response; the server will verify whether the write succeeded",
          true,
          { cause: err },
        );
      }
      if (response.ok) return "uploaded";
      if (response.status === 412) return "already_exists";

      const objectMayExist = response.status === 408
        || response.status === 429
        || response.status >= 500;
      if (objectMayExist && attempt === 0) continue;
      throw new AttachmentUploadArgError(
        "UPLOAD_OBJECT_PUT_FAILED",
        `Direct object upload failed with HTTP ${response.status}`,
        objectMayExist,
      );
    } finally {
      body.destroy();
      await finished(body).catch(() => undefined);
    }
  }
  throw new AttachmentUploadArgError(
    "UPLOAD_OBJECT_PUT_FAILED",
    "Direct object upload ended without a terminal response",
    true,
  );
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setClockTimeout(resolve, ms));
}

type UploadFailureResponse = Readonly<{
  status: number;
  error?: string | null;
  errorCode?: string | null;
  suggestedNextAction?: string | null;
  proxy?: Parameters<typeof apiFailureError>[0]["proxy"];
}>;

function throwUploadFailure(response: UploadFailureResponse, fallbackCode = "UPLOAD_FAILED"): never {
  throw apiFailureError(response, fallbackCode);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)}${units[unitIndex]}`;
}

export const attachmentUploadCommand = defineCommand(
  {
    name: "upload",
    description: "Upload a local file as an attachment (server plan limit applies)",
    options: [
      { flags: "--path <filepath>", description: "Absolute path to the local file to upload" },
      {
        flags: "--target <target>",
        description: "Target where the attachment will be used: '#channel', 'dm:@peer', or thread variants. Required by the v0 server until channel-less uploads land.",
      },
      { flags: "--channel <target>", description: "Legacy alias for --target (accepted during transition)" },
      { flags: "--mime-type <type>", description: "Explicit MIME type override, e.g. image/png" },
    ],
  },
  async (ctx, opts: UploadOpts) => {
      if (typeof opts.path !== "string" || opts.path.length === 0) {
        throw cliError("INVALID_ARG", "--path is required");
      }
      if (!existsSync(opts.path)) {
        throw cliError("INVALID_ARG", `--path does not exist: ${opts.path}`);
      }
      const stat = statSync(opts.path);
      if (!stat.isFile()) {
        throw cliError("INVALID_ARG", `--path is not a regular file: ${opts.path}`);
      }
      if (stat.size === 0) throw cliError("INVALID_ARG", "--path is empty; refusing to upload a 0-byte attachment");

      const target = resolveTargetAlias(opts);
      if (!target) {
        throw cliError(
          "MISSING_CHANNEL",
          "v0 server requires a target to attach the upload to. Pass --target '#name', 'dm:@peer', or a thread target.",
        );
      }

      const filename = basename(opts.path);
      let explicitMimeType: string | null;
      try {
        explicitMimeType = normalizeExplicitMimeType(opts.mimeType);
      } catch (err) {
        if (err instanceof AttachmentUploadArgError) throw cliError(err.code, err.message, { cause: err });
        throw err;
      }
      const uploadMimeType = inferUploadMimeType(filename, readFilePrefix(opts.path), explicitMimeType);

      const agentContext = ctx.loadAgentContext();
      const client = ctx.createApiClient(agentContext);
      const agentApi = createAgentApiSurfaceClient(client);

      const capabilityResponse = await agentApi.attachments.uploadCapabilities();
      const capability = capabilityResponse.ok
        ? capabilityResponse.data!
        : capabilityResponse.status === 404
          ? {
              directUploadEnabled: false,
              directUploadThresholdBytes: null,
              maxBytes: MAX_ATTACHMENT_UPLOAD_BYTES,
              sessionExpiresInSeconds: null,
            }
          : throwUploadFailure(capabilityResponse, "UPLOAD_CAPABILITY_FAILED");
      try {
        validateUploadFileSize(stat.size, capability.maxBytes);
      } catch (err) {
        if (err instanceof AttachmentUploadArgError) throw cliError(err.code, err.message, { cause: err });
        throw err;
      }

      const resolved = await agentApi.channels.resolve({ target });
      if (!resolved.ok || !resolved.data?.channelId) {
        const code = resolved.status >= 500 ? "SERVER_5XX" : "RESOLVE_FAILED";
        throw cliError(code, resolved.error ?? `Could not resolve target: ${target}`);
      }
      const channelId = resolved.data!.channelId!;

      const useDirectUpload = capability.directUploadEnabled
        && capability.directUploadThresholdBytes !== null
        && stat.size >= capability.directUploadThresholdBytes;

      if (useDirectUpload) {
        const created = await agentApi.attachments.createUploadSession({
          channelId,
          filename,
          mimeType: uploadMimeType,
          sizeBytes: stat.size,
          clientRequestId: randomUUID(),
        });
        if (!created.ok) throwUploadFailure(created);

        const uploadId = created.data!.uploadId;
        try {
          await putFileToPresignedUrl(
            opts.path,
            stat.size,
            created.data!.upload.url,
            created.data!.upload.headers,
          );
        } catch (err) {
          if (err instanceof AttachmentUploadArgError && !err.objectMayExist) {
            await agentApi.attachments.cancelUploadSession({ uploadId }).catch(() => undefined);
            throw cliError(err.code, err.message, { cause: err });
          }
          // A transport failure can happen after object storage committed the
          // conditional PUT. Preserve the session and let server-side HEAD
          // verification decide whether the write exists.
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const completed = await agentApi.attachments.completeUploadSession({ uploadId });
          if (completed.ok) {
            const attachment = completed.data!.attachment;
            writeText(ctx.io, formatAttachmentUploaded(attachment));
            return;
          }
          const retryable = completed.errorCode === "UPLOAD_OBJECT_NOT_FOUND"
            || completed.errorCode === "UPLOAD_VERIFICATION_IN_PROGRESS";
          if (!retryable || attempt === 2) throwUploadFailure(completed);
          await wait(250 * (attempt + 1));
        }
        throw cliError("UPLOAD_FAILED", "Direct upload completion ended without a terminal response");
      }

      const buffer = readFileSync(opts.path);
      const blob = new Blob([buffer], { type: uploadMimeType });
      const form = new FormData();
      form.append("file", blob, filename);
      form.append("channelId", channelId);
      if (explicitMimeType) {
        form.append("mimeType", explicitMimeType);
      }

      const res = await agentApi.attachments.upload(form);
      if (!res.ok) throwUploadFailure(res);
      const d = res.data!;
      writeText(ctx.io, formatAttachmentUploaded(d));
  },
);

export function registerAttachmentUploadCommand(parent: Command, runtimeOptions: CommandRuntimeOptions = {}): void {
  registerCliCommand(parent, attachmentUploadCommand, runtimeOptions);
}
