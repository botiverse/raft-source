import { useContext } from "react";
import type { ReactNode } from "react";

import { PanelHeadChromeContext } from "./panelHeadChrome";

/**
 * What a panel standing in the planned row as a section (the Artifact, the profile: RowRegionChrome) shows under its
 * head. Hidden, still mounted, while a region expanded in its column shows this one as its head alone (#189 rule 5,
 * rowPlanStore `stackFolds`, `PanelHeadChrome.headOnly`); otherwise a box of no layout of its own (`display:
 * contents`), its children laid out by the panel as before. Tasks and Files fold their own bodies (ChannelSideCard).
 */
export function RowRegionBody({ children }: { children: ReactNode }) {
  const headOnly = useContext(PanelHeadChromeContext)?.headOnly ?? false;
  return <div className={headOnly ? "hidden" : "contents"} data-row-region-body={headOnly ? "head-only" : ""}>{children}</div>;
}
