import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentContext } from "../../auth/env.js";
import { cliError } from "../../core/errors.js";
import {
  CanonicalFetchTransportError,
  credentialFreeDiagnosticUrl,
  fetchWithCanonicalProxy,
  type FetchTransportCauseClass,
} from "../../proxy.js";
import { buildAgentCallbackHandoffUrl, type IntegrationLoginResponse, type RegisteredIntegrationService } from "./_format.js";

export interface SessionCookie {
  pair: string;
  host: string;
  path: string;
  secure: boolean;
  expiresAt?: string;
}

export interface IntegrationServiceSession {
  serviceId: string;
  clientId: string;
  returnUrl: string;
  cookies: SessionCookie[];
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationSessionResult {
  cookies: SessionCookie[];
  source: "cache" | "fresh";
  sessionPath: string | null;
}

function safeUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw cliError("INVALID_ARG", `${label} must be a valid URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw cliError("INVALID_ARG", `${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw cliError("INVALID_ARG", `${label} must not include credentials`);
  }
  return url;
}

function resolveStateRoot(env: NodeJS.ProcessEnv): string {
  const configured = env.RAFT_HOME?.trim() || env.SLOCK_HOME?.trim();
  if (configured) return configured;
  const home = env.HOME ?? os.homedir();
  return path.join(home, ".slock");
}

export function integrationSessionFilePath(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  service: RegisteredIntegrationService;
}): string | null {
  const root = input.agentContext.profileCredentialPath
    ? path.dirname(input.agentContext.profileCredentialPath)
    : path.join(resolveStateRoot(input.env), "integration-sessions", input.agentContext.agentId);
  const safeClientId = encodeURIComponent(input.service.clientId).replace(/%/g, "_");
  return path.join(root, "integrations", `${safeClientId}.json`);
}

function setCookieHeaderValues(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  return typeof getSetCookie === "function"
    ? getSetCookie.call(headers)
    : [headers.get("set-cookie")].filter((value): value is string => Boolean(value));
}

function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith("/") || pathname === "/") return "/";
  const lastSlash = pathname.lastIndexOf("/");
  if (lastSlash <= 0) return "/";
  return pathname.slice(0, lastSlash);
}

function parseCookieExpiry(parts: string[]): string | undefined {
  const now = Date.now();
  const attributes = parts.map((part) => {
    const separator = part.indexOf("=");
    return {
      name: (separator >= 0 ? part.slice(0, separator) : part).trim().toLowerCase(),
      value: separator >= 0 ? part.slice(separator + 1).trim() : "",
    };
  });
  const maxAge = attributes.find((attribute) => attribute.name === "max-age");
  if (maxAge && /^-?\d+$/.test(maxAge.value)) {
    const seconds = Number(maxAge.value);
    if (Number.isSafeInteger(seconds)) {
      return seconds <= 0
        ? new Date(0).toISOString()
        : new Date(now + seconds * 1000).toISOString();
    }
  }
  for (const attribute of attributes) {
    if (attribute.name === "expires") {
      const time = Date.parse(attribute.value);
      if (Number.isFinite(time)) return new Date(time).toISOString();
    }
  }
  return undefined;
}

function parseSessionCookie(value: string, sourceUrl: URL): SessionCookie | null {
  const parts = value.split(";").map((part) => part.trim()).filter(Boolean);
  const pair = parts.shift();
  if (!pair || !pair.includes("=") || pair.startsWith("=")) return null;

  const sourceHost = sourceUrl.hostname.toLowerCase();
  let host = sourceHost;
  let cookiePath = defaultCookiePath(sourceUrl.pathname);
  let secure = false;

  for (const part of parts) {
    const separator = part.indexOf("=");
    const rawName = separator >= 0 ? part.slice(0, separator) : part;
    const rawValue = separator >= 0 ? part.slice(separator + 1) : "";
    const name = rawName.trim().toLowerCase();
    if (name === "secure") {
      secure = true;
    } else if (name === "path" && rawValue.trim().startsWith("/")) {
      cookiePath = rawValue.trim();
    } else if (name === "domain") {
      const domain = rawValue.trim().replace(/^\./, "").toLowerCase();
      if (domain !== sourceHost) return null;
      host = domain;
    }
  }

  return { pair, host, path: cookiePath, secure, expiresAt: parseCookieExpiry(parts) };
}

export function cookiePathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (cookiePath.endsWith("/")) return requestPath.startsWith(cookiePath);
  return requestPath.startsWith(`${cookiePath}/`);
}

