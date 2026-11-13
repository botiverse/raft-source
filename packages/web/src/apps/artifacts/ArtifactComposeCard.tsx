import { useCallback, useRef } from "react";
import type { ComponentProps } from "react";
import { useIntl } from "react-intl";
import { X } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import type { ArtifactCommentAnchor } from "@botiverse/raft-shared";

import { DraftPlace } from "./ArtifactActorParts";
import ArtifactCommentBox from "./ArtifactCommentBox";

/**
 * A new comment's card, the same however it was started: a selection or a
 * picked block in comment mode (ArtifactSelectionComposer), a selection in a
 * file's view, or the page's own Comment button (ArtifactCommentBubble's
 * ComposeBubble). What it is on, then ×, then the box. The two callers place
 * it, both on the one surface (ArtifactCardShell: a popover on a desktop, a
 * sheet on a phone); nothing in the card itself differs between them.
 *
 * × drops the words written in the box, then closes the card (`onClose`);
 * closed any other way, they are kept. On a phone too: swiping the sheet away
 * keeps them, so × is how they are dropped. The dropping is the box's own
 * (`discardRef`: what its Cancel does in an edit or a reply), the one path
 * there is, so nothing kept for this box outlives its ×.
 */
export function ArtifactComposeCard({ place, onClose, box, testId, placeTestId, cancelTestId }: {
  /** Where the comment goes; null for a comment on the Artifact as a whole. */
  place: ArtifactCommentAnchor | null;
  /** Close the card: after ×, its words already dropped. */
  onClose: () => void;
  /** The box, without a Cancel of its own: the card's × is it. */
  box: Omit<ComponentProps<typeof ArtifactCommentBox>, "onCancel" | "discardRef">;
  testId?: string;
  placeTestId: string;
  cancelTestId: string;
}) {
  const { formatMessage } = useIntl();
  const discard = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => {
    discard.current?.();
    onClose();
  }, [onClose]);
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-start gap-2">
        <p className="line-clamp-2 min-w-0 flex-1 text-footnote text-foreground-muted" data-testid={place ? placeTestId : undefined}>
          {place ? <DraftPlace anchor={place} /> : null}
        </p>
        <Button variant="ghost" size="icon-md" className="-mt-1.5 -me-1.5 shrink-0" aria-label={formatMessage({ id: "artifacts.comments.cancel" })} onClick={cancel} data-testid={cancelTestId}>
          <X />
        </Button>
      </div>
      <ArtifactCommentBox {...box} discardRef={discard} />
    </div>
  );
}
