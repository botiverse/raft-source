import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { BasicTracer, BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS, eventsForSpan, MemoryTraceSink, RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
import fc from "fast-check";
import {
  BuiltInDriver,
  PI_SDK_COMPACTION_ENABLED,
  PiDriver,
  PiSdkRuntimeSession,
  buildBuiltInAgentDir,
  buildPiSessionCreateEnvPatch,
  buildBuiltInSessionDir,
  buildPiLegacyRpcArgs,
  buildPiSessionDir,
  createPiAgentSessionForContext,
  createPiSdkEventMappingState,
  detectPiModels,
  detectPiModelsFromRegistry,
  mapPiSdkEventToParsedEvents,
  projectPiCompactionInputTelemetry,
  resolveBuiltInGatewayModelInput,
  resolveBuiltInGatewayLaunch,
  seedPiSessionModelRuntime,
  withProcessEnvPatch,
  __piPromptsInFlightForTest,
} from "./pi.js";
import { waitForState } from "../testing/drydock.js";
import {
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamSimpleAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getGlobalDispatcher } from "undici";
import net from "node:net";
import { resolveRuntimeSessionRef } from "./runtimeArtifacts.js";
import type { ParsedEvent, SpawnContext } from "./types.js";

function makeSpawnContext(
  overrides: Partial<SpawnContext["config"]> = {},
  ctxOverrides: Partial<Omit<SpawnContext, "config">> = {},
): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing instructions",
    prompt: "wake prompt",
    workingDirectory: "/tmp/pi-agent",
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    config: {
      name: "Pi Agent",
      displayName: null,
      description: null,
      runtime: "pi",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: "default",
      reasoningEffort: null,
      envVars: null,
      runtimeContext: null,
      ...overrides,
    },
    ...ctxOverrides,
  };
}

function makeDeterministicTracer() {
  let spanIndex = 0;
  const traceId = "1".repeat(32);
  const spanIds = ["2".repeat(16), "3".repeat(16), "4".repeat(16)];
  const sink = new MemoryTraceSink();
  const tracer = new BasicTracer({
    sink,
    traceIdGenerator: () => traceId,
    spanIdGenerator: () => spanIds[spanIndex++] ?? "5".repeat(16),
  });
  return { sink, tracer, traceId };
}

const serverSockets = new WeakMap<Server, Set<Socket>>();

async function listenOnLoopback(server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  serverSockets.set(server, sockets);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  server.closeAllConnections?.();
  // Node excludes CONNECT-upgraded sockets from closeAllConnections().
  for (const socket of serverSockets.get(server) ?? []) socket.destroy();
  await closed;
  serverSockets.delete(server);
}

test("closeServer destroys CONNECT-upgraded sockets before awaiting server close", { timeout: 10_000 }, async () => {
  const server = createServer();
  server.on("connect", (_request, socket) => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  });
  const port = await listenOnLoopback(server);
  const client = createConnection({ host: "127.0.0.1", port });

  try {
    await new Promise<void>((resolve, reject) => {
      client.once("error", reject);
      client.once("connect", () => {
        client.write("CONNECT gateway.invalid:443 HTTP/1.1\r\nHost: gateway.invalid:443\r\n\r\n");
      });
      client.once("data", () => resolve());
    });
    await closeServer(server);
  } finally {
    client.destroy();
    if (server.listening) await closeServer(server);
  }
});

test("buildPiLegacyRpcArgs preserves the old CLI launch mapping for compatibility docs", () => {
  const args = buildPiLegacyRpcArgs(makeSpawnContext({
    model: "provider/model-alpha",
    reasoningEffort: "high",
    sessionId: "pi-session-1",
  }), "pi-session-1");

  assert.deepEqual(args, [
    "--mode", "rpc",
    "--session-dir", buildPiSessionDir("/tmp/pi-agent"),
    "--system-prompt", "standing instructions",
    "--model", "provider/model-alpha",
    "--thinking", "high",
    "--session-id", "pi-session-1",
  ]);
});

test("buildPiLegacyRpcArgs omits optional launch flags for default config", () => {
  const args = buildPiLegacyRpcArgs(makeSpawnContext(), null);

  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("--thinking"), false);
  assert.equal(args.includes("--session-id"), false);
});

test("driver declares native standing prompt support for SDK launch", () => {
  assert.equal(new PiDriver().supportsNativeStandingPrompt, true);
});

test("probe reports the bundled SDK instead of requiring a host pi binary", () => {
  const probe = new PiDriver().probe();

  assert.equal(probe.available, true);
  assert.match(probe.version ?? "", /^\d+\.\d+\.\d+/);
});

