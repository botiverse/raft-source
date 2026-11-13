import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { HTMLAttributes, ReactNode, Ref } from "react";
import {
  Banner,
  BannerAction,
  BannerClose,
  BannerDescription,
  BannerTitle,
} from "@botiverse/raft-ui";
import Tooltip from "./Tooltip";

/**
 * Thin product adapter over the public RUI Banner composition. RUI owns the
 * visual recipe and status semantics while callers provide product content.
 *
 * Raft Design System › Banner: one soft wash per intent (info cyan, warning
 * orange, destructive red, success lime), ink text and ink icon, a hairline
 * and no ink frame. A problem is orange; red is only for consequences that
 * cannot be taken back.
 */

export type BannerIntent = "destructive" | "warning" | "info" | "success";

const NON_LIVE = { role: undefined };
export type BannerDensity = "sm" | "md" | "lg";

// Default icon per intent — the DS banner glyphs (Lucide, 20px). NOT
// auto-rendered — the dominant inline pattern is iconless, so we render an
// icon only when the caller explicitly passes one. To get the conventional
// intent icon, callers can either pass `withIcon` (boolean) or any
// ReactNode via `icon`. The map exists so `withIcon` has a predictable lookup.
const INTENT_DEFAULT_ICON: Record<BannerIntent, ReactNode> = {
  destructive: <OctagonAlert size={20} aria-hidden="true" />,
  warning: <TriangleAlert size={20} aria-hidden="true" />,
  info: <Info size={20} aria-hidden="true" />,
  success: <CircleCheck size={20} aria-hidden="true" />,
};

/** `onClose` renders raft-ui's `BannerClose` (the ×) for a banner with no
 *  button; `closeLabel`, required with it, is its localized accessible name
 *  and tooltip. A banner that has `actions` closes with a ghost Dismiss among
 *  them instead (Raft Design System › Banner). */
type BannerCloseProps =
  | { onClose?: () => void; closeLabel: string }
  | { onClose?: undefined; closeLabel?: undefined };

interface BannerBaseProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** The banner's root element, e.g. to tell whether focus is inside it
   *  before it goes away. */
  ref?: Ref<HTMLDivElement>;
  /** Semantic status forwarded to the RUI recipe. */
  intent: BannerIntent;
  /** Density forwarded to the RUI size register. */
  density?: BannerDensity;
  /** Optional bold heading rendered above the body. */
  title?: ReactNode;
  /** Banner body. Most callsites pass a `<p>`-worthy string but any
   *  ReactNode (links, button rows) is fine. */
  children?: ReactNode;
  /** Convenience flag — render the conventional intent icon
   *  (OctagonAlert / TriangleAlert / Info / CircleCheck). When
   *  `false` (default), banner renders without an icon — matching
   *  the dominant inline pattern. */
  withIcon?: boolean;
  /** Override the icon entirely with a custom node. Takes
   *  precedence over `withIcon`. Useful for waiting indicators
   *  (pulsing dot) or task-specific icons. */
  icon?: ReactNode;
  /** Optional action slot: the banner's one button, with a ghost Dismiss
   *  before it when the banner can be dismissed. raft-ui places it at the
   *  bottom right; don't put a × here, use `onClose`. */
  actions?: ReactNode;
  /** RUI's Banner announces itself as a live `role="alert"`. Pass `false`
   *  for a notice that is part of the page (read before acting) rather than
   *  news, so assistive tech does not interrupt with it. */
  live?: boolean;
}

export type BannerProps = BannerBaseProps & BannerCloseProps;

export default function AppBanner({
  intent,
  density = "md",
  title,
  children,
  icon,
  withIcon = false,
  actions,
  onClose,
  closeLabel,
  live = true,
  className = "",
  ...rest
}: BannerProps) {
  const resolvedIcon = icon !== undefined ? icon : (withIcon ? INTENT_DEFAULT_ICON[intent] : null);
  return (
    <Banner {...rest} {...(live ? null : NON_LIVE)} status={intent} size={density} className={className}>
      {resolvedIcon}
      {title ? <BannerTitle>{title}</BannerTitle> : null}
      {children ? <BannerDescription>{children}</BannerDescription> : null}
      {actions ? <BannerAction>{actions}</BannerAction> : null}
      {onClose ? (
        <Tooltip content={closeLabel}>
          <BannerClose type="button" onClick={onClose} aria-label={closeLabel} />
        </Tooltip>
      ) : null}
    </Banner>
  );
}
