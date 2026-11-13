import { currentTimeMs } from "@botiverse/raft-shared";
import type { ArtifactId, ArtifactViewerData, ArtifactWebFrame } from "@botiverse/raft-shared";
import { artifactReaderScope } from "./artifactReaderScope";

/**
 * The frame ticket a viewer answer carried (`ArtifactViewerData.frame`): the
 * first load of that version's frame uses it instead of asking the frame
 * route, so the first screen needs one request fewer. The canonical link's
 * `open` answer carries one too, taken out the same way (artifactOpenEarly).
 *
 * The ticket opens once, within 60 s of the answer (the server's rule), so it
 * is taken out of the viewer data as it arrives (never kept in a payload,
 * cached or logged) and held here for that version's first frame only:
 * - taken once: a remount, a retry, a reload and a version switch find
 *   nothing and ask the frame route;
 * - used within FRESH_MS of the answer, well inside the 60 s;
 * - by the reader it was answered for, in the server it was answered in
 *   (artifactReaderScope: a sign-out, another person signing in on this page
 *   or a server switch leaves it unused; `open`'s names its server itself,
 *   or none for a public Artifact read as an outsider, artifactReaderScopeIn).
 * A ticket nobody takes (a press that opened nothing) expires unused.
 */
const FRESH_MS = 45_000;
/** At most this many wait for their frame; the oldest go first. */
const KEPT_MAX = 4;

const kept = new Map<string, { frame: ArtifactWebFrame; scope: string | null; at: number }>();

const keyOf = (id: ArtifactId, version: number) => `${id}@${version}`;

/** Holds the ticket a viewer answer for `id` at `version` carried, for the reader in `scope` (the current server's by default). */
export function keepViewerFrame(id: ArtifactId, version: number, frame: ArtifactWebFrame, scope = artifactReaderScope()): void {
  const key = keyOf(id, version);
  kept.delete(key);
  kept.set(key, { frame, scope, at: currentTimeMs() });
  for (const oldest of kept.keys()) {
    if (kept.size <= KEPT_MAX) break;
    kept.delete(oldest);
  }
}

/** Viewer data as it arrives, its ticket taken out and held for its version's first frame (keepViewerFrame): the data a viewer may keep. */
export function withoutViewerFrame(data: ArtifactViewerData, scope = artifactReaderScope()): ArtifactViewerData {
  if (!data.frame) return data;
  const { frame, ...rest } = data;
  keepViewerFrame(rest.card.id, rest.card.version, frame, scope);
  return rest;
}

/** The ticket for `id` at `version`'s first frame, once: null when there is none, or it is stale or another reader's or server's. */
export function takeViewerFrame(id: ArtifactId, version: number, scope = artifactReaderScope()): ArtifactWebFrame | null {
  const key = keyOf(id, version);
  const entry = kept.get(key);
  if (!entry) return null;
  kept.delete(key);
  if (scope === null || entry.scope !== scope) {
    // Another reader or server: what this page held for the last one goes.
    kept.clear();
    return null;
  }
  return currentTimeMs() - entry.at < FRESH_MS ? entry.frame : null;
}

/** Tests only. */
export function resetViewerFramesForTests(): void {
  kept.clear();
}
