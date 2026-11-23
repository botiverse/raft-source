// What links to an Artifact, for the reader who asks (#proj-workspace:#336
// step 2, part A2, "Linked from"; reviewed with Tenny): `GET
// /api/artifacts/:id/backlinks` (webRoutes.ts, signed in only; contract:
// shared webArtifactsContract.ts artifactWebPaths.backlinks,
// ArtifactWebBacklinks). Reads only, moves no read position, stores nothing
// per reader. No signed-out route in v1.
//
// - The Artifact is read as the viewer reads it (readableItemFor: the flag's
//   403, the one 404 for one the reader can't see or that doesn't exist).
// - `documents`: other Artifacts whose CURRENT version links this one: core's
//   object_references rows of source kind `artifact` naming it
//   (platform/references sourcesReferencingSql; a push replaces a source's
//   rows, so only current versions have any), the source live with a
//   published, unrevoked current version (hasReadableCurrentVersion's rule,
//   as a join), never this Artifact itself, and only those the reader sees:
//   visibleArtifactsSql (the list form of canViewArtifacts, as the dashboard
//   and a conversation's Artifacts list) in the same statement, so the count
//   holds only what the reader can see. Newest current version first, then
//   id. Each as the card a message's link shows (webCards.ts artifactCards:
//   the live title, the reader's view of the home, an outsider's author
//   without an id).
// - `discussions`: chat messages that link it, core's rules for who reads a
//   message (platform/references messageBacklinks, services/messageBacklinks.ts:
//   the reader's visible conversations as message search reads them, the
//   history window, live messages, a page re-read so a message that no
//   longer links it is dropped), each where the reader reads it (a joint by
//   the reader's projection) with an excerpt of its text now. Only for a
//   reader inside the Artifact's server (accessOf `inside`, the rule the
//   original message follows: origin.ts); anyone else gets an empty group,
//   so another server's reader of a public Artifact learns nothing of this
//   server's conversations. The author is named as a card's is (profiler); a
//   sender Raft names no one here (a connected workspace's person) is null.
// - Counts are after the filters, each group counted up to
//   ARTIFACT_BACKLINKS_COUNT_CAP rows (`capped` past it), the page the newest
//   ARTIFACT_BACKLINKS_PAGE_LIMIT. A discussion's count can include a message
//   that still names a Raft address but no longer this Artifact (known limit,
//   services/messageBacklinks.ts); the page never lists one.
//
// Cost, a constant number of queries however many links: the item and the
// flag, its sight (readableItemFor); then at once the documents (the visible
// homes, then the count and the page at once, then the cards' profiles and
// facts) and the discussions (messageBacklinks' own few, then one profile
// lookup).
//
// The agent read's `linkedFrom` (`raft artifact read`'s "Linked from",
// #336 step 2, PR-C; contract: agentApiArtifactsContract
// agentApiArtifactReadResponseSchema; routes.ts read) is the same two groups
// read the same way with the AGENT as the viewer (apiCommon viewActor):
// `documents` by visibleArtifactsSql for the agent, `discussions` by
// messageBacklinks for the agent (visibleRootChannelIds: its channels through
// filterAgentAccessibleChannelIds), only inside the Artifact's server; the
// newest AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN of each. A personal
// assistant never gets here (services/assistantRouteAllowlist.ts:
// artifactRead is refused to it; it reads through assistantOwnerArtifact, as
// its owner), so no owner's-DM narrowing (`allowedRootChannelIds`) applies.
// A document as its id and live title; a message as the agent names its
// conversation (platform/conversations agentConversationRefs, a thread's
// reply by its thread target: agentOriginOf's rule, origin.ts), its id, and
// its sender's handle (namer); one it can't name (a DM peer it has no name
// for) is counted, not listed. Two more lookups at once (the names, the
// handles), however many links.
import { and, desc, eq, isNotNull, isNull, ne, sql, type SQL } from "drizzle-orm";
import {
  AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN,
  ARTIFACT_BACKLINKS_COUNT_CAP,
  ARTIFACT_BACKLINKS_PAGE_LIMIT,
  agentTaskThreadTarget,
  asChannelId,
  asMessageId,
  type AgentApiArtifactLinkedFrom,
  type ArtifactActor,
  type ArtifactBacklinkGroup,
  type ArtifactBacklinkMessage,
  type ArtifactCard,
  type ArtifactWebBacklinks,
} from "@botiverse/raft-shared";
import { agentConversationRefs } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { messageBacklinks, sourcesReferencingSql, type MessageBacklink, type MessageBacklinks } from "../../platform/references";
import type { ServerViewActor } from "../../platform/visibility";
import { accessOf, json, namer, viewActor, type ArtifactActorRef, type ArtifactAgent, type ArtifactApiJson } from "./apiCommon";
import { ARTIFACT_OBJECT_KIND } from "./kinds";
import { artifactItems, artifactVersions, type ArtifactItemRow } from "./schema";
import { visibleArtifactsSql } from "./visibility";
import { artifactCards, cardAuthorRef, type ShownArtifact } from "./webCards";
import { answerWeb, profiler, readableItemFor, readerViewActor, type ArtifactWebApiError, type ArtifactWebReader } from "./webCommon";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_MESSAGES: MessageBacklinks = { items: [], total: 0, capped: false };

