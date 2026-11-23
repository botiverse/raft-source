/**
 * Generate `packages/shared/src/piBuiltinModels.generated.ts` from the Pi SDK.
 * Built-in (Raft's packaged Pi) surfaces every Pi provider whose sign-in is a
 * single API key: OAR's Pi provider list (`createPiProviderAuth().loginProviders()`)
 * says which providers take an API key, and running each one's API-key login
 * against a scratch `auth.json` counts its prompts. Models come from
 * `@earendil-works/pi-ai`'s model registry, the default model from
 * `@earendil-works/pi-coding-agent`'s `defaultModelPerProvider`, and the env
 * var from pi-ai's public `findEnvKeys`.
 *
 * A provider is surfaced when it has an API-key login with exactly one prompt
 * (the key), catalog models, a default model and an https base URL without
 * credential headers. Every other provider must be named, with its reason, in
 * `PI_EXCLUDED_PROVIDERS`; an unlisted provider that does not qualify, a
 * released provider that stops qualifying, or a surfaced set or key variable
 * other than `EXPECTED_SURFACED_PROVIDER_ENV_KEYS` fails the run, so a Pi bump
 * that adds or changes providers is reviewed rather than shipped silently.
 *
 * Why this exists: `pi-ai` is Node-only, so the web bundle can't import it
 * directly. Codegen at SDK-bump time gives us SDK fidelity without dragging
 * Node deps into the browser. Locked path B per @tygg #proj-runtime
 * msg=9bfb3fb3 (codegen preferred over a runtime endpoint).
 *
 * Run:
 *   pnpm --filter @botiverse/raft-daemon generate:pi-builtin-models
 *   pnpm --filter @botiverse/raft-shared generate:runtime-provider-display-names
 * (the second reads this output for the provider names).
 *
 * CI gate (companion script):
 *   pnpm --filter @botiverse/raft-daemon check:pi-builtin-models-fresh
 * It runs only in the full Test workflow (integration-contracts, on staging
 * pushes), not on PRs: rerun the generator in the PR that bumps Pi.
 *
 * Do not edit `packages/shared/src/piBuiltinModels.generated.ts` directly —
 * edit the tables below + rerun this script.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LoginProvider, ProviderAuthFacade, ProviderLoginPrompt } from "@botiverse/oar";

/**
 * Pi providers Built-in does not surface, each with the reason. Every provider
 * OAR lists is either surfaced or named here.
 */
const PI_EXCLUDED_PROVIDERS: Readonly<Record<string, string>> = {
  "openai-codex": "OAuth sign-in only; there is no API key to enter",
  "amazon-bedrock": "multi-field credential (asks which AWS credential first); out of scope",
  "google-vertex": "multi-field credential (asks API key or ADC first, then project/location); out of scope",
  "cloudflare-workers-ai": "multi-field credential (asks the account id after the key); out of scope",
  "cloudflare-ai-gateway": "multi-field credential (asks account and gateway ids after the key); out of scope",
  azure: "multi-field credential (needs a resource/base URL besides the key; its catalog has none); out of scope",
  typesafe: "Pi ships no catalog models for it",
  "github-copilot": "a Copilot subscription token sent with fixed editor headers, not an API key",
  radius: "the account's gateway catalog replaces Pi's shipped list, so the models shown would be wrong",
  // Built-in owns every surfaced provider's key variable and strips it from an
  // agent's saved Environment Variables; HF_TOKEN is widely set for the agent's
  // own Hugging Face tools, so surfacing it would silently remove it there.
  huggingface: "its key variable HF_TOKEN is commonly set for an agent's own tools; making it Raft-owned would strip it from existing agents",
};

/**
 * Providers whose Raft env var is not Pi's only one. Anthropic: Pi also lists
 * ANTHROPIC_AUTH_TOKEN and ANTHROPIC_OAUTH_TOKEN; Raft has always materialized
 * the key as ANTHROPIC_API_KEY (and blocks the host's OAuth token).
 */
