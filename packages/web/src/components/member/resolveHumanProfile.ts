import type { ServerMember } from "../../store/serverStore";
import type { HumanProfile } from "./HumanDetailPanel";

export function resolveHumanProfile(
  liveMember: ServerMember | undefined,
  fallbackHuman: HumanProfile | null,
): HumanProfile | null {
  if (liveMember && fallbackHuman) {
    return { ...fallbackHuman, ...liveMember };
  }
  if (fallbackHuman) {
    return fallbackHuman;
  }
  if (liveMember) {
    return { ...liveMember, membershipStatus: "active" as const, createdAgents: [] };
  }
  return null;
}
