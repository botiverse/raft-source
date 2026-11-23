import { useCallback } from "react";
import { Check, FolderInput } from "lucide-react";
import MenuItem from "../ui/MenuItem";
import type { SidebarCustomSection } from "../../store/sidebarSections";

export function MoveToSectionMenuItem({ section, current, onMove }: {
  section: SidebarCustomSection;
  current: boolean;
  onMove: (sectionId: string) => void;
}) {
  const move = useCallback(() => onMove(section.id), [onMove, section.id]);
  return (
    <MenuItem
      icon={<FolderInput size={14} />}
      trailing={current ? <Check size={16} /> : null}
      onClick={move}
    >
      <span className={current ? "flex min-w-0 items-center gap-1 font-bold" : "flex min-w-0 items-center gap-1"}>
        {section.emoji && <span aria-hidden>{section.emoji}</span>}
        <span className="truncate">{section.name}</span>
      </span>
    </MenuItem>
  );
}
