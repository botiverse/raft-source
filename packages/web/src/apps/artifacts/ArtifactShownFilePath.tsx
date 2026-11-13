import type { ArtifactViewerData } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { useShownFile } from "./artifactShownFile";

/**
 * The header's word for a file that isn't the entry (#proj-workspace:#272; Kirby): its name, grey,
 * after the title, only while such a file is shown; its whole path on hover (the folders are in
 * the Files panel's row). The title comes first:
 *
 * - it takes only the room the title leaves (it grows from nothing, capped at its own width, and
 *   is cut at its end), so it never costs the title a letter nor lies over the header's buttons;
 * - a narrow header (a phone, the in-app viewer in a narrow pane) shows none: the header's content
 *   area is the query container (`@container` on the shell's PanelHeaderContent, which has the
 *   room the header's buttons leave; the heading itself is only as wide as its words), so it goes
 *   by that room, not the window's. The current row in the Files panel still says which file is
 *   shown.
 *
 * No Back beside it: the entry's row is the way back, and so is the browser's Back on the
 * Artifact's own page.
 */
export function ArtifactShownFilePath({ data }: { data: Pick<ArtifactViewerData, "files"> }) {
  const { file, entry } = useShownFile(data);
  if (!file || entry) return null;
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return (
    <Tooltip content={file.path}>
      <span className="hidden min-w-0 max-w-max flex-[1_1_0] truncate text-callout text-foreground-hint @[26rem]:block" data-testid="artifact-shown-file-path">
        {name}
      </span>
    </Tooltip>
  );
}
