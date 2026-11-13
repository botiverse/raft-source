import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { BUILTIN_RUNTIME_HOST_PROVIDER_ENV_SCRUB_KEYS, eventsForSpan, PI_BUILTIN_PROVIDER_CONNECTION_PROBES, providerRequestId, RUNTIME_CONFIG_VERSION } from "@botiverse/raft-shared";
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
  configureBuiltInGatewayCustomModel,
  createPiAgentSessionForContext,
  findAnthropicGatewayThinkingContract,
  resolveBuiltInThinkingLevel,
  type AnthropicGatewayThinkingContract,
  createPiSdkEventMappingState,
  detectPiModels,
  detectPiModelsFromRegistry,
  mapPiSdkEventToParsedEvents,
  projectPiCompactionInputTelemetry,
  resolveBuiltInGatewayModelInput,
  resolveBuiltInGatewayLaunch,
  resolvePiModelFromRegistry,
  safeDiagnosticErrorClass,
  safeDiagnosticErrorCode,
  seedPiSessionModelRuntime,
  assertProviderApiKeyIsHeaderSafe,
  withProcessEnvPatch,
  __piPromptsInFlightForTest,
} from "./pi";
import { piSessionMemoryAttrs } from "./piSessionMemory";
import { waitForState } from "../testing/drydock";
import type { ProviderRequestObserver } from "../providerRequestFetch";
import {
  ModelRegistry,
  ModelRuntime,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, clampThinkingLevel, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import { streamSimple as streamSimpleOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { streamSimple as streamSimpleAnthropicMessages } from "@earendil-works/pi-ai/api/anthropic-messages";
import { getGlobalDispatcher } from "undici";
import net from "node:net";
import { resolveRuntimeSessionRef, writeRuntimeLifecycleDiagnosticRecord } from "./runtimeArtifacts";
import type { ParsedEvent, SpawnContext } from "./types";
import { traceRows } from "../testing/traceRows";
import { makeDeterministicTracer } from "../testing/deterministicTracer";
import { answerGatewayModelListRead } from "../testing/gatewayModelListProbe";
import { installDaemonFetchMockForTests } from "../daemonFetch";

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
      customModelProviderIds: ["openrouter"],
    });
    assert.equal(detected.value.models.some((model) => model.id === "deepseek/deepseek-v4-pro" && model.verified === "launchable"), true);
    // 0.86.0 renamed this entry: deepseek-v4-flash -> deepseek-flash ("DeepSeek V4.1 Flash").
    assert.equal(detected.value.models.some((model) => model.id === "deepseek/deepseek-flash" && model.verified === "launchable"), true);
    assert.equal(detected.value.models.some((model) => model.id === "openai/gpt-5.4" && model.verified === "launchable"), true);
    assert.equal(detected.value.models.some((model) => model.id === "moonshotai-cn/kimi-k2.7-code" && model.verified === "launchable"), true);
    // 1.4.0 dropped the MiMo V2.5 ids; V2.6-Pro is the provider default now.
    assert.equal(detected.value.models.some((model) => model.id === "xiaomi/mimo-v2.6-pro" && model.verified === "launchable"), true);
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
    const traceSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.pi.session.create");
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

test("a live Pi session counts in the memory event until it is disposed", async () => {
  const fixture = createPiExtensionModelFixture(onTestFinished);
  const before = piSessionMemoryAttrs(Date.now()).pi_session_count ?? 0;

  const session = await withPiExtensionEnv(fixture, () =>
    createPiAgentSessionForContext(makeSpawnContext({ model: fixture.modelId }), "pi-memory-session"));
  try {
    const attrs = piSessionMemoryAttrs(Date.now());
    assert.equal(attrs.pi_session_count, before + 1);
    assert.equal(typeof attrs.pi_session_entry_count, "number");
    assert.ok((attrs.pi_oldest_session_age_ms ?? -1) >= 0, "age comes from the session header");
  } finally {
    session.dispose();
  }
  assert.equal(piSessionMemoryAttrs(Date.now()).pi_session_count ?? 0, before);
});

