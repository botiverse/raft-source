// #proj-runtime:#53 follow-up to task #10: a typed OpenRouter model takes its
// context window and max output tokens from OpenRouter's own model list
// (`<OpenRouter base>/models`), between the agent's own value and the catalog.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eventsForSpan, RUNTIME_CONFIG_VERSION, type RuntimeConfig } from "@botiverse/raft-shared";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  buildBuiltInAgentDir,
  buildBuiltInSessionDir,
  builtInPresetModelListBaseUrl,
  configureBuiltInPresetCustomModel,
  openPiAgentSessionForContext,
  readBuiltInPresetCustomModelLimits,
} from "./pi";
import type { SpawnContext } from "./types";
import { installDaemonFetchMockForTests } from "../daemonFetch";
import { resetGatewayModelLimitsCacheForTests } from "../gatewayModelLimits";
import { makeDeterministicTracer } from "../testing/deterministicTracer";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_MODELS = `${OPENROUTER_BASE}/models`;

// The shape OpenRouter's list has: a total `context_length` at the top, the
// output cap nested under `top_provider`, ids with slashes.
const OPENROUTER_LIST = {
  data: [
    { id: "acme/brand-new-model", name: "Acme: Brand New", context_length: 262_144, top_provider: { context_length: 262_144, max_completion_tokens: 65_536, is_moderated: false } },
    { id: "openrouter/auto", name: "Auto Router", context_length: 2_000_000, top_provider: { context_length: null, max_completion_tokens: null } },
    { id: "acme/context-only", context_length: 128_000, top_provider: { max_completion_tokens: null } },
  ],
};

let requests: Array<{ url: string; authorization: string | null }> = [];
let restoreFetch: (() => void) | undefined;
function serve(handler: (url: string) => Response): void {
  restoreFetch?.();
  restoreFetch = installDaemonFetchMockForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return handler(url);
  }) as typeof fetch);
}
beforeEach(() => {
  resetGatewayModelLimitsCacheForTests();
  requests = [];
  serve(() => new Response("not found", { status: 404 }));
});
afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function openRouterConfig(name: string, limits: { contextWindow?: number; maxOutputTokens?: number } = {}, apiKey = "sk-or-test"): RuntimeConfig {
  return {
    version: RUNTIME_CONFIG_VERSION,
    runtime: "builtin",
    provider: { kind: "preset", providerId: "openrouter", apiKey },
    hostUserState: "forbidden",
    model: { kind: "custom", name, ...limits },
    mode: { kind: "default" },
  } as RuntimeConfig;
}

async function freshRegistry(): Promise<ModelRegistry> {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  return new ModelRegistry(runtime);
}

function fetchFrom(list: unknown, seen: Array<{ url: string; authorization: string | null }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    return Response.json(list);
  }) as typeof fetch;
}

test("OpenRouter's list is read from OpenRouter's catalog base URL; other presets have none", () => {
  assert.equal(builtInPresetModelListBaseUrl("openrouter"), OPENROUTER_BASE);
  assert.equal(builtInPresetModelListBaseUrl("deepseek"), null);
  assert.equal(builtInPresetModelListBaseUrl("anthropic"), null);
  assert.equal(builtInPresetModelListBaseUrl("qwen-token-plan"), null);
});

test("a typed model on a provider whose list Raft does not read sends nothing anywhere and takes Raft's defaults", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const config = { ...openRouterConfig("qwen4-preview"), provider: { kind: "preset", providerId: "qwen-token-plan", apiKey: "sk-qwen-test" } } as RuntimeConfig;
  const read = await readBuiltInPresetCustomModelLimits(config, fetchFrom(OPENROUTER_LIST, seen));
  assert.deepEqual(read, { limits: null, outcome: "skipped", cached: false, baseUrl: null });
  assert.deepEqual(seen, [], "the key goes nowhere but the model calls");
  const { modelLimits } = configureBuiltInPresetCustomModel(await freshRegistry(), config, read.limits, read.baseUrl);
  assert.deepEqual(modelLimits, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
});

