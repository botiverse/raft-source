/**
 * The owner's sidebar, as owner actions (#proj-assistant:#19; the table and
 * its rules: assistantOwnerActions.ts). Both entries are `transform` entries
 * on the owner's own PATCH /api/servers/:id/sidebar-order (Tenny's ruling):
 * the tool's arguments arrive as the request body, and Raft reads the owner's
 * sidebar in the same request, computes the route's own body the way the web
 * does for a drag or a pin, and the owner's handler runs unchanged on it. No
 * client reads and writes the order itself.
 *
 *   move_conversation(target, position)  where it sits in its own list: the
 *     channels, the External list (joint and external-only channels) or the
 *     DMs with people. Like a drag in the web (sidebarDnd's
 *     replaceSidebarSubsetOrder): only that list's ids move inside the stored
 *     order, and ids the stored order doesn't list yet are completed the way
 *     the web completes them (reconcileOrderIds). A list sorted by name or by
 *     recent activity is refused: manual order would not show. A pinned item,
 *     an item in a custom section and #all (always first) are refused too.
 *   pin_conversation(target, pinned)     adds or removes the pinned ref, as
 *     the web's pin toggle does; an item in a custom section is refused
 *     (pinning it would take it out of the section, which undo cannot put back).
 *   arrange_conversations(list, order)   a whole list's order in one call
 *     (#proj-assistant:#28, Artea: N moves were N round trips, and pinned ones
 *     had to be unpinned and pinned again). `pinned`: exactly these, pinned in
 *     this order (the others it can see unpinned; pins it can't see, with no
 *     DM yet or on an archived channel, kept after them). `channels` / `external` / `dms`: these
 *     first, in this order, the rest of the list after them as they were. The
 *     same refusals as a move or a pin, for every item, before anything changes.
 */
import { asServerId } from "@botiverse/raft-shared";
import { mapWithConcurrency } from "../lib/mapWithConcurrency";
import * as channelService from "./channelService";
import * as serverService from "./serverService";
import {
  ownerFacingConversationRef,
  undoLine,
  type AssistantOwnerAction,
  type AssistantOwnerActionArg,
  type AssistantOwnerActionRefusal,
  type AssistantOwnerActionRequestScope,
} from "./assistantOwnerActions";

type SortMode = "manual" | "recent" | "az";
type ListKind = "channels" | "external" | "dms";
type PinnedRef = serverService.SidebarPinnedRef;

interface OwnerSidebar {
  order: serverService.SidebarOrderPreferences & { pinned: PinnedRef[] };
  channels: Array<{ id: string; type: string; name: string | null }>;
  externalIds: Set<string>;
  dms: Array<{ id: string; peerType: string | null; peerId: string | null }>;
  allChannelId: string | null;
}

/** The owner's sidebar as the web builds it: the stored order (pins and sections canonical) and what it lists. */
async function readOwnerSidebar(serverId: string, ownerUserId: string): Promise<OwnerSidebar | null> {
  // routes/servers.ts owns the hydrated read (GET /sidebar-order); loaded lazily, it imports the auth chain.
  const { loadSidebarOrderResponse } = await import("../routes/servers");
  const [order, channelRows, dmRows] = await Promise.all([
    loadSidebarOrderResponse(serverId, ownerUserId),
    channelService.listChannels(serverId, ownerUserId),
    channelService.listDMChannels(serverId, ownerUserId),
  ]);
  if (!order) return null;
  const channels = (channelRows as Array<{ id: string; type: string; name: string | null; archivedAt?: unknown }>)
    .filter((channel) => !channel.archivedAt)
    .map((channel) => ({ id: channel.id, type: channel.type, name: channel.name }));
  const externalIds = await channelService.channelIdsWithExternalRelation(
    channels.filter((channel) => channel.type === "channel" || channel.type === "private").map((channel) => channel.id),
  );
  const dms = (dmRows as Array<{ id: string; peerType?: string | null; peerId?: string | null }>)
    .map((dm) => ({ id: dm.id, peerType: dm.peerType ?? null, peerId: dm.peerId ?? null }));
  return { order, channels, externalIds: new Set(externalIds), dms, allChannelId: channels.find((channel) => channel.name === "all")?.id ?? null };
}

