import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";

import { Command } from "commander";

import type { ApiResponse } from "../../client.js";
import type { AgentContext } from "../../auth/env.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { renderError } from "../../core/renderer.js";
import type { IntegrationLoginResponse, RegisteredIntegrationService } from "./_format.js";
import { CleanupOutcome, integrationInvokeCommand, registerIntegrationInvokeCommand } from "./invoke.js";
import { IntegrationV1Error } from "./invokeV1.js";
import type { AgentManifestV0 } from "./manifest.js";
import { validateAgentManifestV1, type AgentManifestV1 } from "./manifestV1.js";

const agentContext: AgentContext = {
  agentId: "agent-123",
  serverId: "server-456",
  serverUrl: "https://slock.example",
  token: "secret",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function service(overrides: Partial<RegisteredIntegrationService> = {}): RegisteredIntegrationService {
  return {
    id: "svc-1",
    clientId: "pr-diff-viewer-3c05bd",
    name: "PR Diff Viewer",
    description: null,
    homepageUrl: "https://pr-diff-viewer.botiverse.workers.dev",
    returnUrl: "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback",
    agentManifestUrl: "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

function manifest(): AgentManifestV0 {
  return {
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api" },
    name: "Botiverse PR Diff Viewer",
    description: "High-performance diff viewer.",
    app_origin: "https://pr-diff-viewer.botiverse.workers.dev",
    auth: {
      type: "login_with_raft",
      login_url: "https://pr-diff-viewer.botiverse.workers.dev/login",
    },
    actions: [{
      name: "render-patch",
      description: "Upload a raw unified diff patch and return a shareable viewer URL.",
      endpoint: { method: "POST", path: "/api/render-patch" },
      parameters: {
        patchText: { type: "string", description: "Raw unified diff text to render", required: true },
        author: { type: "string", description: "Name or identifier of the author", required: false },
      },
      returns: {
        viewerUrl: { type: "string", description: "Shareable URL for the rendered patch" },
      },
    }],
  };
}

function feedbackAdminManifest(endpointPath = "/api/feedback/notes"): AgentManifestV0 {
  return {
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api", base_url: "https://feedback-admin.botiverse.workers.dev" },
    name: "Feedback Admin",
    app_origin: "https://feedback-admin.botiverse.workers.dev",
    auth: {
      type: "login_with_raft",
      login_url: "https://feedback-admin.botiverse.workers.dev/login",
    },
    actions: [{
      name: "add_feedback_note",
      description: "Append a note to a feedback report.",
      endpoint: { method: "POST", path: endpointPath },
      parameters: {
        id: { type: "string", description: "feedback report id", required: true },
        content: { type: "string", description: "Note content", required: true },
      },
      returns: {
        id: { type: "string", description: "New note id" },
      },
    }],
  };
}

function feedbackAdminFileManifest(): AgentManifestV0 {
  return {
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api", base_url: "https://feedback-admin.botiverse.workers.dev" },
    name: "Feedback Admin",
    app_origin: "https://feedback-admin.botiverse.workers.dev",
    auth: {
      type: "login_with_raft",
      login_url: "https://feedback-admin.botiverse.workers.dev/login",
    },
    actions: [{
      name: "download_feedback_transcript",
      description: "Download the trace transcript bundle linked to a feedback report.",
      endpoint: { method: "GET", path: "/api/feedback/transcript" },
      parameters: {
        id: { type: "string", description: "feedback report id", required: true },
      },
      response: { type: "file", description: "gzip binary object streamed from R2" },
    }],
  };
}

function feedbackAdminService(): RegisteredIntegrationService {
  return service({
    id: "svc-feedback-admin",
    clientId: "slock-feedback-admin-58bdf6",
    name: "Feedback Admin",
    homepageUrl: "https://feedback-admin.botiverse.workers.dev",
    returnUrl: "https://feedback-admin.botiverse.workers.dev/login/raft/callback",
    agentManifestUrl: "https://feedback-admin.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
  });
}

function releaseNotesManifest(endpoint: { method: "GET" | "POST"; path: string }): AgentManifestV0 {
  return {
    schema: "slock-agent-manifest.v0",
    execution: { mode: "http_api", base_url: "https://feedback-admin.botiverse.workers.dev" },
    name: "Release App",
    app_origin: "https://feedback-admin.botiverse.workers.dev",
    auth: {
      type: "login_with_raft",
      login_url: "https://feedback-admin.botiverse.workers.dev/login",
    },
    actions: [{
      name: endpoint.method === "POST" ? "release.notes.append" : "release.notes.read",
      description: "Release notes action.",
      endpoint,
      parameters: endpoint.method === "POST"
        ? {
            releaseId: { type: "string", description: "Target release id.", required: true },
            content: { type: "string", description: "Complete release-notes content.", required: true },
            idempotencyKey: { type: "string", description: "Stable revision key.", required: true },
          }
        : {
            releaseId: { type: "string", description: "Target release id.", required: true },
            include: { type: "string", description: "Readback selector.", required: false },
          },
      returns: { receipt: { type: "object", description: "Release notes result." } },
    }],
  };
}

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

function responseWithUrl(body: BodyInit | null, init: ResponseInit, url: string): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

function trackSockets(server: http.Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

function ok<T>(data: T): ApiResponse<T> {
  return { ok: true, status: 200, data, error: null };
}

function loginStartResponse(url: string): Response {
  return responseWithUrl("", {
    status: 302,
    headers: {
      "set-cookie": "oauth-state=state-123; HttpOnly; Path=/; Max-Age=300",
      location: "https://raft.example/login-with-raft/setup",
    },
  }, url);
}

function callbackHeaders(sessionCookie: string): Headers {
  const headers = new Headers({ location: "/" });
  headers.append("set-cookie", "oauth-state=; HttpOnly; Path=/; Max-Age=0");
  headers.append("set-cookie", sessionCookie);
  return headers;
}

async function parseCommand(argv: string[], input: {
  io: CliIo;
  service?: RegisteredIntegrationService;
  loginResponse?: ApiResponse<IntegrationLoginResponse>;
  requests?: Array<{ method: string; path: string; body?: unknown }>;
  profileDir?: string;
}): Promise<void> {
  const program = new Command();
  program.exitOverride();
  const integrationCmd = program.command("integration");
  registerIntegrationInvokeCommand(integrationCmd, {
    io: input.io,
    env: { HOME: input.profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-profile-")) } as NodeJS.ProcessEnv,
    loadAgentContext: () => {
      const profileDir = input.profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-profile-"));
      return {
        ...agentContext,
        profileCredentialPath: path.join(profileDir, "credential.json"),
      };
    },
    createApiClient: () => {
      const requests = input.requests ?? [];
      const registeredService = input.service ?? service();
      return {
        request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
          requests.push({ method, path: requestPath, body });
          if (requestPath === "/internal/agent-api/integrations") {
            return ok({ services: [registeredService], activeLogins: [] });
          }
          if (requestPath === "/internal/agent-api/integrations/login") {
            return input.loginResponse ?? ok({
              status: "already_logged_in",
              service: registeredService,
              scopes: ["identity"],
              requestId: "agent-login-request",
            });
          }
          return { ok: false, status: 404, data: null, error: "not found" };
        },
      } as any;
    },
  });
  await program.parseAsync(["node", "raft", ...argv], { from: "node" });
}

function commandContext(input: {
  io: CliIo;
  service?: RegisteredIntegrationService;
  loginResponse?: ApiResponse<IntegrationLoginResponse>;
  requests?: Array<{ method: string; path: string; body?: unknown }>;
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const requests = input.requests ?? [];
  const registeredService = input.service ?? service();
  const profileDir = input.profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-profile-"));
  const context: AgentContext = {
    ...agentContext,
    profileCredentialPath: path.join(profileDir, "credential.json"),
  };
  return createCommandContext({
    io: input.io,
    env: { HOME: profileDir, ...input.env } as NodeJS.ProcessEnv,
    loadAgentContext: () => context,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path: requestPath, body });
        if (requestPath === "/internal/agent-api/integrations") {
          return ok({ services: [registeredService], activeLogins: [] });
        }
        if (requestPath === "/internal/agent-api/integrations/login") {
          return input.loginResponse ?? ok({
            status: "already_logged_in",
            service: registeredService,
            scopes: ["identity"],
            requestId: "agent-login-request",
          });
        }
        return { ok: false, status: 404, data: null, error: "not found" };
      },
    }) as any,
  });
}

