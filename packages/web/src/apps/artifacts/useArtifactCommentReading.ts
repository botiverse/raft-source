import { useCallback, useRef, useState } from "react";
import type { ArtifactCardUnseen, ArtifactComment, ArtifactCommentId, ArtifactId } from "@botiverse/raft-shared";
import type { AnnotationReport } from "@botiverse/porthole";

import type { ArtifactViewerActor } from "./artifactApi";
import { NO_READ_MARK, markPlaceOf, readMarkAfterLook, readMarkAtLoad } from "./artifactCommentListOrder";
import type { ArtifactCommentReadMark, ArtifactMarkPlace, ArtifactMarkPlaces } from "./artifactCommentListOrder";
import { artifactCardSeed } from "./artifactOpenIntent";

export interface ArtifactCommentReading {
  readMark: ArtifactCommentReadMark;
  markPlaces: () => ArtifactMarkPlaces | null;
  placesKnown: boolean;
  notePlaces: (report: AnnotationReport) => void;
}

type OpenerUnseen = Pick<ArtifactCardUnseen, "newComments" | "firstNewComment">;

/**
 * What was new to the reader before the viewer opened, read once as the comments mount (the
 * viewer's route moves the read position as it opens, so nothing read after says it): the
 * viewer data's own `unseenAtOpen`, which the route read before its move (null: an outsider,
 * who keeps no read position). The opener's card (ArtifactCard `unseen`, the card a message, an
 * Activity row or a link chip showed: artifactCardSeed) stands in from an older Server, and wins
 * where it says more is new: an Activity row's open marks the row read before the viewer's route
 * runs. Opened on its first new comment with neither (`listAt`): from that one.
 */
function openerUnseen(id: ArtifactId, version: number, atOpen: ArtifactCardUnseen | null | undefined, listAt: ArtifactCommentId | null): OpenerUnseen | null {
  if (atOpen === null) return null;
  const card = artifactCardSeed({ id, version: null }) ?? artifactCardSeed({ id, version });
  const seed: OpenerUnseen | null = card?.unseen ?? (listAt ? { newComments: 1, firstNewComment: listAt } : null);
  if (!atOpen) return seed;
  return seed && seed.newComments > atOpen.newComments ? seed : atOpen;
}

/**
 * The comment list's memory beside the open viewer (ArtifactCommentsProvider), across the list's
 * openings: where the reader had read the comments to (`readMark`, the list's "new" when it
 * opens: readMarkAtLoad once the comments first load, readMarkAfterLook each time the list closes),
 * and where the frame last said each posted thread's mark is in the file it shows (`markPlaces`,
 * from its `anchored` reports, for Page order; `placesKnown` once it said anything for this file
 * and version).
 */
export function useArtifactCommentReading({ id, version, atOpen, comments, viewer, panelOpen, shownPath, listAt }: {
  id: ArtifactId;
  version: number;
  /** The viewer data's `unseenAtOpen` (undefined: an older Server's, or another route's). */
  atOpen: ArtifactCardUnseen | null | undefined;
  comments: ArtifactComment[] | null;
  viewer: ArtifactViewerActor | null;
  panelOpen: boolean;
  shownPath: string | null;
  listAt: ArtifactCommentId | null;
}): ArtifactCommentReading {
  // oxlint-disable-next-line react-doctor/no-derived-useState -- read once at mount: what was new before the viewer's route moved the read position.
  const [opener] = useState(() => openerUnseen(id, version, atOpen, listAt));
  const [read, setRead] = useState<{ id: ArtifactId; mark: ArtifactCommentReadMark }>({ id, mark: NO_READ_MARK });
  // React's "adjusting state when a prop changes": the first load, then each close of the list.
  if (comments && (read.id !== id || read.mark.through === null)) setRead({ id, mark: readMarkAtLoad(comments, viewer, read.id === id ? opener : null) });
  const [wasOpen, setWasOpen] = useState(panelOpen);
  if (wasOpen !== panelOpen) {
    setWasOpen(panelOpen);
    if (!panelOpen && comments) setRead({ id, mark: readMarkAfterLook(comments) });
  }
  const key = `${id}@${version}:${shownPath ?? ""}`;
  const places = useRef<{ key: string; places: ArtifactMarkPlaces } | null>(null);
  const [placesFor, setPlacesFor] = useState<string | null>(null);
  const notePlaces = useCallback((report: AnnotationReport) => {
    if (report.type !== "anchored" || shownPath === null) return;
    const now = places.current?.key === key ? places.current.places.places : new Map<string, ArtifactMarkPlace>();
    const next = new Map(now);
    for (const result of report.results) next.set(result.id, markPlaceOf(result));
    places.current = { key, places: { path: shownPath, places: next } };
    setPlacesFor(key);
  }, [key, shownPath]);
  const markPlaces = useCallback(() => (places.current?.key === key ? places.current.places : null), [key]);
  return { readMark: read.id === id ? read.mark : NO_READ_MARK, markPlaces, placesKnown: placesFor === key, notePlaces };
}
