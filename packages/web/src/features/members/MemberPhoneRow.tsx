import { SidebarItem, SidebarItemContent, SidebarItemSubtitle, SidebarItemTitle } from "@botiverse/raft-ui";
import { memo, useCallback, useId } from "react";
import { useIntl } from "react-intl";
import { MemberEntryAppTag, MemberEntryAvatar, MemberEntryRoleWord, YouSuffix } from "./MemberEntryParts";
import { agentRuntimeFacts, memberDescription } from "./memberEntryFacts";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { MemberMenuTrigger } from "./MemberMenuTrigger";
import type { MemberEntry } from "./membersPageModel";

/**
 * A member on a phone (raft-design Members › On a phone): the sidebar row the
 * phone's lists of places use, one button that opens the profile. It is 44px
 * with one line; raft-ui's sidebar row has no fixed two-line height, so with a
 * second line it grows (`wrap`) to about 60px, as a pinned row does. On
 * the Agents tab its second line is the runtime, the model and the computer
 * in Space Mono (no computer under By computer: its heading names it);
 * elsewhere the description (or a Guest's channel), as the Members list
 * showed before.
 */
export const MemberPhoneRow = memo(function MemberPhoneRow({ entry, isSelf, runtimeLine, machineName, onOpen }: {
  entry: MemberEntry;
  isSelf: boolean;
  /** The Agents tab: the second line is what the agent runs on. */
  runtimeLine: boolean;
  /** The computer for that line, or null to leave it out. */
  machineName: string | null;
  onOpen: (entry: MemberEntry) => void;
}) {
  const { formatMessage } = useIntl();
  const deprecatedHere = useRuntimeDeprecatedHere();
  const handleClick = useCallback(() => onOpen(entry), [entry, onOpen]);
  const id = useId();
  let second: string | null;
  if (runtimeLine && entry.kind === "agent") {
    const { runtime, model } = agentRuntimeFacts(entry.agent, formatMessage, deprecatedHere);
    second = [runtime, model, machineName].filter(Boolean).join(" · ") || null;
  } else if (entry.kind === "human" && entry.member.role === "guest" && entry.member.guestChannel) {
    second = formatMessage({ id: "layout.sidebar.guestChannel" }, { channel: entry.member.guestChannel.name });
  } else {
    second = memberDescription(entry);
  }
  return (
    <MemberMenuTrigger
      entry={entry}
      render={<SidebarItem type="button" wrap={Boolean(second)} />}
      onClick={handleClick}
      aria-label={formatMessage({ id: "members.page.openProfile" }, { name: entry.name })}
      aria-describedby={second ? `${id}-meta ${id}-second` : `${id}-meta`}
      data-testid={`member-row-${entry.id}`}
      data-member-entry-id={entry.id}
      data-slot="sidebar-item"
      className="w-full"
    >
      <MemberEntryAvatar entry={entry} context="sidebar-list" />
      <SidebarItemContent stacked>
        <span className="flex min-w-0 items-baseline gap-1">
          <SidebarItemTitle data-testid="member-entry-name">{entry.name}</SidebarItemTitle>
          <span id={`${id}-meta`} className="contents">
            {isSelf ? <YouSuffix /> : null}
            <MemberEntryRoleWord entry={entry} className="shrink-0 text-caption font-medium text-foreground-hint" />
            <MemberEntryAppTag entry={entry} className="self-center" />
          </span>
        </span>
        {second ? (
          <SidebarItemSubtitle
            id={`${id}-second`}
            className={runtimeLine ? "font-mono text-mono-meta" : undefined}
            data-testid={runtimeLine ? "member-row-runtime" : "member-entry-description"}
          >
            {second}
          </SidebarItemSubtitle>
        ) : null}
      </SidebarItemContent>
    </MemberMenuTrigger>
  );
});
