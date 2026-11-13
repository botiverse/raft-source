import { executeJsonRequest, executeResponseRequest, ChatBridgeToolTimeoutError, DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS, HttpStatusError } from "./chatBridgeRequest";
import { daemonFetch } from "./daemonFetch";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DaemonScopeAttestation {
  attestation: string;
  scope: string;
  audience: string;
  resource: string | null;
  metadata?: Record<string, unknown>;
  expiresAt: string;
}

export interface RequestDaemonScopeAttestationOptions {
  serverUrl: string;
  apiKey: string;
  scope: string;
  metadata?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Optional caller cancellation (merged with the per-hop timeout). Absent = today's behaviour. */
  signal?: AbortSignal;
}

export interface DirectUploadCreateResponse {
  upload: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  };
  [key: string]: unknown;
}

export interface CreateDirectUploadSessionOptions<TResponse extends DirectUploadCreateResponse> {
  /** Runs after the server signed, BEFORE the worker is contacted. Throw to abort. */
  verifyCapability?: (capability: DaemonScopeAttestation) => void;
  serverUrl: string;
  apiKey: string;
  workerUrl: string;
  scope: string;
  createPath?: string;
  body: Record<string, unknown>;
  attestationMetadata?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Optional caller cancellation for every hop. Absent = today's behaviour. */
  signal?: AbortSignal;
  /**
   * Hold every hop to `workerUrl`'s origin: no redirects on the create POST
   * or the PUT, and the PUT URL the worker returns must be on that origin, or
   * the upload fails before any bytes are sent. For a receiver this daemon did
   * not choose itself (a server-named trace upload URL). Absent = today's behaviour.
   */
  pinWorkerOrigin?: boolean;
}

export interface UploadWithSignedCapabilityOptions {
  /**
   * Runs after the server signed and the worker created the session, BEFORE
   * any bytes are uploaded. Throw to abort (e.g. the server or worker did not
   * acknowledge an attachment kind the caller depends on).
   */
  verifySession?: (capability: DaemonScopeAttestation, session: DirectUploadCreateResponse) => void;
  /** Runs after the server signed, BEFORE the worker is contacted. Throw to abort. */
  verifyCapability?: (capability: DaemonScopeAttestation) => void;
  serverUrl: string;
  apiKey: string;
  workerUrl: string;
  scope: string;
  createPath?: string;
  createBody: Record<string, unknown>;
  attestationMetadata?: Record<string, unknown>;
  uploadBody: BodyInit;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /** Optional caller cancellation for every hop (attestation, create, PUT). Absent = today's behaviour. */
  signal?: AbortSignal;
  /**
   * Hold every hop to `workerUrl`'s origin: no redirects on the create POST
   * or the PUT, and the PUT URL the worker returns must be on that origin, or
   * the upload fails before any bytes are sent. For a receiver this daemon did
   * not choose itself (a server-named trace upload URL). Absent = today's behaviour.
   */
  pinWorkerOrigin?: boolean;
}

/** The worker named a PUT target off its own origin while `pinWorkerOrigin` was set. */
export class DirectUploadTargetOriginError extends Error {
  override name = "DirectUploadTargetOriginError";
}

/** Which hop of a signed direct upload failed. */
export type DirectUploadStage = "attestation" | "create" | "put";
const DIRECT_UPLOAD_STAGE = Symbol.for("raft.daemon.directUploadStage");

/** Tag an error with its hop without changing its class or message (logs and callers keep their text). */
function tagStage<T>(err: T, stage: DirectUploadStage): T {
  if (err && typeof err === "object" && !(DIRECT_UPLOAD_STAGE in err)) {
    Object.defineProperty(err, DIRECT_UPLOAD_STAGE, { value: stage, enumerable: false });
  }
  return err;
}

export interface DirectUploadFailureClass {
  stage: DirectUploadStage | null;
  httpStatus: number | null;
  httpClass: "4xx" | "5xx" | "timeout" | "network" | "other";
}

/** Typed classification of a failure thrown by uploadWithSignedCapability. Never parses messages for status. */
export function classifyDirectUploadFailure(err: unknown): DirectUploadFailureClass {
  const chain: unknown[] = [];
  for (let e: unknown = err; e && chain.length < 5; e = (e as { cause?: unknown }).cause) chain.push(e);
  const tagged = chain.find((e) => e && typeof e === "object" && DIRECT_UPLOAD_STAGE in e) as Record<symbol, unknown> | undefined;
  const stage = (tagged?.[DIRECT_UPLOAD_STAGE] as DirectUploadStage | undefined) ?? null;
  const http = chain.find((e): e is HttpStatusError => e instanceof HttpStatusError);
  if (http) return { stage, httpStatus: http.status, httpClass: http.status >= 500 ? "5xx" : http.status >= 400 ? "4xx" : "other" };
  if (chain.some((e) => e instanceof ChatBridgeToolTimeoutError)) return { stage, httpStatus: null, httpClass: "timeout" };
  if (chain.some((e) => e instanceof TypeError)) return { stage, httpStatus: null, httpClass: "network" };
  return { stage, httpStatus: null, httpClass: "other" };
}