/** `item` as a target of references. */
const targetOf = (item: ArtifactItemRow) => ({ kind: ARTIFACT_OBJECT_KIND, id: item.id });

/**
 * The other Artifacts whose current version links `item`, as `viewer` sees
 * them: the newest `limit` with their current versions, and how many there
 * are, the count and the page at once.
 */
async function artifactsLinking(viewer: ServerViewActor, item: ArtifactItemRow, limit: number): Promise<{ page: ShownArtifact[]; total: number; capped: boolean }> {
  const visible = await visibleArtifactsSql(viewer);
  const linking: SQL = and(
    visible,
    sql`${artifactItems.id} IN ${sourcesReferencingSql(ARTIFACT_OBJECT_KIND, targetOf(item))}`,
    ne(artifactItems.id, item.id),
    // The current version as a card shows it: published, not revoked (hasReadableCurrentVersion).
    isNull(artifactVersions.revokedAt),
    isNotNull(artifactVersions.position),
  )!;
  const db = getDb();
  const cap = ARTIFACT_BACKLINKS_COUNT_CAP;
  const [counted, page] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(
      db.select({ one: sql`1`.as("one") }).from(artifactItems)
        .innerJoin(artifactVersions, eq(artifactVersions.id, artifactItems.currentVersionId))
        .where(linking)
        .limit(cap + 1)
        .as("linking"),
    ),
    db.select({ item: artifactItems, version: artifactVersions }).from(artifactItems)
      .innerJoin(artifactVersions, eq(artifactVersions.id, artifactItems.currentVersionId))
      .where(linking)
      .orderBy(desc(artifactVersions.createdAt), desc(artifactItems.id))
      .limit(limit),
  ]);
  const n = Number(counted[0]?.n ?? 0);
  const shown: ShownArtifact[] = page.map(({ item: source, version }) => ({ item: source, version, current: version, pinned: false }));
  return { page: shown, total: Math.min(n, cap), capped: n > cap };
}

/** The header's `documents`: artifactsLinking for the reader, as cards. */
async function documentsLinking(reader: ArtifactWebReader, item: ArtifactItemRow): Promise<ArtifactBacklinkGroup<ArtifactCard>> {
  const { page, total, capped } = await artifactsLinking(readerViewActor(reader), item, ARTIFACT_BACKLINKS_PAGE_LIMIT);
  const actorOf = await profiler(page.map(cardAuthorRef));
  return { items: await artifactCards(reader, page, actorOf), total, capped };
}

/** A message's sender as a card names an actor: a person's or an agent's (by uuid), else null. */
const senderRef = ({ sender }: MessageBacklink): ArtifactActorRef | null =>
  (sender.type === "user" || sender.type === "agent") && UUID.test(sender.id) ? { type: sender.type, id: sender.id } : null;

/** The chat messages that link `item` as `viewer` reads them, the newest `limit`: none for a viewer outside its server. */
function messagesLinking(viewer: ServerViewActor, item: ArtifactItemRow, limit: number): Promise<MessageBacklinks> {
  if (!accessOf(viewer, item).inside) return Promise.resolve(NO_MESSAGES);
  return messageBacklinks(viewer, targetOf(item), { limit, countCap: ARTIFACT_BACKLINKS_COUNT_CAP });
}

