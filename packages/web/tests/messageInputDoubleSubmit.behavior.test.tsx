import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, startTransition, Suspense, useEffect, useLayoutEffect, useState } from "react";
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { createIntl } from "react-intl";
import { mergedMessages } from "../src/i18n/messages";
import { DEFAULT_LOCALE } from "../src/i18n/locale";
const mentionFmt = createIntl({ locale: DEFAULT_LOCALE, messages: mergedMessages(DEFAULT_LOCALE) }).formatMessage;
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import { resetUploadCapability, withUploadCapability } from "./helpers/uploadCapability";
import MessageInput, {
  clearDraftPendingFilesForTests,
  clearFailedSendMentionsForTests,
  formatMentionActionStatusNotice,
  mergeFailedSendIntoDraft,
  mentionActionSucceeded,
  releaseSubmittedDraftIntent,
} from "../src/components/message/MessageInput";
import type {
  PendingMentionActionExecuteResult,
} from "../src/components/message/MessageInput";
import ChannelMembers from "../src/components/agent/ChannelMembers";
import { subscribeChannelMembersChanged } from "../src/store/channelMemberEvents";
import type { MessageMention } from "../src/components/message/messageMentionTypes";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { SendMessageResult } from "../src/store/messageStore";
import { resetServerFeatureFlagsForTests, setServerFeatureFlagForTests } from "../src/store/serverFeatureFlags";
import { TOPBAR_OVERFLOW_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useServerStore } from "../src/store/serverStore";
import type { ServerMember } from "../src/store/serverStore";

const CHANNEL_ID = "channel-double-submit";

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalScrollIntoView = window.HTMLElement.prototype.scrollIntoView;
const originalConsoleError = console.error;

type ComposerOverrides = Partial<ComponentProps<typeof MessageInput>>;

const neverResolvingSuspense = new Promise<never>(() => {});

function SuspendAfterComposer({ onSuspend }: { onSuspend: () => void }): never {
  onSuspend();
  throw neverResolvingSuspense;
}

const SUSPENDED_THREAD_ID = "thread-b-abandoned-transition";

function AbandonedTransitionComposer({ onSuspend }: { onSuspend: () => void }) {
  const [channelId, setChannelId] = useState(CHANNEL_ID);
  return (
    <>
      <button type="button" onClick={() => startTransition(() => setChannelId(SUSPENDED_THREAD_ID))}>
        Switch in suspended transition
      </button>
      <Suspense fallback={null}>
        <MessageInput
          channelId={channelId}
          channelName={channelId === CHANNEL_ID ? "#general" : "#thread-b"}
        />
        {channelId === SUSPENDED_THREAD_ID ? <SuspendAfterComposer onSuspend={onSuspend} /> : null}
      </Suspense>
    </>
  );
}

function CommitPhaseProbe({
  channelId,
  onLayout,
  onPassive,
}: {
  channelId: string;
  onLayout: (channelId: string) => void;
  onPassive: (channelId: string) => void;
}) {
  useLayoutEffect(() => {
    onLayout(channelId);
  }, [channelId, onLayout]);
  useEffect(() => {
    onPassive(channelId);
  }, [channelId, onPassive]);
  return null;
}

function CommitWindowComposer({
  channelId,
  onLayout,
  onPassive,
}: {
  channelId: string;
  onLayout: (channelId: string) => void;
  onPassive: (channelId: string) => void;
}) {
  return (
    <>
      <MessageInput
        channelId={channelId}
        channelName={channelId === CHANNEL_ID ? "#general" : "#thread-b"}
      />
      <CommitPhaseProbe channelId={channelId} onLayout={onLayout} onPassive={onPassive} />
    </>
  );
}

function ChannelSwitcherComposer() {
  const [channelId, setChannelId] = useState(CHANNEL_ID);
  return (
    <>
      <button type="button" onClick={() => setChannelId((current) => (
        current === CHANNEL_ID ? "thread-b-duplicate-submit" : CHANNEL_ID
      ))}>
        Toggle duplicate-submit thread
      </button>
      <MessageInput
        channelId={channelId}
        channelName={channelId === CHANNEL_ID ? "#general" : "#thread-b"}
      />
    </>
  );
}

function setupComposer(
  sendMessage: ReturnType<typeof makeSendSpy>,
  overrides: ComposerOverrides = {},
  options: {
    members?: ServerMember[];
    renderChannelMembers?: boolean;
    apiGet?: typeof api.get;
    channelType?: "channel" | "dm";
  } = {},
) {
  // The composer will not attach a file until the server ceiling is known.
  api.get = withUploadCapability(
    options.apiGet
      ?? (async () => ({ data: { agents: [], humans: [] } })) as typeof api.get,
  );

  useAuthStore.setState({
    user: {
      id: "user-1",
      email: "user@example.com",
      gravatarHash: "",
      name: "user",
      displayName: "User",
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
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: "user-1",
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-04T00:00:00.000Z",
    },
    members: options.members ?? [],
  } as never);
  const composerChannel = {
      id: CHANNEL_ID,
      serverId: "server-1",
      name: "general",
      type: options.channelType ?? "channel",
      description: null,
      archived: false,
      archivedAt: null,
      archivedBy: null,
      isDefault: false,
      createdAt: "2026-07-04T00:00:00.000Z",
  };
  useChannelStore.setState({
    channels: options.channelType === "dm" ? [] : [composerChannel],
    dmChannels: options.channelType === "dm" ? [composerChannel] : [],
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
      {options.renderChannelMembers ? <ChannelMembers channelId={CHANNEL_ID} /> : null}
      <MessageInput channelId={CHANNEL_ID} channelName="#general" {...overrides} />
    </MemoryRouter>,
  );
  const resolvedChannelName = overrides.channelName ?? "#general";
  const textarea = screen.getByPlaceholderText(`Message ${resolvedChannelName}`) as HTMLTextAreaElement;
  const form = textarea.closest("form");
  assert.ok(form, "composer should render inside a form");
  return { ...view, textarea, form };
}

function makeSendSpy(
  pendingMentionActions: SendMessageResult["pendingMentionActions"] = [],
  unresolvedMentionHandles: SendMessageResult["unresolvedMentionHandles"] = [],
) {
  const calls: Array<{ content: string; attachmentIds: string[] }> = [];
  const details: Array<{
    channelId: string;
    content: string;
    attachmentIds: string[];
    asTask: boolean | undefined;
    optimisticId: string | undefined;
    randomId: string | undefined;
    mentions: MessageMention[] | undefined;
  }> = [];
  const send = async (
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
    asTask?: boolean,
    optimisticId?: string,
    randomId?: string,
    mentions?: MessageMention[],
  ): Promise<SendMessageResult> => {
    calls.push({ content, attachmentIds });
    details.push({ channelId, content, attachmentIds, asTask, optimisticId, randomId, mentions });
    return { messageId: `message-${calls.length}`, pendingMentionActions, unresolvedMentionHandles };
  };
  return Object.assign(send, { calls, details });
}

function makeDeferredSendSpy() {
  const calls: Array<{ content: string; attachmentIds: string[] }> = [];
  const details: Array<{
    channelId: string;
    content: string;
    attachmentIds: string[];
    asTask: boolean | undefined;
    optimisticId: string | undefined;
    randomId: string | undefined;
    mentions: MessageMention[] | undefined;
  }> = [];
  const pendingSends: Array<{
    resolve: (value: SendMessageResult) => void;
    reject: (reason: unknown) => void;
  }> = [];
  const send = async (
    channelId: string,
    content: string,
    attachmentIds: string[] = [],
    asTask?: boolean,
    optimisticId?: string,
    randomId?: string,
    mentions?: MessageMention[],
  ): Promise<SendMessageResult> => {
    calls.push({ content, attachmentIds });
    details.push({ channelId, content, attachmentIds, asTask, optimisticId, randomId, mentions });
    return await new Promise<SendMessageResult>((resolve, reject) => {
      pendingSends.push({ resolve, reject });
    });
  };
  return Object.assign(send, {
    calls,
    details,
    resolveSend: (value: SendMessageResult, index = 0) => pendingSends.splice(index, 1)[0]?.resolve(value),
    rejectSend: (reason: unknown, index = 0) => pendingSends.splice(index, 1)[0]?.reject(reason),
    pendingSends,
  });
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

function assertSendGlyph(button: HTMLButtonElement) {
  assert.equal(button.querySelector('[role="status"]'), null);
  assert.ok(button.querySelector("svg"), "send icon should render for non-loading submit buttons");
}

async function submitTwiceInOneFrame(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  resetUploadCapability();
  cleanup();
  clearDraftPendingFilesForTests();
  clearFailedSendMentionsForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  console.error = originalConsoleError;
  window.HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
  resetServerFeatureFlagsForTests();
});

test("MessageInput override can intentionally submit an empty body only when allowed", async () => {
  const sendMessage = makeSendSpy();
  const overrideCalls: Array<{ content: string; mentions: MessageMention[] }> = [];
  const onSendOverride = async (content: string, mentions: MessageMention[]) => {
    overrideCalls.push({ content, mentions });
  };

  const blocked = setupComposer(sendMessage, { onSendOverride });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  assert.deepEqual(overrideCalls, []);
  assert.deepEqual(sendMessage.calls, []);
  blocked.unmount();

  setupComposer(sendMessage, { onSendOverride, allowEmptySubmit: true });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));

  await waitFor(() => assert.equal(overrideCalls.length, 1));
  assert.deepEqual(overrideCalls[0], { content: "", mentions: [] });
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput keeps blank and whitespace-only drafts blocked", async () => {
  const sendMessage = makeSendSpy();
  const { textarea, form } = setupComposer(sendMessage);

  const emptyButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  assert.equal(emptyButton.disabled, true);
  assert.equal(emptyButton.title, "Send");
  assert.equal(emptyButton.getAttribute("aria-label"), "Send");
  assert.ok(emptyButton.classList.contains("size-7"));
  assert.equal(emptyButton.classList.contains("size-9"), false);
  assertSendGlyph(emptyButton);
  await submitForm(form);
  assert.deepEqual(sendMessage.calls, []);

  fireEvent.change(textarea, { target: { value: "   " } });
  const whitespaceButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  assert.equal(whitespaceButton.disabled, true);
  assert.equal(whitespaceButton.title, "Send");
  assert.equal(whitespaceButton.getAttribute("aria-label"), "Send");
  assertSendGlyph(whitespaceButton);
  await submitForm(form);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput keeps unresolved mention warnings dismissible in channels", async () => {
  const sendMessage = makeSendSpy([], ["@croxx"]);
  const { textarea, form } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "hello @croxx" } });
  await submitForm(form);

  assert.ok(await screen.findByText(
    "Not notified: @croxx. Select a person or agent from the mention picker and try again if needed.",
  ));
  fireEvent.click(screen.getByRole("button", { name: "Dismiss unnotified mention warning" }));

  await waitFor(() => assert.equal(screen.queryByText(/Not notified:/u), null));
  assert.deepEqual(sendMessage.calls, [{ content: "hello @croxx", attachmentIds: [] }]);
});

