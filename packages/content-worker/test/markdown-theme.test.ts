import assert from "node:assert/strict";
import test from "node:test";
import { Script } from "node:vm";

import { compile, defineDisplays, DEFAULT_THEME_VARIABLES, LIBRARY_CDNS } from "@botiverse/porthole";
import { ARTIFACT_PAGE_CARD_MIN_WIDTH_PX, ARTIFACT_PAGE_COLORS, ARTIFACT_PAGE_THEME_TOKENS, ARTIFACT_PAGE_THEME_VARIABLES } from "@botiverse/raft-shared/src/artifactPageTheme";
import { renderMarkdownToHtml } from "../src/markdown";
import { raftDisplays } from "../src/raftContentDisplays";

/**
 * A Markdown page follows Raft's theme through `--raft-*` variables and, with no theme, looks as it
 * always has (#proj-workspace:#219). The page is checked as text: what a browser does with it, a
 * theme switched with the page open included, is the web's frame and a person's eyes.
 */
const DOCUMENT = "# Title\n\n## Part\n\n`code` and [a link](https://example.com)\n\n> quote\n\n| a |\n|---|\n| b |\n\n```mermaid\ngraph TD; A-->B\n```\n\n```\nplain\n```\n";

function styleOf(page: string): string {
  const match = /<style>([\s\S]*)<\/style>/.exec(page);
  assert.ok(match, "the page's style");
  return match[1]!;
}

/** The light values print is reset to: literal, by design, so left out of what is checked for colours. */
const PRINT_RULES = /@media print \{[\s\S]*?\n  \}/;

function mediaBlocks(css: string, query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  assert.notEqual(start, -1, query);
  return css.slice(start, css.indexOf("\n  }", start));
}

function scriptsOf(page: string): string[] {
  return [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!);
}

