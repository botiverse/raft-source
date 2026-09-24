export const MASTER_DETAIL_COMPACT_PANEL_BOUNDS = {
  min: 320,
  max: 480,
  defaultWidth: 320,
} as const;

interface ResolveMasterDetailPanelWidthOptions {
  isLargeViewport: boolean;
  isCompactLayout: boolean;
  wideWidth: number;
  compactWidth: number;
}

/**
 * Activity and Search share the same master/detail column policy:
 * wide at lg+, compact at tablet widths or when a third pane is open.
 */
export function resolveMasterDetailPanelWidth({
  isLargeViewport,
  isCompactLayout,
  wideWidth,
  compactWidth,
}: ResolveMasterDetailPanelWidthOptions): number {
  return isLargeViewport && !isCompactLayout ? wideWidth : compactWidth;
}
