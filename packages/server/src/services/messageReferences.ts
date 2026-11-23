// A chat message's links to first-party objects as core's `object_references`
// holds them (#proj-workspace:#336, step 2): the message is the SOURCE (kind
// `message`, a core source kind: services/objectReferences.ts
// CORE_SOURCE_KINDS), each object its visible links name a target, so an
// Artifact can list the messages that link it ("Linked from"; the read route
// comes later and joins the live message, `deleted_at IS NULL`).
//
// - What is read: the message's visible links, the one walk the apps told of
//   a new message share (firstPartyAppMessageLinks.messageObjectLinks: shared
//   messageVisibleLinks, each kind's linkId, each object once in message
//   order), at most OBJECT_REFERENCES_MAX_PER_SOURCE objects. Each row's
//   detail is `{ href, bare }` only (the link as written, an href past
//   MESSAGE_REFERENCE_HREF_MAX_BYTES left out): never the message's text.
// - The hot path pays nothing for a message that can't link an object:
//   recordMessageReferences first checks the text for an address on one of
//   Raft's hosts (platform/links appHosts, and each kind's
//   AppObjectKind.linkHosts), a string search, and without one returns at
//   once, no work scheduled and no query. With one, the links are read on a
//   later tick, after the commit, never awaited by the write that made the
//   message; a message whose links name no object stops there too, with no
//   query, unless it is an edit of a text that could have had rows.
// - Ordering (Tenny, #proj-workspace:#336): writes run after the commit, so an
//   older edit's write can land after a newer one's, or after a retraction.
//   Each write therefore runs in one short transaction that first locks the
//   message row (FOR NO KEY UPDATE: an edit's and a retraction's UPDATE wait
//   for it, or it for them; a foreign key's check does not) and re-reads it:
//   only while the message is live (`deleted_at IS NULL`) and its content is
//   still exactly the content the links were read from are its rows
//   replaced; otherwise the write is dropped, because whichever write changed
//   the content scheduled its own (or, a retraction, deleted the rows in its
//   transaction). So the rows are always those of the content the message
//   has now.
// - An edit passes the content it replaced: when that text had no address on
//   Raft's hosts the message has no rows (they are only written for its
//   current text), so the edit is a new message's case; otherwise the new
//   text's references replace the old ones (none: the old ones are deleted).
// - A retraction (assistantSendAsOwnerService.retractDelegatedMessage)
//   deletes the rows in its own transaction (deleteMessageReferences). A hard
//   delete leaves none to read: a server's purge deletes its rows by
//   server_id; a channel's delete cascades to its messages, and its rows are
//   left to the read's join.
// - The row's server is the message's storage server (`messages.server_id`,
//   a joint's messages the joint storage server's; its channel's for an
//   older row without one).
//
// Cost of a message whose text has an address on Raft's hosts and links an
// object (a create or an edit), or an edit whose old text had one: BEGIN; the
// message row's SELECT ... FOR NO KEY UPDATE (joined to its channel); the
// DELETE of its old rows; the INSERT of its new ones (none when it links no
// object any more); COMMIT. Three statements in one short transaction.
import { and, eq, isNull, sql } from "drizzle-orm";
import { asServerId } from "@botiverse/raft-shared";
import { linkedObjectKinds } from "../apps/firstPartyApps";
import { getDb, type DatabaseExecutor } from "../db/index";
import { channels, messages } from "../db/schema";
import { appHosts } from "../platform/links";
import { messageObjectLinks } from "./firstPartyAppMessageLinks";
import { deleteReferencesOfSource, OBJECT_REFERENCES_MAX_PER_SOURCE, replaceReferences, type ObjectReference, type ObjectReferenceDetail } from "./objectReferences";

/** The source kind of a message's references (CORE_SOURCE_KINDS). */
export const MESSAGE_REFERENCE_SOURCE_KIND = "message";

/** A link longer than this (UTF-8 bytes) is stored without its href, so the row's detail stays under the table's 4 KiB. */
export const MESSAGE_REFERENCE_HREF_MAX_BYTES = 2048;

const inFlight = new Set<Promise<void>>();

/**
 * The hosts on which a kind's linkId can name an object, lowercased: Raft's
 * app hosts (platform/links appHosts) and each kind's AppObjectKind.linkHosts;
 * none when no kind reads links.
 */