test("createPiAgentSessionForContext persists an early startup failure without a native transcript", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-startup-failure-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });

  try {
    await assert.rejects(
      createPiAgentSessionForContext(
        makeSpawnContext(
          {
            runtime: "builtin",
            model: "definitely-missing-model",
            runtimeConfig: {
              version: RUNTIME_CONFIG_VERSION,
              runtime: "builtin",
              provider: {
                kind: "preset",
                providerId: "qwen-token-plan-cn",
                apiKey: "sk-startup-failure-test",
              },
              hostUserState: "forbidden",
              model: { kind: "preset", id: "definitely-missing-model" },
              mode: { kind: "default" },
              envVars: null,
            },
          },
          { workingDirectory, launchId: "startup-failure-launch" },
        ),
        "builtin-startup-failure",
        {
          agentDir: path.join(root, "agent"),
          sessionDir: path.join(root, "sessions"),
          isolateHostProviderEnv: true,
        },
      ),
    );

    const records = readFileSync(
      path.join(
        workingDirectory,
        ".slock",
        "runtime-sessions",
        "builtin-builtin-startup-failure.jsonl",
      ),
      "utf8",
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      records
        .filter((record) => record.type === "runtime_lifecycle")
        .map((record) => [record.event?.kind, record.event?.phase]),
      [
        ["session_start", "started"],
        ["model_resolved", undefined],
        ["session_start", "failed"],
      ],
    );
    assert.equal(
      records.at(-1)?.event?.errorClass,
      "RuntimeModelNotFoundError",
    );
    assert.doesNotMatch(
      JSON.stringify(records),
      /standing instructions|wake prompt|agent-token/iu,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing Pi model is reported for the pi runtime, not as Built-in", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pi-missing-model-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  try {
    await assert.rejects(
      createPiAgentSessionForContext(
        makeSpawnContext({ runtime: "pi", model: "deepseek/deepseek-v4-flash" }, { workingDirectory, launchId: "pi-missing-model-launch" }),
        "pi-missing-model",
        { agentDir: path.join(root, "agent"), sessionDir: path.join(root, "sessions"), isolateHostProviderEnv: true },
      ),
      (error: unknown) => {
        const typed = error as { code?: string; runtimeId?: string; model?: string };
        assert.equal(typed.code, "model_not_found");
        assert.equal(typed.runtimeId, "pi");
        assert.equal(typed.model, "deepseek/deepseek-v4-flash");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
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
    normalizeContext({ messages }),
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
    normalizeContext({ messages }),
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
        normalizeContext({
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "inspect this" },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
            timestamp: 1,
          }],
        }),
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

      const traceSpan = traceRows(sink, traceId).find((span) => span.name === "daemon.builtin.session.create");
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
        session.sessionManager.appendMessage({
          role: "user",
          content: "persist lifecycle proof",
          timestamp: Date.now(),
        });
        session.sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: "openai-completions",
          provider: "openai",
          model: "gateway-e2e-model",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        });
        const lifecyclePath = path.join(
          workingDirectory,
          ".slock",
          "runtime-sessions",
          "builtin-builtin-gateway-session.jsonl",
        );
        const lifecycleRecords = readFileSync(lifecyclePath, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const resolved = lifecycleRecords.find(
          (record) =>
            record.type === "runtime_lifecycle" &&
            record.event?.kind === "model_resolved",
        );
        assert.deepEqual(resolved?.event, {
          kind: "model_resolved",
          requestedModel: "gateway-e2e-model",
          providerId: "openai",
          modelId: "gateway-e2e-model",
          modelApi: "openai-completions",
          configSource: "agent_config",
        });
        assert.deepEqual(
          lifecycleRecords
            .filter(
              (record) =>
                record.type === "runtime_lifecycle" &&
                (record.event?.kind === "session_start" ||
                  record.event?.kind === "model_resolved"),
            )
            .map((record) => [record.event?.kind, record.event?.phase]),
          [
            ["session_start", "started"],
            ["model_resolved", undefined],
            ["session_start", "ready"],
          ],
        );
        assert.ok(
          lifecycleRecords.some(
            (record) =>
              record.event?.kind === "transcript_persist" &&
              record.event?.outcome === "deferred",
          ),
        );
        assert.ok(
          lifecycleRecords.some(
            (record) =>
              record.event?.kind === "transcript_persist" &&
              record.event?.outcome === "persisted",
          ),
        );
        assert.doesNotMatch(
          JSON.stringify(lifecycleRecords),
          /sk-gateway-test|host-openai-should-not-win|127\.0\.0\.1|persist lifecycle proof/iu,
        );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Built-in records a transcript persistence failure outside the transcript", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "builtin-persist-failure-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  let session: AgentSession | undefined;

  try {
    session = await createPiAgentSessionForContext(
      makeSpawnContext(
        {
          runtime: "builtin",
          model: "persist-failure-model",
          runtimeConfig: {
            version: RUNTIME_CONFIG_VERSION,
            runtime: "builtin",
            provider: {
              kind: "gateway",
              providerId: "openai-compatible",
              baseUrl: "http://127.0.0.1:8787/v1",
              apiKey: "sk-persist-failure-test",
            },
            hostUserState: "forbidden",
            model: { kind: "custom", name: "persist-failure-model" },
            mode: { kind: "default" },
            envVars: null,
          },
        },
        { workingDirectory, launchId: "persist-failure-launch" },
      ),
      "builtin-persist-failure",
      {
        agentDir: path.join(root, "agent"),
        sessionDir: path.join(root, "sessions"),
        isolateHostProviderEnv: true,
      },
    );
    session.sessionManager.appendMessage({
      role: "user",
      content: "private transcript content",
      timestamp: Date.now(),
    });
    session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "private assistant content" }],
      api: "openai-completions",
      provider: "openai",
      model: "persist-failure-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    const transcriptPath = session.sessionManager.getSessionFile();
    assert.ok(transcriptPath);
    chmodSync(transcriptPath, 0o400);

    assert.throws(() =>
      session!.sessionManager.appendMessage({
        role: "user",
        content: "must not enter diagnostics",
        timestamp: Date.now(),
      }),
    );

    const diagnostics = readFileSync(
      path.join(
        workingDirectory,
        ".slock",
        "runtime-sessions",
        "builtin-builtin-persist-failure.jsonl",
      ),
      "utf8",
    );
    const failed = diagnostics
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find(
        (record) =>
          record.event?.kind === "transcript_persist" &&
          record.event?.outcome === "failed",
      );
    assert.deepEqual(
      {
        kind: failed?.event?.kind,
        outcome: failed?.event?.outcome,
        entryType: failed?.event?.entryType,
        errorCode: failed?.event?.errorCode,
      },
      {
        kind: "transcript_persist",
        outcome: "failed",
        entryType: "message",
        errorCode: "EACCES",
      },
    );
    assert.doesNotMatch(
      diagnostics,
      /private transcript content|private assistant content|must not enter diagnostics/iu,
    );
  } finally {
    session?.dispose();
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
      const traceSpan = traceRows(sink, traceId)
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
    if (answerGatewayModelListRead(req, res)) return;
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
    // pi 1.5.1 appends the transport detail ("terminated: other side closed (UND_ERR_SOCKET)")
    // to the same abort; the failure is still the terminated stream.
    assert.match(String(failedResult.errorMessage), /^terminated\b/u);
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
      if (answerGatewayModelListRead(req, res)) return;
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
  // The session reads the gateway's model list first (#proj-runtime:#53); this real host is not reached.
  const restoreFetch = installDaemonFetchMockForTests((async () => new Response("not found", { status: 404 })) as typeof fetch);

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
        normalizeContext({
          systemPrompt: "standing instructions",
          messages: [{ role: "user", content: "wake prompt", timestamp: 1 }],
        }),
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
    restoreFetch();
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
        normalizeContext({
          systemPrompt: "standing instructions",
          messages: [{ role: "user", content: "wake prompt", timestamp: 1 }],
        }),
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
        normalizeContext({
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "inspect this" },
              { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
            ],
            timestamp: 1,
          }],
        }),
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
    { kind: "tool_call", name: "bash", input: { command: "pwd" }, callId: "tool-1" },
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
      compaction: {
        outcome: "compaction_failed_or_exhausted", reason: "overflow", failureReason: "recovery_exhausted", willRetry: false,
        failureDiagnostic: {
          errorClass: "RuntimeError", errorReason: "unclassified_runtime_error",
          fingerprint: "f41d728e908b7992", reasonProvenance: "runtime_error_event",
        },
      },
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
        compaction: {
          outcome: "compaction_failed_or_exhausted", reason: "overflow", failureReason: "recovery_exhausted", willRetry: false,
          failureDiagnostic: {
            errorClass: "RuntimeError", errorReason: "unclassified_runtime_error",
            fingerprint: "ef9d078ca16bfdc2", reasonProvenance: "runtime_error_event",
          },
        },
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
      message: "RuntimeError: context compaction failed",
      terminalReason: "compaction_failed_or_exhausted",
      compaction: {
        outcome: "compaction_failed_or_exhausted", reason: "unknown", failureReason: "compaction_failed", willRetry: false,
        failureDiagnostic: {
          errorClass: "RuntimeError", errorReason: "unclassified_runtime_error",
          fingerprint: "224df98fdcdd429c", reasonProvenance: "runtime_error_event",
        },
      },
    },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /reviewer|secret|provider\.example|private/iu);
});