const PI_PROVIDER_ENV_OVERRIDES: Readonly<Record<string, { apiKeyEnvKey: string; blockedHostEnvKeys: readonly string[] }>> = {
  anthropic: { apiKeyEnvKey: "ANTHROPIC_API_KEY", blockedHostEnvKeys: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
};

/**
 * Providers Built-in already offered before it surfaced every API-key
 * provider, in their form order (the first is the form's default provider).
 * Stored agents use them, so one that stops qualifying fails the run. Newer
 * providers follow, sorted by id.
 */
const RELEASED_PROVIDER_ORDER = [
  "deepseek",
  "minimax",
  "minimax-cn",
  "zai",
  "zai-coding-cn",
  "moonshotai",
  "moonshotai-cn",
  "kimi-coding",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "openrouter",
  "openai",
  "anthropic",
  "google",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-ams",
] as const;

/**
 * The surfaced providers and the key variable Raft owns for each, as last
 * reviewed. A Pi bump that adds, drops or renames any fails the run: each new
 * key variable becomes Built-in-owned (stripped from agents' saved env vars),
 * so it needs a look before it ships.
 */
const EXPECTED_SURFACED_PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  "deepseek": "DEEPSEEK_API_KEY",
  "minimax": "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  "zai": "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  "moonshotai": "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "openrouter": "OPENROUTER_API_KEY",
  "openai": "OPENAI_API_KEY",
  "anthropic": "ANTHROPIC_API_KEY",
  "google": "GEMINI_API_KEY",
  "xai": "XAI_API_KEY",
  "xiaomi": "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "ant-ling": "ANT_LING_API_KEY",
  "baseten": "BASETEN_API_KEY",
  "cerebras": "CEREBRAS_API_KEY",
  "fireworks": "FIREWORKS_API_KEY",
  "groq": "GROQ_API_KEY",
  "meta": "META_API_KEY",
  "mistral": "MISTRAL_API_KEY",
  "nvidia": "NVIDIA_API_KEY",
  "opencode": "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-individual-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "together": "TOGETHER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
};

interface GeneratedProvider {
  providerId: string;
  apiKeyEnvKey: string;
  blockedHostEnvKeys: readonly string[];
  defaultModelId: string;
  connectionProbe: {
    api: string;
    baseUrl: string;
    headers: Record<string, string>;
  };
  /**
   * Every catalog model of the provider uses one api, base URL and static
   * headers: a model id outside the catalog can run on that same transport.
   */
  uniformTransport: boolean;
  /** Every catalog model of the provider reasons: a typed model id is registered with reasoning on. */
  allModelsReason: boolean;
  models: GeneratedModel[];
}

interface GeneratedModel {
  id: string;
  label: string;
}

interface PiSdkModel {
  id: string;
  name?: string;
  provider: string;
  api: string;
  baseUrl: string;
  headers?: Record<string, string>;
  reasoning?: boolean;
}

type PiSdkModelsByProvider = Record<string, Record<string, PiSdkModel>>;

interface PiSdkVersions {
  piAi: string;
  piCodingAgent: string;
  oar: string;
}

function loadPackageVersion(packageName: "@earendil-works/pi-ai" | "@earendil-works/pi-coding-agent" | "@botiverse/oar"): string {
  const entryPath = fileURLToPath(import.meta.resolve(packageName));
  const packageJsonPath = resolve(dirname(entryPath), "..", "package.json");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`${packageName} package.json has no valid version`);
  }
  return manifest.version;
}

function loadPiSdkVersions(): PiSdkVersions {
  return {
    piAi: loadPackageVersion("@earendil-works/pi-ai"),
    piCodingAgent: loadPackageVersion("@earendil-works/pi-coding-agent"),
    oar: loadPackageVersion("@botiverse/oar"),
  };
}

function modelSortKey(model: GeneratedModel): string {
  return `${model.id} ${model.label}`.toLowerCase();
}

function maxVersionScore(input: string): number {
  const matches = input.match(/\d+(?:[._-]\d+)*/g) ?? [];
  let best = 0;
  for (const match of matches) {
    const normalized = match.replace(/[_-]/g, ".");
    const parts = normalized.split(".").map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
    if (parts.length === 0) continue;
    const score = parts.reduce((sum, part, index) => sum + part / (100 ** index), 0);
    if (score > best) best = score;
  }
  return best;
}

function capabilityScore(input: string): number {
  const text = input.toLowerCase();
  let score = 0;

  if (/\bfable\b/.test(text) || /\bmythos\b/.test(text)) score += 900;
  if (/\bopus\b/.test(text)) score += 800;
  if (/\bsonnet\b/.test(text)) score += 650;
  if (/\bhaiku\b/.test(text)) score += 400;

  if (/\bpro\b/.test(text) || /\bmax\b/.test(text) || /\bultra\b/.test(text) || /\bpremier\b/.test(text)) score += 180;
  if (/\bcoder?\b/.test(text) || /\bcoding\b/.test(text) || /\bcodex\b/.test(text)) score += 120;
  if (/\bthinking\b/.test(text) || /\breasoning\b/.test(text)) score += 90;
  if (/\blarge\b/.test(text) || /\bsuper\b/.test(text)) score += 70;

  if (/\bfast\b/.test(text) || /\bflash\b/.test(text) || /\bturbo\b/.test(text) || /\bhighspeed\b/.test(text)) score -= 35;
  if (/\blite\b/.test(text) || /\bmini\b/.test(text) || /\bnano\b/.test(text) || /\bmicro\b/.test(text)) score -= 90;
  if (/\bfree\b/.test(text)) score -= 120;

  return score;
}

