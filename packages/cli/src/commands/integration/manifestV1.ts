import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import safeRegex from "safe-regex2";

export const AGENT_MANIFEST_SCHEMA_V1 = "slock-agent-manifest.v1";
export const RAFT_AGENT_MANIFEST_SCHEMA_V1 = "raft-agent-manifest.v1";

export const V1_SCHEMA_LIMITS = {
  maxDepth: 12,
  maxNodes: 256,
  maxProperties: 128,
  maxBranches: 64,
  maxPatternLength: 256,
  maxEnumValues: 64,
} as const;
export const V1_MANIFEST_LIMITS = {
  maxActions: 64,
  maxScopesPerAction: 64,
  maxBindingsPerMap: 128,
} as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentManifestJsonSchemaV1 = Record<string, unknown>;

export type AgentManifestRequestBindingV1 = {
  from: string;
};

export type AgentManifestRequestV1 = {
  path?: Record<string, AgentManifestRequestBindingV1>;
  query?: Record<string, AgentManifestRequestBindingV1>;
  body?: AgentManifestRequestBindingV1;
};

export type AgentManifestReadbackBindingV1 = {
  from: "request" | "response";
  pointer: string;
};

export type AgentManifestActionV1 = {
  name: string;
  description?: string;
  endpoint: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
  };
  request: AgentManifestRequestV1;
  authority: {
    principal: "agent_session";
    required_scopes: string[];
  };
  effect: "read" | "create" | "update" | "delete" | "external_side_effect";
  input_schema: AgentManifestJsonSchemaV1;
  output_schema: AgentManifestJsonSchemaV1;
  idempotency:
    | { mode: "safe" | "idempotent" | "non_idempotent" }
    | {
        mode: "key_required";
        transport: { location: "header"; name: string };
        scope: "actor_action";
      };
  readback:
    | { mode: "not_applicable" | "not_supported" }
    | {
        mode: "action";
        action: string;
        input: Record<string, AgentManifestReadbackBindingV1>;
        assertions: Array<{
          pointer: string;
          operator: "exists" | "equals" | "not_equals";
          value?: JsonValue;
        }>;
      };
  rollback:
    | { mode: "not_applicable" | "irreversible" }
    | { mode: "manual"; instructions_url: string }
    | {
        mode: "action";
        action: string;
        input: Record<string, AgentManifestReadbackBindingV1>;
      };
};

export type AgentManifestV1 = {
  schema: typeof AGENT_MANIFEST_SCHEMA_V1;
  service?: string;
  name?: string;
  description?: string;
  docs_url?: string;
  app_origin?: string;
  execution: {
    mode: "local_cli" | "http_api";
    base_url?: string;
  };
  auth?: {
    type: "login_with_raft";
    login_url?: string;
  };
  actions: AgentManifestActionV1[];
  credential_boundary?: {
    storage: "per_agent_home" | "slock_managed_token";
    forbid_user_home?: boolean;
  };
  context_check?: Record<string, unknown>;
};

const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const EFFECTS = new Set(["read", "create", "update", "delete", "external_side_effect"]);
const IDEMPOTENCY_MODES = new Set(["safe", "idempotent", "key_required", "non_idempotent"]);
const SCHEMA_KEYS = new Set([
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "pattern",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$defs",
  "$ref",
]);
const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const CREDENTIAL_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "proxy-authenticate",
  "www-authenticate",
]);
const UNSAFE_BINDING_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertKnownFields(value: Record<string, unknown>, allowed: Set<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !key.startsWith("x-")) {
      throw new Error(`${field}.${key} is not supported in manifest v1`);
    }
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string when present`);
  }
  return value.trim();
}

function requireName(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
  const name = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(name)) {
    throw new Error(`${field} may only contain letters, digits, dot, underscore, colon, or dash`);
  }
  return name;
}

function requireHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty HTTPS URL string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${field} must use HTTPS`);
  if (parsed.username || parsed.password) throw new Error(`${field} must not include credentials`);
  if (field === "execution.base_url" && (parsed.search || parsed.hash)) {
    throw new Error(`${field} must not include a query or fragment`);
  }
  return parsed.toString();
}

