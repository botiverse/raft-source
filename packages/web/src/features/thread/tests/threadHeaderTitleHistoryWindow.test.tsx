import assert from "node:assert/strict";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { RefObject } from "react";

import api from "../../../api/client";
import { useThreadParent } from "../useThreadParent";
import { useThreadHeaderTitle } from "../useThreadHeaderTitle";
import { useMessageStore } from "../../../store/messageStore";
import type { Message } from "../../../store/messageStore";
import type { FollowedThread } from "../../../store/threadStore";
import { useRowPlanStore } from "../../../components/layout/rowPlanStore";
import type { RowPlan } from "../../../components/layout/rowPlan";

// #15285 review: a parent behind the plan's history window (the context route's 404 `history_limited`) is not one
// the person can't see (raft-design #1307): the title names it as usual, and the place name and View in channel
// open its conversation at the history paywall: away from it, the `?msg=` jump the paywall centers on; beside it on a
// desktop, in place (the thread stays open).

const CHANNEL_ID = "ch-design";
const PARENT_ID = "msg-root";
const PATH = `/s/acme/channel/${CHANNEL_ID}`;
const formatMessage = (({ id }: { id: string }) => ({
  "message.author.unknown": "Unknown",
  "message.outline.noText": "No text",
}[id] ?? id)) as Parameters<typeof useThreadHeaderTitle>[0]["formatMessage"];

function historyLimited(hiddenTarget: unknown) {
  return Object.assign(new Error("404"), {
    response: { status: 404, data: { code: "history_limited", error: "older", channelId: CHANNEL_ID, targetMessageId: PARENT_ID, hiddenTarget } },
  });
}
const notFound = () => Object.assign(new Error("404"), { response: { status: 404, data: { error: "Message not found" } } });
const GLIMPSE = {
  target: { id: PARENT_ID, seq: 4, senderType: "user", senderId: "u-otto", senderName: "Otto", senderAvatarUrl: null, createdAt: "2026-08-01T10:00:00.000Z", preview: "Brand colors, final: Raft Yellow stays at 400" },
  before: [], after: [], thread: null, replies: null,
};

function mockContext(answer: () => unknown) {
  return vi.spyOn(api, "get").mockImplementation(async (url: string) => {
    if (url === `/messages/context/${PARENT_ID}`) throw answer();
    return { data: { tasks: [] } };
  });
}

function useParent(followedThreads: FollowedThread[] = []) {
  return useThreadParent({
    parentMessageId: PARENT_ID, parentChannelId: CHANNEL_ID, threadChannelId: "th-1", hideParentMessage: false,
    parentChannelBucket: [], followedThreads, threadSummaries: {}, agentById: new Map(), memberById: new Map(),
    currentUser: null, realtimeParentTaskUpdate: null, coerceThreadIngress: (incoming) => [...incoming], messages: [],
  });
}

const regionRef: RefObject<HTMLDivElement | null> = { current: null };
function useTitle(parent: ReturnType<typeof useThreadParent>, navigate: (to: string) => void, pathname = "/s/acme/activity") {
  return useThreadHeaderTitle({
    parentMessage: parent.displayedParentMessageWithThreadId, parentHistoryGlimpse: parent.parentHistoryGlimpse, parentUnavailable: parent.parentUnavailable,
    hideParentMessage: false, showHeader: true, conversationKey: PARENT_ID, replyRegionRef: regionRef, agentById: new Map(), memberById: new Map(),
    currentUser: null, formatMessage, isDesktop: true, presentation: "side", pathname,
    parentChannelId: CHANNEL_ID, parentMessageId: PARENT_ID, parentRouteKind: "channel", serverSlug: "acme", navigate,
  });
}

beforeEach(() => {
  useMessageStore.setState({ channelMessages: {}, highlightedMessageId: null, highlightNonce: 0 });
  useRowPlanStore.setState({ plan: null });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll(".thread-side-column").forEach((node) => node.remove());
});

test("a parent behind the history window is named from the paywall's glimpse, and is not out of reach", async () => {
  mockContext(() => historyLimited(GLIMPSE));
  const to: string[] = [];
  const { result } = renderHook(() => {
    const parent = useParent();
    return { parent, title: useTitle(parent, (path) => { to.push(path); }) };
  });
  await waitFor(() => assert.ok(result.current.parent.parentHistoryGlimpse !== null, "the glimpse is kept"));
  assert.equal(result.current.parent.parentUnavailable, false, "behind the window is not out of reach");
  assert.deepEqual(result.current.title.headerOriginal, { state: "shown", sender: "Otto", text: "Brand colors, final: Raft Yellow stays at 400" });
  assert.equal(result.current.title.parentOutOfView, true, "never a row of the list: the title names it");
  act(() => result.current.title.handleOpenParentChannelAction());
  assert.deepEqual(to, [`${PATH}?msg=${PARENT_ID}`], "the place name opens the conversation at the paywall");
});

