// A card's rich excerpt of a Markdown entry (excerptBlocks.ts, #proj-workspace:#220).
// Proves: each block Kirby's spec names, with its limit; inline bold, italic and
// code kept, a link only its words; what the card must never hold (a URL, a tag
// outside code); the bounds, whatever the input, in rows, bytes and spans; and
// that a long hostile input stays linear (a quadratic pass times this file out).
import assert from "node:assert/strict";
import {
  ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES,
  ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS,
  ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS,
  ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES,
  ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS,
  ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS,
  ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS,
  parseArtifactExcerptBlocks,
} from "@botiverse/raft-shared";
import type { ArtifactExcerptBlock } from "@botiverse/raft-shared";
import { markdownExcerptBlocks } from "./excerptBlocks";

const blocks = (markdown: string, title: string | null = null) => markdownExcerptBlocks(markdown, title);
const words = (text: string) => [{ text }];
const paragraph = (text: string) => ({ type: "paragraph", spans: words(text) });

describe("the blocks", () => {
  test("headings keep their level; a first heading repeating the title goes; setext headings count", () => {
    assert.deepEqual(blocks("# One\n\n## Two\n\n### Three\n\n###### Six ##"), [
      { type: "heading", level: 1, spans: words("One") },
      { type: "heading", level: 2, spans: words("Two") },
      { type: "heading", level: 3, spans: words("Three") },
      { type: "heading", level: 6, spans: words("Six") },
    ]);
    assert.deepEqual(blocks("# The title\n\nWords.", "The Title"), [paragraph("Words.")]);
    assert.deepEqual(blocks("Big\n===\n\nSmall\n---\n"), [{ type: "heading", level: 1, spans: words("Big") }, { type: "heading", level: 2, spans: words("Small") }]);
  });

  test("a paragraph's wrapped lines join; a blank line ends it; front matter and link definitions go", () => {
    assert.deepEqual(blocks("---\nkey: value\n---\none\ntwo\n\nthree\n\n[ref]: https://evil.test"), [paragraph("one two"), paragraph("three")]);
  });

  test("a quote is one block, its markers and lazy lines included", () => {
    assert.deepEqual(blocks("> one\n> > two\nlazy\n\nafter"), [{ type: "quote", spans: words("one two lazy") }, paragraph("after")]);
    assert.deepEqual(blocks("> ## A heading\n> - an item"), [{ type: "quote", spans: words("A heading an item") }]);
  });

  test("lists: two levels at most, numbers as written, tasks as checks, wrapped lines joined", () => {
    const list = blocks("- a\n  wrapped\n- b\n  - nested\n    - deeper\n\n3. three\n4) four\n\n- [ ] todo\n- [x] done");
    assert.deepEqual(list, [{
      type: "list",
      items: [
        { level: 0, spans: words("a wrapped") },
        { level: 0, spans: words("b") },
        { level: 1, spans: words("nested") },
        { level: 1, spans: words("deeper") },
        { level: 0, order: 3, spans: words("three") },
        { level: 0, order: 4, spans: words("four") },
        { level: 0, checked: false, spans: words("todo") },
        { level: 0, checked: true, spans: words("done") },
      ],
    }]);
    assert.deepEqual(blocks("Born in\n1986. A year."), [paragraph("Born in 1986. A year.")], "only a list starting at 1 interrupts a paragraph");
  });

  test("code: the first four lines of a fence or an indented block, as written, without the language", () => {
    assert.deepEqual(blocks("```ts\nconst a = 1;\n\n  <b>indented</b>\nfour\nfive\n```\n\nafter"), [
      { type: "code", lines: ["const a = 1;", "", "  <b>indented</b>", "four"] },
      paragraph("after"),
    ]);
    assert.deepEqual(blocks("~~~\n``` not a close\n~~~"), [{ type: "code", lines: ["``` not a close"] }]);
    assert.deepEqual(blocks("````\n```\ninner\n```\n````"), [{ type: "code", lines: ["```", "inner", "```"] }]);
    assert.deepEqual(blocks("before\n\n    indented # code\n    ---\n\nafter"), [paragraph("before"), { type: "code", lines: ["indented # code", "---"] }, paragraph("after")]);
    assert.deepEqual(blocks("```\nnever closed"), [{ type: "code", lines: ["never closed"] }]);
    const long = blocks(`\`\`\`\n${"x".repeat(1000)}\n\`\`\``) as Array<{ lines: string[] }>;
    assert.equal(long[0]!.lines[0]!.length, ARTIFACT_EXCERPT_CODE_LINE_MAX_CHARS);
  });

  test("tables: the header and the first three rows, at most eight columns, escaped pipes kept", () => {
    assert.deepEqual(blocks("| a | b |\n|---|:-:|\n| 1 | **2** |\n| 3 | x\\|y |\n| 5 | 6 |\n| 7 | 8 |\n\nafter"), [
      {
        type: "table",
        header: [words("a"), words("b")],
        rows: [[words("1"), [{ text: "2", bold: true }]], [words("3"), words("x|y")], [words("5"), words("6")]],
      },
      paragraph("after"),
    ]);
    const wide = Array.from({ length: 30 }, (_, index) => `c${index}`);
    const [table] = blocks(`${wide.join(" | ")}\n${wide.map(() => "---").join(" | ")}\n${wide.join(" | ")}`) as Array<{ header: unknown[]; rows: unknown[][] }>;
    assert.equal(table!.header.length, ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS);
    assert.equal(table!.rows[0]!.length, ARTIFACT_EXCERPT_TABLE_MAX_COLUMNS);
    assert.deepEqual(blocks("a | b\n---\nwords"), [{ type: "heading", level: 2, spans: words("a | b") }, paragraph("words")], "a delimiter row of another width is no table");
  });

  test("images: a label with the alt text and no address, for a line of nothing else", () => {
    assert.deepEqual(blocks("![A chart](https://evil.test/a.png)\n\n![](b.png)\n\n[![Badge](c.svg)](https://evil.test)\n\n<img src=\"d.png\" alt=\"Logo\">"), [
      { type: "image", alt: "A chart" }, { type: "image", alt: "" }, { type: "image", alt: "Badge" }, { type: "image", alt: "Logo" },
    ]);
    assert.deepEqual(blocks("![one](a.png) ![two](b.png)"), [{ type: "images", count: 2 }], "several on a line: one row with their count, no alt text");
    assert.deepEqual(blocks("[![a](a.svg)](x) [![b](b.svg)](y) ![c](c.png)\n\nafter"), [{ type: "images", count: 3 }, paragraph("after")], "a row of badges");
    assert.deepEqual(blocks("![one](a.png)\n![two](b.png)"), [{ type: "image", alt: "one" }, { type: "image", alt: "two" }], "each on a line of its own keeps its label");
    assert.deepEqual(blocks("Words ![in a line](a.png) go on."), [paragraph("Words go on.")], "in a paragraph it is left out, as in `text`");
    const [long] = blocks(`![${"a".repeat(500)}](x.png)`) as Array<{ alt: string }>;
    assert.equal(long!.alt.length, ARTIFACT_EXCERPT_IMAGE_ALT_MAX_CHARS);
  });

  test("Mermaid and HTML blocks are one label, whatever they hold; invisible ones leave nothing", () => {
    assert.deepEqual(blocks("```mermaid\ngraph TD\nA-->B\n```"), [{ type: "diagram" }]);
    assert.deepEqual(blocks("~~~ Mermaid\ngraph\n~~~"), [{ type: "diagram" }]);
    assert.deepEqual(blocks("<div align=\"center\">\n  <h1>Hidden</h1>\n</div>\n\nafter"), [{ type: "diagram" }, paragraph("after")]);
    assert.deepEqual(blocks("<svg>\n\n<path/>\n\n</svg>\n\nafter"), [{ type: "diagram" }, paragraph("after")]);
    assert.deepEqual(blocks("<div>one</div>\n\n<div>two</div>\n\n<table><tr><td>three</td></tr></table>"), [{ type: "diagram" }], "a run of them says it once");
    assert.deepEqual(blocks("<script>\nalert(1)\n\nmore\n</script>\n\n<style>p{}</style>\n\n<!-- a\ncomment -->\n\nafter"), [paragraph("after")]);
    assert.deepEqual(blocks("<script>\nnever closed\n\nall hidden"), null);
    assert.deepEqual(blocks("</div>\n\n<br>\n\n<br>a break, then words\n\n</div> and more\n\n<https://example.test>\n\nafter"), [paragraph("a break, then words"), paragraph("and more"), paragraph("after")], "a stray tag isn't a block, and an autolink no diagram");
  });

  test("rules are drawn, in every spelling", () => {
    for (const rule of ["---", "***", "___", "- - -", "* * *", "<hr>", "<hr />"]) {
      assert.deepEqual(blocks(`above\n\n${rule}\n\nbelow`), [paragraph("above"), { type: "rule" }, paragraph("below")], rule);
    }
  });
});

