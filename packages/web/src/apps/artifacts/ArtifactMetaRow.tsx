import type { ReactNode } from "react";
import { PanelMeta } from "@botiverse/raft-ui";

/**
 * The Artifact header's line under the title, in two parts (stdrc's option
 * A, #proj-raft-ui:7531279d):
 *
 * - `text`: where it lives and its original message, in raft-ui PanelMeta,
 *   which truncates (overflow hidden): its parts give way, down to nothing on
 *   the narrowest card. It is as wide as what it says, never wider (no
 *   flex-1), so
 * - `readers`: who's here and who read it (ArtifactPresence) follow it right
 *   after the line's gap, as one line, not at the far end of the row beside
 *   the header actions (stdrc, #12699). They sit beside PanelMeta rather than
 *   in it, never shrinking, so they stay whole at every width and nothing
 *   clips their focus ring.
 *
 * The row is as tall as the readers' trigger from the first paint (27px),
 * whether or not anyone is listed yet, so the title doesn't move when
 * presence arrives.
 *
 * Two columns (#proj-workspace:#286): the text's may give way to nothing, the
 * readers' never does, so the row is never narrower than the readers and they
 * can't run past it onto the header's first action. (It was a size container,
 * which made it 0 wide beside the title on a desktop: the readers spilled over
 * Open in New Page, and their count never showed.) The head's fold counts the
 * readers beside the title (useHeadReadersWidth), and the head's content is
 * the container their count measures: under 16rem, faces alone
 * (ArtifactPresence; on a phone they are faces alone).
 */
export function ArtifactMetaRow({ text, readers = null, testId }: { text: ReactNode; readers?: ReactNode; testId?: string }) {
  return (
    <div className="grid min-h-[27px] grid-cols-[minmax(0,auto)_auto] items-center gap-2" data-artifact-meta-row="" data-testid={testId}>
      <PanelMeta render={<div />} className="flex min-w-0 items-center gap-2" data-testid="artifact-meta-text">
        {text}
      </PanelMeta>
      {readers}
    </div>
  );
}
