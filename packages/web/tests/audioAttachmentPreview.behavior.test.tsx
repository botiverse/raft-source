import assert from "node:assert/strict";
import { resetAttachmentPreviewSummaryCache } from "../src/components/message/attachmentPreviewSummaryCache";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message, MessageAttachment } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import type { Locale } from "../src/i18n/locale";

class MemoryStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string) {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.map.set(key, value);
  }

  removeItem(key: string) {
    this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

function installBrowserStubs() {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  class ImmediateIntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds = [0];

    constructor(private readonly callback: IntersectionObserverCallback) {}

    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }

    disconnect() {}
    unobserve() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  Object.defineProperty(window, "IntersectionObserver", {
    value: ImmediateIntersectionObserver,
    configurable: true,
  });
  Object.defineProperty(globalThis, "IntersectionObserver", {
    value: ImmediateIntersectionObserver,
    configurable: true,
  });
}

function makeUser(): User {
  return {
    id: "user-1",
    email: "current@example.com",
    gravatarHash: "currenthash",
    name: "current",
    displayName: "Current User",
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
  };
}

function makeServer(): Server {
  return {
    id: "server-1",
    name: "Server",
    slug: "server",
    ownerId: "user-1",
    onboardingAgentId: null,
    hideHumansFromMembers: false,
    plan: "free",
    planDowngradedAt: null,
    role: "member",
    createdAt: "2026-07-04T00:00:00.000Z",
  };
}

function makeAudioAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: "audio-1",
    filename: "voice.mp3",
    mimeType: "application/octet-stream",
    sizeBytes: 4096,
    ...overrides,
  };
}

function makeMessage(attachment: MessageAttachment): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "audio attachment",
    createdAt: "2026-07-04T00:00:00.000Z",
    attachments: [attachment],
  };
}

async function renderMessage(message: Message, locale?: Locale) {
  installBrowserStubs();
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { default: DocumentPreviewHost } = await import("../src/components/message/DocumentPreviewHost");
  const { default: MediaPreviewHost } = await import("../src/components/message/MediaPreviewHost");
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
  useServerStore.setState({ current: makeServer(), members: [] as ServerMember[] });
  useAgentStore.setState({ agents: [] as Agent[], agentActivities: {} });
  useChannelStore.setState({ dmChannels: [] as Channel[] });
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false });

  const tree = (
    <MemoryRouter>
      <MessageItem message={message} mentionMap={new Map()} channels={[]} hideThreadActions />
      {/* Preview modals are mounted app-level (see App.tsx), so a message-only
          render would never show them. */}
      <DocumentPreviewHost />
      <MediaPreviewHost />
    </MemoryRouter>
  );
  const view = locale
    ? rtlRender(<TestIntlProvider locale={locale}>{tree}</TestIntlProvider>)
    : render(tree);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const row = view.container.querySelector<HTMLElement>("#message-message-1");
  assert.ok(row);
  return { ...view, row };
}

afterEach(() => {
  resetAttachmentPreviewSummaryCache();
  cleanup();
});

