import api from "../api/client";
import { markChannelUnavailable } from "./channelAccessLoss";
import { useServerStore } from "./serverStore";
import { useUIStore } from "./uiStore";
import type { OpenThreadRequest, ThreadState } from "./threadStore";

/**
 * Canonical ids for a message link before it is opened (#503).
 *
 * Raft links and refs may name a message by an 8-hex short id (`msg=`, the
 * parent half of `thread=<channel>:<parent>`, `#channel:shortid`), and a link's
 * channel segment is only checked to be hex. The channel and thread routes take
 * full UUIDs only: anything else answers the uniform non-UUID 404
 * (server lib/uuidPathParams.ts), which the thread panel used to show as "you
 * can't access this thread". `GET /messages/context/:id` is the route that
 * takes a short id (scoped by a UUID `channelId`) and answers the canonical
 * ids, so an id that is not a full UUID is resolved through it first; a full
 * UUID passes through with no request.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[0-9a-f]{8}$/i;
/** A short id, or a UUID cut short or run on: the shapes a link or ref carries. */
const RAFT_ID_PREFIX_RE = /^[0-9a-f]{8}(?:-[0-9a-f-]*)?$/i;

export function isFullUuid(id: string | null | undefined): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

/**
 * An id shaped like a Raft id that is not a full UUID (a short id, a truncated
 * UUID): no UUID route takes it, so it is resolved (or refused) before it is
 * sent. Any other string is no id a link produces and is left to the route.
 */
export function needsCanonicalId(id: string | null | undefined): boolean {
  return typeof id === "string" && !UUID_RE.test(id) && RAFT_ID_PREFIX_RE.test(id);
}

/**
 * A channel id a link cut short (`/channel/<short id>`): no channel route
 * takes it, so the page says the conversation isn't available, as for one
 * `GET /channels/:id` refused, and nothing is requested.
 */
export function refuseShortChannelId(channelId: string): boolean {
  if (!needsCanonicalId(channelId)) return false;
  markChannelUnavailable(channelId);
  return true;
}

/** `unresolvable`: no lookup names it (malformed, missing, not readable here); `transient`: the lookup failed, try again. */
export type LinkIdFailure = "unresolvable" | "transient";

interface LocatedMessage {
  channelId: string;
  messageId: string;
  threadParentMessageId: string | null;
  threadChannelId: string | null;
}

interface ContextAnswer {
  code?: unknown;
  channelId?: unknown;
  targetMessageId?: unknown;
  canonicalTarget?: { kind?: unknown; channelId?: unknown; threadParentMessageId?: unknown; threadChannelId?: unknown } | null;
}

/** Where a message is, by the context route: its channel and, for a thread reply, its thread. */
async function locateMessage(channelId: string, messageId: string): Promise<LocatedMessage | LinkIdFailure> {
  const scoped = isFullUuid(channelId);
  // A short id is only unique within a channel, and the route takes a UUID channel only.
  if (!isFullUuid(messageId) && !(scoped && SHORT_ID_RE.test(messageId))) return "unresolvable";
  let answer: ContextAnswer | undefined;
  try {
    ({ data: answer } = await api.get<ContextAnswer>(`/messages/context/${encodeURIComponent(messageId)}`, {
      params: { ...(scoped ? { channelId } : {}), before: 0, after: 0 },
    }));
  } catch (error) {
    const response = (error as { response?: { status?: number; data?: ContextAnswer } } | null)?.response;
    // A target behind the history window still says where it is (hiddenHistoryStore).
    if (response?.status === 404 && response.data?.code === "history_limited") answer = response.data;
    else return response?.status === 404 || response?.status === 400 ? "unresolvable" : "transient";
  }
  const thread = answer?.canonicalTarget?.kind === "thread" ? answer.canonicalTarget : null;
  const located = {
    channelId: thread ? thread.channelId : answer?.channelId,
    messageId: answer?.targetMessageId,
    threadParentMessageId: thread ? thread.threadParentMessageId : null,
    threadChannelId: thread && isFullUuid(thread.threadChannelId as string) ? thread.threadChannelId as string : null,
  };
  if (!isFullUuid(located.channelId as string) || !isFullUuid(located.messageId as string)) return "unresolvable";
  if (thread && !isFullUuid(located.threadParentMessageId as string)) return "unresolvable";
  return located as LocatedMessage;
}

