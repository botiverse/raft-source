import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  SearchEntityResult,
  SearchEntityResultContent,
  SearchEntityResultDescription,
  SearchEntityResultHeader,
  SearchEntityResultIcon,
  SearchEntityResultLeading,
  SearchEntityResultTitle,
} from "@botiverse/raft-ui";
import type { ArtifactSearchHit as ArtifactSearchHitData } from "@botiverse/raft-shared";

import { formatRelativeTime } from "../../utils/relativeTime";
import { artifactKindIcon, useArtifactHomeText } from "./ArtifactCardParts";
import { artifactActorName } from "./artifactFacts";

export interface ArtifactSearchHitProps {
  hit: ArtifactSearchHitData;
  /** The title with the query's hits marked: core search's marking, the same as every other result's. */
  highlight: (text: string) => ReactNode;
  /** The keyboard highlight (DS Search `selected`). */
  selected: boolean;
  onOpen: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}

/**
 * One Artifact in the Artifacts group of core's search (`GET /api/search`):
 * the hit's card as a search row (raft-ui SearchEntityResult, as the places
 * and people above it): the kind's tile, the title with its hits marked, then
 * where it lives, who it names and when it last changed, the same parts as
 * the Artifacts home page's rows (ArtifactCardParts).
 */
export function ArtifactSearchHit({ hit, highlight, selected, onOpen }: ArtifactSearchHitProps) {
  const intl = useIntl();
  const homeText = useArtifactHomeText();
  const { card } = hit;
  const when = formatRelativeTime(card.updatedAt, intl.locale);
  const line = [homeText(card.home, card.fromAnotherServer), artifactActorName(card.author, intl.formatMessage), when].filter((part): part is string => !!part).join(" · ");
  // The row is the button itself, a direct child of the section's list, with
  // the test id and the keyboard marker; a list cell draws no line between
  // rows (raft-design patterns/lists.md).
  return (
    <SearchEntityResult
      type="button"
      onClick={onOpen}
      selected={selected}
      data-testid="search-app-hit"
      data-artifact-id={card.id}
      data-active={selected ? "true" : undefined}
    >
      <SearchEntityResultLeading>
        <SearchEntityResultIcon>{artifactKindIcon(card.kind)}</SearchEntityResultIcon>
      </SearchEntityResultLeading>
      <SearchEntityResultContent>
        <SearchEntityResultHeader>
          <SearchEntityResultTitle className="truncate">{highlight(card.title)}</SearchEntityResultTitle>
        </SearchEntityResultHeader>
        <SearchEntityResultDescription>{line}</SearchEntityResultDescription>
      </SearchEntityResultContent>
    </SearchEntityResult>
  );
}
