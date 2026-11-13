import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxInput,
  ComboboxInputGroup,
  ComboboxList,
  ComboboxTrigger,
  ComboboxTriggerIndicator,
  PickerTriggerButton,
} from "@botiverse/raft-ui";
import { FilterChipRemove } from "@botiverse/raft-ui/wip";

import { useMediaQuery } from "../../hooks/effectPrimitives";
import { ToolbarLabelTooltip } from "../../components/ui/ToolbarLabelTooltip";

/**
 * The home page's two list filters (#proj-workspace:#221), Conversation and
 * Author, are this one control: a PickerTriggerButton opening a Combobox with
 * the search on top and the list below (Raft DS › Select › Filters), one value.
 * Unset, the button says the filter's name; set, it fills and says the value,
 * and a × in the chevron's place clears it. The × is the DS's FilterChipRemove,
 * as the chip's, beside the trigger rather than in it (a button can't hold a
 * button): raft-ui has no × for a PickerTriggerButton. It clears in one press
 * without opening the list, and focus goes back to the button it leaves. On a
 * touch screen the ×'s hit area reaches 10px past the button's end (Raft DS ›
 * FilterChip › Behavior), so while it shows, the group keeps 8px more after it:
 * with the row's 8px gap the next control starts 16px on, clear of the × (its
 * own hit area reaches 6px back). Geometry: visual-testing
 * artifactFilterClearHitArea.spec.ts.
 *
 * The button's text is never cut (Raft DS › PickerTriggerButton: a long value
 * makes it wider): a phone's row scrolls instead (FilterStrip). Wider the
 * row wraps, so only a name wider than the whole row is held to it.
 *
 * The keyboard works at every moment (Kirby): the list is always what is on
 * screen, the local matches while the server is asked (useFilterChoices), and its
 * first row is highlighted, from the first open. No match: nothing is highlighted,
 * and Enter only closes the list. When the server's answer to a search replaces
 * the rows, the highlight goes to its first row, wherever the arrows had taken it.
 * Base UI has no way to set a highlight, and clears one only when the list it
 * navigates goes empty, so `moving` gives it an empty list for the one commit
 * before paint; nothing is drawn from it, and `always` then takes the first row.
 */

const NO_ROWS: readonly string[] = [];

/** Base UI's own value for "the first row of whatever list there is": Combobox forwards it to AriaCombobox, its type says boolean only. */
const HIGHLIGHT_FIRST = { autoHighlight: "always" } as unknown as { autoHighlight: boolean };

const FILTER_COLLISION_AVOIDANCE = { side: "none", align: "shift", fallbackAxisSide: "none" } as const;

/** While a list waits for its answer with nothing to show: quiet, and never "nothing found". */
export function FilterChoicesLoading({ label, testId }: { label: string; testId: string }) {
  return <p className="px-3 py-2 text-callout text-foreground-hint" role="status" data-testid={testId}>{label}</p>;
}

/** A failed read says so where it is, with Try again (Feedback). */
export function FilterChoicesFailed({ message, retryLabel, onRetry, testId }: { message: string; retryLabel: string; onRetry: () => void; testId: string }) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2" role="alert" data-testid={testId}>
      <span className="text-callout text-foreground-muted">{message}</span>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>{retryLabel}</Button>
    </div>
  );
}

export function ArtifactFilterCombobox({ testId, icon, name, value, valueLabel, appliedLabel, clearLabel, onValue, items, answer, labelOf, open, onOpenChange, query, onQuery, searchLabel, searchPlaceholder, children, footer }: {
  testId: string;
  icon: ReactNode;
  /** The filter's name: what the button says unset. */
  name: string;
  /** The one value, or none. */
  value: string | null;
  /** What the button says set. */
  valueLabel: string | null;
  /** The button's name set ("Author: Remy"): the value alone doesn't say what it changes. */
  appliedLabel: string | null;
  clearLabel: string;
  /** A value from the list, or null: cleared. */
  onValue: (value: string | null) => void;
  /** The values offered, in the list's order. */
  items: readonly string[];
  /** Names the server's answer to a search while it is the list (useFilterChoices); null otherwise. */
  answer: number | null;
  labelOf: (value: string) => string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQuery: (query: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  /** The list's groups and items. */
  children: ReactNode;
  /** Under the list: why it is empty, or that it failed. */
  footer: ReactNode;
}) {
  const coarse = useMediaQuery("(pointer: coarse)");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const applied = value !== null;
  // The answer the highlight has gone to the top of.
  const [followed, setFollowed] = useState<number | null>(null);
  const moving = answer !== null && answer !== followed;
  useLayoutEffect(() => {
    if (moving) setFollowed(answer);
  }, [moving, answer]);
  const changeOpen = useCallback((next: boolean) => {
    if (next) onQuery("");
    onOpenChange(next);
  }, [onQuery, onOpenChange]);
  const changeInput = useCallback((next: string, details: { reason: string }) => {
    // Choosing an item writes its label into the field; only typing searches.
    if (details.reason !== "item-press") onQuery(next);
  }, [onQuery]);
  const clear = useCallback(() => {
    onValue(null);
    // The × goes with the value: focus stays on the filter.
    triggerRef.current?.focus();
  }, [onValue]);
  // The × takes the chevron's place, so the button's text never runs under it.
  const trigger = useMemo(() => <PickerTriggerButton className={`w-full min-w-0 justify-start ${applied ? "pe-7.5" : ""}`} data-testid={testId} />, [testId, applied]);
  return (
    <span className={`relative inline-flex max-w-full shrink-0 max-md:max-w-none ${applied ? "pointer-coarse:me-2" : ""}`} data-testid={`${testId}-group`}>
      <Combobox<string>
        {...HIGHLIGHT_FIRST}
        items={moving ? NO_ROWS : items}
        value={value}
        open={open}
        inputValue={query}
        filter={null}
        itemToStringLabel={labelOf}
        onOpenChange={changeOpen}
        onInputValueChange={changeInput}
        onValueChange={onValue}
      >
        <ToolbarLabelTooltip label={appliedLabel ?? name}>
          <ComboboxTrigger ref={triggerRef} render={trigger} aria-label={appliedLabel ?? name}>
            {icon}
            {/* Unset, the name gives way to the icon where the wide row would wrap (useIconsOnlyWhenWrapped); a value stays. */}
            <span className="min-w-0 text-left md:truncate" data-testid={`${testId}-value`} data-toolbar-label={applied ? undefined : ""}>{valueLabel ?? name}</span>
            {applied ? null : (
              <ComboboxTriggerIndicator>
                <ChevronDown aria-hidden />
              </ComboboxTriggerIndicator>
            )}
          </ComboboxTrigger>
        </ToolbarLabelTooltip>
        <ComboboxContent align="start" side="bottom" collisionAvoidance={FILTER_COLLISION_AVOIDANCE} initialFocus={!coarse} finalFocus={false} className="w-[320px] max-w-[calc(100vw-2rem)]">
          <ComboboxInputGroup>
            <ComboboxInput aria-label={searchLabel} placeholder={searchPlaceholder} suppressPasswordManager />
          </ComboboxInputGroup>
          <ComboboxList>{children}</ComboboxList>
          {footer}
        </ComboboxContent>
      </Combobox>
      {applied ? (
        <FilterChipRemove className="absolute end-1 top-1/2 -translate-y-1/2" aria-label={clearLabel} onClick={clear} data-testid={`${testId}-clear`} />
      ) : null}
    </span>
  );
}