async function withMockFetch<T>(
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
  options: {
    manifest?: ReturnType<typeof manifest>;
    callbackSetCookie?: string;
    actionStatus?: number;
    actionBody?: unknown;
    actionContentType?: string;
    expectedActionBody?: unknown;
  } = {},
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    calls.push({ url: resolvedUrl, init });
    if (resolvedUrl.endsWith("/.well-known/slock-agent-manifest.json")) {
      return responseWithUrl(JSON.stringify(options.manifest ?? manifest()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    const loginUrl = options.manifest?.auth?.login_url ?? manifest().auth?.login_url;
    if (loginUrl && resolvedUrl === loginUrl) {
      assert.equal(init?.redirect, "manual");
      return loginStartResponse(resolvedUrl);
    }
    if (resolvedUrl === "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request") {
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      return responseWithUrl("", {
        status: 302,
        headers: callbackHeaders(options.callbackSetCookie
          ?? "pr-diff-viewer-session=session-123; HttpOnly; Path=/; Max-Age=604800"),
      }, resolvedUrl);
    }
    if (resolvedUrl === "https://pr-diff-viewer.botiverse.workers.dev/api/render-patch") {
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).cookie, "pr-diff-viewer-session=session-123");
      assert.deepEqual(
        JSON.parse(String(init?.body)),
        options.expectedActionBody ?? {
          patchText: "diff --git a/app.ts b/app.ts\n",
          author: "Cardy",
        },
      );
      const actionBody = options.actionBody ?? {
        viewerUrl: "https://pr-diff-viewer.botiverse.workers.dev/view/abc",
      };
      const actionContentType = options.actionContentType ?? "application/json";
      return responseWithUrl(actionContentType.startsWith("text/") && typeof actionBody === "string"
        ? actionBody
        : JSON.stringify(actionBody), {
        status: options.actionStatus ?? 200,
        headers: { "content-type": actionContentType },
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

function v1Manifest(mode: "http_api" | "local_cli" = "http_api"): AgentManifestV1 {
  return validateAgentManifestV1({
    schema: "raft-agent-manifest.v1",
    service: "pr-diff-viewer-3c05bd",
    execution: mode === "http_api"
      ? {
          mode: "http_api",
          base_url: "https://pr-diff-viewer.botiverse.workers.dev/api",
        }
      : { mode: "local_cli" },
    ...(mode === "http_api" ? { auth: { type: "login_with_raft" } } : {}),
    actions: mode === "http_api"
      ? [{
          name: "get_status",
          endpoint: { method: "GET", path: "/status" },
          request: {},
          authority: {
            principal: "agent_session",
            required_scopes: ["status:read"],
          },
          effect: "read",
          input_schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          output_schema: {
            type: "object",
            required: ["status"],
            properties: {
              status: { const: "ready" },
            },
            additionalProperties: false,
          },
          idempotency: { mode: "safe" },
          readback: { mode: "not_applicable" },
          rollback: { mode: "not_applicable" },
        }]
      : [],
  });
}

async function withV1Fetch<T>(
  manifestValue: AgentManifestV1,
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    calls.push({ url: resolvedUrl, init });
    if (resolvedUrl.endsWith("/.well-known/slock-agent-manifest.json")) {
      return responseWithUrl(JSON.stringify(manifestValue), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    if (resolvedUrl === "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request") {
      return responseWithUrl("", {
        status: 302,
        headers: {
          "set-cookie": "v1-session=v1-session-secret; HttpOnly; Secure; Path=/; Max-Age=600",
          location: "/",
        },
      }, resolvedUrl);
    }
    if (resolvedUrl === "https://pr-diff-viewer.botiverse.workers.dev/api/status") {
      return responseWithUrl(JSON.stringify({ status: "ready" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-request-id": "v1-request",
        },
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

function writeStoredV1Session(profileDir: string, cookiePath = "/"): void {
  const integrationsDir = path.join(profileDir, "integrations");
  fs.mkdirSync(integrationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(integrationsDir, "pr-diff-viewer-3c05bd.json"),
    JSON.stringify({
      serviceId: "svc-1",
      clientId: "pr-diff-viewer-3c05bd",
      returnUrl: "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback",
      cookies: [{
        pair: "v1-session=preflight-secret",
        host: "pr-diff-viewer.botiverse.workers.dev",
        path: cookiePath,
        secure: true,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

function writeStoredV0Session(profileDir: string, host: string): void {
  const integrationsDir = path.join(profileDir, "integrations");
  fs.mkdirSync(integrationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(integrationsDir, "pr-diff-viewer-3c05bd.json"),
    JSON.stringify({
      serviceId: "svc-1",
      clientId: "pr-diff-viewer-3c05bd",
      returnUrl: "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback",
      cookies: [{
        pair: "legacy-session=proxy-secret",
        host,
        path: "/",
        secure: false,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

async function withManifestResponse<T>(
  response: (url: string) => Response,
  fn: (calls: string[]) => Promise<T>,
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    calls.push(resolvedUrl);
    return response(resolvedUrl);
  }) as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function withFeedbackAdminFetch<T>(
  fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<T>,
  options: {
    manifest?: AgentManifestV0;
  } = {},
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    calls.push({ url: resolvedUrl, init });
    if (resolvedUrl.endsWith("/.well-known/slock-agent-manifest.json")) {
      return responseWithUrl(JSON.stringify(options.manifest ?? feedbackAdminManifest()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    const loginUrl = options.manifest?.auth?.login_url ?? feedbackAdminManifest().auth?.login_url;
    if (loginUrl && resolvedUrl === loginUrl) {
      assert.equal(init?.redirect, "manual");
      return loginStartResponse(resolvedUrl);
    }
    if (resolvedUrl === "https://feedback-admin.botiverse.workers.dev/login/raft/callback?code=agent-login-request") {
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      return responseWithUrl("", {
        status: 302,
        headers: callbackHeaders("feedback-admin-session=session-123; HttpOnly; Path=/; Max-Age=604800"),
      }, resolvedUrl);
    }
    const actionUrl = new URL(resolvedUrl);
    const pathMatch = /^\/api\/feedback\/([^/]+)\/notes$/.exec(actionUrl.pathname);
    if (
      actionUrl.origin === "https://feedback-admin.botiverse.workers.dev"
      && (actionUrl.pathname === "/api/feedback/notes" || pathMatch)
    ) {
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).cookie, "feedback-admin-session=session-123");
      assert.equal(actionUrl.searchParams.get("id") ?? pathMatch?.[1], "d3d2c6e1-b355-4bb5-aed2-a565bc775d2f");
      assert.equal(JSON.parse(String(init?.body)).content, "test note");
      return responseWithUrl(JSON.stringify({ id: "note-1" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    const releaseNotesPath = /^\/api\/releases\/([^/]+)\/notes$/.exec(actionUrl.pathname);
    if (actionUrl.origin === "https://feedback-admin.botiverse.workers.dev" && releaseNotesPath) {
      assert.equal((init?.headers as Record<string, string>).cookie, "feedback-admin-session=session-123");
      assert.equal(actionUrl.searchParams.has("releaseId"), false);
      if (init?.method === "POST") {
        assert.deepEqual(JSON.parse(String(init.body)), {
          content: "v1.10.0 release notes",
          idempotencyKey: "v1.10.0-notes-revision-1",
        });
        return responseWithUrl(JSON.stringify({ receipt: { revision: 1, idempotentReplay: false } }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }, resolvedUrl);
      }
      assert.equal(init?.method, "GET");
      assert.equal(actionUrl.searchParams.get("include"), "revisions");
      assert.deepEqual([...actionUrl.searchParams.keys()], ["include"]);
      return responseWithUrl(JSON.stringify({ revisions: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
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

async function withFeedbackAdminFileFetch<T>(
  fn: (calls: Array<{ url: string; init?: RequestInit }>, filePath: string) => Promise<T>,
  options: {
    manifest?: AgentManifestV0;
    outputPath?: string;
    status?: number;
    omitContentType?: boolean;
    contentType?: string;
    contentDisposition?: string | null;
    responseBody?: BodyInit | null;
    contentLength?: string;
  } = {},
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const binaryBody = Buffer.from("1f8b0800000000000000", "hex");
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    calls.push({ url: resolvedUrl, init });
    if (resolvedUrl.endsWith("/.well-known/slock-agent-manifest.json")) {
      return responseWithUrl(JSON.stringify(options.manifest ?? feedbackAdminFileManifest()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    const loginUrl = options.manifest?.auth?.login_url ?? feedbackAdminFileManifest().auth?.login_url;
    if (loginUrl && resolvedUrl === loginUrl) {
      assert.equal(init?.redirect, "manual");
      return loginStartResponse(resolvedUrl);
    }
    if (resolvedUrl === "https://feedback-admin.botiverse.workers.dev/login/raft/callback?code=agent-login-request") {
      assert.equal(new Headers(init?.headers).get("cookie"), null);
      return responseWithUrl("", {
        status: 302,
        headers: callbackHeaders("feedback-admin-session=session-123; HttpOnly; Path=/; Max-Age=604800"),
      }, resolvedUrl);
    }
    const actionUrl = new URL(resolvedUrl);
    if (
      actionUrl.origin === "https://feedback-admin.botiverse.workers.dev"
      && actionUrl.pathname === "/api/feedback/transcript"
    ) {
      assert.equal(init?.method, "GET");
      assert.equal((init?.headers as Record<string, string>).cookie, "feedback-admin-session=session-123");
      assert.equal(actionUrl.searchParams.get("id"), "d3d2c6e1-b355-4bb5-aed2-a565bc775d2f");
      assert.equal((init?.headers as Record<string, string>).accept, "*/*");
      const headers: Record<string, string> = {};
      if (!options.omitContentType) {
        headers["content-type"] = options.contentType ?? "application/gzip";
      }
      if (options.contentDisposition !== null) {
        headers["content-disposition"] = options.contentDisposition ?? "attachment; filename=\"transcript.jsonl.gz\"";
      }
      if (options.contentLength !== undefined) {
        headers["content-length"] = options.contentLength;
      }
      return responseWithUrl(options.responseBody !== undefined ? options.responseBody : binaryBody, {
        status: options.status ?? 200,
        headers,
      }, resolvedUrl);
    }
    return responseWithUrl("not found", { status: 404 }, resolvedUrl);
  }) as typeof fetch;
  try {
    return await fn(calls, options.outputPath ?? "");
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("integration invoke sends feedback-admin id in URL and param content in POST JSON body", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withFeedbackAdminFetch(async (fetchCalls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "add_feedback_note",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
      "--param",
      "content=test note",
    ], {
      io,
      requests,
      service: feedbackAdminService(),
    });

    assert.deepEqual(fetchCalls.map((call) => call.url), [
      "https://feedback-admin.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      "https://feedback-admin.botiverse.workers.dev/login/raft/callback?code=agent-login-request",
      "https://feedback-admin.botiverse.workers.dev/api/feedback/notes?id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    ]);
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/login",
      body: { service: "slock-feedback-admin-58bdf6", scopes: undefined, target: undefined },
    },
  ]);
  assert.match(stdout.join(""), /Action invoked: add_feedback_note/);
});

test("integration invoke sends feedback-admin id in URL and data-json content in POST body", async () => {
  const { io } = memoryIo();

  await withFeedbackAdminFetch(async (fetchCalls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "add_feedback_note",
      "--data-json",
      JSON.stringify({
        id: "d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
        content: "test note",
      }),
    ], {
      io,
      service: feedbackAdminService(),
    });

    assert.equal(
      fetchCalls.at(-1)?.url,
      "https://feedback-admin.botiverse.workers.dev/api/feedback/notes?id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    );
  });
});

test("integration invoke sends feedback-admin id in URL and data-file content in POST body", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-feedback-admin-"));
  const dataPath = path.join(tmp, "note.json");
  fs.writeFileSync(dataPath, JSON.stringify({
    id: "d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    content: "test note",
  }), "utf8");
  const { io } = memoryIo();

  await withFeedbackAdminFetch(async (fetchCalls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "add_feedback_note",
      "--data-file",
      dataPath,
    ], {
      io,
      service: feedbackAdminService(),
    });

    assert.equal(
      fetchCalls.at(-1)?.url,
      "https://feedback-admin.botiverse.workers.dev/api/feedback/notes?id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    );
  });
});

test("integration invoke writes a file-response action to a temporary file and prints the path", async () => {
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async (fetchCalls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    ], {
      io,
      service: feedbackAdminService(),
    });

    assert.equal(
      fetchCalls.at(-1)?.url,
      "https://feedback-admin.botiverse.workers.dev/api/feedback/transcript?id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    );
  });

  const output = stdout.join("");
  assert.match(output, /Action invoked: download_feedback_transcript/);
  assert.match(output, /file: .*transcript\.jsonl\.gz/);
  assert.match(output, /content type: application\/gzip/);
  assert.match(output, /size: 10 bytes/);
});

test("integration invoke preserves and redacts structured errors from file-response actions without writing a file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-file-error-"));
  const outputPath = path.join(tmp, "must-not-exist.jsonl.gz");
  const { io, stdout, stderr } = memoryIo();
  const body = JSON.stringify({
    error: {
      code: "TRANSCRIPT_NOT_READY",
      message: "transcript is still processing",
      details: {
        apiKey: "plain-secret-value",
        observed: "sk_daemon_super-secret",
      },
    },
  });

  await withFeedbackAdminFileFetch(async () => {
    await assert.rejects(
      () => parseCommand([
        "integration",
        "invoke",
        "--service",
        "slock-feedback-admin-58bdf6",
        "--action",
        "download_feedback_transcript",
        "--param",
        "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
        "--output",
        outputPath,
      ], {
        io,
        service: feedbackAdminService(),
      }),
      /CliExit\(1\)/,
    );
  }, {
    status: 409,
    contentType: "application/problem+json; charset=utf-8",
    responseBody: body,
  });

  assert.deepEqual(stdout, []);
  assert.equal(
    stderr.join(""),
    "Error: service action failed (HTTP 409); response body: "
      + '{"error":{"code":"TRANSCRIPT_NOT_READY","message":"transcript is still processing","details":{"apiKey":"<redacted>","observed":"sk_daemon_<redacted>"}}}\n'
      + "Code: INTEGRATION_INVOKE_FAILED\n",
  );
  assert.doesNotMatch(stderr.join(""), /\[object Object\]|plain-secret-value|super-secret/);
  assert.equal(fs.existsSync(outputPath), false);
});

test("integration invoke recursively redacts a structured file-response error with missing Content-Type and writes no file", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-file-error-no-type-"));
  const outputPath = path.join(tmp, "must-not-exist.jsonl.gz");
  const { io, stderr } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await assert.rejects(
      () => parseCommand([
        "integration",
        "invoke",
        "--service",
        "slock-feedback-admin-58bdf6",
        "--action",
        "download_feedback_transcript",
        "--param",
        "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
        "--output",
        outputPath,
      ], {
        io,
        service: feedbackAdminService(),
      }),
      /CliExit\(1\)/,
    );
  }, {
    status: 422,
    omitContentType: true,
    responseBody: JSON.stringify({ error: { apiKey: "plain-secret-value" } }),
  });

  assert.equal(
    stderr.join(""),
    'Error: service action failed (HTTP 422); response body: {"error":{"apiKey":"<redacted>"}}\n'
      + "Code: INTEGRATION_INVOKE_FAILED\n",
  );
  assert.doesNotMatch(stderr.join(""), /plain-secret-value/);
  assert.equal(fs.existsSync(outputPath), false);
});

test("integration invoke writes a file-response action to --output path", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-file-output-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
      "--output",
      outputPath,
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, { outputPath });

  assert.ok(fs.existsSync(outputPath), "output file should exist");
  assert.equal(fs.readFileSync(outputPath).toString("hex"), "1f8b0800000000000000");
  assert.match(stdout.join(""), new RegExp(`file: ${outputPath.replace(/[\\/]/g, "[\\\\/]")}`));
});

test("integration invoke emits file path in JSON mode for file-response actions", async () => {
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
      "--json",
    ], {
      io,
      service: feedbackAdminService(),
    });
  });

  const parsed = JSON.parse(stdout.join(""));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.action, "download_feedback_transcript");
  assert.equal(parsed.data.contentType, "application/gzip");
  assert.equal(parsed.data.size, 10);
  assert.equal(parsed.data.created, false);
  assert.equal(parsed.data.overwritten, false);
  assert.equal(parsed.data.unknown, true);
  assert.equal(parsed.data.dirCreated, true);
  assert.ok(typeof parsed.data.dirCreatedPath === "string");
  assert.equal(parsed.data.dirCleaned, false);
  assert.equal(parsed.data.tempDirCreated, true);
  assert.equal(parsed.data.tempDirCleaned, true);
  assert.equal(parsed.data.cleanupFailed, false);
  assert.ok(typeof parsed.data.filePath === "string");
});

test("integration invoke file response creates private default temp directory and file", async () => {
  const { io, stdout } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  try {
    await withFeedbackAdminFileFetch(async () => {
      await parseCommand([
        "integration",
        "invoke",
        "--service",
        "slock-feedback-admin-58bdf6",
        "--action",
        "download_feedback_transcript",
        "--param",
        "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
        "--json",
      ], {
        io,
        service: feedbackAdminService(),
      });
    });

    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.ok, true);
    const filePath: string = parsed.data.filePath;
    const dirPath = path.dirname(filePath);

    assert.ok(fs.existsSync(filePath), "downloaded file should exist");
    assert.ok(fs.existsSync(dirPath), "default temp directory should exist");
    const dirStats = fs.statSync(dirPath);
    const fileStats = fs.statSync(filePath);
    assert.equal(dirStats.mode & 0o777, 0o700, "default temp directory should be private (0700)");
    assert.equal(fileStats.mode & 0o777, 0o600, "downloaded file should be private (0600)");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("integration invoke rejects v0 array and object fields passed through text --param before login", async () => {
  for (const declaredType of ["array", "object"] as const) {
    const typedManifest = manifest();
    typedManifest.actions = [{
      name: "render-patch",
      endpoint: { method: "POST", path: "/api/render-patch" },
      parameters: {
        structured_input: { type: declaredType, required: true },
      },
    }];
    const { io, stderr } = memoryIo();
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];

    await withMockFetch(async (calls) => {
      await assert.rejects(
        () => parseCommand([
          "integration",
          "invoke",
          "--service",
          "pr-diff-viewer-3c05bd",
          "--action",
          "render-patch",
          "--param",
          `structured_input=${declaredType === "array" ? '["cli-binary"]' : '{"enabled":true}'}`,
        ], { io, requests }),
        /CliExit\(1\)/,
      );
      assert.match(stderr.join(""), /--param structured_input is text-only/);
      assert.match(stderr.join(""), new RegExp(`manifest declares ${declaredType}`));
      assert.match(stderr.join(""), /use --data-json or --data-file for typed JSON/);
      assert.match(stderr.join(""), /Code: INVALID_ARG/);
      assert.deepEqual(calls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      ]);
    }, { manifest: typedManifest });

    assert.deepEqual(requests, [
      { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    ]);
  }
});

test("integration invoke preserves typed v0 arrays and objects from --data-json", async () => {
  const typedManifest = manifest();
  typedManifest.actions = [{
    name: "render-patch",
    endpoint: { method: "POST", path: "/api/render-patch" },
    parameters: {
      enabled_product_types: { type: "array", required: true },
      channel_options: { type: "object", required: true },
    },
  }];
  const expectedActionBody = {
    enabled_product_types: ["cli-binary"],
    channel_options: { stable: false },
  };
  const { io } = memoryIo();

  await withMockFetch(async (calls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "pr-diff-viewer-3c05bd",
      "--action",
      "render-patch",
      "--data-json",
      JSON.stringify(expectedActionBody),
    ], { io });

    assert.equal(calls.at(-1)?.url, "https://pr-diff-viewer.botiverse.workers.dev/api/render-patch");
    assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), expectedActionBody);
  }, { manifest: typedManifest, expectedActionBody });
});

test("integration invoke help identifies --param as text-only and points structured fields to typed JSON", () => {
  const program = new Command();
  const integration = program.command("integration");
  registerIntegrationInvokeCommand(integration);
  const invoke = integration.commands.find((candidate) => candidate.name() === "invoke");

  assert.ok(invoke);
  let help = "";
  invoke.configureOutput({
    writeOut: (chunk) => { help += chunk; },
    writeErr: (chunk) => { help += chunk; },
  });
  invoke.outputHelp();
  assert.match(help, /--param <key=value>[\s\S]*Text action parameter/);
  assert.match(help, /Use\s+--data-json\/--data-file for array or object\s+fields/);
});

test("integration invoke file response rejects non-POSIX platform for default temp", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.match(err.message, /private file permissions are not supported/);
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreatedPath, undefined);
        return true;
      },
    );
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("integration invoke file response creates private file under explicit --output", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-output-perms-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  try {
    await withFeedbackAdminFileFetch(async () => {
      await parseCommand([
        "integration",
        "invoke",
        "--service",
        "slock-feedback-admin-58bdf6",
        "--action",
        "download_feedback_transcript",
        "--param",
        "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
        "--output",
        outputPath,
      ], {
        io,
        service: feedbackAdminService(),
      });
    }, { outputPath });

    assert.ok(fs.existsSync(outputPath), "output file should exist");
    const outputStats = fs.statSync(outputPath);
    assert.equal(outputStats.mode & 0o777, 0o600, "explicit output file should still be private (0600)");
    // Parent directory is user-controlled; we must not alter its permissions.
    const parentStats = fs.statSync(tmp);
    assert.equal(parentStats.mode & 0o777, 0o700, "user-controlled parent directory should retain its original mode");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("integration invoke file response enforces private mode even under restrictive umask", async () => {
  const { io, stdout } = memoryIo();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-profile-"));
  const integrationsDir = path.join(profileDir, "integrations");
  fs.mkdirSync(integrationsDir, { recursive: true });
  fs.writeFileSync(
    path.join(integrationsDir, "slock-feedback-admin-58bdf6.json"),
    JSON.stringify({
      serviceId: "service-slock-feedback-admin",
      clientId: "slock-feedback-admin-58bdf6",
      returnUrl: "https://feedback-admin.botiverse.workers.dev/login/raft/callback",
      cookies: [{
        pair: "session=valid",
        host: "feedback-admin.botiverse.workers.dev",
        path: "/",
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const previousUmask = process.umask(0o777);
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });

  try {
    await withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService(), profileDir }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          json: true,
        },
      );
    });

    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.ok, true);
    const filePath: string = parsed.data.filePath;
    const dirPath = path.dirname(filePath);

    assert.ok(fs.existsSync(filePath), "downloaded file should exist");
    assert.ok(fs.existsSync(dirPath), "default temp directory should exist");
    assert.equal(fs.statSync(dirPath).mode & 0o777, 0o700, "directory mode should override umask");
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, "file mode should override umask");
  } finally {
    process.umask(previousUmask);
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  }
});

test("integration invoke file response cleans up default temp dir when chmod fails", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalChmodSync = fs.chmodSync.bind(fs);
  const mutableFs = fs as unknown as { chmodSync: typeof fs.chmodSync };
  let failedPath: string | null = null;
  mutableFs.chmodSync = ((filepath: fs.PathLike, mode: fs.Mode) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith("raft-integration-invoke-")) {
      failedPath = resolved;
      throw new Error("chmod failed");
    }
    return originalChmodSync(filepath, mode);
  }) as typeof fs.chmodSync;
  const restore = () => { mutableFs.chmodSync = originalChmodSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.dirCreatedPath, failedPath);
        assert.equal(err.effect_state?.dirCleaned, true);
        assert.equal(err.effect_state?.retainedParentDirs, undefined);
        assert.equal(err.effect_state?.retainedTempArtifacts, undefined);
        return true;
      },
    );
    assert.ok(failedPath !== null, "chmod should have been called on default temp dir");
    assert.ok(!fs.existsSync(failedPath), "default temp dir should be removed after failed chmod");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
  }
});

test("integration invoke file response reports default temp dir retained when chmod and cleanup fail", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalChmodSync = fs.chmodSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { chmodSync: typeof fs.chmodSync; rmSync: typeof fs.rmSync };
  let chmodCalled = false;
  let retainedPath: string | null = null;
  mutableFs.chmodSync = ((filepath: fs.PathLike, mode: fs.Mode) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith("raft-integration-invoke-")) {
      chmodCalled = true;
      throw new Error("chmod failed");
    }
    return originalChmodSync(filepath, mode);
  }) as typeof fs.chmodSync;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes("raft-integration-invoke-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => {
    mutableFs.chmodSync = originalChmodSync;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            json: true,
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.dirCreatedPath, retainedPath);
        assert.deepEqual(err.effect_state?.retainedParentDirs, [retainedPath]);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.deepEqual(err.effect_state?.retainedTempArtifacts, [retainedPath]);
        return true;
      },
    );
    assert.ok(chmodCalled, "chmod should have been called on default temp dir");
    assert.ok(retainedPath !== null, "rmSync should have been called on default temp dir");
    assert.ok(fs.existsSync(retainedPath), "default temp dir should be retained after failed cleanup");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    if (retainedPath && fs.existsSync(retainedPath)) {
      fs.rmSync(retainedPath, { recursive: true, force: true });
    }
  }
});

