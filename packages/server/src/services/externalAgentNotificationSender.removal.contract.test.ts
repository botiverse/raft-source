import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

// Removal contract for the un-gated "Notification sender" External Agent
// purpose (reverted in PR #6995). This test must fail if the deleted
// doc/module or the production tokens return.

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const DELETED_PATHS = [
  "docs/operations/external-agent-notifiers.md",
  "packages/server/src/services/externalAgentPurpose.ts",
  "packages/server/src/services/externalAgentPurpose.test.ts",
];

const RETIRED_TOKENS = ["externalPurpose", "externalAgentPurpose", "notification_sender"];

const SCANNED_DIRS = [
  "packages/server/src",
  "packages/shared/src",
  "packages/web/src",
  "docs",
  "manual",
  "scripts",
];

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".md", ".sh", ".json"]);

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if (
      SCANNED_EXTENSIONS.has(full.slice(full.lastIndexOf("."))) &&
      !/\.(test|spec|contract\.test)\.[tj]sx?$/.test(entry)
    ) {
      yield full;
    }
  }
}

test("deleted notification-sender module and doc stay absent", () => {
  for (const path of DELETED_PATHS) {
    assert.equal(existsSync(join(repoRoot, path)), false, `${path} must stay deleted`);
  }
});

test("notification-sender production tokens stay absent from shipped sources", () => {
  for (const dir of SCANNED_DIRS) {
    const absoluteDir = join(repoRoot, dir);
    if (!existsSync(absoluteDir)) continue;
    for (const file of walk(absoluteDir)) {
      const content = readFileSync(file, "utf8");
      for (const token of RETIRED_TOKENS) {
        assert.equal(
          content.includes(token),
          false,
          `${relative(repoRoot, file)} must not reference retired token ${token}`,
        );
      }
    }
  }
});
