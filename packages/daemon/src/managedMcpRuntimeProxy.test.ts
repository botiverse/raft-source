import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  ManagedMcpCallRequest,
  ManagedMcpRuntimeSnapshot,
} from "@botiverse/raft-shared";
import {
  __resetManagedMcpRuntimeProxyForTest,
  installManagedMcpRuntimeJsonOverlay,
  prepareManagedMcpRuntimeProxy,
  registerManagedMcpRuntimeProxy,
  unregisterManagedMcpRuntimeProxyForLaunch,
  writeManagedMcpRuntimeConfigFile,
} from "./managedMcpRuntimeProxy.js";

const mcpServerId = "22222222-2222-4222-8222-222222222222";

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "raft-managed-mcp-runtime-"),
  );
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("managed MCP discovery failures are fail-soft before non-Pi runtime launch", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const status of [403, 503]) {
      const warnings: string[] = [];
      globalThis.fetch = (async () => new Response(JSON.stringify({
        code: `unsafe-${status}-detail`,
      }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
      const handle = await prepareManagedMcpRuntimeProxy({
        agentId: `agent-discovery-${status}`,
        launchId: `launch-discovery-${status}`,
        serverUrl: "https://raft.test",
        agentCredentialKey: "sk_agent_test",
        onWarning: (warning) => warnings.push(warning),
      });
      assert.equal(handle, null);
      assert.deepEqual(warnings, [
        `Managed MCP discovery unavailable for this session [reason=discovery_failed,http_status=${status}]`,
      ]);
      assert.equal(warnings[0]!.includes("sk_agent_test"), false);
      assert.equal(warnings[0]!.includes(`unsafe-${status}-detail`), false);
    }

    const warnings: string[] = [];
    globalThis.fetch = (async () => {
      throw new TypeError("network unavailable with unsafe-network-detail");
    }) as typeof fetch;
    const handle = await prepareManagedMcpRuntimeProxy({
      agentId: "agent-discovery-network",
      launchId: "launch-discovery-network",
      serverUrl: "https://raft.test",
      agentCredentialKey: "sk_agent_test",
      onWarning: (warning) => warnings.push(warning),
    });
    assert.equal(handle, null);
    assert.deepEqual(warnings, [
      "Managed MCP discovery unavailable for this session [reason=discovery_failed,transport=network]",
    ]);
    assert.equal(warnings[0]!.includes("unsafe-network-detail"), false);
  } finally {
    globalThis.fetch = originalFetch;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("managed MCP silent unavailability paths emit bounded warnings", async () => {
  const originalFetch = globalThis.fetch;
  const warnings: string[] = [];
  let fetchCalls = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({
        catalogVersion: 2,
        tools: [{
          mcpServerId,
          serverName: "unsafe-private-server",
          toolName: "unsafe-private-tool",
          runtimeName: "unsafe_private_runtime",
          inputSchema: { type: "object" },
          configVersion: 1,
          assignmentVersion: 1,
        }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    assert.equal(await prepareManagedMcpRuntimeProxy({
      agentId: "agent-missing-server",
      agentCredentialKey: "unsafe-agent-credential",
      onWarning: (warning) => warnings.push(warning),
    }), null);
    assert.equal(fetchCalls, 0);

    assert.equal(await prepareManagedMcpRuntimeProxy({
      agentId: "agent-missing-credential",
      serverUrl: "https://unsafe-private-server.test",
      onWarning: (warning) => warnings.push(warning),
    }), null);
    assert.equal(fetchCalls, 0);

    assert.equal(await prepareManagedMcpRuntimeProxy({
      agentId: "agent-unsupported-catalog",
      launchId: "launch-unsupported-catalog",
      serverUrl: "https://raft.test",
      agentCredentialKey: "unsafe-agent-credential",
      onWarning: (warning) => warnings.push(warning),
    }), null);
    assert.equal(fetchCalls, 1);

    assert.deepEqual(warnings, [
      "Managed MCP discovery unavailable for this session [reason=missing_server_url]",
      "Managed MCP discovery unavailable for this session [reason=missing_agent_credential]",
      "Managed MCP discovery unavailable for this session [reason=unsupported_catalog_version]",
    ]);
    assert.doesNotMatch(
      warnings.join("\n"),
      /unsafe-agent-credential|unsafe-private-server|unsafe-private-tool|unsafe_private_runtime|https:/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("managed MCP runtime proxy stays registered when the initial catalog is empty", async () => {
  const originalFetch = globalThis.fetch;
  const warnings: string[] = [];
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      catalogVersion: 1,
      tools: [],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const handle = await prepareManagedMcpRuntimeProxy({
      agentId: "agent-empty-catalog",
      launchId: "launch-empty-catalog",
      serverUrl: "https://raft.test",
      agentCredentialKey: "sk_agent_test",
      onWarning: (warning) => warnings.push(warning),
    });
    assert(handle);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:/u);
    assert.deepEqual(warnings, []);
  } finally {
    globalThis.fetch = originalFetch;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("managed MCP runtime proxy protects in-process clients with loopback NO_PROXY", async () => {
  const originalNoProxy = process.env.NO_PROXY;
  const originalNoProxyLower = process.env.no_proxy;
  try {
    process.env.NO_PROXY = "corp.internal";
    process.env.no_proxy = "lower.internal,localhost";
    const handle = await registerManagedMcpRuntimeProxy({
      agentId: "agent-loopback-no-proxy",
      launchId: "launch-loopback-no-proxy",
      snapshot: { catalogVersion: 1, tools: [] },
      async callTool() {
        return { isError: false, content: [] };
      },
    });

    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:/u);
    assert.equal(process.env.NO_PROXY, "127.0.0.1,localhost,corp.internal,lower.internal");
    assert.equal(process.env.no_proxy, process.env.NO_PROXY);
  } finally {
    if (originalNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = originalNoProxy;
    if (originalNoProxyLower === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = originalNoProxyLower;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("managed MCP runtime proxy exposes currently available tools and forwards calls through the Server gateway", async () => {
  const calls: ManagedMcpCallRequest[] = [];
  let snapshot: ManagedMcpRuntimeSnapshot = {
    catalogVersion: 1,
    tools: [
      {
        mcpServerId,
        serverName: "Private Docs",
        toolName: "search",
        runtimeName: "mcp_private_search",
        description: "Search private docs",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        configVersion: 7,
        assignmentVersion: 9,
      },
      {
        mcpServerId: "33333333-3333-4333-8333-333333333333",
        serverName: "Other Private Docs",
        toolName: "search",
        runtimeName: "mcp_other_private_search",
        description: "Search other private docs",
        inputSchema: { type: "object" },
        configVersion: 3,
        assignmentVersion: 4,
      },
    ],
  };
  const handle = await registerManagedMcpRuntimeProxy({
    agentId: "agent-1",
    launchId: "launch-1",
    snapshot,
    async loadSnapshot() {
      return snapshot;
    },
    async callTool(input) {
      calls.push(input);
      return {
        isError: false,
        content: [{ type: "text", text: "private result" }],
        structuredContent: { hitCount: 1 },
      };
    },
  });

  const client = new Client({ name: "runtime-proxy-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(handle.url));
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 2);
    assert.equal(new Set(listed.tools.map((tool) => tool.name)).size, 2);
    assert(listed.tools.every((tool) => tool.name.length <= 48));
    assert(
      listed.tools.every(
        (tool) => `mcp__${handle.name}__${tool.name}`.length <= 63,
      ),
    );
    const listedToolName = listed.tools[0]?.name;
    assert.equal(typeof listedToolName, "string");
    assert.match(listedToolName!, /^r[0-9a-f]{8}_search$/);
    assert.doesNotMatch(JSON.stringify(listed), /private\.example\.test/);

    const result = await client.callTool({
      name: listedToolName!,
      arguments: { query: "raft" },
    });
    assert.deepEqual(result.content, [
      { type: "text", text: "private result" },
    ]);
    assert.deepEqual(calls, [
      {
        mcpServerId,
        toolName: "search",
        arguments: { query: "raft" },
        expectedConfigVersion: 7,
        expectedAssignmentVersion: 9,
      },
    ]);

    snapshot = {
      catalogVersion: 1,
      tools: [
        {
          ...snapshot.tools[0]!,
          configVersion: 8,
          assignmentVersion: 10,
        },
      ],
    };
    const refreshed = await client.callTool({
      name: listedToolName!,
      arguments: { query: "fresh" },
    });
    assert.deepEqual(refreshed.content, [
      { type: "text", text: "private result" },
    ]);
    assert.deepEqual(calls[1], {
      mcpServerId,
      toolName: "search",
      arguments: { query: "fresh" },
      expectedConfigVersion: 8,
      expectedAssignmentVersion: 10,
    });

    snapshot = { catalogVersion: 1, tools: [] };
    const revokedTool = await client.callTool({
      name: listedToolName!,
      arguments: { query: "revoked" },
    });
    assert.equal(revokedTool.isError, true);
    assert.match(JSON.stringify(revokedTool.content), /not currently available/);
    assert.equal(calls.length, 2);

    assert.equal(
      unregisterManagedMcpRuntimeProxyForLaunch({
        agentId: "agent-1",
        launchId: "launch-1",
      }),
      1,
    );
    const revoked = await fetch(handle.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
        params: {},
      }),
    });
    assert.equal(revoked.status, 404);
  } finally {
    await client.close().catch(() => undefined);
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("managed MCP runtime config files are private and removed with the launch", () => {
  withTempDir((directory) => {
    const filePath = writeManagedMcpRuntimeConfigFile({
      agentId: "agent/config",
      launchId: "launch/config",
      slockHome: directory,
      runtime: "copilot",
      filename: "mcp.json",
      content: '{"mcpServers":{}}',
    });

    assert.equal(readFileSync(filePath, "utf8"), '{"mcpServers":{}}');
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    unregisterManagedMcpRuntimeProxyForLaunch({
      agentId: "agent/config",
      launchId: "launch/config",
    });
    assert.equal(existsSync(filePath), false);
  });
});

test("managed MCP JSON overlay preserves user config and restores its exact bytes and mode", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, ".cursor", "mcp.json");
    const original =
      '{\n  "mcpServers": { "user": { "url": "https://user.example/mcp" } }\n}';
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, original, { mode: 0o640 });

    installManagedMcpRuntimeJsonOverlay({
      agentId: "agent-overlay",
      launchId: "launch-overlay",
      filePath,
      apply: (config) => ({
        ...config,
        mcpServers: {
          ...(config.mcpServers as Record<string, unknown>),
          raftmanagedtest: { url: "http://127.0.0.1:1234/mcp/token" },
        },
      }),
    });

    const overlaid = JSON.parse(readFileSync(filePath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(overlaid.mcpServers).sort(), [
      "raftmanagedtest",
      "user",
    ]);
    unregisterManagedMcpRuntimeProxyForLaunch({
      agentId: "agent-overlay",
      launchId: "launch-overlay",
    });
    assert.equal(readFileSync(filePath, "utf8"), original);
    assert.equal(statSync(filePath).mode & 0o777, 0o640);
  });
});

test("managed MCP JSON overlay never overwrites a concurrent user edit during cleanup", () => {
  withTempDir((directory) => {
    const filePath = path.join(directory, ".agents", "mcp_config.json");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, '{"user":1}\n', { mode: 0o600 });
    installManagedMcpRuntimeJsonOverlay({
      agentId: "agent-cas",
      launchId: "launch-cas",
      filePath,
      apply: (config) => ({ ...config, managed: true }),
    });

    const concurrent = '{"user":2,"changedWhileRunning":true}\n';
    writeFileSync(filePath, concurrent, "utf8");
    unregisterManagedMcpRuntimeProxyForLaunch({
      agentId: "agent-cas",
      launchId: "launch-cas",
    });
    assert.equal(readFileSync(filePath, "utf8"), concurrent);
  });
});
