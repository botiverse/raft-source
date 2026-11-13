import type { HTMLAttributes, ReactNode, Ref } from "react";
import { PanelHeaderContent, PanelMeta, PanelSectionHeader, PanelTitle } from "@botiverse/raft-ui";

type DivPassthroughProps = HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;

export type TabRootBarProps = {
  /** The page name: the bar's title, and the page's heading. */
  name: ReactNode;
  /** One line under the name, shown at rest (counts in `font-mono`). */
  subtitle?: ReactNode;
  /** Replaces the name and subtitle in the bar (Home: the workspace pill, who
   *  is working and the bell; Search: its field). The name then stays the
   *  heading, `sr-only`. */
  content?: ReactNode;
  /** 1 on a phone tab root, where the name is the page's one h1; 2 for the
   *  same page's head on desktop, a column under the app's own chrome. */
  headingLevel?: 1 | 2;
  /** Passed to the bar (e.g. `data-testid`, `title`). */
  containerProps?: DivPassthroughProps;
  /** Passed to the name block (e.g. `data-testid`, `onClick`). */
  titleProps?: DivPassthroughProps;
  ref?: Ref<HTMLDivElement>;
};

/**
 * The top bar of a phone tab root — Home, Activity, Tasks, Search and More —
 * in one place so the five cannot drift (design lead + artin 2026-10-21, as in the
 * mobile app): raft-ui's `PanelSectionHeader`, 56px (48 in short windows) on
 * the frame with its seam, sticky, and nothing under it but the page. No
 * large title and no icon tile. The page name sits in the bar in
 * `text-headline` with one subtitle line when the page has one; Home shows
 * its own content instead. From `md` up it is the same head as every panel.
 */
export function TabRootBar({ name, subtitle, content, headingLevel = 1, containerProps, titleProps, ref }: TabRootBarProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  return (
    <PanelSectionHeader {...containerProps} ref={ref} data-tab-root-bar="">
      {content ? (
        <>
          <Heading className="sr-only">{name}</Heading>
          {content}
        </>
      ) : (
        <PanelHeaderContent {...titleProps}>
          <PanelTitle render={<Heading>{name}</Heading>} />
          {subtitle != null && <PanelMeta render={<p />}>{subtitle}</PanelMeta>}
        </PanelHeaderContent>
      )}
    </PanelSectionHeader>
  );
}
