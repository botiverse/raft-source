import assert from "node:assert/strict";
import test from "node:test";
import { buildMermaidSrcDoc, parseSvgAspect } from "../src/components/markdown/mermaid/mermaidFrame";

test("parseSvgAspect reads viewBox width/height", () => {
  assert.deepEqual(parseSvgAspect('<svg viewBox="0 0 640 480"></svg>'), { w: 640, h: 480 });
  assert.deepEqual(parseSvgAspect("<svg viewBox='0 0 100.5 50.25'></svg>"), { w: 100.5, h: 50.25 });
});

test("parseSvgAspect falls back to width/height attrs, then 4:3", () => {
  assert.deepEqual(parseSvgAspect('<svg width="300" height="150"></svg>'), { w: 300, h: 150 });
  assert.deepEqual(parseSvgAspect("<svg>no dims</svg>"), { w: 4, h: 3 });
  assert.deepEqual(parseSvgAspect('<svg viewBox="0 0 0 0"></svg>'), { w: 4, h: 3 });
});

test("buildMermaidSrcDoc wraps the SVG in a CSP-locked html doc", () => {
  const doc = buildMermaidSrcDoc('<svg id="d"><rect/></svg>');
  assert.match(doc, /^<!doctype html>/);
  assert.match(doc, /Content-Security-Policy/);
  assert.match(doc, /default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
  assert.ok(doc.includes('<svg id="d"><rect/></svg>'), "embeds the SVG verbatim");
});

test("buildMermaidSrcDoc lets layout-settle zoom grow past Mermaid's inline natural max-width", () => {
  const doc = buildMermaidSrcDoc(
    '<svg style="max-width:177.02px" viewBox="0 0 177.02 557"><rect/></svg>',
  );
  assert.match(
    doc,
    /svg\{display:block;width:100%;max-width:none!important;height:auto\}/,
    "the sandbox stylesheet must beat Mermaid's inline max-width after the iframe grows past natural size",
  );
});

test("isolation property: even a hostile SVG is only ever embedded in the srcDoc string (framed, not injected)", () => {
  // The empty-sandbox iframe — not stripping — is what neutralizes this. The
  // builder must NOT execute/sanitize; it just wraps. Safety is the frame.
  const hostile =
    '<svg onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><foreignObject><img src=x onerror=alert(4)></foreignObject></svg>';
  const doc = buildMermaidSrcDoc(hostile);
  // It's a plain string destined for iframe srcDoc (empty sandbox) — verified
  // structurally by the contract test. Here we just assert the builder is a
  // pure wrapper (no eval/DOM) and keeps the payload contained in the doc.
  assert.ok(doc.includes(hostile));
  assert.match(doc, /default-src 'none'/);
  assert.equal(typeof doc, "string");
});
