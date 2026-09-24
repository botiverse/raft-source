import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { integrationLoginCommand } from "./login.js";
import type { RegisteredIntegrationService } from "./_format.js";

function memoryIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: (chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true; } },
    },
  };
}

function service(): RegisteredIntegrationService {
  return {
    id: "svc-1",
    clientId: "docs-demo",
    name: "Docs Demo",
    description: null,
    homepageUrl: "https://docs.example",
    returnUrl: "https://docs.example/login/raft/callback",
    agentManifestUrl: "https://docs.example/.well-known/slock-agent-manifest.json",
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  };
}

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function ok(data: unknown): ApiResponse<unknown> {
  return { ok: true, status: 200, data, error: null };
}

async function withMockFetch<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    calls.push(resolvedUrl);
    if (resolvedUrl === "https://docs.example/.well-known/slock-agent-manifest.json") {
      return responseWithUrl(JSON.stringify({
        schema: "slock-agent-manifest.v0",
        execution: { mode: "http_api", base_url: "https://docs.example" },
        auth: { type: "login_with_raft", login_url: "https://docs.example/auth/login" },
        actions: [{
          name: "read-docs",
          endpoint: { method: "GET", path: "/api/docs" },
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    if (resolvedUrl === "https://docs.example/auth/login") {
      assert.equal(init?.redirect, "manual");
      return responseWithUrl("", {
        status: 302,
        headers: {
          "set-cookie": "docs-oauth-state=state-123; HttpOnly; Secure; Path=/; Max-Age=300",
          location: "https://raft.example/login-with-raft/setup",
        },
      }, resolvedUrl);
    }
    if (resolvedUrl === "https://docs.example/login/raft/callback?code=agent-login-request") {
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      const headers = new Headers({ location: "/" });
      headers.append("set-cookie", "docs-oauth-state=; HttpOnly; Secure; Path=/; Max-Age=0");
      headers.append("set-cookie", "docs-session=session-123; HttpOnly; Secure; Path=/; Max-Age=604800");
      return responseWithUrl("", {
        status: 302,
        headers,
      }, resolvedUrl);
    }
    return responseWithUrl("not found", { status: 404 }, resolvedUrl);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("integration login consumes one-time handoff and stores service session without exposing request id", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-"));
  const svc = service();
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        assert.equal(requestPath, "/internal/agent-api/integrations/login");
        assert.deepEqual(body, { service: "docs-demo", scopes: undefined, target: undefined });
        return ok({
          status: "logged_in",
          service: svc,
          scopes: ["identity"],
          requestId: "agent-login-request",
        });
      },
    }) as any,
  });

  await withMockFetch(async (calls) => {
    await integrationLoginCommand.handler(ctx, { service: "docs-demo" });
    assert.deepEqual(calls, [
      "https://docs.example/login/raft/callback?code=agent-login-request",
    ]);
  });

  const output = stdout.join("");
  assert.match(output, /Agent login ready: Docs Demo/);
  assert.match(output, /session: service session created and stored for this agent/);
  assert.doesNotMatch(output, /manifest status:/);
  assert.doesNotMatch(output, /action surface:/);
  assert.doesNotMatch(output, /agent-login-request/);
  assert.doesNotMatch(output, /callback handoff URL/);

  const sessionPath = path.join(tmp, "integrations", "docs-demo.json");
  const stored = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { cookies?: Array<{ pair?: string }> };
  assert.deepEqual(stored.cookies?.map((cookie) => cookie.pair), ["docs-session=session-123"]);
});

test("integration login json omits successful request id and reports stored session", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-json-"));
  const svc = service();
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "already_logged_in",
        service: svc,
        scopes: ["identity"],
        requestId: "agent-login-request",
      }),
    }) as any,
  });

  await withMockFetch(async () => {
    await integrationLoginCommand.handler(ctx, { service: "docs-demo", json: true });
  });

  const body = JSON.parse(stdout.join("")) as {
    data?: {
      requestId?: string;
      session?: { status?: string; source?: string };
      manifestObservation?: unknown;
    };
  };
  assert.equal(body.data?.requestId, undefined);
  assert.deepEqual(body.data?.session, {
    status: "stored",
    source: "fresh",
    path: path.join(tmp, "integrations", "docs-demo.json"),
  });
  assert.equal(body.data?.manifestObservation, undefined);
});

test("integration login remains successful for existing Web apps with no manifest", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-web-only-"));
  const svc = service();
  svc.agentManifestUrl = null;
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "logged_in",
        service: svc,
        scopes: ["identity"],
        requestId: "agent-login-request",
      }),
    }) as any,
  });

  await withMockFetch(async (calls) => {
    await integrationLoginCommand.handler(ctx, { service: "docs-demo" });
    assert.deepEqual(calls, ["https://docs.example/login/raft/callback?code=agent-login-request"]);
  });

  const output = stdout.join("");
  assert.match(output, /Agent login ready: Docs Demo/);
  assert.match(output, /session: service session created and stored for this agent/);
  assert.doesNotMatch(output, /manifest status:/);
  assert.doesNotMatch(output, /action surface:/);
  assert.doesNotMatch(output, /Error:/);
});

