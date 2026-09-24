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
import type { RegisteredIntegrationService } from "./_format.js";
import {
  IntegrationEnvError,
  integrationEnvCommand,
  resolveIntegrationEnv,
} from "./env.js";
import { validateAgentManifestV0 } from "./manifest.js";

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
    clientId: "drive9",
    name: "Drive9",
    description: null,
    homepageUrl: "https://drive9.ai",
    returnUrl: "https://drive9.ai/login/callback",
    agentManifestUrl: "https://drive9.ai/.well-known/slock-agent-manifest.json",
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    ...overrides,
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

async function withMockFetchResponse<T>(input: {
  body: unknown;
  status?: number;
  contentType?: string;
}, fn: () => Promise<T>): Promise<T> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    const responseBody = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
    const response = new Response(responseBody, {
      status: input.status ?? 200,
      headers: { "content-type": input.contentType ?? "application/json" },
    });
    const resolvedUrl = typeof url === "string" || url instanceof URL ? url.toString() : url.url;
    Object.defineProperty(response, "url", { value: resolvedUrl });
    return response;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

async function withMockFetch<T>(manifest: unknown, fn: () => Promise<T>): Promise<T> {
  return withMockFetchResponse({ body: manifest }, fn);
}

function commandContextForService(input: {
  io: CliIo;
  service: RegisteredIntegrationService;
  requests?: Array<{ method: string; path: string }>;
}) {
  const requests = input.requests ?? [];
  return createCommandContext({
    io: input.io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, requestPath: string): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path: requestPath });
        return {
          ok: true,
          status: 200,
          error: null,
          data: { services: [input.service], activeLogins: [] },
        };
      },
    }) as any,
  });
}

test("resolveIntegrationEnv returns per-agent HOME exports for explicit local_cli boundary", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-env-command-"));
  const result = await resolveIntegrationEnv({
    ctx: agentContext,
    service: service(),
    env: { SLOCK_HOME: tmp } as NodeJS.ProcessEnv,
    fetchManifest: async () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      docs_url: "https://drive9.ai/skill.md",
      execution: { mode: "local_cli", command: "drive9" },
      credential_boundary: { storage: "per_agent_home", forbid_user_home: true },
    }),
  });

  assert.equal(result.kind, "local-env");
  assert.equal(result.profile.command, "drive9");
  assert.equal(
    result.profile.env.HOME,
    path.join(tmp, "integration-profiles", "server-456", "agent-123", "drive9"),
  );
  assert.equal(result.profile.env.HOME, result.profile.env.SLOCK_INTEGRATION_PROFILE_HOME);
});

test("integration env command writes per-agent HOME exports for explicit local_cli boundary", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-env-command-handler-"));
  const previousSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = tmp;
  const { io, stdout } = memoryIo();
  const requests: Array<{ method: string; path: string }> = [];
  try {
    await withMockFetch({
      schema: "slock-agent-manifest.v0",
      docs_url: "https://drive9.ai/skill.md",
      execution: { mode: "local_cli", command: "drive9" },
      credential_boundary: { storage: "per_agent_home", forbid_user_home: true },
    }, async () => {
      await integrationEnvCommand.handler(
        commandContextForService({ io, service: service(), requests }),
        { service: "drive9" },
      );
    });
  } finally {
    if (previousSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlockHome;
  }

  assert.deepEqual(requests, [
    { method: "GET", path: "/internal/agent-api/integrations" },
  ]);
  assert.match(stdout.join(""), /export HOME='/);
  assert.match(stdout.join(""), /integration-profiles\/server-456\/agent-123\/drive9/);
});

test("integration env never materializes credentials for a v1 local CLI surface", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "slock-integration-env-v1-local-"));
  const previousSlockHome = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = tmp;
  const { io, stdout } = memoryIo();
  try {
    await withMockFetch({
      schema: "raft-agent-manifest.v1",
      execution: { mode: "local_cli" },
      credential_boundary: {
        storage: "per_agent_home",
        forbid_user_home: true,
      },
      actions: [],
    }, async () => {
      await integrationEnvCommand.handler(
        commandContextForService({ io, service: service() }),
        { service: "drive9", json: true },
      );
    });
  } finally {
    if (previousSlockHome === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = previousSlockHome;
  }

  const payload = JSON.parse(stdout.join(""));
  assert.equal(payload.ok, true);
  assert.equal(payload.data.requiresLocalEnv, false);
  assert.equal(payload.data.command, null);
  assert.deepEqual(payload.data.env, {});
  assert.match(payload.data.message, /credential materialization are design-blocked/);
  assert.equal(fs.existsSync(path.join(tmp, "integration-profiles")), false);
});

test("integration env command rejects missing --service as INVALID_ARG", async () => {
  const { io } = memoryIo();
  await assert.rejects(
    async () => {
      await integrationEnvCommand.handler(commandContextForService({ io, service: service() }), {});
    },
    (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_ARG");
      assert.match(err.message, /--service must not be empty/);
      return true;
    },
  );
});

