import { useMemo } from "react";

import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { isSearchableAgent } from "../../store/searchableAgent";
import { useServerStore } from "../../store/serverStore";

export interface IdentityOption {
  /** `user:<id>` / `agent:<id>` (the filters' encoding). */
  key: string;
  type: "user" | "agent";
  id: string;
  label: string;
  /** Stable @handle / mention name for searchability + tie-break */
  handle: string;
  /** Avatar identity — passed to AvatarSlot (`avatarUrl` for agents and
   *  humans alike). Absent on the synthetic
   *  "Unassigned" sentinel, which renders as `humanPlaceholder`. */
  avatarUrl?: string | null;
  /** True for the synthetic "Unassigned" row. Suppresses avatar lookup and
   *  italicizes the label so the sentinel stays visually distinct from a
   *  real member while still flowing through the same sorted+searchable
   *  list (no longer pinned). */
  isSentinel?: boolean;
}

/**
 * Combined identity options for Creator + Assignee popovers.
 * Humans and agents share the same shape because both can author or claim
 * a task. We flag the kind so the popover renders a distinguishing badge
 * (H / A) and so the selection encoding stays unambiguous.
 *
 * Stable sort by display label keeps the list's visual order independent
 * from the order events arrive in the underlying Zustand stores.
 */
export function useTaskIdentityOptions(): IdentityOption[] {
  const members = useServerStore((s) => s.members);
  const agents = useAgentStore((s) => s.agents);
  const currentUserId = useAuthStore((s) => s.user?.id);
  return useMemo<IdentityOption[]>(() => {
    const humans = members.map<IdentityOption>((m) => ({
      key: `user:${m.userId}`,
      type: "user",
      id: m.userId,
      label: m.displayName || m.name,
      handle: m.name,
      avatarUrl: m.avatarUrl,
    }));
    const agentOpts = agents.filter((a) => isSearchableAgent(a, currentUserId)).map<IdentityOption>((a) => ({
      key: `agent:${a.id}`,
      type: "agent",
      id: a.id,
      label: a.displayName || a.name,
      handle: a.name,
      avatarUrl: a.avatarUrl,
    }));
    return [...humans, ...agentOpts].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
  }, [members, agents, currentUserId]);
}
