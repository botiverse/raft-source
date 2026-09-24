// The source-regex layout assertions for ThreadsInbox, PanelHeader,
// MessageSearchPage, and TasksPanel moved to mounted-DOM assertions in
// inboxToolbarLayout.behavior.test.tsx. What remains here
// reads bytes that are themselves the contract:
// - the overflow-y-overlay stylesheet rule definition in src/index.css
//   (stylesheet content is a bytes-are-contract case), and
// - the cross-surface PanelHeader adoption policy below — which panel renders
//   the primitive and which keeps its legacy raw header until migration.
//   Mounting every panel to prove primitive reuse is out of proportion; the
//   canonical classList itself is pinned by the mounted PanelHeader test.
//   ThreadsInbox and TasksPanel left these lists because the mounted tests
//   now prove their headers through the real render path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("the overflow-y-overlay rule keeps a visible scroll affordance without reserving a gutter", () => {
  const styles = readFileSync(resolve(repoRoot, "src/index.css"), "utf8");
  assert.match(styles, /\.overflow-y-overlay\s*\{[\s\S]*?overflow-y:\s*auto/);
  assert.match(styles, /@supports \(overflow:\s*overlay\)\s*\{[\s\S]*?\.overflow-y-overlay\s*\{[\s\S]*?overflow-y:\s*overlay/);
});

test("main panel surfaces keep the canonical PanelHeader adoption contract", () => {
  const panelHeaderFiles = [
    "src/components/message/ChatPanel.tsx",
    "src/components/saved/SavedPanel.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/components/settings/ReleaseNotesPanel.tsx",
    "src/components/search/MessageSearchPage.tsx",
    "src/components/machine/MachineDetailPanel.tsx",
    "src/components/machine/MobileComputersPanel.tsx",
    "src/components/member/HumanDetailPanel.tsx",
    "src/components/message/ThreadPanel.tsx",
  ];

  for (const path of panelHeaderFiles) {
    const source = readFileSync(resolve(repoRoot, path), "utf8");
    assert.match(source, /<PanelHeader\b/, `${path} should use PanelHeader's canonical padding`);
  }

  const legacySource = readFileSync(resolve(repoRoot, "src/components/task/LegacyTaskPanel.tsx"), "utf8");
  assert.match(
    legacySource,
    /className="flex h-panel-header items-center gap-3 border-b-2 border-black bg-(?:white|soft-signal) px-5/,
    "LegacyTaskPanel should keep the legacy px-5 header contract until migrated",
  );
});
