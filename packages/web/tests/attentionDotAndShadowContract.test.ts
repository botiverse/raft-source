import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("AttentionDot primitive exposes lg/sm physical-fit axis + brutal-pink default", () => {
  const src = read("src/components/ui/AttentionDot.tsx");
  // Two-tier physical-fit axis (stdrc 2026-05-14 PR #1709 amend,
  // msg=6ad15567). `lg` is canonical default, `sm` is compact-only.
  // Size is physical fit, NOT priority — don't reintroduce `md` (or any
  // intermediate tier) under another name. See CLAUDE.md "Attention
  // Dots" for the boundary test.
  assert.match(src, /sm:\s*"size-1"/);
  assert.match(src, /lg:\s*"size-2\.5"/);
  assert.doesNotMatch(src, /md:\s*"size-2"/);
  // API surface must expose only the two tiers — banning `md` at the
  // type level is what makes accidental reintroduction a typecheck error
  // rather than a code-review nit.
  assert.match(src, /size\?:\s*"sm"\s*\|\s*"lg"/);
  // Default size = lg (canonical). If a callsite drops the `size` prop
  // it should land on the canonical 10×10, not the compact tier.
  assert.match(src, /size = "lg"/);
  // brutal-pink stays the canonical default tone — overrides are explicit.
  assert.match(src, /tone = "bg-brutal-pink"/);
  // Border is what makes the dot read as an attention chip vs decorative
  // pixel. Required at every tier.
  assert.match(src, /border border-black/);
  // rounded-full guarantees the dot shape across tiers.
  assert.match(src, /rounded-full/);
});

test("no `size=\"md\"` AttentionDot consumers remain (md was removed in PR #1709 amend)", () => {
  // After the 3-tier → 2-tier collapse, every `size="md"` AttentionDot
  // callsite was either promoted to `lg` (canonical) or dropped to `sm`
  // (compact-only). Re-introducing `md` is the symptom of someone
  // misreading the new physical-fit rule as a priority tier — fail CI
  // before the regression lands.
  //
  // Scan only the AttentionDot usages, not every `size="md"` literal in
  // the repo (Checkbox, Button, etc. have their own size
  // axes that are unrelated).
  const componentsDir = resolve(repoRoot, "src");
  let hits = "";
  try {
    hits = execSync(
      `grep -RnE '<AttentionDot[^/>]*size="md"' ${componentsDir}`,
      { encoding: "utf8" },
    );
  } catch (err: any) {
    if (err.status === 1) hits = "";
    else throw err;
  }
  assert.equal(
    hits.trim(),
    "",
    `AttentionDot size="md" is banned — collapse to size="lg" (canonical) or size="sm" (compact-only):\n${hits}`,
  );
});

test("LeftRail + Sidebar use AttentionDot for unread / cross-context dots", () => {
  const leftRail = read("src/components/layout/LeftRail.tsx");
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(leftRail, /import AttentionDot from "\.\.\/ui\/AttentionDot";/);
  assert.match(sidebar, /import AttentionDot from "\.\.\/ui\/AttentionDot";/);

  // server-switcher dot must be `lg` (cross-context attention) on both
  // desktop LeftRail and the mobile/short Sidebar surface. LeftRail now keeps
  // its dot visual-only inside a button whose name and visible help are owned
  // by aria-label + raft-ui Tooltip; it must not retain a browser-native title.
  assert.match(leftRail, /<AttentionDot[\s\S]*?size="lg"[\s\S]*?aria-hidden="true"/);
  assert.match(sidebar, /<AttentionDot[\s\S]*?size="lg"[\s\S]*?title=\{formatMessage\(\{ id: "layout\.sidebar\.otherServersUnread" \}\)\}/);

  // No raw inline pink-dot spans should remain in these two files. If a
  // new dot is added, route it through AttentionDot.
  assert.doesNotMatch(leftRail, /rounded-full border border-black bg-brutal-pink/);
  assert.doesNotMatch(sidebar, /size-2 rounded-full bg-brutal-pink border border-black/);
});

test("shadow-soft-popover token exists in index.css with the locked value", () => {
  const css = read("src/index.css");
  // Token value is pinned per CLAUDE.md "Shadow Boundary — Hard vs Soft".
  // Tweaking the value is a design call; if you need a different soft
  // shadow, talk to the designer before editing this line.
  assert.match(css, /--shadow-soft-popover:\s*0 4px 12px rgba\(0,\s*0,\s*0,\s*0\.08\);/);
});

test("no inline shadow-[rgba(...)] arbitrary values in components/", () => {
  // Lint-ban: all shadow effects must reference a named token
  // (shadow-brutal*, shadow-soft-popover). See CLAUDE.md "Shadow
  // Boundary — Hard vs Soft".
  const componentsDir = resolve(repoRoot, "src/components");
  let hits = "";
  try {
    hits = execSync(`grep -RnE 'shadow-\\[[^]]*rgba' ${componentsDir}`, { encoding: "utf8" });
  } catch (err: any) {
    // grep exits 1 when there are no matches — that's the success case.
    if (err.status === 1) hits = "";
    else throw err;
  }
  assert.equal(hits.trim(), "", `inline rgba shadows are banned (use shadow-brutal* or shadow-soft-popover instead):\n${hits}`);
});
