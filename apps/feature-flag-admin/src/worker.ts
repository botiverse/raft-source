import { Client } from "pg";
import {
  verifyFeatureFlagAdminPrivileges,
} from "@botiverse/raft-shared";
import { handleAnnouncementAdminRequest } from "./announcementAdmin";

export const FEATURE_FLAG_AUDIT_REASON_MAX_LENGTH = 500;

type PrincipalType = "human" | "agent";

type RaftUserinfo = {
  sub?: unknown;
  type?: unknown;
  scope?: unknown;
  client_id?: unknown;
  server_id?: unknown;
  server_slug?: unknown;
  server_role?: unknown;
  preferred_username?: unknown;
  name?: unknown;
  picture?: unknown;
};

type FeatureFlagPrincipal = {
  sub: string;
  type: PrincipalType;
  serverId: string;
  serverSlug: string | null;
  serverRole: string | null;
  clientId: string;
  scopes: string[];
  name: string | null;
  preferredUsername: string | null;
  picture: string | null;
};

type LoginState = {
  nonce: string;
  returnTo: string;
  exp: number;
};

type FeatureFlagSession = {
  accessToken: string;
  principal: FeatureFlagPrincipal;
  expiresAt: number;
};

export interface Env {
  ASSETS: Fetcher;
  FEATURE_FLAG_PG?: Hyperdrive;
  FEATURE_FLAG_AUDIT_DB?: D1Database;
  RAFT_ORIGIN?: string;
  RAFT_API_ORIGIN?: string;
  RAFT_CLIENT_ID: string;
  RAFT_CLIENT_SECRET: string;
  FEATURE_FLAG_SESSION_SECRET: string;
  FEATURE_FLAG_ALLOWED_SERVER_IDS?: string;
}

type FeatureFlagSummary = {
  key: string;
  description: string | null;
  enabled: boolean;
  killSwitch: boolean;
  randomizationUnit: "user" | "server";
  defaultEnabled: boolean;
  defaultVariant: string | null;
  salt?: string;
  highRisk: boolean;
  createdAt?: string;
  updatedAt: string;
};

type AdminRole = "admin";

type FeatureFlagRule = {
  id: string;
  stage: "user" | "platform" | "server" | "audience" | "lab" | "plan" | "percentage";
  priority: number;
  decision: "allow" | "deny";
  values: string[];
  percentageBasisPoints: number | null;
  variant: string | null;
  createdAt: string;
  updatedAt: string;
};

type AudienceMember = {
  memberId: string;
  kind: "user" | "server";
  userId?: string;
  serverSlug?: string | null;
  status: "active" | "unknown_or_deleted";
};

type AudienceDefinition = {
  audienceKey: string;
  name: string;
  description: string;
  enabled: boolean;
  members: AudienceMember[];
  affectedFlags: string[];
  createdAt: string;
  updatedAt: string;
};

type ServerRef = {
  serverId: string;
  serverSlug: string | null;
  status: "active" | "unknown_or_deleted";
};

type PublicServerTarget = {
  serverSlug: string | null;
  status: "active" | "unknown_or_deleted";
};

type LabDefinition = {
  labKey: string;
  name: string;
  description: string;
  state: "draft" | "open" | "paused" | "retired";
  createdAt: string;
  updatedAt: string;
};

type FeatureFlagDetail = {
  flag: FeatureFlagSummary;
  rules: FeatureFlagRule[];
  serverAllowlist: {
    managed: boolean;
    ruleId: string | null;
    serverIds: string[];
  };
  serverAllowlistRules: Array<{
    ruleId: string;
    priority: number;
    serverIds: string[];
  }>;
  unsupportedRuleShapes: string[];
};

type PublicFeatureFlagRule = Omit<FeatureFlagRule, "values"> & {
  values?: string[];
  serverTargets?: PublicServerTarget[];
};

type PublicFeatureFlagDetail = {
  flag: FeatureFlagSummary;
  rules: PublicFeatureFlagRule[];
  serverAllowlist: {
    managed: boolean;
    ruleId: string | null;
    serverTargets: PublicServerTarget[];
  };
  serverAllowlistRules: Array<{
    ruleId: string;
    priority: number;
    serverTargets: PublicServerTarget[];
  }>;
  unsupportedRuleShapes: string[];
};

type GenericFeatureFlagPatch = {
  description?: string | null;
  enabled?: boolean;
  killSwitch?: boolean;
  randomizationUnit?: FeatureFlagSummary["randomizationUnit"];
  defaultEnabled?: boolean;
  defaultVariant?: string | null;
  salt?: string;
};

type GenericFeatureFlagRuleInput = {
  stage: FeatureFlagRule["stage"];
  priority: number;
  decision: FeatureFlagRule["decision"];
  values: string[];
  percentageBasisPoints: number | null;
  variant: string | null;
};

type GenericFeatureFlagRulePatch = Partial<GenericFeatureFlagRuleInput>;

type FeatureFlagPreviewReason =
  | "missing_flag"
  | "kill_switch"
  | "flag_disabled"
  | "missing_user_unit"
  | "missing_server_unit"
  | "user_rule"
  | "platform_rule"
  | "server_rule"
  | "audience_rule"
  | "lab_rule"
  | "plan_rule"
  | "percentage_rule"
  | "default";

type FeatureFlagPreview = {
  key: string;
  enabled: boolean;
  reason: FeatureFlagPreviewReason;
};

type OperatorApiErrorCode =
  | "operator_unauthorized"
  | "announcement_operator_required"
  | "invalid_principal_id"
  | "invalid_admin_role"
  | "invalid_reason"
  | "admin_role_grant_not_found"
  | "admin_role_write_failed"
  | "invalid_flag_key"
  | "invalid_lab_key"
  | "invalid_audience_key"
  | "invalid_lab_state"
  | "invalid_rule_id"
  | "invalid_server_slug"
  | "server_slug_unknown"
  | "server_slug_ambiguous"
  | "invalid_request"
  | "flag_not_found"
  | "lab_not_found"
  | "audience_not_found"
  | "audience_already_exists"
  | "audience_in_use"
  | "lab_already_exists"
  | "lab_state_transition_invalid"
  | "rule_not_found"
  | "rule_shape_unsupported"
  | "version_conflict"
  | "audit_write_failed"
  | "operator_api_pending"
  | "internal_error";

const BOTIVERSE_SERVER_ID = "95f993fa-2a68-4797-b8ae-7beb7d984ada";
const DEFAULT_RAFT_ORIGIN = "https://app.raft.build";
const DEFAULT_RAFT_API_ORIGIN = "https://api.raft.build";
const FEATURE_FLAG_CONFIG_SCOPE_GLOBAL = "global";
// Must remain byte-identical to the canonical server writer's exported
// feature-flag config-version lock identity (namespace "FFCV", key 0).
const FEATURE_FLAG_CONFIG_VERSION_LOCK_NAMESPACE = 0x46464356;
const FEATURE_FLAG_CONFIG_VERSION_LOCK_KEY = 0;
const FEATURE_FLAG_LOCK_NAMESPACE = 0x46464c47;
const FLAG_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const LAB_KEY_RE = FLAG_KEY_RE;
const AUDIENCE_KEY_RE = FLAG_KEY_RE;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVER_CATALOG_QUERY_MAX_LENGTH = 64;
const SERVER_CATALOG_RESULT_LIMIT = 50;
const ADMIN_ROLES = new Set<AdminRole>(["admin"]);
const SESSION_COOKIE = "feature_flag_admin_session";
const STATE_COOKIE = "feature_flag_admin_oauth_state";
const SESSION_TTL_SECONDS = 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function normalizeOrigin(raw: string | undefined, fallback: string): string {
  return (raw?.trim() || fallback).replace(/\/+$/, "");
}

function required(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is not configured`);
  return trimmed;
}

function splitCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function allowedServerIds(env: Env): Set<string> {
  const values = splitCsv(env.FEATURE_FLAG_ALLOWED_SERVER_IDS);
  return new Set(values.length ? values : [BOTIVERSE_SERVER_ID]);
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=") || "";
  }
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.slice(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

async function signJson(secret: string, payload: unknown): Promise<string> {
  const encoded = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await hmac(secret, encoded);
  return `${encoded}.${signature}`;
}

async function verifySignedJson<T>(secret: string, token: string | null | undefined): Promise<T | null> {
  if (!token) return null;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = await hmac(secret, encoded);
  if (expected !== signature) return null;
  try {
    return JSON.parse(decoder.decode(base64UrlDecode(encoded))) as T;
  } catch {
    return null;
  }
}

async function sessionKey(env: Env): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(required(env.FEATURE_FLAG_SESSION_SECRET, "FEATURE_FLAG_SESSION_SECRET")));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealSession(env: Env, session: FeatureFlagSession): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(env);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(session)),
  );
  return `${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ciphertext))}`;
}

async function openSession(request: Request, env: Env): Promise<FeatureFlagSession | null> {
  const raw = cookieValue(request, SESSION_COOKIE);
  if (!raw) return null;
  const [rawIv, rawCiphertext] = raw.split(".");
  if (!rawIv || !rawCiphertext) return null;
  try {
    const key = await sessionKey(env);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlDecode(rawIv) },
      key,
      base64UrlDecode(rawCiphertext),
    );
    const session = JSON.parse(decoder.decode(plaintext)) as FeatureFlagSession;
    if (!session.accessToken || !session.principal || session.expiresAt <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function cookieHeader(request: Request, name: string, value: string, maxAgeSeconds: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

function clearCookieHeader(request: Request, name: string): string {
  return cookieHeader(request, name, "", 0);
}

function normalizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, "https://feature-flags.invalid");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/";
  }
}

function localCallbackUrl(request: Request): string {
  const url = new URL(request.url);
  return new URL("/auth/raft/callback", url.origin).toString();
}

async function loginRedirect(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const now = Math.floor(Date.now() / 1000);
  const state = await signJson(required(env.FEATURE_FLAG_SESSION_SECRET, "FEATURE_FLAG_SESSION_SECRET"), {
    nonce: crypto.randomUUID(),
    returnTo: normalizeReturnTo(url.searchParams.get("return_to")),
    exp: now + STATE_TTL_SECONDS,
  } satisfies LoginState);

  const setup = new URL("/login-with-raft/setup", normalizeOrigin(env.RAFT_ORIGIN, DEFAULT_RAFT_ORIGIN));
  setup.searchParams.set("client_id", required(env.RAFT_CLIENT_ID, "RAFT_CLIENT_ID"));
  setup.searchParams.set("return_to", localCallbackUrl(request));
  setup.searchParams.set("scope", "openid profile");

  return new Response(null, {
    status: 302,
    headers: {
      Location: setup.toString(),
      "Set-Cookie": cookieHeader(request, STATE_COOKIE, state, STATE_TTL_SECONDS),
      "Cache-Control": "no-store",
    },
  });
}

async function exchangeCode(env: Env, code: string): Promise<{ access_token: string; expires_in?: number }> {
  const clientId = required(env.RAFT_CLIENT_ID, "RAFT_CLIENT_ID");
  const clientSecret = required(env.RAFT_CLIENT_SECRET, "RAFT_CLIENT_SECRET");
  const response = await fetch(`${normalizeOrigin(env.RAFT_API_ORIGIN, DEFAULT_RAFT_API_ORIGIN)}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!response.ok) throw new Error(`token_${response.status}`);
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  if (typeof payload.access_token !== "string") throw new Error("token_invalid");
  return {
    access_token: payload.access_token,
    expires_in: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
  };
}

