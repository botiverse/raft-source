// Where an Artifact's canonical link opens: `GET /api/artifacts/:id/locate`
// (ArtifactWebLocation). The link (`https://app.raft.build/artifacts/<id>`,
// `/v/<n>`) names no server, and the web opens an Artifact in one of the
// reader's servers (`/s/<slug>/artifacts?artifact=<id>`), so the web asks
// here which one. It only reads: no read position moves, nothing is written.
//
// The reader asks with any server they are in (core's requireServer), and the
// answer is about every server they are in (platform/links serversOfUser),
// tried in this order: the Artifact's own server, the one asked with, then,
// for an Artifact homed in a conversation (a joint channel is seen from each
// participating server through its own projection), the rest. A public
// Artifact is seen from the first two; one homed in the server, or an orphan,
// only from its own server. Visibility is canViewArtifacts', each server as
// the reader's (actorsWhoCanViewArtifact, one call); flags are evaluated in
// one batch, beside it (every candidate server's, read alongside sight).
//
// The answer is what opening the viewer from one of the servers the reader
// sees it from would answer (so it tells nothing a read there wouldn't):
// - the first server the reader sees it from with Artifacts on there and on
//   the Artifact's own server (a non-public read needs both, as
//   visibleItemFor): 200 `{ serverSlug }`;
// - a public Artifact whose own server has Artifacts on, seen only from
//   servers of the reader's with Artifacts off (they aren't in its server):
//   200 `{ serverSlug, serverArtifactsOff: true }`, the first server they see
//   it from. A public Artifact opens by its own server's flag alone (Tenny,
//   task #74; the read routes' webCommon readableItemFor): the viewer, its
//   files, frame and comment list answer there, read-only (every write is
//   403 ARTIFACTS_NOT_ENABLED and `capabilities` offer none);
// - seen from none: the one 404 NOT_VISIBLE, whatever the reason (no such id,
//   deleted, revoked, not theirs to see);
// - another server's Artifact, off on its own server, seen from a server of
//   the reader's with Artifacts on, or public (whatever the reader's
//   servers' flags): that same 404 (the viewer there answers it so; the
//   Artifact's server's flag is not the reader's to learn);
// - otherwise Artifacts are off where it would open: 403
//   ARTIFACTS_NOT_ENABLED, `details.serverSlug` naming that server (the
//   Artifact's own when the reader sees it from there, else the first server
//   they see it from), as the viewer there answers before looking at the
//   Artifact's own server. The reader is a member there: nothing new is told.
//   A public Artifact answers this only to a member of its own server, off.
import { eq } from "drizzle-orm";
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY, type ArtifactWebLocation, type ServerId } from "@botiverse/raft-shared";
import { getDb } from "../../platform/db";
import { appEnabledOnLiveServers } from "../../platform/flags";
import { serversOfUser } from "../../platform/links";
import { ARTIFACTS_NOT_ENABLED_ERROR, json, type ArtifactApiJson } from "./apiCommon";
import { artifactItems } from "./schema";
import { actorsWhoCanViewArtifact } from "./visibility";
import { webFail, webNotVisible, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";

export function createLocateOperations() {
  return {
    locate: async (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<ArtifactWebLocation> | ArtifactWebApiError> => {
      const [[item], memberships] = await Promise.all([
        getDb().select().from(artifactItems).where(eq(artifactItems.id, id)).limit(1),
        serversOfUser(reader.userId),
      ]);
      if (!item || item.deletedAt !== null || item.revokedAt !== null) return webNotVisible();
      const slugOf = new Map(memberships.map((server) => [server.id, server.slug]));
      const ordered: ServerId[] = [item.serverId, reader.serverId];
      if (item.homeKind === "conversation") ordered.push(...memberships.map((server) => server.id));
      const candidates = [...new Set(ordered)].filter((serverId) => slugOf.has(serverId)
        && (item.homeKind === "public" || item.homeKind === "conversation" || serverId === item.serverId));
      if (candidates.length === 0) return webNotVisible();

      // Sight and the flags at once: the flags of every candidate, those it is seen from among them.
      const [visible, [itemServerOn, ...candidateOn]] = await Promise.all([
        actorsWhoCanViewArtifact(candidates.map((serverId) => ({ type: "user" as const, id: reader.userId, serverId })), item),
        appEnabledOnLiveServers([item.serverId, ...candidates], WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY),
      ]);
      const seenFrom = candidates.filter((_, index) => visible[index]);
      if (seenFrom.length === 0) return webNotVisible();
      const on = candidateOn.filter((_, index) => visible[index]);
      if (itemServerOn) {
        const opensIn = seenFrom.find((_, index) => on[index]);
        if (opensIn) return json({ serverSlug: slugOf.get(opensIn)! });
        // Public, by its own server's flag alone: read-only in the server the reader sees it from, Artifacts off there.
        if (item.homeKind === "public") return json({ serverSlug: slugOf.get(seenFrom[0]!)!, serverArtifactsOff: true as const });
      } else if (seenFrom[0] !== item.serverId && (item.homeKind === "public" || on.some(Boolean))) {
        // Another server's Artifact, off there, seen from a server with Artifacts on (or public, from any): not seen, as the viewer there answers.
        return webNotVisible();
      }
      // Every server it is seen from is off (or, off on its own server, the reader sees it from there): that server's 403,
      // whatever the Artifact's own server says.
      return webFail(403, { code: "ARTIFACTS_NOT_ENABLED", error: ARTIFACTS_NOT_ENABLED_ERROR, details: { serverSlug: slugOf.get(seenFrom[0]!)! } });
    },
  };
}
