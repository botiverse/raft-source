// The readable text of an Artifact's entry for the signed-out index.md and
// meta routes (readableText.ts). Proves: an HTML page's text without its
// markup, with block breaks; script, style, noscript, template, svg and
// title skipped, nested tags in them too; quoted `>` in attributes, comments,
// stray `<` and an unterminated tag; character references; `pre` kept; an
// image's alt text kept where it is (extractor 1); a description collapsed
// and cut at a word with "…"; a first heading repeating the title left out
// of the description (extractor 1); markdownPlainText's text the same as its
// regexes' were, in linear time on a long hostile input; and a card's excerpt
// of a Markdown entry: plain words with their blocks, bounded, no tag a browser
// could open outside inline code, whose text stays as written; emphasis gone
// in Chinese too.
import assert from "node:assert/strict";
import { ARTIFACT_EXCERPT_MAX_CHARS, ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS } from "@botiverse/raft-shared";
import { decodeCharacterReferences, describe as describeText, htmlReadableText, markdownExcerpt, markdownPlainText, withoutTitleHeading } from "./readableText";

describe("htmlReadableText", () => {
  test("keeps the text and its blocks, drops the markup", () => {
    const html = "<!doctype html><html><head><title>T</title><meta name=x content='a>b'></head>"
      + "<body><div><h2 class=\"x>y\">Heading</h2><p>One <em>two</em>\n   three.</p><p>Four<br>five</p>"
      + "<ul><li>a</li><li>b <a href=\"/x\">link</a></li></ul><table><tr><td>c1</td><td>c2</td></tr></table></div></body></html>";
    assert.equal(htmlReadableText(html), "## Heading\n\nOne two three.\n\nFour\nfive\n\n- a\n- b link\n\nc1 c2");
  });

  test("skips script, style, noscript, template, svg and title with what they hold", () => {
    const html = "<p>keep</p><script>if (a < b) document.write('<p>no</p>')</script><style>p>a{}</style>"
      + "<noscript><p>no js</p></noscript><template><div>tpl</div></template>"
      + "<svg viewBox='0 0 1 1'><svg><text>inner</text></svg><text>outer</text></svg><svg/><p>after</p>"
      + "<SCRIPT type=module>alert(1)</SCRIPT ><p>end</p>";
    assert.equal(htmlReadableText(html), "keep\n\nafter\n\nend");
  });

  test("comments, processing instructions, a stray < and an unterminated tag never leak markup", () => {
    assert.equal(htmlReadableText("a <!-- <p>hidden</p> --> b <?xml x?> c < d 1<2"), "a b c < d 1<2");
    assert.equal(htmlReadableText("<p>shown</p><img src=\"x"), "shown");
    assert.equal(htmlReadableText("<p>open<!-- never closed"), "open");
  });

  test("decodes character references; keeps pre's whitespace", () => {
    assert.equal(htmlReadableText("<p>&lt;b&gt; &amp;amp; &#65;&#x42; caf&eacute; &bogus; &constructor;</p>"), "<b> &amp; AB caf&eacute; &bogus; &constructor;");
    assert.equal(htmlReadableText("<p>intro</p><pre>  x\n    y</pre><p>a   b</p>"), "intro\n\n  x\n    y\n\na b");
    assert.equal(decodeCharacterReferences("&#0; &#xD800; &#x1F600;"), "\uFFFD \uFFFD 😀");
  });

  test("keeps an image's alt text where the image is; a decorative one (no alt, alt=\"\") says nothing", () => {
    const html = "<h1>Report</h1><p>Revenue<img src=chart.png alt=\"Revenue by quarter &amp; region\">grew.</p>"
      + "<p><img src=deco.png alt=\"\"><img src=x.png><IMG SRC='y.png' ALT='Logo'/></p>"
      // An alt inside another attribute's value is not the image's.
      + "<p><img title='alt=\"no\"' alt=yes></p><svg><img alt=\"inside svg\"></svg>";
    assert.equal(htmlReadableText(html), "# Report\n\nRevenue Revenue by quarter & region grew.\n\nLogo\n\nyes");
  });

  test("is linear on a large page", () => {
    const html = `<html><body>${"<div><p>text &amp; more</p></div>".repeat(50_000)}</body></html>`;
    const started = Date.now();
    const text = htmlReadableText(html);
    assert.ok(Date.now() - started < 2_000);
    assert.ok(text.startsWith("text & more"));
  });
});

