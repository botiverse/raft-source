import { Card } from "@botiverse/raft-ui";
import { memo, useCallback, useContext, useId } from "react";
import { useIntl } from "react-intl";
import { RoleCornerTag, RoleCornerTagSpacer } from "../../components/member/MemberLabelParts";
import { EditAgentButton } from "./EditAgentButton";
import { MemberActionsContext } from "./memberActionsContext";
import { MemberEntryAppTag, MemberEntryAvatar } from "./MemberEntryParts";
import { memberDescription } from "./memberEntryFacts";
import { MemberMenuTrigger } from "./MemberMenuTrigger";
import { MEMBER_TILE_MIN_H } from "./memberRowHeights";
import type { MemberEntry } from "./membersPageModel";
import { AGENT_MODEL_LINE, agentTileModel, useCanEditAgent, useMemberTileTag } from "./memberTileParts";

/**
 * A member as a tile in the directory's grid: the anatomy and size of a DS
 * ListRow (`default`) set in a card, so a person reads at the size people and
 * agents have everywhere else in the app: a 35px avatar (`list-row`), the name
 * at 600 in `text-body` (14/22 with a mouse) and nothing else on its line but
 * the App tag, and one line under it as the row's subtitle (footnote): a
 * person's description, an agent's model in mono meta as the Agents tab's
 * Model column sets it (its description is in its hover
 * card and profile, and is the tile's accessible description). The role, and
 * "You" on the viewer's own tile ("You · Owner"), is the hover card's corner
 * tag (RoleCornerTag) in the tile's top-right corner (raft-design Members).
 * 66px tall with a mouse and 58px by touch, a ListRow with a subtitle
 * (raft-design spacing.md › Heights, a row with an avatar and a preview: at
 * least 64 / 56); the text is centred beside the avatar, so a tile without a
 * second line holds no empty line. The whole tile is one button that opens
 * the profile; its name is "Open X's profile" and the rest of the tile is its
 * description (aria-describedby). Its menu and double-click (Message) are
 * MemberMenuTrigger's.
 *
 * An agent the viewer may edit (useCanEditAgent) has Edit agent
 * (EditAgentButton) over the tile's bottom-right corner, below the corner
 * tag (by touch too, at the tile's 60px): a sibling of the tile's button in
 * the tile's cell, not inside it. The text keeps clear of it.
 *
 * raft-ui Card is the surface (hairline, radius-container, layer-card, no
 * shadow), rendered as the button. Card has no interactive state of its own,
 * so the DS states are added here: the subtle tier on hover (of the cell, so
 * it holds while the pointer is on Edit agent), the medium tier on press, and
 * `focus-ring` (shadow-focus), which raft-ui shows only after keyboard input
 * (states.md › Focus). An upstream raft-ui candidate.
 */
export const MemberTile = memo(function MemberTile({ entry, isSelf, selected, onOpen }: {
  entry: MemberEntry;
  isSelf: boolean;
  /** Open in the side panel: Raft DS › States "Selected: content", info-soft and no hover, as the Computers rack's open card. */
  selected: boolean;
  onOpen: (entry: MemberEntry) => void;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onOpen(entry), [entry, onOpen]);
  const id = useId();
  const actions = useContext(MemberActionsContext);
  const agent = entry.kind === "agent" ? entry.agent : null;
  const canEdit = useCanEditAgent(agent) && actions !== null;
  const tag = useMemberTileTag(entry, isSelf);
  const description = memberDescription(entry);
  const second = agent ? agentTileModel(agent) : description;
  const describedBy = [
    tag ? `${id}-tag` : null,
    second ? `${id}-second` : null,
    agent && description ? `${id}-desc` : null,
  ].filter(Boolean).join(" ") || undefined;
  return (
    <div className="group/edit relative min-w-0" data-testid={`member-tile-cell-${entry.id}`}>
      <MemberMenuTrigger
        entry={entry}
        render={<Card render={<button type="button" />} />}
        onClick={handleClick}
        aria-label={formatMessage({ id: "members.page.openProfile" }, { name: entry.name })}
        aria-describedby={describedBy}
        data-testid={`member-tile-${entry.id}`}
        data-member-kind={entry.kind}
        data-member-entry-id={entry.id}
        aria-current={selected ? "true" : undefined}
        data-selected={selected ? "" : undefined}
        className={`${MEMBER_TILE_MIN_H} relative w-full flex-row items-center gap-3 overflow-hidden px-4 py-3 text-left outline-none pointer-coarse:py-2 active:overlay-medium focus-visible:shadow-focus ${selected ? "bg-info-soft" : "group-hover/edit:overlay-subtle"}`}
      >
        {tag ? <span id={`${id}-tag`} className="contents"><RoleCornerTag label={tag} /></span> : null}
        <MemberEntryAvatar entry={entry} context="list-row" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/* Clear of Edit agent, which may overlap the name line too (a tile with no second line centres it). */}
          <span className={`flex min-w-0 items-center gap-2 ${canEdit ? "pr-8" : ""}`}>
            <span className="min-w-[3ch] truncate text-body font-semibold text-foreground" data-testid="member-entry-name">
              {entry.name}
            </span>
            <MemberEntryAppTag entry={entry} />
            {tag ? <RoleCornerTagSpacer label={tag} /> : null}
          </span>
          {/* The row's subtitle (ListRowSubtitle's type): one line, and none at all without one; clear of Edit agent. */}
          {second ? (
            <span
              id={`${id}-second`}
              className={`truncate ${agent ? AGENT_MODEL_LINE : "text-footnote text-foreground"} ${canEdit ? "pr-8" : ""}`}
              data-testid={agent ? "member-entry-model" : "member-entry-description"}
            >
              {second}
            </span>
          ) : null}
          {agent && description ? <span id={`${id}-desc`} className="sr-only">{description}</span> : null}
        </span>
      </MemberMenuTrigger>
      {canEdit && agent && actions ? (
        <EditAgentButton agent={agent} onEdit={actions.requestEdit} className="absolute right-2 bottom-2 pointer-coarse:bottom-0.5" />
      ) : null}
    </div>
  );
});