function requireJsonPointer(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be an RFC 6901 JSON Pointer`);
  if (value === "") return value;
  if (!value.startsWith("/") || /~(?:[^01]|$)/.test(value)) {
    throw new Error(`${field} must be an RFC 6901 JSON Pointer`);
  }
  return value;
}

function requireEndpointPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty relative path`);
  }
  const endpointPath = value.trim();
  if (!endpointPath.startsWith("/") || endpointPath.startsWith("//")) {
    throw new Error(`${field} must be a relative service path`);
  }
  if (/[\u0000-\u001f\u007f\\]/.test(endpointPath)) {
    throw new Error(`${field} must not contain control characters or backslashes`);
  }
  const staticPath = endpointPath.replace(/\{[A-Za-z][A-Za-z0-9_]*\}/g, "placeholder");
  for (const segment of staticPath.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error(`${field} contains invalid percent encoding`);
    }
    if (decoded === "." || decoded === "..") {
      throw new Error(`${field} must not contain dot segments`);
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(endpointPath, "https://manifest.invalid");
  } catch {
    throw new Error(`${field} must be a relative service path`);
  }
  if (
    parsed.origin !== "https://manifest.invalid"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${field} must not contain an origin, credentials, query, or fragment`);
  }
  return endpointPath;
}

function normalizeMethod(value: unknown, field: string): AgentManifestActionV1["endpoint"]["method"] {
  if (typeof value !== "string") throw new Error(`${field} must be an HTTP method`);
  const method = value.trim().toUpperCase();
  if (!HTTP_METHODS.has(method)) {
    throw new Error(`${field} must be GET, POST, PUT, PATCH, or DELETE`);
  }
  return method as AgentManifestActionV1["endpoint"]["method"];
}

function normalizeRequestBinding(value: unknown, field: string): AgentManifestRequestBindingV1 {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownFields(value, new Set(["from"]), field);
  return { from: requireJsonPointer(value.from, `${field}.from`) };
}

function normalizeRequestBindingMap(
  value: unknown,
  field: string,
): Record<string, AgentManifestRequestBindingV1> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (Object.keys(value).length > V1_MANIFEST_LIMITS.maxBindingsPerMap) {
    throw new Error(`${field} exceeds the maximum binding count`);
  }
  const result: Record<string, AgentManifestRequestBindingV1> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = requireName(key, `${field} key`);
    if (UNSAFE_BINDING_NAMES.has(name)) {
      throw new Error(`${field} contains an unsafe binding name`);
    }
    result[name] = normalizeRequestBinding(raw, `${field}.${name}`);
  }
  return result;
}

function normalizeRequest(value: unknown, field: string): AgentManifestRequestV1 {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownFields(value, new Set(["path", "query", "body"]), field);
  return {
    path: normalizeRequestBindingMap(value.path, `${field}.path`),
    query: normalizeRequestBindingMap(value.query, `${field}.query`),
    body: value.body === undefined ? undefined : normalizeRequestBinding(value.body, `${field}.body`),
  };
}

function countPlaceholders(endpointPath: string): string[] {
  const placeholders: string[] = [];
  const unmatched = endpointPath.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    placeholders.push(name);
    return "";
  });
  if (/[{}]/.test(unmatched)) throw new Error("actions[].endpoint.path contains an invalid placeholder");
  if (new Set(placeholders).size !== placeholders.length) {
    throw new Error("actions[].endpoint.path contains a duplicate placeholder");
  }
  return placeholders;
}

function assertRequestCoherence(action: AgentManifestActionV1, field: string): void {
  const placeholders = countPlaceholders(action.endpoint.path).sort();
  const pathBindings = Object.keys(action.request.path ?? {}).sort();
  if (JSON.stringify(placeholders) !== JSON.stringify(pathBindings)) {
    throw new Error(`${field}.request.path must bind every endpoint placeholder exactly once`);
  }
  if (action.endpoint.method === "GET" && action.request.body) {
    throw new Error(`${field}.request.body is forbidden for GET actions`);
  }
}

function assertFiniteInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${field} must be a safe integer greater than or equal to ${minimum}`);
  }
  return Number(value);
}