test("MessageInput clears unresolved mention warnings when the composer switches channel", async () => {
  const sendMessage = makeSendSpy([], ["@croxx"]);
  const { textarea, form, rerender } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "hello @croxx" } });
  await submitForm(form);

  assert.ok(await screen.findByText(
    "Not notified: @croxx. Select a person or agent from the mention picker and try again if needed.",
  ));

  rerender(
    <MemoryRouter>
      <MessageInput channelId="channel-after-unresolved-mention" channelName="#random" />
    </MemoryRouter>,
  );

  await waitFor(() => assert.equal(screen.queryByText(/Not notified:/u), null));
});

test("MessageInput suppresses unresolved mention warnings in DMs without changing send delivery", async () => {
  const sendMessage = makeSendSpy([], ["@croxx"]);
  const { textarea, form } = setupComposer(
    sendMessage,
    { channelName: "@peer" },
    { channelType: "dm" },
  );

  fireEvent.change(textarea, { target: { value: "hello @croxx" } });
  await submitForm(form);

  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  assert.equal(screen.queryByText(/Not notified:/u), null);
  assert.equal(screen.queryByRole("button", { name: "Dismiss unnotified mention warning" }), null);
  assert.deepEqual(sendMessage.details[0], {
    channelId: CHANNEL_ID,
    content: "hello @croxx",
    attachmentIds: [],
    asTask: undefined,
    optimisticId: sendMessage.details[0]?.optimisticId,
    randomId: sendMessage.details[0]?.randomId,
    mentions: [],
  });
});

test("MessageInput allowEmptySubmit does not bypass the default send path without an override", async () => {
  const sendMessage = makeSendSpy();
  const { form } = setupComposer(sendMessage, { allowEmptySubmit: true });

  const button = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Send");
  assert.equal(button.getAttribute("aria-label"), "Send");
  assertSendGlyph(button);
  await submitForm(form);

  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput resolves a lazy thread only at submit and delivers through the durable channel", async () => {
  const sendMessage = makeSendSpy();
  const resolveCalls: string[] = [];
  const resolvedCalls: string[] = [];
  const { textarea, form } = setupComposer(sendMessage, {
    channelId: "pending-thread:parent-1",
    resolveChannelId: async () => {
      resolveCalls.push("resolve");
      return "thread-channel-1";
    },
    onChannelResolved: (channelId) => resolvedCalls.push(channelId),
  });

  assert.deepEqual(resolveCalls, [], "rendering a lazy composer must not create its thread channel");
  fireEvent.change(textarea, { target: { value: "first reply" } });
  assert.deepEqual(resolveCalls, [], "editing a draft must remain local and read-only");

  await submitTwiceInOneFrame(form);

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.deepEqual(resolveCalls, ["resolve"], "same-frame duplicate submit must share one lazy create intent");
  assert.equal(sendMessage.details[0]?.channelId, "thread-channel-1");
  assert.equal(sendMessage.details[0]?.content, "first reply");
  assert.deepEqual(resolvedCalls, ["thread-channel-1"]);
  assert.equal(useMessageStore.getState().channelMessages["pending-thread:parent-1"]?.length ?? 0, 0);
});

test("lazy-thread attachments stay local until submit and share one channel resolution", async () => {
  const sendMessage = makeSendSpy();
  let resolveCount = 0;
  const uploadChannelIds: string[] = [];
  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/attachments/upload");
    assert.ok(body instanceof FormData);
    uploadChannelIds.push(String(body.get("channelId")));
    return { data: { attachments: [{ id: `attachment-${uploadChannelIds.length}` }] } };
  }) as typeof api.post;
  const { container, form } = setupComposer(sendMessage, {
    channelId: "pending-thread:parent-upload",
    resolveChannelId: async () => {
      resolveCount += 1;
      await Promise.resolve();
      return "thread-channel-upload";
    },
  });
  const fileInput = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput);

  fireEvent.change(fileInput, {
    target: {
      files: [
        new File(["one"], "one.txt", { type: "text/plain" }),
        new File(["two"], "two.txt", { type: "text/plain" }),
      ],
    },
  });

  // Attaching is asynchronous now: the composer waits for the server-owned size
  // ceiling before accepting anything, so wait for the chips rather than a
  // single microtask. The property under test is unchanged — picking files must
  // not resolve the thread channel or start an upload.
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove two.txt" })));
  assert.equal(resolveCount, 0, "choosing attachments must not create an empty thread channel");
  assert.deepEqual(uploadChannelIds, []);

  await submitForm(form);
  await waitFor(() => assert.equal(uploadChannelIds.length, 2));
  assert.equal(resolveCount, 1);
  assert.deepEqual(uploadChannelIds, ["thread-channel-upload", "thread-channel-upload"]);
  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.equal(sendMessage.details[0]?.channelId, "thread-channel-upload");
  assert.deepEqual(sendMessage.details[0]?.attachmentIds, ["attachment-1", "attachment-2"]);
});

test("MessageInput media picker exposes videos to the native file chooser", () => {
  const sendMessage = makeSendSpy();
  const { container } = setupComposer(sendMessage);

  const mediaInput = container.querySelector('input[type="file"][accept]') as HTMLInputElement | null;
  assert.ok(mediaInput, "media file input should be present");
  assert.equal(mediaInput.multiple, true);
  assert.match(mediaInput.accept, /(^|,)image\/\*(,|$)/);
  assert.match(mediaInput.accept, /(^|,)video\/\*(,|$)/);

  const mediaButton = screen.getByTitle("Attach media") as HTMLButtonElement;
  assert.equal(mediaButton.type, "button");
});

test("mention action result policy is closed across notify, add, dropped, stale, and missing results", () => {
  const result = (
    action: "notify" | "add",
    status: PendingMentionActionExecuteResult["status"],
    reason?: string,
  ): PendingMentionActionExecuteResult => ({
    resolutionId: "resolution-policy",
    action,
    status,
    reason,
  });

  assert.equal(mentionActionSucceeded("notify", result("notify", "queued")), true);
  assert.equal(mentionActionSucceeded("notify", result("notify", "delivered")), false);
  assert.equal(mentionActionSucceeded("add", result("add", "delivered")), true);
  assert.equal(mentionActionSucceeded("add", result("add", "queued")), false);
  assert.equal(mentionActionSucceeded("add", result("add", "dropped")), false);
  assert.equal(mentionActionSucceeded("notify", undefined), false);
  assert.equal(mentionActionSucceeded("add", undefined), false);

  assert.equal(
    formatMentionActionStatusNotice(undefined, mentionFmt),
    "This mention action is no longer available.",
  );
  assert.equal(
    formatMentionActionStatusNotice(result("notify", "dropped", "delivery_unavailable"), mentionFmt),
    "Notification was not delivered because delivery is temporarily unavailable. Try again.",
  );
  assert.equal(
    formatMentionActionStatusNotice(result("notify", "dropped", "target_not_queued"), mentionFmt),
    "That target was not notified right now. Try again.",
  );
  assert.equal(
    formatMentionActionStatusNotice(result("notify", "stale", "target_unavailable"), mentionFmt),
    "That target is no longer available.",
  );
});

