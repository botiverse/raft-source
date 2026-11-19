import assert from "node:assert/strict";
import "./helpers/domSetup";
import { useState } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";

// The panel joins its thread's room; no socket here.
vi.mock("../src/api/socket", () => {
  const socket = { on: () => socket, off: () => socket, emit: () => socket, connected: false };
  return { getSocket: () => socket };
});

import api from "../src/api/client";
import { InlineThreadReplies } from "../src/components/message/InlineThreadReplies";
import { useThreadTimeline } from "../src/features/thread/useThreadTimeline";
import { THREAD_PREVIEW_PARAM } from "../src/store/channelPageQuery";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { handleThreadUpdatedForReplies } from "../src/store/threadRepliesSocket";
import {
  consumeThreadUpdatedWithSyncCore,
  hydrateThreadRepliesSnapshotWithSyncCore,
  readThreadRepliesSyncCoreScopeForTests,
  resetThreadRepliesSyncCoreForTests,
} from "../src/store/threadRepliesSyncDomain";
import { captureReceiverPrivateIngressContext } from "../src/store/messageStore";
import {
  MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
  messageRef,
  messageRepliesDiscussion,
  syncScopeWindow,
} from "../../shared/src/discussionGraph";
import { useThreadStore } from "../src/store/threadStore";
import { TestIntlProvider } from "./helpers/intl";

// #14945 asks every channel page for reply previews cut to 200 characters
// (threadPreviewChars, #14921). A thread whose latest reply is 500 characters:
// the page's summary carries 199 characters + "…" flagged `truncated`. That
// cut text is the inline row's and nothing else's: opening the thread shows
// the whole reply, no frame of the panel shows the cut text as its body, and
// what the client holds for the reply is never the cut text passed off as
// the full one.

const SERVER_ID = "server-1";
const USER_ID = "user-1";
const CHANNEL_ID = "channel-1";
const THREAD_ID = "thread-1";
const PARENT_ID = "parent-1";
const REPLY_ID = "reply-5";
const CREATED_AT = "2026-11-14T09:00:00.000Z";
const FULL = "The deploy notes say ".repeat(24).slice(0, 499) + ".";
const CUT = `${FULL.slice(0, 199)}…`;

const originalGet = api.get;
const originalPost = api.post;
const realFormatMessage = ((descriptor: { id: string }) => descriptor.id) as never;

function message(overrides: Partial<Message>): Message {
  return {
    id: "m",
    seq: 1,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "u-2",
    senderName: "Sam",
    messageType: "chat",
    content: "",
    createdAt: CREATED_AT,
    ...overrides,
  } as Message;
}

const parent = message({ id: PARENT_ID, seq: 1, content: "Where are the deploy notes?", threadId: THREAD_ID } as Partial<Message>);
const fullReply = message({
  id: REPLY_ID,
  seq: 5,
  channelId: THREAD_ID,
  content: FULL,
  conversationContext: { channelType: "thread", parentMessageId: PARENT_ID, parentChannelId: CHANNEL_ID, parentChannelType: "channel" },
} as Partial<Message>);

function earlierReply(seq: number) {
  return {
    messageId: `reply-${seq}`, seq, preview: `reply ${seq}`,
    senderId: "u-2", senderType: "user" as const, senderName: "Sam", senderAvatarUrl: null, createdAt: CREATED_AT,
  };
}

/** The channel's latest page, read with threadPreviewChars: the thread's latest reply comes cut. */
function channelPage(replyCount = 1) {
  const earlier = replyCount > 1 ? [3, 4].slice(2 - (replyCount - 1)).map(earlierReply) : [];
  return {
    messages: [parent],
    historyLimited: false,
    threadSummariesByParentMessageId: {
      [PARENT_ID]: {
        threadChannelId: THREAD_ID,
        replyCount,
        lastReplyAt: CREATED_AT,
        participantIds: ["u-2"],
        unreadCount: 0,
        firstUnreadMessageId: null,
        latestReplies: [...earlier, {
          messageId: REPLY_ID, seq: 5, preview: CUT, truncated: true as const,
          senderId: "u-2", senderType: "user" as const, senderName: "Sam", senderAvatarUrl: null, createdAt: CREATED_AT,
        }],
      },
    },
  };
}

