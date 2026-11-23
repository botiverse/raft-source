import assert from "node:assert/strict";
import { act, cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
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

// #triage:#545: a large photo picked in the composer is resized before it is
// uploaded, and the chip, the upload body and the trace all describe the
// resized file. jsdom has no canvas: createImageBitmap / OffscreenCanvas are
// stubbed, so this covers the composer wiring, not the pixels.

const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
const CHANNEL_ID = "channel-upload-deadline";
const originalApiGet = api.get;
const originalApiPost = api.post;
const originalConsoleError = console.error;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const MiB = 1024 * 1024;
let objectUrls: Blob[] = [];
let revoked: string[] = [];
let finished: Array<Record<string, unknown>> = [];

beforeEach(() => {
  finished = [];
  objectUrls = [];
  revoked = [];
  URL.createObjectURL = (blob: Blob) => {
    objectUrls.push(blob);
    return `blob:test/${objectUrls.length}`;
  };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  vi.stubGlobal("createImageBitmap", async () => ({ width: 4032, height: 3024, close: () => {} }));
  vi.stubGlobal("OffscreenCanvas", class {
    constructor(public width: number, public height: number) {}
    getContext() {
      return { drawImage: () => {}, fillRect: () => {}, fillStyle: "", imageSmoothingEnabled: false, imageSmoothingQuality: "low" };
    }
    async convertToBlob(options: { type: string }) {
      return new Blob([new Uint8Array(MiB)], { type: options.type });
    }
  });
  __setUploadFinishedEmitterForTest((_name, attrs) => { finished.push(attrs); });
});

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
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
  upload: (body: unknown) => Promise<unknown>;
  addOptimisticMessage?: (message: Record<string, unknown>) => void;
}>) {
  console.error = () => {};
  api.post = (async (url: string, body?: unknown) => {
    if (url === "/attachments/upload") return options.upload(body);
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
    ...(options.addOptimisticMessage ? { addOptimisticMessage: options.addOptimisticMessage } : {}),
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

test("a 4 MiB JPEG is uploaded as its resized copy, and the chip and trace follow it", async () => {
  const uploaded: File[] = [];
  const { fileInput } = setupComposer({
    upload: async (body) => {
      uploaded.push((body as FormData).get("files") as File);
      return { data: { attachments: [{ id: "attachment-1" }] } };
    },
  });
  const photo = new File([new Uint8Array(4 * MiB)], "IMG_0001.jpg", { type: "image/jpeg", lastModified: 1_650_000_000_000 });
  fireEvent.change(fileInput, { target: { files: [photo] } });

  await waitFor(() => assert.equal(finished.length, 1));
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0]!.size, MiB);
  assert.equal(uploaded[0]!.type, "image/jpeg");
  assert.equal(uploaded[0]!.name, "IMG_0001.jpg");
  assert.equal(uploaded[0]!.lastModified, 1_650_000_000_000);

  // The chip's preview moved to the resized file; the original's URL was released.
  assert.equal(objectUrls[0], photo);
  assert.equal(objectUrls.at(-1), uploaded[0]);
  assert.ok(revoked.includes("blob:test/1"));

  assert.equal(finished[0]!.outcome, "ok");
  assert.equal(finished[0]!.resized, true);
  assert.equal(finished[0]!.resize_outcome, "resized");
  assert.equal(finished[0]!.resize_ratio_pct, 25);
});

test("a small JPEG and a large PNG are uploaded unchanged", async () => {
  const uploaded: File[] = [];
  const { fileInput } = setupComposer({
    upload: async (body) => {
      uploaded.push((body as FormData).get("files") as File);
      return { data: { attachments: [{ id: `attachment-${uploaded.length}` }] } };
    },
  });
  const small = new File([new Uint8Array(MiB)], "small.jpg", { type: "image/jpeg" });
  const png = new File([new Uint8Array(4 * MiB)], "big.png", { type: "image/png" });
  fireEvent.change(fileInput, { target: { files: [small, png] } });

  await waitFor(() => assert.equal(finished.length, 2));
  assert.deepEqual(uploaded.map((file) => [file.name, file.size]).sort(), [["big.png", 4 * MiB], ["small.jpg", MiB]]);
  assert.deepEqual(finished.map((attrs) => attrs.resized), [false, false]);
});

test("a new-thread reply sends the resized photo with a live preview in the optimistic message", async () => {
  // A pending thread queues its files and uploads them at send time; the
  // optimistic row is built after that upload, so it must describe the
  // resized file and must not point at the original's revoked blob URL.
  const uploaded: File[] = [];
  const optimistic: Array<Record<string, unknown>> = [];
  const { form, fileInput } = setupComposer({
    channelId: "pending-thread:parent-photo",
    resolveChannelId: async () => CHANNEL_ID,
    upload: async (body) => {
      uploaded.push((body as FormData).get("files") as File);
      return { data: { attachments: [{ id: "attachment-1" }] } };
    },
    addOptimisticMessage: (message) => { optimistic.push(message); },
  });
  const photo = new File([new Uint8Array(4 * MiB)], "IMG_0002.jpg", { type: "image/jpeg", lastModified: 1_650_000_000_000 });
  fireEvent.change(fileInput, { target: { files: [photo] } });
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove IMG_0002.jpg" })));
  assert.equal(uploaded.length, 0, "queued until send");

  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await waitFor(() => assert.equal(optimistic.length, 1));
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0]!.size, MiB);

  const [attachment] = optimistic[0]!.attachments as Array<Record<string, unknown>>;
  assert.equal(attachment!.sizeBytes, MiB, "the optimistic size is the uploaded size, so the server ack keeps the local preview");
  assert.equal(attachment!.filename, "IMG_0002.jpg");
  assert.equal(attachment!.width, 2560);
  assert.equal(attachment!.height, 1920);
  const previewUrl = attachment!.localPreviewUrl as string;
  assert.ok(previewUrl, "the optimistic row has a local preview");
  assert.equal(objectUrls[Number(previewUrl.split("/").at(-1)) - 1], uploaded[0], "the preview is the resized file");
  assert.ok(!revoked.includes(previewUrl), "the optimistic preview URL is still live");
});
