import {
  createAgentApiMessageClient,
  type AgentApiMessageClient,
  type AgentApiMessageClientError,
  type AgentApiMessageClientFailure,
  type AgentApiMessageClientOptions,
  type AgentApiMessageClientResult,
  type AgentApiMessageClientSuccess,
} from "@botiverse/raft-shared/src/agentApiMessages";
import {
  createAgentApiClient,
} from "@botiverse/raft-shared/src/agentApiClient";
import { MANUAL_CONTEXT_CAPABILITY, RAFT_CLIENT_CAPABILITIES_HEADER } from "@botiverse/raft-shared";

import {
  joinRaftChannelByTarget,
  type RaftChannelJoinRequest,
  type RaftChannelJoinResult,
} from "./channelJoin";
import { receiveRaftEvents, type RaftEventsReceiveRequest, type RaftEventsReceiveResult } from "./events";
import { createRaftRoutes, type RaftRoutes } from "./routes";
import { getRaftContext, type RaftContextResult } from "./context";
import { createRaftManageClient, type RaftManageClient } from "./manage";

export type RaftClient = AgentApiMessageClient & RaftManageClient & {
  events: {
    /** Nonblocking inbox pull. Returned messages are acknowledged before the response; never automatically retried. */
    receive(request?: RaftEventsReceiveRequest): Promise<RaftEventsReceiveResult>;
  };
  channels: {
    join(request: RaftChannelJoinRequest): Promise<RaftChannelJoinResult>;
  };
  /**
   * Every Agent API route as `routes.<resource>.<method>({ params, query, body })` (one named object, typed per route),
   * typed from the shared contract, with per-route metadata via `routes.describe`.
   * Retry policy follows the contract: reads may retry, writes make one attempt.
   */
  routes: RaftRoutes;
  agent: {
    /** Read the bound agent, its Server (id, slug, name), and credential capabilities. */
    context(): Promise<RaftContextResult>;
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
  /** Static request headers, over the SDK's own (`sdkRequestHeaders`). `authorization` is always overwritten by `credential`. */
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
 * The headers every SDK request carries: the caller's static `headers` over
 * the SDK's own `X-Raft-Client: sdk` (the Server records Manual requests by
 * client) and `X-Raft-Client-Capabilities: manual-context-v1` (manual.get and
 * manual.search always send intent and reason). Names come back lowercase.
 */
export function sdkRequestHeaders(headers?: Record<string, string>): Record<string, string> {
  const merged = new Headers({ "X-Raft-Client": "sdk", [RAFT_CLIENT_CAPABILITIES_HEADER]: MANUAL_CONTEXT_CAPABILITY });
  for (const [name, value] of new Headers(headers)) merged.set(name, value);
  return Object.fromEntries(merged);
}

/**
 * Create the program-layer client for the credential-derived
 * `/internal/agent-api/*` surface: typed calls with plain API results, for
 * programs and bots. Stable under semver. The agent layer
 * (`createRaftAgent`, `@botiverse/raft-sdk/agent`) is built on it.
 */
export function createRaftClient(options: CreateRaftClientOptions): RaftClient {
  const serverUrl = requireServerUrl(options.serverUrl);
  const credential = requireAgentCredential(options.credential);
  const auth = { authorization: `Bearer ${credential}` };
  const headers = sdkRequestHeaders(options.headers);

  const messageClient = createAgentApiMessageClient({
    baseUrl: serverUrl,
    fetch: options.fetch,
    headers,
    retry: options.retry,
    throttle: options.throttle,
    auth,
  });
  const agentApi = createAgentApiClient({
    fetch: {
      baseUrl: serverUrl,
      fetch: options.fetch,
      headers,
      retry: {
        attempts: Math.min(Math.max(1, options.retry?.attempts ?? 1), 5),
      },
      throttle: options.throttle,
      auth,
    },
  });
  // Writes are not idempotent (a retried prepare would post a second card), so
  // they always make one attempt regardless of options.retry.
  const writeApi = createAgentApiClient({
    fetch: {
      baseUrl: serverUrl,
      fetch: options.fetch,
      headers,
      retry: { attempts: 1 },
      throttle: options.throttle,
      auth,
    },
  });
  const eventsApi = createAgentApiClient({
    fetch: {
      baseUrl: serverUrl,
      // This GET acknowledges messages. Avoid browser cache reuse and implicit redirect requests.
      fetch: (input, init) => (options.fetch ?? fetch)(input, { ...init, cache: "no-store", redirect: "error" }),
      // sdkRequestHeaders lowercases names, so the shared transport's authorization overlay wins.
      headers,
      retry: { attempts: 1 },
      throttle: options.throttle,
      auth,
    },
  });

  return {
    ...messageClient,
    ...createRaftManageClient(agentApi, writeApi, {
      serverUrl,
      fetch: options.fetch ?? fetch,
      headers,
      authorization: auth.authorization,
      beforeRequest: options.throttle?.beforeRequest,
    }),
    events: {
      receive: (request) => receiveRaftEvents(eventsApi, request),
    },
    channels: {
      join: (request) => joinRaftChannelByTarget(agentApi, request),
    },
    routes: createRaftRoutes({
      serverUrl,
      fetch: options.fetch,
      headers,
      authorization: auth.authorization,
      readAttempts: options.retry?.attempts,
      beforeRequest: options.throttle?.beforeRequest,
    }),
    agent: {
      context: () => getRaftContext(agentApi),
    },
  };
}
