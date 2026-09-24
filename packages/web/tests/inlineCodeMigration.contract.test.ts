import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("markdown inline code renderers use raft-ui InlineCode directly", () => {
  const markdownContent = readSource("src/components/markdown/MarkdownContent.tsx");
  const inlinePreview = readSource("src/components/markdown/InlineMarkdownPreview.tsx");
  const agentWorkspace = readSource("src/components/agent/AgentWorkspace.tsx");
  const announcementModal = readSource("src/components/AnnouncementModal.tsx");

  for (const source of [markdownContent, inlinePreview, agentWorkspace, announcementModal]) {
    assert.match(source, /InlineCode/);
    assert.match(source, /from "raft-ui"/);
  }

  assert.doesNotMatch(
    markdownContent,
    /<code className="border border-black bg-soft-signal\/40 px-1 \[font-size:inherit\] font-mono/,
  );
});

test("inline prose tokens use InlineCode while command blocks remain raw code", () => {
  const skillsPanel = readSource("src/components/agent/AgentSkills.tsx");
  const paletteAudit = readSource("src/pages/PaletteAuditPage.tsx");
  const computerCommandGuide = readSource("src/components/machine/ComputerCommandGuide.tsx");

  assert.match(skillsPanel, /<InlineCode className="text-\[11px\] text-black\/40">\{path\}<\/InlineCode>/);
  assert.match(paletteAudit, /<InlineCode>file:line<\/InlineCode>/);

  assert.match(computerCommandGuide, /<code className="min-w-0 flex-1 border-2 border-black bg-black px-3 py-2 font-mono text-xs text-brutal-lime/);
});
