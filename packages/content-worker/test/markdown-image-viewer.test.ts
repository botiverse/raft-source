import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";

import { renderMarkdownToHtml } from "../src/markdown";

/**
 * A Markdown page's images open in the page's own viewer (#proj-workspace:#288). Here as text: the
 * viewer comes with a page that has an image and only then, and its script compiles. What it does
 * in a browser (open, zoom, pan, close, a linked image left to its link) is
 * scripts/raft-content-image-viewer-browser-smoke.ts.
 */
function scriptsOf(page: string): string[] {
  return [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

const viewerScript = (page: string) => scriptsOf(page).find((script) => script.includes("image-viewer"));

test("a page with an image carries the viewer; one without doesn't", () => {
  assert.ok(viewerScript(renderMarkdownToHtml("# Shot\n\n![the chart](chart.png)\n", "Doc")));
  assert.ok(viewerScript(renderMarkdownToHtml('Raw HTML too: <img src="chart.png" alt="">\n', "Doc")));
  assert.equal(viewerScript(renderMarkdownToHtml("# Words\n\nNo pictures.\n", "Doc")), undefined);
});

test("the viewer's script compiles (it is text to tsc)", () => {
  const script = viewerScript(renderMarkdownToHtml("![a](a.png)", "Doc"));
  assert.ok(script);
  // Compiled, never run.
  assert.doesNotThrow(() => new Script(script));
});

test("the viewer's style uses the page's colour variables, as the rest of the page", () => {
  const page = renderMarkdownToHtml("![a](a.png)", "Doc");
  const rules = page.split("\n").filter((line) => line.includes(".image-viewer") && /(background|color|box-shadow):/.test(line));
  assert.ok(rules.length > 0);
  // Every colour through a `--raft-*` variable (its fallback the light value: markdown-theme.test.ts checks those).
  for (const rule of rules) {
    for (const value of rule.matchAll(/(?:background|color|box-shadow):([^;]+);/g)) assert.match(value[1]!, /var\(--raft-/, rule);
  }
});