test("integration env command returns no-op success when service declares no manifest", async () => {
  const { io, stdout } = memoryIo();
  await integrationEnvCommand.handler(
    commandContextForService({
      io,
      service: service({
        clientId: "plain-app",
        name: "Plain App",
        agentManifestUrl: null,
      }),
    }),
    { service: "plain-app" },
  );

  assert.match(stdout.join(""), /No local CLI environment exports are required/);
  assert.match(stdout.join(""), /manifest: none declared/);
  assert.match(stdout.join(""), /Plain App does not expose an agent behavior manifest/);
  assert.doesNotMatch(stdout.join(""), /export HOME=/);
});

test("integration env command returns JSON no-op success when service declares no manifest", async () => {
  const { io, stdout } = memoryIo();
  await integrationEnvCommand.handler(
    commandContextForService({
      io,
      service: service({
        clientId: "plain-app",
        name: "Plain App",
        agentManifestUrl: null,
      }),
    }),
    { service: "plain-app", json: true },
  );

  const parsed = JSON.parse(stdout.join("")) as {
    ok: boolean;
    data: { manifestUrl: string | null; requiresLocalEnv: boolean; command: string | null; env: Record<string, string> };
  };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.manifestUrl, null);
  assert.equal(parsed.data.requiresLocalEnv, false);
  assert.equal(parsed.data.command, null);
  assert.deepEqual(parsed.data.env, {});
});

test("integration env command treats missing well-known manifest as no-op success", async () => {
  const { io, stdout } = memoryIo();
  await withMockFetchResponse({ body: { error: "not found" }, status: 404 }, async () => {
    await integrationEnvCommand.handler(
      commandContextForService({ io, service: service({ clientId: "well-known-only", name: "Well Known Only" }) }),
      { service: "well-known-only" },
    );
  });

  assert.match(stdout.join(""), /No local CLI environment exports are required/);
  assert.match(stdout.join(""), /agent behavior manifest was not found/);
  assert.doesNotMatch(stdout.join(""), /export HOME=/);
});

test("integration env command treats inferred well-known HTML fallback as no-op success", async () => {
  const { io, stdout } = memoryIo();
  await withMockFetchResponse({ body: "<!doctype html><h1>App</h1>", contentType: "text/html" }, async () => {
    await integrationEnvCommand.handler(
      commandContextForService({
        io,
        service: service({
          clientId: "internal-app",
          name: "Internal App",
          agentManifestUrl: "https://internal-app.example/.well-known/slock-agent-manifest.json",
          agentManifestUrlSource: "well_known",
        }),
      }),
      { service: "internal-app" },
    );
  });

  assert.match(stdout.join(""), /No local CLI environment exports are required/);
  assert.match(stdout.join(""), /agent behavior manifest was not found/);
  assert.doesNotMatch(stdout.join(""), /export HOME=/);
});