/** The chat messages that link `item`, for a reader inside its server only (the header's `discussions`). */
async function discussionsLinking(reader: ArtifactWebReader, item: ArtifactItemRow): Promise<ArtifactBacklinkGroup<ArtifactBacklinkMessage>> {
  const found = await messagesLinking(readerViewActor(reader), item, ARTIFACT_BACKLINKS_PAGE_LIMIT);
  const actorOf = await profiler(found.items.flatMap((message) => {
    const ref = senderRef(message);
    return ref ? [ref] : [];
  }));
  return {
    items: found.items.map((message): ArtifactBacklinkMessage => {
      const ref = senderRef(message);
      const author: ArtifactActor | null = ref ? actorOf(ref) : null;
      return {
        messageId: asMessageId(message.messageId),
        conversationId: asChannelId(message.conversationId),
        ...(message.threadRootId ? { threadRootId: asMessageId(message.threadRootId) } : {}),
        author,
        createdAt: message.createdAt.toISOString(),
        excerpt: message.excerpt,
      };
    }),
    total: found.total,
    capped: found.capped,
  };
}

/**
 * The agent read's `linkedFrom` (this file's header): what links `item` as
 * the agent sees it, the newest AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN of
 * each group; a message by the conversation as the agent names it.
 */
/** Tests only: make the "Linked from" lookup of `raft artifact read` throw, to pin that the read answers without it. */
let linkedFromFailsForTests = false;
export function __setAgentLinkedFromFailsForTests(fails: boolean): void {
  linkedFromFailsForTests = fails;
}

/**
 * `raft artifact read`'s "Linked from", or undefined when it couldn't be read
 * (Tenny on #15753): the read is the most-used Artifact call and the field is
 * optional, so a failing lookup is logged and left out, never the read's
 * failure. The text shows no block without it.
 */
export async function agentLinkedFromOf(agent: ArtifactAgent, item: ArtifactItemRow): Promise<AgentApiArtifactLinkedFrom | undefined> {
  try {
    if (linkedFromFailsForTests) throw new Error("linked-from lookup failed (test)");
    return await linkedFromOf(agent, item);
  } catch (error) {
    console.warn("[artifacts] an Artifact read's \"Linked from\" was not read; the read answers without it", {
      artifactId: item.id,
      errorClass: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

async function linkedFromOf(agent: ArtifactAgent, item: ArtifactItemRow): Promise<AgentApiArtifactLinkedFrom> {
  const viewer = viewActor(agent);
  const limit = AGENT_API_ARTIFACT_READ_LINKED_FROM_SHOWN;
  const [documents, discussions] = await Promise.all([artifactsLinking(viewer, item, limit), messagesLinking(viewer, item, limit)]);
  const conversationIds = [...new Set(discussions.items.map((message) => message.conversationId))];
  const [refs, name] = await Promise.all([
    conversationIds.length > 0 ? agentConversationRefs(agent, conversationIds) : new Map<string, { target: string | null }>(),
    namer(discussions.items.flatMap((message) => {
      const ref = senderRef(message);
      return ref ? [ref] : [];
    })),
  ]);
  return {
    documents: {
      items: documents.page.map(({ item: source }) => ({ id: source.id, title: source.title })),
      total: documents.total,
      capped: documents.capped,
    },
    discussions: {
      items: discussions.items.flatMap((message) => {
        const target = refs.get(message.conversationId)?.target;
        if (!target) return [];
        const sender = senderRef(message);
        return [{
          target: message.threadRootId !== null ? agentTaskThreadTarget(target, message.threadRootId) : target,
          messageId: message.messageId,
          author: sender ? name(sender) : null,
        }];
      }),
      total: discussions.total,
      capped: discussions.capped,
    },
  };
}

export function createBacklinkOperations() {
  return {
    /**
     * `GET /:id/backlinks`: the Artifact as the viewer reads it
     * (readableItemFor: 403 ARTIFACTS_NOT_ENABLED, the one 404), then what
     * links to it for this reader (the header).
     */
    backlinks: (reader: ArtifactWebReader, id: string): Promise<ArtifactApiJson<ArtifactWebBacklinks> | ArtifactWebApiError> => answerWeb(async () => {
      const item = await readableItemFor(reader, id);
      const [documents, discussions] = await Promise.all([documentsLinking(reader, item), discussionsLinking(reader, item)]);
      return json<ArtifactWebBacklinks>({ documents, discussions });
    }),
  };
}