test("integration login reports an active Raft grant separately from a failed service-session handoff", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-handoff-failure-"));
  const svc = service();
  svc.agentManifestUrl = null;
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: {
      HOME: tmp,
      HTTPS_PROXY: "http://127.0.0.1:43192",
    } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "already_logged_in",
        service: svc,
        scopes: ["identity"],
        requestId: "agent-login-request-must-not-render",
      }),
    }) as any,
  });

  const previousFetch = globalThis.fetch;
  let dispatcherObserved = false;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    dispatcherObserved = Boolean((init as RequestInit & { dispatcher?: unknown } | undefined)?.dispatcher);
    const dnsCause = Object.assign(new Error("getaddrinfo ENOTFOUND docs.example"), { code: "ENOTFOUND" });
    throw Object.assign(new TypeError("fetch failed"), { cause: dnsCause });
  }) as typeof fetch;
  try {
    await assert.rejects(
      async () => integrationLoginCommand.handler(ctx, { service: "docs-demo" }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(String(error.code), "INTEGRATION_SESSION_HANDOFF_FAILED");
        assert.equal(error.fault_domain, "integration_session_transport");
        assert.equal(error.retryable, true);
        assert.match(error.message, /Raft grant is active/);
        assert.match(error.message, /service session handoff failed/);
        assert.doesNotMatch(error.message, /INTERNAL_BUG|agent-login-request-must-not-render/);
        assert.match(error.suggestedNextAction ?? "", /raft integration login --service "docs-demo"/);
        assert.deepEqual(error.details, {
          grant_status: "active",
          service_session_status: "not_stored",
          transport_stage: "callback",
          actual_url: "https://docs.example/login/raft/callback?code=%5Bredacted%5D",
          cause_class: "dns",
          cause_code: "ENOTFOUND",
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fs.existsSync(path.join(tmp, "integrations", "docs-demo.json")), false);
  assert.equal(dispatcherObserved, true);
});

test("integration login surfaces the service's JSON error body on a callback HTTP rejection", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-callback-body-"));
  const svc = service();
  svc.agentManifestUrl = null;
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "already_logged_in",
        service: svc,
        scopes: ["identity"],
        requestId: "agent-login-request",
      }),
    }) as any,
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseWithUrl(JSON.stringify({
    error: "DEDICATED_INTAKE_AGENT_REQUIRED",
    hint: "this service is bound to a single configured intake agent",
  }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }, "https://docs.example/login/raft/callback")) as typeof fetch;
  try {
    await assert.rejects(
      async () => integrationLoginCommand.handler(ctx, { service: "docs-demo" }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(String(error.code), "INTEGRATION_SESSION_HANDOFF_FAILED");
        assert.match(error.message, /Service response: DEDICATED_INTAKE_AGENT_REQUIRED — this service is bound to a single configured intake agent\./);
        assert.deepEqual(error.details, {
          grant_status: "active",
          service_session_status: "not_stored",
          transport_stage: "callback",
          actual_url: "https://docs.example/login/raft/callback",
          cause_class: "http",
          cause_code: "HTTP_403",
          service_error_code: "DEDICATED_INTAKE_AGENT_REQUIRED",
          service_error_hint: "this service is bound to a single configured intake agent",
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("integration login keeps a non-JSON callback error body out of the message", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-callback-html-"));
  const svc = service();
  svc.agentManifestUrl = null;
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "already_logged_in",
        service: svc,
        scopes: ["identity"],
        requestId: "agent-login-request",
      }),
    }) as any,
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseWithUrl("<html><body>Forbidden</body></html>", {
    status: 403,
    headers: { "content-type": "text/html" },
  }, "https://docs.example/login/raft/callback")) as typeof fetch;
  try {
    await assert.rejects(
      async () => integrationLoginCommand.handler(ctx, { service: "docs-demo" }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(String(error.code), "INTEGRATION_SESSION_HANDOFF_FAILED");
        assert.doesNotMatch(error.message, /Service response:|<html>/);
        assert.deepEqual(error.details, {
          grant_status: "active",
          service_session_status: "not_stored",
          transport_stage: "callback",
          actual_url: "https://docs.example/login/raft/callback",
          cause_class: "http",
          cause_code: "HTTP_403",
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("integration login redacts the one-time handoff and credentials echoed by a JSON error", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-callback-redaction-"));
  const svc = service();
  svc.agentManifestUrl = null;
  const requestId = "agent-login-request-must-not-render";
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "already_logged_in",
        service: svc,
        scopes: ["identity"],
        requestId,
      }),
    }) as any,
  });

  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async () => responseWithUrl(JSON.stringify({
    error: `handoff=${requestId.replace("request-must", "request\u0000-must")}`,
    hint: [
      `request=${requestId.replace("login-request", "login-\u200Brequest")}`,
      "retry with Authorization: Basic ZGVtbzpwYXNz, token=token-value; Bearer ZGVtbzpw\u0000YXNz",
      "sk_machine_machine-value gho_1234567890abcdefghij AKIA1234567890ABCDEF",
    ].join(" "),
  }), {
    status: 403,
    headers: { "content-type": "application/json" },
  }, `https://docs.example/login/raft/callback?code=${requestId}`)) as typeof fetch;
  try {
    await assert.rejects(
      async () => integrationLoginCommand.handler(ctx, { service: "docs-demo" }),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        const rendered = `${error.message}\n${JSON.stringify(error.details)}`;
        assert.doesNotMatch(
          rendered,
          /agent-login-request-must-not-render|agent-login-request\s+-must-not-render|agent-login-\s+request-must-not-render|ZGVtbzpwYXNz|YXNz|token-value|machine-value|gho_|AKIA/,
        );
        assert.match(rendered, /<redacted>/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("integration login does not fetch manifest login_url before the stateless agent callback", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-no-browser-login-"));
  const svc = service();
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: {
      HOME: tmp,
      HTTPS_PROXY: "http://127.0.0.1:43193",
    } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ok({
        status: "already_logged_in",
        service: svc,
        scopes: ["identity"],
        requestId: "agent-login-request-must-not-render",
      }),
    }) as any,
  });

  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    calls.push(resolvedUrl);
    if (resolvedUrl === svc.agentManifestUrl) {
      throw new Error("agent login must not fetch the manifest before callback handoff");
    }
    if (resolvedUrl === "https://docs.example/auth/login") {
      throw new Error("agent login must not start browser-flow login before callback handoff");
    }
    assert.equal(resolvedUrl, "https://docs.example/login/raft/callback?code=agent-login-request-must-not-render");
    assert.equal(init?.redirect, "manual");
    assert.equal(new Headers(init?.headers).get("cookie"), null);
    return responseWithUrl("", {
      status: 302,
      headers: {
        "set-cookie": "docs-session=session-123; HttpOnly; Secure; Path=/; Max-Age=604800",
        location: "/",
      },
    }, resolvedUrl);
  }) as typeof fetch;
  try {
    await integrationLoginCommand.handler(ctx, { service: "docs-demo" });
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.deepEqual(calls, ["https://docs.example/login/raft/callback?code=agent-login-request-must-not-render"]);
  assert.match(stdout.join(""), /session: service session created and stored for this agent/);
  assert.equal(fs.existsSync(path.join(tmp, "integrations", "docs-demo.json")), true);
});

