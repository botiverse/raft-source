// An open Artifact page kept up to date (core's `object:watch`, shared
// objectWatch.ts): who may watch an Artifact, and the pings after a change.
//
// - watchArtifact (the registration's `watch`, asked by core's socket for
//   the socket's person in its server): the Artifact `ref` names (its `pt_`
//   id or its short id, parseArtifactId) if they read it now, by the rule the
//   viewer's reads answer by (webCommon readableItemFor: the deployment's
//   Artifacts on, canViewArtifacts, itemReadable), and the parts they read:
//   `comments` only when the comment list would list them any
//   (apiCommon accessOf: an outsider of a public Artifact reads none), and
//   `version` always. Anything else: null, nothing joined.
// - announceArtifactChanged: after the commit of each change to what the
//   viewer shows (platform/objectWatch announceObjectChanged), beside the
//   `activity:changed` of the same commit where there is one:
//   `comments` for a comment written (web and agent API, a resolve's note
//   too), edited or deleted (web), a thread resolved or reopened, a review
//   submitted; `version` for a new version (publish.ts). No content: the page
//   reads the part again through its own checked reads.
// - forgetArtifactWatchers: after the commit that deleted an Artifact or
//   moved it to a smaller home (manage.ts), every socket leaves its rooms;
//   one whose person still reads it joins again when its page next watches.
import { parseArtifactId, type ObjectChangedPart } from "@botiverse/raft-shared";
import type { AppWebReader } from "../../platform/apps";
import { announceObjectChanged, forgetObjectWatchers } from "../../platform/objectWatch";
import { accessOf } from "./apiCommon";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { ArtifactWebFailure, readableItemFor } from "./webCommon";

/** The Artifact `ref` names and the parts `reader` reads of it, or null when they can't read it now. */
export async function watchArtifact(reader: AppWebReader, ref: string): Promise<{ id: string; parts: ObjectChangedPart[] } | null> {
  const id = parseArtifactId(ref);
  if (id === null) return null;
  try {
    const item = await readableItemFor(reader, id);
    return { id: item.id, parts: accessOf(reader, item).comments ? ["comments", "version"] : ["version"] };
  } catch (error) {
    // Its one 404 and the deployment's 403: not readable.
    if (error instanceof ArtifactWebFailure) return null;
    throw error;
  }
}

/** After the commit of a change to one part of the Artifact `itemId`: its watchers' ping. Never throws. */
export function announceArtifactChanged(itemId: string, part: ObjectChangedPart): void {
  announceObjectChanged(ARTIFACT_OBJECT_KIND, itemId, part);
}

/** After the commit that deleted the Artifact `itemId` or narrowed its home: no socket watches it any more. Never throws. */
export function forgetArtifactWatchers(itemId: string): void {
  forgetObjectWatchers(ARTIFACT_OBJECT_KIND, itemId);
}
