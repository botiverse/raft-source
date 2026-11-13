import { useMemo } from "react";
import type { ReactNode } from "react";

import { ArtifactShownFileContext } from "./artifactShownFile";

/**
 * Holds which file of the version the viewer shows (artifactShownFile), for everything below:
 * the content, the Files panel's rows, the header's path, and the comments (made on, and marked
 * in, the file shown). `path` and `onShow` are the host's: where it keeps the file asked for.
 */
export function ArtifactShownFileProvider({ path, onShow, children }: {
  path: string | null;
  onShow: (path: string | null) => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ path, show: onShow }), [path, onShow]);
  return <ArtifactShownFileContext.Provider value={value}>{children}</ArtifactShownFileContext.Provider>;
}
