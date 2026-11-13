import type {
  AgentApiClientFailure,
  AgentApiClientResult,
  AgentApiRawFailure,
  AgentApiRawResult,
  AgentApiRawTransport,
  AgentApiRequestBodyByRoute,
  AgentApiRequestParamsByRoute,
  AgentApiRequestQueryByRoute,
  AgentApiResponseByRoute,
  AgentApiRouteKey,
} from "@botiverse/raft-shared";
import {
  buildAgentApiRawRoutePath,
  buildLegacyAgentApiPath,
  agentApiClientResultFromRaw,
  agentApiContract,
  createAgentApiClient as createSharedAgentApiClient,
  getAgentApiResponseKind,
  parseAgentApiResponse,
  requestAgentApiRawRoute,
} from "@botiverse/raft-shared/src/agentCliSurface";

import type { ApiResponse, BinaryResponse } from "./client";
import { apiFailureError } from "./core/apiFailure";
import { CliError } from "./core/errors";

export function buildContractAgentPath(
  agentId: string,
  routePath: string,
  query?: URLSearchParams,
): string {
  const base = buildLegacyAgentApiPath(agentId, routePath);
  const suffix = query && query.size > 0 ? `?${query.toString()}` : "";
  return `${base}${suffix}`;
}

export function buildContractAgentPathForRoute<K extends AgentApiRouteKey>(
  agentId: string,
  routeKey: K,
  params?: AgentApiRequestParamsByRoute[K],
  query?: AgentApiRequestQueryByRoute[K],
): string {
  const path = buildAgentApiRawRoutePath(routeKey, {
    pathPrefix: buildLegacyAgentApiPath(agentId, ""),
    params,
    query,
  });
  if (typeof path === "string") return path;
  throw cliErrorFromRawFailure(path);
}

export function buildAgentApiRoutePath<K extends AgentApiRouteKey>(
  routeKey: K,
  pathParams?: AgentApiRequestParamsByRoute[K],
  query?: AgentApiRequestQueryByRoute[K],
): string {
  const path = buildAgentApiRawRoutePath(routeKey, { params: pathParams, query });
  if (typeof path === "string") return path;
  throw cliErrorFromRawFailure(path);
}

