/**
 * Contract test: all `fixed inset-0` modal backdrops must go through
 * DismissBackdrop, Lightbox, or Modal — never inline.
 *
 * Prevents future callsites from re-introducing ad-hoc backdrop divs
 * that bypass the shared ESC / click-outside / scroll-lock lifecycle.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import test from "node:test";

const SRC = join(import.meta.dirname, "../src");
const ALLOWED = new Set([
  "DismissBackdrop.tsx",
  "Lightbox.tsx",
  "Modal.tsx",
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
    const base = file.split("/").pop()!;
    if (ALLOWED.has(base)) continue;
    const src = readFileSync(file, "utf8");
    if (/fixed inset-0/.test(src)) {
      violations.push(file.replace(SRC + "/", ""));
    }
  }

  if (violations.length > 0) {
    throw new Error(
      `Inline 'fixed inset-0' backdrop found in:\n${violations.map((v) => `  ${v}`).join("\n")}\n\nUse <DismissBackdrop>, <Lightbox>, or <Modal> instead.`,
    );
  }
});
