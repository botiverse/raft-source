import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Tabs, TabsLabel, TabsList, TabsTab } from "@botiverse/raft-ui";

import type { MessageId } from "../../i18n/messages";
import { pickRowTab, topRegion, useRowTabs } from "./rowPlanStore";

const REGION_TITLE: Record<string, MessageId> = {
  conversation: "message.chatPanel.tabChat",
  thread: "message.threadPanel.thread",
  tasks: "task.panel.heading",
  files: "message.chatPanel.tabFiles",
  artifact: "artifacts.viewer.regionLabel",
  profile: "agent.detail.tab.profile",
  shortcuts: "keyboardShortcuts.title",
};

/**
 * #189 rule 4's last step (the prototype's `tabs`): where the row can't give every column its 160, the rightmost
 * columns become tabs in their left neighbour's head, in place of its title. `region`'s head renders this where it
 * is the column's top head (rowPlanStore `useRowTabs`); null elsewhere, and the head shows its title. A tab shows
 * its column there; which one is shown is presentation only, never saved.
 */
export function RowTabs({ region }: { region: string }) {
  const { formatMessage } = useIntl();
  const tabs = useRowTabs(region);
  const group = tabs?.group ?? null;
  const pick = useCallback((unit: string) => {
    if (group) pickRowTab(group, unit);
  }, [group]);
  if (!tabs) return null;
  const label = (regions: readonly string[]) => regions
    .filter((r) => r !== "conversation" || regions.length === 1)
    .map((r) => (REGION_TITLE[r] ? formatMessage({ id: REGION_TITLE[r]! }) : r))
    .join(" · ");
  return (
    // The title's whole room (the head folds its own actions first, headFit `tabs`); where the tabs don't fit it, the
    // row scrolls sideways under raft-ui's own edge fade, the picked tab kept in view: every tab stays reachable.
    <Tabs<string> value={tabs.active} onValueChange={pick} className="min-w-0" data-testid="row-tabs">
      <TabsList aria-label={formatMessage({ id: "layout.row.tabs" })}>
        {tabs.units.map((unit) => (
          <TabsTab key={unit.key} value={unit.key} data-testid={`row-tab-${topRegion(unit.regions) ?? unit.key}`}>
            <TabsLabel>{label(unit.regions)}</TabsLabel>
          </TabsTab>
        ))}
      </TabsList>
    </Tabs>
  );
}
