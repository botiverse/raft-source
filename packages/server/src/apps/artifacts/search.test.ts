// The pure parts of Artifact search (title only): the two tokenizer sides,
// which query words match as prefixes, and the title match a list shows
// (snippets and highlights in Unicode code points, never UTF-16 units).
import assert from "node:assert/strict";
import { AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS } from "@botiverse/raft-shared";
import { buildSearchIndexText, tokenizeSearchText } from "../../platform/searchTokenizer";
import { matchesOf, queryTokensOf, snippetOf } from "./search";

const query = (text: string) => queryTokensOf(tokenizeSearchText(text));
/** The highlighted text, cut from the snippet by code points. */
const highlighted = (found: { snippet: string; highlights: Array<{ start: number; length: number }> }) =>
  found.highlights.map((h) => Array.from(found.snippet).slice(h.start, h.start + h.length).join(""));

test("index side emits sub-words; every query-side word of a title is among them", () => {
  const indexed = (title: string) => new Set(buildSearchIndexText(title).split(" "));
  assert.deepEqual([...indexed("第三季度财务报告")].sort(), ["三季", "三季度", "季度", "报告", "第三", "第三季", "第三季度", "财务", "财务报告"].sort());
  assert.ok(indexed("会议纪要").has("纪要"));
  assert.ok(indexed("使用手册").has("手册"));
  for (const title of ["第三季度财务报告", "数据迁移计划书", "Planning notes: Q3 budget", "🚀 会议纪要 v2"]) {
    const words = indexed(title);
    for (const word of tokenizeSearchText(title)) assert.ok(words.has(word), `${title}: ${word}`);
  }
  // The query side is unchanged: whole words.
  assert.deepEqual(tokenizeSearchText("第三季度财务报告"), ["第三季度", "财务报告"]);
});

test("query words: ASCII letters and digits of three or more match as prefixes, nothing else", () => {
  assert.deepEqual(query("Plan pl 2024 报告 v2.0"), [
    { text: "plan", prefix: true },
    { text: "pl", prefix: false },
    { text: "2024", prefix: true },
    { text: "报告", prefix: false },
    { text: "v2.0", prefix: false },
  ]);
  assert.deepEqual(query("plan PLAN"), [{ text: "plan", prefix: true }]);
});

test("snippet and highlights count code points: emoji and CJK before the match", () => {
  const found = snippetOf("🚀🎉 第三季度财务报告", query("报告"))!;
  assert.equal(found.snippet, "🚀🎉 第三季度财务报告");
  assert.deepEqual(found.highlights, [{ start: 9, length: 2 }]);
  assert.deepEqual(highlighted(found), ["报告"]);
});

test("snippet: a long title is cut to the snippet width around the first match", () => {
  const found = snippetOf(`${"😀".repeat(250)} Migration plan`, query("migration"))!;
  assert.equal(Array.from(found.snippet).length, AGENT_API_ARTIFACT_SEARCH_SNIPPET_CHARS);
  assert.deepEqual(highlighted(found), ["Migration"]);
  assert.ok(found.snippet.endsWith("Migration plan"));
});

test("prefix words highlight to the word's end; other ASCII words match whole words only; case folds without moving offsets", () => {
  assert.deepEqual(highlighted(snippetOf("Planning notes", query("plan"))!), ["Planning"]);
  assert.equal(snippetOf("Planning notes", query("pl")), null, "two letters: no prefix");
  assert.equal(snippetOf("replan", query("plan")), null, "a prefix starts a word");
  const found = snippetOf("İ PL pl-x", query("pl"))!;
  assert.deepEqual(found.highlights, [{ start: 2, length: 2 }, { start: 5, length: 2 }]);
});

test("matches: the title only", () => {
  assert.deepEqual(matchesOf({ title: "第三季度财务报告" }, query("财务")), [
    { field: "title", snippet: "第三季度财务报告", highlights: [{ start: 4, length: 2 }] },
  ]);
  assert.deepEqual(matchesOf({ title: "Budget" }, query("plan")), []);
});