/** The web's reconcileOrderIds: the stored ids that still exist, then the rest in list order; `first` leads. */
export function reconcileOrderIds(itemIds: readonly string[], storedIds: readonly string[], first?: string | null): string[] {
  const present = new Set(itemIds);
  const next: string[] = [];
  if (first && present.has(first)) next.push(first);
  for (const id of storedIds) if (id !== first && present.has(id) && !next.includes(id)) next.push(id);
  for (const id of itemIds) if (id !== first && !next.includes(id)) next.push(id);
  return next;
}

/** The web's replaceSidebarSubsetOrder: the subset's slots in the full order take the new subset order. */
export function replaceSubsetOrder(fullOrder: readonly string[], previousSubset: readonly string[], nextSubset: readonly string[]): string[] {
  const subset = new Set(previousSubset);
  let index = 0;
  const next = fullOrder.map((id) => {
    if (!subset.has(id)) return id;
    const replacement = nextSubset[index];
    index += 1;
    return replacement ?? id;
  });
  for (; index < nextSubset.length; index += 1) next.push(nextSubset[index]!);
  return next;
}

function pinnedRefKey(ref: PinnedRef): string {
  return `${ref.kind}:${ref.id}`;
}

/** The pinned ref the web uses for a conversation: a channel by id, a DM by its peer. */
function pinnedRefOf(sidebar: OwnerSidebar, conversationId: string): PinnedRef | null {
  const dm = sidebar.dms.find((row) => row.id === conversationId);
  if (dm) {
    if (dm.peerType === "agent" && dm.peerId) return { kind: "agent", id: dm.peerId };
    if (dm.peerType === "user" && dm.peerId) return { kind: "human", id: dm.peerId };
    return null;
  }
  return sidebar.channels.some((channel) => channel.id === conversationId) ? { kind: "channel", id: conversationId } : null;
}

function isPinned(sidebar: OwnerSidebar, conversationId: string): boolean {
  const ref = pinnedRefOf(sidebar, conversationId);
  return !!ref && sidebar.order.pinned.some((pinned) => pinnedRefKey(pinned) === pinnedRefKey(ref));
}

function isInCustomSection(sidebar: OwnerSidebar, conversationId: string): boolean {
  return sidebar.order.sectionPlacements.some((placement) => placement.kind === "channel" && placement.id === conversationId);
}

/** Which list of the sidebar a conversation sits in; null when it is in none (an agent's DM sits under Agents). */
function listKindOf(sidebar: OwnerSidebar, conversationId: string): ListKind | null {
  const dm = sidebar.dms.find((row) => row.id === conversationId);
  if (dm) return dm.peerType === "user" ? "dms" : null;
  const channel = sidebar.channels.find((row) => row.id === conversationId);
  if (!channel) return null;
  return channel.type === "joint" || sidebar.externalIds.has(channel.id) ? "external" : "channels";
}

function sortModeOf(sidebar: OwnerSidebar, kind: ListKind): SortMode {
  if (kind === "dms") return sidebar.order.dmSortMode;
  return kind === "external" ? sidebar.order.jointChannelSortMode : sidebar.order.channelSortMode;
}

interface ListView {
  /** The stored order this list writes (channelOrder or dmOrder), completed like the web. */
  full: string[];
  /** What the list shows in manual order: neither pinned, nor in a custom section, nor #all. */
  shown: string[];
  field: "channelOrder" | "dmOrder";
}

function listView(sidebar: OwnerSidebar, kind: ListKind): ListView {
  if (kind === "dms") {
    const full = reconcileOrderIds(sidebar.dms.map((dm) => dm.id), sidebar.order.dmOrder);
    const hidden = new Set(sidebar.order.hiddenDmIds);
    const shown = full.filter((id) => listKindOf(sidebar, id) === "dms" && !hidden.has(id) && !isPinned(sidebar, id) && !isInCustomSection(sidebar, id));
    return { full, shown, field: "dmOrder" };
  }
  const full = reconcileOrderIds(sidebar.channels.map((channel) => channel.id), sidebar.order.channelOrder, sidebar.allChannelId);
  const shown = full.filter((id) => id !== sidebar.allChannelId && listKindOf(sidebar, id) === kind && !isPinned(sidebar, id) && !isInCustomSection(sidebar, id));
  return { full, shown, field: "channelOrder" };
}