test("integration invoke file response reports staging temp dir retained when chmod and cleanup fail", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-staging-chmod-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalChmodSync = fs.chmodSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { chmodSync: typeof fs.chmodSync; rmSync: typeof fs.rmSync };
  let chmodCalled = false;
  let retainedPath: string | null = null;
  mutableFs.chmodSync = ((filepath: fs.PathLike, mode: fs.Mode) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      chmodCalled = true;
      throw new Error("chmod failed");
    }
    return originalChmodSync(filepath, mode);
  }) as typeof fs.chmodSync;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => {
    mutableFs.chmodSync = originalChmodSync;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
            json: true,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.ok(
          err.effect_state?.retainedTempArtifacts?.includes(retainedPath ?? ""),
          "receipt must locate the retained staging temp dir",
        );
        return true;
      },
    );
    assert.ok(chmodCalled, "chmod should have been called on staging temp dir");
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    assert.ok(fs.existsSync(retainedPath), "staging temp dir should be retained after failed cleanup");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response reports staging temp dir retained when temp file fchmod and cleanup fail", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-file-fchmod-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalFchmodSync = fs.fchmodSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { fchmodSync: typeof fs.fchmodSync; rmSync: typeof fs.rmSync };
  let retainedPath: string | null = null;
  mutableFs.fchmodSync = ((_fd: number, _mode: fs.Mode) => {
    throw new Error("fchmod failed");
  }) as typeof fs.fchmodSync;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => {
    mutableFs.fchmodSync = originalFchmodSync;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
            json: true,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.tempFileCreated, true);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.ok(
          err.effect_state?.retainedTempArtifacts?.includes(retainedPath ?? ""),
          "receipt must locate the retained temp file artifact",
        );
        return true;
      },
    );
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    assert.ok(fs.existsSync(retainedPath), "staging temp dir should be retained after failed cleanup");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response cleans up default temp dir when statSync postcondition fails", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalStatSync = fs.statSync.bind(fs);
  const mutableFs = fs as unknown as { statSync: typeof fs.statSync };
  let failedPath: string | null = null;
  mutableFs.statSync = ((filepath: fs.PathLike, options?: fs.StatOptions) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith("raft-integration-invoke-")) {
      failedPath = resolved;
      throw new Error("stat postcondition failed");
    }
    return originalStatSync(filepath, options);
  }) as typeof fs.statSync;
  const restore = () => { mutableFs.statSync = originalStatSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.dirCreatedPath, failedPath);
        assert.equal(err.effect_state?.dirCleaned, true);
        assert.equal(err.effect_state?.retainedParentDirs, undefined);
        assert.equal(err.effect_state?.retainedTempArtifacts, undefined);
        return true;
      },
    );
    assert.ok(failedPath !== null, "statSync should have been called on default temp dir");
    assert.ok(!fs.existsSync(failedPath), "default temp dir should be removed after failed statSync");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
  }
});

test("integration invoke file response reports default temp dir retained when statSync and cleanup fail", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalStatSync = fs.statSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { statSync: typeof fs.statSync; rmSync: typeof fs.rmSync };
  let statCalled = false;
  let retainedPath: string | null = null;
  mutableFs.statSync = ((filepath: fs.PathLike, options?: fs.StatOptions) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith("raft-integration-invoke-")) {
      statCalled = true;
      throw new Error("stat postcondition failed");
    }
    return originalStatSync(filepath, options);
  }) as typeof fs.statSync;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes("raft-integration-invoke-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => {
    mutableFs.statSync = originalStatSync;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            json: true,
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.deepEqual(err.effect_state?.retainedTempArtifacts, [retainedPath]);
        return true;
      },
    );
    assert.ok(statCalled, "statSync should have been called on default temp dir");
    assert.ok(retainedPath !== null, "rmSync should have been called on default temp dir");
    assert.ok(fs.existsSync(retainedPath), "default temp dir should be retained after failed cleanup");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    if (retainedPath && fs.existsSync(retainedPath)) {
      fs.rmSync(retainedPath, { recursive: true, force: true });
    }
  }
});

test("integration invoke file response cleans up default temp dir when staging mkdir fails", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  const mutableFs = fs as unknown as { mkdirSync: typeof fs.mkdirSync };
  let mkdirCalled = false;
  mutableFs.mkdirSync = ((filepath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      mkdirCalled = true;
      throw new Error("staging mkdir failed");
    }
    return originalMkdirSync(filepath, options);
  }) as typeof fs.mkdirSync;
  const restore = () => { mutableFs.mkdirSync = originalMkdirSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.dirCleaned, true);
        assert.equal(err.effect_state?.retainedParentDirs, undefined);
        assert.ok(!err.effect_state?.tempDirCreated, "tempDirCreated should be unset");
        return true;
      },
    );
    assert.ok(mkdirCalled, "mkdirSync should have been called on staging temp dir");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
  }
});

test("integration invoke file response reports default temp dir retained when staging mkdir fails and cleanup fails", async () => {
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { mkdirSync: typeof fs.mkdirSync; rmSync: typeof fs.rmSync };
  let mkdirCalled = false;
  let retainedPath: string | null = null;
  mutableFs.mkdirSync = ((filepath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      mkdirCalled = true;
      throw new Error("staging mkdir failed");
    }
    return originalMkdirSync(filepath, options);
  }) as typeof fs.mkdirSync;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (path.basename(str).startsWith("raft-integration-invoke-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => {
    mutableFs.mkdirSync = originalMkdirSync;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          },
        );
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.equal(err.effect_state?.dirCleaned, undefined);
        assert.deepEqual(err.effect_state?.retainedParentDirs, [retainedPath]);
        return true;
      },
    );
    assert.ok(mkdirCalled, "mkdirSync should have been called on staging temp dir");
    assert.ok(retainedPath !== null, "rmSync should have been called on default temp dir");
    assert.ok(fs.existsSync(retainedPath), "default temp dir should be retained after failed cleanup");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    if (retainedPath && fs.existsSync(retainedPath)) {
      fs.rmSync(retainedPath, { recursive: true, force: true });
    }
  }
});

