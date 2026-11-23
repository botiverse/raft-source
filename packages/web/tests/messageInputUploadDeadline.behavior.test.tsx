import assert from "node:assert/strict";
import { act } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { TestIntlProvider } from "./helpers/intl";
import { resetUploadCapability, withUploadCapability } from "./helpers/uploadCapability";
import api from "../src/api/client";
import { MessageInput } from "../src/features/composer/MessageInput";
import { clearDraftPendingFilesForTests, clearFailedSendMentionsForTests } from "../src/features/composer/draftPendingFilesCache";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useMessageStore } from "../src/store/messageStore";
import type { SendMessageResult } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { __setUploadFinishedEmitterForTest } from "../src/utils/attachmentUploadOutcomeTrace";
import { ATTACHMENT_UPLOAD_CONTROL_TIMEOUT_MS } from "../src/utils/directAttachmentUpload";

// #triage:#545: a composer upload never spins forever, and each attempt is
// reported once (slock.attachment.upload_finished).

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
const CHANNEL_ID = "channel-upload-deadline";
const originalApiGet = api.get;
const originalApiPost = api.post;
const originalConsoleError = console.error;
let finished: Array<Record<string, unknown>> = [];

beforeEach(() => {
  finished = [];
  __setUploadFinishedEmitterForTest((_name, attrs) => { finished.push(attrs); });
});

afterEach(() => {
  vi.useRealTimers();
  __setUploadFinishedEmitterForTest(null);
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

function setupComposer(options: Readonly<{
  channelId?: string;
  resolveChannelId?: () => Promise<string>;
  upload: (signal: AbortSignal | undefined) => Promise<unknown>;
}>) {
  console.error = () => {};
  api.post = (async (url: string, _body?: unknown, config?: { signal?: AbortSignal }) => {
    if (url === "/attachments/upload") return options.upload(config?.signal);
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
  const sendMessage = async (): Promise<SendMessageResult> => (
    { messageId: "message-1", pendingMentionActions: [], unresolvedMentionHandles: [], deliveryWarnings: [] }
  );
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [] },
    currentChannelId: CHANNEL_ID,
    messages: [],
    sendMessage,
  } as never);
  const view = render(
    <MemoryRouter>
      <MessageInput
        channelId={options.channelId ?? CHANNEL_ID}
        channelName="#general"
        resolveChannelId={options.resolveChannelId}
      />
    </MemoryRouter>,
  );
  const textarea = screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement;
  const fileInput = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  return { form: textarea.closest("form")!, fileInput };
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

function pickFile(fileInput: HTMLInputElement, name: string) {
  fireEvent.change(fileInput, { target: { files: [new File([name], name, { type: "text/plain" })] } });
}

test("a thread channel that never resolves times out, and sending again asks afresh and uploads", async () => {
  const resolveCalls: number[] = [];
  let uploads = 0;
  const { form, fileInput } = setupComposer({
    channelId: "pending-thread:parent-deadline",
    resolveChannelId: () => {
      resolveCalls.push(resolveCalls.length + 1);
      // The first lookup hangs for good; the next one gets an answer.
      return resolveCalls.length === 1 ? new Promise<string>(() => undefined) : Promise.resolve("thread-channel-1");
    },
    upload: async () => {
      uploads += 1;
      return { data: { attachments: [{ id: `attachment-${uploads}` }] } };
    },
  });
  pickFile(fileInput, "one.txt");
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove one.txt" })));

  vi.useFakeTimers();
  await submitForm(form);
  assert.deepEqual(resolveCalls, [1]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ATTACHMENT_UPLOAD_CONTROL_TIMEOUT_MS);
  });
  vi.useRealTimers();

  await screen.findByText("Failed to create thread");
  assert.equal(uploads, 0);
  assert.equal(finished.length, 0, "no upload attempt started");

  await submitForm(form);
  await waitFor(() => assert.equal(uploads, 1));
  assert.deepEqual(resolveCalls, [1, 2], "the retry does not wait on the hung lookup");
  await waitFor(() => assert.equal(finished.length, 1));
  assert.equal(finished[0]!.outcome, "ok");
  assert.equal(finished[0]!.route, "legacy");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(finished.length, 1, "one report per attempt");
});

test("removing a file mid-upload reports the attempt once, as cancelled", async () => {
  let uploadSignal: AbortSignal | undefined;
  const { fileInput } = setupComposer({
    upload: (signal) => {
      uploadSignal = signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  pickFile(fileInput, "two.txt");
  await waitFor(() => assert.ok(uploadSignal));
  assert.equal(finished.length, 0);

  fireEvent.click(screen.getByRole("button", { name: "Remove two.txt" }));
  await waitFor(() => assert.equal(finished.length, 1));
  assert.equal(uploadSignal?.aborted, true);
  assert.equal(finished[0]!.outcome, "cancelled");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert.equal(finished.length, 1, "one report per attempt");
});
