import { useCallback, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger, TextLink } from "@botiverse/raft-ui";
import { useAppNavigate } from "../../../hooks/useAppNavigate";
import type { Agent } from "../../../store/agentStore";
import { useServerStore } from "../../../store/serverStore";
import ProfilePreviewCardContent from "../../message/DeferredProfilePreviewCardContent";

/**
 * An agent's or a person's name in the migration log, linked to their profile
 * the way a mention is (MentionLink): hovering or focusing it opens the same
 * profile preview card, with the same delays; clicking it, or tapping it on a
 * phone (where a preview card doesn't open), opens the profile. The card is
 * read-only, so the link is what reaches everything on it (PreviewCard ›
 * Accessibility). It sits inside rows that react to a click themselves, so
 * its click never reaches the row.
 */
export function ProfileNameLink({ kind, id, fallbackAgent, fallbackLabel, children }: {
  kind: "agent" | "user";
  id: string;
  fallbackAgent?: Agent | null;
  /** The name to show on the card when the person or agent isn't in the local store. */
  fallbackLabel?: string;
  children: ReactNode;
}) {
  const navigate = useAppNavigate();
  const slug = useServerStore((s) => s.current?.slug);
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const href = `${slug ? `/s/${encodeURIComponent(slug)}` : ""}/${kind === "agent" ? "agent" : "human"}/${encodeURIComponent(id)}`;
  const onClick = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    // A new tab or window (Cmd, Ctrl, Shift, the middle button) is the browser's.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    // Close the card before moving, or it stays over the destination.
    previewActionsRef.current?.close();
    if (kind === "agent") navigate.toAgent(id); else navigate.toHuman(id);
  }, [id, kind, navigate]);
  return (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={<TextLink variant="strong" render={<a href={href}>{children}</a>} />}
        onClick={onClick}
        data-testid={`migration-log-${kind}-link-${id}`}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent sideOffset={6} collisionPadding={6}>
        <ProfilePreviewCardContent mentionType={kind} mentionId={id} fallbackAgent={fallbackAgent} fallbackLabel={fallbackLabel} />
      </PreviewCardContent>
    </PreviewCard>
  );
}
