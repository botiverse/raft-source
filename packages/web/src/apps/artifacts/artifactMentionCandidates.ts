import { asArtifactId } from "@botiverse/raft-shared";
import type { ArtifactWebMentionCandidates } from "@botiverse/raft-shared";

import { artifactSource } from "./artifactSource";

/**
 * Who can be @mentioned on an Artifact (its object audience), matching `q`,
 * through the data source: the API source asks core's
 * `POST /api/mentions/audience`; the fake answers in tests and the fake dev
 * build. Core's mention picker reads it.
 */
export function artifactMentionCandidates(objectId: string, q: string): Promise<ArtifactWebMentionCandidates> {
  return artifactSource().mentionCandidates(asArtifactId(objectId), q);
}
