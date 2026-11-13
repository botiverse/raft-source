import { createContext } from "react";
import type { ServerRole } from "@botiverse/raft-shared";
import type { Agent } from "../../store/agentStore";
import { canMessageHuman } from "../../components/member/humanDmAccess";
import type { MemberEntry } from "./membersPageModel";

/**
 * What a tile or row on the Members page can do beyond opening the profile
 * (its menu and double-click, as the retired Members sidebar had them). The
 * page provides it (useMemberActions); without it a tile only opens the
 * profile.
 */
export interface MemberActions {
  viewerRole: ServerRole | null;
  /** Open the DM with this member (an existing one first), closing the profile. */
  openDm: (entry: MemberEntry) => void;
  startAgent: (agent: Agent) => void;
  /** Stop asks first, as on the profile. */
  requestStop: (agent: Agent) => void;
  /** Restart / reset opens its chooser, as on the profile. */
  requestReset: (agent: Agent) => void;
}

export const MemberActionsContext = createContext<MemberActions | null>(null);

/** Whether the viewer can message this member: the profile's rule (a Guest has no DMs, #wg-rbac:#15). */
export function canMessageEntry(entry: MemberEntry, viewerRole: ServerRole | null): boolean {
  return entry.kind === "agent" ? !entry.agent.deletedAt : canMessageHuman(viewerRole, entry.member);
}
