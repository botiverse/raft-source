import { forwardRef, useCallback } from "react";
import { AppRailItem, AppRailItemAttention, AppRailItemIcon, AppRailItemLabel } from "@botiverse/raft-ui";

import Tooltip from "../ui/Tooltip";

/** A rail item's tooltip goes beside the rail, on the side away from it. */
const TOOLTIP_CONTENT_PROPS = {
  left: { side: "left" },
  right: { side: "right" },
} as const;

/**
 * One of the rail's navigation buttons (LeftRail): its icon, its name in a
 * tooltip to its right, the attention dot, the selected sticker.
 */
type RailTabButtonProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children" | "onClick" | "onDoubleClick" | "aria-label" | "aria-haspopup" | "aria-expanded"
> & {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  showDot?: boolean;
  dotInactiveOnly?: boolean;
  dotTooltip?: string;
  tooltipSide?: "left" | "right";
  onClick: (event: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  testId?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  showTooltip?: boolean;
};

export const RailTabButton = forwardRef<HTMLButtonElement, RailTabButtonProps>(function RailTabButton({
  icon,
  label,
  active,
  showDot,
  dotInactiveOnly,
  dotTooltip,
  tooltipSide = "right",
  onClick,
  onDoubleClick,
  testId,
  onPointerDown,
  buttonRef,
  ariaHasPopup,
  ariaExpanded,
  showTooltip = true,
  className = "",
  ...buttonProps
}, forwardedRef) {
  const dotVisible = Boolean(showDot && (!dotInactiveOnly || !active));
  const setButtonRefs = useCallback((node: HTMLButtonElement | null) => {
    setReactRef(buttonRef, node);
    setReactRef(forwardedRef, node);
  }, [buttonRef, forwardedRef]);
  const button = (
    <AppRailItem
      {...buttonProps}
      ref={setButtonRefs}
      selected={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-label={label}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      data-testid={testId}
      onPointerDown={onPointerDown}
      // Raft Design System › Rail: 40×40 items, 36×36 when the window is
      // under 600 tall (the heads shrink to 48 with them).
      className={`size-(--rail-item) [@media(max-height:600px)]:h-9 [@media(max-height:600px)]:w-9 ${className}`}
    >
      <AppRailItemIcon className="relative">
        {icon}
        {dotVisible ? (
          <AppRailItemAttention title={dotTooltip ?? label} />
        ) : null}
      </AppRailItemIcon>
      <AppRailItemLabel>{label}</AppRailItemLabel>
    </AppRailItem>
  );

  return showTooltip ? (
    <Tooltip
      content={dotVisible && dotTooltip ? dotTooltip : label}
      contentProps={TOOLTIP_CONTENT_PROPS[tooltipSide]}
    >
      {button}
    </Tooltip>
  ) : button;
});

function setReactRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