test("Built-in driver is a separate preset runtime with static launchable models", async () => {
  const fixture = createPiExtensionModelFixture();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTaskKey = process.env.TASK349_PI_API_KEY;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  process.env.TASK349_PI_API_KEY = "task349-host-key";
  try {
    const driver = new BuiltInDriver();
    assert.equal(driver.id, "builtin");
    assert.equal(driver.probe().available, true);
    const detected = await driver.detectModels();
    assert.equal(detected.kind, "live");
    if (detected.kind !== "live") assert.fail("Built-in catalog must be live");
    assert.deepEqual(detected.value.catalog, {
      protocolVersion: 1,
      runtime: "builtin",
      runtimeVersion: driver.probe().version,
    });
    assert.equal(detected.value.models.some((model) => model.id === "deepseek/deepseek-v4-pro" && model.verified === "launchable"), true);
    assert.equal(detected.value.models.some((model) => model.id === "deepseek/deepseek-v4-flash" && model.verified === "launchable"), true);
    assert.equal(detected.value.models.some((model) => model.id === "openai/gpt-5.4" && model.verified === "launchable"), true);
    assert.equal(detected.value.models.some((model) => model.id === "moonshotai-cn/kimi-k2.7-code" && model.verified === "launchable"), true);
    assert.equal(detected.value.models.some((model) => model.id === "xiaomi/mimo-v2.5-pro" && model.verified === "launchable"), true);
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnv("TASK349_PI_API_KEY", previousTaskKey);
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Built-in driver uses preset workspace-local state paths", () => {
  assert.equal(buildBuiltInAgentDir("/tmp/agent-workspace"), "/tmp/agent-workspace/.builtin-runtime");
  assert.equal(buildBuiltInSessionDir("/tmp/agent-workspace"), "/tmp/agent-workspace/.builtin-sessions");
});

test("detectPiModelsFromRegistry exposes authenticated SDK models as launchable", () => {
  const detected = detectPiModelsFromRegistry({
    getAvailable: () => [
      {
        provider: "provider-a",
        id: "model-alpha",
        name: "Model Alpha",
      },
      {
        provider: "provider-a",
        id: "model-beta",
        name: "Model Beta",
      },
    ] as any,
  });

  assert.ok(detected);
  assert.deepEqual(detected!.models, [
    { id: "provider-a/model-alpha", label: "Model Alpha · Provider A", verified: "launchable" },
    { id: "provider-a/model-beta", label: "Model Beta · Provider A", verified: "launchable" },
  ]);
});

test("detectPiModelsFromRegistry returns null when no SDK models are available", () => {
  assert.equal(detectPiModelsFromRegistry({ getAvailable: () => [] as any }), null);
});

test("detectPiModelsFromRegistry uses canonical brand-cased provider labels (e.g. DeepSeek)", () => {
  const detected = detectPiModelsFromRegistry({
    getAvailable: () => [
      { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ] as any,
  });

  // Without the canonical map entry, humanizePiSegment("deepseek") → "Deepseek"
  // (single-token title-case). The map keeps the brand's mid-string capital "S".
  assert.ok(detected);
  assert.equal(detected!.models.length, 1);
  assert.equal(detected!.models[0].label, "DeepSeek V4 Pro · DeepSeek");
});

test("detectPiModels defaults through the SDK model registry", async () => {
  assert.equal(await detectPiModels({ getAvailable: () => [] as any }), null);
});

test("detectPiModels loads provider models from Pi package extensions", async () => {
  const fixture = createPiExtensionModelFixture(onTestFinished);
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const span = tracer.startSpan("daemon.runtime_models.detect", {
    surface: "daemon",
    kind: "internal",
    attrs: { runtime: "pi" },
  });
  const bareRuntime = await ModelRuntime.create({
    authPath: path.join(fixture.agentDir, "auth.json"),
    modelsPath: path.join(fixture.agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const bareRegistry = new ModelRegistry(bareRuntime);

  assert.equal(bareRegistry.find(fixture.provider, fixture.model), undefined);

  const detected = await withPiExtensionEnv(fixture, () => detectPiModels(undefined, { span }));
  span.end("ok");

  assert.ok(detected?.models.some((model) =>
    model.id === fixture.modelId &&
    model.label === "Task 349 Extension Model · Task349",
  ));
  const traceEvents = eventsForSpan(sink, traceId, "daemon.runtime_models.detect");
  assert.equal(
    traceEvents.find((event) => event.name === "daemon.pi.models.services_ready")?.attrs?.available_models_count,
    1,
  );
  assert.equal(
    traceEvents.find((event) => event.name === "daemon.pi.models.result")?.attrs?.returned_models_count,
    1,
  );
});

test("createPiAgentSessionForContext resolves explicit Pi package extension models", async () => {
  const fixture = createPiExtensionModelFixture(onTestFinished);
  const { sink, tracer, traceId } = makeDeterministicTracer();

  const session = await withPiExtensionEnv(fixture, () =>
    createPiAgentSessionForContext(
      makeSpawnContext({ model: fixture.modelId }, { launchId: "launch-1", tracer }),
      "pi-extension-session",
    ));

  try {
    assert.equal(session.model?.provider, fixture.provider);
    assert.equal(session.model?.id, fixture.model);
    const traceSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.pi.session.create");
    assert.equal(traceSpan?.attrs?.requested_model, fixture.modelId);
    assert.equal(traceSpan?.attrs?.resolved_model, fixture.modelId);
    assert.equal(traceSpan?.attrs?.outcome, "started");
    assert.equal(
      eventsForSpan(sink, traceId, "daemon.pi.session.create")
        .find((event) => event.name === "daemon.pi.session.services_ready")?.attrs?.available_models_count,
      1,
    );
  } finally {
    session.dispose();
  }
});

test("Built-in gateway image-input override defaults closed and unions without replacing registry input", () => {
  assert.deepEqual(resolveBuiltInGatewayModelInput(undefined, undefined), ["text"]);
  assert.deepEqual(resolveBuiltInGatewayModelInput(undefined, false), ["text"]);
  assert.deepEqual(resolveBuiltInGatewayModelInput(["image"], true), ["image", "text"]);
  assert.deepEqual(resolveBuiltInGatewayModelInput(["text", "image"], true), ["text", "image"]);
});

test("unchecked unknown gateways downgrade image blocks before OpenAI and Anthropic payloads", async () => {
  const common = {
    id: "unknown-text-only",
    name: "Unknown text-only",
    baseUrl: "http://127.0.0.1:8787",
    reasoning: false,
    input: resolveBuiltInGatewayModelInput(undefined, false),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const messages = [{
    role: "user" as const,
    content: [
      { type: "text" as const, text: "inspect this" },
      { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" as const },
    ],
    timestamp: 1,
  }];

  let openAIPayload: unknown;
  const openAIResult = await streamSimpleOpenAICompletions(
    { ...common, provider: "openai", api: "openai-completions" },
    { messages },
    {
      apiKey: "sk-test",
      onPayload: (payload) => {
        openAIPayload = payload;
        throw new Error("captured before network");
      },
    },
  ).result();
  assert.equal(openAIResult.stopReason, "error");
  const openAIContent = (openAIPayload as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>;
  }).messages[0]?.content;
  assert.ok(openAIContent?.some((block) => block.text?.includes("image omitted")));
  assert.equal(openAIContent?.some((block) => block.type === "image_url"), false);

  let anthropicPayload: unknown;
  const anthropicResult = await streamSimpleAnthropicMessages(
    { ...common, provider: "anthropic", api: "anthropic-messages" },
    { messages },
    {
      apiKey: "sk-test",
      onPayload: (payload) => {
        anthropicPayload = payload;
        throw new Error("captured before network");
      },
    },
  ).result();
  assert.equal(anthropicResult.stopReason, "error");
  const anthropicContent = (anthropicPayload as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>;
  }).messages[0]?.content;
  assert.ok(anthropicContent?.some((block) => block.text?.includes("image omitted")));
  assert.equal(anthropicContent?.some((block) => block.type === "image"), false);
});

test("Built-in gateway custom model is registered for SDK session launch", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-gateway-model-"));
  const workingDirectory = path.join(root, "workspace");
  const { sink, tracer, traceId } = makeDeterministicTracer();
  mkdirSync(workingDirectory, { recursive: true });

  try {
    const session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "gateway-e2e-model",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "gateway",
            providerId: "openai-compatible",
            baseUrl: "http://127.0.0.1:8787/v1",
            apiKey: "sk-gateway-test",
            supportsImageInput: true,
          },
          hostUserState: "forbidden",
          model: { kind: "custom", name: "gateway-e2e-model" },
          mode: { kind: "default" },
          envVars: {
            OPENAI_API_KEY: "sk-host-openai-should-not-win",
            OPENAI_BASE_URL: "https://host-openai-should-not-win.example/v1",
          },
        },
      }, { workingDirectory, launchId: "launch-1", tracer }),
      "builtin-gateway-session",
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        traceName: "daemon.builtin.session.create",
        traceEventPrefix: "daemon.builtin.session",
        logPrefix: "builtin-driver-test",
        agentDirSource: "managed_builtin",
        exposeLaunchTraceEvidence: true,
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );

    try {
      assert.equal(session.model?.provider, "openai");
      assert.equal(session.model?.id, "gateway-e2e-model");
      assert.equal(session.model?.baseUrl, "http://127.0.0.1:8787/v1");
      assert.equal(session.model?.api, "openai-completions");
      const gatewayModel = session.model as Model<"openai-completions"> | undefined;
      assert.equal(gatewayModel?.compat?.supportsDeveloperRole, false);
      assert.equal(gatewayModel?.compat?.supportsStore, false);
      assert.deepEqual(gatewayModel?.input, ["text", "image"]);

      let capturedPayload: unknown;
      let fetchCalls = 0;
      const result = await streamSimpleOpenAICompletions(
        gatewayModel!,
        {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "inspect this" },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
            timestamp: 1,
          }],
        },
        {
          apiKey: "sk-gateway-test",
          onPayload: (payload) => {
            capturedPayload = payload;
          },
          fetch: async () => {
            fetchCalls += 1;
            return new Response([
              `data: ${JSON.stringify({
                id: "chatcmpl-gateway-model-proof",
                object: "chat.completion.chunk",
                created: 1,
                model: "gateway-e2e-model",
                choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
              })}\n\n`,
              `data: ${JSON.stringify({
                id: "chatcmpl-gateway-model-proof",
                object: "chat.completion.chunk",
                created: 1,
                model: "gateway-e2e-model",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              })}\n\n`,
              "data: [DONE]\n\n",
            ].join(""), {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          },
          maxRetries: 0,
        },
      ).result();
      assert.equal(result.stopReason, "stop");
      assert.equal(fetchCalls, 1);
      const openAIPayload = capturedPayload as {
        messages: Array<{ content: string | Array<{ type: string }> }>;
      };
      const userContent = openAIPayload.messages[0]?.content;
      assert.ok(Array.isArray(userContent));
      assert.ok(userContent.some((block) => block.type === "image_url"));

      const traceSpan = sink.getTrace(traceId).find((span) => span.name === "daemon.builtin.session.create");
      assert.equal(traceSpan?.attrs?.outcome, "started");
      assert.equal(traceSpan?.attrs?.requested_model, "gateway-e2e-model");
      assert.equal(traceSpan?.attrs?.resolved_model, "openai/gateway-e2e-model");
      assert.equal(traceSpan?.attrs?.provider_id, "openai-compatible");
      assert.equal(traceSpan?.attrs?.model_kind, "custom");
      assert.equal(traceSpan?.attrs?.base_url_present, true);
      assert.equal(traceSpan?.attrs?.provider_key_present, true);
      assert.equal(
        eventsForSpan(sink, traceId, "daemon.builtin.session.create")
          .find((event) => event.name === "daemon.builtin.session.services_ready")?.attrs?.available_models_count,
        1,
      );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed compatible connection materializes a secret-free gateway projection for SDK launch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-managed-provider-model-"));
  const workingDirectory = path.join(root, "workspace");
  const { sink, tracer, traceId } = makeDeterministicTracer();
  mkdirSync(workingDirectory, { recursive: true });

  try {
    const session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "managed-e2e-model",
        envVars: {
          OPENAI_API_KEY: "managed-launch-key",
          OPENAI_BASE_URL: "http://127.0.0.1:8788/v1",
        },
        providerConnection: {
          providerId: "openai-compatible",
          endpointUrl: "http://127.0.0.1:8788/v1",
          supportsImageInput: true,
        },
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "connection",
            connectionId: "11111111-1111-4111-8111-111111111111",
          },
          hostUserState: "forbidden",
          model: { kind: "custom", name: "managed-e2e-model" },
          mode: { kind: "default" },
        },
      }, { workingDirectory, launchId: "managed-launch-1", tracer }),
      "managed-provider-session",
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        traceName: "daemon.builtin.managed.session.create",
        exposeLaunchTraceEvidence: true,
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );

    try {
      assert.equal(session.model?.provider, "openai");
      assert.equal(session.model?.id, "managed-e2e-model");
      assert.equal(session.model?.baseUrl, "http://127.0.0.1:8788/v1");
      assert.deepEqual(session.model?.input, ["text", "image"]);
      assert.equal((await session.modelRuntime.getAuth("openai"))?.auth.apiKey, "managed-launch-key");
      const traceSpan = sink.getTrace(traceId)
        .find((span) => span.name === "daemon.builtin.managed.session.create");
      assert.equal(traceSpan?.attrs?.provider_id, "openai-compatible");
      assert.equal(traceSpan?.attrs?.base_url_present, true);
      assert.equal(traceSpan?.attrs?.provider_key_present, true);
      assert.equal(traceSpan?.attrs?.provider_key_source, "server_managed_connection");
      assert.equal(JSON.stringify(traceSpan).includes("managed-launch-key"), false);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("daemon Pi provider requests traverse a real CONNECT proxy when the gateway is directly unreachable", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-provider-proxy-"));
  const workingDirectory = path.join(root, "workspace");
  const providerRequests: string[] = [];
  const connectAuthorities: string[] = [];
  mkdirSync(workingDirectory, { recursive: true });

  const provider = createServer((req, res) => {
    providerRequests.push(req.url ?? "");
    req.resume();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (providerRequests.length === 2) {
      const socket = res.socket;
      res.write(`data: ${JSON.stringify({
        id: "chatcmpl-proxy-proof-broken",
        object: "chat.completion.chunk",
        created: 1,
        model: "gateway-proxy-model",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
      })}\n\n`, () => socket?.destroy());
      return;
    }
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-proxy-proof",
      object: "chat.completion.chunk",
      created: 1,
      model: "gateway-proxy-model",
      choices: [{ index: 0, delta: { content: "proxied" }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl-proxy-proof",
      object: "chat.completion.chunk",
      created: 1,
      model: "gateway-proxy-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const providerPort = await listenOnLoopback(provider);

  const proxy = createServer();
  proxy.on("connect", (req, downstream, head) => {
    connectAuthorities.push(req.url ?? "");
    const upstream = createConnection({ host: "127.0.0.1", port: providerPort }, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
    });
    upstream.on("error", () => downstream.destroy());
    downstream.on("error", () => upstream.destroy());
  });
  const proxyPort = await listenOnLoopback(proxy);
  const previousDispatcher = getGlobalDispatcher();
  let session: AgentSession | undefined;

  try {
    session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "gateway-proxy-model",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "gateway",
            providerId: "openai-compatible",
            baseUrl: "http://direct-unreachable.invalid/v1",
            apiKey: "sk-proxy-proof",
            supportsImageInput: false,
          },
          hostUserState: "forbidden",
          model: { kind: "custom", name: "gateway-proxy-model" },
          mode: { kind: "default" },
          envVars: {
            HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
            NO_PROXY: "localhost,127.0.0.1",
          },
        },
      }, { workingDirectory, launchId: "launch-proxy-proof" }),
      "builtin-proxy-proof-session",
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        agentDirSource: "managed_builtin",
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );

    assert.equal(
      getGlobalDispatcher(),
      previousDispatcher,
      "creating a Pi session must not replace the daemon-global dispatcher",
    );

    const result = await session.modelRuntime.streamSimple(
      session.model as Model<"openai-completions">,
      {
        systemPrompt: "standing instructions",
        messages: [{ role: "user", content: "proxy proof", timestamp: 1 }],
      },
      { apiKey: "sk-proxy-proof", maxRetries: 0 },
    ).result();

    assert.equal(result.stopReason, "stop");
    assert.deepEqual(providerRequests, ["/v1/chat/completions"]);
    assert.equal(connectAuthorities.includes("direct-unreachable.invalid:80"), true);
    assert.equal(result.content.some((block) => block.type === "text" && block.text === "proxied"), true);

    const failedResult = await session.modelRuntime.streamSimple(
      session.model as Model<"openai-completions">,
      {
        systemPrompt: "standing instructions",
        messages: [{ role: "user", content: "stream failure proof", timestamp: 2 }],
      },
      { apiKey: "sk-proxy-proof", maxRetries: 0 },
    ).result();
    assert.equal(failedResult.stopReason, "error");
    assert.equal(failedResult.errorMessage, "terminated");
    assert.equal(typeof failedResult.errorMessage, "string");
    assert.deepEqual(providerRequests, ["/v1/chat/completions", "/v1/chat/completions"]);

    session.dispose();
    session = undefined;
    assert.equal(
      getGlobalDispatcher(),
      previousDispatcher,
      "disposing a Pi session must leave the daemon-global dispatcher unchanged",
    );
  } finally {
    session?.dispose();
    await closeServer(proxy);
    await closeServer(provider);
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent Pi sessions keep distinct proxy routes and dispose independently", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-provider-proxy-isolation-"));
  const previousDispatcher = getGlobalDispatcher();

  function createProvider(label: string, requests: string[]): Server {
    return createServer((req, res) => {
      requests.push(req.url ?? "");
      req.resume();
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${label}`,
        object: "chat.completion.chunk",
        created: 1,
        model: `gateway-${label}`,
        choices: [{ index: 0, delta: { content: label }, finish_reason: null }],
      })}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${label}`,
        object: "chat.completion.chunk",
        created: 1,
        model: `gateway-${label}`,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  }

  function createProxy(providerPort: number, authorities: string[]): Server {
    const proxy = createServer();
    proxy.on("connect", (req, downstream, head) => {
      authorities.push(req.url ?? "");
      const upstream = createConnection({ host: "127.0.0.1", port: providerPort }, () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(downstream);
        downstream.pipe(upstream);
      });
      upstream.on("error", () => downstream.destroy());
      downstream.on("error", () => upstream.destroy());
    });
    return proxy;
  }

  const firstRequests: string[] = [];
  const secondRequests: string[] = [];
  const firstAuthorities: string[] = [];
  const secondAuthorities: string[] = [];
  const firstProvider = createProvider("first", firstRequests);
  const secondProvider = createProvider("second", secondRequests);
  const firstProviderPort = await listenOnLoopback(firstProvider);
  const secondProviderPort = await listenOnLoopback(secondProvider);
  const firstProxy = createProxy(firstProviderPort, firstAuthorities);
  const secondProxy = createProxy(secondProviderPort, secondAuthorities);
  const firstProxyPort = await listenOnLoopback(firstProxy);
  const secondProxyPort = await listenOnLoopback(secondProxy);
  let firstSession: AgentSession | undefined;
  let secondSession: AgentSession | undefined;

  const createSession = async (label: "first" | "second", proxyPort: number) => {
    const workingDirectory = path.join(root, label);
    mkdirSync(workingDirectory, { recursive: true });
    return createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: `gateway-${label}`,
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "gateway",
            providerId: "openai-compatible",
            baseUrl: `http://${label}-unreachable.invalid/v1`,
            apiKey: `sk-${label}`,
            supportsImageInput: false,
          },
          hostUserState: "forbidden",
          model: { kind: "custom", name: `gateway-${label}` },
          mode: { kind: "default" },
          envVars: {
            HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
            NO_PROXY: "localhost,127.0.0.1",
          },
        },
      }, { workingDirectory, launchId: `launch-${label}` }),
      `session-${label}`,
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        agentDirSource: "managed_builtin",
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );
  };

  const request = (session: AgentSession, label: "first" | "second") =>
    session.modelRuntime.streamSimple(
      session.model as Model<"openai-completions">,
      {
        systemPrompt: "standing instructions",
        messages: [{ role: "user", content: label, timestamp: 1 }],
      },
      { apiKey: `sk-${label}`, maxRetries: 0 },
    ).result();

  try {
    firstSession = await createSession("first", firstProxyPort);
    secondSession = await createSession("second", secondProxyPort);
    assert.equal(getGlobalDispatcher(), previousDispatcher);

    const [firstResult, secondResult] = await Promise.all([
      request(firstSession, "first"),
      request(secondSession, "second"),
    ]);
    assert.equal(firstResult.content.some((block) => block.type === "text" && block.text === "first"), true);
    assert.equal(secondResult.content.some((block) => block.type === "text" && block.text === "second"), true);
    assert.deepEqual(firstRequests, ["/v1/chat/completions"]);
    assert.deepEqual(secondRequests, ["/v1/chat/completions"]);
    assert.equal(firstAuthorities.includes("first-unreachable.invalid:80"), true);
    assert.equal(firstAuthorities.some((authority) => authority.includes("second-unreachable")), false);
    assert.equal(secondAuthorities.includes("second-unreachable.invalid:80"), true);
    assert.equal(secondAuthorities.some((authority) => authority.includes("first-unreachable")), false);

    firstSession.dispose();
    firstSession = undefined;
    const secondAfterFirstDispose = await request(secondSession, "second");
    assert.equal(secondAfterFirstDispose.stopReason, "stop");
    assert.deepEqual(secondRequests, ["/v1/chat/completions", "/v1/chat/completions"]);
    assert.equal(getGlobalDispatcher(), previousDispatcher);
  } finally {
    firstSession?.dispose();
    secondSession?.dispose();
    await closeServer(firstProxy);
    await closeServer(secondProxy);
    await closeServer(firstProvider);
    await closeServer(secondProvider);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Built-in gateway inherits Qwen Token Plan payload compatibility from the Pi registry", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-qwen-token-plan-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });

  try {
    const session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "qwen3.8-max",
        reasoningEffort: "high",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "gateway",
            providerId: "openai-compatible",
            baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/",
            apiKey: "sk-qwen-token-plan-test",
            supportsImageInput: true,
          },
          hostUserState: "forbidden",
          model: { kind: "custom", name: "qwen3.8-max" },
          mode: { kind: "default" },
          envVars: null,
        },
      }, { workingDirectory, launchId: "launch-1" }),
      "builtin-qwen-token-plan-session",
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        traceName: "daemon.builtin.session.create",
        traceEventPrefix: "daemon.builtin.session",
        logPrefix: "builtin-driver-test",
        agentDirSource: "managed_builtin",
        exposeLaunchTraceEvidence: true,
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );

    try {
      const model = session.model;
      assert.ok(model);
      assert.equal(model.provider, "openai");
      assert.equal(model.id, "qwen3.8-max");
      assert.equal(model.api, "openai-completions");
      const openAIModel = model as Model<"openai-completions">;
      assert.equal(openAIModel.compat?.supportsDeveloperRole, false);
      assert.equal(openAIModel.compat?.supportsStore, false);
      assert.equal(openAIModel.compat?.thinkingFormat, "qwen");
      assert.equal(model.name, "Qwen3.8 Max");
      assert.deepEqual(model.input, ["text", "image"]);
      assert.equal(model.contextWindow, 1_000_000);
      assert.equal(model.maxTokens, 131_072);

      let capturedPayload: unknown;
      const result = await streamSimpleOpenAICompletions(
        openAIModel,
        {
          systemPrompt: "standing instructions",
          messages: [{ role: "user", content: "wake prompt", timestamp: 1 }],
        },
        {
          apiKey: "sk-qwen-token-plan-test",
          reasoning: "high",
          onPayload: (payload) => {
            capturedPayload = payload;
            throw new Error("captured before network");
          },
        },
      ).result();

      assert.equal(result.stopReason, "error");
      const payload = capturedPayload as {
        messages: Array<{ role: string }>;
        store?: unknown;
        enable_thinking?: unknown;
      };
      assert.deepEqual(payload.messages.map((message) => message.role), ["system", "user"]);
      assert.equal("store" in payload, false);
      assert.equal(payload.enable_thinking, true);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Built-in Qwen Token Plan CN preset resolves without a custom gateway and emits a compatible payload", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-qwen-token-plan-cn-preset-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });

  try {
    const session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "qwen-token-plan-cn/qwen3.8-max",
        reasoningEffort: "high",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "preset",
            providerId: "qwen-token-plan-cn",
            apiKey: "sk-qwen-token-plan-cn-test",
          },
          hostUserState: "forbidden",
          model: { kind: "preset", id: "qwen-token-plan-cn/qwen3.8-max" },
          mode: { kind: "default" },
          envVars: null,
        },
      }, { workingDirectory, launchId: "launch-1" }),
      "builtin-qwen-token-plan-cn-preset-session",
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        traceName: "daemon.builtin.session.create",
        traceEventPrefix: "daemon.builtin.session",
        logPrefix: "builtin-driver-test",
        agentDirSource: "managed_builtin",
        exposeLaunchTraceEvidence: true,
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );

    try {
      const model = session.model;
      assert.ok(model);
      assert.equal(model.provider, "qwen-token-plan-cn");
      assert.equal(model.id, "qwen3.8-max");
      assert.equal(model.baseUrl, "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
      assert.equal(model.api, "openai-completions");
      const openAIModel = model as Model<"openai-completions">;
      assert.equal(openAIModel.compat?.supportsDeveloperRole, false);
      assert.equal(openAIModel.compat?.supportsStore, false);
      assert.equal(openAIModel.compat?.thinkingFormat, "qwen");

      let capturedPayload: unknown;
      const result = await streamSimpleOpenAICompletions(
        openAIModel,
        {
          systemPrompt: "standing instructions",
          messages: [{ role: "user", content: "wake prompt", timestamp: 1 }],
        },
        {
          apiKey: "sk-qwen-token-plan-cn-test",
          reasoning: "high",
          onPayload: (payload) => {
            capturedPayload = payload;
            throw new Error("captured before network");
          },
        },
      ).result();

      assert.equal(result.stopReason, "error");
      const payload = capturedPayload as {
        messages: Array<{ role: string }>;
        store?: unknown;
        enable_thinking?: unknown;
      };
      assert.deepEqual(payload.messages.map((message) => message.role), ["system", "user"]);
      assert.equal("store" in payload, false);
      assert.equal(payload.enable_thinking, true);
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Built-in gateway custom model resolution stays pinned when another provider uses the same model id", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-gateway-collision-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });

  try {
    const session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "claude-sonnet-4-6",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION,
          runtime: "builtin",
          provider: {
            kind: "gateway",
            providerId: "anthropic-compatible",
            baseUrl: "http://127.0.0.1:8787/anthropic",
            apiKey: "sk-gateway-test",
            supportsImageInput: true,
          },
          hostUserState: "forbidden",
          model: { kind: "custom", name: "claude-sonnet-4-6" },
          mode: { kind: "default" },
          envVars: {
            ANTHROPIC_API_KEY: "sk-host-anthropic-should-not-win",
            ANTHROPIC_BASE_URL: "https://host-anthropic-should-not-win.example/v1",
          },
        },
      }, { workingDirectory, launchId: "launch-1" }),
      "builtin-gateway-collision-session",
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        traceName: "daemon.builtin.session.create",
        traceEventPrefix: "daemon.builtin.session",
        logPrefix: "builtin-driver-test",
        agentDirSource: "managed_builtin",
        exposeLaunchTraceEvidence: true,
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
      },
    );

    try {
      assert.equal(session.model?.provider, "anthropic");
      assert.equal(session.model?.id, "claude-sonnet-4-6");
      assert.equal(session.model?.baseUrl, "http://127.0.0.1:8787/anthropic");
      assert.equal(session.model?.api, "anthropic-messages");
      assert.deepEqual(session.model?.input, ["text", "image"]);

      let capturedPayload: unknown;
      const result = await streamSimpleAnthropicMessages(
        session.model as Model<"anthropic-messages">,
        {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "inspect this" },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
            timestamp: 1,
          }],
        },
        {
          apiKey: "sk-gateway-test",
          onPayload: (payload) => {
            capturedPayload = payload;
            throw new Error("captured before network");
          },
        },
      ).result();
      assert.equal(result.stopReason, "error");
      const anthropicPayload = capturedPayload as {
        messages: Array<{ content: Array<{ type: string }> }>;
      };
      assert.ok(anthropicPayload.messages[0]?.content.some((block) => block.type === "image"));
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("process env patches are serialized across concurrent session creation", async () => {
  const key = "SLOCK_TEST_PI_SESSION_CREATE_ENV_PATCH";
  const previous = process.env[key];
  process.env[key] = "host";
  let releaseFirst!: () => void;
  let secondEntered = false;
  let firstEntered!: () => void;
  const firstEnteredPromise = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });

  try {
    const first = withProcessEnvPatch({ [key]: "first" }, async () => {
      assert.equal(process.env[key], "first");
      firstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      assert.equal(process.env[key], "first");
      return "first";
    });
    await firstEnteredPromise;

    const second = withProcessEnvPatch({ [key]: "second" }, async () => {
      secondEntered = true;
      assert.equal(process.env[key], "second");
      return "second";
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(secondEntered, false);
    assert.equal(process.env[key], "first");
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.equal(process.env[key], "host");
  } finally {
    restoreEnv(key, previous);
  }
});