async function fetchUserinfo(env: Env, accessToken: string): Promise<RaftUserinfo> {
  const response = await fetch(`${normalizeOrigin(env.RAFT_API_ORIGIN, DEFAULT_RAFT_API_ORIGIN)}/api/oauth/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) throw new Error(`userinfo_${response.status}`);
  return response.json() as Promise<RaftUserinfo>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`userinfo_missing_${label}`);
  return normalized;
}

function normalizePrincipal(userinfo: RaftUserinfo, env: Env): FeatureFlagPrincipal {
  if (userinfo.type !== "human" && userinfo.type !== "agent") throw new Error("principal_type_not_allowed");
  const clientId = requiredString(userinfo.client_id, "client_id");
  if (clientId !== required(env.RAFT_CLIENT_ID, "RAFT_CLIENT_ID")) throw new Error("client_not_allowed");
  const serverId = requiredString(userinfo.server_id, "server_id");
  if (!allowedServerIds(env).has(serverId)) throw new Error("server_not_allowed");
  return {
    sub: requiredString(userinfo.sub, "sub"),
    type: userinfo.type,
    serverId,
    serverSlug: optionalString(userinfo.server_slug),
    serverRole: optionalString(userinfo.server_role),
    clientId,
    scopes: typeof userinfo.scope === "string" ? userinfo.scope.split(/\s+/).filter(Boolean) : [],
    name: optionalString(userinfo.name),
    preferredUsername: optionalString(userinfo.preferred_username),
    picture: optionalString(userinfo.picture),
  };
}

function publicAuthFailure(): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/?login_error=Login%20with%20Raft%20failed",
      "Cache-Control": "no-store",
    },
  });
}

function requestId(): string {
  return crypto.randomUUID();
}

function ok<T>(data: T, configVersion: number, id = requestId(), init?: ResponseInit): Response {
  return Response.json({ data, configVersion, requestId: id }, init);
}

function authorizationOk<T>(data: T, id: string): Response {
  return Response.json({ data, requestId: id });
}

function fail(code: OperatorApiErrorCode, message: string, status: number, id = requestId()): Response {
  return Response.json({
    error: { code, message },
    requestId: id,
  }, { status });
}

function parseFlagKey(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return FLAG_KEY_RE.test(trimmed) ? trimmed : null;
}

function parseLabKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return LAB_KEY_RE.test(trimmed) ? trimmed : null;
}

function parseAudienceKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return AUDIENCE_KEY_RE.test(trimmed) ? trimmed : null;
}

function parseLabState(value: unknown): LabDefinition["state"] | null {
  return value === "draft" || value === "open" || value === "paused" || value === "retired"
    ? value
    : null;
}

function parseDecision(value: unknown): FeatureFlagRule["decision"] | null {
  return value === "allow" || value === "deny" ? value : null;
}

function parsePriority(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseNonemptyText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function parseLabKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed = value.map((entry) => parseLabKey(entry));
  if (parsed.some((entry) => entry === null)) return null;
  return [...new Set(parsed as string[])].sort();
}

function sameLabKeySet(left: string[], right: string[]): boolean {
  const canonicalize = (values: string[]) => [...new Set(values)].sort();
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function parseServerId(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value.trim()) ? value.trim() : null;
}

function parseServerSlug(value: unknown): string | null {
  return typeof value === "string"
    && value.length >= 5
    && /^[a-z][a-z0-9-]*$/.test(value)
    ? value
    : null;
}

function parseServerSlugs(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed = value.map((entry) => parseServerSlug(entry));
  if (parsed.some((entry) => entry === null)) return null;
  return [...new Set(parsed as string[])].sort();
}

function parseServerSlugsAllowEmpty(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return [];
  return parseServerSlugs(value);
}

function parseUuidArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const parsed = value.map((entry) => parseServerId(entry)?.toLowerCase() ?? null);
  if (parsed.some((entry) => entry === null)) return null;
  return [...new Set(parsed as string[])].sort();
}

function parseServerCatalogQuery(value: string | null): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized.length <= SERVER_CATALOG_QUERY_MAX_LENGTH
    && /^[a-z0-9-]*$/.test(normalized)
    ? normalized
    : null;
}

function parseRuleId(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value.trim()) ? value.trim() : null;
}

function parseReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const reason = value.trim();
  return reason.length >= 3 && reason.length <= FEATURE_FLAG_AUDIT_REASON_MAX_LENGTH ? reason : null;
}

function parseExpectedVersion(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parseInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function parseStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const values = value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
  return values.length === value.length ? values : undefined;
}

function parseRandomizationUnit(value: unknown): FeatureFlagSummary["randomizationUnit"] | null {
  return value === "user" || value === "server" ? value : null;
}

function parseRuleStage(value: unknown): FeatureFlagRule["stage"] | null {
  return value === "user"
    || value === "platform"
    || value === "server"
    || value === "audience"
    || value === "lab"
    || value === "plan"
    || value === "percentage"
    ? value
    : null;
}

async function requestBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === "GET" || request.method === "HEAD") return {};
  const text = await request.text().catch(() => "");
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return {};
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {};
}

async function hasPersistentRole(env: Env, principalId: string, role: AdminRole): Promise<boolean> {
  if (!env.FEATURE_FLAG_AUDIT_DB) return false;
  const grant = await env.FEATURE_FLAG_AUDIT_DB.prepare(`
    SELECT principal_id
    FROM feature_flag_admin_role_grants
    WHERE principal_id = ? AND role = ? AND enabled = 1
    LIMIT 1
  `).bind(principalId, role).first<{ principal_id: string }>();
  return grant?.principal_id === principalId;
}

async function requireOperator(session: FeatureFlagSession, env: Env, id: string): Promise<Response | null> {
  if (!env.FEATURE_FLAG_AUDIT_DB) {
    return fail(
      "operator_api_pending",
      "Admin authorization storage is not configured.",
      501,
      id,
    );
  }
  if (await hasPersistentRole(env, session.principal.sub, "admin")) return null;
  return fail("operator_unauthorized", "Feature flag operator access required.", 403, id);
}

// Announcement publishing requires a human AND the `admin` role. The `admin` half is
// already enforced by requireOperator on the same route, so the only thing left to check
// here is that the principal is a human: an agent holding `admin` must still be refused.
// The retired `announcement_publisher` role is deliberately not consulted — see
// parseAdminRole. Callers must keep running requireOperator BEFORE this gate; on its own
// this function does not establish `admin`.
function requireHumanAnnouncementOperator(
  session: FeatureFlagSession,
  id: string,
): Response | null {
  if (session.principal.type !== "human") {
    return fail(
      "announcement_operator_required",
      "Announcement publishing requires a human account.",
      403,
      id,
    );
  }
  return null;
}

// `announcement_publisher` is retired here, which closes the PRODUCT API write surface:
// every in-repo write to feature_flag_admin_role_grants goes through this parser first.
// The D1 CHECK constraint still lists the retired value and is deliberately left alone —
// changing a SQLite CHECK means rebuilding the grant and audit tables, which is worse
// than the schema debt while zero enabled publisher grants exist.
// ⚠️ Precisely: the value is unreachable through this API. It is NOT globally unwritable —
// raw D1 or migration authority can still insert it.
function parseAdminRole(value: string): AdminRole | null {
  return ADMIN_ROLES.has(value as AdminRole) ? value as AdminRole : null;
}

function roleGrantJson(row: Record<string, unknown>) {
  return {
    principalId: String(row.principal_id),
    role: String(row.role),
    enabled: Number(row.enabled) === 1,
    grantedByPrincipalId: String(row.granted_by_principal_id),
    reason: String(row.reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

async function handleAccessGrantApi(
  request: Request,
  env: Env,
  session: FeatureFlagSession,
  id: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/operator/access-grants" && request.method === "GET") {
    if (!env.FEATURE_FLAG_AUDIT_DB) {
      return fail("operator_api_pending", "Admin authorization storage is not configured.", 501, id);
    }
    const result = await env.FEATURE_FLAG_AUDIT_DB.prepare(`
      SELECT principal_id, role, enabled, granted_by_principal_id, reason, created_at, updated_at
      FROM feature_flag_admin_role_grants
      WHERE enabled = 1
      ORDER BY principal_id ASC, role ASC
    `).bind().all<Record<string, unknown>>();
    return authorizationOk({ grants: result.results.map(roleGrantJson) }, id);
  }

  const match = url.pathname.match(/^\/api\/operator\/access-grants\/([^/]+)\/([^/]+)$/);
  if (!match || (request.method !== "PUT" && request.method !== "DELETE")) return null;
  if (!env.FEATURE_FLAG_AUDIT_DB) {
    return fail("operator_api_pending", "Admin authorization storage is not configured.", 501, id);
  }

  const principalId = decodeURIComponent(match[1] ?? "");
  const role = parseAdminRole(decodeURIComponent(match[2] ?? ""));
  if (!UUID_RE.test(principalId)) {
    return fail("invalid_principal_id", "principalId must be a valid UUID.", 400, id);
  }
  if (!role) {
    return fail(
      "invalid_admin_role",
      "role must be admin. announcement_publisher is retired; announcement publishing "
        + "now requires a human with admin.",
      400,
      id,
    );
  }
  const body = await requestBody(request);
  const reason = parseReason(body.reason);
  if (!reason) {
    return fail(
      "invalid_reason",
      `reason must be between 3 and ${FEATURE_FLAG_AUDIT_REASON_MAX_LENGTH} characters.`,
      400,
      id,
    );
  }

  const db = env.FEATURE_FLAG_AUDIT_DB;
  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  try {
    if (request.method === "DELETE") {
      const before = await db.prepare(`
        SELECT principal_id
        FROM feature_flag_admin_role_grants
        WHERE principal_id = ? AND role = ? AND enabled = 1
        LIMIT 1
      `).bind(principalId, role).first<{ principal_id: string }>();
      if (!before) return fail("admin_role_grant_not_found", "Admin role grant not found.", 404, id);
    }

    const mutation = request.method === "PUT"
      ? db.prepare(`
          INSERT INTO feature_flag_admin_role_grants (
            principal_id, role, enabled, granted_by_principal_id, reason, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?)
          ON CONFLICT(principal_id, role) DO UPDATE SET
            enabled = 1,
            granted_by_principal_id = excluded.granted_by_principal_id,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `).bind(principalId, role, session.principal.sub, reason, now, now)
      : db.prepare(`
          UPDATE feature_flag_admin_role_grants
          SET enabled = 0, granted_by_principal_id = ?, reason = ?, updated_at = ?
          WHERE principal_id = ? AND role = ? AND enabled = 1
        `).bind(session.principal.sub, reason, now, principalId, role);
    const audit = db.prepare(`
      INSERT INTO feature_flag_admin_role_audit_events (
        id, actor_principal_id, target_principal_id, role, action, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(
      auditId,
      session.principal.sub,
      principalId,
      role,
      request.method === "PUT" ? "grant" : "revoke",
      reason,
      now,
    );
    await db.batch([mutation, audit]);

    const readback = await db.prepare(`
      SELECT principal_id, role, enabled, granted_by_principal_id, reason, created_at, updated_at
      FROM feature_flag_admin_role_grants
      WHERE principal_id = ? AND role = ?
      LIMIT 1
    `).bind(principalId, role).first<Record<string, unknown>>();
    const expectedEnabled = request.method === "PUT";
    if (!readback || (Number(readback.enabled) === 1) !== expectedEnabled) {
      throw new Error("role_grant_readback_mismatch");
    }
    return authorizationOk({ grant: roleGrantJson(readback), auditId }, id);
  } catch (error) {
    console.warn("[feature-flag-admin-role]", error instanceof Error ? error.message : "unknown");
    return fail("admin_role_write_failed", "Admin role update failed.", 500, id);
  }
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  if (!code) return publicAuthFailure();

  const secret = required(env.FEATURE_FLAG_SESSION_SECRET, "FEATURE_FLAG_SESSION_SECRET");
  const now = Math.floor(Date.now() / 1000);
  const state = await verifySignedJson<LoginState>(secret, cookieValue(request, STATE_COOKIE));
  const hasValidState = !!state && state.exp >= now && !!state.nonce;

  try {
    const token = await exchangeCode(env, code);
    const principal = normalizePrincipal(await fetchUserinfo(env, token.access_token), env);
    if (!hasValidState && principal.type !== "agent") throw new Error("human_state_required");
    const ttlSeconds = Math.max(1, Math.min(token.expires_in ?? SESSION_TTL_SECONDS, SESSION_TTL_SECONDS));
    const sealed = await sealSession(env, {
      accessToken: token.access_token,
      principal,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
    const headers = new Headers();
    headers.append("Set-Cookie", clearCookieHeader(request, STATE_COOKIE));
    headers.append("Set-Cookie", cookieHeader(request, SESSION_COOKIE, sealed, ttlSeconds));
    headers.set("Location", hasValidState ? normalizeReturnTo(state.returnTo) : "/");
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.warn("[feature-flag-auth]", error instanceof Error ? error.message : "unknown");
    const response = publicAuthFailure();
    response.headers.append("Set-Cookie", clearCookieHeader(request, STATE_COOKIE));
    response.headers.append("Set-Cookie", clearCookieHeader(request, SESSION_COOKIE));
    return response;
  }
}

function getClient(env: Env): Client | null {
  if (!env.FEATURE_FLAG_PG?.connectionString) return null;
  return new Client({ connectionString: env.FEATURE_FLAG_PG.connectionString });
}

async function operatorDbReadiness(env: Env): Promise<Response> {
  return withOperatorClient(env, "operator-db-readiness", async (client) => {
    await verifyFeatureFlagAdminPrivileges(
      (text, values) => client.query(text, values),
      { requireAuthenticatedUser: true },
    );
    return new Response(null, {
      status: 204,
      headers: { "Cache-Control": "private, no-store" },
    });
  }, {
    unavailable: () => new Response(null, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    }),
    failure: () => new Response(null, {
      status: 503,
      headers: { "Cache-Control": "private, no-store" },
    }),
    errorLabel: "[feature-flag-admin-operator-db-readiness]",
  });
}

function pgRowToFlag(row: Record<string, unknown>): FeatureFlagSummary {
  const key = String(row.key);
  return {
    key,
    description: row.description === null ? null : String(row.description),
    enabled: Boolean(row.enabled),
    killSwitch: Boolean(row.kill_switch),
    randomizationUnit: row.randomization_unit === "user" ? "user" : "server",
    defaultEnabled: Boolean(row.default_enabled),
    defaultVariant: row.default_variant === null ? null : String(row.default_variant),
    ...(row.salt !== undefined ? { salt: String(row.salt) } : {}),
    highRisk: key.includes("inbox") || key.includes("migration") || key.includes("read_receipts"),
    ...(row.created_at !== undefined ? { createdAt: new Date(String(row.created_at)).toISOString() } : {}),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function pgRowToRule(row: Record<string, unknown>): FeatureFlagRule {
  const rawValues = Array.isArray(row.values) ? row.values : [];
  return {
    id: String(row.id),
    stage: row.stage as FeatureFlagRule["stage"],
    priority: Number(row.priority),
    decision: row.decision as FeatureFlagRule["decision"],
    values: rawValues.filter((value): value is string => typeof value === "string"),
    percentageBasisPoints: row.percentage_basis_points === null ? null : Number(row.percentage_basis_points),
    variant: row.variant === null ? null : String(row.variant),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function pgRowToLab(row: Record<string, unknown>): LabDefinition {
  return {
    labKey: String(row.key),
    name: String(row.name),
    description: String(row.description),
    state: row.state as LabDefinition["state"],
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

async function loadLabDefinition(client: Client, key: string): Promise<LabDefinition | null> {
  const result = await client.query(
    "SELECT key, name, description, state, created_at, updated_at FROM lab_definitions WHERE key = $1",
    [key],
  );
  return result.rows[0] ? pgRowToLab(result.rows[0]) : null;
}

async function loadLabDefinitions(client: Client): Promise<LabDefinition[]> {
  const result = await client.query(`
    SELECT key, name, description, state, created_at, updated_at
    FROM lab_definitions
    ORDER BY key ASC
  `);
  return result.rows.map((row) => pgRowToLab(row));
}

async function loadAudienceDefinitions(client: Client, onlyKey?: string): Promise<AudienceDefinition[]> {
  const audienceResult = await client.query(`
    SELECT key, name, description, enabled, created_at, updated_at
    FROM feature_flag_audiences
    WHERE ($1::text IS NULL OR key = $1)
    ORDER BY key ASC
  `, [onlyKey ?? null]);
  const keys = audienceResult.rows.map((row) => String(row.key));
  if (keys.length === 0) return [];
  const memberResult = await client.query(`
    SELECT
      member.id,
      member.audience_key,
      member.kind,
      member.target_id,
      CASE
        WHEN member.kind = 'user' AND app_user.id IS NOT NULL THEN 'active'
        WHEN member.kind = 'server' AND server.id IS NOT NULL AND server.deleted_at IS NULL THEN 'active'
        ELSE 'unknown_or_deleted'
      END AS status,
      CASE
        WHEN member.kind = 'server' AND server.deleted_at IS NULL THEN server.slug
        ELSE NULL
      END AS server_slug
    FROM feature_flag_audience_members AS member
    LEFT JOIN users AS app_user ON member.kind = 'user' AND app_user.id = member.target_id
    LEFT JOIN servers AS server ON member.kind = 'server' AND server.id = member.target_id
    WHERE member.audience_key = ANY($1::text[])
    ORDER BY member.audience_key ASC, member.kind ASC, member.id ASC
  `, [keys]);
  const ruleResult = await client.query(`
    SELECT flag_key, values
    FROM feature_flag_rules
    WHERE stage = 'audience'
  `);
  const affectedByKey = new Map<string, Set<string>>();
  for (const row of ruleResult.rows) {
    const values = Array.isArray(row.values) ? row.values : [];
    for (const value of values) {
      if (typeof value !== "string") continue;
      const affected = affectedByKey.get(value) ?? new Set<string>();
      affected.add(String(row.flag_key));
      affectedByKey.set(value, affected);
    }
  }
  const membersByKey = new Map<string, AudienceMember[]>();
  for (const row of memberResult.rows) {
    const audienceKey = String(row.audience_key);
    const kind = row.kind === "user" ? "user" : "server";
    const status = row.status === "active" ? "active" : "unknown_or_deleted";
    const member: AudienceMember = kind === "user"
      ? { memberId: String(row.id), kind, userId: String(row.target_id), status }
      : {
          memberId: String(row.id),
          kind,
          serverSlug: status === "active" && typeof row.server_slug === "string" ? row.server_slug : null,
          status,
        };
    const members = membersByKey.get(audienceKey) ?? [];
    members.push(member);
    membersByKey.set(audienceKey, members);
  }
  return audienceResult.rows.map((row) => ({
    audienceKey: String(row.key),
    name: String(row.name),
    description: String(row.description),
    enabled: Boolean(row.enabled),
    members: membersByKey.get(String(row.key)) ?? [],
    affectedFlags: [...(affectedByKey.get(String(row.key)) ?? [])].sort(),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }));
}

async function loadAudienceDefinition(client: Client, key: string): Promise<AudienceDefinition | null> {
  return (await loadAudienceDefinitions(client, key))[0] ?? null;
}

async function enabledNonemptyAudienceKeysExist(client: Client, keys: string[]): Promise<boolean> {
  if (keys.length === 0) return false;
  const result = await client.query(`
    SELECT audience.key
    FROM feature_flag_audiences AS audience
    INNER JOIN feature_flag_audience_members AS member ON member.audience_key = audience.key
    WHERE audience.enabled = TRUE AND audience.key = ANY($1::text[])
    GROUP BY audience.key
    ORDER BY audience.key ASC
  `, [keys]);
  return JSON.stringify(result.rows.map((row) => String(row.key))) === JSON.stringify([...new Set(keys)].sort());
}

async function openLabKeysExist(client: Client, labKeys: string[]): Promise<boolean> {
  const result = await client.query(`
    SELECT key
    FROM lab_definitions
    WHERE key = ANY($1::text[]) AND state = 'open'
    ORDER BY key ASC
  `, [labKeys]);
  return JSON.stringify(result.rows.map((row) => String(row.key))) === JSON.stringify(labKeys);
}

function canTransitionLabState(before: LabDefinition["state"], after: LabDefinition["state"]): boolean {
  if (before === after) return true;
  if (before === "retired") return false;
  if (after === "retired") return true;
  if (before === "draft") return after === "open";
  return (before === "open" && after === "paused") || (before === "paused" && after === "open");
}

function isServerAllowlistRule(rule: FeatureFlagRule): boolean {
  return rule.stage === "server"
    && rule.decision === "allow"
    && rule.percentageBasisPoints === null
    && rule.variant === null;
}

function isCanonicalServerAllowlistRule(rule: FeatureFlagRule): boolean {
  return isServerAllowlistRule(rule) && rule.priority === 0;
}

function isCanonicalWebPlatformAllowRule(rule: FeatureFlagRule): boolean {
  return rule.stage === "platform"
    && rule.priority === 0
    && rule.decision === "allow"
    && JSON.stringify(rule.values) === JSON.stringify(["web"])
    && rule.percentageBasisPoints === null
    && rule.variant === null;
}

function deriveServerAllowlist(rules: FeatureFlagRule[]): FeatureFlagDetail["serverAllowlist"] {
  const canonicalRules = rules.filter(isCanonicalServerAllowlistRule);
  const canonical = canonicalRules.length === 1 ? canonicalRules[0] : null;
  return {
    // Other server rules may carry independently managed rollout slices. This
    // operator owns only the canonical priority-0 allow rule and leaves every
    // other shape byte-for-byte untouched.
    managed: canonicalRules.length <= 1,
    ruleId: canonical?.id ?? null,
    serverIds: canonical?.values ?? [],
  };
}

function deriveServerAllowlistRules(rules: FeatureFlagRule[]): FeatureFlagDetail["serverAllowlistRules"] {
  return rules
    .filter(isServerAllowlistRule)
    .map((rule) => ({
      ruleId: rule.id,
      priority: rule.priority,
      serverIds: rule.values,
    }));
}

function unsupportedRuleShapes(rules: FeatureFlagRule[]): string[] {
  return rules
    .filter((rule) => rule.stage === "server")
    .filter((rule) => !isServerAllowlistRule(rule))
    .map((rule) => rule.id);
}

async function loadServerRefs(client: Client, rules: FeatureFlagRule[]): Promise<ServerRef[]> {
  const serverIds = [...new Set(
    rules
      .filter((rule) => rule.stage === "server")
      .flatMap((rule) => rule.values),
  )];
  const queryableIds = serverIds.filter((serverId) => UUID_RE.test(serverId));
  const result = queryableIds.length
    ? await client.query(
      "SELECT id, slug, deleted_at FROM servers WHERE id = ANY($1::uuid[])",
      [queryableIds],
    )
    : { rows: [] };
  const activeSlugs = new Map<string, string>();
  for (const row of result.rows) {
    if (row.deleted_at === null && typeof row.slug === "string") {
      activeSlugs.set(String(row.id).toLowerCase(), row.slug);
    }
  }
  return serverIds.map((serverId) => {
    const serverSlug = activeSlugs.get(serverId.toLowerCase()) ?? null;
    return {
      serverId,
      serverSlug,
      status: serverSlug ? "active" : "unknown_or_deleted",
    };
  });
}

type ServerSlugResolution =
  | { ok: true; serverId: string }
  | {
    ok: false;
    code: "server_slug_unknown" | "server_slug_ambiguous";
    message: string;
    status: 404 | 409;
  };

function serverSlugResolution(rows: Array<Record<string, unknown>>): ServerSlugResolution {
  if (rows.length === 0) {
    return { ok: false, code: "server_slug_unknown", message: "Server slug is unknown or deleted.", status: 404 };
  }
  if (rows.length !== 1) {
    return { ok: false, code: "server_slug_ambiguous", message: "Server slug is ambiguous.", status: 409 };
  }
  const serverId = parseServerId(rows[0]?.server_id);
  if (!serverId) {
    return { ok: false, code: "server_slug_unknown", message: "Server slug is unknown or deleted.", status: 404 };
  }
  return { ok: true, serverId };
}

async function resolveActiveServerSlug(
  client: Client,
  serverSlug: string,
): Promise<ServerSlugResolution> {
  const result = await client.query(`
    SELECT id AS server_id
    FROM servers
    WHERE slug = $1 AND deleted_at IS NULL
    ORDER BY id ASC
    LIMIT 2
  `, [serverSlug]);
  return serverSlugResolution(result.rows);
}

async function resolveActiveServerSlugs(
  client: Client,
  serverSlugs: string[],
): Promise<Extract<ServerSlugResolution, { ok: false }> | { ok: true; serverIds: string[] }> {
  const serverIds: string[] = [];
  for (const serverSlug of serverSlugs) {
    const resolved = await resolveActiveServerSlug(client, serverSlug);
    if (!resolved.ok) return resolved;
    serverIds.push(resolved.serverId);
  }
  return { ok: true, serverIds: [...new Set(serverIds)].sort() };
}

async function listActiveServerSlugs(client: Client, query: string): Promise<string[]> {
  const result = await client.query(`
    SELECT slug
    FROM servers
    WHERE deleted_at IS NULL
      AND slug IS NOT NULL
      AND slug ~ '^[a-z][a-z0-9-]{4,}$'
      AND ($1::text = '' OR strpos(slug, $1::text) > 0)
    GROUP BY slug
    HAVING COUNT(*) = 1
    ORDER BY
      CASE
        WHEN slug = $1::text THEN 0
        WHEN slug LIKE ($1::text || '%') THEN 1
        ELSE 2
      END,
      slug ASC
    LIMIT $2
  `, [query, SERVER_CATALOG_RESULT_LIMIT]);
  return result.rows
    .map((row) => typeof row.slug === "string" ? row.slug : null)
    .filter((slug): slug is string => slug !== null);
}

function scopedServerAllowlistMutationIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail,
  targetRuleId: string | null,
  nextServerIds: string[],
): boolean {
  const untouchedBefore = before.rules.filter((rule) => rule.id !== targetRuleId);
  const untouchedAfter = after.rules.filter((rule) => rule.id !== targetRuleId);
  if (JSON.stringify(untouchedAfter) !== JSON.stringify(untouchedBefore)) return false;

  if (!targetRuleId) return false;
  const beforeTarget = before.rules.find((rule) => rule.id === targetRuleId);
  const target = after.rules.find((rule) => rule.id === targetRuleId);
  return !!beforeTarget
    && !!target
    && isServerAllowlistRule(beforeTarget)
    && isServerAllowlistRule(target)
    && target.id === beforeTarget.id
    && target.priority === beforeTarget.priority
    && target.createdAt === beforeTarget.createdAt
    && JSON.stringify(target.values) === JSON.stringify(nextServerIds);
}

async function getConfigVersion(client: Client): Promise<number> {
  const result = await client.query(
    "SELECT version FROM feature_flag_config_versions WHERE scope = $1",
    [FEATURE_FLAG_CONFIG_SCOPE_GLOBAL],
  );
  return Number(result.rows[0]?.version ?? 0);
}

async function featureFlagLockKey(flagKey: string): Promise<number> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(flagKey));
  return new DataView(digest).getInt32(0, false);
}

async function lockOperatorWrites(client: Client, flagKey?: string): Promise<void> {
  // The CAS cursor is global, so every writer must share one serialization
  // point. Per-flag or per-Lab locks would allow two different targets to both
  // accept the same expectedConfigVersion before either version bump commits.
  await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
    FEATURE_FLAG_CONFIG_VERSION_LOCK_NAMESPACE,
    FEATURE_FLAG_CONFIG_VERSION_LOCK_KEY,
  ]);
  if (flagKey) {
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [
      FEATURE_FLAG_LOCK_NAMESPACE,
      await featureFlagLockKey(flagKey),
    ]);
  }
}

async function bumpConfigVersion(client: Client, actor: string, auditEventId: string): Promise<number> {
  const result = await client.query(`
    INSERT INTO feature_flag_config_versions (scope, version, updated_at, updated_by, last_audit_event_id)
    VALUES ($1, 1, NOW(), $2, $3)
    ON CONFLICT (scope) DO UPDATE SET
      version = feature_flag_config_versions.version + 1,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by,
      last_audit_event_id = EXCLUDED.last_audit_event_id
    RETURNING version
  `, [FEATURE_FLAG_CONFIG_SCOPE_GLOBAL, actor, auditEventId]);
  return Number(result.rows[0]?.version ?? 0);
}

async function loadFeatureFlagDetail(client: Client, key: string): Promise<FeatureFlagDetail | null> {
  const flagResult = await client.query("SELECT * FROM feature_flags WHERE key = $1", [key]);
  if (!flagResult.rows[0]) return null;
  const ruleResult = await client.query(`
    SELECT id, stage, priority, decision, values, percentage_basis_points, variant, created_at, updated_at
    FROM feature_flag_rules
    WHERE flag_key = $1
    ORDER BY stage ASC, priority ASC, created_at ASC, id ASC
  `, [key]);
  const rules = ruleResult.rows.map((row) => pgRowToRule(row));
  return {
    flag: pgRowToFlag(flagResult.rows[0]),
    rules,
    serverAllowlist: deriveServerAllowlist(rules),
    serverAllowlistRules: deriveServerAllowlistRules(rules),
    unsupportedRuleShapes: unsupportedRuleShapes(rules),
  };
}

async function toPublicFeatureFlagDetail(client: Client, detail: FeatureFlagDetail): Promise<PublicFeatureFlagDetail> {
  const refs = await loadServerRefs(client, detail.rules);
  const refsById = new Map(refs.map((ref) => [ref.serverId, ref]));
  const serverTarget = (serverId: string): PublicServerTarget => {
    const ref = refsById.get(serverId);
    return ref?.status === "active" && ref.serverSlug
      ? { serverSlug: ref.serverSlug, status: "active" }
      : { serverSlug: null, status: "unknown_or_deleted" };
  };
  const publicRule = (rule: FeatureFlagRule): PublicFeatureFlagRule => {
    const { values, ...base } = rule;
    return rule.stage === "server"
      ? { ...base, serverTargets: values.map(serverTarget) }
      : { ...base, values };
  };
  return {
    flag: detail.flag,
    rules: detail.rules.map(publicRule),
    serverAllowlist: {
      managed: detail.serverAllowlist.managed,
      ruleId: detail.serverAllowlist.ruleId,
      serverTargets: detail.serverAllowlist.serverIds.map(serverTarget),
    },
    serverAllowlistRules: detail.serverAllowlistRules.map((rule) => ({
      ruleId: rule.ruleId,
      priority: rule.priority,
      serverTargets: rule.serverIds.map(serverTarget),
    })),
    unsupportedRuleShapes: detail.unsupportedRuleShapes,
  };
}

async function withReadOnlySnapshot<T>(client: Client, operation: () => Promise<T>): Promise<T> {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    const result = await operation();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function beginOperatorMutationSnapshot(client: Client, flagKey?: string): Promise<void> {
  // Hyperdrive may return a PostgreSQL backend to its pool when a Worker-side
  // client ends. Session advisory locks therefore are not request-scoped and
  // can poison every later writer. Begin a READ COMMITTED transaction first,
  // then acquire the same transaction-scoped global/per-flag locks used by the
  // canonical Server writer. Waiting does not freeze later statement snapshots,
  // while the locks prevent relevant writers from changing the rows used for
  // validation, audit, mutation, and readback until COMMIT/ROLLBACK.
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await lockOperatorWrites(client, flagKey);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function writeAuditEvent(env: Env, event: Record<string, unknown>): Promise<void> {
  if (!env.FEATURE_FLAG_AUDIT_DB) throw new Error("audit_db_missing");
  await env.FEATURE_FLAG_AUDIT_DB.prepare(`
    INSERT INTO feature_flag_audit_events (
      id, request_id, actor_kind, actor_id, actor_name, operation, flag_key,
      target_kind, target_id, reason, before_json, after_json,
      pg_config_version, slock_echo_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    event.id,
    event.requestId,
    event.actorKind,
    event.actorId,
    event.actorName,
    event.operation,
    event.flagKey,
    event.targetKind,
    event.targetId,
    event.reason,
    JSON.stringify(event.before ?? null),
    JSON.stringify(event.after ?? null),
    event.pgConfigVersion ?? null,
    "not_attempted",
    event.createdAt,
  ).run();
}

async function finalizeAuditEvent(env: Env, id: string, pgConfigVersion: number, after: unknown): Promise<void> {
  if (!env.FEATURE_FLAG_AUDIT_DB) throw new Error("audit_db_missing");
  await env.FEATURE_FLAG_AUDIT_DB.prepare(`
    UPDATE feature_flag_audit_events
    SET pg_config_version = ?, after_json = ?, slock_echo_status = ?
    WHERE id = ?
  `).bind(pgConfigVersion, JSON.stringify(after ?? null), "not_attempted", id).run();
}

function ruleForValue(
  rules: FeatureFlagRule[],
  stage: FeatureFlagRule["stage"],
  value: string | undefined,
): FeatureFlagRule | null {
  if (!value) return null;
  return rules.find((rule) => rule.stage === stage && rule.values.includes(value)) ?? null;
}

function previewFromRule(
  key: string,
  rule: FeatureFlagRule,
  reason: FeatureFlagPreviewReason,
): FeatureFlagPreview {
  return { key, enabled: rule.decision === "allow", reason };
}

async function featureFlagBucket(input: {
  key: string;
  salt: string;
  unit: "user" | "server";
  unitId: string;
}): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${input.salt}:${input.key}:${input.unit}:${input.unitId}`),
  ));
  return (((digest[0] ?? 0) * 0x1000000)
    + ((digest[1] ?? 0) * 0x10000)
    + ((digest[2] ?? 0) * 0x100)
    + (digest[3] ?? 0)) % 10_000;
}

async function effectiveLabKeys(
  client: Client,
  serverId: string,
  rules: FeatureFlagRule[],
): Promise<Set<string>> {
  const labKeys = [...new Set(
    rules.filter((rule) => rule.stage === "lab").flatMap((rule) => rule.values),
  )];
  if (labKeys.length === 0) return new Set();
  try {
    const result = await client.query(`
      SELECT enrollment.lab_key
      FROM server_lab_enrollments AS enrollment
      INNER JOIN server_lab_access AS access
        ON access.server_id = enrollment.server_id AND access.enabled = TRUE
      INNER JOIN lab_definitions AS definition
        ON definition.key = enrollment.lab_key AND definition.state = 'open'
      WHERE enrollment.server_id = $1
        AND enrollment.enabled = TRUE
        AND enrollment.lab_key = ANY($2::text[])
    `, [serverId, labKeys]);
    return new Set(result.rows.map((row) => String(row.lab_key)));
  } catch (error) {
    console.warn("[feature-flag-lab-preview] treating unavailable Lab cohort data as no-match", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return new Set();
  }
}

async function matchingAudienceKeys(
  client: Client,
  rules: FeatureFlagRule[],
  userId?: string,
  serverId?: string,
): Promise<Set<string>> {
  const audienceKeys = [...new Set(
    rules.filter((rule) => rule.stage === "audience").flatMap((rule) => rule.values),
  )];
  if (audienceKeys.length === 0 || (!userId && !serverId)) return new Set();
  const result = await client.query(`
    SELECT DISTINCT member.audience_key
    FROM feature_flag_audience_members AS member
    INNER JOIN feature_flag_audiences AS audience
      ON audience.key = member.audience_key AND audience.enabled = TRUE
    WHERE member.audience_key = ANY($1::text[])
      AND ((member.kind = 'user' AND member.target_id = $2::uuid)
        OR (member.kind = 'server' AND member.target_id = $3::uuid))
  `, [audienceKeys, userId ?? null, serverId ?? null]);
  return new Set(result.rows.map((row) => String(row.audience_key)));
}

async function effectiveServerPlan(client: Client, serverId: string): Promise<string> {
  const result = await client.query(`
    SELECT
      server.plan AS server_plan,
      subscription.plan AS subscription_plan,
      subscription.status AS subscription_status
    FROM servers AS server
    LEFT JOIN subscriptions AS subscription ON subscription.server_id = server.id
    WHERE server.id = $1 AND server.deleted_at IS NULL
    LIMIT 1
  `, [serverId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) return "free";
  const serverPlan = typeof row.server_plan === "string" ? row.server_plan : "free";
  if (serverPlan === "founder" || serverPlan === "partner") return serverPlan;
  if (row.subscription_plan === "pro") {
    return row.subscription_status === "active" || row.subscription_status === "past_due"
      ? "pro"
      : "free";
  }
  return serverPlan;
}

async function evaluateFeatureFlagPreview(input: {
  client: Client;
  key: string;
  userId?: string;
  serverId?: string;
  platform?: "web" | "mobile";
}): Promise<FeatureFlagPreview> {
  const { client, key, userId, serverId, platform } = input;
  const flagResult = await client.query(`
    SELECT key, enabled, kill_switch, randomization_unit, default_enabled, default_variant, salt
    FROM feature_flags
    WHERE key = $1
  `, [key]);
  const flag = flagResult.rows[0] as Record<string, unknown> | undefined;
  if (!flag) return { key, enabled: false, reason: "missing_flag" };
  if (flag.kill_switch === true) return { key, enabled: false, reason: "kill_switch" };
  if (flag.enabled !== true) return { key, enabled: false, reason: "flag_disabled" };

  const ruleResult = await client.query(`
    SELECT id, stage, priority, decision, values, percentage_basis_points, variant, created_at, updated_at
    FROM feature_flag_rules
    WHERE flag_key = $1
    ORDER BY priority ASC, created_at ASC, id ASC
  `, [key]);
  const rules = ruleResult.rows.map((row) => pgRowToRule(row));

  const userRule = ruleForValue(rules, "user", userId);
  if (userRule) return previewFromRule(key, userRule, "user_rule");
  const platformRule = ruleForValue(rules, "platform", platform);
  if (platformRule) return previewFromRule(key, platformRule, "platform_rule");
  const serverRule = ruleForValue(rules, "server", serverId);
  if (serverRule) return previewFromRule(key, serverRule, "server_rule");

  const audiences = await matchingAudienceKeys(client, rules, userId, serverId);
  const audienceRule = rules.find((rule) => (
    rule.stage === "audience" && rule.values.some((audienceKey) => audiences.has(audienceKey))
  ));
  if (audienceRule) return previewFromRule(key, audienceRule, "audience_rule");

  if (serverId) {
    const labs = await effectiveLabKeys(client, serverId, rules);
    const labRule = rules.find((rule) => (
      rule.stage === "lab" && rule.values.some((labKey) => labs.has(labKey))
    ));
    if (labRule) return previewFromRule(key, labRule, "lab_rule");

    if (rules.some((rule) => rule.stage === "plan")) {
      const planRule = ruleForValue(rules, "plan", await effectiveServerPlan(client, serverId));
      if (planRule) return previewFromRule(key, planRule, "plan_rule");
    }
  }

  const randomizationUnit = flag.randomization_unit === "user" ? "user" : "server";
  const unitId = randomizationUnit === "user" ? userId : serverId;
  if (!unitId) {
    return {
      key,
      enabled: false,
      reason: randomizationUnit === "user" ? "missing_user_unit" : "missing_server_unit",
    };
  }
  const bucket = await featureFlagBucket({
    key,
    salt: String(flag.salt),
    unit: randomizationUnit,
    unitId,
  });
  const percentageRule = rules.find((rule) => (
    rule.stage === "percentage"
    && rule.percentageBasisPoints !== null
    && bucket < rule.percentageBasisPoints
  ));
  if (percentageRule) return previewFromRule(key, percentageRule, "percentage_rule");
  return { key, enabled: flag.default_enabled === true, reason: "default" };
}

async function handleOperatorApi(request: Request, env: Env, session: FeatureFlagSession): Promise<Response> {
  const id = requestId();
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/operator\/?/, "");

  const unauthorized = await requireOperator(session, env, id);
  if (unauthorized) return unauthorized;

  const accessGrantResponse = await handleAccessGrantApi(request, env, session, id);
  if (accessGrantResponse) return accessGrantResponse;

  if (request.method === "GET" && path === "servers") {
    const query = parseServerCatalogQuery(url.searchParams.get("query"));
    if (query === null) {
      return fail(
        "invalid_server_slug",
        `query must contain only lowercase server-slug characters and be at most ${SERVER_CATALOG_QUERY_MAX_LENGTH} characters.`,
        400,
        id,
      );
    }
    return withOperatorClient(env, id, async (client) => {
      return withReadOnlySnapshot(client, async () => {
        const serverSlugs = await listActiveServerSlugs(client, query);
        return authorizationOk({ servers: serverSlugs.map((serverSlug) => ({ serverSlug })) }, id);
      });
    });
  }

  if (request.method === "GET" && path === "audiences") {
    return withOperatorClient(env, id, async (client) => {
      return withReadOnlySnapshot(client, async () => (
        ok({ audiences: await loadAudienceDefinitions(client) }, await getConfigVersion(client), id)
      ));
    });
  }

  if (request.method === "POST" && path === "audiences") {
    const body = await requestBody(request);
    const key = parseAudienceKey(body.audienceKey);
    const name = parseNonemptyText(body.name, 200);
    const description = typeof body.description === "string" && body.description.trim().length <= 2_000
      ? body.description.trim()
      : null;
    const enabled = body.enabled === undefined ? false : parseOptionalBoolean(body.enabled);
    const userIds = body.userIds === undefined ? [] : parseUuidArray(body.userIds);
    const serverSlugs = body.serverSlugs === undefined ? [] : parseServerSlugsAllowEmpty(body.serverSlugs);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!key) return fail("invalid_audience_key", "Invalid audience key.", 400, id);
    if (!name || description === null || enabled === undefined || !userIds || !serverSlugs
      || !reason || expectedConfigVersion === null) {
      return fail("invalid_request", "audienceKey, name, member arrays, reason, and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => createAudienceDefinition({
      env, session, client, requestId: id, key, name, description, enabled,
      userIds, serverSlugs, reason, expectedConfigVersion,
    }));
  }

  const audienceMatch = path.match(/^audiences\/([^/]+)$/);
  if (request.method === "PATCH" && audienceMatch) {
    const key = parseAudienceKey(decodeURIComponent(audienceMatch[1] ?? ""));
    const body = await requestBody(request);
    const name = parseNonemptyText(body.name, 200);
    const description = typeof body.description === "string" && body.description.trim().length <= 2_000
      ? body.description.trim()
      : null;
    const enabled = parseOptionalBoolean(body.enabled);
    const userIds = parseUuidArray(body.userIds);
    const serverSlugs = parseServerSlugsAllowEmpty(body.serverSlugs);
    const retainedMemberIds = parseUuidArray(body.retainedMemberIds);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!key) return fail("invalid_audience_key", "Invalid audience key.", 400, id);
    if (!name || description === null || enabled === undefined || !userIds || !serverSlugs
      || !retainedMemberIds || !reason || expectedConfigVersion === null) {
      return fail("invalid_request", "A full audience replacement, reason, and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => updateAudienceDefinition({
      env, session, client, requestId: id, key, name, description, enabled,
      userIds, serverSlugs, retainedMemberIds, reason, expectedConfigVersion,
    }));
  }

  const previewMatch = path.match(/^feature-flags\/([^/]+)\/evaluate-preview$/);
  if (request.method === "POST" && previewMatch) {
    const key = parseFlagKey(decodeURIComponent(previewMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    if (Object.hasOwn(body, "serverId")) {
      return fail("invalid_server_slug", "serverId is not accepted; use serverSlug.", 400, id);
    }
    const hasServerSlug = body.serverSlug !== null
      && body.serverSlug !== undefined
      && body.serverSlug !== "";
    const serverSlug = hasServerSlug ? parseServerSlug(body.serverSlug) : null;
    const userId = body.userId === undefined ? undefined : parseServerId(body.userId) ?? undefined;
    const platform = body.platform === "web" || body.platform === "mobile" ? body.platform : undefined;
    if (hasServerSlug && !serverSlug) {
      return fail("invalid_server_slug", "serverSlug must be a non-empty server slug.", 400, id);
    }
    if (body.userId !== undefined && !userId) {
      return fail("invalid_request", "userId must be a valid UUID.", 400, id);
    }
    if (body.platform !== undefined && !platform) {
      return fail("invalid_request", "platform must be web or mobile.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => {
      return withReadOnlySnapshot(client, async () => {
        let serverId: string | undefined;
        if (serverSlug) {
          const resolved = await resolveActiveServerSlug(client, serverSlug);
          if (!resolved.ok) return fail(resolved.code, resolved.message, resolved.status, id);
          serverId = resolved.serverId;
        }
        const evaluation = await evaluateFeatureFlagPreview({ client, key, userId, serverId, platform });
        return ok({ evaluation }, await getConfigVersion(client), id);
      });
    });
  }

  if (request.method === "GET" && path === "labs") {
    return withOperatorClient(env, id, async (client) => {
      return ok({ labs: await loadLabDefinitions(client) }, await getConfigVersion(client), id);
    });
  }

  if (request.method === "POST" && path === "labs") {
    const body = await requestBody(request);
    const key = parseLabKey(body.labKey);
    const name = parseNonemptyText(body.name, 200);
    const description = parseNonemptyText(body.description, 2_000);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!key) return fail("invalid_lab_key", "Invalid Lab key.", 400, id);
    if (!name || !description || !reason || expectedConfigVersion === null) {
      return fail("invalid_request", "labKey, name, description, reason, and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => {
      return createLabDefinition({ env, session, client, requestId: id, key, name, description, reason, expectedConfigVersion });
    });
  }

  const labMatch = path.match(/^labs\/([^/]+)$/);
  const labStateMatch = path.match(/^labs\/([^/]+)\/state$/);
  if ((request.method === "PATCH" && labMatch) || (request.method === "POST" && labStateMatch)) {
    const matchedLabKey = labMatch?.[1] ?? labStateMatch?.[1] ?? "";
    const key = parseLabKey(decodeURIComponent(matchedLabKey));
    if (!key) return fail("invalid_lab_key", "Invalid Lab key.", 400, id);
    const body = await requestBody(request);
    const stateOnly = request.method === "POST";
    const hasName = !stateOnly && Object.hasOwn(body, "name");
    const hasDescription = !stateOnly && Object.hasOwn(body, "description");
    const hasState = Object.hasOwn(body, "state");
    const name = hasName ? parseNonemptyText(body.name, 200) : undefined;
    const description = hasDescription ? parseNonemptyText(body.description, 2_000) : undefined;
    const state = hasState ? parseLabState(body.state) : undefined;
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if ((hasName && !name) || (hasDescription && !description) || (hasState && !state)) {
      return fail(hasState && !state ? "invalid_lab_state" : "invalid_request", "Invalid Lab update.", 400, id);
    }
    if ((!hasName && !hasDescription && !hasState) || !reason || expectedConfigVersion === null) {
      return fail("invalid_request", "At least one Lab field, reason, and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => {
      return updateLabDefinition({
        env,
        session,
        client,
        requestId: id,
        key,
        name: name ?? undefined,
        description: description ?? undefined,
        state: state ?? undefined,
        reason,
        expectedConfigVersion,
      });
    });
  }

  const labRulesMatch = path.match(/^feature-flags\/([^/]+)\/lab-rules$/);
  if (request.method === "POST" && labRulesMatch) {
    const key = parseFlagKey(decodeURIComponent(labRulesMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    const labKeys = parseLabKeys(body.labKeys);
    const decision = parseDecision(body.decision);
    const priority = parsePriority(body.priority);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!labKeys || !decision || priority === null || !reason || expectedConfigVersion === null) {
      return fail("invalid_request", "labKeys, decision, priority, reason, and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => {
      return mutateLabRule({ env, session, client, requestId: id, key, labKeys, decision, priority, reason, expectedConfigVersion, operation: "lab_rule_create" });
    });
  }

  const labRuleMatch = path.match(/^feature-flags\/([^/]+)\/lab-rules\/([^/]+)$/);
  if ((request.method === "PATCH" || request.method === "DELETE") && labRuleMatch) {
    const key = parseFlagKey(decodeURIComponent(labRuleMatch[1] ?? ""));
    const ruleId = parseRuleId(decodeURIComponent(labRuleMatch[2] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    if (!ruleId) return fail("invalid_rule_id", "Invalid rule id.", 400, id);
    const body = await requestBody(request);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!reason || expectedConfigVersion === null) {
      return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    }
    if (request.method === "DELETE") {
      return withOperatorClient(env, id, async (client) => {
        return mutateLabRule({ env, session, client, requestId: id, key, ruleId, reason, expectedConfigVersion, operation: "lab_rule_delete" });
      });
    }
    const hasLabKeys = Object.hasOwn(body, "labKeys");
    const hasDecision = Object.hasOwn(body, "decision");
    const hasPriority = Object.hasOwn(body, "priority");
    const labKeys = hasLabKeys ? parseLabKeys(body.labKeys) : undefined;
    const decision = hasDecision ? parseDecision(body.decision) : undefined;
    const priority = hasPriority ? parsePriority(body.priority) : undefined;
    if ((!hasLabKeys && !hasDecision && !hasPriority)
      || (hasLabKeys && !labKeys)
      || (hasDecision && !decision)
      || (hasPriority && priority === null)) {
      return fail("invalid_request", "At least one valid lab-rule field is required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => {
      return mutateLabRule({
        env,
        session,
        client,
        requestId: id,
        key,
        ruleId,
        labKeys: labKeys ?? undefined,
        decision: decision ?? undefined,
        priority: priority ?? undefined,
        reason,
        expectedConfigVersion,
        operation: "lab_rule_update",
      });
    });
  }

  if (request.method === "GET" && path === "feature-flags") {
    return withOperatorClient(env, id, async (client) => {
      const result = await client.query(`
        SELECT key, description, enabled, kill_switch, randomization_unit, default_enabled,
               default_variant, salt, created_at, updated_at
        FROM feature_flags
        ORDER BY key ASC
      `);
      return ok({ flags: result.rows.map((row) => pgRowToFlag(row)) }, await getConfigVersion(client), id);
    });
  }

  const detailMatch = path.match(/^feature-flags\/([^/]+)$/);
  if (request.method === "POST" && path === "feature-flags") {
    const body = await requestBody(request);
    const key = parseFlagKey(typeof body.key === "string" ? body.key : null);
    const randomizationUnit = parseRandomizationUnit(body.randomizationUnit);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!key || !randomizationUnit) {
      return fail("invalid_request", "key and randomizationUnit are required.", 400, id);
    }
    if (!reason || expectedConfigVersion === null) {
      return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    }
    const description = parseOptionalString(body.description);
    const defaultVariant = parseOptionalString(body.defaultVariant);
    const salt = parseOptionalString(body.salt);
    return withOperatorClient(env, id, async (client) => createGenericFeatureFlag({
      env,
      session,
      client,
      requestId: id,
      key,
      randomizationUnit,
      description: description ?? null,
      enabled: parseOptionalBoolean(body.enabled) ?? true,
      killSwitch: parseOptionalBoolean(body.killSwitch) ?? false,
      defaultEnabled: parseOptionalBoolean(body.defaultEnabled) ?? false,
      defaultVariant: defaultVariant ?? null,
      salt: salt ?? crypto.randomUUID(),
      reason,
      expectedConfigVersion,
    }));
  }

  if (request.method === "GET" && detailMatch) {
    const key = parseFlagKey(decodeURIComponent(detailMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    return withOperatorClient(env, id, async (client) => {
      return withReadOnlySnapshot(client, async () => {
        const detail = await loadFeatureFlagDetail(client, key);
        if (!detail) return fail("flag_not_found", "Feature flag not found.", 404, id);
        return ok(await toPublicFeatureFlagDetail(client, detail), await getConfigVersion(client), id);
      });
    });
  }

  if ((request.method === "PATCH" || request.method === "DELETE") && detailMatch) {
    const key = parseFlagKey(decodeURIComponent(detailMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!reason || expectedConfigVersion === null) {
      return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    }
    if (request.method === "DELETE") {
      return withOperatorClient(env, id, async (client) => deleteGenericFeatureFlag({
        env, session, client, requestId: id, key, reason, expectedConfigVersion,
      }));
    }
    const patch: GenericFeatureFlagPatch = {};
    const description = parseOptionalString(body.description);
    const defaultVariant = parseOptionalString(body.defaultVariant);
    const salt = parseOptionalString(body.salt);
    const enabled = parseOptionalBoolean(body.enabled);
    const killSwitch = parseOptionalBoolean(body.killSwitch);
    const defaultEnabled = parseOptionalBoolean(body.defaultEnabled);
    if (description !== undefined) patch.description = description;
    if (defaultVariant !== undefined) patch.defaultVariant = defaultVariant;
    // The legacy route intentionally treated both null and undefined as a
    // no-op for this NOT NULL column. Only a non-empty string updates salt.
    if (salt !== undefined && salt !== null) patch.salt = salt;
    if (enabled !== undefined) patch.enabled = enabled;
    if (killSwitch !== undefined) patch.killSwitch = killSwitch;
    if (defaultEnabled !== undefined) patch.defaultEnabled = defaultEnabled;
    if (body.randomizationUnit !== undefined) {
      const randomizationUnit = parseRandomizationUnit(body.randomizationUnit);
      if (!randomizationUnit) {
        return fail("invalid_request", "randomizationUnit must be user or server.", 400, id);
      }
      patch.randomizationUnit = randomizationUnit;
    }
    return withOperatorClient(env, id, async (client) => updateGenericFeatureFlag({
      env, session, client, requestId: id, key, patch, reason, expectedConfigVersion,
    }));
  }

  const killSwitchMatch = path.match(/^feature-flags\/([^/]+)\/kill-switch$/);
  if (request.method === "POST" && killSwitchMatch) {
    const key = parseFlagKey(decodeURIComponent(killSwitchMatch[1] ?? ""));
    const body = await requestBody(request);
    const killSwitch = parseOptionalBoolean(body.killSwitch);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!key || killSwitch === undefined) {
      return fail("invalid_request", "key and boolean killSwitch are required.", 400, id);
    }
    if (!reason || expectedConfigVersion === null) {
      return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => updateGenericFeatureFlag({
      env,
      session,
      client,
      requestId: id,
      key,
      patch: { killSwitch },
      reason,
      expectedConfigVersion,
      operation: "feature_flag_kill_switch_update",
      failureMessage: "Failed to update feature flag kill switch.",
    }));
  }

  const rulesMatch = path.match(/^feature-flags\/([^/]+)\/rules$/);
  if (request.method === "POST" && rulesMatch) {
    const key = parseFlagKey(decodeURIComponent(rulesMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    const stage = parseRuleStage(body.stage);
    const decision = parseDecision(body.decision);
    if (stage === "server" && Object.hasOwn(body, "values")) {
      return fail("invalid_server_slug", "Server rules do not accept values; use serverSlugs.", 400, id);
    }
    if (stage !== "server" && Object.hasOwn(body, "serverSlugs")) {
      return fail("invalid_request", "serverSlugs is only valid for server rules.", 400, id);
    }
    const serverSlugs = stage === "server" ? parseServerSlugs(body.serverSlugs) : undefined;
    const values = stage === "server" ? [] : body.values === undefined ? [] : parseStringArray(body.values);
    const priority = body.priority === undefined ? 0 : parseInteger(body.priority);
    const percentageBasisPoints = body.percentageBasisPoints === undefined || body.percentageBasisPoints === null
      ? null
      : parseInteger(body.percentageBasisPoints);
    const variant = parseOptionalString(body.variant);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (
      !stage
      || !decision
      || values === undefined
      || (stage === "server" && !serverSlugs)
      || priority === undefined
      || (stage === "percentage" && percentageBasisPoints === undefined)
    ) {
      return fail("invalid_request", "Invalid feature flag rule.", 400, id);
    }
    if (!reason || expectedConfigVersion === null) {
      return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    }
    const rawRule: GenericFeatureFlagRuleInput = {
      stage,
      decision,
      values,
      priority,
      percentageBasisPoints: stage === "percentage" ? (percentageBasisPoints ?? null) : null,
      variant: variant ?? null,
    };
    const ruleError = genericRuleValidationError(key, rawRule);
    if (ruleError) return fail("invalid_request", ruleError, 400, id);
    const rule = normalizeGenericRule(rawRule);
    return withOperatorClient(env, id, async (client) => createGenericFeatureFlagRule({
      env, session, client, requestId: id, key, rule, serverSlugs: serverSlugs ?? undefined, reason, expectedConfigVersion,
    }));
  }

  const ruleMatch = path.match(/^feature-flags\/([^/]+)\/rules\/([^/]+)$/);
  if ((request.method === "PATCH" || request.method === "DELETE") && ruleMatch) {
    const key = parseFlagKey(decodeURIComponent(ruleMatch[1] ?? ""));
    const ruleId = parseRuleId(decodeURIComponent(ruleMatch[2] ?? ""));
    if (!key || !ruleId) {
      return fail("invalid_request", "Invalid feature flag rule identifier.", 400, id);
    }
    const body = await requestBody(request);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!reason || expectedConfigVersion === null) {
      return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    }
    if (request.method === "DELETE") {
      return withOperatorClient(env, id, async (client) => deleteGenericFeatureFlagRule({
        env, session, client, requestId: id, key, ruleId, reason, expectedConfigVersion,
      }));
    }
    const patch: GenericFeatureFlagRulePatch = {};
    const rawValuesProvided = Object.hasOwn(body, "values");
    const serverSlugsProvided = Object.hasOwn(body, "serverSlugs");
    if (rawValuesProvided && serverSlugsProvided) {
      return fail("invalid_request", "Provide values or serverSlugs, not both.", 400, id);
    }
    const serverSlugs = serverSlugsProvided ? parseServerSlugs(body.serverSlugs) : undefined;
    if (serverSlugsProvided && !serverSlugs) {
      return fail("invalid_server_slug", "serverSlugs must be a non-empty array of server slugs.", 400, id);
    }
    if (body.stage !== undefined) {
      const stage = parseRuleStage(body.stage);
      if (!stage) return fail("invalid_request", "stage must be user, platform, server, audience, lab, plan, or percentage.", 400, id);
      patch.stage = stage;
    }
    if (body.decision !== undefined) {
      const decision = parseDecision(body.decision);
      if (!decision) return fail("invalid_request", "decision must be allow or deny.", 400, id);
      patch.decision = decision;
    }
    if (body.values !== undefined) {
      const values = parseStringArray(body.values);
      if (!values) return fail("invalid_request", "values must be an array of strings.", 400, id);
      patch.values = values;
    }
    if (body.priority !== undefined) {
      const priority = parseInteger(body.priority);
      if (priority === undefined) return fail("invalid_request", "priority must be an integer.", 400, id);
      patch.priority = priority;
    }
    if (body.percentageBasisPoints !== undefined) {
      if (body.percentageBasisPoints === null) {
        patch.percentageBasisPoints = null;
      } else {
        const percentageBasisPoints = parseInteger(body.percentageBasisPoints);
        if (percentageBasisPoints === undefined || percentageBasisPoints < 0 || percentageBasisPoints > 10_000) {
          return fail("invalid_request", "percentageBasisPoints must be 0-10000.", 400, id);
        }
        patch.percentageBasisPoints = percentageBasisPoints;
      }
    }
    if (body.variant !== undefined) {
      const variant = parseOptionalString(body.variant);
      if (variant !== undefined) patch.variant = variant;
    }
    return withOperatorClient(env, id, async (client) => updateGenericFeatureFlagRule({
      env,
      session,
      client,
      requestId: id,
      key,
      ruleId,
      patch,
      serverSlugs: serverSlugs ?? undefined,
      rawValuesProvided,
      serverSlugsProvided,
      reason,
      expectedConfigVersion,
    }));
  }

  const defaultEnabledMatch = path.match(/^feature-flags\/([^/]+)\/default-enabled$/);
  if (request.method === "POST" && defaultEnabledMatch) {
    const key = parseFlagKey(decodeURIComponent(defaultEnabledMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    const defaultEnabled = typeof body.defaultEnabled === "boolean" ? body.defaultEnabled : null;
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (defaultEnabled === null || !reason || expectedConfigVersion === null) {
      return fail("invalid_request", "defaultEnabled, reason, and expectedConfigVersion are required.", 400, id);
    }
    return withOperatorClient(env, id, async (client) => {
      return mutateDefaultEnabled({ env, session, client, requestId: id, key, defaultEnabled, reason, expectedConfigVersion });
    });
  }

  const addMatch = path.match(/^feature-flags\/([^/]+)\/server-allowlist$/);
  if (request.method === "POST" && addMatch) {
    const key = parseFlagKey(decodeURIComponent(addMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    if (Object.hasOwn(body, "serverId")) {
      return fail("invalid_server_slug", "serverId is not accepted; use serverSlug.", 400, id);
    }
    const serverSlug = parseServerSlug(body.serverSlug);
    const targetRuleId = parseRuleId(body.targetRuleId);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!serverSlug) return fail("invalid_server_slug", "serverSlug must be a non-empty server slug.", 400, id);
    if (!targetRuleId) return fail("invalid_rule_id", "targetRuleId must be a valid UUID.", 400, id);
    if (!reason || expectedConfigVersion === null) return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    return withOperatorClient(env, id, async (client) => {
      return mutateServerAllowlist({ request, env, session, client, requestId: id, key, targetRuleId, serverSlug, reason, expectedConfigVersion, operation: "server_allowlist_add" });
    });
  }

  const createFirstServerRuleMatch = path.match(/^feature-flags\/([^/]+)\/server-allowlist\/rules$/);
  if (request.method === "POST" && createFirstServerRuleMatch) {
    const key = parseFlagKey(decodeURIComponent(createFirstServerRuleMatch[1] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    const body = await requestBody(request);
    if (Object.hasOwn(body, "serverIds")) {
      return fail("invalid_server_slug", "serverIds is not accepted; use serverSlugs.", 400, id);
    }
    const serverSlugs = parseServerSlugs(body.serverSlugs);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!serverSlugs) return fail("invalid_server_slug", "serverSlugs must be a non-empty array of server slugs.", 400, id);
    if (!reason || expectedConfigVersion === null) return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    return withOperatorClient(env, id, async (client) => {
      return createFirstServerAllowRule({ env, session, client, requestId: id, key, serverSlugs, reason, expectedConfigVersion });
    });
  }

  if (
    request.method === "POST"
    && path === "feature-flags/apple_web_login_v0/platform-allowlist/web/rules"
  ) {
    const body = await requestBody(request);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!reason || expectedConfigVersion === null) {
      return fail(
        "invalid_request",
        "reason and expectedConfigVersion are required.",
        400,
        id,
      );
    }
    return withOperatorClient(env, id, async (client) => {
      return createFirstAppleWebPlatformAllowRule({
        env,
        session,
        client,
        requestId: id,
        reason,
        expectedConfigVersion,
      });
    });
  }

  const removeMatch = path.match(/^feature-flags\/([^/]+)\/server-allowlist\/([^/]+)$/);
  if (request.method === "DELETE" && removeMatch) {
    const key = parseFlagKey(decodeURIComponent(removeMatch[1] ?? ""));
    const serverSlug = parseServerSlug(decodeURIComponent(removeMatch[2] ?? ""));
    if (!key) return fail("invalid_flag_key", "Invalid feature flag key.", 400, id);
    if (!serverSlug) return fail("invalid_server_slug", "serverSlug must be a non-empty server slug.", 400, id);
    const body = await requestBody(request);
    const targetRuleId = parseRuleId(body.targetRuleId);
    const reason = parseReason(body.reason);
    const expectedConfigVersion = parseExpectedVersion(body.expectedConfigVersion);
    if (!targetRuleId) return fail("invalid_rule_id", "targetRuleId must be a valid UUID.", 400, id);
    if (!reason || expectedConfigVersion === null) return fail("invalid_request", "reason and expectedConfigVersion are required.", 400, id);
    return withOperatorClient(env, id, async (client) => {
      return mutateServerAllowlist({ request, env, session, client, requestId: id, key, targetRuleId, serverSlug, reason, expectedConfigVersion, operation: "server_allowlist_remove" });
    });
  }

  return fail("invalid_request", "Unknown operator API route.", 404, id);
}

async function withOperatorClient(
  env: Env,
  id: string,
  operation: (client: Client) => Promise<Response>,
  responses: {
    unavailable?: () => Response;
    failure?: () => Response;
    errorLabel?: string;
  } = {},
): Promise<Response> {
  const client = getClient(env);
  if (!client) {
    return responses.unavailable?.()
      ?? fail("operator_api_pending", "Feature flag PG Hyperdrive binding is not configured.", 501, id);
  }

  try {
    await client.connect();
    return await operation(client);
  } catch (error) {
    console.error(
      responses.errorLabel ?? "[feature-flag-operator]",
      error instanceof Error ? error.message : "unknown",
    );
    return responses.failure?.()
      ?? fail("internal_error", "Feature flag operator API failed.", 500, id);
  } finally {
    // Transaction-scoped locks release with COMMIT/ROLLBACK on the pinned
    // transaction backend; no cleanup query may depend on a pooled session.
    await client.end().catch(() => undefined);
  }
}

function firstServerAllowRuleCreationIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail,
  ruleId: string,
  serverIds: string[],
): boolean {
  const beforeServerRules = before.rules.filter((rule) => rule.stage === "server");
  if (beforeServerRules.length !== 0) return false;

  const createdRule = after.rules.find((rule) => rule.id === ruleId);
  const afterUntouched = after.rules.filter((rule) => rule.id !== ruleId);
  return JSON.stringify(afterUntouched) === JSON.stringify(before.rules)
    && JSON.stringify(after.flag) === JSON.stringify(before.flag)
    && !!createdRule
    && isCanonicalServerAllowlistRule(createdRule)
    && JSON.stringify(createdRule.values) === JSON.stringify(serverIds)
    && after.serverAllowlist.managed === true
    && after.serverAllowlist.ruleId === ruleId
    && JSON.stringify(after.serverAllowlist.serverIds) === JSON.stringify(serverIds)
    && JSON.stringify(after.serverAllowlistRules) === JSON.stringify([{
      ruleId,
      priority: 0,
      serverIds,
    }])
    && JSON.stringify(after.unsupportedRuleShapes) === JSON.stringify(before.unsupportedRuleShapes);
}

async function createFirstServerAllowRule(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  serverSlugs: string[];
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, serverSlugs, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const resolved = await resolveActiveServerSlugs(client, serverSlugs);
    if (!resolved.ok) {
      await client.query("ROLLBACK");
      return fail(resolved.code, resolved.message, resolved.status, id);
    }
    const { serverIds } = resolved;
    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    if (before.rules.some((rule) => rule.stage === "server")) {
      await client.query("ROLLBACK");
      return fail("rule_shape_unsupported", "A server rule already exists; this helper only creates the first server allowlist rule.", 409, id);
    }

    const actorName = session.principal.name || session.principal.preferredUsername || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation: "server_allowlist_first_rule_create",
      flagKey: key,
      targetKind: "feature_flag",
      targetId: key,
      reason,
      before,
      after: { serverIds },
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    const created = await client.query(`
      INSERT INTO feature_flag_rules (
        flag_key, stage, priority, decision, values, percentage_basis_points, variant
      ) VALUES ($1, 'server', 0, 'allow', $2::jsonb, NULL, NULL)
      RETURNING id
    `, [key, JSON.stringify(serverIds)]);
    const ruleId = parseRuleId(created.rows[0]?.id);
    if (!ruleId) {
      await client.query("ROLLBACK");
      throw new Error("first_server_allow_rule_missing_id");
    }

    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !firstServerAllowRuleCreationIsValid(before, after, ruleId, serverIds)) {
      await client.query("ROLLBACK");
      return fail("rule_shape_unsupported", "Server allowlist rule creation changed state outside the first-rule scope.", 409, id);
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const configVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, configVersion, after).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ ...publicAfter, changed: true, auditEventId, ruleId }, configVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; feature flag was not mutated.", 500, id);
    }
    throw error;
  }
}

function firstAppleWebPlatformAllowRuleCreationIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail,
  ruleId: string,
): boolean {
  if (before.rules.some((rule) => rule.stage === "platform")) return false;
  const createdRule = after.rules.find((rule) => rule.id === ruleId);
  const afterUntouched = after.rules.filter((rule) => rule.id !== ruleId);
  return JSON.stringify(afterUntouched) === JSON.stringify(before.rules)
    && JSON.stringify(after.flag) === JSON.stringify(before.flag)
    && !!createdRule
    && isCanonicalWebPlatformAllowRule(createdRule);
}

async function createFirstAppleWebPlatformAllowRule(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const {
    env,
    session,
    client,
    requestId: id,
    reason,
    expectedConfigVersion,
  } = input;
  const key = "apple_web_login_v0";
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    if (before.rules.some((rule) => rule.stage === "platform")) {
      await client.query("ROLLBACK");
      return fail(
        "rule_shape_unsupported",
        "A platform rule already exists; this helper only creates the first web allow rule.",
        409,
        id,
      );
    }

    const actorName = session.principal.name
      || session.principal.preferredUsername
      || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation: "apple_web_platform_first_rule_create",
      flagKey: key,
      targetKind: "feature_flag",
      targetId: key,
      reason,
      before,
      after: {
        stage: "platform",
        priority: 0,
        decision: "allow",
        values: ["web"],
        percentageBasisPoints: null,
        variant: null,
      },
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    const created = await client.query(`
      INSERT INTO feature_flag_rules (
        flag_key, stage, priority, decision, values, percentage_basis_points, variant
      ) VALUES ($1, 'platform', 0, 'allow', '["web"]'::jsonb, NULL, NULL)
      RETURNING id
    `, [key]);
    const ruleId = parseRuleId(created.rows[0]?.id);
    if (!ruleId) {
      await client.query("ROLLBACK");
      throw new Error("first_web_platform_rule_missing_id");
    }

    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !firstAppleWebPlatformAllowRuleCreationIsValid(before, after, ruleId)) {
      await client.query("ROLLBACK");
      return fail(
        "rule_shape_unsupported",
        "Apple web platform rule creation changed state outside the first-rule scope.",
        409,
        id,
      );
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const configVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, configVersion, after).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ ...publicAfter, changed: true, auditEventId, ruleId }, configVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; feature flag was not mutated.", 500, id);
    }
    throw error;
  }
}