export function cookieHeaderForUrl(cookies: SessionCookie[], url: URL): string | null {
  const host = url.hostname.toLowerCase();
  const valid = cookies
    .filter((cookie) => isCookieUnexpired(cookie))
    .filter((cookie) => cookie.host === host)
    .filter((cookie) => !cookie.secure || url.protocol === "https:")
    .filter((cookie) => cookiePathMatches(url.pathname || "/", cookie.path))
    .sort((left, right) => right.path.length - left.path.length)
    .map((cookie) => cookie.pair);
  return valid.length > 0 ? valid.join("; ") : null;
}

function sessionCookiesFromSetCookie(headers: Headers, sourceUrl: URL): SessionCookie[] {
  return setCookieHeaderValues(headers)
    .map((value) => parseSessionCookie(value, sourceUrl))
    .filter((value): value is SessionCookie => Boolean(value));
}

function isCookieUnexpired(cookie: SessionCookie, expirySkewMs = 0): boolean {
  if (!cookie.expiresAt) return true;
  return Date.parse(cookie.expiresAt) > Date.now() + expirySkewMs;
}

function freshCookies(cookies: SessionCookie[]): SessionCookie[] {
  return cookies.filter((cookie) => isCookieUnexpired(cookie, 30_000));
}

interface ServiceErrorNote {
  code?: string;
  hint?: string;
}

// An HTTP rejection from the service usually arrives with a JSON body that says
// why — and that body used to be dropped, leaving only "HTTP_401" for a failure
// the service had already explained (e.g. a service that is bound to a single
// dedicated agent by design). Surface the service's own `error` code and
// hint/message, bounded, credential-redacted, and stripped of control
// characters; anything that is not a JSON object stays out of the message
// rather than splatting HTML into it.
function redactServiceErrorText(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitiveValue of sensitiveValues) {
    if (sensitiveValue) redacted = redacted.replaceAll(sensitiveValue, "<redacted>");
  }
  return redacted
    .replace(/\b(sk_(?:agent|machine|computer|daemon)_)[A-Za-z0-9._-]+/g, "$1<redacted>")
    .replace(/\b(sap_)[A-Za-z0-9._-]+/g, "$1<redacted>")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+)\b/g, "<redacted>")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted>")
    .replace(/\b(authorization\s*[:=]\s*)[^\r\n,;]+/gi, "$1<redacted>")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/\b((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)[^\s,;]+/gi, "$1<redacted>");
}

async function readServiceErrorNote(
  response: Response,
  sensitiveValues: readonly string[] = [],
): Promise<ServiceErrorNote | null> {
  let raw: string;
  try {
    raw = (await response.text()).slice(0, 4096);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const clean = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const printable = redactServiceErrorText(
      value.replace(/[\p{Cc}\p{Cf}]+/gu, ""),
      sensitiveValues,
    ).trim().slice(0, 300);
    return printable.length > 0 ? printable : undefined;
  };
  const code = clean(body.error) ?? clean(body.code);
  const hint = clean(body.hint) ?? clean(body.message) ?? clean(body.detail);
  if (!code && !hint) return null;
  return { code, hint };
}

function serviceErrorSuffix(note: ServiceErrorNote | null | undefined): string {
  if (!note) return "";
  const parts = [note.code, note.hint].filter(Boolean);
  return ` Service response: ${parts.join(" — ")}.`;
}

function sessionHandoffError(input: {
  service: RegisteredIntegrationService;
  stage: "callback";
  url: string | URL;
  causeClass: FetchTransportCauseClass | "http";
  causeCode?: string;
  cause?: unknown;
  message?: string;
  suggestedNextAction?: string;
  serviceError?: ServiceErrorNote | null;
}) {
  const actualUrl = credentialFreeDiagnosticUrl(input.url);
  const causeSuffix = input.causeCode ? `/${input.causeCode}` : "";
  const baseMessage = input.message
    ?? `Raft grant is active, but the service session handoff failed before a session was stored (${input.stage} ${input.causeClass}${causeSuffix} at ${actualUrl}).`;
  return cliError(
    "INTEGRATION_SESSION_HANDOFF_FAILED",
    `${baseMessage}${serviceErrorSuffix(input.serviceError)}`,
    {
      cause: input.cause,
      layer: "integration_session_transport",
      faultDomain: "integration_session_transport",
      retryable: true,
      suggestedNextAction: input.suggestedNextAction
        ?? `Retry raft integration login --service ${JSON.stringify(input.service.clientId)}; the existing Raft grant does not prove that a service session was stored.`,
      details: {
        grant_status: "active",
        service_session_status: "not_stored",
        transport_stage: input.stage,
        actual_url: actualUrl,
        cause_class: input.causeClass,
        cause_code: input.causeCode ?? null,
        ...(input.serviceError?.code ? { service_error_code: input.serviceError.code } : {}),
        ...(input.serviceError?.hint ? { service_error_hint: input.serviceError.hint } : {}),
      },
    },
  );
}