test("SDK event mapping pairs each compaction start with its own end by cycle id", () => {
  const state = createPiSdkEventMappingState();
  const map = (event: Record<string, unknown>) => mapPiSdkEventToParsedEvents(event as unknown as AgentSessionEvent, state, undefined)
    .filter((parsed) => parsed.kind.startsWith("compaction_"));
  const end = { type: "compaction_end", reason: "manual", result: { summary: "s" }, aborted: false, willRetry: false };
  assert.deepEqual(map({ type: "compaction_start", reason: "manual" }), [{ kind: "compaction_started", cycleId: 1 }]);
  assert.deepEqual(map(end), [{ kind: "compaction_finished", cycleId: 1 }]);
  // A repeated end has no open start, so it claims no cycle.
  assert.deepEqual(map(end), [{ kind: "compaction_finished" }]);
  assert.deepEqual(map({ type: "compaction_start", reason: "threshold" }), [{ kind: "compaction_started", cycleId: 2 }]);
  assert.deepEqual(map({ ...end, result: undefined, aborted: true }), [{ kind: "compaction_interrupted", cycleId: 2, outcome: "aborted", reason: "manual", willRetry: false }]);
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
      willRetry: false,
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
  assert.equal(events.filter((event) => event.kind === "compaction_interrupted").length, 0);
  assert.equal(events.find((event) => event.kind === "error")?.compaction?.failureReason, "recovery_exhausted");
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

// Task #1302: abort() waits for the run to go idle, so a tool that ignores the
// abort used to hang every stop, including the stalled-recovery SIGKILL
// escalation, and the agent never restarted.
test("PiSdkRuntimeSession SIGKILL stop ends the session even when abort never settles", async () => {
  const calls: string[] = [];
  const fake = createFakeAgentSession("pi-session-hung-abort", calls);
  (fake as unknown as { abort: () => Promise<void> }).abort = () => {
    calls.push("abort");
    return new Promise<void>(() => undefined);
  };
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(),
    () => undefined,
    async () => fake as unknown as AgentSession,
  );
  const closes: unknown[] = [];
  runtime.on("close", (info) => closes.push(info));
  await runtime.start({ text: "initial prompt" });
  await new Promise((resolve) => setImmediate(resolve));
  fake.__setStreaming(true);

  let gracefulSettled = false;
  void runtime.stop({ signal: "SIGTERM", reason: "stalled_recovery" }).then(() => { gracefulSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gracefulSettled, false, "a graceful stop still waits for abort");
  assert.deepEqual(closes, []);

  await runtime.stop({ signal: "SIGKILL", reason: "stalled_recovery_sigterm_timeout" });
  assert.equal(calls.includes("dispose"), true);
  assert.equal(closes.length, 1);
  assert.equal(runtime.closed, true);
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
    // --- POSITIVE CONTROL: real 1.5.2 OAuth flow, real fetch, pointed at loopback -------------
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

test("kimi-coding preset uses OpenAI Chat Completions after the Pi 1.3.0 provider switch", { timeout: 10_000 }, async () => {
  // Pi 1.3.0 moved the kimi-coding provider from Anthropic Messages
  // (`https://api.kimi.com/coding`) to OpenAI Chat Completions
  // (`https://api.kimi.com/coding/v1`). Both halves matter for Built-in agents on
  // Kimi For Coding: the generated probe entry drives the picker / connection
  // probe, and the resolved catalog model drives the launch. Assert the entry,
  // then the resolved model, then the actual request shape against loopback.
  assert.deepEqual(PI_BUILTIN_PROVIDER_CONNECTION_PROBES["kimi-coding"], {
    api: "openai-completions",
    baseUrl: "https://api.kimi.com/coding/v1",
    headers: {},
  });

  const registry = await freshBuiltInModelRegistry();
  const runtimeConfig = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "preset", providerId: "kimi-coding", apiKey: "preset-kimi" },
    hostUserState: "forbidden",
    model: { kind: "preset", id: "kimi-coding/kimi-for-coding" },
    mode: { kind: "default" },
  } as const;
  const model = resolvePiModelFromRegistry("kimi-coding/kimi-for-coding", registry, runtimeConfig as never);
  assert.ok(model, "the kimi-coding preset model must resolve from the SDK catalog");
  assert.equal(model.api, "openai-completions", "kimi-coding must resolve to the Chat Completions api");
  assert.equal(model.baseUrl, "https://api.kimi.com/coding/v1", "kimi-coding must resolve to the /v1 base URL");

  // Pick the transport the resolved api selects, so a regression back to
  // anthropic-messages fails the wire assertions instead of being bypassed.
  const seen: Array<{ method?: string; url?: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, body, headers: req.headers });
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" }).end("data: [DONE]\n\n");
    });
  });
  const port = await listenOnLoopback(server);
  // The address comes from the catalog (asserted above); only the base URL is
  // swapped to loopback here so the wire shape is pinned without real egress.
  const loopbackModel = { ...model, baseUrl: `http://127.0.0.1:${port}/v1` };
  const context = normalizeContext({ messages: [{ role: "user", content: "ping", timestamp: 1 }] });
  try {
    const result = model.api === "openai-completions"
      ? await streamSimpleOpenAICompletions(
          loopbackModel as Model<"openai-completions">,
          context,
          { apiKey: "sk-kimi-coding-test" },
        ).result()
      : await streamSimpleAnthropicMessages(
          loopbackModel as Model<"anthropic-messages">,
          context,
          { apiKey: "sk-kimi-coding-test" },
        ).result();
    assert.ok(result.stopReason.length > 0, "the stream must settle");

    const request = seen.find((entry) => entry.method === "POST");
    assert.ok(request, "the provider must POST the completion");
    assert.equal(request.url, "/v1/chat/completions", "kimi-coding must POST to the Chat Completions path");
    assert.match(
      String(request.headers.authorization ?? ""),
      /^Bearer /u,
      "a Chat Completions bearer header must be sent",
    );
    assert.equal(request.headers["anthropic-version"], undefined, "the Anthropic Messages header must not come back");
    const payload = JSON.parse(request.body) as { model?: unknown; messages?: unknown };
    assert.equal(typeof payload.model, "string");
    assert.ok(Array.isArray(payload.messages), "a Chat Completions body carries a messages array");
  } finally {
    await closeServer(server);
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
  //   byte-identical. 0.85.1 -> 0.86.0 was re-verified the same way: the model-runtime.js
  //   diff is confined to `stream`/`streamSimple` gaining a `normalizeContext(context)`
  //   call before delegating to the provider (the TranscriptContext hardening). The
  //   `synchronizeCredentialState` body is byte-identical between the two versions and
  //   `allowNetwork: false` still appears exactly 4 times in each -- the seeding path is
  //   untouched, so the offline guarantee holds.
  //
  //   0.86.0 -> 0.86.1 was re-verified the same way and is stronger: `diff` of
  //   dist/core/model-runtime.js between the two packed artifacts is EMPTY (byte-identical), the
  //   `synchronizeCredentialState` body is byte-identical, and `allowNetwork: false` still appears
  //   exactly 4 times in each. The offline seeding guarantee is untouched.
  //
  //   0.86.1 -> 1.0.2 was re-verified the same way: `synchronizeCredentialState` and
  //   `refreshProviderAvailability` are byte-identical, and the credential sync still refreshes
  //   with `allowNetwork: false`. The other changes in model-runtime.js only add more
  //   `refresh({ allowNetwork: false })` calls (6 occurrences, up from 4); none of them enables the network.
  //
  //   1.0.2 -> 1.1.0 was re-verified the same way: the whole model-runtime.js diff is 2 lines
  //   (`classify` gains an `assertClassifierInputSupported(model, context)` guard), while
  //   `synchronizeCredentialState` and `refreshProviderAvailability` are byte-identical and
  //   `allowNetwork: false` still appears exactly 6 times in each. The seeding path is untouched.
  //
  //   1.1.0 -> 1.2.0 was re-verified the same way: the whole model-runtime.js diff is 17 lines
  //   and is confined to provider catalog construction -- `openrouter` is now wrapped with
  //   `withPersonalizedCatalog(provider, personalizeOpenRouterCatalog, ...)` (the new import from
  //   `@earendil-works/pi-ai/providers/openrouter`), with the builtin-provider loop refactored to
  //   match. `synchronizeCredentialState` and `refreshProviderAvailability` are byte-identical,
  //   and `allowNetwork: false` still appears exactly 6 times in each. The seeding path is
  //   untouched, so the offline guarantee holds.
  //
  //   1.2.0 -> 1.3.0 was re-verified and is the strongest form: `diff` of
  //   dist/core/model-runtime.js between the two packed artifacts is EMPTY (byte-identical), so
  //   `synchronizeCredentialState`, `refreshProviderAvailability` and every `allowNetwork: false`
  //   site (6 each) are unchanged. The 1.3.0 changes live elsewhere in the package (kimi-coding's
  //   Chat Completions move, catalog personalization), not on the credential/availability path.
  //
  //   1.3.0 -> 1.4.0 was re-verified the same way: the whole model-runtime.js diff is 9 lines and
  //   is confined to the outgoing-request header path -- `getOpenCodeSessionHeaders(requestModel,
  //   sessionId)` is now merged into the provider headers and `requestModel` is computed before
  //   the merge. `synchronizeCredentialState` and `refreshProviderAvailability` are
  //   byte-identical, and `allowNetwork: false` still appears exactly 6 times in each, so the
  //   seeding path is untouched and the offline guarantee holds.
  //
  //   1.4.0 -> 1.5.0 was re-verified and is the strongest form again: `diff` of
  //   dist/core/model-runtime.js between the two packed artifacts is EMPTY (byte-identical),
  //   so `synchronizeCredentialState`, `refreshProviderAvailability` and every
  //   `allowNetwork: false` site (6 each) are unchanged. 1.5.0's changes (pi-schema tool
  //   validation, the models.dev v2 catalog) live outside the credential/availability path.
  //
  //   1.5.1 -> 1.5.2 was re-verified and is the strongest form again: dist/core/model-runtime.js
  //   is byte-identical between the packed artifacts, so every credential/seeding site is
  //   unchanged (1.5.2 only touched session forking/import and an OAuth version string).
  //
  //   1.5.0 -> 1.5.1 was re-verified: the model-runtime.js diff is 15 lines -- a new
  //   additive `settleCredentialWrites()` and `options?.signal` threaded into four
  //   internal refreshes. `synchronizeCredentialState` and `refreshProviderAvailability`
  //   are byte-identical and `allowNetwork: false` still appears exactly 6 times in
  //   each, so the seeding path is untouched. (1.5.1 also turns Anthropic message
  //   threads on by default, which the daemon keeps, see #runtime-watch:#1.)
  //
  // Then update VERIFIED_AGAINST *and* the three sibling 0.8x.y labels below (the positive-control
  // comment, the "never triggers a remote model refresh (pi X)" test name, and its comment) --
  // otherwise they assert a version nobody re-checked.
  const VERIFIED_AGAINST = "1.5.2";
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

test("Pi auth seeding never triggers a remote model refresh (pi 1.5.2)", async () => {
  // Under 1.5.2 the offline guarantee lives inside the library: credential synchronization
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

test("#54 phase 3: PiSdkRuntimeSession reads Pi's context usage, compacts only an idle session, and reports a failure by class", async () => {
  const calls: string[] = [];
  const fake = createFakeAgentSession("pi-session-compact", calls);
  let compactError: Error | null = null;
  const session = Object.assign(fake, {
    isCompacting: false,
    getContextUsage: () => ({ tokens: 300_000, contextWindow: 1_000_000, percent: 30 }),
    async compact() {
      calls.push("compact");
      if (compactError) throw compactError;
      return {} as never;
    },
  });
  const runtime = new PiSdkRuntimeSession(makeSpawnContext(), () => undefined, async () => session as unknown as AgentSession);
  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await runtime.turnEndContextFacts(), { contextTokens: 300_000, windowTokens: 1_000_000 });
  fake.__setStreaming(true);
  assert.deepEqual(await runtime.compactAtTurnEnd(), { kind: "refused", reason: "busy" }, "compact() would abort the running turn");
  assert.equal(calls.includes("compact"), false);
  fake.__setStreaming(false);
  assert.deepEqual(await runtime.compactAtTurnEnd(), { kind: "completed" });
  compactError = new Error("Summarization failed: generation hit the token cap and the summary is incomplete");
  assert.deepEqual(await runtime.compactAtTurnEnd(), { kind: "failed", reason: "summary_incomplete" }, "a class, never the provider text");
  assert.equal(calls.filter((call) => call === "compact").length, 2);
});

test("#54 phase 3: cancelTurnEndCompaction aborts Pi's open compaction and resolves once the session takes prompts again", async () => {
  const calls: string[] = [];
  const fake = createFakeAgentSession("pi-session-cancel", calls);
  const session = Object.assign(fake, {
    isCompacting: false,
    abortCompaction() {
      calls.push("abortCompaction");
      // Pi clears its compaction controller once the aborted summary call unwinds.
      setTimeout(() => { session.isCompacting = false; }, 30);
    },
  });
  const runtime = new PiSdkRuntimeSession(makeSpawnContext(), () => undefined, async () => session as unknown as AgentSession);
  assert.deepEqual(await runtime.start({ text: "initial prompt" }), { ok: true, acceptedAs: "prompt" });
  await new Promise((resolve) => setImmediate(resolve));

  await runtime.cancelTurnEndCompaction();
  assert.equal(calls.includes("abortCompaction"), false, "nothing to cancel when no compaction is open");
  session.isCompacting = true;
  await runtime.cancelTurnEndCompaction();
  assert.equal(calls.filter((call) => call === "abortCompaction").length, 1);
  assert.equal(session.isCompacting, false, "resolves only once Pi would take a prompt again");
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

test("PiSdkRuntimeSession persists provider, compaction, and requested-stop order without a native transcript", async () => {
  const workingDirectory = mkdtempSync(
    path.join(os.tmpdir(), "pi-lifecycle-order-"),
  );
  const calls: string[] = [];
  const unsafeCompactionText =
    "context too large Bearer sk-unsafe https://provider.example/private";
  const fake = createFakeAgentSession("builtin-lifecycle-session", calls, {
    promptEvents: [
      {
        type: "compaction_start",
        reason: "overflow",
      } as unknown as AgentSessionEvent,
      {
        type: "compaction_end",
        reason: "overflow",
        errorMessage: unsafeCompactionText,
        willRetry: false,
      } as unknown as AgentSessionEvent,
    ],
  });
  let providerObserver: ProviderRequestObserver | undefined;
  const originalAbort = fake.abort.bind(fake);
  fake.abort = async () => {
    providerObserver?.({
      schemaVersion: 1,
      requestId: providerRequestId("11111111-1111-4111-8111-111111111111"),
      provider: "xai",
      phase: "cancelled",
      startedAt: "2026-09-18T03:33:00.000Z",
      observedAt: "2026-09-18T03:33:01.000Z",
    });
    await originalAbort();
  };
  const runtime = new PiSdkRuntimeSession(
    makeSpawnContext(
      { runtime: "builtin" },
      {
        workingDirectory,
        agentId: "agent-lifecycle",
        launchId: "launch-lifecycle",
        processInstanceId: "process-lifecycle",
      },
    ),
    () => undefined,
    async (_ctx, _sessionId, _toolObserver, observeProvider) => {
      providerObserver = observeProvider;
      observeProvider?.({
        schemaVersion: 1,
        requestId: providerRequestId("11111111-1111-4111-8111-111111111111"),
        provider: "xai",
        phase: "waiting",
        startedAt: "2026-09-18T03:33:00.000Z",
        observedAt: "2026-09-18T03:33:00.000Z",
      });
      return fake as unknown as AgentSession;
    },
  );

  try {
    assert.deepEqual(
      await runtime.start({
        text: "private prompt",
        sessionId: "builtin-lifecycle-session",
      }),
      {
        ok: true,
        acceptedAs: "prompt",
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    fake.__setStreaming(true);
    await runtime.stop({
      signal: "SIGTERM",
      reason: "operator stop with private detail",
    });

    const lifecyclePath = path.join(
      workingDirectory,
      ".slock",
      "runtime-sessions",
      "builtin-builtin-lifecycle-session.jsonl",
    );
    const resolvedRef = resolveRuntimeSessionRef(
      "builtin",
      "builtin-lifecycle-session",
      path.join(workingDirectory, "home"),
      workingDirectory,
      {
        agentId: "agent-lifecycle",
        workingDirectory,
        launchId: "launch-lifecycle",
        processInstanceId: "process-lifecycle",
      },
    );
    assert.equal(resolvedRef.path, lifecyclePath);
    const records = readFileSync(lifecyclePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const events = records
      .filter((record) => record.type === "runtime_lifecycle")
      .map((record) => record.event);
    assert.equal(
      records.filter((record) => record.type === "runtime_session_handoff").length,
      1,
      "fallback transcript resolution must append without clobbering lifecycle facts",
    );
    assert.deepEqual(
      events.map((event) => [
        event.kind,
        event.phase ?? event.outcome ?? event.source,
      ]),
      [
        ["provider_request", "waiting"],
        ["compaction", "started"],
        ["compaction", "failed"],
        ["cancel_requested", "requested_stop"],
        ["provider_request", "cancelled"],
      ],
    );
    assert.equal(events[2]?.failureReason, "compaction_failed");
    assert.equal(events[4]?.cancelSource, "requested_stop");
    assert.doesNotMatch(
      JSON.stringify(events),
      /private prompt|operator stop|sk-unsafe|provider\.example|Bearer/iu,
    );
  } finally {
    rmSync(workingDirectory, { recursive: true, force: true });
  }
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
      provenanceVisibleBeforeTerminalError = traceRows(sink, traceId)
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
    () => traceRows(sink, traceId).some((span) => span.name === "daemon.pi.prompt" && span.status === "error"),
    "daemon.pi.prompt error span recorded",
    { timeoutMs: 500, pollIntervalMs: 10 },
  );

  const failureEvents = traceRows(sink, traceId)
    .filter((span) => span.name === "daemon.pi.prompt")
    .flatMap((span) => span.events ?? [])
    .filter((event) => event.name === "daemon.pi.provider_request.failed");
  assert.equal(failureEvents.length, 1);
  assert.deepEqual(failureEvents[0]?.attrs, {
    phase: "prompt_request",
    response_started: true,
    reason: "provider_auth_denied",
    http_status: 403,
    // #424: one flag in the same family as the value, and no raw id — the sink
    // drops the raw one and it has no hash form. The deepEqual is the point:
    // it fails if the raw id comes back, not just if the flag goes missing.
    runtime_session_id_present: true,
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
        () => traceRows(sink, traceId).some((span) => span.name === "daemon.pi.prompt" && span.status === "error"),
        "daemon.pi.prompt error span recorded",
        { timeoutMs: 500, pollIntervalMs: 10 },
      );
      return traceRows(sink, traceId)
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
  assert.equal(preResponse?.runtime_session_id, undefined, "#424: the raw id is not emitted");
  assert.equal(preResponse?.runtime_session_id_present, true, "…and the fact is carried by the flag");
  assert.equal(preResponse?.launch_id, "phase-launch-false");
  assert.equal(responseStarted?.phase, "prompt_request");
  assert.equal(responseStarted?.response_started, true);
  assert.equal(responseStarted?.reason, "stream_read_error");
  assert.equal(responseStarted?.runtime_session_id, undefined);
  assert.equal(responseStarted?.runtime_session_id_present, true);
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
  const promptSpans = traceRows(sink, traceId).filter((span) => span.name === "daemon.pi.prompt");
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

test("Built-in loads enabled host directory and package extensions only while opted in", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "raft-builtin-local-plugins-"));
  const hostDir = path.join(root, "host");
  const workspace = path.join(root, "workspace");
  const packageDir = path.join(root, "plugin-package");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(path.join(hostDir, "extensions"), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(packageDir, { recursive: true });
  const extension = (name: string) => `import { writeFileSync } from "node:fs";
  export default function(pi) {
    pi.on("session_start", () => writeFileSync(${JSON.stringify(root)} + "/" + "${name}-started", "started"));
    pi.registerTool({ name: "${name}", label: "${name}", description: "Local plugin probe",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: "loaded" }], details: {} }; }
    });
  }`;
  writeFileSync(path.join(hostDir, "extensions", "probe.ts"), extension("host_probe"));
  writeFileSync(path.join(hostDir, "extensions", "disabled.ts"), extension("disabled_probe"));
  writeFileSync(path.join(packageDir, "index.ts"), extension("package_probe"));
  writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name: "probe", pi: { extensions: ["./index.ts"] } }));
  writeFileSync(path.join(hostDir, "settings.json"), JSON.stringify({
    packages: [packageDir], extensions: ["-extensions/disabled.ts"],
    defaultProvider: "host-provider", defaultModel: "host-model",
  }));
  process.env.PI_CODING_AGENT_DIR = hostDir;
  try {
    for (const loadLocalPlugins of [undefined, true, false]) {
      const session = await createPiAgentSessionForContext(makeSpawnContext({
        runtime: "builtin",
        runtimeConfig: {
          version: RUNTIME_CONFIG_VERSION, runtime: "builtin", hostUserState: "forbidden",
          ...(loadLocalPlugins !== undefined ? { loadLocalPlugins } : {}),
          provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "http://localhost:9876/v1", apiKey: "agent-key" },
          model: { kind: "custom", name: "agent-model" }, mode: { kind: "default" },
        },
      }, { workingDirectory: workspace }), `local-plugin-${String(loadLocalPlugins)}`, {
        agentDir: buildBuiltInAgentDir(workspace), sessionDir: buildBuiltInSessionDir(workspace),
        isolateHostProviderEnv: true, exposeLaunchEnvToTools: false,
      });
      try {
        const tools = session.getActiveToolNames();
        assert.equal(tools.includes("host_probe"), loadLocalPlugins === true);
        assert.equal(tools.includes("package_probe"), loadLocalPlugins === true);
        assert.equal(tools.includes("disabled_probe"), false);
        assert.equal(existsSync(path.join(root, "host_probe-started")), loadLocalPlugins === true);
        assert.equal(existsSync(path.join(root, "package_probe-started")), loadLocalPlugins === true);
        assert.equal(existsSync(path.join(root, "disabled_probe-started")), false);
        rmSync(path.join(root, "host_probe-started"), { force: true });
        rmSync(path.join(root, "package_probe-started"), { force: true });
        assert.equal(session.model?.id, "agent-model");
        assert.equal(session.model?.baseUrl, "http://localhost:9876/v1");
      } finally { session.dispose(); }
    }
  } finally {
    restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
    rmSync(root, { recursive: true, force: true });
  }
});

// task #1203/#1204: a managed-connection custom model named like a catalog model
// (kimi-k3 also exists as github-copilot/kimi-k3, listed first) resolved to the
// first same-name catalog entry, so the launch asked for Copilot credentials.
// Selection must use the same gateway provider the custom model is registered
// under, for direct gateways and managed connections alike.
async function freshBuiltInModelRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  return new ModelRegistry(runtime);
}

function builtInConnectionCustomConfig(name: string) {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
    hostUserState: "forbidden",
    model: { kind: "custom", name },
    mode: { kind: "default" },
  } as const;
}

for (const [providerId, registryProvider] of [
  ["openai-compatible", "openai"],
  ["anthropic-compatible", "anthropic"],
] as const) {
  test(`managed ${providerId} connection custom model selects its own gateway entry, not a same-name catalog model`, async () => {
    const registry = await freshBuiltInModelRegistry();
    // The first catalog entry is what a by-name fallback returns for its id, so
    // naming the custom model after it makes the collision real for both
    // gateway providers regardless of where they sit in catalog order.
    const colliding = registry.getAll()[0]!;
    assert.notEqual(colliding.provider, registryProvider, "fixture precondition: collision must come from another provider");
    const config = builtInConnectionCustomConfig(colliding.id);
    const projection = { providerId, endpointUrl: "https://gateway.example.test/v1", supportsImageInput: false } as const;
    configureBuiltInGatewayCustomModel(registry, config, projection);

    const model = resolvePiModelFromRegistry(colliding.id, registry, config, projection);
    assert.equal(model?.provider, registryProvider);
    assert.equal(model?.id, colliding.id);
  });
}

test("field case: managed openai-compatible connection kimi-k3 does not select github-copilot/kimi-k3", async () => {
  const registry = await freshBuiltInModelRegistry();
  assert.equal(registry.getAll().find((model) => model.id === "kimi-k3")?.provider, "github-copilot",
    "fixture precondition: the SDK catalog lists github-copilot/kimi-k3 first");
  const config = builtInConnectionCustomConfig("kimi-k3");
  const projection = { providerId: "openai-compatible", endpointUrl: "https://gateway.example.test/v1", supportsImageInput: false } as const;
  configureBuiltInGatewayCustomModel(registry, config, projection);

  const model = resolvePiModelFromRegistry("kimi-k3", registry, config, projection);
  assert.equal(model?.provider, "openai");
  assert.equal(model?.id, "kimi-k3");
});

test("managed connection custom model name containing a slash stays one gateway model id", async () => {
  const registry = await freshBuiltInModelRegistry();
  const config = builtInConnectionCustomConfig("moonshotai/kimi-k3");
  const projection = { providerId: "openai-compatible", endpointUrl: "https://gateway.example.test/v1", supportsImageInput: false } as const;
  configureBuiltInGatewayCustomModel(registry, config, projection);

  const model = resolvePiModelFromRegistry("moonshotai/kimi-k3", registry, config, projection);
  assert.equal(model?.provider, "openai");
  assert.equal(model?.id, "moonshotai/kimi-k3");
});

test("managed connection custom model that was not registered fails closed instead of falling back by name", async () => {
  const registry = await freshBuiltInModelRegistry();
  const config = builtInConnectionCustomConfig("kimi-k3");
  const projection = { providerId: "openai-compatible", endpointUrl: "https://gateway.example.test/v1", supportsImageInput: false } as const;

  assert.equal(resolvePiModelFromRegistry("kimi-k3", registry, config, projection), undefined);
});

test("direct gateway custom models and ordinary catalog presets keep resolving as before", async () => {
  const registry = await freshBuiltInModelRegistry();
  const gatewayConfig = {
    ...builtInConnectionCustomConfig("kimi-k3"),
    provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl: "https://gateway.example.test", apiKey: "gateway-test-key" },
  } as const;
  configureBuiltInGatewayCustomModel(registry, gatewayConfig, null);
  assert.equal(resolvePiModelFromRegistry("kimi-k3", registry, gatewayConfig, null)?.provider, "anthropic");

  const presetConfig = {
    ...builtInConnectionCustomConfig("unused"),
    model: { kind: "preset", id: "moonshotai/kimi-k3" },
  } as const;
  const preset = resolvePiModelFromRegistry("moonshotai/kimi-k3", registry, presetConfig, null);
  assert.equal(preset?.provider, "moonshotai");
  assert.equal(preset?.id, "kimi-k3");
});

