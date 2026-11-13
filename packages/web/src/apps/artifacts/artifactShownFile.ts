import { createContext, useContext } from "react";
import type { ArtifactFile, ArtifactId, ArtifactViewerData } from "@botiverse/raft-shared";

import { artifactPagePath, artifactUrl } from "./artifactLinks";

/**
 * The file of the version the viewer shows (#proj-workspace:#272): the entry, unless the reader
 * opened another from the Files panel. `path` is the file asked for (null: the entry) and `show`
 * asks for another (null: the entry again). The viewer's hosts hold it (ArtifactShownFileProvider):
 * the Artifact's own page in its address (`?file=`, so Back returns to the entry and a link can
 * name a file), the in-app viewer in memory. With no provider the entry is shown and `show` does
 * nothing (the public page, a card's preview).
 */
export interface ArtifactShownFile {
  path: string | null;
  show: (path: string | null) => void;
}

const ENTRY_ONLY: ArtifactShownFile = { path: null, show: () => {} };

export const ArtifactShownFileContext = createContext<ArtifactShownFile>(ENTRY_ONLY);

/** The address's name for the file shown, on the Artifact's own page. */
export const ARTIFACT_PAGE_FILE_PARAM = "file";

type Files = ArtifactViewerData["files"];

/** The version's entry: the file marked so, else its first (an older answer). */
export function entryFileOf(files: Files): ArtifactFile | null {
  return files.find((file) => file.entry) ?? files[0] ?? null;
}

/** The file shown for `path`: that file when the version has it, else the entry (a link to a file a later version dropped). */
export function shownFileOf(files: Files, path: string | null): ArtifactFile | null {
  const entry = entryFileOf(files);
  if (path === null) return entry;
  return files.find((file) => file.path === path) ?? entry;
}

/** The file the viewer shows of `data`'s version, and whether it is the entry. */
export function useShownFile(data: Pick<ArtifactViewerData, "files">): { file: ArtifactFile | null; entry: boolean } {
  const { path } = useContext(ArtifactShownFileContext);
  const file = shownFileOf(data.files, path);
  return { file, entry: file === entryFileOf(data.files) };
}

/** Asks the viewer for another file of the version (null: the entry). */
export function useShowFile(): ArtifactShownFile["show"] {
  return useContext(ArtifactShownFileContext).show;
}

/**
 * The address of `path` on the Artifact's own page (null: the entry, the page's plain address):
 * what a Files row links to, so it opens in a new tab and copies as a link like any other.
 */
export function artifactFilePagePath(id: ArtifactId, version: number | null, path: string | null): string {
  const page = artifactPagePath(id, version);
  return path === null ? page : `${page}?${ARTIFACT_PAGE_FILE_PARAM}=${encodeURIComponent(path)}`;
}

/** That address in full, on this deployment's own origin (`artifactUrl`): what "Open in new tab" opens for a file that isn't the entry. */
export function artifactFileUrl(id: ArtifactId, version: number | null, path: string): string {
  return `${artifactUrl(id, version)}?${ARTIFACT_PAGE_FILE_PARAM}=${encodeURIComponent(path)}`;
}