/** Keep the HTTP status in the message: callers and logs classify on it. */
function withStatus(prefix: string, err: unknown, stage: DirectUploadStage): never {
  if (err instanceof HttpStatusError) {
    throw tagStage(new Error(`${prefix} (${err.status})${err.serverError ? `: ${err.serverError}` : ""}`, { cause: err }), stage);
  }
  throw tagStage(err, stage);
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function sameOrigin(target: unknown, base: string): boolean {
  if (typeof target !== "string") return false;
  try {
    return new URL(target).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

function jsonHeaders(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

export async function requestDaemonScopeAttestation({
  serverUrl,
  apiKey,
  scope,
  metadata,
  fetchImpl = daemonFetch,
  timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
  signal,
}: RequestDaemonScopeAttestationOptions): Promise<DaemonScopeAttestation> {
  const { data } = await executeJsonRequest<DaemonScopeAttestation>(
    joinUrl(serverUrl, "/internal/machine/scope-attestation"),
    {
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({
        scope,
        ...(metadata ? { metadata } : {}),
      }),
      ...(signal ? { signal } : {}),
    },
    {
      toolName: "daemon_direct_upload.scope_attestation",
      target: scope,
      timeoutMs,
      fetchImpl,
    },
  ).catch((err: unknown) => withStatus("Failed to request daemon scope attestation", err, "attestation"));

  return data;
}

export async function createDirectUploadSession<TResponse extends DirectUploadCreateResponse>({
  serverUrl,
  apiKey,
  workerUrl,
  scope,
  createPath = "/api/uploads",
  body,
  attestationMetadata,
  verifyCapability,
  fetchImpl = daemonFetch,
  timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
  signal,
  pinWorkerOrigin = false,
}: CreateDirectUploadSessionOptions<TResponse>): Promise<{ capability: DaemonScopeAttestation; response: TResponse }> {
  const capability = await requestDaemonScopeAttestation({
    serverUrl,
    apiKey,
    scope,
    metadata: attestationMetadata,
    fetchImpl,
    timeoutMs,
    signal,
  });
  verifyCapability?.(capability);

  const { data } = await executeJsonRequest<TResponse>(
    joinUrl(workerUrl, createPath),
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ...body,
        attestation: capability.attestation,
      }),
      ...(signal ? { signal } : {}),
      ...(pinWorkerOrigin ? { redirect: "error" as const } : {}),
    },
    {
      toolName: "daemon_direct_upload.create",
      target: capability.audience,
      timeoutMs,
      fetchImpl,
    },
  ).catch((err: unknown) => withStatus("Failed to create direct upload session", err, "create"));

  return { capability, response: data };
}

export async function uploadWithSignedCapability({
  serverUrl,
  apiKey,
  workerUrl,
  scope,
  createPath = "/api/uploads",
  createBody,
  attestationMetadata,
  uploadBody,
  verifySession,
  verifyCapability,
  fetchImpl = daemonFetch,
  timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
  signal,
  pinWorkerOrigin = false,
}: UploadWithSignedCapabilityOptions): Promise<{ capability: DaemonScopeAttestation; session: DirectUploadCreateResponse; uploadResponse: Response }> {
  const { capability, response: session } = await createDirectUploadSession({
    serverUrl,
    apiKey,
    workerUrl,
    scope,
    createPath,
    body: createBody,
    attestationMetadata,
    verifyCapability,
    fetchImpl,
    timeoutMs,
    signal,
    pinWorkerOrigin,
  });
  verifySession?.(capability, session);
  if (pinWorkerOrigin && !sameOrigin(session.upload.url, workerUrl)) {
    throw tagStage(new DirectUploadTargetOriginError("Upload target is not on the worker's origin"), "put");
  }

  const { response: uploadResponse } = await executeResponseRequest(
    session.upload.url,
    {
      method: session.upload.method,
      headers: session.upload.headers ?? {},
      body: uploadBody,
      ...(signal ? { signal } : {}),
      ...(pinWorkerOrigin ? { redirect: "error" as const } : {}),
    },
    {
      toolName: "daemon_direct_upload.put",
      target: capability.audience,
      timeoutMs,
      fetchImpl,
    },
  ).catch((err: unknown) => { throw tagStage(err, "put"); });

  if (!uploadResponse.ok) {
    throw tagStage(
      new Error(`Failed to upload with signed capability (${uploadResponse.status})`, {
        cause: new HttpStatusError("daemon_direct_upload.put", uploadResponse.status, null),
      }),
      "put",
    );
  }

  return { capability, session, uploadResponse };
}
