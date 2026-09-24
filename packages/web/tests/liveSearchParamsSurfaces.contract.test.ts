import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

const migratedSurfaces = [
  "src/components/agent/AgentDetailPanel.tsx",
  "src/components/message/ForwardedBundleRouteCard.tsx",
  "src/components/search/MessageSearchPage.tsx",
  "src/components/workspace/workspaceGridUrlState.ts",
  "src/hooks/useEmbedParamsKeeper.ts",
] as const;

function readSource(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("query-param writer surfaces use the live search-param setter", () => {
  for (const path of migratedSurfaces) {
    const source = readSource(path);
    assert.match(
      source,
      /useLiveSearchParams/,
      `${path} must use the event-time URL writer`,
    );
    assert.doesNotMatch(
      source,
      /import\s*\{[^}]*\buseSearchParams\b[^}]*\}\s*from\s*["']react-router-dom["']/,
      `${path} must not import React Router's stale search-param setter directly`,
    );
  }
});
