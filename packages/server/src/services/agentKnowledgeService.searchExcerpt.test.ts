import assert from "node:assert/strict";
import { extractSearchExcerpt, searchAgentKnowledgeDocs } from "./agentKnowledgeService";

// #proj-docs:#4: a search result showed only the topic's first 700 characters,
// so a match deep in the topic looked like a miss (#wg-agent-migration:e1f4df83).

test("a match past the first screen shows the matching section", async () => {
  const [result] = await searchAgentKnowledgeDocs("raftbackupignore");
  assert.equal(result?.slug, "agent");
  assert.match(result.firstScreen, /^# Agent\n\.\.\.\n## Keep your workspace migratable/);
  assert.match(result.firstScreen, /\.raftbackupignore/);
  assert.ok(result.firstScreen.length <= 703, "excerpt stays within the first screen's budget");
});

test("a match the first screen already shows keeps the first screen", async () => {
  const [result] = await searchAgentKnowledgeDocs("channel");
  assert.equal(result?.slug, "channel");
  assert.match(result.firstScreen, /^# Channel\nA channel is/);
  assert.doesNotMatch(result.firstScreen, /^## /m);
});

const filler = Array.from({ length: 20 }, (_, i) => `Intro line ${i} about general things in this topic.`).join("\n");

test("the section with the most terms the first screen lacks wins", () => {
  const content = [
    "---", "title: Sample", "---",
    "# Sample", filler,
    "## Moving", "Move the workspace with care.",
    "## Ignore files", "Some lead-in text.", "List paths in the ignore file to skip them when you move.",
  ].join("\n");
  const excerpt = extractSearchExcerpt(content, "Sample", new Set(["ignore", "skip", "move"]));
  assert.equal(excerpt, "# Sample\n...\n## Ignore files\nSome lead-in text.\nList paths in the ignore file to skip them when you move.");
});

test("headings inside code fences do not start a section", () => {
  const content = [
    "# Sample", filler,
    "## Shell", "Run this:", "```", "# frobnicate the widget", "```",
  ].join("\n");
  assert.equal(
    extractSearchExcerpt(content, "Sample", new Set(["frobnicate"])),
    "# Sample\n...\n## Shell\nRun this:\n```\n# frobnicate the widget\n```",
  );
});

test("no matched terms keeps the first screen", () => {
  const content = ["# Sample", filler, "## Later", "Something else."].join("\n");
  assert.equal(extractSearchExcerpt(content, "Sample", new Set()), extractSearchExcerpt(content, "Sample", new Set(["absent"])));
  assert.match(extractSearchExcerpt(content, "Sample", new Set()), /^# Sample\nIntro line 0/);
});

test("a long line before the hit is dropped so the hit still shows", () => {
  const content = ["# T", filler, "## Deep", "a", "b", "c", "W ".repeat(400), "frobtok here"].join("\n");
  assert.equal(extractSearchExcerpt(content, "T", new Set(["frobtok"])), "# T\n...\n## Deep\n...\nfrobtok here");
});

test("a hit line too long for the budget is shown from shortly before the hit", () => {
  const content = ["# T", filler, "## Deep", `${"lead ".repeat(200)}frobtok and the rest`].join("\n");
  const excerpt = extractSearchExcerpt(content, "T", new Set(["frobtok"]));
  assert.match(excerpt, /^# T\n\.\.\.\n## Deep\n\.\.\.lead /);
  assert.match(excerpt, /frobtok and the rest$/);
});

test("a section right under the title gets no ellipsis before it", () => {
  const content = ["# T", "## First", filler, "frobtok here"].join("\n");
  assert.equal(extractSearchExcerpt(content, "T", new Set(["frobtok"])), "# T\n## First\n...\nIntro line 19 about general things in this topic.\nfrobtok here");
});

test("a topic whose body has no title line opens with its title", () => {
  const content = ["---", "title: Apps", "---", "## Built-in apps", filler, "## Later", "frobtok here"].join("\n");
  assert.equal(extractSearchExcerpt(content, "Apps", new Set(["frobtok"])), "# Apps\n...\n## Later\nfrobtok here");
});

test("an over-long hit line is windowed on the word the stem came from", () => {
  // `approval` stems to `approve`, and `approves` (an earlier, different
  // word starting with the stem) must not anchor the window.
  const line = `${"lead ".repeat(10)}approvesque ${"lead ".repeat(200)}approval needed`;
  const content = ["# T", filler, "## Deep", line].join("\n");
  assert.match(extractSearchExcerpt(content, "T", new Set(["approve"])), /approval needed$/);
});

test("a manual search for a word whose stem differs still shows it", async () => {
  // integration.md has `directories` deep in a 2700-character line.
  const result = (await searchAgentKnowledgeDocs("directories")).find((r) => r.slug === "integration");
  assert.ok(result, "integration is among the results");
  assert.match(result.firstScreen, /directories/i);
});
