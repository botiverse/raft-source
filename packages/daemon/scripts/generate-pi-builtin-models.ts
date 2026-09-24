/**
 * Generate `packages/shared/src/piBuiltinModels.generated.ts` from the
 * `@earendil-works/pi-ai` SDK. The Pi SDK's model registry is the source of
 * truth for Pi-builtin provider model lists; we mirror a curated subset (the
 * providers we surface in the
 * create-agent UI per `BUILTIN_RUNTIME_PROVIDERS` in shared) into a
 * web-importable constant.
 *
 * Why this exists: `pi-ai` is Node-only, so the web bundle can't import it
 * directly. Codegen at SDK-bump time gives us SDK fidelity without dragging
 * Node deps into the browser. Locked path B per @tygg #proj-runtime
 * msg=9bfb3fb3 (codegen preferred over a runtime endpoint).
 *
 * Run:
 *   pnpm --filter @botiverse/raft-daemon generate:pi-builtin-models
 *
 * CI gate (companion script):
 *   pnpm --filter @botiverse/raft-daemon check:pi-builtin-models-fresh
 *
 * Do not edit `packages/shared/src/piBuiltinModels.generated.ts` directly —
 * edit `PI_SURFACED_PROVIDERS` below + rerun this script.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Providers we surface in the Built-in/Quick Start create-agent UI.
//
// Provider API-key env names are verified against Pi 0.80.10 internal source
// `@earendil-works/pi-ai/dist/env-api-keys.js#getApiKeyEnvVars`. Pi does not
// expose a public raw `getApiKeyEnvVars(provider)` API yet. Its public
// `findEnvKeys(provider, env)` is presence-filtered and cannot safely generate
// a scrub table because unset host keys must still be blocked. Keep this as the
// single local mirror until Pi exports provider env metadata.
// TODO: switch this to codegen-read once Pi exports `getApiKeyEnvVars` or the
// canonical provider env map.
const PI_SURFACED_PROVIDER_ENVS = {
  deepseek: { apiKeyEnvKey: "DEEPSEEK_API_KEY" },
  minimax: { apiKeyEnvKey: "MINIMAX_API_KEY" },
  "minimax-cn": { apiKeyEnvKey: "MINIMAX_CN_API_KEY" },
  zai: { apiKeyEnvKey: "ZAI_API_KEY" },
  "zai-coding-cn": { apiKeyEnvKey: "ZAI_CODING_CN_API_KEY" },
  moonshotai: { apiKeyEnvKey: "MOONSHOT_API_KEY" },
  "moonshotai-cn": { apiKeyEnvKey: "MOONSHOT_API_KEY" },
  "kimi-coding": { apiKeyEnvKey: "KIMI_API_KEY" },
  "qwen-token-plan": { apiKeyEnvKey: "QWEN_TOKEN_PLAN_API_KEY" },
  "qwen-token-plan-cn": { apiKeyEnvKey: "QWEN_TOKEN_PLAN_CN_API_KEY" },
  openrouter: { apiKeyEnvKey: "OPENROUTER_API_KEY" },
  openai: { apiKeyEnvKey: "OPENAI_API_KEY" },
  anthropic: { apiKeyEnvKey: "ANTHROPIC_API_KEY", blockedHostEnvKeys: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] },
  google: { apiKeyEnvKey: "GEMINI_API_KEY" },
  xai: { apiKeyEnvKey: "XAI_API_KEY" },
  xiaomi: { apiKeyEnvKey: "XIAOMI_API_KEY" },
} as const satisfies Record<string, { apiKeyEnvKey: string; blockedHostEnvKeys?: readonly string[] }>;

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
}

type PiSdkModelsByProvider = Record<string, Record<string, PiSdkModel>>;

interface PiSdkVersions {
  piAi: string;
  piCodingAgent: string;
}

function loadPackageVersion(packageName: "@earendil-works/pi-ai" | "@earendil-works/pi-coding-agent"): string {
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

async function buildProviders(): Promise<GeneratedProvider[]> {
  const defaultModelPerProvider = await loadPiDefaultModelPerProvider();
  const modelsByProvider = await loadPiModelsByProvider();
  const providers: GeneratedProvider[] = [];
  for (const [providerId, envConfig] of Object.entries(PI_SURFACED_PROVIDER_ENVS)) {
    const defaultModelId = defaultModelPerProvider[providerId];
    if (!defaultModelId) {
      throw new Error(`Pi SDK has no defaultModelPerProvider entry for surfaced provider ${providerId}`);
    }
    const apiKeyEnvKey = envConfig.apiKeyEnvKey;
    const blockedHostEnvKeys = envConfig.blockedHostEnvKeys ?? [apiKeyEnvKey];
    const models = buildModelList(providerId, defaultModelId, modelsByProvider);
    if (models.length === 0) {
      throw new Error(`No SDK models found for Pi provider ${providerId}`);
    }
    const defaultModel = modelsByProvider[providerId]?.[defaultModelId];
    if (!defaultModel?.api || !defaultModel.baseUrl) {
      throw new Error(`Pi SDK default model ${providerId}/${defaultModelId} has no API/base URL probe metadata`);
    }
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
    `// Pi SDK versions: @earendil-works/pi-ai ${versions.piAi}; @earendil-works/pi-coding-agent ${versions.piCodingAgent}.`,
    "// - local provider env mirror copied from Pi getApiKeyEnvVars until Pi exports raw provider env metadata",
    "// TODO: switch provider env metadata to codegen-read once Pi exports getApiKeyEnvVars.",
    "// Regenerate after any Pi SDK bump that affects exposed provider/model metadata.",
    "//",
    "// CI gate keeps this in sync with the SDK by re-running the generator and",
    "// failing on `git diff` drift.",
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
