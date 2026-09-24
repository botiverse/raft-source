export type ExternalAttachmentCapabilityManifest = Readonly<{
  inboundDownload: boolean;
  outboundUpload: boolean;
  batchCompletion: boolean;
  authenticatedCorrelation: boolean;
  maximumFilesPerMessage: number;
  maximumBytesPerFile: number;
}>;

export type ExternalAttachmentAuthority = Readonly<{
  provider: string;
  appRegistrationId: string;
  installId: string;
  workspaceId: string;
  providerAuthorityId: string;
  providerConversationId: string;
  connectionEpoch: number;
  bindingId: string;
  bindingEpoch: number;
}>;

export type ExternalAttachmentMetadata = Readonly<{
  providerFileId: string;
  sourceExternalActorId: string;
  filename: string;
  declaredSizeBytes: number;
  mimeType: string;
  providerCreatedAt: Date | null;
}>;

export type ExternalAttachmentUploadRequest = Readonly<{
  sourceAttachmentId: string;
  filename: string;
  byteSize: number;
  mimeType: string;
  contentDigest: string;
}>;

export type ExternalOutboundFrozenAttachment = Readonly<{
  sourceAttachmentId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  contentDigest: string;
  messagePosition: number;
}>;

/**
 * The provider-neutral subset of an immutable outbound delivery snapshot used
 * by the asset state machine. Provider renderers may carry additional fields,
 * but the transfer kernel must not import a provider-specific snapshot type.
 */
export type ExternalOutboundAttachmentSnapshot = Readonly<{
  sanitizedText: string;
  authorPolicy: Readonly<{
    displayName: string;
    fallbackKind: "human" | "agent";
    avatar: null | Readonly<{ publicUrl: string }>;
  }>;
  attachments: readonly ExternalOutboundFrozenAttachment[];
  bindingAuthority: ExternalAttachmentAuthority;
}>;

export type ExternalAttachmentCompletionRequest = Readonly<{
  providerConversationId: string;
  providerRootThreadId: string | null;
  providerFileIds: readonly string[];
  renderedText: string;
  reconciliationMarker: string;
  author: Readonly<{
    displayName: string;
    avatarPublicUrl: string | null;
    fallbackKind: "human" | "agent";
  }>;
}>;

export type ExternalAttachmentCorrelationRequest = Readonly<{
  providerConversationId: string;
  providerRootThreadId: string | null;
  providerFileIds: readonly string[];
  reconciliationMarker: string;
}>;

export type ExternalAttachmentProviderFailure = Readonly<{
  class:
    | "rate_limited"
    | "transient"
    | "deterministic"
    | "outcome_unknown"
    | "authority_revoked";
  reason: string;
  retryAfterMs: number | null;
  /** Whether the failure invalidates provider bytes or only this occurrence. */
  scope: "asset_global" | "occurrence_local";
}>;

/**
 * Thin provider boundary for file transfer. Handle types are intentionally
 * adapter-private and transient: the kernel may persist the stable provider
 * file ID, but never a bearer credential, private locator, or upload ticket.
 */
export interface ExternalInboundAttachmentProviderAdapter<TDownloadHandle> {
  readonly provider: string;
  readonly capabilities: ExternalAttachmentCapabilityManifest;

  inspectInboundAsset(input: {
    authority: ExternalAttachmentAuthority;
    providerFileId: string;
    signal: AbortSignal;
  }): Promise<{
    metadata: ExternalAttachmentMetadata;
    downloadHandle: TDownloadHandle;
  }>;

  downloadInboundAsset(input: {
    authority: ExternalAttachmentAuthority;
    handle: TDownloadHandle;
    maximumBytes: number;
    signal: AbortSignal;
  }): AsyncIterable<Uint8Array>;

  classifyFailure(error: unknown): ExternalAttachmentProviderFailure;
}

export interface ExternalOutboundAttachmentProviderAdapter<TUploadHandle> {
  readonly provider: string;
  readonly capabilities: ExternalAttachmentCapabilityManifest;

  createOutboundUpload(input: {
    authority: ExternalAttachmentAuthority;
    asset: ExternalAttachmentUploadRequest;
    signal: AbortSignal;
  }): Promise<{
    providerFileId: string;
    uploadHandle: TUploadHandle;
  }>;

  uploadOutboundAsset(input: {
    authority: ExternalAttachmentAuthority;
    handle: TUploadHandle;
    bytes: AsyncIterable<Uint8Array>;
    expectedByteSize: number;
    expectedContentDigest: string;
    signal: AbortSignal;
  }): Promise<{
    uploadedByteSize: number;
    uploadedContentDigest: string;
  }>;

  completeOutboundMessage(input: {
    authority: ExternalAttachmentAuthority;
    completion: ExternalAttachmentCompletionRequest;
    signal: AbortSignal;
  }): Promise<
    | { kind: "accepted_pending_correlation" }
    | { kind: "outcome_unknown"; reason: string }
  >;

  correlateOutboundMessage(input: {
    authority: ExternalAttachmentAuthority;
    correlation: ExternalAttachmentCorrelationRequest;
    signal: AbortSignal;
  }): Promise<
    | { kind: "pending" }
    | { kind: "matched"; providerMessageId: string }
    | { kind: "conflict"; reason: string }
  >;

  classifyFailure(error: unknown): ExternalAttachmentProviderFailure;
}

export interface ExternalAttachmentProviderAdapter<TDownloadHandle, TUploadHandle>
  extends ExternalInboundAttachmentProviderAdapter<TDownloadHandle>,
    ExternalOutboundAttachmentProviderAdapter<TUploadHandle> {}

export function validateExternalAttachmentCapabilityManifest(
  raw: ExternalAttachmentCapabilityManifest,
): ExternalAttachmentCapabilityManifest {
  if (!Number.isSafeInteger(raw.maximumFilesPerMessage) || raw.maximumFilesPerMessage <= 0) {
    throw new Error("External attachment provider file-count capability is invalid");
  }
  if (!Number.isSafeInteger(raw.maximumBytesPerFile) || raw.maximumBytesPerFile <= 0) {
    throw new Error("External attachment provider byte capability is invalid");
  }
  if (raw.outboundUpload && (!raw.batchCompletion || !raw.authenticatedCorrelation)) {
    throw new Error("External attachment outbound upload requires completion and correlation capabilities");
  }
  return Object.freeze({ ...raw });
}
