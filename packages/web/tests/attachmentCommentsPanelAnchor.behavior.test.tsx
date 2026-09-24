import "global-jsdom/register";
import { resetAttachmentPreviewSummaryCache } from "../src/components/message/attachmentPreviewSummaryCache";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// oxlint-disable-next-line no-restricted-imports -- Whole-module React shim for classic-runtime test dependencies.
import * as React from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import type { CommentAnchor } from "../src/components/message/attachmentCommentAnchors";
import type { Agent } from "../src/store/agentStore";
import type { Channel } from "../src/store/channelStore";
import type { Message, MessageAttachment } from "../src/store/messageStore";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { default: api } = await import("../src/api/client");
const { AttachmentCommentsPanel } = await import("../src/components/message/AttachmentCommentsPanel");
const { default: MessageItem } = await import("../src/components/message/MessageItem");
const { default: DocumentPreviewHost } = await import("../src/components/message/DocumentPreviewHost");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useSavedStore } = await import("../src/store/savedStore");
const { useServerStore } = await import("../src/store/serverStore");
const originalApiGet = api.get;
const originalApiPost = api.post;
const originalScrollTo = HTMLElement.prototype.scrollTo;
const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;

function setupStores() {
  useAuthStore.setState({
    user: {
      id: "user-attachment-comment",
      email: "user@example.com",
      gravatarHash: "",
      name: "commenter",
      displayName: "Commenter",
      description: null,
      avatarUrl: null,
      emailVerified: true,
      preferredLanguage: null,
      preferredTimezone: null,
      autoTranslationEnabled: false,
      preferredTimeFormat: null,
      preferredMessageBodyFontSize: null,
      referralSource: null,
      referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-attachment-comment",
      name: "Server",
      slug: "server",
      ownerId: "user-attachment-comment",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-04T00:00:00.000Z",
    },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "channel-attachment-comment",
      serverId: "server-attachment-comment",
      name: "general",
      type: "regular",
      description: null,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      isDefault: false,
      createdAt: "2026-07-04T00:00:00.000Z",
    }],
    dmChannels: [],
  } as never);
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });
  useMessageStore.setState({
    drafts: {},
    channelMessages: { "channel-attachment-comment": [] },
    currentChannelId: "channel-attachment-comment",
    messages: [],
  } as never);
}

function makeTextAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: "text-attachment-1",
    filename: "tap-anchor.txt",
    mimeType: "text/plain",
    sizeBytes: 64,
    ...overrides,
  };
}

function makeMessage(attachment: MessageAttachment): Message {
  return {
    id: "message-attachment-comment",
    channelId: "channel-attachment-comment",
    senderType: "user",
    senderId: "user-attachment-comment",
    senderName: "Commenter",
    messageType: "chat",
    content: "text attachment",
    createdAt: "2026-07-04T00:00:00.000Z",
    attachments: [attachment],
  };
}