test("MessageInput treats queued notify as success and removes the resolved strip row", async () => {
  const resolutionId = "resolution-queued";
  const sendMessage = makeSendSpy([{
    resolutionId,
    messageId: "message-queued",
    targetType: "agent",
    targetHandle: "Noel",
    targetAvatarUrl: null,
    reason: "not in channel",
    availableActions: ["notify"],
    expiresAt: null,
  }]);
  const { textarea, form } = setupComposer(sendMessage);
  const removalTimers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if ((timeout === 450 || timeout === 750) && typeof handler === "function") {
      removalTimers.push(() => handler(...args));
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  api.post = (async (url: string) => {
    assert.equal(url, "/messages/mention-actions/execute");
    return {
      data: {
        ok: true,
        action: "notify",
        results: [{ resolutionId, action: "notify", status: "queued" }],
      },
    };
  }) as typeof api.post;

  fireEvent.change(textarea, { target: { value: "hello @Noel" } });
  await submitForm(form);
  const strip = await screen.findByTestId("pending-mention-action-strip");
  fireEvent.click(within(strip).getByRole("button", { name: "Notify" }));

  try {
    await waitFor(() => assert.ok(screen.getByText("Queued")));
    assert.equal(removalTimers.length, 2);
    act(() => removalTimers[0]?.());
    assert.match(screen.getByTestId("pending-mention-action-rows").querySelector(":scope > div")?.className ?? "", /opacity-0/);
    act(() => removalTimers[1]?.());
    assert.equal(screen.queryByTestId("pending-mention-action-strip"), null);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("successful mention Add refreshes the sibling channel member count and list without a socket round-trip", async () => {
  setServerFeatureFlagForTests("server-1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, true);
  const resolutionId = "resolution-add-member";
  const sendMessage = makeSendSpy([{
    resolutionId,
    messageId: "message-add-member",
    targetType: "user",
    targetHandle: "added-user",
    targetAvatarUrl: null,
    reason: "not in channel",
    availableActions: ["add"],
    expiresAt: null,
  }]);
  const existingHuman = {
    id: "user-1",
    name: "user",
    displayName: "User",
    description: null,
    avatarUrl: null,
    gravatarHash: "",
    role: "owner",
  };
  const addedHuman = {
    id: "user-added",
    name: "added-user",
    displayName: "Added User",
    description: null,
    avatarUrl: null,
    gravatarHash: "",
    role: "member",
  };
  let membershipAdded = false;
  let memberReads = 0;
  const apiGet = (async (url: string) => {
    assert.equal(url, `/channels/${CHANNEL_ID}/members`);
    memberReads += 1;
    return {
      data: {
        agents: [],
        humans: membershipAdded ? [existingHuman, addedHuman] : [existingHuman],
      },
    };
  }) as typeof api.get;
  const { textarea, form } = setupComposer(
    sendMessage,
    {},
    { apiGet, renderChannelMembers: true },
  );
  const participantsButton = screen.getByTitle("View participants");
  await waitFor(() => assert.equal(participantsButton.textContent?.trim(), "1"));
  assert.equal(participantsButton.tagName, "BUTTON");
  assert.match(participantsButton.className, /\bh-7\b/);
  assert.match(participantsButton.className, /\bmin-w-7\b/);
  assert.match(participantsButton.className, /\bgap-1\b/);
  assert.match(participantsButton.className, /\bpx-1\.5\b/);
  const participantsIcon = participantsButton.querySelector("svg");
  const participantsCount = participantsButton.querySelector("span");
  assert.ok(participantsIcon);
  assert.ok(participantsCount);
  assert.equal(participantsIcon.getAttribute("width"), "14");
  assert.match(participantsIcon.getAttribute("class") ?? "", /\bshrink-0\b/);
  assert.match(participantsCount.className, /(?:^|\s)min-w-\[1ch\](?:\s|$)/);
  assert.match(participantsCount.className, /\btabular-nums\b/);

  api.post = (async (url: string, body?: unknown) => {
    assert.equal(url, "/messages/mention-actions/execute");
    assert.deepEqual(body, { action: "add", resolutionIds: [resolutionId] });
    membershipAdded = true;
    return {
      data: {
        ok: true,
        action: "add",
        results: [{ resolutionId, action: "add", status: "delivered" }],
      },
    };
  }) as typeof api.post;

  fireEvent.change(textarea, { target: { value: "hello @added-user" } });
  await submitForm(form);
  fireEvent.click(within(await screen.findByTestId("pending-mention-action-strip")).getByRole("button", { name: "Add" }));

  await waitFor(() => assert.equal(participantsButton.textContent?.trim(), "2"));
  assert.equal(memberReads, 2, "the sibling snapshots should share one initial read and one post-mutation refresh");

  fireEvent.click(participantsButton);
  assert.ok(screen.getByRole("heading", { name: "Members (2)" }));
  assert.ok(screen.getByText("Added User"));
});

test("ChannelMembers compact trigger renders the real participant count and caps it at 99+", async () => {
  setServerFeatureFlagForTests("server-1", TOPBAR_OVERFLOW_FEATURE_FLAG_KEY, true);
  const makeHumans = (count: number) => Array.from({ length: count }, (_, index) => ({
    id: `member-${index}`,
    name: `member-${index}`,
    displayName: `Member ${index}`,
    description: null,
    avatarUrl: null,
    gravatarHash: "",
    role: "member",
  }));
  const mountCount = (count: number) => setupComposer(
    makeSendSpy(),
    {},
    {
      renderChannelMembers: true,
      apiGet: (async () => ({ data: { agents: [], humans: makeHumans(count) } })) as typeof api.get,
    },
  );

  const three = mountCount(3);
  const threeButton = screen.getByTitle("View participants");
  await waitFor(() => assert.equal(threeButton.textContent?.trim(), "3"));
  assert.match(threeButton.className, /\bh-7\b/);
  assert.doesNotMatch(threeButton.className, /\bh-8\b/);
  assert.match(threeButton.className, /\bmin-w-7\b/);
  assert.match(threeButton.className, /\bgap-1\b/);
  assert.match(threeButton.className, /\bpx-1\.5\b/);
  const icon = threeButton.querySelector("svg");
  assert.ok(icon);
  assert.equal(icon.getAttribute("width"), "14");
  assert.match(icon.getAttribute("class") ?? "", /\bshrink-0\b/);
  three.unmount();

  mountCount(100);
  const hundredButton = screen.getByTitle("View participants");
  await waitFor(() => assert.equal(hundredButton.textContent?.trim(), "99+"));
});

test("MessageInput batches Add all once, removes successes, and keeps partial failures retryable", async () => {
  const successfulId = "resolution-add-success";
  const failedId = "resolution-add-failed";
  const sendMessage = makeSendSpy([
    {
      resolutionId: successfulId,
      messageId: "message-add-all",
      targetType: "agent",
      targetHandle: "Tommy",
      targetAvatarUrl: null,
      reason: "not in channel",
      availableActions: ["add", "notify"],
      expiresAt: null,
    },
    {
      resolutionId: failedId,
      messageId: "message-add-all",
      targetType: "user",
      targetHandle: "King",
      targetAvatarUrl: null,
      reason: "not in channel",
      availableActions: ["add"],
      expiresAt: null,
    },
  ]);
  const { textarea, form } = setupComposer(sendMessage);
  const removalTimers: Array<() => void> = [];
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if ((timeout === 450 || timeout === 750) && typeof handler === "function") {
      removalTimers.push(() => handler(...args));
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(handler, timeout, ...args);
  }) as typeof setTimeout;
  const calls: Array<{ url: string; body: unknown }> = [];
  const memberRefreshes: Array<string | null> = [];
  const unsubscribeMemberRefresh = subscribeChannelMembersChanged((channelId) => {
    memberRefreshes.push(channelId);
  });
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    calls.push({ url, body });
    assert.equal(
      url,
      "/messages/mention-actions/execute",
      `unexpected POST while exercising Add all; calls=${JSON.stringify(calls)}`,
    );
    return {
      data: {
        ok: true,
        action: "add",
        results: [
          { resolutionId: successfulId, action: "add", status: "delivered" },
          { resolutionId: failedId, action: "add", status: "stale", reason: "target_unavailable" },
        ],
      },
    };
  }) as typeof api.post;

  fireEvent.change(textarea, { target: { value: "hello @Tommy @King" } });
  await submitForm(form);
  const strip = await screen.findByTestId("pending-mention-action-strip");
  fireEvent.click(within(strip).getByRole("button", { name: "Add all" }));

  try {
    const expectedCall = {
      url: "/messages/mention-actions/execute",
      body: {
        action: "add",
        resolutionIds: [successfulId, failedId],
      },
    };
    await waitFor(() => assert.deepEqual(
      calls,
      [expectedCall],
      `Add all must issue exactly one request; calls=${JSON.stringify(calls)}`,
    ));
    assert.deepEqual(memberRefreshes, [CHANNEL_ID], "a partial-success batch should invalidate membership exactly once");
    await screen.findByText("Added 1 of 2. That target is no longer available.");
    assert.equal(removalTimers.length, 2);
    assert.ok(within(strip).getByText("Added"));

    act(() => removalTimers[0]?.());
    act(() => removalTimers[1]?.());
    assert.ok(screen.getByText("Added 1 of 2. That target is no longer available."));
    const remainingStrip = screen.getByTestId("pending-mention-action-strip");
    assert.match(remainingStrip.textContent ?? "", /@King/);
    assert.doesNotMatch(remainingStrip.textContent ?? "", /@Tommy/);
    assert.ok(within(remainingStrip).getByRole("button", { name: "Add" }));
    assert.equal(within(remainingStrip).queryByRole("button", { name: "Add all" }), null);
  } finally {
    unsubscribeMemberRefresh();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("MessageInput keeps a same-frame Add all retry single-flight", async () => {
  const firstId = "resolution-add-first";
  const secondId = "resolution-add-second";
  const sendMessage = makeSendSpy([
    {
      resolutionId: firstId,
      messageId: "message-add-all-single-flight",
      targetType: "agent",
      targetHandle: "Tommy",
      targetAvatarUrl: null,
      reason: "not in channel",
      availableActions: ["add"],
      expiresAt: null,
    },
    {
      resolutionId: secondId,
      messageId: "message-add-all-single-flight",
      targetType: "user",
      targetHandle: "King",
      targetAvatarUrl: null,
      reason: "not in channel",
      availableActions: ["add"],
      expiresAt: null,
    },
  ]);
  const { textarea, form } = setupComposer(sendMessage);
  const calls: Array<{ url: string; body: unknown }> = [];
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/feature-flags/evaluate") {
      return { data: { evaluations: [] } };
    }
    calls.push({ url, body });
    assert.equal(
      url,
      "/messages/mention-actions/execute",
      `unexpected POST while exercising Add all; calls=${JSON.stringify(calls)}`,
    );
    return {
      data: {
        ok: true,
        action: "add",
        results: [
          { resolutionId: firstId, action: "add", status: "delivered" },
          { resolutionId: secondId, action: "add", status: "delivered" },
        ],
      },
    };
  }) as typeof api.post;

  fireEvent.change(textarea, { target: { value: "hello @Tommy @King" } });
  await submitForm(form);
  const strip = await screen.findByTestId("pending-mention-action-strip");
  const addAllButton = within(strip).getByRole("button", { name: "Add all" });
  await act(async () => {
    addAllButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    addAllButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });

  const expectedCall = {
    url: "/messages/mention-actions/execute",
    body: { action: "add", resolutionIds: [firstId, secondId] },
  };
  assert.deepEqual(
    calls,
    [expectedCall],
    `same-frame Add all must stay single-flight; calls=${JSON.stringify(calls)}`,
  );
});

test("MessageInput keeps dropped notify retryable and shows the privacy-safe reason", async () => {
  const resolutionId = "resolution-dropped";
  const sendMessage = makeSendSpy([{
    resolutionId,
    messageId: "message-dropped",
    targetType: "agent",
    targetHandle: "Noel",
    targetAvatarUrl: null,
    reason: "not in channel",
    availableActions: ["notify"],
    expiresAt: null,
  }]);
  const { textarea, form } = setupComposer(sendMessage);
  api.post = (async () => ({
    data: {
      ok: true,
      action: "notify",
      results: [{
        resolutionId,
        action: "notify",
        status: "dropped",
        reason: "delivery_unavailable",
      }],
    },
  })) as typeof api.post;

  fireEvent.change(textarea, { target: { value: "hello @Noel" } });
  await submitForm(form);
  const strip = await screen.findByTestId("pending-mention-action-strip");
  fireEvent.click(within(strip).getByRole("button", { name: "Notify" }));

  await screen.findByText("Notification was not delivered because delivery is temporarily unavailable. Try again.");
  assert.ok(screen.getByTestId("pending-mention-action-strip"));
  assert.ok(screen.getByRole("button", { name: "Notify" }));
});

test("MessageInput enables normal text and ready attachment drafts through separate submit paths", async () => {
  const sendMessage = makeSendSpy();
  const textComposer = setupComposer(sendMessage);

  fireEvent.change(textComposer.textarea, { target: { value: "ready text" } });
  const textButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  assert.equal(textButton.disabled, false);
  assert.equal(textButton.title, "Send");
  assert.equal(textButton.getAttribute("aria-label"), "Send");
  assertSendGlyph(textButton);
  textComposer.unmount();
  cleanup();

  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      return { data: { attachments: [{ id: "attachment-ready-1" }] } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  const fileComposer = setupComposer(sendMessage);
  const fileInput = fileComposer.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput, "file input should be present");
  fireEvent.change(fileInput, { target: { files: [new File(["ready"], "ready.txt", { type: "text/plain" })] } });

  await waitFor(() => {
    const attachmentButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    assert.equal(attachmentButton.disabled, false);
    assert.equal(attachmentButton.title, "Send");
    assert.equal(attachmentButton.getAttribute("aria-label"), "Send");
    assertSendGlyph(attachmentButton);
  });
  await submitForm(fileComposer.form);

  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  assert.deepEqual(sendMessage.calls[0], { content: "[1 attachment]", attachmentIds: ["attachment-ready-1"] });
  assert.equal(sendMessage.details[0]?.asTask, undefined);
  assert.match(sendMessage.details[0]?.optimisticId ?? "", /^optimistic-/);
  assert.match(sendMessage.details[0]?.randomId ?? "", /^msg-/);
  assert.equal(sendMessage.details[0]?.mentions, undefined);
});

test("MessageInput prevents send-button pointerdown from blurring the mobile composer before click submit", () => {
  const sendMessage = makeSendSpy();
  const { textarea } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "ready text" } });
  const sendButton = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
  assert.equal(sendButton.disabled, false);

  const pointerDown = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  sendButton.dispatchEvent(pointerDown);

  assert.equal(pointerDown.defaultPrevented, true);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput prevents task-toggle pointerdown from blurring the mobile composer without sending", () => {
  const sendMessage = makeSendSpy();
  const { textarea } = setupComposer(sendMessage, { showTaskButton: true });

  fireEvent.change(textarea, { target: { value: "ready text" } });
  textarea.focus();
  assert.equal(document.activeElement, textarea);

  const taskToggle = screen.getByRole("checkbox", { name: "As Task" }) as HTMLButtonElement;
  assert.equal(taskToggle.getAttribute("aria-checked"), "false");

  const pointerDown = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  taskToggle.dispatchEvent(pointerDown);

  assert.equal(pointerDown.defaultPrevented, true);
  assert.equal(document.activeElement, textarea);
  assert.deepEqual(sendMessage.calls, []);

  fireEvent.click(taskToggle);
  assert.equal(taskToggle.getAttribute("aria-checked"), "true");
  assert.equal(document.activeElement, textarea);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput does not focus the composer when task mode is toggled while the keyboard is closed", () => {
  const sendMessage = makeSendSpy();
  const { textarea } = setupComposer(sendMessage, { showTaskButton: true });

  fireEvent.change(textarea, { target: { value: "ready text" } });
  textarea.focus();
  textarea.blur();
  assert.notEqual(document.activeElement, textarea);

  const taskToggle = screen.getByRole("checkbox", { name: "As Task" }) as HTMLButtonElement;
  assert.equal(taskToggle.getAttribute("aria-checked"), "false");

  const pointerDown = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  taskToggle.dispatchEvent(pointerDown);

  assert.equal(pointerDown.defaultPrevented, true);
  assert.notEqual(document.activeElement, textarea);
  assert.deepEqual(sendMessage.calls, []);

  fireEvent.click(taskToggle);
  assert.equal(taskToggle.getAttribute("aria-checked"), "true");
  assert.notEqual(document.activeElement, textarea);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput preserves focus through the picker tap, then blurs after media selection", async () => {
  const sendMessage = makeSendSpy();
  const { container, textarea } = setupComposer(sendMessage);

  api.post = (async (url: string) => {
    assert.equal(url, "/attachments/upload");
    return { data: { attachments: [{ id: "attachment-media-1" }] } };
  }) as typeof api.post;

  fireEvent.change(textarea, { target: { value: "ready text" } });
  textarea.focus();
  assert.equal(document.activeElement, textarea);

  const imageInput = container.querySelector('input[type="file"][accept*="image/"]') as HTMLInputElement | null;
  const fileInput = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(imageInput, "image picker input should be present");
  assert.ok(fileInput, "file picker input should be present");

  let imagePickerClicks = 0;
  let filePickerClicks = 0;
  imageInput.click = () => { imagePickerClicks += 1; };
  fileInput.click = () => { filePickerClicks += 1; };

  const imageButton = screen.getByTitle(/Attach (image|media)/) as HTMLButtonElement;
  const imagePointerDown = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  imageButton.dispatchEvent(imagePointerDown);
  assert.equal(imagePointerDown.defaultPrevented, true);
  assert.equal(document.activeElement, textarea);
  fireEvent.click(imageButton);
  assert.equal(imagePickerClicks, 1);
  assert.equal(document.activeElement, textarea);

  const fileButton = screen.getByTitle("Attach file") as HTMLButtonElement;
  const filePointerDown = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  fileButton.dispatchEvent(filePointerDown);
  assert.equal(filePointerDown.defaultPrevented, true);
  assert.equal(document.activeElement, textarea);
  fireEvent.click(fileButton);
  assert.equal(filePickerClicks, 1);
  assert.equal(document.activeElement, textarea);

  await act(async () => {
    fireEvent.change(imageInput, {
      target: { files: [new File(["video"], "clip.mp4", { type: "video/mp4" })] },
    });
  });
  assert.notEqual(document.activeElement, textarea, "native media selection should dismiss the mobile keyboard");
  assert.equal(imageInput.value, "", "picker value should reset so the same media can be selected again");
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput blurs the composer as soon as submit is accepted so the mobile keyboard closes smoothly", async () => {
  const sendMessage = makeDeferredSendSpy();
  const { textarea, form } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "ready text" } });
  textarea.style.height = "64px";
  textarea.focus();
  assert.equal(document.activeElement, textarea);

  await submitForm(form);

  assert.equal(sendMessage.calls.length, 1);
  assert.equal(textarea.style.height, "");
  assert.notEqual(document.activeElement, textarea);

  await act(async () => {
    sendMessage.resolveSend({ messageId: "message-1", pendingMentionActions: [], unresolvedMentionHandles: [] });
  });
});

