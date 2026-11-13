// The standalone page's one call: `GET /api/artifacts/:id/open`
// (ArtifactWebOpen). The web's lightweight page for an Artifact's canonical
// link (`/artifacts/<id>`, which names no server) asks this once, signed in,
// with no X-Server-Id (core's account route, platform/apps
// WebApiMount.accountRoute: the person, no server), instead of `/auth/me`,
// `/servers`, `locate` and the viewer one after another. Signed out is
// core's 401 (the web shows the signed-out page instead).
//
// Only the Artifact's own server is asked about, in this order:
// 1. The reader stands in the Artifact's server (platform/links
//    serverOfUser) and reads it there (webCommon readableItemFor with that
//    server as theirs: its home, that server's flag): `{ opensIn: {
//    serverId, slug, name }, viewer }`, the viewer exactly as `GET
//    /api/artifacts/:id` answers in that server (webViewer viewerAnswerOf:
//    `?version=` and its refusals, the read position moved, capabilities,
//    `frame`). Being a member is not enough: a member who can't see its home
//    (a private channel they aren't in) is never answered from here.
// 2. Otherwise a public Artifact whose own server has Artifacts on, with a
//    current version (publicRoutes publicItemOf, the signed-out page's
//    checks): `{ opensIn: null, viewer }`, read as an outsider (viewerDataOf
//    from no server of the reader's: no capability, the current version
//    only, no comment count, following, origin or savedFrom, no read position
//    moved), its `frame` the signed-out page's anonymous ticket
//    (publicRoutes anonymousFrameOf: no server of the reader's stands behind
//    the read, and it is no more than a signed-out visitor gets).
//    `?version=` naming another version: the one 404; malformed: 400
//    INVALID_REQUEST, as the viewer.
// 3. Otherwise the one 404 NOT_VISIBLE, whatever the reason (no such id,
//    deleted, revoked, not theirs to see, its own server's Artifacts off).
// The reader's other servers are never consulted: not their flags, nor a
// joint channel seen through their projection (`locate`, asked from a
// server, still finds those).
import { eq } from "drizzle-orm";
import { asServerId, type ArtifactWebOpen } from "@botiverse/raft-shared";
import type { AppAccountReader } from "../../platform/apps";
import { getDb } from "../../platform/db";
import { serverOfUser } from "../../platform/links";
import { json, type ArtifactApiJson } from "./apiCommon";
import { anonymousFrameOf, publicItemOf } from "./publicRoutes";
import { artifactItems, type ArtifactItemRow } from "./schema";
import { answerWeb, ArtifactWebFailure, readableItemFor, webNotVisible, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";
import { parseVersionQuery, viewerAnswerOf, viewerDataOf } from "./webViewer";

/**
 * Where case 2 reads from: no server. viewerDataOf asks the reader's server
 * only whether the Artifact is another server's (apiCommon accessOf,
 * shownActorOf: an outsider of a public one) and, for a conversation home,
 * that conversation's name, never asked here (case 2 is public only). No
 * server has this id: servers' ids are random v4 uuids, never the nil one.
 */
const NO_SERVER = asServerId("00000000-0000-0000-0000-000000000000");

/** The item if the reader reads it (readableItemFor), else null for its refusal (its server's 403, the one 404). */
async function readableOrNull(reader: ArtifactWebReader, id: string): Promise<ArtifactItemRow | null> {
  try {
    return await readableItemFor(reader, id);
  } catch (error) {
    if (error instanceof ArtifactWebFailure) return null;
    throw error;
  }
}

export function createOpenOperations() {
  return {
    open: (person: AppAccountReader, id: string, query: { version?: unknown }): Promise<ArtifactApiJson<ArtifactWebOpen> | ArtifactWebApiError> => answerWeb(async () => {
      const [row] = await getDb().select({ serverId: artifactItems.serverId }).from(artifactItems).where(eq(artifactItems.id, id)).limit(1);
      if (!row) return webNotVisible();

      // 1. Read in its own server: a member who sees it there, with Artifacts on there.
      const server = await serverOfUser(person.userId, row.serverId);
      if (server) {
        const reader: ArtifactWebReader = { userId: person.userId, serverId: server.id, sessionFamilyId: person.sessionFamilyId };
        const readable = await readableOrNull(reader, id);
        if (readable) {
          return json<ArtifactWebOpen>({ opensIn: { serverId: server.id, slug: server.slug, name: server.name }, viewer: await viewerAnswerOf(reader, readable, query) });
        }
      }

      // 2. Public, by its own server's flag alone: read as an outsider.
      const found = await publicItemOf(id);
      if (!found) return webNotVisible();
      const { item, version } = found;
      const requested = parseVersionQuery(query.version);
      if (requested !== undefined && requested !== version.number) return webNotVisible();
      const outsider: ArtifactWebReader = { userId: person.userId, serverId: NO_SERVER, sessionFamilyId: person.sessionFamilyId };
      const { body } = await viewerDataOf(outsider, item, undefined);
      const frame = await anonymousFrameOf(item, version);
      return json<ArtifactWebOpen>({ opensIn: null, viewer: frame ? { ...body, frame } : body });
    }),
  };
}
