// The comment list's search (#proj-workspace:#341): the words of a query, which comments and threads
// match them (text and author names, any case, inside Chinese / Japanese / Korean text, a reply alone,
// resolved threads too), where the marks go, and when a collapsed thread opens to show a match.
import assert from "node:assert/strict";
import { asArtifactCommentId } from "@botiverse/raft-shared";
import type { ArtifactActor, ArtifactComment, ArtifactCommentPart } from "@botiverse/raft-shared";

import { buildThreads } from "../src/apps/artifacts/artifactComments";
import {
  commentMatches,
  commentSearchTerms,
  commentSearchText,
  foldForSearch,
  hidesMatch,
  markdownSearchText,
  searchCommentThreads,
  searchParts,
  searchRanges,
} from "../src/apps/artifacts/artifactCommentSearch";

const person = (id: string, displayName = id): ArtifactActor => ({ type: "user", id, name: id, displayName, avatarUrl: null });
const nameOf = (actor: ArtifactActor) => actor.displayName;
const at = (minute: number) => `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z`;

function comment(id: string, minute: number, extra: {
  by?: ArtifactActor;
  text?: string;
  body?: ArtifactCommentPart[];
  replyTo?: string;
  resolved?: boolean;
  deleted?: boolean;
} = {}): ArtifactComment {
  return {
    id: asArtifactCommentId(id),
    author: extra.by ?? person("ana", "Ana"),
    body: extra.body ?? [{ type: "text", text: extra.text ?? `comment ${id}` }],
    createdAt: at(minute),
    editedAt: null,
    deletedAt: extra.deleted ? at(minute) : null,
    version: 1,
    target: { scope: "artifact" },
    replyTo: extra.replyTo ? asArtifactCommentId(extra.replyTo) : null,
    resolvedAt: extra.resolved ? at(minute) : null,
    resolvedBy: extra.resolved ? person("ana", "Ana") : null,
  };
}

const found = (threads: ReturnType<typeof buildThreads>, query: string) => searchCommentThreads(threads, commentSearchTerms(query), nameOf);
const sorted = (ids: ReadonlySet<string>) => [...ids].sort();

describe("the comment list's search words", () => {
  it("splits at spaces, folds the case, drops a leading @ or #, and keeps each once", () => {
    assert.deepEqual(commentSearchTerms("  Hello   WORLD hello "), ["hello", "world"]);
    assert.deepEqual(commentSearchTerms("@Remy #design"), ["remy", "design"]);
    assert.deepEqual(commentSearchTerms("   "), []);
    assert.deepEqual(commentSearchTerms("@ #"), []);
    assert.deepEqual(commentSearchTerms("评论 デザイン"), ["评论", "デザイン"]);
  });

  it("folds one character at a time, so a text and its parts fold alike", () => {
    assert.equal(foldForSearch("ΟΔΟΣ"), "οδοσ");
    assert.equal(foldForSearch("Ünïcode ABC"), "ünïcode abc");
    assert.equal(foldForSearch("中文ABC"), "中文abc");
  });

  it("reads a comment's mentions as they show", () => {
    const body: ArtifactCommentPart[] = [{ type: "text", text: "ask " }, { type: "mention", actor: person("remy", "Remy") }, { type: "text", text: " please" }];
    assert.equal(commentSearchText({ body }), "ask @Remy please");
  });
});