/**
 * The owner's sidebar as get_owner_sidebar shows it (assistantOwnerReads.ts):
 * each list's sort mode and what it shows in manual order (the ids
 * move_conversation positions against), and the pinned conversations.
 */
export async function readOwnerSidebarView(serverId: string, ownerUserId: string): Promise<{
  channels: { sortMode: SortMode; shown: string[] };
  external: { sortMode: SortMode; shown: string[] };
  dms: { sortMode: SortMode; shown: string[] };
  pinnedIds: string[];
} | null> {
  const sidebar = await readOwnerSidebar(serverId, ownerUserId);
  if (!sidebar) return null;
  const view = (kind: ListKind) => ({ sortMode: sortModeOf(sidebar, kind), shown: listView(sidebar, kind).shown });
  const conversations = [...sidebar.channels.map((channel) => channel.id), ...sidebar.dms.map((dm) => dm.id)];
  // In the stored pinned order.
  const pinnedIds = sidebar.order.pinned.flatMap((ref) => conversations.filter((id) => {
    const own = pinnedRefOf(sidebar, id);
    return own !== null && pinnedRefKey(own) === pinnedRefKey(ref);
  }).slice(0, 1));
  return { channels: view("channels"), external: view("external"), dms: view("dms"), pinnedIds };
}

type Position = "top" | "bottom" | { after: string };

function readPosition(value: unknown): Position | null {
  if (value === "top" || value === "bottom") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const after = (value as { after?: unknown }).after;
    if (typeof after === "string" && after && Object.keys(value).length === 1) return { after };
  }
  return null;
}

const SORT_TEXT: Record<Exclude<SortMode, "manual">, string> = { az: "by name", recent: "by recent activity" };

function refusal(status: number, code: string, error: string): { ok: false; refusal: AssistantOwnerActionRefusal } {
  return { ok: false, refusal: { status, code, error } };
}

async function refOf(scope: AssistantOwnerActionRequestScope, id: string): Promise<string> {
  return await ownerFacingConversationRef(scope.serverId, scope.ownerUserId, id) ?? "the conversation";
}

/** Where `id` sits in `shown`: first, or right after its neighbour. */
async function positionOf(scope: AssistantOwnerActionRequestScope, shown: readonly string[], id: string): Promise<"top" | { after: string }> {
  const index = shown.indexOf(id);
  if (index <= 0) return "top";
  return { after: await refOf(scope, shown[index - 1]!) };
}

function positionKey(position: "top" | { after: string }): string {
  return position === "top" ? "top" : `after ${position.after}`;
}

/** A conversation of this server the owner has in their sidebar; the shared refusal otherwise. */
async function sidebarTarget(scope: AssistantOwnerActionRequestScope, targetId: unknown) {
  if (typeof targetId !== "string" || !targetId) return null;
  if ((scope.params.id ?? "").toLowerCase() !== scope.serverId.toLowerCase()) return null;
  const channel = await channelService.getChannel(targetId);
  if (!channel || channel.serverId !== scope.serverId) return null;
  if (!await channelService.canUserAccessChannel(channel.id, scope.ownerUserId, asServerId(scope.serverId))) return null;
  return channel;
}

type MoveBefore = { targetId: string; field: ListView["field"]; previous: "top" | { after: string }; shownAfter: string[] };