test("SDK event mapping buffers thinking and text deltas until their matching end events", () => {
  const state = createPiSdkEventMappingState("pi-session-123");
  const events = [
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " more" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "plan more" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "hel" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "lo" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "hello" },
    } as unknown as AgentSessionEvent, state),
  ];

  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "pi-session-123" },
    { kind: "thinking", text: "" },
    { kind: "thinking", text: "plan more" },
    { kind: "text", text: "" },
    { kind: "text", text: "hello" },
  ]);
});

test("SDK event mapping uses buffered thinking deltas when thinking_end has no content", () => {
  const state = createPiSdkEventMappingState();
  const events = [
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "buffered" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " plan" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "" },
    } as unknown as AgentSessionEvent, state),
  ];

  assert.deepEqual(events, [
    { kind: "thinking", text: "" },
    { kind: "thinking", text: "buffered plan" },
  ]);
});

test("SDK event mapping emits final thinking_end when Pi did not stream thinking deltas", () => {
  const state = createPiSdkEventMappingState();
  const events = mapPiSdkEventToParsedEvents({
    type: "message_update",
    assistantMessageEvent: {
      type: "thinking_end",
      contentIndex: 0,
      content: "final plan",
    },
  } as unknown as AgentSessionEvent, state);

  assert.deepEqual(events, [{ kind: "thinking", text: "final plan" }]);
});

test("SDK event mapping buffers concurrent thinking blocks by contentIndex", () => {
  const state = createPiSdkEventMappingState();
  const events = [
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "first" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_start", contentIndex: 1 },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "second" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 1, content: "" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "" },
    } as unknown as AgentSessionEvent, state),
  ];

  assert.deepEqual(events, [
    { kind: "thinking", text: "" },
    { kind: "thinking", text: "" },
    { kind: "thinking", text: "second" },
    { kind: "thinking", text: "first" },
  ]);
});

test("SDK event mapping emits tool calls and waits for agent_settled before daemon turn_end", () => {
  const state = createPiSdkEventMappingState("pi-session-42");
  const events = [
    ...mapPiSdkEventToParsedEvents({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "turn_end",
      message: { role: "assistant" },
      toolResults: [],
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({ type: "agent_settled" } as unknown as AgentSessionEvent, state),
  ];

  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "pi-session-42" },
    { kind: "tool_call", name: "bash", input: { command: "pwd" } },
    { kind: "turn_end", sessionId: "pi-session-42" },
  ]);
});

test("SDK event mapping keeps non-terminal Pi-only progress events inert", () => {
  const piOnlyEventTypes = [
    "agent_start",
    "turn_start",
    "turn_end",
    "message_end",
    "tool_execution_update",
    "queue_update",
    "session_info_changed",
    "thinking_level_changed",
    "auto_retry_start",
  ] as const;

  fc.assert(
    fc.property(
      fc.option(fc.constant("pi-session-property"), { nil: null }),
      fc.constantFrom(...piOnlyEventTypes),
      (sessionId, type) => {
        const state = createPiSdkEventMappingState(sessionId);
        const events = [
          ...mapPiSdkEventToParsedEvents({ type } as unknown as AgentSessionEvent, state),
          ...mapPiSdkEventToParsedEvents({ type } as unknown as AgentSessionEvent, state),
        ];

        assert.deepEqual(events.filter((event) => event.kind !== "session_init"), []);
        assert.equal(events.filter((event) => event.kind === "session_init").length, sessionId ? 1 : 0);
      },
    ),
  );
});

test("SDK event mapping suppresses a retryable provider error when the retry succeeds", () => {
  const state = createPiSdkEventMappingState("pi-session-retry-success");
  const sequence = [
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "429: rate limited",
        usage: { input: 5, totalTokens: 5 },
      },
    },
    { type: "agent_end", messages: [], willRetry: true },
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "429: rate limited",
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 7, output: 3, totalTokens: 10 },
      },
    },
    { type: "auto_retry_end", success: true, attempt: 1 },
    { type: "agent_end", messages: [], willRetry: false },
    { type: "agent_settled" },
  ] as unknown as AgentSessionEvent[];
  const events = sequence.flatMap((event) => mapPiSdkEventToParsedEvents(event, state));

  assert.equal(events.filter((event) => event.kind === "error").length, 0);
  assert.deepEqual(
    events.filter((event) => event.kind === "telemetry").map((event) =>
      event.kind === "telemetry" ? event.attrs : null
    ),
    [
      { input_tokens: 5, total_tokens: 5 },
      { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    ],
  );
  assert.deepEqual(events.at(-1), {
    kind: "turn_end",
    sessionId: "pi-session-retry-success",
  });
});

