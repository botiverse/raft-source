import { Card } from "@botiverse/raft-ui";
import { memo, useCallback, useId } from "react";
import { useIntl } from "react-intl";
import { MemberEntryAppTag, MemberEntryAvatar, MemberEntryRoleWord, YouSuffix } from "./MemberEntryParts";
import { memberDescription } from "./memberEntryFacts";
import { MemberMenuTrigger } from "./MemberMenuTrigger";
import { MEMBER_TILE_MIN_H } from "./memberRowHeights";
import type { MemberEntry } from "./membersPageModel";

/**
 * A member as a tile in the directory's grid: the anatomy and size of a DS
 * ListRow (`default`) set in a card, so a person reads at the size people and
 * agents have everywhere else in the app: a 35px avatar (`list-row`), the name
 * at 600 in `text-body` (14/22 with a mouse) with the role word, "(you)" and
 * the App tag after it, and the description on one line under it as the row's
 * subtitle (footnote, ink). 66px tall with a mouse and 58px by touch, a
 * ListRow with a subtitle (raft-design spacing.md › Heights, a row with an
 * avatar and a preview: at least 64 / 56); the
 * text is centred beside the avatar, so a tile without a description holds no
 * empty line. The whole tile is one button that opens the profile; its name
 * is "Open X's profile" and the rest of the tile is its description
 * (aria-describedby). Its menu and double-click (Message) are
 * MemberMenuTrigger's.
 *
 * raft-ui Card is the surface (hairline, radius-container, layer-card, no
 * shadow), rendered as the button. Card has no interactive state of its own,
 * so the DS states are added here: the subtle tier on hover, the medium tier
 * on press, and `focus-ring` (shadow-focus), which raft-ui shows only after
 * keyboard input (states.md › Focus). An upstream raft-ui candidate.
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
  const description = memberDescription(entry);
  return (
    <MemberMenuTrigger
      entry={entry}
      render={<Card render={<button type="button" />} />}
      onClick={handleClick}
      aria-label={formatMessage({ id: "members.page.openProfile" }, { name: entry.name })}
      aria-describedby={description ? `${id}-meta ${id}-desc` : `${id}-meta`}
      data-testid={`member-tile-${entry.id}`}
      data-member-kind={entry.kind}
      data-member-entry-id={entry.id}
      aria-current={selected ? "true" : undefined}
      data-selected={selected ? "" : undefined}
      className={`${MEMBER_TILE_MIN_H} flex-row items-center gap-3 px-4 py-3 text-left outline-none pointer-coarse:py-2 active:overlay-medium focus-visible:shadow-focus ${selected ? "bg-info-soft" : "hover:overlay-subtle"}`}
    >
      <MemberEntryAvatar entry={entry} context="list-row" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-[3ch] truncate text-body font-semibold text-foreground" data-testid="member-entry-name">
            {entry.name}
          </span>
          <span id={`${id}-meta`} className="contents">
            {isSelf ? <YouSuffix /> : null}
            <MemberEntryRoleWord entry={entry} className="shrink-0 text-caption font-medium text-foreground-muted" />
            <MemberEntryAppTag entry={entry} className="self-center" />
          </span>
        </span>
        {/* The row's subtitle (ListRowSubtitle's type): one line, and none at all without a description. */}
        {description ? (
          <span id={`${id}-desc`} className="truncate text-footnote text-foreground" data-testid="member-entry-description">
            {description}
          </span>
        ) : null}
      </span>
    </MemberMenuTrigger>
  );
});
