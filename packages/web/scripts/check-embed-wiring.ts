#!/usr/bin/env node
/**
 * Detector: the embed keeper must actually be WIRED, not merely defined.
 *
 * Why this exists (@MingQi, PR #4799): the first cut of this feature shipped
 * `embedSearchParams()` with ZERO callers. Every unit test was green — they tested the
 * helper. The app was never embedded. A helper with no callsite is the exact failure
 * this file is here to make loud.
 *
 * Why a detector and not a unit test: the behavior gate would be "render MainLayout and
 * navigate", but MainLayout pulls in the Vite `import.meta.env` graph, which the node
 * test harness does not shim — that test would be flaky infrastructure, not a gate.
 * Wiring-presence is implementation SHAPE, and this repo guards shape with detectors
 * (`check-color-tokens.ts`, `check-source-extensions.ts`), never with unit tests that
 * regex source (artin 铁律 1).
 *
 * Every layout an embed can be in calls the keeper: the server layout (MainLayout), and
 * the Artifact's own page (App.tsx's ArtifactPermalinkRoute, outside that layout; the App
 * opens Artifacts there, mobile #3866).
 *
 * The BEHAVIOR of the keeper (merge, no-op, reload, self-trigger) is gated for real in
 * tests/embedNavigation.behavior.test.tsx (removed in the 2026-11 web DOM test prune) against the production hook, and on the
 * Artifact page in tests/artifactStandalonePage.behavior.test.tsx (removed in the 2026-11 web DOM test prune). This file only
 * answers: does the app call it?
 */
import { readFileSync } from "node:fs";

const CALLSITES = [
  { path: "packages/web/src/components/layout/MainLayout.tsx", url: "../src/components/layout/MainLayout.tsx", from: "../../hooks/useEmbedParamsKeeper" },
  { path: "packages/web/src/App.tsx", url: "../src/App.tsx", from: "./hooks/useEmbedParamsKeeper" },
];

const failures = [];
for (const site of CALLSITES) {
  const src = readFileSync(new URL(site.url, import.meta.url), "utf8");
  // Strip comments so a mention in prose can never satisfy the check.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  if (!/useEmbedParamsKeeper\s*\(\s*\)/.test(code)) {
    failures.push(
      `${site.path} does not CALL useEmbedParamsKeeper().\n` +
      `   The embed params will be dropped on the first navigation, and the next WebView\n` +
      `   cold start comes back unembedded — a bug that never errors, it just grows a\n` +
      `   second header one day. Defining the hook is not wiring it.`,
    );
  }
  if (!code.includes(`from "${site.from}"`)) {
    failures.push(`${site.path} does not import useEmbedParamsKeeper.`);
  }
}

if (failures.length) {
  console.error("✗ embed wiring check failed:\n");
  for (const f of failures) console.error(` - ${f}\n`);
  process.exit(1);
}
console.log(`✓ embed wiring: ${CALLSITES.map((s) => s.path.split("/").pop()).join(", ")} call useEmbedParamsKeeper()`);