async function mutateServerAllowlist(input: {
  request: Request;
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  targetRuleId: string;
  serverSlug: string;
  reason: string;
  expectedConfigVersion: number;
  operation: "server_allowlist_add" | "server_allowlist_remove";
}): Promise<Response> {
  const { env, session, client, requestId: id, key, targetRuleId, serverSlug, reason, expectedConfigVersion, operation } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const resolved = await resolveActiveServerSlug(client, serverSlug);
    if (!resolved.ok) {
      await client.query("ROLLBACK");
      return fail(resolved.code, resolved.message, resolved.status, id);
    }
    const serverId = resolved.serverId;
    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    const targetRule = before.rules.find((rule) => rule.id === targetRuleId);
    if (!targetRule) {
      await client.query("ROLLBACK");
      return fail("rule_not_found", "Selected server allowlist rule was not found.", 404, id);
    }
    if (!isServerAllowlistRule(targetRule)) {
      await client.query("ROLLBACK");
      return fail("rule_shape_unsupported", "Selected rule is not a plain server allowlist rule.", 409, id);
    }

    const nextServerIds = operation === "server_allowlist_add"
      ? [...new Set([...targetRule.values, serverId])].sort()
      : targetRule.values.filter((value) => value !== serverId);

    const actorName = session.principal.name || session.principal.preferredUsername || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation,
      flagKey: key,
      targetKind: "server",
      targetId: serverId,
      reason,
      before,
      after: { targetRuleId, serverAllowlist: nextServerIds },
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    await client.query(
      "UPDATE feature_flag_rules SET values = $1::jsonb, updated_at = NOW() WHERE id = $2 AND flag_key = $3",
      [JSON.stringify(nextServerIds), targetRuleId, key],
    );

    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !scopedServerAllowlistMutationIsValid(before, after, targetRuleId, nextServerIds)) {
      await client.query("ROLLBACK");
      return fail("rule_shape_unsupported", "Server allowlist mutation changed rules outside the selected target.", 409, id);
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const newVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, newVersion, after).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ ...publicAfter, auditEventId }, newVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; feature flag was not mutated.", 500, id);
    }
    throw error;
  }
}

function scopedDefaultEnabledMutationIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail,
  defaultEnabled: boolean,
): boolean {
  const { defaultEnabled: _beforeDefaultEnabled, updatedAt: _beforeUpdatedAt, ...beforeFlag } = before.flag;
  const { defaultEnabled: afterDefaultEnabled, updatedAt: _afterUpdatedAt, ...afterFlag } = after.flag;
  return afterDefaultEnabled === defaultEnabled
    && JSON.stringify(afterFlag) === JSON.stringify(beforeFlag)
    && JSON.stringify(after.rules) === JSON.stringify(before.rules)
    && JSON.stringify(after.serverAllowlist) === JSON.stringify(before.serverAllowlist)
    && JSON.stringify(after.serverAllowlistRules) === JSON.stringify(before.serverAllowlistRules)
    && JSON.stringify(after.unsupportedRuleShapes) === JSON.stringify(before.unsupportedRuleShapes);
}

async function mutateDefaultEnabled(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  defaultEnabled: boolean;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, defaultEnabled, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }

    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    if (before.flag.defaultEnabled === defaultEnabled) {
      const publicBefore = await toPublicFeatureFlagDetail(client, before);
      await client.query("ROLLBACK");
      return ok({ ...publicBefore, changed: false, auditEventId: null }, currentVersion, id);
    }

    const actorName = session.principal.name || session.principal.preferredUsername || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation: "default_enabled_update",
      flagKey: key,
      targetKind: "flag",
      targetId: key,
      reason,
      before,
      after: { defaultEnabled },
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    const update = await client.query(
      "UPDATE feature_flags SET default_enabled = $1, updated_at = NOW() WHERE key = $2 AND default_enabled IS DISTINCT FROM $1 RETURNING key",
      [defaultEnabled, key],
    );
    if (!update.rows[0]) {
      await client.query("ROLLBACK");
      throw new Error("default_enabled_update_lost_race");
    }

    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !scopedDefaultEnabledMutationIsValid(before, after, defaultEnabled)) {
      await client.query("ROLLBACK");
      throw new Error("default_enabled_update_scope_violation");
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const newVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, newVersion, after).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ ...publicAfter, changed: true, auditEventId }, newVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; feature flag was not mutated.", 500, id);
    }
    throw error;
  }
}

