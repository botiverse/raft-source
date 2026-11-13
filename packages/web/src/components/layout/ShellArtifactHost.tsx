import { useMemo } from "react";
import { useLocation } from "react-router-dom";

import { ArtifactCoverViewer, useArtifactShell, useShellArtifactCard } from "../../apps/artifacts";
import { ChannelSideFloatSlot, SideArtifactPortal } from "../task/ChannelSideArea";
import type { SideAreaArtifact } from "../task/ChannelSideArea";
import { shellPageOf } from "./artifactViewerAddress";

/**
 * The app shell's place for an Artifact clicked where no channel panel is
 * (the opening rule, #proj-workspace:#104; docs/development/workspace-artifacts.md
 * "Where an Artifact opens"): a thread Activity or Search opened in its main
 * area, Saved, a legacy Files tab, a task's dialog. Mounted once, in the
 * workspace row (MainLayout), so every surface in it opens Artifacts in place
 * without wiring anything.
 *
 * Its viewer is the same card of the same side area as beside a channel
 * (ChannelSideArea): a column of the row beside the main area, expanded over
 * the whole row, covering the main area on a phone (with Back and a history
 * entry) through its float slot, which spans the row. One opened in a dialog
 * covers that dialog instead (ArtifactCoverViewer). Leaving the page (the
 * address changes) closes either. Either is the page's address too
 * (`?artifact=`, useArtifactViewerAddress).
 */
export default function ShellArtifactHost() {
  const location = useLocation();
  // Its Artifact's own address (`?artifact=`, useArtifactViewerAddress) is not another page.
  useArtifactShell(shellPageOf(location.pathname, location.search));
  const card = useShellArtifactCard();
  const artifact = useMemo<SideAreaArtifact | null>(() => (card ? {
    icon: card.icon,
    openedAt: card.openedAt,
    minWidth: card.minWidth,
    expanded: card.expanded,
  } : null), [card]);
  return (
    <>
      {card && artifact ? (
        <>
          <SideArtifactPortal title={card.label} artifact={artifact} render={card.render} />
          {/* Floating or covering, over the main area; nothing else here takes the pointer. */}
          <div className="pointer-events-none absolute inset-0 *:pointer-events-auto" data-testid="shell-artifact-float">
            <ChannelSideFloatSlot />
          </div>
        </>
      ) : null}
      <ArtifactCoverViewer />
    </>
  );
}
