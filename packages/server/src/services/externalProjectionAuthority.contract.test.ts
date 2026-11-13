import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const serverSourceRoot = resolve(import.meta.dirname, "..");

function productionTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(path);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [path];
  });
}

test("external projection source ratchet keeps one canonical writer", () => {
  const externalSenderWriters = productionTypeScriptFiles(serverSourceRoot)
    .filter((path) => /senderType\s*:\s*["']external_projection["']/.test(readFileSync(path, "utf8")))
    .map((path) => relative(serverSourceRoot, path));

  assert.deepEqual(externalSenderWriters, ["services/externalProjectionService.ts"]);
});