function normalizeGenericRule(rule: GenericFeatureFlagRuleInput): GenericFeatureFlagRuleInput {
  return { ...rule, values: [...new Set(rule.values)] };
}

function genericRuleValidationError(flagKey: string, rule: GenericFeatureFlagRuleInput): string | null {
  if (rule.stage === "platform" && rule.values.some((value) => value !== "web" && value !== "mobile")) {
    return "platform rule values must be web or mobile.";
  }
  if (
    rule.stage === "percentage"
    && (rule.percentageBasisPoints === null
      || rule.percentageBasisPoints < 0
      || rule.percentageBasisPoints > 10_000)
  ) {
    return "percentageBasisPoints must be 0-10000 for percentage rules.";
  }
  if (rule.stage === "audience") {
    if (
      rule.values.length === 0
      || rule.values.some((value) => !AUDIENCE_KEY_RE.test(value))
      || new Set(rule.values).size !== rule.values.length
    ) return "Audience rules require one or more unique valid audience keys.";
    if (rule.percentageBasisPoints !== null || rule.variant !== null) {
      return "Audience rules cannot set percentageBasisPoints or variants.";
    }
    return null;
  }
  if (rule.stage !== "lab") return null;
  if (flagKey === "server_labs_ui_v0") {
    return "server_labs_ui_v0 cannot use Lab feature-flag rules because it gates the Labs UI itself.";
  }
  if (
    rule.values.length === 0
    || rule.values.some((value) => !LAB_KEY_RE.test(value))
    || new Set(rule.values).size !== rule.values.length
  ) {
    return "Lab rules require one or more unique valid lab keys.";
  }
  if (rule.percentageBasisPoints !== null) return "Lab rules cannot set percentageBasisPoints.";
  if (rule.variant !== null) return "Lab rule variants are not supported in v1.";
  return null;
}