test("MessageInput keeps the composer focused after a successful desktop Enter send", async () => {
  const previousMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const sendMessage = makeSendSpy();
  try {
    const { textarea, unmount } = setupComposer(sendMessage);

    fireEvent.change(textarea, { target: { value: "ready text" } });
    textarea.focus();
    assert.equal(document.activeElement, textarea);

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => assert.equal(sendMessage.calls.length, 1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const focusPreserved = document.activeElement === textarea;
    assert.equal(textarea.value, "");
    unmount();
    assert.equal(focusPreserved, true);
  } finally {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
  }
});

test("MessageInput leaves Shift+Enter to the textarea newline behavior", async () => {
  const previousMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false }),
  });
  const sendMessage = makeSendSpy();
  try {
    const { textarea, unmount } = setupComposer(sendMessage);

    fireEvent.change(textarea, { target: { value: "line one" } });
    textarea.focus();

    const defaultAllowed = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", shiftKey: true });

    assert.equal(defaultAllowed, true);
    assert.equal(sendMessage.details.length, 0);
    assert.equal(textarea.value, "line one");
    assert.equal(document.activeElement, textarea);
    unmount();
  } finally {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
  }
});

test("MessageInput leaves plain Enter to the textarea on portrait touch-primary viewports", async () => {
  const previousMatchMedia = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: query === "(pointer: coarse) and (orientation: portrait)",
    }),
  });
  const sendMessage = makeSendSpy();
  try {
    const { textarea, unmount } = setupComposer(sendMessage);

    fireEvent.change(textarea, { target: { value: "mobile line" } });
    textarea.focus();

    const defaultAllowed = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    assert.equal(defaultAllowed, true);
    assert.equal(sendMessage.details.length, 0);
    assert.equal(textarea.value, "mobile line");
    assert.equal(document.activeElement, textarea);
    unmount();
  } finally {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
  }
});

for (const shortcut of [
  { label: "Cmd+Enter", event: { metaKey: true } },
  { label: "Ctrl+Enter", event: { ctrlKey: true } },
]) {
  test(`MessageInput sends with ${shortcut.label} from the focused composer`, async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false }),
    });
    const sendMessage = makeSendSpy();
    try {
      const { textarea, unmount } = setupComposer(sendMessage);

      fireEvent.change(textarea, { target: { value: `${shortcut.label} body` } });
      textarea.focus();
      assert.equal(document.activeElement, textarea);

      fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", ...shortcut.event });

      await waitFor(() => assert.equal(sendMessage.details.length, 1));
      assert.equal(sendMessage.details[0]?.content, `${shortcut.label} body`);
      assert.equal(sendMessage.details[0]?.asTask, undefined);
      assert.equal(textarea.value, "");
      assert.equal(document.activeElement, textarea);
      unmount();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
    }
  });
}

for (const shortcut of [
  { label: "Cmd+Shift+Enter", event: { metaKey: true, shiftKey: true } },
  { label: "Ctrl+Shift+Enter", event: { ctrlKey: true, shiftKey: true } },
]) {
  test(`MessageInput sends as task with ${shortcut.label} from the focused composer`, async () => {
    const previousMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false }),
    });
    const sendMessage = makeSendSpy();
    try {
      const { textarea, unmount } = setupComposer(sendMessage);

      fireEvent.change(textarea, { target: { value: `${shortcut.label} body` } });
      textarea.focus();
      assert.equal(document.activeElement, textarea);

      const defaultAllowed = fireEvent.keyDown(textarea, { key: "Enter", code: "Enter", ...shortcut.event });

      await waitFor(() => assert.equal(sendMessage.details.length, 1));
      assert.equal(defaultAllowed, false);
      assert.equal(sendMessage.details[0]?.content, `${shortcut.label} body`);
      assert.equal(sendMessage.details[0]?.asTask, true);
      assert.equal(textarea.value, "");
      assert.equal(document.activeElement, textarea);
      unmount();
    } finally {
      Object.defineProperty(window, "matchMedia", { configurable: true, value: previousMatchMedia });
    }
  });
}

