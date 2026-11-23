// #189 Rule 2 in a clipped column: what follows the head fades over its last 24px, except full-bleed
// media (an HTML or PDF Artifact's frame, an image, the page beside the conversation), which is cut on
// a hard line: faded, a dark page showed the lighter column surface behind it as a white glow
// (raft-design spacing.md "Edges fade", #proj-raft-ui:#270, as mobile #5016). Text keeps the fade.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cutsAtClipEdge } from "../src/apps/artifacts/artifactDrawnKind";

const read = (path: string) => readFileSync(resolve(import.meta.dirname, "..", path), "utf8");
const uncommented = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

describe("cutsAtClipEdge", () => {
  it("cuts an HTML or PDF page in the frame and an image", () => {
    assert.equal(cutsAtClipEdge("html", "html", true), true);
    assert.equal(cutsAtClipEdge("pdf", "pdf", true), true);
    assert.equal(cutsAtClipEdge("image", "image", true), true);
    assert.equal(cutsAtClipEdge("html", "pdf", false), true, "a PDF of an HTML set opens in the frame");
    assert.equal(cutsAtClipEdge("markdown", "html", false), true, "another page of a Markdown set");
    assert.equal(cutsAtClipEdge("html", "image", false), true, "an image of the set, drawn by Raft");
  });

  it("fades a Markdown document, text, a csv and No preview", () => {
    assert.equal(cutsAtClipEdge("markdown", "markdown", true), false);
    assert.equal(cutsAtClipEdge("html", "markdown", false), false, "a Markdown file of an HTML set is still a document");
    assert.equal(cutsAtClipEdge("text", "text", true), false);
    assert.equal(cutsAtClipEdge("csv", "csv", true), false);
    assert.equal(cutsAtClipEdge("video", "video", true), false, "no preview");
    assert.equal(cutsAtClipEdge("image", "pdf", false), false, "a PDF beside a drawn entry has no preview");
  });
});

test("index.css takes the clipped column's fade off a body marked data-clip-edge=cut, after the fade rule", () => {
  const css = uncommented(read("src/index.css"));
  const fade = css.indexOf('[data-clipped] [data-slot="panel-header"] ~ *,');
  assert.ok(fade >= 0, "the Rule 2 fade rule");
  const cut = css.match(/\[data-clipped\] \[data-clip-edge="cut"\]:not\(#_\)\s*\{([^}]*)\}/);
  assert.ok(cut, "a rule for [data-clipped] [data-clip-edge=\"cut\"] that outranks the RowRegionBody selector");
  assert.ok(cut.index! > fade, "it comes after the fade rule");
  assert.match(cut[1]!, /(^|[;\s])mask-image:\s*none/);
  assert.match(cut[1]!, /-webkit-mask-image:\s*none/);
  assert.doesNotMatch(cut[1]!, /min-width|overflow/, "the content's minimum and the clip stay");
});

test("the full-bleed bodies under a head carry the marker", () => {
  // The Artifact's body (SurfaceBody: the masked node, RowRegionBody being display: contents).
  assert.match(read("src/apps/artifacts/ArtifactSurface.tsx"), /useShownCutsAtClipEdge\(data\)[\s\S]*?data-clip-edge=\{cut \? "cut" : undefined\}[^>]*data-testid=\{`artifact-\$\{kind\}-layout`\}/);
  // The page beside the conversation, framed and in Raft Desktop's browser.
  assert.match(read("src/features/webPreview/WebPreviewPanel.tsx"), /\{framed \? \([\s\S]{0,200}data-clip-edge="cut"/);
  assert.match(read("src/features/webPreview/BrowserPanel.tsx"), /<RowRegionBody>[\s\S]{0,200}data-clip-edge=\{active\.url === null \? undefined : "cut"\}/);
});