function actorName(session: FeatureFlagSession): string {
  return session.principal.name || session.principal.preferredUsername || session.principal.sub;
}

async function createMutationAudit(input: {
  env: Env;
  session: FeatureFlagSession;
  requestId: string;
  operation: string;
  flagKey: string;
  targetKind: string;
  targetId: string;
  reason: string;
  before: unknown;
  after: unknown;
}): Promise<string> {
  const auditEventId = crypto.randomUUID();
  await writeAuditEvent(input.env, {
    id: auditEventId,
    requestId: input.requestId,
    actorKind: input.session.principal.type,
    actorId: input.session.principal.sub,
    actorName: actorName(input.session),
    operation: input.operation,
    flagKey: input.flagKey,
    targetKind: input.targetKind,
    targetId: input.targetId,
    reason: input.reason,
    before: input.before,
    after: input.after,
    createdAt: new Date().toISOString(),
  }).catch((error) => {
    throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
  });
  return auditEventId;
}

async function commitMutation(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  auditEventId: string;
  after: unknown;
}): Promise<number> {
  const configVersion = await bumpConfigVersion(
    input.client,
    actorName(input.session),
    input.auditEventId,
  );
  await input.client.query("COMMIT");
  await finalizeAuditEvent(input.env, input.auditEventId, configVersion, input.after).catch((error) => {
    console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
  });
  return configVersion;
}

function mutationFailure(error: unknown, id: string, message: string): Response {
  if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
    return fail("audit_write_failed", "Audit write failed; feature flag was not mutated.", 500, id);
  }
  console.error("[feature-flag-generic-admin]", error instanceof Error ? error.message : "unknown");
  return fail("internal_error", message, 500, id);
}

function flagCreateReadbackIsValid(
  detail: FeatureFlagDetail | null,
  expected: Omit<FeatureFlagSummary, "highRisk" | "createdAt" | "updatedAt">,
): boolean {
  if (!detail || detail.rules.length !== 0) return false;
  const { highRisk: _highRisk, createdAt: _createdAt, updatedAt: _updatedAt, ...flag } = detail.flag;
  return JSON.stringify(flag) === JSON.stringify(expected);
}

function flagPatchReadbackIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail | null,
  patch: GenericFeatureFlagPatch,
): boolean {
  if (!after || JSON.stringify(after.rules) !== JSON.stringify(before.rules)) return false;
  const expected = { ...before.flag, ...patch };
  const { updatedAt: _expectedUpdatedAt, ...expectedStable } = expected;
  const { updatedAt: _afterUpdatedAt, ...afterStable } = after.flag;
  return JSON.stringify(afterStable) === JSON.stringify(expectedStable);
}

async function createGenericFeatureFlag(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  description: string | null;
  enabled: boolean;
  killSwitch: boolean;
  randomizationUnit: FeatureFlagSummary["randomizationUnit"];
  defaultEnabled: boolean;
  defaultVariant: string | null;
  salt: string;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    const expected = {
      key,
      description: input.description,
      enabled: input.enabled,
      killSwitch: input.killSwitch,
      randomizationUnit: input.randomizationUnit,
      defaultEnabled: input.defaultEnabled,
      defaultVariant: input.defaultVariant,
      salt: input.salt,
    };
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "feature_flag_create", flagKey: key,
      targetKind: "flag", targetId: key, reason, before, after: expected,
    });
    await client.query(`
      INSERT INTO feature_flags (
        key, description, enabled, kill_switch, randomization_unit,
        default_enabled, default_variant, salt, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
    `, [
      key,
      input.description,
      input.enabled,
      input.killSwitch,
      input.randomizationUnit,
      input.defaultEnabled,
      input.defaultVariant,
      input.salt,
    ]);
    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !flagCreateReadbackIsValid(after, expected)) throw new Error("feature_flag_create_readback_mismatch");
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const configVersion = await commitMutation({ env, session, client, auditEventId, after });
    return ok({ ...publicAfter, changed: true, auditEventId }, configVersion, id, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to create feature flag.");
  }
}

async function updateGenericFeatureFlag(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  patch: GenericFeatureFlagPatch;
  reason: string;
  expectedConfigVersion: number;
  operation?: string;
  failureMessage?: string;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, patch, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    const auditEventId = await createMutationAudit({
      env,
      session,
      requestId: id,
      operation: input.operation ?? "feature_flag_update",
      flagKey: key,
      targetKind: "flag",
      targetId: key,
      reason,
      before,
      after: patch,
    });
    await client.query(`
      UPDATE feature_flags SET
        description = CASE WHEN $1 THEN $2 ELSE description END,
        enabled = CASE WHEN $3 THEN $4 ELSE enabled END,
        kill_switch = CASE WHEN $5 THEN $6 ELSE kill_switch END,
        randomization_unit = CASE WHEN $7 THEN $8 ELSE randomization_unit END,
        default_enabled = CASE WHEN $9 THEN $10 ELSE default_enabled END,
        default_variant = CASE WHEN $11 THEN $12 ELSE default_variant END,
        salt = CASE WHEN $13 THEN $14 ELSE salt END,
        updated_at = NOW()
      WHERE key = $15
      RETURNING key
    `, [
      Object.hasOwn(patch, "description"), patch.description ?? null,
      Object.hasOwn(patch, "enabled"), patch.enabled ?? false,
      Object.hasOwn(patch, "killSwitch"), patch.killSwitch ?? false,
      Object.hasOwn(patch, "randomizationUnit"), patch.randomizationUnit ?? "user",
      Object.hasOwn(patch, "defaultEnabled"), patch.defaultEnabled ?? false,
      Object.hasOwn(patch, "defaultVariant"), patch.defaultVariant ?? null,
      Object.hasOwn(patch, "salt"), patch.salt ?? "",
      key,
    ]);
    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !flagPatchReadbackIsValid(before, after, patch)) throw new Error("feature_flag_update_readback_mismatch");
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const configVersion = await commitMutation({ env, session, client, auditEventId, after });
    return ok({ ...publicAfter, changed: true, auditEventId }, configVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, input.failureMessage ?? "Failed to update feature flag.");
  }
}

async function deleteGenericFeatureFlag(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "feature_flag_delete", flagKey: key,
      targetKind: "flag", targetId: key, reason, before, after: null,
    });
    const deleted = await client.query("DELETE FROM feature_flags WHERE key = $1 RETURNING key", [key]);
    if (!deleted.rows[0] || await loadFeatureFlagDetail(client, key)) {
      throw new Error("feature_flag_delete_readback_mismatch");
    }
    const configVersion = await commitMutation({ env, session, client, auditEventId, after: null });
    return new Response(null, {
      status: 204,
      headers: {
        "X-Feature-Flag-Config-Version": String(configVersion),
        "X-Feature-Flag-Audit-Event-Id": auditEventId,
        "X-Request-Id": id,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to delete feature flag.");
  }
}

function ruleReadbackIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail | null,
  operation: "create" | "update" | "delete",
  ruleId: string,
  expected?: GenericFeatureFlagRuleInput,
): boolean {
  if (!after || JSON.stringify(after.flag) !== JSON.stringify(before.flag)) return false;
  const beforeUntouched = before.rules.filter((rule) => rule.id !== ruleId);
  const afterUntouched = after.rules.filter((rule) => rule.id !== ruleId);
  if (operation === "create") {
    if (JSON.stringify(afterUntouched) !== JSON.stringify(before.rules)) return false;
  } else if (JSON.stringify(afterUntouched) !== JSON.stringify(beforeUntouched)) {
    return false;
  }
  if (operation === "delete") return !after.rules.some((rule) => rule.id === ruleId);
  const actual = after.rules.find((rule) => rule.id === ruleId);
  if (!actual || !expected) return false;
  return actual.stage === expected.stage
    && actual.priority === expected.priority
    && actual.decision === expected.decision
    && JSON.stringify(actual.values) === JSON.stringify(expected.values)
    && actual.percentageBasisPoints === expected.percentageBasisPoints
    && actual.variant === expected.variant;
}

async function createGenericFeatureFlagRule(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  rule: GenericFeatureFlagRuleInput;
  serverSlugs?: string[];
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, rule, serverSlugs, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    let resolvedRule = rule;
    if (rule.stage === "server") {
      if (!serverSlugs) {
        await client.query("ROLLBACK");
        return fail("invalid_server_slug", "Server rules require serverSlugs.", 400, id);
      }
      const resolved = await resolveActiveServerSlugs(client, serverSlugs);
      if (!resolved.ok) {
        await client.query("ROLLBACK");
        return fail(resolved.code, resolved.message, resolved.status, id);
      }
      resolvedRule = { ...rule, values: resolved.serverIds };
    }
    if (resolvedRule.stage === "audience" && !await enabledNonemptyAudienceKeysExist(client, resolvedRule.values)) {
      await client.query("ROLLBACK");
      return fail("invalid_request", "Audience rules may reference only enabled, non-empty audiences.", 400, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    const ruleId = crypto.randomUUID();
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "feature_flag_rule_create", flagKey: key,
      targetKind: "rule", targetId: ruleId, reason, before, after: { id: ruleId, ...resolvedRule },
    });
    await client.query(`
      INSERT INTO feature_flag_rules (
        id, flag_key, stage, priority, decision, values,
        percentage_basis_points, variant, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, NOW(), NOW())
    `, [
      ruleId, key, resolvedRule.stage, resolvedRule.priority, resolvedRule.decision, JSON.stringify(resolvedRule.values),
      resolvedRule.percentageBasisPoints, resolvedRule.variant,
    ]);
    const after = await loadFeatureFlagDetail(client, key);
    if (!before || !after || !ruleReadbackIsValid(before, after, "create", ruleId, resolvedRule)) {
      throw new Error("feature_flag_rule_create_readback_mismatch");
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const configVersion = await commitMutation({ env, session, client, auditEventId, after });
    return ok({ ...publicAfter, changed: true, auditEventId, ruleId }, configVersion, id, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to create feature flag rule.");
  }
}

async function updateGenericFeatureFlagRule(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  ruleId: string;
  patch: GenericFeatureFlagRulePatch;
  serverSlugs?: string[];
  rawValuesProvided: boolean;
  serverSlugsProvided: boolean;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const {
    env,
    session,
    client,
    requestId: id,
    key,
    ruleId,
    patch,
    serverSlugs,
    rawValuesProvided,
    serverSlugsProvided,
    reason,
    expectedConfigVersion,
  } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    const current = before?.rules.find((rule) => rule.id === ruleId);
    if (!current) {
      await client.query("ROLLBACK");
      return fail("rule_not_found", "Feature flag rule not found.", 404, id);
    }
    const effectiveStage = patch.stage ?? current.stage;
    let expectedValues = patch.values ?? current.values;
    if (effectiveStage === "server") {
      if (rawValuesProvided) {
        await client.query("ROLLBACK");
        return fail("invalid_server_slug", "Server rules do not accept values; use serverSlugs.", 400, id);
      }
      if (serverSlugsProvided) {
        const resolved = await resolveActiveServerSlugs(client, serverSlugs ?? []);
        if (!resolved.ok) {
          await client.query("ROLLBACK");
          return fail(resolved.code, resolved.message, resolved.status, id);
        }
        expectedValues = resolved.serverIds;
      } else if (current.stage !== "server") {
        await client.query("ROLLBACK");
        return fail("invalid_server_slug", "Changing a rule to server requires serverSlugs.", 400, id);
      }
    } else {
      if (serverSlugsProvided) {
        await client.query("ROLLBACK");
        return fail("invalid_request", "serverSlugs is only valid for server rules.", 400, id);
      }
      if (current.stage === "server" && !rawValuesProvided) {
        await client.query("ROLLBACK");
        return fail("invalid_request", "Changing a server rule stage requires replacement values.", 400, id);
      }
    }
    const rawExpected: GenericFeatureFlagRuleInput = {
      stage: effectiveStage,
      priority: patch.priority ?? current.priority,
      decision: patch.decision ?? current.decision,
      values: expectedValues,
      percentageBasisPoints: patch.percentageBasisPoints === undefined
        ? current.percentageBasisPoints
        : patch.percentageBasisPoints,
      variant: patch.variant === undefined ? current.variant : patch.variant,
    };
    const validationError = genericRuleValidationError(key, rawExpected);
    if (validationError) {
      await client.query("ROLLBACK");
      return fail("invalid_request", validationError, 400, id);
    }
    const expected = normalizeGenericRule(rawExpected);
    if (expected.stage === "audience" && !await enabledNonemptyAudienceKeysExist(client, expected.values)) {
      await client.query("ROLLBACK");
      return fail("invalid_request", "Audience rules may reference only enabled, non-empty audiences.", 400, id);
    }
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "feature_flag_rule_update", flagKey: key,
      targetKind: "rule", targetId: ruleId, reason, before, after: { id: ruleId, ...expected },
    });
    await client.query(`
      UPDATE feature_flag_rules SET
        stage = $1,
        priority = $2,
        decision = $3,
        values = $4::jsonb,
        percentage_basis_points = $5,
        variant = $6,
        updated_at = NOW()
      WHERE id = $7 AND flag_key = $8
      RETURNING id
    `, [
      expected.stage,
      expected.priority,
      expected.decision,
      JSON.stringify(expected.values),
      expected.percentageBasisPoints,
      expected.variant,
      ruleId,
      key,
    ]);
    const after = await loadFeatureFlagDetail(client, key);
    if (!before || !after || !ruleReadbackIsValid(before, after, "update", ruleId, expected)) {
      throw new Error("feature_flag_rule_update_readback_mismatch");
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const configVersion = await commitMutation({ env, session, client, auditEventId, after });
    return ok({ ...publicAfter, changed: true, auditEventId, ruleId }, configVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to update feature flag rule.");
  }
}

