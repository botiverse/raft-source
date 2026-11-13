import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const webSrcRoot = fileURLToPath(new URL("../src", import.meta.url));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) return listSourceFiles(fullPath);
    return /\.(ts|tsx)$/.test(entry) ? [fullPath] : [];
  });
}

test("web runtime picker surfaces do not import the raw runtime registry directly", () => {
  const offenders = listSourceFiles(webSrcRoot)
    .filter((file) => /\/components\/(agent|machine|onboarding)\//.test(file))
    .filter((file) => {
      const source = readFileSync(file, "utf8");
      return /import\s*\{[^}]*\bRUNTIMES\b[^}]*\}\s*from\s*["']@botiverse\/raft-shared["']/.test(source);
    })
    .map((file) => relative(webSrcRoot, file));

  assert.deepEqual(offenders, []);
});
