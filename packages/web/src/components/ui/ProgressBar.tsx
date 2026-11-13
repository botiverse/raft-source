import { Progress, ProgressTrack, ProgressIndicator } from "@botiverse/raft-ui";
import type { HTMLAttributes } from "react";
import { useContext } from "react";
import { IntlContext } from "react-intl";
import { enFallback } from "../../i18n/messages/enFallback";

/** Product labels and value normalization over the themed RUI progress recipe.
 *
 *  Raft Design System › Loading (`rf-progress`): an 8px sunken track with a
 *  cyan fill that carries an ink edge; orange near a limit, lime when done.
 *  Progress is a passive indicator, so it is never the action pink. */
export type ProgressBarTone = "cyan" | "lime" | "orange";

const TONE_CLASS: Record<ProgressBarTone, "information" | "success" | "warning"> = {
  cyan: "information",
  lime: "success",
  orange: "warning",
};

/** RUI Progress turns lime when complete; this keeps the tone's own colour (raft-ui's cn merges it over that rule). */
const HOLD_TONE_WHEN_FULL_CLASS = "data-complete:[--progress-indicator:var(--progress-color)]";

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** 0–100 for a determinate bar; omit (or null) for an indeterminate stripe. */
  value?: number | null;
  /** Fill color. Defaults to the DS cyan fill. */
  tone?: ProgressBarTone;
  /** Optional phase / status label rendered above the track (left). */
  label?: string;
  /** Show the numeric percent at the right of the label row (determinate only). */
  showPercent?: boolean;
  /**
   * Keep the tone at 100% instead of turning lime ("done"): for a level that
   * is not a task, such as a disk or memory that is full, where lime would
   * read as fine.
   */
  holdToneWhenFull?: boolean;
}

export default function ProgressBar({
  value = null,
  tone = "cyan",
  label,
  showPercent = false,
  holdToneWhenFull = false,
  className = "",
  // Names the bar itself, not its wrapper, when there is no visible label.
  "aria-label": ariaLabel,
  ...rest
}: ProgressBarProps) {
  const intl = useContext(IntlContext);
  const indeterminate = value === null || value === undefined || Number.isNaN(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  const defaultAriaLabel =
    intl?.formatMessage({ id: "ui.progressBar.ariaLabel" }) ?? enFallback["ui.progressBar.ariaLabel"];

  return (
    <div className={className} {...rest}>
      {(label || (showPercent && !indeterminate)) && (
        <div className="mb-1.5 flex items-center justify-between gap-2">
          {label ? <span className="truncate text-footnote font-semibold text-foreground">{label}</span> : <span />}
          {showPercent && !indeterminate && <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">{Math.round(pct)}%</span>}
        </div>
      )}
      <Progress
        value={indeterminate ? null : pct}
        variant={TONE_CLASS[tone]}
        className={holdToneWhenFull ? HOLD_TONE_WHEN_FULL_CLASS : undefined}
        aria-label={label ?? ariaLabel ?? defaultAriaLabel}
      >
        <ProgressTrack>
          <ProgressIndicator />
        </ProgressTrack>
      </Progress>
    </div>
  );
}
