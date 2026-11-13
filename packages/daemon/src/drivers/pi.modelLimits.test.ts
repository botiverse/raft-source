// task #1357 item 1: the limits a Built-in gateway custom model is registered
// with, reported per field with its source, are exactly the values the Pi
// model registry holds for the session's model.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RUNTIME_CONFIG_VERSION, type ModelLimits } from "@botiverse/raft-shared";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  buildBuiltInAgentDir,
  buildBuiltInSessionDir,
  configureBuiltInGatewayCustomModel,
  openPiAgentSessionForContext,
  readBuiltInGatewayModelLimits,
  resolvePiModelFromRegistry,
} from "./pi";
import type { SpawnContext } from "./types";
import { installDaemonFetchMockForTests } from "../daemonFetch";
import { resetGatewayModelLimitsCacheForTests } from "../gatewayModelLimits";

const QWEN_TOKEN_PLAN_BASE_URL = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/";
const RAFT_DEFAULTS: ModelLimits = {
  contextWindow: { value: 200_000, source: "raft_default" },
  maxTokens: { value: 8192, source: "raft_default" },
};

// Sessions read the gateway's model list (#proj-runtime:#53). By default every
// gateway answers 404, so the limits fall through as before; a test that wants
// a list installs its own.
let gatewayRequests: string[] = [];
let restoreFetch: (() => void) | undefined;
function serveGatewayLists(handler: (url: string, init?: RequestInit) => Response): void {
  restoreFetch?.();
  restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    gatewayRequests.push(url);
    return handler(url, init);
  }) as typeof fetch);
}
beforeEach(() => {
  resetGatewayModelLimitsCacheForTests();
  gatewayRequests = [];
  serveGatewayLists(() => new Response("not found", { status: 404 }));
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

async function freshRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  return new ModelRegistry(runtime);
}

function gatewayConfig(providerId: "openai-compatible" | "anthropic-compatible", baseUrl: string, name: string) {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "gateway", providerId, baseUrl, apiKey: "gateway-test-key" },
    hostUserState: "forbidden",
    model: { kind: "custom", name },
    mode: { kind: "default" },
  } as const;
}

function registeredLimits(registry: ModelRegistry, config: Parameters<typeof resolvePiModelFromRegistry>[2], name: string) {
  const model = resolvePiModelFromRegistry(name, registry, config, null);
  assert.ok(model, "the gateway model is registered");
  return { contextWindow: model.contextWindow, maxTokens: model.maxTokens };
}

test("an endpoint + id pair no catalog entry matches registers Raft's defaults and reports raft_default for both fields", async () => {
  const registry = await freshRegistry();
  const config = gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "my-model");
  const { modelLimits } = configureBuiltInGatewayCustomModel(registry, config, null);
  assert.deepEqual(modelLimits, RAFT_DEFAULTS);
  assert.deepEqual(registeredLimits(registry, config, "my-model"), { contextWindow: 200_000, maxTokens: 8192 }, "the report is what was registered");
});

test("a catalog pair (Qwen Token Plan) registers and reports the catalog's values, both from catalog", async () => {
  const registry = await freshRegistry();
  const catalog = registry.getAll().find((model) => model.id === "qwen3.8-max" && model.api === "openai-completions" && model.baseUrl.startsWith("https://token-plan.cn-beijing"));
  assert.ok(catalog, "fixture precondition: the SDK catalog knows the Qwen Token Plan pair");
  const config = gatewayConfig("openai-compatible", QWEN_TOKEN_PLAN_BASE_URL, "qwen3.8-max");
  const { modelLimits } = configureBuiltInGatewayCustomModel(registry, config, null);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: catalog.contextWindow, source: "catalog" },
    maxTokens: { value: catalog.maxTokens, source: "catalog" },
  });
  assert.notEqual(catalog.contextWindow, 200_000, "fixture precondition: the catalog value differs from the default");
  assert.deepEqual(registeredLimits(registry, config, "qwen3.8-max"), { contextWindow: catalog.contextWindow, maxTokens: catalog.maxTokens });
});

