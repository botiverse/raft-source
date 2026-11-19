import path from "node:path";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { agentStateFile, readPlainSmallFile, writeAgentStateText } from "../agentStateFiles";

/**
 * A Built-in agent's `.builtin-runtime/models.json` is in its workspace: the
 * agent writes it (the "Model limits" note tells it to). Pi applies the whole
 * file over its catalog: a provider-level `baseUrl` moves every catalog model
 * of that provider, `headers` resolve `$VAR` against the daemon's env and run
 * `!command` in the daemon, and Raft then sends the provider key it seeded to
 * wherever the model points. So Pi never reads that file. Raft reads it, keeps
 * only `providers.<id>.modelOverrides.<model>` limits and model metadata, and
 * gives Pi a copy in the daemon's own per-agent state (agentStateFiles.ts),
 * outside the workspace; Pi re-reads that copy on every refresh.
 */

/** The `modelOverrides` fields passed on to Pi: limits and model metadata only. */
export const PI_MODEL_OVERRIDE_KEPT_FIELDS = [
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "inputLimits",
  "cost",
  "promptCache",
  "contextWindow",
  "maxTokens",
] as const;

/** The daemon-owned copy Pi reads, in the agent's state directory. */
export const BUILTIN_FILTERED_MODELS_JSON_NAME = "builtin-runtime-models.json";
const MODELS_JSON_MAX_BYTES = 1024 * 1024;

export type FilteredPiModelsJson = {
  providers: Record<string, { modelOverrides: Record<string, Record<string, unknown>> }>;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const KEPT_FIELD_CHECKS: Record<(typeof PI_MODEL_OVERRIDE_KEPT_FIELDS)[number], (value: unknown) => boolean> = {
  name: (value) => typeof value === "string" && value.length > 0,
  reasoning: (value) => typeof value === "boolean",
  thinkingLevelMap: isPlainObject,
  input: (value) => Array.isArray(value) && value.every((entry) => entry === "text" || entry === "image"),
  inputLimits: isPlainObject,
  cost: isPlainObject,
  promptCache: isPlainObject,
  contextWindow: (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  maxTokens: (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
};

/**
 * What of a parsed models.json Pi may see: per provider, the `modelOverrides`
 * entries' kept fields of the right type. Everything else (provider `baseUrl`,
 * `headers`, `apiKey`, `api`, `authHeader`, `oauth`, `compat`, `models`; an
 * override's `headers`, `compat`, `samplingParams*` and any unknown field) is
 * dropped. Providers and overrides left empty are dropped too.
 */
export function filterPiModelsJson(parsed: unknown): FilteredPiModelsJson {
  const providers: FilteredPiModelsJson["providers"] = {};
  if (!isPlainObject(parsed) || !isPlainObject(parsed.providers)) return { providers };
  const kept: Array<[string, { modelOverrides: Record<string, Record<string, unknown>> }]> = [];
  for (const [providerId, provider] of Object.entries(parsed.providers)) {
    if (!isPlainObject(provider) || !isPlainObject(provider.modelOverrides)) continue;
    const overrides: Array<[string, Record<string, unknown>]> = [];
    for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
      if (!isPlainObject(override)) continue;
      const fields = PI_MODEL_OVERRIDE_KEPT_FIELDS
        .filter((field) => Object.hasOwn(override, field) && KEPT_FIELD_CHECKS[field](override[field]))
        .map((field) => [field, override[field]] as const);
      // fromEntries defines own properties: an id such as "__proto__" stays a key.
      if (fields.length > 0) overrides.push([modelId, Object.fromEntries(fields)]);
    }
    if (overrides.length > 0) kept.push([providerId, { modelOverrides: Object.fromEntries(overrides) }]);
  }
  return { providers: Object.fromEntries(kept) };
}

/** Pi's own models.json parsing: a BOM, `//` comments and trailing commas are accepted (pi-coding-agent utils/json.js). */
function parsePiJson(text: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const stripped = withoutBom
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === "\"" ? match : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === "\"" ? match : ""));
  return JSON.parse(stripped);
}

/** The agent's models.json, filtered; empty when it is missing, not a plain file, too large or not JSON. */
export function readFilteredPiModelsJson(file: string): FilteredPiModelsJson {
  const text = readPlainSmallFile(file, MODELS_JSON_MAX_BYTES);
  if (text === null) return { providers: {} };
  try {
    return filterPiModelsJson(parsePiJson(text));
  } catch {
    return { providers: {} };
  }
}

/**
 * Write the filtered copy of the workspace's models.json for this agent and
 * return its path, for Pi's `modelsPath`. Called at every session build, so an
 * edit to the workspace file applies from the agent's next start, as before.
 */
export function syncBuiltInFilteredModelsJson(workspaceModelsJson: string, agentsDir: string, agentId: string): string {
  const target = agentStateFile(agentsDir, agentId, BUILTIN_FILTERED_MODELS_JSON_NAME);
  writeAgentStateText(target, `${JSON.stringify(readFilteredPiModelsJson(workspaceModelsJson), null, 2)}\n`);
  return target;
}

/** The daemon's records dir for a workspace: every host lays workspaces out as `<agents dir>/<agentId>`. */
export function agentsDirOfWorkspace(workingDirectory: string): string {
  return path.dirname(path.resolve(workingDirectory));
}

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** The origins Pi's static catalog runs a provider's models on; empty for a provider it does not list. */
export function piCatalogProviderOrigins(providerId: string): ReadonlySet<string> {
  const models = getBuiltinModels(providerId as Parameters<typeof getBuiltinModels>[0]) as ReadonlyArray<{ baseUrl: string }>;
  return new Set(models.map((model) => originOf(model.baseUrl)).filter((origin): origin is string => origin !== null));
}

export function piBaseUrlOrigin(baseUrl: string): string | null {
  return originOf(baseUrl);
}

/** A Built-in model whose transport is not its provider's own endpoint: the start is refused before any request. */
export class BuiltInModelTransportMismatchError extends Error {
  constructor(input: { provider: string; modelId: string; origin: string | null; expected: readonly string[] }) {
    super(
      `Raft refused to start the model ${input.provider}/${input.modelId}: it would send the provider key to `
      + `${input.origin ?? "an invalid base URL"}, not to ${input.expected.length > 0 ? input.expected.join(" or ") : "a known endpoint of the provider"}. `
      + "Built-in agents cannot change a provider's endpoint, headers or credentials in .builtin-runtime/models.json; only modelOverrides limits and metadata apply.",
    );
    this.name = "BuiltInModelTransportMismatchError";
  }
}

/** Throws BuiltInModelTransportMismatchError unless the model's base URL origin is one of `allowed`. */
export function assertBuiltInModelTransport(
  model: { provider: string; id: string; baseUrl: string },
  allowed: ReadonlySet<string>,
): void {
  const origin = originOf(model.baseUrl);
  if (origin !== null && allowed.has(origin)) return;
  throw new BuiltInModelTransportMismatchError({ provider: model.provider, modelId: model.id, origin, expected: [...allowed] });
}