test("Runtime lifecycle diagnostics stay bounded and keep appending after truncation", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "runtime-lifecycle-cap-"));
  try {
    const write = (phase: "started" | "ready") =>
      writeRuntimeLifecycleDiagnosticRecord({
        runtime: "builtin",
        sessionId: "cap-session",
        fallbackDir: root,
        agentId: "cap-agent",
        launchId: "cap-launch",
        processInstanceId: "cap-process",
        event: { kind: "session_start", phase },
      });
    const filePath = write("started")?.path;
    assert.ok(filePath);
    const cap = 4 * 1024 * 1024;
    // Fill the sidecar up to the cap with content that must not survive truncation.
    appendFileSync(filePath, `${"sk-cap-secret-filler".repeat(64)}\n`.repeat(Math.ceil(cap / 1281)));
    assert.ok(statSync(filePath).size > cap);

    assert.ok(write("ready"));
    assert.ok(write("started"));

    assert.ok(statSync(filePath).size < 4096);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    const text = readFileSync(filePath, "utf8");
    assert.doesNotMatch(text, /sk-cap-secret-filler/u);
    const records = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(
      records.map((record) => [record.type, record.event?.phase]),
      [
        ["runtime_lifecycle_history_truncated", undefined],
        ["runtime_lifecycle", "ready"],
        ["runtime_lifecycle", "started"],
      ],
    );
    assert.deepEqual(
      [...new Set(records.map((record) => record.joinKey))],
      ["runtime_lifecycle:cap-agent:cap-launch:cap-process:cap-session"],
    );
    assert.deepEqual(Object.keys(records[0]).sort(), [
      "agentId",
      "artifactVersion",
      "createdAt",
      "joinKey",
      "launchId",
      "processInstanceId",
      "runtime",
      "sessionId",
      "type",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime lifecycle diagnostics persist only known error classes; identifier-shaped unknown names become UnknownError", () => {
  // Known categories keep their class: the shared runtime taxonomy, the daemon's
  // own startup classes, and JS built-ins.
  assert.equal(safeDiagnosticErrorClass(Object.assign(new Error("x"), { name: "InputTooLargeError" })), "InputTooLargeError");
  assert.equal(safeDiagnosticErrorClass(Object.assign(new Error("x"), { name: "RuntimeModelNotFoundError" })), "RuntimeModelNotFoundError");
  assert.equal(safeDiagnosticErrorClass(new TypeError("x")), "TypeError");
  assert.equal(safeDiagnosticErrorClass(new Error("x")), "Error");

  // A name that satisfies the old identifier shape and length limit but carries a
  // synthetic sensitive marker must not be copied into the sidecar.
  const syntheticSecretName = "sk-ant-api03-SYNTHETIC_SECRET_MARKER.v1";
  assert.match(syntheticSecretName, /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u, "fixture must pass the old shape gate");
  assert.equal(safeDiagnosticErrorClass(Object.assign(new Error("x"), { name: syntheticSecretName })), "UnknownError");
  assert.equal(safeDiagnosticErrorClass(Object.assign(new Error("x"), { name: "VendorSpecificError" })), "UnknownError");

  // Non-Error throws and shapeless names never leak a value either.
  assert.equal(safeDiagnosticErrorClass("sk-synthetic-string-throw"), "UnknownError");
  assert.equal(safeDiagnosticErrorClass({ name: "InputTooLargeError" }), "UnknownError");
  assert.equal(safeDiagnosticErrorClass(Object.assign(new Error("x"), { name: "Error: token=sk-synthetic" })), "UnknownError");
});

test("Runtime lifecycle diagnostics persist only known error codes; identifier-shaped unknown codes are omitted", () => {
  // Supported transport and file-system codes are copied as-is.
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET" })), "ECONNRESET");
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" })), "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: "ENOENT" })), "ENOENT");
  assert.equal(safeDiagnosticErrorCode({ code: "ETIMEDOUT" }), "ETIMEDOUT");

  // A code that satisfies the old identifier shape but carries a synthetic
  // credential-shaped marker (AWS access key id style) must not be persisted.
  // Built at runtime so secret scanners don't flag this test sample.
  const syntheticKeyCode = "AK" + "IASYNTHETICKEY0001";
  assert.match(syntheticKeyCode, /^[A-Z][A-Z0-9_]{0,31}$/u, "fixture must pass the old shape gate");
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: syntheticKeyCode })), undefined);
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: "VENDOR_SPECIFIC_CODE" })), undefined);

  // Non-string, lowercase, non-object, and shapeless codes never leak a value either.
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: 42 })), undefined);
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: "econnreset" })), undefined);
  assert.equal(safeDiagnosticErrorCode("ECONNRESET"), undefined);
  assert.equal(safeDiagnosticErrorCode(Object.assign(new Error("x"), { code: "ECONNRESET token=sk-synthetic" })), undefined);
});

