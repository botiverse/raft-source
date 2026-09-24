import { executeJsonRequest, executeResponseRequest, DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS } from "./chatBridgeRequest.js";
import { daemonFetch } from "./daemonFetch.js";

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
  serverUrl: string;
  apiKey: string;
  workerUrl: string;
  scope: string;
  createPath?: string;
  body: Record<string, unknown>;
  attestationMetadata?: Record<string, unknown>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface UploadWithSignedCapabilityOptions {
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
}

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, "")}${path}`;
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
}: RequestDaemonScopeAttestationOptions): Promise<DaemonScopeAttestation> {
  const { response, data } = await executeJsonRequest<DaemonScopeAttestation>(
    joinUrl(serverUrl, "/internal/machine/scope-attestation"),
    {
      method: "POST",
      headers: jsonHeaders(apiKey),
      body: JSON.stringify({
        scope,
        ...(metadata ? { metadata } : {}),
      }),
    },
    {
      toolName: "daemon_direct_upload.scope_attestation",
      target: scope,
      timeoutMs,
      fetchImpl,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to request daemon scope attestation (${response.status})`);
  }

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
  fetchImpl = daemonFetch,
  timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
}: CreateDirectUploadSessionOptions<TResponse>): Promise<{ capability: DaemonScopeAttestation; response: TResponse }> {
  const capability = await requestDaemonScopeAttestation({
    serverUrl,
    apiKey,
    scope,
    metadata: attestationMetadata,
    fetchImpl,
    timeoutMs,
  });

  const { response, data } = await executeJsonRequest<TResponse>(
    joinUrl(workerUrl, createPath),
    {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({
        ...body,
        attestation: capability.attestation,
      }),
    },
    {
      toolName: "daemon_direct_upload.create",
      target: capability.audience,
      timeoutMs,
      fetchImpl,
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to create direct upload session (${response.status})`);
  }

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
  fetchImpl = daemonFetch,
  timeoutMs = DEFAULT_CHAT_BRIDGE_TOOL_TIMEOUT_MS,
}: UploadWithSignedCapabilityOptions): Promise<{ capability: DaemonScopeAttestation; session: DirectUploadCreateResponse; uploadResponse: Response }> {
  const { capability, response: session } = await createDirectUploadSession({
    serverUrl,
    apiKey,
    workerUrl,
    scope,
    createPath,
    body: createBody,
    attestationMetadata,
    fetchImpl,
    timeoutMs,
  });

  const { response: uploadResponse } = await executeResponseRequest(
    session.upload.url,
    {
      method: session.upload.method,
      headers: session.upload.headers ?? {},
      body: uploadBody,
    },
    {
      toolName: "daemon_direct_upload.put",
      target: capability.audience,
      timeoutMs,
      fetchImpl,
    },
  );

  if (!uploadResponse.ok) {
    throw new Error(`Failed to upload with signed capability (${uploadResponse.status})`);
  }

  return { capability, session, uploadResponse };
}
