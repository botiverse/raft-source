import { Button } from "@botiverse/raft-ui";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useChannelStore } from "../../store/channelStore";
import Banner from "../ui/Banner";
import type { ArchivedNameCollision } from "./archivedNameCollision";

/**
 * The warning for a channel name an archived channel holds, on create and on
 * rename (#proj-chat:#19). Open Channel goes to the archived channel (read-only, as
 * from Settings › Archived Channels); Unarchive restores it and goes there,
 * offered only to whoever may unarchive it. Both leave the surface first
 * (`onLeave`, the dialog's close).
 */
export function ArchivedNameCollisionBanner({
  collision,
  onLeave,
  onError,
  onChangeName,
  showHint = true,
}: {
  collision: ArchivedNameCollision | null;
  onLeave: () => void;
  /** A failed unarchive, as the dialog's own error. */
  onError: (message: string) => void;
  /** Create clears the name for another; rename leaves it to the field. */
  onChangeName?: () => void;
  showHint?: boolean;
}) {
  const { formatMessage } = useIntl();
  const unarchiveChannel = useChannelStore((s) => s.unarchiveChannel);
  const nav = useAppNavigate();
  const [unarchiving, setUnarchiving] = useState(false);
  const archivedChannelId = collision?.archivedChannelId;

  const handleOpen = useCallback(() => {
    if (!archivedChannelId) return;
    onLeave();
    nav.toChannel(archivedChannelId);
  }, [archivedChannelId, onLeave, nav]);

  const handleUnarchive = useCallback(async () => {
    if (!archivedChannelId) return;
    setUnarchiving(true);
    try {
      const channel = await unarchiveChannel(archivedChannelId);
      onLeave();
      nav.toChannel(channel.id);
    } catch (err: unknown) {
      const axiosErr = err as { response?: { data?: { error?: string } } };
      onError(axiosErr.response?.data?.error || formatMessage({ id: "channel.create.failedUnarchive" }));
    } finally {
      setUnarchiving(false);
    }
  }, [archivedChannelId, unarchiveChannel, onLeave, nav, onError, formatMessage]);

  if (!collision) return null;
  const canUnarchive = collision.canUnarchiveArchivedChannel;
  return (
    <Banner
      intent="warning"
      data-testid="archived-name-collision"
      title={formatMessage(
        { id: "channel.create.archivedNameHeld" },
        {
          name: collision.archivedChannelName,
          // <mono> keeps the mono styling INSIDE the message so translators
          // can move it, rather than splitting the sentence around a span.
          mono: (chunks: ReactNode) => (
            <span key="archived-name" className="font-mono">{chunks}</span>
          ),
        },
      )}
      actions={(
        <>
          {canUnarchive && (
            <Button size="md"
              variant="outline"
              type="button"
              onClick={handleUnarchive}
              disabled={unarchiving}
              data-testid="archived-name-collision-unarchive"
            >
              {unarchiving ? formatMessage({ id: "channel.create.unarchiving" }) : formatMessage({ id: "channel.create.unarchive" })}
            </Button>
          )}
          <Button size="md"
            variant={canUnarchive ? "ghost" : "outline"}
            type="button"
            onClick={handleOpen}
            disabled={unarchiving}
            data-testid="archived-name-collision-open"
          >
            {formatMessage({ id: "channel.create.openArchived" })}
          </Button>
          {onChangeName && (
            <Button size="md"
              variant="ghost"
              type="button"
              onClick={onChangeName}
            >
              {formatMessage({ id: "channel.create.changeName" })}
            </Button>
          )}
        </>
      )}
    >
      {showHint && formatMessage({
        id: canUnarchive ? "channel.create.archivedCanManage" : "channel.create.archivedCannotManage",
      })}
    </Banner>
  );
}