// jianghanfeng 2026-09-27: every DeepSeek V4.1 Flash agent on a shared provider
// connection failed with Node's "Cannot convert argument to a ByteString because
// the character at index 7 has a value of 27993" — index 7 is the first key
// character after "Bearer ", i.e. the configured key began with "浙".
test("a provider key that cannot go into an HTTP header is refused with a readable error before any request", async () => {
  const badKey = "浙江-deepseek-key";
  // The symptom this guards: Node refuses the header value itself.
  assert.throws(() => new Headers({ Authorization: `Bearer ${badKey}` }), /ByteString/);

  const config = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
    hostUserState: "forbidden",
    model: { kind: "preset", id: "deepseek/deepseek-flash" },
    mode: { kind: "default" },
  } as const;
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  await assert.rejects(
    seedPiSessionModelRuntime(
      runtime,
      config,
      { providerId: "deepseek", endpointUrl: null, supportsImageInput: false },
      { DEEPSEEK_API_KEY: badKey },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^DEEPSEEK_API_KEY contains a character that cannot be sent in an HTTP header \(position 1, code 27993\)/);
      assert.doesNotMatch(error.message, /deepseek-key/, "the key value must not be echoed");
      return true;
    },
  );
  assert.equal(await runtime.getAuth("deepseek"), undefined, "a rejected key must not be seeded");

  // Never newly refuse a key that some header form accepts: fetch trims edge
  // whitespace, so a trailing newline or space kept working and must still.
  const cases = [
    "sk-a", "sk-a\n", "sk-a\r", "sk-a\r\n", "\nsk-a", " sk-a", "sk-a ", "sk-a\t", "\tsk-a", "sk\ta", "sk-\u00e9",
    "sk-\na", "sk-\ra", "sk-\u0000a", "sk-a\u0000", "\u0000sk-a", "\u6d59sk", "sk-\u6d59",
  ];
  const headerFormThrows = (key: string) => [
    () => new Headers({ Authorization: `Bearer ${key}` }),
    () => new Headers({ "x-api-key": key }),
  ].map((build) => { try { build(); return false; } catch { return true; } });
  for (const key of cases) {
    let refused = false;
    try { assertProviderApiKeyIsHeaderSafe(key, "K"); } catch { refused = true; }
    if (refused) {
      assert.deepEqual(headerFormThrows(key), [true, true], `refused ${JSON.stringify(key)} although a header form accepts it`);
    }
  }
  for (const key of ["sk-a\n", "sk-a\r", " sk-a", "sk-a\t", "sk-\u00e9"]) {
    assert.doesNotThrow(() => assertProviderApiKeyIsHeaderSafe(key, "K"), JSON.stringify(key));
  }
  for (const key of ["sk-\na", "sk-\u0000a", "\u6d59sk"]) {
    assert.throws(() => assertProviderApiKeyIsHeaderSafe(key, "K"), JSON.stringify(key));
  }
  assert.throws(() => assertProviderApiKeyIsHeaderSafe("  \u6d59sk", "K"), /position 3, code 27993/);
});

