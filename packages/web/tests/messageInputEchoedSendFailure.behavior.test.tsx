import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";
import { resetUploadCapability, withUploadCapability } from "./helpers/uploadCapability";
import { MessageInput } from "../src/features/composer/MessageInput";
import { clearDraftPendingFilesForTests, clearFailedSendMentionsForTests } from "../src/features/composer/draftPendingFilesCache";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message, SendMessageResult } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

// #triage:#482: POST /v2/messages committed and the socket echo replaced the
// optimistic row, but the HTTP reply was lost. The composer must not offer the
// text back for a duplicate resend.

const CHANNEL_ID = "channel-echoed-send";
const originalApiGet = api.get;
const originalConsoleError = console.error;

function setupComposer(sendMessage: (...args: never[]) => Promise<SendMessageResult>) {
  api.get = withUploadCapability((async () => ({ data: { agents: [], humans: [] } })) as typeof api.get);
  useAuthStore.setState({ user: { id: "user-1", name: "user", displayName: "User" } } as never);
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", role: "owner" }, members: [] } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, serverId: "server-1", name: "general", type: "channel", archived: false }],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage,
  } as never);
  rtlRender(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
    { wrapper: TestIntlProvider },
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const form = textarea.closest("form");
  assert.ok(form);
  return { textarea, form };
}

async function typeAndSubmit(textarea: HTMLTextAreaElement, form: HTMLFormElement, text: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
    setValue.call(textarea, text);
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

function channelRows(): Message[] {
  return useMessageStore.getState().channelMessages[CHANNEL_ID] ?? [];
}

afterEach(() => {
  resetUploadCapability();
  cleanup();
  clearDraftPendingFilesForTests();
  clearFailedSendMentionsForTests();
  api.get = originalApiGet;
  console.error = originalConsoleError;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("a send whose echo landed before the reply was lost stays sent: no error, no restored draft, one row", async () => {
  console.error = () => {};
  const send = async (
    channelId: string,
    content: string,
    _attachmentIds?: string[],
    _asTask?: boolean,
    _optimisticId?: string,
    randomId?: string,
  ): Promise<SendMessageResult> => {
    // The socket echo for this randomId replaces the optimistic row...
    useMessageStore.getState().addMessage({
      id: "server-message-1",
      channelId,
      randomId,
      seq: 1,
      senderType: "user",
      senderId: "user-1",
      senderName: "User",
      messageType: "chat",
      content,
      createdAt: new Date().toISOString(),
    } as Message);
    // ...then the HTTP response is lost.
    throw new Error("timeout of 30000ms exceeded");
  };
  const { textarea, form } = setupComposer(send as never);

  await typeAndSubmit(textarea, form, "hello once");

  await waitFor(() => assert.deepEqual(channelRows().map((row) => row.id), ["server-message-1"]));
  assert.equal(textarea.value, "");
  assert.equal(useMessageStore.getState().drafts[CHANNEL_ID] ?? "", "");
  assert.ok(screen.queryByText("Failed to send message") === null);
});

test("a plain send failure with no echo still removes the row, restores the draft and errors", async () => {
  console.error = () => {};
  const send = async (): Promise<SendMessageResult> => {
    throw new Error("network down");
  };
  const { textarea, form } = setupComposer(send as never);

  await typeAndSubmit(textarea, form, "hello retry");

  await waitFor(() => assert.ok(screen.queryByText("Failed to send message") !== null));
  assert.equal(textarea.value, "hello retry");
  assert.deepEqual(channelRows(), []);
});