test("a typed OpenRouter id is matched exactly in OpenRouter's list, the output cap from top_provider", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const fetchSpy = fetchFrom(OPENROUTER_LIST, seen);
  const listed = await readBuiltInPresetCustomModelLimits(openRouterConfig("acme/brand-new-model"), fetchSpy);
  assert.deepEqual(listed.limits, { contextWindow: 262_144, maxTokens: 65_536 });
  assert.equal(listed.outcome, "ok");
  assert.equal(listed.baseUrl, OPENROUTER_BASE);
  assert.deepEqual(seen, [{ url: OPENROUTER_MODELS, authorization: "Bearer sk-or-test" }], "one GET to OpenRouter with the agent's own key");

  const auto = await readBuiltInPresetCustomModelLimits(openRouterConfig("openrouter/auto"), fetchSpy);
  assert.deepEqual(auto.limits, { contextWindow: 2_000_000 }, "a native openrouter/ id is looked up as is; a null cap is no cap");
  const contextOnly = await readBuiltInPresetCustomModelLimits(openRouterConfig("acme/context-only"), fetchSpy);
  assert.deepEqual(contextOnly.limits, { contextWindow: 128_000 });
  const unlisted = await readBuiltInPresetCustomModelLimits(openRouterConfig("acme/not-there"), fetchSpy);
  assert.equal(unlisted.outcome, "not_listed");
  assert.equal(seen.length, 1, "the list is read once and cached for every model of the same key");
});

test("no read when the agent set both limits, has no key, or is not a typed OpenRouter model", async () => {
  const fetchSpy = (async () => { throw new Error("no request expected"); }) as unknown as typeof fetch;
  assert.equal((await readBuiltInPresetCustomModelLimits(openRouterConfig("acme/m", { contextWindow: 1_000, maxOutputTokens: 100 }), fetchSpy)).outcome, "skipped");
  assert.equal((await readBuiltInPresetCustomModelLimits(openRouterConfig("acme/m", {}, ""), fetchSpy)).outcome, "skipped");
  const preset = { ...openRouterConfig("acme/m"), model: { kind: "preset", id: "openrouter/moonshotai/kimi-k2.6" } } as RuntimeConfig;
  assert.equal((await readBuiltInPresetCustomModelLimits(preset, fetchSpy)).outcome, "skipped");
  const otherPreset = { ...openRouterConfig("m"), provider: { kind: "preset", providerId: "deepseek", apiKey: "sk-ds" } } as RuntimeConfig;
  assert.equal((await readBuiltInPresetCustomModelLimits(otherPreset, fetchSpy)).outcome, "skipped");
  const gateway = { ...openRouterConfig("m"), provider: { kind: "gateway", providerId: "openai-compatible", baseUrl: OPENROUTER_BASE, apiKey: "sk-or" } } as RuntimeConfig;
  assert.equal((await readBuiltInPresetCustomModelLimits(gateway, fetchSpy)).outcome, "skipped", "a gateway reads through the gateway reader instead");
});

test("two agents with the same key share one read; a different key reads again", async () => {
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const fetchSpy = fetchFrom(OPENROUTER_LIST, seen);
  await Promise.all([
    readBuiltInPresetCustomModelLimits(openRouterConfig("acme/brand-new-model"), fetchSpy),
    readBuiltInPresetCustomModelLimits(openRouterConfig("acme/context-only"), fetchSpy),
  ]);
  assert.equal(seen.length, 1);
  await readBuiltInPresetCustomModelLimits(openRouterConfig("acme/brand-new-model", {}, "sk-or-other"), fetchSpy);
  assert.equal(seen.length, 2);
});

