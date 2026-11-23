// An Artifact version's links to other Artifacts (contentLinks.ts). Proves:
// Markdown's inline, reference, auto and literal links and raw `<a href>`,
// bare or with words; HTML's `<a href>` and `<area href>`, character
// references decoded; none in code, comments, scripts, styles or templates,
// nor an image; only this deployment's hosts (never another host or a
// look-alike one), never a relative link, a link by name or the Artifact
// itself; a pinned `/v/<n>`; once per file and address, bare when any is;
// files in the order given; at most CONTENT_LINKS_MAX; a literal link ended
// before full-width punctuation; and linear time on long hostile inputs.
import assert from "node:assert/strict";
import { artifactLinkId, asArtifactId } from "@botiverse/raft-shared";
import { OBJECT_REFERENCES_MAX_PER_SOURCE } from "../../platform/references";
import { CONTENT_LINKS_MAX, contentLinks, markdownLinks, type ContentLink } from "./contentLinks";
import { htmlLinks } from "./readableText";

const A = asArtifactId("pt_11111111-1111-4111-8111-111111111111");
const B = asArtifactId("pt_22222222-2222-4222-8222-222222222222");
const SELF = asArtifactId("pt_33333333-3333-4333-8333-333333333333");
const HOSTS = ["app.raft.build", "raft.example.test"];
const linkTo = (id: string, rest = "") => `https://app.raft.build/artifacts/${artifactLinkId(asArtifactId(id))}${rest}`;
const a = linkTo(A);
const b = linkTo(B);

const links = (path: string, text: string): ContentLink[] => contentLinks([{ path, text }], { selfId: SELF, appHosts: HOSTS });
const brief = (found: readonly ContentLink[]) => found.map((link) => [link.targetId, link.targetVersion, link.bare]);