interface CliAgentApiHttpClient {
  request<T>(method: string, pathname: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<ApiResponse<T>>;
  requestRawBody?<T>(method: string, pathname: string, bytes: Uint8Array, contentType?: string): Promise<ApiResponse<T>>;
  requestBinary?(method: string, pathname: string): Promise<BinaryResponse>;
  requestMultipart?<T>(method: string, pathname: string, form: FormData): Promise<ApiResponse<T>>;
}

export function buildAgentApiEventsPath(query?: AgentApiRequestQueryByRoute["events"]): string {
  return buildAgentApiRoutePath("events", undefined, query);
}

function rawTransportForClient(client: CliAgentApiHttpClient, options?: { signal?: AbortSignal }): AgentApiRawTransport {
  return {
    request: async (input) => {
      const route = agentApiContract[input.routeKey];
      if (getAgentApiResponseKind(route.response) === "binary") {
        if (typeof client.requestBinary !== "function") {
          throw new CliError({
            code: "VIEW_FAILED",
            message: "Agent API binary download transport is unavailable in this CLI context",
          });
        }
        const response = await client.requestBinary(input.method, input.path);
        return {
          ok: response.ok,
          status: response.status,
          // A refusal's body reaches the operations, as on the JSON path, so they
          // can show the Server's sentence and next step for a failed download.
          data: response.ok ? response.body : (response.errorBody ?? null),
          error: response.error,
          errorCode: response.errorCode,
          suggestedNextAction: response.suggestedNextAction ?? null,
          proxy: response.proxy,
        };
      }
      const response = options
        ? await client.request<unknown>(input.method, input.path, input.body, options)
        : await client.request<unknown>(input.method, input.path, input.body);
      // A refusal's body (`details` and all) reaches the operations, as it does over fetch.
      return response.ok || response.errorBody === undefined ? response : { ...response, data: response.errorBody };
    },
  };
}

/** Shared-contract client used by higher-level SDK operations inside the CLI. */
export function createAgentApiContractSurfaceClient(client: CliAgentApiHttpClient, options?: { signal?: AbortSignal }) {
  return createSharedAgentApiClient(rawTransportForClient(client, options));
}

function cliErrorFromRawFailure(failure: AgentApiRawFailure): CliError {
  switch (failure.reason) {
    case "missing_path_param":
    case "request_contract_mismatch":
      return new CliError({
        code: "INVALID_ARG",
        message: failure.message,
        cause: failure.cause,
      });
    case "empty_response":
    case "response_contract_mismatch":
    case "missing_route":
      return new CliError({
        code: "INVALID_JSON_RESPONSE",
        message: failure.message,
        cause: failure.cause,
      });
    case "transport_error":
      return cliErrorFromTransportFailure(
        failure.message,
        failure.cause,
        failure.routeKey,
      );
    case "http_error":
      return new CliError({
        code: "CHECK_FAILED",
        message: failure.message,
        cause: failure.cause,
      });
  }
}

function cliErrorFromTransportFailure(
  message: string,
  cause: unknown,
  routeKey?: AgentApiRouteKey,
): CliError {
  // ApiClient already turns a received daemon-proxy response into a typed
  // CliError with correlation and proxy diagnostics. The shared raw client
  // catches it at its transport boundary, so preserve that classification
  // instead of flattening a known response into a new CHECK_FAILED wrapper.
  if (cause instanceof CliError) return cause;

  const method = routeKey === undefined ? undefined : agentApiContract[routeKey].method;
  return new CliError({
    code: "CHECK_FAILED",
    message,
    cause,
    faultDomain: "agent_api_transport",
    // A transport exception has no authoritative response. Reads are safe to
    // repeat; writes are not, because the request may have committed.
    retryable: method === "GET" ? true : method === undefined ? undefined : false,
  });
}

function cliErrorFromClientFailure(failure: AgentApiClientFailure): CliError {
  switch (failure.error.kind) {
    case "validation":
      switch (failure.error.reason) {
        case "missing_path_param":
        case "request_contract_mismatch":
          return new CliError({
            code: "INVALID_ARG",
            message: failure.error.message,
            cause: failure.error.cause,
          });
        case "empty_response":
        case "response_contract_mismatch":
        case "missing_route":
          return new CliError({
            code: "INVALID_JSON_RESPONSE",
            message: failure.error.message,
            cause: failure.error.cause,
          });
      }
      break;
    case "transport":
      return cliErrorFromTransportFailure(
        failure.error.message,
        failure.error.cause,
        failure.routeKey,
      );
    case "http":
      return new CliError({
        code: "CHECK_FAILED",
        message: failure.error.message,
      });
  }
}

function apiResponseFromClientResult<K extends AgentApiRouteKey>(
  result: AgentApiClientResult<K>,
): ApiResponse<AgentApiResponseByRoute[K]> {
  if (result.ok) {
    return {
      ok: true,
      status: result.status,
      data: result.data,
      error: null,
    };
  }
  if (result.error.kind === "http") {
    const response = {
      ok: false,
      status: result.error.status,
      data: null,
      error: result.error.message,
      errorCode: result.error.errorCode,
      suggestedNextAction: result.error.suggestedNextAction,
      proxy: result.error.proxy as ApiResponse<AgentApiResponseByRoute[K]>["proxy"],
      // A refusal's whole body (`path`, `currentRevision`, `retry_after`, …), for commands that explain it.
      ...(result.error.response !== undefined ? { errorBody: result.error.response } : {}),
    };
    if (response.status >= 500 && response.errorCode === "agent_proxy_failed") {
      throw apiFailureError(response, "CHECK_FAILED");
    }
    return response;
  }
  throw cliErrorFromClientFailure(result);
}

/**
 * The CLI's failure rules for a shared agent operation's requests (an
 * `agentOps` function called with `createAgentApiContractSurfaceClient`):
 * `observe` throws a transport or contract failure and a daemon-proxy 5xx
 * exactly as `createAgentApiSurfaceClient` calls do, and hands an HTTP
 * refusal back to the operation; `last()` is the latest refusal as the CLI's
 * ApiResponse, for the command's own error message.
 */
export function createCliOperationFailures() {
  let last: ApiResponse<unknown> | null = null;
  return {
    async observe<K extends AgentApiRouteKey>(request: Promise<AgentApiClientResult<K>>): Promise<AgentApiClientResult<K>> {
      const result = await request;
      if (!result.ok) last = apiResponseFromClientResult(result);
      return result;
    },
    last: (): ApiResponse<unknown> | null => last,
  };
}

async function rawRouteResultAsApiResponse<K extends AgentApiRouteKey>(
  result: Promise<AgentApiRawResult<K>>,
): Promise<ApiResponse<AgentApiResponseByRoute[K]>> {
  return apiResponseFromClientResult(agentApiClientResultFromRaw(await result));
}

async function requestClientAsApiResponse<K extends AgentApiRouteKey>(
  result: Promise<AgentApiClientResult<K>>,
): Promise<ApiResponse<AgentApiResponseByRoute[K]>> {
  return apiResponseFromClientResult(await result);
}

async function requestContractRoute<K extends AgentApiRouteKey>(
  client: CliAgentApiHttpClient,
  path: string,
  routeKey: K,
  options: {
    params?: AgentApiRequestParamsByRoute[K];
    query?: AgentApiRequestQueryByRoute[K];
    body?: AgentApiRequestBodyByRoute[K];
  } = {},
): Promise<ApiResponse<AgentApiResponseByRoute[K]>> {
  const pinnedPathTransport: AgentApiRawTransport = {
    request: async (input) => client.request<unknown>(input.method, path, input.body),
  };
  return rawRouteResultAsApiResponse(requestAgentApiRawRoute(pinnedPathTransport, routeKey, {
    pathPrefix: "",
    params: options.params,
    query: options.query,
    body: options.body,
  }));
}

export async function requestContractAgentRoute<K extends AgentApiRouteKey>(
  client: CliAgentApiHttpClient,
  agentId: string,
  routeKey: K,
  options: {
    params?: AgentApiRequestParamsByRoute[K];
    query?: AgentApiRequestQueryByRoute[K];
    body?: AgentApiRequestBodyByRoute[K];
  } = {},
): Promise<ApiResponse<AgentApiResponseByRoute[K]>> {
  return requestContractRoute(client, buildContractAgentPathForRoute(agentId, routeKey, options.params, options.query), routeKey, options);
}

async function requestContractAgentApiRoute<K extends AgentApiRouteKey>(
  client: CliAgentApiHttpClient,
  routeKey: K,
  options: {
    params?: AgentApiRequestParamsByRoute[K];
    query?: AgentApiRequestQueryByRoute[K];
    body?: AgentApiRequestBodyByRoute[K];
  } = {},
): Promise<ApiResponse<AgentApiResponseByRoute[K]>> {
  return rawRouteResultAsApiResponse(requestAgentApiRawRoute(rawTransportForClient(client), routeKey, options));
}

async function requestMultipartContractAgentApiRoute<K extends AgentApiRouteKey>(
  client: CliAgentApiHttpClient,
  routeKey: K,
  form: FormData,
): Promise<ApiResponse<AgentApiResponseByRoute[K]>> {
  if (typeof client.requestMultipart !== "function") {
    throw new CliError({
      code: "CHECK_FAILED",
      message: "Agent API multipart transport is unavailable in this CLI context",
    });
  }

  const response = await client.requestMultipart<unknown>(
    "POST",
    buildAgentApiRoutePath(routeKey),
    form,
  );
  if (!response.ok) {
    return response as ApiResponse<AgentApiResponseByRoute[K]>;
  }
  if (response.data === null) {
    throw new CliError({
      code: "INVALID_JSON_RESPONSE",
      message: `Agent API ${routeKey} returned an empty response body`,
    });
  }
  try {
    return {
      ...response,
      data: parseAgentApiResponse(routeKey, response.data),
    };
  } catch (cause) {
    throw new CliError({
      code: "INVALID_JSON_RESPONSE",
      message: `Agent API ${routeKey} response did not match the shared contract`,
      cause,
    });
  }
}

export function createAgentApiClient(client: CliAgentApiHttpClient, agentId: string) {
  const agentApi = createSharedAgentApiClient(rawTransportForClient(client), {
    pathPrefix: buildLegacyAgentApiPath(agentId, ""),
  });
  return {
    server: {
      info: () =>
        requestClientAsApiResponse(agentApi.server.info()),
      update: (body: AgentApiRequestBodyByRoute["serverUpdate"]) =>
        requestClientAsApiResponse(agentApi.server.update(body)),
    },
    history: {
      read: (query: AgentApiRequestQueryByRoute["historyRead"]) =>
        requestClientAsApiResponse(agentApi.history.read(query)),
    },
    messages: {
      send: (body: AgentApiRequestBodyByRoute["messageSend"]) =>
        requestClientAsApiResponse(agentApi.messages.send(body)),
      sendV2: (body: AgentApiRequestBodyByRoute["messageSendV2"]) =>
        requestClientAsApiResponse(agentApi.messages.sendV2(body)),
      resolve: (params: AgentApiRequestParamsByRoute["messageResolve"]) =>
        requestClientAsApiResponse(agentApi.messages.resolve(params)),
      addReaction: (
        params: AgentApiRequestParamsByRoute["messageReactionAdd"],
        body: AgentApiRequestBodyByRoute["messageReactionAdd"],
      ) =>
        requestClientAsApiResponse(agentApi.messages.addReaction(params, body)),
      removeReaction: (
        params: AgentApiRequestParamsByRoute["messageReactionRemove"],
        body: AgentApiRequestBodyByRoute["messageReactionRemove"],
      ) =>
        requestClientAsApiResponse(agentApi.messages.removeReaction(params, body)),
      updateCard: (
        params: AgentApiRequestParamsByRoute["messageCardUpdate"],
        body: AgentApiRequestBodyByRoute["messageCardUpdate"],
      ) =>
        requestClientAsApiResponse(agentApi.messages.updateCard(params, body)),
    },
    channels: {
      join: (params: AgentApiRequestParamsByRoute["channelJoin"]) =>
        requestClientAsApiResponse(agentApi.channels.join(params)),
      leave: (params: AgentApiRequestParamsByRoute["channelLeave"], body: AgentApiRequestBodyByRoute["channelLeave"] = {}) =>
        requestClientAsApiResponse(agentApi.channels.leave(params, body)),
    },
    mentions: {
      pendingActions: (query?: AgentApiRequestQueryByRoute["mentionActionsPending"]) =>
        requestClientAsApiResponse(agentApi.mentions.pendingActions(query ?? {})),
      executeAction: (body: AgentApiRequestBodyByRoute["mentionActionsExecute"]) =>
        requestClientAsApiResponse(agentApi.mentions.executeAction(body)),
      senderDeliveries: (params: AgentApiRequestParamsByRoute["senderMentionDeliveries"]) =>
        requestClientAsApiResponse(agentApi.mentions.senderDeliveries(params)),
    },
  };
}

export function createAgentApiSurfaceClient(client: CliAgentApiHttpClient, options?: { signal?: AbortSignal }) {
  const agentApi = createSharedAgentApiClient(rawTransportForClient(client, options));
  return {
    agent: {
      context: () =>
        requestClientAsApiResponse(agentApi.agent.context()),
    },
    server: {
      info: (query?: AgentApiRequestQueryByRoute["serverInfo"]) =>
        requestClientAsApiResponse(agentApi.server.info(query)),
      update: (body: AgentApiRequestBodyByRoute["serverUpdate"]) =>
        requestClientAsApiResponse(agentApi.server.update(body)),
    },
    events: {
      get: (query: AgentApiRequestQueryByRoute["events"]) =>
        requestClientAsApiResponse(agentApi.events.get(query)),
    },
    history: {
      read: (query: AgentApiRequestQueryByRoute["historyRead"]) =>
        requestClientAsApiResponse(agentApi.history.read(query)),
    },
    knowledge: {
      get: (query: AgentApiRequestQueryByRoute["knowledgeGet"]) =>
        requestClientAsApiResponse(agentApi.knowledge.get(query)),
      search: (query: AgentApiRequestQueryByRoute["knowledgeSearch"]) =>
        requestClientAsApiResponse(agentApi.knowledge.search(query)),
    },
    context: {
      search: (body: AgentApiRequestBodyByRoute["contextSearch"]) =>
        requestClientAsApiResponse(agentApi.context.search(body)),
      read: (body: AgentApiRequestBodyByRoute["contextRead"]) =>
        requestClientAsApiResponse(agentApi.context.read(body)),
    },
    tasks: {
      list: (query: AgentApiRequestQueryByRoute["taskList"]) =>
        requestClientAsApiResponse(agentApi.tasks.list(query)),
      create: (body: AgentApiRequestBodyByRoute["taskCreate"]) =>
        requestClientAsApiResponse(agentApi.tasks.create(body)),
      claim: (body: AgentApiRequestBodyByRoute["taskClaim"]) =>
        requestClientAsApiResponse(agentApi.tasks.claim(body)),
      unclaim: (body: AgentApiRequestBodyByRoute["taskUnclaim"]) =>
        requestClientAsApiResponse(agentApi.tasks.unclaim(body)),
      assign: (body: AgentApiRequestBodyByRoute["taskAssign"]) =>
        requestClientAsApiResponse(agentApi.tasks.assign(body)),
      updateStatus: (body: AgentApiRequestBodyByRoute["taskUpdateStatus"]) =>
        requestClientAsApiResponse(agentApi.tasks.updateStatus(body)),
      recordResourceReceipt: (body: AgentApiRequestBodyByRoute["taskResourceReceipt"]) =>
        requestClientAsApiResponse(agentApi.tasks.recordResourceReceipt(body)),
      delete: (body: AgentApiRequestBodyByRoute["taskDelete"]) =>
        requestClientAsApiResponse(agentApi.tasks.delete(body)),
      convert: (body: AgentApiRequestBodyByRoute["taskConvert"]) =>
        requestClientAsApiResponse(agentApi.tasks.convert(body)),
      amend: (body: AgentApiRequestBodyByRoute["taskAmend"]) =>
        requestClientAsApiResponse(agentApi.tasks.amend(body)),
      view: (query: AgentApiRequestQueryByRoute["taskView"]) =>
        requestClientAsApiResponse(agentApi.tasks.view(query)),
      read: (query: AgentApiRequestQueryByRoute["taskRead"]) =>
        requestClientAsApiResponse(agentApi.tasks.read(query)),
      reply: (body: AgentApiRequestBodyByRoute["taskReply"]) =>
        requestClientAsApiResponse(agentApi.tasks.reply(body)),
      following: (query: AgentApiRequestQueryByRoute["taskFollowing"] = {}) =>
        requestClientAsApiResponse(agentApi.tasks.following(query)),
      follow: (body: AgentApiRequestBodyByRoute["taskFollow"]) =>
        requestClientAsApiResponse(agentApi.tasks.follow(body)),
      unfollow: (body: AgentApiRequestBodyByRoute["taskUnfollow"]) =>
        requestClientAsApiResponse(agentApi.tasks.unfollow(body)),
      history: (query: AgentApiRequestQueryByRoute["taskHistory"]) =>
        requestClientAsApiResponse(agentApi.tasks.history(query)),
    },
    migrations: {
      retry: () =>
        requestClientAsApiResponse(agentApi.migrations.retry()),
    },
    reminders: {
      list: (query: AgentApiRequestQueryByRoute["reminderList"]) =>
        requestClientAsApiResponse(agentApi.reminders.list(query)),
      create: (body: AgentApiRequestBodyByRoute["reminderCreate"]) =>
        requestClientAsApiResponse(agentApi.reminders.create(body)),
      cancel: (params: AgentApiRequestParamsByRoute["reminderCancel"]) =>
        requestClientAsApiResponse(agentApi.reminders.cancel(params)),
      snooze: (
        params: AgentApiRequestParamsByRoute["reminderSnooze"],
        body: AgentApiRequestBodyByRoute["reminderSnooze"],
      ) =>
        requestClientAsApiResponse(agentApi.reminders.snooze(params, body)),
      update: (
        params: AgentApiRequestParamsByRoute["reminderUpdate"],
        body: AgentApiRequestBodyByRoute["reminderUpdate"],
      ) =>
        requestClientAsApiResponse(agentApi.reminders.update(params, body)),
      log: (params: AgentApiRequestParamsByRoute["reminderLog"]) =>
        requestClientAsApiResponse(agentApi.reminders.log(params)),
    },
    appSources: {
      ack: (body: AgentApiRequestBodyByRoute["appSourceAck"]) =>
        requestClientAsApiResponse(agentApi.appSources.ack(body)),
    },
    apps: {
      getConfig: (params: AgentApiRequestParamsByRoute["appConfigGet"]) =>
        requestClientAsApiResponse(agentApi.apps.getConfig(params)),
      patchConfig: (
        params: AgentApiRequestParamsByRoute["appConfigPatch"],
        body: AgentApiRequestBodyByRoute["appConfigPatch"],
      ) => requestClientAsApiResponse(agentApi.apps.patchConfig(params, body)),
    },
    messages: {
      send: (body: AgentApiRequestBodyByRoute["messageSend"]) =>
        requestClientAsApiResponse(agentApi.messages.send(body)),
      sendV2: (body: AgentApiRequestBodyByRoute["messageSendV2"]) =>
        requestClientAsApiResponse(agentApi.messages.sendV2(body)),
      resolve: (params: AgentApiRequestParamsByRoute["messageResolve"]) =>
        requestClientAsApiResponse(agentApi.messages.resolve(params)),
      search: (query: AgentApiRequestQueryByRoute["messageSearch"]) =>
        requestClientAsApiResponse(agentApi.messages.search(query)),
      addReaction: (
        params: AgentApiRequestParamsByRoute["messageReactionAdd"],
        body: AgentApiRequestBodyByRoute["messageReactionAdd"],
      ) =>
        requestClientAsApiResponse(agentApi.messages.addReaction(params, body)),
      removeReaction: (
        params: AgentApiRequestParamsByRoute["messageReactionRemove"],
        body: AgentApiRequestBodyByRoute["messageReactionRemove"],
      ) =>
        requestClientAsApiResponse(agentApi.messages.removeReaction(params, body)),
      updateCard: (
        params: AgentApiRequestParamsByRoute["messageCardUpdate"],
        body: AgentApiRequestBodyByRoute["messageCardUpdate"],
      ) =>
        requestClientAsApiResponse(agentApi.messages.updateCard(params, body)),
    },
    channels: {
      join: (params: AgentApiRequestParamsByRoute["channelJoin"]) =>
        requestClientAsApiResponse(agentApi.channels.join(params)),
      leave: (params: AgentApiRequestParamsByRoute["channelLeave"], body: AgentApiRequestBodyByRoute["channelLeave"] = {}) =>
        requestClientAsApiResponse(agentApi.channels.leave(params, body)),
      mute: (params: AgentApiRequestParamsByRoute["channelMute"]) =>
        requestClientAsApiResponse(agentApi.channels.mute(params, {})),
      unmute: (params: AgentApiRequestParamsByRoute["channelUnmute"]) =>
        requestClientAsApiResponse(agentApi.channels.unmute(params)),
      archive: (body: AgentApiRequestBodyByRoute["channelArchive"]) =>
        requestClientAsApiResponse(agentApi.channels.archive(body)),
      unarchive: (body: AgentApiRequestBodyByRoute["channelUnarchive"]) =>
        requestClientAsApiResponse(agentApi.channels.unarchive(body)),
      create: (body: AgentApiRequestBodyByRoute["channelCreate"]) =>
        requestClientAsApiResponse(agentApi.channels.create(body)),
      update: (params: AgentApiRequestParamsByRoute["channelUpdate"], body: AgentApiRequestBodyByRoute["channelUpdate"]) =>
        requestClientAsApiResponse(agentApi.channels.update(params, body)),
      addMember: (params: AgentApiRequestParamsByRoute["channelMemberAdd"], body: AgentApiRequestBodyByRoute["channelMemberAdd"]) =>
        requestClientAsApiResponse(agentApi.channels.addMember(params, body)),
      removeMember: (params: AgentApiRequestParamsByRoute["channelMemberRemove"], body: AgentApiRequestBodyByRoute["channelMemberRemove"]) =>
        requestClientAsApiResponse(agentApi.channels.removeMember(params, body)),
      members: (query: AgentApiRequestQueryByRoute["channelMembers"]) =>
        requestClientAsApiResponse(agentApi.channels.members(query)),
      resolve: (body: AgentApiRequestBodyByRoute["resolveChannel"]) =>
        requestClientAsApiResponse(agentApi.channels.resolve(body)),
    },
    inbox: {
      list: (query: AgentApiRequestQueryByRoute["inboxList"]) =>
        requestClientAsApiResponse(agentApi.inbox.list(query)),
      // RFC 081. `read` consumes what it returns (destructive_read): one attempt, never retried.
      read: (body: AgentApiRequestBodyByRoute["inboxRead"]) =>
        requestClientAsApiResponse(agentApi.inbox.read(body)),
      dismiss: (body: AgentApiRequestBodyByRoute["inboxDismiss"]) =>
        requestClientAsApiResponse(agentApi.inbox.dismiss(body)),
    },
    threads: {
      list: () =>
        requestClientAsApiResponse(agentApi.threads.list()),
      follow: (body: AgentApiRequestBodyByRoute["threadFollow"]) =>
        requestClientAsApiResponse(agentApi.threads.follow(body)),
      unfollow: (body: AgentApiRequestBodyByRoute["threadUnfollow"]) =>
        requestClientAsApiResponse(agentApi.threads.unfollow(body)),
    },
    profile: {
      show: (query: AgentApiRequestQueryByRoute["profileShow"]) =>
        requestClientAsApiResponse(agentApi.profile.show(query)),
      update: (body: AgentApiRequestBodyByRoute["profileUpdate"]) =>
        requestClientAsApiResponse(agentApi.profile.update(body)),
      updateAvatar: (form: FormData) =>
        requestMultipartContractAgentApiRoute(client, "profileAvatarUpdate", form),
    },
    integrations: {
      token: (body: AgentApiRequestBodyByRoute["integrationToken"]) =>
        requestClientAsApiResponse(agentApi.integrations.token(body)),
      list: (query: AgentApiRequestQueryByRoute["integrationList"] = {}) =>
        requestClientAsApiResponse(agentApi.integrations.list(query)),
      marketplace: (query: AgentApiRequestQueryByRoute["integrationMarketplaceSearch"]) =>
        requestClientAsApiResponse(agentApi.integrations.marketplace(query)),
      login: (body: AgentApiRequestBodyByRoute["integrationLogin"]) =>
        requestClientAsApiResponse(agentApi.integrations.login(body)),
      prepareApp: (body: AgentApiRequestBodyByRoute["integrationAppPrepare"]) =>
        requestClientAsApiResponse(agentApi.integrations.prepareApp(body)),
      rotateAppSecret: (body: AgentApiRequestBodyByRoute["integrationAppRotateSecret"]) =>
        requestClientAsApiResponse(agentApi.integrations.rotateAppSecret(body)),
      transferAppOwner: (body: AgentApiRequestBodyByRoute["integrationAppTransferOwner"]) =>
        requestClientAsApiResponse(agentApi.integrations.transferAppOwner(body)),
      updateApp: (body: AgentApiRequestBodyByRoute["integrationAppUpdate"]) =>
        requestClientAsApiResponse(agentApi.integrations.updateApp(body)),
      manageApp: (body: AgentApiRequestBodyByRoute["integrationAppManage"]) =>
        requestClientAsApiResponse(agentApi.integrations.manageApp(body)),
      updateAppLogo: (form: FormData) =>
        requestMultipartContractAgentApiRoute(client, "integrationAppLogoUpdate", form),
      listApps: () =>
        requestClientAsApiResponse(agentApi.integrations.listApps()),
      getAppStatus: (query: AgentApiRequestQueryByRoute["integrationAppStatus"]) =>
        requestClientAsApiResponse(agentApi.integrations.getAppStatus(query)),
    },
    actions: {
      prepare: (body: AgentApiRequestBodyByRoute["actionPrepare"]) =>
        requestClientAsApiResponse(agentApi.actions.prepare(body)),
    },
    mentions: {
      pendingActions: (query?: AgentApiRequestQueryByRoute["mentionActionsPending"]) =>
        requestClientAsApiResponse(agentApi.mentions.pendingActions(query ?? {})),
      executeAction: (body: AgentApiRequestBodyByRoute["mentionActionsExecute"]) =>
        requestClientAsApiResponse(agentApi.mentions.executeAction(body)),
      senderDeliveries: (params: AgentApiRequestParamsByRoute["senderMentionDeliveries"]) =>
        requestClientAsApiResponse(agentApi.mentions.senderDeliveries(params)),
    },
    attachments: {
      upload: (form: FormData) =>
        requestMultipartContractAgentApiRoute(client, "attachmentUpload", form),
      uploadCapabilities: () =>
        requestClientAsApiResponse(agentApi.attachments.uploadCapabilities()),
      createUploadSession: (body: AgentApiRequestBodyByRoute["attachmentUploadSessionCreate"]) =>
        requestClientAsApiResponse(agentApi.attachments.createUploadSession(body)),
      completeUploadSession: (params: AgentApiRequestParamsByRoute["attachmentUploadSessionComplete"]) =>
        requestClientAsApiResponse(agentApi.attachments.completeUploadSession(params)),
      cancelUploadSession: (params: AgentApiRequestParamsByRoute["attachmentUploadSessionCancel"]) =>
        requestClientAsApiResponse(agentApi.attachments.cancelUploadSession(params)),
      uploadSessionStatus: (params: AgentApiRequestParamsByRoute["attachmentUploadSessionStatus"]) =>
        requestClientAsApiResponse(agentApi.attachments.uploadSessionStatus(params)),
      download: (params: AgentApiRequestParamsByRoute["attachmentDownload"]) =>
        requestClientAsApiResponse(agentApi.attachments.download(params)),
      view: (params: AgentApiRequestParamsByRoute["attachmentDownload"]) =>
        requestClientAsApiResponse(agentApi.attachments.download(params)),
      comments: (
        params: AgentApiRequestParamsByRoute["attachmentCommentsList"],
        query: AgentApiRequestQueryByRoute["attachmentCommentsList"] = {},
      ) =>
        requestClientAsApiResponse(agentApi.attachments.comments(params, query)),
    },
  };
}
