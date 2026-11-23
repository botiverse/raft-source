import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { AppWindow, ArrowUpRight } from "lucide-react";
import { DropdownMenuItem } from "@botiverse/raft-ui";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { openInSystemBrowser, useObjectWindow } from "../../features/objectWindows";
import { artifactUrl } from "./artifactLinks";
import { isNewWindowClick, openArtifactInWindow, useArtifactMiniWindows } from "./artifactWindowOpening";
import { artifactOpenLabelId, openArtifactWindow } from "./artifactWindow";

/**
 * The viewer's ⋯ first item, the Artifact somewhere else (ArtifactViewerMenu):
 * - in an Artifact's object window, Open in system browser: its address in the system browser, always (#337 PR3);
 * - in Raft Desktop with the Artifact mini window (artifactWindowOpening.ts), Open in new window, with a window icon:
 *   the reused Artifact window, another with Cmd/Ctrl held; its `artifact_opened` is `link`, as the page this item
 *   opened before counted it (focus goes nowhere when it closes: the menu that opened it is gone);
 * - elsewhere Open in new page, as before (artifactWindow: its own window where Raft is installed on a computer).
 * Addresses are built from the id, never taken from the payload.
 */
export function ArtifactOpenElsewhereItem({ card }: { card: Pick<ArtifactCard, "id" | "pinned" | "version" | "title"> }) {
  const { formatMessage } = useIntl();
  const inWindow = useObjectWindow() !== null;
  const miniWindows = useArtifactMiniWindows();
  const version = card.pinned ? card.version : null;
  const open = useCallback((event: MouseEvent<HTMLElement>) => {
    const url = artifactUrl(card.id, version);
    if (inWindow) {
      if (!openInSystemBrowser(url)) openArtifactWindow(url, card.id);
      return;
    }
    const opened = openArtifactInWindow({ id: card.id, version }, { enabled: miniWindows, source: "link", additional: isNewWindowClick(event), title: card.title });
    if (!opened) openArtifactWindow(url, card.id);
  }, [card.id, card.title, version, inWindow, miniWindows]);
  if (inWindow) {
    return (
      <DropdownMenuItem onClick={open} data-testid="artifact-window-menu-open-in-system-browser">
        <ArrowUpRight />
        {formatMessage({ id: "artifacts.window.openInSystemBrowser" })}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem onClick={open} data-testid="artifact-viewer-menu-open-in-new-page">
      {miniWindows ? <AppWindow /> : <ArrowUpRight />}
      {formatMessage({ id: miniWindows ? "artifacts.card.openInNewWindow" : artifactOpenLabelId("artifacts.card.openInNewPage") })}
    </DropdownMenuItem>
  );
}
