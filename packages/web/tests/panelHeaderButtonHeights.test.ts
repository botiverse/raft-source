import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

test("thread panel header action buttons share fixed h-7 height", () => {
  const source = readFileSync(
    resolve(repoRoot, "src/components/message/ThreadPanel.tsx"),
    "utf8",
  );

  // View-in-channel fallback: task #187 keeps the flag-off action as the
  // canonical square size-7 icon at every width. Under the flag it moves into
  // ThreadOverflowMenu instead of expanding into a header text button.
  assert.match(
    source,
    /className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-white"/,
  );
  // X close button: visible in modal (centered dialog), hidden in
  // mobile-modal (full-screen, back chevron), and `hidden lg:flex` in side
  // (msg=804c045d clarification).
  assert.match(
    source,
    /const closeButtonClassName = presentation === "modal"\s*\?\s*"btn-brutal-sm flex size-7 items-center justify-center bg-white"\s*:\s*"btn-brutal-sm hidden size-7 items-center justify-center bg-white lg:flex"/,
  );
});

test("profile panel header action buttons share fixed h-7 height", () => {
  const agentSource = readFileSync(
    resolve(repoRoot, "src/components/agent/AgentDetailPanel.tsx"),
    "utf8",
  );
  const humanSource = readFileSync(
    resolve(repoRoot, "src/components/member/HumanDetailPanel.tsx"),
    "utf8",
  );

  assert.match(
    agentSource,
    /className="btn-brutal-sm flex size-7 items-center justify-center bg-white"/,
  );
  assert.match(
    humanSource,
    /className="btn-brutal-sm flex size-7 items-center justify-center bg-white"/,
  );
  const messageButtonIdx = humanSource.search(
    /title=\{formatMessage\(\{ id: "member\.detail\.message" \}\)\}\s+aria-label=\{formatMessage\(\{ id: "member\.detail\.message" \}\)\}\s*>\s*<MessageSquare size=\{14\} \/>\s*<\/button>/,
  );
  assert.ok(messageButtonIdx >= 0, "human profile Message icon-button anchor not found");
  assert.doesNotMatch(
    humanSource,
    /<span[^>]*>Message<\/span>/,
  );
  assert.match(
    agentSource,
    /className=\{`btn-brutal-sm size-7 items-center justify-center bg-white \$\{onBack \? "flex" : "hidden md:flex"\}`\}/,
  );
  assert.match(
    humanSource,
    /className=\{`btn-brutal-sm size-7 items-center justify-center bg-white \$\{onBack \? "flex" : "hidden md:flex"\}`\}/,
  );
  assert.doesNotMatch(
    agentSource,
    /h-panel-header[\s\S]{0,2000}title=\{diagnosticCopied \? "Diagnostic info copied" : "Copy Diagnostic Info"\}/,
  );
});

test("secondary panel header icon actions use the shared h-7 icon button contract", () => {
  const panelFiles = [
    "src/components/message/ChatPanel.tsx",
    "src/components/thread/ThreadsInbox.tsx",
    "src/components/saved/SavedPanel.tsx",
    "src/components/settings/SettingsPanel.tsx",
    "src/components/settings/ReleaseNotesPanel.tsx",
    "src/components/search/MessageSearchPage.tsx",
    "src/components/machine/MachineDetailPanel.tsx",
    "src/components/machine/MobileComputersPanel.tsx",
    "src/components/task/LegacyTaskPanel.tsx",
    "src/components/message/SelectShareLightbox.tsx",
  ];

  for (const file of panelFiles) {
    const source = readFileSync(resolve(repoRoot, file), "utf8");
    assert.doesNotMatch(source, /h-panel-header[\s\S]{0,1200}btn-brutal-sm[^"]*p-1\.5/);
  }

  const buttonSource = readFileSync(resolve(repoRoot, "src/components/ui/Button.tsx"), "utf8");
  assert.match(buttonSource, /icon: "size-7 text-xs"/);
  assert.match(buttonSource, /text: "h-7 px-2\.5 text-xs"/);
  assert.match(buttonSource, /iconText: "h-7 gap-1\.5 px-2\.5 text-xs"/);
  assert.doesNotMatch(buttonSource, /\bcount:/);
});
