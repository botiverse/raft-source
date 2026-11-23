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

// #triage:#501 (Hands fff23b48): text written into the box without an input
// event (a dictation tool, an input method) after the last sync. Send must take
// what the box shows and leave it empty; before, it sent the stale `content`,
// then the clear adopted the whole box back (the sent text included), and that
// rode along with the next message.

const CHANNEL_ID = "channel-bypassed-send";
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


function writeWithoutEvent(textarea: HTMLTextAreaElement, text: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  setValue.call(textarea, text);
}

function recordingSend(sent: string[]) {
  return async (channelId: string, content: string, _a?: string[], _t?: boolean, _o?: string, randomId?: string): Promise<SendMessageResult> => {
    sent.push(content);
    useMessageStore.getState().addMessage({
      id: `server-message-${sent.length}`,
      channelId,
      randomId,
      seq: sent.length,
      senderType: "user",
      senderId: "user-1",
      senderName: "User",
      messageType: "chat",
      content,
      createdAt: new Date().toISOString(),
    } as Message);
    return { messageId: `server-message-${sent.length}`, pendingMentionActions: [], unresolvedMentionHandles: [], deliveryWarnings: [] } as SendMessageResult;
  };
}

test("text written into the box without an input event is sent with the typed text, and the box ends empty", async () => {
  const sent: string[] = [];
  const { textarea, form } = setupComposer(recordingSend(sent) as never);

  await act(async () => {
    writeWithoutEvent(textarea, "srv trash");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  writeWithoutEvent(textarea, "srv trash\n\nolder dictation");
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });

  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0], "srv trash\n\nolder dictation");
  assert.equal(textarea.value, "");
  assert.equal(useMessageStore.getState().drafts[CHANNEL_ID] ?? "", "");
});

test("after such a send the next message carries nothing of the previous one", async () => {
  const sent: string[] = [];
  const { textarea, form } = setupComposer(recordingSend(sent) as never);

  await act(async () => {
    writeWithoutEvent(textarea, "first");
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  writeWithoutEvent(textarea, "first\n\ntail");
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal(sent[0], "first\n\ntail");
  // The user types after whatever the box holds now (as in 50af91ff: the tail, then the new words).
  await typeAndSubmit(textarea, form, `${textarea.value}second`);

  await waitFor(() => assert.equal(sent.length, 2));
  assert.equal(sent[1], "second");
  assert.equal(textarea.value, "");
});
