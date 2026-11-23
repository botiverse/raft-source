import assert from "node:assert/strict";
import "./helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QUOTE_REPLY_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { ResolvedInlineQuote, ResolvedInlineQuotesMap } from "@botiverse/raft-shared";
import { toast } from "@botiverse/raft-ui";

import api from "../src/api/client";
import MessageItem from "../src/components/message/MessageItem";
import { QuoteReplyBlocks } from "../src/components/message/QuoteReplyBlocks";
import { QuoteReplyPreview } from "../src/components/message/QuoteReplyPreview";
import {
  QuotedMessageLocalJumpContext,
  useQuoteJumpHighlightStore,
} from "../src/components/message/useJumpToQuotedMessage";
import { messageHoverToolbarActions } from "../src/components/message/MessageHoverToolbar";
import { getMessageSelectionShortcutTarget } from "../src/components/message/messageSelectionShortcutUtils";
import { emitSelectedTextQuote } from "../src/components/message/selectedTextQuote";
import { MessageInput } from "../src/features/composer/MessageInput";
import { useComposerQuoteStore } from "../src/features/composer/composerQuoteStore";
import { clearDraftPendingFilesForTests, clearFailedSendMentionsForTests } from "../src/features/composer/draftPendingFilesCache";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message, SendMessageResult } from "../src/store/messageStore";
import {
  clearResolvedQuotesHydration,
  hydrateLiveMessageResolvedQuotes,
} from "../src/store/resolvedQuotesHydrationStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { useServerStore } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";
import { resetUploadCapability, withUploadCapability } from "./helpers/uploadCapability";

const CHANNEL_ID = "chan-quote-1";
const SERVER_ID = "srv-quote-1";
const originalApiGet = api.get;
const originalApiPost = api.post;
const originalToastInfo = toast.info;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

const SAMPLE_QUOTE_1: ResolvedInlineQuote = {
  messageId: "54a733de-1111-4222-8333-1234567890ab",
  shortId: "54a733de",
  author: { type: "user", name: "Artea" },
  createdAt: "2026-11-19T06:34:36.000Z",
  isPartial: true,
};

const SAMPLE_QUOTE_2: ResolvedInlineQuote = {
  messageId: "99bbccdd-2222-4333-8444-1234567890cd",
  shortId: "99bbccdd",
  author: { type: "agent", name: "Sage" },
  createdAt: "2026-11-19T06:40:00.000Z",
  isPartial: false,
};

function resetAll() {
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  toast.info = originalToastInfo;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  useComposerQuoteStore.getState().clearAll();
  useQuoteJumpHighlightStore.getState().clear();
  clearResolvedQuotesHydration();
  clearDraftPendingFilesForTests();
  clearFailedSendMentionsForTests();
  resetServerFeatureFlagsForTests();
  resetUploadCapability();
}

function seedStores(flagEnabled: boolean) {
  useAuthStore.setState({
    user: { id: "user-1", email: "u@example.com", name: "artea", displayName: "Artea", composerSendKey: "enter" },
    initialized: true,
    loading: false,
  } as never);
  useServerStore.setState({
    current: { id: SERVER_ID, name: "Raft", slug: "raft", ownerId: "user-1", role: "owner", plan: "free" },
    members: [],
    serverEpoch: 1,
  } as never);
  useChannelStore.setState({
    channels: [
      { id: CHANNEL_ID, serverId: SERVER_ID, name: "proj-chat", type: "channel", archived: false },
      { id: "dm-peer-1", serverId: SERVER_ID, name: "peer", type: "dm", archived: false },
    ],
    dmChannels: [],
  } as never);
  setServerFeatureFlagForTests(SERVER_ID, QUOTE_REPLY_FEATURE_FLAG_KEY, flagEnabled);
}

const noop = () => {};

function baseMarkdownProps() {
  return {
    channels: [],
    mentionMap: new Map(),
    structuredMentionMap: new Map(),
    onNavigateChannel: noop,
    onNavigateDm: noop,
    onNavigateAgent: noop,
    onNavigateHuman: noop,
    onNavigateExternal: noop,
    timeFormatOptions: {},
    readReceiptChannelId: CHANNEL_ID,
    readReceiptMessageSeq: 1,
    readReceiptEnabled: false,
  };
}