async function deleteGenericFeatureFlagRule(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  ruleId: string;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, ruleId, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    if (!before?.rules.some((rule) => rule.id === ruleId)) {
      await client.query("ROLLBACK");
      return fail("rule_not_found", "Feature flag rule not found.", 404, id);
    }
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "feature_flag_rule_delete", flagKey: key,
      targetKind: "rule", targetId: ruleId, reason, before, after: null,
    });
    const deleted = await client.query(
      "DELETE FROM feature_flag_rules WHERE id = $1 AND flag_key = $2 RETURNING id",
      [ruleId, key],
    );
    const after = await loadFeatureFlagDetail(client, key);
    if (!deleted.rows[0] || !ruleReadbackIsValid(before, after, "delete", ruleId)) {
      throw new Error("feature_flag_rule_delete_readback_mismatch");
    }
    const configVersion = await commitMutation({ env, session, client, auditEventId, after });
    return new Response(null, {
      status: 204,
      headers: {
        "X-Feature-Flag-Config-Version": String(configVersion),
        "X-Feature-Flag-Audit-Event-Id": auditEventId,
        "X-Request-Id": id,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to delete feature flag rule.");
  }
}

type ResolvedAudienceMember = { id: string; kind: "user" | "server"; targetId: string };

async function resolveAudienceMembers(input: {
  client: Client;
  requestId: string;
  audienceKey?: string;
  userIds: string[];
  serverSlugs: string[];
  retainedMemberIds: string[];
}): Promise<{ ok: true; members: ResolvedAudienceMember[] } | { ok: false; response: Response }> {
  const { client, requestId: id, audienceKey, userIds, serverSlugs, retainedMemberIds } = input;
  const existingResult = audienceKey
    ? await client.query(
      "SELECT id, kind, target_id FROM feature_flag_audience_members WHERE audience_key = $1",
      [audienceKey],
    )
    : { rows: [] };
  const existingByTarget = new Map<string, string>();
  const existingById = new Map<string, { kind: "user" | "server"; targetId: string }>();
  for (const row of existingResult.rows) {
    const kind = row.kind === "user" ? "user" : "server";
    const targetId = String(row.target_id);
    const id = String(row.id);
    existingByTarget.set(`${kind}:${targetId}`, id);
    existingById.set(id, { kind, targetId });
  }
  if (retainedMemberIds.some((id) => !existingById.has(id))) {
    return { ok: false, response: fail("invalid_request", "retainedMemberIds must belong to this audience.", 400, id) };
  }
  if (userIds.length > 0) {
    const users = await client.query("SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id ASC", [userIds]);
    const found = new Set(users.rows.map((row) => String(row.id).toLowerCase()));
    if (userIds.some((id) => !found.has(id.toLowerCase()))) {
      return { ok: false, response: fail("invalid_request", "One or more userIds are unknown.", 400, id) };
    }
  }
  const resolvedServers = serverSlugs.length > 0
    ? await resolveActiveServerSlugs(client, serverSlugs)
    : { ok: true as const, serverIds: [] };
  if (!resolvedServers.ok) {
    return { ok: false, response: fail(resolvedServers.code, resolvedServers.message, resolvedServers.status, id) };
  }
  const targets = [
    ...userIds.map((targetId) => ({ kind: "user" as const, targetId })),
    ...resolvedServers.serverIds.map((targetId) => ({ kind: "server" as const, targetId })),
    ...retainedMemberIds.map((id) => existingById.get(id)!),
  ];
  const members = new Map<string, ResolvedAudienceMember>();
  for (const target of targets) {
    const targetKey = `${target.kind}:${target.targetId}`;
    members.set(targetKey, {
      id: existingByTarget.get(targetKey) ?? crypto.randomUUID(),
      ...target,
    });
  }
  return { ok: true, members: [...members.values()].sort((a, b) => `${a.kind}:${a.targetId}`.localeCompare(`${b.kind}:${b.targetId}`)) };
}

async function replaceAudienceMemberRows(
  client: Client,
  audienceKey: string,
  members: ResolvedAudienceMember[],
): Promise<void> {
  await client.query("DELETE FROM feature_flag_audience_members WHERE audience_key = $1", [audienceKey]);
  for (const member of members) {
    await client.query(`
      INSERT INTO feature_flag_audience_members (id, audience_key, kind, target_id, created_at)
      VALUES ($1, $2, $3, $4, NOW())
    `, [member.id, audienceKey, member.kind, member.targetId]);
  }
}

function audienceMemberReadbackIsValid(
  audience: AudienceDefinition,
  userIds: string[],
  serverSlugs: string[],
  retainedMemberIds: string[],
): boolean {
  const actualUserIds = audience.members
    .filter((member) => member.kind === "user" && member.status === "active")
    .map((member) => member.userId ?? "")
    .sort();
  const actualServerSlugs = audience.members
    .filter((member) => member.kind === "server" && member.status === "active")
    .map((member) => member.serverSlug ?? "")
    .sort();
  const actualRetainedIds = audience.members
    .filter((member) => member.status === "unknown_or_deleted")
    .map((member) => member.memberId)
    .sort();
  return JSON.stringify(actualUserIds) === JSON.stringify([...new Set(userIds)].sort())
    && JSON.stringify(actualServerSlugs) === JSON.stringify([...new Set(serverSlugs)].sort())
    && JSON.stringify(actualRetainedIds) === JSON.stringify([...new Set(retainedMemberIds)].sort());
}

async function createAudienceDefinition(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  userIds: string[];
  serverSlugs: string[];
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, name, description, enabled, userIds, serverSlugs, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    if (await loadAudienceDefinition(client, key)) {
      await client.query("ROLLBACK");
      return fail("audience_already_exists", "Audience key already exists.", 409, id);
    }
    const resolved = await resolveAudienceMembers({ client, requestId: id, userIds, serverSlugs, retainedMemberIds: [] });
    if (!resolved.ok) {
      await client.query("ROLLBACK");
      return resolved.response;
    }
    if (enabled && resolved.members.length === 0) {
      await client.query("ROLLBACK");
      return fail("invalid_request", "An enabled audience must contain at least one member.", 400, id);
    }
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "audience_create", flagKey: key,
      targetKind: "audience", targetId: key, reason, before: null,
      after: { audienceKey: key, name, description, enabled, userIds, serverSlugs },
    });
    await client.query(`
      INSERT INTO feature_flag_audiences (key, name, description, enabled, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NOW(), NOW())
    `, [key, name, description, enabled]);
    await replaceAudienceMemberRows(client, key, resolved.members);
    const audience = await loadAudienceDefinition(client, key);
    if (!audience || audience.name !== name || audience.description !== description
      || audience.enabled !== enabled || !audienceMemberReadbackIsValid(audience, userIds, serverSlugs, [])) {
      throw new Error("audience_create_readback_mismatch");
    }
    const configVersion = await commitMutation({ env, session, client, auditEventId, after: audience });
    return ok({ audience, changed: true, auditEventId }, configVersion, id, { status: 201 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to create audience.");
  }
}

async function updateAudienceDefinition(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  name: string;
  description: string;
  enabled: boolean;
  userIds: string[];
  serverSlugs: string[];
  retainedMemberIds: string[];
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, name, description, enabled, userIds, serverSlugs, retainedMemberIds, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadAudienceDefinition(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("audience_not_found", "Audience not found.", 404, id);
    }
    const resolved = await resolveAudienceMembers({ client, requestId: id, audienceKey: key, userIds, serverSlugs, retainedMemberIds });
    if (!resolved.ok) {
      await client.query("ROLLBACK");
      return resolved.response;
    }
    if (enabled && resolved.members.length === 0) {
      await client.query("ROLLBACK");
      return fail("invalid_request", "An enabled audience must contain at least one member.", 400, id);
    }
    if (!enabled && before.enabled && before.affectedFlags.length > 0) {
      await client.query("ROLLBACK");
      return fail("audience_in_use", "Remove this audience from affected flags before disabling it.", 409, id);
    }
    const auditEventId = await createMutationAudit({
      env, session, requestId: id, operation: "audience_update", flagKey: key,
      targetKind: "audience", targetId: key, reason, before,
      after: { audienceKey: key, name, description, enabled, userIds, serverSlugs, retainedMemberIds },
    });
    await client.query(`
      UPDATE feature_flag_audiences
      SET name = $1, description = $2, enabled = $3, updated_at = NOW()
      WHERE key = $4
    `, [name, description, enabled, key]);
    await replaceAudienceMemberRows(client, key, resolved.members);
    const audience = await loadAudienceDefinition(client, key);
    if (!audience || audience.name !== name || audience.description !== description
      || audience.enabled !== enabled
      || !audienceMemberReadbackIsValid(audience, userIds, serverSlugs, retainedMemberIds)) {
      throw new Error("audience_update_readback_mismatch");
    }
    const configVersion = await commitMutation({ env, session, client, auditEventId, after: audience });
    return ok({ audience, changed: true, auditEventId }, configVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return mutationFailure(error, id, "Failed to update audience.");
  }
}

async function createLabDefinition(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  name: string;
  description: string;
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, name, description, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    if (await loadLabDefinition(client, key)) {
      await client.query("ROLLBACK");
      return fail("lab_already_exists", "Lab key already exists.", 409, id);
    }

    const actorName = session.principal.name || session.principal.preferredUsername || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation: "lab_create",
      flagKey: key,
      targetKind: "lab",
      targetId: key,
      reason,
      before: null,
      after: { labKey: key, name, description, state: "draft" },
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    await client.query(
      "INSERT INTO lab_definitions (key, name, description, state, created_at, updated_at) VALUES ($1, $2, $3, 'draft', NOW(), NOW())",
      [key, name, description],
    );
    const lab = await loadLabDefinition(client, key);
    if (!lab || lab.labKey !== key || lab.name !== name || lab.description !== description || lab.state !== "draft") {
      await client.query("ROLLBACK");
      throw new Error("lab_create_readback_mismatch");
    }
    const newVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, newVersion, lab).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ lab, changed: true, auditEventId }, newVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; Lab was not mutated.", 500, id);
    }
    throw error;
  }
}

async function updateLabDefinition(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  name?: string;
  description?: string;
  state?: LabDefinition["state"];
  reason: string;
  expectedConfigVersion: number;
}): Promise<Response> {
  const { env, session, client, requestId: id, key, reason, expectedConfigVersion } = input;
  await beginOperatorMutationSnapshot(client);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadLabDefinition(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("lab_not_found", "Lab not found.", 404, id);
    }
    const next = {
      name: input.name ?? before.name,
      description: input.description ?? before.description,
      state: input.state ?? before.state,
    };
    const isNoop = before.name === next.name
      && before.description === next.description
      && before.state === next.state;
    if (before.state === "retired" && !isNoop) {
      await client.query("ROLLBACK");
      return fail("lab_state_transition_invalid", "Retired Labs are immutable history.", 409, id);
    }
    if (!canTransitionLabState(before.state, next.state)) {
      await client.query("ROLLBACK");
      return fail("lab_state_transition_invalid", "Lab lifecycle transition is not allowed.", 409, id);
    }
    if (isNoop) {
      await client.query("ROLLBACK");
      return ok({ lab: before, changed: false, auditEventId: null }, currentVersion, id);
    }

    const actorName = session.principal.name || session.principal.preferredUsername || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation: "lab_update",
      flagKey: key,
      targetKind: "lab",
      targetId: key,
      reason,
      before,
      after: next,
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    await client.query(
      "UPDATE lab_definitions SET name = $1, description = $2, state = $3, updated_at = NOW() WHERE key = $4",
      [next.name, next.description, next.state, key],
    );
    const lab = await loadLabDefinition(client, key);
    if (!lab || lab.labKey !== before.labKey || lab.createdAt !== before.createdAt
      || lab.name !== next.name || lab.description !== next.description || lab.state !== next.state) {
      await client.query("ROLLBACK");
      throw new Error("lab_update_readback_mismatch");
    }
    const newVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, newVersion, lab).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ lab, changed: true, auditEventId }, newVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; Lab was not mutated.", 500, id);
    }
    throw error;
  }
}

function isLabRule(rule: FeatureFlagRule): boolean {
  return rule.stage === "lab"
    && rule.values.length > 0
    && rule.percentageBasisPoints === null
    && rule.variant === null;
}

function labRuleReadbackIsValid(
  before: FeatureFlagDetail,
  after: FeatureFlagDetail,
  operation: "lab_rule_create" | "lab_rule_update" | "lab_rule_delete",
  ruleId: string,
  expected?: { labKeys: string[]; decision: FeatureFlagRule["decision"]; priority: number },
): boolean {
  const beforeUntouched = before.rules.filter((rule) => rule.id !== ruleId);
  const afterUntouched = after.rules.filter((rule) => rule.id !== ruleId);
  if (operation === "lab_rule_create") {
    if (JSON.stringify(afterUntouched) !== JSON.stringify(before.rules)) return false;
  } else if (operation === "lab_rule_delete") {
    return JSON.stringify(after.rules) === JSON.stringify(beforeUntouched);
  } else if (JSON.stringify(afterUntouched) !== JSON.stringify(beforeUntouched)) {
    return false;
  }
  const rule = after.rules.find((candidate) => candidate.id === ruleId);
  return !!rule && !!expected && isLabRule(rule)
    && rule.decision === expected.decision
    && rule.priority === expected.priority
    && JSON.stringify(rule.values) === JSON.stringify(expected.labKeys);
}

async function mutateLabRule(input: {
  env: Env;
  session: FeatureFlagSession;
  client: Client;
  requestId: string;
  key: string;
  ruleId?: string;
  labKeys?: string[];
  decision?: FeatureFlagRule["decision"];
  priority?: number;
  reason: string;
  expectedConfigVersion: number;
  operation: "lab_rule_create" | "lab_rule_update" | "lab_rule_delete";
}): Promise<Response> {
  const { env, session, client, requestId: id, key, reason, expectedConfigVersion, operation } = input;
  await beginOperatorMutationSnapshot(client, key);
  try {
    const currentVersion = await getConfigVersion(client);
    if (currentVersion !== expectedConfigVersion) {
      await client.query("ROLLBACK");
      return fail("version_conflict", "Feature flag config version changed.", 409, id);
    }
    const before = await loadFeatureFlagDetail(client, key);
    if (!before) {
      await client.query("ROLLBACK");
      return fail("flag_not_found", "Feature flag not found.", 404, id);
    }
    const current = input.ruleId ? before.rules.find((rule) => rule.id === input.ruleId) : undefined;
    if (operation !== "lab_rule_create" && !current) {
      await client.query("ROLLBACK");
      return fail("rule_not_found", "Lab rule not found.", 404, id);
    }
    if (current && !isLabRule(current)) {
      await client.query("ROLLBACK");
      return fail("rule_shape_unsupported", "Selected rule is not a v1 Lab rule.", 409, id);
    }
    const expected = operation === "lab_rule_delete" ? undefined : {
      labKeys: input.labKeys ?? current?.values ?? [],
      decision: input.decision ?? current?.decision ?? "allow",
      priority: input.priority ?? current?.priority ?? 0,
    };
    const retargets = operation === "lab_rule_create"
      || (operation === "lab_rule_update" && !!current && !!expected
        && !sameLabKeySet(current.values, expected.labKeys));
    if (expected && retargets && !(await openLabKeysExist(client, expected.labKeys))) {
      await client.query("ROLLBACK");
      return fail("lab_not_found", "Every Lab rule target must exist and be open.", 409, id);
    }
    if (operation === "lab_rule_update" && current && expected
      && current.decision === expected.decision
      && current.priority === expected.priority
      && sameLabKeySet(current.values, expected.labKeys)) {
      const publicBefore = await toPublicFeatureFlagDetail(client, before);
      await client.query("ROLLBACK");
      return ok({ ...publicBefore, changed: false, auditEventId: null }, currentVersion, id);
    }

    const actorName = session.principal.name || session.principal.preferredUsername || session.principal.sub;
    const auditEventId = crypto.randomUUID();
    const ruleId = input.ruleId ?? crypto.randomUUID();
    await writeAuditEvent(env, {
      id: auditEventId,
      requestId: id,
      actorKind: session.principal.type,
      actorId: session.principal.sub,
      actorName,
      operation,
      flagKey: key,
      targetKind: "lab_rule",
      targetId: ruleId,
      reason,
      before,
      after: operation === "lab_rule_delete" ? null : { ruleId, ...expected },
      createdAt: new Date().toISOString(),
    }).catch(async (error) => {
      await client.query("ROLLBACK");
      throw new Error(`audit_write_failed:${error instanceof Error ? error.message : "unknown"}`);
    });

    if (operation === "lab_rule_create" && expected) {
      await client.query(`
        INSERT INTO feature_flag_rules (
          id, flag_key, stage, priority, decision, values,
          percentage_basis_points, variant, created_at, updated_at
        ) VALUES ($1, $2, 'lab', $3, $4, $5::jsonb, NULL, NULL, NOW(), NOW())
      `, [ruleId, key, expected.priority, expected.decision, JSON.stringify(expected.labKeys)]);
    } else if (operation === "lab_rule_update" && expected) {
      await client.query(`
        UPDATE feature_flag_rules
        SET priority = $1, decision = $2, values = $3::jsonb,
            percentage_basis_points = NULL, variant = NULL, updated_at = NOW()
        WHERE id = $4 AND flag_key = $5 AND stage = 'lab'
      `, [expected.priority, expected.decision, JSON.stringify(expected.labKeys), ruleId, key]);
    } else {
      await client.query(
        "DELETE FROM feature_flag_rules WHERE id = $1 AND flag_key = $2 AND stage = 'lab'",
        [ruleId, key],
      );
    }

    const after = await loadFeatureFlagDetail(client, key);
    if (!after || !labRuleReadbackIsValid(before, after, operation, ruleId, expected)) {
      await client.query("ROLLBACK");
      throw new Error("lab_rule_readback_mismatch");
    }
    const publicAfter = await toPublicFeatureFlagDetail(client, after);
    const newVersion = await bumpConfigVersion(client, actorName, auditEventId);
    await client.query("COMMIT");
    await finalizeAuditEvent(env, auditEventId, newVersion, after).catch((error) => {
      console.warn("[feature-flag-audit-finalize]", error instanceof Error ? error.message : "unknown");
    });
    return ok({ ...publicAfter, changed: true, auditEventId, ruleId }, newVersion, id);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof Error && error.message.startsWith("audit_write_failed")) {
      return fail("audit_write_failed", "Audit write failed; Lab rule was not mutated.", 500, id);
    }
    throw error;
  }
}

