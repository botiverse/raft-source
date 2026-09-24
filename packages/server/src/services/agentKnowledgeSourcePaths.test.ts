import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

// Why this exists: on 2026-08-24 `manual/agent-knowledge/app.md` was on disk and served
// under its bare id, but was absent from SOURCE_PATHS — so the documented
// `agent-knowledge/<id>` path form returned NOT_FOUND for that one topic while working
// for the other six in its section. Agents that followed the documented form fell back to
// guessing paths, which surfaced as an 11-row / 3-agent / 3-server miss family in the
// daily Manual reason digest.
//
// The list could drift from disk in either direction with nothing going red. This asserts
// both directions, because each fails differently:
//   on disk, unregistered  => the topic is unreachable by path form (the 8/24 defect)
//   registered, not on disk => the reader points at a file that cannot be read
const SERVICE = join(import.meta.dirname, "agentKnowledgeService.ts");
const MANUAL_DIR = join(import.meta.dirname, "..", "..", "..", "..", "manual", "agent-knowledge");

function registeredPaths(): Set<string> {
  const src = readFileSync(SERVICE, "utf-8");
  const found = src.matchAll(/"manual\/agent-knowledge\/([a-z0-9-]+\.md)"/g);
  return new Set([...found].map((m) => m[1]));
}

test("every agent-knowledge topic on disk is registered in SOURCE_PATHS", () => {
  const onDisk = new Set(readdirSync(MANUAL_DIR).filter((f) => f.endsWith(".md")));
  const registered = registeredPaths();

  // Guard the guard: if either side is empty the comparison below passes vacuously,
  // which would be the "check that cannot go red" shape this test exists to prevent.
  assert.ok(onDisk.size > 10, `expected topics on disk, found ${onDisk.size}`);
  assert.ok(registered.size > 10, `expected registered paths, found ${registered.size}`);

  const unregistered = [...onDisk].filter((f) => !registered.has(f)).sort();
  const missingFile = [...registered].filter((f) => !onDisk.has(f)).sort();

  assert.deepEqual(unregistered, [], `on disk but not in SOURCE_PATHS: ${unregistered.join(", ")}`);
  assert.deepEqual(missingFile, [], `in SOURCE_PATHS but not on disk: ${missingFile.join(", ")}`);
});
