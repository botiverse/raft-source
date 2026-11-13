import { useCallback } from "react";
import { Check } from "lucide-react";

import MenuItem from "./ui/MenuItem";
import type { InlineBadgeOption } from "./InlineBadgeEditor";

export function InlineBadgeMenuItem({
  option,
  selected,
  onSelect,
  testId,
}: {
  option: InlineBadgeOption;
  selected: boolean;
  onSelect: (id: string) => Promise<void> | void;
  testId?: string;
}) {
  const handleClick = useCallback(async () => {
    await onSelect(option.id);
  }, [onSelect, option.id]);

  // Raft Design System › Menu: the current value is a trailing ink check plus
  // bold; the check keeps its slot when hidden so labels do not shift.
  return (
    <MenuItem
      role="button"
      onClick={handleClick}
      data-testid={testId}
      data-current={selected || undefined}
      icon={option.avatar}
      trailing={<Check size={16} aria-hidden="true" className={`shrink-0 text-foreground ${selected ? "opacity-100" : "opacity-0"}`} />}
    >
      <span className={selected ? "font-bold" : undefined}>{option.label}</span>
    </MenuItem>
  );
}
