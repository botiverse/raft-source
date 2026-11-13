import { canTransitionServerRole } from "@botiverse/raft-shared";
import type { ServerRole } from "@botiverse/raft-shared";

/**
 * Guest is never a target: a Guest belongs to exactly one channel and is not
 * made by changing a server role (the server refuses with 403, #wg-rbac:#15).
 * An existing Guest can still be promoted to member or admin.
 */
const TARGET_SERVER_ROLE_ORDER = ["owner", "admin", "member"] as const;

export function getEditableHumanServerRoles(input: {
  actorRole: ServerRole | null | undefined;
  targetRole: ServerRole;
  isSelf: boolean;
  ownerCount: number;
}): ServerRole[] {
  return TARGET_SERVER_ROLE_ORDER.filter((nextRole) =>
    canTransitionServerRole({
      actorRole: input.actorRole,
      targetRole: input.targetRole,
      nextRole,
      isSelf: input.isSelf,
      ownerCount: input.ownerCount,
    }));
}
