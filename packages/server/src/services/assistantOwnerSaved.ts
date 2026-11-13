/**
 * The owner's saved messages, as owner actions (#proj-assistant:#19; tygg
 * 42da9646: the assistant can see what the owner saved and change it).
 *
 *   list_owner_saved_messages(filter?)  read, GET /api/channels/saved
 *   save_message(message, saved)        direct, POST /api/channels/saved
 *                                       (`saved: false` unsaves; undo flips it)
 *
 * The first read that shows message content, so the content is held to what
 * the assistant itself can read (Tenny 86cf99d9, option c): a saved message
 * in a channel shows its preview only when the assistant can read that
 * channel; a DM the assistant isn't in (a DM the owner has with someone else)
 * is always a reference only. Each reference-only line says why (Sage
 * 4dfde2a6), so the model doesn't keep trying to open it. save_message reads
 * no content, so any message on the list can be saved or unsaved.
 *
 * One message reference everywhere (Sage): `#design msg=1a2b3c4d`, a thread
 * reply `#design:9f8e7d6c msg=…`, a DM `dm:@bob msg=…`; save_message takes
 * exactly what the list prints.
 */
import { asServerId } from "@botiverse/raft-shared";
import { inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents, users } from "../db/schema";
import * as channelService from "./channelService";
import { getServerHistoryWindowForRead } from "./historyWindow";
import { resolveMessageIdInServer } from "./messageService";
import * as savedService from "./savedService";
import { ownerFacingConversationRef, undoLine, type AssistantOwnerAction } from "./assistantOwnerActions";
import { readFilter, readName, renderOwnerList } from "./assistantOwnerReads";

/** How many saved messages the list reads (newest first) before "…and N more". */
export const OWNER_SAVED_READ_LIMIT = 100;
/**
 * With a filter, how many of the newest saved messages Raft reads to match it
 * itself (the route's own search reads content the assistant may not see).
 */
export const OWNER_SAVED_FILTER_SCAN = 500;
/** A preview is one line, cut at this many characters. */
export const OWNER_SAVED_PREVIEW_MAX = 200;

const short = (id: string) => id.slice(0, 8);

/** One line of message text, folded and cut at OWNER_SAVED_PREVIEW_MAX. */
export function savedPreview(content: unknown): string {
  const raw = typeof content === "string" ? content : "";
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > OWNER_SAVED_PREVIEW_MAX ? `${flat.slice(0, OWNER_SAVED_PREVIEW_MAX)}…` : flat;
}

/** Handles (`name`, without @) of the people and agents who wrote the messages. */
async function handles(entries: readonly savedService.SavedEntry[]): Promise<Map<string, string>> {
  const userIds = [...new Set(entries.filter((e) => e.senderType === "user" || e.senderType === "human").map((e) => e.senderId))];
  const agentIds = [...new Set(entries.filter((e) => e.senderType === "agent").map((e) => e.senderId))];
  const [userRows, agentRows] = await Promise.all([
    userIds.length ? getDb().select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, userIds)) : [],
    agentIds.length ? getDb().select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
  ]);
  return new Map([...userRows, ...agentRows].map((row) => [row.id, readName(row.name)]));
}

/** "2026-11-04 09:12Z" (absolute UTC, as agent text writes times). */
function when(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "time unknown";
  return `${date.toISOString().slice(0, 16).replace("T", " ")}Z`;
}

