import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentContext } from "../../auth/env.js";
import {
  credentialFreeDiagnosticUrl,
  fetchWithCanonicalProxy,
  type FetchTransportCauseClass,
} from "../../proxy.js";
import {
  AGENT_MANIFEST_SCHEMA_V1,
  RAFT_AGENT_MANIFEST_SCHEMA_V1,
  validateAgentManifestV1,
  type AgentManifestV1,
} from "./manifestV1.js";

export {
  AGENT_MANIFEST_SCHEMA_V1,
  RAFT_AGENT_MANIFEST_SCHEMA_V1,
  validateAgentManifestV1,
};
export type { AgentManifestActionV1, AgentManifestV1 } from "./manifestV1.js";

export const AGENT_MANIFEST_MAX_BYTES = 64 * 1024;
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

export type AgentManifest = AgentManifestV0 | AgentManifestV1;

export type LocalCliProfileEnv = {
  serviceId: string;
  command: string;
  profileHome: string;
  env: Record<string, string>;
};

export class AgentManifestFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details: {
      contentType?: string;
      retryAfter?: string;
      url?: string;
      causeClass?: FetchTransportCauseClass | "http";
      causeCode?: string;
    } = {},
  ) {
    super(message);
    this.name = "AgentManifestFetchError";
  }
}

export class AgentManifestResponseFormatError extends Error {
  constructor(
    message: string,
    public readonly details: {
      contentType?: string;
      url?: string;
    } = {},
  ) {
    super(message);
    this.name = "AgentManifestResponseFormatError";
  }
}

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

export function validateAgentManifest(value: unknown): AgentManifest {
  if (!isRecord(value)) throw new Error("manifest must be a JSON object");
  if (value.schema === AGENT_MANIFEST_SCHEMA_V1 || value.schema === RAFT_AGENT_MANIFEST_SCHEMA_V1) {
    return validateAgentManifestV1(value);
  }
  return validateAgentManifestV0(value);
}

export async function fetchAgentManifest(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AgentManifest> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error("agent behavior manifest URL must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("agent behavior manifest URL must not include credentials");
  }
  const response = await fetchWithCanonicalProxy(parsed, {
    headers: { accept: "application/json" },
    redirect: "follow",
    signal: AbortSignal.timeout(AGENT_MANIFEST_FETCH_TIMEOUT_MS),
  }, env);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:" || finalUrl.username || finalUrl.password) {
    throw new Error("manifest redirects must remain on credential-free HTTPS URLs");
  }
  if (!response.ok) {
    throw new AgentManifestFetchError(
      `manifest fetch failed with HTTP ${response.status}`,
      response.status,
      {
        contentType: response.headers.get("content-type") ?? undefined,
        retryAfter: response.headers.get("retry-after") ?? undefined,
        url: credentialFreeDiagnosticUrl(response.url || parsed),
        causeClass: "http",
        causeCode: `HTTP_${response.status}`,
      },
    );
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType && !contentType.includes("application/json")) {
    throw new AgentManifestResponseFormatError(
      `manifest response must be application/json (received ${contentType})`,
      { contentType, url: response.url },
    );
  }

  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > AGENT_MANIFEST_MAX_BYTES) {
    throw new Error("manifest response is too large");
  }
  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > AGENT_MANIFEST_MAX_BYTES) {
    throw new Error("manifest response is too large");
  }
  const raw = body.toString("utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new AgentManifestResponseFormatError(
      `manifest response is not valid JSON: ${(err as Error).message}`,
      { contentType: contentType || undefined, url: response.url },
    );
  }
  return validateAgentManifest(parsedJson);
}

function wellKnownAliasUrl(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.pathname === RAFT_AGENT_MANIFEST_WELL_KNOWN_PATH) {
    parsed.pathname = SLOCK_AGENT_MANIFEST_WELL_KNOWN_PATH;
    return parsed.toString();
  }
  if (parsed.pathname === SLOCK_AGENT_MANIFEST_WELL_KNOWN_PATH) {
    parsed.pathname = RAFT_AGENT_MANIFEST_WELL_KNOWN_PATH;
    return parsed.toString();
  }
  return null;
}

function shouldTryWellKnownAlias(err: unknown): boolean {
  if (err instanceof AgentManifestFetchError) return err.status === 404 || err.status === 410;
  return err instanceof AgentManifestResponseFormatError;
}

export async function fetchAgentManifestWithWellKnownAliases(
  url: string,
  fetchManifestImpl: typeof fetchAgentManifest = fetchAgentManifest,
): Promise<AgentManifest> {
  try {
    return await fetchManifestImpl(url);
  } catch (err) {
    if (!shouldTryWellKnownAlias(err)) throw err;
    const alias = wellKnownAliasUrl(url);
    if (!alias) throw err;
    return await fetchManifestImpl(alias);
  }
}

function sanitizePathSegment(value: string): string {
  const segment = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "service";
}

function resolveRaftHome(env: NodeJS.ProcessEnv, homeDir = os.homedir()): string {
  const configured = env.RAFT_HOME?.trim() || env.SLOCK_HOME?.trim();
  const raw = configured && configured.length > 0 ? configured : path.join(homeDir, ".slock");
  return path.resolve(expandHome(raw, homeDir));
}

function expandHome(input: string, homeDir: string): string {
  if (input === "~") return homeDir;
  if (input.startsWith("~/")) return path.join(homeDir, input.slice(2));
  return input;
}

export function buildLocalCliProfileEnv(input: {
  ctx: AgentContext;
  serviceId: string;
  manifest: AgentManifestV0;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}): LocalCliProfileEnv {
  if (input.manifest.execution.mode !== "local_cli" || !input.manifest.execution.command) {
    throw new Error("manifest is not a local_cli integration");
  }
  if (input.manifest.credential_boundary?.storage !== "per_agent_home") {
    throw new Error("manifest does not request per_agent_home credential storage");
  }
  if (input.manifest.credential_boundary.forbid_user_home !== true) {
    throw new Error("manifest must set credential_boundary.forbid_user_home=true for local_cli isolation");
  }

  const root = resolveRaftHome(input.env ?? process.env, input.homeDir);
  const profileHome = path.join(
    root,
    "integration-profiles",
    sanitizePathSegment(input.ctx.serverId ?? "server"),
    sanitizePathSegment(input.ctx.agentId),
    sanitizePathSegment(input.serviceId),
  );
  fs.mkdirSync(profileHome, { recursive: true, mode: 0o700 });
  fs.chmodSync(profileHome, 0o700);

  return {
    serviceId: input.serviceId,
    command: input.manifest.execution.command,
    profileHome,
    env: {
      SLOCK_INTEGRATION_SERVICE: input.serviceId,
      SLOCK_INTEGRATION_PROFILE_HOME: profileHome,
      HOME: profileHome,
      XDG_CONFIG_HOME: path.join(profileHome, ".config"),
      XDG_CACHE_HOME: path.join(profileHome, ".cache"),
      XDG_DATA_HOME: path.join(profileHome, ".local", "share"),
      XDG_STATE_HOME: path.join(profileHome, ".local", "state"),
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function formatShellExports(profile: LocalCliProfileEnv): string {
  const lines = [
    `# Raft integration profile for ${profile.serviceId}`,
    `# command: ${profile.command}`,
    "# This only exports env; Raft does not execute manifest commands.",
    "# Apply these exports before invoking the local CLI yourself.",
  ];
  for (const [key, value] of Object.entries(profile.env)) {
    lines.push(`export ${key}=${shellQuote(value)}`);
  }
  return lines.join("\n");
}
