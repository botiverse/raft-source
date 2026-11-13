import { useMemo } from "react";
import { useServerStore } from "../../store/serverStore";
import { LOCAL_MEMBER_ORIGIN, memberOrigin } from "../../utils/memberOrigin";
import type { KnownServer, MemberOrigin, MemberOriginSource } from "../../utils/memberOrigin";

/**
 * Where a message's sender is from, for the author row's marks (#wg-rbac:#46):
 * the server tile on the avatar, no model for another server's agent, no Guest
 * for another server's person. `sender` is the agent or member the row
 * resolved; without one, `actorHomeServerId` (the actors table's row, an id
 * only) is named from the conversation's connected servers. Stable while its
 * inputs are, so a memoized row does not re-render for it.
 */
export function useSenderOrigin(
  sender: MemberOriginSource | null | undefined,
  actorHomeServerId: string | null | undefined,
  connectedServers: readonly KnownServer[] | null | undefined,
  skip: boolean,
): MemberOrigin {
  const viewerServerId = useServerStore((state) => state.current?.id ?? null);
  return useMemo(() => {
    if (skip) return LOCAL_MEMBER_ORIGIN;
    const source = sender ?? (actorHomeServerId ? { serverId: actorHomeServerId } : null);
    const origin = memberOrigin(source, viewerServerId, connectedServers);
    return origin.external ? origin : LOCAL_MEMBER_ORIGIN;
  }, [skip, sender, actorHomeServerId, viewerServerId, connectedServers]);
}