test("integration login reports install-required without calling the app callback or creating a session", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-login-install-required-"));
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
    profileCredentialPath: path.join(tmp, "credential.json"),
  };
  const { io, stdout } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: { HOME: tmp } as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        assert.equal(requestPath, "/internal/agent-api/integrations/login");
        assert.deepEqual(body, { service: "me-build", scopes: undefined, target: "#general" });
        return ok({
          status: "install_required",
          nextAction: "install_from_marketplace",
          service: { ...service(), clientId: "me-build", name: "Me Build" },
          scopes: ["openid", "profile"],
          installation: {
            serverSlug: "botiverse",
            serverName: "Botiverse",
            marketplaceUrl: "https://raft.build/s/botiverse/settings/applications?marketplace_app=svc-1",
            target: "#general",
            actionCardMessageId: "card-install-1",
          },
        });
      },
    }) as any,
  });

  await withMockFetch(async (calls) => {
    await integrationLoginCommand.handler(ctx, { service: "me-build", target: "#general" });
    assert.deepEqual(calls, []);
  });

  assert.match(stdout.join(""), /Marketplace install required: Me Build/);
  assert.equal(fs.existsSync(path.join(tmp, "integrations", "me-build.json")), false);
});

test("integration login preserves typed invalid scope failures", async () => {
  const agentContext: AgentContext = {
    agentId: "agent-123",
    serverId: "server-456",
    serverUrl: "https://slock.example",
    token: "secret",
    clientMode: "self-hosted-runner",
    secretSource: "profile-credential-file",
    activeCapabilities: null,
  };
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    env: {} as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (): Promise<ApiResponse<unknown>> => ({
        ok: false,
        status: 400,
        data: null,
        error: "Requested scopes are not allowed for this service",
        errorCode: "INVALID_SCOPE",
      }),
    }) as any,
  });

  await assert.rejects(
    async () => {
      await integrationLoginCommand.handler(ctx, { service: "docs-demo", scope: ["profile"] });
    },
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INVALID_SCOPE");
      assert.match(error.message, /not allowed for this service/);
      return true;
    },
  );
});
