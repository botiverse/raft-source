import { useMemo } from "react";
import type { ReactNode } from "react";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { readsAsOutsider } from "./artifactOwnServer";
import { ArtifactPageForkContext } from "./artifactPageForkContext";
import type { ArtifactPageFork } from "./artifactPageForkContext";

/**
 * Under the surface: offers Fork in Raft to the frame where the reader is another server's
 * (readsAsOutsider: the same question that takes their Comments toggle away, so a reader is never
 * left with neither the comment list nor the question).
 */
export function ArtifactPageForkProvider({ data, openFork, children }: { data: ArtifactViewerData; openFork: () => void; children: ReactNode }) {
  const outsider = readsAsOutsider(data.card);
  const pageFork = useMemo<ArtifactPageFork | null>(() => (outsider ? { open: openFork, signedOut: false } : null), [outsider, openFork]);
  return <ArtifactPageForkContext value={pageFork}>{children}</ArtifactPageForkContext>;
}