function comparePiModelsByStrength(left: GeneratedModel, right: GeneratedModel): number {
  const leftKey = modelSortKey(left);
  const rightKey = modelSortKey(right);
  const leftScore = capabilityScore(leftKey);
  const rightScore = capabilityScore(rightKey);
  if (leftScore !== rightScore) return rightScore - leftScore;

  const leftVersion = maxVersionScore(leftKey);
  const rightVersion = maxVersionScore(rightKey);
  if (leftVersion !== rightVersion) return rightVersion - leftVersion;

  return left.label.localeCompare(right.label) || left.id.localeCompare(right.id);
}

async function loadPiDefaultModelPerProvider(): Promise<Record<string, string>> {
  // Pi's default map is exported by its built artifact but not by the package's
  // top-level barrel. Keep this deep import confined to daemon-side codegen so
  // shared/web runtime code never depends on unpublished Pi internals.
  const piEntryUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
  const piEntryPath = fileURLToPath(piEntryUrl);
  const resolverUrl = pathToFileURL(resolve(dirname(piEntryPath), "core", "model-resolver.js")).href;
  const module = await import(resolverUrl) as { defaultModelPerProvider?: Record<string, string> };
  if (!module.defaultModelPerProvider) {
    throw new Error("Pi SDK no longer exposes defaultModelPerProvider from its model resolver artifact");
  }
  return module.defaultModelPerProvider;
}

async function loadPiModelsByProvider(): Promise<PiSdkModelsByProvider> {
  // Pi's generated model registry is not exported from its package barrel.
  // Import it only for daemon-side codegen, keeping shared/web runtime code
  // on generated constants instead of unpublished Pi internals.
  const piEntryUrl = import.meta.resolve("@earendil-works/pi-ai");
  const piEntryPath = fileURLToPath(piEntryUrl);
  const modelsUrl = pathToFileURL(resolve(dirname(piEntryPath), "models.generated.js")).href;
  const module = await import(modelsUrl) as { MODELS?: PiSdkModelsByProvider };
  if (!module.MODELS) {
    throw new Error("Pi SDK no longer exposes MODELS from its generated model registry artifact");
  }
  return module.MODELS;
}

function buildModelList(
  providerId: string,
  defaultModelId: string,
  modelsByProvider: PiSdkModelsByProvider,
): GeneratedModel[] {
  // Compose the Pi-style `<provider>/<modelId>` form so the result works with
  // detectPiModelsFromRegistry's existing `id` shape, and use `model.name` as
  // the human label (already brand-cased, e.g. "DeepSeek V4 Pro").
  const sdkModels = Object.values(modelsByProvider[providerId] ?? {});
  const list: GeneratedModel[] = sdkModels.map((m) => ({
    id: `${m.provider}/${m.id}`,
    label: m.name ?? m.id,
  }));
  // The UI list is sorted by a stable "newer/stronger first" heuristic so
  // users are not forced to scroll through older/cheaper models before seeing
  // current frontier options. The SDK default is emitted separately below and
  // remains the provider preset; display order is not default authority.
  list.sort(comparePiModelsByStrength);
  const defaultIdx = list.findIndex((m) => m.id === `${providerId}/${defaultModelId}`);
  if (defaultIdx < 0) {
    throw new Error(
      `Pi SDK no longer exposes default model ${providerId}/${defaultModelId}; ` +
      "check @earendil-works/pi-coding-agent's defaultModelPerProvider.",
    );
  }
  return list;
}

/**
 * The prompts a provider's API-key login asks, run against a throwaway
 * `auth.json`: the key prompt is answered with a placeholder and a second
 * prompt stops the flow (so the count tops out at 2). No network: the facade
 * runs with model network off and an API-key login only stores the key.
 */
