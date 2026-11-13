import { useIntl } from "react-intl";
import { SquareCheckBig } from "lucide-react";
import { Button } from "@botiverse/raft-ui";
import { ReopenTaskIcon } from "@botiverse/ricons";
import { CommentCardMeta } from "@botiverse/raft-ui/wip";
import type { ArtifactComment } from "@botiverse/raft-shared";

import { formatRelativeTime } from "../../utils/relativeTime";
import { actorKey } from "./artifactComments";
import { artifactActorName } from "./artifactFacts";
import type { ThreadResolution } from "./useThreadResolution";

/**
 * Resolve on an open thread, Reopen on a resolved one (#249): beside Reply, drawn as Reply is; the
 * icons a task's Mark as Done and Reopen have. While it asks, the button is `loading` (it keeps the
 * focus, which a disabled button would drop to the page).
 */
export function ResolveButton({ resolution }: { resolution: ThreadResolution }) {
  const { formatMessage } = useIntl();
  if (!resolution.may) return null;
  const label = formatMessage({ id: resolution.resolved ? "artifacts.comments.reopen" : "artifacts.comments.resolve" });
  return (
    <Button
      variant="ghost"
      size="md"
      onClick={resolution.toggle}
      loading={resolution.busy}
      loadingLabel={label}
      data-testid={resolution.resolved ? "artifact-comment-reopen" : "artifact-comment-resolve"}
    >
      {resolution.resolved ? <ReopenTaskIcon /> : <SquareCheckBig />}
      {label}
    </Button>
  );
}

/** Who resolved the thread and when (#249): a line about the thread, "Resolved by Remy · 2 hours ago". */
export function ResolvedBy({ root }: { root: ArtifactComment }) {
  const { formatMessage, locale } = useIntl();
  if (!root.resolvedBy || !root.resolvedAt) return null;
  const time = <time dateTime={root.resolvedAt}>{formatRelativeTime(root.resolvedAt, locale) ?? ""}</time>;
  return (
    <CommentCardMeta data-testid="artifact-comment-resolved-by" data-resolver={actorKey(root.resolvedBy)}>
      <SquareCheckBig aria-hidden />
      <span className="min-w-0 truncate">{formatMessage({ id: "artifacts.comments.resolvedBy" }, { name: artifactActorName(root.resolvedBy, formatMessage), time })}</span>
    </CommentCardMeta>
  );
}
