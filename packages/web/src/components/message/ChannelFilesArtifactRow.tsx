import { useCallback, useMemo } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { Clock } from "lucide-react";
import { Button, FileContent, FileMeta, FileMetaItem, FileName, FileRow, FileRowOpen, FileThumbnail } from "@botiverse/raft-ui";
import type { ArtifactCard } from "@botiverse/raft-shared";
import type { ConversationArtifactsView } from "../../apps/artifacts";
import { ContentLoading } from "../ui/ContentLoading";

import { artifactKindIcon, openConversationArtifact, useArtifactOpenIntent } from "../../apps/artifacts";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import {
  COMPACT_ROW_BUTTON,
  COMPACT_ROW_MONO,
  COMPACT_ROW_TITLE,
  COMPACT_ROW_TITLE_GROUP,
  COMPACT_ROW_TRAILING,
} from "../task/compactRow";
import AttachmentTooltip from "./attachmentTooltip";

/**
 * One of the conversation's Artifacts among its files: the kind's icon, the
 * title, the version and when it was last updated. The whole row opens the
 * viewer. `compact`: the Files card's row (raft-design patterns/tasks.md,
 * "Rows in a compact list"), as a file's; else the legacy tab's FileRow card
 * (raft-ui files.md), as the file rows beside it.
 */
export function ConversationArtifactRow({ card, conversationId, compact }: { card: ArtifactCard; conversationId: string; compact: boolean }) {
  const { formatMessage } = useIntl();
  const { formatCompactDate, formatShortDateTime, formatMediumDateTime } = useTimeFormatter();
  const open = useCallback((event: MouseEvent<HTMLElement>) => {
    openConversationArtifact(card, event.currentTarget, conversationId, { sideCard: compact });
  }, [card, conversationId, compact]);
  // The row opens the latest version.
  const target = useMemo(() => ({ id: card.id, version: null }), [card.id]);
  const intent = useArtifactOpenIntent(target, card);
  const version = formatMessage({ id: "artifacts.card.version" }, { version: card.latestVersion });
  // Read as "Artifact <title>, v<n>": the row says what it is among the files; the visible parts aren't read twice.
  const name = <span className="sr-only">{formatMessage({ id: "artifacts.filesTab.rowName" }, { title: card.title, version: card.latestVersion })}</span>;

  if (compact) {
    return (
      <button type="button" onClick={open} {...intent} className={COMPACT_ROW_BUTTON} data-testid="conversation-artifact-row" data-artifact-id={card.id}>
        <span data-row-mark className="flex size-5 shrink-0 items-center justify-center text-foreground-hint [&>svg]:size-4" aria-hidden="true">
          {artifactKindIcon(card.kind)}
        </span>
        <span className={COMPACT_ROW_TITLE_GROUP}>
          {name}
          {/* The full title on hover, as a file's name. */}
          <AttachmentTooltip content={card.title}>
            <span aria-hidden="true" className={`relative z-raised ${COMPACT_ROW_TITLE}`} data-testid="conversation-artifact-title">{card.title}</span>
          </AttachmentTooltip>
          <span aria-hidden="true" className={COMPACT_ROW_MONO} data-testid="conversation-artifact-version">{version}</span>
        </span>
        <span className={COMPACT_ROW_TRAILING}>
          <time dateTime={card.updatedAt} title={formatMediumDateTime(card.updatedAt)} className={COMPACT_ROW_MONO} data-testid="conversation-artifact-time">
            {formatCompactDate(card.updatedAt)}
          </time>
          {/* The file rows' action slot (their ⋯, ChannelFilesPanelFileRow), kept empty: the time stands where
              theirs does and the trailing group wraps where theirs does, so a narrow or clipped Files column
              never cuts this row's time before theirs. */}
          <span data-row-mark aria-hidden="true" className="-mr-[9px] w-8 shrink-0 self-center" data-testid="conversation-artifact-action-slot" />
        </span>
      </button>
    );
  }

  return (
    <FileRow className="channel-file-row">
      <FileRowOpen onClick={open} {...intent} data-testid="conversation-artifact-row" data-artifact-id={card.id}>
        <FileThumbnail aria-hidden="true">{artifactKindIcon(card.kind)}</FileThumbnail>
        <FileContent>
          <FileName>{name}<span aria-hidden="true" data-testid="conversation-artifact-title">{card.title}</span></FileName>
          <FileMeta>
            <FileMetaItem aria-hidden="true" data-testid="conversation-artifact-version">{version}</FileMetaItem>
            <FileMetaItem>
              <Clock size={12} aria-hidden="true" />
              <time dateTime={card.updatedAt} title={formatMediumDateTime(card.updatedAt)} data-testid="conversation-artifact-time">{formatShortDateTime(card.updatedAt)}</time>
            </FileMetaItem>
          </FileMeta>
        </FileContent>
      </FileRowOpen>
    </FileRow>
  );
}

/**
 * The conversation's Artifacts at the head of its Files list: loading, an
 * error with Retry, or the rows with Show More while there are more pages.
 * Nothing when hidden (the flag, or Artifacts off for the server).
 */
export function ConversationArtifactsSection({
  view,
  retry,
  showMore,
  conversationId,
  compact,
}: {
  view: ConversationArtifactsView;
  retry: () => void;
  showMore: () => void;
  conversationId: string;
  compact: boolean;
}) {
  const { formatMessage } = useIntl();
  if (view.status === "hidden") return null;
  if (view.status === "loading") {
    return <ContentLoading className="p-3" data-testid="conversation-artifacts-loading">{formatMessage({ id: "artifacts.filesTab.loading" })}</ContentLoading>;
  }
  if (view.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2 p-3 text-callout text-danger-strong" role="alert" data-testid="conversation-artifacts-error">
        <span>{formatMessage({ id: "artifacts.filesTab.loadError" })}</span>
        <Button type="button" size="md" variant="outline" onClick={retry}>{formatMessage({ id: "artifacts.filesTab.retry" })}</Button>
      </div>
    );
  }
  return (
    <>
      {view.cards.map((card) => (
        <ConversationArtifactRow key={card.id} card={card} conversationId={conversationId} compact={compact} />
      ))}
      {view.nextCursor !== null || view.more === "failed" ? (
        <div className="flex flex-wrap items-center justify-center gap-2 p-2" data-testid="conversation-artifacts-more">
          {view.more === "failed" ? <span className="text-callout text-danger-strong" role="alert">{formatMessage({ id: "artifacts.filesTab.loadMoreError" })}</span> : null}
          {view.more === "loading" ? (
            <ContentLoading>{formatMessage({ id: "artifacts.filesTab.loading" })}</ContentLoading>
          ) : (
            <Button type="button" size="md" variant="outline" onClick={showMore}>{formatMessage({ id: "artifacts.filesTab.showMore" })}</Button>
          )}
        </div>
      ) : null}
    </>
  );
}