test("SDK event mapping emits one final provider error after full retry exhaustion", () => {
  const state = createPiSdkEventMappingState("pi-session-retry-exhausted");
  const sequence: AgentSessionEvent[] = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    sequence.push(
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: `429: retry attempt ${attempt}`,
        },
      } as unknown as AgentSessionEvent,
      { type: "agent_end", messages: [], willRetry: true } as unknown as AgentSessionEvent,
      {
        type: "auto_retry_start",
        attempt,
        maxAttempts: 3,
        delayMs: 1_000 * attempt,
        errorMessage: `429: retry attempt ${attempt}`,
      } as unknown as AgentSessionEvent,
    );
  }
  sequence.push(
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "429: retry exhausted",
      },
    } as unknown as AgentSessionEvent,
    { type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent,
    {
      type: "auto_retry_end",
      success: false,
      attempt: 3,
      finalError: "429: retry exhausted",
    } as unknown as AgentSessionEvent,
    { type: "agent_settled" } as unknown as AgentSessionEvent,
  );

  const events = sequence.flatMap((event) => mapPiSdkEventToParsedEvents(event, state));
  assert.deepEqual(events.filter((event) => event.kind === "error"), [
    { kind: "error", message: "429: retry exhausted" },
  ]);
  assert.equal(events.filter((event) => event.kind === "turn_end").length, 1);
});

test("SDK event mapping emits one final provider error when retry is disabled or non-retryable", () => {
  for (const message of [
    "429: retries disabled",
    "401: provider authentication required",
    "403: provider quota unavailable",
  ]) {
    const state = createPiSdkEventMappingState(`pi-session-${message.slice(0, 3)}`);
    const sequence = [
      {
        type: "message_end",
        message: { role: "assistant", stopReason: "error", errorMessage: message },
      },
      { type: "agent_end", messages: [], willRetry: false },
      { type: "agent_settled" },
    ] as unknown as AgentSessionEvent[];
    const events = sequence.flatMap((event) => mapPiSdkEventToParsedEvents(event, state));
    assert.deepEqual(events.filter((event) => event.kind === "error"), [
      { kind: "error", message },
    ]);
    assert.equal(events.filter((event) => event.kind === "turn_end").length, 1);
  }
});

test("SDK event mapping emits retry cancellation exactly once", () => {
  const state = createPiSdkEventMappingState("pi-session-retry-cancelled");
  const sequence = [
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "429: rate limited" },
    },
    { type: "agent_end", messages: [], willRetry: true },
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "429: rate limited",
    },
    { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
    { type: "agent_settled" },
  ] as unknown as AgentSessionEvent[];
  const events = sequence.flatMap((event) => mapPiSdkEventToParsedEvents(event, state));

  assert.deepEqual(events.filter((event) => event.kind === "error"), [
    { kind: "error", message: "Retry cancelled" },
  ]);
  assert.equal(events.filter((event) => event.kind === "turn_end").length, 1);
});

test("SDK event mapping fails closed when retry terminal sequencing is incomplete", () => {
  const missingMessageState = createPiSdkEventMappingState("pi-session-missing-message");
  const missingMessageEvents = [
    ...mapPiSdkEventToParsedEvents({
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "provider retry failed",
    } as unknown as AgentSessionEvent, missingMessageState),
    ...mapPiSdkEventToParsedEvents({
      type: "agent_settled",
    } as unknown as AgentSessionEvent, missingMessageState),
  ];
  assert.deepEqual(missingMessageEvents.filter((event) => event.kind === "error"), [
    { kind: "error", message: "provider retry failed" },
  ]);

  const missingRetryEndState = createPiSdkEventMappingState("pi-session-missing-retry-end");
  const missingRetryEndEvents = [
    ...mapPiSdkEventToParsedEvents({
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "provider failed" },
    } as unknown as AgentSessionEvent, missingRetryEndState),
    ...mapPiSdkEventToParsedEvents({
      type: "agent_settled",
    } as unknown as AgentSessionEvent, missingRetryEndState),
  ];
  assert.deepEqual(missingRetryEndEvents.filter((event) => event.kind === "error"), [
    { kind: "error", message: "provider failed" },
  ]);
});

test("SDK event mapping emits token_usage from message_end usage on a successful turn", () => {
  const state = createPiSdkEventMappingState("pi-session-usage");
  const events = mapPiSdkEventToParsedEvents({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      usage: {
        input: 100,
        output: 200,
        totalTokens: 300,
        cost: { total: 0.033 },
      },
    },
  } as unknown as AgentSessionEvent, state);

  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "pi-session-usage" },
    {
      kind: "telemetry",
      name: "token_usage",
      source: "pi_message_end_usage",
      usageKind: "per_turn",
      sessionId: undefined,
      attrs: { input_tokens: 100, output_tokens: 200, total_tokens: 300, totalCostUsd: 0.033 },
    },
  ]);
});

test("SDK event mapping preserves error-turn token usage while holding the provider outcome", () => {
  const state = createPiSdkEventMappingState("pi-session-usage-err");
  const events = mapPiSdkEventToParsedEvents({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: "429: rate limited",
      usage: { input: 5, totalTokens: 5 },
    },
  } as unknown as AgentSessionEvent, state);

  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "pi-session-usage-err" },
    {
      kind: "telemetry",
      name: "token_usage",
      source: "pi_message_end_usage",
      usageKind: "per_turn",
      sessionId: undefined,
      attrs: { input_tokens: 5, total_tokens: 5 },
    },
  ]);
});

test("SDK event mapping preserves usage while suppressing a raw overflow error", () => {
  const events = mapPiSdkEventToParsedEvents({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage:
        "400 invalid_parameter_error: Range of input length should be [1, 983616]; Bearer sk-unsafe-token",
      usage: { input: 983_617, totalTokens: 983_617 },
    },
  } as unknown as AgentSessionEvent, createPiSdkEventMappingState("pi-session-overflow-usage"));

  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "pi-session-overflow-usage" },
    {
      kind: "telemetry",
      name: "token_usage",
      source: "pi_message_end_usage",
      usageKind: "per_turn",
      sessionId: undefined,
      attrs: { input_tokens: 983_617, total_tokens: 983_617 },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /invalid_parameter_error|unsafe|sk-/iu);
});

test("SDK event mapping keeps overflow owned by compaction after an ordinary retry attempt", () => {
  const state = createPiSdkEventMappingState("pi-session-retry-to-overflow");
  const sequence = [
    {
      type: "message_end",
      message: { role: "assistant", stopReason: "error", errorMessage: "429: rate limited" },
    },
    { type: "agent_end", messages: [], willRetry: true },
    {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1_000,
      errorMessage: "429: rate limited",
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "400 invalid_parameter_error: Range of input length should be [1, 983616]",
      },
    },
    {
      type: "auto_retry_end",
      success: false,
      attempt: 1,
      finalError: "400 invalid_parameter_error: Range of input length should be [1, 983616]",
    },
    { type: "agent_end", messages: [], willRetry: false },
    {
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Context overflow recovery failed after one compact-and-retry attempt",
    },
    { type: "agent_settled" },
  ] as unknown as AgentSessionEvent[];
  const events = sequence.flatMap((event) => mapPiSdkEventToParsedEvents(event, state));

  assert.deepEqual(events.filter((event) => event.kind === "error"), [
    {
      kind: "error",
      message: "InputTooLargeError",
      terminalReason: "compaction_failed_or_exhausted",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /429|invalid_parameter_error/iu);
});

test("SDK event mapping preserves failed compaction as one terminal outcome, never finished", () => {
  const state = createPiSdkEventMappingState("pi-session-overflow");
  const observedFailure = {
    type: "compaction_end",
    reason: "overflow",
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage:
      "Context overflow recovery failed after one compact-and-retry attempt; Bearer sk-unsafe-token https://provider.example/private",
  } as unknown as AgentSessionEvent;
  const events = Array.from({ length: 15 }, () => mapPiSdkEventToParsedEvents(
    observedFailure,
    state,
    {
      messageCount: 30,
      inputTextLength: 6_000,
      configuredContextLimit: 983_616,
    },
  )).flat();

  assert.equal(events.filter((event) => event.kind === "compaction_finished").length, 0);
  assert.deepEqual(
    events.filter((event) => event.kind !== "session_init"),
    [
      {
        kind: "compaction_interrupted",
        outcome: "compaction_failed_or_exhausted",
        reason: "overflow",
        failureReason: "recovery_exhausted",
      },
      {
        kind: "telemetry",
        name: "recovery",
        source: "pi_compaction",
        attrs: {
          recovery_outcome: "compaction_failed_or_exhausted",
          compaction_reason: "overflow",
          failure_reason: "recovery_exhausted",
          will_retry: false,
          message_count_capped: 30,
          message_count_was_capped: false,
          input_length_bucket: "4097_16384",
          configured_context_limit: 983_616,
          input_range_classification: "upper_bound_overflow",
        },
      },
      {
        kind: "error",
        message: "InputTooLargeError",
        terminalReason: "compaction_failed_or_exhausted",
      },
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /unsafe|token|provider\.example|private/iu,
  );
});

test("SDK event mapping runtime-normalizes a malicious compaction reason before every carrier", () => {
  const events = mapPiSdkEventToParsedEvents({
    type: "compaction_end",
    reason: "overflow; Bearer sk-reviewer-secret https://provider.example/private",
    result: undefined,
    aborted: false,
    willRetry: false,
    errorMessage: "private provider failure",
  } as unknown as AgentSessionEvent, createPiSdkEventMappingState(), {
    messageCount: 2,
    inputTextLength: 2_048,
    configuredContextLimit: 983_616,
  });

  assert.deepEqual(events, [
    {
      kind: "compaction_interrupted",
      outcome: "compaction_failed_or_exhausted",
      reason: "unknown",
      failureReason: "compaction_failed",
    },
    {
      kind: "telemetry",
      name: "recovery",
      source: "pi_compaction",
      attrs: {
        recovery_outcome: "compaction_failed_or_exhausted",
        compaction_reason: "unknown",
        failure_reason: "compaction_failed",
        will_retry: false,
        message_count_capped: 2,
        message_count_was_capped: false,
        input_length_bucket: "1025_4096",
        configured_context_limit: 983_616,
        input_range_classification: "nonempty",
      },
    },
    {
      kind: "error",
      message: "InputTooLargeError",
      terminalReason: "compaction_failed_or_exhausted",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /reviewer|secret|provider\.example|private/iu);
});

test("SDK event mapping distinguishes successful and aborted compaction outcomes", () => {
  const succeeded = mapPiSdkEventToParsedEvents({
    type: "compaction_end",
    reason: "threshold",
    result: { summary: "must not cross the adapter boundary" },
    aborted: false,
    willRetry: false,
  } as unknown as AgentSessionEvent, createPiSdkEventMappingState(), {
    messageCount: 4,
    inputTextLength: 2_000,
    configuredContextLimit: 131_072,
  });
  const aborted = mapPiSdkEventToParsedEvents({
    type: "compaction_end",
    reason: "manual",
    result: undefined,
    aborted: true,
    willRetry: false,
  } as unknown as AgentSessionEvent, createPiSdkEventMappingState(), {
    messageCount: 1,
    inputTextLength: 64,
    configuredContextLimit: 131_072,
  });

  assert.deepEqual(succeeded, [
    { kind: "compaction_finished" },
    {
      kind: "telemetry",
      name: "recovery",
      source: "pi_compaction",
      attrs: {
        recovery_outcome: "compaction_succeeded",
        compaction_reason: "threshold",
        will_retry: false,
        message_count_capped: 4,
        message_count_was_capped: false,
        input_length_bucket: "1025_4096",
        configured_context_limit: 131_072,
        input_range_classification: "nonempty",
      },
    },
  ]);
  assert.deepEqual(aborted, [
    {
      kind: "compaction_interrupted",
      outcome: "aborted",
      reason: "manual",
    },
    {
      kind: "telemetry",
      name: "recovery",
      source: "pi_compaction",
      attrs: {
        recovery_outcome: "aborted",
        compaction_reason: "manual",
        will_retry: false,
        message_count_capped: 1,
        message_count_was_capped: false,
        input_length_bucket: "1_1024",
        configured_context_limit: 131_072,
        input_range_classification: "nonempty",
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(succeeded), /must not cross/iu);
});

test("Pi compaction input telemetry classifies true empty input separately and caps counts", () => {
  assert.deepEqual(projectPiCompactionInputTelemetry({
    messageCount: 0,
    inputTextLength: 0,
    configuredContextLimit: 983_616,
  }, "overflow"), {
    message_count_capped: 0,
    message_count_was_capped: false,
    input_length_bucket: "0",
    configured_context_limit: 983_616,
    input_range_classification: "lower_bound_empty",
  });
  assert.deepEqual(projectPiCompactionInputTelemetry({
    messageCount: 2_000,
    inputTextLength: 2_000_000,
    configuredContextLimit: Number.POSITIVE_INFINITY,
  }, "overflow"), {
    message_count_capped: 1_024,
    message_count_was_capped: true,
    input_length_bucket: "over_1048576",
    configured_context_limit_present: false,
    input_range_classification: "upper_bound_overflow",
  });
});

test("SDK event mapping holds daemon turn_end until Pi reports agent_settled", () => {
  const state = createPiSdkEventMappingState("pi-session-settled");
  assert.deepEqual(mapPiSdkEventToParsedEvents({
    type: "agent_end",
    messages: [],
    willRetry: false,
  } as unknown as AgentSessionEvent, state), [
    { kind: "session_init", sessionId: "pi-session-settled" },
  ]);
  assert.deepEqual(mapPiSdkEventToParsedEvents({
    type: "agent_settled",
  } as unknown as AgentSessionEvent, state), [
    { kind: "turn_end", sessionId: "pi-session-settled" },
  ]);
});

test("SDK event mapping permits one compact-and-retry chain, then terminalizes a second Qwen overflow", () => {
  const state = createPiSdkEventMappingState("pi-session-qwen");
  const qwenOverflow = {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage:
        "400 invalid_parameter_error: Range of input length should be [1, 983616]; Bearer sk-unsafe-token",
    },
  } as unknown as AgentSessionEvent;
  const evidence = {
    messageCount: 30,
    inputTextLength: 1_048_577,
    configuredContextLimit: 983_616,
  };
  const sequence = [
    qwenOverflow,
    { type: "agent_end", messages: [], willRetry: false },
    { type: "compaction_start", reason: "overflow", willRetry: true },
    {
      type: "compaction_end",
      reason: "overflow",
      result: { summary: "private compacted context" },
      aborted: false,
      willRetry: true,
    },
    qwenOverflow,
    { type: "agent_end", messages: [], willRetry: false },
    {
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage:
        "Context overflow recovery failed after one compact-and-retry attempt; https://provider.example/private",
    },
    { type: "agent_settled" },
  ] as unknown as AgentSessionEvent[];
  const events = sequence.flatMap((event) =>
    mapPiSdkEventToParsedEvents(
      event,
      state,
      event.type === "compaction_end" ? evidence : undefined,
    )
  );

  assert.equal(events.filter((event) => event.kind === "compaction_started").length, 1);
  assert.equal(events.filter((event) => event.kind === "compaction_finished").length, 1);
  assert.equal(events.filter((event) => event.kind === "compaction_interrupted").length, 1);
  assert.equal(events.filter((event) => event.kind === "error").length, 1);
  assert.equal(events.filter((event) => event.kind === "turn_end").length, 1);
  assert.equal(events.at(-1)?.kind, "turn_end");
  assert.deepEqual(
    events.filter((event) => event.kind === "telemetry").map((event) =>
      event.kind === "telemetry" ? event.attrs?.recovery_outcome : null
    ),
    ["compaction_succeeded", "compaction_failed_or_exhausted"],
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /invalid_parameter_error|unsafe|private compacted context|provider\.example/iu,
  );
});

test("SDK assistant placeholder events stay invisible to daemon turn accounting", () => {
  const assistantPlaceholderEventTypes = [
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "start",
    "done",
  ] as const;

  fc.assert(
    fc.property(
      fc.option(fc.constant("pi-session-property"), { nil: null }),
      fc.constantFrom(...assistantPlaceholderEventTypes),
      (sessionId, assistantEventType) => {
        const state = createPiSdkEventMappingState(sessionId);
        const sdkEvent = {
          type: "message_update",
          assistantMessageEvent: { type: assistantEventType },
        } as unknown as AgentSessionEvent;
        const events = [
          ...mapPiSdkEventToParsedEvents(sdkEvent, state),
          ...mapPiSdkEventToParsedEvents(sdkEvent, state),
        ];

        assert.deepEqual(events.filter((event) => event.kind !== "session_init"), []);
        assert.equal(events.filter((event) => event.kind === "session_init").length, sessionId ? 1 : 0);
      },
    ),
  );
});

test("SDK event mapping emits final text_end when Pi did not stream text deltas", () => {
  const state = createPiSdkEventMappingState();
  const events = mapPiSdkEventToParsedEvents({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_end",
      content: "final answer",
    },
  } as unknown as AgentSessionEvent, state);

  assert.deepEqual(events, [{ kind: "text", text: "final answer" }]);
});

test("SDK event mapping uses buffered text deltas when text_end has no content", () => {
  const state = createPiSdkEventMappingState();
  const events = [
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "streamed" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " answer" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "" },
    } as unknown as AgentSessionEvent, state),
  ];

  assert.deepEqual(events, [
    { kind: "text", text: "" },
    { kind: "text", text: "streamed answer" },
  ]);
});

test("SDK event mapping buffers concurrent text blocks by contentIndex", () => {
  const state = createPiSdkEventMappingState();
  const events = [
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "first" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 1 },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "second" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "" },
    } as unknown as AgentSessionEvent, state),
    ...mapPiSdkEventToParsedEvents({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "" },
    } as unknown as AgentSessionEvent, state),
  ];

  assert.deepEqual(events, [
    { kind: "text", text: "" },
    { kind: "text", text: "" },
    { kind: "text", text: "second" },
    { kind: "text", text: "first" },
  ]);
});