test("behind the window with nothing of it known, the title stays Thread and the place name still goes to the paywall", async () => {
  mockContext(() => historyLimited(null));
  const to: string[] = [];
  const { result } = renderHook(() => {
    const parent = useParent();
    return { parent, title: useTitle(parent, (path) => { to.push(path); }) };
  });
  await waitFor(() => assert.ok(result.current.parent.parentHistoryGlimpse !== null, "known to be behind the window"));
  assert.equal(result.current.parent.parentUnavailable, false);
  assert.equal(result.current.title.headerOriginal, null, "Thread, with nothing to name");
  act(() => result.current.title.handleOpenParentChannelAction());
  assert.deepEqual(to, [`${PATH}?msg=${PARENT_ID}`]);
});

test("behind the window, a followed thread's preview names it by its first line where the answer has no glimpse", async () => {
  mockContext(() => historyLimited(null));
  const followed = { parentMessageId: PARENT_ID, parentMessagePreview: "Q3 roadmap draft\n\nOwners and dates below", parentMessageSenderId: "u-juno", parentMessageSenderType: "user", parentInHistory: false } as FollowedThread;
  const { result } = renderHook(() => {
    const parent = useParent([followed]);
    return { parent, title: useTitle(parent, () => {}) };
  });
  await waitFor(() => assert.ok(result.current.title.headerOriginal !== null, "named"));
  assert.deepEqual(result.current.title.headerOriginal, { state: "shown", sender: "Unknown", text: "Q3 roadmap draft" });
});

test("a plain not found (or a refusal) is still out of reach", async () => {
  mockContext(notFound);
  const { result } = renderHook(() => useParent());
  await waitFor(() => assert.equal(result.current.parentUnavailable, true));
  assert.equal(result.current.parentHistoryGlimpse, null);
});

test("beside its conversation but covered by the thread (a narrow row), the place name takes the ?msg= route", () => {
  useMessageStore.setState({ channelMessages: { [CHANNEL_ID]: [{ id: PARENT_ID, channelId: CHANNEL_ID } as Message] } });
  const parent = { displayedParentMessageWithThreadId: { id: PARENT_ID, channelId: CHANNEL_ID, senderType: "user", senderId: "u", senderName: "Juno", content: "Hi", createdAt: "" } as Message, parentHistoryGlimpse: null, parentUnavailable: false } as ReturnType<typeof useThreadParent>;
  const to: string[] = [];
  const { result } = renderHook(() => useTitle(parent, (path) => { to.push(path); }, PATH));
  // Not covered: located in place, the thread stays open.
  act(() => result.current.handleOpenParentChannelAction());
  assert.deepEqual(to, []);
  assert.equal(useMessageStore.getState().highlightedMessageId, PARENT_ID);
  // The row plan folds the thread over the conversation's column (#189 rule 3).
  useMessageStore.setState({ highlightedMessageId: null });
  useRowPlanStore.setState({ plan: { fold: true } as RowPlan });
  act(() => result.current.handleOpenParentChannelAction());
  assert.deepEqual(to, [`${PATH}?msg=${PARENT_ID}`]);
  // No plan, but the column says it covers.
  useRowPlanStore.setState({ plan: null });
  const column = document.createElement("div");
  column.className = "thread-side-column";
  column.setAttribute("data-covers", "first");
  document.body.append(column);
  act(() => result.current.handleOpenParentChannelAction());
  assert.deepEqual(to, [`${PATH}?msg=${PARENT_ID}`, `${PATH}?msg=${PARENT_ID}`]);
});

// Kirby, #proj-chat:409f38ec: beside its own conversation on a desktop, a parent behind the window is handled in
// place like any other: the conversation beside the thread loads the parent's context, which stops at the history
// paywall (messageStore.loadMessageContext: history_limited + hiddenTarget), and the thread stays open.
test("beside its conversation, a parent behind the window is located in place: the conversation loads it to the paywall, no route", async () => {
  mockContext(() => historyLimited(GLIMPSE));
  const { result: parentHook } = renderHook(() => useParent());
  await waitFor(() => assert.equal(parentHook.current.parentHistoryGlimpse?.preview, GLIMPSE.target.preview));
  const loadMessageContext = vi.spyOn(useMessageStore.getState(), "loadMessageContext").mockResolvedValue(undefined);
  const to: string[] = [];
  const { result } = renderHook(() => useTitle(parentHook.current, (path) => { to.push(path); }, PATH));
  act(() => result.current.handleOpenParentChannelAction());
  assert.deepEqual(to, [], "no ?msg= route: the thread stays open");
  assert.deepEqual(loadMessageContext.mock.calls, [[CHANNEL_ID, PARENT_ID]]);
});
