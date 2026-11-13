import axios from "axios";
import { create } from "zustand";
import { isAgentContextViewFailureReason, isAgentContextViewTooLargeCause, parseAgentContextView } from "@botiverse/raft-shared";
import type { AgentContextView, AgentContextViewFailureReason, AgentContextViewTooLargeCause, AgentContextViewOutcome, AgentContextViewRecord, AgentContextViewRecordList, AgentContextViewSourceKind } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAgentContextViewStore } from "../../store/agentContextViewStore";
import type { OpenAgentContextView } from "../../store/agentContextViewStore";
import { reportContextViewResult } from "../../utils/contextViewTrace";
import { markAgentContextViewGone } from "./agentContextViewStatus";

/**
 * The context behind one agent message
 * (`GET /api/agents/:id/messages/:messageId/context`, Archer's #12958):
 * `{ok: true, context}` streamed from the agent's Computer, or
 * `{ok: false, reason, computer, computerOwner}`. Asked once the status says
 * `available`, once per opening of a message (and on Retry); never cached:
 * every attempt is audited. Closing the panel or opening another message
 * aborts the request, so the Server ends the attempt `cancelled` and stops
 * reading from the Computer.
 *
 * - `gone`: the 404 every refusal is (the flag went off, access was lost);
 *   the panel closes and the status is kept as that 404.
 * - `ok`: the parsed view, and the body as received (Copy raw request).
 * - `failed`: a reason to say. An answer that is cut off (the Server destroys
 *   the response rather than send a partial body), not JSON, or not a view
 *   (`parseAgentContextView`) is `read_failed`, as is any other failed
 *   request: none of them is `too_large`, which only the Server says. A
 *   `too_large` may say why (`tooLargeCause`); a Computer that predates it
 *   doesn't, and the panel says the general sentence.
 */
export type AgentContextViewAnswer =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "ok"; context: AgentContextView; raw: string }
  | { kind: "failed"; reason: AgentContextViewFailureReason; tooLargeCause?: AgentContextViewTooLargeCause; computer: Named | null; computerOwner: Named | null };

type Named = { id: string; name: string };
type SettledAnswer = Exclude<AgentContextViewAnswer, { kind: "loading" }>;

function readNamed(value: unknown): Named | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, name } = value as { id?: unknown; name?: unknown };
  return typeof id === "string" && typeof name === "string" ? { id, name } : null;
}

const READ_FAILED: Extract<AgentContextViewAnswer, { kind: "failed" }> = { kind: "failed", reason: "read_failed", computer: null, computerOwner: null };

/** What a 200's body says (text as received, or already decoded). */
export function readAgentContextViewAnswer(body: unknown): SettledAnswer {
  let decoded = body;
  if (typeof body === "string") {
    try {
      decoded = JSON.parse(body);
    } catch {
      return READ_FAILED;
    }
  }
  if (typeof decoded !== "object" || decoded === null) return READ_FAILED;
  const answer = decoded as { ok?: unknown; context?: unknown; reason?: unknown; tooLargeCause?: unknown; computer?: unknown; computerOwner?: unknown };
  if (answer.ok === true) {
    const parsed = parseAgentContextView(answer.context);
    if (!parsed.ok) return READ_FAILED;
    // As received, not as parsed: unknown fields and part kinds stay (indented for reading).
    return { kind: "ok", context: parsed.context, raw: JSON.stringify(answer.context, null, 2) };
  }
  if (answer.ok === false && isAgentContextViewFailureReason(answer.reason)) {
    const tooLargeCause = answer.reason === "too_large" && isAgentContextViewTooLargeCause(answer.tooLargeCause) ? answer.tooLargeCause : undefined;
    return { kind: "failed", reason: answer.reason, ...(tooLargeCause ? { tooLargeCause } : {}), computer: readNamed(answer.computer), computerOwner: readNamed(answer.computerOwner) };
  }
  return READ_FAILED;
}

interface ResultState {
  /** `agentId:messageId` of the view the answer is for. */
  key: string | null;
  /** The view's answer; null where none was asked (the status says it can't be shown). */
  answer: AgentContextViewAnswer | null;
  /** Who viewed this message's context (newest first); null until loaded or when it failed. */
  viewedBy: AgentContextViewRecord[] | null;
}

export const useAgentContextViewResultStore = create<ResultState>(() => ({ key: null, answer: null, viewedBy: null }));

export function agentContextViewKey(view: Pick<OpenAgentContextView, "agentId" | "messageId">): string {
  return `${view.agentId}:${view.messageId}`;
}

let generation = 0;
let controller: AbortController | null = null;
let inflight: { key: string; promise: Promise<void> } | null = null;

/** Drop the current attempt: its answer is ignored and its request aborted. */
function abandon() {
  generation++;
  controller?.abort();
  controller = null;
  inflight = null;
}

/**
 * Who viewed (`GET /agents/:id/context-views?messageId=`), in every state.
 * After this panel's own attempt (`seen`, the outcome it got): the attempt
 * row is written before the request reaches the Computer, but the outcome
 * only after the answer was sent, so it may still read `cancelled` here. The
 * viewer's newest row is that attempt (rows are newest first): it takes the
 * outcome this panel saw.
 */
