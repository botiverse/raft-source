import { useEffect, useEffectEvent } from "react";
import { useIntl } from "react-intl";
import { useAgentActivityTraceJoin, useAgentDisplayState } from "../../store/agentStore";
import type { AgentActivity } from "@botiverse/raft-shared";
import StatusDot from "../ui/StatusDot";
import type { StatusDotProps } from "../ui/StatusDot";
import { traceAgentActivityStatusDotApplied } from "../../utils/webAgentActivityTrace";
import { formatAgentDisplayStateText } from "../../utils/activity";
import { useAgentRuntimeSignInNeeded } from "./useAgentRuntimeSignInNeeded";

/**
 * Isolated component that subscribes to a single agent's activity and renders
 * a colored `<StatusDot />`. This is the zustand-bound flavor — for static
 * activity values, use `<StatusDot activity={...} />` directly.
 *
 * Pass `size` / `className` through for non-avatar status labels. Avatar
 * activity belongs in raft-ui's `<AvatarBadge>`; AvatarBadge
 * owns its corner geometry and responsive scale.
 */
export default function AgentActivityDot({
  agentId,
  fallbackActivity = "offline",
  size,
  className,
  ...rest
}: { agentId: string; fallbackActivity?: AgentActivity } & Omit<StatusDotProps, "activity" | "tone">) {
  const intl = useIntl();
  const fallbackStatus = fallbackActivity === "offline" ? "stopped" : "active";
  const displayState = useAgentDisplayState(agentId, { status: fallbackStatus });
  const traceJoin = useAgentActivityTraceJoin(agentId);
  // #triage:#494: a start waiting for the runtime's sign-in is something a
  // person must do: the error light, and the sentence in place of the daemon's.
  const signIn = useAgentRuntimeSignInNeeded(agentId, displayState);
  const title = rest.title ?? signIn?.detail ?? formatAgentDisplayStateText(intl, displayState);
  // Traced when what the dot shows changes, with the join of the push that
  // changed it; a new push that leaves the dot as it was (a new join id
  // alone) is not a new dot state (#proj-frontend:#8).
  const traceApplied = useEffectEvent((activity: AgentActivity, isOnline: boolean | undefined, isExternal: boolean | undefined) => {
    traceAgentActivityStatusDotApplied({ agentId, activity, isOnline, isExternal, join: traceJoin });
  });
  useEffect(() => {
    traceApplied(displayState.activity, displayState.isOnline, displayState.isExternal);
  }, [agentId, displayState.activity, displayState.isOnline, displayState.isExternal]);
  return <StatusDot presence={signIn ? "error" : undefined} activity={displayState.activity} external={displayState.isExternal && !displayState.isOnline} size={size} className={className} {...rest} title={title} />;
}
