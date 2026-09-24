import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";

import { sanitizeAgentKnowledgeContent } from "./agentKnowledgeService.js";

// Why this exists: on 2026-08-27 a prompt-source rewrite (PR #6964) introduced a literal
// repo path into the *body* of an agent-served Manual topic. The reviewed gates counted a
// named word list and were blind to path-shaped tokens, and the leak was only caught by a
// human reading the repo. Maintainer provenance comments ({/* Verified against: ... */})
// are allowed in source files because the serve pipeline strips them; the contract this
// test pins is about what an agent actually RECEIVES: the sanitized body must contain no
// internal source paths, build commands, or code-location citations.
//
// This calls the production transform (sanitizeAgentKnowledgeContent), not a re-
// implementation, so it also covers the stripper itself: if stripping ever regresses,
// the comment blocks' own path citations flow into the output and this goes red.
const MANUAL_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "manual");

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
  { name: "repo package path", pattern: /packages\/[A-Za-z0-9_.-]+\// },
  { name: "internal build command", pattern: /pnpm --filter/ },
  { name: "code-location citation", pattern: /\.(?:tsx|ts|mts|mjs|cjs):\d/ },
  // NOT forbidden: absolute user paths like /Users/me/... — they appear as deliberate
  // placeholders in documented CLI examples (e.g. profile-update --description). The ruled
  // class is references to OUR source code, which the three patterns above cover; a broad
  // absolute-path pattern flagged instructional content on its first run.
];

function manualFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => join(e.parentPath, e.name));
}

test("sanitized (agent-served) manual bodies contain no internal source references", () => {
  const files = manualFiles(MANUAL_ROOT);
  // Guard the guard: an empty enumeration would pass vacuously.
  assert.ok(files.length > 10, `expected manual topics, found ${files.length}`);

  let strippedSomething = false;
  const leaks: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const served = sanitizeAgentKnowledgeContent(source);
    if (served.length < source.length) strippedSomething = true;
    for (const { name, pattern } of FORBIDDEN) {
      const hit = served.match(pattern);
      if (hit) leaks.push(`${file.slice(MANUAL_ROOT.length + 1)}: ${name} -> ${hit[0]}`);
    }
  }

  // Positive control on the instrument: at least one file must actually have had
  // comment content removed, proving the sanitizer ran and is not an identity pass-through
  // that this test silently stopped exercising.
  assert.ok(strippedSomething, "sanitizer removed nothing from any file — instrument failure");
  assert.deepEqual(leaks, [], `internal references in served bodies:\n${leaks.join("\n")}`);
});
