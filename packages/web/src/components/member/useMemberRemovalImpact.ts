import type { MemberRemovalImpact } from "@botiverse/raft-shared";
import { useEffect, useState } from "react";
import api from "../../api/client";

/**
 * What removing a member, or leaving, takes offline (#13527: every Computer
 * the person attached to the server is revoked; the agents on them stay
 * assigned but go offline), read from the server's removal-impact route when
 * the confirmation opens.
 */
export type MemberRemovalImpactState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; impact: MemberRemovalImpact }
  | { kind: "failed" };

/** A read that hangs must not hold the confirm back: after this it counts as failed. */
const IMPACT_READ_TIMEOUT_MS = 10_000;

/**
 * `memberId` null: nothing to read (a Guest leaving attaches no Computers, and
 * the route refuses a Guest asking about itself).
 */
export function useMemberRemovalImpact(serverId: string | undefined, memberId: string | null | undefined): MemberRemovalImpactState {
  // The read's path, or why there is none: null asks nothing, "" can't ask.
  const path = memberId === null ? null : serverId && memberId ? `/servers/${serverId}/members/${memberId}/removal-impact` : "";
  const [answer, setAnswer] = useState<{ path: string; state: MemberRemovalImpactState } | null>(null);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    api.get<MemberRemovalImpact>(path, { timeout: IMPACT_READ_TIMEOUT_MS })
      .then(({ data }) => {
        if (!cancelled) setAnswer({ path, state: { kind: "ready", impact: data } });
      })
      .catch(() => {
        if (!cancelled) setAnswer({ path, state: { kind: "failed" } });
      });
    return () => { cancelled = true; };
  }, [path]);
  if (path === null) return { kind: "none" };
  if (path === "") return { kind: "failed" };
  return answer?.path === path ? answer.state : { kind: "loading" };
}
