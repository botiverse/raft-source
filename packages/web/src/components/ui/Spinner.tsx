import type { HTMLAttributes } from "react";
import { useContext } from "react";
import { IntlContext } from "react-intl";
import { en } from "../../i18n/messages/en";

/**
 * Ring-style loading spinner. The single staging primitive for indeterminate
 * "loading / pending / uploading" feedback. Use this anywhere you would have
 * reached for an inline `<div className="... animate-spin" />` or a
 * generic lucide loader icon with `animate-spin`.
 *
 * NOT to be used for:
 *  - Refresh-action icons that spin while their action is in-flight
 *    (e.g. `<RefreshCw className={loading ? "animate-spin" : ""} />`). The
 *    spinning icon there is the affordance, not a generic loader; keep those
 *    as-is.
 *  - Status / activity dots (presence, typing). Use `<StatusDot>` instead.
 *
 * Color semantic:
 *  - `default` — black ring on a light surface (cards, panels, white inputs)
 *  - `inverse` — white ring on a dark surface (image lightbox, dark overlay)
 *
 * Sizes are tuned to the existing inline spinners they replace:
 *  - xs  10px — inline next to text (thread-ref resolving, chat-line markers)
 *  - sm  16px — small chips, attachment thumbnails, icon-sized buttons
 *  - md  20px — message overlays, optimistic image placeholders
 *  - lg  32px — full-surface modal loaders (image lightbox, file viewer)
 */
export type SpinnerSize = "xs" | "sm" | "md" | "lg";
export type SpinnerVariant = "default" | "inverse";

const SIZE_CLASS: Record<SpinnerSize, string> = {
  xs: "size-2.5 border-2",
  sm: "size-4 border-2",
  md: "size-5 border-2",
  lg: "size-8 border-2",
};

const VARIANT_CLASS: Record<SpinnerVariant, string> = {
  default: "border-black/20 border-t-black",
  inverse: "border-white/40 border-t-white",
};

export interface SpinnerProps extends Omit<HTMLAttributes<HTMLSpanElement>, "size"> {
  size?: SpinnerSize;
  variant?: SpinnerVariant;
  /** Accessible label announced by screen readers. */
  label?: string;
  className?: string;
}

export default function Spinner({
  size = "md",
  variant = "default",
  label,
  className = "",
  ...props
}: SpinnerProps) {
  const intl = useContext(IntlContext);
  const defaultLabel =
    intl?.formatMessage({ id: "common.loadingLabel" }) ?? en["common.loadingLabel"];

  return (
    <span
      {...props}
      role="status"
      aria-label={label ?? defaultLabel}
      className={[
        "inline-block shrink-0 rounded-full animate-spin",
        SIZE_CLASS[size],
        VARIANT_CLASS[variant],
        className,
      ].filter(Boolean).join(" ")}
    />
  );
}
