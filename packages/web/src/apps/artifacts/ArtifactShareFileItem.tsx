import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Share } from "lucide-react";
import { DropdownMenuItem, useToast } from "@botiverse/raft-ui";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { useOwnerWindow } from "../../utils/ownerDocument";
import { trackArtifactViewerAction } from "./artifactAnalytics";
import { readsInOwnServer } from "./artifactOwnServer";
import { artifactShareFile, artifactShareTarget, offersArtifactShare, shareArtifactFile } from "./artifactShareFile";
import type { ArtifactShareTarget } from "./artifactShareFile";
import { artifactSource } from "./artifactSource";
import { POLITE_ERROR } from "./artifactToasts";

/** The file read for a target: the File to share, or null where the read failed. */
interface ShareRead {
  target: ArtifactShareTarget;
  file: File | null;
}

/**
 * ⋯'s Share (#proj-workspace:#346, artifactShareFile.ts): the version's file
 * itself to the system share sheet. Offered as Download is (the Artifact's own
 * server's reader: readsInOwnServer), and only where this browser shares such
 * a file; otherwise nothing is drawn. The menu's items mount as it opens, so
 * the bytes are read then and the File kept: the click calls navigator.share
 * at once, inside its user activation, which an await before it would lose
 * (Safari: NotAllowedError). Disabled until the bytes are in. A cancelled
 * sheet says nothing; any other failure, a failed read too, says so in a toast.
 */
export function ArtifactShareFileItem({ data, testId }: { data: ArtifactViewerData; testId: string }) {
  const { formatMessage } = useIntl();
  const toast = useToast();
  // The window the menu is drawn in (an object window's own): its navigator is the click's.
  const ownerWindow = useOwnerWindow();
  const nav = ownerWindow?.navigator;
  const { id, version } = data.card;
  const target = useMemo(() => (readsInOwnServer(data.card) ? artifactShareTarget(data) : null), [data]);
  const offered = useMemo(() => target !== null && offersArtifactShare(target, nav), [target, nav]);
  const [read, setRead] = useState<ShareRead | null>(null);
  useEffect(() => {
    if (!offered || !target) return;
    let current = true;
    artifactSource().readBytes({ id, version, path: target.path }).then(
      (bytes) => {
        if (current) setRead({ target, file: artifactShareFile(target, bytes) });
      },
      () => {
        if (current) setRead({ target, file: null });
      },
    );
    return () => {
      current = false;
    };
  }, [offered, target, id, version]);
  const ready = read !== null && read.target === target ? read : null;
  const failed = useCallback(() => {
    toast.error(formatMessage({ id: "message.share.failed" }), POLITE_ERROR);
  }, [formatMessage, toast]);
  const share = useCallback(() => {
    if (!ready || !nav) return;
    trackArtifactViewerAction("share");
    if (!ready.file) {
      failed();
      return;
    }
    // No await before it: navigator.share is called in this click.
    void shareArtifactFile(ready.file, nav).catch(failed);
  }, [ready, nav, failed]);
  if (!offered) return null;
  return (
    <DropdownMenuItem onClick={share} disabled={ready === null} data-testid={`${testId}-share`}>
      <Share />
      {formatMessage({ id: "artifacts.menu.share" })}
    </DropdownMenuItem>
  );
}
