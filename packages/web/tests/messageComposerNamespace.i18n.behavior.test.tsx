import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import "./helpers/domSetup";
import { act } from "react";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { createIntl } from "react-intl";
import { renderWithIntl } from "./helpers/intl";
import MessageInput, { formatMentionActionStatusNotice } from "../src/components/message/MessageInput";
import { formatMessageAttachmentLimitError } from "../src/utils/messageAttachmentLimits";
import { mergedMessages } from "../src/i18n/messages";
import api from "../src/api/client";
import { resetUploadCapability, withUploadCapability } from "./helpers/uploadCapability";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";

// Behavior gate for the message.composer + message.mentionActionNotice migration
// (MessageInput, B1). Rendered under zh-cn, assert @AngLee-final Chinese composer
// chrome reaches the DOM with no pre-migration English leak, and that the
// mention-action status policy resolves through the zh catalog.

const CHANNEL_ID = "channel-i18n-composer";
const originalGet = api.get;
const originalPost = api.post;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

afterEach(() => {
  resetUploadCapability();
  cleanup();
  api.get = originalGet;
  api.post = originalPost;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  window.history.pushState({}, "", "/");
});

function seedComposerStores() {
  api.get = withUploadCapability((async () => ({ data: { agents: [], humans: [] } })) as typeof api.get);
  useAuthStore.setState({ user: { id: "me" } } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage: async () => ({}),
  } as never);
}

function renderComposerZh() {
  seedComposerStores();
  const view = renderWithIntl(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );
  return view;
}

test("MessageInput renders zh-cn composer chrome (placeholder ICU)", () => {
  api.get = withUploadCapability((async () => ({ data: { agents: [], humans: [] } })) as typeof api.get);
  useAuthStore.setState({ user: { id: "me" } } as never);
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage: async () => ({}),
  } as never);

  renderWithIntl(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
    { locale: "zh-cn" },
  );

  // messagePlaceholder is an ICU `发送消息至 {channel}` — the channel name splices in.
  assert.ok(screen.getByPlaceholderText("发送消息至 #general"), "composer placeholder renders zh");
  const body = document.body.textContent ?? "";
  assert.doesNotMatch(body, /Message #general/, "placeholder must not leak the English composer copy");
});

test("formatMentionActionStatusNotice resolves through the zh-cn catalog", () => {
  const zh = createIntl({ locale: "zh-cn", messages: mergedMessages("zh-cn") }).formatMessage;
  assert.equal(formatMentionActionStatusNotice(undefined, zh), "此提及操作已不可用。");
  assert.equal(formatMentionActionStatusNotice({ status: "expired" } as never, zh), "此提及操作已过期。");
  assert.equal(
    formatMentionActionStatusNotice({ status: "dropped", reason: "delivery_unavailable" } as never, zh),
    "通知未送达，投递暂时不可用。请重试。",
  );
});

test("attachment-limit error resolves through the zh-cn catalog", () => {
  const zh = createIntl({ locale: "zh-cn", messages: mergedMessages("zh-cn") }).formatMessage;
  // attachment-limit error (util formatMessageAttachmentLimitError, 3 joined parts) under zh.
  const err = formatMessageAttachmentLimitError(
    {
      rejectedForCount: [{ size: 1 }, { size: 1 }],
      rejectedForEmpty: [{ size: 0 }],
      rejectedForSize: [{ size: 60 * 1024 * 1024 }],
    },
    zh,
    50 * 1024 * 1024,
  );
  assert.match(err, /每条消息最多 10 个附件。已跳过 2 个多余文件。/);
  assert.match(err, /已跳过 1 个空文件。/);
  assert.match(err, /每个文件最大 50MB。当前最大文件为 60\.0MB。/);
  assert.doesNotMatch(err, /attachments per message|extra file|empty file|per file/i);
});

// Real-DOM attachment aria/label teeth: render MessageInput under zh-cn, add a
// real attachment, and assert the CHIP's aria-labels / mime fallback resolve zh
// (reverting the SortableAttachment wiring to English makes these RED — a
// catalog-only assertion would be a false green, @铁根).
test("ready image attachment chip renders zh preview + remove aria-labels", async () => {
  URL.createObjectURL = (() => "blob:zh-ready") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") return { data: { attachments: [{ id: "att-ready" }] } };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  const view = renderComposerZh();
  const imageInput = view.container.querySelector('input[type="file"][accept]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(imageInput, { target: { files: [new File(["img"], "photo.png", { type: "image/png" })] } });
  });

  assert.ok(await screen.findByRole("button", { name: "移除 photo.png" }), "remove aria renders zh");
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "预览 photo.png" }), "preview aria renders zh once ready"));
  assert.equal(screen.queryByRole("button", { name: "Remove photo.png" }), null, "no English remove aria");
  assert.equal(screen.queryByRole("button", { name: "Preview photo.png" }), null, "no English preview aria");
});

test("failed image upload chip renders the zh retry aria-label", async () => {
  URL.createObjectURL = (() => "blob:zh-fail") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") throw new Error("upload failed");
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  const view = renderComposerZh();
  const imageInput = view.container.querySelector('input[type="file"][accept]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(imageInput, { target: { files: [new File(["img"], "broken.png", { type: "image/png" })] } });
  });

  assert.ok(await screen.findByRole("button", { name: "重试上传 broken.png" }), "retry aria renders zh");
  assert.equal(screen.queryByRole("button", { name: "Retry uploading broken.png" }), null, "no English retry aria");
});

test("non-image attachment chip shows the zh no-MIME fallback label", async () => {
  URL.createObjectURL = (() => "blob:zh-file") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") return { data: { attachments: [{ id: "att-file" }] } };
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  const view = renderComposerZh();
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [new File(["data"], "notes", { type: "" })] } });
  });

  assert.ok(await screen.findByText("文件"), "no-MIME chip renders the zh fallback label");
  assert.ok(await screen.findByRole("button", { name: "移除 notes" }), "remove aria renders zh");
});