test("each field has its own source: a catalog entry without maxTokens reports catalog contextWindow and raft_default maxTokens", () => {
  const registered: Array<{ models: Array<{ contextWindow: number; maxTokens: number }> }> = [];
  const registry = {
    getAll: () => [{ id: "partial-model", api: "openai-completions", baseUrl: "https://partial.example.test/v1", contextWindow: 64_000, input: ["text"] }],
    registerProvider: (_id: string, provider: { models: Array<{ contextWindow: number; maxTokens: number }> }) => registered.push(provider),
    find: () => registered[0]?.models[0],
  } as unknown as ModelRegistry;
  const config = gatewayConfig("openai-compatible", "https://partial.example.test/v1/", "partial-model");
  const { modelLimits } = configureBuiltInGatewayCustomModel(registry, config, null);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: 64_000, source: "catalog" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
  assert.equal(registered[0]?.models[0]?.contextWindow, 64_000);
  assert.equal(registered[0]?.models[0]?.maxTokens, 8192);
});

test("an Anthropic-compatible pair with an on-record thinking contract but no catalog entry still reports raft_default", async () => {
  const registry = await freshRegistry();
  const config = gatewayConfig("anthropic-compatible", "https://api.minimax.cn/anthropic", "MiniMax-M3.1-Flash-Preview");
  const { thinkingContract, modelLimits } = configureBuiltInGatewayCustomModel(registry, config, null);
  assert.ok(thinkingContract, "fixture precondition: the pair has a thinking contract");
  assert.deepEqual(modelLimits, RAFT_DEFAULTS, "a thinking contract carries no limits");
  assert.deepEqual(registeredLimits(registry, config, "MiniMax-M3.1-Flash-Preview"), { contextWindow: 200_000, maxTokens: 8192 });
});

test("a managed gateway connection reports limits; presets and non-gateway connections report none", async () => {
  const connection = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
    hostUserState: "forbidden",
    model: { kind: "custom", name: "my-model" },
    mode: { kind: "default" },
  } as const;
  const projection = { providerId: "openai-compatible", endpointUrl: "https://gateway.example.test/v1", supportsImageInput: false } as const;
  assert.deepEqual(configureBuiltInGatewayCustomModel(await freshRegistry(), connection, projection).modelLimits, RAFT_DEFAULTS);
  assert.equal(configureBuiltInGatewayCustomModel(await freshRegistry(), connection, null).modelLimits, null, "a connection the launch does not resolve to a gateway");
  const preset = { ...connection, model: { kind: "preset", id: "moonshotai/kimi-k3" } } as const;
  assert.equal(configureBuiltInGatewayCustomModel(await freshRegistry(), preset, projection).modelLimits, null);
});

function builtInContext(workingDirectory: string, baseUrl: string, name: string): SpawnContext {
  return {
    agentId: "agent-1",
    standingPrompt: "standing instructions",
    prompt: "wake prompt",
    workingDirectory,
    slockCliPath: "/tmp/slock-cli.js",
    daemonApiKey: "daemon-token",
    launchId: "launch-1",
    config: {
      name: "Built-in Agent",
      displayName: null,
      description: null,
      runtime: "builtin",
      serverUrl: "https://slock.example",
      authToken: "agent-token",
      sessionId: null,
      model: name,
      reasoningEffort: null,
      envVars: null,
      runtimeContext: null,
      runtimeConfig: { ...gatewayConfig("openai-compatible", baseUrl, name), envVars: null },
    },
  };
}