function manifest(request: Request): Response {
  const origin = new URL(request.url).origin;
  return Response.json({
    schema: "raft-agent-manifest.v0",
    name: "Feature Flag Admin",
    service: "slock-feature-flag-admin",
    app_origin: origin,
    execution: {
      mode: "http_api",
      base_url: `${origin}/api/operator`,
    },
    auth: {
      type: "login_with_raft",
      login_url: `${origin}/login`,
    },
    actions: [
      {
        name: "list-admin-role-grants",
        description: "List enabled Worker-owned admin grants.",
        endpoint: { method: "GET", path: "/api/operator/access-grants" },
      },
      {
        name: "grant-admin-role",
        description: "Grant the admin role with a persistent audit record. For human principals this also confers authority to publish announcements to every user.",
        endpoint: { method: "PUT", path: "/api/operator/access-grants/{principalId}/{role}" },
        parameters: {
          principalId: { type: "string", description: "Target Raft principal UUID.", required: true },
          role: { type: "string", description: "admin — grants Feature Flag administration AND, for human principals, authority to publish announcements to every user.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
        },
      },
      {
        name: "revoke-admin-role",
        description: "Revoke an enabled admin role with a persistent audit record. This also removes announcement publishing authority for human principals.",
        endpoint: { method: "DELETE", path: "/api/operator/access-grants/{principalId}/{role}" },
        parameters: {
          principalId: { type: "string", description: "Target Raft principal UUID.", required: true },
          role: { type: "string", description: "admin — grants Feature Flag administration AND, for human principals, authority to publish announcements to every user.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
        },
      },
      {
        name: "list-labs",
        description: "List the canonical Lab catalog and lifecycle state.",
        endpoint: { method: "GET", path: "/api/operator/labs" },
      },
      {
        name: "create-lab",
        description: "Create a draft Lab with audited config-version CAS.",
        endpoint: { method: "POST", path: "/api/operator/labs" },
        parameters: {
          labKey: { type: "string", description: "Stable lowercase Lab key.", required: true },
          name: { type: "string", description: "Operator-facing Lab name.", required: true },
          description: { type: "string", description: "Operator-facing Lab description.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "update-lab",
        description: "Update Lab metadata or lifecycle. Retired Labs cannot be reopened.",
        endpoint: { method: "PATCH", path: "/api/operator/labs/{labKey}" },
        parameters: {
          labKey: { type: "string", description: "Stable Lab key.", required: true },
          name: { type: "string", description: "Optional replacement name." },
          description: { type: "string", description: "Optional replacement description." },
          state: { type: "string", description: "Optional draft, open, paused, or retired lifecycle state." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "set-lab-state",
        description: "Apply a frozen Lab lifecycle transition with audited config-version CAS.",
        endpoint: { method: "POST", path: "/api/operator/labs/{labKey}/state" },
        parameters: {
          labKey: { type: "string", description: "Stable Lab key.", required: true },
          state: { type: "string", description: "draft, open, paused, or retired lifecycle state.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "list-feature-flags",
        description: "List feature flags visible to the operator.",
        endpoint: { method: "GET", path: "/api/operator/feature-flags" },
      },
      {
        name: "list-audiences",
        description: "List reusable named audiences, typed members, and affected feature flags.",
        endpoint: { method: "GET", path: "/api/operator/audiences" },
      },
      {
        name: "create-audience",
        description: "Create an audited audience draft or enabled non-empty audience using user IDs and server slugs.",
        endpoint: { method: "POST", path: "/api/operator/audiences" },
        parameters: {
          audienceKey: { type: "string", description: "Stable lowercase audience key.", required: true },
          name: { type: "string", description: "Operator-facing audience name.", required: true },
          description: { type: "string", description: "Operator-facing audience description.", required: true },
          enabled: { type: "boolean", description: "Enabled audiences must contain at least one member." },
          userIds: { type: "array", items: { type: "string" }, description: "User UUID members." },
          serverSlugs: { type: "array", items: { type: "string" }, description: "Active server slug members." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "replace-audience",
        description: "Replace audience metadata and typed membership with audited config-version CAS.",
        endpoint: { method: "PATCH", path: "/api/operator/audiences/{audienceKey}" },
        parameters: {
          audienceKey: { type: "string", description: "Stable audience key.", required: true },
          name: { type: "string", description: "Replacement name.", required: true },
          description: { type: "string", description: "Replacement description.", required: true },
          enabled: { type: "boolean", description: "Enabled audiences must remain non-empty.", required: true },
          userIds: { type: "array", items: { type: "string" }, description: "Replacement user UUID members.", required: true },
          serverSlugs: { type: "array", items: { type: "string" }, description: "Replacement active server slug members.", required: true },
          retainedMemberIds: { type: "array", items: { type: "string" }, description: "Opaque member-row IDs to retain for unresolved historical targets.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "list-server-targets",
        description: "Search the bounded active-server slug catalog for feature-flag targeting. Returns slugs only and excludes deleted or ambiguous entries.",
        endpoint: { method: "GET", path: "/api/operator/servers" },
        parameters: {
          query: { type: "string", description: "Optional lowercase slug substring, up to 64 characters." },
        },
      },
      {
        name: "get-feature-flag",
        description: "Load feature flag detail, rules, allowlist state, and active server-slug projections. Unknown or deleted server references are marked explicitly.",
        endpoint: { method: "GET", path: "/api/operator/feature-flags/{key}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
        },
      },
      {
        name: "create-feature-flag",
        description: "Create a feature flag with audited config-version CAS and authoritative PG readback.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          randomizationUnit: { type: "string", description: "user or server.", required: true },
          description: { type: "string", description: "Optional description." },
          enabled: { type: "boolean", description: "Optional evaluation enable state." },
          killSwitch: { type: "boolean", description: "Optional emergency kill-switch state." },
          defaultEnabled: { type: "boolean", description: "Optional default decision." },
          defaultVariant: { type: "string", description: "Optional default variant." },
          salt: { type: "string", description: "Optional stable randomization salt." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "update-feature-flag",
        description: "Patch feature-flag fields with audited config-version CAS. Explicit null clears description/defaultVariant; salt null is a no-op.",
        endpoint: { method: "PATCH", path: "/api/operator/feature-flags/{key}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          description: { type: "string", description: "Optional description; null clears." },
          enabled: { type: "boolean", description: "Optional evaluation enable state." },
          killSwitch: { type: "boolean", description: "Optional emergency kill-switch state." },
          randomizationUnit: { type: "string", description: "Optional user or server." },
          defaultEnabled: { type: "boolean", description: "Optional default decision." },
          defaultVariant: { type: "string", description: "Optional default variant; null clears." },
          salt: { type: "string", description: "Optional non-empty salt; null is a no-op." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "delete-feature-flag",
        description: "Delete a feature flag and cascading rules with audit, CAS, and absence readback.",
        endpoint: { method: "DELETE", path: "/api/operator/feature-flags/{key}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "set-kill-switch",
        description: "Set the emergency kill switch with audit, CAS, and exact PG readback.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/kill-switch" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          killSwitch: { type: "boolean", description: "New emergency kill-switch state.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "create-feature-flag-rule",
        description: "Create any supported user/platform/server/audience/lab/plan/percentage rule with audit, CAS, and exact readback. Server rules accept exact active server slugs and store UUIDs internally; audience rules accept enabled named audience keys.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/rules" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          stage: { type: "string", description: "user, platform, server, audience, lab, plan, or percentage.", required: true },
          decision: { type: "string", description: "allow or deny.", required: true },
          priority: { type: "integer", description: "Optional first-match priority." },
          values: { type: "array<string>", description: "Optional exact match values for non-server rules." },
          serverSlugs: { type: "array<string>", description: "Required exact active server slugs when stage=server." },
          percentageBasisPoints: { type: "integer", description: "Required 0-10000 for percentage rules." },
          variant: { type: "string", description: "Optional variant." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "update-feature-flag-rule",
        description: "Patch an exact feature-flag rule with audit, CAS, shape validation, and exact readback. Server rule targets use exact active server slugs.",
        endpoint: { method: "PATCH", path: "/api/operator/feature-flags/{key}/rules/{ruleId}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          ruleId: { type: "string", description: "Exact rule UUID.", required: true },
          stage: { type: "string", description: "Optional rule stage." },
          decision: { type: "string", description: "Optional allow or deny." },
          priority: { type: "integer", description: "Optional first-match priority." },
          values: { type: "array<string>", description: "Optional exact match values for non-server rules." },
          serverSlugs: { type: "array<string>", description: "Optional replacement exact active slugs for a server rule; required when changing another stage to server." },
          percentageBasisPoints: { type: "integer", description: "Optional 0-10000 threshold or null." },
          variant: { type: "string", description: "Optional variant or null." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "delete-feature-flag-rule",
        description: "Delete an exact rule with audit, CAS, and absence readback.",
        endpoint: { method: "DELETE", path: "/api/operator/feature-flags/{key}/rules/{ruleId}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          ruleId: { type: "string", description: "Exact rule UUID.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "set-default-enabled",
        description: "Set a feature flag's defaultEnabled value with an expected config version and audit reason.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/default-enabled" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          defaultEnabled: { type: "boolean", description: "New defaultEnabled value.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "add-server-allowlist",
        description: "Add an exact active server slug to an explicitly selected plain server allowlist rule. targetRuleId is required.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/server-allowlist" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          serverSlug: { type: "string", description: "Exact active server slug to add.", required: true },
          targetRuleId: { type: "string", description: "Exact plain server allowlist rule UUID.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "create-first-server-allow-rule",
        description: "Create the first plain priority-0 server allowlist rule with exact active server slugs, config-version CAS, audit, and readback. Fails if any server rule already exists.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/server-allowlist/rules" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          serverSlugs: { type: "array<string>", description: "Non-empty exact active server slug list for the initial allowlist rule.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "enable-apple-web-login",
        description: "Create the first canonical Apple web-only platform allow rule with config-version CAS, D1 pre-audit, and exact readback. Fails if the flag is absent or any platform rule already exists.",
        endpoint: {
          method: "POST",
          path: "/api/operator/feature-flags/apple_web_login_v0/platform-allowlist/web/rules",
        },
        parameters: {
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "remove-server-allowlist",
        description: "Remove an exact active server slug from an explicitly selected plain server allowlist rule. targetRuleId is required.",
        endpoint: { method: "DELETE", path: "/api/operator/feature-flags/{key}/server-allowlist/{serverSlug}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          serverSlug: { type: "string", description: "Exact active server slug to remove.", required: true },
          targetRuleId: { type: "string", description: "Exact plain server allowlist rule UUID.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "create-lab-rule",
        description: "Create a v1 Lab allow/deny rule with audited config-version CAS.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/lab-rules" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          labKeys: { type: "array<string>", description: "Non-empty active Lab keys; values match by OR.", required: true },
          decision: { type: "string", description: "allow or deny.", required: true },
          priority: { type: "integer", description: "Non-negative first-match priority.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "update-lab-rule",
        description: "Update Lab rule targets, decision, or priority without exposing variants.",
        endpoint: { method: "PATCH", path: "/api/operator/feature-flags/{key}/lab-rules/{ruleId}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          ruleId: { type: "string", description: "Exact Lab rule UUID.", required: true },
          labKeys: { type: "array<string>", description: "Optional non-empty active Lab keys; values match by OR." },
          decision: { type: "string", description: "Optional allow or deny." },
          priority: { type: "integer", description: "Optional non-negative first-match priority." },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "delete-lab-rule",
        description: "Delete an exact v1 Lab rule with audited config-version CAS.",
        endpoint: { method: "DELETE", path: "/api/operator/feature-flags/{key}/lab-rules/{ruleId}" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          ruleId: { type: "string", description: "Exact Lab rule UUID.", required: true },
          reason: { type: "string", description: "Audit reason, 3 to 500 characters.", required: true },
          expectedConfigVersion: { type: "integer", description: "Current config version for optimistic concurrency.", required: true },
        },
      },
      {
        name: "evaluate-feature-flag-preview",
        description: "Return the authoritative feature-flag decision and reason for an exact active server slug and/or user context. Variants are not exposed in v1.",
        endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/evaluate-preview" },
        parameters: {
          key: { type: "string", description: "Feature flag key.", required: true },
          serverSlug: { type: "string", description: "Optional exact active server slug." },
          userId: { type: "string", description: "Optional user UUID." },
          platform: { type: "string", description: "Optional platform: web or mobile." },
        },
      },
    ],
  }, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/login" || url.pathname === "/auth/login") {
      return loginRedirect(request, env);
    }
    if (url.pathname === "/auth/raft/callback") {
      return handleCallback(request, env);
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      return Response.json({ ok: true }, {
        headers: { "Set-Cookie": clearCookieHeader(request, SESSION_COOKIE) },
      });
    }
    if (url.pathname === "/.well-known/raft-agent-manifest.json" || url.pathname === "/.well-known/slock-agent-manifest.json") {
      return manifest(request);
    }
    if (url.pathname === "/api/readiness/operator-db" && request.method === "POST") {
      return operatorDbReadiness(env);
    }

    const session = await openSession(request, env);
    if (url.pathname === "/api/session") {
      return Response.json({
        principal: session?.principal ?? null,
      }, session ? undefined : {
        headers: { "Set-Cookie": clearCookieHeader(request, SESSION_COOKIE) },
      });
    }

    if (url.pathname.startsWith("/api/")) {
      if (!session) return Response.json({ error: "Login with Raft session is required" }, { status: 401 });
      if (
        url.pathname === "/api/operator/announcements"
        || url.pathname.startsWith("/api/operator/announcements/")
      ) {
        const id = requestId();
        const unauthorized = await requireOperator(session, env, id);
        if (unauthorized) return unauthorized;
        const nonHuman = requireHumanAnnouncementOperator(session, id);
        if (nonHuman) return nonHuman;
        return withOperatorClient(env, id, async (client) => (
          handleAnnouncementAdminRequest(request, session.principal.sub, client)
        ));
      }
      if (request.method === "POST" && /^\/api\/operator\/feature-flags\/[^/]+\/evaluate-preview$/.test(url.pathname)) {
        return handleOperatorApi(request, env, session);
      }
      if (request.method === "POST" && /^\/api\/operator\/feature-flags\/[^/]+\/server-allowlist\/rules$/.test(url.pathname)) {
        return handleOperatorApi(request, env, session);
      }
      if (
        request.method === "POST"
        && url.pathname === "/api/operator/feature-flags/apple_web_login_v0/platform-allowlist/web/rules"
      ) {
        return handleOperatorApi(request, env, session);
      }
      return handleOperatorApi(request, env, session);
    }

    if (!session) {
      const login = new URL("/login", url.origin);
      login.searchParams.set("return_to", normalizeReturnTo(`${url.pathname}${url.search}${url.hash}`));
      return new Response(null, {
        status: 302,
        headers: {
          Location: login.toString(),
          "Cache-Control": "no-store",
        },
      });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "private, no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};

export const internals = {
  SESSION_COOKIE,
  STATE_COOKIE,
  signJson,
  verifySignedJson,
  normalizePrincipal,
  normalizeReturnTo,
};
