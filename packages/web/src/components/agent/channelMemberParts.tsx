import { Badge } from "@botiverse/raft-ui";
import type { ComponentProps } from "react";
import { useIntl } from "react-intl";
import type { AgentActivity } from "@botiverse/raft-shared";
import { useAgentDisplayState, useAppBotAgent } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { formatAgentDisplayStateText } from "../../utils/activity";
import Tooltip from "../ui/Tooltip";

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
  if (isAppBot) return null;
  return (
    <div className="truncate text-caption text-foreground-hint">
      {activityText}
    </div>
  );
}

// Shared by the modal/panel member list and the members page, which shows
// the same remote-server badge on joint-channel rows. The RUI Badge recipe
// owns the chip shape (22px cyan-soft = external); the server label is data,
// so it reads in Space Mono like every other machine label.
// Other props (and a ref) reach the Badge, so a Tooltip can render through it.
// `spokenLabel`, when given, is what assistive tech reads instead of `label`
// (the visible label is then hidden from it).
// The label truncates in a span of its own: the Badge is an inline-flex box,
// and an ellipsis is drawn only by a block box (`text-overflow` doesn't apply
// to a flex container), so `truncate` on the Badge clipped a long server name
// mid-glyph with no "…" (cindyz, #wg-rbac:2ee0381d). The span may shrink
// (min-w-0) inside the chip, which may shrink inside the row.
export function JointPeerBadge({ label, spokenLabel, ...props }: { label: string; spokenLabel?: string } & Omit<ComponentProps<typeof Badge>, "children">) {
  return (
    <Badge
      {...props}
      appearance="soft"
      variant="information"
      className="inline-flex min-w-0 max-w-full shrink items-center justify-center text-center font-mono text-mono-meta font-normal"
    >
      <span className="min-w-0 truncate" aria-hidden={spokenLabel === undefined ? undefined : true}>{label}</span>
      {spokenLabel !== undefined && <span className="sr-only">{spokenLabel}</span>}
    </Badge>
  );
}

/** One JointPeerBadge per server, in roster order (viewed server first).
 *  `sourceOf`, when given (computed joint rosters, where each label is one
 *  of that person's sources), gives every badge the sentence
 *  "{name} is also a member of {server}": spoken as the badge's text and
 *  shown as a hover tooltip. */
export function JointServerBadges({ labels, sourceOf }: { labels: readonly string[]; sourceOf?: string }) {
  const { formatMessage } = useIntl();
  if (labels.length === 0) return null;
  return (
    // Keeps #9527's layout: the name keeps at least half the row and the
    // badges never push it to nothing. The badges themselves shrink (min-w-0
    // below) so a long server name is cut inside its own chip with an
    // ellipsis, instead of the row clipping every chip mid-glyph (cindyz,
    // #wg-rbac:2ee0381d): a name ending in "…" says it is shortened, a half
    // letter doesn't. They shrink far sooner than the name (999 to its 1), so
    // the row only ever shortens a server name to keep a person's whole.
    <span className="flex min-w-0 max-w-1/2 shrink-[999] items-center gap-1 overflow-hidden">
      {labels.map((label, index) => sourceOf === undefined
        ? <JointPeerBadge key={`${index}:${label}`} label={label} />
        : (() => {
          // The tag sits inside the row's profile button, which a tooltip can't
          // reach by keyboard, touch or screen reader: the sentence is also the
          // tag's spoken text, so it joins the row's accessible name; the hover
          // tooltip is an extra (DS accessibility: focus shows what hover shows).
          const sentence = formatMessage({ id: "channel.membersPage.sourceTagTooltip" }, { name: sourceOf, server: label });
          return (
            <Tooltip key={`${index}:${label}`} content={sentence}>
              <JointPeerBadge label={label} spokenLabel={sentence} />
            </Tooltip>
          );
        })())}
    </span>
  );
}
