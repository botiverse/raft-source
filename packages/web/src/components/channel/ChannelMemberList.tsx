import { useCallback } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { Badge, Button, Card, ScrollArea } from "@botiverse/raft-ui";
import type { AgentActivity, ServerRole } from "@botiverse/raft-shared";
import { UserMinus, X } from "lucide-react";
import AvatarSlot from "../ui/AvatarSlot";
import SectionEyebrow from "../ui/SectionEyebrow";
import Tooltip from "../ui/Tooltip";
import AgentActivityDot from "../agent/AgentActivityDot";
import AppBadge from "../agent/AppBadge";
import { useAppBotAgent } from "../../store/agentStore";

// DS ListRow for a member: 35px identity, the name 15/20 600, the role or
// handle 12/16 ink-3; rows hover with fill-subtle and are separated by a
// hairline that starts where the text starts (16 + 35 + 12 = 63px).
const MEMBER_ROW_CLASS = [
  "group relative flex min-h-16 items-center gap-3 px-4 py-2.5 transition-colors md:pointer-coarse:min-h-14",
  "hover:bg-fill-subtle [@media(max-height:600px)]:min-h-0 [@media(max-height:600px)]:py-1.5",
  "[[data-member-row]+&]:before:pointer-events-none [[data-member-row]+&]:before:absolute [[data-member-row]+&]:before:top-0 [[data-member-row]+&]:before:right-0 [[data-member-row]+&]:before:left-[63px] [[data-member-row]+&]:before:border-t [[data-member-row]+&]:before:border-line-hairline",
  "[li+li>&]:before:pointer-events-none [li+li>&]:before:absolute [li+li>&]:before:top-0 [li+li>&]:before:right-0 [li+li>&]:before:left-[63px] [li+li>&]:before:border-t [li+li>&]:before:border-line-hairline",
].join(" ");
const MEMBER_ROW_TITLE_CLASS = "truncate text-subhead font-semibold text-foreground";
// The title with the App badge after the name: the name truncates, the badge stays.
const MEMBER_ROW_TITLE_WITH_BADGE_CLASS = "flex min-w-0 items-center gap-1.5 text-subhead font-semibold text-foreground";
const MEMBER_ROW_SUB_CLASS = "truncate text-caption text-foreground-hint";

export function ChannelMemberListShell({
  children,
  className = "",
  framed = true,
  "data-testid": dataTestId,
}: {
  children: ReactNode;
  className?: string;
  /** Framed = bordered box with its own scroll (dialogs): the card is the
      frame, the rows scroll in a raft-ui ScrollArea that fills it, no tab stop
      (each row is one), a scroll at its end carrying on to the dialog.
      Unframed = flat sections that scroll with the surrounding sheet (drawer panel). */
  framed?: boolean;
  "data-testid"?: string;
}) {
  return framed ? (
    <Card className={`max-h-72 ${className}`} data-testid={dataTestId}>
      <ScrollArea tabIndex={-1} overscroll="auto" className="min-h-0 flex-1">
        {children}
      </ScrollArea>
    </Card>
  ) : (
    <div className={className} data-testid={dataTestId}>
      {children}
    </div>
  );
}

/** DS list section title (`rf-section`): 13/18 700 ink-3 above its rows,
 *  no band behind it. */
export function ChannelMemberSectionHeader({ children }: { children: ReactNode }) {
  return (
    <SectionEyebrow as="div" className="px-4 pt-4 pb-1.5">
      {children}
    </SectionEyebrow>
  );
}

function ChannelMemberActivityBadge({
  agentId,
  fallbackActivity,
}: {
  agentId: string;
  fallbackActivity?: AgentActivity;
}) {
  return (
    <AgentActivityDot
      agentId={agentId}
      fallbackActivity={fallbackActivity}
      size="md"
      data-channel-member-avatar-badge-shell="true"
    />
  );
}