test("MessageHoverToolbar omits quote when flag off and places quote right after thread when enabled", () => {
  assert.deepEqual(
    messageHoverToolbarActions({ canForward: true, canMore: true }),
    ["reaction", "thread", "forward", "bookmark", "more"],
  );
  assert.deepEqual(
    messageHoverToolbarActions({ canQuote: true, canForward: true, canMore: true }),
    ["reaction", "thread", "quote", "forward", "bookmark", "more"],
  );
});

test("QuoteReplyBlocks renders interleaved multi-point verified quotes, triggers partial-jump passage highlight, and hides msg=<id> on degraded blocks", async () => {
  try {
    seedStores(true);
    let getCalls = 0;
    api.get = (async () => {
      getCalls += 1;
      return { data: {} };
    }) as typeof api.get;

    const jumped: string[] = [];
    const content = [
      "> follow raft design system",
      "> msg=54a733de",
      "",
      "Agreed on design.",
      "",
      "> keep agent read verbatim",
      "> msg=99bbccdd",
      "",
      "Agreed on AX.",
      "",
      "> retracted or spoofed excerpt",
      "> msg=deadbeef",
      "",
      "Still readable after degradation.",
    ].join("\n");

    const resolvedQuotes: ResolvedInlineQuotesMap = {
      "0": SAMPLE_QUOTE_1,
      "1": SAMPLE_QUOTE_2,
    };

    const { container } = render(
      <MemoryRouter initialEntries={["/s/raft/channel/chan-quote-1"]}>
        <TestIntlProvider>
          <QuotedMessageLocalJumpContext.Provider value={(id) => { jumped.push(id); return true; }}>
            <QuoteReplyBlocks
              {...baseMarkdownProps()}
              messageId="reply-multi-1"
              quoteReplyEnabled={true}
              resolvedQuotes={resolvedQuotes}
              content={content}
            />
          </QuotedMessageLocalJumpContext.Provider>
        </TestIntlProvider>
      </MemoryRouter>,
    );

    const firstQuote = screen.getByTestId("message-quote-reply-reply-multi-1");
    assert.equal(firstQuote.getAttribute("data-quote-reply-preview"), "true");
    assert.ok(firstQuote.textContent?.includes("Artea"));
    assert.ok(firstQuote.textContent?.includes("follow raft design system"));

    const secondQuote = screen.getByTestId("message-quote-reply-reply-multi-1-1");
    assert.ok(secondQuote.textContent?.includes("Sage"));
    assert.ok(secondQuote.textContent?.includes("keep agent read verbatim"));

    // Degraded block 2 omits author/jump AND hides trailing `msg=deadbeef` in Web display
    const degraded = container.querySelector("[data-quote-reply-degraded='true']");
    assert.ok(degraded, "degraded quote block should be wrapped in degraded container");
    assert.ok(degraded.querySelector("blockquote"), "degraded quote renders as plain blockquote");
    assert.ok(degraded.textContent?.includes("retracted or spoofed excerpt"));
    assert.ok(!degraded.textContent?.includes("msg=deadbeef"), "degraded quote must hide trailing msg=<id> line in Web UI");
    assert.equal(getCalls, 0, "verified/degraded HTTP-loaded message must never trigger extra fetch on mount");

    // Clicking partial quote sets passage highlight alongside local jump
    fireEvent.click(firstQuote);
    assert.deepEqual(jumped, [SAMPLE_QUOTE_1.messageId]);
    assert.equal(useQuoteJumpHighlightStore.getState().target?.messageId, SAMPLE_QUOTE_1.messageId);
    assert.equal(useQuoteJumpHighlightStore.getState().target?.passage, "follow raft design system");

    // Clicking whole-message quote clears/does not set passage highlight for whole message
    useQuoteJumpHighlightStore.getState().clear();
    fireEvent.click(secondQuote);
    assert.deepEqual(jumped, [SAMPLE_QUOTE_1.messageId, SAMPLE_QUOTE_2.messageId]);
    assert.equal(useQuoteJumpHighlightStore.getState().target, null);
  } finally {
    resetAll();
  }
});

