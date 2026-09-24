import type {
  ExternalAttachmentAuthority,
  ExternalAttachmentCompletionRequest,
  ExternalAttachmentCorrelationRequest,
  ExternalAttachmentProviderFailure,
  ExternalAttachmentUploadRequest,
  ExternalOutboundAttachmentProviderAdapter,
} from "./externalAttachmentProviderAdapter.js";
import { validateExternalAttachmentCapabilityManifest } from "./externalAttachmentProviderAdapter.js";

export class SlackOutboundAttachmentError extends Error {
  constructor(readonly failure: ExternalAttachmentProviderFailure) {
    super(failure.reason);
    this.name = "SlackOutboundAttachmentError";
  }
}

export interface SlackOutboundAttachmentTransport {
  createUpload(input: {
    authority: ExternalAttachmentAuthority;
    asset: ExternalAttachmentUploadRequest;
    signal: AbortSignal;
  }): Promise<{ providerFileId: string; uploadUrl: string }>;
  upload(input: {
    authority: ExternalAttachmentAuthority;
    uploadUrl: string;
    bytes: AsyncIterable<Uint8Array>;
    expectedByteSize: number;
    expectedContentDigest: string;
    signal: AbortSignal;
  }): Promise<{ uploadedByteSize: number; uploadedContentDigest: string }>;
  complete(input: {
    authority: ExternalAttachmentAuthority;
    completion: ExternalAttachmentCompletionRequest;
    signal: AbortSignal;
  }): Promise<{ kind: "accepted_pending_correlation" } | { kind: "outcome_unknown"; reason: string }>;
  correlate(input: {
    authority: ExternalAttachmentAuthority;
    correlation: ExternalAttachmentCorrelationRequest;
    signal: AbortSignal;
  }): Promise<
    | { kind: "pending" }
    | { kind: "matched"; providerMessageId: string }
    | { kind: "conflict"; reason: string }
  >;
  classify(error: unknown): ExternalAttachmentProviderFailure;
}

type SlackUploadHandle = Readonly<{
  providerFileId: string;
  uploadUrl: string;
}>;

function bounded(value: string, max: number, reason: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || normalized.includes("\0")) {
    throw new SlackOutboundAttachmentError({
      class: "deterministic",
      reason,
      retryAfterMs: null,
      scope: "occurrence_local",
    });
  }
  return normalized;
}

function uploadUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SlackOutboundAttachmentError({
      class: "deterministic",
      reason: "provider_upload_locator_invalid",
      retryAfterMs: null,
      scope: "occurrence_local",
    });
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "files.slack.com"
    || url.username
    || url.password
    || url.hash
  ) {
    throw new SlackOutboundAttachmentError({
      class: "deterministic",
      reason: "provider_upload_locator_invalid",
      retryAfterMs: null,
      scope: "occurrence_local",
    });
  }
  return url.toString();
}

export function createSlackOutboundAttachmentAdapter(
  transport: SlackOutboundAttachmentTransport,
): ExternalOutboundAttachmentProviderAdapter<SlackUploadHandle> {
  return {
    provider: "slack",
    capabilities: validateExternalAttachmentCapabilityManifest({
      inboundDownload: false,
      outboundUpload: true,
      batchCompletion: true,
      authenticatedCorrelation: true,
      maximumFilesPerMessage: 10,
      maximumBytesPerFile: 1_073_741_824,
    }),
    async createOutboundUpload({ authority, asset, signal }) {
      if (authority.provider !== "slack") {
        throw new SlackOutboundAttachmentError({
          class: "authority_revoked",
          reason: "provider_authority_mismatch",
          retryAfterMs: null,
          scope: "occurrence_local",
        });
      }
      const ticket = await transport.createUpload({ authority, asset, signal });
      const providerFileId = bounded(ticket.providerFileId, 320, "provider_file_identity_invalid");
      return {
        providerFileId,
        uploadHandle: { providerFileId, uploadUrl: uploadUrl(ticket.uploadUrl) },
      };
    },
    uploadOutboundAsset(input) {
      return transport.upload({
        authority: input.authority,
        uploadUrl: input.handle.uploadUrl,
        bytes: input.bytes,
        expectedByteSize: input.expectedByteSize,
        expectedContentDigest: input.expectedContentDigest,
        signal: input.signal,
      });
    },
    completeOutboundMessage: (input) => transport.complete(input),
    correlateOutboundMessage: (input) => transport.correlate(input),
    classifyFailure(error) {
      return error instanceof SlackOutboundAttachmentError
        ? error.failure
        : transport.classify(error);
    },
  };
}
