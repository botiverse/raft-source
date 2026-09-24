import {
  createAgentApiMessageClient,
  type AgentApiMessageClient,
  type AgentApiMessageClientError,
  type AgentApiMessageClientFailure,
  type AgentApiMessageClientOptions,
  type AgentApiMessageClientResult,
  type AgentApiMessageClientSuccess,
} from "@botiverse/raft-shared/src/agentApiMessages.js";
import {
  createAgentApiClient,
} from "@botiverse/raft-shared/src/agentApiClient.js";

import {
  joinRaftChannelByTarget,
  type RaftChannelJoinRequest,
  type RaftChannelJoinResult,
} from "./channelJoin.js";
import { receiveRaftEvents, type RaftEventsReceiveRequest, type RaftEventsReceiveResult } from "./events.js";

export type RaftClient = AgentApiMessageClient & {
  events: {
    /** Nonblocking inbox pull. Returned messages are acknowledged before the response; never automatically retried. */
    receive(request?: RaftEventsReceiveRequest): Promise<RaftEventsReceiveResult>;
  };
  channels: {
    join(request: RaftChannelJoinRequest): Promise<RaftChannelJoinResult>;
  };
};
export type RaftClientError = AgentApiMessageClientError;
export type RaftClientFailure = AgentApiMessageClientFailure;
export type RaftClientResult = AgentApiMessageClientResult;
export type RaftClientSuccess = AgentApiMessageClientSuccess;

export type RaftSdkConfigurationErrorCode =
  | "MISSING_SERVER_URL"
  | "INVALID_SERVER_URL"
  | "MISSING_AGENT_CREDENTIAL"
  | "INVALID_AGENT_CREDENTIAL"
  | "INVALID_CREDENTIAL_PATH";

export class RaftSdkConfigurationError extends Error {
  readonly name = "RaftSdkConfigurationError";

  constructor(
    readonly code: RaftSdkConfigurationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateRaftClientOptions {
  /** Raft Server origin, for example `https://api.raft.build`. */
  serverUrl: string;
  /** Credential bound to exactly one External Agent (`sk_agent_*`). */
  credential: string;
  /** Optional fetch implementation for runtimes, tests, or network policy wrappers. */
  fetch?: typeof fetch;
  /** Static request headers. `authorization` is always overwritten by `credential`. */
  headers?: Record<string, string>;
  /** Bounded transport retries. Defaults to one attempt and is capped at five. events.receive always uses one attempt. */
  retry?: AgentApiMessageClientOptions["retry"];
  /** Optional caller-owned throttle hook, invoked once per logical request. */
  throttle?: RaftClientThrottleOptions;
}

export interface RaftClientTransportRequest {
  method: string;
  path: string;
  body?: unknown;
}

export interface RaftClientThrottleOptions {
  beforeRequest?: (request: RaftClientTransportRequest) => Promise<void> | void;
}

export function requireServerUrl(value: string): string {
  const serverUrl = value.trim();
  if (!serverUrl) {
    throw new RaftSdkConfigurationError("MISSING_SERVER_URL", "Raft Server URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new RaftSdkConfigurationError(
      "INVALID_SERVER_URL",
      "Raft Server URL must be an absolute HTTP(S) URL",
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new RaftSdkConfigurationError(
      "INVALID_SERVER_URL",
      "Raft Server URL must use HTTP or HTTPS",
    );
  }
  if (parsed.username || parsed.password) {
    throw new RaftSdkConfigurationError(
      "INVALID_SERVER_URL",
      "Raft Server URL must not contain credentials",
    );
  }
  return serverUrl.replace(/\/+$/, "");
}

export function requireAgentCredential(value: string): string {
  const credential = value.trim();
  if (!credential) {
    throw new RaftSdkConfigurationError(
      "MISSING_AGENT_CREDENTIAL",
      "Raft Agent credential is required",
    );
  }
  if (!credential.startsWith("sk_agent_") || credential.length === "sk_agent_".length) {
    throw new RaftSdkConfigurationError(
      "INVALID_AGENT_CREDENTIAL",
      "Raft Agent credential must be a long-lived External Agent credential",
    );
  }
  return credential;
}

/**
 * Create a typed client for the credential-derived `/internal/agent-api/*`
 * surface. The SDK does not read CLI profiles, environment variables, or the
 * host user's home directory: the caller chooses and supplies the credential.
 */
export function createRaftClient(options: CreateRaftClientOptions): RaftClient {
  const serverUrl = requireServerUrl(options.serverUrl);
  const credential = requireAgentCredential(options.credential);
  const auth = { authorization: `Bearer ${credential}` };

  const messageClient = createAgentApiMessageClient({
    baseUrl: serverUrl,
    fetch: options.fetch,
    headers: options.headers,
    retry: options.retry,
    throttle: options.throttle,
    auth,
  });
  const agentApi = createAgentApiClient({
    fetch: {
      baseUrl: serverUrl,
      fetch: options.fetch,
      headers: options.headers,
      retry: {
        attempts: Math.min(Math.max(1, options.retry?.attempts ?? 1), 5),
      },
      throttle: options.throttle,
      auth,
    },
  });
  const eventsApi = createAgentApiClient({
    fetch: {
      baseUrl: serverUrl,
      // This GET acknowledges messages. Avoid browser cache reuse and implicit redirect requests.
      fetch: (input, init) => (options.fetch ?? fetch)(input, { ...init, cache: "no-store", redirect: "error" }),
      // Normalize casing before the shared transport overlays authorization.
      headers: Object.fromEntries(new Headers(options.headers)),
      retry: { attempts: 1 },
      throttle: options.throttle,
      auth,
    },
  });

  return {
    ...messageClient,
    events: {
      receive: (request) => receiveRaftEvents(eventsApi, request),
    },
    channels: {
      join: (request) => joinRaftChannelByTarget(agentApi, request),
    },
  };
}
