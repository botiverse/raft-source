import { FilterChip, FilterChipLabel, FilterChipRemove } from "@botiverse/raft-ui/wip";
import type { ActivityFilterChoice } from "../../store/activityFilterPreference";
import { ACTIVITY_FILTER_ICON } from "./activityFilterMenu";

/**
 * The filter in effect, beside the Filter button, with an × back to All:
 * raft-ui's FilterChip (info-soft, as high as the 32px filter button) and its
 * FilterChipRemove, which owns the × hit target.
 */
export function ActiveFilterChip({ choice, label, clearLabel, onClear }: {
  choice: ActivityFilterChoice;
  label: string;
  clearLabel: string;
  onClear: () => void;
}) {
  const Icon = ACTIVITY_FILTER_ICON[choice];
  return (
    <FilterChip data-testid="inbox-filter-chip" data-filter={choice}>
      <Icon aria-hidden />
      <FilterChipLabel>{label}</FilterChipLabel>
      <FilterChipRemove data-testid="inbox-filter-clear" aria-label={clearLabel} onClick={onClear} />
    </FilterChip>
  );
}
