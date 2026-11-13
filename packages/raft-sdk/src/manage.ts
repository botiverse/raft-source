import type { z } from "zod";
import { MAX_PROFILE_AVATAR_BYTES } from "@botiverse/raft-shared";
import type { AgentApiClient, AgentApiClientResult } from "@botiverse/raft-shared/src/agentApiClient";
import type { prepareActionCardRequestSchema } from "@botiverse/raft-shared/src/agentOps/index";
import {
  parseAgentApiResponse,
  type agentApiAppConfigPatchBodySchema,
  type AgentApiActionPrepareResponse,
  type AgentApiAppConfigPatchBody,
  type AgentApiAppConfigResponse,
  type AgentApiProfileUpdateBody,
  type AgentApiProfileView,
  type AgentApiRouteKey,
  type AgentApiServerUpdateBody,
  type AgentApiServerUpdateResponse,
} from "@botiverse/raft-shared/src/agentApiContract";

export type RaftProfile = AgentApiProfileView;
export type RaftProfileUpdate = AgentApiProfileUpdateBody;
export type RaftServerUpdate = AgentApiServerUpdateBody;
export type RaftServerProfile = AgentApiServerUpdateResponse;
// Request types use the schema INPUT, so fields with Server-side defaults
// (for example channel:create `visibility`, patch `unset`) stay optional.
// A card is typed as this version knows it (the actions.prepare operation's
// schema); the wire carries any card, and the Server checks it.
export type RaftActionPrepareRequest = z.input<typeof prepareActionCardRequestSchema>;
export type RaftActionPrepared = AgentApiActionPrepareResponse;
export type RaftAppConfig = AgentApiAppConfigResponse;
export type RaftAppConfigPatch = z.input<typeof agentApiAppConfigPatchBodySchema>;

export interface RaftApiError {
  code: "INVALID_REQUEST" | "TRANSPORT_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE";
  /** Safe SDK text; raw transport errors and response bodies are never included. */
  message: string;
  /** The Server's stable machine code for an HTTP rejection, when it sends one. */
  errorCode?: string;
}

export type RaftApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status?: number; error: RaftApiError };

