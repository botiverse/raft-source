import type { ReactNode, Ref } from "react";
import { Button } from "@botiverse/raft-ui";
import AttentionDot from "../ui/AttentionDot";
import Tooltip from "../ui/Tooltip";

// Its tooltip opens under the bar, like the Bell's, never up into the title
// bar's band (the caption buttons on Windows).
const TOP_BAR_TOOLTIP = { side: "bottom" } as const;

export interface TopBarUpdateButtonProps {
  /** The visible label ("Update", the desktop's "Restart to Update"), or the icon of an `iconOnly` button. */
  children: ReactNode;
  /** A square icon button where the bar has no room for the label (WebUpdateButton). */
  iconOnly?: boolean;
  /** The full accessible name: what is ready and what a click does. */
  label: string;
  tooltip: ReactNode;
  onClick: () => void;
  testId: string;
  dotTestId: string;
  /** The outer box, the region's item (its width is the button's). */
  ref?: Ref<HTMLSpanElement>;
}

/**
 * The top bar's Update button, before who is working (Raft Design System ›
 * Page structure › Top bar; Raft Chat: "an Update button with a pink pixel
 * when it is ready"). One component for the desktop app's ready update
 * (apps/desktop DesktopUpdatePill, "Restart to Update") and the web's newer
 * published release (WebUpdateButton, "Update").
 *
 * An update waits for you, but it is not the screen's reason to exist, so it
 * is not pink (one pink per screen: the composer's Send). Like the bar's
 * search field it is an ink-outline 36px frame item, and like the Bell it
 * carries the pink attention pixel on its corner.
 */
export function TopBarUpdateButton({ children, iconOnly = false, label, tooltip, onClick, testId, dotTestId, ref }: TopBarUpdateButtonProps) {
  return (
    <span ref={ref} className="relative isolate inline-flex shrink-0">
      <Tooltip content={tooltip} contentProps={TOP_BAR_TOOLTIP}>
        <Button
          variant="outline"
          size={iconOnly ? "icon-md" : "md"}
          className={iconOnly ? "size-9" : "h-9"}
          aria-label={label}
          data-testid={testId}
          onClick={onClick}
        >
          {children}
        </Button>
      </Tooltip>
      <AttentionDot
        aria-hidden
        data-testid={dotTestId}
        className="pointer-events-none absolute -right-1 -top-1 z-raised"
      />
    </span>
  );
}
