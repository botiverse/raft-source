// Builder for the language-neutral Agent API description
// (`packages/shared/agent-api/agent-api.v1.json`).
//
// Everything here is derived: the route list and schemas come from
// `agentApiContract`, the operating metadata from `agentApiRouteMeta`, and
// the version from `computeAgentApiManifestVersion`, so the document cannot
// disagree with what the Server validates. Generators in other languages
// consume this file; nothing in this repo should hand-edit it.

import { z } from "zod";

import {
  AGENT_API_BASE_PATH,
  agentApiCapabilities,
  agentApiContract,
  buildAgentApiRouteManifest,
  computeAgentApiManifestVersion,
  getAgentApiResponseKind,
  type AgentApiCapability,
  type AgentApiMethod,
  type AgentApiRouteKey,
} from "./agentApiContract";
import {
  AGENT_API_ROUTE_META,
  getAgentApiRetryPolicy,
  toAgentApiToolAnnotations,
  type AgentApiAudience,
  type AgentApiIdempotency,
  type AgentApiRetryPolicy,
  type AgentApiSideEffect,
  type AgentApiToolAnnotations,
} from "./agentApiRouteMeta";

export const AGENT_API_DESCRIPTION_SCHEMA = "raft-agent-api-description.v1" as const;

export type AgentApiJsonSchema = Record<string, unknown>;

export interface AgentApiRouteDescription {
  key: AgentApiRouteKey;
  method: AgentApiMethod;
  path: string;
  fullPath: string;
  client: { resource: string; method: string };
  capability: AgentApiCapability;
  description: string;
  sideEffect: AgentApiSideEffect;
  idempotency: AgentApiIdempotency;
  destructive: boolean;
  audience: AgentApiAudience;
  retryPolicy: AgentApiRetryPolicy;
  annotations: AgentApiToolAnnotations;
  request: {
    params: AgentApiJsonSchema | null;
    query: AgentApiJsonSchema | null;
    body: AgentApiJsonSchema | null;
  };
  response: {
    kind: "json" | "binary" | "empty";
    body: AgentApiJsonSchema | null;
  };
}

export interface AgentApiDescription {
  schema: typeof AGENT_API_DESCRIPTION_SCHEMA;
  /** Content hash of the route manifest; equals `AGENT_API_MANIFEST_VERSION`. */
  manifestVersion: string;
  basePath: string;
  capabilities: readonly AgentApiCapability[];
  routes: AgentApiRouteDescription[];
}

const JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";

function toJsonSchema(schema: z.ZodType, io: "input" | "output"): AgentApiJsonSchema {
  // Transforms and branded ids have no JSON Schema form; `unrepresentable:
  // "any"` keeps the document buildable and marks those spots as `{}`.
  // `reused: "inline"` keeps every schema self-contained: the description
  // document is a wire artifact, and a `$ref` into a route-local `$defs`
  // has no reader that can resolve it.
  const result = z.toJSONSchema(schema, { io, unrepresentable: "any", reused: "inline", target: "draft-2020-12" }) as Record<string, unknown>;
  delete result.$schema;
  // zod 4.6 keeps a meta-id schema behind a `$ref` even for a single use;
  // hoist that one level so the wire document has no dangling root ref.
  // Only the root `$ref` is dropped: the hoisted schema can still reference
  // sibling entries (or itself, recursively) inside `$defs`, so `$defs`
  // must be preserved whole — deleting it would strand every nested
  // `#/$defs/...` reference in this subschema.
  if (typeof result.$ref === "string" && result.$ref.startsWith("#/$defs/") && result.$defs && typeof result.$defs === "object") {
    const name = result.$ref.slice("#/$defs/".length);
    const target = (result.$defs as Record<string, unknown>)[name];
    if (target && typeof target === "object") {
      const { $ref: _ref, ...rest } = result;
      return { ...(target as Record<string, unknown>), ...rest } as AgentApiJsonSchema;
    }
  }
  return result;
}

export function buildAgentApiDescription(): AgentApiDescription {
  const manifest = buildAgentApiRouteManifest();
  const routes = Object.values(agentApiContract).map((route): AgentApiRouteDescription => {
    const key = route.key as AgentApiRouteKey;
    const meta = AGENT_API_ROUTE_META[key];
    const request = route.request as { params?: z.ZodType; query?: z.ZodType; body?: z.ZodType };
    const response = route.response as { kind?: "json" | "binary" | "empty"; body?: z.ZodType };
    return {
      key,
      method: route.method,
      path: route.path,
      fullPath: route.fullPath,
      client: route.client,
      capability: route.capability,
      description: route.description,
      sideEffect: meta.sideEffect,
      idempotency: meta.idempotency,
      destructive: meta.destructive,
      audience: meta.audience,
      retryPolicy: getAgentApiRetryPolicy(meta),
      annotations: toAgentApiToolAnnotations(meta),
      request: {
        params: request.params ? toJsonSchema(request.params, "input") : null,
        query: request.query ? toJsonSchema(request.query, "input") : null,
        body: request.body ? toJsonSchema(request.body, "input") : null,
      },
      response: {
        kind: getAgentApiResponseKind(route.response),
        body: response.body ? toJsonSchema(response.body, "output") : null,
      },
    };
  });
  return {
    schema: AGENT_API_DESCRIPTION_SCHEMA,
    manifestVersion: computeAgentApiManifestVersion(manifest),
    basePath: AGENT_API_BASE_PATH,
    capabilities: agentApiCapabilities,
    routes,
  };
}

export { JSON_SCHEMA_DIALECT as AGENT_API_DESCRIPTION_JSON_SCHEMA_DIALECT };
