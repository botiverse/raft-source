import type { SkillInfo } from "@botiverse/raft-shared";

export interface SkillSection {
  scope: "global" | "workspace";
  skills: SkillInfo[];
}

/**
 * The groups the agent's Skills section draws, global first: only those that
 * hold a skill. An empty group gets no label and no sentence; with none at
 * all, the section header's count of 0 is the whole section.
 */
export function skillSections(global: SkillInfo[], workspace: SkillInfo[]): SkillSection[] {
  const sections: SkillSection[] = [{ scope: "global", skills: global }, { scope: "workspace", skills: workspace }];
  return sections.filter((section) => section.skills.length > 0);
}
