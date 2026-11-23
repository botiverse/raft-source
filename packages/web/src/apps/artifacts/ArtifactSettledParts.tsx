import { useIntl } from "react-intl";
import { Check, CircleCheck, CircleDashed, Undo2 } from "lucide-react";
import { Badge, Button, DropdownMenuItem } from "@botiverse/raft-ui";
import type { ArtifactCard, ArtifactSettled } from "@botiverse/raft-shared";

import Tooltip from "../../components/ui/Tooltip";
import { useArtifactReaderId } from "./artifactAuthorText";
import { artifactSettledLine } from "./artifactSettled";
import type { ArtifactSettle } from "./useArtifactSettle";

/**
 * Settled (#334) as drawn: the tag, ⋯'s Settle or Unsettle, the details' Status.
 *
 * The tag: one small tag, the same on every surface: after the version tag in the viewer's head and on a chat
 * card, after the title on the home page. Soft success, so it reads as done and stays quieter than the pink sticker,
 * the one "something is new for you" signal. Its tooltip says who, when and at which version, as the app's other tags
 * with a tooltip (AppBadge, ChannelSlackSyncBadge): no tab stop of its own on every settled tile and row; a screen
 * reader reads the same words with the tag, and the viewer's details say them in Status. Raised over a card's
 * covering link (`relative z-raised`), so hovering it shows the tooltip instead of opening the card.
 */
export function ArtifactSettledTag({ settled }: { settled: ArtifactSettled }) {
  const intl = useIntl();
  const readerId = useArtifactReaderId();
  const line = artifactSettledLine(settled, readerId, intl);
  return (
    <Tooltip content={line}>
      <Badge appearance="soft" variant="success" className="relative z-raised shrink-0 cursor-default" data-testid="artifact-settled-tag">
        <Check aria-hidden />
        {intl.formatMessage({ id: "artifacts.settled.tag" })}
        <span className="sr-only">{intl.formatMessage({ id: "artifacts.settled.tagDetail" }, { line })}</span>
      </Badge>
    </Tooltip>
  );
}

/** ⋯'s Settle or Unsettle, leading the Artifact-itself group (ArtifactViewerMenu). */
export function ArtifactSettleMenuItem({ settle, testId }: { settle: ArtifactSettle; testId: string }) {
  const { formatMessage } = useIntl();
  return (
    <DropdownMenuItem onClick={settle.toggle} disabled={settle.busy} data-testid={testId} data-settle={settle.settled ? "unsettle" : "settle"}>
      {settle.settled ? <Undo2 /> : <CircleCheck />}
      {formatMessage({ id: settle.settled ? "artifacts.settled.unsettle" : "artifacts.settled.settle" })}
    </DropdownMenuItem>
  );
}

/**
 * The details' Status (#334): the state in words, who settled it and when, or that a new version took it back to
 * Working, and the one button ⋯ has too (none for a reader who may not comment).
 */
export function ArtifactStatusSection({ card, settle }: { card: ArtifactCard; settle: ArtifactSettle | null }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const readerId = useArtifactReaderId();
  const { settled, reopened } = card;
  const label = formatMessage({ id: settle?.settled ? "artifacts.settled.unsettle" : "artifacts.settled.settle" });
  return (
    <div className="flex min-w-0 flex-col items-start gap-2" data-testid="artifact-details-status-body" data-state={settled ? "settled" : reopened ? "reopened" : "working"}>
      {settled ? (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center"><ArtifactSettledTag settled={settled} /></div>
          <p className="m-0 text-caption text-foreground-muted">{artifactSettledLine(settled, readerId, intl)}</p>
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-1.5 text-callout text-foreground">
            <CircleDashed aria-hidden className="size-3.5 text-foreground-hint" />
            {formatMessage({ id: "artifacts.settled.working" })}
          </div>
          <p className="m-0 text-caption text-foreground-muted" data-testid={reopened ? "artifact-details-reopened" : undefined}>
            {reopened
              ? formatMessage({ id: "artifacts.settled.reopened" }, { version: reopened.version, was: artifactSettledLine(reopened.was, readerId, intl) })
              : formatMessage({ id: "artifacts.settled.workingHint" })}
          </p>
        </div>
      )}
      {settle ? (
        <Button size="sm" variant="outline" onClick={settle.toggle} loading={settle.busy} loadingLabel={label} data-testid="artifact-details-settle" data-settle={settle.settled ? "unsettle" : "settle"}>
          {settle.settled ? <Undo2 aria-hidden /> : <CircleCheck aria-hidden />}
          {label}
        </Button>
      ) : null}
    </div>
  );
}