describe("Markdown", () => {
  test("a bare link (literal, autolink, [url](url)) is bare; one with words is not", () => {
    const md = `See ${a}.\n\nAlso <${b}> and [the plan](${a}/v/3), and [${b}/v/2](${b}/v/2).`;
    assert.deepEqual(brief(links("index.md", md)), [
      [A, null, true],
      [B, null, true],
      [A, 3, false],
      [B, 2, true],
    ]);
  });

  test("emphasis around a bare link's words keeps it bare; trailing punctuation isn't the link's", () => {
    assert.deepEqual(brief(links("a.md", `**${a}**, [*${b}*](${b}); (${a}/v/4)`)), [[A, null, true], [B, null, true], [A, 4, true]]);
  });

  test("reference links and their definitions; an image is no link, but a badge's link is one with words", () => {
    const md = `[words][plan] and [Plan].\n\n![chart](${a}/v/5) [![badge](x.png)](${b})\n\n[plan]: ${a}/v/6`;
    assert.deepEqual(brief(links("a.md", md)), [[A, 6, false], [B, null, false]]);
  });

  test("raw <a href> in the page's HTML, references decoded", () => {
    const md = `Text <a href="${a.replace(/\//g, "&#47;")}">${a}</a> and <a href='${b}?x=1&amp;y=2'>the other</a>.`;
    const found = links("a.md", md);
    assert.deepEqual(brief(found), [[A, null, true], [B, null, false]]);
    assert.equal(found[1]!.href, `${b}?x=1&y=2`);
  });

  test("none in fenced code, inline code, comments, scripts or styles", () => {
    const md = [
      "```", `${a}/v/1`, "```",
      "~~~~md", `[x](${a}/v/2)`, "~~~~",
      `Inline \`${a}/v/3\` and \`\`[x](${a}/v/4)\`\`.`,
      `<!-- ${a}/v/5`, `still a comment ${a}/v/6 -->`,
      `<script>const u = "${a}/v/7";</script>`,
      `<style>a::after { content: "${a}/v/8" }</style>`,
      `<template><a href="${a}/v/9">x</a></template>`,
      `After: ${b}`,
    ].join("\n");
    assert.deepEqual(brief(links("a.md", md)), [[B, null, true]]);
  });

  test("markdownLinks reads links to anywhere, in order; the caller keeps the Artifacts'", () => {
    const found = markdownLinks(`[x](https://example.test/a) <https://example.test/b> https://example.test/c`);
    assert.deepEqual(found.map((link) => [link.href, link.text]), [
      ["https://example.test/a", "x"],
      ["https://example.test/b", null],
      ["https://example.test/c", null],
    ]);
  });

  describe("a literal link ends before full-width punctuation (shared bareLinkEnd.ts, the content Worker's rule)", () => {
    // "See <link>(v10, round 6)", in Chinese with full-width parentheses and comma.
    const SEE = "\u89c1 ";
    const ASIDE = "\uff08v10\uff0c\u7b2c 6 \u8f6e\uff09";
    const literal = (md: string) => markdownLinks(md).map((link) => [link.href, link.text, link.offset]);

    test("a CJK aside straight after a link to another Artifact isn't the link's: its title and backlink are found", () => {
      const md = `${SEE}${a}${ASIDE}`;
      assert.deepEqual(literal(md), [[a, null, SEE.length]]);
      const found = links("a.md", md);
      assert.deepEqual(brief(found), [[A, null, true]]);
      assert.equal(found[0]!.href, a);
    });

    test("a full-width comma, full stop or corner bracket ends it; a link may start right after one", () => {
      // A full-width comma, full stop, closing corner bracket after; an opening corner bracket and colon before.
      for (const mark of ["\uff0c", "\u3002", "\u300d"]) {
        assert.deepEqual(literal(`x ${a}${mark}rest`), [[a, null, 2]], mark);
      }
      assert.deepEqual(literal(`\u300c${a}\u300d`), [[a, null, 1]]);
      assert.deepEqual(literal(`\uff1a${a}/v/2\u3002`), [[`${a}/v/2`, null, 1]]);
      // Two links, the second in full-width parentheses after the first: both, as the page renders them.
      assert.deepEqual(literal(`${a}\uff08${b}\uff09`), [[a, null, 0], [b, null, a.length + 1]]);
      // GFM's trailing punctuation goes from the cut link too.
      assert.deepEqual(literal(`x ${a}.\uff08y\uff09`), [[a, null, 2]]);
    });

    test("a literal link starts wherever `http(s)://` is written, after any character, as the page renders it", () => {
      // "Conclusion:<link> (v10" in Chinese: a full-width colon straight before, a space after.
      assert.deepEqual(literal(`\u7ed3\u8bba\uff1a${a} \uff08v10`), [[a, null, 3]]);
      // Straight after a CJK letter, ASCII letters, `(`, a corner bracket, `=`.
      assert.deepEqual(literal(`\u89c1${a}`), [[a, null, 1]]);
      assert.deepEqual(literal(`abc${a}`), [[a, null, 3]]);
      assert.deepEqual(literal(`(${a})`), [[a, null, 1]]);
      assert.deepEqual(literal(`\u300c${a}\u300d`), [[a, null, 1]]);
      assert.deepEqual(literal(`x=${a}/v/2`), [[`${a}/v/2`, null, 2]]);
      // An address within a literal link's characters is part of it, as marked reads it.
      assert.deepEqual(literal(`${a}/x/https://example.test/b`), [[`${a}/x/https://example.test/b`, null, 0]]);
      const found = links("a.md", `\u7ed3\u8bba\uff1a${a} \uff08v10`);
      assert.deepEqual(brief(found), [[A, null, true]]);
      assert.equal(found[0]!.href, a);
    });

    test("ASCII parentheses keep GFM's rule; explicit links and autolinks keep their own end", () => {
      assert.deepEqual(literal("x https://example.test/wiki/Foo_(bar) (see https://example.test/y)"), [
        ["https://example.test/wiki/Foo_(bar)", null, 2],
        ["https://example.test/y", null, 43],
      ]);
      const explicit = `${a}/v/3\uff08\uff09`;
      assert.deepEqual(literal(`[x](${explicit}) <${explicit}>`), [[explicit, "x", 0], [explicit, null, explicit.length + 6]]);
    });
  });
});

