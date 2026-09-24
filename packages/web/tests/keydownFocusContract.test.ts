import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import test from "node:test";

/**
 * Fail-closed focus contract for global key listeners (focus-trap sweep, task #21).
 *
 * Every `window.addEventListener("keydown", ...)` / `document.addEventListener("keydown", ...)`
 * in the web app must declare, on its own comment line within the 2 non-empty
 * lines immediately above the call, EXACTLY ONE of:
 *
 *   // keydown-focus-on-open
 *       The surface moves focus into itself on open (verify: same component has
 *       a focus-on-open `useLayoutEffect` + `.focus()` / `autoFocus` / tabIndex).
 *       This is what stops a focused background element (e.g. the composer, which
 *       preventDefaults Enter) from swallowing keys meant for the surface.
 *
 *   // keydown-global-exempt: <reason>
 *       This listener intentionally does NOT move focus in — e.g. a true global
 *       shortcut, a combobox that keeps focus on its trigger, a docked non-modal
 *       panel, a listener that delegates focus to a wrapping primitive, or a
 *       capture-phase handler that runs before the background. The reason must be
 *       specific (>= 8 chars after trim) — "global shortcut" / "exempt" alone fail.
 *
 * Why per-callsite and not per-file: a per-file "does this file contain any
 * focus code" heuristic gives a free pass to files that happen to have unrelated
 * focus code (e.g. MainLayout's ⌘K next to inline-edit autoFocus). Forcing an
 * explicit declaration at each callsite makes adding a new keydown listener a
 * conscious choice — mirrors the inline-rationale doctrine for disabled lint rules.
 *
 * Single source of truth for exemptions: `grep -rn "keydown-global-exempt:" src`.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const srcRoot = resolve(repoRoot, "src");

const LISTENER_RE = /\b(?:window|document)\.addEventListener\(\s*["'`]keydown["'`]/;
const FOCUS_ON_OPEN_RE = /^\s*\/\/\s*keydown-focus-on-open\s*$/;
const EXEMPT_RE = /^\s*\/\/\s*keydown-global-exempt:\s*(.+?)\s*$/;
const MIN_REASON_LEN = 8;

function collectTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsxFiles(full));
    } else if (full.endsWith(".tsx") || full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Find a valid marker among the up-to-2 nearest non-empty lines above `idx`. */
function markerAbove(lines: string[], idx: number): { kind: "focus" | "exempt" | "exempt-empty"; reason?: string } | null {
  let seen = 0;
  for (let i = idx - 1; i >= 0 && seen < 2; i--) {
    const line = lines[i];
    if (line.trim() === "") continue;
    seen++;
    if (FOCUS_ON_OPEN_RE.test(line)) return { kind: "focus" };
    const m = EXEMPT_RE.exec(line);
    if (m) {
      const reason = m[1].trim();
      return reason.length >= MIN_REASON_LEN ? { kind: "exempt", reason } : { kind: "exempt-empty", reason };
    }
  }
  return null;
}

test("every keydown listener declares a focus-on-open or specific exemption marker", () => {
  const files = collectTsxFiles(srcRoot);
  const violations: string[] = [];
  let listenerCount = 0;

  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, idx) => {
      if (!LISTENER_RE.test(line)) return;
      listenerCount++;
      const rel = `${relative(repoRoot, file)}:${idx + 1}`;
      const marker = markerAbove(lines, idx);
      if (!marker) {
        violations.push(
          `${rel}: missing marker. Add "// keydown-focus-on-open" or ` +
            `"// keydown-global-exempt: <specific reason>" on its own line directly above.`,
        );
      } else if (marker.kind === "exempt-empty") {
        violations.push(
          `${rel}: keydown-global-exempt reason "${marker.reason}" too vague ` +
            `(needs >= ${MIN_REASON_LEN} chars describing the specific surface/shortcut).`,
        );
      }
    });
  }

  // Guard against the regex silently matching nothing (e.g. a refactor that
  // renames addEventListener) — would otherwise make this test vacuously pass.
  assert.ok(listenerCount >= 15, `expected to scan many keydown listeners, found ${listenerCount}`);
  assert.deepEqual(violations, [], `\n${violations.join("\n")}\n`);
});
