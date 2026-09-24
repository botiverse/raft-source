import "global-jsdom/register";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// oxlint-disable-next-line no-restricted-imports -- Whole-module React shim for classic-runtime test dependencies.
import * as React from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import type { Agent } from "../src/store/agentStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
const { default: api } = await import("../src/api/client");
const { default: ImageLightbox } = await import("../src/components/ImageLightbox");
const { default: MessageItem } = await import("../src/components/message/MessageItem");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useImageLightboxStore } = await import("../src/store/imageLightboxStore");
const { useMessageStore } = await import("../src/store/messageStore");
const { useSavedStore } = await import("../src/store/savedStore");
const { useServerStore } = await import("../src/store/serverStore");
const originalApiGet = api.get;

function setupStores() {
  useAuthStore.setState({
    user: {
      id: "svg-preview-user",
      email: "svg@example.com",
      gravatarHash: "",
      name: "svg-user",
      displayName: "SVG User",
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
      id: "svg-preview-server",
      name: "Server",
      slug: "server",
      ownerId: "svg-preview-user",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-08-06T00:00:00.000Z",
    },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: "svg-preview-thread",
      serverId: "svg-preview-server",
      name: "thread",
      type: "thread",
      description: null,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      isDefault: false,
      createdAt: "2026-08-06T00:00:00.000Z",
    }],
    dmChannels: [],
  } as never);
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });
  useMessageStore.setState({
    drafts: {},
    channelMessages: { "svg-preview-thread": [] },
    currentChannelId: "svg-preview-thread",
    messages: [],
  } as never);
  useImageLightboxStore.setState(useImageLightboxStore.getInitialState(), true);
}

function makeSvgMessage(): Message {
  return {
    id: "svg-preview-message",
    channelId: "svg-preview-thread",
    senderType: "user",
    senderId: "svg-preview-user",
    senderName: "SVG User",
    messageType: "chat",
    content: "brand asset",
    createdAt: "2026-08-06T00:00:00.000Z",
    attachments: [{
      id: "svg-preview-attachment",
      filename: "logomark.svg",
      mimeType: "image/svg+xml",
      sizeBytes: 2048,
      width: 120,
      height: 120,
      thumbnailUrl: "https://cdn.example.test/thumbs/logomark.webp",
      // Refreshed message rows intentionally carry only the safe raster
      // thumbnail; the larger raster URL belongs to the upload response.
      rasterPreviewUrl: null,
    }],
  };
}

function makeHeicMessage(): Message {
  return {
    ...makeSvgMessage(),
    id: "heic-preview-message",
    content: "camera photo",
    attachments: [{
      id: "heic-preview-attachment",
      filename: "camera-photo.heic",
      mimeType: "image/heic",
      sizeBytes: 4096,
      width: 32,
      height: 32,
      thumbnailUrl: "https://cdn.example.test/thumbs/camera-photo.webp",
      rasterPreviewUrl: null,
    }],
  };
}

afterEach(() => {
  cleanup();
  api.get = originalApiGet;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useSavedStore.setState(useSavedStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useImageLightboxStore.setState(useImageLightboxStore.getInitialState(), true);
});

test("a refreshed thread SVG renders inline and opens only its safe raster thumbnail", async () => {
  setupStores();
  const getUrls: string[] = [];
  api.get = (async (url: string) => {
    getUrls.push(url);
    throw new Error(`unexpected raw attachment request: ${url}`);
  }) as typeof api.get;

  render(
    <MemoryRouter>
      <MessageItem
        message={makeSvgMessage()}
        mentionMap={new Map()}
        channels={[] as Channel[]}
        hideThreadActions
      />
      <ImageLightbox />
    </MemoryRouter>,
  );

  const inlineImage = await screen.findByRole("img", { name: "logomark.svg" });
  assert.equal(inlineImage.getAttribute("src"), "https://cdn.example.test/thumbs/logomark.webp");
  assert.equal(screen.queryByText("image/svg+xml"), null, "the SVG must not degrade to a file card");

  fireEvent.click(screen.getByRole("button", { name: "Preview logomark.svg" }));
  const lightboxImage = await screen.findByTestId("image-lightbox-image");
  await waitFor(() => {
    assert.equal(lightboxImage.getAttribute("src"), "https://cdn.example.test/thumbs/logomark.webp");
  });
  assert.deepEqual(getUrls, [], "opening the SVG must not request its raw attachment URL");
});

test("a HEIC attachment opens its compatible thumbnail instead of the raw file", async () => {
  setupStores();
  const getUrls: string[] = [];
  api.get = (async (url: string) => {
    getUrls.push(url);
    throw new Error(`unexpected raw attachment request: ${url}`);
  }) as typeof api.get;

  render(
    <MemoryRouter>
      <MessageItem
        message={makeHeicMessage()}
        mentionMap={new Map()}
        channels={[] as Channel[]}
        hideThreadActions
      />
      <ImageLightbox />
    </MemoryRouter>,
  );

  const inlineImage = await screen.findByRole("img", { name: "camera-photo.heic" });
  assert.equal(inlineImage.getAttribute("src"), "https://cdn.example.test/thumbs/camera-photo.webp");

  fireEvent.click(screen.getByRole("button", { name: "Preview camera-photo.heic" }));
  const lightboxImage = await screen.findByTestId("image-lightbox-image");
  await waitFor(() => {
    assert.equal(lightboxImage.getAttribute("src"), "https://cdn.example.test/thumbs/camera-photo.webp");
  });
  assert.deepEqual(getUrls, [], "opening HEIC must not request a raw URL browsers cannot reliably decode");
});