/** The live `thread:updated` for the 500-character reply, delivered the way socketBridge does. */
function deliverLiveReply(replyCount: number, withSyncWindow: boolean) {
  const payload = {
    parentMessageId: PARENT_ID,
    threadChannelId: THREAD_ID,
    replyCount,
    lastReplyAt: CREATED_AT,
    participantIds: ["u-2"],
    latestReply: fullReply,
    ...(withSyncWindow ? {
      syncCoreReplyWindow: {
        producer: MESSAGE_REPLIES_SYNC_WINDOW_PRODUCER,
        discussion: messageRepliesDiscussion(
          messageRef(SERVER_ID, PARENT_ID),
          { serverId: SERVER_ID, scopeKind: "channel", scopeId: CHANNEL_ID },
        ),
        window: syncScopeWindow({ epoch: "epoch-1" }),
      },
    } : {}),
  };
  const ingressContext = captureReceiverPrivateIngressContext(useMessageStore.getState().currentUserId);
  const result = consumeThreadUpdatedWithSyncCore(payload as never, {
    serverId: ingressContext.serverId, principalId: ingressContext.principalId, ingressContext,
  });
  if (result.kind === "applied") useThreadStore.getState().applyReplyScope(result.parentMessageId, result.scope);
  else handleThreadUpdatedForReplies(payload as never);
}

function stubChannelPage(replyCount: number) {
  api.get = (async (url: string) => {
    if (url.startsWith(`/messages/channel/${CHANNEL_ID}`)) return { data: channelPage(replyCount) };
    return { data: {} };
  }) as typeof api.get;
}

function inlineRowText(): string {
  const scope = useThreadStore.getState().replyScopes[PARENT_ID]!;
  const view = render(
    <TestIntlProvider>
      <InlineThreadReplies replies={scope.replies} replyCount={scope.replyCount} unreadCount={0} hasDraft={false} onOpenThread={() => {}} />
    </TestIntlProvider>,
  );
  const text = view.container.textContent ?? "";
  view.unmount();
  return text;
}

function heldLatestReplies() {
  return [
    useThreadStore.getState().replyScopes[PARENT_ID]?.replies.find((reply) => reply.messageId === REPLY_ID),
    useThreadStore.getState().summaries[PARENT_ID]?.latestReplies?.find((reply) => reply.messageId === REPLY_ID),
    readThreadRepliesSyncCoreScopeForTests({ serverId: SERVER_ID, principalId: USER_ID, parentMessageId: PARENT_ID, threadChannelId: THREAD_ID })
      ?.replies.find((reply) => reply.messageId === REPLY_ID),
  ].filter((reply) => reply !== undefined);
}

beforeEach(() => {
  resetThreadRepliesSyncCoreForTests();
  useServerStore.setState({ current: { id: SERVER_ID, name: "S", slug: "s" } } as never);
  useMessageStore.getState().setCurrentUserId(USER_ID);
  useMessageStore.setState({ channelMessages: {}, channelWindowMeta: {}, historyFetchedChannels: {}, messages: [], currentChannelId: null });
  useThreadStore.setState({ summaries: {}, replyScopes: {} });
});

afterEach(() => {
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  resetThreadRepliesSyncCoreForTests();
  useMessageStore.getState().setCurrentUserId(null);
  useServerStore.setState({ current: null });
});

const NO_MESSAGES: Message[] = [];

