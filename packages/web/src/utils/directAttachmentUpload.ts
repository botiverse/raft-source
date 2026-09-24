import type { components } from "@botiverse/raft-shared/src/generated/openapi.js";
import { setClockTimeout } from "@botiverse/raft-shared";
import axios from "axios";
import type { AxiosProgressEvent, AxiosRequestConfig } from "axios";
import { reportUploadCapabilityFallback } from "./attachmentUploadFallbackTrace";
import type {
  UploadFallbackErrorIdentity,
  UploadFallbackReason,
} from "./attachmentUploadFallbackTrace";

type Attachment = components["schemas"]["AttachmentUploadResponse"];
type Capabilities = components["schemas"]["AttachmentUploadCapabilities"];
type CreateRequest = components["schemas"]["CreateAttachmentUploadSessionRequest"];
type CreateResponse = components["schemas"]["CreateAttachmentUploadSessionResponse"];
type CompleteResponse = components["schemas"]["CompleteAttachmentUploadSessionResponse"];
type SessionView = components["schemas"]["AttachmentUploadSessionView"];

type ContractError =
  | components["schemas"]["AttachmentUploadForbiddenError"]
  | components["schemas"]["AttachmentUploadIdempotencyConflictError"]
  | components["schemas"]["AttachmentUploadRateLimitedError"]
  | components["schemas"]["AttachmentUploadTooLargeError"]
  | components["schemas"]["AttachmentUploadVerificationInProgressError"]
  | components["schemas"]["InvalidUploadRequestError"]
  | components["schemas"]["UploadObjectMismatchError"]
  | components["schemas"]["UploadObjectNotFoundError"]
  | components["schemas"]["UploadSessionExpiredError"]
  | components["schemas"]["AttachmentUploadSessionNotFoundError"];

type ApiResponse<T> = Readonly<{ data: T }>;
type ApiRequestConfig = Readonly<{ signal?: AbortSignal }>;

export interface AttachmentUploadApi {
  get<T = unknown>(url: string, config?: ApiRequestConfig): Promise<ApiResponse<T>>;
  post<T = unknown>(url: string, body?: unknown, config?: ApiRequestConfig): Promise<ApiResponse<T>>;
  delete<T = unknown>(url: string): Promise<ApiResponse<T>>;
}

export type DirectAttachmentUploadSession = Readonly<{ uploadId: string }>;

export class AttachmentUploadClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AttachmentUploadClientError";
  }
}

type AxiosLikeError = Readonly<{
  response?: Readonly<{
    status?: number;
    data?: Partial<ContractError>;
  }>;
}>;

function httpStatus(error: unknown): number | undefined {
  return (error as AxiosLikeError | null)?.response?.status;
}

/**
 * Did the caller cancel, rather than something failing?
 *
 * This is the one case the #187 fail-safe must NOT degrade: silently running a
 * legacy upload after the user hit cancel would upload a file they asked us not
 * to. Checked three ways because cancellation reaches us in different shapes —
 * the signal itself, a DOM `AbortError`, and axios's `ERR_CANCELED`.
 */
function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "CanceledError") return true;
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_CANCELED";
}

/** The error's own identity — name and code only, never its message. */
function errorIdentity(error: unknown): UploadFallbackErrorIdentity {
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: typeof name === "string" ? name : null,
    code: typeof code === "string" ? code : null,
  };
}

/**
 * Map a failed capability probe onto the telemetry reason set.
 *
 * The no-status branch is split rather than collapsed: a TIMEOUT and an
 * unreachable NETWORK are the two most different causes here, and lumping both
 * into one value would swallow exactly the distinction an on-call reader needs
 * (@tygg's tracing requirement). `capability_unreachable` now means only "no
 * status and no recognisable cause", and `error_name`/`error_code` carry the
 * rest.
 */
function capabilityFallbackReason(error: unknown): UploadFallbackReason {
  const status = httpStatus(error);
  if (status === undefined) {
    const { code, name } = errorIdentity(error);
    if (code === "ECONNABORTED" || code === "ETIMEDOUT" || name === "TimeoutError") return "capability_timeout";
    if (code === "ERR_NETWORK" || name === "TypeError") return "capability_network";
    return "capability_unreachable";
  }
  if (status === 404) return "capability_not_found";
  if (status >= 500) return "capability_server_error";
  return "capability_client_error";
}