function assertJsonValue(value: unknown, field: string): asserts value is JsonValue {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [
    { value, path: field, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > V1_SCHEMA_LIMITS.maxNodes || current.depth > V1_SCHEMA_LIMITS.maxDepth) {
      throw new Error(`${field} exceeds the bounded JSON literal work limits`);
    }
    if (
      current.value === null
      || typeof current.value === "boolean"
      || typeof current.value === "string"
      || (typeof current.value === "number" && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: current.value[index],
          path: `${current.path}[${index}]`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    if (isRecord(current.value)) {
      for (const [key, nested] of Object.entries(current.value)) {
        pending.push({
          value: nested,
          path: `${current.path}.${key}`,
          depth: current.depth + 1,
        });
      }
      continue;
    }
    throw new Error(`${current.path} must contain only JSON values`);
  }
}

function assertBoundedSchema(schema: unknown, field: string, requireObjectRoot: boolean): AgentManifestJsonSchemaV1 {
  if (!isRecord(schema)) throw new Error(`${field} must be a JSON Schema object`);

  let nodes = 0;
  let properties = 0;
  let branches = 0;
  const visit = (value: unknown, path: string, depth: number): void => {
    if (!isRecord(value)) throw new Error(`${path} must be a JSON Schema object`);
    nodes += 1;
    if (nodes > V1_SCHEMA_LIMITS.maxNodes) {
      throw new Error(`${field} exceeds the maximum schema node count`);
    }
    if (depth > V1_SCHEMA_LIMITS.maxDepth) {
      throw new Error(`${field} exceeds the maximum schema depth`);
    }
    for (const key of Object.keys(value)) {
      if (!SCHEMA_KEYS.has(key)) throw new Error(`${path}.${key} is not an allowed manifest v1 schema keyword`);
    }

    if (value.type !== undefined) {
      if (typeof value.type !== "string" || !JSON_TYPES.has(value.type)) {
        throw new Error(`${path}.type must be one supported JSON type`);
      }
    }
    if (value.$ref !== undefined) {
      if (typeof value.$ref !== "string" || !/^#\/\$defs\/[A-Za-z0-9._-]{1,80}$/.test(value.$ref)) {
        throw new Error(`${path}.$ref must reference one local #/$defs entry`);
      }
    }
    if (value.pattern !== undefined) {
      if (typeof value.pattern !== "string" || value.pattern.length > V1_SCHEMA_LIMITS.maxPatternLength) {
        throw new Error(`${path}.pattern exceeds the bounded regex length`);
      }
      try {
        new RegExp(value.pattern);
      } catch {
        throw new Error(`${path}.pattern must be a valid regular expression`);
      }
      if (!safeRegex(value.pattern)) {
        throw new Error(`${path}.pattern must not contain unsafe backtracking`);
      }
    }
    if (value.enum !== undefined) {
      if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > V1_SCHEMA_LIMITS.maxEnumValues) {
        throw new Error(`${path}.enum must be a nonempty bounded array`);
      }
      assertJsonValue(value.enum, `${path}.enum`);
    }
    if (value.const !== undefined) assertJsonValue(value.const, `${path}.const`);
    for (const keyword of ["minItems", "maxItems", "minLength", "maxLength"] as const) {
      if (value[keyword] !== undefined) assertFiniteInteger(value[keyword], `${path}.${keyword}`);
    }
    for (const keyword of ["minimum", "maximum"] as const) {
      if (value[keyword] !== undefined && (typeof value[keyword] !== "number" || !Number.isFinite(value[keyword]))) {
        throw new Error(`${path}.${keyword} must be a finite number`);
      }
    }
    if (
      typeof value.minItems === "number"
      && typeof value.maxItems === "number"
      && value.minItems > value.maxItems
    ) {
      throw new Error(`${path}.minItems must not exceed maxItems`);
    }
    if (
      typeof value.minLength === "number"
      && typeof value.maxLength === "number"
      && value.minLength > value.maxLength
    ) {
      throw new Error(`${path}.minLength must not exceed maxLength`);
    }
    if (
      typeof value.minimum === "number"
      && typeof value.maximum === "number"
      && value.minimum > value.maximum
    ) {
      throw new Error(`${path}.minimum must not exceed maximum`);
    }

    if (value.properties !== undefined) {
      if (!isRecord(value.properties)) throw new Error(`${path}.properties must be an object`);
      properties += Object.keys(value.properties).length;
      if (properties > V1_SCHEMA_LIMITS.maxProperties) {
        throw new Error(`${field} exceeds the maximum property count`);
      }
      for (const [name, child] of Object.entries(value.properties)) {
        if (name === "__proto__" || name === "prototype" || name === "constructor") {
          throw new Error(`${path}.properties contains an unsafe property name`);
        }
        visit(child, `${path}.properties.${name}`, depth + 1);
      }
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || !value.required.every((item) => typeof item === "string")) {
        throw new Error(`${path}.required must be an array of property names`);
      }
      if (new Set(value.required).size !== value.required.length) {
        throw new Error(`${path}.required must not contain duplicates`);
      }
    }
    if (
      value.additionalProperties !== undefined
      && typeof value.additionalProperties !== "boolean"
      && !isRecord(value.additionalProperties)
    ) {
      throw new Error(`${path}.additionalProperties must be a boolean or schema`);
    }
    if (isRecord(value.additionalProperties)) {
      visit(value.additionalProperties, `${path}.additionalProperties`, depth + 1);
    }
    if (value.items !== undefined) visit(value.items, `${path}.items`, depth + 1);
    for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
      if (value[keyword] === undefined) continue;
      if (!Array.isArray(value[keyword]) || value[keyword].length === 0 || value[keyword].length > 16) {
        throw new Error(`${path}.${keyword} must be a nonempty bounded schema array`);
      }
      branches += value[keyword].length;
      if (branches > V1_SCHEMA_LIMITS.maxBranches) {
        throw new Error(`${field} exceeds the maximum schema branch count`);
      }
      value[keyword].forEach((child, index) => visit(child, `${path}.${keyword}[${index}]`, depth + 1));
    }
    if (value.not !== undefined) visit(value.not, `${path}.not`, depth + 1);
    if (value.$defs !== undefined) {
      if (!isRecord(value.$defs)) throw new Error(`${path}.$defs must be an object`);
      for (const [name, child] of Object.entries(value.$defs)) {
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error(`${path}.$defs contains an invalid name`);
        visit(child, `${path}.$defs.${name}`, depth + 1);
      }
    }
  };

  visit(schema, field, 0);
  if (requireObjectRoot && schema.type !== "object") {
    throw new Error(`${field}.type must be object`);
  }

  const ajv = new Ajv2020({
    allErrors: false,
    strict: false,
    validateSchema: true,
    formats: {},
  });
  try {
    ajv.compile(schema);
  } catch (error) {
    throw new Error(`${field} is not a valid bounded JSON Schema: ${(error as Error).message}`);
  }
  return schema;
}