describe("describe", () => {
  test("whitespace collapsed; short text whole", () => {
    assert.equal(describeText("  a\n\n b\tc  "), "a b c");
  });

  test("cut at a word boundary, then …", () => {
    const text = Array.from({ length: 80 }, (_, i) => `w${i}`).join(" ");
    const out = describeText(text);
    assert.ok(out.endsWith("…"));
    const kept = out.slice(0, -1);
    assert.ok(Array.from(kept).length <= ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS);
    assert.ok(text.startsWith(`${kept} `), "a whole number of words");
  });

  test("a single word longer than the limit is cut where it reaches it; characters are never split", () => {
    const out = describeText("😀".repeat(200));
    assert.equal(out, `${"😀".repeat(ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS)}…`);
  });

  test("exactly the limit is not cut", () => {
    const text = "x".repeat(ARTIFACT_PUBLIC_DESCRIPTION_MAX_CHARS);
    assert.equal(describeText(text), text);
  });
});

test("markdownPlainText drops headings, list markers, emphasis, links and images", () => {
  assert.equal(
    markdownPlainText("# Title\n\n> quote\n\n- **bold** and _it_ [link](https://x) ![alt](i.png) `code`\n1. one"),
    "Title\n\nquote\n\nbold and it link alt code\none",
  );
});

describe("markdownPlainText is the regexes it replaced, in linear time", () => {
  /** What it was as regexes: frozen here, because stored descriptions (READABLE_TEXT_EXTRACTOR) came from it. */
  const asRegexes = (markdown: string): string => markdown
    .replace(/^```.*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]{0,3}(#{1,6}|>+|[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^\n]*?\S)\1/g, "$2")
    .replace(/<[^>]*>/g, "");

  test("the same text as the regexes on ordinary Markdown", () => {
    const markdown = [
      "# Title ##", "", "> quoted **bold** line", "- item with `code` and [a link](https://x.test/a_b_c)", "1. [a link\nover two lines](https://x.test)",
      "[![badge](b.png)](https://x.test) and ![alt](i.png)", "**a *nested* b** ***both*** __under__ ~~gone~~ snake_case_name 2 * 3 * 4", "",
      "```ts", "const a = b[0](c) < d;", "```", "<div class=\"a\">html</div> a [stray bracket and [link](x) 1 < 2", "[ ] todo [ref][1] [^1]",
    ].join("\n");
    assert.equal(markdownPlainText(markdown), asRegexes(markdown));
  });

  test("the same text as the regexes on any mix of its markers (seeded, so every run reads the same strings)", () => {
    const tokens = [
      "*", "**", "***", "_", "__", "`", "~", "~~", "[", "]", "(", ")", "![", "](", "<", ">", "!", "```", "\\", "#", "# ", "> ", "- ", "1. ",
      " ", "  ", "\t", "\n", "\r\n", " ", " ", "a", "b c", "中", "😀",
    ];
    let seed = 20261107;
    const below = (limit: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % limit;
    };
    for (let round = 0; round < 20_000; round += 1) {
      const markdown = Array.from({ length: 1 + below(14) }, () => tokens[below(tokens.length)]!).join("");
      assert.equal(markdownPlainText(markdown), asRegexes(markdown), JSON.stringify(markdown));
    }
  });

  const elapsedMs = (markdown: string): number => {
    const started = Date.now();
    markdownPlainText(markdown);
    return Date.now() - started;
  };

  // Compared with itself, so a slow machine isn't a failure: doubling the input
  // doubles a linear pass and quadruples a quadratic one. Under the floor it
  // passes whatever the ratio, as a few milliseconds' ratio is noise: the
  // regexes needed some 10^10 steps at 200 KB, a linear pass some 10^6.
  test.each([
    ["an image with no `]`", "!["],
    ["an image with no `)`", "![a]("],
    ["a link with no `]`", "["],
    ["a link with no `)`", "[a]("],
    ["a link with no `]`, over many lines", "[\n"],
    ["a link with no `)`, over many lines", "[a](\n"],
    ["`*` with no close", "*a "],
    ["`_` with no close", "_a "],
    ["a code span with no close", "`a "],
    ["`~~` with no close", "~~a "],
    ["`**` closed only by `*`", "**a "],
    ["`__` closed only by `_`", "__a "],
    ["a tag with no `>`", "<"],
    ["a tag with no `>`, after a word", "<a "],
    ["a tag with no `>`, over many lines", "<\n"],
    ["a fence's line, many times", "```a\n"],
    ["a run of quote markers", ">"],
    ["a list number with no dot", "1"],
  ])("%s, repeated to 200 KB", (_what, unit) => {
    const hostile = (size: number): string => `${unit.repeat(Math.ceil(size / unit.length))}y`;
    const half = elapsedMs(hostile(100 * 1024));
    const whole = elapsedMs(hostile(200 * 1024));
    assert.ok(whole < Math.max(1_000, 3 * half), `100 KB took ${half} ms, 200 KB took ${whole} ms`);
  });

  test("a run of spaces mid-line in a page's text, 200 KB of it, is read in linear time", () => {
    const page = (size: number): string => `<pre>${" ".repeat(size)}x</pre>`;
    const timed = (html: string): number => {
      const started = performance.now();
      htmlReadableText(html);
      return performance.now() - started;
    };
    const half = timed(page(100 * 1024));
    const whole = timed(page(200 * 1024));
    assert.ok(whole < Math.max(1_000, 3 * half), `100 KB took ${half} ms, 200 KB took ${whole} ms`);
  });
});

