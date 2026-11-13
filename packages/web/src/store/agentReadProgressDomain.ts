/**
 * Agent read progress (agent_read_progress_v0): where each agent has read up
 * to in the open conversation, projected onto its loaded messages. Pure: the
 * read positions come from the read-receipt store (the detail's
 * `peerReadStates`, moved forward by `read_progress:updated`), "working" from
 * the agent typing store; useAgentReadProgress wires them.
 *
 * Rules (artin's "A+B" in the mock-up,
 * https://app.raft.build/artifacts/DxhdQsbuB38PRhxxJPiGrX):
 * - Only agents, and only the relevant ones: those that spoke or were
 *   @mentioned in the conversation's last RELEVANCE_WINDOW messages, plus those
 *   working here now. Working agents first, then the most recently active.
 * - A: an agent's face sits on the last loaded row whose seq is at or below its
 *   read position (a folded system message gives way to its group's row). Older
 *   than every loaded row: no face.
 * - B: one line under your own latest message, at the live edge only, and only
 *   when the message will not reach a relevant agent: one that stopped
 *   following a thread, or muted a channel, and that your message does not
 *   @mention, followed by what would reach them ("Mention them to reach
 *   them"). Who replied, is working, read it or not yet is not repeated
 *   there: the faces (A) say who read up to where (task #proj-raft-ui:#212).
 */
import type { IntlShape } from "react-intl";
import type { ReadReceiptScope } from "./readReceiptDomain";

/** How far back "spoke or was @mentioned" looks. */
export const AGENT_READ_RELEVANCE_WINDOW = 30;
/** Faces per message before the rest fold into +N. */
export const AGENT_READ_MAX_FACES = 3;
/** The same on a narrow (phone) width. */
export const AGENT_READ_MAX_FACES_NARROW = 2;
/** Names the B line spells out before "+N". */
export const AGENT_READ_STATUS_MAX_NAMES = 3;

export interface AgentReadMessageSlice {
  id: string;
  seq?: number;
  senderType: string;
  senderId: string;
  messageType?: "chat" | "system";
  mentions?: ReadonlyArray<{ type: string; id: string }>;
}

function realSeq(seq: number | undefined): seq is number {
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0;
}

/**
 * Each agent's read position in a scope, or null when there is none to show:
 * no hydrate, a summary scope (above the per-peer bound, no identities), or a
 * scope with no agent peer at all.
 */
export function agentReadPositions(scope: ReadReceiptScope | undefined): ReadonlyMap<string, number> | null {
  if (!scope || scope.kind !== "peers") return null;
  const positions = new Map<string, number>();
  for (const peer of scope.peers) {
    if (peer.peerKind === "agent") positions.set(peer.peerId, peer.maxReadSeq);
  }
  return positions.size > 0 ? positions : null;
}

/**
 * The agents the detail says stopped following this thread. Empty when it says
 * nothing: a channel, a summary scope, or a server without the field. Unknown
 * is never "stopped".
 */
export function agentsStoppedFollowing(scope: ReadReceiptScope | undefined): ReadonlySet<string> {
  const stopped = new Set<string>();
  if (scope?.kind !== "peers") return stopped;
  for (const peer of scope.peers) {
    if (peer.peerKind === "agent" && peer.stoppedFollowing) stopped.add(peer.peerId);
  }
  return stopped;
}

/**
 * The agents the detail says muted this channel. Empty when it says nothing: a
 * thread, a DM, a summary scope, or a server without the field. Unknown is
 * never "muted".
 */
export function agentsMutedChannel(scope: ReadReceiptScope | undefined): ReadonlySet<string> {
  const muted = new Set<string>();
  if (scope?.kind !== "peers") return muted;
  for (const peer of scope.peers) {
    if (peer.peerKind === "agent" && peer.mutedChannel) muted.add(peer.peerId);
  }
  return muted;
}

/**
 * The agents to show, in display order: working ones first (in the order they
 * started), then by how recently they spoke or were @mentioned in the last
 * `window` messages. Only agents with a read position (the scope's exposed
 * peers) can be shown.
 */
export function relevantReadAgentIds(
  messages: readonly AgentReadMessageSlice[],
  positions: ReadonlyMap<string, number>,
  workingAgentIds: readonly string[],
  window: number = AGENT_READ_RELEVANCE_WINDOW,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (agentId: string) => {
    if (seen.has(agentId) || !positions.has(agentId)) return;
    seen.add(agentId);
    ids.push(agentId);
  };
  for (const agentId of workingAgentIds) add(agentId);
  const start = Math.max(0, messages.length - window);
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]!;
    if (message.messageType === "system") continue;
    if (message.senderType === "agent") add(message.senderId);
    for (const mention of message.mentions ?? []) {
      if (mention.type === "agent") add(mention.id);
    }
  }
  return ids;
}

