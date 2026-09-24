import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

type SystemMessageGroupDisclosureProps = {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
};

export default function SystemMessageGroupDisclosure({
  summary,
  expanded,
  onToggle,
  children,
}: SystemMessageGroupDisclosureProps) {
  return (
    <div className="mb-1">
      <div className="flex justify-center py-1.5">
        <button
          type="button"
          className="group flex max-w-full items-center gap-1.5 px-2 py-1 text-xs text-black/50 hover:text-black/75"
          onClick={onToggle}
          aria-expanded={expanded}
          title={summary}
          data-testid="system-message-group-toggle"
        >
          <span className="truncate">{summary}</span>
          <ChevronRight
            aria-hidden
            className={`size-3 shrink-0 text-black/35 transition-transform ${expanded ? "-rotate-90" : "rotate-90"}`}
          />
        </button>
      </div>
      {expanded && (
        <div data-testid="system-message-group-details">
          {children}
        </div>
      )}
    </div>
  );
}
