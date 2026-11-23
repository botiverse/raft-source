// Messages that link first-party objects (AppObjectKind.linkedInMessage): an
// Artifact's original message, `link` (apps/artifacts/linkOrigin.ts). Core
// reads the new message's links as the web reads its object cards (shared
// messageVisibleLinks, bare or with words, code and images left out; the
// first MESSAGE_OBJECT_LINK_LIMIT object links, as the web's
// useMessageLinkCards), asks each kind that reads links (linkId) which of
// its objects they name, and hands each kind that wants them its ids.
//
// Called by messageService.broadcastAndDeliver for a new chat message of a
// person or an agent, after the send committed. Never awaited by the send:
// the links are read and the apps called on a later tick, and a failure is
// logged and lost (the send stands; the app's record is best effort).
import { messageVisibleLinks } from "@botiverse/raft-shared/src/appLinkPreview";
import { linkedObjectKinds } from "../apps/firstPartyApps";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import type { AppLinkingMessage } from "../platform/apps";

/** At most this many distinct object links of one message are read, in message order (the web's MESSAGE_OBJECT_LINK_LIMIT). */
export const MESSAGE_OBJECT_LINK_LIMIT = 10;

const inFlight = new Set<Promise<void>>();

type LinkedKind = ReturnType<typeof linkedObjectKinds>[number];

/** One object a message's visible links name: the kind that read it, its id, and the link as written. */
export interface MessageObjectLink {
  entry: LinkedKind;
  id: string;
  href: string;
  /** The address is the link's text (shared messageVisibleLinks). */
  bare: boolean;
}

/**
 * The objects `content`'s visible links name (shared messageVisibleLinks, as
 * the web reads its object cards), each once (its first link), in message
 * order, at most `limit` of them: for each link, the first kind that reads
 * links (linkId, registry order) whose linkId names an object. Pure and
 * synchronous: no database. The one walk both readers share: the apps told
 * of a new message (MESSAGE_OBJECT_LINK_LIMIT, as the web counts its cards)
 * and the message's object_references (services/messageReferences.ts,
 * OBJECT_REFERENCES_MAX_PER_SOURCE; #proj-workspace:#336).
 */
export function messageObjectLinks(content: string, limit: number): MessageObjectLink[] {
  const kinds = linkedObjectKinds();
  const found: MessageObjectLink[] = [];
  if (kinds.length === 0 || limit <= 0) return found;
  const seen = new Set<string>();
  for (const { href, bare } of messageVisibleLinks(content)) {
    for (const entry of kinds) {
      const id = entry.objectKind.linkId(href);
      if (id === null) continue;
      const key = `${entry.objectKind.kind}:${id}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ entry, id, href, bare });
      }
      break;
    }
    if (found.length >= limit) break;
  }
  return found;
}

/**
 * The ids each kind that wants them (linkedInMessage) reads from `content`'s
 * visible links: each object once, in message order, among the first
 * MESSAGE_OBJECT_LINK_LIMIT object links of any kind that reads links (as the
 * web counts them for its cards).
 */
function linkedIdsByKind(content: string): Array<{ entry: LinkedKind; ids: string[] }> {
  if (!linkedObjectKinds().some(({ objectKind }) => objectKind.linkedInMessage !== undefined)) return [];
  const found = new Map<LinkedKind, string[]>();
  for (const { entry, id } of messageObjectLinks(content, MESSAGE_OBJECT_LINK_LIMIT)) {
    if (entry.objectKind.linkedInMessage === undefined) continue;
    const ids = found.get(entry) ?? [];
    ids.push(id);
    found.set(entry, ids);
  }
  return [...found].map(([entry, ids]) => ({ entry, ids }));
}

async function tellApps(message: AppLinkingMessage, content: string): Promise<void> {
  for (const { entry, ids } of linkedIdsByKind(content)) {
    try {
      await entry.objectKind.linkedInMessage?.(message, ids);
    } catch (error) {
      console.warn("[firstPartyAppMessageLinks] an app's linkedInMessage failed", { app: entry.app.id, kind: entry.objectKind.kind, messageId: message.id, error: serializeErrorForLog(error) });
    }
  }
}

/**
 * Tells the apps whose objects a new message links (AppObjectKind.linkedInMessage),
 * on a later tick; returns at once and never throws.
 */
export function announceMessageObjectLinks(message: AppLinkingMessage, content: string): void {
  if (!content.includes("://")) return;
  const task = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => tellApps(message, content))
    .catch((error: unknown) => {
      console.warn("[firstPartyAppMessageLinks] reading a message's object links failed", { messageId: message.id, error: serializeErrorForLog(error) });
    })
    .finally(() => { inFlight.delete(task); });
  inFlight.add(task);
}

/** Waits until every announcement started so far has finished (tests). */
export async function drainMessageObjectLinksForTests(): Promise<void> {
  while (inFlight.size > 0) await Promise.all(inFlight);
}
