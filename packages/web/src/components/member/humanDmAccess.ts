import type { ServerRole } from "@botiverse/raft-shared";

/**
 * Whether the viewer can message this person: the profile's Message and the
 * Members page's menu and double-click read this one rule. A Guest has no DMs
 * (#wg-rbac:#15), neither as the viewer nor as the other person, even if a DM
 * channel exists from before; and no DM with someone who has left or been
 * removed, or another server's person in a joint channel.
 */
export function canMessageHuman(
  viewerRole: ServerRole | null | undefined,
  human: { role: ServerRole | string | null; membershipStatus?: string },
  { isRemoteJointHuman = false }: { isRemoteJointHuman?: boolean } = {},
): boolean {
  return (human.membershipStatus ?? "active") === "active"
    && !isRemoteJointHuman
    && viewerRole !== "guest"
    && human.role !== "guest";
}
