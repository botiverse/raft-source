import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

const compactChipTokens = ["px-2", "py-0.5", "text-xs"];
const oversizedChipPattern = /\bpx-2\.5\b|\bpy-1\b|\btext-sm\b/;

function assertCompactChipScale(className: string): void {
  for (const token of compactChipTokens) {
    assert.match(className, new RegExp(`\\b${token.replace(".", "\\.")}\\b`));
  }
  assert.doesNotMatch(className, oversizedChipPattern);
}

function assertCompactRuntimeChip(className: string): void {
  assert.match(className, /\bh-6\b/);
  assertCompactChipScale(className);
}

function extractRuntimeAccountUsageClass(source: string): string {
  const matches = [...source.matchAll(
    /<RuntimeAccountUsageGateChip[\s\S]*?className="([^"]+)"[\s\S]*?>/g,
  )];
  assert.equal(matches.length, 1, "Agent runtime chip target changed; update this contract");
  return matches[0]![1];
}

function extractValueChipClassAfter(source: string, anchor: string): string {
  const index = source.indexOf(anchor);
  assert.notEqual(index, -1, `${anchor} anchor not found`);
  const match = source.slice(index).match(/value=\{\s*<span className="([^"]+)"/);
  assert.ok(match, `${anchor} className not found`);
  return match[1];
}

test("agent runtime chip keeps the same compact type scale as adjacent config chips", () => {
  const source = readSource("src/components/agent/AgentDetailPanel.tsx");
  const runtimeClassName = extractRuntimeAccountUsageClass(source);

  assertCompactRuntimeChip(runtimeClassName);
  assertCompactChipScale(extractValueChipClassAfter(source, "agent.runtimeConfig.model"));
  assertCompactChipScale(extractValueChipClassAfter(source, "agent.runtimeConfig.reasoning"));
  assertCompactChipScale(extractValueChipClassAfter(source, "agent.runtimeConfig.mode"));
});

test("machine detected runtime chips keep the compact 24px recipe in both states", () => {
  const source = readSource("src/components/machine/MachineDetailPanel.tsx");
  const detectedMatch = source.match(
    /\?\s*"([^"]*bg-brutal-cyan[^"]*)"\s*:\s*"([^"]*bg-gray-100[^"]*)";/,
  );
  assert.ok(detectedMatch, "Detected Runtimes chip class branches not found");

  assertCompactRuntimeChip(detectedMatch[1]!);
  assertCompactRuntimeChip(detectedMatch[2]!);
});
