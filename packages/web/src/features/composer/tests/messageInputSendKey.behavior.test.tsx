import assert from "node:assert/strict";
import "../../../../tests/helpers/domSetup";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import api from "../../../api/client";
import { MessageInput } from "../MessageInput";
import { clearDraftPendingFilesForTests, clearFailedSendMentionsForTests } from "../draftPendingFilesCache";
import { composerEnterAction } from "../composerSendKey";
import type { ComposerSendKey } from "../composerSendKey";
import { useAuthStore } from "../../../store/authStore";
import { useChannelStore } from "../../../store/channelStore";
import { useMessageStore } from "../../../store/messageStore";
import type { SendMessageResult } from "../../../store/messageStore";
import { resetServerFeatureFlagsForTests } from "../../../store/serverFeatureFlags";
import { useServerStore } from "../../../store/serverStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";
import { resetUploadCapability, withUploadCapability } from "../../../../tests/helpers/uploadCapability";

// #triage:#210: how the message box sends is the account's choice
// (user.composerSendKey). "enter" (default): Enter sends, Shift+Enter is a new
// line. "mod_enter": ⌘/Ctrl+Enter sends, Enter and Shift+Enter are new lines.
// Every MessageInput reads it (channel, thread, DM, task conversation, the
// assistant's popover, attachment comments, forward); there is no separate
// message-edit composer in the product.

const CHANNEL_ID = "channel-send-key";
const originalApiGet = api.get;
const originalApiPost = api.post;
const originalMatchMedia = window.matchMedia;
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function makeSendSpy() {
  const sent: string[] = [];
  const asTask: Array<boolean | undefined> = [];
  const send = async (_channelId: string, content: string, _attachmentIds: string[] = [], sentAsTask?: boolean): Promise<SendMessageResult> => {
    sent.push(content);
    asTask.push(sentAsTask);
    return { messageId: `message-${sent.length}`, pendingMentionActions: [], unresolvedMentionHandles: [], deliveryWarnings: [] };
  };
  return Object.assign(send, { sent, asTask });
}

async function setupComposer(mode: ComposerSendKey | null, { touchPortrait = false }: { touchPortrait?: boolean } = {}) {
  const sendMessage = makeSendSpy();
  api.get = withUploadCapability((async () => ({ data: { agents: [], humans: [] } })) as typeof api.get);
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      const keys = (body as { keys?: string[] } | undefined)?.keys ?? [];
      return { data: { evaluations: keys.map((key) => ({ key, enabled: false })) } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  // Desktop pointer, or a phone held upright (touch-primary portrait).
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: touchPortrait && query === "(pointer: coarse) and (orientation: portrait)" }),
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  useAuthStore.setState({
    user: { id: "user-1", email: "u@example.com", name: "user-1", displayName: "User 1", composerSendKey: mode },
  } as never);
  useServerStore.setState({
    current: { id: "server-1", name: "Server", slug: "server", ownerId: "user-1", role: "owner", plan: "free" },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [
      { id: CHANNEL_ID, serverId: "server-1", name: "general", type: "channel", archived: false },
      { id: "channel-design", serverId: "server-1", name: "design", type: "channel", archived: false },
    ],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage,
  } as never);
  render(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
    { wrapper: TestIntlProvider },
  );
  await act(async () => {});
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  return { textarea, sendMessage };
}

function type(textarea: HTMLTextAreaElement, value: string) {
  fireEvent.change(textarea, { target: { value, selectionStart: value.length, selectionEnd: value.length } });
  textarea.focus();
}

/** Presses the key; returns whether the browser keeps its default (a newline). */
async function press(textarea: HTMLTextAreaElement, init: Record<string, unknown>) {
  const defaultAllowed = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", ...init });
  await act(async () => {});
  return defaultAllowed;
}