/**
 * Where each agent's face goes: row id -> agent ids, each list in `agentIds`
 * order. A row is a loaded message with a real seq; `foldedMessageIds` maps a
 * system message folded into a group to the group's row. With `hasNewer` (a
 * context window, newer messages not loaded) an agent that read past the last
 * loaded row stopped somewhere not shown: it gets no face, never a false
 * "read up to here" on the window's last row.
 */
export function placeAgentReads(
  messages: readonly AgentReadMessageSlice[],
  positions: ReadonlyMap<string, number>,
  agentIds: readonly string[],
  foldedMessageIds?: ReadonlyMap<string, string>,
  hasNewer = false,
): Map<string, string[]> {
  const rows: Array<{ id: string; seq: number }> = [];
  let sorted = true;
  for (const message of messages) {
    if (!realSeq(message.seq)) continue;
    if (rows.length > 0 && rows[rows.length - 1]!.seq > message.seq) sorted = false;
    rows.push({ id: message.id, seq: message.seq });
  }
  if (!sorted) rows.sort((left, right) => left.seq - right.seq);
  const placement = new Map<string, string[]>();
  for (const agentId of agentIds) {
    const maxReadSeq = positions.get(agentId);
    if (maxReadSeq === undefined) continue;
    // The last row at or below the position (binary search over seq).
    let low = 0;
    let high = rows.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid]!.seq <= maxReadSeq) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (found < 0) continue;
    if (hasNewer && found === rows.length - 1 && maxReadSeq > rows[found]!.seq) continue;
    const rowId = foldedMessageIds?.get(rows[found]!.id) ?? rows[found]!.id;
    const list = placement.get(rowId);
    if (list) list.push(agentId);
    else placement.set(rowId, [agentId]);
  }
  return placement;
}

/**
 * The viewer's own latest message among the last `window` loaded ones, or
 * null. Only at the live edge (`hasNewer` false): in a context window the last
 * loaded message is not the conversation's last.
 */
export function ownLatestMessageId(
  messages: readonly AgentReadMessageSlice[],
  viewerUserId: string | null,
  hasNewer: boolean,
  window: number = AGENT_READ_RELEVANCE_WINDOW,
): string | null {
  if (!viewerUserId || hasNewer) return null;
  const start = Math.max(0, messages.length - window);
  for (let index = messages.length - 1; index >= start; index -= 1) {
    const message = messages[index]!;
    if (message.messageType === "system") continue;
    if (message.senderType === "user" && message.senderId === viewerUserId) return message.id;
  }
  return null;
}

/** Why your message will not reach an agent: it stopped following the thread, or muted the channel. */
export type AgentReadStatusState = "stoppedFollowing" | "muted";

export interface AgentReadStatusEntry {
  agentId: string;
  state: AgentReadStatusState;
}

const STATE_ORDER: Record<AgentReadStatusState, number> = {
  stoppedFollowing: 0,
  muted: 1,
};

/**
 * The B line under your latest message: the relevant agents it will not
 * reach, or null when it reaches everyone (then there is no line). An agent
 * stopped following (`stoppedFollowingAgentIds`, a thread) or muted the
 * channel (`mutedAgentIds`), and has done nothing with your message yet:
 * working (typing here now, or in your message's thread), replied (posted after
 * your message, or replied in its thread: `threadRepliedAgentIds`) or read (its
 * position reached your message) all mean it already has it. A message that
 * @mentions an agent that can read here flags no one: the mention reaches it
 * (the send reactivates the follow; it pierces a channel mute), even before the
 * detail catches up, and the agents it does not name are not its audience.
 * Sorted stopped following, then muted. Null too when there is no one to count
 * or the message has no seq yet (a send still on its way).
 */
export function projectAgentReadStatus(
  messages: readonly AgentReadMessageSlice[],
  messageId: string | null,
  positions: ReadonlyMap<string, number>,
  relevantAgentIds: readonly string[],
  workingAgentIds: readonly string[],
  threadRepliedAgentIds: readonly string[] = [],
  stoppedFollowingAgentIds: ReadonlySet<string> = new Set(),
  mutedAgentIds: ReadonlySet<string> = new Set(),
): AgentReadStatusEntry[] | null {
  if (!messageId) return null;
  if (stoppedFollowingAgentIds.size === 0 && mutedAgentIds.size === 0) return null;
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return null;
  const own = messages[index]!;
  if (!realSeq(own.seq)) return null;
  if ((own.mentions ?? []).some((mention) => mention.type === "agent" && positions.has(mention.id))) return null;
  const replied = new Set<string>(threadRepliedAgentIds);
  for (let later = index + 1; later < messages.length; later += 1) {
    const message = messages[later]!;
    if (message.senderType === "agent" && message.messageType !== "system") replied.add(message.senderId);
  }
  const working = new Set(workingAgentIds);
  const entries: AgentReadStatusEntry[] = [];
  for (const agentId of relevantAgentIds) {
    if (working.has(agentId) || replied.has(agentId) || (positions.get(agentId) ?? 0) >= own.seq) continue;
    if (stoppedFollowingAgentIds.has(agentId)) entries.push({ agentId, state: "stoppedFollowing" });
    else if (mutedAgentIds.has(agentId)) entries.push({ agentId, state: "muted" });
  }
  if (entries.length === 0) return null;
  // Array.prototype.sort is stable: same-state agents keep the relevance order.
  return entries.sort((left, right) => STATE_ORDER[left.state] - STATE_ORDER[right.state]);
}