for (const [label, baseUrl, name] of [
  ["catalog pair", QWEN_TOKEN_PLAN_BASE_URL, "qwen3.8-max"],
  ["unknown endpoint", "https://gateway.example.test/v1", "my-model"],
] as const) {
  test(`the opened session handle carries exactly the limits of the session's model (${label})`, async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-model-limits-"));
    const workingDirectory = path.join(root, "workspace");
    mkdirSync(workingDirectory, { recursive: true });
    try {
      const handle = await openPiAgentSessionForContext(builtInContext(workingDirectory, baseUrl, name), `session-${name}`, {
        agentDir: buildBuiltInAgentDir(workingDirectory),
        sessionDir: buildBuiltInSessionDir(workingDirectory),
        isolateHostProviderEnv: true,
        exposeLaunchEnvToTools: false,
      });
      try {
        const model = handle.session.model;
        assert.ok(model);
        assert.ok(handle.modelLimits);
        assert.equal(handle.modelLimits.contextWindow.value, model.contextWindow);
        assert.equal(handle.modelLimits.maxTokens.value, model.maxTokens);
        const expectedSource = label === "catalog pair" ? "catalog" : "raft_default";
        assert.equal(handle.modelLimits.contextWindow.source, expectedSource);
        assert.equal(handle.modelLimits.maxTokens.source, expectedSource);
      } finally {
        handle.session.dispose();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const NOTE_HEADING = "## Model limits";

async function withBuiltInWorkspace(run: (open: (baseUrl: string, name: string) => ReturnType<typeof openPiAgentSessionForContext>, agentDir: string) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-limits-note-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const agentDir = buildBuiltInAgentDir(workingDirectory);
  try {
    await run((baseUrl, name) => openPiAgentSessionForContext(builtInContext(workingDirectory, baseUrl, name), `session-${name}`, {
      agentDir,
      sessionDir: buildBuiltInSessionDir(workingDirectory),
      isolateHostProviderEnv: true,
      exposeLaunchEnvToTools: false,
    }), agentDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the session's system prompt names Raft's defaults only when a value is one", async () => {
  await withBuiltInWorkspace(async (open) => {
    const unknown = await open("https://gateway.example.test/v1", "my-model");
    try {
      const prompt = unknown.session.systemPrompt;
      assert.ok(prompt.includes("standing instructions"), "the standing prompt stays");
      assert.ok(prompt.includes(NOTE_HEADING));
      assert.match(prompt, /context window 200,000 tokens and max output 8,192 tokens/);
      assert.match(prompt, /"openai": \{\n\s+"modelOverrides": \{\n\s+"my-model": \{/, "the registry's own provider and model ids");
      assert.doesNotMatch(prompt, /gateway-test-key|gateway\.example\.test/, "no key and no base URL");
    } finally {
      unknown.session.dispose();
    }
    const catalog = await open(QWEN_TOKEN_PLAN_BASE_URL, "qwen3.8-max");
    try {
      assert.ok(catalog.session.systemPrompt.includes("standing instructions"));
      assert.ok(!catalog.session.systemPrompt.includes(NOTE_HEADING), "catalog limits: nothing is said");
    } finally {
      catalog.session.dispose();
    }
  });
});

test("the override the note shows, written to the agent dir's models.json, is what the next session runs with and reports as catalog", async () => {
  await withBuiltInWorkspace(async (open, agentDir) => {
    const first = await open("https://gateway.example.test/v1", "my-model");
    const shown = /```json\n([\s\S]*?)\n```/.exec(first.session.systemPrompt)?.[1];
    first.session.dispose();
    assert.ok(shown, "the note shows the JSON to write");
    writeFileSync(path.join(agentDir, "models.json"), shown
      .replace(/"contextWindow": <tokens>/, "\"contextWindow\": 262144")
      .replace(/"maxTokens": <tokens>/, "\"maxTokens\": 65536"));

    const next = await open("https://gateway.example.test/v1", "my-model");
    try {
      assert.deepEqual(next.modelLimits, {
        contextWindow: { value: 262_144, source: "catalog" },
        maxTokens: { value: 65_536, source: "catalog" },
      });
      assert.equal(next.session.model?.contextWindow, 262_144, "the session runs with the override");
      assert.equal(next.session.model?.maxTokens, 65_536);
      assert.ok(!next.session.systemPrompt.includes(NOTE_HEADING), "no default left, nothing said");
    } finally {
      next.session.dispose();
    }

    // An override that equals Raft's default is still the file's value, not a default.
    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { modelOverrides: { "my-model": { contextWindow: 200_000, maxTokens: 8192 } } } } }));
    const sameAsDefault = await open("https://gateway.example.test/v1", "my-model");
    try {
      assert.deepEqual(sameAsDefault.modelLimits, {
        contextWindow: { value: 200_000, source: "catalog" },
        maxTokens: { value: 8192, source: "catalog" },
      });
      assert.ok(!sameAsDefault.session.systemPrompt.includes(NOTE_HEADING), "the agent declared them: nothing is said");
    } finally {
      sameAsDefault.session.dispose();
    }

    writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openai: { modelOverrides: { "my-model": { contextWindow: 96_000 } } } } }));
    const partial = await open("https://gateway.example.test/v1", "my-model");
    try {
      assert.deepEqual(partial.modelLimits, {
        contextWindow: { value: 96_000, source: "catalog" },
        maxTokens: { value: 8192, source: "raft_default" },
      });
      assert.match(partial.session.systemPrompt, /max output 8,192 tokens\. This is not the model's real limit/);
      assert.doesNotMatch(partial.session.systemPrompt, /context window 200,000/);
    } finally {
      partial.session.dispose();
    }
  });
});

test("a models.json override wins over a declared value too, and the report says what the session runs with", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-limits-override-"));
  try {
    const modelsPath = path.join(root, "models.json");
    writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { modelOverrides: { "my-model": { contextWindow: 50_000 } } } } }));
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath, allowModelNetwork: false });
    const registry = new ModelRegistry(runtime);
    const declared = { ...gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "my-model"), model: { kind: "custom", name: "my-model", contextWindow: 96_000 } } as const;
    const { modelLimits } = configureBuiltInGatewayCustomModel(registry, declared as never, null);
    assert.deepEqual(modelLimits?.contextWindow, { value: 50_000, source: "catalog" });
    assert.equal(registeredLimits(registry, declared as never, "my-model").contextWindow, 50_000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the agent's declared limits win over the catalog and Raft's default, each field on its own (#proj-runtime:#50)", async () => {
  const registry = await freshRegistry();
  const declared = { ...gatewayConfig("openai-compatible", QWEN_TOKEN_PLAN_BASE_URL, "qwen3.8-max"), model: { kind: "custom", name: "qwen3.8-max", contextWindow: 96_000 } } as const;
  const { modelLimits } = configureBuiltInGatewayCustomModel(registry, declared as never, null);
  assert.deepEqual(modelLimits?.contextWindow, { value: 96_000, source: "agent_config" }, "declared beats the catalog");
  assert.equal(modelLimits?.maxTokens.source, "catalog", "the undeclared field keeps the catalog value");
  assert.deepEqual(registeredLimits(registry, declared as never, "qwen3.8-max").contextWindow, 96_000, "the report is what was registered");

  const unknownPair = { ...gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "devin/swe-2-flash"), model: { kind: "custom", name: "devin/swe-2-flash", maxOutputTokens: 32_000 } } as const;
  const both = configureBuiltInGatewayCustomModel(await freshRegistry(), unknownPair as never, null).modelLimits;
  assert.deepEqual(both, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 32_000, source: "agent_config" },
  }, "a field left empty still reports Raft's default, so the warning stays for that one");
});