test("task #365: a launch that turns stale while the pi factory prepares never creates the SDK session", async () => {
  const fixture = createPiExtensionModelFixture(onTestFinished);
  let stale = false;
  const refused = new Error("launch claimed against an earlier connection");
  const ctx = {
    ...makeSpawnContext({ model: fixture.modelId }, { launchId: "launch-stale" }),
    assertLaunchCurrent: () => { if (stale) throw refused; },
  };
  await withPiExtensionEnv(fixture, async () => {
    const pending = createPiAgentSessionForContext(ctx, "pi-stale-session");
    stale = true; // the connection changes while the factory awaits its preparation
    await assert.rejects(pending, (err) => err === refused);
  });
  // Positive control: the same context while current yields a session.
  stale = false;
  const session = await withPiExtensionEnv(fixture, () => createPiAgentSessionForContext(ctx, "pi-current-session"));
  try {
    assert.ok(session.sessionId);
  } finally {
    session.dispose();
  }
});

test("task #365: a launch that turns stale while pi waits for the env-patch lock never creates the SDK session", async () => {
  const fixture = createPiExtensionModelFixture(onTestFinished);
  let stale = false;
  const refused = new Error("launch claimed against an earlier connection");
  // A non-empty env patch: the session create runs under the process-wide env lock.
  const ctx = {
    ...makeSpawnContext({ model: fixture.modelId, envVars: { TASK365_ENV_PATCH: "1" } }, { launchId: "launch-lock" }),
    assertLaunchCurrent: () => { if (stale) throw refused; },
  };
  let holder: Promise<unknown> | null = null;
  const info = console.info;
  console.info = (...args: unknown[]) => {
    // Right after the services are ready, another env-patch user takes the
    // lock, so the session create below has to wait for it.
    if (holder === null && String(args[0]).includes("create_session services_ready")) {
      holder = withProcessEnvPatch({ TASK365_LOCK_HOLDER: "1" }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        stale = true; // the connection changes while the create waits for the lock
      });
    }
    return info.apply(console, args as []);
  };
  try {
    await withPiExtensionEnv(fixture, async () => {
      await assert.rejects(createPiAgentSessionForContext(ctx, "pi-lock-session"), (err) => err === refused);
    });
    assert.ok(holder, "the lock was held while the session create waited");
    await holder;
  } finally {
    console.info = info;
  }
});

// ---------------------------------------------------------------------------
// Built-in Pi × Anthropic-compatible gateway: exact-pair thinking contracts
// (MiniMax M3.1 report, 2026-10-13)
// ---------------------------------------------------------------------------

function anthropicGatewayConfig(baseUrl: string, name: string, reasoningEffort: string | null = null) {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "gateway", providerId: "anthropic-compatible", baseUrl, apiKey: "gateway-test-key" },
    hostUserState: "forbidden",
    model: { kind: "custom", name },
    mode: { kind: "default" },
    ...(reasoningEffort ? { reasoningEffort } : {}),
  } as const;
}