function normalizeAuthority(value: unknown, field: string): AgentManifestActionV1["authority"] {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownFields(value, new Set(["principal", "required_scopes"]), field);
  if (value.principal !== "agent_session") {
    throw new Error(`${field}.principal must be agent_session`);
  }
  if (!Array.isArray(value.required_scopes) || !value.required_scopes.every((scope) => typeof scope === "string" && scope.trim())) {
    throw new Error(`${field}.required_scopes must be an array of nonempty strings`);
  }
  if (value.required_scopes.length > V1_MANIFEST_LIMITS.maxScopesPerAction) {
    throw new Error(`${field}.required_scopes exceeds the maximum scope count`);
  }
  const scopes = value.required_scopes.map((scope) => String(scope).trim());
  const sorted = [...new Set(scopes)].sort();
  if (JSON.stringify(scopes) !== JSON.stringify(sorted)) {
    throw new Error(`${field}.required_scopes must be sorted and unique`);
  }
  return { principal: "agent_session", required_scopes: scopes };
}

function normalizeIdempotency(
  value: unknown,
  field: string,
  effect: AgentManifestActionV1["effect"],
): AgentManifestActionV1["idempotency"] {
  if (!isRecord(value) || typeof value.mode !== "string" || !IDEMPOTENCY_MODES.has(value.mode)) {
    throw new Error(`${field}.mode must be safe, idempotent, key_required, or non_idempotent`);
  }
  if (effect === "read" && value.mode !== "safe") {
    throw new Error(`${field}.mode must be safe for read actions`);
  }
  if (effect !== "read" && value.mode === "safe") {
    throw new Error(`${field}.mode safe is forbidden for mutation actions`);
  }
  if (value.mode !== "key_required") {
    assertKnownFields(value, new Set(["mode"]), field);
    return { mode: value.mode as "safe" | "idempotent" | "non_idempotent" };
  }
  assertKnownFields(value, new Set(["mode", "transport", "scope"]), field);
  if (!isRecord(value.transport)) throw new Error(`${field}.transport must be an object`);
  assertKnownFields(value.transport, new Set(["location", "name"]), `${field}.transport`);
  if (value.transport.location !== "header") throw new Error(`${field}.transport.location must be header`);
  if (typeof value.transport.name !== "string" || !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(value.transport.name)) {
    throw new Error(`${field}.transport.name must be a safe header name`);
  }
  if (CREDENTIAL_HEADER_NAMES.has(value.transport.name.toLowerCase())) {
    throw new Error(`${field}.transport.name must not be a credential header`);
  }
  if (value.scope !== "actor_action") throw new Error(`${field}.scope must be actor_action`);
  return {
    mode: "key_required",
    transport: { location: "header", name: value.transport.name },
    scope: "actor_action",
  };
}

