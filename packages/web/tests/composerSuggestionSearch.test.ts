import assert from "node:assert/strict";
import test from "node:test";
import { rankBasicComposerSuggestions, rankComposerSuggestions } from "../src/utils/composerSuggestionSearch.js";
import type { ComposerSuggestionSearchEntry } from "../src/utils/composerSuggestionSearch.js";

interface ChannelSuggestion {
  name: string;
  subtitle?: string;
}

interface MemberSuggestion {
  handle: string;
  displayName: string;
  description?: string;
  sourceServerLabel?: string;
}

function channelEntries(suggestions: ChannelSuggestion[]): ComposerSuggestionSearchEntry<ChannelSuggestion>[] {
  return suggestions.map((suggestion, index) => ({
    index,
    suggestion,
    fields: [
      { raw: suggestion.name, priority: 0 },
      { raw: suggestion.subtitle ?? "", priority: 3 },
    ],
  }));
}

function memberEntries(suggestions: MemberSuggestion[]): ComposerSuggestionSearchEntry<MemberSuggestion>[] {
  return suggestions.map((suggestion, index) => ({
    index,
    suggestion,
    fields: [
      { raw: suggestion.handle, priority: 0 },
      { raw: suggestion.displayName, priority: 1 },
      { raw: suggestion.description ?? "", priority: 3 },
      { raw: suggestion.sourceServerLabel ?? "", priority: 4 },
    ],
  }));
}

function filterChannels(query: string, suggestions: ChannelSuggestion[]): string[] {
  return rankComposerSuggestions(query, channelEntries(suggestions)).map((suggestion) => suggestion.name);
}

function filterMembers(query: string, suggestions: MemberSuggestion[]): string[] {
  return rankComposerSuggestions(query, memberEntries(suggestions)).map((suggestion) => suggestion.handle);
}

test("composer channel search matches Chinese pinyin full, initials, and mixed query", () => {
  const suggestions = [
    { name: "对话流专修" },
    { name: "输入框专修" },
    { name: "markdown专修" },
  ];

  assert.deepEqual(filterChannels("duihua", suggestions), ["对话流专修"]);
  assert.deepEqual(filterChannels("dui hua", suggestions), ["对话流专修"]);
  assert.deepEqual(filterChannels("dh", suggestions), ["对话流专修"]);
  assert.deepEqual(filterChannels("dhlzx", suggestions), ["对话流专修"]);
  assert.deepEqual(filterChannels("对hua", suggestions), ["对话流专修"]);
  assert.deepEqual(filterChannels("shuru", suggestions), ["输入框专修"]);
  assert.deepEqual(filterChannels("sr", suggestions), ["输入框专修"]);
});

test("composer member search ranks exact prefix substring and fuzzy matches", () => {
  const suggestions = [
    { displayName: "Android Developer", handle: "android-developer" },
    { displayName: "Cindy", handle: "cindy" },
    { displayName: "Dev Ops", handle: "devops" },
    { displayName: "Product Owner", handle: "owner", description: "Android developer contact" },
  ];

  assert.deepEqual(filterMembers("dev", suggestions), ["devops", "android-developer", "owner"]);
  assert.deepEqual(filterMembers("anddev", suggestions), ["android-developer"]);
});

test("composer member search matches mixed Latin Chinese pinyin", () => {
  const suggestions = [
    { displayName: "KMP-专家", handle: "KMP-专家" },
    { displayName: "KMP Developer", handle: "KMP-Developer" },
  ];

  assert.deepEqual(filterMembers("zhuanjia", suggestions), ["KMP-专家"]);
  assert.deepEqual(filterMembers("kmpzhuanjia", suggestions), ["KMP-专家"]);
});

test("composer channel name match ranks ahead of subtitle match", () => {
  const suggestions = [
    { name: "general", subtitle: "markdown triage" },
    { name: "markdown专修", subtitle: "docs" },
  ];

  assert.deepEqual(filterChannels("markdown", suggestions), ["markdown专修", "general"]);
});

test("composer search legacy raw contains still matches symbol queries", () => {
  const suggestions = [
    { name: "general" },
    { name: "c++" },
  ];

  assert.deepEqual(filterChannels("++", suggestions), ["c++"]);
});

test("composer search blank query keeps original order", () => {
  const suggestions = [
    { displayName: "B", handle: "b" },
    { displayName: "A", handle: "a" },
  ];

  assert.deepEqual(filterMembers("", suggestions), ["b", "a"]);
});

test("basic degraded search keeps literal matching but disables pinyin and fuzzy", () => {
  const suggestions = [
    { displayName: "对话流专修", handle: "dialog-owner" },
    { displayName: "Android Developer", handle: "android-developer" },
  ];
  const entries = memberEntries(suggestions);

  assert.deepEqual(rankBasicComposerSuggestions("对话", entries).map((suggestion) => suggestion.handle), ["dialog-owner"]);
  assert.deepEqual(rankBasicComposerSuggestions("android", entries).map((suggestion) => suggestion.handle), ["android-developer"]);
  assert.deepEqual(rankBasicComposerSuggestions("duihua", entries), []);
  assert.deepEqual(rankBasicComposerSuggestions("anddev", entries), []);
});

test("basic degraded search normalizes channel and member scope prefixes like the full ranker", () => {
  const channels = channelEntries([{ name: "design" }, { name: "general" }]);
  const members = memberEntries([
    { displayName: "Ray", handle: "ray" },
    { displayName: "Cindy", handle: "cindy" },
  ]);

  assert.deepEqual(rankBasicComposerSuggestions("#design", channels).map((suggestion) => suggestion.name), ["design"]);
  assert.deepEqual(rankBasicComposerSuggestions("@ray", members).map((suggestion) => suggestion.handle), ["ray"]);
});