test("driver contract is persistent SDK steering with slock-cli communication", () => {
  const driver = new PiDriver();

  assert.equal(driver.id, "pi");
  assert.deepEqual(driver.lifecycle, {
    kind: "persistent",
    stdin: "direct",
    inFlightWake: "steer",
  });
  assert.deepEqual(driver.communication, { chat: "slock_cli", runtimeControl: "none" });
  assert.equal(driver.supportsStdinNotification, true);
  assert.equal(driver.busyDeliveryMode, "direct");
  assert.deepEqual(driver.model.toLaunchSpec?.("provider/model-alpha"), {
    params: { model: "provider/model-alpha" },
  });
});

test("driver creates a native SDK RuntimeSession instead of a child-process adapter", () => {
  const driver = new PiDriver();
  const runtime = driver.createSession(makeSpawnContext());

  assert.ok(runtime instanceof PiSdkRuntimeSession);
  assert.deepEqual(runtime.descriptor, {
    transport: "sdk",
    lifecycle: "sdk_session",
    stdout: {
      channel: "diagnostic",
    },
    input: {
      initial: "start",
      idle: "sdk_prompt",
      busy: "sdk_steer",
    },
    readiness: "sdk_ready",
    turnBoundary: "sdk_event",
    startPolicy: "immediate",
    inFlightWake: "steer",
    busyDelivery: "direct",
    postTurn: "keep_alive",
  });
  assert.equal(driver.encodeStdinMessage("hello", "session", { mode: "idle" }), null);
});

test("driver enables Pi SDK compaction so compaction lifecycle events can surface", () => {
  assert.equal(
    PI_SDK_COMPACTION_ENABLED,
    true,
    "Pi SDK settings must keep compaction enabled; the driver already maps compaction_start/end to daemon events",
  );
});

test("PiSdkRuntimeSession subscribes before prompt and routes prompt, steer, and stop through SDK APIs", async () => {
  const calls: string[] = [];
  const events: ParsedEvent[] = [];
  const fake = createFakeAgentSession("pi-session-runtime", calls);
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  runtime.on("runtime_event", (event) => events.push(event));

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.slice(0, 2), ["subscribe", "prompt:initial prompt:subscribers=1"]);
  assert.deepEqual(events, [
    { kind: "session_init", sessionId: "pi-session-runtime" },
    { kind: "turn_end", sessionId: "pi-session-runtime" },
  ]);

  const busyResult = runtime.send({ mode: "busy", text: "steer now" });
  assert.equal(isThenable(busyResult), false);
  assert.deepEqual(busyResult, { ok: true, acceptedAs: "steer" });
  assert.equal(calls.includes("steer:steer now"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("steer:steer now"), true);

  const idleResult = runtime.send({ mode: "idle", text: "idle follow-up" });
  assert.equal(isThenable(idleResult), false);
  assert.deepEqual(idleResult, { ok: true, acceptedAs: "prompt" });
  assert.equal(calls.includes("prompt:idle follow-up:subscribers=1"), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("prompt:idle follow-up:subscribers=1"), true);

  fake.__setStreaming(true);
  await runtime.stop({ signal: "SIGTERM", reason: "test-stop" });
  assert.equal(calls.includes("abort"), true);
  assert.equal(calls.includes("dispose"), true);
});

test("PiSdkRuntimeSession queues initial prompt before session_init-triggered steering", async () => {
  const calls: string[] = [];
  const fake = createFakeAgentSession("pi-session-ready-debt", calls);
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  runtime.on("runtime_event", (event) => {
    if (event.kind === "session_init") {
      assert.deepEqual(runtime.send({ mode: "busy", text: "queued before session_init" }), {
        ok: true,
        acceptedAs: "steer",
      });
    }
  });

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), {
    ok: true,
    acceptedAs: "prompt",
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.slice(0, 3), [
    "subscribe",
    "prompt:initial prompt:subscribers=1",
    "steer:queued before session_init",
  ]);
});

test("Built-in auth seeding captures preset keys in per-agent ModelRuntime overrides", async () => {
  const previousKimi = process.env.KIMI_API_KEY;
  process.env.KIMI_API_KEY = "host-kimi";
  try {
    const presetConfig = {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "kimi-coding", apiKey: "preset-kimi" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "kimi-coding/kimi-k2.7-code" },
      mode: { kind: "default" },
    } as const;
    const presetCredentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials: presetCredentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    await seedPiSessionModelRuntime(modelRuntime, presetConfig);

    assert.equal((await modelRuntime.getAuth("kimi-coding"))?.auth.apiKey, "preset-kimi");
    assert.equal(await presetCredentials.read("kimi-coding"), undefined, "runtime override must not persist into credential storage");
    assert.deepEqual(modelRuntime.getProviderAuthStatus("kimi-coding"), {
      configured: true,
      source: "runtime",
    });
    assert.equal(process.env.KIMI_API_KEY, "host-kimi");
    assert.deepEqual(buildPiSessionCreateEnvPatch(presetConfig, {
      KIMI_API_KEY: "preset-kimi",
      SAFE_FLAG: "enabled",
    }), { SAFE_FLAG: "enabled" });

    const gatewayCredentials = new InMemoryCredentialStore();
    const gatewayRuntime = await ModelRuntime.create({
      credentials: gatewayCredentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    const gatewayConfig = {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "openai-compatible",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "preset-openai-compatible",
      },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "gateway-model" },
      mode: { kind: "default" },
    } as const;
    await seedPiSessionModelRuntime(gatewayRuntime, gatewayConfig);

    assert.equal((await gatewayRuntime.getAuth("openai"))?.auth.apiKey, "preset-openai-compatible");
    assert.equal(await gatewayCredentials.read("openai"), undefined, "gateway runtime override must not persist into credential storage");
    assert.deepEqual(buildPiSessionCreateEnvPatch(gatewayConfig, {
      OPENAI_API_KEY: "preset-openai-compatible",
      OPENAI_BASE_URL: "https://gateway.example.test/v1",
      SAFE_FLAG: "enabled",
    }), {
      OPENAI_BASE_URL: "https://gateway.example.test/v1",
      SAFE_FLAG: "enabled",
    });
  } finally {
    restoreEnv("KIMI_API_KEY", previousKimi);
  }
});