export interface MessageLinkIds {
  channelId: string;
  messageId: string;
  threadParentMessageId: string | null;
}

/** A parsed message link (raftPermalinks.parseRaftPermalink) with canonical ids. */
export async function resolveMessageLinkIds<T extends MessageLinkIds>(link: T): Promise<T | LinkIdFailure> {
  if (isFullUuid(link.channelId) && isFullUuid(link.messageId)
    && (link.threadParentMessageId === null || isFullUuid(link.threadParentMessageId))) return link;
  const located = await locateMessage(link.channelId, link.messageId);
  if (typeof located === "string") return located;
  let threadParentMessageId = located.threadParentMessageId
    ?? (link.threadParentMessageId === link.messageId ? located.messageId : link.threadParentMessageId);
  if (threadParentMessageId && !isFullUuid(threadParentMessageId)) {
    const parent = await locateMessage(located.channelId, threadParentMessageId);
    if (typeof parent === "string") return parent;
    threadParentMessageId = parent.threadParentMessageId ?? parent.messageId;
  }
  return { ...link, channelId: located.channelId, messageId: located.messageId, threadParentMessageId };
}

export interface ThreadAnchorIds {
  parentChannelId: string;
  parentMessageId: string;
  threadChannelId: string | null;
  focusedMessageId: string | null;
}

/**
 * A thread's anchor with canonical ids. One that needs no resolution passes
 * through with no request; an id naming a reply resolves to its thread, with
 * the reply as the focus.
 */
export async function resolveThreadAnchorIds(parentChannelId: string, parentMessageId: string): Promise<ThreadAnchorIds | LinkIdFailure> {
  if (!needsCanonicalId(parentChannelId) && !needsCanonicalId(parentMessageId)) {
    return { parentChannelId, parentMessageId, threadChannelId: null, focusedMessageId: null };
  }
  const located = await locateMessage(parentChannelId, parentMessageId);
  if (typeof located === "string") return located;
  return located.threadParentMessageId
    ? { parentChannelId: located.channelId, parentMessageId: located.threadParentMessageId, threadChannelId: located.threadChannelId, focusedMessageId: located.messageId }
    : { parentChannelId: located.channelId, parentMessageId: located.messageId, threadChannelId: null, focusedMessageId: null };
}

type SetThreadState = (partial: Partial<ThreadState> | ((state: ThreadState) => Partial<ThreadState>)) => void;
type OpenThreadSurface = (request: OpenThreadRequest) => Promise<void>;

/** An open waiting on its lookup: shown in the store as the raw anchor, loading. */
interface PendingOpen {
  run: Promise<void>;
  /** Puts the raw anchor (loading) in the store again, if something else replaced it. */
  mark: () => void;
}

const resolving = new Map<string, PendingOpen>();

/**
 * threadStore's open actions (`openThread`, `openTaskModal`) behind the
 * canonical-id check: whatever opened it (a `thread=` / `task=` address, a
 * ref, a link), the thread lookup is sent canonical ids only. Ids that need
 * resolving are resolved once (concurrent opens of the same anchor share it);
 * ids that can't be resolved end on the panel's generic failure, never the
 * "can't access" copy, and without a Retry that would send them again.
 *
 * While the lookup runs the raw anchor is the open one (the panel's loading
 * skeleton, the URL as given), so a close, Back or newer open replaces it as
 * any open is replaced; the answer is applied only to that anchor still up.
 */
export function withCanonicalThreadIds(
  surface: "thread" | "task",
  get: () => ThreadState,
  set: SetThreadState,
  open: OpenThreadSurface,
): OpenThreadSurface {
  return (request) => {
    if (!needsCanonicalId(request.parentChannelId) && !needsCanonicalId(request.parentMessageId)) return open(request);
    // A task open from openThread goes on to openTaskModal, which resolves; a
    // request for another server is refused by `open` with no request.
    const current = useServerStore.getState().current;
    if ((surface === "thread" && request.intent === "task") || (request.serverSlug && current?.slug !== request.serverSlug)) return open(request);
    const key = `${surface}\u0000${request.parentChannelId}\u0000${request.parentMessageId}`;
    const pending = resolving.get(key);
    if (pending) {
      pending.mark();
      return pending.run;
    }
    const entry = openResolved(surface, get, set, open, request);
    const shared: PendingOpen = { mark: entry.mark, run: entry.run.finally(() => resolving.delete(key)) };
    resolving.set(key, shared);
    return shared.run;
  };
}

