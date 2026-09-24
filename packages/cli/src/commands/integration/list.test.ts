import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
  projectAgentLoginIntegrationInventory,
} from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { integrationListCommand, integrationListJsonResponse } from "./list.js";

function memoryIo(): { io: CliIo; stdout: string[] } {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdout: { write: (chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; } },
      stderr: { write: () => true },
    },
  };
}

const agentContext: AgentContext = {
  agentId: "agent-1",
  serverId: "server-1",
  serverUrl: "https://api.raft.test",
  token: "secret",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

function response(): ApiResponse<unknown> {
  return {
    ok: true,
    status: 200,
    error: null,
    data: {
      services: [
        {
          id: "survey-id",
          clientId: "slock-survey",
          appType: "slock_builtin",
          name: "Raft Survey",
          description: null,
          homepageUrl: "https://survey.example",
          returnUrl: "https://survey.example/auth/callback",
          agentManifestUrl: "https://survey.example/.well-known/raft-agent-manifest.json",
          agentManifestUrlSource: "explicit",
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
        {
          id: "web-id",
          clientId: "web-only",
          appType: "server_local",
          name: "Web Only",
          description: null,
          homepageUrl: "https://web.example",
          returnUrl: "https://web.example/auth/callback",
          agentManifestUrl: null,
          createdAt: "2026-07-23T00:00:00.000Z",
          updatedAt: "2026-07-23T00:00:00.000Z",
        },
      ],
      activeLogins: [
        {
          id: "grant-1",
          serviceId: "survey-id",
          clientId: "slock-survey",
          appType: "slock_builtin",
          name: "Raft Survey",
          description: null,
          homepageUrl: "https://survey.example",
          returnUrl: "https://survey.example/auth/callback",
          agentManifestUrl: "https://survey.example/.well-known/raft-agent-manifest.json",
          agentManifestUrlSource: "explicit",
          scopes: ["identity"],
          createdAt: "2026-07-23T00:00:00.000Z",
        },
      ],
    },
  };
}

function context(io: CliIo) {
  return createCommandContext({
    io,
    env: {} as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string) => {
        assert.equal(path, "/internal/agent-api/integrations");
        return response();
      },
    }) as any,
  });
}

test("integration list reports only registry and login facts without external fan-out", async () => {
  const previousFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("list must not probe external manifests");
  }) as typeof fetch;
  try {
    const { io, stdout } = memoryIo();
    await integrationListCommand.handler(context(io), {});
    const output = stdout.join("");

    assert.equal(fetches, 0);
    assert.ok(output.startsWith(AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.heading));
    assert.ok(output.includes(AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.exclusion));
    assert.ok(output.includes(AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.boundary));
    assert.match(output, /Raft Survey[\s\S]*session: active login/);
    assert.match(output, /Raft Survey[\s\S]*agent behavior manifest: https:\/\/survey\.example/);
    assert.match(output, /Web Only[\s\S]*session: not logged in/);
    assert.doesNotMatch(output, /manifest status:/);
    assert.doesNotMatch(output, /action surface:/);
    assert.doesNotMatch(output, /evidence ceiling:/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("integration list JSON preserves the registry response without synthesized readiness", async () => {
  const { io, stdout } = memoryIo();
  await integrationListCommand.handler(context(io), { json: true });
  const body = JSON.parse(stdout.join("")) as {
    data?: Record<string, unknown>;
    observationScope?: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(body.data ?? {}).sort(), ["activeLogins", "services"]);
  assert.equal("manifestObservations" in (body.data ?? {}), false);
  assert.deepEqual(body.observationScope, AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE);
});

test("integration list JSON projects a structured scope mutation into its machine receipt", () => {
  const projection = projectAgentLoginIntegrationInventory({
    ...AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
    includes: ["built_in_raft_apps", "registered_services"],
  });
  const data = response().data as Parameters<typeof integrationListJsonResponse>[0];
  const body = integrationListJsonResponse(data, projection);

  assert.equal(body.observationScope, projection.observationScope);
  assert.deepEqual(body.observationScope.includes, ["built_in_raft_apps", "registered_services"]);
});
