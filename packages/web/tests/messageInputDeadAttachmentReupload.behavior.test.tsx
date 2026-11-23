import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { createIntl } from "react-intl";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import { resetUploadCapability, withUploadCapability } from "./helpers/uploadCapability";
import api from "../src/api/client";
import { mergedMessages } from "../src/i18n/messages";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
import { MessageInput } from "../src/features/composer/MessageInput";
import { markDeadAttachmentsForReupload } from "../src/features/composer/deadAttachmentSend";
import type { PendingFile } from "../src/features/composer/composerTypes";
import { clearDraftPendingFilesForTests, clearFailedSendMentionsForTests } from "../src/features/composer/draftPendingFilesCache";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { SendMessageResult } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
const fmt = createIntl({ locale: DEFAULT_LOCALE, messages: mergedMessages(DEFAULT_LOCALE) }).formatMessage;
const CHANNEL_ID = "channel-dead-attachment";
const NEEDS_REUPLOAD = "This file needs to be uploaded again.";
const COMPOSER_REUPLOAD = "An attachment is no longer available. Upload it again or remove it, then send.";
const originalApiGet = api.get;
const originalApiPost = api.post;
const originalConsoleError = console.error;

afterEach(() => {
  resetUploadCapability();
  cleanup();
  clearDraftPendingFilesForTests();
  clearFailedSendMentionsForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  console.error = originalConsoleError;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

function makeSendSpy() {
  const calls: Array<{ content: string; attachmentIds: string[] }> = [];
  const rejections: unknown[] = [];
  const send = async (_channelId: string, content: string, attachmentIds: string[] = []): Promise<SendMessageResult> => {
    calls.push({ content, attachmentIds });
    const rejection = rejections.shift();
    if (rejection !== undefined) throw rejection;
    return { messageId: `message-${calls.length}`, pendingMentionActions: [], unresolvedMentionHandles: [], deliveryWarnings: [] };
  };
  return Object.assign(send, { calls, rejections });
}

function setupComposer(sendMessage: ReturnType<typeof makeSendSpy>) {
  let uploads = 0;
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      uploads += 1;
      return { data: { attachments: [{ id: `attachment-${uploads}` }] } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  api.get = withUploadCapability((async () => ({ data: { agents: [], humans: [] } })) as typeof api.get);
  useAuthStore.setState({ user: { id: "user-1", email: "user@example.com", name: "user", displayName: "User" } } as never);
  useServerStore.setState({
    current: { id: "server-1", name: "Server", slug: "server", ownerId: "user-1", plan: "free", role: "owner" },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, serverId: "server-1", name: "general", type: "channel", archived: false, archivedAt: null }],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage,
  } as never);
  const view = render(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  return { textarea, form, fileInput, uploadCount: () => uploads };
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

async function attachAndSend(names: string[], sendMessage: ReturnType<typeof makeSendSpy>) {
  console.error = () => {};
  const composer = setupComposer(sendMessage);
  fireEvent.change(composer.textarea, { target: { value: "with file" } });
  fireEvent.change(composer.fileInput, {
    target: { files: names.map((name) => new File([name], name, { type: "text/plain" })) },
  });
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled, false));
  await submitForm(composer.form);
  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  return composer;
}

test("a dead attachment id comes back as a failed upload that blocks send until it is re-uploaded", async () => {
  const sendMessage = makeSendSpy();
  sendMessage.rejections.push({ response: { status: 410, data: { code: "attachment_expired", error: "raw expired text" } } });
  const composer = await attachAndSend(["retry.txt"], sendMessage);
  assert.deepEqual(sendMessage.calls[0]!.attachmentIds, ["attachment-1"]);

  const banner = (await screen.findByText(NEEDS_REUPLOAD)).closest('[role="alert"]') as HTMLElement;
  assert.ok(within(banner).getByText("retry.txt"));
  assert.ok(screen.getByText(COMPOSER_REUPLOAD));
  assert.ok(screen.queryByText("raw expired text") === null);
  assert.equal(composer.textarea.value, "with file");
  const blocked = screen.getByRole("button", { name: "Retry or remove failed attachments" }) as HTMLButtonElement;
  assert.equal(blocked.disabled, true);
  await submitForm(composer.form);
  assert.equal(sendMessage.calls.length, 1);

  fireEvent.click(within(banner).getByRole("button", { name: "Retry uploading retry.txt" }));
  await waitFor(() => assert.ok(screen.queryByText(NEEDS_REUPLOAD) === null));
  assert.equal(screen.queryByText(COMPOSER_REUPLOAD) === null, true, "retrying answers the composer error");
  assert.equal(composer.uploadCount(), 2);
  await waitFor(() => assert.equal((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled, false));
  await submitForm(composer.form);
  await waitFor(() => assert.equal(sendMessage.calls.length, 2));
  assert.deepEqual(sendMessage.calls[1]!.attachmentIds, ["attachment-2"]);
});

test("a dead-id error that names one attachment marks only that file", async () => {
  const sendMessage = makeSendSpy();
  sendMessage.rejections.push({
    response: { status: 400, data: { code: "attachment_already_linked", error: "Attachment attachment-2 is already attached to another message." } },
  });
  await attachAndSend(["one.txt", "two.txt"], sendMessage);
  await waitFor(() => assert.equal(screen.getAllByText(NEEDS_REUPLOAD).length, 1));
  const banner = screen.getByText(NEEDS_REUPLOAD).closest('[role="alert"]') as HTMLElement;
  assert.ok(within(banner).getByText("two.txt"));
  assert.ok(screen.getByText("one.txt"));
});

test("other send errors keep the restored attachments sendable and show the server text", async () => {
  const sendMessage = makeSendSpy();
  sendMessage.rejections.push({ response: { status: 409, data: { code: "attachment_replay_conflict", error: "raw conflict text" } } });
  await attachAndSend(["keep.txt"], sendMessage);
  await waitFor(() => assert.ok(screen.getByText("raw conflict text")));
  assert.ok(screen.getByText("keep.txt"));
  assert.ok(screen.queryByText(NEEDS_REUPLOAD) === null);
  assert.ok(screen.queryByText(COMPOSER_REUPLOAD) === null);
  assert.equal((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled, false);
});

test("markDeadAttachmentsForReupload gives a fresh upload identity and no Retry without a blob", () => {
  const base = {
    preview: null,
    uploadStatus: "ready" as const,
    uploadProgress: 100,
    uploadClientRequestId: "old-request",
    directUploadSession: { uploadId: "old-session" },
  };
  const files = [
    { ...base, id: "with-blob", file: new File(["a"], "a.txt"), attachmentId: "att-a" },
    { ...base, id: "no-blob", file: { name: "b.txt" } as unknown as File, attachmentId: "att-b" },
    { ...base, id: "no-id", file: new File(["c"], "c.txt"), uploadStatus: "queued" as const, attachmentId: undefined },
  ] as PendingFile[];
  const marked = markDeadAttachmentsForReupload(files, { code: "attachment_not_found", error: "One or more attachments are no longer stored." }, fmt);
  assert.equal(marked[0]!.uploadStatus, "error");
  assert.equal(marked[0]!.uploadCanRetry, true);
  assert.equal(marked[0]!.attachmentId, undefined);
  assert.equal(marked[0]!.directUploadSession, undefined);
  assert.notEqual(marked[0]!.uploadClientRequestId, "old-request");
  assert.equal(marked[0]!.uploadError, NEEDS_REUPLOAD);
  assert.equal(marked[1]!.uploadCanRetry, false);
  assert.equal(marked[2], files[2]);
  assert.equal(markDeadAttachmentsForReupload(files, { code: "peer_not_member", error: "x" }, fmt), files);
});
