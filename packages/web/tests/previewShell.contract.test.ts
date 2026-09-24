import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

const shell = read("src/components/ui/PreviewShell.tsx");
const quoted = read("src/components/ui/cards/QuotedMessageCard.tsx");
const attachment = read("src/components/message/AttachmentChip.tsx");

test("PreviewShell exports the canonical preview skin recipe (single source)", () => {
  assert.match(shell, /export const PREVIEW_SHELL_BORDER = "border border-black\/15 hover:border-black\/30";/);
  // Skin is hover-only: press inherits hover styling (`:hover` keeps matching
  // while `:active` is true). Pre-refactor QuotedMessageCard never had an
  // active token, and a `color-mix(in oklab, …, transparent)` × element
  // `opacity` combo paints cyan on Chromium — both reasons to keep the shell
  // press-token-free. stdrc 2026-05-23 #proj-theme:441c8b2b cfd10230.
  assert.match(shell, /export const PREVIEW_SHELL_SKIN = `\$\{PREVIEW_SHELL_BORDER\} bg-white hover:bg-black\/5`;/);
  assert.doesNotMatch(shell, /active:bg-soft-signal/);
  assert.doesNotMatch(shell, /active:opacity-90/);
  assert.match(shell, /export const PREVIEW_SHELL_SKIN_MUTED =\s*"border-2 border-black\/30 bg-black\/5 italic text-black\/40 hover:shadow-brutal-sm";/);
  // Polymorphic root (button when clickable, else div).
  assert.match(shell, /const Root = onClick \? "button" : "div";/);
  assert.match(shell, /type: "button" as const/);
  // Layout is caller-supplied via className — no hardcoded `w-full text-left
  // group` in the shell. (Drives stdrc 2026-05-22 7d19c377 / 4365db5a:
  // AttachmentChip can now wrap PreviewShell with its fixed-size layout.)
  assert.doesNotMatch(shell, /group w-full text-left/);
});

test("QuotedMessageCard consumes PreviewShell with its own layout className", () => {
  assert.match(quoted, /import PreviewShell from "\.\.\/PreviewShell";/);
  // Layout class moved from PreviewShell defaults to caller.
  assert.match(quoted, /<PreviewShell variant="muted" onClick=\{onClick\} data-testid="quoted-message-card" className="group block w-full text-left">/);
  assert.match(quoted, /<PreviewShell onClick=\{onClick\} data-testid="quoted-message-card" className="group block w-full text-left">/);
  assert.doesNotMatch(quoted, /const Root = onClick \? "button" : "div";/);
  assert.doesNotMatch(quoted, /border border-black\/15 bg-white text-left/);
  assert.doesNotMatch(quoted, /<Root\b/);
});

test("AttachmentChip wraps PreviewShell (direct component reuse, not just border tokens)", () => {
  // stdrc 2026-05-22 #proj-theme:441c8b2b 7d19c377 / 4365db5a: direct
  // component reuse — the outer chip wrapper IS a PreviewShell, so hover + bg
  // + press-flash all single-source through the shell.
  assert.match(attachment, /import PreviewShell from "\.\.\/ui\/PreviewShell";/);
  assert.match(attachment, /<PreviewShell\b/);
  // Layout-only constant — no border / bg / hover tokens (those live on
  // PreviewShell's skin). Width-contract guards (w-44 / min-w-44 / max-w-44 /
  // shrink-0 / overflow-hidden) still pinned via the width test.
  const layout = attachment.match(/const COMPACT_CHIP_LAYOUT = "([^"]+)";/);
  assert.ok(layout, "COMPACT_CHIP_LAYOUT must remain a static literal (width contract)");
  assert.doesNotMatch(layout![1], /border-black\/15/);
  assert.doesNotMatch(layout![1], /hover:border-black\/30/);
  assert.doesNotMatch(layout![1], /\bbg-white\b/);
  assert.doesNotMatch(layout![1], /hover:bg-black\/5/);
  assert.doesNotMatch(layout![1], /active:bg-soft-signal/);
  // No leftover inline `<button>` root — the shell owns the polymorphic root.
  assert.doesNotMatch(attachment, /\n {4}<button\b/);
  // Old route-A border style must stay gone.
  assert.doesNotMatch(attachment, /border-2 border-black\b(?!\/)/);
});
