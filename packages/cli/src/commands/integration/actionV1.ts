import { createHash } from "node:crypto";

import type { RegisteredIntegrationService } from "./_format.js";
import {
  boundedSchemaErrorPath,
  compileAgentManifestSchemaV1,
  type AgentManifestActionV1,
  type AgentManifestReadbackBindingV1,
  type AgentManifestV1,
  type JsonValue,
} from "./manifestV1.js";

export interface V1RequestPlan {
  method: AgentManifestActionV1["endpoint"]["method"];
  url: URL;
  body?: JsonValue;
}

export interface V1SchemaValidationFailure {
  path: string | null;
  message: string;
}

const MISSING = Symbol("missing-json-pointer");
const V1_INSTANCE_LIMITS = {
  maxDepth: 24,
  maxNodes: 10_000,
  maxBytes: 1024 * 1024,
} as const;

export class V1RequestInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "V1RequestInputError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON cannot contain non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalize(value[key])}`
    ).join(",")}}`;
  }
  throw new Error("canonical JSON cannot contain undefined, bigint, functions, or symbols");
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pointerToken(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

export function resolveJsonPointer(value: unknown, pointer: string): unknown | typeof MISSING {
  if (pointer === "") return value;
  let current = value;
  for (const rawToken of pointer.slice(1).split("/")) {
    const token = pointerToken(rawToken);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return MISSING;
      const index = Number(token);
      if (index >= current.length) return MISSING;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, token)) return MISSING;
    current = current[token];
  }
  return current;
}

function scalarString(value: unknown, field: string): string {
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new V1RequestInputError(`${field} must resolve to one scalar value`);
}

function safeRegistryUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed : null;
  } catch {
    return null;
  }
}

function boundedInstanceFailure(value: unknown): V1SchemaValidationFailure | null {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return { path: "/", message: "value must be acyclic JSON" };
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > V1_INSTANCE_LIMITS.maxBytes) {
    return { path: "/", message: "value exceeds the bounded JSON byte size" };
  }

  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number): V1SchemaValidationFailure | null => {
    nodes += 1;
    if (nodes > V1_INSTANCE_LIMITS.maxNodes) {
      return { path, message: "value exceeds the bounded JSON node count" };
    }
    if (depth > V1_INSTANCE_LIMITS.maxDepth) {
      return { path, message: "value exceeds the bounded JSON depth" };
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index += 1) {
        const failure = visit(current[index], `${path}/${index}`, depth + 1);
        if (failure) return failure;
      }
      return null;
    }
    if (isRecord(current)) {
      for (const [key, child] of Object.entries(current)) {
        const token = key.replace(/~/g, "~0").replace(/\//g, "~1");
        const failure = visit(child, `${path}/${token}`, depth + 1);
        if (failure) return failure;
      }
    }
    return null;
  };
  return visit(value, "", 0);
}

export function resolveRegisteredActionBaseUrl(input: {
  service: RegisteredIntegrationService;
  manifest: AgentManifestV1;
}): URL {
  if (!input.manifest.execution.base_url) {
    throw new Error("manifest v1 HTTP API execution requires a base URL");
  }
  const base = new URL(input.manifest.execution.base_url);
  const authorizedOrigins = new Set(
    [
      safeRegistryUrl(input.service.agentManifestUrl),
      safeRegistryUrl(input.service.homepageUrl),
      safeRegistryUrl(input.service.returnUrl),
    ].filter((value): value is URL => Boolean(value)).map((value) => value.origin),
  );
  if (!authorizedOrigins.has(base.origin)) {
    throw new Error("manifest v1 execution.base_url origin is not authorized by the registered service URLs");
  }
  return base;
}

export function validateV1Input(
  action: AgentManifestActionV1,
  payload: Record<string, unknown>,
): V1SchemaValidationFailure | null {
  const boundedFailure = boundedInstanceFailure(payload);
  if (boundedFailure) return boundedFailure;
  const validate = compileAgentManifestSchemaV1(action.input_schema);
  if (validate(payload)) return null;
  const error = validate.errors?.[0];
  return {
    path: boundedSchemaErrorPath(error),
    message: error?.message?.slice(0, 256) ?? "input does not match the declared schema",
  };
}

export function validateV1Output(
  action: AgentManifestActionV1,
  value: unknown,
): V1SchemaValidationFailure | null {
  const boundedFailure = boundedInstanceFailure(value);
  if (boundedFailure) return boundedFailure;
  const validate = compileAgentManifestSchemaV1(action.output_schema);
  if (validate(value)) return null;
  const error = validate.errors?.[0];
  return {
    path: boundedSchemaErrorPath(error),
    message: error?.message?.slice(0, 256) ?? "output does not match the declared schema",
  };
}

export function buildV1RequestPlan(input: {
  service: RegisteredIntegrationService;
  manifest: AgentManifestV1;
  action: AgentManifestActionV1;
  payload: Record<string, unknown>;
}): V1RequestPlan {
  const base = resolveRegisteredActionBaseUrl(input);
  let endpointPath = input.action.endpoint.path;
  for (const name of Object.keys(input.action.request.path ?? {}).sort()) {
    const binding = input.action.request.path?.[name];
    const resolved = binding ? resolveJsonPointer(input.payload, binding.from) : MISSING;
    if (resolved === MISSING) {
      throw new V1RequestInputError(`request.path.${name} points to a missing input value`);
    }
    const rawSegment = scalarString(resolved, `request.path.${name}`);
    if (rawSegment === "." || rawSegment === "..") {
      throw new V1RequestInputError(`request.path.${name} must not resolve to a dot segment`);
    }
    const segment = encodeURIComponent(rawSegment);
    endpointPath = endpointPath.replace(`{${name}}`, segment);
  }
  if (/[{}]/.test(endpointPath)) throw new Error("request path contains an unbound placeholder");
  const basePath = base.pathname.endsWith("/") ? base.pathname.slice(0, -1) : base.pathname;
  const url = new URL(base);
  url.pathname = `${basePath}${endpointPath}`;
  url.search = "";
  url.hash = "";
  if (
    url.origin !== base.origin
    || url.username
    || url.password
    || url.hash
    || (basePath !== "" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))
  ) {
    throw new Error("mapped request URL escaped the registered action base");
  }

  for (const name of Object.keys(input.action.request.query ?? {}).sort()) {
    const binding = input.action.request.query?.[name];
    const resolved = binding ? resolveJsonPointer(input.payload, binding.from) : MISSING;
    if (resolved === MISSING) {
      throw new V1RequestInputError(`request.query.${name} points to a missing input value`);
    }
    if (Array.isArray(resolved)) {
      for (const item of resolved) url.searchParams.append(name, scalarString(item, `request.query.${name}`));
    } else {
      url.searchParams.append(name, scalarString(resolved, `request.query.${name}`));
    }
  }

  let body: JsonValue | undefined;
  if (input.action.request.body) {
    const resolved = resolveJsonPointer(input.payload, input.action.request.body.from);
    if (resolved === MISSING) {
      throw new V1RequestInputError("request.body points to a missing input value");
    }
    try {
      canonicalJson(resolved);
    } catch (error) {
      throw new V1RequestInputError(
        error instanceof Error ? error.message : "request.body must resolve to one JSON value",
      );
    }
    body = resolved as JsonValue;
  }
  return {
    method: input.action.endpoint.method,
    url,
    body,
  };
}

export function requestBindingDigest(input: {
  payload: Record<string, unknown>;
  plan: V1RequestPlan;
}): string {
  return sha256CanonicalJson({
    input: input.payload,
    request: {
      method: input.plan.method,
      url: input.plan.url.toString(),
      body: input.plan.body ?? null,
    },
  });
}

export function actionContractDigest(action: AgentManifestActionV1): string {
  return sha256CanonicalJson(action);
}

export function manifestDigest(manifest: AgentManifestV1): string {
  return sha256CanonicalJson(manifest);
}

export function effectiveContractDigest(input: {
  actorServerId: string;
  service: RegisteredIntegrationService;
  manifest: AgentManifestV1;
  action: AgentManifestActionV1;
  registeredBaseUrl: URL;
}): string {
  return sha256CanonicalJson({
    manifest_schema: input.manifest.schema,
    server_id: input.actorServerId,
    integration_id: input.service.id,
    service_id: input.service.clientId,
    registered_base_url: input.registeredBaseUrl.toString(),
    execution: input.manifest.execution,
    auth: input.manifest.auth ?? null,
    credential_boundary: input.manifest.credential_boundary ?? null,
    manifest_sha256: manifestDigest(input.manifest),
    action: input.action,
  });
}

export function mapReadbackInput(input: {
  bindings: Record<string, AgentManifestReadbackBindingV1>;
  request: Record<string, unknown>;
  response: unknown;
}): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [name, binding] of Object.entries(input.bindings)) {
    const source = binding.from === "request" ? input.request : input.response;
    const value = resolveJsonPointer(source, binding.pointer);
    if (value === MISSING) throw new Error(`readback input ${name} points to a missing ${binding.from} value`);
    mapped[name] = value;
  }
  return mapped;
}

export function evaluateReadbackAssertions(input: {
  assertions: Extract<AgentManifestActionV1["readback"], { mode: "action" }>["assertions"];
  response: unknown;
}): { passed: boolean; failedPointer?: string } {
  for (const assertion of input.assertions) {
    const actual = resolveJsonPointer(input.response, assertion.pointer);
    let passed: boolean;
    if (assertion.operator === "exists") {
      passed = actual !== MISSING;
    } else if (actual === MISSING) {
      passed = false;
    } else {
      const equals = canonicalJson(actual) === canonicalJson(assertion.value);
      passed = assertion.operator === "equals" ? equals : !equals;
    }
    if (!passed) return { passed: false, failedPointer: assertion.pointer };
  }
  return { passed: true };
}
