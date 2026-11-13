import api from "../../api/client";
import { artifactObjectRefOf } from "../../apps/artifacts";
import { loadObjectSummaries, objectRefKey, peekObjectSummaries } from "../../objects/objectSummaryLoader";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { BesideKind, BesideState } from "../../store/besideMemory";
import { besideKindsOf } from "../../store/besideMemory";
import { useMachineStore } from "../../store/machineStore";
import { useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import type { HumanProfile } from "../member/HumanDetailPanel";
import { buildThreadParentContextRequest } from "../message/messageContextRequest";
import { getCachedAgentProfile, getCachedHumanProfile, setCachedAgentProfile, setCachedHumanProfile } from "../profile/profileFallbackCache";
import { besideArtifactTarget } from "./besideAddress";

// Whether the person can still see what was open beside a conversation,
// asked before it is restored (docs/frontend/beside-memory.md): a restore
// never shows a "not found" or "no access" panel.
//
// - `visible`: open it.
// - `gone`: a final answer (deleted, access removed, left the channel): it is
//   dropped from what is remembered.
// - `unknown`: no answer (offline, a 5xx, a list still loading, no answer
//   within BESIDE_VISIBILITY_TIMEOUT_MS): not opened now, and still
//   remembered.
//
// Each kind is answered from what the page already holds where it can be
// (`local`), so a restore that needs no request happens at once; otherwise by
// one request (`asked`), whose answer goes into the cache the panel itself
// reads, so the panel does not ask again.

export type BesideVisibility = "visible" | "gone" | "unknown";
export type BesideVisibilityAnswers = Partial<Record<BesideKind, BesideVisibility>>;

/** How long a request may take before its thing is left closed for this visit. */
export const BESIDE_VISIBILITY_TIMEOUT_MS = 4_000;

/** The request's answer is final: this reader can't have it (as the message context route's, messageStore). */
function isFinalRefusal(error: unknown): boolean {
  const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
  return status === 400 || status === 403 || status === 404;
}

async function asked(request: () => Promise<boolean>): Promise<BesideVisibility> {
  try {
    return (await request()) ? "visible" : "gone";
  } catch (error) {
    return isFinalRefusal(error) ? "gone" : "unknown";
  }
}

interface Check {
  /** The answer the page already holds; null where a request is needed. */
  local: () => BesideVisibility | null;
  remote: () => Promise<BesideVisibility>;
}

/** The thread's parent message: one the conversation already shows, else the message alone from the context route. */
function threadCheck(conversationId: string, messageId: string): Check {
  return {
    local: () => {
      const shown = useMessageStore.getState().channelMessages[conversationId]?.find((message) => message.id === messageId);
      return shown ? (shown.deletedAt ? "gone" : "visible") : null;
    },
    remote: () => asked(async () => {
      const { url, config } = buildThreadParentContextRequest(messageId, conversationId);
      const { data } = await api.get(url, config);
      const parent = (data as { messages?: Message[] } | null)?.messages?.find((message) => message.id === messageId);
      return !!parent && !parent.deletedAt;
    }),
  };
}

/** The Artifact at its version, as core's object summaries answer for this reader (kept, batched and shared with the viewer's header). */
function artifactCheck(artifact: NonNullable<BesideState["artifact"]>): Check {
  const target = besideArtifactTarget(artifact);
  if (!target) return { local: () => "gone", remote: async () => "gone" };
  const ref = artifactObjectRefOf(target);
  const read = (answer: { status: string } | undefined): BesideVisibility | null => {
    if (!answer) return null;
    if (answer.status === "error") return "unknown";
    return answer.status === "ok" ? "visible" : "gone";
  };
  return {
    local: () => {
      const kept = read(peekObjectSummaries(null, "artifact", [ref])?.get(objectRefKey(ref)));
      return kept === "unknown" ? null : kept;
    },
    remote: async () => read((await loadObjectSummaries(null, "artifact", [ref])).get(objectRefKey(ref))) ?? "unknown",
  };
}

function profileCheck(profile: string): Check {
  const at = profile.indexOf(":");
  const type = profile.slice(0, at);
  const id = profile.slice(at + 1);
  const serverId = () => useServerStore.getState().current?.id ?? null;
  if (type === "agent") {
    return {
      local: () => (useAgentStore.getState().agents.some((agent) => agent.id === id) || getCachedAgentProfile(serverId(), id) ? "visible" : null),
      remote: () => asked(async () => {
        const server = serverId();
        const { data } = await api.get(`/agents/${id}`);
        if (data && server === serverId()) setCachedAgentProfile(server, data as Agent);
        return !!data;
      }),
    };
  }
  if (type === "human") {
    // The panel opened from the address has no channel: the same cache entry, the same request.
    return {
      local: () => {
        const server = serverId();
        if (!server) return "unknown";
        return useServerStore.getState().members.some((member) => member.userId === id) || getCachedHumanProfile(server, id, null) ? "visible" : null;
      },
      remote: () => asked(async () => {
        const server = serverId();
        const { data } = await api.get(`/servers/${server}/members/${id}/profile`);
        if (data && server && server === serverId()) setCachedHumanProfile(server, data as HumanProfile, null);
        return !!data;
      }),
    };
  }
  const computer = (): BesideVisibility => {
    const { machines, loadStatus } = useMachineStore.getState();
    if (machines.some((machine) => machine.id === id)) return "visible";
    return loadStatus === "loaded" ? "gone" : "unknown";
  };
  return { local: computer, remote: async () => computer() };
}

function checksOf(conversationId: string, state: BesideState): Array<[BesideKind, Check]> {
  return besideKindsOf(state).map((kind) => [
    kind,
    kind === "thread" ? threadCheck(conversationId, state.thread!) : kind === "artifact" ? artifactCheck(state.artifact!) : profileCheck(state.profile!),
  ]);
}

function safely(local: () => BesideVisibility | null): BesideVisibility | null {
  try {
    return local();
  } catch {
    return null;
  }
}

/** Every open kind of `state` answered from what the page holds, with no request; null if any needs one. */
export function peekBesideVisibility(conversationId: string, state: BesideState): BesideVisibilityAnswers | null {
  const answers: BesideVisibilityAnswers = {};
  for (const [kind, check] of checksOf(conversationId, state)) {
    const answer = safely(check.local);
    if (answer === null) return null;
    answers[kind] = answer;
  }
  return answers;
}

function within(answer: Promise<BesideVisibility>, timeoutMs: number): Promise<BesideVisibility> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unknown"), timeoutMs);
    answer.then((value) => value, (): BesideVisibility => "unknown").then((value) => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export type BesideVisibilityCheck = (conversationId: string, state: BesideState) => Promise<BesideVisibilityAnswers>;

/**
 * Each open kind of `state`, checked together: from the page where it can be,
 * else by a request given `timeoutMs`. Never rejects: a check that throws or
 * runs out of time is `unknown`.
 */
export async function checkBesideVisibility(conversationId: string, state: BesideState, timeoutMs: number = BESIDE_VISIBILITY_TIMEOUT_MS): Promise<BesideVisibilityAnswers> {
  const answers = await Promise.all(checksOf(conversationId, state).map(async ([kind, check]) => {
    const answer = safely(check.local) ?? await within(Promise.resolve().then(check.remote), timeoutMs);
    return [kind, answer] as const;
  }));
  return Object.fromEntries(answers);
}