test("Pi library egress traverses both interception faces, and apiKey seeding produces none", async () => {
  // The mock-based teeth above prove OUR side of the contract: we pass no options and issue no
  // refresh. They cannot prove the library's side, because setRuntimeApiKey is stubbed there.
  //
  // That matters because 0.84.3 CHANGED this path. In 0.83.0 setRuntimeApiKey did local snapshot
  // arithmetic and one outbound call that consumed OUR refreshOptions. In 0.84.3 it delegates to
  // synchronizeCredentialState, which refreshes with a hardcoded allowNetwork:false AND calls
  // refreshProviderAvailability -> getAvailable / checkAuth / credentials.read, none of which
  // accept a network toggle. Control moved out of our hands while the surface grew, so the
  // guarantee is now upstream's and must be verified against the real library, not asserted.
  //
  // WHAT THIS PROVES, PRECISELY: "if the library goes out, I see it" -- NOT "the seeding path goes
  // out", which must never happen. Those are different claims and only the first is falsifiable
  // here. A positive control built on the seeding path itself is impossible: that path contains no
  // egress site at all (dist/models.js and dist/auth/resolve.js have neither a fetch call nor any
  // import capable of one), so any control there would have to invent an endpoint the product does
  // not have -- proving the fixture, not the library. The control therefore runs at the only
  // reachable real egress site: an OAuth flow, pointed at loopback.
  //
  // BOTH counters are asserted on that single request. If only the fetch face recorded it, the
  // socket face would be empty on this path, and any future egress issued through http(s).request
  // rather than fetch -- an SDK path, say -- would fall outside coverage silently. Two faces
  // recording one request is what makes the coverage claim load-bearing.
  const oauthPaths: string[] = [];
  const server = createServer((req, res) => {
    oauthPaths.push(req.url ?? "");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ access_token: "a-tok", refresh_token: "r-tok", expires_in: 3600 }));
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as AddressInfo).port;
  const previousOauthHost = process.env.KIMI_CODE_OAUTH_HOST;

  // Pass-through while the control runs, so the request actually reaches loopback and BOTH faces
  // can record it; fail-closed during seeding, so a regression is contained instead of dialling out.
  let blocking = false;
  let fetchCount = 0;
  let sockCount = 0;
  const fetchTargets: string[] = [];
  const sockTargets: string[] = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  globalThis.fetch = function patchedFetch(input: unknown, init?: unknown): Promise<Response> {
    fetchCount += 1;
    fetchTargets.push(String((input as { url?: string })?.url ?? input));
    if (blocking) throw new Error("unexpected network egress via fetch");
    return (realFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
  } as unknown as typeof globalThis.fetch;
  net.Socket.prototype.connect = function patchedConnect(this: Socket, ...args: unknown[]): Socket {
    sockCount += 1;
    // node normalizes connect() arguments into an array-like [options, callback] before it reaches
    // the prototype, so the target is one level in; read it defensively either way.
    const raw = args[0] as Record<string, unknown> | undefined;
    const opts = (raw && typeof raw === "object" && "0" in raw ? raw["0"] : raw) as
      { host?: string; port?: number } | undefined;
    sockTargets.push(`${opts?.host}:${opts?.port}`);
    if (blocking) throw new Error("unexpected network egress via net.Socket.connect");
    return (realConnect as (...a: unknown[]) => Socket).apply(this, args);
  } as never;

  try {
    // --- POSITIVE CONTROL: real 0.85.1 OAuth flow, real fetch, pointed at loopback -------------
    process.env.KIMI_CODE_OAUTH_HOST = `http://127.0.0.1:${port}`;
    const { kimiCodingProvider } = await import("@earendil-works/pi-ai/providers/kimi-coding");
    const provider = kimiCodingProvider() as unknown as {
      id: string;
      auth: {
        oauth: {
          refresh: (credential: unknown, signal: AbortSignal) =>
            Promise<{ access: string; refresh: string }>;
        };
      };
    };
    assert.equal(provider.id, "kimi-coding", "control must exercise the real provider definition");
    const refreshed = await provider.auth.oauth.refresh(
      { type: "oauth", access: "old", refresh: "dummy-refresh", expires: 0 },
      new AbortController().signal,
    );

    assert.equal(refreshed.access, "a-tok", "the library must have parsed OUR loopback response");
    assert.deepEqual(oauthPaths, ["/api/oauth/token"], "loopback server must have served the flow");
    assert.equal(fetchCount, 1, "library-originated egress must reach the fetch face exactly once");
    assert.equal(sockCount, 1, "library-originated egress must reach the socket face exactly once");
    assert.ok(
      fetchTargets[0]?.includes(`127.0.0.1:${port}`),
      `fetch face must record the loopback target, saw ${fetchTargets[0]}`,
    );
    assert.equal(
      sockTargets[0],
      `127.0.0.1:${port}`,
      "socket face must record the loopback host:port, not an unresolved target",
    );

    // --- THE ACTUAL CLAIM: the real seeding path emits nothing on either face -------------------
    blocking = true;
    fetchCount = 0;
    sockCount = 0;
    fetchTargets.length = 0;
    sockTargets.length = 0;

    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    await seedPiSessionModelRuntime(modelRuntime, {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "kimi-coding", apiKey: "preset-kimi" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "kimi-coding/kimi-k2.7-code" },
      mode: { kind: "default" },
    } as never);

    assert.equal(
      fetchCount,
      0,
      `credential seeding must not reach the network; saw fetch to ${fetchTargets.join(", ")}`,
    );
    assert.equal(
      sockCount,
      0,
      `credential seeding must not open a socket; saw connect to ${sockTargets.join(", ")}`,
    );
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
    restoreEnv("KIMI_CODE_OAUTH_HOST", previousOauthHost);
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
});

test("pi pin is the version this offline guarantee was verified against", () => {
  // The offline guarantee now lives in upstream code, so nothing in this repo fails when a future
  // 0.8x.y moves it. This anchor forces a human decision at bump time: change the pin and this
  // test reds until someone re-verifies the seeding path against the new artifact.
  //
  // HOW TO RE-VERIFY (three commands; do this before touching VERIFIED_AGAINST):
  //   1. npm pack @earendil-works/pi-coding-agent@<old> and @<new>; untar both.
  //   2. diff their dist/core/model-runtime.js.
  //   3. Confirm synchronizeCredentialState still calls
  //        this.models.refresh({ allowNetwork: false, providers: [providerId], signal })
  //      and that refreshProviderAvailability still reads only local state
  //      (models.getAvailable / models.checkAuth / credentials.read).
  //   If the credential path is untouched, the guarantee holds. 0.84.4 -> 0.85.1 was a 7-line
  //   diff, entirely a fetchDeferred -> streamDeferred refactor, with the seeding path
  //   byte-identical.
  //
  // Then update VERIFIED_AGAINST *and* the three sibling 0.8x.y labels below (the positive-control
  // comment, the "never triggers a remote model refresh (pi X)" test name, and its comment) --
  // otherwise they assert a version nobody re-checked.
  const VERIFIED_AGAINST = "0.85.1";
  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const name of ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent"]) {
    assert.equal(
      pkg.dependencies[name],
      VERIFIED_AGAINST,
      `${name} moved off ${VERIFIED_AGAINST}. The no-network seeding guarantee is upstream's, not `
        + `ours, so re-verify before moving this pin: npm pack pi-coding-agent at both versions, `
        + `diff dist/core/model-runtime.js, and confirm synchronizeCredentialState still refreshes `
        + `with allowNetwork:false. Only then update VERIFIED_AGAINST. Editing this constant `
        + `without that check removes the only detector we have.`,
    );
  }
});

test("Pi auth seeding never triggers a remote model refresh (pi 0.85.1)", async () => {
  // Under 0.85.1 the offline guarantee lives inside the library: credential synchronization
  // refreshes with allowNetwork:false and reconciles only local catalog/composition/availability.
  // Our side of the contract is that seeding issues NO refresh of its own — remote freshness is a
  // separate, deliberate caller decision. This counts refreshes rather than inspecting arguments,
  // so an explicitly remote refresh added to the seeding path fails here even though it would
  // typecheck and leave every value-level assertion untouched.
  let refreshCalls = 0;
  let remoteRefreshCalls = 0;
  const modelRuntime = {
    async setRuntimeApiKey() {},
    async refresh(options?: { allowNetwork?: boolean }) {
      refreshCalls += 1;
      if (options?.allowNetwork === true) remoteRefreshCalls += 1;
      return { refreshed: [] } as unknown as ReturnType<ModelRuntime["refresh"]>;
    },
  };

  await seedPiSessionModelRuntime(
    modelRuntime as unknown as Pick<ModelRuntime, "setRuntimeApiKey">,
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "kimi-coding", apiKey: "preset-kimi" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "kimi-coding/kimi-k2.7-code" },
      mode: { kind: "default" },
    } as never,
  );

  assert.equal(refreshCalls, 0, "seeding must not call refresh() at all");
  assert.equal(remoteRefreshCalls, 0, "seeding must never request a network-backed refresh");

  // Positive control: the counter must be able to observe a remote refresh, otherwise the two
  // assertions above would hold trivially and this tooth would be green by construction.
  await modelRuntime.refresh({ allowNetwork: true });
  assert.equal(refreshCalls, 1, "counter must observe refresh calls");
  assert.equal(remoteRefreshCalls, 1, "counter must distinguish network-backed refreshes");
});

test("Pi auth seeding keeps SDK model refresh offline", async () => {
  // Records ARITY, not just the values. Under pi 0.84.3 the offline guarantee moved into the
  // library: credential synchronization itself refreshes with allowNetwork:false and only
  // reconciles local catalog/composition/availability. Our contract is therefore "pass exactly
  // providerId and apiKey, and nothing else" — asserting argCount is what makes re-introducing
  // a third argument (an options object, a network toggle) fail here instead of silently
  // changing seeding behaviour.
  const calls: Array<{ providerId: string; apiKey: string; argCount: number }> = [];
  const modelRuntime: Pick<ModelRuntime, "setRuntimeApiKey"> = {
    async setRuntimeApiKey(...args: Parameters<ModelRuntime["setRuntimeApiKey"]>) {
      calls.push({ providerId: args[0], apiKey: args[1], argCount: args.length });
    },
  };
  const configs = [
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "pi-key" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "preset", providerId: "kimi-coding", apiKey: "preset-key" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "kimi-coding/kimi-k2.7-code" },
      mode: { kind: "default" },
    },
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "openai-compatible",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "gateway-key",
      },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "gateway-model" },
      mode: { kind: "default" },
    },
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: {
        kind: "gateway",
        providerId: "anthropic-compatible",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: "anthropic-gateway-key",
      },
      hostUserState: "forbidden",
      model: { kind: "custom", name: "gateway-model" },
      mode: { kind: "default" },
    },
  ] as Parameters<typeof seedPiSessionModelRuntime>[1][];

  for (const config of configs) await seedPiSessionModelRuntime(modelRuntime, config);
  await seedPiSessionModelRuntime(
    modelRuntime,
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    },
    { providerId: "deepseek", endpointUrl: null, supportsImageInput: false },
    { DEEPSEEK_API_KEY: "managed-key" },
  );
  await seedPiSessionModelRuntime(
    modelRuntime,
    {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "builtin",
      provider: { kind: "connection", connectionId: "22222222-2222-4222-8222-222222222222" },
      hostUserState: "forbidden",
      model: { kind: "preset", id: "google/gemini-3.1-pro-preview" },
      mode: { kind: "default" },
    },
    { providerId: "google", endpointUrl: null, supportsImageInput: false },
    { GEMINI_API_KEY: "managed-google-key" },
  );

  // Sole refresh-option guard for every setRuntimeApiKey branch; new provider paths must extend this expected call log.
  assert.deepEqual(calls, [
    { providerId: "deepseek", apiKey: "pi-key", argCount: 2 },
    { providerId: "kimi-coding", apiKey: "preset-key", argCount: 2 },
    { providerId: "openai", apiKey: "gateway-key", argCount: 2 },
    { providerId: "anthropic", apiKey: "anthropic-gateway-key", argCount: 2 },
    { providerId: "deepseek", apiKey: "managed-key", argCount: 2 },
    { providerId: "google", apiKey: "managed-google-key", argCount: 2 },
  ]);
});

test("managed provider launches seed credentials from ephemeral env and keep gateway metadata secret-free", async () => {
  const deepseekConfig = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
    hostUserState: "forbidden",
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
  } as const;
  const deepseekRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  await seedPiSessionModelRuntime(
    deepseekRuntime,
    deepseekConfig,
    { providerId: "deepseek", endpointUrl: null, supportsImageInput: false },
    { DEEPSEEK_API_KEY: "managed-deepseek-key" },
  );
  assert.equal((await deepseekRuntime.getAuth("deepseek"))?.auth.apiKey, "managed-deepseek-key");
  assert.deepEqual(buildPiSessionCreateEnvPatch(deepseekConfig, {
    DEEPSEEK_API_KEY: "managed-deepseek-key",
    SAFE_FLAG: "enabled",
  }), { SAFE_FLAG: "enabled" });

  const gatewayConfig = {
    ...deepseekConfig,
    model: { kind: "custom", name: "managed-model" },
  } as const;
  const gatewayProjection = {
    providerId: "openai-compatible",
    endpointUrl: "https://gateway.example.test/v1",
    supportsImageInput: true,
  } as const;
  const gatewayRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  await seedPiSessionModelRuntime(
    gatewayRuntime,
    gatewayConfig,
    gatewayProjection,
    { OPENAI_API_KEY: "managed-gateway-key", OPENAI_BASE_URL: gatewayProjection.endpointUrl },
  );
  assert.equal((await gatewayRuntime.getAuth("openai"))?.auth.apiKey, "managed-gateway-key");
  assert.deepEqual(resolveBuiltInGatewayLaunch(gatewayConfig, gatewayProjection), {
    providerId: "openai-compatible",
    baseUrl: gatewayProjection.endpointUrl,
    supportsImageInput: true,
  });
  await assert.rejects(
    () => seedPiSessionModelRuntime(gatewayRuntime, gatewayConfig),
    /launch metadata is missing/,
  );
});

