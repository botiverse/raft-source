import { SidebarItem, SidebarItemContent, SidebarItemSubtitle, SidebarItemTitle } from "@botiverse/raft-ui";
import { memo, useCallback, useContext, useId } from "react";
import { useIntl } from "react-intl";
import { RoleCornerTag, RoleCornerTagSpacer } from "../../components/member/MemberLabelParts";
import { EditAgentButton } from "./EditAgentButton";
import { MemberActionsContext } from "./memberActionsContext";
import { MemberEntryAppTag, MemberEntryAvatar, MemberEntryRoleWord } from "./MemberEntryParts";
import { agentRuntimeFacts, memberDescription } from "./memberEntryFacts";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import { MemberMenuTrigger } from "./MemberMenuTrigger";
import type { MemberEntry } from "./membersPageModel";
import { AGENT_MODEL_LINE, agentTileModel, useCanEditAgent, useMemberTileTag } from "./memberTileParts";

/**
 * A member on a phone (raft-design Members › On a phone): the sidebar row the
 * phone's lists of places use, one button that opens the profile. It is 44px
 * with one line; raft-ui's sidebar row has no fixed two-line height, so with a
 * second line it grows (`wrap`) to about 60px, as a pinned row does. On
 * the Agents tab its second line is the runtime, the model and the computer
 * in Space Mono (no computer under By computer: its heading names it), and the
 * role is a word after the name, as on the desktop's Agents rows. Elsewhere
 * it reads as the desktop's tile (MemberTile): the name alone on its line, the
 * role (and "You") in the corner tag, and as the second line a person's
 * description (or a Guest's channel) or an agent's model. An agent the viewer
 * may edit has Edit agent at the row's end, beside its button, always shown
 * by touch; such a row is two lines tall even with no second line, so the
 * corner tag sits above it, and its name keeps clear of it.
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
  const actions = useContext(MemberActionsContext);
  const agent = entry.kind === "agent" ? entry.agent : null;
  const canEdit = useCanEditAgent(agent) && actions !== null;
  const tileTag = useMemberTileTag(entry, isSelf);
  const cornerTag = runtimeLine ? null : tileTag;
  let second: string | null;
  if (runtimeLine && entry.kind === "agent") {
    const { runtime, model } = agentRuntimeFacts(entry.agent, formatMessage, deprecatedHere);
    second = [runtime, model, machineName].filter(Boolean).join(" · ") || null;
  } else if (entry.kind === "agent") {
    second = agentTileModel(entry.agent);
  } else if (entry.member.role === "guest" && entry.member.guestChannel) {
    second = formatMessage({ id: "layout.sidebar.guestChannel" }, { channel: entry.member.guestChannel.name });
  } else {
    second = memberDescription(entry);
  }
  const describedBy = [
    runtimeLine ? `${id}-meta` : null,
    cornerTag ? `${id}-tag` : null,
    second ? `${id}-second` : null,
  ].filter(Boolean).join(" ") || undefined;
  return (
    <div className="group/edit relative min-w-0">
      <MemberMenuTrigger
        entry={entry}
        render={<SidebarItem type="button" wrap={Boolean(second) || canEdit} />}
        onClick={handleClick}
        aria-label={formatMessage({ id: "members.page.openProfile" }, { name: entry.name })}
        aria-describedby={describedBy}
        data-testid={`member-row-${entry.id}`}
        data-member-entry-id={entry.id}
        data-slot="sidebar-item"
        className="relative w-full"
      >
        {/* The cell's own shape (raft-ui list cell: its inset and radius), so the tag sits in its corner. */}
        {cornerTag ? (
          <span id={`${id}-tag`} className="pointer-events-none absolute inset-y-0 right-(--cell-inset-end) left-(--cell-inset-x) overflow-hidden rounded-(--cell-radius)">
            <RoleCornerTag label={cornerTag} />
          </span>
        ) : null}
        <MemberEntryAvatar entry={entry} context="sidebar-list" />
        <SidebarItemContent stacked>
          <span className={`flex min-w-0 items-baseline gap-1 ${canEdit ? "pr-9" : ""}`}>
            <SidebarItemTitle data-testid="member-entry-name">{entry.name}</SidebarItemTitle>
            <span id={`${id}-meta`} className="contents">
              {runtimeLine ? <MemberEntryRoleWord entry={entry} className="shrink-0 text-caption font-medium text-foreground-hint" /> : null}
              <MemberEntryAppTag entry={entry} className="self-center" />
            </span>
            {cornerTag ? <RoleCornerTagSpacer label={cornerTag} /> : null}
          </span>
          {second ? (
            <SidebarItemSubtitle
              id={`${id}-second`}
              className={`${runtimeLine ? "font-mono text-mono-meta" : agent ? AGENT_MODEL_LINE : ""} ${canEdit ? "pr-9" : ""}`.trim() || undefined}
              data-testid={runtimeLine ? "member-row-runtime" : agent ? "member-entry-model" : "member-entry-description"}
            >
              {second}
            </SidebarItemSubtitle>
          ) : canEdit ? (
            // No second line: an empty one all the same, so the row is two lines tall and the
            // corner tag sits above Edit agent, never over it.
            <SidebarItemSubtitle aria-hidden className={`block h-lh ${AGENT_MODEL_LINE}`} data-testid="member-row-edit-spacer" />
          ) : null}
        </SidebarItemContent>
      </MemberMenuTrigger>
      {canEdit && agent && actions ? (
        <EditAgentButton agent={agent} onEdit={actions.requestEdit} className="absolute right-3 bottom-1" />
      ) : null}
    </div>
  );
});