test("registration: the agent's value, then OpenRouter's, then the catalog, then Raft's default, field by field", async () => {
  const reported = { contextWindow: 262_144, maxTokens: 65_536 };
  let registry = await freshRegistry();
  assert.deepEqual(configureBuiltInPresetCustomModel(registry, openRouterConfig("acme/brand-new-model"), reported, OPENROUTER_BASE).modelLimits, {
    contextWindow: { value: 262_144, source: "gateway" },
    maxTokens: { value: 65_536, source: "gateway" },
  });
  registry = await freshRegistry();
  assert.deepEqual(configureBuiltInPresetCustomModel(registry, openRouterConfig("acme/brand-new-model", { maxOutputTokens: 4_096 }), reported, OPENROUTER_BASE).modelLimits, {
    contextWindow: { value: 262_144, source: "gateway" },
    maxTokens: { value: 4_096, source: "agent_config" },
  });
  registry = await freshRegistry();
  assert.deepEqual(configureBuiltInPresetCustomModel(registry, openRouterConfig("acme/brand-new-model"), { contextWindow: 262_144 }, OPENROUTER_BASE).modelLimits, {
    contextWindow: { value: 262_144, source: "gateway" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
  registry = await freshRegistry();
  assert.deepEqual(configureBuiltInPresetCustomModel(registry, openRouterConfig("acme/brand-new-model"), { contextWindow: 32_000, maxTokens: 64_000 }, OPENROUTER_BASE).modelLimits?.maxTokens,
    { value: 8192, source: "raft_default" }, "a reported cap larger than the context window is ignored");
});

test("limits read from another host than the registration's model calls go to are not used", async () => {
  const registry = await freshRegistry();
  assert.deepEqual(configureBuiltInPresetCustomModel(registry, openRouterConfig("acme/brand-new-model"), { contextWindow: 262_144, maxTokens: 65_536 }, "https://elsewhere.example.test/v1").modelLimits, {
    contextWindow: { value: 200_000, source: "raft_default" },
    maxTokens: { value: 8192, source: "raft_default" },
  });
});

function openRouterContext(workingDirectory: string, name: string, tracer?: SpawnContext["tracer"]): SpawnContext {
  return {
    ...(tracer ? { tracer } : {}),
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
      runtimeConfig: { ...openRouterConfig(name), envVars: null },
    },
  } as SpawnContext;
}

test("an opened session on a provider whose list Raft does not read makes no request and traces no list read", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-qwen-limits-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const context = openRouterContext(workingDirectory, "qwen4-preview", tracer);
  context.config.runtimeConfig = {
    ...openRouterConfig("qwen4-preview"),
    provider: { kind: "preset", providerId: "qwen-token-plan", apiKey: "sk-qwen-test" },
    envVars: null,
  } as RuntimeConfig;
  try {
    const handle = await openPiAgentSessionForContext(context, "session-qwen", {
      agentDir: buildBuiltInAgentDir(workingDirectory),
      sessionDir: buildBuiltInSessionDir(workingDirectory),
      isolateHostProviderEnv: true,
      exposeLaunchEnvToTools: false,
    });
    try {
      assert.equal(handle.session.model?.provider, "qwen-token-plan");
      assert.equal(handle.session.model?.id, "qwen4-preview");
      assert.deepEqual(requests, []);
      const events = eventsForSpan(sink, traceId, "daemon.pi.session.create");
      assert.equal(events.some((event) => event.name === "daemon.pi.session.gateway_model_limits"), false);
    } finally {
      handle.session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an opened session registers OpenRouter's limits, only OpenRouter is asked, and a failing read never stops the start", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-openrouter-limits-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const { sink, tracer, traceId } = makeDeterministicTracer();
  const open = async (name: string) => openPiAgentSessionForContext(openRouterContext(workingDirectory, name, tracer), `session-${name.replace(/[^A-Za-z0-9]+/g, "-")}`, {
    agentDir: buildBuiltInAgentDir(workingDirectory),
    sessionDir: buildBuiltInSessionDir(workingDirectory),
    isolateHostProviderEnv: true,
    exposeLaunchEnvToTools: false,
  });
  try {
    serve((url) => (url === OPENROUTER_MODELS ? Response.json(OPENROUTER_LIST) : new Response("not found", { status: 404 })));
    const handle = await open("acme/brand-new-model");
    try {
      assert.deepEqual(handle.modelLimits, {
        contextWindow: { value: 262_144, source: "gateway" },
        maxTokens: { value: 65_536, source: "gateway" },
      });
      assert.equal(handle.session.model?.contextWindow, 262_144);
      assert.equal(handle.session.model?.maxTokens, 65_536);
      assert.deepEqual(requests, [{ url: OPENROUTER_MODELS, authorization: "Bearer sk-or-test" }]);
      // Dashboards read this value: an OpenRouter read is traced as `openrouter`.
      const read = eventsForSpan(sink, traceId, "daemon.pi.session.create").find((event) => event.name === "daemon.pi.session.gateway_model_limits");
      assert.equal(read?.attrs?.provider_kind, "openrouter");
      assert.equal(read?.attrs?.outcome, "ok");
    } finally {
      handle.session.dispose();
    }

    resetGatewayModelLimitsCacheForTests();
    serve(() => { throw new Error("connect ECONNREFUSED"); });
    const failed = await open("acme/brand-new-model");
    try {
      assert.deepEqual(failed.modelLimits, {
        contextWindow: { value: 200_000, source: "raft_default" },
        maxTokens: { value: 8192, source: "raft_default" },
      }, "the start goes on with the next source");
    } finally {
      failed.session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A saved preset connection runs a typed id exactly as its provider does: the
// connection supplies only the key. The model is registered on the provider's
// own transport, the agent's limits apply, OpenRouter's list is read with the
// connection's key, and nothing goes anywhere else.
test("an opened session runs a typed id through a saved preset connection on the provider's transport with the connection's key", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "slock-builtin-connection-typed-"));
  const workingDirectory = path.join(root, "workspace");
  mkdirSync(workingDirectory, { recursive: true });
  const open = async (providerId: string, keyEnv: string, model: RuntimeConfig["model"], sessionId: string) => {
    const context = openRouterContext(workingDirectory, (model as { name: string }).name);
    context.config.runtimeConfig = {
      ...openRouterConfig("unused"),
      provider: { kind: "connection", connectionId: "conn-1" },
      model,
      envVars: null,
    } as RuntimeConfig;
    context.config.providerConnection = { providerId, endpointUrl: null, supportsImageInput: false } as NonNullable<SpawnContext["config"]["providerConnection"]>;
    context.config.envVars = { [keyEnv]: "sk-connection-key" };
    return openPiAgentSessionForContext(context, sessionId, {
      agentDir: buildBuiltInAgentDir(workingDirectory),
      sessionDir: buildBuiltInSessionDir(workingDirectory),
      isolateHostProviderEnv: true,
      exposeLaunchEnvToTools: false,
    });
  };
  try {
    serve((url) => (url === OPENROUTER_MODELS ? Response.json(OPENROUTER_LIST) : new Response("not found", { status: 404 })));
    const openrouter = await open("openrouter", "OPENROUTER_API_KEY", { kind: "custom", name: "acme/brand-new-model", maxOutputTokens: 4_096 }, "session-or-conn");
    try {
      const template = (await freshRegistry()).getAll().find((model) => model.provider === "openrouter")!;
      assert.equal(openrouter.session.model?.provider, "openrouter");
      assert.equal(openrouter.session.model?.id, "acme/brand-new-model");
      assert.equal(openrouter.session.model?.baseUrl, template.baseUrl, "the provider's own transport");
      assert.deepEqual(openrouter.modelLimits, {
        contextWindow: { value: 262_144, source: "gateway" },
        maxTokens: { value: 4_096, source: "agent_config" },
      });
      assert.deepEqual(requests, [{ url: OPENROUTER_MODELS, authorization: "Bearer sk-connection-key" }], "the key goes only to the provider");
    } finally {
      openrouter.session.dispose();
    }

    requests = [];
    const deepseek = await open("deepseek", "DEEPSEEK_API_KEY", { kind: "custom", name: "deepseek-v9", contextWindow: 128_000, maxOutputTokens: 16_000 }, "session-ds-conn");
    try {
      const template = (await freshRegistry()).getAll().find((model) => model.provider === "deepseek")!;
      assert.equal(deepseek.session.model?.provider, "deepseek");
      assert.equal(deepseek.session.model?.id, "deepseek-v9");
      assert.equal(deepseek.session.model?.baseUrl, template.baseUrl);
      assert.equal(deepseek.session.model?.api, template.api);
      assert.deepEqual(deepseek.modelLimits, {
        contextWindow: { value: 128_000, source: "agent_config" },
        maxTokens: { value: 16_000, source: "agent_config" },
      });
      assert.deepEqual(requests, [], "DeepSeek has no list Raft reads");
    } finally {
      deepseek.session.dispose();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
