import { useCallback } from "react";
import { useIntl } from "react-intl";
import type { ArtifactCard } from "@botiverse/raft-shared";

import { useToast } from "@botiverse/raft-ui";
import { hostMenuItems } from "../../embed";
import { copyTextToClipboard } from "../../utils/selectMarkdown";
import { useOwnerWindow } from "../../utils/ownerDocument";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { artifactUrl } from "./artifactLinks";
import { requestArtifactHostAction } from "./artifactPageOpening";

/**
 * Copies the Artifact's address (this deployment's origin; `/v/<n>` only when pinned) and says so in a toast. On the
 * Artifact page in the App, where it declared `copy-link` (`hostMenu`), the App copies it with the system clipboard and
 * says so itself (`#host=copy-link`; a WebView may refuse the page's write): the App builds the address from the page
 * path, so only the page asks. A copy the browser refused is a warning, as Embed's. The viewer's (⋯, its head) and the
 * home page's tiles' and rows' menu (ArtifactHomeMenu). In the window it is drawn in: its clipboard (an object window's has
 * the focus, not the main window's) and its toasts (useToast: the nearest provider; #337 PR3).
 */
export function useCopyArtifactLink(card: Pick<ArtifactCard, "id" | "pinned" | "version">, surface: "viewer" | "page"): () => void {
  const { formatMessage } = useIntl();
  const toast = useToast();
  const view = useOwnerWindow();
  // Built from the id, never taken from the payload.
  const url = artifactUrl(card.id, card.pinned ? card.version : null);
  return useCallback(() => {
    trackArtifactViewerAction("copy_link");
    if (surface === "page" && hostMenuItems().includes("copy-link")) {
      requestArtifactHostAction("copy-link");
      return;
    }
    void copyTextToClipboard(url, undefined, { view }).then(
      () => toast.success(formatMessage({ id: "artifacts.menu.linkCopied" })),
      () => toast.warning(formatMessage({ id: "artifacts.frame.copyFailed" })),
    );
  }, [url, surface, formatMessage, toast, view]);
}
