import { useLayoutEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";

// Hooks the agent panel's Usage tab and Members › Agents › Usage share (#proj-o11y:#36).

/** Token counts, shares and UTC day names in the reader's locale; "—" for what is not known. */
export function useUsageFormat() {
  const { formatMessage, formatNumber, formatDate } = useIntl();
  return useMemo(() => ({
    dash: formatMessage({ id: "agent.usage.noValue" }),
    tokens: (tokens: number) => formatNumber(tokens, { notation: "compact", maximumFractionDigits: tokens >= 1e9 ? 2 : 1 }),
    percent: (share: number, digits = 1) => formatNumber(share, { style: "percent", maximumFractionDigits: digits }),
    change: (change: number) => formatNumber(change, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 0 }),
    dayName: (day: string) => formatDate(`${day}T12:00:00Z`, { weekday: "short", month: "numeric", day: "numeric", timeZone: "UTC" }),
  }), [formatDate, formatMessage, formatNumber]);
}

export function useElementWidth(): [(element: HTMLDivElement | null) => void, number] {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
}
