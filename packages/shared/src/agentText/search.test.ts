import assert from "node:assert/strict";

import { extractRaftMentionHandles } from "../raftRefs";
import { expandSearchMatchToRefLiteral, formatAgentSearchResults, neutralizeAgentRaftRefLiterals } from "./search";

test("non-ASCII @handle, #channel and dm:@peer are neutralised like ASCII ones", () => {
  assert.equal(neutralizeAgentRaftRefLiterals("@庄天翼 看 #频道"), "user:庄天翼 看 channel:频道");
  assert.equal(neutralizeAgentRaftRefLiterals("问 dm:@庄天翼 和 dm:@庄天翼~agent"), "问 dm:user:庄天翼 和 dm:user:庄天翼~agent");
  // Full-width punctuation before the ref is a boundary, as it is for a live mention.
  assert.equal(neutralizeAgentRaftRefLiterals("请看（@庄天翼，#频道）"), "请看（user:庄天翼，channel:频道）");
  // A letter before `@` makes it no mention (createRaftUserRefRegex agrees): left as it is.
  assert.equal(neutralizeAgentRaftRefLiterals("草案@庄天翼"), "草案@庄天翼");
  for (const text of ["@庄天翼 看 #频道", "问 dm:@庄天翼", "请看（@庄天翼，#频道）", "@Zoë and @Ünal"]) {
    assert.deepEqual(extractRaftMentionHandles(neutralizeAgentRaftRefLiterals(text)), [], text);
  }
});

test("refs after ASCII punctuation are neutralised with the live mention grammar's boundary", () => {
  const cases: Array<[string, string]> = [
    ["a,@庄天翼", "a,user:庄天翼"],
    ["**@庄天翼**", "**user:庄天翼**"],
    ["cc:@庄天翼", "cc:user:庄天翼"],
    ["/@庄天翼", "/user:庄天翼"],
    ["<@庄天翼>", "<user:庄天翼>"],
    ["看.@庄天翼 !@alice", "看.user:庄天翼 !user:alice"],
    ["see:#频道 and *#proj*", "see:channel:频道 and *channel:proj*"],
    // The `@` before a rewritten ref would start a new live mention: kept apart.
    ["@@alice @#proj ##proj", "@ user:alice @ channel:proj # channel:proj"],
    // Unchanged from before.
    ["@alice mentioned #proj-search and task #12", "user:alice mentioned channel:proj-search and task:12"],
    ["line\n@a\n#b-c_d\ndm:@e~human task #7x", "line\nuser:a\nchannel:b-c_d\ndm:user:e~human task #7x"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(neutralizeAgentRaftRefLiterals(text), expected, text);
    assert.deepEqual(extractRaftMentionHandles(neutralizeAgentRaftRefLiterals(text)), [], text);
  }
  // A letter or digit before `@` is no mention: emails and `草案@x` stay as they are.
  for (const text of ["a@b.com", "bob@example.com", "张三@example.com", "草案@庄天翼", "issue #5", "x_@a", "x-@a"]) {
    assert.equal(neutralizeAgentRaftRefLiterals(text), text, text);
  }
});

test("no neutralised text leaves a live mention", () => {
  // Random text from the characters the grammars care about. A handle starting
  // with `_` or `-` (`@_x`) is still left as text (known gap), so only those may survive.
  // No domain-like tokens: the live parser starts a new chunk right after an
  // email, so `a@b.com@c` mentions `c` there, a split this neutraliser does not copy.
  const alphabet = ["@", "#", "dm:@", "task #", "~agent", " ", "\n", "(", ",", ";", ":", "/", "*", "<", ">", "!", ".", "`", "-", "_", "a", "Z", "7", "庄", "天", "，", "é"];
  let seed = 7;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 4000; i += 1) {
    const text = Array.from({ length: 1 + Math.floor(next() * 14) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
    const live = extractRaftMentionHandles(neutralizeAgentRaftRefLiterals(text)).filter((handle) => !/^[_-]/.test(handle));
    assert.deepEqual(live, [], JSON.stringify(text));
  }
});

test("a match inside a non-ASCII handle or channel is widened to the whole ref", () => {
  const content = "请 @庄天翼 看 #频道 和 dm:@庄天翼";
  const at = (part: string, from = 0) => {
    const start = content.indexOf(part, from);
    return { start, end: start + part.length };
  };
  assert.deepEqual(expandSearchMatchToRefLiteral(content, at("天翼")), at("@庄天翼"));
  assert.deepEqual(expandSearchMatchToRefLiteral(content, at("道")), at("#频道"));
  assert.deepEqual(expandSearchMatchToRefLiteral(content, at("庄天", content.indexOf("dm:"))), at("dm:@庄天翼"));
});

test("a search preview whose match cuts through a non-ASCII handle leaves no live mention", () => {
  const out = formatAgentSearchResults("天翼", {
    results: [{
      id: "res-cjk",
      seq: 1,
      channelType: "channel",
      channelName: "频道",
      senderName: "reviewer",
      senderType: "agent",
      content: "请 @庄天翼 看一下 #频道 的发布说明",
    }],
  });
  assert.match(out, /请 <match>user:庄天翼<\/match> 看一下 channel:频道 的发布说明/);
  assert.doesNotMatch(out.replace(/<\/?match>/g, ""), /@庄/);
  assert.deepEqual(extractRaftMentionHandles(out), []);
});

test("a search preview whose match sits in a ref after ASCII punctuation widens it and leaves no live mention", () => {
  const out = formatAgentSearchResults("天翼", {
    results: [{
      id: "res-punct",
      seq: 1,
      channelType: "channel",
      channelName: "general",
      senderName: "reviewer",
      senderType: "agent",
      content: "please check a,@庄天翼 and **@庄天翼** today",
    }],
  });
  assert.match(out, /a,<match>user:庄天翼<\/match> and \*\*user:庄天翼\*\* today/);
  assert.doesNotMatch(out.replace(/<\/?match>/g, ""), /@庄/);
  assert.deepEqual(extractRaftMentionHandles(out), []);
});
