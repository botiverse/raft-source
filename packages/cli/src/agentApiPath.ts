import {
  buildAgentApiRawRoutePath,
  buildLegacyAgentApiPath,
  agentApiClientResultFromRaw,
  agentApiContract,
  createAgentApiClient as createSharedAgentApiClient,
  getAgentApiResponseKind,
  parseAgentApiResponse,
  requestAgentApiRawRoute,
  type AgentApiClientFailure,
  type AgentApiClientResult,
  type AgentApiRawFailure,
  type AgentApiRawResult,
  type AgentApiRawTransport,
  type AgentApiRequestBodyByRoute,
  type AgentApiRequestParamsByRoute,
  type AgentApiRequestQueryByRoute,
  type AgentApiResponseByRoute,
  type AgentApiRouteKey,
} from "@botiverse/raft-shared";

import type { ApiResponse, BinaryResponse } from "./client.js";
import { apiFailureError } from "./core/apiFailure.js";
import { CliError } from "./core/errors.js";

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
  request<T>(method: string, pathname: string, body?: unknown): Promise<ApiResponse<T>>;
  requestBinary?(method: string, pathname: string): Promise<BinaryResponse>;
  requestMultipart?<T>(method: string, pathname: string, form: FormData): Promise<ApiResponse<T>>;
}

export function buildAgentApiEventsPath(query?: AgentApiRequestQueryByRoute["events"]): string {
  return buildAgentApiRoutePath("events", undefined, query);
}

function rawTransportForClient(client: CliAgentApiHttpClient): AgentApiRawTransport {
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
          data: response.ok ? response.body : null,
          error: response.error,
          errorCode: response.errorCode,
          proxy: response.proxy,
        };
      }
      return client.request<unknown>(input.method, input.path, input.body);
    },
  };
}

/** Shared-contract client used by higher-level SDK operations inside the CLI. */
export function createAgentApiContractSurfaceClient(client: CliAgentApiHttpClient) {
  return createSharedAgentApiClient(rawTransportForClient(client));
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
    };
    if (response.status >= 500 && response.errorCode === "agent_proxy_failed") {
      throw apiFailureError(response, "CHECK_FAILED");
    }
    return response;
  }
  throw cliErrorFromClientFailure(result);
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
    },
    channels: {
      join: (params: AgentApiRequestParamsByRoute["channelJoin"]) =>
        requestClientAsApiResponse(agentApi.channels.join(params)),
      leave: (params: AgentApiRequestParamsByRoute["channelLeave"]) =>
        requestClientAsApiResponse(agentApi.channels.leave(params)),
    },
    mentions: {
      pendingActions: (query?: AgentApiRequestQueryByRoute["mentionActionsPending"]) =>
        requestClientAsApiResponse(agentApi.mentions.pendingActions(query ?? {})),
      executeAction: (body: AgentApiRequestBodyByRoute["mentionActionsExecute"]) =>
        requestClientAsApiResponse(agentApi.mentions.executeAction(body)),
    },
  };
}

export function createAgentApiSurfaceClient(client: CliAgentApiHttpClient) {
  const agentApi = createSharedAgentApiClient(rawTransportForClient(client));
  return {
    server: {
      info: () =>
        requestClientAsApiResponse(agentApi.server.info()),
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
    wiki: {
      manifest: () =>
        requestClientAsApiResponse(agentApi.wiki.manifest()),
      read: (params: AgentApiRequestParamsByRoute["wikiArtifactRead"]) =>
        requestClientAsApiResponse(agentApi.wiki.read(params)),
      publish: (body: AgentApiRequestBodyByRoute["wikiManifestPublish"]) =>
        requestClientAsApiResponse(agentApi.wiki.publish(body)),
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
      history: (query: AgentApiRequestQueryByRoute["taskHistory"]) =>
        requestClientAsApiResponse(agentApi.tasks.history(query)),
    },
    migrations: {
      begin: (body: AgentApiRequestBodyByRoute["migrationBegin"]) =>
        requestClientAsApiResponse(agentApi.migrations.begin(body)),
      status: () =>
        requestClientAsApiResponse(agentApi.migrations.status()),
      ready: (body: AgentApiRequestBodyByRoute["migrationReady"]) =>
        requestClientAsApiResponse(agentApi.migrations.ready(body)),
      arrived: (body: AgentApiRequestBodyByRoute["migrationArrived"]) =>
        requestClientAsApiResponse(agentApi.migrations.arrived(body)),
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
    },
    channels: {
      join: (params: AgentApiRequestParamsByRoute["channelJoin"]) =>
        requestClientAsApiResponse(agentApi.channels.join(params)),
      leave: (params: AgentApiRequestParamsByRoute["channelLeave"]) =>
        requestClientAsApiResponse(agentApi.channels.leave(params)),
      mute: (params: AgentApiRequestParamsByRoute["channelMute"]) =>
        requestClientAsApiResponse(agentApi.channels.mute(params, {})),
      unmute: (params: AgentApiRequestParamsByRoute["channelUnmute"]) =>
        requestClientAsApiResponse(agentApi.channels.unmute(params)),
      archive: (body: AgentApiRequestBodyByRoute["channelArchive"]) =>
        requestClientAsApiResponse(agentApi.channels.archive(body)),
      unarchive: (body: AgentApiRequestBodyByRoute["channelUnarchive"]) =>
        requestClientAsApiResponse(agentApi.channels.unarchive(body)),
      members: (query: AgentApiRequestQueryByRoute["channelMembers"]) =>
        requestClientAsApiResponse(agentApi.channels.members(query)),
      resolve: (body: AgentApiRequestBodyByRoute["resolveChannel"]) =>
        requestClientAsApiResponse(agentApi.channels.resolve(body)),
    },
    threads: {
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
      list: () =>
        requestClientAsApiResponse(agentApi.integrations.list()),
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
