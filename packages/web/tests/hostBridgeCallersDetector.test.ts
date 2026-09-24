import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, test } from "node:test";

/**
 * @MingQi review r5 #1: the layout-owner detector must have an EXECUTABLE counterfactual
 * per owner — not one hand-verified case. Previous regex used `(\.\.\/)*` and missed
 * `./embed/hostBridge` (`src/embed.ts` importing from a same-level sibling), so an
 * owner could silently drift and the detector would stay green.
 *
 * These tests run the actual detector against each owner file with a fake import
 * appended, and require exit=1 + owner name in stderr. Restoring the file after each
 * case is protected via a try/finally.
 */

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPO, "scripts/check-host-bridge-callers.mjs");

const OWNERS: Array<{ label: string; path: string; importSpec: string }> = [
  { label: "MainLayout.tsx", path: "src/components/layout/MainLayout.tsx",
    importSpec: 'import { emitHostEvent } from "../../embed/hostBridge";' },
  { label: "PanelHeader.tsx", path: "src/components/ui/PanelHeader.tsx",
    importSpec: 'import { emitHostEvent } from "../../embed/hostBridge";' },
  { label: "embed.ts", path: "src/embed.ts",
    importSpec: 'import { emitHostEvent } from "./embed/hostBridge";' },
];

let restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

function corruptOwner(rel: string, importSpec: string): void {
  const abs = resolve(REPO, rel);
  const original = readFileSync(abs, "utf8");
  writeFileSync(abs, original + "\n" + importSpec + "\n");
  restore.push(() => writeFileSync(abs, original));
}

function runDetector(): { code: number; err: string } {
  const r = spawnSync("node", [SCRIPT], { encoding: "utf8" });
  return { code: r.status ?? -1, err: r.stderr + r.stdout };
}

describe("layout-owner host-bridge callers detector — executable counterfactuals", () => {
  test("baseline: repo passes", () => {
    const r = runDetector();
    assert.equal(r.code, 0, `baseline failed:\n${r.err}`);
  });

  for (const owner of OWNERS) {
    test(`adding a hostBridge import to ${owner.label} → detector exit=1`, () => {
      corruptOwner(owner.path, owner.importSpec);
      const r = runDetector();
      assert.equal(r.code, 1, `expected exit=1 for ${owner.label}\n${r.err}`);
      assert.match(r.err, new RegExp(owner.path), `owner path must appear in the failure`);
    });
  }
});
