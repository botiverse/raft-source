import { useEffect, useState } from "react";

import { useRecentArtifactsHere } from "./artifactRecentConversation";
import { useArtifactViewerStore } from "./artifactViewerStore";

/**
 * Mounted while the loaded viewer shows this Artifact beside a conversation: keeps it in that conversation's list
 * (its title and the version shown; its time is the side card's opening, so the same opening is written once). The
 * title's menu (ArtifactRecentTitle) and the details behind a desktop head's title (ArtifactDetailsTitle) both list
 * them, and both mount it. It writes nothing beside no conversation.
 */
export function RecentArtifactRecord({ id, title, version }: { id: string; title: string; version: number }) {
  const { remember } = useRecentArtifactsHere();
  const opening = useArtifactViewerStore((s) => s.openedAt);
  const [mountedAt] = useState(() => Date.now());
  const openedAt = opening > 0 ? opening : mountedAt;
  useEffect(() => {
    remember({ id, title, version, openedAt });
  }, [id, openedAt, remember, title, version]);
  return null;
}