export const moveConversation: AssistantOwnerAction<MoveBefore> = {
  key: "sidebarMove",
  tool: "move_conversation",
  method: "PATCH",
  path: "/api/servers/:id/sidebar-order",
  tier: "direct",
  phrase: "move a conversation in the sidebar",
  params: [
    { name: "target", kind: "conversation", description: "A channel (#design) or a DM with a person (dm:@name)." },
    { name: "position", kind: "position", description: "\"top\", \"bottom\", or { after: \"#general\" } to put it right after another conversation in the same list." },
  ],
  mapping: [
    { param: "target", into: "body_ref", field: "targetId" },
    { param: "position", into: "body_position", field: "position" },
  ],
  allowedFields: ["targetId", "position"],
  requiredFields: ["targetId", "position"],
  async admit(scope, owner) {
    const target = await sidebarTarget(scope, scope.body.targetId);
    if (!target) return { ok: false };
    const position = readPosition(scope.body.position);
    if (!position) return refusal(400, "assistant_owner_action_invalid_position", "position must be \"top\", \"bottom\" or { after: \"#name\" }.");
    const sidebar = await readOwnerSidebar(scope.serverId, scope.ownerUserId);
    if (!sidebar) return { ok: false };
    const ref = await refOf(scope, target.id);
    if (target.id === sidebar.allChannelId) return refusal(409, "assistant_owner_action_fixed_place", `#all always stays first in ${owner}'s sidebar.`);
    const kind = listKindOf(sidebar, target.id);
    if (!kind) return refusal(409, "assistant_owner_action_not_in_list", `${ref} isn't in a list ${owner} can reorder in the sidebar (DMs with agents are under Agents). ${owner} can move it themselves.`);
    const sortMode = sortModeOf(sidebar, kind);
    if (sortMode !== "manual") {
      return refusal(409, "assistant_owner_action_sidebar_sorted", `${owner}'s sidebar is sorted ${SORT_TEXT[sortMode]}, so manual order doesn't apply; they can switch it in settings.`);
    }
    if (isPinned(sidebar, target.id)) return refusal(409, "assistant_owner_action_pinned", `${ref} is pinned in ${owner}'s sidebar, and pinned conversations keep their own order. Ask ${owner} whether to unpin it first; or they can move it among the pinned ones themselves.`);
    if (isInCustomSection(sidebar, target.id)) return refusal(409, "assistant_owner_action_in_section", `${ref} is in one of ${owner}'s own sidebar sections; ${owner} can move it there themselves.`);
    const view = listView(sidebar, kind);
    if (kind === "dms" && sidebar.order.hiddenDmIds.includes(target.id)) {
      return refusal(409, "assistant_owner_action_not_in_list", `${ref} is closed in ${owner}'s sidebar, so it has no place to move.`);
    }
    const others = view.shown.filter((id) => id !== target.id);
    let index: number;
    if (position === "top") index = 0;
    else if (position === "bottom") index = others.length;
    else {
      const afterId = position.after;
      if (afterId === sidebar.allChannelId && kind === "channels") index = 0;
      else {
        const at = others.indexOf(afterId);
        if (afterId === target.id || at < 0) {
          return refusal(400, "assistant_owner_action_invalid_position", `That conversation isn't in the same sidebar list as ${ref} (or it is pinned or in a section), so ${ref} can't go right after it.`);
        }
        index = at + 1;
      }
    }
    const nextShown = [...others.slice(0, index), target.id, ...others.slice(index)];
    const previousSubset = view.shown.includes(target.id) ? view.shown : [...view.shown, target.id];
    const nextFull = replaceSubsetOrder(view.full, previousSubset, nextShown);
    const routeOrder = view.field === "channelOrder" ? nextFull.filter((id) => id !== sidebar.allChannelId) : nextFull;
    return {
      ok: true,
      before: { targetId: target.id, field: view.field, previous: await positionOf(scope, view.shown, target.id), shownAfter: nextShown },
      routeBody: { [view.field]: routeOrder },
    };
  },
  async describe(scope, before, owner) {
    const ref = await refOf(scope, before.targetId);
    const next = await positionOf(scope, before.shownAfter, before.targetId);
    const changed = positionKey(next) !== positionKey(before.previous);
    const last = before.shownAfter.indexOf(before.targetId) === before.shownAfter.length - 1 && before.shownAfter.length > 1;
    const where = next === "top" ? "to the top of" : last ? "to the bottom of" : `right after ${next.after} in`;
    const done = changed ? `Moved ${ref} ${where} ${owner}'s sidebar.` : `Nothing changed: ${ref} was already there in ${owner}'s sidebar.`;
    const undoArgs: Record<string, AssistantOwnerActionArg> = { target: ref, position: before.previous };
    const undo = changed ? { tool: "move_conversation", args: undoArgs } : null;
    return {
      done,
      undo: undo ? { ...undo, text: undoLine(undo, "where it was before") } : null,
      audit: { targetId: before.targetId, previousValue: positionKey(before.previous), nextValue: positionKey(next) },
    };
  },
};

