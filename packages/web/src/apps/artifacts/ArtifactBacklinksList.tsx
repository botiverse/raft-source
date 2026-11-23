import { useCallback, useContext, useEffect, useId, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ListRow, TextLink } from "@botiverse/raft-ui";
import type { ArtifactCard } from "@botiverse/raft-shared";

import AvatarSlot from "../../components/ui/AvatarSlot";
import { formatShortRelativeTime } from "../../utils/relativeTime";
import { ArtifactActorAvatar } from "./ArtifactActorParts";
import { BACKLINKS_FIRST_ROWS, backlinksRows } from "./artifactBacklinksModel";
import type { NamedBacklinkMessage } from "./artifactBacklinksModel";
import { useArtifactHomeText } from "./ArtifactCardParts";
import { artifactActorName } from "./artifactFacts";
import { artifactUrl } from "./artifactLinks";
import { KindGlyph } from "./ArtifactMessageCard";
import { rememberArtifactCard } from "./artifactOpenIntent";
import { artifactShareHost } from "./artifactShareHost";
import { isPlainPrimaryClick, openArtifactInPlace } from "./openArtifactInPlace";
import { ArtifactMessageOpeningContext } from "./useArtifactBacklinks";

/**
 * What "Linked from" lists (#proj-workspace:#336 step 2, Kirby's design), the same wherever it is
 * drawn (the strip's section, its phone sheet, the block under content Raft draws): two groups,
 * Documents (other Artifacts whose current version links this one) and Discussions (chat messages
 * that link it), each its first BACKLINKS_FIRST_ROWS rows and "Show all N" for the rest of the page
 * the route answered (at most ARTIFACT_BACKLINKS_PAGE_LIMIT). A group with nothing to list is left out.
 *
 * - A document is drawn with the message card's parts (KindGlyph, its title, where it lives, who and
 *   how long ago, as the cards' lists say it) and opens as an Artifact link in Raft does: a plain click in
 *   place (openArtifactInPlace), Cmd/Ctrl, Shift and middle clicks its own page (the link's address).
 * - A discussion: who sent it (avatar and name; a sender Raft names no one here, `author` null, is
 *   "Someone" with a person's placeholder), the conversation as the reader's own channel list names
 *   it, in the documents' words for where something lives ("#design", "Direct message with Niko"),
 *   how long ago, and the message's excerpt on at most two lines. It opens the message in its
 *   conversation (its thread for a reply) and highlights it, as the original message's line does
 *   (ArtifactOriginLink); a message in a conversation the reader's list can't name is left out, as
 *   that line is (never an id, never a name from anywhere else): `discussions` are only those it
 *   names (ArtifactBacklinksProvider), which the count counts too.
 * - Both say how long ago in one short form ("2h ago"), in the rows' meta size.
 *
 * `from`: the element an Artifact opens from (findArtifactPlace), where the rows are in a portal
 * (the phone's sheet): the strip in the viewer. `onOpened`: after a row opened something (the sheet closes).
 */
export function ArtifactBacklinksList({ documents, discussions, from, onOpened }: {
  documents: readonly ArtifactCard[];
  discussions: readonly NamedBacklinkMessage[];
  from?: () => HTMLElement | null;
  onOpened?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="artifact-backlinks-list">
      {documents.length > 0 ? <Documents cards={documents} from={from} onOpened={onOpened} /> : null}
      {discussions.length > 0 ? <Discussions named={discussions} onOpened={onOpened} /> : null}
    </div>
  );
}

/** How long ago, as both rows say it: the short form ("2h ago"), in the meta line's size (not Space Mono, whose space reads double). */
const WHEN_CLASS = "shrink-0 text-caption whitespace-nowrap text-foreground-hint";

/** A row: raft-ui's ListRow as a list cell (its hover, press and focus on one inset shape), slimmer than a 64px row. */
const ROW_CLASS = "gap-2.5 py-1.5";

/**
 * One group: its heading, its rows, then "Show all N" while some are folded. Showing them moves focus
 * to the first row it showed (the button goes away from under it).
 */
function Group({ title, testId, more, onShowAll, children }: {
  title: string;
  testId: string;
  more: number;
  onShowAll: () => void;
  children: ReactNode;
}) {
  const { formatMessage } = useIntl();
  const headingId = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  // Set by the press: once the rows it showed are drawn (`more` back to 0), the first of them takes focus.
  const focusShown = useRef(false);
  useEffect(() => {
    if (!focusShown.current || more > 0) return;
    focusShown.current = false;
    listRef.current?.children[BACKLINKS_FIRST_ROWS]?.querySelector<HTMLElement>("a, button")?.focus();
  }, [more]);
  const showAll = useCallback(() => {
    focusShown.current = true;
    onShowAll();
  }, [onShowAll]);
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-1" data-testid={`artifact-backlinks-${testId}`}>
      <h3 id={headingId} className="m-0 text-caption font-semibold text-foreground-hint">{title}</h3>
      {/* -mx: a cell's hover and focus reach past its text (its inset and padding), which stays in line with the heading. */}
      <ul ref={listRef} className="-mx-5 m-0 flex list-none flex-col gap-0.5 p-0">{children}</ul>
      {more > 0 ? (
        <div>
          {/* A text button at the rows' meta size, in ink: clearly the way to the rest, not a pale heading. */}
          <TextLink variant="strong" onClick={showAll} className="text-caption" data-testid={`artifact-backlinks-${testId}-all`}>
            {formatMessage({ id: "artifacts.backlinks.showAll" }, { count: more })}
          </TextLink>
        </div>
      ) : null}
    </section>
  );
}