test("MiniMax-M3.1-Flash-Preview on its documented hosts registers the adaptive-thinking contract; nothing else inherits it", async () => {
  for (const baseUrl of ["https://api.minimax.cn/anthropic", "https://api.minimax.io/anthropic", "https://API.MINIMAX.CN/anthropic/"]) {
    const registry = await freshBuiltInModelRegistry();
    const config = anthropicGatewayConfig(baseUrl, "MiniMax-M3.1-Flash-Preview");
    configureBuiltInGatewayCustomModel(registry, config, null);
    const model = resolvePiModelFromRegistry("MiniMax-M3.1-Flash-Preview", registry, config, null) as Model<"anthropic-messages"> | undefined;
    assert.ok(model, baseUrl);
    assert.equal(model.compat?.forceAdaptiveThinking, true, baseUrl);
    assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" });
    assert.deepEqual(getSupportedThinkingLevels(model), ["minimal", "low", "medium", "high", "xhigh", "max"], "off is not selectable: the upstream rejects disabled");
    assert.equal(clampThinkingLevel(model, "max"), "max", "Max is not clamped down to high");
    assert.equal(clampThinkingLevel(model, "xhigh"), "xhigh");
  }

  // Controls: same id on an undocumented host, another id on a documented host, a different path, an unparsable URL.
  for (const [baseUrl, name] of [
    ["https://api.minimaxi.com/anthropic", "MiniMax-M3.1-Flash-Preview"],
    ["https://gateway.example.test/anthropic", "MiniMax-M3.1-Flash-Preview"],
    ["https://api.minimax.cn/anthropic", "MiniMax-M3"],
    ["https://api.minimax.cn/v1", "MiniMax-M3.1-Flash-Preview"],
    ["https://api.minimax.cn/anthropic", "minimax-m3.1-flash-preview"],
    ["not a url", "MiniMax-M3.1-Flash-Preview"],
  ] as const) {
    assert.equal(findAnthropicGatewayThinkingContract(baseUrl, name), undefined, `${baseUrl} ${name}`);
    const registry = await freshBuiltInModelRegistry();
    const config = anthropicGatewayConfig(baseUrl, name);
    configureBuiltInGatewayCustomModel(registry, config, null);
    const model = resolvePiModelFromRegistry(name, registry, config, null) as Model<"anthropic-messages"> | undefined;
    assert.ok(model, `${baseUrl} ${name}`);
    assert.equal(model.compat, undefined, `${baseUrl} ${name}: no contract inherited`);
    assert.equal(model.thinkingLevelMap, undefined, `${baseUrl} ${name}`);
    assert.equal(clampThinkingLevel(model, "max"), "high", `${baseUrl} ${name}: today's clamp stays`);
  }
});

test("an Anthropic-compatible gateway inherits the SDK catalog entry only for the exact endpoint + id pair", async () => {
  const registry = await freshBuiltInModelRegistry();
  const catalog = registry.getAll().find((model) => model.api === "anthropic-messages" && model.id === "MiniMax-M3" && model.provider === "minimax-cn");
  assert.ok(catalog, "fixture precondition: the SDK catalog knows minimax-cn/MiniMax-M3");
  const config = anthropicGatewayConfig(`${catalog.baseUrl}/`, "MiniMax-M3");
  configureBuiltInGatewayCustomModel(registry, config, null);
  const model = resolvePiModelFromRegistry("MiniMax-M3", registry, config, null);
  assert.equal(model?.provider, "anthropic", "registered under the gateway provider, not the catalog provider");
  assert.equal(model?.contextWindow, catalog.contextWindow);
  assert.equal(model?.maxTokens, catalog.maxTokens);
  assert.deepEqual(model?.input, catalog.input);

  const other = await freshBuiltInModelRegistry();
  const otherConfig = anthropicGatewayConfig("https://gateway.example.test/anthropic", "MiniMax-M3");
  configureBuiltInGatewayCustomModel(other, otherConfig, null);
  const unknown = resolvePiModelFromRegistry("MiniMax-M3", other, otherConfig, null);
  assert.equal(unknown?.contextWindow, 200_000, "an unknown endpoint keeps the gateway defaults");
  assert.equal(unknown?.compat, undefined);

  // A catalog preset (its own registry: registering a gateway model replaces
  // that provider's catalog entries, as it always did) is untouched by this change.
  const presetRegistry = await freshBuiltInModelRegistry();
  const presetConfig = { ...config, model: { kind: "preset", id: "anthropic/claude-fable-5" } } as any;
  const preset = resolvePiModelFromRegistry("anthropic/claude-fable-5", presetRegistry, presetConfig, null) as Model<"anthropic-messages"> | undefined;
  assert.equal(preset?.provider, "anthropic");
  assert.equal(preset?.compat?.forceAdaptiveThinking, true);
  assert.equal(configureBuiltInGatewayCustomModel(presetRegistry, presetConfig, null).thinkingContract, null, "presets never take a gateway contract");
});

test("resolveBuiltInThinkingLevel: unset effort takes the contract's documented default only for a contract model, and otherwise stays exactly what it was", async () => {
  const registry = await freshBuiltInModelRegistry();
  const contractConfig = anthropicGatewayConfig("https://api.minimax.cn/anthropic", "MiniMax-M3.1-Flash-Preview");
  const { thinkingContract } = configureBuiltInGatewayCustomModel(registry, contractConfig, null);
  assert.ok(thinkingContract, "the documented pair registers with its contract");
  assert.equal(resolveBuiltInThinkingLevel(null, thinkingContract), "max");
  assert.equal(resolveBuiltInThinkingLevel(undefined, thinkingContract), "max");
  assert.equal(resolveBuiltInThinkingLevel("high", thinkingContract), "high", "an explicit choice passes through");
  assert.equal(resolveBuiltInThinkingLevel("max", thinkingContract), "max");
  // Pi's own off/minimal reach the SDK as chosen (Pi maps a level a model lacks).
  assert.equal(resolveBuiltInThinkingLevel("off", thinkingContract), "off");
  assert.equal(resolveBuiltInThinkingLevel("minimal", null), "minimal");

  const plain = await freshBuiltInModelRegistry();
  const plainConfig = anthropicGatewayConfig("https://gateway.example.test/anthropic", "MiniMax-M3.1-Flash-Preview");
  assert.equal(configureBuiltInGatewayCustomModel(plain, plainConfig, null).thinkingContract, null, "no contract for an unknown endpoint");
  // The launch fields carry `null` for an unset effort and the SDK clamps null
  // to its first supported level ("off"): that value must reach the SDK unchanged.
  assert.strictEqual(resolveBuiltInThinkingLevel(null, null), null as unknown as undefined);
  assert.strictEqual(resolveBuiltInThinkingLevel(undefined, null), undefined);
  assert.equal(resolveBuiltInThinkingLevel("max", null), "max");

  const catalog = await freshBuiltInModelRegistry();
  const catalogConfig = anthropicGatewayConfig("https://api.minimaxi.com/anthropic", "MiniMax-M3");
  assert.equal(configureBuiltInGatewayCustomModel(catalog, catalogConfig, null).thinkingContract, null, "a catalog pair is the SDK's business");

  const openai = await freshBuiltInModelRegistry();
  const openaiConfig = { ...plainConfig, provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://api.minimax.cn/v1", apiKey: "k" } } as const;
  assert.equal(configureBuiltInGatewayCustomModel(openai, openaiConfig, null).thinkingContract, null);
});

/** A loopback Anthropic Messages server that records request bodies and answers one short text turn. */
function startFakeAnthropicServer(): { server: Server; bodies: Array<Record<string, any>>; paths: string[] } {
  const bodies: Array<Record<string, any>> = [];
  const paths: string[] = [];
  const server = createServer((req, res) => {
    if (answerGatewayModelListRead(req, res)) return;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      paths.push(req.url ?? "");
      try {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        bodies.push({ unparsable: true });
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: bodies[bodies.length - 1]?.model ?? "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return { server, bodies, paths };
}

/**
 * Drive a real built-in session (registry → clamp → streamSimple → HTTP) for
 * one prompt and return the first request body the gateway received.
 */
async function captureBuiltInAnthropicRequest(input: {
  modelName: string;
  reasoningEffort: string | null;
  contract: AnthropicGatewayThinkingContract | null;
}): Promise<Record<string, any>> {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-anthropic-contract-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const fake = startFakeAnthropicServer();
  const port = await listenOnLoopback(fake.server);
  const baseUrl = `http://127.0.0.1:${port}/anthropic`;
  let session: AgentSession | undefined;
  try {
    session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: input.modelName,
        reasoningEffort: input.reasoningEffort,
        runtimeConfig: anthropicGatewayConfig(baseUrl, input.modelName, input.reasoningEffort),
      }, { workingDirectory, launchId: `launch-anthropic-contract-${port}` }),
      `builtin-anthropic-contract-${port}`,
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        agentDirSource: "managed_builtin",
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
        thinkingContracts: input.contract
          ? [{ endpoint: baseUrl, modelId: input.modelName, contract: input.contract }]
          : [],
      },
    );
    await session.prompt("contract proof");
    assert.equal(fake.paths.length, 1);
    assert.ok(fake.paths[0]!.startsWith("/anthropic/v1/messages"), fake.paths[0]);
    assert.equal(fake.bodies.length, 1);
    return fake.bodies[0]!;
  } finally {
    session?.dispose();
    await closeServer(fake.server);
    rmSync(root, { recursive: true, force: true });
  }
}

