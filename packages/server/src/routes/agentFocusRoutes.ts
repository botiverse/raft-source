// Focus, part 1 (flag `agent_focus_v0`) on the agent API: `POST /focus`,
// `POST /unfocus`, `GET /focus` (`raft focus`, `raft unfocus`). Mounted by
// internalAgentApi.ts. The state and its eviction order are in
// services/agentFocusService.ts; this file resolves the target the way the
// read routes do, checks that the agent can read it, and names every entry
// back as the agent addresses it.
//
// What can be focused: a thread, a DM, a task conversation. Not a plain
// channel (deliberately, for now). Every refusal goes through refuse(); a
// conversation the agent can't read and an unknown one answer the same
// NOT_FOUND bytes.
import type { Request, Response } from "express";
import {
  AGENT_FOCUS_CHANNEL_UNAVAILABLE_CODE,
  AGENT_FOCUS_DISABLED_CODE,
  AGENT_FOCUS_TASK_NO_CONVERSATION_CODE,
  RAFT_HINTS,
  asChannelId,
  parseAgentTaskRef,
  type AgentApiFocusBody,
  type AgentApiFocusEntry,
  type AgentApiFocusListResponse,
  type AgentApiFocusResponse,
  type AgentApiUnfocusResponse,
  type AgentFocusTargetKind,
  type ChannelId,
  type ServerId,
} from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../db/index";
import { refuse, type RefusalInput } from "../lib/refusal";
import * as agentFocusService from "../services/agentFocusService";
import { AGENT_FOCUS_LIMIT, type AgentFocusEntry } from "../services/agentFocusService";
import { renderRelatedTargets } from "../services/agentInboxItems";
import { AGENT_LOUNGE_OUTSIDER_REFUSAL, isLoungeOutsiderAgent } from "../services/agentLoungeService";
import * as channelService from "../services/channelService";
import { canView } from "../services/visibilityService";
import { resolveAgentTaskRefConversation, taskRefOfMessageTarget } from "./agentWritableTarget";

/** Focus is off for this server (the flag): nothing is stored, and nothing about delivery differs. */
export function refuseAgentFocusDisabled(res: Response): void {
  refuse(res, 404, {
    code: AGENT_FOCUS_DISABLED_CODE,
    error: "Focus is not switched on for this server yet: nothing was focused, and every conversation reaches your inbox as before.",
    next: RAFT_HINTS.inboxList(),
  });
}

/** The one answer for a conversation that does not exist or that the agent can't read. */
const FOCUS_TARGET_NOT_FOUND: RefusalInput = {
  code: "NOT_FOUND",
  error: "Not found, or you don't have access.",
  next: RAFT_HINTS.inboxList(),
};

const FOCUS_CHANNEL_UNAVAILABLE: RefusalInput = {
  code: AGENT_FOCUS_CHANNEL_UNAVAILABLE_CODE,
  error: "Channel focus is deliberately not available yet: focus a thread, a DM or a task conversation instead, as your inbox names them.",
  next: RAFT_HINTS.inboxList(),
};

/**
 * A conversation the agent can read but that has no address to give back (an
 * old thread whose parent is gone, a DM whose other side no longer resolves).
 * Refused before anything is stored: an entry the list can't name would hold
 * a place the agent could never free.
 */
const FOCUS_TARGET_UNADDRESSABLE: RefusalInput = {
  code: AGENT_FOCUS_CHANNEL_UNAVAILABLE_CODE,
  error: "That conversation can't be focused: Raft has no address for it to list it under, so you could not unfocus it later. Nothing was focused.",
  next: RAFT_HINTS.inboxList(),
};

type ResolvedFocusTarget = { channelId: ChannelId; kind: AgentFocusTargetKind };

/** Which of these conversations the agent can read: the read routes' check (visibilityService.canView), one answer per id. */
async function readableByAgent(serverId: string, agentId: string, channelIds: readonly string[], executor?: DatabaseExecutor): Promise<boolean[]> {
  return canView(
    { type: "agent", id: agentId, serverId: serverId as ServerId },
    channelIds.map((channelId) => ({ kind: "conversation" as const, channelId })),
    { executor },
  );
}

/**
 * The conversation a focus target names, when it is one the agent can read
 * and focus. Answers the refusal itself and returns null otherwise.
 */
async function resolveFocusTarget(req: Request, res: Response): Promise<ResolvedFocusTarget | null> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const target = (req.body as AgentApiFocusBody).target.trim();

  let channelId: string | null = null;
  const taskRef = taskRefOfMessageTarget(target);
  if (taskRef) {
    const found = await resolveAgentTaskRefConversation(serverId, agentId, taskRef, { create: false });
    if (found && typeof found === "object" && found.kind === "pending") {
      // Nobody has written in it yet (lazy): there is no conversation to focus.
      if (!(await readableByAgent(serverId, agentId, [found.boardChannelId]))[0]) {
        refuse(res, 404, FOCUS_TARGET_NOT_FOUND);
        return null;
      }
      refuse(res, 409, {
        code: AGENT_FOCUS_TASK_NO_CONVERSATION_CODE,
        error: "That task has no conversation yet, so there is nothing to focus: it gets one with its first reply.",
        next: RAFT_HINTS.taskReply(found.ref),
      });
      return null;
    }
    channelId = found && typeof found === "object" ? found.channelId : null;
  } else {
    channelId = (await channelService.resolveChannelByName(serverId, agentId, target))?.channelId ?? null;
  }

  const channel = channelId ? await channelService.getChannel(channelId) : null;
  if (!channel || !(await readableByAgent(serverId, agentId, [channel.id]))[0]) {
    refuse(res, 404, FOCUS_TARGET_NOT_FOUND);
    return null;
  }
  const kind: AgentFocusTargetKind | null = channel.type === "thread" ? "thread"
    : channel.type === "task" ? "task"
    : channel.type === "dm" ? "dm"
    : null;
  if (!kind) {
    refuse(res, 400, FOCUS_CHANNEL_UNAVAILABLE);
    return null;
  }
  return { channelId: asChannelId(channel.id), kind };
}

