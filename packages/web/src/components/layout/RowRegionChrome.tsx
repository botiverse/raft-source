import { useMemo } from "react";
import type { ReactNode } from "react";
import type { ChannelSideSection } from "@botiverse/raft-shared";

import { useSideSectionHead } from "../task/sideSectionDrag";
import { useStackEndHead } from "../task/stackEnd";
import { PanelHeadChromeContext } from "./panelHeadChrome";
import { RowRegionContext, useRowHeadOnly, useRowInRow, useRowTabs } from "./rowPlanStore";
import { RowTabs } from "./RowTabs";

/**
 * A panel standing in the planned row as a section (#189: the profile, the Artifact): its head gets the real grip
 * where it stands in the row (rule 7), and its column's tabs where the row made it hold others (rule 4); its Expand
 * and Move Left / Move Right read the region (RowRegionContext). Where another region expanded in its column shows it
 * as its head alone (rule 5, `stackFolds`), its RowRegionBody hides the rest.
 */
export function RowRegionChrome({ region, children }: { region: ChannelSideSection; children: ReactNode }) {
  const inRow = useRowInRow(region);
  const head = useStackEndHead(inRow ? region : null, useSideSectionHead(inRow ? region : null, inRow));
  const tabs = useRowTabs(region);
  const headOnly = useRowHeadOnly(region);
  const chrome = useMemo(() => ({ props: head.props, grip: head.grip, tabs: tabs ? <RowTabs region={region} /> : null, headOnly }), [head, headOnly, region, tabs]);
  return (
    <RowRegionContext.Provider value={region}>
      <PanelHeadChromeContext.Provider value={chrome}>{children}</PanelHeadChromeContext.Provider>
    </RowRegionContext.Provider>
  );
}
