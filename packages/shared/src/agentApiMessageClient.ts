import {
  agentApiSendBodySchema,
  agentApiSendV2BodySchema,
  agentApiSendResponseSchema,
  type AgentApiSendBody,
  type AgentApiSendV2Body,
  type AgentApiSendResponse,
} from "./agentApiMessageContract.js";
import {
  AGENT_API_BASE_PATH,
  AGENT_API_MESSAGE_SEND_PATH,
  AGENT_API_MESSAGE_SEND_V2_PATH,
} from "./agentApiPaths.js";

export type AgentApiMessageClientErrorReason =
  | "request_contract_mismatch"
  | "transport_error"
  | "http_error"
  | "empty_response"
  | "response_contract_mismatch";

export type AgentApiMessageClientError =
  | {
    kind: "transport";
    reason: "transport_error";
    message: string;
    cause?: unknown;
  }
  | {
    kind: "http";
    reason: "http_error";
    message: string;
    status: number;
    errorCode?: string | null;
    suggestedNextAction?: string | null;
    proxy?: unknown;
    response?: unknown;
  }
  | {
    kind: "validation";
    reason: Exclude<AgentApiMessageClientErrorReason, "transport_error" | "http_error">;
    message: string;
    status?: number;
    cause?: unknown;
    response?: unknown;
  };

export interface AgentApiMessageClientSuccess {
  ok: true;
  status: number;
  data: AgentApiSendResponse;
}

export interface AgentApiMessageClientFailure {
  ok: false;
  status?: number;
  error: AgentApiMessageClientError;
}

export type AgentApiMessageClientResult = AgentApiMessageClientSuccess | AgentApiMessageClientFailure;

export interface AgentApiMessageTransportRequest {
  method: "POST";
  path: string;
  body: AgentApiSendBody | AgentApiSendV2Body;
}

export type AgentApiMessageAuthHeaders = Record<string, string>;
export type AgentApiMessageAuthStrategy =
  | AgentApiMessageAuthHeaders
  | ((request: AgentApiMessageTransportRequest) => AgentApiMessageAuthHeaders | Promise<AgentApiMessageAuthHeaders>);

export interface AgentApiMessageClientOptions {
  baseUrl: string;
  headers?: AgentApiMessageAuthHeaders;
  auth?: AgentApiMessageAuthStrategy;
  fetch?: typeof fetch;
  retry?: {
    attempts?: number;
  };
  throttle?: {
    beforeRequest?: (request: AgentApiMessageTransportRequest) => Promise<void> | void;
  };
}

export interface AgentApiMessageClient {
  messages: {
    send(body: AgentApiSendBody): Promise<AgentApiMessageClientResult>;
    sendV2(body: AgentApiSendV2Body): Promise<AgentApiMessageClientResult>;
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

async function parseResponse(response: Response): Promise<unknown | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function httpFailure(response: Response, data: unknown): AgentApiMessageClientFailure {
  const objectData = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    ok: false,
    status: response.status,
    error: {
      kind: "http",
      reason: "http_error",
      message: typeof objectData.error === "string"
        ? objectData.error
        : response.statusText || `HTTP ${response.status}`,
      status: response.status,
      errorCode: typeof objectData.errorCode === "string"
        ? objectData.errorCode
        : typeof objectData.code === "string" ? objectData.code : null,
      suggestedNextAction: typeof objectData.suggestedNextAction === "string"
        ? objectData.suggestedNextAction
        : null,
      proxy: objectData.proxy,
      response: data,
    },
  };
}

function requestHeaders(
  staticHeaders: AgentApiMessageAuthHeaders | undefined,
  authHeaders: AgentApiMessageAuthHeaders | undefined,
): Headers {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  for (const [name, value] of Object.entries(staticHeaders ?? {})) headers.set(name, value);
  for (const [name, value] of Object.entries(authHeaders ?? {})) headers.set(name, value);
  return headers;
}

export function createAgentApiMessageClient(options: AgentApiMessageClientOptions): AgentApiMessageClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const requestedAttempts = options.retry?.attempts ?? 1;
  const maxAttempts = Number.isSafeInteger(requestedAttempts) && requestedAttempts > 0
    ? Math.min(requestedAttempts, 5)
    : 1;

  const send = async (
    input: AgentApiSendBody | AgentApiSendV2Body,
    version: "v1" | "v2",
  ): Promise<AgentApiMessageClientResult> => {
    const parsedBody = version === "v2"
      ? agentApiSendV2BodySchema.safeParse(input)
      : agentApiSendBodySchema.safeParse(input);
    if (!parsedBody.success) {
      return {
        ok: false,
        error: {
          kind: "validation",
          reason: "request_contract_mismatch",
          message: "Agent API message send body did not match the shared contract",
          cause: parsedBody.error,
        },
      };
    }

    const request: AgentApiMessageTransportRequest = {
      method: "POST",
      path: `${AGENT_API_BASE_PATH}${version === "v2" ? AGENT_API_MESSAGE_SEND_V2_PATH : AGENT_API_MESSAGE_SEND_PATH}`,
      body: parsedBody.data,
    };
    let authHeaders: AgentApiMessageAuthHeaders | undefined;
    try {
      await options.throttle?.beforeRequest?.(request);
      authHeaders = typeof options.auth === "function"
        ? await options.auth(request)
        : options.auth;
    } catch (cause) {
      return {
        ok: false,
        error: {
          kind: "transport",
          reason: "transport_error",
          message: "Agent API message send transport preparation failed",
          cause,
        },
      };
    }
    const init: RequestInit = {
      method: request.method,
      headers: requestHeaders(options.headers, authHeaders),
      body: JSON.stringify(request.body),
    };

    let response: Response | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        response = await fetchImpl(`${baseUrl}${request.path}`, init);
        break;
      } catch (cause) {
        if (attempt === maxAttempts) {
          return {
            ok: false,
            error: {
              kind: "transport",
              reason: "transport_error",
              message: "Agent API message send transport request failed",
              cause,
            },
          };
        }
      }
    }

    if (!response) {
      return {
        ok: false,
        error: {
          kind: "transport",
          reason: "transport_error",
          message: "Agent API message send transport request failed",
        },
      };
    }

    let data: unknown | null;
    try {
      data = await parseResponse(response);
    } catch (cause) {
      return {
        ok: false,
        status: response.status,
        error: {
          kind: "transport",
          reason: "transport_error",
          message: "Agent API message send response could not be read",
          cause,
        },
      };
    }
    if (!response.ok) return httpFailure(response, data);
    if (data === null) {
      return {
        ok: false,
        status: response.status,
        error: {
          kind: "validation",
          reason: "empty_response",
          message: "Agent API message send returned an empty response",
          status: response.status,
        },
      };
    }

    const parsedResponse = agentApiSendResponseSchema.safeParse(data);
    if (!parsedResponse.success) {
      return {
        ok: false,
        status: response.status,
        error: {
          kind: "validation",
          reason: "response_contract_mismatch",
          message: "Agent API message send response did not match the shared contract",
          status: response.status,
          cause: parsedResponse.error,
          response: data,
        },
      };
    }

    return {
      ok: true,
      status: response.status,
      data: parsedResponse.data,
    };
  };

  return {
    messages: {
      send: (input) => send(input, "v1"),
      sendV2: (input) => send(input, "v2"),
    },
  };
}