export interface RaftAvatarUpload {
  /** Image bytes: JPEG, PNG, GIF, or WebP, at most 5 MB. */
  data: Blob | Uint8Array;
  filename: string;
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

const AVATAR_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const SERVER_ERROR_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

const MESSAGES: Record<RaftApiError["code"], string> = {
  INVALID_REQUEST: "The request did not match the Agent API contract; nothing was sent.",
  TRANSPORT_ERROR: "The request did not reach the Raft Server.",
  HTTP_ERROR: "The Raft Server rejected the request.",
  INVALID_RESPONSE: "The Raft Server response did not match the Agent API contract.",
};

function failure<T>(code: RaftApiError["code"], status?: number, errorCode?: string | null): RaftApiResult<T> {
  const safeErrorCode = typeof errorCode === "string" && SERVER_ERROR_CODE.test(errorCode) ? errorCode : undefined;
  return {
    ok: false,
    ...(status === undefined ? {} : { status }),
    error: { code, message: MESSAGES[code], ...(safeErrorCode ? { errorCode: safeErrorCode } : {}) },
  };
}

/** Map a shared-client result to the SDK's body-free result. */
export function toRaftApiResult<K extends AgentApiRouteKey, T>(result: AgentApiClientResult<K>): RaftApiResult<T> {
  if (result.ok) return { ok: true, status: result.status, data: result.data as T };
  const { error } = result;
  if (error.kind === "transport") return failure("TRANSPORT_ERROR");
  if (error.kind === "http") return failure("HTTP_ERROR", error.status, error.errorCode);
  const requestSide = error.reason === "request_contract_mismatch"
    || error.reason === "missing_path_param"
    || error.reason === "missing_route";
  return failure(requestSide ? "INVALID_REQUEST" : "INVALID_RESPONSE", result.status);
}

export interface RaftAvatarTransport {
  serverUrl: string;
  fetch: typeof fetch;
  headers: Record<string, string>;
  authorization: string;
  beforeRequest?: (request: { method: string; path: string; body?: unknown }) => Promise<void> | void;
}

const AVATAR_PATH = "/internal/agent-api/profile/avatar";

/** One multipart POST; never retried, because the upload is a write. */
export async function uploadRaftAvatar(
  transport: RaftAvatarTransport,
  upload: RaftAvatarUpload,
): Promise<RaftApiResult<RaftProfile>> {
  if (!upload || !AVATAR_MIME_TYPES.has(upload.mimeType) || typeof upload.filename !== "string" || !upload.filename.trim()) {
    return failure("INVALID_REQUEST");
  }
  const blob = upload.data instanceof Blob
    ? upload.data
    : upload.data instanceof Uint8Array ? new Blob([Uint8Array.from(upload.data)], { type: upload.mimeType }) : null;
  if (!blob || blob.size === 0 || blob.size > MAX_PROFILE_AVATAR_BYTES) return failure("INVALID_REQUEST");

  const form = new FormData();
  form.append("avatar", blob, upload.filename);
  await transport.beforeRequest?.({ method: "POST", path: AVATAR_PATH });
  const headers = new Headers(transport.headers);
  // fetch sets the multipart boundary itself.
  headers.delete("content-type");
  headers.set("accept", "application/json");
  headers.set("authorization", transport.authorization);

  let response: Response;
  try {
    response = await transport.fetch(`${transport.serverUrl}${AVATAR_PATH}`, { method: "POST", headers, body: form });
  } catch {
    return failure("TRANSPORT_ERROR");
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const errorCode = body && typeof body === "object" ? (body as { errorCode?: unknown }).errorCode : undefined;
    return failure("HTTP_ERROR", response.status, typeof errorCode === "string" ? errorCode : null);
  }
  try {
    return { ok: true, status: response.status, data: parseAgentApiResponse("profileAvatarUpdate", body) };
  } catch {
    return failure("INVALID_RESPONSE", response.status);
  }
}

export interface RaftManageClient {
  profile: {
    /** Show your own profile, or another visible profile with `{ target: "@name" }`. Needs `read`. */
    show(request?: { target?: string }): Promise<RaftApiResult<RaftProfile>>;
    /** Update your display name, description, or avatar URL. Needs `send`. A hosted agent's description is human-only. */
    update(request: RaftProfileUpdate): Promise<RaftApiResult<RaftProfile>>;
    /** Upload an avatar image. Needs `send`. */
    updateAvatar(upload: RaftAvatarUpload): Promise<RaftApiResult<RaftProfile>>;
  };
  server: {
    /** Rename the Server or change member visibility. Needs `server` and owner/admin role. */
    update(request: RaftServerUpdate): Promise<RaftApiResult<RaftServerProfile>>;
  };
  actions: {
    /** Post an action card that a human confirms. Needs `tasks`. */
    prepare(request: RaftActionPrepareRequest): Promise<RaftApiResult<RaftActionPrepared>>;
  };
  apps: {
    /** Read a built-in app's configuration for this agent. Needs `read`. */
    getConfig(appId: string): Promise<RaftApiResult<RaftAppConfig>>;
    /** Atomically change a built-in app's configuration. Needs `tasks`. */
    patchConfig(appId: string, patch: RaftAppConfigPatch): Promise<RaftApiResult<RaftAppConfig>>;
  };
}

/** `readApi` may retry; `writeApi` must make exactly one attempt. */
export function createRaftManageClient(
  readApi: Pick<AgentApiClient, "profile" | "apps">,
  writeApi: Pick<AgentApiClient, "profile" | "server" | "actions" | "apps">,
  avatar: RaftAvatarTransport,
): RaftManageClient {
  return {
    profile: {
      show: async (request = {}) => toRaftApiResult(await readApi.profile.show(
        request.target === undefined ? {} : { target: request.target },
      )),
      update: async (request) => toRaftApiResult(await writeApi.profile.update(request)),
      updateAvatar: (upload) => uploadRaftAvatar(avatar, upload),
    },
    server: {
      update: async (request) => toRaftApiResult(await writeApi.server.update(request)),
    },
    actions: {
      // The shared client parses the body: a known card gets its defaults; any other goes as written, for the Server to check.
      prepare: async (request) => toRaftApiResult(await writeApi.actions.prepare(request)),
    },
    apps: {
      getConfig: async (appId) => toRaftApiResult(await readApi.apps.getConfig({ appId })),
      patchConfig: async (appId, patch) =>
        toRaftApiResult(await writeApi.apps.patchConfig({ appId }, patch as AgentApiAppConfigPatchBody)),
    },
  };
}