test("MessageInput restores the draft and focus when an accepted send fails after closing the keyboard", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  const { textarea, form } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "retry text" } });
  textarea.focus();
  assert.equal(document.activeElement, textarea);

  await submitForm(form);

  assert.equal(sendMessage.calls.length, 1);
  assert.notEqual(document.activeElement, textarea);

  await act(async () => {
    sendMessage.rejectSend(new Error("network failed"));
  });

  await waitFor(() => assert.equal(textarea.value, "retry text"));
  assert.equal(document.activeElement, textarea);
});

test("MessageInput prepends failed sends instead of overwriting text typed while retry is pending", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  const { textarea, form } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "failed message" } });
  await submitForm(form);

  assert.equal(sendMessage.calls.length, 1);
  assert.equal(textarea.value, "");

  fireEvent.change(textarea, { target: { value: "new draft in progress" } });

  await act(async () => {
    sendMessage.rejectSend(new Error("network failed"));
  });

  await waitFor(() => assert.equal(textarea.value, "failed message\nnew draft in progress"));
  assert.equal(useMessageStore.getState().drafts[CHANNEL_ID], "failed message\nnew draft in progress");
  assert.equal(document.activeElement, textarea);
});

test("MessageInput restores a failed send into its originating thread after a switch", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  const { textarea, form, rerender } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "failed in thread A" } });
  await submitForm(form);
  assert.equal(sendMessage.calls.length, 1);

  const THREAD_B = "thread-b-after-switch";
  rerender(
    <MemoryRouter>
      <MessageInput channelId={THREAD_B} channelName="#thread-b" />
    </MemoryRouter>,
  );
  const nextTextarea = await screen.findByPlaceholderText("Message #thread-b") as HTMLTextAreaElement;
  fireEvent.change(nextTextarea, { target: { value: "draft in thread B" } });

  await act(async () => {
    sendMessage.rejectSend(new Error("network failed"));
  });

  await waitFor(() => assert.equal(nextTextarea.value, "draft in thread B"));
  assert.equal(
    useMessageStore.getState().drafts[CHANNEL_ID],
    "failed in thread A",
    "failure recovery must write to the originating thread draft",
  );
  assert.equal(
    useMessageStore.getState().drafts[THREAD_B],
    "draft in thread B",
    "the active thread draft must not receive the failed message",
  );
});

test("MessageInput routes a failure after the next thread commits but before passive effects", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  const seed = setupComposer(sendMessage);
  seed.unmount();
  const phases: string[] = [];
  let rejected = false;
  const onLayout = (channelId: string) => {
    phases.push(`layout:${channelId}`);
    if (channelId === SUSPENDED_THREAD_ID && !rejected) {
      rejected = true;
      sendMessage.rejectSend(new Error("network failed"));
    }
  };
  const onPassive = (channelId: string) => {
    phases.push(`passive:${channelId}`);
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <TestIntlProvider>
          <MemoryRouter>
            <CommitWindowComposer channelId={CHANNEL_ID} onLayout={onLayout} onPassive={onPassive} />
          </MemoryRouter>
        </TestIntlProvider>,
      );
    });
    const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
    const form = textarea.closest("form");
    assert.ok(form);

    fireEvent.change(textarea, { target: { value: "failed before passive effects" } });
    await submitForm(form);
    assert.equal(sendMessage.calls.length, 1);

    root.render(
      <TestIntlProvider>
        <MemoryRouter>
          <CommitWindowComposer channelId={SUSPENDED_THREAD_ID} onLayout={onLayout} onPassive={onPassive} />
        </MemoryRouter>
      </TestIntlProvider>,
    );

    const nextTextarea = await waitFor(() => screen.getByPlaceholderText("Message #thread-b") as HTMLTextAreaElement);
    await waitFor(() => assert.equal(
      useMessageStore.getState().drafts[CHANNEL_ID],
      "failed before passive effects",
    ));
    assert.equal(nextTextarea.value, "");
    assert.notEqual(document.activeElement, nextTextarea, "failed originating send must not focus the newly committed thread");
    assert.equal(useMessageStore.getState().drafts[SUSPENDED_THREAD_ID] ?? "", "");
    assert.ok(phases.includes(`layout:${SUSPENDED_THREAD_ID}`));
    assert.ok(phases.includes(`passive:${SUSPENDED_THREAD_ID}`));
    assert.ok(
      phases.indexOf(`layout:${SUSPENDED_THREAD_ID}`) < phases.indexOf(`passive:${SUSPENDED_THREAD_ID}`),
      "the failure is injected from the committed layout window before passive effects",
    );
  } finally {
    root.unmount();
    container.remove();
  }
});

test("MessageInput keeps committed ownership when a concurrent transition is abandoned", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  const seed = setupComposer(sendMessage);
  seed.unmount();
  const view = render(
    <MemoryRouter>
      <AbandonedTransitionComposer onSuspend={() => {}} />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const form = textarea.closest("form");
  assert.ok(form);

  fireEvent.change(textarea, { target: { value: "failed before abandoned transition" } });
  await submitForm(form);

  let suspended = false;
  view.rerender(<MemoryRouter><AbandonedTransitionComposer onSuspend={() => {
    if (suspended) return;
    suspended = true;
    sendMessage.rejectSend(new Error("network failed"));
  }} /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: "Switch in suspended transition" }));
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[CHANNEL_ID],
    "failed before abandoned transition",
  ));
  const visibleTextarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  assert.equal(visibleTextarea.value, "failed before abandoned transition");
  assert.equal(document.activeElement, visibleTextarea);
});

test("MessageInput restores structured mentions when retrying a failed send after a thread switch", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const { textarea, form, rerender } = setupComposer(sendMessage, {}, { members: [member] });

  fireEvent.change(textarea, { target: { value: "hello @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(textarea.value, "hello @teammate "));
  await submitForm(form);
  assert.deepEqual(sendMessage.details[0]?.mentions, [{
    type: "user",
    id: "user-teammate",
    name: "teammate",
  }]);

  const THREAD_B = "thread-b-mention-switch";
  rerender(
    <MemoryRouter>
      <MessageInput channelId={THREAD_B} channelName="#thread-b" />
    </MemoryRouter>,
  );
  const nextTextarea = await screen.findByPlaceholderText("Message #thread-b") as HTMLTextAreaElement;
  fireEvent.change(nextTextarea, { target: { value: "draft in thread B" } });

  await act(async () => {
    sendMessage.rejectSend(new Error("network failed"));
  });
  await waitFor(() => assert.equal(useMessageStore.getState().drafts[CHANNEL_ID], "hello @teammate "));

  rerender(
    <MemoryRouter>
      <MessageInput channelId={CHANNEL_ID} channelName="#general" />
    </MemoryRouter>,
  );
  const retryTextarea = await screen.findByPlaceholderText("Message #general") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(retryTextarea.value, "hello @teammate "));
  await submitForm(retryTextarea.closest("form")!);

  await waitFor(() => assert.equal(sendMessage.details.length, 2));
  assert.deepEqual(sendMessage.details[1]?.mentions, [{
    type: "user",
    id: "user-teammate",
    name: "teammate",
  }]);
});

test("MessageInput preserves failed mentions across unmount, async failure, and remount", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const view = setupComposer(sendMessage, {}, { members: [member] });
  const sourceChannelId = CHANNEL_ID;

  fireEvent.change(view.textarea, { target: { value: "retry after remount @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(view.textarea.value, "retry after remount @teammate "));
  await submitForm(view.form);
  assert.deepEqual(sendMessage.details[0]?.mentions, [{
    type: "user",
    id: "user-teammate",
    name: "teammate",
  }]);

  // Detach the committed callback ref before the request settles. The failure
  // must persist text + structured mentions to the draft slot, without trying
  // to set error/focus state on the unmounted composer.
  await act(async () => {
    view.rerender(<MemoryRouter />);
  });
  const oldTextarea = view.textarea;
  await act(async () => {
    sendMessage.rejectSend(new Error("network failed after unmount"));
  });
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[sourceChannelId],
    "retry after remount @teammate ",
  ));
  assert.equal(screen.queryByText("Failed to send message"), null);
  assert.notEqual(document.activeElement, oldTextarea);

  // Remount the originating composer and retry. The draft restore effect must
  // recover the structured mention payload that was saved while unmounted.
  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput channelId={sourceChannelId} channelName="#general" mentionChannelId={CHANNEL_ID} />
      </MemoryRouter>,
    );
  });
  const retryTextarea = await screen.findByPlaceholderText("Message #general") as HTMLTextAreaElement;
  await waitFor(() => assert.equal(retryTextarea.value, "retry after remount @teammate "));
  await submitForm(retryTextarea.closest("form")!);
  await waitFor(() => assert.equal(sendMessage.details.length, 2));
  assert.deepEqual(sendMessage.details[1]?.mentions, [{
    type: "user",
    id: "user-teammate",
    name: "teammate",
  }]);
  await act(async () => {
    sendMessage.resolveSend({ messageId: "message-remount", pendingMentionActions: [], unresolvedMentionHandles: [] }, 0);
  });
});

test("mergeFailedSendIntoDraft preserves either side's existing newline boundary", () => {
  assert.equal(mergeFailedSendIntoDraft("failed", ""), "failed");
  assert.equal(mergeFailedSendIntoDraft("", "typing"), "typing");
  assert.equal(mergeFailedSendIntoDraft("failed", "typing"), "failed\ntyping");
  assert.equal(mergeFailedSendIntoDraft("failed\n", "typing"), "failed\ntyping");
  assert.equal(mergeFailedSendIntoDraft("failed", "\ntyping"), "failed\ntyping");
});

