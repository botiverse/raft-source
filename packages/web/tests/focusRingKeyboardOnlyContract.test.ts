import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isTestPath } from "../scripts/testLocations";

// Focus rings show only after keyboard navigation (raft-design states.md ›
// Focus, task #113). raft-ui gates `shadow-focus` on <html data-input-modality>;
// slock's own rings must not bypass that gate.
const repoRoot = resolve(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    // Feature tests (src/features/<feature>/tests/) are not app code.
    return /\.(tsx?|css)$/.test(name) && !isTestPath(relative(repoRoot, path)) ? [path] : [];
  });
}

test("a wrapper rings for keyboard focus inside it, not for any focus (no focus-within rings)", () => {
  const offenders = sourceFiles(resolve(repoRoot, "src")).filter((file) =>
    /focus-within:(shadow-(focus|\[)|ring)/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, []);
});

test("no element removes its focus ring with a focus-visible: class, which also opts it out of the fallback", () => {
  // The fallback skips any element whose classes mention `focus-visible:`.
  // A class that only removes the ring (`focus-visible:outline-none`,
  // `focus-visible:ring-0`) would leave keyboard users nothing; use the
  // unprefixed `outline-none` and draw a ring with `focus-visible:shadow-focus`.
  const offenders = sourceFiles(resolve(repoRoot, "src")).filter((file) =>
    /focus-visible:(outline-none|outline-hidden|outline-0|ring-0)\b/.test(readFileSync(file, "utf8")),
  );
  assert.deepEqual(offenders, []);
});
