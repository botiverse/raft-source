import type { ProfileVisibilityMembershipStatus } from "@botiverse/raft-shared";

export function getHumanDepartureLabel(
  status: ProfileVisibilityMembershipStatus | null | undefined,
): "Left" | "Removed" | null {
  if (status === "left") return "Left";
  if (status === "removed") return "Removed";
  return null;
}
