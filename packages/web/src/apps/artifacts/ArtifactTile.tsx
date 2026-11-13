import { useCallback, useMemo } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import {
  MessageAttachmentCommentSummary,
  MessageAttachmentSummary,
  MessageEmbed,
  MessageEmbedContent,
  MessageEmbedFooter,
  MessageEmbedHeader,
} from "@botiverse/raft-ui";
import { CommentIcon } from "@botiverse/ricons";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { formatRelativeTime, formatShortRelativeTime } from "../../utils/relativeTime";
import { ArtifactAuthor } from "./ArtifactAuthor";
import { ArtifactCardExcerpt } from "./ArtifactCardExcerpt";
import { useArtifactCardPicture } from "./artifactCardPicture";
import { artifactShownTitle } from "./artifactFacts";
import { ArtifactVersionBadge, KindGlyph } from "./ArtifactMessageCard";
import { ArtifactNewSticker } from "./ArtifactNewSticker";
import { hasNews } from "./artifactNews";
import ArtifactScopeLabel from "./ArtifactScopeLabel";
import { artifactUrl } from "./artifactLinks";
import { useArtifactOpenIntent } from "./artifactOpenIntent";
import type { ArtifactDashboardItem } from "./artifactDashboardItems";
import { isPlainPrimaryClick } from "./openArtifactInPlace";

/**
 * The picture at the top of a tile (design D4, D5, D13): the publish check's
 * screenshot of the current version once the service sends one (the phone shot
 * on a phone when there is one), else a publisher's cover, as the message card
 * (useArtifactCardPicture), else a Markdown version's excerpt in the same frame
 * (ArtifactCardExcerpt), else the kind's glyph on `fill-muted`, half as big
 * again, so every tile in a row is as tall. A screenshot still loading, or one that
 * can't be read, reads as none: no spinner, no error.
 */
function TileCover({ card }: { card: ArtifactCard }) {
  const [picture, pictureRef] = useArtifactCardPicture(card);
  return (
    <MessageEmbedContent ref={pictureRef}>
      {picture?.src ? (
        <img src={picture.src} alt="" loading="lazy" className="block aspect-[16/10] w-full border-b border-line-hairline object-cover object-top" data-testid="artifacts-tile-cover" data-cover={picture.screenshot ? "screenshot" : "publisher"} />
      ) : picture?.excerpt ? (
        <ArtifactCardExcerpt text={picture.excerpt} blocks={picture.excerptBlocks} fit="frame" testId="artifacts-tile-excerpt" />
      ) : (
        <div className="flex aspect-[16/10] w-full items-center justify-center border-b border-line-hairline bg-fill-muted" data-testid="artifacts-tile-placeholder">
          <span className="scale-150" aria-hidden><KindGlyph card={card} /></span>
        </div>
      )}
    </MessageEmbedContent>
  );
}

/**
 * The scope icon's touch target on a tile (#proj-workspace:#187). On a touch
 * screen raft-ui's Badge reaches 44px, centred on its 22px chip: 11px below
 * it, across the footer's 6px gap and into the time line, so a tap on the
 * time line's end opened who can see it instead of the Artifact. Still 44px
 * tall, it hangs upward instead, as a TableSortButton's does over its header
 * (DS Spacing, Hit targets; Alignment: let a taller hit area hang into the
 * padding): 16px up, the header's and the footer's padding (py-2 each) above
 * the author line, and 6px down, the footer's gap-1.5, ending where the time
 * line begins. Sideways as Badge has it. The same variants as Badge's
 * anchored ::after, whose top and bottom these replace.
 * TODO(raft-ui): a Badge hit area that hangs one way, for dense rows.
 */
const TILE_SCOPE_HIT_CLASS = "supports-[anchor-scope:all]:pointer-coarse:enabled:after:top-[calc(anchor(top)-16px)] supports-[anchor-scope:all]:pointer-coarse:enabled:after:bottom-[calc(anchor(bottom)-6px)]";