describe("inline", () => {
  test("bold, italic and code are kept apart, nested too", () => {
    assert.deepEqual((blocks("a **b** *c* _d_ `e` ***f*** **g `h`**")![0] as { spans: unknown }).spans, [
      { text: "a " }, { text: "b", bold: true }, { text: " " }, { text: "c", italic: true }, { text: " " }, { text: "d", italic: true }, { text: " " },
      { text: "e", code: true }, { text: " " }, { text: "f", bold: true, italic: true }, { text: " " }, { text: "g ", bold: true }, { text: "h", bold: true, code: true },
    ]);
  });

  test("emphasis in Chinese, which writes no space around it; wrapped across a paragraph's lines", () => {
    assert.deepEqual((blocks("带**粗体**的\n话和**换\n行**")![0] as { spans: unknown }).spans, [{ text: "带" }, { text: "粗体", bold: true }, { text: "的 话和" }, { text: "换 行", bold: true }]);
  });

  test("what isn't emphasis stays: arithmetic, snake_case, escapes", () => {
    assert.deepEqual(blocks("2 * 3 and snake_case_name and \\*not\\* and a\\_b"), [paragraph("2 * 3 and snake_case_name and *not* and a_b")]);
    assert.deepEqual(blocks("**cut off"), [paragraph("cut off")], "a bold with no end loses its markers, as in `text`");
  });

  test("links are their words, footnotes and strikethrough markers go", () => {
    assert.deepEqual(blocks("See [the docs](https://evil.test \"t\") and [ref][1] ok[^2] ~~gone~~"), [paragraph("See the docs and ref ok gone")]);
  });

  test("inline code is the author's, tags and all", () => {
    assert.deepEqual((blocks("use `<b>**x**</b>` here")![0] as { spans: unknown }).spans, [{ text: "use " }, { text: "<b>**x**</b>", code: true }, { text: " here" }]);
  });
});

