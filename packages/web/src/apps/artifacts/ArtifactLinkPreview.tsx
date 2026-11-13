import { useIntl } from "react-intl";
import { PreviewCardTitle, Text } from "@botiverse/raft-ui";
import { PreviewCardBody, PreviewCardMeta } from "@botiverse/raft-ui/wip";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { ARTIFACT_KIND_BADGE, formatArtifactFacts, formatArtifactUpdated } from "./artifactFacts";
import { useArtifactHomeText } from "./ArtifactCardParts";

/**
 * What an Artifact link in a message's text shows inside core's link chip
 * (components/message/AppLinkChip.tsx, ObjectLinkChip: the same chip, hover
 * card and footer as an App link, the footer naming the app alone), from the
 * message's one link-card read: the app's name for the footer and the hover
 * card's body (the chip's mark is `artifactKindIcon`, ArtifactCardParts), drawn with raft-ui's item card parts as
 * an App's card is (DS PreviewCard › Item card).
 */

/** The app's name, as the hover card's footer names whose link it is. */
export function useArtifactsAppName(): string {
  return useIntl().formatMessage({ id: "artifacts.dashboard.title" });
}

/**
 * The hover card's body, in an App item card's order: the title; the details
 * row (PreviewCardMeta, which wraps when out of room): the file type the
 * card's glyph names, the version as the card's tag says it ("v3 · latest
 * v5" when pinned to an older one), the card's own fact line
 * (formatArtifactFacts, as the card under the message says it, which
 * never names the kind: F37) and where it lives, each its own segment; then
 * who updated it and when; then the card's description, or the start of its
 * text. No state Badge: an Artifact has no state, and the card's parts stay
 * neutral.
 *
 * Grey only where it is the card's own: the details and the time are
 * secondary data, so they take PreviewCardMeta's ink (the time in the mono
 * notes size); the description is the item's own words, so it reads in ink.
 * No `Text variant="muted"`: that is for helper text, and this card has none.
 */
export function ArtifactLinkPreview({ card }: { card: ArtifactCard }) {
  const intl = useIntl();
  const homeText = useArtifactHomeText();
  // A deleted conversation's home has an empty name: no "#" alone.
  const home = card.home.kind === "conversation" && !card.home.conversation.name ? null : homeText(card.home, card.fromAnotherServer);
  const segments = [
    { part: "type", text: ARTIFACT_KIND_BADGE[card.kind] },
    {
      part: "version",
      text: card.pinned && card.latestVersion > card.version
        ? intl.formatMessage({ id: "artifacts.card.versionBehind" }, { version: card.version, latest: card.latestVersion })
        : intl.formatMessage({ id: "artifacts.card.version" }, { version: card.version }),
    },
    { part: "facts", text: formatArtifactFacts(card.kind, card.facts, intl) },
    { part: "home", text: home },
  ].filter((segment): segment is { part: string; text: string } => !!segment.text);
  const description = card.description ?? (card.preview.kind === "excerpt" ? card.preview.text : null);
  return (
    <PreviewCardBody>
      <PreviewCardTitle>{card.title}</PreviewCardTitle>
      <PreviewCardMeta data-artifact-link-meta="">
        <p className={`m-0 ${WRAP}`} data-artifact-link-details="">
          {segments.map((segment, index) => (
            <span key={segment.part}>
              {index > 0 ? " · " : null}
              <span {...{ [`data-artifact-link-${segment.part}`]: "" }}>{segment.text}</span>
            </span>
          ))}
        </p>
        <Text.Mono size="meta" className={WRAP} data-artifact-link-updated="">{formatArtifactUpdated(card, intl)}</Text.Mono>
      </PreviewCardMeta>
      {description ? (
        <Text.Sans size="small" variant="default" className={`line-clamp-2 whitespace-pre-wrap ${WRAP}`} data-artifact-link-description="">
          {description}
        </Text.Sans>
      ) : null}
    </PreviewCardBody>
  );
}

// The details row wraps (DS PreviewCardMeta); a long channel name breaks rather than overflow.
const WRAP = "min-w-0 break-words [overflow-wrap:anywhere]";
