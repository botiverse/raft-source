import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import type { AgentContext } from "../../auth/env";
import type { ApiResponse } from "../../client";
import { createCommandContext } from "../../core/context";
import type { CliIo } from "../../core/io";
import { setCanonicalFetchImplForTests } from "../../proxy";
import { integrationLoginCommand } from "./login";
import { loadVerifiedIntegrationSession } from "./_session";
import { createAgentApiSurfaceClient } from "../../agentApiPath";
import type { RegisteredIntegrationService } from "./_format";

const agentId = "11111111-1111-4111-8111-111111111111";
const serverId = "22222222-2222-4222-8222-222222222222";
const code = "33333333-3333-4333-8333-333333333333";
const service: RegisteredIntegrationService = { id: "service-1", clientId: "slock-internal-app-admin", name: "Admin", description: null, homepageUrl: "https://admin.example", returnUrl: "https://admin.example/auth/callback", agentManifestUrl: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
const body = { agent: { id: agentId, name: "agent", displayName: null, description: null, runtime: "external", external: true }, server: { id: serverId, slug: "fixture", name: "Fixture" }, credential: { capabilities: ["read"] }, prompt: null };
const ok = (data: unknown): ApiResponse<unknown> => ({ ok: true, status: 200, data, error: null });

function fixture(root: string, protocol: string, subject = agentId) {
  const output: string[] = [];
  const io: CliIo = { stdout: { write: (value) => { output.push(String(value)); return true; } }, stderr: { write: (value) => { output.push(String(value)); return true; } } };
  const context: AgentContext = { agentId, serverId: null, serverUrl: "https://raft.example", token: "fixture-agent-token", clientMode: "self-hosted-runner", secretSource: "profile-credential-file", activeCapabilities: null, profileCredentialPath: path.join(root, "credential.json") };
  const client = { request: async (_method: string, requestPath: string, payload?: { agentHandoffChallenge?: string }) => {
    if (requestPath === "/internal/agent-api/integrations/login") {
      if (protocol === "v1" && !payload?.agentHandoffChallenge) return { ok: false, status: 400, error: "upgrade", errorCode: "INTEGRATION_HANDOFF_UPGRADE_REQUIRED", data: null };
      return ok({ status: "logged_in", service, scopes: ["identity"], requestId: code, agentHandoffProtocol: protocol });
    }
    if (requestPath === "/internal/agent-api/context") return ok({ ...body, agent: { ...body.agent, id: subject } });
    throw new Error(`unexpected internal path ${requestPath}`);
  } } as never;
  const ctx = createCommandContext({ io, env: { HOME: root } as NodeJS.ProcessEnv, loadAgentContext: () => context, createApiClient: () => client });
  return { ctx, output, context, client };
}

function stubApp(subject = agentId, calls: string[] = []) {
  return setCanonicalFetchImplForTests(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    if (url === "https://admin.example/auth/agent/complete") {
      assert.equal(init?.method, "POST");
      const payload = JSON.parse(String(init?.body)) as { code: string; verifier: string };
      assert.equal(payload.code, code);
      assert.match(payload.verifier, /^[A-Za-z0-9_-]{43}$/);
      return new Response("{}", { status: 200, headers: { "set-cookie": "__Host-raft_app_admin_agent_session=fixture-cookie; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=300" } });
    }
    if (url === "https://admin.example/auth/agent/session") return Response.json({ principal: { type: "agent", sub: subject, serverId } });
    throw new Error("unexpected App endpoint");
  });
}

test("v1 login verifies Raft and App identities, uses no manifest, and stores a private bound cookie", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-v1-login-"));
  const f = fixture(root, "v1");
  const calls: string[] = [];
  const old = stubApp(agentId, calls);
  try {
    const file = path.join(root, "integrations", "slock-internal-app-admin.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    await integrationLoginCommand.handler(f.ctx, { service: service.clientId, json: true });
    assert.deepEqual(calls, ["https://admin.example/auth/agent/complete", "https://admin.example/auth/agent/session"]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const session = JSON.parse(fs.readFileSync(file, "utf8")) as { handoff: { agentId: string; serverId: string; version: string } };
    assert.deepEqual([session.handoff.version, session.handoff.agentId, session.handoff.serverId], ["v1", agentId, serverId]);
    const printed = f.output.join("");
    assert.equal(JSON.parse(printed).data.session.authentication, "verified");
    assert.ok(!printed.includes(code) && !printed.includes("fixture-cookie") && !printed.includes("fixture-agent-token"));
    const verified = await loadVerifiedIntegrationSession({ service, agentContext: f.context, env: { HOME: root }, api: createAgentApiSurfaceClient(f.client) });
    assert.ok(verified?.handoff);
    assert.equal(calls.at(-1), "https://admin.example/auth/agent/session", "a v1 cache is checked again before use");
  } finally { setCanonicalFetchImplForTests(old); fs.rmSync(root, { recursive: true, force: true }); }
});

test("v1 rejects an unexpected App identity before saving; unknown protocol never reaches the App", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "raft-v1-reject-"));
  const wrong = fixture(root, "v1");
  const calls: string[] = [];
  const old = stubApp("different-agent", calls);
  try {
    await assert.rejects(async () => { await integrationLoginCommand.handler(wrong.ctx, { service: service.clientId }); }, /does not match/);
    assert.equal(fs.existsSync(path.join(root, "integrations", "slock-internal-app-admin.json")), false);
    calls.length = 0;
    const unknown = fixture(root, "v2");
    await assert.rejects(async () => { await integrationLoginCommand.handler(unknown.ctx, { service: service.clientId }); }, /Upgrade the Raft CLI/);
    assert.deepEqual(calls, []);
  } finally { setCanonicalFetchImplForTests(old); fs.rmSync(root, { recursive: true, force: true }); }
});