function openResolved(
  surface: "thread" | "task",
  get: () => ThreadState,
  set: SetThreadState,
  open: OpenThreadSurface,
  request: OpenThreadRequest,
): PendingOpen {
  const { parentChannelId, parentMessageId } = request;
  const serverEpoch = useServerStore.getState().serverEpoch;
  const serverSlug = request.serverSlug ?? useServerStore.getState().current?.slug ?? null;
  const focusedMessageId = request.focusedMessageId ?? null;
  let pendingTask: ThreadState["taskModal"] = null;
  // No thread was up: the open is cold (its Focus Mode resumes once its canonical id is known).
  let coldOpen = false;
  // Once the lookup has answered, a repeat of the same short open joins the
  // canonical open in flight; writing the short anchor back would strand it loading.
  let answered = false;
  const isPending = (state: ThreadState) => surface === "task"
    ? pendingTask !== null && state.taskModal === pendingTask
    : state.openParentChannelId === parentChannelId && state.openParentMessageId === parentMessageId
      && state.openThreadLoading && state.openThreadChannelId === null && state.openThreadError === null;
  const mark = () => {
    const state = get();
    if (answered || isPending(state)) return;
    if (surface === "task") {
      pendingTask = { parentMessageId, parentChannelId, threadChannelId: null, serverSlug, focusedMessageId, focusNonce: 0, loading: true, error: null };
      set({ taskModal: pendingTask });
      return;
    }
    // As openThread: another thread up gives up its layout (one in the same
    // channel is retargeted once the canonical id is known).
    coldOpen = state.openParentChannelId === null;
    if (!coldOpen && state.openParentChannelId !== parentChannelId) useUIStore.getState().restoreThreadLayout();
    set({
      openParentMessageId: parentMessageId,
      openParentChannelId: parentChannelId,
      openIntent: "thread",
      openThreadChannelId: null,
      openServerSlug: serverSlug,
      openThreadError: null,
      openThreadLoading: true,
      focusedMessageId,
      openedAt: Date.now(),
      taskModal: null,
    });
  };
  mark();
  const run = (async () => {
    const anchor = await resolveThreadAnchorIds(parentChannelId, parentMessageId);
    answered = true;
    // Closed, replaced by another open, or another server since: that wins.
    if (useServerStore.getState().serverEpoch !== serverEpoch || !isPending(get())) return;
    if (typeof anchor !== "string") {
      if (surface === "thread") {
        // The open below then reads as this thread retargeted, not another one taking over.
        if (coldOpen) useUIStore.getState().resumeThreadLayout(anchor.parentMessageId);
        set({ openParentChannelId: anchor.parentChannelId, openParentMessageId: anchor.parentMessageId });
      }
      await open({
        ...request,
        parentChannelId: anchor.parentChannelId,
        parentMessageId: anchor.parentMessageId,
        threadChannelId: request.threadChannelId ?? anchor.threadChannelId,
        focusedMessageId: request.focusedMessageId ?? anchor.focusedMessageId,
      });
      return;
    }
    // Retry re-runs this resolution (never the thread lookup with these ids), so it is offered only when that can help.
    const error = { parentChannelId, parentMessageId, unavailable: false, unresolved: anchor === "unresolvable" };
    if (surface === "task") {
      set({ taskModal: { ...pendingTask!, loading: false, error } });
      return;
    }
    // As openThread's failure: no thread stays in Focus Mode behind the failure.
    if (coldOpen) useUIStore.getState().resumeThreadLayout(parentMessageId);
    else useUIStore.getState().restoreThreadLayout();
    set({ openThreadError: error, openThreadLoading: false });
  })();
  return { run, mark };
}
