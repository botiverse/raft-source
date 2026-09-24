import { canTransitionServerRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";

const SERVER_ROLE_ORDER = ["owner", "admin", "member", "guest"] as const;

export function getEditableHumanServerRoles(input: {
  actorRole: ServerRole | null | undefined;
  targetRole: ServerRole;
  isSelf: boolean;
  ownerCount: number;
  serverGuestEnabled: boolean;
}): ServerRole[] {
  if (!input.serverGuestEnabled && input.targetRole === "guest") return [];
  return SERVER_ROLE_ORDER.filter((nextRole) =>
    (input.serverGuestEnabled || nextRole !== "guest")
    && canTransitionServerRole({
      actorRole: input.actorRole,
      targetRole: input.targetRole,
      nextRole,
      isSelf: input.isSelf,
      ownerCount: input.ownerCount,
    }));
}