export function messageReferenceHosts(): string[] {
  const kinds = linkedObjectKinds();
  if (kinds.length === 0) return [];
  return [...new Set([...appHosts(), ...kinds.flatMap(({ objectKind }) => objectKind.linkHosts ?? [])].map((host) => host.toLowerCase()))];
}

/**
 * Whether `content` has an address on one of those hosts
 * (messageReferenceHosts), the only places a kind's linkId names an object:
 * a string search, case-insensitive, no parse, no query. False is certain
 * (no object link); true only means the links are worth reading.
 */
export function mayLinkObjects(content: string): boolean {
  if (!content.includes("://")) return false;
  const hosts = messageReferenceHosts();
  if (hosts.length === 0) return false;
  const text = content.toLowerCase();
  return hosts.some((host) => text.includes(host));
}

/** The references `content`'s links make, in message order (no query). */
export function messageReferencesOf(content: string): ObjectReference[] {
  return messageObjectLinks(content, OBJECT_REFERENCES_MAX_PER_SOURCE).map(({ entry, id, href, bare }): ObjectReference => {
    const detail: ObjectReferenceDetail = Buffer.byteLength(href, "utf8") <= MESSAGE_REFERENCE_HREF_MAX_BYTES ? { href, bare } : { bare };
    return { kind: entry.objectKind.kind, id, detail };
  });
}

/** How a write went: written, or dropped because the message changed or went since (another write owns it). */
export type MessageReferencesOutcome = "written" | "stale";

/**
 * Replace message `messageId`'s references with those of `content` (none:
 * delete them), in one short transaction, only while the message is live and
 * its content is still `content` (the header's ordering). Throws a database
 * error; the caller logs it.
 */
export async function writeMessageReferences(messageId: string, content: string, refs: readonly ObjectReference[] = messageReferencesOf(content)): Promise<MessageReferencesOutcome> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select({ serverId: sql<string>`COALESCE(${messages.serverId}, ${channels.serverId})` })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(and(eq(messages.id, messageId), isNull(messages.deletedAt), eq(messages.content, content)))
      .for("no key update", { of: messages })
      .limit(1);
    if (!row) return "stale";
    await replaceReferences(tx, { serverId: asServerId(row.serverId), kind: MESSAGE_REFERENCE_SOURCE_KIND, id: messageId }, refs);
    return "written";
  });
}

/**
 * Record a message's references after the commit that wrote its content: a
 * new message (`previousContent` null) or an edit (the content it replaced).
 * Returns at once and never throws: without an address on Raft's hosts in
 * either text, nothing at all (no work, no query); else the links are read
 * and written on a later tick, a failure logged and lost (the next edit
 * writes them again; the backfill script fills a missed one).
 */
export function recordMessageReferences(input: { messageId: string; content: string; previousContent: string | null }): void {
  const { messageId, content, previousContent } = input;
  const now = mayLinkObjects(content);
  // Rows are only ever written for a message's current text: when the text it
  // replaced had no address on Raft's hosts (or there was none), it has none.
  const hadRows = previousContent !== null && mayLinkObjects(previousContent);
  if (!now && !hadRows) return;
  const task = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      const refs = now ? messageReferencesOf(content) : [];
      // No rows to write and none to replace.
      if (refs.length === 0 && !hadRows) return;
      await writeMessageReferences(messageId, content, refs);
    })
    .catch((error: unknown) => {
      // Its class only: a database error's message may quote the content.
      console.warn("[messageReferences] a message's references were not stored", { messageId, errorClass: error instanceof Error ? error.name : typeof error });
    })
    .finally(() => { inFlight.delete(task); });
  inFlight.add(task);
}

/**
 * Delete a message's references in the caller's transaction (a retraction),
 * when its last content could have made any (`content`: the content it had);
 * else no query.
 */
export async function deleteMessageReferences(executor: DatabaseExecutor, messageId: string, content: string): Promise<void> {
  if (!mayLinkObjects(content)) return;
  await deleteReferencesOfSource(executor, MESSAGE_REFERENCE_SOURCE_KIND, messageId);
}

/** Waits until every write started so far has finished (tests). */
export async function drainMessageReferencesForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.all(inFlight);
}
