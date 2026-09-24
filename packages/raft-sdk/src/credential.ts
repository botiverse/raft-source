import { currentDate } from "@botiverse/raft-shared/src/clock.js";

import {
  createRaftClient,
  requireAgentCredential,
  requireServerUrl,
  type CreateRaftClientOptions,
  type RaftClient,
} from "./client.js";

export interface RaftCredentialIdentity {
  serverUrl: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
  serverId: string;
  credentialId: string;
  scopes: string[];
}

export interface StoredRaftCredential extends RaftCredentialIdentity {
  schemaVersion: 1;
  credential: string;
  storedAt: string;
}

export interface RaftCredentialStore {
  load(): Promise<StoredRaftCredential | null>;
  /**
   * Persist the first credential. Implementations must reject replacement by
   * a different credential; saving the identical credential may be a no-op.
   */
  save(record: StoredRaftCredential): Promise<void>;
}

export type RaftCredentialErrorCode =
  | "CREDENTIAL_REJECTED"
  | "CREDENTIAL_VERIFY_FAILED"
  | "CREDENTIAL_RESPONSE_INVALID"
  | "CREDENTIAL_SCOPE_MISSING"
  | "CREDENTIAL_STORE_READ_FAILED"
  | "CREDENTIAL_STORE_WRITE_FAILED"
  | "CREDENTIAL_STORE_CONFLICT"
  | "CREDENTIAL_NOT_FOUND";

export class RaftCredentialError extends Error {
  readonly name = "RaftCredentialError";

  constructor(
    readonly code: RaftCredentialErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BootstrapRaftCredentialOptions {
  /** Raft Server origin whose Agent API will validate the credential. */
  serverUrl: string;
  /** Existing long-lived External Agent credential (`sk_agent_*`). */
  credential: string;
  /** Caller-selected durable store. */
  store: RaftCredentialStore;
  /** Optional fetch implementation for runtimes, tests, or network policy wrappers. */
  fetch?: typeof fetch;
}

export interface CreateRaftClientFromStoreOptions {
  store: RaftCredentialStore;
  fetch?: CreateRaftClientOptions["fetch"];
  headers?: CreateRaftClientOptions["headers"];
  retry?: CreateRaftClientOptions["retry"];
  throttle?: CreateRaftClientOptions["throttle"];
}

interface AgentIdentityResponse {
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
  serverId: string;
  credentialId: string;
  scopes: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseIdentityResponse(value: unknown): AgentIdentityResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    !isNonEmptyString(input.agentId)
    || !isNonEmptyString(input.agentName)
    || (input.agentDisplayName !== null && typeof input.agentDisplayName !== "string")
    || !isNonEmptyString(input.serverId)
    || !isNonEmptyString(input.credentialId)
    || !Array.isArray(input.scopes)
    || !input.scopes.every(isNonEmptyString)
  ) {
    return null;
  }
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    agentDisplayName: input.agentDisplayName,
    serverId: input.serverId,
    credentialId: input.credentialId,
    scopes: [...input.scopes],
  };
}

export function parseStoredRaftCredential(value: unknown): StoredRaftCredential | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    input.schemaVersion !== 1
    || !isNonEmptyString(input.serverUrl)
    || !isNonEmptyString(input.credential)
    || !isNonEmptyString(input.storedAt)
  ) {
    return null;
  }
  const identity = parseIdentityResponse(input);
  if (!identity || Number.isNaN(Date.parse(input.storedAt))) return null;

  let serverUrl: string;
  let credential: string;
  try {
    serverUrl = requireServerUrl(input.serverUrl);
    credential = requireAgentCredential(input.credential);
  } catch {
    return null;
  }

  return {
    schemaVersion: 1,
    serverUrl,
    credential,
    storedAt: input.storedAt,
    ...identity,
  };
}

/**
 * Validate an existing External Agent credential against Raft, derive its
 * bound identity from the credential-authenticated `whoami` surface, and save
 * it through the caller's explicit store. This does not mint or rotate a
 * credential and never returns the credential bytes.
 */