export function loadStoredIntegrationSession(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  service: RegisteredIntegrationService;
}): IntegrationServiceSession | null {
  const filePath = integrationSessionFilePath(input);
  if (!filePath) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const session = parsed as Partial<IntegrationServiceSession>;
  if (
    session.serviceId !== input.service.id
    || session.clientId !== input.service.clientId
    || session.returnUrl !== input.service.returnUrl
    || !Array.isArray(session.cookies)
  ) {
    return null;
  }
  const cookies = freshCookies(session.cookies);
  if (cookies.length === 0) return null;
  return { ...session, cookies } as IntegrationServiceSession;
}

function storeIntegrationSession(input: {
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  service: RegisteredIntegrationService;
  cookies: SessionCookie[];
}): string | null {
  const filePath = integrationSessionFilePath(input);
  if (!filePath) return null;
  const now = new Date().toISOString();
  const previous = loadStoredIntegrationSession(input);
  const body: IntegrationServiceSession = {
    serviceId: input.service.id,
    clientId: input.service.clientId,
    returnUrl: input.service.returnUrl ?? "",
    cookies: freshCookies(input.cookies),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export async function consumeAgentLoginHandoff(input: {
  login: IntegrationLoginResponse;
  service: RegisteredIntegrationService;
  env?: NodeJS.ProcessEnv;
}): Promise<SessionCookie[]> {
  if (!input.login.requestId) {
    throw cliError("INTEGRATION_LOGIN_FAILED", "agent login response did not include an internal one-time handoff request");
  }
  const callbackUrl = buildAgentCallbackHandoffUrl(input.service.returnUrl, input.login.requestId);
  if (!callbackUrl) {
    throw cliError("INTEGRATION_LOGIN_FAILED", "service return URL cannot be used for Agent Login callback handoff");
  }
  const parsedCallbackUrl = safeUrl(callbackUrl, "service callback URL");
  const env = input.env ?? process.env;

  let response: Response;
  try {
    response = await fetchWithCanonicalProxy(callbackUrl, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "text/html,application/json" },
    }, env);
  } catch (cause) {
    if (cause instanceof CanonicalFetchTransportError) {
      throw sessionHandoffError({
        service: input.service,
        stage: "callback",
        url: parsedCallbackUrl,
        causeClass: cause.diagnostics.causeClass,
        causeCode: cause.diagnostics.causeCode,
        cause,
      });
    }
    throw cause;
  }
  if (response.status < 200 || response.status >= 400) {
    const serviceError = await readServiceErrorNote(response, [input.login.requestId]);
    if (response.status === 409) {
      throw sessionHandoffError({
        service: input.service,
        stage: "callback",
        url: response.url || parsedCallbackUrl,
        causeClass: "http",
        causeCode: "HTTP_409",
        message: "Raft grant is active, but the service session handoff was expired or already used and no service session was stored.",
        serviceError,
      });
    }
    throw sessionHandoffError({
      service: input.service,
      stage: "callback",
      url: response.url || parsedCallbackUrl,
      causeClass: "http",
      causeCode: `HTTP_${response.status}`,
      serviceError,
    });
  }
  const callbackCookies = sessionCookiesFromSetCookie(response.headers, parsedCallbackUrl);
  if (freshCookies(callbackCookies).length === 0) {
    throw cliError(
      "INTEGRATION_LOGIN_FAILED",
      "service callback handoff did not set a session cookie; the service may not support stateless Agent Login sessions yet",
    );
  }
  return callbackCookies;
}

export async function ensureIntegrationServiceSession(input: {
  login: IntegrationLoginResponse;
  service: RegisteredIntegrationService;
  agentContext: AgentContext;
  env: NodeJS.ProcessEnv;
  refresh?: boolean;
}): Promise<IntegrationSessionResult> {
  if (!input.refresh) {
    const stored = loadStoredIntegrationSession(input);
    if (stored) {
      return {
        cookies: stored.cookies,
        source: "cache",
        sessionPath: integrationSessionFilePath(input),
      };
    }
  }

  const cookies = await consumeAgentLoginHandoff(input);
  const sessionPath = storeIntegrationSession({ ...input, cookies });
  return { cookies, source: "fresh", sessionPath };
}
