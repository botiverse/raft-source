import type { LucideIcon } from "lucide-react";
import { MSG_REF_CHIP } from "./messageRefChip";

/**
 * Shared in-message reference chip. Both the Slock-permalink inline ref and the
 * attachment comment-ref render through this one structure so they are provably
 * consistent (same box/weight/layout, one height via MSG_REF_CHIP), differing
 * only by icon, color, label, and an optional trailing badge (stdrc directive).
 *
 * The bordered box (MSG_REF_CHIP) carries no cursor on purpose. This component
 * adds `cursor-default` explicitly because in-message refs are the arrow-cursor
 * exception to the app's normal link-hand control contract.
 */
export function ReferenceChip({
  icon: Icon,
  colorClass,
  label,
  trailing,
  as = "span",
  href,
  onClick,
  title,
  "data-message-affordance": dataMessageAffordance,
}: {
  icon: LucideIcon;
  colorClass: string;
  label: React.ReactNode;
  trailing?: React.ReactNode;
  as?: "a" | "span";
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  "data-message-affordance"?: string;
}) {
  const Tag = as;
  const anchorProps = as === "a" ? { href, onClick } : {};

  return (
    <Tag
      {...anchorProps}
      title={title}
      data-message-affordance={dataMessageAffordance}
      className={`${MSG_REF_CHIP} inline-flex max-w-full cursor-default items-center gap-1 ${colorClass}`}
    >
      <Icon size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      {trailing}
    </Tag>
  );
}