describe("the words a comment's Markdown shows", () => {
  it("keeps a link's label, not its address", () => {
    assert.equal(markdownSearchText("see [the guide](https://example.com/docs_v2 \"Guide\") first"), "see the guide first");
    assert.equal(markdownSearchText("[Wiki](https://en.wikipedia.org/wiki/Foo_(bar)) page"), "Wiki page");
    assert.equal(markdownSearchText("an image ![diagram](a.png) here"), "an image  here");
    // An autolink's address is its text.
    assert.equal(markdownSearchText("<https://example.com/a_b>"), "https://example.com/a_b");
  });

  it("drops emphasis, strikethrough and block syntax, keeps code text and escaped characters", () => {
    assert.equal(markdownSearchText("**bold** and _soft_ and ~~gone~~ and ***both***"), "bold and soft and gone and both");
    assert.equal(markdownSearchText("snake_case_name stays, 2 * 3 too"), "snake_case_name stays, 2 * 3 too");
    assert.equal(markdownSearchText("# Title #\n> quoted\n- item\n1. first\n- [x] done"), "Title\nquoted\nitem\nfirst\ndone");
    assert.equal(markdownSearchText("use `a **b**` here, \\*not emphasis\\*"), "use a **b** here, *not emphasis*");
    assert.equal(markdownSearchText("```ts\nconst answer = 42;\n```\nafter"), "const answer = 42;\nafter");
    assert.equal(markdownSearchText("| a | b |\n|---|---|\n| c | d |"), "  a   b  \n  c   d  ");
    assert.equal(markdownSearchText("中文**“重点”**中文"), "中文“重点”中文");
  });
});

describe("which comments match", () => {
  it("matches the words the Markdown shows, not a link's address or syntax alone", () => {
    const linked = comment("a", 1, { text: "read [the docs](https://example.com/guide) first" });
    assert.equal(commentMatches(linked, commentSearchTerms("docs"), nameOf), true);
    assert.equal(commentMatches(linked, commentSearchTerms("example"), nameOf), false);
    assert.equal(commentMatches(linked, commentSearchTerms("guide"), nameOf), false);
    const bold = comment("b", 1, { text: "this is **really** important" });
    assert.equal(commentMatches(bold, commentSearchTerms("really"), nameOf), true);
    assert.equal(commentMatches(bold, commentSearchTerms("**"), nameOf), false);
    assert.equal(commentMatches(bold, commentSearchTerms("**really**"), nameOf), false);
    const fenced = comment("c", 1, { text: "```python\nprint(1)\n```" });
    assert.equal(commentMatches(fenced, commentSearchTerms("print"), nameOf), true);
    assert.equal(commentMatches(fenced, commentSearchTerms("python"), nameOf), false);
  });

  it("matches the text, any case", () => {
    const c = comment("a", 1, { text: "The Header is too tall" });
    assert.equal(commentMatches(c, commentSearchTerms("header"), nameOf), true);
    assert.equal(commentMatches(c, commentSearchTerms("HEADER TALL"), nameOf), true);
    assert.equal(commentMatches(c, commentSearchTerms("footer"), nameOf), false);
  });

  it("matches the author's name as the list shows it", () => {
    const c = comment("a", 1, { by: person("u1", "Xiaoming Chen"), text: "looks good" });
    assert.equal(commentMatches(c, commentSearchTerms("chen"), nameOf), true);
    // Every word, from the name or the text.
    assert.equal(commentMatches(c, commentSearchTerms("xiaoming good"), nameOf), true);
    assert.equal(commentMatches(c, commentSearchTerms("xiaoming bad"), nameOf), false);
  });

  it("finds a word inside a run of Chinese, Japanese or Korean, which has no spaces", () => {
    assert.equal(commentMatches(comment("a", 1, { text: "这个标题太长了，建议缩短" }), commentSearchTerms("标题"), nameOf), true);
    assert.equal(commentMatches(comment("b", 1, { text: "このボタンの色を変えてください" }), commentSearchTerms("ボタン"), nameOf), true);
    assert.equal(commentMatches(comment("c", 1, { text: "버튼 색상을바꿔주세요" }), commentSearchTerms("색상"), nameOf), true);
    assert.equal(commentMatches(comment("d", 1, { by: person("u2", "陈小明"), text: "ok" }), commentSearchTerms("小明"), nameOf), true);
    // Mixed with Latin, any case.
    assert.equal(commentMatches(comment("e", 1, { text: "把Header改小" }), commentSearchTerms("header改"), nameOf), true);
  });

  it("matches a mention by its name", () => {
    const c = comment("a", 1, { body: [{ type: "mention", actor: person("remy", "Remy") }, { type: "text", text: " can you check" }] });
    assert.equal(commentMatches(c, commentSearchTerms("@remy"), nameOf), true);
  });

  it("never matches a deleted comment, nor without words", () => {
    assert.equal(commentMatches(comment("a", 1, { text: "header", deleted: true }), commentSearchTerms("header"), nameOf), false);
    assert.equal(commentMatches(comment("b", 1, { text: "header" }), [], nameOf), false);
  });
});

