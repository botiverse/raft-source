import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { AgentContext } from "../../auth/env.js";
import type { ApiResponse } from "../../client.js";
import { createCommandContext } from "../../core/context.js";
import { CliError } from "../../core/errors.js";
import type { CliIo } from "../../core/io.js";
import { wikiManifestCommand, wikiPublishCommand, wikiReadCommand } from "./index.js";

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

const agentContext: AgentContext = {
  agentId: "11111111-1111-4111-8111-111111111111",
  serverUrl: "https://raft.example",
  serverId: "22222222-2222-4222-8222-222222222222",
  token: "secret-token",
  clientMode: "self-hosted-runner",
  secretSource: "profile-credential-file",
  activeCapabilities: null,
};

test("wiki manifest prints the canonical manifest envelope as JSON", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const response = {
    configured: true as const,
    wikiSpaceId: "33333333-3333-4333-8333-333333333333",
    etag: "\"manifest-v1\"",
    manifest: { revision: 1 },
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path: requestPath, body });
        return { ok: true, status: 200, error: null, data: response };
      },
    }) as any,
  });

  await wikiManifestCommand.handler(ctx);

  assert.deepEqual(requests, [{
    method: "GET",
    path: "/internal/agent-api/wiki/manifest",
    body: undefined,
  }]);
  assert.deepEqual(JSON.parse(stdout.join("")), response);
  assert.deepEqual(stderr, []);
});

test("wiki read fetches the current canonical artifact envelope as JSON", async () => {
  const { io, stdout, stderr } = memoryIo();
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const artifactId = "44444444-4444-4444-8444-444444444444";
  const response = {
    configured: true as const,
    wikiSpaceId: "33333333-3333-4333-8333-333333333333",
    etag: "\"manifest-v1\"",
    artifact: {
      id: artifactId,
      artifactType: "page" as const,
      slug: "architecture",
      title: "Architecture",
      summary: "Summary",
      currentUnderstanding: "Current understanding",
      status: "current" as const,
      confidence: "high" as const,
      sourcePolicy: "cached_summary" as const,
      sourceRefs: [],
      revision: {
        id: "55555555-5555-4555-8555-555555555555",
        key: "servers/server/wiki/revisions/artifact/revision.md",
        sha256: "a".repeat(64),
        bytes: 15,
      },
      updatedAt: "2026-07-26T00:00:00.000Z",
    },
    markdown: "# Architecture\n",
  };
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => agentContext,
    createApiClient: () => ({
      request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
        requests.push({ method, path: requestPath, body });
        return { ok: true, status: 200, error: null, data: response };
      },
    }) as any,
  });

  await wikiReadCommand.handler(ctx, artifactId);

  assert.deepEqual(requests, [{
    method: "GET",
    path: `/internal/agent-api/wiki/artifacts/${artifactId}`,
    body: undefined,
  }]);
  assert.deepEqual(JSON.parse(stdout.join("")), response);
  assert.deepEqual(stderr, []);
});

test("wiki read rejects a missing or invalid artifact id before auth or network", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      throw new Error("must not load credentials");
    },
  });

  for (const artifactId of [undefined, "", "not-a-uuid"]) {
    await assert.rejects(
      async () => {
        await wikiReadCommand.handler(ctx, artifactId);
      },
      (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "INVALID_ARG");
        assert.match(error.message, /artifactId must be a full UUID/);
        return true;
      },
    );
  }
});

test("wiki publish reads one JSON payload file and returns the committed envelope", async () => {
  const { io, stdout, stderr } = memoryIo();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "raft-wiki-cli-"));
  const inputPath = path.join(directory, "publication.json");
  const publication = {
    expectedEtag: null,
    manifest: { revision: 1 },
    revisionBodies: [],
  };
  fs.writeFileSync(inputPath, JSON.stringify(publication));
  const requests: Array<{ method: string; path: string; body?: unknown }> = [];
  const response = {
    configured: true as const,
    wikiSpaceId: "33333333-3333-4333-8333-333333333333",
    etag: "\"manifest-v1\"",
    manifest: publication.manifest,
  };
  try {
    const ctx = createCommandContext({
      io,
      loadAgentContext: () => agentContext,
      createApiClient: () => ({
        request: async (method: string, requestPath: string, body?: unknown): Promise<ApiResponse<unknown>> => {
          requests.push({ method, path: requestPath, body });
          return { ok: true, status: 200, error: null, data: response };
        },
      }) as any,
    });

    await wikiPublishCommand.handler(ctx, { input: inputPath });

    assert.deepEqual(requests, [{
      method: "POST",
      path: "/internal/agent-api/wiki/publish",
      body: publication,
    }]);
    assert.deepEqual(JSON.parse(stdout.join("")), response);
    assert.deepEqual(stderr, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("wiki publish fails before auth or network when the input file is invalid", async () => {
  const { io } = memoryIo();
  const ctx = createCommandContext({
    io,
    loadAgentContext: () => {
      throw new Error("must not load credentials");
    },
  });

  await assert.rejects(
    async () => {
      await wikiPublishCommand.handler(ctx, { input: "/missing/wiki-publication.json" });
    },
    (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INVALID_ARG");
      assert.match(error.message, /Could not read Wiki publication JSON/);
      return true;
    },
  );
});