type PinBefore = { targetId: string; pinned: boolean; ref: PinnedRef };

export const pinConversation: AssistantOwnerAction<PinBefore> = {
  key: "sidebarPin",
  tool: "pin_conversation",
  method: "PATCH",
  path: "/api/servers/:id/sidebar-order",
  tier: "direct",
  phrase: "pin or unpin a conversation in the sidebar",
  params: [
    { name: "target", kind: "conversation", description: "A channel (#design) or a DM (dm:@name)." },
    { name: "pinned", kind: "boolean", description: "true to pin, false to unpin." },
  ],
  mapping: [
    { param: "target", into: "body_ref", field: "targetId" },
    { param: "pinned", into: "body", field: "pinned" },
  ],
  allowedFields: ["targetId", "pinned"],
  requiredFields: ["targetId", "pinned"],
  async admit(scope, owner) {
    const target = await sidebarTarget(scope, scope.body.targetId);
    if (!target) return { ok: false };
    if (typeof scope.body.pinned !== "boolean") return refusal(400, "assistant_owner_action_invalid_args", "pinned must be true or false.");
    const sidebar = await readOwnerSidebar(scope.serverId, scope.ownerUserId);
    if (!sidebar) return { ok: false };
    const pinnedRef = pinnedRefOf(sidebar, target.id);
    const ref = await refOf(scope, target.id);
    if (!pinnedRef) return refusal(409, "assistant_owner_action_not_in_list", `${ref} isn't in ${owner}'s sidebar, so it can't be pinned.`);
    const wasPinned = isPinned(sidebar, target.id);
    if (scope.body.pinned && !wasPinned && isInCustomSection(sidebar, target.id)) {
      return refusal(409, "assistant_owner_action_in_section", `${ref} is in one of ${owner}'s own sidebar sections; pinning would take it out of the section. ${owner} can pin it themselves.`);
    }
    const key = pinnedRefKey(pinnedRef);
    const pinned = scope.body.pinned
      ? (wasPinned ? sidebar.order.pinned : [...sidebar.order.pinned, pinnedRef])
      : sidebar.order.pinned.filter((item) => pinnedRefKey(item) !== key);
    return { ok: true, before: { targetId: target.id, pinned: wasPinned, ref: pinnedRef }, routeBody: { pinned } };
  },
  async describe(scope, before, owner, result) {
    const resultPinned = Array.isArray(result.pinned) ? result.pinned as PinnedRef[] : null;
    const after = resultPinned
      ? resultPinned.some((item) => item && pinnedRefKey(item) === pinnedRefKey(before.ref))
      : before.pinned;
    const ref = await refOf(scope, before.targetId);
    const changed = after !== before.pinned;
    const done = after
      ? (changed ? `Pinned ${ref} in ${owner}'s sidebar.` : `Nothing changed: ${ref} was already pinned in ${owner}'s sidebar.`)
      : (changed ? `Unpinned ${ref} in ${owner}'s sidebar.` : `Nothing changed: ${ref} wasn't pinned in ${owner}'s sidebar.`);
    const undo = changed ? { tool: "pin_conversation", args: { target: ref, pinned: before.pinned } as Record<string, AssistantOwnerActionArg> } : null;
    return {
      done,
      undo: undo ? { ...undo, text: undoLine(undo) } : null,
      audit: { targetId: before.targetId, previousValue: before.pinned, nextValue: after },
    };
  },
};

type ArrangeList = "pinned" | ListKind;
type ArrangeBefore = { list: ArrangeList; previous: string[]; next: string[] };

const LIST_TEXT: Record<ArrangeList, string> = { pinned: "pinned", channels: "channels", external: "External", dms: "DMs" };
const ARRANGE_MAX = 200;

