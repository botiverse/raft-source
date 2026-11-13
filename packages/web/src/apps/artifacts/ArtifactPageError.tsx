import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import { TriangleAlert, X } from "lucide-react";
import { Button, PanelNotice, PanelNoticeActions, PanelNoticeContent } from "@botiverse/raft-ui";

import Tooltip from "../../components/ui/Tooltip";
import { clipPageError } from "./useArtifactPageErrors";
import type { ArtifactPageErrors } from "./useArtifactPageErrors";

/** The strip over the frame's top, under the panel header: the title, the first message as text, Let the Agent Fix It and ×. */
export function ArtifactPageErrorNotice({ errors }: { errors: ArtifactPageErrors }) {
  const { formatMessage } = useIntl();
  const { send, dismiss } = errors;
  // The strip goes (or its button turns off): focus goes to the surface, never left on the document.
  const sendHere = useCallback((event: MouseEvent<HTMLElement>) => {
    event.currentTarget.closest<HTMLElement>("[data-artifact-focus]")?.focus();
    send();
  }, [send]);
  const dismissHere = useCallback((event: MouseEvent<HTMLElement>) => {
    event.currentTarget.closest<HTMLElement>("[data-artifact-focus]")?.focus();
    dismiss();
  }, [dismiss]);
  const first = errors.shown[0];
  if (first === undefined) return null;
  const dismissLabel = formatMessage({ id: "artifacts.pageError.dismiss" });
  return (
    <PanelNotice status="warning" role="status" data-testid="artifact-page-error" data-count={errors.shown.length}>
      <TriangleAlert aria-hidden />
      <PanelNoticeContent className="min-w-0 truncate">
        {formatMessage({ id: "artifacts.pageError.title" })}
        <bdi dir="auto" className="ms-1 font-normal text-foreground-muted" data-testid="artifact-page-error-message">
          {clipPageError(first)}
        </bdi>
      </PanelNoticeContent>
      <PanelNoticeActions>
        <Button variant="ghost" size="md" onClick={sendHere} disabled={errors.sending} data-testid="artifact-page-error-fix">
          {formatMessage({ id: "artifacts.pageError.fix" })}
        </Button>
        <Tooltip content={dismissLabel}>
          <Button variant="ghost" size="icon-md" aria-label={dismissLabel} onClick={dismissHere} disabled={errors.sending} data-testid="artifact-page-error-dismiss">
            <X />
          </Button>
        </Tooltip>
      </PanelNoticeActions>
    </PanelNotice>
  );
}
