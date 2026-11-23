#!/usr/bin/env node
/**
 * Floating popups and menus must use raft-ui positioned primitives rather than
 * hand-placed portals or static virtual anchors that drift on scroll/resize.
 *
 * Why: Popups placed with manual `createPortal(<ContextMenuPopup style={{ left, top }}>`
 * or `useViewportClamp` freeze at open-time coordinates when their scroll
 * container moves or the window resizes (#proj-raft-ui:#271). raft-ui's
 * `PopoverContent` / `ContextMenuContent` / `DropdownMenuContent` (and web's
 * `AnchoredMenuPopover`) delegate placement, viewport/frame-inset collision,
 * and scroll/resize tracking to Floating UI.
 *
 * Checks (over `packages/web/src`, skipping `raftbench` and `*.test.*`):
 * 1. No `useViewportClamp` references or definitions.
 * 2. No direct unpositioned raft-ui `*Popup` usage (JSX or imports of
 *    `PopoverPopup`, `ContextMenuPopup`, `DropdownMenuPopup`, `ComboboxPopup`,
 *    `PreviewCardPopup`, `SelectPopup`); render through `*Content` or
 *    `<AnchoredMenuPopover>`.
 * 3. No virtual anchor object literals implementing `getBoundingClientRect`
 *    without a nearby non-comment `contextElement` (outside the documented
 *    shared anchor helpers below).
 *
 * Known limits:
 * - Line-based static regexes do not parse full ASTs; a hand-rolled
 *   `createPortal` using a plain `<div>` instead of `*Popup` still relies on
 *   code review.
 * - Files in `ALLOWED_VIRTUAL_ANCHOR_HELPERS` are skipped for rule 3 only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(fileURLToPath(new URL("..", import.meta.url)), "src");
const SKIP_DIRS = new Set(["raftbench"]);

const ALLOWED_VIRTUAL_ANCHOR_HELPERS = new Map([
  ["components/ui/popupAnchor.ts", "shared point-anchor helper with atomic element capture + viewport fallback"],
  ["components/message/messageSelectionShortcutUtils.ts", "shared text-selection virtual anchor with contextElement"],
  ["apps/artifacts/ArtifactCommentBubble.tsx", "shared artifact live-anchor helper (anchorAt) with contextElement + viewport fallback"],
  ["components/agentMigration/log/MigrationLogPage.tsx", "live SVG chart virtual anchor with dynamic contextElement getter"],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...walk(p));
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/** Strips block and line comments from source lines while preserving line indices. */
function stripCommentsByLine(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "");
  return stripped.split("\n");
}

const VIEWPORT_CLAMP = /\buseViewportClamp\b/;
const UNPOSITIONED_POPUP_TOKEN = /\b(?:Popover|ContextMenu|DropdownMenu|Combobox|PreviewCard|Select)Popup\b/;
// Matches object-literal implementations (`getBoundingClientRect: () => ...`,
// `getBoundingClientRect: fn`, `getBoundingClientRect() { ... }`, shorthand `{ getBoundingClientRect }`)
// while ignoring `.getBoundingClientRect()` method calls and TS interface type signatures (`=> DOMRect;`).
const VIRTUAL_ANCHOR_IMPL =
  /(?:^|[{,\s])getBoundingClientRect\s*(?::\s*(?:\([^)]*\)\s*=>|function\b|[a-zA-Z_$][\w$]*\s*[,}])|\(\s*\)\s*(?::[^{;]+)?\{|(?=[,}]))/;
const TYPE_SIGNATURE_LINE = /getBoundingClientRect\s*:\s*\([^)]*\)\s*=>\s*DOMRect(?:ReadOnly)?\s*[;,]?\s*$/;
const CONTEXT_ELEMENT = /\bcontextElement\b/;

const offenders: string[] = [];
for (const file of walk(SRC)) {
  const rel = relative(SRC, file).replace(/\\/g, "/");
  const codeLines = stripCommentsByLine(readFileSync(file, "utf8"));
  codeLines.forEach((line, index) => {
    if (VIEWPORT_CLAMP.test(line)) {
      offenders.push(`${rel}:${index + 1} — useViewportClamp is removed; use raft-ui PopoverContent / AnchoredMenuPopover`);
    }
    if (UNPOSITIONED_POPUP_TOKEN.test(line)) {
      offenders.push(`${rel}:${index + 1} — unpositioned raft-ui *Popup; use raft-ui *Content or <AnchoredMenuPopover>`);
    }
    if (!ALLOWED_VIRTUAL_ANCHOR_HELPERS.has(rel) && VIRTUAL_ANCHOR_IMPL.test(line) && !TYPE_SIGNATURE_LINE.test(line)) {
      const start = Math.max(0, index - 15);
      const end = Math.min(codeLines.length, index + 16);
      const windowText = codeLines.slice(start, end).join("\n");
      if (!CONTEXT_ELEMENT.test(windowText)) {
        offenders.push(`${rel}:${index + 1} — virtual anchor without contextElement; use capturePointAnchor() or include contextElement`);
      }
    }
  });
}

if (offenders.length) {
  console.error("✗ hand-rolled popup placement or static virtual anchor:\n" + offenders.map((o) => `  ${o}`).join("\n"));
  process.exit(1);
}
console.log("✓ popup portal check: no hand-placed *Popup elements or static virtual anchors");
