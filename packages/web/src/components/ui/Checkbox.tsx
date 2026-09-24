// Neo-Brutalist form checkbox primitive — sr-only native input + shared
// CheckMarker visual, matching the form checkbox places already hand-rolled
// before extraction (#proj-permission:1414ca65 msg=dabbb00e):
//
//   • ReportIssueDialog — 4 options + consent
//   • MessageInput — "As Task" toggle
//
// Why a custom span over native styling: the brutal design system uses
// `border-2 border-black` everywhere; native `accent-color` ignores border
// width and gives a soft fill. The `sr-only` input keeps a11y/keyboard/form
// behavior intact while letting us paint the visual.
//
// API stays minimal — same shape as a native `<input type="checkbox">` plus a
// `size` prop. Selection-only markers use CheckMarker directly so decorative
// row selection does not inherit form semantics.
//
// The `<label>` wrapper that owns hover / cursor / disabled-opacity stays
// the caller's job — different consumers compose this checkbox into
// different row layouts (inline vs stacked, with description vs without),
// and forcing one row layout would just push complexity into props.

import type { InputHTMLAttributes } from "react";
import CheckMarker from "./CheckMarker";
import type { CheckMarkerSize } from "./CheckMarker";

type Size = Extract<CheckMarkerSize, "sm" | "md">;

export interface CheckboxProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size"> {
  /** Visual size of the checkbox box. Default `sm` (14px) matches the
   *  existing inline callsites; use `md` (16px) for permission rows and
   *  other settings-style lists. */
  size?: Size;
}

// Inline sr-only equivalent so the native input stays visually hidden
// regardless of whether the consumer's Tailwind has the `sr-only`
// utility class generated. ui-inventory hit this — its Tailwind only
// scans its own src, so primitive-internal class strings weren't being
// generated and the OS-default checkbox visibly bled through.
const SR_ONLY_STYLE = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0,0,0,0)",
  whiteSpace: "nowrap",
  borderWidth: 0,
} as const;

export default function Checkbox({
  size = "sm",
  checked,
  disabled,
  className = "",
  ...rest
}: CheckboxProps) {
  return (
    <span className="relative inline-flex shrink-0">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        style={SR_ONLY_STYLE}
        {...rest}
      />
      <CheckMarker
        checked={Boolean(checked)}
        disabled={disabled}
        size={size}
        tone="black-fill"
        className={className}
      />
    </span>
  );
}
