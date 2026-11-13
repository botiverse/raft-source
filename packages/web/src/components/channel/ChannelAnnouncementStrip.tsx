import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { EllipsisVertical, Link, Megaphone, Settings } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  PanelAction,
  Status,
} from "@botiverse/raft-ui";
import type { ChannelAnnouncementForPerson } from "@botiverse/raft-shared";

import { artifactUrl, openChannelAnnouncement, useArtifactOpenBeside } from "../../apps/artifacts";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { useAnnouncementAuthor } from "./channelAnnouncementParts";
import { formatShortRelativeTime } from "../../utils/relativeTime";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";
import { showToast } from "../toastBridge";

/**
 * A channel's announcement (#proj-chat:#29, flag channel_announcement_v0;
 * raft-design products/raft-chat/channel.md "The announcement"): a strip
 * under the channel header, right above the timeline, on paper with one seam
 * under it, never a notice's tone. One line at every width, a phone's
 * included (Kirby and tygg, 2026-11-10): the title and one sentence, each cut
 * with an ellipsis where it doesn't fit, the title at most 55%. On a phone
 * the updater's avatar and the time go (Kirby), so the title and more of the
 * sentence fit; both are in the viewer once it's open.
 *
 * - Updated (the person hasn't seen the current version): the title bold, the
 *   attention dot, and who updated it (with the version's note when it has
 *   one), with the time since.
 * - Seen: the title regular, the first line of the announcement, its date.
 * - The whole row opens it in the channel's Artifact column (the title's link
 *   stretched over the row, `after:inset-0`); ⋯ is a button of its own above
 *   it, never inside the link (Jasper's accessibility rule via Kirby). While
 *   the column shows it, the row keeps `fill-subtle`.
 * - ⋯: Copy link; for who may change it, Announcement settings. It can't be
 *   hidden: it shows whenever the channel has one ("a pin is a pin", tygg).
 */
export function ChannelAnnouncementStrip({ channelId, announcement, onOpenSettings }: {
  channelId: string;
  announcement: ChannelAnnouncementForPerson;
  /** Opens channel details at the Announcement row; only for people who may change it. */
  onOpenSettings?: () => void;
}) {
  const { formatMessage, locale } = useIntl();
  const { formatCompactDate, formatMediumDateTime } = useTimeFormatter();
  const author = useAnnouncementAuthor(announcement.updatedBy);
  const open = useArtifactOpenBeside(channelId, announcement.artifactId);
  const href = artifactUrl(announcement.artifactId);

  const handleOpen = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    // Cmd/Ctrl, Shift and middle clicks are the browser's own: the Artifact's page in a new tab or window.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (openChannelAnnouncement(announcement.artifactId, event.currentTarget, channelId)) event.preventDefault();
  }, [announcement.artifactId, channelId]);

  const handleCopyLink = useCallback(() => {
    void navigator.clipboard?.writeText(href).then(
      () => showToast({ title: formatMessage({ id: "channel.announcement.strip.linkCopied" }), type: "success" }),
      () => {},
    );
  }, [formatMessage, href]);

  const unread = !announcement.seen;
  const name = author.name ?? formatMessage({ id: "channel.announcement.someone" });
  const line = unread
    ? (announcement.note
      ? formatMessage({ id: "channel.announcement.strip.updatedWithNote" }, { name, note: announcement.note })
      : formatMessage({ id: "channel.announcement.strip.updated" }, { name }))
    : announcement.excerpt || formatMessage({ id: "channel.announcement.strip.updatedBy" }, { name });
  const time = unread ? formatShortRelativeTime(announcement.updatedAt, locale) : formatCompactDate(announcement.updatedAt);
  const optionsLabel = formatMessage({ id: "channel.announcement.strip.options" });

  return (
    <div
      className="relative shrink-0 border-b border-line-seam bg-layer-canvas"
      data-testid="channel-announcement-strip"
      data-state={unread ? "unread" : "read"}
      data-open={open || undefined}
    >
      <div
        className={[
          "group relative flex h-10 items-center gap-2.5 ps-4 pe-2 md:ps-5 md:pe-3",
          open ? "bg-fill-subtle" : "hover:bg-fill-subtle",
        ].join(" ")}
      >
        <Megaphone aria-hidden="true" className="size-4 shrink-0 text-foreground-muted" />
        <div className="flex min-w-0 flex-1 items-baseline gap-2" data-testid="channel-announcement-strip-text">
          <a
            href={href}
            onClick={handleOpen}
            className={[
              "min-w-0 truncate text-callout text-foreground no-underline outline-none",
              "max-w-[55%] shrink-0",
              unread ? "font-bold" : "font-normal",
              // Stretched over the whole row: the row opens it; ⋯ sits above (z-raised).
              "after:absolute after:inset-0 focus-visible:after:inset-ring-2 focus-visible:after:inset-ring-ink",
            ].join(" ")}
            aria-label={formatMessage({ id: "channel.announcement.strip.linkName" }, { title: announcement.title })}
            data-testid="channel-announcement-strip-link"
          >
            {announcement.title}
          </a>
          <span className="flex min-w-0 items-center gap-1.5 text-footnote text-foreground-muted">
            {unread ? (
              // Not on a phone: the title and the sentence get its room (Kirby).
              <span className="flex shrink-0 max-md:hidden" data-testid="channel-announcement-strip-avatar">
                {announcement.updatedBy.type === "agent"
                  ? <AvatarSlot context="preview-mini" type="agent" agentAvatarUrl={author.avatarUrl} />
                  : <AvatarSlot context="preview-mini" type="human" humanAvatarUrl={author.avatarUrl} />}
              </span>
            ) : null}
            <span className="min-w-0 truncate" data-testid="channel-announcement-strip-line">{line}</span>
          </span>
        </div>
        {unread ? (
          <Status
            variant="accent"
            role="img"
            aria-label={formatMessage({ id: "channel.announcement.strip.newDot" })}
            className="shrink-0"
            data-testid="channel-announcement-strip-dot"
          />
        ) : null}
        {time ? (
          <time
            dateTime={announcement.updatedAt}
            title={formatMediumDateTime(announcement.updatedAt)}
            className="shrink-0 font-mono text-mono-meta text-foreground-hint max-md:hidden"
            data-testid="channel-announcement-strip-time"
          >
            {time}
          </time>
        ) : null}
        <DropdownMenu>
          <Tooltip content={optionsLabel}>
            <DropdownMenuTrigger
              render={(
                <PanelAction aria-label={optionsLabel} className="relative z-raised shrink-0" data-testid="channel-announcement-strip-options">
                  <EllipsisVertical />
                </PanelAction>
              )}
            />
          </Tooltip>
          <DropdownMenuContent side="bottom" align="end" sideOffset={4} aria-label={optionsLabel} data-testid="channel-announcement-strip-menu">
            <DropdownMenuItem onClick={handleCopyLink} data-testid="channel-announcement-strip-copy-link">
              <Link />
              {formatMessage({ id: "channel.announcement.strip.copyLink" })}
            </DropdownMenuItem>
            {onOpenSettings ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onOpenSettings} data-testid="channel-announcement-strip-settings">
                  <Settings />
                  {formatMessage({ id: "channel.announcement.strip.settings" })}
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
