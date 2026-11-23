import assert from "node:assert/strict";
import type { SkillInfo } from "@botiverse/raft-shared";
import { skillSections } from "../src/components/agent/skillSections";

// The agent's Skills section draws only the groups that hold a skill
// (#triage:#373): an empty group has no label and no "no skills yet" sentence.

const skill = (name: string) => ({ name, displayName: name, description: "", userInvocable: false, sourcePath: "~/.claude/skills" }) as SkillInfo;

test("a group with no skills is not drawn", () => {
  assert.deepEqual(skillSections([skill("a")], []).map((section) => section.scope), ["global"]);
  assert.deepEqual(skillSections([], [skill("b")]).map((section) => section.scope), ["workspace"]);
});

test("both groups are drawn, global first, when both hold skills", () => {
  const sections = skillSections([skill("a")], [skill("b"), skill("c")]);
  assert.deepEqual(sections.map((section) => [section.scope, section.skills.length]), [["global", 1], ["workspace", 2]]);
});

test("no group at all when the agent has no skills", () => {
  assert.deepEqual(skillSections([], []), []);
});

test("built-in skills (from a Computer that reads them through OAR) come first", () => {
  const sections = skillSections([skill("a")], [skill("b")], [skill("simplify")]);
  assert.deepEqual(sections.map((section) => [section.scope, section.skills.length]), [["builtin", 1], ["global", 1], ["workspace", 1]]);
  assert.deepEqual(skillSections([], [], [skill("simplify")]).map((section) => section.scope), ["builtin"]);
  assert.deepEqual(skillSections([skill("a")], [], []).map((section) => section.scope), ["global"], "an empty built-in list draws nothing");
});
