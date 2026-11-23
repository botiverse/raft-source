/**
 * An Artifact object window's head row is the window's title bar (#337 PR3, ArtifactViewer `inWindow`): titleBar.css
 * pads a `data-raft-titlebar` row clear of the window's controls (from the object window's own frame,
 * features/objectWindows objectWindowChrome.ts) and makes it the drag region, its controls still pressable.
 */
export const WINDOW_TITLE_BAR = { "data-raft-titlebar": "" } as const;