test("integration invoke file response retains explicit output ancestor when staging mkdir fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-explicit-ancestor-"));
  const outputPath = path.join(tmp, "new", "nested", "transcript.jsonl.gz");
  const parentDir = path.dirname(outputPath);
  // mkdirSync(..., { recursive: true }) returns the first directory created,
  // which for `tmp/new/nested` is `tmp/new`.
  const firstCreatedAncestor = path.join(tmp, "new");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  const mutableFs = fs as unknown as { mkdirSync: typeof fs.mkdirSync };
  let stagingMkdirCalled = false;
  let mkdirCalledForParent = false;
  mutableFs.mkdirSync = ((filepath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      stagingMkdirCalled = true;
      throw new Error("staging mkdir failed");
    }
    if (resolved === parentDir) {
      mkdirCalledForParent = true;
    }
    const result = originalMkdirSync(filepath, options);
    if (resolved === parentDir) {
      // Simulate concurrent/user data written after ancestor creation but before
      // staging mkdir failure; the CLI must not recursively delete this ancestor.
      fs.writeFileSync(path.join(firstCreatedAncestor, "concurrent-user-data.txt"), "user data");
    }
    return result;
  }) as typeof fs.mkdirSync;
  const restore = () => { mutableFs.mkdirSync = originalMkdirSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.dirCleaned, undefined);
        assert.deepEqual(err.effect_state?.retainedParentDirs, [firstCreatedAncestor]);
        return true;
      },
    );
    assert.ok(stagingMkdirCalled, "mkdirSync should have been called on staging temp dir");
    assert.ok(mkdirCalledForParent, "mkdirSync should have been called for explicit output parent");
    assert.ok(fs.existsSync(firstCreatedAncestor), "explicit output ancestor should be retained");
    assert.ok(fs.existsSync(path.join(firstCreatedAncestor, "concurrent-user-data.txt")), "user data inside ancestor should survive");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response reports partial effect when recursive output mkdir fails after creating ancestor", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-recursive-mkdir-partial-"));
  const outputPath = path.join(tmp, "created", "nested", "transcript.jsonl.gz");
  const parentDir = path.dirname(outputPath);
  const firstCreatedAncestor = path.join(tmp, "created");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalMkdirSync = fs.mkdirSync.bind(fs);
  const mutableFs = fs as unknown as { mkdirSync: typeof fs.mkdirSync };
  let mkdirCalledForParent = false;
  mutableFs.mkdirSync = ((filepath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }) => {
    const resolved = path.resolve(String(filepath));
    if (resolved === parentDir) {
      mkdirCalledForParent = true;
      // Simulate recursive mkdir creating the first missing ancestor before
      // failing (e.g. ENAMETOOLONG on a deeply nested component).
      fs.mkdirSync(firstCreatedAncestor, { recursive: true });
      throw new Error("recursive mkdir failed after partial ancestor creation");
    }
    return originalMkdirSync(filepath, options);
  }) as typeof fs.mkdirSync;
  const restore = () => { mutableFs.mkdirSync = originalMkdirSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.dirCreated, true);
        assert.equal(err.effect_state?.dirCreatedPath, firstCreatedAncestor);
        assert.equal(err.effect_state?.dirCleaned, undefined);
        assert.deepEqual(err.effect_state?.retainedParentDirs, [firstCreatedAncestor]);
        return true;
      },
    );
    assert.ok(mkdirCalledForParent, "mkdirSync should have been called for explicit output parent");
    assert.ok(fs.existsSync(firstCreatedAncestor), "created ancestor should be retained after recursive mkdir failure");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response cleans up staging temp dir when chmod fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-staging-cleanup-ok-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalChmodSync = fs.chmodSync.bind(fs);
  const mutableFs = fs as unknown as { chmodSync: typeof fs.chmodSync };
  let chmodCalled = false;
  mutableFs.chmodSync = ((filepath: fs.PathLike, mode: fs.Mode) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      chmodCalled = true;
      throw new Error("chmod failed");
    }
    return originalChmodSync(filepath, mode);
  }) as typeof fs.chmodSync;
  const restore = () => { mutableFs.chmodSync = originalChmodSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.tempDirCleaned, true);
        assert.equal(err.effect_state?.retainedTempArtifacts, undefined);
        return true;
      },
    );
    assert.ok(chmodCalled, "chmod should have been called on staging temp dir");
    const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
    assert.deepEqual(leftovers, [], "staging temp dir should be removed after failed chmod");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response cleans up staging temp dir when statSync postcondition fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-staging-stat-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalStatSync = fs.statSync.bind(fs);
  const mutableFs = fs as unknown as { statSync: typeof fs.statSync };
  let statCalled = false;
  mutableFs.statSync = ((filepath: fs.PathLike, options?: fs.StatOptions) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      statCalled = true;
      throw new Error("stat postcondition failed");
    }
    return originalStatSync(filepath, options);
  }) as typeof fs.statSync;
  const restore = () => { mutableFs.statSync = originalStatSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.tempDirCleaned, true);
        assert.equal(err.effect_state?.retainedTempArtifacts, undefined);
        return true;
      },
    );
    assert.ok(statCalled, "statSync should have been called on staging temp dir");
    const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
    assert.deepEqual(leftovers, [], "staging temp dir should be removed after failed statSync");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response cleans up temp file when fchmod fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-file-cleanup-ok-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalFchmodSync = fs.fchmodSync.bind(fs);
  const mutableFs = fs as unknown as { fchmodSync: typeof fs.fchmodSync };
  mutableFs.fchmodSync = ((_fd: number, _mode: fs.Mode) => {
    throw new Error("fchmod failed");
  }) as typeof fs.fchmodSync;
  const restore = () => { mutableFs.fchmodSync = originalFchmodSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.tempDirCleaned, true);
        assert.equal(err.effect_state?.tempFileCreated, true);
        assert.ok(typeof err.effect_state?.tempFilePath === "string");
        assert.equal(err.effect_state?.retainedTempArtifacts, undefined);
        return true;
      },
    );
    const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
    assert.deepEqual(leftovers, [], "temp file and staging dir should be removed after failed fchmod");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response cleans up temp file when fstatSync postcondition fails", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-file-fstat-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalFstatSync = fs.fstatSync.bind(fs);
  const mutableFs = fs as unknown as { fstatSync: typeof fs.fstatSync };
  mutableFs.fstatSync = ((_fd: number, options?: fs.StatOptions) => {
    throw new Error("fstat postcondition failed");
  }) as typeof fs.fstatSync;
  const restore = () => { mutableFs.fstatSync = originalFstatSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_FAILED");
        assert.equal(err.fault_domain, "file_write:prepare");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.tempDirCleaned, true);
        assert.equal(err.effect_state?.tempFileCreated, true);
        assert.ok(typeof err.effect_state?.tempFilePath === "string");
        assert.equal(err.effect_state?.retainedTempArtifacts, undefined);
        return true;
      },
    );
    const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
    assert.deepEqual(leftovers, [], "temp file and staging dir should be removed after failed fstatSync");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response does not retry cleanup after a single rmSync failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-once-cleanup-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  const originalChmodSync = fs.chmodSync.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { chmodSync: typeof fs.chmodSync; rmSync: typeof fs.rmSync };
  let rmCalls = 0;
  let retainedPath: string | null = null;
  mutableFs.chmodSync = ((filepath: fs.PathLike, mode: fs.Mode) => {
    const resolved = path.resolve(String(filepath));
    if (path.basename(resolved).startsWith(".raft-invoke-write-")) {
      throw new Error("chmod failed");
    }
    return originalChmodSync(filepath, mode);
  }) as typeof fs.chmodSync;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      rmCalls += 1;
      retainedPath = str;
      throw new Error("rmSync failed once");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => {
    mutableFs.chmodSync = originalChmodSync;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.ok(
          err.effect_state?.retainedTempArtifacts?.includes(retainedPath ?? ""),
          "receipt must locate the retained artifact",
        );
        return true;
      },
    );
    assert.equal(rmCalls, 1, "cleanup should attempt rmSync exactly once");
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    assert.ok(fs.existsSync(retainedPath), "artifact should remain because cleanup was not retried");
  } finally {
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response rejects declared size exceeding maxBytes before streaming", async () => {
  const { io } = memoryIo();
  const tmpPrefix = path.join(os.tmpdir(), "raft-integration-invoke-");
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("raft-integration-invoke-")));

  await assert.rejects(
    withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
        },
      );
    }, { responseBody: Buffer.from("tiny"), contentLength: String(100 * 1024 * 1024 + 1) }),
    (err: unknown) => {
      if (!(err instanceof CliError)) return false;
      assert.equal(err.code, "LOCAL_WRITE_SIZE_EXCEEDED");
      assert.equal(err.fault_domain, "file_write:size_limit");
      assert.equal(err.effect_state?.targetCommitted, false);
      assert.equal(err.effect_state?.dirCreatedPath, undefined);
      assert.equal(err.effect_state?.retainedParentDirs, undefined);
      assert.equal(err.effect_state?.unknown, true);
      assert.match(err.message, /declared size/);
      assert.match(err.message, /exceeds maximum/);
      return true;
    },
  );

  const after = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("raft-integration-invoke-"));
  const leaked = after.filter((name) => !before.has(name));
  assert.deepStrictEqual(leaked, [], `default temp directories should not be created during preflight rejection (${tmpPrefix}*)`);
});

test("integration invoke file response aborts streaming when actual bytes exceed maxBytes", async () => {
  const { io } = memoryIo();
  const chunk = Buffer.from("x");
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted < 10) {
        emitted++;
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });

  await assert.rejects(
    withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
        },
      );
    }, {
      responseBody: body,
      manifest: (() => {
        const base = feedbackAdminFileManifest();
        const action = base.actions![0]!;
        return {
          ...base,
          actions: [{ ...action, response: { type: "file", maxBytes: 5 } }],
        };
      })(),
    }),
    (err: unknown) => {
      if (!(err instanceof CliError)) return false;
      assert.equal(err.code, "LOCAL_WRITE_SIZE_EXCEEDED");
      assert.equal(err.fault_domain, "file_write:size_limit");
      assert.equal(err.effect_state?.targetCommitted, false);
      assert.equal(err.effect_state?.unknown, true);
      assert.equal(typeof err.effect_state?.bytesWritten, "number");
      assert.ok((err.effect_state?.bytesWritten ?? Infinity) <= 5, "disk bytes must not exceed maxBytes");
      assert.equal(err.effect_state?.tempDirCleaned, true);
      assert.notEqual(err.effect_state?.cleanupFailed, true);
      assert.match(err.message, /exceeds maximum/);
      return true;
    },
  );
});

test("integration invoke file response reports partial cleanup failure on size limit overflow", async () => {
  const { io } = memoryIo();
  const chunk = Buffer.from("x");
  let emitted = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted < 10) {
        emitted++;
        controller.enqueue(chunk);
      } else {
        controller.close();
      }
    },
  });
  const originalRmSync = (fs as any).rmSync;
  const restore = () => { (fs as any).rmSync = originalRmSync; };

  let retainedPath: string | null = null;
  (fs as any).rmSync = (filepath: fs.PathLike, options?: unknown) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed during size-limit cleanup");
    }
    return originalRmSync(filepath, options);
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          },
        );
      }, {
        responseBody: body,
        manifest: (() => {
          const base = feedbackAdminFileManifest();
          const action = base.actions![0]!;
          return {
            ...base,
            actions: [{ ...action, response: { type: "file", maxBytes: 5 } }],
          };
        })(),
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.deepEqual(err.effect_state?.retainedTempArtifacts, [retainedPath]);
        assert.equal(typeof err.effect_state?.bytesWritten, "number");
        assert.ok((err.effect_state?.bytesWritten ?? Infinity) <= 5, "disk bytes must not exceed maxBytes");
        assert.match(err.message, /partial artifact/);
        return true;
      },
    );
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    assert.ok(fs.existsSync(retainedPath), "staging temp dir should be retained after size-limit cleanup failure");
  } finally {
    restore();
  }
});

test("integration invoke file response honors manifest response.maxBytes", async () => {
  const { io } = memoryIo();

  await assert.rejects(
    withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
        },
      );
    }, {
      responseBody: Buffer.from("large"),
      manifest: (() => {
        const base = feedbackAdminFileManifest();
        const action = base.actions![0]!;
        return {
          ...base,
          actions: [{ ...action, response: { type: "file", maxBytes: 2 } }],
        };
      })(),
    }),
    (err: unknown) => {
      if (!(err instanceof CliError)) return false;
      assert.equal(err.code, "LOCAL_WRITE_SIZE_EXCEEDED");
      assert.match(err.message, /exceeds maximum/);
      return true;
    },
  );
});

test("integration invoke rejects --output for v0 non-file-response actions", async () => {
  const { io } = memoryIo();

  await withFeedbackAdminFetch(async () => {
    await assert.rejects(
      async () => integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "add_feedback_note",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f", "content=test note"],
          output: "/tmp/should-not-be-used.json",
        },
      ),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && String(err.message).includes("--output"),
    );
  });
});

test("integration invoke rejects --output for manifest v1 actions", async () => {
  const { io } = memoryIo();

  await withV1Fetch(v1Manifest(), async () => {
    await assert.rejects(
      async () => integrationInvokeCommand.handler(
        commandContext({ io, service: service({ clientId: "pr-diff-viewer-3c05bd" }) }),
        undefined,
        undefined,
        {
          service: "pr-diff-viewer-3c05bd",
          action: "get_status",
          output: "/tmp/should-not-be-used.json",
        },
      ),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_ARG" && String(err.message).includes("--output"),
    );
  });
});

test("integration invoke file response preserves null content type", async () => {
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
      "--json",
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, { omitContentType: true });

  const parsed = JSON.parse(stdout.join(""));
  assert.equal(parsed.data.contentType, null);
});

test("integration invoke file response honors RFC 5987 content-disposition filename", async () => {
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, { contentDisposition: "attachment; filename*=UTF-8''report%20one.csv" });

  const output = stdout.join("");
  assert.match(output, /file: .*report_one\.csv/);
});

test("integration invoke file response falls back from hostile content-disposition filename", async () => {
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, { contentDisposition: "attachment; filename=\"..\"" });

  const output = stdout.join("");
  assert.match(output, /file: .*download/);
});

test("integration invoke file response honors manifest response.filename fallback", async () => {
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, {
    manifest: {
      ...feedbackAdminFileManifest(),
      actions: [{
        name: "download_feedback_transcript",
        description: "Download the trace transcript bundle linked to a feedback report.",
        endpoint: { method: "GET", path: "/api/feedback/transcript" },
        parameters: { id: { type: "string", description: "feedback report id", required: true } },
        response: { type: "file", filename: "manifest-named.csv" },
      }],
    },
    contentDisposition: null,
  });

  const output = stdout.join("");
  assert.match(output, /file: .*manifest-named\.csv/);
});

test("integration invoke file response reports overwrite effect", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-overwrite-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  fs.writeFileSync(outputPath, "existing content", "utf8");
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
      "--output",
      outputPath,
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, { outputPath });

  assert.equal(fs.readFileSync(outputPath).toString("hex"), "1f8b0800000000000000");
  const output = stdout.join("");
  assert.match(output, /effect: unknown/);
});

test("integration invoke file response reports created and dir-created effects", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-dir-created-"));
  const outputPath = path.join(tmp, "nested", "dir", "transcript.jsonl.gz");
  const { io, stdout } = memoryIo();

  await withFeedbackAdminFileFetch(async () => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "slock-feedback-admin-58bdf6",
      "--action",
      "download_feedback_transcript",
      "--param",
      "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
      "--output",
      outputPath,
    ], {
      io,
      service: feedbackAdminService(),
    });
  }, { outputPath });

  assert.ok(fs.existsSync(outputPath));
  const output = stdout.join("");
  assert.match(output, /effect: unknown/);
  assert.match(output, /directory: created/);
});

test("integration invoke file response surfaces local write failures", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-write-fail-"));
  fs.chmodSync(tmp, 0o555);
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => err instanceof CliError && err.code === "LOCAL_WRITE_FAILED",
    );
  } finally {
    fs.chmodSync(tmp, 0o755);
  }
});

test("integration invoke file response reports source transport reset", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-source-reset-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("transport reset"));
    },
  });

  await assert.rejects(
    withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          output: outputPath,
        },
      );
    }, { outputPath, responseBody: body }),
    (err: unknown) => {
      if (!(err instanceof CliError)) return false;
      assert.equal(err.code, "LOCAL_WRITE_SOURCE_FAILED");
      assert.equal(err.fault_domain, "file_write:source_read");
      assert.equal(err.effect_state?.targetCommitted, false);
      assert.equal(err.effect_state?.unknown, true);
      assert.match(err.message, /response body/);
      return true;
    },
  );
  assert.ok(!fs.existsSync(outputPath), "output file should not exist after source reset");
});

test("integration invoke file response reports destination write failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-dest-fail-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalWrite = fs.write.bind(fs);
  const mutableFs = fs as unknown as { write: typeof fs.write };
  const restore = () => { mutableFs.write = originalWrite; };

  mutableFs.write = ((
    _fd: number | fs.PathLike | fs.promises.FileHandle,
    buffer: Uint8Array | string,
    _offsetOrPosition?: number | string | null,
    _lengthOrEncoding?: number | string | null,
    _position?: number | null,
    callback?: (err: NodeJS.ErrnoException | null, written?: number, buffer?: Uint8Array) => void,
  ) => {
    if (typeof callback === "function") {
      callback(new Error("disk full") as NodeJS.ErrnoException, 0, buffer as Uint8Array);
    }
  }) as typeof fs.write;

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_DESTINATION_FAILED");
        assert.equal(err.fault_domain, "file_write:destination_write");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.unknown, true);
        assert.match(err.message, /temporary file/);
        assert.match(err.message, /disk full/);
        return true;
      },
    );
    assert.ok(!fs.existsSync(outputPath), "output file should not exist after destination write failure");
  } finally {
    restore();
  }
});

test("integration invoke file response counts delayed destination write callbacks on source error", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-delayed-write-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalWrite = fs.write.bind(fs);
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { write: typeof fs.write; rmSync: typeof fs.rmSync };
  let retainedPath: string | null = null;
  let writeCallbackDelayed = false;

  mutableFs.write = ((fd: number, buffer: Uint8Array | string, ...args: unknown[]) => {
    const callbackIndex = args.findIndex((arg) => typeof arg === "function");
    const callback = args[callbackIndex] as
      | ((err: NodeJS.ErrnoException | null, written?: number, buffer?: Uint8Array) => void)
      | undefined;
    const otherArgs = args.slice(0, callbackIndex);
    if (writeCallbackDelayed && typeof callback === "function") {
      (originalWrite as unknown as (...writeArgs: unknown[]) => void)(fd, buffer, ...otherArgs, (err: NodeJS.ErrnoException | null, written?: number, buf?: Uint8Array) => {
        setTimeout(() => callback(err, written, buf), 50);
      });
      return;
    }
    (originalWrite as unknown as (...writeArgs: unknown[]) => void)(fd, buffer, ...otherArgs, callback);
  }) as typeof fs.write;

  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (path.basename(str).startsWith(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;

  const restore = () => {
    mutableFs.write = originalWrite;
    mutableFs.rmSync = originalRmSync;
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, {
        outputPath,
        responseBody: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("7 bytes"));
            writeCallbackDelayed = true;
            setTimeout(() => controller.error(new Error("source reset")), 10);
          },
        }),
      }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.bytesWritten, 7);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.ok(Array.isArray(err.effect_state?.retainedTempArtifacts));
        return true;
      },
    );
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    assert.ok(fs.existsSync(path.join(retainedPath, "payload")), "retained payload should exist");
    assert.equal(fs.statSync(path.join(retainedPath, "payload")).size, 7, "retained payload should contain 7 bytes");
  } finally {
    restore();
    if (retainedPath && fs.existsSync(retainedPath)) {
      fs.rmSync(retainedPath, { recursive: true, force: true });
    }
  }
});