function normalizeReadbackBindingMap(
  value: unknown,
  field: string,
): Record<string, AgentManifestReadbackBindingV1> {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (Object.keys(value).length > V1_MANIFEST_LIMITS.maxBindingsPerMap) {
    throw new Error(`${field} exceeds the maximum binding count`);
  }
  const result: Record<string, AgentManifestReadbackBindingV1> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = requireName(key, `${field} key`);
    if (UNSAFE_BINDING_NAMES.has(name)) {
      throw new Error(`${field} contains an unsafe binding name`);
    }
    if (!isRecord(raw)) throw new Error(`${field}.${name} must be an object`);
    assertKnownFields(raw, new Set(["from", "pointer"]), `${field}.${name}`);
    if (raw.from !== "request" && raw.from !== "response") {
      throw new Error(`${field}.${name}.from must be request or response`);
    }
    result[name] = {
      from: raw.from,
      pointer: requireJsonPointer(raw.pointer, `${field}.${name}.pointer`),
    };
  }
  return result;
}

function normalizeReadback(value: unknown, field: string): AgentManifestActionV1["readback"] {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (value.mode === "not_applicable" || value.mode === "not_supported") {
    assertKnownFields(value, new Set(["mode"]), field);
    return { mode: value.mode };
  }
  if (value.mode !== "action") {
    throw new Error(`${field}.mode must be action, not_supported, or not_applicable`);
  }
  assertKnownFields(value, new Set(["mode", "action", "input", "assertions"]), field);
  if (!Array.isArray(value.assertions) || value.assertions.length === 0 || value.assertions.length > 32) {
    throw new Error(`${field}.assertions must be a nonempty bounded array`);
  }
  const assertions = value.assertions.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`${field}.assertions[${index}] must be an object`);
    assertKnownFields(raw, new Set(["pointer", "operator", "value"]), `${field}.assertions[${index}]`);
    if (raw.operator !== "exists" && raw.operator !== "equals" && raw.operator !== "not_equals") {
      throw new Error(`${field}.assertions[${index}].operator is unsupported`);
    }
    if (raw.operator !== "exists" && !Object.hasOwn(raw, "value")) {
      throw new Error(`${field}.assertions[${index}].value is required`);
    }
    if (Object.hasOwn(raw, "value")) assertJsonValue(raw.value, `${field}.assertions[${index}].value`);
    return {
      pointer: requireJsonPointer(raw.pointer, `${field}.assertions[${index}].pointer`),
      operator: raw.operator as "exists" | "equals" | "not_equals",
      ...(Object.hasOwn(raw, "value") ? { value: raw.value as JsonValue } : {}),
    };
  });
  return {
    mode: "action",
    action: requireName(value.action, `${field}.action`),
    input: normalizeReadbackBindingMap(value.input, `${field}.input`),
    assertions,
  };
}

