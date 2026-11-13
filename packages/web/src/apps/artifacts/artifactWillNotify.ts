import { useEffect, useState } from "react";
import type { IntlShape } from "react-intl";
import type { ArtifactCommentId, ArtifactWillNotify } from "@botiverse/raft-shared";

import { formatNameList } from "./artifactNameList";
import { useArtifactComments } from "./ArtifactCommentsContext";
import { artifactSource } from "./artifactSource";

/**
 * The server's will-notify answer for where a new comment goes (without the draft's mentions):
 * `place` is the comment replied to and the file it is on (no path: the whole Artifact); null
 * asks nothing (an edit).
 */
export function useServerWillNotify(place: { replyTo: ArtifactCommentId | undefined; path: string | undefined } | null): ArtifactWillNotify["recipients"] | null {
  const comments = useArtifactComments();
  const id = comments?.data.card.id ?? null;
  const replyTo = place?.replyTo;
  const path = place?.path;
  const key = place && id ? `${id}|${replyTo ?? ""}|${path ?? ""}` : null;
  const [answer, setAnswer] = useState<{ key: string; recipients: ArtifactWillNotify["recipients"] } | null>(null);
  useEffect(() => {
    if (!key || !id) return;
    let cancelled = false;
    void artifactSource().willNotify(id, { ...(replyTo ? { replyTo } : {}), ...(path !== undefined ? { path } : {}) }).then(
      (result) => { if (!cancelled) setAnswer({ key, recipients: result.recipients }); },
      () => {},
    );
    return () => { cancelled = true; };
  }, [key, id, replyTo, path]);
  return answer && answer.key === key ? answer.recipients : null;
}

/**
 * "Will notify: Ana and Pico", or that nobody will be: the send button's tooltip, and C's line. The names alone
 * (#250: not why each hears about it).
 */
export function willNotifyText(recipients: ArtifactWillNotify["recipients"], intl: IntlShape): string {
  const names = recipients.map((r) => r.actor.displayName);
  return recipients.length > 0
    ? intl.formatMessage({ id: "artifacts.comments.willNotify" }, { names: formatNameList(intl, names) })
    : intl.formatMessage({ id: "artifacts.comments.willNotifyNobody" });
}
