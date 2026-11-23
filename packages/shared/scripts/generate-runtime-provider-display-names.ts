import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED } from "../src/piBuiltinModels.generated";

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

// Every provider Built-in surfaces (generated from the Pi SDK by
// `pnpm --filter @botiverse/raft-daemon generate:pi-builtin-models`; run that
// first) takes Pi's own provider name.
const PI_DISPLAY_NAME_PROVIDER_IDS = new Set(Object.keys(PI_BUILTIN_PROVIDER_API_KEY_ENV_KEYS_GENERATED));
const unnamed = [...PI_DISPLAY_NAME_PROVIDER_IDS].filter((id) => !piDisplayNames[id]);
if (unnamed.length > 0) {
  throw new Error(`Pi's provider catalog has no name for Built-in provider(s): ${unnamed.join(", ")}`);
}

const raw = JSON.parse(readFileSync(sourcePath, "utf8")) as Record<string, string>;
const displayNames = new Map(Object.entries(raw));
for (const id of PI_DISPLAY_NAME_PROVIDER_IDS) {
  displayNames.set(id, piDisplayNames[id]!);
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
    "// Source: Pi builtin provider catalog names of every Built-in provider + packages/shared/runtime-provider-display-names.json Slock-only entries",
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
