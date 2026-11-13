import { useContext, useEffect, useState } from "react";
import { ARTIFACT_INLINE_IMAGE_TYPES, artifactFileType } from "@botiverse/raft-shared";
import { ArtifactFileReaderContext, artifactSource, useKeyedLoadWithError } from "./artifactSource";
import type { ArtifactFileTarget } from "./artifactSource";

// Its own module, not ArtifactContent's: a message's Artifact card shows its
// cover with it (artifactCardPicture), and the card is on the first screen
// while the viewer's content is not.

export const SHELL_IMAGE_TYPES: ReadonlySet<string> = new Set(ARTIFACT_INLINE_IMAGE_TYPES);

function mimeOf(type: string): string {
  return type.split(";")[0]!.trim().toLowerCase();
}

/**
 * An image file as a `blob:` URL: bytes from Raft's API (the signed-in source's, or the reader
 * around it: ArtifactFileReaderContext), only when both the
 * path's type and the response's type are png, jpeg, gif, webp or svg; revoked
 * when the caller unmounts. `null` while loading, `false` when refused or
 * failed.
 */
export function useArtifactImageSrc(file: ArtifactFileTarget | null): string | null | false {
  const key = file ? `${file.id}@${file.version}/${file.path}` : "";
  const pathType = file ? mimeOf(artifactFileType(file.path).contentType) : "";
  // Not an inline type by its path: never fetched.
  const fetchable = file !== null && SHELL_IMAGE_TYPES.has(pathType);
  const reader = useContext(ArtifactFileReaderContext);
  const blob = useKeyedLoadWithError(key, () => (file ? (reader ?? artifactSource()).readBytes(file) : Promise.reject(new Error("no file"))), fetchable);
  const allowed = !!blob && SHELL_IMAGE_TYPES.has(pathType) && mimeOf(blob.type) === pathType;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!allowed || !blob) return;
    const url = URL.createObjectURL(blob);
    setSrc(url);
    return () => {
      URL.revokeObjectURL(url);
      setSrc(null);
    };
  }, [allowed, blob]);
  if (!fetchable || blob === undefined || (blob && !allowed)) return false;
  if (blob === null) return null;
  return src;
}