test("integration invoke file response rejects zero-progress destination write", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-zero-progress-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalWrite = fs.write.bind(fs);
  const mutableFs = fs as unknown as { write: typeof fs.write };
  let writeCalls = 0;

  mutableFs.write = ((fd: number, buffer: Uint8Array | string, ...args: unknown[]) => {
    const callbackIndex = args.findIndex((arg) => typeof arg === "function");
    const callback = args[callbackIndex] as
      | ((err: NodeJS.ErrnoException | null, written?: number, buffer?: Uint8Array) => void)
      | undefined;
    writeCalls++;
    // Report zero progress without error; a correct implementation must not
    // recurse forever on the same offset.
    if (typeof callback === "function") {
      callback(null, 0, buffer as Uint8Array);
    }
  }) as typeof fs.write;

  const restore = () => { mutableFs.write = originalWrite; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_DESTINATION_FAILED");
        assert.equal(err.fault_domain, "file_write:destination_write");
        assert.match(err.message, /no progress/);
        assert.equal(err.effect_state?.bytesWritten, 0);
        return true;
      },
    );
    assert.equal(writeCalls, 1, "should give up after first zero-progress write, not recurse");
  } finally {
    restore();
  }
});

test("integration invoke file response cleans up partial temp artifact on stream failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-partial-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("transport reset"));
    },
  });

  await assert.rejects(
    withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          output: outputPath,
        },
      );
    }, { outputPath, responseBody: body }),
    (err: unknown) => {
      if (!(err instanceof CliError)) return false;
      assert.equal(err.code, "LOCAL_WRITE_SOURCE_FAILED");
      assert.equal(err.fault_domain, "file_write:source_read");
      return true;
    },
  );
  const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
  assert.deepEqual(leftovers, [], "partial temp directories should be cleaned up");
});

test("integration invoke file response reports retained partial write bytes on rollback cleanup failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-partial-bytes-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  let enqueued = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!enqueued) {
        controller.enqueue(new TextEncoder().encode("partial"));
        enqueued = true;
        setImmediate(() => controller.error(new Error("transport reset after 7 bytes")));
      }
    },
  });
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { rmSync: typeof fs.rmSync };
  let retainedPath: string | null = null;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;
  const restore = () => { mutableFs.rmSync = originalRmSync; };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath, responseBody: body }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.tempDirCreated, true);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.equal(err.effect_state?.bytesWritten, 7);
        assert.ok(
          err.effect_state?.retainedTempArtifacts?.includes(retainedPath ?? ""),
          "receipt must locate the retained partial temp artifact",
        );
        return true;
      },
    );
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    assert.ok(fs.existsSync(retainedPath), "staging temp dir should be retained after failed cleanup");
    const payloadPath = path.join(retainedPath, "payload");
    assert.ok(fs.existsSync(payloadPath), "partial payload file should be retained");
    assert.equal(fs.statSync(payloadPath).size, 7, "retained payload must contain the 7 bytes written before failure");
  } finally {
    restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("integration invoke file response reports post-commit receipt failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-receipt-fail-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const originalStatSync = fs.statSync.bind(fs);
  const mutableFs = fs as unknown as { statSync: typeof fs.statSync };
  const restore = () => { mutableFs.statSync = originalStatSync; };

  mutableFs.statSync = ((filepath: fs.PathLike, options?: fs.StatOptions) => {
    if (path.resolve(String(filepath)) === path.resolve(outputPath)) {
      throw new Error("permission denied after commit");
    }
    return originalStatSync(filepath, options);
  }) as typeof fs.statSync;

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_POST_COMMIT_FAILED");
        assert.equal(err.fault_domain, "file_write:post_commit");
        assert.equal(err.effect_state?.targetCommitted, true);
        assert.equal(err.effect_state?.unknown, true);
        assert.equal(err.effect_state?.created, false);
        assert.equal(err.effect_state?.overwritten, false);
        assert.match(err.message, /written to/);
        assert.match(err.message, /permission denied after commit/);
        return true;
      },
    );
    assert.ok(fs.existsSync(outputPath), "committed file should remain even when receipt fails");
  } finally {
    restore();
  }
});

test("integration invoke file response reports partial cleanup failure on rollback", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-partial-cleanup-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io } = memoryIo();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("transport reset"));
    },
  });
  const originalRmSync = (fs as any).rmSync;
  const restore = () => { (fs as any).rmSync = originalRmSync; };

  let retainedPath: string | null = null;
  (fs as any).rmSync = (filepath: fs.PathLike, options?: unknown) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  };

  try {
    await assert.rejects(
      withFeedbackAdminFileFetch(async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, service: feedbackAdminService() }),
          undefined,
          undefined,
          {
            service: "slock-feedback-admin-58bdf6",
            action: "download_feedback_transcript",
            param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
            output: outputPath,
          },
        );
      }, { outputPath, responseBody: body }),
      (err: unknown) => {
        if (!(err instanceof CliError)) return false;
        assert.equal(err.code, "LOCAL_WRITE_PARTIAL_FAILED");
        assert.equal(err.fault_domain, "file_write:partial_cleanup");
        assert.equal(err.effect_state?.targetCommitted, false);
        assert.equal(err.effect_state?.cleanupFailed, true);
        assert.deepEqual(err.effect_state?.retainedTempArtifacts, [retainedPath]);
        assert.match(err.message, /partial artifact/);
        return true;
      },
    );
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
    const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
    assert.equal(leftovers.length, 1, "failed rollback temp directory should be retained");
  } finally {
    restore();
  }
});

test("integration invoke file response rejects null body before filesystem effects", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-null-body-"));
  const outputPath = path.join(tmp, "nested", "transcript.jsonl.gz");
  const { io } = memoryIo();

  await assert.rejects(
    withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          output: outputPath,
        },
      );
    }, { outputPath, responseBody: null }),
    (err: unknown) => {
      if (!(err instanceof CliError)) return false;
      assert.equal(err.code, "LOCAL_WRITE_FAILED");
      assert.equal(err.fault_domain, "file_write:prepare");
      assert.equal(err.effect_state?.targetCommitted, false);
      return true;
    },
  );
  assert.ok(!fs.existsSync(outputPath), "output file should not be created for null body");
  assert.ok(!fs.existsSync(path.dirname(outputPath)), "parent directory should not be created for null body");
});

test("integration invoke file response reports temp directory cleanup failure", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-cleanup-fail-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io, stdout } = memoryIo();
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { rmSync: typeof fs.rmSync };
  const restore = () => { mutableFs.rmSync = originalRmSync; };

  let retainedPath: string | null = null;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;

  try {
    await withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          output: outputPath,
        },
      );
    }, { outputPath });

    assert.ok(fs.existsSync(outputPath), "committed file should exist");
    const output = stdout.join("");
    assert.match(output, /effect: unknown/);
    assert.match(output, /temp directory: cleanup failed/);
    assert.ok(
      retainedPath !== null && output.includes(retainedPath),
      "text receipt should include the retained temp directory path",
    );
    const leftovers = fs.readdirSync(tmp).filter((name) => name.startsWith(".raft-invoke-write-"));
    assert.equal(leftovers.length, 1, "failed temp directory should be retained");
  } finally {
    restore();
  }
});

test("integration invoke file response reports cleanup failure in JSON mode", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-cleanup-json-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io, stdout } = memoryIo();
  const originalRmSync = fs.rmSync.bind(fs);
  const mutableFs = fs as unknown as { rmSync: typeof fs.rmSync };
  const restore = () => { mutableFs.rmSync = originalRmSync; };

  let retainedPath: string | null = null;
  mutableFs.rmSync = ((filepath: fs.PathLike, options?: fs.RmOptions) => {
    const str = String(filepath);
    if (str.includes(".raft-invoke-write-")) {
      retainedPath = str;
      throw new Error("rmSync failed");
    }
    return originalRmSync(filepath, options);
  }) as typeof fs.rmSync;

  try {
    await withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          output: outputPath,
          json: true,
        },
      );
    }, { outputPath });

    const parsed = JSON.parse(stdout.join(""));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.cleanupFailed, true);
    assert.equal(parsed.data.tempDirCreated, true);
    assert.equal(parsed.data.tempDirCleaned, false);
    assert.equal(parsed.data.created, false);
    assert.equal(parsed.data.overwritten, false);
    assert.equal(parsed.data.unknown, true);
    assert.deepEqual(parsed.data.retainedTempArtifacts, [retainedPath]);
    assert.ok(retainedPath !== null, "rmSync should have been called on staging temp dir");
  } finally {
    restore();
  }
});

test("integration invoke file response emits machine-readable JSON error on source reset", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-json-error-"));
  const outputPath = path.join(tmp, "transcript.jsonl.gz");
  const { io, stderr } = memoryIo();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(new Error("transport reset"));
    },
  });

  try {
    await withFeedbackAdminFileFetch(async () => {
      await integrationInvokeCommand.handler(
        commandContext({ io, service: feedbackAdminService() }),
        undefined,
        undefined,
        {
          service: "slock-feedback-admin-58bdf6",
          action: "download_feedback_transcript",
          param: ["id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f"],
          output: outputPath,
          json: true,
        },
      );
    }, { outputPath, responseBody: body });
    assert.fail("expected source reset error");
  } catch (error) {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "LOCAL_WRITE_SOURCE_FAILED");
    assert.equal(error.outputMode, "json");
    renderError(io, error);
  }

  const parsed = JSON.parse(stderr.join(""));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, "LOCAL_WRITE_SOURCE_FAILED");
  assert.equal(parsed.error.fault_domain, "file_write:source_read");
  assert.equal(parsed.effect_state.targetCommitted, false);
  assert.equal(parsed.effect_state.targetPath, path.resolve(outputPath));
});

test("integration invoke substitutes manifest path placeholders before POSTing JSON body", async () => {
  const { io } = memoryIo();

  await withFeedbackAdminFetch(async (fetchCalls) => {
    await integrationInvokeCommand.handler(
      commandContext({ io, service: feedbackAdminService() }),
      undefined,
      undefined,
      {
        service: "slock-feedback-admin-58bdf6",
        action: "add_feedback_note",
        param: [
          "id=d3d2c6e1-b355-4bb5-aed2-a565bc775d2f",
          "content=test note",
        ],
      },
    );

    const actionCall = fetchCalls.at(-1);
    assert.equal(
      actionCall?.url,
      "https://feedback-admin.botiverse.workers.dev/api/feedback/d3d2c6e1-b355-4bb5-aed2-a565bc775d2f/notes",
    );
    assert.deepEqual(JSON.parse(String(actionCall?.init?.body)), { content: "test note" });
  }, {
    manifest: feedbackAdminManifest("/api/feedback/{id}/notes"),
  });
});

test("integration invoke preserves release notes idempotencyKey while keeping releaseId URL-only", async () => {
  const { io } = memoryIo();

  await withFeedbackAdminFetch(async (fetchCalls) => {
    await integrationInvokeCommand.handler(
      commandContext({ io, service: feedbackAdminService() }),
      undefined,
      undefined,
      {
        service: "slock-feedback-admin-58bdf6",
        action: "release.notes.append",
        param: [
          "releaseId=rel_f933e29e-423c-4c2b-aea9-7df089ccb306",
          "content=v1.10.0 release notes",
          "idempotencyKey=v1.10.0-notes-revision-1",
        ],
      },
    );

    const actionCall = fetchCalls.at(-1);
    assert.equal(
      actionCall?.url,
      "https://feedback-admin.botiverse.workers.dev/api/releases/rel_f933e29e-423c-4c2b-aea9-7df089ccb306/notes",
    );
    assert.deepEqual(JSON.parse(String(actionCall?.init?.body)), {
      content: "v1.10.0 release notes",
      idempotencyKey: "v1.10.0-notes-revision-1",
    });
  }, {
    manifest: releaseNotesManifest({ method: "POST", path: "/api/releases/{releaseId}/notes" }),
  });
});

test("integration invoke puts GET path-placeholder payload fields in the query only", async () => {
  const { io } = memoryIo();

  await withFeedbackAdminFetch(async (fetchCalls) => {
    await integrationInvokeCommand.handler(
      commandContext({ io, service: feedbackAdminService() }),
      undefined,
      undefined,
      {
        service: "slock-feedback-admin-58bdf6",
        action: "release.notes.read",
        param: [
          "releaseId=rel_f933e29e-423c-4c2b-aea9-7df089ccb306",
          "include=revisions",
        ],
      },
    );

    const actionCall = fetchCalls.at(-1);
    assert.equal(
      actionCall?.url,
      "https://feedback-admin.botiverse.workers.dev/api/releases/rel_f933e29e-423c-4c2b-aea9-7df089ccb306/notes?include=revisions",
    );
    assert.equal(actionCall?.init?.body, undefined);
  }, {
    manifest: releaseNotesManifest({ method: "GET", path: "/api/releases/{releaseId}/notes" }),
  });
});

