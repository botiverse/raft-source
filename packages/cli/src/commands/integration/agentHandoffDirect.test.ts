import assert from "node:assert/strict";
import { test } from "vitest";
import type { AgentContext } from "../../auth/env";
import { agentHandoffProtocol, establishAgentSession, expectedAgentIdentity, verifyCachedAgentSession } from "./agentHandoffDirect";
import type { RegisteredIntegrationService } from "./_format";

const agentId = "11111111-1111-4111-8111-111111111111";
const serverId = "22222222-2222-4222-8222-222222222222";
const code = "33333333-3333-4333-8333-333333333333";
const verifier = "A".repeat(43);
const service = { id: "app", clientId: "slock-internal-app-admin", returnUrl: "https://admin.example/auth/callback" } as RegisteredIntegrationService;
const local = { agentId, serverId: null } as unknown as AgentContext;
const api = { agent: { context: async () => ({ ok: true, data: { agent: { id: agentId }, server: { id: serverId } } }) } } as never;
const cookie = "__Host-raft_app_admin_agent_session=fixture; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300";

function transport(options: { identityAgent?: string; identityServer?: string; setCookie?: string; status?: number } = {}) {
  const urls: string[] = [];
  const fetcher = async (url: string, init: RequestInit) => {
    urls.push(url);
    assert.equal(init.redirect, "manual");
    if (url.endsWith("/auth/agent/complete")) {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(String(init.body)), { code, verifier });
      assert.equal(new Headers(init.headers).get("x-raft-agent-handoff"), "v1");
      return new Response("{}", { status: options.status ?? 200, headers: { "set-cookie": options.setCookie ?? cookie } });
    }
    if (url.endsWith("/auth/agent/session")) return Response.json({ principal: { type: "agent", sub: options.identityAgent ?? agentId, serverId: options.identityServer ?? serverId } });
    throw new Error("unexpected URL");
  };
  return { urls, fetcher: fetcher as never };
}

test("protocol comes from login: old Servers are legacy, unknown values never downgrade", () => {
  assert.equal(agentHandoffProtocol(undefined), "legacy");
  assert.equal(agentHandoffProtocol("legacy"), "legacy");
  assert.equal(agentHandoffProtocol("v1"), "v1");
  for (const value of [null, "v2", "", 1]) assert.throws(() => agentHandoffProtocol(value), /Upgrade the Raft CLI/);
});

test("v1 uses the registered origin and confirms the Agent and Server before returning a session", async () => {
  const io = transport();
  const result = await establishAgentSession({ api, local, service, code, verifier, env: {}, fetch: io.fetcher });
  assert.deepEqual(io.urls, ["https://admin.example/auth/agent/complete", "https://admin.example/auth/agent/session"]);
  assert.deepEqual(result.binding, { version: "v1", agentId, serverId, origin: "https://admin.example" });
  assert.equal(result.cookies.length, 1);
  await verifyCachedAgentSession({ api, local, service, binding: result.binding, cookies: result.cookies, env: {}, fetch: io.fetcher });
  assert.equal(io.urls.at(-1), "https://admin.example/auth/agent/session");
});

test("v1 fails closed for unconfirmed context, insecure cookies and a wrong session identity", async () => {
  const noContext = { agent: { context: async () => ({ ok: false }) } } as never;
  await assert.rejects(expectedAgentIdentity(noContext, local), /Could not confirm/);
  await assert.rejects(expectedAgentIdentity(api, { ...local, serverId: "wrong" }), /Could not confirm/);
  await assert.rejects(establishAgentSession({ api, local, service: { ...service, returnUrl: "http://admin.example/callback" }, code, verifier, env: {}, fetch: transport().fetcher }), /HTTPS/);
  await assert.rejects(establishAgentSession({ api, local, service, code, verifier, env: {}, fetch: transport({ status: 302 }).fetcher }), /refused or redirected/);
  await assert.rejects(establishAgentSession({ api, local, service, code, verifier, env: {}, fetch: transport({ setCookie: cookie.replace("; Secure", "") }).fetcher }), /host-only and isolated/);
  await assert.rejects(establishAgentSession({ api, local, service, code, verifier, env: {}, fetch: transport({ identityAgent: "wrong" }).fetcher }), /does not match/);
  await assert.rejects(establishAgentSession({ api, local, service, code, verifier, env: {}, fetch: transport({ identityServer: "wrong" }).fetcher }), /does not match/);
});

test("a cached v1 session is rechecked, and a wrong binding or App subject is not used", async () => {
  const io = transport();
  const result = await establishAgentSession({ api, local, service, code, verifier, env: {}, fetch: io.fetcher });
  await assert.rejects(verifyCachedAgentSession({ api, local, service, binding: { ...result.binding, agentId: "wrong" }, cookies: result.cookies, env: {}, fetch: io.fetcher }), /does not match/);
  await assert.rejects(verifyCachedAgentSession({ api, local, service, binding: result.binding, cookies: result.cookies, env: {}, fetch: transport({ identityServer: "wrong" }).fetcher }), /does not match/);
  await assert.rejects(verifyCachedAgentSession({ api, local, service, binding: result.binding, cookies: [...result.cookies, ...result.cookies], env: {}, fetch: io.fetcher }), /ambiguous/);
});
