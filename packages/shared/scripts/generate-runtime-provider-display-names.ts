import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(root, "runtime-provider-display-names.json");
const outputPath = path.join(root, "src", "generated", "runtimeProviderDisplayNames.ts");
const piProvidersPath = path.join(
  root,
  "..",
  "daemon",
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "providers",
  "all.js",
);

interface PiProviderCatalogModule {
  builtinProviders(): Array<{ id: string; name: string }>;
}

const piProviders = (
  (await import(pathToFileURL(piProvidersPath).href)) as PiProviderCatalogModule
).builtinProviders();
const piDisplayNames = Object.fromEntries(piProviders.map(({ id, name }) => [id, name]));

const PI_DISPLAY_NAME_PROVIDER_IDS = new Set([
  "anthropic",
  "deepseek",
  "google",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "moonshotai",
  "moonshotai-cn",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "xai",
  "xiaomi",
  "zai",
  "zai-coding-cn",
]);

const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, string>;
const displayNames = new Map(Object.entries(raw));
for (const id of PI_DISPLAY_NAME_PROVIDER_IDS) {
  displayNames.set(id, piDisplayNames[id] ?? raw[id] ?? id);
}
const entries = [...displayNames.entries()].sort(([a], [b]) => a.localeCompare(b));

const body = entries
  .map(([id, label]) => `  ${JSON.stringify(id)}: ${JSON.stringify(label)},`)
  .join("\n");

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(
  outputPath,
  [
    "// GENERATED FILE - DO NOT EDIT DIRECTLY.",
    "// Source: selected Pi builtin provider catalog names + packages/shared/runtime-provider-display-names.json Slock-only entries",
    "// Regenerate: pnpm --filter @botiverse/raft-shared generate:runtime-provider-display-names",
    "",
    "export const RUNTIME_PROVIDER_DISPLAY_NAMES = {",
    body,
    "} as const;",
    "",
    "export type RuntimeProviderId = keyof typeof RUNTIME_PROVIDER_DISPLAY_NAMES;",
    "",
  ].join("\n"),
);