async function countApiKeyLoginPrompts(auth: ProviderAuthFacade, providerId: string): Promise<{ count: number; kinds: string[] }> {
  const kinds: string[] = [];
  const stop = new Error("second prompt");
  try {
    await auth.login(providerId, "api_key", {
      onEvent: () => {
        // An API-key login surfaces no URL or device code worth recording here.
      },
      prompt: async (prompt: ProviderLoginPrompt) => {
        await Promise.resolve();
        kinds.push(prompt.kind);
        if (kinds.length > 1) throw stop;
        return prompt.kind === "select" ? prompt.options[0]?.id ?? "" : "raft-codegen-placeholder";
      },
    });
  } catch (error) {
    if (error !== stop) throw new Error(`Pi API-key login for ${providerId} failed during codegen: ${String(error)}`);
  }
  return { count: kinds.length, kinds };
}

/** OAR's Pi provider list, read on a scratch agent dir so the host's Pi config never leaks in. */
async function loadPiLoginProviders(): Promise<{ providers: readonly LoginProvider[]; auth: ProviderAuthFacade; cleanup: () => void }> {
  const scratch = mkdtempSync(join(tmpdir(), "raft-pi-builtin-codegen-"));
  process.env.OAR_PI_AGENT_DIR = scratch;
  const { createPiProviderAuth } = await import("@botiverse/oar/runtimes/pi");
  const auth = await createPiProviderAuth({ authPath: join(scratch, "auth.json"), modelsPath: null });
  return { providers: auth.loginProviders(), auth, cleanup: () => rmSync(scratch, { recursive: true, force: true }) };
}

async function loadFindEnvKeys(): Promise<(providerId: string) => string[]> {
  const { findEnvKeys } = await import("@earendil-works/pi-ai/compat");
  // findEnvKeys only reports keys present in `env`; an env reporting every key
  // set yields all the env vars Pi reads for the provider.
  const everyKeySet = new Proxy({} as Record<string, string>, { get: () => "set", has: () => true });
  return (providerId) => findEnvKeys(providerId, everyKeySet) ?? [];
}

/** Why a provider cannot be surfaced, or null when it qualifies. */
async function disqualification(
  provider: LoginProvider,
  auth: ProviderAuthFacade,
  defaultModelPerProvider: Record<string, string>,
  modelsByProvider: PiSdkModelsByProvider,
): Promise<string | null> {
  const apiKey = provider.methods.find((method) => method.method === "api_key");
  if (!apiKey) return "no API-key login";
  if ("ambient" in apiKey && apiKey.ambient) return "API key is configured outside Pi (no login prompt)";
  const prompts = await countApiKeyLoginPrompts(auth, provider.providerId);
  if (prompts.count !== 1 || prompts.kinds[0] !== "secret") {
    return `API-key login asks ${prompts.count === 1 ? "one" : "more than one"} prompt (${prompts.kinds.join(", ")}), not just the key`;
  }
  if (Object.keys(modelsByProvider[provider.providerId] ?? {}).length === 0) return "no catalog models";
  const defaultModelId = defaultModelPerProvider[provider.providerId];
  if (!defaultModelId) return "no defaultModelPerProvider entry";
  const defaultModel = modelsByProvider[provider.providerId]?.[defaultModelId];
  if (!defaultModel?.api || !defaultModel.baseUrl) return `default model ${defaultModelId} has no API/base URL`;
  return null;
}

