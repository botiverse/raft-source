import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { FileCode, FileImage, FileQuestion, FileSpreadsheet, FileText, FileVideo } from "lucide-react";
import type { ArtifactHome, ArtifactKind } from "@botiverse/raft-shared";

import { artifactHomeWords } from "./artifactHomeWords";
import { useArtifactServerName } from "./artifactServerName";

/**
 * The parts of an Artifact card that every list of cards draws alike: the
 * Artifacts home page's rows (S7) and the Artifacts group of core's search.
 */

/** The kind's icon, for the row's tile. */
export function artifactKindIcon(kind: ArtifactKind): ReactNode {
  if (kind === "html") return <FileCode />;
  if (kind === "image") return <FileImage />;
  if (kind === "video") return <FileVideo />;
  if (kind === "csv") return <FileSpreadsheet />;
  if (kind === "other") return <FileQuestion />;
  return <FileText />;
}

/** Where it lives, in words (artifactHomeWords), for the lists of cards: the home page's rows, search hits, link previews. */
export function useArtifactHomeText(): (home: ArtifactHome, fromAnotherServer?: boolean) => string {
  const { formatMessage } = useIntl();
  const server = useArtifactServerName();
  return (home, fromAnotherServer = false) => artifactHomeWords(formatMessage, home, server, fromAnotherServer);
}