/** Channel membership only needs one visible distinction: whether the actor
 *  effectively administers this channel. Server owner/admin inheritance and
 *  an explicit channel grant intentionally share the same user-facing label. */
export function MemberRoleTag({ role }: { role: ServerRole | null }) {
  const { formatMessage } = useIntl();
  // No role sent (another server's person): a plain member, no tag.
  if (role !== "owner" && role !== "admin" && role !== "guest") return null;
  const isGuest = role === "guest";
  // Both are a role in this channel, so both are the same neutral label (DS `rf-tag`): a guest's
  // cyan-soft chip read as a different kind of thing beside Channel admin (cindyz, #wg-rbac:2ee0381d).
  return (
    <Badge
      data-testid={isGuest ? "member-page-role-channel-guest" : "member-page-role-channel-admin"}
      appearance="outline"
      className="shrink-0"
    >
      {formatMessage({ id: isGuest
        ? "channel.membersPage.role.channelGuest"
        : "channel.membersPage.role.channelAdmin" })}
    </Badge>
  );
}

export function ChannelMemberRoleAndActions({
  role,
  actions,
}: {
  role: ServerRole | null;
  actions: ReactNode;
}) {
  return (
    <span
      className="flex shrink-0 self-center items-center gap-2 md:pointer-fine:grid"
      data-testid="member-page-trailing"
    >
      <span
        className={`flex shrink-0 items-center md:pointer-fine:col-start-1 md:pointer-fine:row-start-1 md:pointer-fine:justify-self-end ${actions ? "md:pointer-fine:group-hover:invisible md:pointer-fine:group-focus-within:invisible" : ""}`}
      >
        <MemberRoleTag role={role} />
      </span>
      {actions ? (
        <span className="shrink-0 self-center md:pointer-fine:invisible md:pointer-fine:col-start-1 md:pointer-fine:row-start-1 md:pointer-fine:justify-self-end md:pointer-fine:group-hover:visible md:pointer-fine:group-focus-within:visible">
          {actions}
        </span>
      ) : null}
    </span>
  );
}

export function ChannelMemberRow({
  type,
  name,
  secondary,
  agentId,
  agentAvatarUrl,
  agentFallbackActivity,
  humanAvatarUrl,
  onAvatarClick,
  onRowClick,
  trailing,
  media,
  avatarCorner,
}: {
  type: "agent" | "human";
  name: ReactNode;
  secondary?: ReactNode;
  agentId?: string;
  agentAvatarUrl?: string | null;
  agentFallbackActivity?: AgentActivity;
  humanAvatarUrl?: string | null;
  onAvatarClick?: () => void;
  /** Whole-row click (member page: row → profile). Mutually exclusive
   *  with onAvatarClick — a button cannot nest inside a button, so the
   *  avatar renders inert when the row itself is the click target. */
  onRowClick?: () => void;
  trailing?: ReactNode;
  /** Replaces the avatar in the same 35px slot, for a row that isn't a
   *  person or an agent yet (an external invite's Mail tile). */
  media?: ReactNode;
  /** A mark on the avatar's top-left corner: another server's tile
   *  (AvatarOriginCorner). The bottom-right stays the agent's status light. */
  avatarCorner?: ReactNode;
}) {
  // An App bot (the agent list's record; member, follower and picker rows
  // carry only its id) has no presence: the App badge follows its name.
  const appBot = useAppBotAgent(type === "agent" ? agentId : null);
  const avatar = media ?? (
    <AvatarSlot
      context="list-row"
      type={type}
      agentAvatarUrl={agentAvatarUrl}
      humanAvatarUrl={humanAvatarUrl}
      badge={type === "agent" && agentId && !appBot ? (
        <ChannelMemberActivityBadge agentId={agentId} fallbackActivity={agentFallbackActivity} />
      ) : undefined}
      corner={avatarCorner}
    />
  );

  const text = (
    <div className="min-w-0 flex-1">
      {appBot ? (
        <div className={MEMBER_ROW_TITLE_WITH_BADGE_CLASS}>
          <span className="min-w-0 truncate">{name}</span>
          <AppBadge className="shrink-0" appName={appBot.managedByApp?.name} botName={appBot.displayName || appBot.name} />
        </div>
      ) : (
        <div className={MEMBER_ROW_TITLE_CLASS}>
          {name}
        </div>
      )}
      {secondary ? (
        <div className={MEMBER_ROW_SUB_CLASS}>
          {secondary}
        </div>
      ) : null}
    </div>
  );

  const body = (
    <>
      {text}
      {trailing}
    </>
  );

  if (onRowClick) {
    // The row body (avatar + name + sub-line) IS the profile button; the
    // trailing slot (role tag, remove button) renders as a sibling so
    // interactive controls never nest inside a button.
    return (
      <div className={MEMBER_ROW_CLASS} data-member-row="">
        <button
          type="button"
          onClick={onRowClick}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-control text-left outline-none focus-visible:shadow-focus"
        >
          <span className="relative shrink-0">{avatar}</span>
          {text}
        </button>
        {trailing}
      </div>
    );
  }

  return (
    <div className={MEMBER_ROW_CLASS} data-member-row="">
      {onAvatarClick ? (
        <button
          type="button"
          onClick={onAvatarClick}
          className="relative shrink-0 rounded-sticker outline-none focus-visible:shadow-focus"
        >
          {avatar}
        </button>
      ) : (
        <span className="relative shrink-0">{avatar}</span>
      )}
      {body}
    </div>
  );
}