describe("HTML", () => {
  test("<a href> and <area href>, references decoded; an <a> of images only is not bare", () => {
    const html = `<p><a href="${a}?x=1&amp;y=2">${a}?x=1&amp;y=2</a><map><area href="${b}" alt="b"></map>`
      + `<A HREF = '${b}/v/7'><img src=x alt="${b}/v/7"></A><a href=${a}/v/8>words</a></p>`;
    assert.deepEqual(brief(links("index.html", html)), [[A, null, true], [B, null, false], [B, 7, false], [A, 8, false]]);
  });

  test("none in comments, scripts, styles, templates or noscript; a `//host` link reads as https", () => {
    const html = `<!-- <a href="${a}/v/1">x</a> --><script>document.write('<a href="${a}/v/2">')</script>`
      + `<style>/* <a href="${a}/v/3"> */</style><template><a href="${a}/v/4">t</a></template><noscript><a href="${a}/v/5">n</a></noscript>`
      + `<a href="//app.raft.build/artifacts/${artifactLinkId(B)}">w</a>`;
    assert.deepEqual(brief(links("p.html", html)), [[B, null, false]]);
  });

  test("htmlLinks: an <a> ends at the next one; text collapsed", () => {
    assert.deepEqual(htmlLinks(`<a href="x">one\n  two<a href="y">three</a> after`).map((link) => [link.href, link.text]), [["x", "one two"], ["y", "three"]]);
  });
});

describe("which links count", () => {
  test("only this deployment's hosts: never another host, a look-alike one, a relative link or one by name", () => {
    const short = artifactLinkId(A);
    const md = [
      `https://evil.example/artifacts/${short}`,
      `https://app.raft.build.evil.example/artifacts/${short}`,
      `https://evil-app.raft.build/artifacts/${short}`,
      `[rel](/artifacts/${short}) [bare id](${short}) [name](notes)`,
      `https://raft-artifacts.com/p/server/notes`,
      `https://raft.example.test/s/acme/artifacts/${artifactLinkId(B)}/v/9`,
      `https://artifacts.raft.build/${short}`,
    ].join("\n\n");
    assert.deepEqual(brief(links("a.md", md)), [[B, 9, true], [A, null, true]]);
  });

  test("a link to the Artifact itself is left out", () => {
    assert.deepEqual(brief(links("a.md", `${linkTo(SELF)} ${linkTo(SELF, "/v/2")} ${a}`)), [[A, null, true]]);
  });

  test("once per file and address, bare when any of its links is; each file's own, in the order given", () => {
    const found = contentLinks([
      { path: "index.md", text: `[words](${a}) then ${a}` },
      { path: "other.html", text: `<a href="${a}">x</a>` },
      { path: "data.json", text: a },
    ], { selfId: SELF, appHosts: HOSTS });
    assert.deepEqual(found.map((link) => [link.path, link.href, link.bare]), [["index.md", a, true], ["other.html", a, false]]);
  });

  test(`at most ${CONTENT_LINKS_MAX}, the first ones (the platform's limit per source)`, () => {
    assert.equal(CONTENT_LINKS_MAX, OBJECT_REFERENCES_MAX_PER_SOURCE);
    const md = Array.from({ length: CONTENT_LINKS_MAX + 50 }, (_, at) => linkTo(A, `/v/${at + 1}`)).join("\n");
    const found = links("a.md", md);
    assert.equal(found.length, CONTENT_LINKS_MAX);
    assert.equal(found.at(-1)!.targetVersion, CONTENT_LINKS_MAX);
  });
});

test("linear on long hostile inputs", () => {
  const hostile = [
    "[".repeat(500_000) + "]".repeat(500_000),
    "[a](".repeat(300_000),
    "[a](x".repeat(300_000),
    "https://a/" + ")".repeat(1_000_000),
    "[" + "*".repeat(1_000_000) + `](${a})`,
    "<".repeat(1_000_000),
    "`a ".repeat(300_000),
    "<script".repeat(150_000),
    `<${a}> `.repeat(20_000),
    "https://a\uff08".repeat(100_000),
    "xhttps://".repeat(100_000),
    `${a}\u3002`.repeat(20_000),
  ];
  for (const text of hostile) {
    const started = performance.now();
    links("h.md", text);
    links("h.html", text);
    assert.ok(performance.now() - started < 2_000, `${text.slice(0, 12)}… took ${Math.round(performance.now() - started)} ms`);
  }
});