describe("which threads show", () => {
  it("shows a thread when only a reply matches, and names the matching comments", () => {
    const threads = buildThreads([
      comment("r1", 1, { text: "first thread" }),
      comment("x1", 2, { text: "the spacing here", replyTo: "r1" }),
      comment("r2", 3, { text: "second thread" }),
    ]);
    const result = found(threads, "spacing");
    assert.deepEqual(sorted(result.threads), ["r1"]);
    assert.deepEqual(sorted(result.comments), ["x1"]);
  });

  it("shows resolved threads too", () => {
    const threads = buildThreads([
      comment("r1", 1, { text: "fix the logo", resolved: true }),
      comment("r2", 2, { text: "fix the footer" }),
    ]);
    assert.deepEqual(sorted(found(threads, "fix").threads), ["r1", "r2"]);
    assert.deepEqual(sorted(found(threads, "logo").threads), ["r1"]);
  });

  it("shows nothing when nothing matches", () => {
    const threads = buildThreads([comment("r1", 1, { text: "hello" })]);
    const result = found(threads, "nowhere");
    assert.equal(result.threads.size, 0);
    assert.equal(result.comments.size, 0);
  });
});

describe("where the marks go", () => {
  it("marks every place of every word, any case, joining overlaps", () => {
    assert.deepEqual(searchRanges("Header and header", ["header"]), [{ start: 0, end: 6 }, { start: 11, end: 17 }]);
    assert.deepEqual(searchRanges("abcdef", ["abc", "cde"]), [{ start: 0, end: 5 }]);
    assert.deepEqual(searchRanges("abc", []), []);
    assert.deepEqual(searchRanges("这个标题太长", ["标题"]), [{ start: 2, end: 4 }]);
  });

  it("takes an @ or # just before a mark, as the Markdown's marks do", () => {
    assert.deepEqual(searchRanges("@Remy", ["remy"]), [{ start: 0, end: 5 }]);
    assert.deepEqual(searchParts("ask #design", ["design"]), [{ text: "ask ", hit: false, at: 0 }, { text: "#design", hit: true, at: 4 }]);
  });

  it("gives the text's own indices when a character's lower case is longer", () => {
    // "İ" folds to two units ("i̇"): its mark is the one character, and the word after it lands where it is.
    assert.deepEqual(searchRanges("İstanbul city", ["city"]), [{ start: 9, end: 13 }]);
    assert.deepEqual(searchRanges("İstanbul", ["i"]), [{ start: 0, end: 1 }]);
  });

  it("cuts a text into marked and unmarked runs", () => {
    assert.deepEqual(searchParts("Ana Chen", ["chen"]), [{ text: "Ana ", hit: false, at: 0 }, { text: "Chen", hit: true, at: 4 }]);
    assert.deepEqual(searchParts("plain", ["zzz"]), [{ text: "plain", hit: false, at: 0 }]);
    assert.deepEqual(searchParts("", ["a"]), [{ text: "", hit: false, at: 0 }]);
  });
});

describe("a collapsed thread opens for a match on a one-line comment", () => {
  const threads = buildThreads([
    comment("r1", 1, { text: "root about colours" }),
    comment("x1", 2, { text: "seen reply", replyTo: "r1" }),
    comment("x2", 3, { text: "new reply about colours", replyTo: "r1" }),
  ]);
  const thread = threads[0]!;
  const ids = (...list: string[]) => list.map(asArtifactCommentId);

  it("opens when a seen comment (before the first new one) matches", () => {
    assert.equal(hidesMatch(thread, new Set(ids("r1")), ids("x2")), true);
    // Nothing new: every comment is on one line.
    assert.equal(hidesMatch(thread, new Set(ids("x2")), []), true);
  });

  it("stays when the only match is already shown in full, after the divider", () => {
    assert.equal(hidesMatch(thread, new Set(ids("x2")), ids("x2")), false);
    assert.equal(hidesMatch(thread, new Set(ids("x1", "x2")), ids("x1", "x2")), false);
  });
});
