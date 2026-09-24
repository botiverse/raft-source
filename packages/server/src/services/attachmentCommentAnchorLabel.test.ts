import assert from "node:assert/strict";
import { test } from "vitest";

import { renderAnchorLabel, renderAgentCommentScopeLine } from "./attachmentCommentAnchorLabel.js";

// Agent scope-line contract (task #37): short, stable, honest — quote capped,
// structural fallback when a quote is missing, null only when there is no
// anchor at all (the scope line then carries just the filename).

test("anchor labels: per-shape rendering, quote-first where quotes exist", () => {
  assert.equal(renderAnchorLabel("lines", { start: 3, end: 7, quote: "口径" }), "L3–L7 ·「口径」");
  assert.equal(renderAnchorLabel("lines", { start: 5, end: 5 }), "L5");
  assert.equal(renderAnchorLabel("csv-rows", { start: 2, end: 4 }), "row 2–4");
  assert.equal(
    renderAnchorLabel("md-section", { headingId: "h-1", headingTitle: "Rollout plan" }),
    "§ Rollout plan",
  );
  assert.equal(
    renderAnchorLabel("html-region", { x: 100, y: 200, w: 300, h: 150, documentWidth: 1000, documentHeight: 2000, quote: "Activation D0≥35" }),
    "region (10%, 10%, 300×150px) ·「Activation D0≥35」",
  );
  // html-region with quote but no valid coordinates: quote only.
  assert.equal(
    renderAnchorLabel("html-region", { quote: "Activation D0≥35" }),
    "「Activation D0≥35」",
  );
  // html-region with no quote: normalized coordinates so agents know the region.
  assert.equal(
    renderAnchorLabel("html-region", { x: 100, y: 200, w: 300, h: 150, documentWidth: 1000, documentHeight: 2000 }),
    "region (10%, 10%, 300×150px)",
  );
  // html-region with no quote and no document dimensions: absolute coordinates.
  assert.equal(renderAnchorLabel("html-region", { x: 1, y: 2, w: 3, h: 4 }), "region (1, 2, 3×4px)");
  // video-timestamp: formatted as MM:SS or HH:MM:SS.
  assert.equal(renderAnchorLabel("video-timestamp", { time: 42 }), "0:42");
  assert.equal(renderAnchorLabel("video-timestamp", { time: 82.5 }), "1:22");
  assert.equal(renderAnchorLabel("video-timestamp", { time: 3661 }), "1:01:01");
  assert.equal(renderAnchorLabel("video-timestamp", { time: 0 }), "0:00");
});

test("anchor labels: quotes are whitespace-collapsed and capped", () => {
  const long = "x".repeat(200);
  const label = renderAnchorLabel("html-region", { quote: `  a\n\n b   c ${long}` });
  assert.ok(label!.startsWith("「a b c"));
  assert.ok(label!.length < 120, "capped well below the raw quote length");
  assert.ok(label!.includes("…"), "truncation is visible");
});

test("anchor labels: garbage in → null, not a crash or a fake label", () => {
  assert.equal(renderAnchorLabel(null, null), null);
  assert.equal(renderAnchorLabel("lines", null), null);
  assert.equal(renderAnchorLabel("lines", "not-an-object"), null);
  assert.equal(renderAnchorLabel("unknown-type", { start: 1 }), null);
});

test("scope line: filename always present; anchor label appended when usable", () => {
  assert.equal(
    renderAgentCommentScopeLine("report.html", "lines", { start: 3, end: 7 }),
    "[re: report.html · L3–L7]",
  );
  assert.equal(renderAgentCommentScopeLine("report.html", null, null), "[re: report.html]");
  assert.equal(
    renderAgentCommentScopeLine("demo.mp4", "video-timestamp", { time: 95 }),
    "[re: demo.mp4 · 1:35]",
  );
});

test("md-section: multiline/long titles stay one-line and dedupe against the quote (Dozy PR #2856 review)", () => {
  const messyTitle = "  Rollout\n\nplan   for\tQ3 " + "x".repeat(100);
  // Title alone: collapsed to one line, capped, visible truncation.
  const alone = renderAnchorLabel("md-section", { headingId: "h", headingTitle: messyTitle });
  assert.ok(!alone!.includes("\n"), "scope label must stay one line");
  assert.ok(alone!.startsWith("§ Rollout plan for Q3"));
  assert.ok(alone!.includes("…"));
  // Quote == same messy heading: capped quote must equal capped title → no
  // `§ title… ·「title…」` duplication.
  const deduped = renderAnchorLabel("md-section", {
    headingId: "h",
    headingTitle: messyTitle,
    quote: messyTitle,
  });
  assert.equal(deduped, alone, "identical title/quote renders once, not duplicated");
});
