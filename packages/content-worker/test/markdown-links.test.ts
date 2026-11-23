import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdownToHtml } from "../src/markdown";

/**
 * A bare address (GFM's literal link) ends before the full-width punctuation a CJK sentence puts
 * straight after it, as the server reads the page's links (shared bareLinkEnd.ts;
 * contentLinks.ts), so the link opens the address written and the viewer's title for it matches
 * (#proj-deploy:#17). A link with an explicit end (`[words](url)`, `<url>`) keeps it. Characters
 * are written as escapes.
 */
const ARTIFACT = "https://app.raft.build/artifacts/H6XqAbcDEF123";

/** The page's first paragraph. */
function paragraph(markdown: string): string {
  const page = renderMarkdownToHtml(markdown, "Links");
  const match = /<p>[\s\S]*?<\/p>/.exec(page);
  assert.ok(match, "a paragraph");
  return match[0];
}

const anchor = (href: string, text = href) => `<a href="${href}">${text}</a>`;

test("a CJK aside straight after a bare link is text after the link", () => {
  // "See <link>(v10, round 6)", in Chinese with full-width parentheses and comma.
  const aside = "\uff08v10\uff0c\u7b2c 6 \u8f6e\uff09";
  assert.equal(paragraph(`\u89c1 ${ARTIFACT}${aside}`), `<p>\u89c1 ${anchor(ARTIFACT)}${aside}</p>`);
});

test("a full-width comma, full stop or closing corner bracket ends a bare link", () => {
  for (const mark of ["\uff0c", "\u3002", "\u300d"]) {
    assert.equal(paragraph(`\u300c${ARTIFACT}${mark}rest`), `<p>\u300c${anchor(ARTIFACT)}${mark}rest</p>`, mark);
  }
});

test("the cut link still loses its trailing punctuation; `www.` links are cut too", () => {
  assert.equal(paragraph(`x ${ARTIFACT}.\uff08y\uff09`), `<p>x ${anchor(ARTIFACT)}.\uff08y\uff09</p>`);
  assert.equal(paragraph("x www.example.com/a\u3002b"), `<p>x ${anchor("http://www.example.com/a", "www.example.com/a")}\u3002b</p>`);
  // A second link right after the punctuation is a link of its own.
  assert.equal(paragraph(`${ARTIFACT}\uff08https://example.com/y\uff09`), `<p>${anchor(ARTIFACT)}\uff08${anchor("https://example.com/y")}\uff09</p>`);
});

test("a bare link starts wherever `http(s)://` is written, after any character (the server reads the same)", () => {
  // "Conclusion:<link> (v10" in Chinese: a full-width colon straight before, a space after.
  assert.equal(paragraph(`\u7ed3\u8bba\uff1a${ARTIFACT} \uff08v10`), `<p>\u7ed3\u8bba\uff1a${anchor(ARTIFACT)} \uff08v10</p>`);
  assert.equal(paragraph("abchttps://x.test/a"), `<p>abc${anchor("https://x.test/a")}</p>`);
  assert.equal(paragraph("(https://x.test/a)"), `<p>(${anchor("https://x.test/a")})</p>`);
  assert.equal(paragraph("\u300chttps://x.test/a\u300d"), `<p>\u300c${anchor("https://x.test/a")}\u300d</p>`);
  assert.equal(paragraph("x=https://x.test/a"), `<p>x=${anchor("https://x.test/a")}</p>`);
  // An address within a bare link's characters is part of it.
  assert.equal(paragraph("https://x.test/https://y.test/b"), `<p>${anchor("https://x.test/https://y.test/b")}</p>`);
});

test("ASCII parentheses keep GFM's rule", () => {
  assert.equal(
    paragraph("x https://en.wikipedia.org/wiki/Foo_(bar) (see https://example.com/y)"),
    `<p>x ${anchor("https://en.wikipedia.org/wiki/Foo_(bar)")} (see ${anchor("https://example.com/y")})</p>`,
  );
});

test("an explicit link or an autolink keeps its full-width characters", () => {
  const written = `${ARTIFACT}\uff08\uff09`;
  const encoded = `${ARTIFACT}%EF%BC%88%EF%BC%89`;
  assert.equal(paragraph(`[x](${written})`), `<p>${anchor(encoded, "x")}</p>`);
  assert.equal(paragraph(`<${written}>`), `<p>${anchor(encoded, written)}</p>`);
});