/** `task` for `#chan:#7`, `dm` for `dm:@peer`, `thread` for a `:<msg8>` target: read off the rendered target. */
function kindOfRenderedTarget(target: string): AgentFocusTargetKind {
  if (parseAgentTaskRef(target)) return "task";
  return channelService.parseChannelRef(target).threadShortId === null && /^dm:@/i.test(target) ? "dm" : "thread";
}

/**
 * Entries as the agent addresses them now. One the agent can no longer read
 * (it left the DM, the channel went private) is dropped from the stored list
 * here, so it neither shows nor holds one of the three places; one that
 * merely fails to render this time is left out of this answer only.
 */
async function renderFocusEntries(
  serverId: string,
  agentId: string,
  entries: readonly AgentFocusEntry[],
  opts: { prune: boolean },
): Promise<AgentApiFocusEntry[]> {
  if (entries.length === 0) return [];
  const canRead = await readableByAgent(serverId, agentId, entries.map((entry) => entry.channelId));
  const readable = entries.filter((_, index) => canRead[index]);
  if (opts.prune) {
    for (const [index, entry] of entries.entries()) {
      if (!canRead[index]) await agentFocusService.drop(agentId, entry.channelId);
    }
  }
  const targets = await renderRelatedTargets(serverId, agentId, readable.map((entry) => entry.channelId));
  return readable.flatMap((entry) => {
    const target = targets.get(entry.channelId);
    return target ? [{
      target,
      kind: kindOfRenderedTarget(target),
      source: entry.source,
      focusedAt: entry.focusedAt.toISOString(),
      lastActiveAt: entry.lastActiveAt.toISOString(),
    }] : [];
  });
}

/**
 * Focus a conversation the caller has resolved and checked. Its address is
 * rendered first: null, with nothing stored and nothing let go, when it has
 * none. Entries the agent can no longer read are dropped inside the same
 * locked transaction, before the limit is counted.
 */
export async function focusResolvedTarget(
  input: { serverId: string; agentId: string; channelId: ChannelId },
  deps: { renderTargets?: typeof renderRelatedTargets } = {},
): Promise<{ target: string; result: agentFocusService.AgentFocusResult } | null> {
  const { serverId, agentId, channelId } = input;
  const target = (await (deps.renderTargets ?? renderRelatedTargets)(serverId, agentId, [channelId])).get(channelId);
  if (!target) return null;
  const result = await agentFocusService.focus(agentId, channelId, "manual", {
    stillReadable: (channelIds, tx) => readableByAgent(serverId, agentId, channelIds, tx),
  });
  return { target, result };
}

export async function handleFocus(req: Request, res: Response, deps: { answer: (body: AgentApiFocusResponse) => void }): Promise<void> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const resolved = await resolveFocusTarget(req, res);
  if (!resolved) return;
  // Another agent may read a lounge but takes no part in it.
  if (await isLoungeOutsiderAgent(resolved.channelId, agentId)) {
    refuse(res, 403, { code: "agent_lounge_outsider", error: AGENT_LOUNGE_OUTSIDER_REFUSAL });
    return;
  }
  const done = await focusResolvedTarget({ serverId, agentId, channelId: resolved.channelId });
  if (!done) {
    refuse(res, 400, FOCUS_TARGET_UNADDRESSABLE);
    return;
  }
  const { target, result } = done;
  deps.answer({
    ok: true,
    // The address rendered before the write, so the answer can't fail after it.
    focused: {
      target,
      kind: kindOfRenderedTarget(target),
      source: result.focused.source,
      focusedAt: result.focused.focusedAt.toISOString(),
      lastActiveAt: result.focused.lastActiveAt.toISOString(),
    },
    alreadyFocused: result.alreadyFocused,
    // Already removed from the list; named so the agent can put one back.
    evicted: await renderFocusEntries(serverId, agentId, result.evicted, { prune: false }),
    entries: await renderFocusEntries(serverId, agentId, result.entries, { prune: true }),
    limit: AGENT_FOCUS_LIMIT,
  });
}

export async function handleUnfocus(req: Request, res: Response, deps: { answer: (body: AgentApiUnfocusResponse) => void }): Promise<void> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  const resolved = await resolveFocusTarget(req, res);
  if (!resolved) return;
  const target = (await renderRelatedTargets(serverId, agentId, [resolved.channelId])).get(resolved.channelId)
    ?? (req.body as AgentApiFocusBody).target.trim();
  const { wasFocused } = await agentFocusService.unfocus(agentId, resolved.channelId);
  deps.answer({
    ok: true,
    target,
    wasFocused,
    entries: await renderFocusEntries(serverId, agentId, await agentFocusService.list(agentId), { prune: true }),
    limit: AGENT_FOCUS_LIMIT,
  });
}

export async function handleFocusList(req: Request, res: Response, deps: { answer: (body: AgentApiFocusListResponse) => void }): Promise<void> {
  const agentId = req.actingAgentId!;
  const serverId = req.serverId!;
  deps.answer({
    entries: await renderFocusEntries(serverId, agentId, await agentFocusService.list(agentId), { prune: true }),
    limit: AGENT_FOCUS_LIMIT,
  });
}