test("MessageInput restores pending attachments when an accepted send fails after closing the keyboard", async () => {
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      return { data: { attachments: [{ id: "attachment-retry-1" }] } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  const { container, textarea, form } = setupComposer(sendMessage);
  const fileInput = container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput, "file input should be present");

  fireEvent.change(textarea, { target: { value: "retry with file" } });
  fireEvent.change(fileInput, { target: { files: [new File(["retry"], "retry.txt", { type: "text/plain" })] } });
  await waitFor(() => assert.ok(screen.getByText("retry.txt")));
  // The filename is visible during server-owned validation, while submit is
  // intentionally blocked. Wait for the real send control to become ready.
  await waitFor(() => {
    const submit = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    assert.equal(submit.disabled, false);
  });
  textarea.focus();
  assert.equal(document.activeElement, textarea);

  await submitForm(form);

  // The submit handler awaits the queued attachment upload before it reaches
  // sendMessage. React's synthetic event dispatcher does not await that async
  // continuation, so assert the observable call instead of scheduler timing.
  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  assert.deepEqual(sendMessage.calls[0], { content: "retry with file", attachmentIds: ["attachment-retry-1"] });
  assert.notEqual(document.activeElement, textarea);
  assert.equal(screen.queryByText("retry.txt"), null);

  await act(async () => {
    sendMessage.rejectSend(new Error("network failed"));
  });

  await waitFor(() => assert.equal(textarea.value, "retry with file"));
  assert.ok(screen.getByText("retry.txt"));
  assert.equal(document.activeElement, textarea);
});

test("MessageInput forwards the exact send contract for attachments, task flag, optimistic ids, randomId, and mentions", async () => {
  window.HTMLElement.prototype.scrollIntoView = () => {};
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      return { data: { attachments: [{ id: "attachment-contract-1" }] } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  const sendMessage = makeSendSpy();
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const composer = setupComposer(sendMessage, { showTaskButton: true }, { members: [member] });
  const fileInput = composer.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput, "file input should be present");

  fireEvent.change(composer.textarea, { target: { value: "hello @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(composer.textarea.value, "hello @teammate "));
  fireEvent.change(fileInput, { target: { files: [new File(["ready"], "ready.txt", { type: "text/plain" })] } });
  await waitFor(() => {
    const button = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    assert.equal(button.disabled, false);
  });
  fireEvent.click(screen.getByRole("checkbox"));

  await submitForm(composer.form);

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  const call = sendMessage.details[0]!;
  assert.equal(call.channelId, CHANNEL_ID);
  assert.equal(call.content, "hello @teammate ");
  assert.deepEqual(call.attachmentIds, ["attachment-contract-1"]);
  assert.equal(call.asTask, true);
  assert.match(call.optimisticId ?? "", /^optimistic-\d+-\d{6}-/);
  assert.match(call.randomId ?? "", /^msg-\d+-\d{6}-/);
  assert.equal(call.randomId?.replace(/^msg-/, "optimistic-"), call.optimisticId);
  assert.deepEqual(call.mentions, [{ type: "user", id: "user-teammate", name: "teammate" }]);
});

test("MessageInput submitDisabled blocks override submit and exposes the custom reason", async () => {
  const sendMessage = makeSendSpy();
  let overrideCount = 0;
  const { form } = setupComposer(sendMessage, {
    onSendOverride: async () => { overrideCount += 1; },
    allowEmptySubmit: true,
    submitDisabled: true,
    submitDisabledReason: "Select a target first",
  });

  const button = screen.getByRole("button", { name: "Select a target first" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Select a target first");
  assert.equal(button.getAttribute("aria-label"), "Select a target first");
  fireEvent.click(button);
  await submitForm(form);

  assert.equal(overrideCount, 0);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput submitDisabled falls back to a generic disabled label", () => {
  const sendMessage = makeSendSpy();
  setupComposer(sendMessage, {
    onSendOverride: async () => {},
    allowEmptySubmit: true,
    submitDisabled: true,
  });

  const button = screen.getByRole("button", { name: "Send disabled" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Send disabled");
  assert.equal(button.getAttribute("aria-label"), "Send disabled");
});

test("MessageInput submitBusy blocks submit and swaps the send icon for a spinner", async () => {
  const sendMessage = makeSendSpy();
  let overrideCount = 0;
  const { form } = setupComposer(sendMessage, {
    onSendOverride: async () => { overrideCount += 1; },
    allowEmptySubmit: true,
    submitBusy: true,
  });

  const button = screen.getByRole("button", { name: "Sending" }) as HTMLButtonElement;
  assert.equal(button.disabled, true);
  assert.equal(button.title, "Sending...");
  assert.equal(button.getAttribute("aria-label"), "Sending");
  assert.ok(button.querySelector('[role="status"][aria-label="Loading"]'));
  fireEvent.click(button);
  await submitForm(form);

  assert.equal(overrideCount, 0);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput upload states block submit with precise labels", async () => {
  const sendMessage = makeSendSpy();
  let finishUpload: (value: { data: { attachments: Array<{ id: string }> } }) => void = () => {};
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      return new Promise((resolve) => {
        finishUpload = resolve;
      });
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  const uploading = setupComposer(sendMessage);
  const uploadingFile = new File(["uploading"], "uploading.txt", { type: "text/plain" });
  const fileInput = uploading.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput, "file input should be present");
  fireEvent.change(fileInput, { target: { files: [uploadingFile] } });

  try {
    const uploadingButton = await screen.findByRole("button", { name: "Uploading attachments" }) as HTMLButtonElement;
    assert.equal(uploadingButton.disabled, true);
    assert.equal(uploadingButton.title, "Uploading attachments…");
    assert.equal(uploadingButton.getAttribute("aria-label"), "Uploading attachments");
    assert.ok(uploadingButton.querySelector('[role="status"][aria-label="Loading"]'));
  } finally {
    finishUpload({ data: { attachments: [{ id: "attachment-finished-after-assertion" }] } });
    uploading.unmount();
    cleanup();
  }

  api.post = (async (url: string) => {
    if (url === "/attachments/upload") throw new Error("upload failed");
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;

  const failed = setupComposer(sendMessage);
  const failedFile = new File(["failed"], "failed.txt", { type: "text/plain" });
  const failedInput = failed.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(failedInput, "file input should be present");
  fireEvent.change(failedInput, { target: { files: [failedFile] } });

  const failedButton = await screen.findByRole("button", { name: "Retry or remove failed attachments" }) as HTMLButtonElement;
  assert.equal(failedButton.disabled, true);
  assert.equal(failedButton.title, "Retry or remove failed attachments");
  assert.equal(failedButton.getAttribute("aria-label"), "Retry or remove failed attachments");
  assert.equal(failedButton.querySelector('[role="status"]'), null);
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput distinguishes byte transfer from server finishing and keeps the precise failure visible", async () => {
  const sendMessage = makeSendSpy();
  let rejectUpload: (reason: unknown) => void = () => {};
  api.post = (async (
    url: string,
    _body?: unknown,
    config?: { onUploadProgress?: (event: { loaded: number; total?: number }) => void },
  ) => {
    if (url !== "/attachments/upload") throw new Error(`unexpected POST ${url}`);
    config?.onUploadProgress?.({ loaded: 70, total: 70 });
    return await new Promise((_resolve, reject) => {
      rejectUpload = reject;
    });
  }) as typeof api.post;

  const view = setupComposer(sendMessage);
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput, "file input should be present");
  fireEvent.change(fileInput, {
    target: { files: [new File(["video"], "demo.mp4", { type: "video/mp4" })] },
  });

  assert.ok(
    await screen.findByText("Finishing upload…"),
    "a fully sent request must stop presenting itself as a frozen 99% byte transfer",
  );
  assert.equal(screen.queryByText("99%"), null);

  const storageTimeout = Object.assign(new Error("request failed"), {
    response: { data: { error: "Attachment storage timed out" } },
  });
  await act(async () => {
    rejectUpload(storageTimeout);
  });

  assert.ok(
    await screen.findByText("The file reached Raft, but saving it timed out."),
    "the stable server reason must be visible without relying on hover title",
  );
  const visibleFailure = screen.getByRole("alert");
  assert.match(
    visibleFailure.textContent ?? "",
    /The file reached Raft, but saving it timed out\./,
    "the complete failure reason must also be announced without a hover interaction",
  );
  assert.equal(
    visibleFailure.querySelector(".line-clamp-2"),
    null,
    "the touch-readable failure surface must not truncate the precise reason inside the attachment tile",
  );
  assert.match(visibleFailure.className, /w-full/, "the precise reason needs a full-width surface outside the 64px tile");
  assert.equal(
    screen.getAllByText("demo.mp4").length,
    1,
    "the full-width failed state replaces the compact tile instead of duplicating it",
  );
  assert.ok(screen.getByText(/99% sent/), "the failed state must retain how much reached the server");
  assert.ok(screen.getByRole("button", { name: "Retry uploading demo.mp4" }));
  assert.ok(screen.getByRole("button", { name: "Remove demo.mp4" }));
  assert.deepEqual(sendMessage.calls, []);
});

test("MessageInput consumes one same-frame duplicate submit for the same draft", async () => {
  const sendMessage = makeSendSpy();
  const { textarea, form } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "same draft" } });
  await submitTwiceInOneFrame(form);

  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  assert.deepEqual(sendMessage.calls[0], { content: "same draft", attachmentIds: [] });
});

test("releaseSubmittedDraftIntent preserves a newer in-flight request", () => {
  assert.equal(releaseSubmittedDraftIntent("request-two", "request-one"), "request-two");
  assert.equal(releaseSubmittedDraftIntent("request-one", "request-one"), null);
  assert.equal(releaseSubmittedDraftIntent(null, "request-one"), null);
});

test("MessageInput still sends a legitimately edited next draft while the first send is settling", async () => {
  const sendMessage = makeSendSpy();
  const { textarea, form } = setupComposer(sendMessage);

  fireEvent.change(textarea, { target: { value: "first draft" } });
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });

  fireEvent.change(textarea, { target: { value: "second draft" } });
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });

  await waitFor(() => assert.equal(sendMessage.calls.length, 2));
  assert.deepEqual(sendMessage.calls.map((call) => call.content), ["first draft", "second draft"]);
  assert.deepEqual(sendMessage.calls.map((call) => call.attachmentIds), [[], []]);
});

