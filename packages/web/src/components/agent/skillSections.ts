import type { SkillInfo } from "@botiverse/raft-shared";

export interface SkillSection {
  scope: "builtin" | "global" | "workspace";
  skills: SkillInfo[];
}

/**
 * The groups the agent's Skills section draws, built-in first (skills the
 * runtime itself ships; only Computers that read them through OAR send any),
 * then global, then workspace: only those that hold a skill. An empty group
 * gets no label and no sentence; with none at all, the section header's count
 * of 0 is the whole section.
 */
export function skillSections(global: SkillInfo[], workspace: SkillInfo[], builtin: SkillInfo[] = []): SkillSection[] {
  const sections: SkillSection[] = [
    { scope: "builtin", skills: builtin },
    { scope: "global", skills: global },
    { scope: "workspace", skills: workspace },
  ];
  return sections.filter((section) => section.skills.length > 0);
}
