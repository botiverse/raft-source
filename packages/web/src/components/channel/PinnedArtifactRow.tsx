import { useCallback, useState } from "react";
import type { MouseEvent, RefObject } from "react";
import { useIntl } from "react-intl";
import { ChevronRight, Ellipsis, PinOff, Replace } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  ListRow,
  ListRowBody,
  ListRowChevron,
  ListRowIcon,
  ListRowSubtitle,
  ListRowTitle,
} from "@botiverse/raft-ui";
import type { ChannelAnnouncementForPerson } from "@botiverse/raft-shared";

import { artifactKindIcon, artifactUrl, openChannelAnnouncement, useChannelAnnouncementKind } from "../../apps/artifacts";
import { formatShortRelativeTime } from "../../utils/relativeTime";
import Tooltip from "../ui/Tooltip";
import { useAnnouncementAuthor } from "./channelAnnouncementParts";

/** For who may change the pinned content: ⋯ with Replace pin and Unpin; the dialogs give focus back to ⋯. */
export type PinnedArtifactActions = { onReplace: () => void; onRemove: () => void; triggerRef: RefObject<HTMLButtonElement | null> };

const NO_ACTIONS: Partial<PinnedArtifactActions> = {};

/**
 * The channel's pinned Artifact as one row of channel details › Pinned content (cindyz, #proj-chat:#35), the
 * Members row's pattern: its kind's icon (16px: Markdown, HTML, ... as the app draws them), the title on one line,
 * "Updated by X · 2h" under it, and the chevron. The title's link covers the row, so the whole row opens the
 * Artifact beside the channel. For who may change it, ⋯ (Replace pin, Unpin) sits before the chevron, a sibling of
 * the link above it, never inside it; the row keeps its hover fill while the menu is open (ListRow draws
 * `data-popup-open` as hover).
 */
export function PinnedArtifactRow({ channelId, announcement, onOpened, actions }: {
  channelId: string;
  announcement: ChannelAnnouncementForPerson;
  /** After the row opened the Artifact beside the channel. */
  onOpened?: () => void;
  actions?: PinnedArtifactActions;
}) {
  const { formatMessage, locale } = useIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const { onReplace, onRemove, triggerRef } = actions ?? NO_ACTIONS;
  const author = useAnnouncementAuthor(announcement.updatedBy);
  // The payload doesn't say the kind: a document's icon until it is read.
  const kind = useChannelAnnouncementKind(announcement.artifactId) ?? "markdown";
  const handleOpen = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (openChannelAnnouncement(announcement.artifactId, event.currentTarget, channelId)) {
      event.preventDefault();
      onOpened?.();
    }
  }, [announcement.artifactId, channelId, onOpened]);
  // Only the name gives way on a narrow row: the time after it stays whole, so a long name can't hide when it
  // was updated.
  const meta = formatMessage({ id: "channel.announcement.details.meta" }, {
    name: (
      <span key="name" className="min-w-0 truncate" data-testid="channel-settings-announcement-meta-name">
        {author.name ?? formatMessage({ id: "channel.announcement.someone" })}
      </span>
    ),
    time: (
      <span key="time" className="shrink-0" data-testid="channel-settings-announcement-meta-time">
        {formatShortRelativeTime(announcement.updatedAt, locale) ?? ""}
      </span>
    ),
  });
  const actionsLabel = formatMessage({ id: "channel.announcement.details.actions" });

  return (
    <ListRow
      variant="plain"
      render={<div />}
      data-popup-open={menuOpen ? "" : undefined}
      data-kind={kind}
      data-testid="channel-settings-announcement-item"
    >
      <ListRowIcon className="[&>svg]:size-4" data-testid="channel-settings-announcement-icon">{artifactKindIcon(kind)}</ListRowIcon>
      <ListRowBody>
        <ListRowTitle>
          <a
            href={artifactUrl(announcement.artifactId)}
            onClick={handleOpen}
            className="text-inherit no-underline outline-none after:absolute after:inset-0 focus-visible:keyboard:after:inset-ring-2 focus-visible:keyboard:after:inset-ring-foreground"
            data-testid="channel-settings-announcement-link"
          >
            {announcement.title}
          </a>
        </ListRowTitle>
        <ListRowSubtitle className="flex whitespace-pre text-(--list-row-ink-2)" data-testid="channel-settings-announcement-meta">{meta}</ListRowSubtitle>
      </ListRowBody>
      {actions ? (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <Tooltip content={actionsLabel}>
            <DropdownMenuTrigger
              render={(
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  ref={triggerRef}
                  aria-label={actionsLabel}
                  className="relative z-raised -me-1 shrink-0"
                  data-testid="channel-settings-announcement-actions"
                />
              )}
            >
              <Ellipsis aria-hidden="true" />
            </DropdownMenuTrigger>
          </Tooltip>
          <DropdownMenuContent side="bottom" align="end" sideOffset={4} aria-label={actionsLabel} data-testid="channel-settings-announcement-menu">
            <DropdownMenuItem onClick={onReplace} data-testid="channel-settings-announcement-replace">
              <Replace />
              {formatMessage({ id: "channel.announcement.details.replace" })}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onRemove} data-testid="channel-settings-announcement-remove">
              <PinOff />
              {formatMessage({ id: "channel.announcement.details.remove" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      <ListRowChevron><ChevronRight aria-hidden="true" /></ListRowChevron>
    </ListRow>
  );
}

/** Nothing pinned, for who may pin: the same box with one row, "Nothing pinned" (muted) and Pin an Artifact (the picker). */
export function PinnedEmptyRow({ onPin }: { onPin: () => void }) {
  const { formatMessage } = useIntl();
  return (
    <ListRow variant="plain" interactive={false} data-testid="channel-settings-announcement-empty">
      <ListRowBody>
        <ListRowTitle className="text-foreground-muted">{formatMessage({ id: "channel.announcement.details.emptyTitle" })}</ListRowTitle>
      </ListRowBody>
      <Button type="button" size="md" variant="outline" className="shrink-0" onClick={onPin} data-testid="channel-settings-announcement-set">
        {formatMessage({ id: "channel.announcement.details.set" })}
      </Button>
    </ListRow>
  );
}
