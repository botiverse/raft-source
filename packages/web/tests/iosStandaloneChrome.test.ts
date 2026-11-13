import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { isTestPath } from "../scripts/testLocations";

const repoRoot = resolve(import.meta.dirname, "..");

test("systemBarColor.ts is the only runtime writer of meta[name=theme-color]", () => {
  const sourceRoot = resolve(repoRoot, "src");
  const writers = readdirSync(sourceRoot, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file))
    .filter((file) => /theme-color/.test(
      readFileSync(resolve(sourceRoot, file), "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ""),
    ))
    .map((file) => file.split(sep).join("/"))
    // Feature tests (src/features/<feature>/tests/) may mention it; they write nothing at runtime.
    .filter((file) => !isTestPath(`src/${file}`));

  assert.deepEqual(writers, ["theme/systemBarColor.ts"]);
});