export const listOwnerSavedMessages: AssistantOwnerAction<null> = {
  key: "ownerSavedRead",
  tool: "list_owner_saved_messages",
  method: "GET",
  path: "/api/channels/saved",
  tier: "read",
  phrase: "list your owner's saved messages",
  description: () => "The messages your owner saved on this server, newest first: where (#channel msg=…), who wrote it, when, and a preview where you can read that conversation yourself; a DM your owner has with someone else, or a channel you're not in, shows only the reference. To save or unsave one, use save_message with that reference; to read a whole message you can see, use your own read tool.",
  params: [{ name: "filter", kind: "text", optional: true, description: "Optional: words in the message (any case). Only messages in conversations you can read are searched; with a filter, the others are left out." }],
  mapping: [{ param: "filter", into: "query", field: "filter" }],
  allowedFields: [],
  queryFields: ["filter"],
  async admit() {
    return { ok: true, before: null };
  },
  async render(scope, _result, query) {
    // The route ran as the owner (the owner may list them); Raft reads the list itself, so the
    // filter is Raft's (the route's own page is 20) and only these fields are taken.
    const filter = readFilter(query);
    const { cutoff } = await getServerHistoryWindowForRead(scope.serverId);
    const history = cutoff ? { cutoff, side: "inside" as const } : undefined;
    // Never the route's content search (Tenny 2c… 9ac4929a): a hidden message that matched would
    // tell the assistant what it says. With a filter, Raft reads the newest OWNER_SAVED_FILTER_SCAN
    // and matches each itself below; the count is of those matches only.
    const [scanned, savedTotal] = await Promise.all([
      savedService.listSaved(scope.ownerUserId, scope.serverId, { limit: filter ? OWNER_SAVED_FILTER_SCAN : OWNER_SAVED_READ_LIMIT, sort: "desc", history }),
      savedService.countSaved(scope.ownerUserId, scope.serverId, { history }),
    ]);
    // What the assistant can read: the conversation itself, a thread by its parent channel.
    const readable = await channelService.filterAgentAccessibleChannelIds(
      [...new Set(scanned.map((entry) => entry.parentChannelId ?? entry.channelId))],
      scope.agentId,
      asServerId(scope.serverId),
    );
    const authors = await handles(scanned);
    const lines: string[] = [];
    for (const entry of scanned) {
      const conversationId = entry.parentChannelId ?? entry.channelId;
      const conversationType = entry.parentChannelId ? entry.parentChannelType : entry.channelType;
      const conversationName = entry.parentChannelId ? entry.parentChannelName : entry.channelName;
      const isDm = conversationType === "dm";
      const base = isDm
        ? await ownerFacingConversationRef(scope.serverId, scope.ownerUserId, conversationId)
        : conversationName ? `#${readName(conversationName)}` : null;
      if (!base) continue;
      // A thread reply names its thread (`#design:9f8e7d6c`), a task message its task (`#design:#7`).
      const thread = entry.taskNumber !== undefined ? `:#${entry.taskNumber}` : entry.parentMessageId ? `:${short(entry.parentMessageId)}` : "";
      const ref = `${readName(base)}${thread} msg=${short(entry.messageId)}`;
      const author = authors.get(entry.senderId);
      const canRead = readable.has(conversationId);
      // With a filter, only messages in conversations the assistant can read are searched; the
      // others are left out (Tenny 9ac4929a, Sage eb319e94), so nothing hidden can be probed.
      if (filter) {
        if (!canRead) continue;
        const text = typeof entry.content === "string" ? entry.content.toLowerCase() : "";
        if (!text.includes(filter)) continue;
      }
      const fields = [ref, author ? `@${author}` : "someone", when(entry.createdAt)];
      if (canRead) {
        fields.push(`"${savedPreview(entry.content)}"`);
      } else {
        fields.push(isDm ? "content not shown: a DM your owner has with someone else" : `content not shown: you're not in ${readName(base)}`);
      }
      lines.push(fields.join(" · "));
    }

    const notes = filter
      ? (savedTotal > scanned.length ? [`Searched the newest ${scanned.length} of your owner's ${savedTotal} saved messages.`] : [])
      : (savedTotal > scanned.length ? [`Showing the newest ${scanned.length} of ${savedTotal}. To narrow it, pass filter.`] : []);
    return renderOwnerList({
      heading: filter ? `Your owner's saved messages you can read, containing "${readName(filter)}"` : "Your owner's saved messages on this server, newest first",
      lines,
      empty: filter ? `None of the saved messages you can read on this server contain "${readName(filter)}".` : "Your owner hasn't saved any messages on this server.",
      more: "To narrow it, pass filter.",
      notes,
    });
  },
};

/** The message a reference names: `… msg=1a2b3c4d` (or a bare id), in this server. */
async function messageOfRef(serverId: string, ref: unknown): Promise<string | null> {
  if (typeof ref !== "string") return null;
  const trimmed = ref.trim();
  const id = /(?:^|\s)msg=([0-9a-f-]{8,36})\s*$/i.exec(trimmed)?.[1] ?? (/^[0-9a-f-]{8,36}$/i.test(trimmed) ? trimmed : null);
  if (!id) return null;
  const resolved = await resolveMessageIdInServer(serverId, id.toLowerCase());
  return resolved.ok ? resolved.messageId : null;
}

type SaveBefore = { messageId: string; ref: string; saved: boolean };

export const saveMessage: AssistantOwnerAction<SaveBefore> = {
  key: "messageSave",
  tool: "save_message",
  method: "POST",
  path: "/api/channels/saved",
  tier: "direct",
  phrase: "save or unsave a message",
  description: (owner) => `Save or unsave a message for your owner (${owner}), by the message reference list_owner_saved_messages shows (#channel msg=…). Runs right away; undo: the same call with saved flipped. ${owner} sees each change in their settings, under "Changed by your assistant".`,
  params: [
    { name: "message", kind: "text", description: "The message, as list_owner_saved_messages or a message header names it: #design msg=1a2b3c4d, #design:9f8e7d6c msg=…, or dm:@bob msg=…." },
    { name: "saved", kind: "boolean", description: "true to save, false to unsave." },
  ],
  mapping: [
    { param: "message", into: "body", field: "message" },
    { param: "saved", into: "body", field: "saved" },
  ],
  allowedFields: ["message", "saved"],
  requiredFields: ["message", "saved"],
  async admit(scope) {
    if (typeof scope.body.saved !== "boolean") return { ok: false, refusal: { status: 400, code: "assistant_owner_action_invalid", error: "saved must be true or false." } };
    const messageId = await messageOfRef(scope.serverId, scope.body.message);
    // A message the owner can't save here reads like no message at all (the route's own rule).
    if (!messageId || !await savedService.canSaveMessage(scope.ownerUserId, scope.serverId, messageId)) return { ok: false };
    const saved = await savedService.isSaved(scope.ownerUserId, messageId);
    const ref = readName(scope.body.message);
    return { ok: true, before: { messageId, ref, saved }, routeBody: { messageId, saved: scope.body.saved } };
  },
  async describe(_scope, before, owner, result) {
    const after = typeof result.saved === "boolean" ? result.saved : before.saved;
    const done = after
      ? (before.saved ? `Nothing changed: ${before.ref} was already saved for ${owner}.` : `Saved ${before.ref} for ${owner}.`)
      : (before.saved ? `Unsaved ${before.ref} for ${owner}.` : `Nothing changed: ${before.ref} wasn't saved for ${owner}.`);
    const undo = before.saved !== after ? { tool: "save_message", args: { message: before.ref, saved: before.saved } } : null;
    return {
      done,
      undo: undo ? { ...undo, text: undoLine(undo) } : null,
      audit: { targetId: before.messageId, previousValue: before.saved, nextValue: after },
    };
  },
};