test("the gateway's value sits between the agent's own and the catalog's, each field on its own (#proj-runtime:#53)", async () => {
  const catalogPair = gatewayConfig("openai-compatible", QWEN_TOKEN_PLAN_BASE_URL, "qwen3.8-max");
  const registry = await freshRegistry();
  const { modelLimits } = configureBuiltInGatewayCustomModel(registry, catalogPair, null, {}, { contextWindow: 77_000 });
  assert.deepEqual(modelLimits?.contextWindow, { value: 77_000, source: "gateway" }, "the gateway beats the catalog");
  assert.equal(modelLimits?.maxTokens.source, "catalog", "a field the gateway did not report keeps the catalog value");
  assert.equal(registeredLimits(registry, catalogPair, "qwen3.8-max").contextWindow, 77_000, "the report is what was registered");

  const declared = { ...catalogPair, model: { kind: "custom", name: "qwen3.8-max", contextWindow: 96_000 } } as const;
  const both = configureBuiltInGatewayCustomModel(await freshRegistry(), declared as never, null, {}, { contextWindow: 77_000, maxTokens: 9_000 }).modelLimits;
  assert.deepEqual(both, {
    contextWindow: { value: 96_000, source: "agent_config" },
    maxTokens: { value: 9_000, source: "gateway" },
  }, "the agent's own value beats the gateway's");

  const unknownPair = gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "my-model");
  assert.deepEqual(configureBuiltInGatewayCustomModel(await freshRegistry(), unknownPair, null, {}, { maxTokens: 12_000 }).modelLimits, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 12_000, source: "gateway" },
  }, "an unreported field still falls back to Raft's default");
});

test("a gateway max output larger than the context window the model ends up with is ignored", async () => {
  const unknownPair = gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "my-model");
  assert.deepEqual(configureBuiltInGatewayCustomModel(await freshRegistry(), unknownPair, null, {}, { contextWindow: 32_000, maxTokens: 64_000 }).modelLimits, {
    contextWindow: { value: 32_000, source: "gateway" },
    maxTokens: { value: 8192, source: "raft_default" },
  }, "against the gateway's own context window");
  const declared = { ...unknownPair, model: { kind: "custom", name: "my-model", contextWindow: 16_000 } } as const;
  assert.deepEqual(configureBuiltInGatewayCustomModel(await freshRegistry(), declared as never, null, {}, { maxTokens: 20_000 }).modelLimits, {
    contextWindow: { value: 16_000, source: "agent_config" },
    maxTokens: { value: 8192, source: "raft_default" },
  }, "against the agent's own context window");
  assert.equal(configureBuiltInGatewayCustomModel(await freshRegistry(), unknownPair, null, {}, { maxTokens: 200_000 }).modelLimits?.maxTokens.source, "gateway", "equal to the context window still fits");
});