function normalizeRollback(value: unknown, field: string): AgentManifestActionV1["rollback"] {
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  if (value.mode === "not_applicable" || value.mode === "irreversible") {
    assertKnownFields(value, new Set(["mode"]), field);
    return { mode: value.mode };
  }
  if (value.mode === "manual") {
    assertKnownFields(value, new Set(["mode", "instructions_url"]), field);
    return {
      mode: "manual",
      instructions_url: requireHttpsUrl(value.instructions_url, `${field}.instructions_url`),
    };
  }
  if (value.mode !== "action") {
    throw new Error(`${field}.mode must be action, manual, irreversible, or not_applicable`);
  }
  assertKnownFields(value, new Set(["mode", "action", "input"]), field);
  return {
    mode: "action",
    action: requireName(value.action, `${field}.action`),
    input: normalizeReadbackBindingMap(value.input, `${field}.input`),
  };
}

function normalizeAction(value: unknown, index: number): AgentManifestActionV1 {
  const field = `actions[${index}]`;
  if (!isRecord(value)) throw new Error(`${field} must be an object`);
  assertKnownFields(
    value,
    new Set([
      "name",
      "description",
      "endpoint",
      "request",
      "authority",
      "effect",
      "input_schema",
      "output_schema",
      "idempotency",
      "readback",
      "rollback",
    ]),
    field,
  );
  if (!isRecord(value.endpoint)) throw new Error(`${field}.endpoint must be an object`);
  assertKnownFields(value.endpoint, new Set(["method", "path"]), `${field}.endpoint`);
  if (typeof value.effect !== "string" || !EFFECTS.has(value.effect)) {
    throw new Error(`${field}.effect is unsupported`);
  }
  const effect = value.effect as AgentManifestActionV1["effect"];
  const action: AgentManifestActionV1 = {
    name: requireName(value.name, `${field}.name`),
    description: optionalString(value.description, `${field}.description`),
    endpoint: {
      method: normalizeMethod(value.endpoint.method, `${field}.endpoint.method`),
      path: requireEndpointPath(value.endpoint.path, `${field}.endpoint.path`),
    },
    request: normalizeRequest(value.request, `${field}.request`),
    authority: normalizeAuthority(value.authority, `${field}.authority`),
    effect,
    input_schema: assertBoundedSchema(value.input_schema, `${field}.input_schema`, true),
    output_schema: assertBoundedSchema(value.output_schema, `${field}.output_schema`, false),
    idempotency: normalizeIdempotency(value.idempotency, `${field}.idempotency`, effect),
    readback: normalizeReadback(value.readback, `${field}.readback`),
    rollback: normalizeRollback(value.rollback, `${field}.rollback`),
  };
  if (action.endpoint.method === "GET" && effect !== "read") {
    throw new Error(`${field}.effect must be read for GET actions`);
  }
  if (effect === "delete" && action.endpoint.method !== "DELETE") {
    throw new Error(`${field}.endpoint.method must be DELETE for delete actions`);
  }
  if (effect === "read" && action.readback.mode !== "not_applicable") {
    throw new Error(`${field}.readback.mode must be not_applicable for read actions`);
  }
  if (effect !== "read" && action.readback.mode === "not_applicable") {
    throw new Error(`${field}.readback.mode not_applicable is reserved for read actions`);
  }
  if (effect === "read" && action.rollback.mode !== "not_applicable") {
    throw new Error(`${field}.rollback.mode must be not_applicable for read actions`);
  }
  if (effect !== "read" && action.rollback.mode === "not_applicable") {
    throw new Error(`${field}.rollback.mode not_applicable is reserved for read actions`);
  }
  assertRequestCoherence(action, field);
  return action;
}

