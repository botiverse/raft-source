/**
 * Canonical section header — eyebrow label + optional count badge + optional
 * trailing action button.
 *
 * Generalizes the inline `flex items-center justify-between` + `SectionEyebrow`
 * + counter + action button pattern that appears 15+ times across detail
 * panels, settings, channel members, agent reminders, etc.
 *
 * Background: stdrc 2026-05-12 #wg-theme:a987f888 asked for strong-signal
 * primitives to be lifted in one PR. SectionHeader is the third of the three.
 * It composes the existing `SectionEyebrow` primitive (so the eyebrow token
 * stays canonical) rather than duplicating its class string.
 *
 * Slots:
 * - `label`     — the eyebrow text
 * - `icon`      — optional leading icon node (e.g. `<Bell size={16} />`),
 *                 rendered in `text-black/60` next to the eyebrow
 * - `count`     — optional integer badge rendered after the label in
 *                 `text-black/40 font-mono` (rendered only when defined and
 *                 ≥ 0; pass `undefined` / `null` to hide)
 * - `action`    — optional right-aligned action node (e.g. `<button>` to add)
 * - `htmlFor`   — when set, the eyebrow becomes a `<label htmlFor>` for the
 *                 region's main control
 * - `className` — additional classes on the outer wrapper (e.g. `mb-2`,
 *                 `border-b-2 border-black pb-2`)
 *
 * Typography is locked via `SectionEyebrow`; do NOT pass eyebrow class
 * overrides here — if a section needs a different style, it shouldn't be a
 * SectionHeader.
 */

import type { ReactNode } from "react";
import SectionEyebrow from "./SectionEyebrow";

export type SectionHeaderProps = {
  label: ReactNode;
  icon?: ReactNode;
  count?: number | null;
  action?: ReactNode;
  htmlFor?: string;
  className?: string;
};

export default function SectionHeader({
  label,
  icon,
  count,
  action,
  htmlFor,
  className,
}: SectionHeaderProps) {
  const wrapperCls = `flex items-center justify-between gap-2${
    className ? ` ${className}` : ""
  }`;
  const eyebrowAs: "label" | "div" = htmlFor ? "label" : "div";
  return (
    <div className={wrapperCls}>
      <div className="flex min-w-0 items-center gap-2">
        {icon ? (
          <span className="shrink-0 text-black/60">{icon}</span>
        ) : null}
        <SectionEyebrow as={eyebrowAs} htmlFor={htmlFor}>
          {label}
          {typeof count === "number" && count >= 0 ? (
            <span className="ml-2 font-mono text-black/40">{count}</span>
          ) : null}
        </SectionEyebrow>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