function Documents({ cards, from, onOpened }: { cards: readonly ArtifactCard[]; from?: () => HTMLElement | null; onOpened?: () => void }) {
  const { formatMessage } = useIntl();
  const [all, setAll] = useState(false);
  const showAll = useCallback(() => setAll(true), []);
  const { rows, more } = backlinksRows(cards, all);
  return (
    <Group title={formatMessage({ id: "artifacts.backlinks.documents" })} testId="documents" more={more} onShowAll={showAll}>
      {rows.map((card) => <DocumentRow key={card.id} card={card} from={from} onOpened={onOpened} />)}
    </Group>
  );
}

function DocumentRow({ card, from, onOpened }: { card: ArtifactCard; from?: () => HTMLElement | null; onOpened?: () => void }) {
  const intl = useIntl();
  const homeText = useArtifactHomeText();
  // The link is named by its title, described by its line (the anchor is ListRow's render element).
  const lineId = useId();
  // Where it lives, who it names, when it last changed: as the Artifacts group of search says it (ArtifactSearchHit).
  const line = [homeText(card.home, card.fromAnotherServer), artifactActorName(card.author, intl.formatMessage), formatShortRelativeTime(card.updatedAt, intl.locale)]
    .filter((part): part is string => !!part)
    .join(" · ");
  const open = useCallback((event: MouseEvent<HTMLElement>) => {
    if (!isPlainPrimaryClick(event)) return;
    // Its card is the viewer's header while the viewer data loads, as a message card's is.
    rememberArtifactCard(card);
    if (!openArtifactInPlace({ id: card.id, version: null }, from?.() ?? event.currentTarget, "other")) return;
    event.preventDefault();
    onOpened?.();
  }, [card, from, onOpened]);
  return (
    <li className="min-w-0">
      <ListRow variant="entry" cell render={<a href={artifactUrl(card.id, null)} aria-label={card.title} aria-describedby={line ? lineId : undefined} />} onClick={open} className={ROW_CLASS} data-testid="artifact-backlinks-document" data-artifact-id={card.id}>
        <KindGlyph card={card} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="truncate text-callout font-semibold text-foreground">{card.title}</span>
          {line ? <span id={lineId} className="truncate text-caption text-foreground-hint">{line}</span> : null}
        </span>
      </ListRow>
    </li>
  );
}

function Discussions({ named, onOpened }: { named: readonly NamedBacklinkMessage[]; onOpened?: () => void }) {
  const { formatMessage } = useIntl();
  const [all, setAll] = useState(false);
  const showAll = useCallback(() => setAll(true), []);
  const { rows, more } = backlinksRows(named, all);
  return (
    <Group title={formatMessage({ id: "artifacts.backlinks.discussions" })} testId="discussions" more={more} onShowAll={showAll}>
      {rows.map((item) => <DiscussionRow key={item.message.messageId} item={item} onOpened={onOpened} />)}
    </Group>
  );
}

function DiscussionRow({ item, onOpened }: { item: NamedBacklinkMessage; onOpened?: () => void }) {
  const intl = useIntl();
  const homeText = useArtifactHomeText();
  const { message, conversation } = item;
  const openMessage = artifactShareHost().useOpenMessage();
  const opening = useContext(ArtifactMessageOpeningContext);
  const open = useCallback(() => {
    onOpened?.();
    openMessage({ conversationId: message.conversationId, threadRootId: message.threadRootId ?? null }, message.messageId, opening);
  }, [message, onOpened, openMessage, opening]);
  const { author } = message;
  const name = author ? artifactActorName(author, intl.formatMessage) : intl.formatMessage({ id: "artifacts.backlinks.someone" });
  const when = formatShortRelativeTime(message.createdAt, intl.locale);
  return (
    <li className="min-w-0">
      <ListRow variant="entry" cell onClick={open} className={`${ROW_CLASS} items-start`} data-testid="artifact-backlinks-discussion" data-message-id={message.messageId}>
        {author
          ? <ArtifactActorAvatar actor={author} context="comment-entry" className="mt-px shrink-0" />
          : <AvatarSlot context="comment-entry" type="human" humanPlaceholder className="mt-px shrink-0" />}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5 text-callout">
            <span className="min-w-0 shrink truncate font-semibold text-foreground">{name}</span>
            <span className="min-w-0 shrink-[2] truncate text-foreground-muted" data-testid="artifact-backlinks-conversation">{homeText({ kind: "conversation", conversation })}</span>
            {when ? (
              <time dateTime={message.createdAt} className={`ms-auto ps-2 ${WHEN_CLASS}`}>{when}</time>
            ) : null}
          </span>
          {message.excerpt ? <span className="line-clamp-2 text-callout break-words text-foreground-muted">{message.excerpt}</span> : null}
        </span>
      </ListRow>
    </li>
  );
}