/** The thread panel's reply list: the panel's own replies window (useThreadTimeline), each reply's body as text. */
function ThreadPanelReplies({ onFrame }: { onFrame: (bodies: string[]) => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const threadBucket = useMessageStore((s) => s.channelMessages[THREAD_ID] ?? NO_MESSAGES);
  useThreadTimeline({
    threadChannelId: THREAD_ID,
    parentMessageId: PARENT_ID,
    parentTaskId: null,
    focusedMessageId: null,
    isTaskModalSurface: false,
    threadBucket,
    messages,
    setMessages,
    coerceThreadIngress: (incoming) => [...incoming],
    consumeFocusedMessage: () => {},
    formatMessage: realFormatMessage,
  });
  onFrame(messages.map((reply) => reply.content));
  return <ol>{messages.map((reply) => <li key={reply.id} data-reply-body>{reply.content}</li>)}</ol>;
}

test("opening a thread whose latest reply was cut in the page shows the whole reply, never the cut text as its body", async () => {
  const gets: string[] = [];
  api.get = (async (url: string) => {
    gets.push(url);
    if (url.startsWith(`/messages/channel/${CHANNEL_ID}`)) return { data: channelPage() };
    if (url.startsWith(`/messages/channel/${THREAD_ID}`)) return { data: { messages: [fullReply], historyLimited: false } };
    return { data: {} };
  }) as typeof api.get;
  api.post = (async () => ({ data: {} })) as typeof api.post;

  // The page loads with the parameter.
  await useMessageStore.getState().loadMessages(CHANNEL_ID);
  assert.ok(gets[0]?.includes(THREAD_PREVIEW_PARAM), `the page asks for cut previews: ${gets[0]}`);

  // The parent's inline row shows the cut preview: that is what it is for.
  const scope = useThreadStore.getState().replyScopes[PARENT_ID];
  assert.ok(scope, "the page's summary fills the inline row");
  const inline = render(
    <TestIntlProvider>
      <InlineThreadReplies replies={scope.replies} replyCount={scope.replyCount} unreadCount={0} hasDraft={false} onOpenThread={() => {}} />
    </TestIntlProvider>,
  );
  assert.ok(inline.container.textContent?.includes(CUT));
  inline.unmount();

  // Open the thread.
  const frames: string[][] = [];
  const panel = render(<ThreadPanelReplies onFrame={(bodies) => frames.push(bodies)} />);
  await waitFor(() => assert.deepEqual(
    [...panel.container.querySelectorAll("[data-reply-body]")].map((node) => node.textContent),
    [FULL],
  ));
  await act(async () => {});

  assert.equal(FULL.length, 500);
  for (const bodies of frames) {
    assert.ok(!bodies.some((body) => body === CUT || body.endsWith("…")), "no panel frame shows the cut preview as the reply's body");
  }
  assert.ok(!panel.container.textContent?.includes(CUT));

  // Nothing the client holds passes the cut text off as the reply's content:
  // the thread's messages are the full reply, and the inline read models
  // (thread store and Sync Core) keep it flagged as cut.
  for (const held of useMessageStore.getState().channelMessages[THREAD_ID] ?? []) {
    assert.equal(held.content, FULL);
  }
  const heldPreviews = [
    ...useThreadStore.getState().replyScopes[PARENT_ID]!.replies,
    ...useThreadStore.getState().summaries[PARENT_ID]?.latestReplies ?? [],
    ...readThreadRepliesSyncCoreScopeForTests({ serverId: SERVER_ID, principalId: USER_ID, parentMessageId: PARENT_ID, threadChannelId: THREAD_ID })?.replies ?? [],
  ];
  assert.ok(heldPreviews.length > 0);
  for (const held of heldPreviews) {
    if (held.preview !== FULL) assert.equal(held.truncated, true, "a cut copy stays flagged as cut");
  }
});

test("a reply received whole over the socket stays whole when a later page brings it cut", async () => {
  // The reply arrives live first (the thread's first contact), then the
  // channel's page lands with the three latest replies, this one cut.
  deliverLiveReply(3, true);
  stubChannelPage(3);
  await useMessageStore.getState().loadMessages(CHANNEL_ID);

  const held = heldLatestReplies();
  assert.equal(held.length, 3, "the inline row's scope, the summary and Sync Core each hold it");
  for (const reply of held) {
    assert.equal(reply.preview, FULL, "the whole reply is not replaced by the page's cut copy");
    assert.equal(reply.truncated, undefined);
  }
  assert.ok(inlineRowText().includes(FULL));
  assert.ok(!inlineRowText().includes(CUT));
});

test("without a Sync Core context too, a whole live reply is not replaced by the page's cut copy", async () => {
  useServerStore.setState({ current: null });
  deliverLiveReply(1, false);
  stubChannelPage(1);
  await useMessageStore.getState().loadMessages(CHANNEL_ID);

  const reply = useThreadStore.getState().replyScopes[PARENT_ID]?.replies.find((candidate) => candidate.messageId === REPLY_ID);
  assert.equal(reply?.preview, FULL);
  assert.equal(reply?.truncated, undefined);
});

test("a whole copy of the same version completes a cut one", () => {
  const identity = { serverId: SERVER_ID, principalId: USER_ID, parentMessageId: PARENT_ID, threadChannelId: THREAD_ID };
  const cut = channelPage(1).threadSummariesByParentMessageId[PARENT_ID]!.latestReplies;
  hydrateThreadRepliesSnapshotWithSyncCore({ ...identity, replies: cut, replyCount: 1, historyLimited: false, watermark: 5, epoch: null });
  const whole = [{ ...cut[0]!, preview: FULL, truncated: undefined }];
  const result = hydrateThreadRepliesSnapshotWithSyncCore({ ...identity, replies: whole, replyCount: 1, historyLimited: false, watermark: 5, epoch: null });
  assert.equal(result.scope?.replies[0]?.preview, FULL);
  assert.equal(result.scope?.replies[0]?.truncated, undefined);

  // And the cut one, sent again, does not cut it back.
  const again = hydrateThreadRepliesSnapshotWithSyncCore({ ...identity, replies: cut, replyCount: 1, historyLimited: false, watermark: 5, epoch: null });
  assert.equal(again.scope?.replies[0]?.preview, FULL);
});
