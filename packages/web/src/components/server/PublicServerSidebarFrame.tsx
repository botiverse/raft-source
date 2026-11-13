import type { ReactNode } from "react";
import { ScrollArea, SidebarHeader, SidebarHeaderTitle, SidebarRoot } from "@botiverse/raft-ui";

/** Frame shared by the two side columns of the public server page (channels
 *  and settings): the rui SidebarRoot, a header row and a scroll surface.
 *
 *  The head is raft-ui's SidebarHeader, the same head as the signed-in
 *  Sidebar's (on a phone, where the column is the page, the frame). The root
 *  and scroll surface classes mirror the signed-in column; they are measured
 *  against it in a real browser rather than imported, because importing from
 *  Sidebar.tsx would pull the member stores into the anonymous page. */
export default function PublicServerSidebarFrame({
  title,
  testIdPrefix,
  scrollTestId,
  children,
}: {
  title: string;
  testIdPrefix: string;
  scrollTestId: string;
  children: ReactNode;
}) {
  return (
    <SidebarRoot
      className="relative flex h-full w-full flex-col border-r border-line-seam bg-layer-sidebar font-display text-foreground select-none"
      data-testid={`${testIdPrefix}-root`}
    >
      <SidebarHeader data-testid={`${testIdPrefix}-header`}>
        <SidebarHeaderTitle render={<h1>{title}</h1>} />
      </SidebarHeader>
      {/* No padding of its own: the rows are list cells that inset their
          own shape 8px and their content 12px inside it, and their list
          (a gap-0.5 py-2 column) puts the first shape 8px below the
          head's seam, level with the rail's first button below the rail's
          server cell, as the signed-in list does (raft-design patterns/lists.md).
          A raft-ui ScrollArea shown while it scrolls, as the signed-in
          Sidebar's and raft-ui's SidebarContent; the bottom room is the
          content's. */}
      <ScrollArea trigger="scroll" className="min-h-0 flex-1" contentClassName="pb-2" data-testid={scrollTestId}>
        {children}
      </ScrollArea>
    </SidebarRoot>
  );
}
