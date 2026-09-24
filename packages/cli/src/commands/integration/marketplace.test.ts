import assert from "node:assert/strict";
import test from "node:test";

import type { AgentApiIntegrationMarketplaceResponse } from "@botiverse/raft-shared";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import type { CliIo } from "../../core/io.js";
import { formatMarketplaceApps, integrationMarketplaceCommand } from "./marketplace.js";

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

function marketplaceResponse(): AgentApiIntegrationMarketplaceResponse {
  return {
    surface: "public_marketplace",
    metadataTrust: "untrusted_app_supplied",
    query: "me.build",
    limit: 5,
    apps: [{
      id: "app-1",
      clientId: "me-build-homepage",
      name: "Me.Build Homepage",
      description: "Publish a personal homepage for an Agent",
      category: "Productivity",
      dataAccessSummary: "Basic profile only",
      homepageUrl: "https://me.build",
      agentManifestUrl: "https://me.build/.well-known/raft-agent-manifest.json",
      agentManifestUrlSource: "well_known",
      allowedScopes: ["openid", "profile"],
      logoUrl: null,
      installedOnServer: false,
      updatedAt: "2026-08-06T00:00:00.000Z",
    }],
  };
}

function context(io: CliIo, requests: string[]) {
  return createCommandContext({
    io,
    env: {} as NodeJS.ProcessEnv,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (_method: string, path: string): Promise<ApiResponse<unknown>> => {
        requests.push(path);
        return {
          ok: true,
          status: 200,
          error: null,
          data: marketplaceResponse(),
        };
      },
    }) as any,
  });
}

test("integration marketplace searches public apps and gives the exact login handoff", async () => {
  const { io, stdout } = memoryIo();
  const requests: string[] = [];
  await integrationMarketplaceCommand.handler(context(io, requests), "me.build", { limit: "5" });

  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /^\/internal\/agent-api\/integrations\/marketplace\?/u);
  assert.match(requests[0] ?? "", /query=me.build/u);
  assert.match(requests[0] ?? "", /limit=5/u);
  const output = stdout.join("");
  assert.match(output, /untrusted publisher-supplied metadata/u);
  assert.match(output, /Me\.Build Homepage \(me-build-homepage\)/u);
  assert.match(output, /installed on this Server: no/u);
  assert.match(output, /raft integration login --service "me-build-homepage"/u);
});

test("integration marketplace JSON preserves the explicit public and untrusted-metadata boundaries", async () => {
  const { io, stdout } = memoryIo();
  await integrationMarketplaceCommand.handler(context(io, []), "me.build", { json: true });
  const body = JSON.parse(stdout.join("")) as { ok: boolean; data: AgentApiIntegrationMarketplaceResponse };
  assert.equal(body.ok, true);
  assert.equal(body.data.surface, "public_marketplace");
  assert.equal(body.data.metadataTrust, "untrusted_app_supplied");
  assert.equal(body.data.apps[0]?.clientId, "me-build-homepage");
});

test("integration marketplace neutralizes terminal control characters in publisher text", () => {
  const response = marketplaceResponse();
  response.apps[0]!.name = "Me.Build\u001b[2J Homepage";
  response.apps[0]!.description = "Publish\nwithout terminal control";
  const output = formatMarketplaceApps(response);
  assert.equal(output.includes("\u001b"), false);
  assert.match(output, /Me\.Build \[2J Homepage/u);
  assert.match(output, /Publish without terminal control/u);
});

test("integration marketplace rejects invalid limits before making a request", async () => {
  const { io } = memoryIo();
  const requests: string[] = [];
  await assert.rejects(
    async () => integrationMarketplaceCommand.handler(context(io, requests), undefined, { limit: "51" }),
    /--limit must be an integer from 1 to 50/u,
  );
  assert.deepEqual(requests, []);
});