test("an older failed request cannot clear the newer draft's duplicate-submit intent", async () => {
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  api.get = withUploadCapability((async () => ({ data: { agents: [], humans: [] } })) as typeof api.get);
  useAuthStore.setState({ user: {
    id: "user-1", email: "user@example.com", gravatarHash: "", name: "user", displayName: "User",
    description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null,
    preferredTimezone: null, autoTranslationEnabled: false, preferredTimeFormat: null,
    preferredMessageBodyFontSize: null, referralSource: null, referralSourceOther: null,
    referralSourceSkippedAt: null,
  } } as never);
  useServerStore.setState({ current: {
    id: "server-1", name: "Server", slug: "server", ownerId: "user-1", onboardingAgentId: null,
    hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner",
    createdAt: "2026-07-04T00:00:00.000Z",
  }, members: [] } as never);
  useChannelStore.setState({ channels: [{
    id: CHANNEL_ID, serverId: "server-1", name: "general", type: "regular", description: null,
    archived: false, archivedAt: null, archivedBy: null, isDefault: false,
    createdAt: "2026-07-04T00:00:00.000Z",
  }], dmChannels: [] } as never);
  useMessageStore.setState({ drafts: {}, channelMessages: { [CHANNEL_ID]: [] }, currentChannelId: CHANNEL_ID, messages: [], sendMessage } as never);
  render(
    <MemoryRouter>
      <ChannelSwitcherComposer />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const form = textarea.closest("form");
  assert.ok(form);

  fireEvent.change(textarea, { target: { value: "request one" } });
  await submitForm(form);
  await waitFor(() => assert.equal(sendMessage.details.length, 1));

  fireEvent.change(textarea, { target: { value: "request two" } });
  await submitForm(form);

  await waitFor(() => assert.equal(sendMessage.details.length, 2));
  const toggle = screen.getByRole("button", { name: "Toggle duplicate-submit thread" });
  fireEvent.click(toggle);
  const threadTextarea = await screen.findByPlaceholderText("Message #thread-b") as HTMLTextAreaElement;
  assert.equal(threadTextarea.value, "");

  await act(async () => {
    sendMessage.rejectSend(new Error("older request failed"), 0);
  });
  await waitFor(() => assert.equal(useMessageStore.getState().drafts[CHANNEL_ID], "request one"));

  // Simulate the newer draft still present in the originating thread while
  // the user is away from it. Re-entering that thread restores the same
  // request-2 intent without a change event (which intentionally clears the
  // duplicate guard).
  useMessageStore.getState().setDraft(CHANNEL_ID, "request two");
  fireEvent.click(toggle);
  const retryTextarea = await screen.findByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const retryForm = retryTextarea.closest("form");
  assert.ok(retryForm);
  await waitFor(() => assert.equal(retryTextarea.value, "request two"));

  // Re-enter the exact request that is still in flight. This reaches the
  // production intent guard after request 1's catch; the older failure must
  // not have cleared request 2's ownership.
  await submitForm(retryForm);

  assert.deepEqual(sendMessage.details.map((detail) => detail.content), ["request one", "request two"]);
});

test("locale switch preserves the selected @mention payload (@铁根 regression guard)", async () => {
  const sendMessage = makeSendSpy();
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  api.get = (async () => ({ data: { agents: [], humans: [] } })) as typeof api.get;
  useAuthStore.setState({
    user: {
      id: "user-1", email: "user@example.com", gravatarHash: "", name: "user", displayName: "User",
      description: null, avatarUrl: null, emailVerified: true, preferredLanguage: null,
      preferredTimezone: null, autoTranslationEnabled: false, preferredTimeFormat: null,
      preferredMessageBodyFontSize: null, referralSource: null, referralSourceOther: null,
      referralSourceSkippedAt: null,
    },
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1", name: "Server", slug: "server", ownerId: "user-1", onboardingAgentId: null,
      hideHumansFromMembers: false, plan: "free", planDowngradedAt: null, role: "owner",
      createdAt: "2026-07-04T00:00:00.000Z",
    },
    members: [member],
  } as never);
  useChannelStore.setState({
    channels: [{
      id: CHANNEL_ID, serverId: "server-1", name: "general", type: "regular", description: null,
      archived: false, archivedAt: null, archivedBy: null, isDefault: false,
      createdAt: "2026-07-04T00:00:00.000Z",
    }],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {}, channelMessages: { [CHANNEL_ID]: [] }, currentChannelId: CHANNEL_ID, messages: [], sendMessage,
  } as never);

  window.HTMLElement.prototype.scrollIntoView = () => {};

  const tree = (locale: "en" | "zh-cn") => (
    <TestIntlProvider locale={locale}>
      <MemoryRouter>
        <MessageInput channelId={CHANNEL_ID} channelName="#general" />
      </MemoryRouter>
    </TestIntlProvider>
  );
  const view = rtlRender(tree("en"));
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;

  // Select an @mention — this populates the internal selectedMentions payload.
  fireEvent.change(textarea, { target: { value: "hello @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(textarea.value, "hello @teammate "));

  // Switch display language on the SAME mounted composer. Before the fix, the
  // channel-switch reset effect depended on formatMessage and re-ran here,
  // calling setSelectedMentions([]) while the @teammate text stayed — so the
  // submit payload silently lost the mention.
  view.rerender(tree("zh-cn"));
  await waitFor(() => assert.ok(screen.getByPlaceholderText("发送消息至 #general")));

  await submitForm(textarea.closest("form")!);

  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  const call = sendMessage.details[0]!;
  assert.ok(
    call.mentions && call.mentions.length === 1,
    "the @mention payload must survive a display-language switch",
  );
  assert.equal(call.mentions![0]!.name, "teammate");
});

test("Cmd+Z restores the text and structured payload from before mention completion", async () => {
  const sendMessage = makeSendSpy();
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const { textarea } = setupComposer(sendMessage, {}, { members: [member] });

  fireEvent.change(textarea, { target: { value: "hello @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(textarea.value, "hello @teammate "));

  const browserUndoAccepted = fireEvent.keyDown(textarea, { key: "z", metaKey: true });
  assert.equal(browserUndoAccepted, false, "the mention transaction owns this one undo step");
  await waitFor(() => assert.equal(textarea.value, "hello @team"));

  fireEvent.change(textarea, { target: { value: "hello @team next" } });
  await submitForm(textarea.closest("form")!);
  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.equal(sendMessage.details[0]!.content, "hello @team next");
  assert.deepEqual(sendMessage.details[0]!.mentions, []);
});

test("live lazy-thread adoption preserves mention payload and persists the destination draft once", async () => {
  const pendingChannelId = "pending-thread:parent-with-mention";
  const durableChannelId = "thread-channel-with-mention";
  const sendMessage = makeSendSpy();
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const view = setupComposer(
    sendMessage,
    {
      channelId: pendingChannelId,
      mentionChannelId: CHANNEL_ID,
      resolveChannelId: async () => durableChannelId,
    },
    { members: [member] },
  );
  const textarea = view.textarea;

  fireEvent.change(textarea, { target: { value: "hello @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(textarea.value, "hello @teammate "));
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[pendingChannelId],
    "hello @teammate ",
  ));

  let draftTransitions = 0;
  const unsubscribe = useMessageStore.subscribe((state, previousState) => {
    if (state.drafts !== previousState.drafts) draftTransitions += 1;
  });
  const storagePrototype = Object.getPrototypeOf(globalThis.localStorage) as Storage;
  const originalSetItem = storagePrototype.setItem;
  let draftStorageWrites = 0;
  storagePrototype.setItem = function (key: string, value: string) {
    if (key === "slock_drafts") draftStorageWrites += 1;
    return originalSetItem.call(this, key, value);
  };

  try {
    await act(async () => {
      view.rerender(
        <MemoryRouter>
          <MessageInput
            channelId={durableChannelId}
            channelName="#general"
            mentionChannelId={CHANNEL_ID}
            migrateDraftFromChannelId={pendingChannelId}
          />
        </MemoryRouter>,
      );
    });
    await waitFor(() => assert.equal(textarea.value, "hello @teammate "));
    assert.equal(useMessageStore.getState().drafts[pendingChannelId], undefined);
    assert.equal(
      useMessageStore.getState().drafts[durableChannelId],
      "hello @teammate ",
    );
    assert.equal(draftTransitions, 1, "adoption should publish one drafts-store transition");
    assert.equal(draftStorageWrites, 1, "adoption should persist the destination draft once");
    assert.deepEqual(
      JSON.parse(globalThis.localStorage.getItem("slock_drafts") ?? "{}"),
      { [durableChannelId]: "hello @teammate " },
    );
  } finally {
    storagePrototype.setItem = originalSetItem;
    unsubscribe();
  }

  await submitForm(textarea.closest("form")!);
  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  const call = sendMessage.details[0]!;
  assert.equal(call.channelId, durableChannelId);
  assert.deepEqual(call.mentions, [{
    type: "user",
    id: "user-teammate",
    name: "teammate",
  }]);
});

test("failed lazy-thread send follows the provisional-to-durable composer identity", async () => {
  const pendingChannelId = "pending-thread:parent-failed-adoption";
  const durableChannelId = "thread-channel-failed-adoption";
  const sendMessage = makeDeferredSendSpy();
  console.error = () => {};
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const view = setupComposer(
    sendMessage,
    {
      channelId: pendingChannelId,
      mentionChannelId: CHANNEL_ID,
      resolveChannelId: async () => durableChannelId,
    },
    { members: [member] },
  );

  fireEvent.change(view.textarea, { target: { value: "retry @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(view.textarea.value, "retry @teammate "));
  await submitForm(view.form);
  await waitFor(() => assert.equal(sendMessage.details.length, 1));

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId="ordinary-away-channel"
          channelName="#away"
          mentionChannelId={CHANNEL_ID}
        />
      </MemoryRouter>,
    );
  });
  await screen.findByPlaceholderText("Message #away");
  await act(async () => {
    sendMessage.rejectSend(new Error("network failed"));
  });
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[pendingChannelId],
    "retry @teammate ",
  ));

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId={durableChannelId}
          channelName="#thread"
          mentionChannelId={CHANNEL_ID}
          migrateDraftFromChannelId={pendingChannelId}
        />
      </MemoryRouter>,
    );
  });

  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[durableChannelId],
    "retry @teammate ",
  ));
  assert.equal(useMessageStore.getState().drafts[pendingChannelId], undefined);
  await submitForm(view.textarea.closest("form")!);
  await waitFor(() => assert.equal(sendMessage.details.length, 2));
  assert.deepEqual(sendMessage.details[1]?.mentions, [{
    type: "user",
    id: "user-teammate",
    name: "teammate",
  }]);
});