describe("withoutTitleHeading", () => {
  test("drops a first heading that only repeats the title, whitespace, case and emphasis aside; the rest as it was", () => {
    assert.equal(withoutTitleHeading("# Quarterly  Report\n\nRevenue grew.", "quarterly report"), "\nRevenue grew.");
    assert.equal(withoutTitleHeading("\n\n  ## **Quarterly** Report ##\nBody", "Quarterly Report"), "Body");
    assert.equal(withoutTitleHeading("# Quarterly Report", "Quarterly Report"), "");
    // An HTML page's readable text writes its headings so too.
    assert.equal(withoutTitleHeading(htmlReadableText("<h1>Plan</h1><p>Ship it.</p>"), "Plan"), "\nShip it.");
  });

  test("keeps anything else: another heading, a later one, an indented code line, a heading's prefix, no title", () => {
    for (const [text, title] of [
      ["# Quarterly Report 2\n\nx", "Quarterly Report"],
      ["Intro\n\n# Plan\n", "Plan"],
      ["    # Plan\n", "Plan"],
      ["#Plan\n", "Plan"],
      ["# Plan\n", ""],
      ["# Plan\n", null],
      [`# ${"Plan ".repeat(400)}\n`, "Plan ".repeat(400)],
    ] as const) {
      assert.equal(withoutTitleHeading(text, title), text, JSON.stringify([text.slice(0, 40), title?.slice(0, 20)]));
    }
  });
});

