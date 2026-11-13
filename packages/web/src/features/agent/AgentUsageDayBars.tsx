import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { ScrollArea } from "@botiverse/raft-ui";
import type { UsageDay, UsageSums } from "./agentUsage";
import { USAGE_SERIES } from "./agentUsageSeries";
import type { UsageSeriesKey } from "./agentUsageSeries";

// The Usage tab's daily bars (#proj-o11y:#36, v5 mock): one stacked bar per
// UTC day, each kind a sticker segment (radius 3, the 1.5px ink edge raft-ui's
// MeterIndicator draws) with a 2px gap, one hue per kind, the day's sum above.
// raft-ui has no chart component; this is hand-drawn SVG on DS tokens.
// The bars are one radio group: click or arrow keys pick a day, Home/End jump,
// Enter/Space or a second click and Esc go back to the whole range. Narrower
// than MIN_SLOT a day, the chart scrolls sideways (ScrollArea fade) and opens
// at the newest day.


export function UsageSwatch({ kind }: { kind: UsageSeriesKey }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block size-2.5 shrink-0 rounded-[3px] inset-ring-[1.5px] inset-ring-sticker-ink"
      style={{ background: USAGE_SERIES[kind].color }}
    />
  );
}

const HEIGHT = 132;
const TOP = 18; // room for the sum over the tallest bar
const BOTTOM = 30; // day labels
const PLOT = HEIGHT - TOP - BOTTOM;
const MIN_SLOT = 18; // narrower than this a day, the chart scrolls instead of squeezing
const GAP = 2;
const MIN_SEGMENT = 3; // a kind that is there never vanishes
const FADE_PAD = 28; // past the ScrollArea's 24px fade

const value = (sums: UsageSums, kind: UsageSeriesKey) => sums[kind] ?? 0;

