import type { ReactElement } from "react";
import { useIntl } from "react-intl";
import AppBadge from "../../components/agent/AppBadge";
import AgentActivityDot from "../../components/agent/AgentActivityDot";
import AvatarSlot from "../../components/ui/AvatarSlot";
import type { AvatarContext } from "../../components/ui/AvatarSlot";
import { entryRole, roleWordId } from "./membersPageModel";
import type { MemberEntry } from "./membersPageModel";

/** The member's avatar; an agent's carries its presence light (an App's
 *  identity has none, as on its sidebar row). */
export function MemberEntryAvatar({ entry, context, badge }: {
  entry: MemberEntry;
  context: AvatarContext;
  /** An agent's light from a display state the caller already reads (one read per row). */
  badge?: ReactElement;
}) {
  if (entry.kind === "human") {
    return (
      <AvatarSlot
        context={context}
        type="human"
        humanAvatarUrl={entry.member.avatarUrl}
      />
    );
  }
  return (
    <AvatarSlot
      context={context}
      type="agent"
      agentAvatarUrl={entry.agent.avatarUrl}
      badge={entry.agent.managedByAppInstallId ? undefined : badge ?? <AgentActivityDot agentId={entry.agent.id} size="sm" />}
    />
  );
}

/**
 * "(you)" after the viewer's own name. zh writes it in full-width brackets, as
 * the rest of the catalog does (「（你）」); `text-spacing-trim` takes off the
 * opening bracket's built-in half-em, so the gap after the name matches en.
 */
export function YouSuffix() {
  const { formatMessage } = useIntl();
  return (
    <span className="shrink-0 font-normal text-foreground-hint [text-spacing-trim:trim-start]" data-testid="member-entry-you">
      {formatMessage({ id: "layout.sidebar.youSuffix" })}
    </span>
  );
}

/** The App tag on an App's identity. */
export function MemberEntryAppTag({ entry, className = "" }: { entry: MemberEntry; className?: string }) {
  if (entry.kind !== "agent" || !entry.agent.managedByAppInstallId) return null;
  return <AppBadge className={`shrink-0 ${className}`.trim()} appName={entry.agent.managedByApp?.name} botName={entry.name} />;
}

/** The role word after the name: Owner, Admin or Guest only, never Member. */
export function MemberEntryRoleWord({ entry, className }: { entry: MemberEntry; className: string }) {
  const { formatMessage } = useIntl();
  const id = roleWordId(entryRole(entry));
  if (!id) return null;
  return <span className={className} data-testid="member-entry-role">{formatMessage({ id })}</span>;
}