test("Pi auth seeding captures pi-builtin keys without process env", async () => {
  const key = "DEEPSEEK_API_KEY";
  const previous = process.env[key];
  process.env[key] = "host-deepseek-key";
  try {
    const runtimeConfig = {
      version: RUNTIME_CONFIG_VERSION,
      runtime: "pi",
      provider: { kind: "pi-builtin", providerId: "deepseek", apiKey: "agent-deepseek-key" },
      model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
      mode: { kind: "default" },
    } as const;
    const credentials = new InMemoryCredentialStore();
    const modelRuntime = await ModelRuntime.create({
      credentials,
      modelsPath: null,
      allowModelNetwork: false,
    });
    await seedPiSessionModelRuntime(modelRuntime, runtimeConfig);

    assert.equal((await modelRuntime.getAuth("deepseek"))?.auth.apiKey, "agent-deepseek-key");
    assert.equal(await credentials.read("deepseek"), undefined, "runtime override must not persist into credential storage");
    assert.deepEqual(modelRuntime.getProviderAuthStatus("deepseek"), {
      configured: true,
      source: "runtime",
    });
    assert.equal(process.env[key], "host-deepseek-key");
    assert.deepEqual(buildPiSessionCreateEnvPatch(runtimeConfig, {
      DEEPSEEK_API_KEY: "agent-deepseek-key",
      SAFE_FLAG: "enabled",
    }), { SAFE_FLAG: "enabled" });
  } finally {
    restoreEnv(key, previous);
  }
});

test("PiSdkRuntimeSession defers idle prompt until Pi clears streaming after agent_end", async () => {
  const calls: string[] = [];
  const fake = createFakeAgentSession("pi-session-runtime", calls);
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("prompt:initial prompt:subscribers=1"), true);

  fake.__setStreaming(true);
  const idleResult = runtime.send({ mode: "idle", text: "idle follow-up" });
  assert.equal(isThenable(idleResult), false);
  assert.deepEqual(idleResult, { ok: true, acceptedAs: "prompt" });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.includes("prompt:idle follow-up:subscribers=1"), false);

  fake.__setStreaming(false);
  await waitForState(
    () => calls.includes("prompt:idle follow-up:subscribers=1"),
    "idle follow-up prompt delivered to one subscriber",
    { timeoutMs: 500, pollIntervalMs: 10 },
  );
  assert.equal(calls.includes("prompt:idle follow-up:subscribers=1"), true);
});

test("PiSdkRuntimeSession does not serialize pi-builtin prompts across agents", async () => {
  const entered: string[] = [];
  let releaseFirst!: () => void;
  let markFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    markFirstEntered = resolve;
  });
  const firstCalls: string[] = [];
  const secondCalls: string[] = [];
  const firstFake = createFakeAgentSession("pi-session-first", firstCalls, {
    onPrompt: async () => {
      entered.push("first");
      markFirstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    },
  });
  const secondFake = createFakeAgentSession("pi-session-second", secondCalls, {
    onPrompt: () => {
      entered.push("second");
    },
  });
  const makeRuntime = (apiKey: string, fake: ReturnType<typeof createFakeAgentSession>) => new PiSdkRuntimeSession(
    makeSpawnContext({
      model: "deepseek/deepseek-v4-pro",
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "pi",
        provider: { kind: "pi-builtin", providerId: "deepseek", apiKey },
        model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
        mode: { kind: "default" },
      },
    }),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  const first = makeRuntime("first-key", firstFake);
  const second = makeRuntime("second-key", secondFake);

  try {
    assert.deepEqual(await first.start({ text: "first prompt" }), { ok: true, acceptedAs: "prompt" });
    await firstEntered;
    assert.deepEqual(await second.start({ text: "second prompt" }), { ok: true, acceptedAs: "prompt" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(entered, ["first", "second"]);
  } finally {
    releaseFirst?.();
    await Promise.all([first.dispose(), second.dispose()]);
  }
});

test("PiSdkRuntimeSession steers deferred idle input when Pi keeps streaming past grace window", async () => {
  const calls: string[] = [];
  const fake = createFakeAgentSession("pi-session-runtime", calls);
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  fake.__setStreaming(true);
  const idleResult = runtime.send({ mode: "idle", text: "idle follow-up" });
  assert.equal(isThenable(idleResult), false);
  assert.deepEqual(idleResult, { ok: true, acceptedAs: "prompt" });

  await waitForState(
    () => calls.includes("steer:idle follow-up"),
    "idle follow-up steered",
    { timeoutMs: 1_500, pollIntervalMs: 10 },
  );
  assert.equal(calls.includes("prompt:idle follow-up:subscribers=1"), false);
});

test("PiSdkRuntimeSession emits typed delivery_error for deferred busy steer rejection", async () => {
  const calls: string[] = [];
  const events: ParsedEvent[] = [];
  const fake = createFakeAgentSession("pi-session-runtime", calls, {
    steerError: new Error("steer failed"),
  });
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  runtime.on("runtime_event", (event) => events.push(event));

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  const busyResult = runtime.send({ mode: "busy", text: "steer now" });
  assert.equal(isThenable(busyResult), false);
  assert.deepEqual(busyResult, { ok: true, acceptedAs: "steer" });

  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.deepEqual(events.find((event) => event.kind === "delivery_error"), {
    kind: "delivery_error",
    message: "steer failed",
    requestMethod: "turn/steer",
    source: "pi_sdk_response",
    code: "runtime.delivery_error",
    payloadBytes: Buffer.byteLength("steer now", "utf8"),
  });
});

test("PiSdkRuntimeSession emits typed delivery_error for deferred idle prompt rejection", async () => {
  const calls: string[] = [];
  const events: ParsedEvent[] = [];
  let promptCount = 0;
  const fake = createFakeAgentSession("pi-session-runtime", calls, {
    onPrompt: () => {
      promptCount += 1;
      if (promptCount === 2) throw new Error("prompt failed");
    },
  });
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  runtime.on("runtime_event", (event) => events.push(event));

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  const idleResult = runtime.send({ mode: "idle", text: "prompt now" });
  assert.equal(isThenable(idleResult), false);
  assert.deepEqual(idleResult, { ok: true, acceptedAs: "prompt" });

  await new Promise((resolve) => setImmediate(resolve));
  await Promise.resolve();
  assert.deepEqual(events.find((event) => event.kind === "delivery_error"), {
    kind: "delivery_error",
    message: "prompt failed",
    requestMethod: "turn/start",
    source: "pi_sdk_response",
    code: "runtime.delivery_error",
    payloadBytes: Buffer.byteLength("prompt now", "utf8"),
  });
});

test("PiSdkRuntimeSession suppresses a late deferred delivery rejection after close", async () => {
  const calls: string[] = [];
  const events: ParsedEvent[] = [];
  let rejectSteer!: (error: Error) => void;
  const fake = createFakeAgentSession("pi-session-stale-rejection", calls, {
    onSteer: () => new Promise<void>((_resolve, reject) => {
      rejectSteer = reject;
    }),
  });
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  runtime.on("runtime_event", (event) => events.push(event));

  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.send({ mode: "busy", text: "late rejected steer" }), {
    ok: true,
    acceptedAs: "steer",
  });
  await new Promise((resolve) => setImmediate(resolve));

  await runtime.dispose();
  rejectSteer(new Error("stale steer rejection"));
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.some((event) => event.kind === "delivery_error"), false);
});

test("PiSdkRuntimeSession emits a closed-set provider diagnostic for a bodyless startup 403", async () => {
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const events: ParsedEvent[] = [];
  const workingDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-terminal-cause-"));
  const unsafeProviderError = Object.assign(
    new Error("403 status code (no body); Bearer sk-unsafe-token https://gateway.example/private"),
    {
      body: "unsafe response body",
      headers: { authorization: "Bearer sk-unsafe-header" },
      token: "sk-unsafe-property",
      url: "https://gateway.example/private",
      payload: { prompt: "unsafe prompt" },
    },
  );
  const fake = createFakeAgentSession("builtin-session-403", [], {
    promptError: unsafeProviderError,
  });
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext({
      runtime: "builtin",
      runtimeConfig: {
        version: RUNTIME_CONFIG_VERSION,
        runtime: "builtin",
        provider: { kind: "preset", providerId: "deepseek", apiKey: "preset-deepseek-key" },
        hostUserState: "forbidden",
        model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
        mode: { kind: "default" },
      },
    }, {
      tracer,
      workingDirectory,
      agentId: "agent-terminal-cause",
      launchId: "launch-terminal-cause",
      processInstanceId: "process-terminal-cause",
    }),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  let provenanceVisibleBeforeTerminalError = false;
  runtime.on("runtime_event", (event) => {
    if (event.kind === "error") {
      provenanceVisibleBeforeTerminalError = sink.getTrace(traceId)
        .flatMap((span) => span.events ?? [])
        .some((traceEvent) => traceEvent.name === "daemon.pi.provider_request.failed");
    }
    events.push(event);
  });

  assert.deepEqual(await runtime.start({ text: "startup prompt" }), {
    ok: true,
    acceptedAs: "prompt",
  });
  await waitForState(
    () => sink.getTrace(traceId).some((span) => span.name === "daemon.pi.prompt" && span.status === "error"),
    "daemon.pi.prompt error span recorded",
    { timeoutMs: 500, pollIntervalMs: 10 },
  );

  const failureEvents = sink.getTrace(traceId)
    .filter((span) => span.name === "daemon.pi.prompt")
    .flatMap((span) => span.events ?? [])
    .filter((event) => event.name === "daemon.pi.provider_request.failed");
  assert.equal(failureEvents.length, 1);
  assert.deepEqual(failureEvents[0]?.attrs, {
    phase: "prompt_request",
    response_started: true,
    reason: "provider_auth_denied",
    http_status: 403,
    session_id_present: true,
    runtime_session_id: "builtin-session-403",
    launch_id_present: true,
    launch_id: "launch-terminal-cause",
  });
  assert.equal(provenanceVisibleBeforeTerminalError, true);
  assert.ok(events.some(
    (event) => event.kind === "error" && event.message === unsafeProviderError.message,
  ), "typed tracing must not change the existing runtime error delivery");
  assert.doesNotMatch(
    JSON.stringify(failureEvents[0]?.attrs),
    /sk-unsafe|unsafe response|unsafe-header|unsafe-property|gateway\.example|private|payload/iu,
  );

  const causePath = path.join(
    workingDirectory,
    ".slock",
    "runtime-sessions",
    "builtin-builtin-session-403.jsonl",
  );
  assert.equal(existsSync(causePath), true, "terminal cause must be persisted before APM emits terminal error status");
  const cause = readFileSync(causePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find((record) => record.type === "runtime_terminal_cause");
  assert.ok(cause, "runtime_terminal_cause record must be present in the local handoff artifact");
  assert.equal(cause.runtime, "builtin");
  assert.equal(cause.agentId, "agent-terminal-cause");
  assert.equal(cause.sessionId, "builtin-session-403");
  assert.equal(cause.launchId, "launch-terminal-cause");
  assert.equal(cause.processInstanceId, "process-terminal-cause");
  assert.equal(cause.providerId, "deepseek");
  assert.equal(cause.modelId, "deepseek/deepseek-v4-pro");
  assert.equal(cause.phase, "prompt_request");
  assert.equal(cause.errorClass, "RuntimeError");
  assert.match(cause.joinKey, /agent-terminal-cause:launch-terminal-cause:process-terminal-cause:builtin-session-403$/);
  assert.doesNotMatch(
    JSON.stringify(cause),
    /sk-unsafe|unsafe response body|unsafe-header|unsafe-property|unsafe prompt/iu,
  );

  const resolvedRef = resolveRuntimeSessionRef("builtin", "builtin-session-403", mkdtempSync(path.join(os.tmpdir(), "pi-home-")), workingDirectory, {
    agentId: "agent-terminal-cause",
    workingDirectory,
    launchId: "launch-terminal-cause",
    processInstanceId: "process-terminal-cause",
  });
  assert.equal(resolvedRef.path, causePath);
  const recordsAfterResolve = readFileSync(causePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(
    recordsAfterResolve.filter((record) => record.type === "runtime_terminal_cause").length,
    1,
    "fallback handoff append must not clobber the terminal cause record",
  );
  assert.equal(
    recordsAfterResolve.some((record) => record.type === "runtime_session_handoff"),
    true,
    "feedback transcript fallback still records the native-transcript miss",
  );
});

test("PiSdkRuntimeSession classifies the real message_end string channel for pre-response and response-started transport failures", async () => {
  async function runFailure(responseStarted: boolean) {
    const { sink, tracer, traceId } = makeDeterministicTracer();
    const workingDirectory = mkdtempSync(path.join(os.tmpdir(), "pi-provider-phase-"));
    const promptEvents = [
      ...(responseStarted
        ? [{
          type: "message_start",
          message: { role: "assistant" },
        } as unknown as AgentSessionEvent]
        : []),
      {
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: "error",
          // Pi's OpenAI provider normalizes a socket close after response
          // headers/chunks to this plain string before AgentSession publishes
          // message_end. The pre-response adapter likewise publishes a string,
          // not the original structured SDK error object.
          errorMessage: responseStarted ? "terminated" : "Connection error.",
        },
      } as unknown as AgentSessionEvent,
    ];
    const fake = createFakeAgentSession(`phase-session-${responseStarted}`, [], {
      promptEvents,
    });
    const runtime = new PiSdkRuntimeSession(
      makeSpawnContext({}, {
        tracer,
        workingDirectory,
        launchId: `phase-launch-${responseStarted}`,
      }),
      () => undefined,
      async () => fake as unknown as AgentSession,
    );

    try {
      assert.deepEqual(await runtime.start({ text: "phase proof" }), {
        ok: true,
        acceptedAs: "prompt",
      });
      await waitForState(
        () => sink.getTrace(traceId).some((span) => span.name === "daemon.pi.prompt" && span.status === "error"),
        "daemon.pi.prompt error span recorded",
        { timeoutMs: 500, pollIntervalMs: 10 },
      );
      return sink.getTrace(traceId)
        .flatMap((span) => span.events ?? [])
        .find((event) => event.name === "daemon.pi.provider_request.failed")?.attrs;
    } finally {
      await runtime.dispose();
      rmSync(workingDirectory, { recursive: true, force: true });
    }
  }

  const preResponse = await runFailure(false);
  const responseStarted = await runFailure(true);

  assert.equal(preResponse?.phase, "prompt_request");
  assert.equal(preResponse?.response_started, false);
  assert.equal(preResponse?.reason, "pre_response_transport_error");
  assert.equal(preResponse?.runtime_session_id, "phase-session-false");
  assert.equal(preResponse?.launch_id, "phase-launch-false");
  assert.equal(responseStarted?.phase, "prompt_request");
  assert.equal(responseStarted?.response_started, true);
  assert.equal(responseStarted?.reason, "stream_read_error");
  assert.equal(responseStarted?.runtime_session_id, "phase-session-true");
  assert.equal(responseStarted?.launch_id, "phase-launch-true");
  assert.doesNotMatch(
    JSON.stringify([preResponse, responseStarted]),
    /connection|terminated|token|url|message/iu,
  );
});

test("PiSdkRuntimeSession does not invoke deferred SDK calls after close", async () => {
  const busyCalls: string[] = [];
  const busyRuntime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => createFakeAgentSession("pi-session-busy", busyCalls) as unknown as AgentSession,
  );
  assert.deepEqual(await busyRuntime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(busyRuntime.send({ mode: "busy", text: "steer after close" }), {
    ok: true,
    acceptedAs: "steer",
  });
  await busyRuntime.stop({ signal: "SIGTERM", reason: "close-before-steer" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(busyCalls.includes("steer:steer after close"), false);

  const idleCalls: string[] = [];
  const idleRuntime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => createFakeAgentSession("pi-session-idle", idleCalls) as unknown as AgentSession,
  );
  assert.deepEqual(await idleRuntime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(idleRuntime.send({ mode: "idle", text: "prompt after close" }), {
    ok: true,
    acceptedAs: "prompt",
  });
  await idleRuntime.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(idleCalls.includes("prompt:prompt after close:subscribers=1"), false);
});

type PiExtensionModelFixture = {
  root: string;
  agentDir: string;
  provider: string;
  model: string;
  modelId: string;
};

function createPiExtensionModelFixture(registerCleanup?: (fn: () => void) => void): PiExtensionModelFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-extension-models-"));
  const agentDir = path.join(root, "agent");
  const extensionDir = path.join(root, "task349-pi-extension-provider");
  const provider = "task349";
  const model = "local-extension-model";
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
    packages: [extensionDir],
  }, null, 2), "utf8");
  writeFileSync(path.join(extensionDir, "package.json"), JSON.stringify({
    name: "task349-pi-extension-provider",
    private: true,
    version: "1.0.0",
    type: "module",
    pi: {
      extensions: ["./index.ts"],
    },
  }, null, 2), "utf8");
  writeFileSync(path.join(extensionDir, "index.ts"), `
export default function(pi) {
  pi.registerProvider("${provider}", {
    name: "Task349",
    baseUrl: "https://task349.invalid/v1",
    apiKey: "$TASK349_PI_API_KEY",
    api: "openai-responses",
    models: [{
      id: "${model}",
      name: "Task 349 Extension Model",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000,
      maxTokens: 4096
    }]
  });
}
`, "utf8");

  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    agentDir,
    provider,
    model,
    modelId: `${provider}/${model}`,
  };
}