describe("markdownExcerpt", () => {
  test("reduces Markdown to its words, one line per block", () => {
    const markdown = [
      "---", "title: front matter", "---", "",
      "# Plan", "",
      "A paragraph with **bold**, *em*, _under_, `code`, ~~gone~~ and a [link](https://example.test/x \"t\")",
      "wrapped onto a second line.", "",
      "> Quoted words", "",
      "- [x] done item", "- plain item", "  continued", "1. numbered", "",
      "| Name | Age |", "| --- | --- |", "| Ann | 30 |", "",
      "---", "",
      "Setext", "===", "",
      "[ref]: https://example.test/ref", "",
      "```ts", "const a = **b**;", "```", "",
      "Keeps 2 * 3 and snake_case and a < b.",
    ].join("\n");
    assert.equal(markdownExcerpt(markdown, null), [
      "Plan",
      "A paragraph with bold, em, under, code, gone and a link wrapped onto a second line.",
      "Quoted words",
      "done item",
      "plain item continued",
      "numbered",
      "Name · Age",
      "Ann · 30",
      "Setext",
      "const a = **b**;",
      "Keeps 2 * 3 and snake_case and a < b.",
    ].join("\n"));
  });

  test("a first heading repeating the title is left out; another stays", () => {
    assert.equal(markdownExcerpt("# My plan\n\nThe words", "my  PLAN"), "The words");
    assert.equal(markdownExcerpt("# Another\n\nThe words", "My plan"), "Another\nThe words");
  });

  test("links, images and mentions are words at most, nothing to follow", () => {
    assert.equal(markdownExcerpt("See [the docs](https://example.test) and [ref][1] now.", null), "See the docs and ref now.");
    assert.equal(markdownExcerpt("![alt](https://evil.test/x.png) after [^1]", null), "after");
    assert.equal(markdownExcerpt("[![badge](https://evil.test/b.svg)](https://example.test) words", null), "words");
    assert.equal(markdownExcerpt("<https://example.test> words", null), "words");
    assert.equal(markdownExcerpt("Ask @alice about #general", null), "Ask @alice about #general", "plain words: only the client's text node keeps them inert");
  });

  test("bold and italic go in Chinese too, with no space or punctuation outside the markers", () => {
    assert.equal(markdownExcerpt("第二项，带**粗体**", null), "第二项，带粗体", "a letter before the opener");
    assert.equal(markdownExcerpt("第一项，**粗体**，继续", null), "第一项，粗体，继续", "after a full-width comma");
    assert.equal(markdownExcerpt("中文**粗体**中文", null), "中文粗体中文", "between letters");
    assert.equal(markdownExcerpt("这是*斜体*文字和***都有***", null), "这是斜体文字和都有");
    assert.equal(markdownExcerpt("**重要。**后面的字", null), "重要。后面的字", "punctuation inside the closer");
    assert.equal(markdownExcerpt("- 第二项，带**粗体**", null), "第二项，带粗体");
    assert.equal(markdownExcerpt("| 名称 | 说明**重点** |", null), "名称 · 说明重点");
    assert.equal(markdownExcerpt("__粗体__，继续", null), "粗体，继续");
    assert.equal(markdownExcerpt("带__下划线__字", null), "带__下划线__字", "`_` opens no emphasis inside a word: the page shows it too");
  });

  test("emphasis in English as before; what isn't emphasis stays", () => {
    assert.equal(markdownExcerpt("with **bold** and *italic*", null), "with bold and italic");
    assert.equal(markdownExcerpt("**a *nested* b**", null), "a nested b");
    assert.equal(markdownExcerpt("intra**word**bold", null), "intrawordbold");
    assert.equal(markdownExcerpt("Keeps 2 * 3 * 4 and snake_case_name", null), "Keeps 2 * 3 * 4 and snake_case_name");
    assert.equal(markdownExcerpt("\\*not bold\\* and \\_not\\_", null), "*not bold* and _not_");
    assert.equal(markdownExcerpt("**wrapped over\ntwo lines**", null), "wrapped over two lines", "a pair split by a soft wrap, at word edges");
  });

  test("inline code keeps its text as written, as plain text", () => {
    assert.equal(markdownExcerpt("`<b>html</b>`", null), "<b>html</b>");
    assert.equal(markdownExcerpt("Use `<img src=x>` and `**not bold**` here", null), "Use <img src=x> and **not bold** here");
    assert.equal(markdownExcerpt("``a ` b`` then `[x](y)` and `$1`", null), "a ` b then [x](y) and $1");
    assert.equal(markdownExcerpt("**bold `code` more**", null), "bold code more", "a pair around a span still pairs");
    assert.equal(markdownExcerpt("[`code`](https://example.test)", null), "code", "a link's words");
    assert.equal(markdownExcerpt("`never closed", null), "never closed");
    assert.equal(markdownExcerpt("<`img src=x>`", null), "img src=x>", "words outside a span can't lend it a `<`");
    assert.equal(markdownExcerpt("a\uE000b `c`", null), "ab c", "an entry's own private use characters are no marks");
    assert.equal(markdownExcerpt("|`<b>`| x |", null), "<b> · x");
  });

  test("no HTML comes out, however it is split", () => {
    assert.equal(markdownExcerpt("<script>alert(1)</script>\n\nafter", null), "after");
    assert.equal(markdownExcerpt("<style>\np { color: red }\n</style>\nafter", null), "after");
    assert.equal(markdownExcerpt("<!-- a\nhidden\n-->\nafter", null), "after");
    assert.equal(markdownExcerpt("before <img src=x onerror=alert(1)> after", null), "before after");
    assert.equal(markdownExcerpt("<script>\nnever closed\n\nall hidden", null), null);
    for (const hostile of [
      "<<b>script>alert(1)</script>", "<scr<b>ipt>x", "<b<>script>", "<<<<img src=x onerror=alert(1)", "<img src=x onerror=alert(1)",
      "\\<b\\>", "<\u200Bscript>alert(1)", "<\u0000img src=x>", "<\uFFFDimg src=x>", "</div>", "<!doctype html>", "<?php",
    ]) {
      const excerpt = markdownExcerpt(hostile, null) ?? "";
      assert.doesNotMatch(excerpt, /<[a-zA-Z/!?]/, JSON.stringify(hostile));
    }
    assert.equal(markdownExcerpt("&lt;script&gt;", null), "&lt;script&gt;", "a character reference stays as written: decoding it could make a tag");
    assert.equal(markdownExcerpt("```html\n<div class=\"a\">x</div>\n```", null), "<div class=\"a\">x</div>", "a fence's code is the author's, as inline code's: as text");
  });

  test("control and format characters go: nothing Postgres refuses, nothing that reorders the words", () => {
    assert.equal(markdownExcerpt("a\u0000b\u202Ec\u2066d\uFEFFe\u0007f", null), "abcdef");
    assert.equal(markdownExcerpt("\uFEFF# Heading\r\n\r\nwords\r\n", null), "Heading\nwords");
    assert.equal(markdownExcerpt("words\uFFFD", null), "words", "bytes that weren't UTF-8");
  });

  test("nothing to show is null", () => {
    for (const empty of ["", "   \n\n", "---\n", "![a](b.png)", "<!-- only a comment -->", "[ref]: https://example.test", "---\nkey: value\n---\n"]) {
      assert.equal(markdownExcerpt(empty, null), null, JSON.stringify(empty));
    }
    assert.equal(markdownExcerpt("# Only the title", "Only the title"), null);
  });

  test("bounded in code points, never splitting one", () => {
    const words = markdownExcerpt("word ".repeat(1000), null)!;
    assert.equal(Array.from(words).length, ARTIFACT_EXCERPT_MAX_CHARS);
    assert.ok(words.endsWith("…"));
    const emoji = markdownExcerpt("😀".repeat(1000), null)!;
    assert.equal(Array.from(emoji).length, ARTIFACT_EXCERPT_MAX_CHARS);
    assert.doesNotMatch(emoji, /[\uD800-\uDFFF]/u, "no lone surrogate");
    assert.ok(Buffer.byteLength(emoji) <= 4 * ARTIFACT_EXCERPT_MAX_CHARS);
    const short = "short";
    assert.equal(markdownExcerpt(short, null), short, "short text is not cut");
  });

  test("a long hostile line takes no longer than a linear pass (a quadratic one would time this test out)", () => {
    const size = 64 * 1024;
    for (const unit of ["*a ", "[", "![", "](", "<", "<a ", "<!--", "_ ", " ", "\\", "`", "`a` ", "`` ` ", "a*", "**a", "*** ", "# ", "> "]) {
      assert.equal(typeof (markdownExcerpt(`x${unit.repeat(Math.ceil(size / unit.length))}y`, null) ?? ""), "string", JSON.stringify(unit));
    }
  });
});
