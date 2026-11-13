import assert from "node:assert/strict";
import { test } from "vitest";
import { AGENT_CLASSIC_NAMES, AGENT_NAME_ADJECTIVES, suggestAgentName } from "./agentNameGenerator";
import { validateAgentName } from "./index";

test("every name, bare, paired with an adjective, or with a numeric suffix, is a valid agent name", () => {
  for (const word of [...AGENT_CLASSIC_NAMES, ...AGENT_NAME_ADJECTIVES]) assert.match(word, /^[A-Z][a-z]+$/, word);
  for (const name of AGENT_CLASSIC_NAMES) {
    assert.equal(validateAgentName(name), null, name);
    for (const adjective of AGENT_NAME_ADJECTIVES) {
      assert.equal(validateAgentName(`${adjective}-${name}99`), null, `${adjective}-${name}99`);
    }
  }
});

test("the word lists have no case-insensitive duplicates and leave out the onboarding assistant", () => {
  for (const list of [AGENT_CLASSIC_NAMES, AGENT_NAME_ADJECTIVES]) {
    const lower = list.map((word) => word.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
  }
  assert.ok(!AGENT_CLASSIC_NAMES.some((name) => name.toLowerCase() === "cindy"));
});

test("suggestAgentName returns a free classic name while any is free", () => {
  const onlyFree = AGENT_CLASSIC_NAMES[42]!;
  // Taken names compare case-insensitively, whatever the random value.
  const taken = AGENT_CLASSIC_NAMES.filter((name) => name !== onlyFree).map((name) => name.toUpperCase());
  for (const value of [0, 0.25, 0.5, 0.999999]) {
    assert.equal(suggestAgentName(taken, () => value), onlyFree);
  }
  // Nothing taken: the random value indexes the full list.
  assert.equal(suggestAgentName([], () => 0), AGENT_CLASSIC_NAMES[0]);
  assert.equal(suggestAgentName([], () => 0.999999), AGENT_CLASSIC_NAMES.at(-1));
});

test("once every classic name is taken, suggestAgentName adds an adjective, then a number", () => {
  const names = [...AGENT_CLASSIC_NAMES];
  const first = `${AGENT_NAME_ADJECTIVES[0]}-${AGENT_CLASSIC_NAMES[0]}`;
  assert.equal(suggestAgentName(names, () => 0), first);
  assert.equal(suggestAgentName([...names, first.toLowerCase()], () => 0), `${AGENT_NAME_ADJECTIVES[0]}-${AGENT_CLASSIC_NAMES[1]}`);
  assert.equal(suggestAgentName(names, () => 0.999999), `${AGENT_NAME_ADJECTIVES.at(-1)}-${AGENT_CLASSIC_NAMES.at(-1)}`);

  const pairs = AGENT_NAME_ADJECTIVES.flatMap((adjective) => AGENT_CLASSIC_NAMES.map((name) => `${adjective}-${name}`));
  assert.equal(suggestAgentName([...names, ...pairs], () => 0), `${first}2`);
  assert.equal(suggestAgentName([...names, ...pairs, `${first}2`, `${first.toLowerCase()}3`], () => 0), `${first}4`);
});

test("the word lists match botiverse/mobile AgentNameGenerator.kt (same checksum)", () => {
  // Both repos pin this checksum of `names|adjectives`; editing either list
  // fails here until the other repo's list and checksum change too.
  const text = `${AGENT_CLASSIC_NAMES.join(",")}|${AGENT_NAME_ADJECTIVES.join(",")}`;
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  assert.equal(hash.toString(16), "5de9b463");
});
