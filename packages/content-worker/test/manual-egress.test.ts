import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { generateGuide } from "@botiverse/porthole";
import { raftDisplays } from "../src/raftContentDisplays";

/**
 * The agent manual's Artifact topic (manual/agent-knowledge/artifact.md, "Building a page that
 * shows well"; the server serves it as written, agentKnowledgeService.ts) says what a page may
 * load in Porthole's own sentence for this Worker's config: the guide's Network line, written from
 * the same egress the pages' CSP opens. A change to that egress, or Porthole wording it otherwise
 * after an upgrade, fails here until the manual carries the new sentence, so the list agents read
 * can't drift from what loads.
 */
const MANUAL = new URL("../../../manual/agent-knowledge/artifact.md", import.meta.url);

test("the manual's Network sentence for Artifact pages is Porthole's for the Worker's config, word for word", () => {
  const guide = generateGuide(raftDisplays.guideConfig("artifact", "served"), ["widget"]);
  const sentence = /^- (Network: .+)$/mu.exec(guide)?.[1];
  assert.ok(sentence, "Porthole's widget topic has a Network line");
  assert.ok(
    readFileSync(MANUAL, "utf8").includes(sentence),
    `manual/agent-knowledge/artifact.md should say, in "Building a page that shows well":\n${sentence}`,
  );
  // The manual's example and the push's bundled-library warning (packages/server/src/apps/artifacts/bundledLibraries.ts) point at jsDelivr.
  assert.match(sentence, /\bscripts, styles\b[^;]*https:\/\/cdn\.jsdelivr\.net/u);
});
