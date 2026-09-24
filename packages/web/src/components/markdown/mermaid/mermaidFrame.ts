// Pure helpers for framing an official Mermaid SVG inside a sandboxed iframe.
// Kept dependency-free so they unit-test under node:test directly.

/** Aspect ratio (w/h) parsed from the generated SVG so the sandboxed iframe
 *  can size itself with CSS `aspect-ratio` (no JS measurement, no double
 *  scrollbar, no clipping). Falls back to a sane 4:3 when unparseable. */
export function parseSvgAspect(svg: string): { w: number; h: number } {
  const vb = svg.match(/viewBox\s*=\s*["']\s*[\d.eE+-]+\s+[\d.eE+-]+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s*["']/);
  if (vb) {
    const w = Number(vb[1]);
    const h = Number(vb[2]);
    if (w > 0 && h > 0) return { w, h };
  }
  const wAttr = svg.match(/\bwidth\s*=\s*["']\s*([\d.]+)/);
  const hAttr = svg.match(/\bheight\s*=\s*["']\s*([\d.]+)/);
  const w = wAttr ? Number(wAttr[1]) : NaN;
  const h = hAttr ? Number(hAttr[1]) : NaN;
  if (w > 0 && h > 0) return { w, h };
  return { w: 4, h: 3 };
}

/**
 * Minimal HTML document that frames the SVG. Defense-in-depth on top of the
 * empty-sandbox iframe: a strict CSP meta blocks any network/script the SVG
 * might try, even though the empty sandbox already forbids script execution
 * and same-origin access entirely.
 */
export function buildMermaidSrcDoc(svg: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    '<meta http-equiv="Content-Security-Policy" ',
    "content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:\">",
    // overflow:hidden — the document and the SVG share an aspect ratio, so
    // any overflow is sub-pixel rounding; without it the iframe grows an
    // internal scrollbar whose track magnifies into a visible stripe under
    // the zoom transform (Artea, acceptance 07-30).
    "<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}",
    // Official Mermaid writes a natural-pixel max-width inline. The outer
    // layout-settle zoom intentionally grows this iframe beyond that natural
    // size so Chromium repaints the vector at the settled resolution; without
    // the important override, only the empty SVG canvas grows while the graph
    // stays pinned at its old size in a corner.
    "svg{display:block;width:100%;max-width:none!important;height:auto}</style></head>",
    `<body>${svg}</body></html>`,
  ].join("");
}
