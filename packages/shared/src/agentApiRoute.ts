// The agent API's route shape, and the first-party apps' own route fragments
// (first-party app mechanism: registration in one place). The core contract
// (agentApiContract.ts) and each app's fragment (apps/<id>/agentApi.ts) both
// build routes with `agentApiRoute`; this module imports neither, so a
// fragment can depend on it without an import cycle through the contract.
//
// An app's fragment (`defineAppAgentApi`) holds only its own routes: each
// path is `/<id>` or under `/<id>/`, each `client.resource` is the app's id,
// and each route's `key` is its property name (checked when it is defined,
// and by its type). `mergeAppAgentApis` puts the fragments after core's
// routes and refuses a route key, or a `client` resource and method, that two
// of them share: the raw client would silently keep only one.
import type { z } from "zod";
import { AGENT_API_BASE_PATH } from "./agentApiPaths";

export const agentApiMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type AgentApiMethod = (typeof agentApiMethods)[number];

export const agentApiCapabilities = [
  "read",
  "send",
  "tasks",
  "channels",
  "server",
  "knowledge",
  "mentions",
  "reactions",
  "mcp",
  "raftbench",
] as const;
export type AgentApiCapability = (typeof agentApiCapabilities)[number];

export type AgentApiContractResponse =
  | {
    kind?: "json";
    body: z.ZodType;
  }
  | {
    kind: "binary";
  }
  | {
    /** A success with no body (for example `204 No Content`). */
    kind: "empty";
  };

export const AGENT_API_SIDE_EFFECTS = ["read", "destructive_read", "write"] as const;
export type AgentApiSideEffect = (typeof AGENT_API_SIDE_EFFECTS)[number];

export const AGENT_API_IDEMPOTENCY = ["natural", "key", "none"] as const;
export type AgentApiIdempotency = (typeof AGENT_API_IDEMPOTENCY)[number];

export const AGENT_API_AUDIENCES = ["both", "external", "managed"] as const;
export type AgentApiAudience = (typeof AGENT_API_AUDIENCES)[number];

/** A route's operating metadata (agentApiRouteMeta.ts explains each field). */
export interface AgentApiRouteMeta {
  sideEffect: AgentApiSideEffect;
  idempotency: AgentApiIdempotency;
  /** May remove, archive, rotate, transfer, or overwrite existing state (MCP `destructiveHint`). */
  destructive: boolean;
  audience: AgentApiAudience;
}

/** The common kinds of route metadata, for core's table and apps' fragments alike. */
export const AGENT_API_META = {
  read: { sideEffect: "read", idempotency: "natural", destructive: false, audience: "both" },
  // Additive writes: repeating or undoing them is another ordinary post.
  naturalWrite: { sideEffect: "write", idempotency: "natural", destructive: false, audience: "both" },
  keyedWrite: { sideEffect: "write", idempotency: "key", destructive: false, audience: "both" },
  write: { sideEffect: "write", idempotency: "none", destructive: false, audience: "both" },
  // Destructive writes: remove, archive, rotate, transfer, or overwrite shared state.
  naturalDestructive: { sideEffect: "write", idempotency: "natural", destructive: true, audience: "both" },
  destructive: { sideEffect: "write", idempotency: "none", destructive: true, audience: "both" },
  managedWrite: { sideEffect: "write", idempotency: "none", destructive: false, audience: "managed" },
  managedNaturalDestructive: { sideEffect: "write", idempotency: "natural", destructive: true, audience: "managed" },
} as const satisfies Record<string, AgentApiRouteMeta>;

/**
 * How a read route of an app decides what the caller sees (the server's
 * read-route visibility classification): `unified` for core's visibility
 * entries, `legacy:<check>` for an older one, `none` for no conversation
 * objects; `reason` names the check.
 */
export type AgentApiRouteVisibility = { entry: "unified" | `legacy:${string}` | "none"; reason: string };
/**
 * Why a write route of an app grants no human or Agent/Machine authority (the
 * server's route authority classification): an app's routes answer an
 * agent's own credential (`sk_agent`), so they are `nonHuman`; `reason` says
 * what the write touches.
 */
export type AgentApiRouteAuthority = { reason: string };

export type AgentApiContractRoute = {
  key: string;
  method: AgentApiMethod;
  path: string;
  fullPath: string;
  client: {
    resource: string;
    method: string;
  };
  capability: AgentApiCapability;
  description: string;
  request: {
    params?: z.ZodType;
    query?: z.ZodType;
    body?: z.ZodType;
  };
  response: AgentApiContractResponse;
};

/** A route of the contract: its fields, and its full path under the agent API base. */
export function agentApiRoute<const T extends Omit<AgentApiContractRoute, "fullPath">>(input: T): T & { fullPath: string } {
  return {
    ...input,
    fullPath: `${AGENT_API_BASE_PATH}${input.path}`,
  };
}

/**
 * What an app's route declares besides the contract's fields, so core
 * derives everything it lists per route: its metadata, and how the server
 * classifies it (a read's visibility, a write's authority).
 */
