// Focus, delivery tag (flag `agent_focus_v0`): marks a message whose
// conversation the receiving agent keeps in focus (`AgentMessage.focused`).
// It only tags. It never decides whether a message is delivered, and it moves
// no read state. Contract: docs/contracts/agent-focus.md, "Delivery tag".
//
// This runs on every delivery, so it is ordered by cost: the message's own
// type first (no I/O), then the cached flag, then the conversation's cached
// focus set, and the Computer's capability last.
import { and, eq, isNull } from "drizzle-orm";
import { AGENT_FOCUS_FEATURE_FLAG_KEY, type AgentMessage } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { agentFocusTargets } from "../db/schema";
import { UUID_RE } from "../lib/messageId";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { cachedServerFlagAnswers } from "./featureFlagReadCache";
import { evaluateFeatureFlags } from "./featureFlagService";

/** How long a conversation's focus set is reused on this replica. */
export const FOCUS_SET_CACHE_TTL_MS = 5_000;
/** Past this many conversations the cache starts over (bounds memory; a miss is one indexed query). */
const MAX_FOCUS_SETS = 10_000;

/**
 * Conversation (channel id) to the agents that focus it. The value is the
 * read itself, so the recipients of one fan-out share one query. Local to
 * this replica: a focus change made on another replica is seen within the TTL.
 */
const focusSets = new Map<string, { agentIds: Promise<ReadonlySet<string>>; expiresAt: number }>();

/** The focus sets of these conversations changed here: their next read goes to the database. */
export function forgetFocusSets(channelIds: Iterable<string>): void {
  for (const channelId of channelIds) focusSets.delete(channelId);
}

/** Tests: empty the cache. */
export function __clearFocusSetCacheForTests(): void {
  focusSets.clear();
}

/**
 * A thread, a DM or a task conversation (which arrives as a thread). A plain
 * channel cannot be focused. Nor can a message whose `channel_id` is no
 * channel row: a third-party event arrives as a `dm` under a label
 * (`third-party-agent-events:<id>`), which must never reach a uuid column.
 */
export function canBeFocused(message: AgentMessage): boolean {
  return (message.channel_type === "thread" || message.channel_type === "dm") && UUID_RE.test(message.channel_id);
}

/** Whether Focus is on for the server, from the short flag cache. A failed evaluation throws; the caller reads that as off. */
export async function focusFlagOn(serverId: string): Promise<boolean> {
  const [on] = await cachedServerFlagAnswers([serverId], AGENT_FOCUS_FEATURE_FLAG_KEY, async (serverIds) => {
    const answers = await evaluateFeatureFlags(serverIds.map((id) => ({ key: AGENT_FOCUS_FEATURE_FLAG_KEY, serverId: id })));
    return serverIds.map((_, index) => answers[index]?.enabled === true);
  });
  return on === true;
}

function agentsFocusing(channelId: string): Promise<ReadonlySet<string>> {
  const now = Date.now();
  const cached = focusSets.get(channelId);
  if (cached && cached.expiresAt > now) return cached.agentIds;
  if (focusSets.size >= MAX_FOCUS_SETS) focusSets.clear();
  const agentIds = getDb()
    .select({ agentId: agentFocusTargets.agentId })
    .from(agentFocusTargets)
    // A row the agent unfocused is not an entry.
    .where(and(eq(agentFocusTargets.channelId, channelId), isNull(agentFocusTargets.unfocusedAt)))
    .then((rows): ReadonlySet<string> => new Set(rows.map((row) => row.agentId)));
  const entry = { agentIds, expiresAt: now + FOCUS_SET_CACHE_TTL_MS };
  focusSets.set(channelId, entry);
  // A failed read is not kept.
  agentIds.catch(() => {
    if (focusSets.get(channelId) === entry) focusSets.delete(channelId);
  });
  return agentIds;
}

/** Whether the agent focuses the conversation, from the cached focus set (the read the tag itself makes). */
export async function agentFocuses(agentId: string, channelId: string): Promise<boolean> {
  return (await agentsFocusing(channelId)).has(agentId);
}