async function loadViewedBy(view: OpenAgentContextView, key: string, mine: number, own: { viewerId: string | null; seen: AgentContextViewOutcome } | null) {
  try {
    const { data } = await api.get<AgentContextViewRecordList>(`/agents/${encodeURIComponent(view.agentId)}/context-views`, { params: { messageId: view.messageId } });
    if (mine !== generation || !Array.isArray(data?.views)) return;
    const ownIndex = own?.viewerId ? data.views.findIndex((row) => row.viewer?.id === own.viewerId) : -1;
    const views = data.views.map((row, index) => (index === ownIndex && own ? { ...row, outcome: own.seen } : row));
    useAgentContextViewResultStore.setState((state) => (state.key === key ? { viewedBy: views } : state));
  } catch {
    // Not shown: the list is a footnote to the context, never a reason it can't be read.
  }
}

/**
 * The status says the context can't be shown: no attempt is made (nothing is
 * asked of the Computer), but Viewed by still shows the attempts so far.
 */
export async function loadAgentContextViewedByOnly(view: OpenAgentContextView): Promise<void> {
  const key = agentContextViewKey(view);
  abandon();
  const mine = generation;
  useAgentContextViewResultStore.setState({ key, answer: null, viewedBy: null });
  await loadViewedBy(view, key, mine, null);
}

async function attempt(view: OpenAgentContextView, viewerId: string | null, key: string, mine: number, signal: AbortSignal): Promise<void> {
  const startedAt = Date.now();
  let answer: SettledAnswer;
  // What the trace says when the request itself failed (no answer to read).
  let requestFailure: "network_error" | "other" | null = null;
  try {
    const { data } = await api.get<string>(
      `/agents/${encodeURIComponent(view.agentId)}/messages/${encodeURIComponent(view.messageId)}/context`,
      // As text: a body that does not parse must be read_failed, not a string axios silently keeps.
      { responseType: "text", transformResponse: [(raw: unknown) => raw], signal },
    );
    answer = readAgentContextViewAnswer(data);
  } catch (error) {
    // Aborted: the panel closed or moved on; nothing to say.
    if (axios.isCancel(error) || signal.aborted) return;
    answer = axios.isAxiosError(error) && error.response?.status === 404 ? { kind: "gone" } : READ_FAILED;
    if (answer.kind !== "gone") requestFailure = axios.isAxiosError(error) && !error.response ? "network_error" : "other";
  }
  if (mine !== generation) return;
  reportContextViewResult(
    answer.kind === "ok" ? "ok" : answer.kind === "gone" ? "not_allowed" : requestFailure ?? answer.reason,
    Date.now() - startedAt,
  );
  inflight = null;
  controller = null;
  useAgentContextViewResultStore.setState({ answer });
  if (answer.kind === "gone") {
    markAgentContextViewGone(view.agentId);
    const open = useAgentContextViewStore.getState().open;
    if (open && agentContextViewKey(open) === key) useAgentContextViewStore.getState().close();
    return;
  }
  await loadViewedBy(view, key, mine, { viewerId, seen: answer.kind === "ok" ? "ok" : answer.reason });
}

/**
 * Ask for the context of `view`; the answer lands in the store. Opening the
 * same message again while it is loading or shown asks nothing (one audited
 * attempt per opening); `force` (Retry) is a new attempt.
 */
export function loadAgentContextView(view: OpenAgentContextView, viewerId: string | null, options: { force?: boolean } = {}): Promise<void> {
  const key = agentContextViewKey(view);
  const current = useAgentContextViewResultStore.getState();
  if (!options.force && current.key === key && current.answer !== null) {
    return inflight?.key === key ? inflight.promise : Promise.resolve();
  }
  abandon();
  const mine = generation;
  controller = new AbortController();
  useAgentContextViewResultStore.setState({ key, answer: { kind: "loading" }, viewedBy: null });
  const promise = attempt(view, viewerId, key, mine, controller.signal);
  inflight = { key, promise };
  return promise;
}

/** The panel closed or shows another message: abort and forget (opening it again is a new view). */
useAgentContextViewStore.subscribe((state) => {
  const key = useAgentContextViewResultStore.getState().key;
  if (key !== null && (!state.open || agentContextViewKey(state.open) !== key)) {
    abandon();
    useAgentContextViewResultStore.setState({ key: null, answer: null, viewedBy: null });
  }
});

/** The answer for `key`, or null while there is none for it. */
export function useAgentContextViewAnswer(key: string): AgentContextViewAnswer | null {
  return useAgentContextViewResultStore((state) => (state.key === key ? state.answer : null));
}

/**
 * Where the context shown for `key` was restored from (`source.kind`) when it
 * is `verified`, which says what was checked; null while none is shown or it
 * isn't verified.
 */
export function useAgentContextViewVerifiedSource(key: string): AgentContextViewSourceKind | null {
  return useAgentContextViewResultStore((state) => (state.key === key && state.answer?.kind === "ok" && state.answer.context.verification === "verified" ? state.answer.context.source.kind : null));
}

export function useAgentContextViewViewedBy(key: string): AgentContextViewRecord[] | null {
  return useAgentContextViewResultStore((state) => (state.key === key ? state.viewedBy : null));
}

/** Tests: forget everything (and abort what is in flight). */
export function resetAgentContextViewResults() {
  abandon();
  useAgentContextViewResultStore.setState({ key: null, answer: null, viewedBy: null });
}
