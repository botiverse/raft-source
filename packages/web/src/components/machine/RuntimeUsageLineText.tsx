import { useIntl } from "react-intl";
import type { RuntimeUsageLine } from "./runtimeUsageText";

/**
 * The compact usage line, with a used-up window in the warning colour (as the
 * hover card's warning row) so the computer that cannot run stands out; the
 * rest keeps the surrounding muted colour.
 */
export function RuntimeUsageLineText({ line }: { line: RuntimeUsageLine }) {
  const { formatMessage } = useIntl();
  if (line.windows.length === 0) return <>{line.text}</>;
  // The line has at most two windows (5 hours, then the week); the catalog
  // owns the separator between them.
  const [first, second] = line.windows.map((part) => (part.limitReached
    ? <span key={part.text} className="text-warning-strong" data-usage-limit-reached="">{part.text}</span>
    : part.text));
  const windows = second === undefined ? first : formatMessage({ id: "machine.runtimeUsage.line.pair" }, { first, second });
  return <>{formatMessage({ id: "machine.runtimeUsage.line.all" }, { plan: line.plan, windows: <>{windows}</> })}</>;
}