/** Not more than one warning per this long: a failing flag read would otherwise log on every thread and DM delivery. */
const WARN_INTERVAL_MS = 30_000;
/** When this process last logged a tagging failure (0: never). */
let lastWarnAt = 0;

function warnTagSkipped(err: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_INTERVAL_MS) return;
  lastWarnAt = now;
  console.warn("[AgentFocus] delivery tag skipped; delivering untagged (logged at most every 30 s)", serializeErrorForLog(err));
}

const NONE: ReadonlySet<string> = new Set();

/**
 * `messages` with `focused: true` on exactly those whose conversation is in
 * `focusedChannelIds`, and no `focused` on the rest. A `focus_change` stays
 * only on a message that is tagged: without the tag it is removed with it.
 * A message that changes is copied; when none changes the input array itself
 * is returned.
 */
function withFocusTags(messages: readonly AgentMessage[], focusedChannelIds: ReadonlySet<string>): readonly AgentMessage[] {
  let changed = false;
  const out = messages.map((message) => {
    const focused = canBeFocused(message) && focusedChannelIds.has(message.channel_id);
    if (focused ? message.focused === true : message.focused === undefined && message.focus_change === undefined) return message;
    changed = true;
    if (focused) return { ...message, focused: true as const };
    const { focused: _stale, focus_change: _untold, ...untagged } = message;
    return untagged;
  });
  return changed ? out : messages;
}

/** `messages` with no Focus tag and no `focus_change` (copies where one was set). For a message that is stored, or that goes to an agent with no Computer. */
export function withoutFocusTags(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  return withFocusTags(messages, NONE);
}

/**
 * `messages` for one recipient, with `focused: true` on those whose
 * conversation is in the agent's focus set, and on no other. The tag is
 * decided again on every call: a `focused` the input already carries (a
 * stored payload, a buffered wake message) is never trusted, and is removed
 * when it no longer holds. A message that changes is a copy: the input
 * objects are shared with other recipients and with persisted payloads, and
 * are never changed. When nothing changes the input array itself is returned.
 *
 * Tags only when the flag is on for the server and `machineCapable` says the
 * agent's Computer advertised DAEMON_CAPABILITY_AGENT_FOCUS_V1.
 *
 * Call it only for a message that is being delivered to the agent anyway.
 * Rows in `agent_focus_targets` can outlive the agent's access (they are
 * cleaned only on focus calls), so the tag is no proof of access and must
 * never be the reason a message is sent. On the live path it sits after the
 * delivery's own access check.
 *
 * Never throws: on any failure the messages go out untagged.
 */
export async function stampFocus(input: {
  agentId: string;
  serverId: string | null | undefined;
  messages: readonly AgentMessage[];
  machineCapable: () => boolean | Promise<boolean>;
}): Promise<readonly AgentMessage[]> {
  return withFocusTags(input.messages, await focusedConversations(input));
}

/** The conversations among `messages` that the agent has in focus now, or none when the flag, the capability or a read says no. */
async function focusedConversations(input: Parameters<typeof stampFocus>[0]): Promise<ReadonlySet<string>> {
  const { agentId, serverId, messages } = input;
  if (!serverId) return NONE;
  const channelIds = new Set(messages.filter(canBeFocused).map((message) => message.channel_id));
  if (channelIds.size === 0) return NONE;
  // A message that carries `focus_change` was tagged where the focus was
  // made, maybe on another replica a moment ago: read its focus set again
  // rather than answer from a copy that may be older than that focus.
  forgetFocusSets(messages.filter((message) => message.focus_change !== undefined).map((message) => message.channel_id));
  try {
    if (!await focusFlagOn(serverId)) return NONE;
    const focused = new Set<string>();
    for (const channelId of channelIds) {
      if ((await agentsFocusing(channelId)).has(agentId)) focused.add(channelId);
    }
    if (focused.size === 0) return NONE;
    return await input.machineCapable() ? focused : NONE;
  } catch (err) {
    warnTagSkipped(err);
    return NONE;
  }
}