test("integration invoke lists manifest HTTP API actions without logging in", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(async () => {
    await integrationInvokeCommand.handler(
      commandContext({ io, requests }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true },
    );
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
  const output = stdout.join("");
  assert.match(output, /service: "pr-diff-viewer-3c05bd"/);
  assert.match(output, /- name: "render-patch"/);
  assert.match(output, /method: "POST"/);
  assert.match(output, /path: "\/api\/render-patch"/);
  assert.match(output, /patchText:\n\s+type: "string"\n\s+description: "Raw unified diff text to render"\n\s+required: true/);
  assert.match(output, /author:\n\s+type: "string"\n\s+description: "Name or identifier of the author"\n\s+required: false/);
  assert.match(output, /returns:\n\s+viewerUrl:\n\s+type: "string"/);
  assert.match(output, /status: "valid"/);
  assert.match(output, /surface: "manifest_actions"/);
  assert.match(output, /evidence_ceiling: "manifest_shape"/);
});

test("integration invoke list-actions JSON preserves the typed source rendered by the human view", async () => {
  const { io, stdout } = memoryIo();

  await withMockFetch(async () => {
    await integrationInvokeCommand.handler(
      commandContext({ io }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true, json: true },
    );
  });

  const payload = JSON.parse(stdout.join("")) as {
    ok: boolean;
    data: {
      service: string;
      manifestUrl: string;
      actions: AgentManifestV0["actions"];
    };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.service, "pr-diff-viewer-3c05bd");
  assert.equal(
    payload.data.manifestUrl,
    "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
  );
  assert.deepEqual(payload.data.actions, manifest().actions);
});

test("integration invoke list-actions automatically renders typed action fields from the JSON source", async () => {
  const typedManifest = manifest();
  typedManifest.actions = [{
    name: "add-server-allowlist",
    description: "Add one server to an exact allowlist rule.",
    endpoint: { method: "POST", path: "/api/operator/feature-flags/{key}/server-allowlist" },
    parameters: {
      expectedConfigVersion: {
        type: "integer",
        description: "Current config version for optimistic concurrency.",
        required: true,
      },
    },
    returns: {
      auditId: { type: "string", description: "Immutable audit identifier." },
    },
  }];

  const human = memoryIo();
  await withMockFetch(async () => {
    await integrationInvokeCommand.handler(
      commandContext({ io: human.io }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true },
    );
  }, { manifest: typedManifest });

  const json = memoryIo();
  await withMockFetch(async () => {
    await integrationInvokeCommand.handler(
      commandContext({ io: json.io }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true, json: true },
    );
  }, { manifest: typedManifest });

  const payload = JSON.parse(json.stdout.join("")) as {
    data: { actions: AgentManifestV0["actions"] };
  };
  assert.equal(payload.data.actions?.[0]?.parameters?.expectedConfigVersion?.type, "integer");
  assert.equal(payload.data.actions?.[0]?.parameters?.expectedConfigVersion?.required, true);
  assert.match(
    human.stdout.join(""),
    /expectedConfigVersion:\n\s+type: "integer"\n\s+description: "Current config version for optimistic concurrency\."\n\s+required: true/,
  );
  assert.match(human.stdout.join(""), /returns:\n\s+auditId:\n\s+type: "string"/);
});

test("integration list-actions succeeds for an existing Web app with no manifest", async () => {
  const { io, stdout } = memoryIo();
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("no manifest fetch is expected");
  }) as typeof fetch;
  try {
    await integrationInvokeCommand.handler(
      commandContext({ io, service: service({ agentManifestUrl: null }) }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(fetches, 0);
  const output = stdout.join("");
  assert.match(output, /manifest status: not_configured/);
  assert.match(output, /action surface: web_only\/no_actions/);
  assert.match(output, /evidence ceiling: registry_metadata/);
  assert.match(output, /- none/);
  assert.doesNotMatch(output, /Error:/);
});

test("integration list-actions treats a missing registered manifest as non-breaking discovery", async () => {
  const { io, stdout } = memoryIo();
  await withManifestResponse(
    (url) => responseWithUrl("not found", { status: 404 }, url),
    async () => integrationInvokeCommand.handler(
      commandContext({ io }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true },
    ),
  );

  const output = stdout.join("");
  assert.match(output, /manifest status: missing/);
  assert.match(output, /action surface: unknown/);
  assert.match(output, /- none/);
});

test("integration list-actions JSON preserves unknown surface for a missing registered manifest", async () => {
  const { io, stdout } = memoryIo();
  await withManifestResponse(
    (url) => responseWithUrl("not found", { status: 404 }, url),
    async () => integrationInvokeCommand.handler(
      commandContext({ io }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true, json: true },
    ),
  );

  const payload = JSON.parse(stdout.join("")) as {
    ok: boolean;
    data: {
      status: string;
      surface: string;
      manifestObservation: { surface: string };
      actions: unknown[];
    };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "missing");
  assert.equal(payload.data.surface, "unknown");
  assert.equal(payload.data.manifestObservation.surface, "unknown");
  assert.deepEqual(payload.data.actions, []);
});

test("integration list-actions JSON reports web-only only when no manifest is configured", async () => {
  const { io, stdout } = memoryIo();
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("no manifest fetch is expected");
  }) as typeof fetch;
  try {
    await integrationInvokeCommand.handler(
      commandContext({ io, service: service({ agentManifestUrl: null }) }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true, json: true },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  const payload = JSON.parse(stdout.join("")) as {
    ok: boolean;
    data: {
      status: string;
      surface: string;
      manifestObservation: { surface: string };
      actions: unknown[];
    };
  };
  assert.equal(fetches, 0);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.status, "not_configured");
  assert.equal(payload.data.surface, "web_only_no_actions");
  assert.equal(payload.data.manifestObservation.surface, "web_only_no_actions");
  assert.deepEqual(payload.data.actions, []);
});

test("integration explicit action remains fail-closed when no manifest is configured", async () => {
  const { io } = memoryIo();
  await assert.rejects(
    async () => integrationInvokeCommand.handler(
      commandContext({ io, service: service({ agentManifestUrl: null }) }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", action: "render-patch" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INTEGRATION_MANIFEST_MISSING");
      assert.equal(error.fault_domain, "manifest_registry");
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test("integration invoke preserves planned-offline 503 fault domain and retry metadata", async () => {
  const { io, stderr } = memoryIo();
  await withManifestResponse(
    (url) => responseWithUrl("maintenance", {
      status: 503,
      headers: {
        "content-type": "text/plain",
        "retry-after": "120",
      },
    }, url),
    async () => {
      await assert.rejects(
        async () => integrationInvokeCommand.handler(
          commandContext({ io }),
          undefined,
          undefined,
          { service: "pr-diff-viewer-3c05bd", listActions: true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "INTEGRATION_MANIFEST_UNAVAILABLE");
          assert.equal(error.fault_domain, "manifest_service");
          assert.equal(error.retryable, true);
          assert.match(error.message, /HTTP 503/);
          assert.match(error.message, /retry-after 120/);
          assert.match(error.next_action ?? "", /Retry after 120/);
          renderError(io, error);
          return true;
        },
      );
    },
  );

  const output = stderr.join("");
  assert.match(output, /Code: INTEGRATION_MANIFEST_UNAVAILABLE/);
  assert.match(output, /Layer: manifest_service/);
  assert.match(output, /Retryable: yes/);
  assert.match(output, /Next action: Retry after 120/);
});

test("integration invoke preserves Cloudflare HTML content type as non-retryable response invalid", async () => {
  const { io } = memoryIo();
  await withManifestResponse(
    (url) => responseWithUrl("<html>Access</html>", {
      status: 200,
      headers: { "content-type": "text/html; charset=UTF-8" },
    }, url),
    async () => {
      await assert.rejects(
        async () => integrationInvokeCommand.handler(
          commandContext({ io }),
          undefined,
          undefined,
          { service: "pr-diff-viewer-3c05bd", listActions: true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(error.code, "INTEGRATION_MANIFEST_INVALID");
          assert.equal(error.fault_domain, "manifest_response");
          assert.equal(error.retryable, false);
          assert.match(error.message, /text\/html; charset=UTF-8/);
          assert.match(error.next_action ?? "", /credential-free application\/json/);
          return true;
        },
      );
    },
  );
});

test("integration invoke list-actions documents non-GET id resource locator query shim", async () => {
  const { io, stdout } = memoryIo();

  await withMockFetch(async () => {
    await integrationInvokeCommand.handler(
      commandContext({ io, service: feedbackAdminService() }),
      undefined,
      undefined,
      { service: "slock-feedback-admin-58bdf6", listActions: true },
    );
  }, { manifest: feedbackAdminManifest() });

  const output = stdout.join("");
  assert.match(output, /method: "POST"/);
  assert.match(output, /path: "\/api\/feedback\/notes"/);
  assert.match(output, /id:\n\s+type: "string"\n\s+description: "feedback report id"\n\s+required: true/);
  assert.match(output, /content:\n\s+type: "string"\n\s+description: "Note content"\n\s+required: true/);
  assert.match(output, /id is treated as the resource locator and is also sent as query \?id=/);
  assert.match(output, /JSON body is preserved/);
});

test("integration invoke falls back from inferred Raft well-known manifest to legacy Slock path", async () => {
  const { io, stdout } = memoryIo();

  await withMockFetch(async (fetchCalls) => {
    await integrationInvokeCommand.handler(
      commandContext({
        io,
        service: service({
          agentManifestUrl: "https://pr-diff-viewer.botiverse.workers.dev/.well-known/raft-agent-manifest.json",
          agentManifestUrlSource: "well_known",
        }),
      }),
      undefined,
      undefined,
      { service: "pr-diff-viewer-3c05bd", listActions: true },
    );

    assert.deepEqual(fetchCalls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/raft-agent-manifest.json",
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });

  assert.match(stdout.join(""), /service: "pr-diff-viewer-3c05bd"/);
  assert.match(stdout.join(""), /- name: "render-patch"/);
});

test("integration list-actions never initiates login for unsupported manifest auth", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const cookieManifest = {
    ...manifest(),
    auth: {
      mode: "oauth_session_cookie",
      login_url: "https://pr-diff-viewer.botiverse.workers.dev/login",
    },
  } as any;

  await withMockFetch(
    async (fetchCalls) => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io, requests }),
            undefined,
            undefined,
            { service: "pr-diff-viewer-3c05bd", listActions: true },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_MANIFEST_INVALID");
          assert.match(err.message, /auth\.type must be login_with_raft/);
          assert.equal(err.fault_domain, "manifest_schema");
          assert.equal(err.retryable, false);
          assert.match(err.suggestedNextAction ?? "", /fix manifest schema path auth\.type/);
          assert.doesNotMatch(err.suggestedNextAction ?? "", /login|handoff|callback/i);
          return true;
        },
      );

      assert.deepEqual(requests, [
        { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
      ]);
      assert.deepEqual(fetchCalls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      ]);
    },
    { manifest: cookieManifest },
  );
});

test("integration list-actions target cannot turn manifest failure into login approval", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const cookieManifest = {
    ...manifest(),
    auth: {
      mode: "oauth_session_cookie",
      login_url: "https://pr-diff-viewer.botiverse.workers.dev/login",
    },
  } as any;

  await withMockFetch(
    async () => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({
              io,
              requests,
              loginResponse: ok({
                status: "approval_required",
                service: service(),
                scopes: ["identity"],
                requestId: "agent-login-request",
                approval: {
                  requestId: "approval-request",
                  target: "#proj-auth:21221638",
                  actionCardMessageId: "approval-card-msg",
                },
              }),
            }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              listActions: true,
              target: "#proj-auth:21221638",
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_MANIFEST_INVALID");
          assert.match(err.message, /auth\.type must be login_with_raft/);
          assert.match(err.suggestedNextAction ?? "", /fix manifest schema path auth\.type/);
          assert.doesNotMatch(err.suggestedNextAction ?? "", /approval|login|handoff|callback/i);
          return true;
        },
      );
    },
    { manifest: cookieManifest },
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration manifest failure is independent from login endpoint availability", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const cookieManifest = {
    ...manifest(),
    auth: {
      mode: "oauth_session_cookie",
      login_url: "https://pr-diff-viewer.botiverse.workers.dev/login",
    },
  } as any;

  await withMockFetch(
    async () => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({
              io,
              requests,
              loginResponse: {
                ok: false,
                status: 503,
                data: null,
                error: "login service unavailable",
              },
            }),
            undefined,
            undefined,
            { service: "pr-diff-viewer-3c05bd", action: "render-patch" },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_MANIFEST_INVALID");
          assert.match(err.message, /auth\.type must be login_with_raft/);
          assert.match(err.suggestedNextAction ?? "", /fix manifest schema path auth\.type/);
          assert.doesNotMatch(err.suggestedNextAction ?? "", /login service unavailable/);
          return true;
        },
      );
    },
    { manifest: cookieManifest },
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration invoke does not prepare login request for unrelated manifest errors", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const invalidManifest = {
    ...manifest(),
    schema: "not-a-supported-schema",
  } as any;

  await withMockFetch(
    async () => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io, requests }),
            undefined,
            undefined,
            { service: "pr-diff-viewer-3c05bd", listActions: true },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_MANIFEST_INVALID");
          assert.match(err.message, /manifest schema must be/);
          assert.equal(err.fault_domain, "manifest_schema");
          assert.equal(err.retryable, false);
          assert.match(err.next_action ?? "", /fix manifest schema path schema/);
          assert.match(err.message, /schema path schema/);
          return true;
        },
      );
    },
    { manifest: invalidManifest },
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration invoke performs stateless callback handoff and posts JSON action body", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(async (fetchCalls) => {
    await integrationInvokeCommand.handler(
      commandContext({ io, requests }),
      undefined,
      undefined,
      {
        service: "pr-diff-viewer-3c05bd",
        action: "render-patch",
        param: [`patchText=@${patchPath}`, "author=Cardy"],
      },
    );

    assert.deepEqual(fetchCalls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request",
      "https://pr-diff-viewer.botiverse.workers.dev/api/render-patch",
    ]);
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/login",
      body: { service: "pr-diff-viewer-3c05bd", scopes: undefined, target: undefined },
    },
  ]);
  assert.match(stdout.join(""), /Action invoked: render-patch/);
  assert.match(stdout.join(""), /viewer URL: https:\/\/pr-diff-viewer\.botiverse\.workers\.dev\/view\/abc/);
});

