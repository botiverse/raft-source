import type { ServerRole } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";
import { useMemberRemovalImpact } from "./useMemberRemovalImpact";

/**
 * An owner handing ownership on from a profile (making someone else owner, or
 * stepping down themselves): the Computers they attached here stay online
 * while they are a member and go with their membership (#13527), so the
 * change says so (Warden, 2026-11-09). Their own removal impact is read once
 * the role picker first opens (`want`), or when they confirm stepping down.
 * `asksFirst` is true, and opens the owner confirmation, while that read is
 * still going or when it found Computers; with none, or a failed read, the
 * role applies with Undo as any other.
 */
export function useOwnerHandOver({ serverId, selfUserId, actorIsOwner, isSelf, selfDemotionPending }: {
  serverId: string | undefined;
  selfUserId: string | undefined;
  actorIsOwner: boolean;
  isSelf: boolean;
  selfDemotionPending: boolean;
}) {
  const [wanted, setWanted] = useState(false);
  const [grantPending, setGrantPending] = useState(false);
  const read = actorIsOwner && (wanted || selfDemotionPending);
  const impact = useMemberRemovalImpact(serverId, read ? selfUserId : null);
  const want = useCallback(() => setWanted(true), []);
  const closeGrant = useCallback(() => setGrantPending(false), []);
  const mayHaveComputers = impact.kind === "loading" || (impact.kind === "ready" && impact.impact.computers > 0);
  const asksFirst = useCallback((nextRole: ServerRole) => {
    if (isSelf || nextRole !== "owner" || !actorIsOwner || !mayHaveComputers) return false;
    setGrantPending(true);
    return true;
  }, [actorIsOwner, isSelf, mayHaveComputers]);
  return { impact, want, asksFirst, grantPending, closeGrant };
}