/** Each `var(--raft-…, fallback)` of `css`, by a walk, as a fallback holds parentheses of its own. */
function variablesOf(css: string): { start: number; end: number; name: string; fallback: string }[] {
  const found: { start: number; end: number; name: string; fallback: string }[] = [];
  for (const match of css.matchAll(/var\((--raft-[a-z0-9-]+), /g)) {
    const from = match.index + match[0].length;
    let depth = 1;
    let at = from;
    for (; depth > 0; at += 1) {
      if (css[at] === "(") depth += 1;
      if (css[at] === ")") depth -= 1;
    }
    found.push({ start: match.index, end: at, name: match[1]!, fallback: css.slice(from, at - 1) });
  }
  return found;
}

function replaced(css: string, each: (variable: { name: string; fallback: string }) => string): string {
  let out = "";
  let at = 0;
  for (const variable of variablesOf(css)) {
    out += css.slice(at, variable.start) + each(variable);
    at = variable.end;
  }
  return out + css.slice(at);
}

test("every colour of the page is a variable: none is left hard-coded outside one", () => {
  const css = styleOf(renderMarkdownToHtml(DOCUMENT, "Doc"));
  const outside = replaced(css.replace(PRINT_RULES, ""), () => "");
  assert.equal(/#[0-9a-f]{3,8}\b|\b(?:oklch|oklab|rgba?|hsla?|lab|lch|color-mix)\(|:\s*(?:white|black)\b/iu.exec(outside)?.[0], undefined);
  assert.ok(variablesOf(css).length > 40, "the page's colours went through the variables");
});

test("each variable falls back to the table's light value, so the names and values can't drift", () => {
  const variables = variablesOf(styleOf(renderMarkdownToHtml(DOCUMENT, "Doc")));
  for (const { name, fallback } of variables) assert.equal(fallback, ARTIFACT_PAGE_THEME_VARIABLES[name], name);
  assert.deepEqual([...new Set(variables.map(({ name }) => name))].sort(), Object.keys(ARTIFACT_PAGE_THEME_VARIABLES).sort(), "the table carries nothing the page doesn't draw with");
});

test("with no theme the page is drawn in the values it always was", () => {
  const css = replaced(styleOf(renderMarkdownToHtml(DOCUMENT, "Doc")), ({ fallback }) => fallback);
  const ink = "oklch(0.1813 0.005 17.62)";
  for (const rule of [
    `body { margin: 0; background: #fff; color: ${ink};`,
    ".doc { background: #fff;",
    "nav.outline { border-left: 1px solid oklch(0.1813 0.005 17.62 / 0.149);",
    "color: oklch(0.1813 0.005 17.62 / 0.62); margin-bottom: 0.5rem;",
    "color: oklch(0.1813 0.005 17.62 / 0.678); text-decoration: none;",
    ".doc :not(pre) > code { padding: 0 .25rem; border-radius: 4px; background: oklch(0.9642 0 0);",
    `border-radius: 10px; background: #fff; color: ${ink};`,
    ".code-copy:hover, .code-copy:focus-visible { color: oklch(0.1813 0.005 17.62); background: oklch(0.1813 0.005 17.62 / 0.078); }",
    "background-color: #fff; background-image: linear-gradient(45deg,oklch(0.9642 0 0) 25%,transparent 25%)",
    ".doc th, .doc td { border-bottom: 1px solid oklch(0.1813 0.005 17.62 / 0.149);",
    ".doc blockquote { margin: .5rem 0; border-left: 2px solid oklch(0.1813 0.005 17.62 / 0.451);",
    ".doc a { color: oklch(0.4878 0.2432 264.4);",
    `accent-color: ${ink};`,
    "overflow: hidden; background: #fff; }",
    `.mermaid-tab.is-active { background: oklch(0.883 0.162 91.89); color: ${ink}; box-shadow: inset 0 0 0 1.5px ${ink}; }`,
    ".mermaid-alert { margin: 0; border-top: 1px solid oklch(0.1813 0.005 17.62 / 0.149); background: oklch(0.9413 0.0275 40.2);",
    "background: rgba(0,0,0,.85); }",
    "border-radius: 16px; background: #fff;",
  ]) assert.ok(css.includes(rule), rule);
});

test("with no theme there is no card: its ground and card fall back to the same white as the page", () => {
  for (const token of ["--layer-sidebar", "--layer-card"] as const) assert.equal(ARTIFACT_PAGE_COLORS[token], ARTIFACT_PAGE_COLORS["--layer-canvas"], token);
  const page = renderMarkdownToHtml(DOCUMENT, "Doc");
  // The markup is one for both; only the attribute, which the page sets from the colours, tells them apart.
  assert.equal(/<html[^>]*data-raft-card/.test(page), false, "served without the attribute");
  const surface = scriptsOf(page).find((script) => script.includes("followSurface"));
  assert.ok(surface, "the surface's script");
  assert.ok(surface.includes('if (ground.join() !== card.join()) root.setAttribute("data-raft-card", "");'), "only where they paint apart");
  assert.ok(surface.includes('else root.removeAttribute("data-raft-card");'), "and taken away again");
});

test("the card is screen only, from a wide page, and every rule of it asks for the attribute", () => {
  const css = styleOf(renderMarkdownToHtml(DOCUMENT, "Doc"));
  assert.equal(ARTIFACT_PAGE_CARD_MIN_WIDTH_PX, 1024, "wide empty space on both sides of the 48rem column");
  const wide = `screen and (min-width: ${ARTIFACT_PAGE_CARD_MIN_WIDTH_PX}px)`;
  const card = replaced(mediaBlocks(css, wide), ({ fallback }) => fallback);
  for (const rule of [
    ":root[data-raft-card] body { background: #fff; }",
    ":root[data-raft-card] .page { padding: 2.5rem 2rem; }",
    ":root[data-raft-card] .doc { border: 1px solid oklch(0.1813 0.005 17.62 / 0.149); border-radius: 10px; background: #fff; padding: 3rem 2.5rem; }",
    ":root[data-raft-card] .doc img { background-color: #fff; }",
  ]) assert.ok(card.includes(rule), rule);
  // Nowhere else: narrower (a phone, a medium page) there is no tinted ground, no sheet and none of
  // its padding: the text sits on the canvas (Kirby, xxchan).
  const elsewhere = css.replace(mediaBlocks(css, wide), "");
  assert.equal(elsewhere.includes("data-raft-card"), false);
  assert.equal(css.includes("@media screen and (min-width: 640px)"), false, "no medium sheet");
  assert.equal(css.includes("@media screen and (min-width: 768px)"), false, "nor its medium padding");
  // Every selector in the block is behind the attribute, so a page without it can't match one.
  for (const line of card.split("\n").map((each) => each.trim()).filter((each) => each.includes("{") && !each.startsWith("@media"))) {
    assert.ok(line.startsWith(":root[data-raft-card] "), line);
  }
});

test("print takes every colour back to its light value, over the host's inline ones, and no card", () => {
  const css = styleOf(renderMarkdownToHtml(DOCUMENT, "Doc"));
  const print = PRINT_RULES.exec(css)?.[0];
  assert.ok(print, "the print rules");
  for (const [name, value] of Object.entries(ARTIFACT_PAGE_THEME_VARIABLES)) assert.ok(print.includes(`${name}: ${value} !important;`), name);
  assert.ok(print.includes(':root[data-raft-surface="dark"] { color-scheme: light; }'));
  assert.equal(print.includes("data-raft-card"), false);
});

test("the surface is judged from the document as painted: the card, or the canvas on a phone or with no theme", () => {
  const surface = scriptsOf(renderMarkdownToHtml("# Plain", "Doc")).find((script) => script.includes("followSurface"));
  assert.ok(surface, "the surface's script");
  assert.ok(surface.includes("var rgb = painted(getComputedStyle(doc).backgroundColor, \"#fff\");"));
  assert.equal(surface.includes("--raft-layer-canvas"), false, "not the canvas's token: the document is on the card there");
  // The card's attribute first: the surface is read with the card's rules applied.
  assert.ok(surface.indexOf('"data-raft-card", ""') < surface.indexOf("getComputedStyle(doc)"));
});

test("Mermaid stays neutral on a light surface, strict everywhere, and draws again as the theme changes", () => {
  const page = renderMarkdownToHtml(DOCUMENT, "Doc");
  const mermaid = scriptsOf(page).find((script) => script.includes("mermaid.initialize"));
  assert.ok(mermaid, "the diagram script");
  assert.ok(mermaid.includes('return { theme: "neutral" }'));
  assert.ok(mermaid.includes('securityLevel: "strict"'));
  assert.equal(mermaid.match(/securityLevel:/g)?.length, 1, "one initialize config, whichever theme");
  assert.ok(mermaid.includes('attributeFilter: ["style", "data-raft-surface"]'), "the variables' change, and the surface's");
  // A library that didn't load throws here, as it did, before a fence is moved into the diagram.
  assert.ok(mermaid.indexOf("setTheme();\n  Array.from") >= 0, "the first initialize comes before the fences");
  assert.equal(renderMarkdownToHtml("# No diagram", "Doc").includes("mermaid.initialize"), false, "no diagram, none of Mermaid");
});

test("the page takes its dark scrollbars and controls from its own colours, not from Porthole's scheme", () => {
  const page = renderMarkdownToHtml("# Plain", "Doc");
  // Declaring it would make Porthole set `color-scheme` from the person's mode even where the host
  // sends no colours, on a white page (P039), so the page never does.
  assert.equal(/<meta[^>]+color-scheme/i.test(page), false);
  assert.ok(styleOf(page).includes(':root[data-raft-surface="dark"] { color-scheme: dark; }'));
  const surface = scriptsOf(page).find((script) => script.includes("followSurface"));
  assert.ok(surface, "the surface's script, in every page");
  // The first host context comes with no event (P061), and may come after the page's scripts.
  assert.ok(surface.includes('new MutationObserver(followSurface).observe(root, { attributes: true, attributeFilter: ["style"] })'));
  assert.ok(page.indexOf("followSurface") < page.indexOf("code-copy\""), "ahead of the page's other scripts");
});

test("the page's scripts compile (they are text to tsc)", () => {
  const scripts = scriptsOf(renderMarkdownToHtml(DOCUMENT, "Doc"));
  assert.equal(scripts.length, 3);
  // Compiled, never run.
  for (const script of scripts) assert.doesNotThrow(() => new Script(script));
});

test("the theme's names are Raft's own, added to Porthole's, and colours", () => {
  const { variables } = raftDisplays.guideConfig("artifact", "served").theme;
  for (const name of Object.keys(ARTIFACT_PAGE_THEME_VARIABLES)) {
    // A default name is always set inside a frame, so its fallback would never show.
    assert.equal(name in DEFAULT_THEME_VARIABLES, false, name);
    assert.equal(variables[name], ARTIFACT_PAGE_THEME_VARIABLES[name], name);
  }
  // An HTML Artifact keeps what it reads.
  for (const [name, value] of Object.entries(DEFAULT_THEME_VARIABLES)) assert.deepEqual(variables[name], value, name);
  assert.deepEqual(Object.keys(ARTIFACT_PAGE_THEME_TOKENS).sort(), Object.keys(ARTIFACT_PAGE_THEME_VARIABLES).sort());
  assert.deepEqual(Object.values(ARTIFACT_PAGE_THEME_TOKENS).sort(), Object.keys(ARTIFACT_PAGE_COLORS).sort());
});

test("the theme leaves the page's CSP, sandbox, permissions and capabilities as they were", () => {
  const source = "https://*.content.example";
  const themed = raftDisplays.served(source)?.artifact;
  assert.ok(themed);
  const options = {
    egress: LIBRARY_CDNS,
    runtime: "1",
    // As the Worker's own.
    capabilities: { annotate: {}, comments: {}, copyText: {}, find: {}, openLink: {} },
    layout: { kind: "fill" },
    errors: "host",
  } as const;
  const plain = defineDisplays({
    artifact: { preset: "artifact", options, served: { storage: { scope: "this artifact, across its versions" } } },
  }).served(source)?.artifact;
  assert.ok(plain);
  const [was, now] = [compile(plain), compile(themed)];
  assert.equal(now.csp, was.csp);
  assert.deepEqual(now.cspDirectives, was.cspDirectives);
  assert.equal(now.sandbox, was.sandbox);
  assert.equal(now.allow, was.allow);
  assert.deepEqual(now.config.capabilities, was.config.capabilities);
  assert.deepEqual(now.config.egress, was.config.egress);
});