export const AGENT_READ_STATUS_MESSAGE_IDS = {
  stoppedFollowing: "message.agentReadStatus.stoppedFollowing",
  muted: "message.agentReadStatus.muted",
  more: "message.agentReadStatus.more",
  agentCount: "message.agentReadStatus.agentCount",
} as const;

type FormatList = (names: string[]) => string;

/** "A, B, C": a list that goes on, so no "and" before its last name. The separator is the locale's own. */
function openList(names: string[], formatList: FormatList): string {
  const sample = formatList(["x", "y", "z"]);
  return names.join(sample.slice(sample.indexOf("x") + 1, sample.indexOf("y")));
}

/** One segment of the B line: a state's verb and the names that share it. */
export interface AgentReadStatusRun {
  state: AgentReadStatusState;
  /** The names spelled out, one list: "Niko and Ray", or "Niko, Ray" when a count follows. */
  names: string;
  /** How many more past the cap, counted after the names ("+2"); 0 for none. */
  more: number;
  /** Every agent in the segment: the count the line shows instead of names when not one fits ("4 agents"). */
  total: number;
}

/**
 * The B line's segments: "Stopped following: Niko, Ray · Muted: Cindy". At
 * most AGENT_READ_STATUS_MAX_NAMES names; the agents in one state share their
 * verb. Entries come sorted (projectAgentReadStatus), so stopped following
 * comes first. Past the cap, the rest stay counted in their own segment
 * ("Stopped following: Niko, Ray, Cindy +2"; each segment keeps at least one
 * name), never in a +N of the line. The line (AgentReadStatusLine) draws each
 * segment's verb whole and lets only its names take the ellipsis, so a
 * narrow width cuts names and never the meaning.
 */
export function agentReadStatusRuns(
  entries: readonly AgentReadStatusEntry[],
  nameOf: (agentId: string) => string,
  formatList: FormatList,
  maxNames: number = AGENT_READ_STATUS_MAX_NAMES,
): AgentReadStatusRun[] {
  const groups: Array<{ state: AgentReadStatusState; agentIds: string[] }> = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (last?.state === entry.state) last.agentIds.push(entry.agentId);
    else groups.push({ state: entry.state, agentIds: [entry.agentId] });
  }
  // One name kept back for each run still to come, so none is left out.
  let runsAhead = groups.length;
  let budget = maxNames;
  const runs: AgentReadStatusRun[] = [];
  for (const group of groups) {
    runsAhead -= 1;
    const take = Math.max(1, Math.min(group.agentIds.length, budget - runsAhead));
    const names = group.agentIds.slice(0, take).map(nameOf);
    const more = group.agentIds.length - take;
    runs.push({
      state: group.state,
      names: more > 0 ? openList(names, formatList) : formatList(names),
      more,
      total: group.agentIds.length,
    });
    budget -= take;
  }
  return runs;
}

/**
 * The B line's words as one string (agentReadStatusRuns, each segment's verb
 * from the catalog with its names, "+N" after them): the tooltip, and with
 * `reachHint` after the last segment, the screen-reader sentence.
 */
export function formatAgentReadStatus(
  entries: readonly AgentReadStatusEntry[],
  nameOf: (agentId: string) => string,
  formatMessage: IntlShape["formatMessage"],
  formatList: FormatList,
  maxNames: number = AGENT_READ_STATUS_MAX_NAMES,
  reachHint?: string,
): string {
  if (entries.length === 0) return "";
  const segments = agentReadStatusRuns(entries, nameOf, formatList, maxNames).map((run) => {
    const listed = run.more > 0
      ? `${run.names} ${formatMessage({ id: AGENT_READ_STATUS_MESSAGE_IDS.more }, { count: run.more })}`
      : run.names;
    return formatMessage({ id: AGENT_READ_STATUS_MESSAGE_IDS[run.state] }, { names: listed });
  });
  if (reachHint) segments.push(reachHint);
  return segments.join(" · ");
}
