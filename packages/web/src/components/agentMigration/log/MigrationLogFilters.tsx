// The log's filters (DS Tasks › Filters): computers and agents (ListFilter), outcome and time. Moved out of
// MigrationLogPage so the page stays within its module-shape budget.
import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { CalendarRange, ChevronDown, CircleCheck } from "lucide-react";
import {
  Combobox, ComboboxClear, ComboboxContent, ComboboxEmpty, ComboboxHeader, ComboboxInput, ComboboxInputGroup, ComboboxItem,
  ComboboxItemIndicator, ComboboxLabel, ComboboxList, ComboboxSeparator, ComboboxTrigger, ComboboxTriggerCount, ComboboxTriggerIndicator,
  PickerTriggerButton,
} from "@botiverse/raft-ui";
import type { LogFilters } from "./model";
import { OUTCOME_LABEL } from "./model";
import { useCoarsePointer } from "./viewport";

const OUTCOME_ITEMS: LogFilters["outcomes"] = ["completed", "failed", "canceled"];
const TIME_ITEMS = ["all", "7", "30"] as const;
type TimeItem = (typeof TIME_ITEMS)[number];
const TIME_LABEL = {
  all: "agent.migrationLog.filter.allTime",
  7: "agent.migrationLog.filter.days7",
  30: "agent.migrationLog.filter.days30",
} as const satisfies Record<TimeItem, string>;
const FILTER_COLLISION_AVOIDANCE = { side: "none", align: "shift", fallbackAxisSide: "none" } as const;

/**
 * A filter (DS Tasks › Filters): a PickerTriggerButton that opens a list with
 * search, several values at once. Applied, it fills (data-has-value): one value
 * shows its name, more show the filter's name and how many (Space Mono).
 */
export function ListFilter({ icon, name, searchLabel, ids, labelOf, shortLabelOf, value, onChange, renderItem, className, testId }: {
  icon: ReactNode;
  name: string;
  searchLabel?: string;
  ids: readonly string[];
  /** The text searched and shown for one chosen value. */
  labelOf: (id: string) => string;
  /** A shorter text for the trigger (a computer's code). */
  shortLabelOf?: (id: string) => string;
  value: string[];
  onChange: (value: string[]) => void;
  renderItem: (id: string) => ReactNode;
  className?: string;
  testId: string;
}) {
  const { formatMessage: t } = useIntl();
  // With a mouse, typing goes straight to the search; a touch screen waits for a tap (no keyboard popping up).
  const coarse = useCoarsePointer();
  const one = value.length === 1 ? (shortLabelOf ?? labelOf)(value[0]) : null;
  const onValueChange = useCallback((v: string[]) => onChange(v), [onChange]);
  const clear = useCallback(() => onChange([]), [onChange]);
  const trigger = useMemo(() => <PickerTriggerButton className="shrink-0" data-testid={testId} />, [testId]);
  return (
    <Combobox<string, true> multiple autoHighlight items={ids} value={value} onValueChange={onValueChange} itemToStringLabel={labelOf}>
      <ComboboxTrigger render={trigger} aria-label={one ? t({ id: "agent.migrationLog.filter.valueLabel" }, { filter: name, value: one }) : undefined}>
        {icon}
        <span className="min-w-0 max-w-36 truncate">{one ?? name}</span>
        {value.length > 1 ? <ComboboxTriggerCount>{value.length}</ComboboxTriggerCount> : null}
        <ComboboxTriggerIndicator><ChevronDown aria-hidden /></ComboboxTriggerIndicator>
      </ComboboxTrigger>
      <ComboboxContent align="start" side="bottom" collisionAvoidance={FILTER_COLLISION_AVOIDANCE} initialFocus={Boolean(searchLabel) && !coarse} className={className}>
        <ComboboxHeader>
          <ComboboxLabel>{name}</ComboboxLabel>
          {value.length ? <ComboboxClear onClick={clear}>{t({ id: "agent.migrationLog.filter.clear" })}</ComboboxClear> : null}
        </ComboboxHeader>
        <ComboboxSeparator />
        {searchLabel ? (
          <ComboboxInputGroup>
            <ComboboxInput aria-label={searchLabel} placeholder={t({ id: "agent.migrationLog.filter.searchPlaceholder" })} suppressPasswordManager />
          </ComboboxInputGroup>
        ) : null}
        <ComboboxList>
          {(id: string) => (
            <ComboboxItem key={id} value={id}>
              {renderItem(id)}
              <ComboboxItemIndicator />
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{t({ id: "agent.migrationLog.filter.noMatch" })}</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}

export function OutcomeFilter({ value, onChange }: { value: LogFilters["outcomes"]; onChange: (v: LogFilters["outcomes"]) => void }) {
  const { formatMessage: t } = useIntl();
  const labelOf = useCallback((o: string) => t({ id: OUTCOME_LABEL[o as LogFilters["outcomes"][number]] }), [t]);
  const onValueChange = useCallback((v: string[]) => onChange(v as LogFilters["outcomes"]), [onChange]);
  const renderItem = useCallback((o: string) => <span className="truncate">{labelOf(o)}</span>, [labelOf]);
  return (
    <ListFilter
      icon={<CircleCheck aria-hidden />}
      name={t({ id: "agent.migrationLog.filter.outcome" })}
      searchLabel={t({ id: "agent.migrationLog.filter.searchOutcomes" })}
      ids={OUTCOME_ITEMS}
      labelOf={labelOf}
      value={value}
      onChange={onValueChange}
      renderItem={renderItem}
      className="w-56"
      testId="migration-log-filter-outcome"
    />
  );
}

/** One of three time ranges: the same trigger, its list marks the current one. */
export function TimeFilter({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const { formatMessage: t } = useIntl();
  const current: TimeItem = TIME_ITEMS.find((d) => d !== "all" && Number(d) === value) ?? "all";
  const labelOf = useCallback((d: string) => t({ id: TIME_LABEL[d as TimeItem] }), [t]);
  const onValueChange = useCallback((d: TimeItem | null) => { if (d) onChange(d === "all" ? null : Number(d)); }, [onChange]);
  const trigger = useMemo(() => <PickerTriggerButton className="shrink-0" data-testid="migration-log-filter-time" />, []);
  return (
    <Combobox<TimeItem> items={TIME_ITEMS} filter={null} value={current} onValueChange={onValueChange} itemToStringLabel={labelOf}>
      {/* The default range is a value too, so applied is set by hand: only a range other than All Time. */}
      <ComboboxTrigger render={trigger} data-has-value={current !== "all" ? "" : undefined} aria-label={t({ id: "agent.migrationLog.filter.valueLabel" }, { filter: t({ id: "agent.migrationLog.filter.time" }), value: labelOf(current) })}>
        <CalendarRange aria-hidden />
        <span>{labelOf(current)}</span>
        <ComboboxTriggerIndicator><ChevronDown aria-hidden /></ComboboxTriggerIndicator>
      </ComboboxTrigger>
      <ComboboxContent align="start" side="bottom" collisionAvoidance={FILTER_COLLISION_AVOIDANCE} className="w-48">
        <ComboboxList>
          {(d: TimeItem) => (
            <ComboboxItem key={d} value={d}>
              <span className="truncate">{labelOf(d)}</span>
              <ComboboxItemIndicator />
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}
