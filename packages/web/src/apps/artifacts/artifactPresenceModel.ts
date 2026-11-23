import type { ArtifactActor, ArtifactPresence as Presence, ArtifactViewerData } from "@botiverse/raft-shared";

import { actorKey } from "./artifactComments";

/** What the presence route says, as the header's readers and the details behind its title show it (ArtifactPresence). */
export type HereState = "viewing" | "reading" | "writing";

/**
 * One row of the list: here now (the stack), or someone whose read position
 * is all we know. `updatedSince`: their read position is before the latest
 * version.
 */
export type PresenceRow =
  | { actor: ArtifactActor; here: HereState; self?: true; updatedSince: boolean }
  | { actor: ArtifactActor; here: null; at: string; updatedSince: boolean };

export interface PresenceModel {
  /** The stack: who is here now, others then the viewer, every face in color. */
  here: Array<PresenceRow & { here: HereState }>;
  /** Here now first, then who has read it, the most recent first. */
  rows: PresenceRow[];
  /** How many have read the latest version, and how many stopped before it (the viewer included when known). */
  seenLatest: number;
  notSeenLatest: number;
}

export const isSelf = (r: PresenceRow) => r.here !== null && r.self === true;

/**
 * Who is here now and who has seen the Artifact, the same on every version:
 * presence is per Artifact, and "updated since" is always against the latest
 * version (membership in `readOtherVersion`), never the one on screen.
 *
 * Each person counts once, by their read position. The route leaves the
 * reader out, so the viewer is added here, here now: on the latest version
 * they have read it (opening it moves their position); on an older one only
 * `ownRead` says how far they got, and without it they are left out of the
 * counts.
 */
export function presenceModel(
  presence: Presence,
  viewer: { actor: ArtifactActor; shownVersion: number; latestVersion: number } | null = null,
): PresenceModel {
  const own = viewer ? actorKey(viewer.actor) : null;
  // Each person's read position: true when it is before the latest version.
  const behind = new Map<string, { actor: ArtifactActor; at: string; updatedSince: boolean }>();
  for (const [list, updatedSince] of [[presence.readCurrentVersion, false], [presence.readOtherVersion, true]] as const) {
    for (const r of list) {
      const key = actorKey(r.actor);
      if (key !== own && !behind.has(key)) behind.set(key, { actor: r.actor, at: r.at, updatedSince });
    }
  }
  const ownBehind = !viewer
    ? null
    : viewer.shownVersion === viewer.latestVersion
      ? false
      : presence.ownRead
        ? presence.ownRead.version < viewer.latestVersion
        : null;

  const listed = new Set<string>(own ? [own] : []);
  const here: PresenceModel["here"] = [];
  for (const p of presence.viewing) {
    const key = actorKey(p.actor);
    if (listed.has(key)) continue;
    listed.add(key);
    here.push({ actor: p.actor, here: p.state, updatedSince: behind.get(key)?.updatedSince ?? false });
  }
  if (viewer) here.push({ actor: viewer.actor, here: "viewing", self: true, updatedSince: ownBehind === true });

  const read = [...behind].flatMap(([key, r]) => (listed.has(key) ? [] : [{ ...r, here: null }]));
  read.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const positions = [...behind.values()].map((r) => r.updatedSince);
  if (ownBehind !== null) positions.push(ownBehind);
  return {
    here,
    rows: [...here, ...read],
    seenLatest: positions.filter((b) => !b).length,
    notSeenLatest: positions.filter((b) => b).length,
  };
}

/** The signed-in viewer and the version they're on, from the viewer data (null outside the viewer): presenceModel's `viewer`. */
export function presenceViewer(data: ArtifactViewerData | null | undefined): Parameters<typeof presenceModel>[1] {
  return data ? { actor: data.viewer, shownVersion: data.card.version, latestVersion: data.card.latestVersion } : null;
}

/** Whether anyone but the viewer is in the list (here now or has read it): alone, the viewer sees no presence at all. */
export function someoneElse(model: PresenceModel): boolean {
  return model.rows.some((r) => !isSelf(r));
}

/** How many besides the viewer are here now (the head's dot while there are any: ArtifactDetailsTitle). */
export function othersHereNow(model: PresenceModel): number {
  return model.here.filter((r) => !r.self).length;
}

