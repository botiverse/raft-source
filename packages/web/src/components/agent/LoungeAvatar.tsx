import { useAgentStore } from "../../store/agentStore";
import AvatarSlot from "../ui/AvatarSlot";
import type { AvatarContext } from "../ui/AvatarSlot";
import { AgentLoungeIcon } from "./agentLounge";

/**
 * The Lounge mark's box in the avatar's corner, per avatar size. Drawn like
 * the DS corner badge that holds one icon (raft-ui InboxItemLeadingBadge: an
 * ink-edged square on `info-soft`, ringed with the surface), sized so the
 * glyph still reads on the sidebar's 19px face: a status light shrinks to a
 * bare 7px pixel there, a mark has to stay a picture. The corner holds one
 * thing (DS Avatar › The corner): a Lounge's face carries this mark and no
 * presence light.
 */
const LOUNGE_BADGE_CLASS = [
  "items-center justify-center rounded-[3px] border border-sticker-ink",
  "bg-layer-canvas bg-[linear-gradient(var(--info-soft),var(--info-soft))] text-foreground",
  "outline-2 outline-solid outline-layer-canvas",
  "[&_svg]:shrink-0",
  // 99: 24px, glyph 16
  "group-data-[size=xl]/avatar:size-6 group-data-[size=xl]/avatar:-right-1.5 group-data-[size=xl]/avatar:-bottom-1.5 group-data-[size=xl]/avatar:[&_svg]:size-4",
  // 51: 18px, glyph 12
  "group-data-[size=lg]/avatar:size-[18px] group-data-[size=lg]/avatar:right-[-4px] group-data-[size=lg]/avatar:bottom-[-4px] group-data-[size=lg]/avatar:[&_svg]:size-3",
  // 35: 14px, glyph 10 (InboxItemLeadingBadge's own size)
  "group-data-[size=md]/avatar:size-3.5 group-data-[size=md]/avatar:right-[-3px] group-data-[size=md]/avatar:bottom-[-3px] group-data-[size=md]/avatar:[&_svg]:size-2.5",
  // 27: 12px, glyph 8
  "group-data-[size=sm]/avatar:size-3 group-data-[size=sm]/avatar:right-[-3px] group-data-[size=sm]/avatar:bottom-[-3px] group-data-[size=sm]/avatar:[&_svg]:size-2",
  // 19: 11px, glyph 8 (the smallest a Lounge is drawn at: the sidebar)
  "group-data-[size=xs]/avatar:size-[11px] group-data-[size=xs]/avatar:right-[-3px] group-data-[size=xs]/avatar:bottom-[-3px] group-data-[size=xs]/avatar:[&_svg]:size-2",
  "group-data-[size=2xs]/avatar:size-[11px] group-data-[size=2xs]/avatar:right-[-3px] group-data-[size=2xs]/avatar:bottom-[-3px] group-data-[size=2xs]/avatar:[&_svg]:size-2",
  // 14: 9px, glyph 6
  "group-data-[size=3xs]/avatar:size-[9px] group-data-[size=3xs]/avatar:right-[-2px] group-data-[size=3xs]/avatar:bottom-[-2px] group-data-[size=3xs]/avatar:[&_svg]:size-1.5",
].join(" ");

/** The Lounge's glyph inside its corner mark: a heavier stroke, so it holds at 8px. */
function LoungeBadgeGlyph() {
  return (
    <span className="flex items-center justify-center" aria-hidden="true" data-testid="lounge-avatar-badge">
      <AgentLoungeIcon strokeWidth={3} />
    </span>
  );
}

/**
 * Agent Lounge: the Lounge drawn as its agent's face with the Lounge mark in
 * the bottom-right corner (tygg, #proj-chat:30a58e4d), wherever the Lounge
 * itself is shown: its sidebar row, its header, a thread's parent, Activity.
 * The face is decorative: the row or header around it carries the name
 * ("{Name}'s Lounge"), so its accessible name is unchanged.
 */
export function LoungeAvatar({ agentId, context, className }: {
  agentId: string | null | undefined;
  context: AvatarContext;
  className?: string;
}) {
  const avatarUrl = useAgentStore((s) => (agentId ? s.agents.find((agent) => agent.id === agentId)?.avatarUrl ?? null : null));
  // No wrapper: rows place the avatar as their direct child (raft-ui
  // SidebarItem centers `[data-slot=avatar]` on the first line).
  return (
    <AvatarSlot
      context={context}
      type="agent"
      agentAvatarUrl={avatarUrl}
      badge={<LoungeBadgeGlyph />}
      badgeClassName={LOUNGE_BADGE_CLASS}
      className={className}
    />
  );
}