const PI_BUILTIN_PROVIDER_ENV_KEYS = [
  ...BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS,
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "CLOUDFLARE_ACCOUNT_ID",
  "AWS_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
] as const;

async function withPiExtensionEnv<T>(fixture: PiExtensionModelFixture, fn: () => Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousApiKey = process.env.TASK349_PI_API_KEY;
  const previousBuiltins: Record<string, string | undefined> = {};
  for (const key of PI_BUILTIN_PROVIDER_ENV_KEYS) {
    previousBuiltins[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  process.env.TASK349_PI_API_KEY = "task349-test-key";
  try {
    return await fn();
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    restoreEnv("TASK349_PI_API_KEY", previousApiKey);
    for (const key of PI_BUILTIN_PROVIDER_ENV_KEYS) {
      restoreEnv(key, previousBuiltins[key]);
    }
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function isThenable(value: unknown): boolean {
  return Boolean(value && typeof (value as { then?: unknown }).then === "function");
}


function createFakeAgentSession(sessionId: string, calls: string[], options?: { promptError?: Error; promptEvents?: AgentSessionEvent[]; steerError?: Error; onPrompt?: () => void | Promise<void>; onSteer?: () => void | Promise<void> }) {
  let listener: ((event: AgentSessionEvent) => void) | null = null;
  let streaming = false;
  return {
    sessionId,
    get isStreaming() {
      return streaming;
    },
    subscribe(cb: (event: AgentSessionEvent) => void) {
      calls.push("subscribe");
      listener = cb;
      return () => {
        calls.push("unsubscribe");
        listener = null;
      };
    },
    async prompt(text: string) {
      await options?.onPrompt?.();
      calls.push(`prompt:${text}:subscribers=${listener ? 1 : 0}`);
      for (const event of options?.promptEvents ?? []) listener?.(event);
      if (options?.promptError) throw options.promptError;
      listener?.({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent);
      listener?.({ type: "agent_settled" } as unknown as AgentSessionEvent);
    },
    async steer(text: string) {
      await options?.onSteer?.();
      calls.push(`steer:${text}`);
      if (options?.steerError) throw options.steerError;
    },
    async abort() {
      calls.push("abort");
      streaming = false;
    },
    dispose() {
      calls.push("dispose");
    },
    __setStreaming(value: boolean) {
      streaming = value;
    },
  };
}

/**
 * Fail (rather than hang) if `promise` does not settle in time. A cross-agent
 * serialization regression would otherwise deadlock the concurrency test instead
 * of producing a readable red.
 */
async function assertSettlesWithin(promise: Promise<unknown>, ms: number, failMessage: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(failMessage)), ms);
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function piBuiltinRuntimeConfig(apiKey: string) {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "pi",
    provider: { kind: "pi-builtin", providerId: "deepseek", apiKey },
    model: { kind: "preset", id: "deepseek/deepseek-v4-pro" },
    mode: { kind: "default" },
  } as unknown as Parameters<typeof seedPiSessionModelRuntime>[1];
}

// task #510 acceptance #2 — three-way credential isolation (host / agent A / agent B).
test("pi-builtin credentials stay session-local across host, agent A and agent B", async () => {
  const key = "DEEPSEEK_API_KEY";
  const previous = process.env[key];
  process.env[key] = "host-key-must-never-win";

  try {
    const credentialsA = new InMemoryCredentialStore();
    const credentialsB = new InMemoryCredentialStore();
    const runtimeA = await ModelRuntime.create({ credentials: credentialsA, modelsPath: null, allowModelNetwork: false });
    const runtimeB = await ModelRuntime.create({ credentials: credentialsB, modelsPath: null, allowModelNetwork: false });
    await seedPiSessionModelRuntime(runtimeA, piBuiltinRuntimeConfig("agent-a-key"));
    await seedPiSessionModelRuntime(runtimeB, piBuiltinRuntimeConfig("agent-b-key"));

    // Each agent's session resolves its OWN runtime key...
    assert.equal((await runtimeA.getAuth("deepseek"))?.auth.apiKey, "agent-a-key");
    assert.equal((await runtimeB.getAuth("deepseek"))?.auth.apiKey, "agent-b-key");

    // ...the runtime override beats the host env key for both...
    assert.notEqual((await runtimeA.getAuth("deepseek"))?.auth.apiKey, "host-key-must-never-win");
    assert.notEqual((await runtimeB.getAuth("deepseek"))?.auth.apiKey, "host-key-must-never-win");
    assert.deepEqual(runtimeA.getProviderAuthStatus("deepseek"), { configured: true, source: "runtime" });
    assert.deepEqual(runtimeB.getProviderAuthStatus("deepseek"), { configured: true, source: "runtime" });

    // ...and seeding one agent never mutates the other's storage (no cross-agent bleed).
    await seedPiSessionModelRuntime(runtimeA, piBuiltinRuntimeConfig("agent-a-key-rotated"));
    assert.equal((await runtimeA.getAuth("deepseek"))?.auth.apiKey, "agent-a-key-rotated");
    assert.equal(
      (await runtimeB.getAuth("deepseek"))?.auth.apiKey,
      "agent-b-key",
      "agent B must not observe agent A's credential",
    );

    // The runtime override must not persist into the backing credential store.
    assert.equal(await credentialsA.read("deepseek"), undefined);
    assert.equal(await credentialsB.read("deepseek"), undefined);

    // The host process env is never patched. Patching it is what forced the
    // process-global lock that serialized every agent's prompt (task #510).
    assert.equal(process.env[key], "host-key-must-never-win");
    assert.equal(
      buildPiSessionCreateEnvPatch(piBuiltinRuntimeConfig("agent-a-key"), { [key]: "should-be-stripped" })?.[key],
      undefined,
      "provider key must not ride in the session-create env patch",
    );
  } finally {
    restoreEnv(key, previous);
  }
});

// task #510 acceptance #3 — concurrency + observability.
test("concurrent pi agents do not queue behind each other, and spans prove it", async () => {
  const AGENTS = 3;
  const { sink, tracer, traceId } = makeDeterministicTracer();

  const entered: number[] = [];
  const inFlightSeen: number[] = [];
  let markAllEntered!: () => void;
  const allEntered = new Promise<void>((resolve) => {
    markAllEntered = resolve;
  });

  const runtimes = Array.from({ length: AGENTS }, (_unused, index) => {
    const fake = createFakeAgentSession(`pi-session-${index}`, [], {
      onPrompt: async () => {
        entered.push(index);
        inFlightSeen.push(__piPromptsInFlightForTest());
        if (entered.length === AGENTS) markAllEntered();
        // Hold this turn open until EVERY agent has entered its prompt. Under the
        // old process.env-patch lock, agent 0 would hold the process-global lock
        // here while agents 1..N-1 could never enter — a deadlock, which is the
        // 60-165s cross-agent queue users hit, in miniature.
        await allEntered;
      },
    });
    return new PiSdkRuntimeSession(
      makeSpawnContext({
        model: "deepseek/deepseek-v4-pro",
        runtimeConfig: piBuiltinRuntimeConfig(`agent-${index}-key`) as never,
      }, { tracer, agentId: `agent-${index}` }),
      () => undefined,
      async () => fake as unknown as AgentSession,
    );
  });

  try {
    for (const [index, runtime] of runtimes.entries()) {
      assert.deepEqual(
        await runtime.start({ text: `prompt-${index}` }),
        { ok: true, acceptedAs: "prompt" },
      );
    }

    // RED on the pre-fix head: prompts serialize, so they never all enter.
    await assertSettlesWithin(
      allEntered,
      2_000,
      "pi prompts are still serialized across agents (cross-agent queue present)",
    );

    assert.equal(entered.length, AGENTS);
    assert.ok(
      Math.max(...inFlightSeen) > 1,
      `expected concurrent pi prompts in flight, peak was ${Math.max(...inFlightSeen)}`,
    );
  } finally {
    markAllEntered();
  }

  // Let the prompts finish so their spans end and reach the sink.
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Observability. NOTE: read events across ALL prompt spans — `eventsForSpan`
  // resolves a single span by name, so with one span per agent it would only ever
  // show agent 0's event (prompts_in_flight = 1) and hide the very concurrency we
  // are proving.
  const promptSpans = sink.getTrace(traceId).filter((span) => span.name === "daemon.pi.prompt");
  assert.equal(promptSpans.length, AGENTS, "one daemon.pi.prompt span per agent prompt");
  const startEvents = promptSpans
    .flatMap((span) => span.events ?? [])
    .filter((event) => event.name === "daemon.pi.prompt.start");
  assert.ok(startEvents.length >= 1, "daemon.pi.prompt.start must be emitted");
  assert.ok(
    startEvents.some((event) => Number(event.attrs?.prompts_in_flight) > 1),
    "a prompt.start event must observe >1 prompts_in_flight (cross-agent queue is gone)",
  );
  assert.ok(
    startEvents.every((event) => typeof event.attrs?.queued_ms === "number"),
    "prompt.start must carry queued_ms (the queued -> prompt-start wait users saw as the stall)",
  );
  assert.ok(
    promptSpans.every((span) => typeof span.attrs?.duration_ms === "number"),
    "each prompt span must carry duration_ms",
  );
});