function assertActionReferences(actions: AgentManifestActionV1[]): void {
  const actionByName = new Map(actions.map((action) => [action.name, action]));
  const readbackEdges = new Map<string, string>();
  const rollbackEdges = new Map<string, string>();
  for (const action of actions) {
    if (action.readback.mode === "action") {
      const target = actionByName.get(action.readback.action);
      if (!target || target.effect !== "read" || target.name === action.name) {
        throw new Error(`action ${action.name} readback must reference another declared read action`);
      }
      readbackEdges.set(action.name, target.name);
      assertBindingTargets(action.readback.input, target, `action ${action.name} readback.input`);
    }
    if (action.rollback.mode === "action") {
      const target = actionByName.get(action.rollback.action);
      if (!target || target.effect === "read" || target.name === action.name) {
        throw new Error(`action ${action.name} rollback must reference another declared mutation action`);
      }
      rollbackEdges.set(action.name, target.name);
      assertBindingTargets(action.rollback.input, target, `action ${action.name} rollback.input`);
    }
  }
  assertAcyclic(readbackEdges, "readback");
  assertAcyclic(rollbackEdges, "rollback");
}

function assertBindingTargets(
  bindings: Record<string, AgentManifestReadbackBindingV1>,
  target: AgentManifestActionV1,
  field: string,
): void {
  const properties = isRecord(target.input_schema.properties)
    ? target.input_schema.properties
    : {};
  for (const key of Object.keys(bindings)) {
    if (!Object.hasOwn(properties, key)) {
      throw new Error(`${field}.${key} does not name a target input property`);
    }
  }
  const required = Array.isArray(target.input_schema.required)
    ? target.input_schema.required.filter((value): value is string => typeof value === "string")
    : [];
  for (const key of required) {
    if (!Object.hasOwn(bindings, key)) throw new Error(`${field} does not bind required target input ${key}`);
  }
}

function assertAcyclic(edges: Map<string, string>, label: string): void {
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    let current: string | undefined = start;
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`${label} action references must not contain cycles`);
      seen.add(current);
      current = edges.get(current);
    }
  }
}

