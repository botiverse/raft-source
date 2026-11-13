import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  DescriptionDetails,
  DescriptionItem,
  DescriptionTerm,
  Select,
  SelectContent,
  SelectIcon,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@botiverse/raft-ui";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { relativeChange } from "./agentUsage";
import type { AgentUsageRange, AgentUsageView, UsageFigures } from "./agentUsage";
import { useUsageFormat } from "./agentUsageHooks";

// What the agent panel's Usage tab and the Members › Agents usage view
// (#proj-o11y:#36) both draw: the period Select, the change against the prior
// period, a label and value, and the numbers' formats.

/** A label and its value on a fixed two-column grid. */
export function UsageFact({ term, children, testId }: { term: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <DescriptionItem className="grid grid-cols-[116px_minmax(0,1fr)] items-baseline gap-x-3" data-testid={testId}>
      <DescriptionTerm>{term}</DescriptionTerm>
      <DescriptionDetails className="min-w-0">{children}</DescriptionDetails>
    </DescriptionItem>
  );
}

/** "↗ +12% vs prior period" (or "vs Tue 3/10" for a picked day); "—" when there is nothing to compare. */
export function UsageChange({ figures, picked, testId }: { figures: UsageFigures; picked: boolean; testId?: string }) {
  const { formatMessage } = useIntl();
  const format = useUsageFormat();
  const change = figures.noData ? null : relativeChange(figures.compared, figures.base);
  return (
    <span className="inline-flex items-center gap-1 text-caption text-foreground-muted" data-testid={testId}>
      {change === null ? format.dash : (
        <>
          {change >= 0 ? <ArrowUpRight className="size-3.5" aria-hidden="true" /> : <ArrowDownRight className="size-3.5" aria-hidden="true" />}
          {picked && figures.baseDay
            ? formatMessage({ id: "agent.usage.vsDay" }, { change: format.change(change), day: format.dayName(figures.baseDay) })
            : formatMessage({ id: "agent.usage.vsPrior" }, { change: format.change(change) })}
        </>
      )}
    </span>
  );
}

type PeriodValue = "pick" | "today" | "7" | "14" | "30";

/**
 * The period: Today, 7, 14 or 30 days; a day picked on the bars shows as its
 * value ("Tue 3/10"), the presets under it. One fixed-width trigger, so a
 * choice never changes its size.
 */
export function AgentUsagePeriodSelect({ view, today, onChange, testId }: {
  view: AgentUsageView;
  /** The UTC day the answer ends on. */
  today: string;
  onChange: (view: AgentUsageView) => void;
  testId?: string;
}) {
  const { formatMessage } = useIntl();
  const format = useUsageFormat();
  const value: PeriodValue = view.day === today ? "today" : view.day ? "pick" : (String(view.range) as PeriodValue);
  const pickedLabel = view.day && view.day !== today ? format.dayName(view.day) : "";
  const items = useMemo(() => {
    const rangeLabel = (range: AgentUsageRange) => formatMessage({ id: "agent.usage.period.days" }, { count: range });
    return [
      { value: "pick", label: pickedLabel },
      { value: "today", label: formatMessage({ id: "agent.usage.period.today" }) },
      { value: "7", label: rangeLabel(7) },
      { value: "14", label: rangeLabel(14) },
      { value: "30", label: rangeLabel(30) },
    ];
  }, [formatMessage, pickedLabel]);
  const change = useCallback((next: string | null) => {
    if (next === "today") onChange({ range: view.range, day: today });
    else if (next === "7" || next === "14" || next === "30") onChange({ range: Number(next) as AgentUsageRange, day: null });
  }, [onChange, today, view.range]);
  return (
    <Select items={items} value={value} onValueChange={change}>
      <SelectTrigger aria-label={formatMessage({ id: "agent.usage.periodLabel" })} className="w-[136px]" data-testid={testId}>
        <SelectValue />
        <SelectIcon />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectList>
          {/* The picked-day item stays mounted (hidden when there is none):
              unmounting it while Today was chosen shifted every item up one
              and the Select committed a second value (Today, then 7 days). */}
          <SelectItem value="pick" disabled={!pickedLabel} hidden={!pickedLabel} className={pickedLabel ? "" : "hidden"}>
            <SelectItemText>{pickedLabel}</SelectItemText>
            <SelectItemIndicator />
          </SelectItem>
          {items.slice(1).map((item) => (
            <SelectItem key={item.value} value={item.value}>
              <SelectItemText>{item.label}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}
