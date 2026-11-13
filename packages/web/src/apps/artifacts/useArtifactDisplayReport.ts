import { useCallback } from "react";
import type { RefObject } from "react";

import { displayReportShownFile, displayReportText, measureDisplayReportFacts } from "./artifactDisplayReport";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { useArtifactListCompose } from "./artifactListCompose";

/**
 * Doesn't display well here (#proj-workspace:#243): no dialog of its own. Chosen, the viewer measures
 * the page as it is now (in `page`, the surface's content box, before the list takes any of its
 * width) and opens the comment list (the phone's comments sheet) with its ordinary box at the foot
 * focused, its lines in it (artifactDisplayReport's fixed English, then an empty line, the caret at the
 * end), on the whole Artifact as everything that box posts (artifactListCompose `composeInList`; the
 * lines name the file shown of a multi-file one). The rest is that box's: @, images, Send.
 * Null where the reader may not comment (`capabilities.comment`).
 */
export function useArtifactDisplayReport(page: RefObject<HTMLElement | null>): (() => void) | null {
  const comments = useArtifactComments();
  const data = comments?.data ?? null;
  const shownPath = comments?.shownPath ?? null;
  const composeInList = useArtifactListCompose()?.composeInList;
  const report = useCallback(() => {
    if (!data || !composeInList) return;
    composeInList(`${displayReportText(measureDisplayReportFacts(page.current, data.card.version), displayReportShownFile(data, shownPath))}\n\n`);
  }, [data, shownPath, composeInList, page]);
  return data?.capabilities.comment && composeInList ? report : null;
}