test("legacy action execution reaches a proxy-only target and preserves a direct action route", async () => {
  const actionRequests: Array<{
    url: string;
    method?: string;
    cookie?: string;
    body: string;
  }> = [];
  const origin = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      actionRequests.push({
        url: request.url ?? "",
        method: request.method,
        cookie: request.headers.cookie,
        body,
      });
      response.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
      });
      response.end(JSON.stringify({ viewerUrl: "https://viewer.example/result" }));
    });
  });
  const originSockets = trackSockets(origin);
  const originPort = await listen(origin);

  let proxyConnects = 0;
  const proxy = http.createServer((_request, response) => {
    response.writeHead(501);
    response.end();
  });
  const proxySockets = trackSockets(proxy);
  proxy.on("connect", (_request, downstream, head) => {
    proxyConnects += 1;
    const upstream = net.connect(originPort, "127.0.0.1", () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    upstream.once("error", () => downstream.destroy());
    downstream.once("error", () => upstream.destroy());
  });
  const proxyPort = await listen(proxy);

  const previousFetch = globalThis.fetch;
  let currentManifest = manifest();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const resolvedUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    if (resolvedUrl.endsWith("/.well-known/slock-agent-manifest.json")) {
      return responseWithUrl(JSON.stringify(currentManifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    return previousFetch(input, init);
  }) as typeof fetch;

  const invoke = async (input: {
    baseUrl: string;
    cookieHost: string;
    env: NodeJS.ProcessEnv;
  }) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-action-proxy-"));
    writeStoredV0Session(profileDir, input.cookieHost);
    currentManifest = manifest();
    currentManifest.execution = { mode: "http_api", base_url: input.baseUrl };
    currentManifest.app_origin = input.baseUrl;
    const { io, stdout } = memoryIo();
    await integrationInvokeCommand.handler(
      commandContext({ io, profileDir, env: input.env }),
      undefined,
      undefined,
      {
        service: "pr-diff-viewer-3c05bd",
        action: "render-patch",
        param: ["patchText=diff"],
      },
    );
    assert.match(stdout.join(""), /Action invoked: render-patch/);
  };

  try {
    await invoke({
      baseUrl: `http://proxy-only.invalid:${originPort}`,
      cookieHost: "proxy-only.invalid",
      env: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}` },
    });
    const proxyConnectsBeforeDirect = proxyConnects;
    assert.ok(proxyConnectsBeforeDirect >= 1);

    await invoke({
      baseUrl: `http://127.0.0.1:${originPort}`,
      cookieHost: "127.0.0.1",
      env: {},
    });
    assert.equal(proxyConnects, proxyConnectsBeforeDirect, "the direct action must not use the proxy");
  } finally {
    globalThis.fetch = previousFetch;
    for (const socket of proxySockets) socket.destroy();
    for (const socket of originSockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve())),
    ]);
  }

  assert.deepEqual(actionRequests, [
    {
      url: "/api/render-patch",
      method: "POST",
      cookie: "legacy-session=proxy-secret",
      body: JSON.stringify({ patchText: "diff" }),
    },
    {
      url: "/api/render-patch",
      method: "POST",
      cookie: "legacy-session=proxy-secret",
      body: JSON.stringify({ patchText: "diff" }),
    },
  ]);
});

test("legacy action transport failures preserve a bounded cause without dispatch success", async () => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-action-timeout-"));
  writeStoredV0Session(profileDir, "pr-diff-viewer.botiverse.workers.dev");
  const { io } = memoryIo();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const resolvedUrl = typeof input === "string" || input instanceof URL ? input.toString() : input.url;
    if (resolvedUrl.endsWith("/.well-known/slock-agent-manifest.json")) {
      return responseWithUrl(JSON.stringify(manifest()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }, resolvedUrl);
    }
    const timeoutCause = Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
    throw Object.assign(new TypeError("fetch failed"), { cause: timeoutCause });
  }) as typeof fetch;
  try {
    await assert.rejects(
      async () => integrationInvokeCommand.handler(
        commandContext({ io, profileDir }),
        undefined,
        undefined,
        {
          service: "pr-diff-viewer-3c05bd",
          action: "render-patch",
          param: ["patchText=diff"],
        },
      ),
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "INTEGRATION_INVOKE_FAILED");
        assert.equal(error.layer, "integration_action_transport");
        assert.equal(error.fault_domain, "integration_action_transport");
        assert.equal(error.retryable, true);
        assert.deepEqual(error.details, {
          actual_url: "https://pr-diff-viewer.botiverse.workers.dev/api/render-patch",
          cause_class: "timeout",
          cause_code: "ETIMEDOUT",
        });
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("integration invoke explains how to post an approval card when login has no target", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-approval-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(async () => {
    await assert.rejects(
      async () => {
        await integrationInvokeCommand.handler(
          commandContext({
            io,
            requests,
            loginResponse: ok({
              status: "approval_required",
              service: service(),
              scopes: ["identity"],
              requestId: "agent-login-request",
              approval: {
                requestId: "approval-request",
                target: null,
                actionCardMessageId: null,
              },
            }),
          }),
          undefined,
          undefined,
          {
            service: "pr-diff-viewer-3c05bd",
            action: "render-patch",
            param: [`patchText=@${patchPath}`],
          },
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INTEGRATION_APPROVAL_REQUIRED");
        assert.match(err.suggestedNextAction ?? "", /Approval request approval-request exists/);
        assert.match(err.suggestedNextAction ?? "", /no approval card was posted/);
        assert.match(
          err.suggestedNextAction ?? "",
          /raft integration login --service "pr-diff-viewer-3c05bd" --target "<current-channel-or-thread>"/,
        );
        assert.match(err.suggestedNextAction ?? "", /post the owner\/admin approval card/);
        return true;
      },
    );
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/login",
      body: { service: "pr-diff-viewer-3c05bd", scopes: undefined, target: undefined },
    },
  ]);
});

test("integration invoke reports the approval card prepared for its target", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-approval-target-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(async () => {
    await assert.rejects(
      async () => {
        await integrationInvokeCommand.handler(
          commandContext({
            io,
            requests,
            loginResponse: ok({
              status: "approval_required",
              service: service(),
              scopes: ["identity"],
              requestId: "agent-login-request",
              approval: {
                requestId: "approval-request",
                target: "#proj-auth:ae464e21",
                actionCardMessageId: "approval-card-message",
              },
            }),
          }),
          undefined,
          undefined,
          {
            service: "pr-diff-viewer-3c05bd",
            action: "render-patch",
            param: [`patchText=@${patchPath}`],
            target: "#proj-auth:ae464e21",
          },
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INTEGRATION_APPROVAL_REQUIRED");
        assert.match(err.suggestedNextAction ?? "", /Approval request approval-request/);
        assert.match(err.suggestedNextAction ?? "", /#proj-auth:ae464e21/);
        assert.match(err.suggestedNextAction ?? "", /approval-card-message/);
        assert.match(err.suggestedNextAction ?? "", /rerun the same integration invoke command/);
        assert.match(
          err.suggestedNextAction ?? "",
          /raft integration login --service "pr-diff-viewer-3c05bd" --target "#proj-auth:ae464e21"/,
        );
        return true;
      },
    );
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    {
      method: "POST",
      path: "/internal/agent-api/integrations/login",
      body: { service: "pr-diff-viewer-3c05bd", scopes: undefined, target: "#proj-auth:ae464e21" },
    },
  ]);
});

test("integration invoke reuses stored service session without creating a fresh handoff request", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-cache-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const profileDir = path.join(tmp, "profile");
  const sessionDir = path.join(profileDir, "integrations");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "pr-diff-viewer-3c05bd.json"), JSON.stringify({
    serviceId: "svc-1",
    clientId: "pr-diff-viewer-3c05bd",
    returnUrl: "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback",
    cookies: [{
      pair: "pr-diff-viewer-session=session-123",
      host: "pr-diff-viewer.botiverse.workers.dev",
      path: "/",
      secure: false,
    }],
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  }), "utf8");
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(async (fetchCalls) => {
    await integrationInvokeCommand.handler(
      commandContext({ io, requests, profileDir }),
      undefined,
      undefined,
      {
        service: "pr-diff-viewer-3c05bd",
        action: "render-patch",
        param: [`patchText=@${patchPath}`, "author=Cardy"],
      },
    );

    assert.deepEqual(fetchCalls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      "https://pr-diff-viewer.botiverse.workers.dev/api/render-patch",
    ]);
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
  assert.match(stdout.join(""), /Action invoked: render-patch/);
});

test("integration invoke reports a clear login next action when service rejects cached session", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-stale-session-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const profileDir = path.join(tmp, "profile");
  const sessionDir = path.join(profileDir, "integrations");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, "pr-diff-viewer-3c05bd.json"), JSON.stringify({
    serviceId: "svc-1",
    clientId: "pr-diff-viewer-3c05bd",
    returnUrl: "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback",
    cookies: [{
      pair: "pr-diff-viewer-session=session-123",
      host: "pr-diff-viewer.botiverse.workers.dev",
      path: "/",
      secure: false,
    }],
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
  }), "utf8");
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(
    async (fetchCalls) => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io, requests, profileDir }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              action: "render-patch",
              param: [`patchText=@${patchPath}`, "author=Cardy"],
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_INVOKE_FAILED");
          assert.match(err.message, /service session was rejected or expired \(HTTP 401\)/);
          assert.match(
            err.suggestedNextAction ?? "",
            /raft integration login --service pr-diff-viewer-3c05bd/,
          );
          return true;
        },
      );

      assert.deepEqual(fetchCalls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
        "https://pr-diff-viewer.botiverse.workers.dev/api/render-patch",
      ]);
    },
    { actionStatus: 401, actionBody: { error: "unauthorized" } },
  );

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration invoke renders structured non-2xx status and redacted response body with or without --json", async () => {
  const failureBody = {
    error: {
      code: "INVALID_BODY",
      message: "body.serverId is required",
      details: {
        expected: { serverId: "uuid" },
        apiKey: "plain-secret-value",
        observed: "sk_agent_super-secret",
        trace: "JWT eyJhbGciOiJIUzI1NiJ9.payload.signature",
      },
    },
    authorization: "Bearer service-session-secret",
  };
  const expectedBody = JSON.stringify({
    error: {
      code: "INVALID_BODY",
      message: "body.serverId is required",
      details: {
        expected: { serverId: "uuid" },
        apiKey: "<redacted>",
        observed: "sk_agent_<redacted>",
        trace: "JWT <redacted>",
      },
    },
    authorization: "<redacted>",
  });

  for (const json of [false, true]) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-error-body-"));
    const patchPath = path.join(tmp, "change.patch");
    fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
    const { io, stdout, stderr } = memoryIo();

    await withMockFetch(
      async () => {
        await assert.rejects(
          () => parseCommand([
            "integration",
            "invoke",
            "--service",
            "pr-diff-viewer-3c05bd",
            "--action",
            "render-patch",
            "--param",
            `patchText=@${patchPath}`,
            "--param",
            "author=Cardy",
            ...(json ? ["--json"] : []),
          ], { io, profileDir: path.join(tmp, "profile") }),
          /CliExit\(1\)/,
        );
      },
      {
        actionStatus: 422,
        actionBody: failureBody,
        actionContentType: "application/problem+json; charset=utf-8",
      },
    );

    assert.deepEqual(stdout, []);
    if (json) {
      assert.deepEqual(JSON.parse(stderr.join("")), {
        ok: false,
        error: {
          code: "INTEGRATION_INVOKE_FAILED",
          message: `service action failed (HTTP 422); response body: ${expectedBody}`,
          fault_domain: null,
          layer: null,
          retryable: null,
          effect: null,
          correlation_id: null,
        },
      });
    } else {
      assert.equal(
        stderr.join(""),
        `Error: service action failed (HTTP 422); response body: ${expectedBody}\n`
          + "Code: INTEGRATION_INVOKE_FAILED\n",
      );
    }
    assert.doesNotMatch(stderr.join(""), /\[object Object\]|plain-secret-value|super-secret|service-session-secret/);
  }
});

test("integration invoke recursively redacts structured error fields even when Content-Type is text/plain", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-wrong-error-type-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io, stderr } = memoryIo();

  await withMockFetch(
    async () => {
      await assert.rejects(
        () => parseCommand([
          "integration",
          "invoke",
          "--service",
          "pr-diff-viewer-3c05bd",
          "--action",
          "render-patch",
          "--param",
          `patchText=@${patchPath}`,
          "--param",
          "author=Cardy",
        ], { io, profileDir: path.join(tmp, "profile") }),
        /CliExit\(1\)/,
      );
    },
    {
      actionStatus: 422,
      actionBody: { error: { apiKey: "plain-secret-value" } },
      actionContentType: "text/plain",
    },
  );

  assert.equal(
    stderr.join(""),
    'Error: service action failed (HTTP 422); response body: {"error":{"apiKey":"<redacted>"}}\n'
      + "Code: INTEGRATION_INVOKE_FAILED\n",
  );
  assert.doesNotMatch(stderr.join(""), /plain-secret-value/);
});

test("integration invoke preserves a controlled typed integer-validation error instead of rendering object coercion", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-integer-validation-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io, stderr } = memoryIo();

  await withMockFetch(
    async () => {
      await assert.rejects(
        () => parseCommand([
          "integration",
          "invoke",
          "--service",
          "pr-diff-viewer-3c05bd",
          "--action",
          "render-patch",
          "--param",
          `patchText=@${patchPath}`,
          "--param",
          "author=Cardy",
        ], { io, profileDir: path.join(tmp, "profile") }),
        /CliExit\(1\)/,
      );
    },
    {
      actionStatus: 400,
      actionBody: {
        error: {
          code: "INVALID_BODY",
          message: "expectedConfigVersion must be an integer",
          details: { field: "expectedConfigVersion", receivedType: "string" },
        },
      },
    },
  );

  assert.equal(
    stderr.join(""),
    "Error: service action failed (HTTP 400); response body: "
      + '{"error":{"code":"INVALID_BODY","message":"expectedConfigVersion must be an integer","details":{"field":"expectedConfigVersion","receivedType":"string"}}}\n'
      + "Code: INTEGRATION_INVOKE_FAILED\n",
  );
  assert.doesNotMatch(stderr.join(""), /\[object Object\]/);
});

test("integration invoke includes status and redacts credentials in a text error response", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-text-error-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io } = memoryIo();

  await withMockFetch(
    async () => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              action: "render-patch",
              param: [`patchText=@${patchPath}`, "author=Cardy"],
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_INVOKE_FAILED");
          assert.equal(
            err.message,
            "service action failed (HTTP 409); response body: denied Bearer <redacted> for sk_machine_<redacted>",
          );
          return true;
        },
      );
    },
    {
      actionStatus: 409,
      actionBody: "denied Bearer session-secret for sk_machine_machine-secret",
      actionContentType: "text/plain",
    },
  );
});

test("integration invoke keeps malformed JSON-shaped plain-text errors readable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-invoke-malformed-error-"));
  const patchPath = path.join(tmp, "change.patch");
  fs.writeFileSync(patchPath, "diff --git a/app.ts b/app.ts\n", "utf8");
  const { io } = memoryIo();

  await withMockFetch(
    async () => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              action: "render-patch",
              param: [`patchText=@${patchPath}`, "author=Cardy"],
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_INVOKE_FAILED");
          assert.equal(
            err.message,
            'service action failed (HTTP 422); response body: {"error":{"message":"still processing"',
          );
          return true;
        },
      );
    },
    {
      actionStatus: 422,
      actionBody: '{"error":{"message":"still processing"',
      actionContentType: "text/plain",
    },
  );
});

