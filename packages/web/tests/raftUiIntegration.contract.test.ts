import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { EXPECTED_RAFT_UI_VERSION } from "./helpers/raftUiVersion";

const repoRoot = resolve(import.meta.dirname, "..");

function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("web app installs raft-ui global CSS and providers", () => {
  const packageJson = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.["raft-ui"], EXPECTED_RAFT_UI_VERSION);

  const css = read("src/index.css");
  assert.match(css, /@import "raft-ui\/styles\.css";/);
  assert.match(css, /@source "\.\.\/node_modules\/raft-ui\/dist";/);

  const main = read("src/main.tsx");
  assert.match(main, /import \{ ThemeProvider, ToastProvider, TooltipProvider \} from "raft-ui";/);
  assert.match(main, /<ThemeProvider defaultTheme="brutal" defaultMode="light">/);
  assert.match(main, /<TooltipProvider>/);
  assert.match(main, /<ToastProvider>/);
});

test("web typography keeps Space Grotesk while routing only the neutral straight quote through Hanken", () => {
  const css = read("src/index.css");

  assert.match(css, /@import "\.\/assets\/fonts\/fonts\.css"/);
  const localFonts = read("src/assets/fonts/fonts.css");
  assert.match(localFonts, /font-family: 'Space Grotesk'/);
  assert.match(localFonts, /font-family: 'Space Mono'/);
  assert.doesNotMatch(css + localFonts, /https:\/\/fonts\.(?:googleapis|gstatic)\.com/);
  assert.match(
    css,
    /@font-face\s*\{[\s\S]*?font-family:\s*'Raft Quote Glyphs';[\s\S]*?font-weight:\s*400 700;[\s\S]*?src:\s*url\('\.\/assets\/fonts\/hanken-grotesk-quotes\.woff2'\)\s*format\('woff2'\);[\s\S]*?unicode-range:\s*U\+0022;[\s\S]*?\}/,
  );
  assert.doesNotMatch(
    css,
    /unicode-range:[^;]*(?:U\+201C|U\+201D|U\+201C-201D)/i,
    "curly quotes must remain owned by Space Grotesk",
  );

  const quoteThenSpace =
    /(?:--font-display|font-family):\s*'Raft Quote Glyphs',\s*'Space Grotesk',\s*system-ui,\s*sans-serif;/g;
  assert.equal(
    Array.from(css.matchAll(quoteThenSpace)).length,
    2,
    "body and --font-display should share the quote-only face before Space Grotesk",
  );
  assert.match(css, /--font-mono:\s*'Space Mono',\s*ui-monospace,\s*monospace;/);
  assert.doesNotMatch(
    css,
    /family=Hanken\+Grotesk/,
    "Hanken must not become a full-range global Web font",
  );

  const selectScreenshot = read("src/utils/selectScreenshot.ts");
  assert.match(selectScreenshot, /'Space Grotesk', 'Space Mono', ui-monospace, sans-serif/);
  assert.match(selectScreenshot, /'Space Mono', ui-monospace, monospace/);
});

test("segmented controls use raft-ui directly at callsites", () => {
  for (const file of [
    "src/components/agent/ExternalSetupTabSegmentedControl.tsx",
    "src/components/agent/AgentWorkspace.tsx",
    "src/components/channel/CreateChannelDialog.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/components/settings/SettingsSegmentedControls.tsx",
    "src/components/task/TaskFilterSegmentedControl.tsx",
    "src/components/task/TasksPanel.tsx",
    "src/components/thread/ThreadsInbox.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /from "raft-ui";/, `${file} should import raft-ui directly`);
    assert.doesNotMatch(
      source,
      /from "\.\.\/ui\/SegmentedControl";/,
      `${file} should not use the local SegmentedControl adapter`,
    );
  }

  for (const file of [
    "src/components/message/ChatPanel.tsx",
    "src/components/message/ThreadPanel.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /import \{ toast \} from "raft-ui";/, `${file} should import raft-ui toast directly`);
    assert.match(source, /SELECTION_TOAST_OPTIONS\s*=\s*\{\s*icon:\s*false,\s*dismissible:\s*false,?\s*\}\s*as const;/);
    assert.doesNotMatch(source, /showSelectionToast/, `${file} should call raft-ui toast APIs directly`);
    assert.doesNotMatch(source, /data-testid="(?:thread-)?forward-toast"/, `${file} should not render local forward toast wrappers`);
  }

  const utils = read("src/components/message/forwardSelectionUtils.ts");
  assert.doesNotMatch(utils, /scheduleSelectionToastClear/, "forward selection should not keep a local toast timeout helper");
});

test("select fields use raft-ui directly at business callsites", () => {
  for (const file of [
    "src/components/agent/CreateAgentDialog.tsx",
    "src/components/agent/AgentDetailPanel.tsx",
    "src/components/agent/RuntimeConfigFields.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/pages/HumanLoginSetupPage.tsx",
    "src/pages/IntegrationInvitePage.tsx",
  ]) {
    const source = read(file);
    assert.match(source, /from "raft-ui";/, `${file} should import raft-ui directly`);
    assert.match(source, /<Select[\s>]/, `${file} should render raft-ui Select at the callsite`);
    assert.doesNotMatch(source, /SelectItemLeading/, `${file} should not reserve an empty leading slot for text-only options`);
    assert.doesNotMatch(
      source,
      /from "\.\.?\/(?:\.\.\/)?(?:components\/)?Select";/,
      `${file} should not use the deleted local Select adapter`,
    );
  }

  const agentDetail = read("src/components/agent/AgentDetailPanel.tsx");
  assert.doesNotMatch(
    agentDetail,
    /<select[\s>]/,
    "agent migration must not fall back to a native select outside the component library",
  );
});

test("select roots are wrapped when adjacent layout siblings matter", () => {
  const invite = read("src/pages/IntegrationInvitePage.tsx");

  assert.match(
    invite,
    /<div className="mt-3 grid gap-3 md:grid-cols-\[1fr_auto\] md:items-end">\s*<div className="min-w-0">\s*<Select[\s\S]*?items=\{manageableServerOptions\}/,
    "integration invite target select should not leak its hidden input into the install grid",
  );
});