test("integration env command fails closed for explicit manifest HTML fallback", async () => {
  const { io } = memoryIo();
  await withMockFetchResponse({ body: "<!doctype html><h1>App</h1>", contentType: "text/html" }, async () => {
    await assert.rejects(
      async () => {
        await integrationEnvCommand.handler(
          commandContextForService({
            io,
            service: service({
              clientId: "explicit-html",
              name: "Explicit HTML",
              agentManifestUrl: "https://explicit.example/agent-manifest.json",
              agentManifestUrlSource: "explicit",
            }),
          }),
          { service: "explicit-html" },
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INTEGRATION_MANIFEST_INVALID");
        assert.match(err.message, /application\/json/);
        return true;
      },
    );
  });
});

test("integration env command returns no-op success for no-boundary manifest without context_check", async () => {
  const { io, stdout } = memoryIo();
  await withMockFetch({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://example.com/skill.md",
    execution: { mode: "local_cli", command: "stateless-cli" },
  }, async () => {
    await integrationEnvCommand.handler(
      commandContextForService({ io, service: service({ clientId: "stateless-cli", name: "Stateless CLI" }) }),
      { service: "stateless-cli" },
    );
  });

  assert.match(stdout.join(""), /No local CLI environment exports are required/);
  assert.match(stdout.join(""), /manifest does not request a Raft-managed local environment/);
  assert.doesNotMatch(stdout.join(""), /export HOME=/);
});

test("integration env command points HTTP API action services to integration invoke", async () => {
  const { io, stdout } = memoryIo();
  await withMockFetch({
    schema: "slock-agent-manifest.v0",
    app_origin: "https://pr-diff-viewer.botiverse.workers.dev",
    execution: { mode: "http_api" },
    auth: { type: "login_with_raft" },
    actions: [{
      name: "render-patch",
      endpoint: { method: "POST", path: "/api/render-patch" },
      parameters: { patchText: { type: "string", required: true } },
    }],
  }, async () => {
    await integrationEnvCommand.handler(
      commandContextForService({
        io,
        service: service({ clientId: "pr-diff-viewer-3c05bd", name: "PR Diff Viewer" }),
      }),
      { service: "pr-diff-viewer-3c05bd" },
    );
  });

  assert.match(stdout.join(""), /manifest exposes HTTP API actions; no local CLI env is required/);
  assert.match(stdout.join(""), /API actions: render-patch/);
  assert.match(stdout.join(""), /raft integration invoke --service "pr-diff-viewer-3c05bd" --list-actions/);
  assert.doesNotMatch(stdout.join(""), /export HOME=/);
});

test("integration env command includes HTTP API actions in JSON no-op output", async () => {
  const { io, stdout } = memoryIo();
  await withMockFetch({
    schema: "slock-agent-manifest.v0",
    app_origin: "https://pr-diff-viewer.botiverse.workers.dev",
    execution: { mode: "http_api" },
    actions: [{ name: "render-patch", endpoint: { method: "POST", path: "/api/render-patch" } }],
  }, async () => {
    await integrationEnvCommand.handler(
      commandContextForService({
        io,
        service: service({ clientId: "pr-diff-viewer-3c05bd", name: "PR Diff Viewer" }),
      }),
      { service: "pr-diff-viewer-3c05bd", json: true },
    );
  });

  const parsed = JSON.parse(stdout.join("")) as { data: { actions: string[]; requiresLocalEnv: boolean } };
  assert.equal(parsed.data.requiresLocalEnv, false);
  assert.deepEqual(parsed.data.actions, ["render-patch"]);
});

test("integration env command fails closed when per_agent_home omits forbid_user_home=true", async () => {
  const { io } = memoryIo();
  await withMockFetch({
    schema: "slock-agent-manifest.v0",
    docs_url: "https://drive9.ai/skill.md",
    execution: { mode: "local_cli", command: "drive9" },
    credential_boundary: { storage: "per_agent_home" },
  }, async () => {
    await assert.rejects(
      async () => {
        await integrationEnvCommand.handler(commandContextForService({ io, service: service() }), { service: "drive9" });
      },
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INTEGRATION_MANIFEST_UNSUPPORTED");
        assert.match(err.message, /forbid_user_home=true/);
        return true;
      },
    );
  });
});

test("resolveIntegrationEnv treats absent manifests as no-op success", async () => {
  const result = await resolveIntegrationEnv({
    ctx: agentContext,
    service: service({
      clientId: "plain-app",
      name: "Plain App",
      agentManifestUrl: null,
    }),
  });

  assert.equal(result.kind, "no-local-env");
  assert.equal(result.manifestUrl, null);
  assert.equal(result.manifest, null);
  assert.equal(result.message, "Plain App does not expose an agent behavior manifest; no local CLI env is required");
});

test("resolveIntegrationEnv treats HTTP 404 manifests as no-op success", async () => {
  const result = await resolveIntegrationEnv({
    ctx: agentContext,
    service: service({ clientId: "well-known-only", name: "Well Known Only" }),
    fetchManifest: async () => {
      const { AgentManifestFetchError } = await import("./manifest.js");
      throw new AgentManifestFetchError("manifest fetch failed with HTTP 404", 404);
    },
  });

  assert.equal(result.kind, "no-local-env");
  assert.equal(result.manifest, null);
  assert.equal(result.message, "agent behavior manifest was not found; no local CLI env is required");
});

test("resolveIntegrationEnv treats no-boundary manifests as no-op success even without context_check", async () => {
  const result = await resolveIntegrationEnv({
    ctx: agentContext,
    service: service({ clientId: "stateless-cli", name: "Stateless CLI" }),
    fetchManifest: async () => validateAgentManifestV0({
      schema: "slock-agent-manifest.v0",
      docs_url: "https://example.com/skill.md",
      execution: { mode: "local_cli", command: "stateless-cli" },
    }),
  });

  assert.equal(result.kind, "no-local-env");
  assert.equal(result.message, "manifest does not request a Raft-managed local environment");
  assert.ok(result.manifest);
  assert.equal(result.manifest.context_check, undefined);
});

test("resolveIntegrationEnv fails closed when per_agent_home omits forbid_user_home=true", async () => {
  await assert.rejects(
    async () => {
      await resolveIntegrationEnv({
        ctx: agentContext,
        service: service(),
        fetchManifest: async () => validateAgentManifestV0({
          schema: "slock-agent-manifest.v0",
          docs_url: "https://drive9.ai/skill.md",
          execution: { mode: "local_cli", command: "drive9" },
          credential_boundary: { storage: "per_agent_home" },
        }),
      });
    },
    (err: unknown) => {
      assert.ok(err instanceof IntegrationEnvError);
      assert.equal(err.code, "INTEGRATION_MANIFEST_UNSUPPORTED");
      assert.match(err.message, /forbid_user_home=true/);
      return true;
    },
  );
});