export async function bootstrapRaftCredential(
  options: BootstrapRaftCredentialOptions,
): Promise<RaftCredentialIdentity> {
  const serverUrl = requireServerUrl(options.serverUrl);
  const credential = requireAgentCredential(options.credential);
  const httpFetch = options.fetch ?? globalThis.fetch;

  let existing: StoredRaftCredential | null;
  try {
    existing = await options.store.load();
  } catch {
    throw new RaftCredentialError(
      "CREDENTIAL_STORE_READ_FAILED",
      "The existing Agent credential could not be checked before saving",
    );
  }
  if (existing) {
    const validatedExisting = parseStoredRaftCredential(existing);
    if (!validatedExisting) {
      throw new RaftCredentialError(
        "CREDENTIAL_STORE_READ_FAILED",
        "The existing Agent credential record is invalid",
      );
    }
    existing = validatedExisting;
    if (
      existing.serverUrl !== serverUrl
      || existing.credential !== credential
    ) {
      throw new RaftCredentialError(
        "CREDENTIAL_STORE_CONFLICT",
        "The credential store already contains a different Raft Agent credential",
      );
    }
  }

  let response: Response;
  try {
    response = await httpFetch(`${serverUrl}/internal/agent-api/`, {
      method: "GET",
      headers: { authorization: `Bearer ${credential}` },
    });
  } catch {
    throw new RaftCredentialError(
      "CREDENTIAL_VERIFY_FAILED",
      "Could not reach the Raft Server to verify the Agent credential",
    );
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new RaftCredentialError(
        "CREDENTIAL_REJECTED",
        "The Raft Server rejected the Agent credential",
      );
    }
    throw new RaftCredentialError(
      "CREDENTIAL_VERIFY_FAILED",
      `The Raft Server could not verify the Agent credential (status ${response.status})`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RaftCredentialError(
      "CREDENTIAL_RESPONSE_INVALID",
      "The Raft Server returned an invalid Agent identity response",
    );
  }
  const identity = parseIdentityResponse(payload);
  if (!identity) {
    throw new RaftCredentialError(
      "CREDENTIAL_RESPONSE_INVALID",
      "The Raft Server returned an invalid Agent identity response",
    );
  }
  if (!identity.scopes.includes("send")) {
    throw new RaftCredentialError(
      "CREDENTIAL_SCOPE_MISSING",
      "The Raft Agent credential does not include the send capability required by this SDK",
    );
  }

  if (
    existing
    && (
      existing.serverId !== identity.serverId
      || existing.agentId !== identity.agentId
    )
  ) {
    throw new RaftCredentialError(
      "CREDENTIAL_STORE_CONFLICT",
      "The credential store is already bound to a different Raft Agent identity",
    );
  }

  if (existing) {
    return { serverUrl, ...identity };
  }

  const record: StoredRaftCredential = {
    schemaVersion: 1,
    serverUrl,
    credential,
    storedAt: currentDate().toISOString(),
    ...identity,
  };

  try {
    await options.store.save(record);
  } catch (error) {
    if (
      error instanceof RaftCredentialError
      && error.code === "CREDENTIAL_STORE_CONFLICT"
    ) {
      throw error;
    }
    throw new RaftCredentialError(
      "CREDENTIAL_STORE_WRITE_FAILED",
      "The verified Agent credential could not be saved",
    );
  }

  return { serverUrl, ...identity };
}

/** Load the caller-selected credential store and create a normal Raft client. */
export async function createRaftClientFromStore(
  options: CreateRaftClientFromStoreOptions,
): Promise<RaftClient> {
  let record: StoredRaftCredential | null;
  try {
    record = await options.store.load();
  } catch {
    throw new RaftCredentialError(
      "CREDENTIAL_STORE_READ_FAILED",
      "The stored Agent credential could not be loaded",
    );
  }
  if (!record) {
    throw new RaftCredentialError(
      "CREDENTIAL_NOT_FOUND",
      "No stored Raft Agent credential was found",
    );
  }
  const validated = parseStoredRaftCredential(record);
  if (!validated) {
    throw new RaftCredentialError(
      "CREDENTIAL_STORE_READ_FAILED",
      "The stored Agent credential is invalid",
    );
  }
  if (!validated.scopes.includes("send")) {
    throw new RaftCredentialError(
      "CREDENTIAL_SCOPE_MISSING",
      "The stored Raft Agent credential does not include the send capability required by this SDK",
    );
  }
  return createRaftClient({
    serverUrl: validated.serverUrl,
    credential: validated.credential,
    fetch: options.fetch,
    headers: options.headers,
    retry: options.retry,
    throttle: options.throttle,
  });
}
