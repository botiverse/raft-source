import { useIntl } from "react-intl";
import type { AgentActivity } from "@botiverse/raft-shared";
import { useAgentDisplayState, useAppBotAgent } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { formatAgentDisplayStateText } from "../../utils/activity";
import Tooltip from "../ui/Tooltip";
import { useAgentRuntimeSignInNeeded } from "./useAgentRuntimeSignInNeeded";

/**
 * Member-row parts the channel member list (ChannelMembers, loaded when the
 * members page opens) shares with rows that are always on screen: the
 * channel menu's agent rows and a thread's agent followers.
 */

// Shared by the modal/panel member list and the drawer-internal members
// page (presentation="page"), which renders the same per-agent activity
// sub-line.
export function agentStatusFallbackActivity(status: Agent["status"]): AgentActivity {
  return status === "active" ? "online" : "offline";
}

export function AgentActivityInfo({ agentId, fallbackStatus }: { agentId: string; fallbackStatus: Agent["status"] }) {
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId, { status: fallbackStatus });
  // An App bot has no presence (it would read "Offline" forever): its row
  // carries the App badge after the name instead (ChannelMemberRow).
  const isAppBot = useAppBotAgent(agentId) !== null;
  const activityText = formatAgentDisplayStateText(intl, displayState);
  // #triage:#494: a start waiting for the runtime's sign-in reads as that, with
  // the sentence on a second line in place of the daemon's (its full text on
  // hover). The row's Sign in is `AgentRuntimeSignInRowAction`, in its trailing slot.
  const signIn = useAgentRuntimeSignInNeeded(agentId, displayState);
  if (isAppBot) return null;
  if (signIn) {
    return (
      <div className="min-w-0" data-testid="member-row-sign-in-needed">
        <div className="truncate text-caption text-foreground-muted">{signIn.fullText}</div>
        <Tooltip content={signIn.detail}>
          <div className="truncate text-caption text-foreground-hint" data-testid="member-row-sign-in-detail">{signIn.detail}</div>
        </Tooltip>
      </div>
    );
  }
  return (
    <div className="truncate text-caption text-foreground-hint">
      {activityText}
    </div>
  );
}

/** The other servers a member of the viewed server is also in, in roster
 *  order, as quiet text after the name: "Also in Raft, Acme Corp", the same
 *  grey as the server name written after someone from another server
 *  (MemberRowName), so a member list has one way of saying a server (cindyz,
 *  2026-11-13, #wg-rbac:38225c7c; it was a blue chip per server). `sourceOf`,
 *  when given (computed joint rosters, where each label is one of that
 *  person's sources), gives the text the sentence "{name} is also a member of
 *  {servers}": spoken instead of the short form, and shown as a hover tooltip.
 *  Without it (an agent's row) the text is the same, with no tooltip or
 *  sentence. The text gives way before the
 *  name does (it shrinks 999 to the name's 1) and ends in an ellipsis. */
export function JointServerBadges({ labels, sourceOf }: { labels: readonly string[]; sourceOf?: string }) {
  const { formatMessage, formatList } = useIntl();
  if (labels.length === 0) return null;
  const quiet = "min-w-0 max-w-1/2 shrink-[999] truncate text-caption font-normal text-foreground-hint";
  const alsoIn = formatMessage({ id: "channel.membersPage.alsoIn" }, { servers: labels.join(", ") });
  // Always "Also in": server names alone after a name are how someone from
  // another server is written (MemberRowName), and these rows are ours.
  if (sourceOf === undefined) {
    return <span className={quiet} data-testid="member-row-also-in">{alsoIn}</span>;
  }
  // The text sits inside the row's profile button, which a tooltip can't
  // reach by keyboard, touch or screen reader: the sentence is also the
  // text's spoken form, so it joins the row's accessible name; the hover
  // tooltip is an extra (DS accessibility: focus shows what hover shows).
  const sentence = formatMessage({ id: "channel.membersPage.sourceTagTooltip" }, { name: sourceOf, server: formatList([...labels], { type: "conjunction" }) });
  return (
    <Tooltip content={sentence}>
      <span className={quiet} data-testid="member-row-also-in">
        <span aria-hidden>{alsoIn}</span>
        <span className="sr-only">{sentence}</span>
      </span>
    </Tooltip>
  );
}
