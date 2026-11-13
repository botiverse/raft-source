/** Platform-selected Agent Login v1. No manifest chooses or configures this protocol. */
import type { AgentContext } from "../../auth/env";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import { cliError } from "../../core/errors";
import { fetchWithCanonicalProxy } from "../../proxy";
import type { RegisteredIntegrationService } from "./_format";
import type { SessionCookie } from "./_session";

type Api = ReturnType<typeof createAgentApiSurfaceClient>;
type Fetcher = typeof fetchWithCanonicalProxy;
export type AgentHandoffBinding = { version: "v1"; agentId: string; serverId: string; origin: string };
const COOKIE = "__Host-raft_app_admin_agent_session";
const COMPLETE = "/auth/agent/complete";
const SESSION = "/auth/agent/session";
const CODE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  throw cliError("INTEGRATION_AGENT_HANDOFF_FAILED", message, { retryable: false });
}

/** Missing means an old Server; an unknown value is never a legacy downgrade. */
export function agentHandoffProtocol(value: unknown): "legacy" | "v1" {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "v1") return "v1";
  throw cliError("INTEGRATION_HANDOFF_UNSUPPORTED", "This App uses an unknown Agent Login protocol. Upgrade the Raft CLI and retry.");
}

export function handoffOrigin(service: RegisteredIntegrationService): string {
  let callback: URL;
  try { callback = new URL(service.returnUrl ?? ""); } catch { return fail("Agent handoff needs a registered HTTPS callback."); }
  if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash) return fail("Agent handoff needs a registered HTTPS callback without credentials or fragments.");
  return callback.origin;
}

export async function expectedAgentIdentity(api: Api, local: AgentContext): Promise<{ agentId: string; serverId: string }> {
  try {
    const result = await api.agent.context();
    if (!result.ok || !result.data?.agent.id || !result.data.server.id) return fail("Could not confirm the Agent and Server with Raft.");
    const { id: agentId } = result.data.agent;
    const { id: serverId } = result.data.server;
    if ((local.agentId && local.agentId !== agentId) || (local.serverId && local.serverId !== serverId)) return fail("Raft's confirmed Agent or Server does not match this context.");
    return { agentId, serverId };
  } catch {
    return fail("Could not confirm the Agent and Server with Raft.");
  }
}

function ensureOk(response: Response): void {
  if (response.status < 200 || response.status >= 300 || response.redirected) fail("Agent handoff was refused or redirected; start login again.");
}

async function jsonBody(response: Response): Promise<unknown> {
  if (!response.body || Number(response.headers.get("content-length") ?? "0") > 8192) return fail("Invalid Agent session response.");
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8192) { await reader.cancel(); return fail("Agent session response is too large."); }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("Invalid Agent session response."); }
}

function sessionCookie(response: Response, origin: string): SessionCookie {
  const values = response.headers.getSetCookie().filter((line) => line.startsWith(`${COOKIE}=`));
  if (values.length !== 1) return fail("Agent handoff did not return exactly one session cookie.");
  const parts = values[0]!.split(";").map((part) => part.trim());
  const pair = parts.shift()!;
  if (!/^[A-Za-z0-9_.-]+$/.test(pair.slice(COOKIE.length + 1))) return fail("Invalid Agent session cookie.");
  const attrs = parts.map((part) => part.toLowerCase());
  if (attrs.some((part) => part === "domain" || part.startsWith("domain="))
    || attrs.filter((part) => part.startsWith("path=")).length !== 1 || !attrs.includes("path=/")
    || !attrs.includes("secure") || !attrs.includes("httponly") || !attrs.includes("samesite=strict")
    || attrs.filter((part) => part.startsWith("samesite=")).length !== 1) return fail("Agent session cookie is not host-only and isolated.");
  const ages = attrs.filter((part) => part.startsWith("max-age="));
  const age = ages.length === 1 && /^max-age=\d+$/.test(ages[0]!) ? Number(ages[0]!.slice(8)) : 0;
  if (!Number.isSafeInteger(age) || age < 1 || age > 3600) return fail("Invalid Agent session lifetime.");
  return { pair, host: new URL(origin).hostname, path: "/", secure: true, expiresAt: new Date(Date.now() + age * 1000).toISOString() };
}

export async function verifyAgentSession(input: { origin: string; cookie: SessionCookie; expected: { agentId: string; serverId: string }; env: NodeJS.ProcessEnv; fetch?: Fetcher }): Promise<void> {
  if (input.cookie.host !== new URL(input.origin).hostname || input.cookie.path !== "/" || !input.cookie.secure
    || !input.cookie.pair.startsWith(`${COOKIE}=`) || !input.cookie.expiresAt
    || !Number.isFinite(Date.parse(input.cookie.expiresAt)) || Date.parse(input.cookie.expiresAt) <= Date.now()) return fail("Agent session cookie is missing or does not match the App.");
  const response = await (input.fetch ?? fetchWithCanonicalProxy)(`${input.origin}${SESSION}`, {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { accept: "application/json", cookie: input.cookie.pair },
  }, input.env).catch(() => fail("Could not verify the Agent session; start login again."));
  ensureOk(response);
  const body = await jsonBody(response);
  const principal = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>).principal : null;
  if (!principal || typeof principal !== "object" || Array.isArray(principal)) return fail("Agent session identity is missing.");
  const identity = principal as Record<string, unknown>;
  if (identity.type !== "agent" || identity.sub !== input.expected.agentId || identity.serverId !== input.expected.serverId) return fail("Agent session identity does not match the authenticated Raft context.");
}

export async function establishAgentSession(input: { api: Api; local: AgentContext; service: RegisteredIntegrationService; code: string; verifier: string; env: NodeJS.ProcessEnv; fetch?: Fetcher }): Promise<{ cookies: SessionCookie[]; binding: AgentHandoffBinding }> {
  if (!CODE.test(input.code) || !/^[A-Za-z0-9_-]{43}$/.test(input.verifier)) return fail("Agent handoff requires a fresh one-time request and verifier.");
  const expected = await expectedAgentIdentity(input.api, input.local);
  const origin = handoffOrigin(input.service);
  const response = await (input.fetch ?? fetchWithCanonicalProxy)(`${origin}${COMPLETE}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { accept: "application/json", "content-type": "application/json", "x-raft-agent-handoff": "v1" },
    body: JSON.stringify({ code: input.code, verifier: input.verifier }),
  }, input.env).catch(() => fail("Agent handoff could not reach the App; start login again."));
  ensureOk(response);
  const cookie = sessionCookie(response, origin);
  await verifyAgentSession({ origin, cookie, expected, env: input.env, fetch: input.fetch });
  return { cookies: [cookie], binding: { version: "v1", ...expected, origin } };
}

export async function verifyCachedAgentSession(input: { api: Api; local: AgentContext; service: RegisteredIntegrationService; binding: AgentHandoffBinding; cookies: SessionCookie[]; env: NodeJS.ProcessEnv; fetch?: Fetcher }): Promise<void> {
  const expected = await expectedAgentIdentity(input.api, input.local);
  const origin = handoffOrigin(input.service);
  if (input.binding.version !== "v1" || input.binding.agentId !== expected.agentId || input.binding.serverId !== expected.serverId || input.binding.origin !== origin) return fail("Stored Agent session does not match this Raft context.");
  const cookies = input.cookies.filter((cookie) => cookie.pair.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) return fail("Stored Agent session is missing or ambiguous.");
  await verifyAgentSession({ origin, cookie: cookies[0]!, expected, env: input.env, fetch: input.fetch });
}
