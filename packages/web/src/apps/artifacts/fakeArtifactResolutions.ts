// FAKE DATA: resolving comment threads (#249) as the Server does (resolutions.ts), for the fake
// data source (fakeArtifactSource.ts), on its list of an Artifact's comments.
import { currentTimeMs } from "@botiverse/raft-shared";
import type { ArtifactCapabilities, ArtifactComment, ArtifactCommentId, ArtifactWebThreadResolution } from "@botiverse/raft-shared";

import type { ArtifactApiError } from "./artifactApi";
import { ME, actorKey } from "./fakeArtifactActors";

/** The root of the thread `comment` is in (itself for a root), up the reply chain as far as it is kept. */
function rootOf(list: readonly ArtifactComment[], comment: ArtifactComment): ArtifactComment {
  let root = comment;
  for (let parent = list.find((c) => c.id === root.replyTo); parent; parent = list.find((c) => c.id === root.replyTo)) root = parent;
  return root;
}

/** A reply to `replyTo` reopens the resolved thread it is in (resolutions.ts reopenThreadsOf). */
export function reopenFakeThreadOf(list: ArtifactComment[], replyTo: ArtifactCommentId | null): void {
  const parent = replyTo ? list.find((c) => c.id === replyTo) : undefined;
  const root = parent ? rootOf(list, parent) : undefined;
  if (!root?.resolvedAt) return;
  list[list.indexOf(root)] = { ...root, resolvedAt: null, resolvedBy: null };
}

/**
 * Resolve (`resolve`) or reopen a thread for the fake's reader: its root only (409
 * COMMENT_IS_REPLY naming it), by one who takes part and is the thread's author or may delete the
 * Artifact (403 FORBIDDEN); one that stands so already changes nothing (`changed: false`).
 */
export function changeFakeResolution(list: ArtifactComment[], commentId: ArtifactCommentId, capabilities: ArtifactCapabilities, resolve: boolean): ArtifactWebThreadResolution {
  const index = list.findIndex((c) => c.id === commentId);
  if (index < 0) throw { status: 404, code: "COMMENT_NOT_FOUND" } satisfies ArtifactApiError;
  const root = list[index]!;
  if (root.replyTo) throw { status: 409, code: "COMMENT_IS_REPLY", details: { thread: rootOf(list, root).id } } satisfies ArtifactApiError;
  if (!capabilities.comment || (!capabilities.delete && actorKey(root.author) !== actorKey(ME))) throw { status: 403, code: "FORBIDDEN" } satisfies ArtifactApiError;
  if ((root.resolvedAt !== null) === resolve) return { comment: root, note: null, changed: false };
  const changed: ArtifactComment = resolve ? { ...root, resolvedAt: new Date(currentTimeMs()).toISOString(), resolvedBy: ME } : { ...root, resolvedAt: null, resolvedBy: null };
  list[index] = changed;
  return { comment: changed, note: null, changed: true };
}
