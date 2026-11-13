import { useCallback, useContext } from "react";
import { useIntl } from "react-intl";
import { Maximize2, Minimize2 } from "lucide-react";
import { PanelToggleAction } from "@botiverse/raft-ui";

import Tooltip from "../ui/Tooltip";
import { RowRegionContext, toggleRowExpand, useRowExpand } from "./rowPlanStore";

/**
 * #189 rule 5: a region's Expand, the same in every head (Tasks, Files, the Artifact, the profile, the thread, whose
 * Focus Mode it is, and the conversation). It makes the region's column fill the row, the others 160 and clipped, and,
 * in a column that stacks regions, the region fill its height, the others their heads alone (rowPlanStore
 * `stackExpanded`); pressed again, or Escape, the row is as it was before, to the pixel. One region at a time, and
 * pressed only on that region's head (`regionPressed`): another head in its column shows it unpressed and moves the
 * expansion there. A window control
 * (raft-design panel.md, Rules): right before Close, after ⋯, never in it. Shown only where the row has more than
 * one column, and always on the column expanded, so it can come back (rowPlanStore `useRowExpand`); none where the
 * row isn't planned (a phone: the panel already fills the screen). `region` defaults to the panel's (RowRegionContext).
 */
export function RowExpandAction({ region, testId, onExpand }: { region?: string; testId?: string; /** Called when it expands (not when it restores): the Artifact's `maximize` event. */ onExpand?: () => void }) {
  const contextRegion = useContext(RowRegionContext);
  const own = region ?? contextRegion ?? "";
  const { shown, pressed } = useRowExpand(own);
  const toggle = useCallback(() => {
    if (!pressed) onExpand?.();
    toggleRowExpand(own);
  }, [onExpand, own, pressed]);
  if (!shown) return null;
  return <ExpandToggleAction pressed={pressed} onPressedChange={toggle} testId={testId ?? `row-expand-${own}`} />;
}

/**
 * Expand as a head shows it (RowExpandAction's, the thread's Focus Mode): Expand, pressed Restore, with its tooltip.
 * For a head whose Expand comes from elsewhere, as the Tasks page's task's (TasksRoute, TaskFocusContext).
 */
export function ExpandToggleAction({ pressed, onPressedChange, testId }: { pressed: boolean; onPressedChange: () => void; testId: string }) {
  const { formatMessage } = useIntl();
  const label = formatMessage({ id: pressed ? "artifacts.viewer.restore" : "artifacts.viewer.expand" });
  return (
    <Tooltip content={label}>
      <PanelToggleAction
        aria-label={label}
        pressed={pressed}
        onPressedChange={onPressedChange}
        data-testid={testId}
        data-row-expand=""
      >
        {pressed ? <Minimize2 /> : <Maximize2 />}
      </PanelToggleAction>
    </Tooltip>
  );
}