test("lazy resolve failure remains visible after provisional-to-durable adoption", async () => {
  const pendingChannelId = "pending-thread:parent-resolve-failure";
  const durableChannelId = "thread-channel-resolve-failure";
  const sendMessage = makeSendSpy();
  let rejectResolve: (reason: unknown) => void = () => {};
  const resolveChannelId = new Promise<string>((_resolve, reject) => {
    rejectResolve = reject;
  });
  const view = setupComposer(sendMessage, {
    channelId: pendingChannelId,
    resolveChannelId: () => resolveChannelId,
  });

  fireEvent.change(view.textarea, { target: { value: "create then fail" } });
  await submitForm(view.form);
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[pendingChannelId],
    "create then fail",
  ));

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId={durableChannelId}
          channelName="#thread"
          migrateDraftFromChannelId={pendingChannelId}
        />
      </MemoryRouter>,
    );
  });
  await waitFor(() => assert.equal(view.textarea.value, "create then fail"));

  await act(async () => {
    rejectResolve(new Error("thread creation failed"));
  });
  await waitFor(() => assert.ok(screen.getByText("Failed to create thread")));
  assert.deepEqual(sendMessage.details, []);
  assert.equal(view.textarea.value, "create then fail");
});

test("lazy resolve failure stays silent after switching to another channel", async () => {
  const pendingChannelId = "pending-thread:parent-resolve-away";
  const sendMessage = makeSendSpy();
  let rejectResolve: (reason: unknown) => void = () => {};
  const resolveChannelId = new Promise<string>((_resolve, reject) => {
    rejectResolve = reject;
  });
  const view = setupComposer(sendMessage, {
    channelId: pendingChannelId,
    resolveChannelId: () => resolveChannelId,
  });

  fireEvent.change(view.textarea, { target: { value: "stay in source" } });
  await submitForm(view.form);
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[pendingChannelId],
    "stay in source",
  ));

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput channelId="ordinary-away-resolve" channelName="#away" />
      </MemoryRouter>,
    );
  });
  const awayTextarea = await screen.findByPlaceholderText("Message #away");
  await act(async () => {
    rejectResolve(new Error("thread creation failed"));
  });

  await waitFor(() => assert.equal(useMessageStore.getState().drafts[pendingChannelId], "stay in source"));
  assert.equal(useMessageStore.getState().drafts["ordinary-away-resolve"] ?? "", "");
  assert.equal(screen.queryByText("Failed to create thread"), null);
  assert.notEqual(document.activeElement, awayTextarea);
  assert.deepEqual(sendMessage.details, []);
});

test("lazy upload failure remains visible after provisional-to-durable adoption", async () => {
  const pendingChannelId = "pending-thread:parent-upload-failure";
  const durableChannelId = "thread-channel-upload-failure";
  const sendMessage = makeSendSpy();
  let rejectUpload: (reason: unknown) => void = () => {};
  api.post = (async (url: string) => {
    assert.equal(url, "/attachments/upload");
    return await new Promise((_resolve, reject) => {
      rejectUpload = reject;
    });
  }) as typeof api.post;
  const view = setupComposer(sendMessage, {
    channelId: pendingChannelId,
    resolveChannelId: async () => durableChannelId,
  });
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput);
  fireEvent.change(fileInput, {
    target: { files: [new File(["upload"], "reply.txt", { type: "text/plain" })] },
  });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove reply.txt" })));
  await submitForm(view.form);
  await waitFor(() => assert.equal(typeof rejectUpload, "function"));

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId={durableChannelId}
          channelName="#thread"
          migrateDraftFromChannelId={pendingChannelId}
        />
      </MemoryRouter>,
    );
  });
  await act(async () => {
    rejectUpload(new Error("upload failed"));
  });
  await waitFor(() => assert.ok(screen.getByText("Remove or retry failed attachments before sending.")));
  assert.deepEqual(sendMessage.details, []);
});

test("lazy upload failure stays silent after switching to another channel", async () => {
  const pendingChannelId = "pending-thread:parent-upload-away";
  const sendMessage = makeSendSpy();
  let rejectUpload: (reason: unknown) => void = () => {};
  api.post = (async (url: string) => {
    assert.equal(url, "/attachments/upload");
    return await new Promise((_resolve, reject) => {
      rejectUpload = reject;
    });
  }) as typeof api.post;
  const view = setupComposer(sendMessage, {
    channelId: pendingChannelId,
    resolveChannelId: async () => "thread-channel-upload-away",
  });
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput);
  fireEvent.change(fileInput, {
    target: { files: [new File(["upload"], "away.txt", { type: "text/plain" })] },
  });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove away.txt" })));
  await submitForm(view.form);
  await waitFor(() => assert.equal(typeof rejectUpload, "function"));

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput channelId="ordinary-away-upload" channelName="#away" />
      </MemoryRouter>,
    );
  });
  const awayTextarea = await screen.findByPlaceholderText("Message #away");
  await act(async () => {
    rejectUpload(new Error("upload failed"));
  });
  await waitFor(() => assert.equal(useMessageStore.getState().drafts[pendingChannelId] ?? "", ""));
  assert.equal(screen.queryByText("Remove or retry failed attachments before sending."), null);
  assert.notEqual(document.activeElement, awayTextarea);
  assert.deepEqual(sendMessage.details, []);
});

test("pending lazy-thread upload failure stays with its origin after switching before resolve", async () => {
  const pendingChannelId = "pending-thread:parent-upload-before-resolve";
  const durableChannelId = "thread-channel-upload-before-resolve";
  const sendMessage = makeSendSpy();
  let resolveThread: (channelId: string) => void = () => {};
  const threadResolution = new Promise<string>((resolve) => {
    resolveThread = resolve;
  });
  let rejectUpload: (reason: unknown) => void = () => {};
  api.post = (async (url: string) => {
    assert.equal(url, "/attachments/upload");
    return await new Promise((_resolve, reject) => {
      rejectUpload = reject;
    });
  }) as typeof api.post;
  const view = setupComposer(sendMessage, {
    channelId: pendingChannelId,
    resolveChannelId: () => threadResolution,
  });
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement | null;
  assert.ok(fileInput);
  fireEvent.change(fileInput, {
    target: { files: [new File(["upload"], "before-resolve.txt", { type: "text/plain" })] },
  });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove before-resolve.txt" })));
  await submitForm(view.form);

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput channelId="ordinary-away-before-resolve" channelName="#away" />
      </MemoryRouter>,
    );
  });
  const awayTextarea = await screen.findByPlaceholderText("Message #away");

  await act(async () => {
    resolveThread(durableChannelId);
  });
  await waitFor(() => assert.equal(typeof rejectUpload, "function"));
  await act(async () => {
    rejectUpload(new Error("upload failed before resolve"));
  });

  await waitFor(() => assert.equal(useMessageStore.getState().drafts[pendingChannelId] ?? "", ""));
  assert.equal(screen.queryByText("Remove or retry failed attachments before sending."), null);
  assert.notEqual(document.activeElement, awayTextarea);

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId={durableChannelId}
          channelName="#thread"
          migrateDraftFromChannelId={pendingChannelId}
        />
      </MemoryRouter>,
    );
  });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Retry uploading before-resolve.txt" })));
  assert.ok(screen.getByText("File no longer available or upload failed. Tap to retry."));
});

test("attachment comment override failure restores only its originating composer after a switch", async () => {
  const sendMessage = makeSendSpy();
  const sourceChannelId = "attachment-comment:source-attachment";
  let rejectOverride: (reason: unknown) => void = () => {};
  const view = setupComposer(sendMessage, {
    channelId: sourceChannelId,
    channelName: "#general",
    variant: "compact",
    allowEmptySubmit: true,
    onSendOverride: async () => await new Promise<void>((_resolve, reject) => {
      rejectOverride = reject;
    }),
  });
  fireEvent.change(view.textarea, { target: { value: "retry source comment" } });
  await submitForm(view.form);

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId="attachment-comment:other-attachment"
          channelName="other.txt"
          variant="compact"
          allowEmptySubmit
          onSendOverride={async () => {}}
        />
      </MemoryRouter>,
    );
  });
  const awayTextarea = await screen.findByPlaceholderText("Message other.txt");
  await act(async () => {
    rejectOverride(new Error("comment send failed"));
  });

  await waitFor(() => assert.equal(useMessageStore.getState().drafts[sourceChannelId], "retry source comment"));
  assert.equal(useMessageStore.getState().drafts["attachment-comment:other-attachment"] ?? "", "");
  assert.equal(screen.queryByText("Failed to send message"), null);
  assert.notEqual(document.activeElement, awayTextarea);
});

test("ordinary channel switches still clear structured mention payloads", async () => {
  const otherChannelId = "ordinary-other-channel";
  const sendMessage = makeSendSpy();
  window.HTMLElement.prototype.scrollIntoView = () => {};
  const member: ServerMember = {
    userId: "user-teammate",
    email: "team@example.com",
    gravatarHash: "",
    name: "teammate",
    displayName: "Team Mate",
    description: null,
    avatarUrl: null,
    role: "member",
    joinedAt: "2026-07-04T00:00:00.000Z",
  };
  const view = setupComposer(
    sendMessage,
    { mentionChannelId: CHANNEL_ID },
    { members: [member] },
  );
  const textarea = view.textarea;

  fireEvent.change(textarea, { target: { value: "hello @team" } });
  await waitFor(() => assert.ok(screen.getByText("@teammate")));
  fireEvent.click(screen.getByText("@teammate"));
  await waitFor(() => assert.equal(textarea.value, "hello @teammate "));
  act(() => {
    useMessageStore.getState().setDraft(otherChannelId, "hello @teammate ");
  });

  await act(async () => {
    view.rerender(
      <MemoryRouter>
        <MessageInput
          channelId={otherChannelId}
          channelName="#other"
          mentionChannelId={CHANNEL_ID}
        />
      </MemoryRouter>,
    );
  });
  await waitFor(() => assert.equal(textarea.value, "hello @teammate "));

  await submitForm(textarea.closest("form")!);
  await waitFor(() => assert.equal(sendMessage.details.length, 1));
  assert.deepEqual(sendMessage.details[0]!.mentions, []);
});
