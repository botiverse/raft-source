import {
  type ExternalAttachmentAuthority,
  type ExternalAttachmentProviderFailure,
  type ExternalInboundAttachmentProviderAdapter,
  validateExternalAttachmentCapabilityManifest,
} from "./externalAttachmentProviderAdapter.js";

export type SlackInboundAttachmentInspection = Readonly<{
  id: string;
  user: string;
  name: string;
  mimetype: string;
  size: number;
  timestamp: number | null;
  urlPrivateDownload: string;
}>;

export interface SlackInboundAttachmentTransport {
  inspect(input: {
    authority: ExternalAttachmentAuthority;
    providerFileId: string;
    signal: AbortSignal;
  }): Promise<SlackInboundAttachmentInspection>;
  download(input: {
    authority: ExternalAttachmentAuthority;
    privateUrl: string;
    maximumBytes: number;
    signal: AbortSignal;
  }): AsyncIterable<Uint8Array>;
}

type SlackDownloadHandle = Readonly<{
  providerFileId: string;
  privateUrl: string;
  declaredSizeBytes: number;
  authorityFingerprint: string;
}>;

export class SlackInboundAttachmentError extends Error {
  constructor(readonly failure: ExternalAttachmentProviderFailure) {
    super(failure.reason);
    this.name = "SlackInboundAttachmentError";
  }
}

function bounded(value: string, max: number, reason: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new SlackInboundAttachmentError({
      class: "deterministic",
      reason,
      retryAfterMs: null,
      scope: "asset_global",
    });
  }
  return normalized;
}

function authorityFingerprint(authority: ExternalAttachmentAuthority): string {
  return [
    authority.provider,
    authority.appRegistrationId,
    authority.installId,
    authority.workspaceId,
    authority.providerAuthorityId,
    authority.providerConversationId,
    authority.connectionEpoch,
    authority.bindingId,
    authority.bindingEpoch,
  ].join("\0");
}

function privateSlackDownloadUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SlackInboundAttachmentError({
      class: "deterministic",
      reason: "provider_file_download_locator_invalid",
      retryAfterMs: null,
      scope: "asset_global",
    });
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "files.slack.com"
    || url.username
    || url.password
    || url.hash
  ) {
    throw new SlackInboundAttachmentError({
      class: "deterministic",
      reason: "provider_file_download_locator_invalid",
      retryAfterMs: null,
      scope: "asset_global",
    });
  }
  return url.toString();
}

export function createSlackInboundAttachmentAdapter(
  transport: SlackInboundAttachmentTransport,
): ExternalInboundAttachmentProviderAdapter<SlackDownloadHandle> {
  return {
    provider: "slack",
    capabilities: validateExternalAttachmentCapabilityManifest({
      inboundDownload: true,
      outboundUpload: false,
      batchCompletion: false,
      authenticatedCorrelation: false,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1_073_741_824,
    }),
    async inspectInboundAsset({ authority, providerFileId, signal }) {
      if (authority.provider !== "slack") {
        throw new SlackInboundAttachmentError({
          class: "authority_revoked",
          reason: "provider_authority_mismatch",
          retryAfterMs: null,
          scope: "occurrence_local",
        });
      }
      const inspection = await transport.inspect({ authority, providerFileId, signal });
      if (inspection.id !== providerFileId) {
        throw new SlackInboundAttachmentError({
          class: "deterministic",
          reason: "provider_file_identity_mismatch",
          retryAfterMs: null,
          scope: "asset_global",
        });
      }
      const filename = bounded(inspection.name, 1024, "provider_file_name_invalid");
      const mimeType = bounded(inspection.mimetype, 255, "provider_file_mime_invalid");
      const sourceExternalActorId = bounded(inspection.user, 160, "provider_file_owner_invalid");
      if (!Number.isSafeInteger(inspection.size) || inspection.size <= 0) {
        throw new SlackInboundAttachmentError({
          class: "deterministic",
          reason: "provider_file_size_invalid",
          retryAfterMs: null,
          scope: "asset_global",
        });
      }
      const privateUrl = privateSlackDownloadUrl(inspection.urlPrivateDownload);
      const providerCreatedAt = inspection.timestamp === null
        ? null
        : new Date(inspection.timestamp * 1_000);
      if (providerCreatedAt && !Number.isFinite(providerCreatedAt.getTime())) {
        throw new SlackInboundAttachmentError({
          class: "deterministic",
          reason: "provider_file_timestamp_invalid",
          retryAfterMs: null,
          scope: "asset_global",
        });
      }
      return {
        metadata: {
          providerFileId,
          sourceExternalActorId,
          filename,
          declaredSizeBytes: inspection.size,
          mimeType,
          providerCreatedAt,
        },
        downloadHandle: {
          providerFileId,
          privateUrl,
          declaredSizeBytes: inspection.size,
          authorityFingerprint: authorityFingerprint(authority),
        },
      };
    },
    async *downloadInboundAsset({ authority, handle, maximumBytes, signal }) {
      if (
        authority.provider !== "slack"
        || handle.authorityFingerprint !== authorityFingerprint(authority)
      ) {
        throw new SlackInboundAttachmentError({
          class: "authority_revoked",
          reason: "provider_authority_mismatch",
          retryAfterMs: null,
          scope: "occurrence_local",
        });
      }
      if (
        !Number.isSafeInteger(maximumBytes)
        || maximumBytes <= 0
        || handle.declaredSizeBytes > maximumBytes
      ) {
        throw new SlackInboundAttachmentError({
          class: "deterministic",
          reason: "provider_file_size_exceeds_plan",
          retryAfterMs: null,
          scope: "occurrence_local",
        });
      }
      let receivedBytes = 0;
      for await (const chunk of transport.download({
        authority,
        privateUrl: handle.privateUrl,
        maximumBytes,
        signal,
      })) {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > handle.declaredSizeBytes || receivedBytes > maximumBytes) {
          throw new SlackInboundAttachmentError({
            class: "deterministic",
            reason: "provider_file_stream_exceeded_bound",
            retryAfterMs: null,
            scope: "asset_global",
          });
        }
        yield chunk;
      }
      if (receivedBytes !== handle.declaredSizeBytes) {
        throw new SlackInboundAttachmentError({
          class: "transient",
          reason: "provider_file_stream_incomplete",
          retryAfterMs: null,
          scope: "asset_global",
        });
      }
    },
    classifyFailure(error) {
      return error instanceof SlackInboundAttachmentError
        ? error.failure
        : {
          class: "transient",
          reason: "provider_attachment_unavailable",
          retryAfterMs: null,
          scope: "asset_global",
        };
    },
  };
}
