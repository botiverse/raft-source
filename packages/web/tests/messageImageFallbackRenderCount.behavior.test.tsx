import assert from "node:assert/strict";
import { resetInlineAttachmentUrlCache } from "../src/components/message/inlineAttachmentUrlCache";
import { afterEach, test } from "node:test";
import { act } from "react";
import { cleanup, render as rtlRender, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message, MessageAttachment } from "../src/store/messageStore";
import { createRenderCounter } from "./helpers/renderCount";

const originalGet = api.get;

function makeUser(): User {
  return {
    id: "user-1",
    email: "owner@example.com",
    gravatarHash: "",
    name: "owner",
    displayName: "Owner",
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: "UTC",
    autoTranslationEnabled: false,
    preferredTranslationDisplay: "original",
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function makeMessage(attachments?: MessageAttachment[]): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    // Keep the sender distinct from the viewer so Gravatar's independent
    // async email-hash commit cannot hide the fallback-effect regression.
    senderId: "user-2",
    senderName: "Guest",
    messageType: "chat",
    content: "",
    createdAt: "2026-07-10T00:00:00.000Z",
    attachments,
  };
}

async function renderCountedMessage(message: Message) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({ current: null, members: [] });
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const counter = createRenderCounter();
  const view = render(
    <MemoryRouter>
      <counter.Count id="message-row">
        <MessageItem message={message} mentionMap={new Map()} channels={[]} hideThreadActions />
      </counter.Count>
    </MemoryRouter>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  return { ...view, commits: counter.get("message-row") };
}

afterEach(() => {
  resetInlineAttachmentUrlCache();
  cleanup();
  api.get = originalGet;
});

test("attachment-free MessageItem settles after one commit", async () => {
  assert.equal((await renderCountedMessage(makeMessage())).commits, 1);
});

test("MessageItem with an existing image thumbnail settles after one commit", async () => {
  assert.equal((await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: "/thumbnail.png",
    rasterPreviewUrl: null,
  }]))).commits, 1);
});

test("MessageItem still loads an inline fallback when an image has no thumbnail", async () => {
  const requestedUrls: string[] = [];
  api.post = (async (url: string, body: { attachmentIds: string[] }) => {
    assert.equal(url, "/attachments/urls");
    requestedUrls.push(...body.attachmentIds);
    return { data: { urls: body.attachmentIds.map((id) => ({ id, url: "/inline.png", expiresAt: null })) } };
  }) as unknown as typeof api.post;
  api.get = (async (url: string) => {
    requestedUrls.push(url);
    return { data: { url: "/inline.png", expiresAt: null } };
  }) as typeof api.get;

  const { container } = await renderCountedMessage(makeMessage([{
    id: "image-1",
    filename: "image.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    localPreviewUrl: null,
    thumbnailUrl: null,
    rasterPreviewUrl: null,
  }]));

  await waitFor(() => {
    assert.equal(container.querySelector("img[alt='image.png']")?.getAttribute("src"), "/inline.png");
  });
  // One batch call carrying the single image id, not a per-image GET.
  assert.deepEqual(requestedUrls, ["image-1"]);
});
