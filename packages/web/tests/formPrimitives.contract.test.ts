import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

function sourceFilesUnder(path: string): string[] {
  const root = resolve(repoRoot, path);
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const visit = (entry: string) => {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      for (const child of readdirSync(entry)) visit(resolve(entry, child));
      return;
    }
    if (/\.(tsx?|jsx?)$/.test(entry)) results.push(relative(repoRoot, entry));
  };
  visit(root);
  return results.sort();
}

test("time format setting uses the canonical segmented control", () => {
  const source = readSource("src/components/settings/SettingsPanel.tsx");

  assert.match(source, /import \{[\s\S]*SegmentedControl,?[\s\S]*SegmentedControlItem,?[\s\S]*SegmentedControlLabel,?[\s\S]*\} from "raft-ui";/);
  // Time-format aria migrated to react-intl (settings big-files phase).
  assert.match(source, /aria-label=\{formatMessage\(\{ id: "settings\.dateTime\.timeFormatAria" \}\)\}/);
  assert.match(source, /data-testid="time-format-12h"/);
  assert.match(source, /data-testid="time-format-24h"/);
  assert.doesNotMatch(source, /Checkbox[\s\S]{0,800}Time format|Time format[\s\S]{0,800}Checkbox/);
});

test("search sort uses the filter-chip pattern (Sort dropdown, not SegmentedControl)", () => {
  // Per stdrc #proj-uiux:c2313b1d msg=da1194bd (2026-05-26): the Relevant /
  // Recent segmented toggle was replaced with a chip+popover named "Sort"
  // matching the From / Channel / Time filter-chip shape, positioned after
  // those filters. The SegmentedControl import is gone; the chip uses
  // `search-sort-chip` testid and renders the current value as its label.
  const source = readSource("src/components/search/MessageSearchPage.tsx");

  assert.doesNotMatch(source, /import SegmentedControl from "\.\.\/ui\/SegmentedControl";/);
  assert.doesNotMatch(source, /<SegmentedControl<SearchSort>/);
  assert.match(source, /data-testid="search-sort-chip"/);
  assert.match(source, /title=\{formatMessage\(\{ id: "search\.sort" \}\)\}/);
  assert.match(source, /\["relevance", "recent"\] as SearchSort\[\]/);
});

// GAP, RECORDED ON PURPOSE — do not read this space as "nothing to cover here".
//
// Deleted: a source-regex pin asserting the server-translation Checkbox carried
// `size="md"` and `className="mt-0.5"` next to its label.
//
// The risk it was aimed at is real: the checkbox should sit on the first line of
// its label rather than centring against a wrapped two-line one. But the pin could
// not detect that risk. It matched the *spelling* of one arrangement, so any other
// spelling that aligns correctly fails it, and any regression that keeps the
// spelling passes it. The property is geometric and this suite runs in jsdom, which
// performs no layout — a measured assertion here resolves to 0 and passes on nothing.
//
// So there is currently NO automated coverage for checkbox/label alignment. Closing
// it needs a real-engine geometry assertion (measure the box), which is out of scope
// for the source-pin conversion and has no home in this file.
//
// Disposition: 铁根 was asked to rule (a) add a real-engine geometry tooth, or
// (b) delete and record the gap. After no ruling, the pre-announced default (b) was
// applied — see #proj-frontend:fcd1c96e. Deleting a pin that only appears to guard
// is preferable to keeping a green light wired to a string.

test("business selects use raft-ui directly without the deprecated local adapter", () => {
  const popoverSource = readSource("src/components/ui/SelectionPopover.tsx");

  assert.equal(existsSync(resolve(repoRoot, "src/components/Select.tsx")), false);
  for (const sourcePath of [
    "src/components/agent/CreateAgentDialog.tsx",
    "src/components/agent/RuntimeConfigFields.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/pages/HumanLoginSetupPage.tsx",
    "src/pages/IntegrationInvitePage.tsx",
  ]) {
    const source = readSource(sourcePath);
    assert.match(source, /from "raft-ui";/, `${sourcePath} should import raft-ui directly`);
    assert.match(source, /<Select[\s>]/, `${sourcePath} should render raft-ui Select at the business callsite`);
    assert.doesNotMatch(source, /from "\.\.?\/(?:\.\.\/)?components\/Select"|from "\.\.\/Select"|from "\.\.\/components\/Select"/);
  }
  // Per stdrc msg=32e323aa + msg=832c2c02 + msg=b0b92c1c (2026-05-25):
  // SelectionPopover / InlineBadgeEditor dropdown) keeps no yellow-fill
  // selected rows while search/filter popovers continue to use soft-signal hover.
  assert.doesNotMatch(popoverSource, /bg-soft-signal(?!\/30)/);
  assert.match(popoverSource, /hover:bg-soft-signal\/30/);
});

test("components do not hand-roll switch primitives before a canonical Toggle exists", () => {
  const offenders: string[] = [];
  // role="switch" is the strongest signal of a hand-rolled toggle. We don't
  // ban bare `Toggle` / `Switch` identifiers because those names are now
  // legitimately reusable post-Brutal-prefix-drop (multi-theme prep,
  // #proj-theme:ac79cf20 stdrc msg=876c1102); reserve the canonical name for
  // the future primitive without poisoning the namespace.
  const switchPattern = /role=["']switch["']/;

  const scanned = sourceFilesUnder("src/components");
  for (const sourcePath of scanned) {
    const source = readSource(sourcePath);
    if (switchPattern.test(source)) offenders.push(sourcePath);
  }

  // The scan has to have actually scanned something. `sourceFilesUnder` returns
  // [] for a missing root, so a path typo or a directory move would leave
  // `offenders` empty and this invariant silently unguarded while CI stays
  // green. Verified: pointing the root at a non-existent directory left the
  // whole file passing 6/6 before this line existed.
  assert.ok(scanned.length > 50, `expected to scan the component tree, saw ${scanned.length} files`);
  assert.deepEqual(offenders, []);
});

test("12-hour and 24-hour segmented labels stay centralized in SettingsPanel", () => {
  const offenders: string[] = [];
  const timeFormatLiteralPattern = /12-hour|24-hour/;
  const allowed = new Set(["src/components/settings/SettingsPanel.tsx"]);

  const scanned = [
    ...sourceFilesUnder("src/components"),
    ...sourceFilesUnder("src/pages"),
  ];
  for (const sourcePath of scanned) {
    if (allowed.has(sourcePath)) continue;
    const source = readSource(sourcePath);
    if (timeFormatLiteralPattern.test(source)) offenders.push(sourcePath);
  }

  // Same guard as above: an empty scan makes this assertion pass on nothing.
  // The `> 50` is a deliberate choice of protection, not a measured threshold: it
  // catches a root that resolved to a near-empty directory, which `> 0` would miss.
  // If components+pages is ever legitimately split below this, update the number —
  // it is not asserting anything about how large the tree ought to be.
  assert.ok(scanned.length > 50, `expected to scan components+pages, saw ${scanned.length} files`);
  // ...and every allow-listed path must actually be among them. Keyed on the set,
  // not on one literal: an exemption whose path was typo'd or moved would otherwise
  // sit there doing nothing while the scan stayed green — the same silent-pass this
  // test exists to prevent, one level up.
  for (const allowedPath of allowed) {
    assert.ok(
      scanned.includes(allowedPath),
      `allow-listed ${allowedPath} must be in the scanned set`,
    );
  }
  assert.deepEqual(offenders, []);
});
