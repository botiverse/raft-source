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
} from "./managedMcpRuntimeProxy";
import { RuntimeTurnOriginHolder } from "./runtimeTurnOrigin";

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

test("managed MCP endpoint takes the token as a bearer header, so it need not be in a process's arguments", async () => {
  const snapshot: ManagedMcpRuntimeSnapshot = { catalogVersion: 1, tools: [] };
  const handle = await registerManagedMcpRuntimeProxy({
    agentId: "agent-bearer",
    launchId: "launch-bearer",
    snapshot,
    async loadSnapshot() {
      return snapshot;
    },
    async callTool() {
      return { isError: false, content: [] };
    },
  });
  try {
    assert.equal(handle.url, `${handle.endpointUrl}/${handle.token}`);
    assert.doesNotMatch(handle.endpointUrl, new RegExp(handle.token));

    const client = new Client({ name: "runtime-proxy-bearer-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.endpointUrl), {
      requestInit: { headers: { Authorization: `Bearer ${handle.token}` } },
    });
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools, []);
    await client.close();

    for (const authorization of [undefined, "Bearer", "Bearer ", "Bearer wrong-token", `Basic ${handle.token}`]) {
      const response = await fetch(handle.endpointUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(authorization ? { authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(response.status, 404, String(authorization));
    }
    // The header only stands in for the path token on the bare endpoint.
    const pathMiss = await fetch(`${handle.endpointUrl}/not-a-token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${handle.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(pathMiss.status, 404);
  } finally {
    unregisterManagedMcpRuntimeProxyForLaunch({ agentId: "agent-bearer", launchId: "launch-bearer" });
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

    // #proj-runtime:#40: while it holds the token the file is the owner's only.
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
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

test("⭐ native proxy forwards the origin of the turn a call was issued in -- never a later turn's (task #21)", async () => {
  const calls: ManagedMcpCallRequest[] = [];
  const snapshot: ManagedMcpRuntimeSnapshot = {
    catalogVersion: 1,
    tools: [{
      mcpServerId,
      serverName: "Docs",
      toolName: "search",
      runtimeName: "mcp_docs_search",
      inputSchema: { type: "object" },
      configVersion: 1,
      assignmentVersion: 1,
    }],
  };
  let duringLoad: (() => void) | null = null;
  const holder = new RuntimeTurnOriginHolder("process-1");
  const register = (processInstanceId: string) => registerManagedMcpRuntimeProxy({
    agentId: "agent-origin",
    launchId: "launch-origin",
    processInstanceId,
    readTurnOrigin: holder.read,
    snapshot,
    async loadSnapshot() {
      const hook = duringLoad;
      duringLoad = null;
      // Yield first so the handler has already captured its origin, then move the turn on.
      await new Promise((resolve) => setImmediate(resolve));
      hook?.();
      return snapshot;
    },
    async callTool(input) {
      calls.push(input);
      return { isError: false, content: [{ type: "text", text: "ok" }] };
    },
  });
  const own = await register("process-1");
  const foreign = await register("process-2");
  const clientFor = async (url: string) => {
    const client = new Client({ name: "origin-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    const [tool] = (await client.listTools()).tools;
    return { client, call: () => client.callTool({ name: tool!.name, arguments: {} }) };
  };
  const a = await clientFor(own.url);
  const b = await clientFor(foreign.url);
  try {
    const M1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const M2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await a.call();
    assert.equal(calls.at(-1)!.origin, undefined, "no open turn");

    holder.beginTurn({ sourceMessageId: M1 });
    await a.call();
    assert.deepEqual(calls.at(-1)!.origin, { sourceMessageId: M1 });

    // The turn ends and the next begins while this call is still reloading the tool snapshot.
    duringLoad = () => {
      holder.endTurn();
      holder.beginTurn({ sourceMessageId: M2 });
    };
    await a.call();
    assert.equal(calls.at(-1)!.origin, undefined, "⭐ must not be re-homed onto the turn that started mid-call");

    await a.call();
    assert.deepEqual(calls.at(-1)!.origin, { sourceMessageId: M2 }, "control: the new turn's own calls do carry it");

    await b.call();
    assert.equal(calls.at(-1)!.origin, undefined, "a registration for another process instance never borrows this getter");
  } finally {
    await a.client.close();
    await b.client.close();
    await __resetManagedMcpRuntimeProxyForTest();
  }
});

test("⭐ the native proxy passes the Server's refusal and its guidance to the model, not a bare HTTP status", async () => {
  const snapshot: ManagedMcpRuntimeSnapshot = {
    catalogVersion: 1,
    tools: [{
      mcpServerId,
      serverName: "Docs",
      toolName: "search",
      runtimeName: "mcp_docs_search",
      inputSchema: { type: "object" },
      configVersion: 1,
      assignmentVersion: 1,
    }],
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = String(input instanceof Request ? input.url : input);
    // Only the agent-api leg is stubbed; the MCP client's own transport talks to the local proxy
    // over this same global and must be left alone.
    if (!url.startsWith("https://raft.test")) return originalFetch(input as never, init as never);
    if (url.endsWith("/mcp/tools")) {
      return new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify({
        error: "MCP connection is not authorized for this agent",
        code: "managed_mcp_login_required",
        connectionRequested: true,
      }),
      { status: 409, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const handle = await prepareManagedMcpRuntimeProxy({
    agentId: "agent-guidance",
    launchId: "launch-guidance",
    serverUrl: "https://raft.test",
    agentCredentialKey: "sk_agent_test",
  });
  assert.ok(handle);
  const client = new Client({ name: "guidance-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(handle!.url)));
    const [tool] = (await client.listTools()).tools;
    const result = await client.callTool({ name: tool!.name, arguments: {} });
    const text = JSON.stringify(result.content);
    assert.equal(result.isError, true);
    assert.match(text, /not authorized for this agent/, "the Server's own sentence reaches the model");
    assert.match(text, /human to authorize/, "⭐ and what happens next");
    assert.doesNotMatch(text, /^"\[\{"type":"text","text":"Raft MCP gateway request failed: HTTP 409/u,
      "not a bare status line");
  } finally {
    await client.close().catch(() => undefined);
    globalThis.fetch = originalFetch;
    await __resetManagedMcpRuntimeProxyForTest();
  }
});
