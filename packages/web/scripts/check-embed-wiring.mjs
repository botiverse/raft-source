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
 * (`check-color-tokens.mjs`, `check-source-extensions.mjs`), never with unit tests that
 * regex source (artin 铁律 1).
 *
 * The BEHAVIOR of the keeper (merge, no-op, reload, self-trigger) is gated for real in
 * tests/embedNavigation.behavior.test.tsx against the production hook. This file only
 * answers: does the app call it?
 */
import { readFileSync } from "node:fs";

const CALLSITE = "packages/web/src/components/layout/MainLayout.tsx";
const src = readFileSync(new URL("../src/components/layout/MainLayout.tsx", import.meta.url), "utf8");

// Strip comments so a mention in prose can never satisfy the check.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const failures = [];
if (!/useEmbedParamsKeeper\s*\(\s*\)/.test(code)) {
  failures.push(
    `${CALLSITE} does not CALL useEmbedParamsKeeper().\n` +
    `   The embed params will be dropped on the first navigation, and the next WebView\n` +
    `   cold start comes back unembedded — a bug that never errors, it just grows a\n` +
    `   second header one day. Defining the hook is not wiring it.`,
  );
}
if (!/from\s+"\.\.\/\.\.\/hooks\/useEmbedParamsKeeper"/.test(code)) {
  failures.push(`${CALLSITE} does not import useEmbedParamsKeeper.`);
}

if (failures.length) {
  console.error("✗ embed wiring check failed:\n");
  for (const f of failures) console.error(` - ${f}\n`);
  process.exit(1);
}
console.log("✓ embed wiring: MainLayout calls useEmbedParamsKeeper()");
