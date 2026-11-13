import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { bareRegistrationsReadWithEmptyFallback } from "./registeredVarFallbacks";

// No built stylesheet may read a bare-registered custom property with an empty
// fallback: Chromium 111 to 118 drop such a declaration, and with it every
// ring, the shadow beside it, filters and tabular numbers
// (scripts/registeredVarFallbacks.ts, #triage:#322). The build's plugin takes
// them out; this fails the build when a stylesheet got past it (a new build
// config without the plugin, a Tailwind that writes the rules another way).

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const distRoot = join(webRoot, "dist");

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const hits: string[] = [];
let checked = 0;
for await (const file of walk(distRoot)) {
  if (!file.endsWith(".css")) continue;
  checked += 1;
  const names = bareRegistrationsReadWithEmptyFallback(await readFile(file, "utf8"));
  if (names.length > 0) hits.push(`${relative(webRoot, file)}: ${names.join(", ")}`);
}

if (hits.length > 0) {
  console.error("[registered-var-fallbacks] registered without an initial value and read with an empty fallback, which Chromium 111-118 drop:");
  for (const hit of hits) console.error(`- ${hit}`);
  console.error("Add registeredVarFallbacksPlugin() to the build config that wrote the file (scripts/registeredVarFallbacks.ts).");
  process.exit(1);
}

console.log(`[registered-var-fallbacks] ${checked} stylesheets: no bare registration is read with an empty fallback`);
