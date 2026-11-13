import { useCallback } from "react";
import type { ReactNode } from "react";

/**
 * One app filter above the events list — Raft Design System › Select `rf-filter`:
 * 32 tall with a seam outline at rest; the applied filter is cyan-soft without
 * an outline, its label a 32px control's (`text-control`). raft-ui has no
 * filter-chip primitive, so this is hand-rolled.
 */
export function AppEventFilterButton({
  clientId,
  active,
  onSelect,
  children,
}: {
  clientId: string | null;
  active: boolean;
  onSelect: (clientId: string | null) => void;
  children: ReactNode;
}) {
  const handleClick = useCallback(() => onSelect(clientId), [onSelect, clientId]);
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={handleClick}
      className={`inline-flex h-8 max-w-full items-center gap-1.5 rounded-control px-2.5 text-control font-semibold outline-none focus-visible:shadow-focus ${active ? "bg-info-soft text-foreground hover:overlay-medium" : "text-foreground-muted ring-1 ring-inset ring-line-seam hover:bg-fill-medium"}`}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}
