import { useCallback, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import type { ArtifactSettled, ArtifactViewerData } from "@botiverse/raft-shared";

import { useToast } from "@botiverse/raft-ui";
import { artifactErrorCode } from "./artifactApi";
import { reportOwnSettle } from "./artifactOwnSettles";
import { settleRefusal, settledShown, withSettled } from "./artifactSettled";
import { artifactSource } from "./artifactSource";
import { POLITE_ERROR } from "./artifactToasts";

/**
 * Settle or Unsettle (#334): ⋯'s first item of the Artifact-itself group and the details' Status section, one button
 * each, for whoever may comment on it, where its server has `artifact_settled_v0` on (the card says `settled`).
 */
export interface ArtifactSettle {
  /** Who settled it, when and at which version; null while it is Working. */
  settled: ArtifactSettled | null;
  /** Asking the server: the buttons say so, and another press waits for it. */
  busy: boolean;
  /** Settle it if it is Working, else take it back to Working. */
  toggle: () => void;
}

/**
 * The viewer's Settle or Unsettle (useArtifactViewerActions): its answer goes on the data shown at once (the head's
 * tag, the details and ⋯ follow it), kept on the data it was made on (`data`, whichever version: the state is the
 * Artifact's), so a read of new data takes the server's word again, and is reported to the home page under it
 * (reportOwnSettle: the reader's own act moves its row there). `view` is the data shown with the reader's other
 * writes. A settle may follow it (the server follows whoever never unfollowed it), so the follow state is read again
 * after one and given to `onFollowed`. A refusal says why in a toast.
 */
export function useArtifactSettle(data: ArtifactViewerData | null, view: ArtifactViewerData | null, onFollowed: (following: boolean) => void): { view: ArtifactViewerData | null; settle: ArtifactSettle | null } {
  const { formatMessage } = useIntl();
  // The nearest provider's toasts: the window the viewer is drawn in (an object window's own, #337 PR3).
  const toast = useToast();
  const [answered, setAnswered] = useState<{ on: ArtifactViewerData; settled: ArtifactSettled | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(
    () => (view && answered && answered.on === data ? { ...view, card: withSettled(view.card, answered.settled) } : view),
    [view, answered, data],
  );
  const id = shown?.card.id ?? null;
  // Undefined: the card says nothing of Settled (the flag off), so nothing is offered.
  const settled = shown && settledShown(shown.card) ? shown.card.settled ?? null : undefined;
  const toggle = useCallback(() => {
    const source = artifactSource();
    if (!source.setSettled || !id || !data || settled === undefined || busy) return;
    const on = data;
    const settling = settled === null;
    setBusy(true);
    void source.setSettled(id, settling).then(
      (answer) => {
        setAnswered({ on, settled: answer.settled });
        reportOwnSettle(id, answer.settled);
        if (!settling || !answer.changed) return;
        // Whether it follows now is the server's to say (not if the reader once unfollowed it): the viewer's read says.
        void source.viewer({ id, version: null }).then((result) => {
          if (result.status === "ok") onFollowed(result.data.following);
        }, () => {});
      },
      (error: unknown) => { toast.error(formatMessage({ id: settleRefusal(artifactErrorCode(error)) }), POLITE_ERROR); },
    ).finally(() => setBusy(false));
  }, [id, data, settled, busy, onFollowed, formatMessage, toast]);
  const may = settled !== undefined && shown?.capabilities.comment === true;
  const settle = useMemo<ArtifactSettle | null>(() => (may ? { settled: settled ?? null, busy, toggle } : null), [may, settled, busy, toggle]);
  return { view: shown, settle };
}
