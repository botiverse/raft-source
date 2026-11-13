import { useCallback, useId } from "react";
import { useIntl } from "react-intl";
import { Globe } from "lucide-react";
import {
  IconTile,
  InboxItem,
  InboxItemContent,
  InboxItemHeading,
  InboxItemLeading,
  InboxItemMetadata,
  InboxItemSubtitle,
  InboxItemTimestamp,
  InboxItemTitle,
  InboxItemTrailing,
  InboxItemTrigger,
} from "@botiverse/raft-ui";

import { formatShortRelativeTime } from "../../utils/relativeTime";
import { ArtifactAuthor } from "./ArtifactAuthor";
import { artifactKindIcon, useArtifactHomeText } from "./ArtifactCardParts";
import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import { artifactShownTitle } from "./artifactFacts";
import { ArtifactNewSticker } from "./ArtifactNewSticker";
import type { OpenRow } from "./artifactDashboardParts";

/**
 * One Artifact of a phone's list (design p3): the kind's tile, the title on one
 * line, then where it lives, its version and its comments ("#channel · v2 · 4
 * comments"), at the end when it was last opened in that order, else updated, short as a phone's tile says it;
 * then who made it and what is new. Every place reads alike; a public one has a globe before it.
 * Every home page row shows its title without an old `.md` or `.html` (artifactShownTitle).
 */
export function AllRow({ item, index, onOpen, readerId }: { item: ArtifactDashboardItem; index: number; onOpen: OpenRow; readerId: string | null }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const homeText = useArtifactHomeText();
  const ids = { title: useId(), meta: useId() };
  const { card } = item;
  const open = useCallback(
    (event: { currentTarget: HTMLElement }) => onOpen(card, event.currentTarget, index),
    [card, onOpen, index],
  );
  const facts = [
    formatMessage({ id: "artifacts.card.version" }, { version: card.version }),
    card.commentCount > 0 ? formatMessage({ id: "artifacts.card.comments" }, { count: card.commentCount }) : null,
  ].filter((part): part is string => part !== null);
  return (
    // Compact: the title and the line under it one line each (raft-ui InboxItem density), the time beside the title.
    <InboxItem density="compact" data-testid="artifacts-all-row" data-artifact-id={card.id}>
      <InboxItemTrigger aria-labelledby={`${ids.title} ${ids.meta}`} onClick={open} data-artifact-open="" />
      <InboxItemLeading>
        <IconTile>{artifactKindIcon(card.kind)}</IconTile>
      </InboxItemLeading>
      <InboxItemContent>
        <InboxItemHeading>
          <InboxItemTitle id={ids.title} data-artifact-title="">{artifactShownTitle(card.title)}</InboxItemTitle>
        </InboxItemHeading>
        <InboxItemSubtitle id={ids.meta} className="truncate" data-testid="artifacts-all-meta">
          <span data-testid="artifacts-all-place">
            {card.home.kind === "public" ? <Globe aria-hidden size={12} className="mr-1 inline align-[-0.125em]" data-testid="artifacts-all-public" /> : null}
            {homeText(card.home, card.fromAnotherServer)}
          </span>
          {facts.map((fact) => ` · ${fact}`).join("")}
        </InboxItemSubtitle>
        <RowMetadata item={item} readerId={readerId} />
      </InboxItemContent>
      <InboxItemTrailing>
        <InboxItemTimestamp>{formatShortRelativeTime(item.openedAt ?? card.updatedAt, intl.locale)}</InboxItemTimestamp>
      </InboxItemTrailing>
    </InboxItem>
  );
}

/** A phone row's last line (design p3, D17): who made it first, then the pink sticker. */
function RowMetadata({ item, readerId }: { item: ArtifactDashboardItem; readerId: string | null }) {
  return (
    <InboxItemMetadata className="relative min-w-0">
      <ArtifactAuthor actor={item.card.author} readerId={readerId} wrap />
      <ArtifactNewSticker news={item.news} />
    </InboxItemMetadata>
  );
}