function contractError(error: unknown, fallbackCode: string, fallbackMessage: string): AttachmentUploadClientError {
  const data = (error as AxiosLikeError | null)?.response?.data;
  const code = typeof data?.code === "string" ? data.code : fallbackCode;
  const message = typeof data?.message === "string" ? data.message : fallbackMessage;
  const retryable = typeof data?.retryable === "boolean" ? data.retryable : true;
  const retryAfterCandidate = (data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  const retryAfterMs = typeof retryAfterCandidate === "number"
    ? retryAfterCandidate
    : undefined;
  return new AttachmentUploadClientError(code, message, retryable, retryAfterMs);
}

function sessionEndpoint(uploadId: string): string {
  return `/attachments/upload-sessions/${encodeURIComponent(uploadId)}`;
}

function mimeTypeForUpload(file: File): string {
  const normalized = file.type.split(";")[0]?.trim().toLowerCase();
  return normalized || "application/octet-stream";
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setClockTimeout(resolve, ms);
  });
}

async function completeUpload(
  api: AttachmentUploadApi,
  uploadId: string,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<Attachment> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await api.post<CompleteResponse>(`${sessionEndpoint(uploadId)}/complete`, undefined, { signal });
      return response.data.attachment;
    } catch (error) {
      const failure = contractError(error, "UPLOAD_COMPLETE_FAILED", "The upload could not be completed.");
      const contractRetryable = failure.code === "UPLOAD_OBJECT_NOT_FOUND"
        || failure.code === "UPLOAD_VERIFICATION_IN_PROGRESS";
      if (!contractRetryable || attempt === 2) throw failure;
      await sleep(failure.retryAfterMs ?? 250 * (attempt + 1));
    }
  }
  throw new AttachmentUploadClientError(
    "UPLOAD_COMPLETE_FAILED",
    "The upload could not be completed.",
  );
}

function completedAttachment(session: SessionView): Attachment | null {
  return session.state === "completed" ? session.attachment : null;
}

function assertSessionCanResume(session: SessionView): void {
  if (session.state === "expired") {
    throw new AttachmentUploadClientError("UPLOAD_SESSION_EXPIRED", "Upload session expired.");
  }
  if (session.state === "canceled") {
    throw new AttachmentUploadClientError("UPLOAD_SESSION_CANCELED", "Upload session was canceled.");
  }
  if (session.state === "failed") {
    throw new AttachmentUploadClientError("UPLOAD_OBJECT_MISMATCH", "Uploaded object failed verification.");
  }
}

