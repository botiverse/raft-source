/**
 * What ending one person's membership of a server takes offline, as
 * GET /api/servers/:id/members/:memberId/removal-impact answers it for the
 * remove-member and leave dialogs. Removing or leaving revokes every live
 * Computer the person attached to that server (the server's
 * removeMemberInTransaction); the agents on those Computers stay bound but go
 * offline.
 */
export interface MemberRemovalImpact {
  /** Live (unrevoked) Computers the person attached to this server. */
  computers: number;
  /** Live agents bound to those Computers' machines. */
  agents: number;
  /**
   * Of those, the ones that are not the person's own: neither created by
   * them nor their personal assistant. An agent another agent created counts
   * here too.
   */
  othersAgents: number;
  /** Up to MEMBER_REMOVAL_IMPACT_MAX_COMPUTER_NAMES of those Computers' names, by name. */
  computerNames: string[];
}

export const MEMBER_REMOVAL_IMPACT_MAX_COMPUTER_NAMES = 3;