export function AgentUsageDayBars({
  days,
  withCacheReads,
  width,
  selected,
  onSelect,
  formatTokens,
}: {
  days: UsageDay[];
  withCacheReads: boolean;
  width: number;
  selected: string | null;
  onSelect: (day: string | null) => void;
  formatTokens: (tokens: number) => string;
}) {
  const { formatMessage, formatDate } = useIntl();
  const [hover, setHover] = useState<number | null>(null);
  const refs = useRef<(SVGGElement | null)[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);

  const order: UsageSeriesKey[] = withCacheReads ? ["cacheRead", "inputNew", "cacheWrite", "output"] : ["inputNew", "cacheWrite", "output"];
  const kinds = order.filter((kind) => days.some((day) => value(day.sums, kind) > 0));
  const n = days.length;
  const dense = n > 7;
  const sums = days.map((day) => kinds.reduce((sum, kind) => sum + value(day.sums, kind), 0));
  const max = Math.max(1, ...sums);
  const slot = Math.max(MIN_SLOT, width / Math.max(1, n));
  const contentWidth = slot * n;
  const scrolls = contentWidth > width + 0.5;
  const barWidth = Math.min(28, slot * (dense ? 0.62 : 0.56));
  const tallest = sums.indexOf(Math.max(...sums));
  const selectedIndex = selected === null ? null : days.findIndex((day) => day.day === selected);
  const picked = selectedIndex === -1 ? null : selectedIndex;
  const shown = hover ?? picked;
  const lastIndex = n - 1;

  const weekday = (day: string) => formatDate(`${day}T12:00:00Z`, { weekday: "short", timeZone: "UTC" });
  // The locale's own one-letter weekday (zh-CN "一", not the first character of "周一").
  const weekdayInitial = (day: string) => formatDate(`${day}T12:00:00Z`, { weekday: "narrow", timeZone: "UTC" });
  const monthDay = (day: string) => formatDate(`${day}T12:00:00Z`, { month: "numeric", day: "numeric", timeZone: "UTC" });
  const dayOfMonth = (day: string) => formatDate(`${day}T12:00:00Z`, { day: "numeric", timeZone: "UTC" });
  const dayName = (day: string) => formatDate(`${day}T12:00:00Z`, { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" });
  const kindLabel = (kind: UsageSeriesKey) => formatMessage({ id: USAGE_SERIES[kind].labelId });
  const dash = formatMessage({ id: "agent.usage.noValue" });

  const pick = (index: number) => onSelect(picked === index ? null : days[index]!.day);
  const move = (index: number) => {
    const next = Math.max(0, Math.min(lastIndex, index));
    onSelect(days[next]!.day);
    refs.current[next]?.focus({ preventScroll: true });
  };
  const onKeyDown = (event: KeyboardEvent<SVGGElement>, index: number) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(index + 1),
      ArrowDown: () => move(index + 1),
      ArrowLeft: () => move(index - 1),
      ArrowUp: () => move(index - 1),
      Home: () => move(0),
      End: () => move(lastIndex),
      Enter: () => pick(index),
      " ": () => pick(index),
    };
    if (event.key === "Escape" && picked !== null) keys.Escape = () => onSelect(null);
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  };

  // Open at the newest day; again when the range or the width changes.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && picked === null) element.scrollLeft = element.scrollWidth;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on a new layout, not on every pick
  }, [n, width, scrolls]);
  // Keep the picked day in view.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || picked === null) return;
    const left = picked * slot;
    const right = left + slot;
    if (left < element.scrollLeft + FADE_PAD) element.scrollLeft = Math.max(0, left - FADE_PAD);
    else if (right > element.scrollLeft + element.clientWidth - FADE_PAD) element.scrollLeft = right - element.clientWidth + FADE_PAD;
  }, [picked, slot]);

  const kindFigures = (amountOf: (kind: UsageSeriesKey) => number) => kinds
    .map((kind) => formatMessage({ id: "agent.usage.readoutKind" }, { kind: kindLabel(kind), tokens: formatTokens(amountOf(kind)) }))
    .join(formatMessage({ id: "agent.usage.readoutSeparator" }));
  const shownDay = shown === null ? null : days[shown]!;
  const readout: ReactNode = shownDay === null
    ? kindFigures((kind) => days.reduce((sum, day) => sum + value(day.sums, kind), 0))
    : !shownDay.noData && kinds.length === 0
      ? dayName(shownDay.day)
      : formatMessage({ id: "agent.usage.readoutDay" }, {
        day: dayName(shownDay.day),
        figures: shownDay.noData ? dash : kindFigures((kind) => value(shownDay.sums, kind)),
      });
  const hasPartial = days.some((day) => day.partial);
  const scrollStyle = useMemo(() => ({ width }), [width]);

  const svg = (
    <svg
      width={contentWidth}
      height={HEIGHT}
      viewBox={`0 0 ${contentWidth} ${HEIGHT}`}
      role="radiogroup"
      aria-label={formatMessage({ id: "agent.usage.chartLabel" })}
      className="block overflow-visible"
    >
      <line x1={0} x2={contentWidth} y1={TOP + PLOT + 0.5} y2={TOP + PLOT + 0.5} stroke="var(--line-hairline)" />
      {days.map((day, index) => {
        const x = slot * index + (slot - barWidth) / 2;
        let y = TOP + PLOT;
        const segments = day.noData ? [] : kinds.map((kind) => {
          const amount = value(day.sums, kind);
          if (amount <= 0) return null;
          const height = Math.max(MIN_SEGMENT, (PLOT * amount) / max);
          y -= height;
          return <rect key={kind} x={x} y={y} width={barWidth} height={height - GAP} rx={3} fill={USAGE_SERIES[kind].color} stroke="var(--sticker-ink)" strokeWidth={1.5} />;
        });
        const isSelected = picked === index;
        const dim = picked !== null ? !isSelected && hover !== index : hover !== null && hover !== index;
        const showSum = !day.noData && (!dense || isSelected || hover === index || (picked === null && hover === null && index === tallest));
        const sumLabel = day.noData ? dash : formatTokens(sums[index]!);
        const name = day.partial
          ? formatMessage({ id: "agent.usage.barLabelPartial" }, { day: dayName(day.day), tokens: sumLabel })
          : formatMessage({ id: "agent.usage.barLabel" }, { day: dayName(day.day), tokens: sumLabel });
        const isToday = index === lastIndex;
        return (
          <g
            key={day.day}
            ref={(element) => { refs.current[index] = element; }}
            role="radio"
            aria-checked={isSelected}
            aria-label={name}
            tabIndex={index === (picked ?? lastIndex) ? 0 : -1}
            className="cursor-pointer outline-none [&:focus-visible>.usage-ring]:opacity-100"
            data-day={day.day}
            data-no-data={day.noData ? "" : undefined}
            onClick={() => pick(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <rect x={slot * index} y={0} width={slot} height={HEIGHT} fill="transparent" />
            {isSelected ? <rect x={slot * index + 1} y={2} width={slot - 2} height={TOP + PLOT - 2} rx={6} fill="var(--fill-muted)" /> : null}
            <rect className="usage-ring opacity-0" x={slot * index + 1} y={1} width={slot - 2} height={HEIGHT - 2} rx={6} fill="none" stroke="var(--foreground)" strokeWidth={1.5} strokeDasharray="3 2" />
            <g opacity={dim ? 0.32 : 1}>{segments}</g>
            {showSum ? (
              <text
                x={index === 0 ? x : isToday ? x + barWidth : x + barWidth / 2}
                y={y - 6}
                textAnchor={index === 0 ? "start" : isToday ? "end" : "middle"}
                className={`font-mono text-[11px] ${dim ? "fill-foreground-hint" : "fill-foreground"} ${isSelected ? "font-bold" : ""}`}
              >
                {sumLabel}
              </text>
            ) : null}
            {n > 14 ? (
              // 30 bars: one date a week, counted back from today, and the picked day.
              isSelected || ((lastIndex - index) % 7 === 0 && (picked === null || Math.abs(picked - index) > 2)) ? (
                <text
                  x={isToday ? slot * n - 1 : index === 0 ? 1 : x + barWidth / 2}
                  y={TOP + PLOT + 14}
                  textAnchor={isToday ? "end" : index === 0 ? "start" : "middle"}
                  className={`font-mono text-[10px] ${isSelected ? "fill-foreground font-bold" : "fill-foreground-muted"}`}
                >
                  {isToday && !isSelected ? formatMessage({ id: "agent.usage.today" }) : monthDay(day.day)}
                  {day.partial ? formatMessage({ id: "agent.usage.partialMark" }) : null}
                </text>
              ) : null
            ) : (
              <>
                <text
                  x={x + barWidth / 2}
                  y={TOP + PLOT + 14}
                  textAnchor="middle"
                  className={`font-sans text-[11px] ${isSelected ? "fill-foreground font-bold" : dim ? "fill-foreground-hint" : "fill-foreground-muted"}`}
                >
                  {dense ? weekdayInitial(day.day) : isToday ? formatMessage({ id: "agent.usage.today" }) : weekday(day.day)}
                  {day.partial && !dense ? formatMessage({ id: "agent.usage.partialMark" }) : null}
                </text>
                <text x={x + barWidth / 2} y={TOP + PLOT + 26} textAnchor="middle" className="fill-foreground-hint font-mono text-[10px]">
                  {dense ? dayOfMonth(day.day) : monthDay(day.day)}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );

  return (
    <div className="flex flex-col gap-2" data-testid="agent-usage-chart">
      <div className="min-h-[18px] truncate font-mono text-mono-meta text-foreground-muted" aria-live="polite" data-testid="agent-usage-readout">
        {readout}
      </div>
      {scrolls ? (
        <ScrollArea ref={scroller} orientation="horizontal" fade trigger="hover" style={scrollStyle} data-testid="agent-usage-chart-scroll">
          {svg}
        </ScrollArea>
      ) : svg}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-foreground-muted">
        {kinds.slice().reverse().map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5"><UsageSwatch kind={kind} />{kindLabel(kind)}</span>
        ))}
        {hasPartial ? <span className="text-foreground-hint">{formatMessage({ id: "agent.usage.partialLegend" })}</span> : null}
      </div>
    </div>
  );
}