export function validateAgentManifestV1(value: unknown): AgentManifestV1 {
  if (!isRecord(value)) throw new Error("manifest must be a JSON object");
  assertKnownFields(
    value,
    new Set([
      "schema",
      "service",
      "name",
      "description",
      "docs_url",
      "app_origin",
      "execution",
      "auth",
      "actions",
      "credential_boundary",
      "context_check",
    ]),
    "manifest",
  );
  if (value.schema !== AGENT_MANIFEST_SCHEMA_V1 && value.schema !== RAFT_AGENT_MANIFEST_SCHEMA_V1) {
    throw new Error(`manifest schema must be ${AGENT_MANIFEST_SCHEMA_V1} or ${RAFT_AGENT_MANIFEST_SCHEMA_V1}`);
  }
  if (!isRecord(value.execution)) throw new Error("execution must be an object");
  assertKnownFields(value.execution, new Set(["mode", "base_url"]), "execution");
  if (value.execution.mode !== "local_cli" && value.execution.mode !== "http_api") {
    throw new Error("execution.mode must be local_cli or http_api");
  }
  if (value.execution.mode === "http_api" && value.execution.base_url === undefined) {
    throw new Error("execution.base_url is required for http_api manifest v1");
  }
  if (!Array.isArray(value.actions)) throw new Error("actions must be an array");
  if (value.actions.length > V1_MANIFEST_LIMITS.maxActions) {
    throw new Error("actions exceeds the maximum action count");
  }
  const actions = value.actions.map(normalizeAction);
  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.name)) throw new Error(`duplicate action name: ${action.name}`);
    seen.add(action.name);
  }
  if (value.execution.mode === "local_cli" && actions.length > 0) {
    throw new Error("manifest v1 local_cli actions must be empty during P2-B");
  }
  assertActionReferences(actions);

  let auth: AgentManifestV1["auth"];
  if (value.auth !== undefined) {
    if (!isRecord(value.auth)) throw new Error("auth must be an object");
    assertKnownFields(value.auth, new Set(["type", "login_url"]), "auth");
    if (value.auth.type !== "login_with_raft") throw new Error("auth.type must be login_with_raft");
    auth = {
      type: "login_with_raft",
      login_url: value.auth.login_url === undefined
        ? undefined
        : requireHttpsUrl(value.auth.login_url, "auth.login_url"),
    };
  }
  if (value.execution.mode === "http_api" && actions.length > 0 && !auth) {
    throw new Error("auth.type=login_with_raft is required for http_api manifest v1 actions");
  }

  let credentialBoundary: AgentManifestV1["credential_boundary"];
  if (value.credential_boundary !== undefined) {
    if (!isRecord(value.credential_boundary)) throw new Error("credential_boundary must be an object");
    assertKnownFields(value.credential_boundary, new Set(["storage", "forbid_user_home"]), "credential_boundary");
    if (
      value.credential_boundary.storage !== "per_agent_home"
      && value.credential_boundary.storage !== "slock_managed_token"
    ) {
      throw new Error("credential_boundary.storage must be per_agent_home or slock_managed_token");
    }
    if (
      value.credential_boundary.forbid_user_home !== undefined
      && typeof value.credential_boundary.forbid_user_home !== "boolean"
    ) {
      throw new Error("credential_boundary.forbid_user_home must be a boolean when present");
    }
    credentialBoundary = {
      storage: value.credential_boundary.storage,
      forbid_user_home: value.credential_boundary.forbid_user_home === true,
    };
  }
  if (value.context_check !== undefined && !isRecord(value.context_check)) {
    throw new Error("context_check must be an object when present");
  }

  return {
    schema: AGENT_MANIFEST_SCHEMA_V1,
    service: optionalString(value.service, "service"),
    name: optionalString(value.name, "name"),
    description: optionalString(value.description, "description"),
    docs_url: value.docs_url === undefined ? undefined : requireHttpsUrl(value.docs_url, "docs_url"),
    app_origin: value.app_origin === undefined ? undefined : requireHttpsUrl(value.app_origin, "app_origin"),
    execution: {
      mode: value.execution.mode,
      base_url: value.execution.base_url === undefined
        ? undefined
        : requireHttpsUrl(value.execution.base_url, "execution.base_url"),
    },
    auth,
    actions,
    credential_boundary: credentialBoundary,
    context_check: value.context_check,
  };
}

export function compileAgentManifestSchemaV1(
  schema: AgentManifestJsonSchemaV1,
): ValidateFunction<unknown> {
  const ajv = new Ajv2020({
    allErrors: false,
    strict: false,
    validateSchema: true,
    formats: {},
  });
  return ajv.compile(schema);
}

export function boundedSchemaErrorPath(error: ErrorObject | null | undefined): string | null {
  if (!error) return null;
  const path = error.instancePath || "/";
  return path.length > 256 ? `${path.slice(0, 253)}...` : path;
}
