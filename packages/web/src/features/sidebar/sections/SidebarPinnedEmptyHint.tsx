import { useIntl } from "react-intl";
import { SidebarSectionDescription } from "./SidebarSectionDescription";

/**
 * Pinned's empty hint ("Drag channels or DMs here to pin"). `reserved`: its
 * box only, invisible and hidden from assistive technology, for a Pinned that
 * is still loading with no pins to draw (none remembered): the hint is what
 * most likely lands there, so the sections below keep their place instead of
 * moving down by its height once the pins are read (skeleton-vs-layout audit,
 * #proj-raft-ui:#231). The same words keep the box the hint's height at every
 * width and in every language.
 */
export function SidebarPinnedEmptyHint({ reserved = false }: { reserved?: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <SidebarSectionDescription
      data-testid={reserved ? "sidebar-pinned-empty-hint-reserved" : "sidebar-pinned-empty-hint"}
      aria-hidden={reserved || undefined}
      tone="subtle"
      className={reserved ? "min-h-9 py-2 transition-colors invisible" : "min-h-9 py-2 transition-colors"}
    >
      <span className="block whitespace-normal break-words">
        {formatMessage({ id: "layout.sidebar.pinnedEmptyHint" })}
      </span>
    </SidebarSectionDescription>
  );
}