test("no gateway read when the agent set both limits, there is no key, or the model is not a gateway custom model", async () => {
  const fetchSpy = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;
  const declaredBoth = { ...gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "m"), model: { kind: "custom", name: "m", contextWindow: 1, maxOutputTokens: 1 } } as const;
  assert.equal((await readBuiltInGatewayModelLimits(declaredBoth as never, null, null, fetchSpy)).outcome, "skipped");
  const noKey = { ...gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "m"), provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: "https://gateway.example.test/v1", apiKey: "" } } as const;
  assert.equal((await readBuiltInGatewayModelLimits(noKey as never, null, null, fetchSpy)).outcome, "skipped");
  const preset = { ...gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "m"), model: { kind: "preset", id: "moonshotai/kimi-k3" } } as const;
  assert.equal((await readBuiltInGatewayModelLimits(preset as never, null, null, fetchSpy)).outcome, "skipped");
});

test("a managed gateway connection reads with the key from the launch env, not from anywhere else", async () => {
  const connection = {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "connection", connectionId: "11111111-1111-4111-8111-111111111111" },
    hostUserState: "forbidden",
    model: { kind: "custom", name: "my-model" },
    mode: { kind: "default" },
  } as const;
  const projection = { providerId: "openai-compatible", endpointUrl: "https://gateway.example.test/v1", supportsImageInput: false } as const;
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const fetchSpy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({ data: [{ id: "my-model", context_length: 64_000 }] });
  }) as typeof fetch;
  const result = await readBuiltInGatewayModelLimits(connection, projection, { OPENAI_API_KEY: "sk-managed" }, fetchSpy);
  assert.deepEqual(result.limits, { contextWindow: 64_000 });
  assert.deepEqual(seen, [{ url: "https://gateway.example.test/v1/models", authorization: "Bearer sk-managed" }]);
  assert.equal((await readBuiltInGatewayModelLimits(connection, projection, null, fetchSpy)).outcome, "skipped", "no launch key, no read");
});

test("a gateway (stock CLIProxyAPI) whose plain list has no limits is read again at ?client_version=pi", async () => {
  const seen: string[] = [];
  const fetchSpy = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return url.endsWith("?client_version=pi")
      ? Response.json({ models: [{ slug: "my-model", context_window: 272_000, max_context_window: 872_000 }] })
      : Response.json({ object: "list", data: [{ id: "my-model", object: "model" }] });
  }) as typeof fetch;
  const result = await readBuiltInGatewayModelLimits(gatewayConfig("openai-compatible", "https://gateway.example.test/v1", "my-model"), null, null, fetchSpy);
  assert.deepEqual(result, { limits: { contextWindow: 272_000 }, outcome: "ok", cached: false, format: "cliproxyapi_pi", fallbackRead: true });
  assert.deepEqual(seen, ["https://gateway.example.test/v1/models", "https://gateway.example.test/v1/models?client_version=pi"]);
});

test("an opened session registers and reports the gateway's limits, and a failing gateway never stops the start", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-gateway-limits-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const open = async (name: string) => openPiAgentSessionForContext(builtInContext(workingDirectory, "https://gateway.example.test/v1", name), `session-${name}`, {
    agentDir: buildBuiltInAgentDir(workingDirectory),
    sessionDir: buildBuiltInSessionDir(workingDirectory),
    isolateHostProviderEnv: true,
    exposeLaunchEnvToTools: false,
  });
  try {
    serveGatewayLists((url, init) => {
      assert.equal(url, "https://gateway.example.test/v1/models");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer gateway-test-key");
      return Response.json({ data: [{ id: "listed-model", context_length: 131_072, max_completion_tokens: 32_768 }] });
    });
    const handle = await open("listed-model");
    try {
      assert.deepEqual(handle.modelLimits, {
        contextWindow: { value: 131_072, source: "gateway" },
        maxTokens: { value: 32_768, source: "gateway" },
      });
      assert.equal(handle.session.model?.contextWindow, 131_072);
      assert.equal(handle.session.model?.maxTokens, 32_768);
    } finally {
      handle.session.dispose();
    }

    resetGatewayModelLimitsCacheForTests();
    serveGatewayLists(() => { throw new Error("connect ECONNREFUSED"); });
    const failed = await open("listed-model");
    try {
      assert.deepEqual(failed.modelLimits, RAFT_DEFAULTS, "the start goes on with the next source");
    } finally {
      failed.session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