const M31_CONTRACT = findAnthropicGatewayThinkingContract("https://api.minimax.cn/anthropic", "MiniMax-M3.1-Flash-Preview")!;

test("real built-in chain: a contract model's default turn asks for adaptive thinking at the documented default effort, never disabled", { timeout: 20_000 }, async () => {
  const body = await captureBuiltInAnthropicRequest({ modelName: "MiniMax-M3.1-Flash-Preview", reasoningEffort: null, contract: M31_CONTRACT });
  assert.equal(body.model, "MiniMax-M3.1-Flash-Preview");
  assert.equal(body.thinking?.type, "adaptive", JSON.stringify(body.thinking));
  assert.equal(body.output_config?.effort, "max");
  assert.equal(JSON.stringify(body).includes("disabled"), false);
  assert.equal(body.thinking?.budget_tokens, undefined);
});

test("real built-in chain: Max on a contract model reaches the wire as adaptive + effort max; high stays high", { timeout: 30_000 }, async () => {
  const max = await captureBuiltInAnthropicRequest({ modelName: "MiniMax-M3.1-Flash-Preview", reasoningEffort: "max", contract: M31_CONTRACT });
  assert.equal(max.thinking?.type, "adaptive");
  assert.equal(max.output_config?.effort, "max", "not clamped to high");
  const high = await captureBuiltInAnthropicRequest({ modelName: "MiniMax-M3.1-Flash-Preview", reasoningEffort: "high", contract: M31_CONTRACT });
  assert.equal(high.thinking?.type, "adaptive");
  assert.equal(high.output_config?.effort, "high");
});

test("real built-in chain, control: the same model id without a contract keeps today's requests (disabled by default, budget thinking for Max)", { timeout: 30_000 }, async () => {
  const dflt = await captureBuiltInAnthropicRequest({ modelName: "MiniMax-M3.1-Flash-Preview", reasoningEffort: null, contract: null });
  assert.equal(dflt.thinking?.type, "disabled", JSON.stringify(dflt.thinking));
  assert.equal(dflt.output_config, undefined);
  const max = await captureBuiltInAnthropicRequest({ modelName: "MiniMax-M3.1-Flash-Preview", reasoningEffort: "max", contract: null });
  assert.equal(max.thinking?.type, "enabled", JSON.stringify(max.thinking));
  assert.equal(typeof max.thinking?.budget_tokens, "number");
  assert.equal(max.output_config, undefined);
});

/** Like startFakeAnthropicServer, but the first turn answers with a signed thinking block and a bash tool call. */
function startFakeAnthropicToolServer(): { server: Server; bodies: Array<Record<string, any>> } {
  const bodies: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (answerGatewayModelListRead(req, res)) return;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "MiniMax-M3.1-Flash-Preview", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      if (bodies.length === 1) {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan: run echo" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-turn-1" } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "bash", input: {} } });
        send("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "echo tool-proof" }) } });
        send("content_block_stop", { type: "content_block_stop", index: 1 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 2 } });
      } else {
        send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
        send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } });
        send("content_block_stop", { type: "content_block_stop", index: 0 });
        send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      }
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  return { server, bodies };
}

test("real built-in chain: a tool round trip on a contract model replays the signed thinking block and keeps adaptive thinking on the second request", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-anthropic-contract-tools-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const fake = startFakeAnthropicToolServer();
  const port = await listenOnLoopback(fake.server);
  const baseUrl = `http://127.0.0.1:${port}/anthropic`;
  let session: AgentSession | undefined;
  try {
    session = await createPiAgentSessionForContext(
      makeSpawnContext({
        runtime: "builtin",
        model: "MiniMax-M3.1-Flash-Preview",
        reasoningEffort: "max",
        runtimeConfig: anthropicGatewayConfig(baseUrl, "MiniMax-M3.1-Flash-Preview", "max"),
      }, { workingDirectory, launchId: `launch-anthropic-contract-tools-${port}` }),
      `builtin-anthropic-contract-tools-${port}`,
      {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        agentDirSource: "managed_builtin",
        exposeLaunchEnvToTools: false,
        isolateHostProviderEnv: true,
        thinkingContracts: [{ endpoint: baseUrl, modelId: "MiniMax-M3.1-Flash-Preview", contract: M31_CONTRACT }],
      },
    );
    await session.prompt("tool proof");
    assert.equal(fake.bodies.length, 2, "tool call, then the follow-up request");
    for (const body of fake.bodies) {
      assert.equal(body.thinking?.type, "adaptive");
      assert.equal(body.output_config?.effort, "max");
    }
    const second = fake.bodies[1]!;
    const assistant = second.messages.find((message: any) => message.role === "assistant");
    assert.ok(assistant, JSON.stringify(second.messages));
    const thinking = assistant.content.find((block: any) => block.type === "thinking");
    assert.deepEqual({ thinking: thinking?.thinking, signature: thinking?.signature }, { thinking: "plan: run echo", signature: "sig-turn-1" }, "the signed thinking block is replayed verbatim");
    assert.ok(assistant.content.some((block: any) => block.type === "tool_use" && block.name === "bash"));
    const toolResult = second.messages.at(-1)?.content?.find?.((block: any) => block.type === "tool_result");
    assert.ok(toolResult, "the tool result goes back on the second request");
    assert.match(JSON.stringify(toolResult), /tool-proof/);
  } finally {
    session?.dispose();
    await closeServer(fake.server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("real built-in chain: a relaunch resumes the Pi session and sends the earlier turn back (Pi SDK upgrade check)", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-pi-resume-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const bodies: Array<Record<string, any>> = [];
  const server = createServer((req, res) => {
    if (answerGatewayModelListRead(req, res)) return;
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const send = (event: string, data: Record<string, unknown>) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `msg_${bodies.length}`, type: "message", role: "assistant", model: "resume-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `reply-${bodies.length}` } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  const port = await listenOnLoopback(server);
  const baseUrl = `http://127.0.0.1:${port}/anthropic`;
  const sessionId = `builtin-resume-${port}`;
  const launch = (launchSessionId: string | null, launchId: string) => createPiAgentSessionForContext(
    makeSpawnContext({
      runtime: "builtin",
      model: "resume-model",
      sessionId: launchSessionId,
      runtimeConfig: anthropicGatewayConfig(baseUrl, "resume-model"),
    }, { workingDirectory, launchId }),
    sessionId,
    {
      agentDir: buildBuiltInAgentDir(workingDirectory),
      sessionDir: buildBuiltInSessionDir(workingDirectory),
      agentDirSource: "managed_builtin",
      exposeLaunchEnvToTools: false,
      isolateHostProviderEnv: true,
    },
  );
  let first: AgentSession | undefined;
  let second: AgentSession | undefined;
  try {
    first = await launch(null, `launch-resume-1-${port}`);
    await first.prompt("first turn");
    first.dispose();
    first = undefined;

    second = await launch(sessionId, `launch-resume-2-${port}`);
    await second.prompt("second turn");
    assert.equal(bodies.length, 2);
    const history = JSON.stringify(bodies[1]!.messages);
    assert.match(history, /first turn/, "the resumed session sends the first launch's prompt");
    assert.match(history, /reply-1/, "and its reply");
    assert.match(history, /second turn/);
  } finally {
    first?.dispose();
    second?.dispose();
    await closeServer(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test("task #17: Pi tool ends carry the call id, Pi's own duration, and a non-zero bash exit as an ok call with the exit code", () => {
  const state = createPiSdkEventMappingState("pi-session-17");
  state.sessionAnnounced = true;
  const end = (extra: Record<string, unknown>) => mapPiSdkEventToParsedEvents({ type: "tool_execution_end", toolCallId: "call-7", toolName: "bash", ...extra } as unknown as AgentSessionEvent, state);
  assert.deepEqual(end({ isError: false, durationMs: 1200, result: { content: [] } }), [{ kind: "tool_output", name: "bash", callId: "call-7", ok: true, durationMs: 1200 }]);
  assert.deepEqual(end({ isError: true, durationMs: 900, result: { structuredContent: { exit_code: 1, output: "" } } }), [{ kind: "tool_output", name: "bash", callId: "call-7", ok: true, exitCode: 1, durationMs: 900 }]);
  assert.deepEqual(end({ isError: true, result: { content: [{ type: "text", text: "Command timed out" }] } }), [{ kind: "tool_output", name: "bash", callId: "call-7", ok: false }]);
});
