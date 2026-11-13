/**
 * Contract test: all `fixed inset-0` modal backdrops must go through
 * DismissBackdrop or a raft-ui overlay (Dialog, Drawer, Lightbox) — never inline.
 *
 * Prevents future callsites from re-introducing ad-hoc backdrop divs
 * that bypass the shared ESC / click-outside / scroll-lock lifecycle.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { isTestPath } from "../scripts/testLocations";

const SRC = join(import.meta.dirname, "../src");
const ALLOWED = new Set([
  "DismissBackdrop.tsx",
  "Lightbox.tsx",
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test("modal backdrops use a shared primitive", () => {
  const violations: string[] = [];
  for (const file of walk(SRC)) {
    if (!file.endsWith(".tsx")) continue;
    // Feature tests (src/features/<feature>/tests/) are not app code.
    if (isTestPath(`src/${relative(SRC, file)}`)) continue;
    const base = file.split("/").pop()!;
    if (ALLOWED.has(base)) continue;
    const src = readFileSync(file, "utf8");
    if (/fixed inset-0/.test(src)) {
      violations.push(file.replace(SRC + "/", ""));
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Inline 'fixed inset-0' backdrop found in:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nUse <DismissBackdrop> or a raft-ui Dialog, Drawer or Lightbox instead.`,
    );
  }
});
