import { useMemo } from "react";
import type { ReactNode } from "react";
import type { ArtifactId } from "@botiverse/raft-shared";

import { publicArtifactFileReader, publicArtifactMeta } from "./apiArtifactSource";
import { ArtifactDrawnContent } from "./ArtifactContent";
import type { ArtifactDrawnKind } from "./artifactDrawnKind";
import { ArtifactLoadingArea } from "./ArtifactLoadingSplash";
import { ArtifactFileReaderContext, useKeyedLoadWithError } from "./artifactSource";

/**
 * The most of a file the public page reads to draw it. The signed-out file route answers a file
 * whole (the signed-in one cuts text at 256 KiB on the server), so the size the page's meta gives
 * decides first: past this, nothing is fetched and the page says what it said before this
 * existed (sign in to see it).
 */
const PUBLIC_DRAWN_MAX_BYTES: Record<ArtifactDrawnKind, number> = {
  text: 1024 * 1024,
  csv: 1024 * 1024,
  image: 8 * 1024 * 1024,
};

/**
 * A public Artifact of a kind Raft draws itself (text, a csv, an image), on the public page
 * (the Artifacts feature matrix, gap 1: a visitor and another server's reader of the link saw
 * "can't be previewed, sign in" for every one of them). The same renderers as the viewer's
 * (ArtifactDrawnContent), reading the signed-out routes: the page's meta for the entry file's
 * path and size (the public view names the kind, not the file), then that file.
 *
 * Read-only: no comments (there is no comments provider here, so the renderers mark nothing and
 * offer no Comment on a selection) and no download, as the rest of the public page.
 * `fallback` (the page's own "sign in to view" state) shows when the meta or the file can't be
 * read, the file is past the size above, or it isn't what its name says.
 */
export function PublicArtifactDrawn({ id, version, kind, title, fallback }: {
  id: ArtifactId;
  /** The current version's number, as the public view gave it: a new version is a new read. */
  version: number;
  kind: ArtifactDrawnKind;
  title: string;
  fallback: ReactNode;
}) {
  const meta = useKeyedLoadWithError(`${id}@${version}/meta`, () => publicArtifactMeta(id));
  // Read as it is given: an answer without the files it should list draws nothing (the fallback), never an error.
  const entry = meta && Array.isArray(meta.files) ? meta.files.find((file) => file.path === meta.entry) ?? null : null;
  const path = entry?.path ?? null;
  const file = useMemo(() => (path === null ? null : { id, version, path }), [id, version, path]);
  if (meta === null) return <ArtifactLoadingArea kind={kind} testId="public-artifact-drawn-loading" />;
  if (!meta || !entry || !file || entry.size > PUBLIC_DRAWN_MAX_BYTES[kind]) return fallback;
  return (
    <ArtifactFileReaderContext value={publicArtifactFileReader}>
      <ArtifactDrawnContent kind={kind} file={file} title={title} fallback={fallback} />
    </ArtifactFileReaderContext>
  );
}
