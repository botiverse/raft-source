import { Card } from "@botiverse/raft-ui";
import { useCallback } from "react";
import type { BulkResetMode, BulkResetOption } from "../../features/computer/machineDetailTypes";

export function BulkResetOptionCard({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: BulkResetOption;
  selected: boolean;
  disabled: boolean;
  onSelect: (mode: BulkResetMode) => void;
}) {
  const { mode } = option;
  const handleClick = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    // A selectable option inside the dialog (raft-ui Card `option`). The picked
    // one carries its consequence's soft wash; disabled is the DS disabled
    // surface, never a dimmed copy.
    <Card
      variant="option"
      render={<button type="button" aria-pressed={selected} disabled={disabled} />}
      onClick={handleClick}
      className={`w-full p-3 text-left outline-none transition-colors focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-fill-muted disabled:text-foreground-disabled ${
        selected ? option.selectedClass : "hover:overlay-subtle active:overlay-medium"
      }`}
    >
      <div className="text-callout font-semibold">{option.label}</div>
      <p className="mt-0.5 text-footnote text-foreground-muted">{option.desc}</p>
    </Card>
  );
}
