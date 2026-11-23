import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { backlinksCountText, backlinksPlace, backlinksShown, backlinksTotal, namedBacklinkMessages } from "./artifactBacklinksModel";
import { useShownFile } from "./artifactShownFile";
import { ArtifactBacklinksContext, useArtifactBacklinks, useBacklinkConversationNames } from "./useArtifactBacklinks";
import type { ArtifactBacklinksState } from "./useArtifactBacklinks";

/**
 * "Linked from" for a surface (#proj-workspace:#336 step 2, Kirby's design; ArtifactSurface's
 * SurfaceState provides it, so both shells and the object window have it): what links to the
 * Artifact (useArtifactBacklinks, once per Artifact), the discussions the reader's own channel list
 * names (the only ones listed and counted), where it goes for the file shown (the strip at
 * the content's foot, or the block under content Raft draws: artifactBacklinksModel `backlinksPlace`),
 * and its open state, closed at first and per Artifact (another Artifact opened here starts closed),
 * never remembered. While there is nothing to say (loading, a failure, nothing links it) the
 * context is null and no part draws anything.
 */
export function ArtifactBacklinksProvider({ data, phone, children }: { data: ArtifactViewerData; phone: boolean; children: ReactNode }) {
  const { id, kind } = data.card;
  const backlinks = useArtifactBacklinks(id);
  // The discussions the reader's own channel list names: the only ones listed, and counted (Kirby).
  const nameOf = useBacklinkConversationNames();
  const items = backlinks?.discussions.items;
  const discussions = useMemo(() => (items ? namedBacklinkMessages(items, nameOf) : []), [items, nameOf]);
  const shown = useShownFile(data);
  const place = backlinksPlace(kind, shown.file?.kind ?? null, shown.entry);
  // Open for this Artifact only: a new one opened in the same surface starts closed.
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(0);
  const open = openFor === id;
  const setOpen = useCallback((next: boolean) => setOpenFor(next ? id : null), [id]);
  const blockRef = useRef<HTMLElement | null>(null);
  const stripRef = useRef<HTMLButtonElement | null>(null);
  const setBlock = useCallback((element: HTMLElement | null) => { blockRef.current = element; }, []);
  const setStrip = useCallback((element: HTMLButtonElement | null) => { stripRef.current = element; }, []);
  const strip = useCallback(() => stripRef.current, []);
  const reveal = useCallback(() => {
    if (place === "strip") {
      setOpenFor(id);
      setRevealed((count) => count + 1);
      return;
    }
    // Under the content: brought into view, and focused so a screen reader reads it from its heading.
    const block = blockRef.current;
    if (!block) return;
    block.scrollIntoView({ block: "nearest" });
    block.focus({ preventScroll: true });
  }, [place, id]);
  const value = useMemo<ArtifactBacklinksState | null>(() => {
    if (!backlinksShown(backlinks, discussions.length)) return null;
    const { count, capped } = backlinksTotal(backlinks, discussions.length);
    return { backlinks, discussions, countText: backlinksCountText(count, capped), place, phone, open, setOpen, reveal, revealed, setBlock, setStrip, strip };
  }, [backlinks, discussions, place, phone, open, setOpen, reveal, revealed, setBlock, setStrip, strip]);
  return <ArtifactBacklinksContext.Provider value={value}>{children}</ArtifactBacklinksContext.Provider>;
}
