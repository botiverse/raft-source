import { artifactDownloadFileName, artifactFileType } from "@botiverse/raft-shared";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { canShareFiles, isShareAbort } from "./webShareFiles";
import type { FileShareNavigator } from "./webShareFiles";

// ⋯'s Share (#proj-workspace:#346): the version's file itself handed to the
// system share sheet (navigator.share), so it goes to another app as an
// attachment does. The file is the one Download names: a version of one file
// shares that file, of several its entry file, by artifactDownloadFileName.

/** Larger files are not read ahead for Share, so ⋯ offers none for them. */
export const ARTIFACT_SHARE_MAX_BYTES = 50 * 1024 * 1024;

/** The file Share hands over: its path in the version, the name it goes by and its type. */
export interface ArtifactShareTarget {
  path: string;
  name: string;
  type: string;
}

/**
 * What Share would hand over for the version shown: its one file, or with
 * several its entry file (the first where none is marked), named as Download
 * names it, typed by its extension (the type Raft serves it with, without
 * parameters). Null with no file, or one above ARTIFACT_SHARE_MAX_BYTES.
 */
export function artifactShareTarget(data: Pick<ArtifactViewerData, "card" | "files">): ArtifactShareTarget | null {
  const file = data.files.find((candidate) => candidate.entry) ?? data.files[0];
  if (!file || file.sizeBytes > ARTIFACT_SHARE_MAX_BYTES) return null;
  return {
    path: file.path,
    name: artifactDownloadFileName({ title: data.card.title, fileCount: data.files.length, path: file.path }),
    type: artifactFileType(file.path).contentType.split(";")[0]!.trim(),
  };
}

/** The file to share: the bytes read, by the target's name and type. */
export function artifactShareFile(target: ArtifactShareTarget, bytes: Blob): File {
  return new File([bytes], target.name, { type: target.type });
}

/** Whether this browser shares such a file: asked of an empty one by the same name and type, before reading any bytes. */
export function offersArtifactShare(target: ArtifactShareTarget, nav: FileShareNavigator | undefined): boolean {
  return canShareFiles([new File([], target.name, { type: target.type })], nav);
}

/**
 * Hands `file` to the share sheet. `navigator.share` is called before this
 * returns, so call it in the click itself: a browser (Safari) refuses a share
 * that the click's user activation no longer covers. Resolves `cancelled`
 * where the person closed the sheet (AbortError: nothing to say); rejects on
 * any other failure.
 */
export function shareArtifactFile(file: File, nav: FileShareNavigator): Promise<"shared" | "cancelled"> {
  let sharing: Promise<void>;
  try {
    if (typeof nav.share !== "function") throw new TypeError("navigator.share is unavailable");
    sharing = nav.share({ files: [file] });
  } catch (error) {
    return isShareAbort(error) ? Promise.resolve("cancelled") : Promise.reject(error);
  }
  return Promise.resolve(sharing).then(
    () => "shared" as const,
    (error: unknown) => {
      if (isShareAbort(error)) return "cancelled" as const;
      throw error;
    },
  );
}