type AppRouteFacts<Method> = { meta: AgentApiRouteMeta } & (Method extends "GET"
  ? { visibility: AgentApiRouteVisibility; authority?: never }
  : { authority: AgentApiRouteAuthority; visibility?: never });

type AppRoute<Id extends string, Key extends string, Method> = AgentApiContractRoute & {
  key: Key;
  path: `/${Id}` | `/${Id}/${string}`;
  client: { resource: Id; method: string };
} & AppRouteFacts<Method>;

/** A route of an app's fragment, as core reads its facts. */
export type AppAgentApiRoute = AgentApiContractRoute & { meta: AgentApiRouteMeta; visibility?: AgentApiRouteVisibility; authority?: AgentApiRouteAuthority };

/** One first-party app's agent API: its id and its routes. */
export type AppAgentApi<Id extends string = string, Routes extends Record<string, AppAgentApiRoute> = Record<string, AppAgentApiRoute>> = {
  readonly id: Id;
  readonly routes: Routes;
};

/**
 * A first-party app's own agent API routes. Each path is `/<id>` or under
 * `/<id>/` (where core lets the app mount it), each `client.resource` is the
 * id, and each `key` is the route's property name; anything else is a type
 * error and, if it gets past the types, throws here.
 */
export function defineAppAgentApi<const Id extends string, const Routes extends { [K in keyof Routes & string]: AppRoute<Id, K, Routes[K] extends { method: infer M } ? M : never> }>(
  id: Id,
  routes: Routes,
): AppAgentApi<Id, Routes> {
  for (const [key, route] of Object.entries(routes) as Array<[string, AppAgentApiRoute]>) {
    if (route.key !== key) throw new Error(`${id}'s agent API route ${key} has key ${route.key}`);
    if (!route.meta) throw new Error(`${id}'s agent API route ${key} has no meta`);
    if (route.method === "GET" ? !route.visibility || route.authority : !route.authority || route.visibility) {
      throw new Error(`${id}'s agent API route ${key} (${route.method}) declares ${route.method === "GET" ? "a read's visibility" : "a write's authority"} and only that`);
    }
    if (route.path !== `/${id}` && !route.path.startsWith(`/${id}/`)) throw new Error(`${id}'s agent API route ${key} is at ${route.path}, not under /${id}/`);
    if (route.client.resource !== id) throw new Error(`${id}'s agent API route ${key} is on the client's ${route.client.resource}, not ${id}`);
  }
  return { id, routes };
}

/** Every route of these apps, in order, with the app it is from. */
export function appAgentApiRoutesOf(apps: readonly AppAgentApi[]): Array<{ app: string; route: AppAgentApiRoute }> {
  return apps.flatMap((app) => Object.values(app.routes).map((route) => ({ app: app.id, route })));
}

type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;

/** Every route of these apps, as one object type. */
export type AppAgentApiRoutes<Apps extends readonly AppAgentApi[]> = UnionToIntersection<Apps[number]["routes"]>;

/**
 * Core's routes, then each app's in registry order. A route key, or a
 * `client` resource and method, that two of them share is refused.
 */
export function mergeAppAgentApis<const Core extends Record<string, AgentApiContractRoute>, const Apps extends readonly AppAgentApi[]>(
  core: Core,
  apps: Apps,
): Core & AppAgentApiRoutes<Apps> {
  const merged: Record<string, AgentApiContractRoute> = { ...core };
  const clientMethods = new Map<string, string>();
  for (const [key, route] of Object.entries(core)) clientMethods.set(`${route.client.resource}.${route.client.method}`, key);
  for (const app of apps) {
    for (const [key, route] of Object.entries(app.routes)) {
      if (Object.hasOwn(merged, key)) throw new Error(`agent API route ${key} of ${app.id} is already a route of the contract`);
      const clientMethod = `${route.client.resource}.${route.client.method}`;
      const taken = clientMethods.get(clientMethod);
      if (taken !== undefined) throw new Error(`agent API route ${key} of ${app.id} is the client's ${clientMethod}, which ${taken} already is`);
      merged[key] = route;
      clientMethods.set(clientMethod, key);
    }
  }
  return merged as Core & AppAgentApiRoutes<Apps>;
}

/**
 * What a route's request and response are, from its own schemas: the shape
 * every app route's `…ByRoute` entry has (core's are written by hand, some
 * as their own interfaces). `never` where the route has none.
 */
export type AgentApiParamsOf<R> = R extends { request: { params: infer S extends z.ZodType } } ? z.infer<S> : never;
export type AgentApiQueryOf<R> = R extends { request: { query: infer S extends z.ZodType } } ? z.infer<S> : never;
export type AgentApiBodyOf<R> = R extends { request: { body: infer S extends z.ZodType } } ? z.infer<S> : never;
export type AgentApiResponseOf<R> = R extends { response: { kind: "binary" } }
  ? Uint8Array
  : R extends { response: { kind: "empty" } }
    ? null
    : R extends { response: { body: infer S extends z.ZodType } } ? z.infer<S> : never;
