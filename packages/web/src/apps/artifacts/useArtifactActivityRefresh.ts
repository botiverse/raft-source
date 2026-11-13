import { useCallback, useEffect, useRef } from "react";
import type { ArtifactCard, ArtifactCommentId, ArtifactId, ObjectInboxItem } from "@botiverse/raft-shared";

import { useReadObjectWhileShown } from "../../objects/objectRead";
import { subscribeObjectSummaryInvalidation } from "../../objects/objectSummaryLoader";
import { useServerStore } from "../../store/serverStore";
import { artifactActivityUnread } from "./artifactActivityRow";

/**
 * Calls `listener` on new activity on Artifacts in `serverId` (`id`: on that one; null: any) until
 * unsubscribed. There is no per-Artifact realtime event: `activity:changed` invalidates one
 * server's object summaries (every kind), as do a reconnect (every server's) and a change made
 * here. Another server's activity is left alone: what a page reads is its own server's. Not one
 * reference's card asked again (useArtifactNewerVersion's poll).
 */
function subscribeArtifactActivity(serverId: string, id: ArtifactId | null, listener: () => void): () => void {
  return subscribeObjectSummaryInvalidation((change) => {
    if (change.ref !== undefined || (change.kind !== undefined && change.kind !== "artifact")) return;
    if (typeof change.serverId === "string" && change.serverId !== serverId) return;
    if (id === null || change.id === undefined || change.id === id) listener();
  });
}

/**
 * Reads again (`read`) on new activity on Artifacts (subscribeArtifactActivity; `serverId` null:
 * never): one read at a time, and at most one more after it for whatever came meanwhile.
 */
export function useArtifactActivityChanged(serverId: string | null, id: ArtifactId | null, read: () => Promise<unknown>): void {
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => {
    if (serverId === null) return;
    let live = true;
    let state: "idle" | "reading" | "queued" = "idle";
    const run = () => {
      state = "reading";
      const next = () => {
        if (live && state === "queued") run();
        else state = "idle";
      };
      readRef.current().then(next, next);
    };
    const unsubscribe = subscribeArtifactActivity(serverId, id, () => {
      if (state === "idle") run();
      else state = "queued";
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [serverId, id]);
}

/**
 * The open viewer keeps up with its Artifact ("if I can see it, it's read"): new activity on it in
 * the current server (whose the viewer reads) reads its comments again (`refresh`), and while the
 * latest version is shown in a page that is visible and focused, its Activity row turning unread
 * is read once the row's comment is among those on screen (`shown`: rendered, in a thread the
 * reader has open). New versions are left unread: the viewer only offers them
 * (useArtifactNewerVersion); so is a row that doesn't say it is comments alone.
 */
export function useArtifactActivityRefresh(
  card: Pick<ArtifactCard, "id" | "version" | "latestVersion">,
  refresh: () => Promise<unknown>,
  shown: ReadonlySet<ArtifactCommentId>,
): void {
  useArtifactActivityChanged(useServerStore((s) => s.current?.id ?? null), card.id, refresh);
  const onScreen = useCallback((row: ObjectInboxItem<"artifact">) => {
    const comment = row.target?.comment;
    return artifactActivityUnread(row)?.versions === 0 && comment != null && shown.has(comment);
  }, [shown]);
  useReadObjectWhileShown("artifact", card.id, card.version === card.latestVersion, onScreen);
}