/**
 * One Artifact in the home page's grid (#proj-workspace:#133, design g1, c1):
 * the message card's frame (MessageEmbed `interactive`), the cover, the title
 * and version, the one pink sticker for what is new; then who made it, the
 * plain "💬 N" and who can see it as an icon (its popover says who, its name
 * where it lives); then only when the reader last opened it, else when it was
 * updated (#proj-workspace:#177, xxchan: the place and the time crammed into
 * one line were both cut short). The title is shown without an old `.md` or
 * `.html` (artifactShownTitle). The title is the link and its ::after covers
 * the tile, so the whole tile opens it and the scope chip stays a control of
 * its own. No "💬 0": a card without comments says none, as the message card.
 * A phone's tile says the time alone, short (Kirby: "9d ago", "9 天前"): which
 * time it is goes unmarked there, as on a phone's row.
 */
export function ArtifactTile({ item, readerId, onOpen, phone }: {
  item: ArtifactDashboardItem;
  readerId: string | null;
  onOpen: (card: ArtifactCard, from: HTMLElement) => void;
  phone: boolean;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { card, news, openedAt } = item;
  const url = artifactUrl(card.id, null);
  const target = useMemo(() => ({ id: card.id, version: null }), [card.id]);
  const intent = useArtifactOpenIntent(target, card);
  const open = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    // Cmd/Ctrl and middle clicks keep the link's own new tab.
    if (!isPlainPrimaryClick(event)) return;
    event.preventDefault();
    onOpen(card, event.currentTarget);
  }, [card, onOpen]);
  const time = phone
    ? formatShortRelativeTime(openedAt ?? card.updatedAt, intl.locale)
    : formatMessage({ id: openedAt ? "artifacts.dashboard.tile.opened" : "artifacts.dashboard.tile.updated" }, { time: formatRelativeTime(openedAt ?? card.updatedAt, intl.locale) });
  return (
    <MessageEmbed interactive className="relative flex h-full min-w-0 flex-col" data-testid="artifacts-dashboard-row" data-view="tile" data-artifact-id={card.id}>
      <TileCover card={card} />
      <MessageEmbedHeader className="grid min-w-0 gap-1.5">
        <div className="flex min-w-0 items-start gap-1.5">
          <a
            href={url}
            onClick={open}
            {...intent}
            data-artifact-open=""
            data-artifact-title=""
            data-testid="artifacts-tile-title"
            className="line-clamp-2 min-w-0 text-subhead break-words font-bold text-foreground no-underline outline-none after:absolute after:inset-0 after:rounded-container focus-visible:after:shadow-focus"
          >
            {artifactShownTitle(card.title)}
          </a>
          <span className="shrink-0 pt-px"><ArtifactVersionBadge version={card.version} /></span>
        </div>
        {hasNews(news) ? <span className="flex min-w-0"><ArtifactNewSticker news={news} twoLines /></span> : null}
      </MessageEmbedHeader>
      {/* Wide, the author shares its line with the comments and who can see it, and the time has its own. A phone tile is
          about 150px inside (390px: two columns, 16px margins, an 8px gap, 12px padding), so there the author has the line
          to itself, the most telling thing on it, and the comments and who can see it end the time's line, which its short
          form fits. The time is never cut, nor broken inside a word: should a locale's form not fit, it wraps at a space, and
          is never narrower than its longest word, so where that leaves the two no room they take the line under it, at its end. */}
      <MessageEmbedFooter className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
        <ArtifactAuthor actor={card.author} readerId={readerId} className="flex-1 max-md:basis-full" />
        <div className="ms-auto flex items-center gap-2 max-md:order-last max-md:self-end" data-testid="artifacts-tile-meta">
          {card.commentCount > 0 ? (
            <MessageAttachmentSummary
              render={<MessageAttachmentCommentSummary />}
              className="mt-0 shrink-0 pr-0"
              aria-label={formatMessage({ id: "artifacts.card.comments" }, { count: card.commentCount })}
              data-testid="artifacts-comment-count"
            >
              <CommentIcon aria-hidden />
              {card.commentCount}
            </MessageAttachmentSummary>
          ) : null}
          <ArtifactScopeLabel home={card.home} fromAnotherServer={card.fromAnotherServer} onCard iconOnly className={TILE_SCOPE_HIT_CLASS} />
        </div>
        <p className="min-w-0 basis-full break-words font-mono text-mono-meta text-foreground-hint max-md:flex-[1_1_min-content] max-md:break-normal" data-testid="artifacts-tile-time">{time}</p>
      </MessageEmbedFooter>
    </MessageEmbed>
  );
}