afterEach(() => {
  resetAttachmentPreviewSummaryCache();
  cleanup();
  api.get = originalApiGet;
  api.post = originalApiPost;
  HTMLElement.prototype.scrollTo = originalScrollTo;
  Element.prototype.scrollIntoView = originalScrollIntoView;
  window.matchMedia = originalMatchMedia;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useSavedStore.setState(useSavedStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("attachment comment submit reads the latest shell anchor instead of the rendered prop", async () => {
  setupStores();
  HTMLElement.prototype.scrollTo = () => {};

  const latestAnchor: CommentAnchor = { type: "video-timestamp", data: { time: 1.2 } };
  const posts: Array<{ url: string; body: unknown }> = [];

  api.get = (async (url: string) => {
    if (url === "/attachments/attachment-1/comments") {
      return {
        data: {
          comments: [],
          threadChannelId: "thread-attachment-comment",
          viewer: { canComment: true, reason: "ok" },
        },
      };
    }
    if (url === "/channels/channel-attachment-comment/members") {
      return { data: { agents: [], humans: [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    posts.push({ url, body });
    return {
      data: {
        threadChannelId: "thread-attachment-comment",
        message: {
          id: "comment-message-1",
          channelId: "thread-attachment-comment",
          senderType: "user",
          senderId: "user-attachment-comment",
          senderName: "Commenter",
          content: "timestamp should survive same-tick submit",
          createdAt: "2026-07-04T00:00:01.000Z",
          commentRef: {
            commentId: "comment-message-1",
            attachmentId: "attachment-1",
            attachmentName: "silent-cut.mp4",
            anchorLabel: "0:01.200",
          },
        },
      },
    };
  }) as typeof api.post;

  render(
    <MemoryRouter>
      <AttachmentCommentsPanel
        attachmentId="attachment-1"
        filename="silent-cut.mp4"
        parentMessage={{ id: "parent-message", channelId: "channel-attachment-comment" }}
        pendingAnchor={null}
        getPendingAnchor={() => latestAnchor}
      />
    </MemoryRouter>,
  );

  const composer = await screen.findByPlaceholderText("Comment on silent-cut.mp4…");
  fireEvent.change(composer, { target: { value: "timestamp should survive same-tick submit" } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  let commentPost: (typeof posts)[number] | undefined;
  await waitFor(() => {
    commentPost = posts.find((post) => post.url === "/attachments/attachment-1/comments");
    assert.ok(commentPost);
  });
  assert.deepEqual(commentPost?.body, {
    content: "timestamp should survive same-tick submit",
    anchor: latestAnchor,
    mentions: undefined,
  });
  assert.deepEqual(
    useMessageStore.getState().channelMessages["thread-attachment-comment"]?.map((message) => ({
      id: message.id,
      content: message.content,
      commentRef: message.commentRef,
    })),
    [{
      id: "comment-message-1",
      content: "timestamp should survive same-tick submit",
      commentRef: {
        commentId: "comment-message-1",
        attachmentId: "attachment-1",
        attachmentName: "silent-cut.mp4",
        anchorLabel: "0:01.200",
      },
    }],
    "the author-visible create response must immediately populate the shared message cache",
  );
});

test("coarse pointer text preview tap commits only real structural anchors", async () => {
  setupStores();
  HTMLElement.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  const commentPosts: unknown[] = [];
  window.matchMedia = ((query: string) => ({
    matches: query === "(pointer: coarse)",
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;

  const getUrls: string[] = [];
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [{ key: "attachment_comments_v0", enabled: true }] } };
    }
    if (url === "/attachments/text-attachment-1/comments") {
      commentPosts.push(body);
      return { data: { threadChannelId: "thread-attachment-comment" } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = (async (url: string) => {
    getUrls.push(url);
    if (url === "/channels/channel-attachment-comment/members") {
      return { data: { agents: [], humans: [] } };
    }
    if (url === "/attachments/text-attachment-1/preview") {
      return {
        data: {
          status: "ok",
          data: { kind: "text", text: "Alpha anchor line\nBeta keep line\n" },
          truncated: false,
        },
      };
    }
    if (url === "/attachments/text-attachment-1/comments") {
      return {
        data: {
          comments: [],
          threadChannelId: "thread-attachment-comment",
          viewer: { canComment: true, reason: "ok" },
        },
      };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  render(
    <MemoryRouter>
      <MessageItem
        message={makeMessage(makeTextAttachment())}
        mentionMap={new Map()}
        channels={[] as Channel[]}
        hideThreadActions
      />
      {/* App.tsx mounts this; a message-only render would never show the modal. */}
      <DocumentPreviewHost />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByLabelText("tap-anchor.txt"));
  await waitFor(() => assert.ok(screen.getByText("Plain text preview")));
  fireEvent.click(await screen.findByRole("button", { name: "Comment" }));

  const line = screen.getByText("Alpha anchor line");
  fireEvent.mouseUp(line);

  await waitFor(() => {
    const pendingAnchor = document.querySelector("[data-message-affordance='attachment-comment-pending-anchor']");
    assert.match(pendingAnchor?.textContent ?? "", /L1/);
  });

  fireEvent.mouseUp(screen.getByText("Plain text preview"));
  const pendingAnchor = document.querySelector("[data-message-affordance='attachment-comment-pending-anchor']");
  assert.match(pendingAnchor?.textContent ?? "", /L1/, "a non-structural tap must not clear the existing pending anchor");

  const secondLine = screen.getByText("Beta keep line");
  const selection = window.getSelection();
  assert.ok(selection);
  const range = document.createRange();
  range.selectNodeContents(secondLine);
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new window.Event("selectionchange"));
  await waitFor(() => {
    const nextPendingAnchor = document.querySelector("[data-message-affordance='attachment-comment-pending-anchor']");
    assert.match(nextPendingAnchor?.textContent ?? "", /L2/);
  });

  selection.removeAllRanges();
  document.dispatchEvent(new window.Event("selectionchange"));
  await new Promise((resolve) => setTimeout(resolve, 350));
  const selectedPendingAnchor = document.querySelector("[data-message-affordance='attachment-comment-pending-anchor']");
  assert.match(selectedPendingAnchor?.textContent ?? "", /L2/, "an empty selectionchange must not clear the existing pending anchor");

  const composer = pendingAnchor?.closest("form")?.querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(composer);
  fireEvent.change(composer, { target: { value: "line anchor comment" } });
  const form = composer.closest("form");
  assert.ok(form);
  fireEvent.submit(form);
  await waitFor(() => assert.equal(commentPosts.length, 1));
  assert.deepEqual(commentPosts[0], {
    content: "line anchor comment",
    anchor: { type: "lines", data: { start: 2, end: 2, quote: "Beta keep line" } },
    mentions: undefined,
  });
  assert.ok(getUrls.includes("/attachments/text-attachment-1/preview"));
});
