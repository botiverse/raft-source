// The v0 agent manifest an app publishes (`raft-agent-manifest.v0`): its
// actions and how to call them. Shared by the `raft` CLI and the SDK; the CLI's
// copy in packages/cli/src/commands/integration/manifest.ts moves here next.
// (v1 manifests are validated by the CLI only for now.)

export const AGENT_MANIFEST_MAX_BYTES = 1024 * 1024;
export const AGENT_MANIFEST_SCHEMA_V0 = "slock-agent-manifest.v0";
export const RAFT_AGENT_MANIFEST_SCHEMA_V0 = "raft-agent-manifest.v0";
export const AGENT_MANIFEST_SCHEMA_V0_URL = "https://app.slock.ai/schemas/agent-manifest.v0.json";
export const RAFT_AGENT_MANIFEST_WELL_KNOWN_PATH = "/.well-known/raft-agent-manifest.json";
export const SLOCK_AGENT_MANIFEST_WELL_KNOWN_PATH = "/.well-known/slock-agent-manifest.json";
export const AGENT_MANIFEST_FETCH_TIMEOUT_MS = 10_000;

export type AgentManifestV0 = {
  schema: typeof AGENT_MANIFEST_SCHEMA_V0;
  service?: string;
  name?: string;
  description?: string;
  docs_url?: string;
  app_origin?: string;
  execution: {
    mode: "local_cli" | "http_api";
    command?: string;
    base_url?: string;
  };
  auth?: {
    type: "login_with_raft";
    login_url?: string;
  };
  actions?: AgentManifestActionV0[];
  credential_boundary?: {
    storage: "per_agent_home" | "slock_managed_token";
    forbid_user_home?: boolean;
  };
  context_check?: Record<string, unknown>;
};

export type AgentManifestActionResponseV0 = {
  type: "file";
  contentType?: string;
  filename?: string;
  description?: string;
  maxBytes?: number;
};

export type AgentManifestActionV0 = {
  name: string;
  description?: string;
  endpoint: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
  };
  parameters?: Record<string, AgentManifestActionParameterV0>;
  returns?: Record<string, AgentManifestActionReturnV0>;
  response?: AgentManifestActionResponseV0;
};

export type AgentManifestActionParameterV0 = {
  type: string;
  description?: string;
  required?: boolean;
};

export type AgentManifestActionReturnV0 = {
  type: string;
  description?: string;
};


function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty URL string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${field} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${field} must not include credentials`);
  }
  return parsed.toString();
}

function requireCommand(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("execution.command must be a non-empty string for local_cli manifests");
  }
  const command = value.trim();
  if (command.includes("/") || command.includes("\\") || /\s/.test(command)) {
    throw new Error("execution.command must be a bare command name, not a path or shell fragment");
  }
  return command;
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

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function requireEndpointPath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty path string`);
  }
  const path = value.trim();
  if (!path.startsWith("/")) {
    throw new Error(`${field} must start with /`);
  }
  if (path.startsWith("//")) {
    throw new Error(`${field} must be a relative service path`);
  }
  try {
    const parsed = new URL(path, "https://manifest.local");
    if (parsed.origin !== "https://manifest.local" || parsed.username || parsed.password || parsed.hash) {
      throw new Error();
    }
  } catch {
    throw new Error(`${field} must be a relative service path`);
  }
  return path;
}

function normalizeActionMethod(value: unknown): AgentManifestActionV0["endpoint"]["method"] {
  if (typeof value !== "string") {
    throw new Error("actions[].endpoint.method must be a string");
  }
  const method = value.trim().toUpperCase();
  if (method !== "GET" && method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE") {
    throw new Error("actions[].endpoint.method must be GET, POST, PUT, PATCH, or DELETE");
  }
  return method;
}