test("hydrateLiveMessageResolvedQuotes upgrades a WS-received message via per-viewer GET /messages/:id/resolved-quotes", async () => {
  try {
    seedStores(true);
    const requestedUrls: string[] = [];
    api.get = (async (url: string) => {
      requestedUrls.push(url);
      return { data: { resolvedQuotes: { "0": SAMPLE_QUOTE_1 } } };
    }) as typeof api.get;

    const liveContent = "> follow raft design system\n> msg=54a733de\n\nLive WS reply.";
    render(
      <MemoryRouter initialEntries={["/s/raft/channel/chan-quote-1"]}>
        <TestIntlProvider>
          <QuoteReplyBlocks
            {...baseMarkdownProps()}
            messageId="ws-live-1"
            quoteReplyEnabled={true}
            resolvedQuotes={undefined}
            content={liveContent}
          />
        </TestIntlProvider>
      </MemoryRouter>,
    );

    assert.ok(screen.queryByTestId("message-quote-reply-ws-live-1") === null);

    act(() => {
      hydrateLiveMessageResolvedQuotes({ id: "ws-live-1", content: liveContent });
    });

    await waitFor(() => {
      assert.ok(screen.getByTestId("message-quote-reply-ws-live-1"));
    });
    assert.deepEqual(requestedUrls, ["/messages/ws-live-1/resolved-quotes"]);
  } finally {
    resetAll();
  }
});

test("QuoteReplyPreview shows one uniform toast for every 404 (missing/private/DM/history_limited)", async () => {
  try {
    seedStores(true);
    api.get = (async () => {
      const error = new Error("Not found") as Error & { response?: { status: number } };
      error.response = { status: 404 };
      throw error;
    }) as typeof api.get;

    const toasts: string[] = [];
    toast.info = ((msg: string) => {
      toasts.push(String(msg));
      return "";
    }) as typeof toast.info;

    render(
      <MemoryRouter initialEntries={["/s/raft/channel/chan-quote-1"]}>
        <TestIntlProvider>
          <QuoteReplyPreview
            messageId="reply-404"
            blockIndex={0}
            excerpt="follow raft design system"
            quote={SAMPLE_QUOTE_1}
          />
        </TestIntlProvider>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByTestId("message-quote-reply-reply-404"));
    await waitFor(() => {
      assert.equal(toasts.length, 1);
    });
    assert.match(toasts[0]!, /isn't available/i);
  } finally {
    resetAll();
  }
});

test("MessageItem hides Quote when right-clicking inside [data-quote-reply-preview] and shows Quote on body right-click", async () => {
  try {
    seedStores(true);
    const replyMsg: Message = {
      id: "msg-with-quote-1",
      channelId: CHANNEL_ID,
      senderType: "user",
      senderId: "user-1",
      senderName: "artea",
      senderDisplayName: "Artea",
      messageType: "chat",
      content: "> follow raft design system\n> msg=54a733de\n\nMy reply body text.",
      createdAt: "2026-11-19T07:00:00.000Z",
      resolvedQuotes: { "0": SAMPLE_QUOTE_1 },
    };

    render(
      <MemoryRouter initialEntries={["/s/raft/channel/chan-quote-1"]}>
        <TestIntlProvider>
          <MessageItem
            message={replyMsg}
            mentionMap={new Map()}
            channels={[{ id: CHANNEL_ID, name: "proj-chat", description: null, type: "channel", createdAt: "2026-11-01T00:00:00.000Z" }]}
          />
        </TestIntlProvider>
      </MemoryRouter>,
    );

    const quoteBar = screen.getByTestId("message-quote-reply-msg-with-quote-1");
    fireEvent.contextMenu(quoteBar);
    await waitFor(() => {
      assert.ok(screen.queryByTestId("message-context-quote") === null);
    });

    const bodyText = screen.getByText("My reply body text.");
    fireEvent.contextMenu(bodyText);
    await waitFor(() => {
      assert.ok(screen.getByTestId("message-context-quote"));
    });
  } finally {
    resetAll();
  }
});

test("getMessageSelectionShortcutTarget ignores selections inside [data-quote-reply-preview]", () => {
  try {
    const body = document.createElement("div");
    body.setAttribute("data-message-selectable", "true");
    body.setAttribute("data-message-id", "msg-select-1");
    body.setAttribute("data-quote-channel-id", CHANNEL_ID);
    body.setAttribute("data-quote-author-name", "Artea");
    body.setAttribute("data-quote-author-type", "user");
    body.setAttribute("data-quote-created-at", "2026-11-19T07:00:00.000Z");

    const preview = document.createElement("div");
    preview.setAttribute("data-quote-reply-preview", "true");
    const previewText = document.createTextNode("quoted ancestor text");
    preview.appendChild(previewText);
    body.appendChild(preview);
    document.body.appendChild(body);

    const range = document.createRange();
    range.setStart(previewText, 0);
    range.setEnd(previewText, 6);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: previewText,
      focusNode: previewText,
      getRangeAt: () => range,
      toString: () => "quoted",
    } as unknown as Selection;

    assert.equal(getMessageSelectionShortcutTarget(fakeSelection), null);
  } finally {
    document.body.innerHTML = "";
  }
});

