import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  DropdownMenu,
  SegmentedControl,
  SegmentedControlCount,
  SegmentedControlItem,
  SegmentedControlLabel,
  DropdownMenuContent,
  DropdownMenuItemLabel,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
} from "@botiverse/raft-ui";
import { FitToolbarGroup, FitToolbarMore, FitToolbarMoreItems, FitToolbarPicker, useFitItem } from "@botiverse/raft-ui/wip";
import { LIST_TOOLBAR_STEP } from "./listToolbar";

/** One choice of a list's scope (Mine / All, Installed / Marketplace): its name, its count when known. */
export interface ListScopeOption<T extends string> {
  value: T;
  label: string;
  count?: number | null;
  testId?: string;
  countTestId?: string;
}

/**
 * A segmented control's track is taller than the line's controls (40px with
 * a mouse against 34px, 38px by touch against 32px): it hangs 3px into the
 * line's air at every density, so the line stays 44px with a mouse and 49px
 * by touch, the controls aligned; only the grey track bleeds into the air.
 */
const SEGMENTED_IN_LINE_CLASS = "-my-[3px]";

/**
 * The scope at the start of a list's toolbar (Mine / All, Installed /
 * Marketplace / Developer): a segmented control, each segment with its count
 * (Raft DS › Page structure), giving way to a Select at step 5 once it
 * doesn't fit, by touch and with a mouse alike.
 */
export function ListScope<T extends string>({ value, options, onValueChange, label, testId, selectTestId }: {
  value: T;
  options: readonly ListScopeOption<T>[];
  onValueChange: (value: T) => void;
  /** The scope's accessible name. */
  label: string;
  /** On the segmented control. */
  testId?: string;
  /** On the Select's trigger. */
  selectTestId?: string;
}) {
  return (
    <FitToolbarGroup
      firstLine
      className="gap-2"
      collapseOrder={LIST_TOOLBAR_STEP.scopeSelect}
      collapsed={<ListScopeSelect value={value} options={options} onValueChange={onValueChange} label={label} testId={selectTestId} />}
    >
      <SegmentedControl<T> className={SEGMENTED_IN_LINE_CLASS} value={value} onValueChange={onValueChange} aria-label={label} data-testid={testId}>
        {options.map((option) => (
          <SegmentedControlItem key={option.value} value={option.value} data-testid={option.testId}>
            <SegmentedControlLabel>{option.label}</SegmentedControlLabel>
            {option.count === null || option.count === undefined ? null : <SegmentedControlCount data-testid={option.countTestId}>{option.count}</SegmentedControlCount>}
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
    </FitToolbarGroup>
  );
}

/**
 * The scope once it has given way (Raft DS › The toolbar over a list, step
 * 5): a Select whose trigger shows the current scope's name alone, the
 * counts in its menu. The head already counts the list the scope shows.
 */
export function ListScopeSelect<T extends string>({ value, options, onValueChange, label, testId }: {
  value: T;
  options: readonly ListScopeOption<T>[];
  onValueChange: (value: T) => void;
  /** The scope's accessible name ("Show your tasks or all tasks"). */
  label: string;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const current = options.find((option) => option.value === value) ?? options[0];
  const change = useCallback((next: T | null) => {
    if (next !== null) onValueChange(next);
  }, [onValueChange]);
  return (
    <Select<T> value={value} onValueChange={change} modal={false}>
      {/* The closed trigger names the scope alone; the counts are in the menu. */}
      <FitToolbarPicker trigger={<SelectTrigger />} icon={null} aria-label={formatMessage({ id: "ui.listToolbar.scopeValue" }, { scope: label, value: current?.label ?? "" })} data-testid={testId}>
        {current?.label}
      </FitToolbarPicker>
      <SelectContent align="start" className="min-w-40">
        <SelectList>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} data-testid={testId ? `${testId}-${option.value}` : undefined}>
              <SelectItemText>{option.label}</SelectItemText>
              {option.count !== null && option.count !== undefined ? (
                <span className="font-mono text-mono-meta text-foreground-hint">{option.count}</span>
              ) : null}
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

/**
 * The toolbar's More (⋯), named More on every list page: it shows only while
 * the sort, the grouping and the view switch have folded into it (step 6),
 * with a secondary add action where there is one (Members' Invite human), and
 * holds them as one menu (FitToolbarMoreItems).
 */
export function ListToolbarMore({ testId }: { testId?: string }) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: "ui.listToolbar.more" });
  return (
    <DropdownMenu>
      <FitToolbarMore trigger={<DropdownMenuTrigger />} aria-label={label} data-testid={testId} />
      <DropdownMenuContent aria-label={label} align="end">
        <FitToolbarMoreItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A choice of one in More's menu (the sort, the grouping, the view): its
 * heading, then its options as radios, the group named by `heading` (a
 * menu's label is only a heading) or by `label` where it shows none.
 */
export function MoreMenuChoices<T extends string>({ heading, label, value, options, onValueChange, testId }: {
  heading: string | null;
  /** The radio group's name where it differs from its heading, or it has none. */
  label?: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onValueChange: (value: T) => void;
  testId?: string;
}) {
  const change = useCallback((next: unknown) => {
    const picked = options.find((option) => option.value === next);
    if (picked) onValueChange(picked.value);
  }, [onValueChange, options]);
  return (
    <>
      {heading === null ? null : <DropdownMenuLabel>{heading}</DropdownMenuLabel>}
      <DropdownMenuRadioGroup aria-label={label ?? heading ?? undefined} value={value} onValueChange={change}>
        {options.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value} data-testid={testId ? `${testId}-${option.value}` : undefined}>
            <DropdownMenuItemLabel>{option.label}</DropdownMenuItemLabel>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/** One way to show a list (List / Board, Grid / List): its words and its icon. */
export interface ListViewOption<T extends string> {
  value: T;
  label: string;
  icon: ReactNode;
  testId?: string;
}

/**
 * The view switch of a list's toolbar: a segmented control (one toolbar
 * item), its icons alone from the first step, each word kept as its name and
 * tooltip; into ⋯ with the sort at step 6 (the group's `moreItem`).
 */
export function ListViewSwitch<T extends string>({ value, options, onValueChange, label, testId }: {
  value: T;
  options: readonly ListViewOption<T>[];
  onValueChange: (value: T) => void;
  /** Its accessible name ("Task view"). */
  label: string;
  testId?: string;
}) {
  const item = useFitItem({ label: LIST_TOOLBAR_STEP.displayLabels });
  const change = useCallback((next: unknown) => {
    const picked = options.find((option) => option.value === next);
    if (picked) onValueChange(picked.value);
  }, [onValueChange, options]);
  return (
    <SegmentedControl<T> value={value} onValueChange={change} aria-label={label} className={SEGMENTED_IN_LINE_CLASS} data-testid={testId} {...item.props}>
      {options.map((option) => (
        <SegmentedControlItem key={option.value} value={option.value} data-testid={option.testId}>
          {option.icon}
          <SegmentedControlLabel>{option.label}</SegmentedControlLabel>
        </SegmentedControlItem>
      ))}
    </SegmentedControl>
  );
}