describe("hostile content", () => {
  const strings = (value: unknown): string[] => {
    if (typeof value === "string") return [value];
    if (Array.isArray(value)) return value.flatMap(strings);
    return value && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  };

  test("no URL survives, wherever it was put", () => {
    const stored = JSON.stringify(blocks([
      "[a](https://evil.test/1)", "![b](https://evil.test/2)", "[![c](https://evil.test/3)](https://evil.test/4)", "[d]: https://evil.test/5",
      "<img src=\"https://evil.test/6\" alt=\"e\">", "<iframe src=\"https://evil.test/7\"></iframe>", "- [f](https://evil.test/8)", "> [g](https://evil.test/9)",
      "| [h](https://evil.test/10) | b |\n|---|---|\n| [i](https://evil.test/11) | c |", "```mermaid\nclick A \"https://evil.test/12\"\n```",
    ].join("\n\n")));
    assert.doesNotMatch(stored, /evil\.test/);
  });

  test("outside code no `<` a browser could read as a tag; event handlers and script are gone", () => {
    for (const hostile of [
      "<<b>script>alert(1)</script>", "<scr<b>ipt>x", "<b<>script>", "<<<<img src=x onerror=alert(1)", "x <img src=x onerror=alert(1)>",
      "\\<b\\>", "<​script>alert(1)", "<\u0000img src=x>", "<�img src=x>", "x </div>", "<!doctype html>", "<?php",
    ]) {
      for (const text of strings(blocks(hostile) ?? [])) assert.doesNotMatch(text, /<[a-zA-Z/!?]/, JSON.stringify(hostile));
    }
  });

  test("no control or format character, nothing Postgres refuses, no lone surrogate", () => {
    assert.deepEqual(blocks("a\u0000b‮c⁦d﻿e\u0007f"), [paragraph("abcdef")]);
    // JSON.stringify writes a lone surrogate as an escape, which jsonb refuses. Every cut, at an odd offset too.
    for (const hostile of ["😀".repeat(5000), `a${"😀".repeat(5000)}`, `\`\`\`\na${"😀".repeat(500)}\n\`\`\``, `![a${"😀".repeat(500)}](x.png)`]) {
      assert.doesNotMatch(JSON.stringify(blocks(hostile)), /\\ud[89ab]/i);
    }
  });

  test("a long hostile input takes no longer than a linear pass, and stays within the bounds", () => {
    const size = 64 * 1024;
    for (const unit of [
      "*a ", "a*", "**a", "*** ", "_a ", "a_ ", "[", "![", "](", "![a](", "[![", "<", "<a ", "<!--", "_ ", " ", "\\", "`", "`a` ", "`` ` ", "# ", "> ", ">", "|", "| ",
      "- ", "1. ", "---", "-", "- [ ] ", "```", "~~~", "    ", "\t", "<div", "</div>", " #",
    ]) {
      for (const hostile of [`x${unit.repeat(Math.ceil(size / unit.length))}y`, `${unit}\n`.repeat(Math.ceil(size / (unit.length + 1))), `${`${unit}x\n`.repeat(Math.ceil(size / (unit.length + 2)))}\n`]) {
        const made = blocks(hostile);
        if (made) assert.ok(Buffer.byteLength(JSON.stringify(made)) <= ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES, JSON.stringify(unit));
      }
    }
  });
});