async function buildProviders(): Promise<GeneratedProvider[]> {
  const defaultModelPerProvider = await loadPiDefaultModelPerProvider();
  const modelsByProvider = await loadPiModelsByProvider();
  const envKeysOf = await loadFindEnvKeys();
  const { providers: loginProviders, auth, cleanup } = await loadPiLoginProviders();
  const surfacedIds: string[] = [];
  try {
    const listedIds = new Set(loginProviders.map((provider) => provider.providerId));
    for (const excludedId of Object.keys(PI_EXCLUDED_PROVIDERS)) {
      if (!listedIds.has(excludedId)) {
        throw new Error(`PI_EXCLUDED_PROVIDERS names ${excludedId}, which OAR's Pi provider list no longer has; drop it`);
      }
    }
    for (const provider of loginProviders) {
      if (Object.hasOwn(PI_EXCLUDED_PROVIDERS, provider.providerId)) continue;
      const reason = await disqualification(provider, auth, defaultModelPerProvider, modelsByProvider);
      if (reason) {
        throw new Error(
          `Pi provider ${provider.providerId} (${provider.name}) cannot be surfaced: ${reason}. `
          + "Review it and add it to PI_EXCLUDED_PROVIDERS with the reason, or make it qualify.",
        );
      }
      surfacedIds.push(provider.providerId);
    }
  } finally {
    cleanup();
  }

  const released: readonly string[] = RELEASED_PROVIDER_ORDER;
  for (const releasedId of released) {
    if (!surfacedIds.includes(releasedId)) {
      throw new Error(`Released Built-in provider ${releasedId} no longer qualifies; stored agents use it`);
    }
  }
  const orderedIds = [
    ...released,
    ...surfacedIds.filter((id) => !released.includes(id)).sort((left, right) => left.localeCompare(right)),
  ];
  const expectedIds = Object.keys(EXPECTED_SURFACED_PROVIDER_ENV_KEYS).sort();
  if ([...orderedIds].sort().join(",") !== expectedIds.join(",")) {
    throw new Error(
      `Surfaced Pi providers changed: ${orderedIds.join(", ")} (expected ${expectedIds.join(", ")}). `
      + "Review the providers the Pi bump added or dropped, then update EXPECTED_SURFACED_PROVIDER_ENV_KEYS.",
    );
  }

  const providers: GeneratedProvider[] = [];
  for (const providerId of orderedIds) {
    const defaultModelId = defaultModelPerProvider[providerId]!;
    const piEnvKeys = envKeysOf(providerId);
    const override = PI_PROVIDER_ENV_OVERRIDES[providerId];
    if (override && !piEnvKeys.includes(override.apiKeyEnvKey)) {
      throw new Error(`Pi no longer reads ${override.apiKeyEnvKey} for ${providerId} (it reads ${piEnvKeys.join(", ") || "none"})`);
    }
    if (!override && piEnvKeys.length !== 1) {
      throw new Error(
        `Pi reads ${piEnvKeys.length} env vars for ${providerId} (${piEnvKeys.join(", ")}); `
        + "pick Raft's in PI_PROVIDER_ENV_OVERRIDES",
      );
    }
    const apiKeyEnvKey = override?.apiKeyEnvKey ?? piEnvKeys[0]!;
    if (apiKeyEnvKey !== EXPECTED_SURFACED_PROVIDER_ENV_KEYS[providerId]) {
      throw new Error(
        `${providerId} key variable is ${apiKeyEnvKey}, expected ${EXPECTED_SURFACED_PROVIDER_ENV_KEYS[providerId]}; `
        + "review it (it becomes Built-in-owned), then update EXPECTED_SURFACED_PROVIDER_ENV_KEYS.",
      );
    }
    const blockedHostEnvKeys = override?.blockedHostEnvKeys ?? [apiKeyEnvKey];
    const models = buildModelList(providerId, defaultModelId, modelsByProvider);
    if (models.length === 0) {
      throw new Error(`No SDK models found for Pi provider ${providerId}`);
    }
    const defaultModel = modelsByProvider[providerId]![defaultModelId]!;
    const probeUrl = new URL(defaultModel.baseUrl);
    if (
      probeUrl.protocol !== "https:"
      || probeUrl.username
      || probeUrl.password
      || probeUrl.search
      || probeUrl.hash
    ) {
      throw new Error(`Pi SDK default model ${providerId}/${defaultModelId} has an unsafe connection probe URL`);
    }
    const probeHeaders = defaultModel.headers ?? {};
    if (Object.keys(probeHeaders).some((key) => /authorization|api[-_]?key|token/iu.test(key))) {
      throw new Error(`Pi SDK default model ${providerId}/${defaultModelId} exposes credential-bearing static headers`);
    }
    const transports = new Set(Object.values(modelsByProvider[providerId] ?? {}).map((model) =>
      JSON.stringify([model.api, model.baseUrl, Object.entries(model.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))])));
    providers.push({
      providerId,
      apiKeyEnvKey,
      blockedHostEnvKeys,
      defaultModelId: `${providerId}/${defaultModelId}`,
      connectionProbe: {
        api: defaultModel.api,
        baseUrl: defaultModel.baseUrl,
        headers: probeHeaders,
      },
      uniformTransport: transports.size === 1,
      allModelsReason: Object.values(modelsByProvider[providerId] ?? {}).every((model) => model.reasoning === true),
      models,
    });
  }
  return providers;
}