async function recoverExistingSession(
  api: AttachmentUploadApi,
  uploadId: string,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<Attachment | null> {
  let session: SessionView;
  try {
    session = (await api.get<SessionView>(sessionEndpoint(uploadId), { signal })).data;
  } catch (error) {
    throw contractError(error, "UPLOAD_SESSION_STATUS_FAILED", "The upload session could not be checked.");
  }
  const attachment = completedAttachment(session);
  if (attachment) return attachment;
  assertSessionCanResume(session);
  try {
    return await completeUpload(api, uploadId, sleep, signal);
  } catch (error) {
    if (error instanceof AttachmentUploadClientError && error.code === "UPLOAD_OBJECT_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

type RawPutOutcome = "uploaded" | "already_exists" | "object_may_exist";
type UploadRequestResponse = Readonly<{ status: number }>;
type UploadRequest = (config: AxiosRequestConfig<File>) => Promise<UploadRequestResponse>;

const defaultUploadRequest: UploadRequest = async (config) => {
  const response = await axios.request(config);
  return { status: response.status };
}

/**
 * Always send the original File so Chromium does not turn the body into a
 * request stream, which requires HTTP/2 while R2's S3 endpoint negotiates
 * HTTP/1.1. XHR provides byte-level upload progress for that plain File body.
 * Browser XHR may follow redirects; that is an explicit product trade-off for
 * this transport, not a no-follow guarantee.
 *
 * A lost response is not replayed blindly; the caller checks the existing
 * upload session before asking the user to retry.
 */
async function putFile(
  file: File,
  upload: CreateResponse["upload"],
  signal: AbortSignal | undefined,
  requestImpl: UploadRequest,
  onProgress?: (progress: number) => void,
): Promise<RawPutOutcome> {
  let reportedProgress = 0;
  const reportProgress = (event: AxiosProgressEvent) => {
    if (!onProgress || file.size <= 0 || event.loaded <= 0) return;
    const progress = Math.max(1, Math.min(99, Math.round((event.loaded / file.size) * 100)));
    if (progress <= reportedProgress) return;
    reportedProgress = progress;
    onProgress(progress);
  };
  let response: UploadRequestResponse;
  try {
    response = await requestImpl({
      method: "PUT",
      url: upload.url,
      headers: {
        "Content-Type": upload.headers["Content-Type"],
        "If-None-Match": upload.headers["If-None-Match"],
      },
      data: file,
      adapter: "xhr",
      withCredentials: false,
      onUploadProgress: reportProgress,
      signal,
      validateStatus: () => true,
    });
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    return "object_may_exist";
  }
  if (response.status >= 200 && response.status < 300) return "uploaded";
  if (response.status === 412) return "already_exists";
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return "object_may_exist";
  }
  throw new AttachmentUploadClientError(
    "UPLOAD_OBJECT_PUT_FAILED",
    `Direct object upload failed with HTTP ${response.status}.`,
  );
}

async function createSession(
  api: AttachmentUploadApi,
  request: CreateRequest,
  signal?: AbortSignal,
): Promise<CreateResponse> {
  try {
    return (await api.post<CreateResponse>("/attachments/upload-sessions", request, { signal })).data;
  } catch (error) {
    throw contractError(error, "UPLOAD_SESSION_CREATE_FAILED", "The upload session could not be created.");
  }
}

export async function cancelAttachmentUploadSession(
  api: AttachmentUploadApi,
  uploadId: string,
): Promise<void> {
  await api.delete(sessionEndpoint(uploadId));
}

export async function uploadAttachmentFile(options: Readonly<{
  api: AttachmentUploadApi;
  file: File;
  channelId: string;
  clientRequestId: string;
  previousSession?: DirectAttachmentUploadSession;
  legacyUpload: () => Promise<string>;
  signal?: AbortSignal;
  onSession?: (session: DirectAttachmentUploadSession) => void;
  onProgress?: (progress: number) => void;
  requestImpl?: UploadRequest;
  sleep?: (ms: number) => Promise<void>;
}>): Promise<string> {
  const {
    api,
    file,
    channelId,
    clientRequestId,
    previousSession,
    legacyUpload,
    signal,
    onSession,
    onProgress,
    requestImpl = defaultUploadRequest,
    sleep = defaultSleep,
  } = options;

  let capability: Capabilities;
  try {
    capability = (await api.get<Capabilities>("/attachments/upload-capabilities", { signal })).data;
  } catch (error) {
    // Task #187 — fail SAFE, not closed. This used to fall back only on 404 and
    // throw on everything else, so a 500 / timeout / network blip killed the
    // upload even though the legacy path was working. That is exactly the
    // 2026-08-02 outage: the capability route 500'd and users could not upload
    // at all, while the fallback that would have saved them sat behind an
    // `=== 404` check.
    //
    // The rule is now "take the direct path only when the server explicitly
    // says it is enabled". Anything else degrades. An unanswered probe tells us
    // nothing about direct upload, and "we don't know" must resolve to the
    // path that always works.
    //
    // The ONE exception is an abort: the user cancelled, so starting a whole
    // legacy upload instead would be the opposite of what they asked for.
    if (isAbort(error, signal)) throw error;
    reportUploadCapabilityFallback(capabilityFallbackReason(error), httpStatus(error) ?? null, errorIdentity(error));
    return legacyUpload();
  }
  if (file.size <= 0) {
    throw new AttachmentUploadClientError("UPLOAD_INVALID_REQUEST", "The attachment is empty.");
  }
  if (file.size > capability.maxBytes) {
    throw new AttachmentUploadClientError("UPLOAD_TOO_LARGE", "The attachment exceeds the plan limit.");
  }
  const direct = capability.directUploadEnabled
    && capability.directUploadThresholdBytes !== null
    && file.size >= capability.directUploadThresholdBytes;
  if (!direct) {
    // Healthy fallbacks are reported too, so the anomaly counts above have a
    // denominator. Without this, "direct upload is disabled everywhere" and
    // "direct upload is broken everywhere" produce the same silence.
    reportUploadCapabilityFallback(
      capability.directUploadEnabled ? "below_threshold" : "not_enabled",
      null,
    );
    return legacyUpload();
  }

  if (previousSession) {
    const recovered = await recoverExistingSession(api, previousSession.uploadId, sleep, signal);
    if (recovered) return recovered.id;
  }

  const session = await createSession(api, {
    channelId,
    filename: file.name,
    mimeType: mimeTypeForUpload(file),
    sizeBytes: file.size,
    clientRequestId,
  }, signal);
  onSession?.({ uploadId: session.uploadId });

  let putOutcome: RawPutOutcome;
  try {
    putOutcome = await putFile(file, session.upload, signal, requestImpl, onProgress);
  } catch (error) {
    if (signal?.aborted) throw error;
    await cancelAttachmentUploadSession(api, session.uploadId).catch(() => undefined);
    throw error;
  }
  if (putOutcome === "object_may_exist") {
    const recovered = await recoverExistingSession(api, session.uploadId, sleep, signal);
    if (recovered) return recovered.id;
    throw new AttachmentUploadClientError(
      "UPLOAD_OBJECT_PUT_UNCERTAIN",
      "The upload response was lost. Retry to safely resume this upload.",
      true,
    );
  }
  const attachment = await completeUpload(api, session.uploadId, sleep, signal);
  return attachment.id;
}
