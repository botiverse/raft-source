import type { HTMLAttributes } from "react";
import { useContext } from "react";
import { IntlContext } from "react-intl";
import { en } from "../../i18n/messages/en";

/**
 * Neo-Brutalism progress bar — the staging primitive for "a multi-phase
 * operation is running" feedback where a `<Spinner>` (pure indeterminate) is
 * too thin to convey staged progress. First use: the managed-Computer
 * Restart / Upgrade flow, which streams `computer:upgrade:progress` phases
 * (downloading → verifying → applying → restarting) over the live WS.
 *
 * Two modes, mirroring the upgrade reality (most phases have no byte percent):
 *  - determinate   — pass `value` (0–100); the fill width tracks it.
 *  - indeterminate — omit `value`; an animated brutal stripe slides across to
 *                    say "working" without a fake percentage.
 *
 * Brutal DNA, consistent with `card-brutal` / `.btn-brutal` / `StatusDot`:
 *  - `border-2 border-black` track on white, `shadow-brutal-sm` (hard, no blur)
 *  - hard-edged fill (NO rounding), solid brutal color (pink CTA by default)
 *  - snap transitions (`transition-all duration-100`), never smooth-easing
 *
 * NOT for: presence/activity (use `<StatusDot>`) or pure spinner loading
 * (use `<Spinner>`). Reach for this only when there are discrete phases or a
 * real percent to show.
 */
export type ProgressBarTone = "pink" | "cyan" | "lime" | "orange";

const TONE_CLASS: Record<ProgressBarTone, string> = {
  pink: "bg-brutal-pink",
  cyan: "bg-brutal-cyan",
  lime: "bg-brutal-lime",
  orange: "bg-brutal-orange",
};

export interface ProgressBarProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
  /** 0–100 for a determinate bar; omit (or null) for an indeterminate stripe. */
  value?: number | null;
  /** Fill color. Defaults to pink (CTA), matching the Upgrade button. */
  tone?: ProgressBarTone;
  /** Optional phase / status label rendered above the track (left). */
  label?: string;
  /** Show the numeric percent at the right of the label row (determinate only). */
  showPercent?: boolean;
}

export default function ProgressBar({
  value = null,
  tone = "pink",
  label,
  showPercent = false,
  className = "",
  ...rest
}: ProgressBarProps) {
  const intl = useContext(IntlContext);
  const indeterminate = value === null || value === undefined || Number.isNaN(value);
  const pct = indeterminate ? 0 : Math.max(0, Math.min(100, value));
  const defaultAriaLabel =
    intl?.formatMessage({ id: "ui.progressBar.ariaLabel" }) ?? en["ui.progressBar.ariaLabel"];

  return (
    <div className={className} {...rest}>
      {(label || (showPercent && !indeterminate)) && (
        <div className="mb-1 flex items-center justify-between text-xs font-mono text-black/60">
          {label ? <span className="truncate">{label}</span> : <span />}
          {showPercent && !indeterminate && <span className="shrink-0">{Math.round(pct)}%</span>}
        </div>
      )}
      <div
        role="progressbar"
        aria-label={label ?? defaultAriaLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(indeterminate ? {} : { "aria-valuenow": Math.round(pct) })}
        className="h-4 w-full overflow-hidden border-2 border-black bg-white shadow-brutal-sm"
      >
        {indeterminate ? (
          <div className={`h-full w-2/5 ${TONE_CLASS[tone]} progress-indeterminate`} />
        ) : (
          <div
            className={`h-full ${TONE_CLASS[tone]} transition-all duration-100`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}