function buildSource(providers: readonly GeneratedProvider[], versions: PiSdkVersions): string {
  const modelBlocks: string[] = [];
  const apiKeyEnvEntries: string[] = [];
  const blockedHostEnvEntries: string[] = [];
  const defaultModelEntries: string[] = [];
  const connectionProbeEntries: string[] = [];
  for (const provider of providers) {
    const { providerId, apiKeyEnvKey, blockedHostEnvKeys, defaultModelId, connectionProbe, models } = provider;
    const entries = models.map((m) => `    { id: ${JSON.stringify(m.id)}, label: ${JSON.stringify(m.label)} },`);
    modelBlocks.push(`  ${JSON.stringify(providerId)}: [\n${entries.join("\n")}\n  ],`);
    apiKeyEnvEntries.push(`  ${JSON.stringify(providerId)}: ${JSON.stringify(apiKeyEnvKey)},`);
    blockedHostEnvEntries.push(
      `  ${JSON.stringify(providerId)}: [${blockedHostEnvKeys.map((key) => JSON.stringify(key)).join(", ")}],`,
    );
    defaultModelEntries.push(`  ${JSON.stringify(providerId)}: ${JSON.stringify(defaultModelId)},`);
    connectionProbeEntries.push(`  ${JSON.stringify(providerId)}: ${JSON.stringify(connectionProbe)},`);
  }
  return [
    "// Auto-generated by `pnpm --filter @botiverse/raft-daemon generate:pi-builtin-models`.",
    "// Do NOT edit by hand. Source:",
    "// - @earendil-works/pi-ai generated model registry",
    "// - @earendil-works/pi-coding-agent defaultModelPerProvider",
    "// - @botiverse/oar Pi provider list (every provider whose sign-in is a single API key)",
    "// - @earendil-works/pi-ai findEnvKeys (provider env vars)",
    `// Pi SDK versions: @earendil-works/pi-ai ${versions.piAi}; @earendil-works/pi-coding-agent ${versions.piCodingAgent}; @botiverse/oar ${versions.oar}.`,
    "// Regenerate after any Pi SDK bump that affects exposed provider/model metadata.",
    "//",
    "// CI gate (check:pi-builtin-models-fresh) keeps this in sync with the SDK by",
    "// re-running the generator and failing on `git diff` drift. It runs only in",
    "// the full Test workflow, not on PRs: rerun the generator in the PR that bumps",
    "// Pi. A provider leaving PI_BUILTIN_UNIFORM_TRANSPORT_PROVIDER_IDS_GENERATED",
    "// stops taking typed model ids (stored ones would no longer parse); the floor",
    "// test in shared runtimeConfig.test.ts fails then.",
    "",
    "export interface PiBuiltinModel {",
    "  id: string;",
    "  label: string;",
    "}",
    "",
    "export const PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED = {",
    ...apiKeyEnvEntries,
    "} as const;",
    "",
    "export const PI_BUILTIN_PROVIDER_BLOCKED_HOST_ENV_KEYS_GENERATED = {",
    ...blockedHostEnvEntries,
    "} as const;",
    "",
    "export const PI_BUILTIN_PROVIDER_DEFAULT_MODELS_GENERATED = {",
    ...defaultModelEntries,
    "} as const;",
    "",
    "export const PI_BUILTIN_PROVIDER_CONNECTION_PROBES_GENERATED = {",
    ...connectionProbeEntries,
    "} as const;",
    "",
    "export const PI_BUILTIN_PROVIDER_MODELS_GENERATED: Record<string, ReadonlyArray<PiBuiltinModel>> = {",
    ...modelBlocks,
    "};",
    "",
    "// Providers whose catalog models all share one api, base URL and static",
    "// headers: a typed model id outside the catalog runs on that transport.",
    "export const PI_BUILTIN_UNIFORM_TRANSPORT_PROVIDER_IDS_GENERATED = [",
    ...providers.filter((provider) => provider.uniformTransport).map((provider) => `  ${JSON.stringify(provider.providerId)},`),
    "] as const;",
    "",
    "// Providers every catalog model of which reasons: a typed model id on one of",
    "// them is registered with reasoning on (and takes a reasoning effort).",
    "export const PI_BUILTIN_ALL_REASONING_PROVIDER_IDS_GENERATED = [",
    ...providers.filter((provider) => provider.allModelsReason).map((provider) => `  ${JSON.stringify(provider.providerId)},`),
    "] as const;",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const here = resolve(fileURLToPath(import.meta.url), "..");
  const outPath = resolve(here, "..", "..", "shared", "src", "piBuiltinModels.generated.ts");
  const source = buildSource(await buildProviders(), loadPiSdkVersions());
  writeFileSync(outPath, source, "utf8");
  console.log(`Wrote ${outPath}`);
}

await main();