function normalizeActionFields(
  value: unknown,
  field: string,
): Record<string, AgentManifestActionParameterV0> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${field} must be an object when present`);

  const fields: Record<string, AgentManifestActionParameterV0> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = requireName(key, `${field} key`);
    if (!isRecord(raw)) throw new Error(`${field}.${name} must be an object`);
    if (typeof raw.type !== "string" || !raw.type.trim()) {
      throw new Error(`${field}.${name}.type must be a non-empty string`);
    }
    fields[name] = {
      type: raw.type.trim(),
      description: optionalString(raw.description),
      required: raw.required === true,
    };
  }
  return fields;
}

function normalizeActionReturns(
  value: unknown,
): Record<string, AgentManifestActionReturnV0> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("actions[].returns must be an object when present");

  const fields: Record<string, AgentManifestActionReturnV0> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = requireName(key, "actions[].returns key");
    if (!isRecord(raw)) throw new Error(`actions[].returns.${name} must be an object`);
    if (typeof raw.type !== "string" || !raw.type.trim()) {
      throw new Error(`actions[].returns.${name}.type must be a non-empty string`);
    }
    fields[name] = {
      type: raw.type.trim(),
      description: optionalString(raw.description),
    };
  }
  return fields;
}

function normalizeActionResponse(
  value: unknown,
): AgentManifestActionResponseV0 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("actions[].response must be an object when present");
  if (typeof value.type !== "string" || !value.type.trim()) {
    throw new Error("actions[].response.type must be a non-empty string");
  }
  const type = value.type.trim();
  if (type !== "file") {
    throw new Error("actions[].response.type must be file");
  }
  const maxBytes = optionalPositiveInteger(value.maxBytes, "actions[].response.maxBytes");
  return {
    type,
    contentType: optionalString(value.contentType),
    filename: optionalString(value.filename),
    description: optionalString(value.description),
    maxBytes,
  };
}

function normalizeActions(value: unknown): AgentManifestActionV0[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("actions must be an array when present");
  const actions = value.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`actions[${index}] must be an object`);
    const endpoint = raw.endpoint;
    if (!isRecord(endpoint)) throw new Error(`actions[${index}].endpoint must be an object`);
    return {
      name: requireName(raw.name, `actions[${index}].name`),
      description: optionalString(raw.description),
      endpoint: {
        method: normalizeActionMethod(endpoint.method),
        path: requireEndpointPath(endpoint.path, `actions[${index}].endpoint.path`),
      },
      parameters: normalizeActionFields(raw.parameters, `actions[${index}].parameters`),
      returns: normalizeActionReturns(raw.returns),
      response: normalizeActionResponse(raw.response),
    };
  });

  const seen = new Set<string>();
  for (const action of actions) {
    if (seen.has(action.name)) throw new Error(`duplicate action name: ${action.name}`);
    seen.add(action.name);
  }
  return actions;
}

function normalizeAuth(value: unknown): AgentManifestV0["auth"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("auth must be an object when present");
  if (value.type !== "login_with_raft") {
    throw new Error("auth.type must be login_with_raft");
  }
  return {
    type: "login_with_raft",
    login_url: value.login_url === undefined ? undefined : requireUrl(value.login_url, "auth.login_url"),
  };
}

export function validateAgentManifestV0(value: unknown): AgentManifestV0 {
  if (!isRecord(value)) throw new Error("manifest must be a JSON object");
  if (
    value.schema !== AGENT_MANIFEST_SCHEMA_V0
    && value.schema !== RAFT_AGENT_MANIFEST_SCHEMA_V0
    && value.schema !== AGENT_MANIFEST_SCHEMA_V0_URL
  ) {
    throw new Error(`manifest schema must be ${AGENT_MANIFEST_SCHEMA_V0} or ${RAFT_AGENT_MANIFEST_SCHEMA_V0}`);
  }
  const execution = value.execution;
  if (!isRecord(execution)) throw new Error("execution must be an object");
  if (execution.mode !== "local_cli" && execution.mode !== "http_api") {
    throw new Error("execution.mode must be local_cli or http_api");
  }
  const credentialBoundary = value.credential_boundary;
  if (credentialBoundary !== undefined && !isRecord(credentialBoundary)) {
    throw new Error("credential_boundary must be an object when present");
  }
  if (
    isRecord(credentialBoundary)
    && credentialBoundary.storage !== "per_agent_home"
    && credentialBoundary.storage !== "slock_managed_token"
  ) {
    throw new Error("credential_boundary.storage must be per_agent_home or slock_managed_token");
  }
  const credentialStorage = isRecord(credentialBoundary)
    && (credentialBoundary.storage === "per_agent_home" || credentialBoundary.storage === "slock_managed_token")
    ? credentialBoundary.storage
    : undefined;
  const forbidUserHome = isRecord(credentialBoundary) && credentialBoundary.forbid_user_home === true;
  if (value.context_check !== undefined && !isRecord(value.context_check)) {
    throw new Error("context_check must be an object when present");
  }

  const actions = normalizeActions(value.actions);
  if (execution.mode !== "http_api") {
    for (const action of actions ?? []) {
      if (action.response) {
        throw new Error("actions[].response is only supported for execution.mode=http_api");
      }
    }
  }

  return {
    schema: AGENT_MANIFEST_SCHEMA_V0,
    service: typeof value.service === "string" && value.service.trim() ? value.service.trim() : undefined,
    name: optionalString(value.name),
    description: optionalString(value.description),
    docs_url: value.docs_url === undefined ? undefined : requireUrl(value.docs_url, "docs_url"),
    app_origin: value.app_origin === undefined ? undefined : requireUrl(value.app_origin, "app_origin"),
    execution: {
      mode: execution.mode,
      command: execution.mode === "local_cli" ? requireCommand(execution.command) : undefined,
      base_url: execution.base_url === undefined ? undefined : requireUrl(execution.base_url, "execution.base_url"),
    },
    auth: normalizeAuth(value.auth),
    actions,
    credential_boundary: credentialStorage
      ? {
          storage: credentialStorage,
          forbid_user_home: forbidUserHome,
        }
      : undefined,
    context_check: value.context_check,
  };
}

export const AGENT_MANIFEST_SCHEMA_V1_NAMES: readonly string[] = ["slock-agent-manifest.v1", "raft-agent-manifest.v1"];

/** The manifest's declared schema is a v1 one (which this module does not validate). */
export function isAgentManifestV1Schema(value: unknown): boolean {
  return isRecord(value) && typeof value.schema === "string" && AGENT_MANIFEST_SCHEMA_V1_NAMES.includes(value.schema);
}
