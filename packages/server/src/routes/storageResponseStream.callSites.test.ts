import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

const sites = [
  {
    label: "attachment download (including Range)",
    file: "attachments.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "attachment HTML preview two-hop transform",
    file: "attachments.ts",
    call: /await streamStorageResponseThrough\(stream, previewStream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "agent API attachment download",
    file: "internalAgentApi.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "integration logo",
    file: "integrations.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "avatar",
    file: "agents.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
  {
    label: "share artifact image",
    file: "shareArtifacts.ts",
    call: /await streamStorageResponse\(stream, res\);/g,
    expectedCount: 1,
  },
] as const;

for (const site of sites) {
  test(`${site.label} joins the abort-safe storage response pipeline`, () => {
    const source = readFileSync(new URL(`./${site.file}`, import.meta.url), "utf8");
    assert.equal(
      [...source.matchAll(site.call)].length,
      site.expectedCount,
      `${site.file} must have exactly the expected joined pipeline call for this storage-read surface`,
    );
  });
}

test("the six storage-read route files contain no bare pipe into an HTTP response", () => {
  for (const file of new Set(sites.map((site) => site.file))) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.pipe\(res(?:\s*[,)]|\s*\.)/);
  }
});
