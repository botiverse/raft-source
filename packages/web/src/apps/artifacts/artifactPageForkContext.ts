import { createContext } from "react";

/**
 * What the page's own comment button gets where the reader has no comments on this Artifact (another
 * server's reader of a public one in the viewer, readsAsOutsider; anyone on the public page): Fork in
 * Raft's opener, the header's Fork in Raft button's (`open`). `signedOut`: a visitor on the public
 * page, who has no server yet, so the question says to sign in (`open` takes them there first).
 */
export interface ArtifactPageFork {
  open: () => void;
  signedOut: boolean;
}

/**
 * The page's comment button then asks whether to fork it instead (useArtifactPageForkAsk,
 * ArtifactFrame). Null elsewhere. Given by ArtifactPageForkProvider (the viewer and the Artifact's own
 * page) and PublicArtifactPage.
 */
export const ArtifactPageForkContext = createContext<ArtifactPageFork | null>(null);