afterEach(() => {
  resetUploadCapability();
  cleanup();
  clearDraftPendingFilesForTests();
  clearFailedSendMentionsForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

for (const mode of [null, "enter"] as const) {
  test(`send key ${mode ?? "unset"} (default): Enter sends, Shift+Enter is a new line, no hint`, async () => {
    const { textarea, sendMessage } = await setupComposer(mode);
    type(textarea, "line one");
    assert.equal(await press(textarea, { shiftKey: true }), true, "Shift+Enter keeps the browser's newline");
    assert.deepEqual(sendMessage.sent, []);
    assert.ok(screen.queryByTestId("composer-send-key-hint") === null);

    assert.equal(await press(textarea, {}), false);
    await waitFor(() => assert.deepEqual(sendMessage.sent, ["line one"]));
  });
}

test("send key mod_enter: Enter and Shift+Enter are new lines; ⌘Enter and Ctrl+Enter send; the hint shows while typing", async () => {
  const { textarea, sendMessage } = await setupComposer("mod_enter");
  assert.ok(screen.queryByTestId("composer-send-key-hint") === null, "no hint on an empty box");
  type(textarea, "first");
  assert.ok(screen.getByTestId("composer-send-key-hint").textContent?.includes("to send"));

  assert.equal(await press(textarea, {}), true, "plain Enter keeps the browser's newline");
  assert.equal(await press(textarea, { shiftKey: true }), true);
  assert.deepEqual(sendMessage.sent, []);
  assert.equal(textarea.value, "first");

  assert.equal(await press(textarea, { metaKey: true }), false);
  await waitFor(() => assert.deepEqual(sendMessage.sent, ["first"]));

  type(textarea, "second");
  assert.equal(await press(textarea, { ctrlKey: true }), false);
  await waitFor(() => assert.deepEqual(sendMessage.sent, ["first", "second"]));
});

for (const mode of ["enter", "mod_enter"] as const) {
  test(`send key ${mode}: an IME composing never sends, whatever the modifiers`, async () => {
    const { textarea, sendMessage } = await setupComposer(mode);
    type(textarea, "ni hao");
    await press(textarea, { isComposing: true });
    await press(textarea, { isComposing: true, metaKey: true });
    await press(textarea, { keyCode: 229 });
    await press(textarea, { keyCode: 229, ctrlKey: true });
    assert.deepEqual(sendMessage.sent, []);
    assert.equal(textarea.value, "ni hao");
  });

  test(`send key ${mode}: with the mention menu open, Enter picks the person and sends nothing`, async () => {
    const { textarea, sendMessage } = await setupComposer(mode);
    await act(async () => { type(textarea, "@user"); });
    await waitFor(() => assert.ok(screen.getByTestId("mention-autocomplete-popover")));
    assert.equal(await press(textarea, {}), false, "the menu takes Enter");
    assert.equal(textarea.value, "@user-1 ");
    assert.deepEqual(sendMessage.sent, []);
  });

  test(`send key ${mode}: with the channel menu open, Enter and Tab pick the channel and send nothing`, async () => {
    const { textarea, sendMessage } = await setupComposer(mode);
    await act(async () => { type(textarea, "#desi"); });
    await waitFor(() => assert.ok(screen.getByText("design")));
    assert.equal(await press(textarea, {}), false);
    assert.equal(textarea.value, "#design ");
    await act(async () => { type(textarea, ""); });
    await act(async () => { type(textarea, "#gen"); });
    await waitFor(() => assert.ok(screen.getByText("general")));
    assert.equal(fireEvent.keyDown(textarea, { key: "Tab", code: "Tab" }), false);
    await act(async () => {});
    assert.equal(textarea.value, "#general ");
    assert.deepEqual(sendMessage.sent, []);
  });
}

test("send key mod_enter: ⌘⇧Enter and Ctrl+Shift+Enter still send as a task where the box offers it", async () => {
  const { textarea, sendMessage } = await setupComposer("mod_enter");
  type(textarea, "task one");
  assert.equal(await press(textarea, { metaKey: true, shiftKey: true }), false);
  await waitFor(() => assert.deepEqual(sendMessage.sent, ["task one"]));
  type(textarea, "task two");
  assert.equal(await press(textarea, { ctrlKey: true, shiftKey: true }), false);
  await waitFor(() => assert.deepEqual(sendMessage.sent, ["task one", "task two"]));
  assert.deepEqual(sendMessage.asTask, [true, true]);
});

test("send key enter on a touch-primary portrait screen: plain Enter is a new line, the Send button sends", async () => {
  const { textarea, sendMessage } = await setupComposer("enter", { touchPortrait: true });
  type(textarea, "from a phone");
  assert.equal(await press(textarea, {}), true, "Enter keeps the browser's newline");
  assert.deepEqual(sendMessage.sent, []);
  assert.equal(textarea.value, "from a phone");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => assert.deepEqual(sendMessage.sent, ["from a phone"]));
});

test("changing the account's send key reaches a mounted composer at once", async () => {
  const { textarea, sendMessage } = await setupComposer(null);
  act(() => {
    useAuthStore.setState({ user: { ...useAuthStore.getState().user!, composerSendKey: "mod_enter" } });
  });
  type(textarea, "after switch");
  assert.equal(await press(textarea, {}), true, "Enter is now a newline");
  assert.deepEqual(sendMessage.sent, []);
  assert.equal(await press(textarea, { metaKey: true }), false);
  await waitFor(() => assert.deepEqual(sendMessage.sent, ["after switch"]));
});

test("composerEnterAction: the one decision, in both modes", () => {
  const desk = { touchPortrait: false };
  const phone = { touchPortrait: true };
  const cases: Array<[ComposerSendKey, Record<string, unknown>, { sendAsTask?: boolean; touchPortrait: boolean }, string | null]> = [
    ["enter", {}, desk, "send"],
    ["enter", { metaKey: true }, desk, "send"],
    ["enter", { shiftKey: true }, desk, "newline"],
    ["enter", {}, phone, "newline"],
    ["enter", { metaKey: true, shiftKey: true }, { ...desk, sendAsTask: true }, "sendAsTask"],
    ["enter", { metaKey: true, shiftKey: true }, desk, "newline"],
    ["mod_enter", {}, desk, "newline"],
    ["mod_enter", { shiftKey: true }, desk, "newline"],
    ["mod_enter", { metaKey: true }, desk, "send"],
    ["mod_enter", { ctrlKey: true }, desk, "send"],
    ["mod_enter", { metaKey: true }, phone, "send"],
    ["mod_enter", { ctrlKey: true, shiftKey: true }, { ...desk, sendAsTask: true }, "sendAsTask"],
    ["mod_enter", { isComposing: true, metaKey: true }, desk, null],
    ["enter", { keyCode: 229 }, desk, null],
    ["enter", { nativeEvent: { isComposing: true } }, desk, null],
  ];
  for (const [mode, event, options, expected] of cases) {
    assert.equal(composerEnterAction({ key: "Enter", ...event }, mode, options), expected, `${mode} ${JSON.stringify(event)} ${JSON.stringify(options)}`);
  }
  assert.equal(composerEnterAction({ key: "a" }, "enter"), null);
});
