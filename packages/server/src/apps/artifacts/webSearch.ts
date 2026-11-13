// Artifacts' group of core's search, `GET /api/search` (first-party app
// mechanism §五): the registration's `search` (register.ts). Core has checked
// the query and the flag, read the person's visible homes once, and runs this
// inside a transaction of its own under a statement timeout.
//
// The search is Artifacts' one search (search.ts prepareArtifactSearch, title
// only), which the agent API's list with `query` runs too: the visibility
// condition core hands over (on the items' home columns; it names the
// reader's server, and of another server lets through only Artifacts homed
// in a joint the reader sees whose own server has workspace_artifacts_v0
// on) and the live items only (liveArtifactsIn) with a readable current
// version, in the statement that ranks and limits; the same cursor. Each
// result is the Artifact's card, as the dashboard draws it, and its matches.
import { asSearchCursor, type ArtifactCard, type ArtifactSearchHit } from "@botiverse/raft-shared";
import type { AppSearchInput, AppSearchPage } from "../../platform/apps";
import { artifactCards, atCurrentVersions, hasReadableCurrentVersion } from "./webCards";
import { profiler, type ArtifactWebReader } from "./webCommon";
import { decodeListCursor, prepareArtifactSearch } from "./search";
import { ARTIFACT_HOME_COLUMNS, liveArtifactsIn } from "./visibility";

export async function searchArtifactsForCore(input: AppSearchInput): Promise<AppSearchPage<ArtifactSearchHit>> {
  const search = prepareArtifactSearch(input.q);
  const cursor = input.cursor === null ? null : decodeListCursor(input.cursor, search.digest);
  if (input.cursor !== null && !cursor) return { kind: "invalid_cursor" };
  const found = await search.run({
    visible: liveArtifactsIn(input.visibleHomesSql(ARTIFACT_HOME_COLUMNS)),
    // Only Artifacts with a card (a readable current version), in the statement that ranks and limits: a page is never short.
    conditions: [hasReadableCurrentVersion()],
    cursor,
    limit: input.limit,
    executor: input.executor,
  });

  const reader: ArtifactWebReader = { userId: input.viewer.userId, serverId: input.viewer.serverId, sessionFamilyId: null };
  const shown = await atCurrentVersions(found.items);
  const actorOf = await profiler(shown.map(({ item }) => ({ type: item.createdByType, id: item.createdById })));
  const cards = await artifactCards(reader, shown, actorOf);
  const cardOf = new Map<string, ArtifactCard>(shown.map(({ item }, index) => [item.id, cards[index]!]));
  // The statement kept only Artifacts with a card; one whose version went between the two reads is left out.
  const items = found.items.flatMap((item, index) => {
    const card = cardOf.get(item.id);
    return card ? [{ card, matches: found.matches[index]! }] : [];
  });
  return { kind: "page", items, nextCursor: found.nextCursor === null ? null : asSearchCursor(found.nextCursor) };
}