/** The ids a list shows, in order: the pinned ones in their stored order, or a list's manual order. */
function shownOf(sidebar: OwnerSidebar, list: ArrangeList): string[] {
  if (list !== "pinned") return listView(sidebar, list).shown;
  const conversations = [...sidebar.channels.map((channel) => channel.id), ...sidebar.dms.map((dm) => dm.id)];
  return sidebar.order.pinned.flatMap((ref) => conversations.filter((id) => {
    const own = pinnedRefOf(sidebar, id);
    return own !== null && pinnedRefKey(own) === pinnedRefKey(ref);
  }).slice(0, 1));
}

/** Each id named as the owner sees it; a list can be 200 long, so at most 4 lookups at a time (server-fanout-ratchet). */
async function refsOf(scope: AssistantOwnerActionRequestScope, ids: readonly string[]): Promise<string[]> {
  return mapWithConcurrency(ids, 4, (id) => refOf(scope, id));
}

export const arrangeConversations: AssistantOwnerAction<ArrangeBefore> = {
  key: "sidebarArrange",
  tool: "arrange_conversations",
  method: "PATCH",
  path: "/api/servers/:id/sidebar-order",
  tier: "direct",
  phrase: "arrange a whole list of the sidebar in one go",
  params: [
    { name: "list", kind: "enum", values: ["pinned", "channels", "external", "dms"], description: "pinned = the pinned conversations (exactly these get pinned, in this order; any not listed are unpinned); channels, external (joint and external channels) or dms (DMs with people) = that list's order." },
    { name: "order", kind: "conversation_list", description: "The conversations in the order you want, e.g. [\"#design\", \"dm:@alice\"]. For a list other than pinned, any you leave out keep their order after these." },
  ],
  mapping: [
    { param: "list", into: "body", field: "list" },
    { param: "order", into: "body_ref_list", field: "orderIds" },
  ],
  allowedFields: ["list", "orderIds"],
  requiredFields: ["list", "orderIds"],
  async admit(scope, owner) {
    const list = scope.body.list;
    if (list !== "pinned" && list !== "channels" && list !== "external" && list !== "dms") {
      return refusal(400, "assistant_owner_action_invalid_args", "list must be pinned, channels, external or dms.");
    }
    const rawIds = scope.body.orderIds;
    if (!Array.isArray(rawIds) || rawIds.length > ARRANGE_MAX || !rawIds.every((id) => typeof id === "string" && id)) {
      return refusal(400, "assistant_owner_action_invalid_args", `order must be a list of up to ${ARRANGE_MAX} conversations.`);
    }
    if (list !== "pinned" && rawIds.length === 0) return refusal(400, "assistant_owner_action_invalid_args", "order must name at least one conversation.");
    const ids = rawIds as string[];
    if (new Set(ids).size !== ids.length) return refusal(400, "assistant_owner_action_invalid_args", "order names a conversation more than once.");
    for (const id of ids) if (!await sidebarTarget(scope, id)) return { ok: false };
    const sidebar = await readOwnerSidebar(scope.serverId, scope.ownerUserId);
    if (!sidebar) return { ok: false };
    const previous = shownOf(sidebar, list);

    if (list === "pinned") {
      if (sidebar.order.pinnedSortMode !== "manual" && ids.length > 1) {
        const mode = sidebar.order.pinnedSortMode as Exclude<SortMode, "manual">;
        return refusal(409, "assistant_owner_action_sidebar_sorted", `${owner}'s pinned conversations are sorted ${SORT_TEXT[mode]}, so manual order doesn't apply; they can switch it in settings.`);
      }
      const refs: PinnedRef[] = [];
      for (const id of ids) {
        const ref = pinnedRefOf(sidebar, id);
        const name = await refOf(scope, id);
        if (!ref) return refusal(409, "assistant_owner_action_not_in_list", `${name} isn't in ${owner}'s sidebar, so it can't be pinned.`);
        if (!isPinned(sidebar, id) && isInCustomSection(sidebar, id)) {
          return refusal(409, "assistant_owner_action_in_section", `${name} is in one of ${owner}'s own sidebar sections; pinning would take it out of the section. ${owner} can pin it themselves.`);
        }
        refs.push(ref);
      }
      // Pins the assistant can't see (a person or agent pinned with no DM yet, a
      // channel archived since) stay as they are, after these, in their order:
      // "the others unpinned" covers only what it can name (Tenny, #14060).
      const visible = new Set([...sidebar.channels.map((channel) => channel.id), ...sidebar.dms.map((dm) => dm.id)]
        .map((id) => pinnedRefOf(sidebar, id))
        .filter((ref): ref is PinnedRef => ref !== null)
        .map(pinnedRefKey));
      // From the stored pins: the hydrated read already leaves those out.
      const stored = (await serverService.getSanitizedMemberSidebarOrder(scope.serverId, scope.ownerUserId))?.pinned ?? sidebar.order.pinned;
      const unseen = stored.filter((ref) => !visible.has(pinnedRefKey(ref)));
      return { ok: true, before: { list, previous, next: ids }, routeBody: { pinned: [...refs, ...unseen] } };
    }

    const sortMode = sortModeOf(sidebar, list);
    if (sortMode !== "manual") {
      return refusal(409, "assistant_owner_action_sidebar_sorted", `${owner}'s sidebar is sorted ${SORT_TEXT[sortMode]}, so manual order doesn't apply; they can switch it in settings.`);
    }
    const view = listView(sidebar, list);
    for (const id of ids) {
      const name = await refOf(scope, id);
      if (id === sidebar.allChannelId) return refusal(409, "assistant_owner_action_fixed_place", `#all always stays first in ${owner}'s sidebar; leave it out.`);
      const kind = listKindOf(sidebar, id);
      if (kind !== list) {
        const where = kind ? `the ${LIST_TEXT[kind]} list` : "no list that can be reordered (DMs with agents are under Agents)";
        return refusal(409, "assistant_owner_action_not_in_list", `${name} is in ${where} of ${owner}'s sidebar, not ${LIST_TEXT[list]}.`);
      }
      if (isPinned(sidebar, id)) return refusal(409, "assistant_owner_action_pinned", `${name} is pinned in ${owner}'s sidebar; arrange it with list pinned instead.`);
      if (isInCustomSection(sidebar, id)) return refusal(409, "assistant_owner_action_in_section", `${name} is in one of ${owner}'s own sidebar sections; ${owner} can move it there themselves.`);
      if (list === "dms" && sidebar.order.hiddenDmIds.includes(id)) return refusal(409, "assistant_owner_action_not_in_list", `${name} is closed in ${owner}'s sidebar, so it has no place to move.`);
    }
    const nextShown = [...ids, ...view.shown.filter((id) => !ids.includes(id))];
    const nextFull = replaceSubsetOrder(view.full, view.shown, nextShown);
    const routeOrder = view.field === "channelOrder" ? nextFull.filter((id) => id !== sidebar.allChannelId) : nextFull;
    return { ok: true, before: { list, previous, next: nextShown }, routeBody: { [view.field]: routeOrder } };
  },
  async describe(scope, before, owner) {
    const changed = before.previous.join(",") !== before.next.join(",");
    const names = await refsOf(scope, before.next);
    const listText = LIST_TEXT[before.list];
    const done = !changed
      ? `Nothing changed: ${owner}'s ${listText} were already in that order.`
      : before.list === "pinned"
        ? (names.length > 0 ? `Pinned in ${owner}'s sidebar, in this order: ${names.join(", ")}.` : `Unpinned everything in ${owner}'s sidebar.`)
        : `Arranged ${owner}'s ${listText} in the sidebar: ${names.join(", ")}.`;
    const previousRefs = await refsOf(scope, before.previous);
    const undo = changed ? { tool: "arrange_conversations", args: { list: before.list, order: previousRefs } as Record<string, AssistantOwnerActionArg> } : null;
    return {
      done,
      undo: undo ? { ...undo, text: undoLine(undo, "the order before") } : null,
      // No single conversation: the list goes in the values (targetId is a conversation id where set).
      audit: { targetId: null, previousValue: `${before.list}: ${before.previous.join(",")}`, nextValue: `${before.list}: ${before.next.join(",")}` },
    };
  },
};