test("audio attachments render a custom inline audio player", async () => {
  const { default: api } = await import("../src/api/client");
  const originalGet = api.get;
  const urls: string[] = [];
  const clickedDownloads: string[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  let playCalls = 0;
  let pauseCalls = 0;

  HTMLAnchorElement.prototype.click = function click() {
    clickedDownloads.push(this.href);
  };
  HTMLMediaElement.prototype.play = function play() {
    playCalls += 1;
    return Promise.resolve();
  };
  HTMLMediaElement.prototype.pause = function pause() {
    pauseCalls += 1;
  };
  api.get = (async (url: string) => {
    urls.push(url);
    if (url === "/channels/channel-1/members") {
      return { data: { agents: [], humans: [] } };
    }
    if (url === "/attachments/audio-1/url?disposition=inline") {
      return { data: { url: "https://cdn.example.test/voice-inline.mp3" } };
    }
    if (url === "/attachments/audio-1/url?disposition=attachment") {
      return { data: { url: "https://cdn.example.test/voice-download.mp3" } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  try {
    const { row } = await renderMessage(makeMessage(makeAudioAttachment()));
    assert.equal(row.querySelectorAll("[data-message-affordance='inline-audio-preview']").length, 1);
    await waitFor(() => {
      assert.equal(row.querySelectorAll("[data-message-affordance='inline-audio-player']").length, 1);
      assert.equal(row.querySelectorAll("[data-message-affordance='audio-play-toggle']").length, 1);
      assert.equal(row.querySelectorAll("[data-message-affordance='audio-seek']").length, 1);
      assert.equal(row.querySelectorAll("[data-message-affordance='audio-volume-control']").length, 1);
      assert.equal(row.querySelectorAll("[data-message-affordance='audio-volume']").length, 1);
      assert.equal(row.querySelectorAll("[data-message-affordance='audio-preview']").length, 0);
      assert.equal(row.querySelectorAll("[data-message-affordance='audio-download']").length, 1);
      assert.ok(row.querySelector("audio[title='Audio preview: voice.mp3']"));
    });
    assert.equal(row.querySelector("button[aria-label='voice.mp3']"), null);
    assert.match(row.textContent ?? "", /Audio file/);
    const audio = row.querySelector("audio[title='Audio preview: voice.mp3']") as HTMLAudioElement;
    assert.equal(audio.tagName, "AUDIO");
    assert.equal(audio.getAttribute("controls"), null);
    assert.equal(audio.getAttribute("preload"), "metadata");
    assert.equal(audio.getAttribute("src"), "https://cdn.example.test/voice-inline.mp3");
    assert.match(audio.className, /hidden/);
    assert.deepEqual(urls.filter((url) => url.includes("/attachments/audio-1/url")), [
      "/attachments/audio-1/url?disposition=inline",
    ]);

    Object.defineProperty(audio, "duration", { configurable: true, value: 65 });
    audio.currentTime = 12;
    fireEvent.loadedMetadata(audio);
    fireEvent.timeUpdate(audio);
    assert.match(row.textContent ?? "", /0:12 \/ 1:05/);

    fireEvent.click(screen.getByLabelText("Play audio voice.mp3"));
    assert.equal(playCalls, 1);
    assert.ok(screen.getByLabelText("Pause audio voice.mp3"));

    fireEvent.click(screen.getByLabelText("Pause audio voice.mp3"));
    assert.equal(pauseCalls, 1);
    assert.ok(screen.getByLabelText("Play audio voice.mp3"));

    fireEvent.change(row.querySelector("[data-message-affordance='audio-seek']") as HTMLInputElement, { target: { value: "30" } });
    assert.equal(audio.currentTime, 30);
    assert.match(row.textContent ?? "", /0:30 \/ 1:05/);

    fireEvent.change(row.querySelector("[data-message-affordance='audio-volume']") as HTMLInputElement, { target: { value: "0.35" } });
    assert.equal(audio.volume, 0.35);

    fireEvent.click(screen.getByLabelText("Download voice.mp3"));
    await waitFor(() => assert.deepEqual(urls.filter((url) => url.includes("/attachments/audio-1/url")), [
      "/attachments/audio-1/url?disposition=inline",
      "/attachments/audio-1/url?disposition=attachment",
    ]));
    assert.deepEqual(clickedDownloads, ["https://cdn.example.test/voice-download.mp3"]);
    assert.equal(screen.queryByRole("button", { name: "Close" }), null);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    HTMLMediaElement.prototype.play = originalPlay;
    HTMLMediaElement.prototype.pause = originalPause;
    api.get = originalGet;
  }
});

test("audio download button downloads without opening a preview modal", async () => {
  const { default: api } = await import("../src/api/client");
  const originalGet = api.get;
  const urls: string[] = [];
  const clickedDownloads: string[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;

  HTMLAnchorElement.prototype.click = function click() {
    clickedDownloads.push(this.href);
  };
  api.get = (async (url: string) => {
    urls.push(url);
    if (url === "/channels/channel-1/members") {
      return { data: { agents: [], humans: [] } };
    }
    if (url === "/attachments/audio-1/url?disposition=inline") {
      return { data: { url: "https://cdn.example.test/voice-inline.mp3" } };
    }
    if (url === "/attachments/audio-1/url?disposition=attachment") {
      return { data: { url: "https://cdn.example.test/voice-download.mp3" } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  try {
    const { row } = await renderMessage(makeMessage(makeAudioAttachment()));
    await waitFor(() => assert.ok(row.querySelector("audio[title='Audio preview: voice.mp3']")));

    fireEvent.click(screen.getByLabelText("Download voice.mp3"));

    await waitFor(() => assert.deepEqual(urls.filter((url) => url.includes("/attachments/audio-1/url")), [
      "/attachments/audio-1/url?disposition=inline",
      "/attachments/audio-1/url?disposition=attachment",
    ]));
    assert.deepEqual(clickedDownloads, ["https://cdn.example.test/voice-download.mp3"]);
    assert.equal(screen.queryByRole("button", { name: "Close" }), null);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    api.get = originalGet;
  }
});

test("failed inline audio URL exposes a download fallback without auto-downloading", async () => {
  const { default: api } = await import("../src/api/client");
  const originalGet = api.get;
  const urls: string[] = [];
  const clickedDownloads: string[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  let rejectInline!: (error: Error) => void;
  const inlineRequest = new Promise<never>((_, reject) => {
    rejectInline = reject;
  });

  HTMLAnchorElement.prototype.click = function click() {
    clickedDownloads.push(this.href);
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };
  api.get = ((url: string) => {
    urls.push(url);
    if (url === "/channels/channel-1/members") {
      return Promise.resolve({ data: { agents: [], humans: [] } });
    }
    if (url === "/attachments/audio-1/url?disposition=inline") {
      return inlineRequest;
    }
    if (url === "/attachments/audio-1/url?disposition=attachment") {
      return Promise.resolve({ data: { url: "https://cdn.example.test/voice-download.mp3" } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  }) as typeof api.get;

  try {
    const { row } = await renderMessage(makeMessage(makeAudioAttachment()));
    await waitFor(() => assert.match(row.textContent ?? "", /Loading voice\.mp3/));

    rejectInline(new Error("signed URL failed"));

    await waitFor(() => assert.match(row.textContent ?? "", /Download to view/));
    assert.deepEqual(urls.filter((url) => url.includes("/attachments/audio-1/url")), [
      "/attachments/audio-1/url?disposition=inline",
    ]);
    assert.equal(consoleErrors.length, 1);
    assert.match(String(consoleErrors[0]?.[0] ?? ""), /Failed to load inline audio attachment URL/);
    assert.deepEqual(clickedDownloads, []);
    assert.equal(screen.queryByTitle("Audio preview: voice.mp3"), null);

    fireEvent.click(screen.getByLabelText("Download voice.mp3"));

    await waitFor(() => assert.deepEqual(urls.filter((url) => url.includes("/attachments/audio-1/url")), [
      "/attachments/audio-1/url?disposition=inline",
      "/attachments/audio-1/url?disposition=attachment",
    ]));
    assert.deepEqual(clickedDownloads, ["https://cdn.example.test/voice-download.mp3"]);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    console.error = originalConsoleError;
    api.get = originalGet;
  }
});

test("non-preview attachments still use the download card path", async () => {
  const { default: api } = await import("../src/api/client");
  const originalGet = api.get;
  const urls: string[] = [];
  const clickedDownloads: string[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;

  HTMLAnchorElement.prototype.click = function click() {
    clickedDownloads.push(this.href);
  };
  api.get = (async (url: string) => {
    urls.push(url);
    if (url === "/channels/channel-1/members") {
      return { data: { agents: [], humans: [] } };
    }
    if (url === "/attachments/file-1/url?disposition=attachment") {
      return { data: { url: "https://cdn.example.test/archive-download.bin" } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  try {
    const { row } = await renderMessage(makeMessage(makeAudioAttachment({
      id: "file-1",
      filename: "archive.bin",
      mimeType: "application/octet-stream",
    })));
    assert.equal(row.querySelector("[data-message-affordance='audio-preview']"), null);
    assert.ok(row.querySelector("[data-message-affordance='file-download']"));

    fireEvent.click(screen.getByLabelText("archive.bin"));

    await waitFor(() => assert.deepEqual(clickedDownloads, ["https://cdn.example.test/archive-download.bin"]));
    assert.deepEqual(urls.filter((url) => url.includes("/attachments/file-1/url")), [
      "/attachments/file-1/url?disposition=attachment",
    ]);
    assert.equal(screen.queryByTitle("Audio preview: archive.bin"), null);
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
    api.get = originalGet;
  }
});

// --- MI-2 react-intl migration tooth: attachment/preview chrome renders zh
// copy (chip meta label + expanded modal title/label). Reverse-RED: reverting
// any of message.messageItem.audioPreview/audioPreviewTitle/audioFile to English
// fails this. ---
test("i18n: audio attachment preview renders zh chrome", async () => {
  const { default: api } = await import("../src/api/client");
  const originalGet = api.get;
  api.get = (async (url: string) => {
    if (url === "/channels/channel-1/members") return { data: { agents: [], humans: [] } };
    if (url === "/attachments/audio-1/url?disposition=inline") return { data: { url: "https://cdn.example.test/voice-inline.mp3" } };
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  try {
    const { row } = await renderMessage(makeMessage(makeAudioAttachment()), "zh-cn");
    await waitFor(() => assert.ok(row.querySelector("audio[title='音频预览：voice.mp3']")));
    assert.match(row.textContent ?? "", /音频文件/);
    assert.ok(screen.getByLabelText("播放音频 voice.mp3"));
    assert.ok(screen.getByLabelText("调整音频进度 voice.mp3"));
    assert.ok(screen.getByLabelText("调整音频音量 voice.mp3"));

    const download = row.querySelector("[data-message-affordance='audio-download']");
    assert.ok(download, "inline audio card renders the download affordance");
    assert.equal(download.getAttribute("aria-label"), "下载 voice.mp3");
    assert.equal(row.querySelector("[data-message-affordance='audio-preview']"), null);
  } finally {
    api.get = originalGet;
  }
});
