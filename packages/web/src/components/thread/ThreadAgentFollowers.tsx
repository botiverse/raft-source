import { Button, Popover, PopoverContent, PopoverTrigger, ScrollArea, toast } from "@botiverse/raft-ui";
import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { getSocket } from "../../api/socket";
import {
  requestThreadAgentFollowers,
  useThreadAgentFollowerStore,
} from "../../store/threadAgentFollowerStore";
import { useServerStore } from "../../store/serverStore";
import { FaceStack } from "../layout/FaceStack";
import AvatarSlot from "../ui/AvatarSlot";
import Tooltip from "../ui/Tooltip";
import { ThreadAgentFollowerRow } from "./ThreadAgentFollowerRow";

function stopEventPropagation(event: { stopPropagation: () => void }) {
  event.stopPropagation();
}

export default function ThreadAgentFollowers({
  threadChannelId,
  variant,
  subject = "thread",
  folded,
  onOpenProfile,
}: {
  threadChannelId: string;
  variant: "card" | "header";
  /**
   * The head too narrow for its button (#189 rule 6): no button; ⋯'s Following Agents opens the list (`open`), shown
   * under `anchor` (the head).
   */
  folded?: { open: boolean; onOpenChange: (open: boolean) => void; anchor: HTMLElement | null };
  /** "task": a task's own conversation (the task dialog) — the removal
   *  notice names the task, not a thread. */
  subject?: "thread" | "task";
  /** The task dialog: a follower's profile opens beside its conversation
   *  (the app's profile panel is behind the dialog). */
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
}) {
  const { formatMessage } = useIntl();
  const roster = useThreadAgentFollowerStore((state) => state.rosters[threadChannelId]);
  const load = useThreadAgentFollowerStore((state) => state.load);
  const remove = useThreadAgentFollowerStore((state) => state.remove);
  const restore = useThreadAgentFollowerStore((state) => state.restore);
  const currentServerId = useServerStore((state) => state.current?.id);
  const [open, setOpen] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const openFollowerProfile = useCallback((agentId: string) => {
    if (folded) folded.onOpenChange(false);
    else setOpen(false);
    onOpenProfile?.("agent", agentId);
  }, [folded, onOpenProfile]);

  useEffect(() => {
    requestThreadAgentFollowers(threadChannelId);
  }, [threadChannelId]);

  useEffect(() => {
    const socket = getSocket();
    const handleMessageNew = (message: { channelId?: string } | null | undefined) => {
      if (message?.channelId !== threadChannelId) return;
      requestThreadAgentFollowers(threadChannelId, true);
    };
    socket.on("message:new", handleMessageNew);
    return () => {
      socket.off("message:new", handleMessageNew);
    };
  }, [threadChannelId]);

  const agents = roster?.agents ?? [];
  const label = roster?.error
    ? formatMessage({ id: "thread.followers.loadFailed" })
    : formatMessage({ id: "thread.followers.label" }, { count: agents.length });

  const handleRemove = useCallback(async (agentId: string, agentLabel: string) => {
    setRemovingId(agentId);
    try {
      const undoToken = await remove(threadChannelId, agentId);
      if (!undoToken) return;
      const removedToastId = toast.success(
        formatMessage({ id: subject === "task" ? "task.followers.removed" : "thread.followers.removed" }, { agent: agentLabel }),
        {
          dismissible: false,
          contentClassName: "thread-follower-removal-toast",
          action: {
            label: formatMessage({ id: "thread.followers.undo" }),
            onClick: () => {
              // Undo answers the notice: it goes, and "Restored …" replaces it
              // rather than stacking beside it.
              toast.dismiss(removedToastId);
              void restore(threadChannelId, agentId, undoToken).then((restored) => {
                if (restored) toast.success(formatMessage({ id: "thread.followers.restored" }, { agent: agentLabel }));
              });
            },
          },
        },
      );
    } catch {
      toast.error(formatMessage({ id: "thread.followers.removeFailed" }));
    } finally {
      setRemovingId(null);
    }
  }, [formatMessage, remove, restore, subject, threadChannelId]);

  const retryLoad = useCallback(() => {
    void load([threadChannelId], true);
  }, [load, threadChannelId]);

  // Do not show a zero-count affordance. While the count is unknown there is
  // nothing actionable yet; a failed load still exposes Retry via an error-only
  // trigger rather than presenting the failure as "0 followers".
  if (!roster || roster.loading && !roster.loaded) return null;
  if (roster.loaded && agents.length === 0) return null;

  return (
    <Popover open={folded ? folded.open : open} onOpenChange={folded ? folded.onOpenChange : setOpen}>
      {folded ? null : (
      <Tooltip content={label}>
      <PopoverTrigger
        render={(
          <Button
            type="button"
            onClick={stopEventPropagation}
            onPointerDown={stopEventPropagation}
            size={variant === "header" ? "md" : undefined}
            variant="ghost"
            className={variant === "header"
              // In a head, with a mouse, the box of the bar buttons beside it (28 at r6), not a 34px Button.
              ? "gap-1.5 px-1.5 md:pointer-fine:h-(--bar-button-size) md:pointer-fine:rounded-(--bar-button-radius)"
              : "h-[22px] gap-1 rounded-chip bg-fill-muted px-1.5 text-foreground-muted md:pointer-fine:h-5 md:pointer-fine:rounded-sticker"}
            aria-label={label}
            data-testid={`thread-followers-${variant}-trigger`}
          >
            {/* The shared stack (raft-ui AvatarGroup as a span, inside the button): 19px faces in the header, 14px on
                the chip, 5px over each other at both sizes; still: a follower's face has no entrance. */}
            {roster.error ? (
              <TriangleAlert size={variant === "header" ? 14 : 12} aria-hidden="true" />
            ) : (
              <FaceStack still testId={`thread-followers-${variant}-faces`}>
                {agents.slice(0, 3).map((agent) => (
                  <AvatarSlot key={agent.id} context={variant === "header" ? "sidebar-list" : "preview-mini"} type="agent" agentAvatarUrl={agent.avatarUrl} />
                ))}
              </FaceStack>
            )}
            {roster.error ? null : <span className="font-mono text-mono-meta">{agents.length}</span>}
          </Button>
        )}
      />
      </Tooltip>
      )}
      <PopoverContent
        anchor={folded?.anchor ?? undefined}
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-72 p-0"
        data-testid="thread-followers-popover"
      >
        <div className="flex min-h-11 items-center border-b border-line-seam px-4 text-headline">
          {formatMessage({ id: "thread.followers.title" })}
        </div>
        <ScrollArea tabIndex={-1} className="max-h-72" contentClassName="p-2">
          {roster?.loading && !roster.loaded ? (
            <div className="px-2 py-4 text-center text-callout text-foreground-hint" data-testid="thread-followers-loading">
              {formatMessage({ id: "thread.followers.loading" })}
            </div>
          ) : roster?.error ? (
            <div className="flex flex-col items-center gap-2 px-2 py-4 text-center text-callout text-foreground-muted" data-testid="thread-followers-error">
              <TriangleAlert size={18} />
              {formatMessage({ id: "thread.followers.loadFailed" })}
              <Button variant="outline" size="md" type="button" onClick={retryLoad}>
                {formatMessage({ id: "thread.followers.retry" })}
              </Button>
            </div>
          ) : agents.length === 0 ? (
            <div className="px-2 py-4 text-center text-callout text-foreground-hint" data-testid="thread-followers-empty">
              {formatMessage({ id: "thread.followers.empty" })}
            </div>
          ) : agents.map((agent) => (
            <ThreadAgentFollowerRow
              key={agent.id}
              agent={agent}
              canManage={roster?.canManage}
              removing={removingId === agent.id}
              currentServerId={currentServerId}
              onRemove={handleRemove}
              onOpenProfile={onOpenProfile ? openFollowerProfile : undefined}
            />
          ))}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
