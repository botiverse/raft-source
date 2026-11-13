import { createContext } from "react";
import type { ReactNode } from "react";

/**
 * What a region of the planned row adds to its panel's head (#189: the profile's, the Artifact's), given by the panel's
 * host (RowRegionChrome) so the head itself (AppPanelHeader, the Artifact viewer's) imports nothing of the row: the
 * grip that moves it (rule 7) with the head's props it needs, its column's tabs in place of its title (rule 4), and
 * whether it shows as its head alone (rule 5: a region expanded in its column; the panel's RowRegionBody hides the rest).
 */
export interface PanelHeadChrome {
  props: { className?: string; "data-side-head"?: string; "data-stack-end"?: string };
  grip: ReactNode;
  tabs: ReactNode | null;
  headOnly: boolean;
}

export const PanelHeadChromeContext = createContext<PanelHeadChrome | null>(null);

/**
 * What leads a side window's head, before its title, when the window holds a second thing behind this one
 * (desktop_web_preview_view_v0: the built-in browser parked behind the Artifact; features/webPreview's
 * useArtifactPlaceCard gives it). `node` is drawn at the very start of the head (after Back, where the panel covers);
 * `width` is the room it takes there, which the head's fit counts (headFit's `leadWidth`). Null everywhere else: the
 * head is exactly what it is without it.
 */
export interface PanelHeadLead {
  node: ReactNode;
  width: number;
}

export const PanelHeadLeadContext = createContext<PanelHeadLead | null>(null);
