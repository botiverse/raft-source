// A conversation's Artifacts, for its Files panel:
// `GET /api/artifacts/conversations/:channelId?cursor=`
// (ArtifactWebConversationArtifacts), for the signed-in reader in the
// request's server.
//
// What it lists: live Artifacts whose home is that conversation, with a
// published current version, that the reader can see. Not the ones only
// linked or sent there (messages carry nothing of Artifacts; a link's card is
// core's summaries). It only reads: no read position moves.
//
// It checks, in order:
// 1. workspace_artifacts_v0 for the reader's server (403 ARTIFACTS_NOT_ENABLED);
// 2. the query: `cursor` a page's nextCursor (400 INVALID_REQUEST), before
//    the conversation, so a refusal never depends on it;
// 3. the conversation: a live top-level conversation of the reader's server
//    (a thread's or task's: its parent) that the reader can see now, by core's
//    channel access (platform/conversations readableConversation); anything
//    else, an unknown id or one that isn't one included, is one 404
//    TARGET_NOT_FOUND with the id as asked.
//
// Who sees what: visibleArtifactsSql (the list form of canViewArtifacts, as
// the dashboard, search and the agent list) is part of the query, so a page
// and its cursor count only what the reader can see; deleted, revoked and
// orphaned Artifacts are never listed. Seeing the conversation only lets the
// reader ask; every row still passes the Artifact rule.
//
// Joint channels: the reader names the joint by its own server's projection;
// its Artifacts name the joint's canonical channel, or (published before
// publish stored that, or in a channel converted since) a server's projection
// of it, so the filter takes every id the joint's Artifacts may name
// (platform/visibility jointHomeAliases), as the agent list's `target` does,
// and visibleArtifactsSql keeps each server's pairs and its flag. The cards
// name the home by the reader's projection (artifactCards, through
// conversationNames and localConversationIds).
//
// Order and paging: newest first by the item's updated_at at millisecond
// precision, then id; ARTIFACT_CONVERSATION_PAGE_LIMIT a page; a keyset
// cursor, the agent list's (search.ts encodeListCursor without a query), so
// an Artifact updated while someone pages moves to the top and may be
// skipped for the rest of that run, never listed twice. A constant number of
// queries: the flag, the conversation (at most four), the visible homes, the
// page, the current versions, profiles, and the cards' comment counts and
// conversation names. The page query is the items of one home
// (idx_items_home_channel) filtered by the reader's visible homes.
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { ARTIFACT_CONVERSATION_PAGE_LIMIT, type ArtifactWebConversationArtifacts } from "@botiverse/raft-shared";
import { readableConversation } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { jointHomeAliases } from "../../platform/visibility";
import { json, TARGET_NOT_FOUND_ERROR, type ArtifactApiJson } from "./apiCommon";
import { artifactItems } from "./schema";
import { decodeListCursor, encodeListCursor, updatedMs, type ListCursor } from "./search";
import { visibleArtifactsSql } from "./visibility";
import { artifactCards, atCurrentVersions, cardAuthorRef, hasReadableCurrentVersion } from "./webCards";
import { answerWeb, profiler, readerViewActor, refuse, requireWebEnabled, webFail, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";

/** The one answer for a conversation the reader can't see, or that doesn't exist. */
const conversationNotFound = (conversationId: string): ArtifactWebApiError =>
  webFail(404, { code: "TARGET_NOT_FOUND", error: TARGET_NOT_FOUND_ERROR, details: { conversationId } });

function parseCursor(query: Record<string, unknown>): ListCursor | null {
  const { cursor } = query;
  if (cursor === undefined) return null;
  const parsed = typeof cursor === "string" ? decodeListCursor(cursor, null) : null;
  if (!parsed) refuse(400, { code: "INVALID_REQUEST", error: "That page of this conversation's artifacts isn't one the list gave out: reload the list to start from the top." });
  return parsed;
}

export function createConversationOperations() {
  return {
    conversationArtifacts: (
      reader: ArtifactWebReader,
      channelId: string,
      query: Record<string, unknown>,
    ): Promise<ArtifactApiJson<ArtifactWebConversationArtifacts> | ArtifactWebApiError> => answerWeb(async () => {
      await requireWebEnabled(reader);
      const cursor = parseCursor(query);
      const conversation = await readableConversation(reader, channelId);
      if (!conversation) return conversationNotFound(channelId);
      // A joint's Artifacts name its canonical channel, or a server's projection of it.
      const homes = conversation.homeChannelId === conversation.conversationId
        ? [conversation.homeChannelId]
        : await jointHomeAliases([conversation.homeChannelId]);

      const limit = ARTIFACT_CONVERSATION_PAGE_LIMIT;
      const visible = await visibleArtifactsSql(readerViewActor(reader));
      const after = cursor ? sql`(${updatedMs}, ${artifactItems.id}) < (${cursor.updatedAt.toISOString()}::timestamptz, ${cursor.id})` : undefined;
      const rows = await getDb().select().from(artifactItems).where(and(
        visible,
        eq(artifactItems.homeKind, "conversation"),
        inArray(artifactItems.homeChannelId, homes),
        // The card shows the current version: never one never published, so a page counts only rows with a card.
        hasReadableCurrentVersion(),
        after,
      )).orderBy(desc(updatedMs), desc(artifactItems.id)).limit(limit + 1);
      const page = rows.slice(0, limit);

      // An Artifact unpublished between the two queries is left out of this page.
      const shown = await atCurrentVersions(page);
      const actorOf = await profiler(shown.map(cardAuthorRef));
      const cards = await artifactCards(reader, shown, actorOf);
      const last = page[page.length - 1];
      return json<ArtifactWebConversationArtifacts>({
        rows: cards.map((card) => ({ card })),
        nextCursor: rows.length > limit && last ? encodeListCursor(last, null) : null,
      });
    }),

    /** A conversation id that isn't valid percent-encoding: the flag first, as every route, then the one 404. */
    undecodableConversation: (reader: ArtifactWebReader, rawId: string): Promise<ArtifactWebApiError> => answerWeb(async () => {
      await requireWebEnabled(reader);
      return conversationNotFound(rawId);
    }),
  };
}