export function ChannelMemberRemoveButton({
  label,
  onClick,
  revealOnRowHover = true,
  visibleLabel,
  icon,
}: {
  label: string;
  onClick: () => void;
  /** Desktop hover-reveal. Uses visibility (not display) so the button's
   *  space is always reserved — the trailing badge never shifts when the
   *  control appears (Artea 2026-08-05: reveal jitter). Mobile and touch
   *  tablets always show it (no hover): gated on `pointer-fine`, not width. */
  revealOnRowHover?: boolean;
  /** Member-management rows render icon-only with a suitable icon (Artea,
   *  2026-09-17); other compact lists keep the bare icon affordance. */
  visibleLabel?: string;
  icon?: ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <Button
        type="button"
        variant="ghost"
        size={visibleLabel ? "md" : "icon-md"}
        onClick={onClick}
        className={`flex ${revealOnRowHover ? "md:pointer-fine:invisible md:pointer-fine:group-hover:visible md:pointer-fine:group-focus-within:visible" : ""} text-foreground-muted hover:text-foreground`}
        aria-label={label}
      >
        {visibleLabel ?? icon ?? <X aria-hidden="true" />}
      </Button>
    </Tooltip>
  );
}

export function ChannelMemberHoverActions({
  roleAction,
  removeAction,
}: {
  roleAction?: {
    label: string;
    ariaLabel?: string;
    onClick: () => void;
    disabled?: boolean;
  };
  removeAction?: {
    label: string;
    onClick: () => void;
  };
}) {
  const onRoleAction = roleAction?.onClick;
  const handleRoleActionClick = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    onRoleAction?.();
  }, [onRoleAction]);

  if (!roleAction && !removeAction) return null;

  return (
    <span className="flex items-center gap-2" data-testid="channel-member-hover-actions">
      {roleAction && (
        <Button
          type="button"
          onClick={handleRoleActionClick}
          disabled={roleAction.disabled}
          size="md"
          variant="outline"
          className="whitespace-nowrap"
          data-testid="channel-member-role-action"
          aria-label={roleAction.ariaLabel}
        >
          {roleAction.label}
        </Button>
      )}
      {removeAction && (
        <ChannelMemberRemoveButton
          label={removeAction.label}
          onClick={removeAction.onClick}
          revealOnRowHover={false}
          icon={<UserMinus aria-hidden />}
        />
      )}
    </span>
  );
}