test("integration invoke does not forward callback cookies to a different action host", async () => {
  const { io } = memoryIo();
  const remoteManifest = manifest();
  remoteManifest.execution = { mode: "http_api", base_url: "https://api.pr-diff-viewer.example" };

  await withMockFetch(
    async (fetchCalls) => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              action: "render-patch",
              param: ["patchText=diff"],
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_INVOKE_FAILED");
          assert.match(err.message, /cookie host and Path cover the action endpoint/);
          return true;
        },
      );

      assert.deepEqual(fetchCalls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
        "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request",
      ]);
    },
    { manifest: remoteManifest },
  );
});

test("integration invoke honors callback cookie Path before action requests", async () => {
  const { io } = memoryIo();

  await withMockFetch(
    async (fetchCalls) => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              action: "render-patch",
              param: ["patchText=diff"],
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_INVOKE_FAILED");
          assert.match(err.message, /cookie host and Path cover the action endpoint/);
          return true;
        },
      );

      assert.deepEqual(fetchCalls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
        "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request",
      ]);
    },
    { callbackSetCookie: "pr-diff-viewer-session=session-123; HttpOnly; Max-Age=604800" },
  );
});

test("integration invoke does not forward Secure callback cookies to http action URLs", async () => {
  const { io } = memoryIo();
  const insecureManifest = manifest();
  insecureManifest.app_origin = "http://pr-diff-viewer.botiverse.workers.dev";
  insecureManifest.auth = {
    type: "login_with_raft",
    login_url: "http://pr-diff-viewer.botiverse.workers.dev/login",
  };
  insecureManifest.execution = { mode: "http_api", base_url: "http://pr-diff-viewer.botiverse.workers.dev" };

  await withMockFetch(
    async (fetchCalls) => {
      await assert.rejects(
        async () => {
          await integrationInvokeCommand.handler(
            commandContext({ io }),
            undefined,
            undefined,
            {
              service: "pr-diff-viewer-3c05bd",
              action: "render-patch",
              param: ["patchText=diff"],
            },
          );
        },
        (err: unknown) => {
          assert.ok(err instanceof CliError);
          assert.equal(err.code, "INTEGRATION_INVOKE_FAILED");
          assert.match(err.message, /cookie host and Path cover the action endpoint/);
          return true;
        },
      );

      assert.deepEqual(fetchCalls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
        "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request",
      ]);
    },
    {
      manifest: insecureManifest,
      callbackSetCookie: "pr-diff-viewer-session=session-123; HttpOnly; Secure; Path=/; Max-Age=604800",
    },
  );
});

test("integration invoke validates required manifest parameters before login", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withMockFetch(async () => {
    await assert.rejects(
      async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, requests }),
          undefined,
          undefined,
          { service: "pr-diff-viewer-3c05bd", action: "render-patch" },
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_ARG");
        assert.match(err.message, /missing required parameter patchText/);
        return true;
      },
    );
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration invoke rejects v1 structured fields passed through text --param before login", async () => {
  const typedManifest = v1Manifest();
  const action = typedManifest.actions[0];
  assert.ok(action);
  action.input_schema = {
    type: "object",
    required: ["filters"],
    properties: {
      filters: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  };
  const { io, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];

  await withV1Fetch(typedManifest, async (calls) => {
    await assert.rejects(
      () => parseCommand([
        "integration",
        "invoke",
        "--service",
        "pr-diff-viewer-3c05bd",
        "--action",
        "get_status",
        "--param",
        'filters=["ready"]',
      ], { io, requests }),
      /CliExit\(1\)/,
    );
    assert.match(stderr.join(""), /--param filters is text-only/);
    assert.match(stderr.join(""), /manifest declares array/);
    assert.match(stderr.join(""), /use --data-json or --data-file for typed JSON/);
    assert.match(stderr.join(""), /Code: INVALID_ARG/);
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration v1 list-actions JSON exposes typed actor-relative readiness without login", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await withV1Fetch(v1Manifest(), async (calls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "pr-diff-viewer-3c05bd",
      "--list-actions",
      "--json",
    ], { io, requests });
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
  const payload = JSON.parse(stdout.join(""));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.actions[0].effect, "read");
  assert.equal(payload.data.actionReadiness[0].actor.id, "agent-123");
  assert.equal(payload.data.actionReadiness[0].authority.status, "unknown");
  assert.equal(payload.data.actionReadiness[0].overall, "auth_not_ready");
});

test("integration v1 preflight binds the exact action and existing session without dispatch", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-preflight-profile-"));
  writeStoredV1Session(profileDir, "/api");

  await withV1Fetch(v1Manifest(), async (calls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "pr-diff-viewer-3c05bd",
      "--action",
      "get_status",
      "--preflight",
      "--json",
    ], { io, requests, profileDir });
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
  const payload = JSON.parse(stdout.join(""));
  assert.equal(payload.ok, true);
  assert.deepEqual(Object.keys(payload.data).sort(), [
    "action",
    "auth",
    "invoke",
    "manifest",
    "schema",
    "service_id",
    "transport",
  ]);
  assert.equal(payload.data.schema, "raft-integration-invoke-preflight.v1");
  assert.equal(payload.data.service_id, "pr-diff-viewer-3c05bd");
  assert.deepEqual(payload.data.action, {
    name: "get_status",
    effect: "read",
    contract_status: "valid",
  });
  assert.deepEqual(Object.keys(payload.data.manifest).sort(), ["observed_at", "source", "status"]);
  assert.equal(payload.data.manifest.status, "valid");
  assert.equal(payload.data.manifest.source, "live_manifest_probe");
  assert.deepEqual(payload.data.auth, { status: "session_bound" });
  assert.deepEqual(payload.data.invoke, { status: "attemptable_unverified" });
  assert.deepEqual(payload.data.transport, { status: "not_attempted" });
  assert.ok(!stdout.join("").includes("preflight-secret"));
  assert.ok(!stdout.join("").includes("agent-123"));
});

test("integration v1 preflight fails closed when the invoke-path manifest is unreachable", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await withManifestResponse(
    () => {
      throw new TypeError("fetch failed");
    },
    async (calls) => {
      await assert.rejects(
        async () => integrationInvokeCommand.handler(
          commandContext({ io, requests }),
          undefined,
          undefined,
          { service: "pr-diff-viewer-3c05bd", action: "get_status", preflight: true },
        ),
        (error: unknown) =>
          error instanceof CliError
          && String(error.code) === "INTEGRATION_MANIFEST_UNREACHABLE"
          && error.fault_domain === "manifest_transport",
      );
      assert.deepEqual(calls, [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      ]);
    },
  );
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("the same service can list actions before invoke preflight reports a bounded refetch cause without dispatch", async () => {
  const listIo = memoryIo();
  const preflightIo = memoryIo();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "raft-integration-refetch-fixture-"));
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  let manifestFetches = 0;
  await withManifestResponse(
    (url) => {
      manifestFetches += 1;
      if (manifestFetches === 1) {
        return responseWithUrl(JSON.stringify(v1Manifest()), {
          status: 200,
          headers: { "content-type": "application/json" },
        }, url);
      }
      const timeoutCause = Object.assign(new Error("connection timed out"), { code: "ETIMEDOUT" });
      throw Object.assign(new TypeError("fetch failed"), { cause: timeoutCause });
    },
    async (calls) => {
      await integrationInvokeCommand.handler(
        commandContext({ io: listIo.io, requests, profileDir }),
        undefined,
        undefined,
        { service: "pr-diff-viewer-3c05bd", listActions: true, json: true },
      );
      const listPayload = JSON.parse(listIo.stdout.join(""));
      assert.equal(listPayload.ok, true);
      assert.equal(listPayload.data.actions[0].name, "get_status");

      await assert.rejects(
        async () => integrationInvokeCommand.handler(
          commandContext({ io: preflightIo.io, requests, profileDir }),
          undefined,
          undefined,
          { service: "pr-diff-viewer-3c05bd", action: "get_status", preflight: true },
        ),
        (error: unknown) => {
          assert.ok(error instanceof CliError);
          assert.equal(String(error.code), "INTEGRATION_MANIFEST_UNREACHABLE");
          assert.equal(error.fault_domain, "manifest_transport");
          assert.equal(error.retryable, true);
          assert.deepEqual(error.details, {
            manifest_url: "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
            actual_url: "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
            cause_class: "timeout",
            cause_code: "ETIMEDOUT",
            http_status: null,
          });
          assert.match(error.suggestedNextAction ?? "", /10 second manifest timeout/);
          return true;
        },
      );

      assert.deepEqual(calls, [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      ]);
    },
  );
  assert.equal(manifestFetches, 2);
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration v1 preflight fails closed on an invalid invoke-path manifest", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await withManifestResponse(
    (url) => responseWithUrl(JSON.stringify({ schema: "raft-agent-manifest.v1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }, url),
    async (calls) => {
      await assert.rejects(
        async () => integrationInvokeCommand.handler(
          commandContext({ io, requests }),
          undefined,
          undefined,
          { service: "pr-diff-viewer-3c05bd", action: "get_status", preflight: true },
        ),
        (error: unknown) =>
          error instanceof CliError
          && String(error.code) === "INTEGRATION_MANIFEST_INVALID"
          && error.fault_domain === "manifest_schema",
      );
      assert.deepEqual(calls, [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      ]);
    },
  );
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration v1 preflight fails closed on action drift without login or dispatch", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await withV1Fetch(v1Manifest(), async (calls) => {
    await assert.rejects(
      async () => integrationInvokeCommand.handler(
        commandContext({ io, requests }),
        undefined,
        undefined,
        { service: "pr-diff-viewer-3c05bd", action: "missing_action", preflight: true },
      ),
      (error: unknown) =>
        error instanceof IntegrationV1Error
        && error.envelope.code === "INTEGRATION_ACTION_UNDECLARED"
        && error.envelope.evidence.transport === "not_attempted",
    );
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration v1 preflight fails closed when the stored session does not bind the exact action", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-preflight-profile-"));
  writeStoredV1Session(profileDir, "/different-action");
  await withV1Fetch(v1Manifest(), async (calls) => {
    await assert.rejects(
      async () => integrationInvokeCommand.handler(
        commandContext({ io, requests, profileDir }),
        undefined,
        undefined,
        { service: "pr-diff-viewer-3c05bd", action: "get_status", preflight: true },
      ),
      (error: unknown) =>
        error instanceof IntegrationV1Error
        && error.envelope.code === "INTEGRATION_AUTH_NOT_READY"
        && error.envelope.evidence.auth === "not_ready"
        && error.envelope.evidence.transport === "not_attempted",
    );
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration v1 preflight rejects payload and login options before any API or file read", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await assert.rejects(
    async () => integrationInvokeCommand.handler(
      commandContext({ io, requests }),
      undefined,
      undefined,
      {
        service: "pr-diff-viewer-3c05bd",
        action: "get_status",
        preflight: true,
        dataFile: "/does/not/exist",
        target: "#ops-hub",
      },
    ),
    (error: unknown) =>
      error instanceof CliError
      && error.code === "INVALID_ARG"
      && error.message.includes("--data-file")
      && error.message.includes("--target"),
  );
  assert.deepEqual(requests, []);
});

test("integration v1 undeclared and local CLI actions fail before login with typed JSON", async () => {
  for (const manifestValue of [v1Manifest(), v1Manifest("local_cli")]) {
    const { io, stderr } = memoryIo();
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    await withV1Fetch(manifestValue, async (calls) => {
      let error: unknown;
      try {
        await integrationInvokeCommand.handler(
          commandContext({ io, requests }),
          undefined,
          undefined,
          {
            service: "pr-diff-viewer-3c05bd",
            action: "missing_action",
            json: true,
          },
        );
      } catch (caught) {
        error = caught;
      }
      assert.ok(error instanceof IntegrationV1Error);
      renderError(io, error);
      assert.deepEqual(calls.map((call) => call.url), [
        "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      ]);
    });
    const payload = JSON.parse(stderr.join(""));
    assert.equal(payload.ok, false);
    assert.equal(
      payload.error.code,
      manifestValue.execution.mode === "local_cli"
        ? "INTEGRATION_LOCAL_CLI_DESIGN_BLOCKED"
        : "INTEGRATION_ACTION_UNDECLARED",
    );
    assert.equal(payload.error.evidence.transport, "not_attempted");
    assert.deepEqual(requests, [
      { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
    ]);
  }
});

test("integration v1 validates input before Agent Login or action dispatch", async () => {
  const { io } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await withV1Fetch(v1Manifest(), async (calls) => {
    await assert.rejects(
      async () => {
        await integrationInvokeCommand.handler(
          commandContext({ io, requests }),
          undefined,
          undefined,
          {
            service: "pr-diff-viewer-3c05bd",
            action: "get_status",
            param: ["unexpected=value"],
          },
        );
      },
      (error: unknown) =>
        error instanceof IntegrationV1Error
        && error.envelope.code === "INTEGRATION_INPUT_INVALID"
        && error.envelope.evidence.transport === "not_attempted",
    );
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
    ]);
  });
  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations", body: undefined },
  ]);
});

test("integration v1 read action emits a typed verified receipt without secrets", async () => {
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  await withV1Fetch(v1Manifest(), async (calls) => {
    await parseCommand([
      "integration",
      "invoke",
      "--service",
      "pr-diff-viewer-3c05bd",
      "--action",
      "get_status",
      "--json",
    ], { io, requests });
    assert.deepEqual(calls.map((call) => call.url), [
      "https://pr-diff-viewer.botiverse.workers.dev/.well-known/slock-agent-manifest.json",
      "https://pr-diff-viewer.botiverse.workers.dev/login/raft/callback?code=agent-login-request",
      "https://pr-diff-viewer.botiverse.workers.dev/api/status",
    ]);
  });

  const rendered = stdout.join("");
  assert.ok(!rendered.includes("v1-session-secret"));
  assert.ok(!rendered.includes("agent-login-request"));
  const payload = JSON.parse(rendered);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.receipt.operation.status, "verified");
  assert.equal(payload.data.receipt.authority.status, "authorized");
  assert.equal(payload.data.receipt.readback.status, "not_applicable");
  assert.equal(payload.data.receipt.target.registered_base_url, "https://pr-diff-viewer.botiverse.workers.dev/api");
  assert.deepEqual(requests.map((request) => request.path), [
    "/internal/agent-api/integrations",
    "/internal/agent-api/integrations/login",
  ]);
  assert.deepEqual(requests[1]?.body, {
    service: "pr-diff-viewer-3c05bd",
    scopes: ["status:read"],
    target: undefined,
  });
});

test("CleanupOutcome cleaned factory is private to the finalizer", () => {
  // Compile-fail mutant: a post-effect callsite must not be able to mint a
  // "cleaned" outcome without actually performing cleanup. The line below is
  // expected to produce TS2341 because `CleanupOutcome.cleaned()` is private.
  // @ts-expect-error TS2341 cleaned is private and only callable inside CleanupOutcome
  CleanupOutcome.cleaned();
});