describe("the bounds", () => {
  const rowsOf = (list: ArtifactExcerptBlock[]) => list.reduce((rows, block) => {
    if (block.type === "list") return rows + block.items.length;
    if (block.type === "code") return rows + block.lines.length;
    if (block.type === "table") return rows + 1 + block.rows.length;
    return rows + 1;
  }, 0);

  test("rows: however many blocks, items, code lines or labels", () => {
    for (const markdown of [
      "para\n\n".repeat(100), "- item\n".repeat(100), "# h\n\n".repeat(100), "---\n\n".repeat(100), "![a](b)\n\n".repeat(100), "![a](b) ![c](d)\n\n".repeat(100),
      "```\na\nb\nc\nd\n```\n\n".repeat(100), "|a|\n|-|\n|b|\n|c|\n|d|\n\n".repeat(100), "```mermaid\nx\n```\n\npara\n\n".repeat(100),
      // The last row goes to an open block that a line of another kind flushes: that line writes nothing more.
      ...["# h", "***", "```\ncode\n```", "```mermaid\nx\n```", "<div>x</div>", "|a|\n|-|\n|b|"].map((line) => `${"para\n\n".repeat(15)}last\n${line}\n`),
      `${"para\n\n".repeat(15)}- last\n![a](b) ![c](d)\n`,
    ]) {
      const made = blocks(markdown)!;
      assert.ok(rowsOf(made) <= ARTIFACT_EXCERPT_BLOCKS_MAX_ROWS, `${markdown.slice(0, 20)}: ${rowsOf(made)}`);
      assert.ok(parseArtifactExcerptBlocks(made), "what is made is what a client accepts");
    }
  });

  test("words: in bytes, so Chinese and emoji weigh what English does, never splitting a code point", () => {
    const textBytes = (list: ArtifactExcerptBlock[]) => list.reduce((sum, block) => sum + ("spans" in block ? block.spans.reduce((spans, span) => spans + Buffer.byteLength(span.text), 0) : 0), 0);
    for (const unit of ["word ", "汉", "😀", "é"]) {
      const made = blocks(unit.repeat(10_000))!;
      assert.ok(textBytes(made) <= ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES, unit);
      assert.ok(textBytes(made) > ARTIFACT_EXCERPT_BLOCKS_MAX_TEXT_BYTES / 2, `a long page reaches the frame's fade: ${unit}`);
    }
  });

  test("spans: one paragraph of styled words can't spend more than the card's", () => {
    const [block] = blocks("*a* ".repeat(1000)) as Array<{ spans: unknown[] }>;
    assert.ok(block!.spans.length <= ARTIFACT_EXCERPT_BLOCKS_MAX_SPANS);
  });

  test("the whole list as JSON, escapes included: what doesn't fit goes last block first", () => {
    for (const markdown of [
      `${"\\\" ".repeat(5000)}`, `${"\"".repeat(5000)}`, "`\"` *\"* ".repeat(500), "😀 **😀** `😀` ".repeat(500),
      `${"| 😀 | 😀 | 😀 | 😀 | 😀 | 😀 | 😀 | 😀 |\n|-|-|-|-|-|-|-|-|\n".repeat(50)}`,
    ]) {
      const made = blocks(markdown);
      assert.ok(made, "something is left");
      assert.ok(Buffer.byteLength(JSON.stringify(made)) <= ARTIFACT_EXCERPT_BLOCKS_MAX_BYTES);
    }
  });

  test("nothing to draw is null, and the card shows its text", () => {
    for (const empty of ["", "   \n\n", "<!-- only a comment -->", "[ref]: https://example.test", "---\nkey: value\n---\n"]) {
      assert.equal(blocks(empty), null, JSON.stringify(empty));
    }
    assert.equal(blocks("# Only the title", "Only the title"), null);
  });
});