test("MessageInput serializes ComposerQuoteBar directly into unified `> ...\\n> msg=<id>` Markdown without extra payload", async () => {
  await withUploadCapability(async () => {
    const originalSend = useMessageStore.getState().sendMessage;
    const originalAddOptimistic = useMessageStore.getState().addOptimisticMessage;
    const sentCalls: Array<{ channelId: string; content: string }> = [];
    const optimisticCalls: Message[] = [];
    try {
      seedStores(true);
      useMessageStore.setState({
        addOptimisticMessage: (msg: Message) => {
          optimisticCalls.push(msg);
        },
        sendMessage: async (channelId: string, content: string): Promise<SendMessageResult> => {
          sentCalls.push({ channelId, content });
          return { messageId: "sent-1", pendingMentionActions: [], unresolvedMentionHandles: [] };
        },
      });

      render(
        <MemoryRouter initialEntries={["/s/raft/channel/chan-quote-1"]}>
          <TestIntlProvider>
            <MessageInput channelId={CHANNEL_ID} channelName="proj-chat" />
          </TestIntlProvider>
        </MemoryRouter>,
      );

      act(() => {
        emitSelectedTextQuote(CHANNEL_ID, "follow raft design system", {
          messageId: SAMPLE_QUOTE_1.messageId,
          authorName: "Artea",
          authorType: "user",
          createdAt: SAMPLE_QUOTE_1.createdAt,
          isPartial: true,
        });
      });

      await waitFor(() => {
        assert.ok(screen.getByTestId("composer-quote-bar"));
      });
      const textarea = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
      assert.equal(textarea.value, "", "textarea stays clean while ComposerQuoteBar holds the pending quote");

      fireEvent.change(textarea, { target: { value: "Agreed!" } });
      fireEvent.keyDown(textarea, { key: "Enter" });

      await waitFor(() => {
        assert.equal(sentCalls.length, 1);
      });
      assert.equal(
        sentCalls[0]!.content,
        "> follow raft design system\n> msg=54a733de\n\nAgreed!",
      );
      assert.equal(optimisticCalls[0]?.resolvedQuotes?.["0"]?.messageId, SAMPLE_QUOTE_1.messageId);
      assert.equal(optimisticCalls[0]?.resolvedQuotes?.["0"]?.isPartial, true);
      assert.ok(screen.queryByTestId("composer-quote-bar") === null, "composer quote bar clears on send");
    } finally {
      useMessageStore.setState({
        sendMessage: originalSend,
        addOptimisticMessage: originalAddOptimistic,
      });
      resetAll();
    }
  });
});

test("MessageInput preserves legacy plain `> ...` insertion when quote_reply_v0 is off", async () => {
  await withUploadCapability(async () => {
    try {
      seedStores(false);
      render(
        <MemoryRouter initialEntries={["/s/raft/channel/chan-quote-1"]}>
          <TestIntlProvider>
            <MessageInput channelId={CHANNEL_ID} channelName="proj-chat" />
          </TestIntlProvider>
        </MemoryRouter>,
      );

      act(() => {
        emitSelectedTextQuote(CHANNEL_ID, "legacy quoted words", {
          messageId: SAMPLE_QUOTE_1.messageId,
          authorName: "Artea",
          authorType: "user",
          createdAt: SAMPLE_QUOTE_1.createdAt,
          isPartial: true,
        });
      });

      const textarea = screen.getByTestId("composer-textarea") as HTMLTextAreaElement;
      await waitFor(() => {
        assert.equal(textarea.value, "> legacy quoted words\n\n");
      });
      assert.ok(screen.queryByTestId("composer-quote-bar") === null);
    } finally {
      resetAll();
    }
  });
});
