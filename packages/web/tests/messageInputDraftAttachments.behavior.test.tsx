import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act } from "react";
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import { MemoryRouter } from "react-router-dom";
import api from "../src/api/client";
import MessageInput, { clearDraftPendingFilesForTests } from "../src/components/message/MessageInput";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import { useImageLightboxStore } from "../src/store/imageLightboxStore";
import { useMessageStore } from "../src/store/messageStore";
import type { SendMessageResult } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";

const CHANNEL_ID = "channel-draft-attachments";
const OTHER_CHANNEL_ID = "channel-other";

const originalApiGet = api.get;
const originalApiPost = api.post;
const originalApiDelete = api.delete;
const originalXMLHttpRequest = globalThis.XMLHttpRequest;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

type DirectUploadXhrRecord = {
  requestMethod: string;
  requestUrl: string;
  requestHeaders: Record<string, string>;
  requestBodySize: number;
  requestBodyType: string;
  withCredentials: boolean;
  progressBytes: number[];
  reportProgress: (loaded: number) => void;
  aborted: boolean;
};

function xhrProgressEvent(
  type: string,
  init: { loaded?: number; total?: number; lengthComputable?: boolean } = {},
): ProgressEvent {
  const event = new Event(type);
  Object.defineProperties(event, {
    loaded: { value: init.loaded ?? 0 },
    total: { value: init.total ?? 0 },
    lengthComputable: { value: init.lengthComputable ?? false },
  });
  return event as ProgressEvent;
}

function installDirectUploadXhr(mode: "success" | "pending"): DirectUploadXhrRecord[] {
  const requests: DirectUploadXhrRecord[] = [];
  class DirectUploadXhr extends EventTarget {
    readonly upload = new EventTarget();
    readyState = 0;
    status = 0;
    statusText = "";
    responseText = "";
    response: unknown = null;
    responseURL = "";
    responseType: XMLHttpRequestResponseType = "";
    timeout = 0;
    withCredentials = false;
    onloadend: ((event: ProgressEvent) => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    onabort: ((event: ProgressEvent) => void) | null = null;
    onerror: ((event: ProgressEvent) => void) | null = null;
    ontimeout: ((event: ProgressEvent) => void) | null = null;
    private method = "";
    private url = "";
    private readonly headers: Record<string, string> = {};
    private record: DirectUploadXhrRecord | null = null;

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
      this.readyState = 1;
    }

    setRequestHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    }

    getAllResponseHeaders(): string {
      return "";
    }

    send(body: Document | XMLHttpRequestBodyInit | null): void {
      assert.ok(body instanceof File, "Axios XHR adapter must pass the original File");
      let record: DirectUploadXhrRecord;
      record = {
        requestMethod: this.method,
        requestUrl: this.url,
        requestHeaders: { ...this.headers },
        requestBodySize: body.size,
        requestBodyType: body.type,
        withCredentials: this.withCredentials,
        progressBytes: [],
        reportProgress: (loaded) => {
          record.progressBytes.push(loaded);
          this.upload.dispatchEvent(xhrProgressEvent("progress", {
            lengthComputable: true,
            loaded,
            total: body.size,
          }));
        },
        aborted: false,
      };
      this.record = record;
      requests.push(record);
      if (mode === "pending") return;
      record.reportProgress(Math.max(1, Math.floor(body.size / 2)));
      record.reportProgress(body.size);
      this.upload.dispatchEvent(xhrProgressEvent("loadend"));
      this.status = 200;
      this.statusText = "OK";
      this.readyState = 4;
      this.onloadend?.(xhrProgressEvent("loadend"));
    }

    abort(): void {
      if (this.record) this.record.aborted = true;
      this.onabort?.(xhrProgressEvent("abort"));
    }
  }
  globalThis.XMLHttpRequest = DirectUploadXhr as unknown as typeof XMLHttpRequest;
  return requests;
}

function renderComposer(
  channelId: string,
  variant: ComponentProps<typeof MessageInput>["variant"] = "full",
  overrides: Partial<ComponentProps<typeof MessageInput>> = {},
) {
  return (
    <MemoryRouter>
      <MessageInput
        channelId={channelId}
        channelName={channelId === CHANNEL_ID ? "#general" : "#other"}
        variant={variant}
        {...overrides}
      />
    </MemoryRouter>
  );
}

function makeAuthUser(id: string) {
  return {
    id,
    email: `${id}@example.com`,
    gravatarHash: "",
    name: id,
    displayName: `User ${id}`,
    description: null,
    avatarUrl: null,
    emailVerified: true,
    preferredLanguage: null,
    preferredTimezone: null,
    autoTranslationEnabled: false,
    preferredTranslationMode: "manual" as const,
    preferredTranslationDisplay: "translated" as const,
    preferredTimeFormat: null,
    preferredMessageBodyFontSize: null,
    referralSource: null,
    referralSourceOther: null,
    referralSourceSkippedAt: null,
  };
}

function setupComposer(
  sendMessage: ReturnType<typeof makeSendSpy>,
  options: {
    channelId?: string;
    variant?: ComponentProps<typeof MessageInput>["variant"];
    userId?: string;
    overrides?: Partial<ComponentProps<typeof MessageInput>>;
  } = {},
) {
  api.get = (async (url: string) => (
    url === "/attachments/upload-capabilities"
      ? {
          data: {
            directUploadEnabled: false,
            directUploadThresholdBytes: null,
            maxBytes: 50 * 1024 * 1024,
            sessionExpiresInSeconds: null,
          },
        }
      : { data: { agents: [], humans: [] } }
  )) as typeof api.get;
  const channelId = options.channelId ?? CHANNEL_ID;
  const userId = options.userId ?? "user-1";

  useAuthStore.setState({
    user: makeAuthUser(userId),
  } as never);
  useServerStore.setState({
    current: {
      id: "server-1",
      name: "Server",
      slug: "server",
      ownerId: userId,
      onboardingAgentId: null,
      hideHumansFromMembers: false,
      plan: "free",
      planDowngradedAt: null,
      role: "owner",
      createdAt: "2026-07-09T00:00:00.000Z",
    },
    members: [],
  } as never);
  useChannelStore.setState({
    channels: [
      {
        id: CHANNEL_ID,
        serverId: "server-1",
        name: "general",
        type: "regular",
        description: null,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        isDefault: false,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
      {
        id: OTHER_CHANNEL_ID,
        serverId: "server-1",
        name: "other",
        type: "regular",
        description: null,
        archived: false,
        archivedAt: null,
        archivedBy: null,
        isDefault: false,
        createdAt: "2026-07-09T00:00:00.000Z",
      },
    ],
    dmChannels: [],
  } as never);
  useMessageStore.setState({
    drafts: {},
    channelMessages: { [CHANNEL_ID]: [], [OTHER_CHANNEL_ID]: [] },
    currentChannelId: channelId,
    messages: [],
    sendMessage,
  } as never);

  const view = render(
    renderComposer(channelId, options.variant, options.overrides),
  );
  const fileInput = view.container.querySelector('input[type="file"][accept]') as HTMLInputElement | null;
  if ((options.variant ?? "full") === "full") {
    assert.ok(fileInput, "media picker input should render");
  }
  const textarea = screen.getByPlaceholderText(channelId === CHANNEL_ID ? "Message #general" : "Message #other") as HTMLTextAreaElement;
  const form = textarea.closest("form");
  assert.ok(form, "composer should render inside a form");
  return { ...view, fileInput, form };
}

function makeSendSpy() {
  const calls: Array<{ content: string; attachmentIds: string[] }> = [];
  const send = async (
    _channelId: string,
    content: string,
    attachmentIds: string[] = [],
  ): Promise<SendMessageResult> => {
    calls.push({ content, attachmentIds });
    return { messageId: `message-${calls.length}`, pendingMentionActions: [], unresolvedMentionHandles: [] };
  };
  return Object.assign(send, { calls });
}

async function attachImage(fileInput: HTMLInputElement, name = "draft.png") {
  const file = new File(["image-bytes"], name, { type: "image/png" });
  await act(async () => {
    fireEvent.change(fileInput, { target: { files: [file] } });
  });
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  cleanup();
  clearDraftPendingFilesForTests();
  api.get = originalApiGet;
  api.post = originalApiPost;
  api.delete = originalApiDelete;
  globalThis.XMLHttpRequest = originalXMLHttpRequest;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useChannelStore.setState(useChannelStore.getInitialState(), true);
  useImageLightboxStore.setState(useImageLightboxStore.getInitialState(), true);
  useMessageStore.setState(useMessageStore.getInitialState(), true);
});

test("normal composer restores ready draft attachments after remount and clears them on send", async () => {
  URL.createObjectURL = (() => "blob:draft-ready") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      return { data: { attachments: [{ id: "attachment-ready-1" }] } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  const sendMessage = makeSendSpy();

  const first = setupComposer(sendMessage);
  await attachImage(first.fileInput!, "draft-ready.png");
  const preview = await screen.findByRole("button", { name: "Preview draft-ready.png" });
  fireEvent.click(preview);
  assert.equal(useImageLightboxStore.getState().isOpen, true);
  assert.deepEqual(
    useImageLightboxStore.getState().images.map(({ id, filename, localPreviewUrl }) => ({
      id,
      filename,
      localPreviewUrl,
    })),
    [{
      id: "attachment-ready-1",
      filename: "draft-ready.png",
      localPreviewUrl: "blob:draft-ready",
    }],
  );
  useImageLightboxStore.getState().close();
  first.unmount();

  const second = setupComposer(sendMessage);
  await waitFor(() => screen.getByRole("button", { name: "Preview draft-ready.png" }));
  await submitForm(second.form);

  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  assert.deepEqual(sendMessage.calls[0], { content: "[1 attachment]", attachmentIds: ["attachment-ready-1"] });
  assert.equal((screen.getByPlaceholderText("Message #general") as HTMLTextAreaElement).value, "");
  second.unmount();

  setupComposer(sendMessage);
  assert.equal(screen.queryByRole("button", { name: "Preview draft-ready.png" }), null);
});

test("normal composer clears draft attachments and revokes previews across auth sessions", async () => {
  const revoked: string[] = [];
  URL.createObjectURL = (() => "blob:draft-user-a") as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  api.post = (async (url: string) => {
    if (url === "/attachments/upload") {
      return { data: { attachments: [{ id: "attachment-user-a" }] } };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  const sendMessage = makeSendSpy();

  const first = setupComposer(sendMessage, { userId: "user-a" });
  await attachImage(first.fileInput!, "draft-user-a.png");
  await waitFor(() => screen.getByRole("button", { name: "Preview draft-user-a.png" }));

  act(() => {
    useAuthStore.setState({ user: null } as never);
    first.unmount();
  });

  setupComposer(sendMessage, { userId: "user-a" });
  assert.equal(screen.queryByRole("button", { name: "Preview draft-user-a.png" }), null);
  cleanup();

  act(() => {
    useAuthStore.setState({ user: makeAuthUser("user-b") } as never);
  });

  setupComposer(sendMessage, { userId: "user-b" });
  assert.equal(screen.queryByRole("button", { name: "Preview draft-user-a.png" }), null);
  assert.ok(revoked.includes("blob:draft-user-a"), "old auth session preview URL should be revoked");
});

test("normal composer restores interrupted uploads as retryable draft attachments", async () => {
  URL.createObjectURL = (() => "blob:draft-uploading") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  let uploadAttempts = 0;
  api.post = (async (url: string) => {
    if (url !== "/attachments/upload") throw new Error(`unexpected POST ${url}`);
    uploadAttempts += 1;
    if (uploadAttempts === 1) return await new Promise(() => {});
    return { data: { attachments: [{ id: "attachment-retry-1" }] } };
  }) as typeof api.post;
  const sendMessage = makeSendSpy();

  const first = setupComposer(sendMessage);
  await attachImage(first.fileInput!, "draft-retry.png");
  await waitFor(() => screen.getByText("Uploading"));
  first.unmount();

  setupComposer(sendMessage);
  const retry = await screen.findByRole("button", { name: "Retry uploading draft-retry.png" });
  assert.equal(uploadAttempts, 1);

  await act(async () => {
    fireEvent.click(retry);
  });

  await waitFor(() => screen.getByRole("button", { name: "Preview draft-retry.png" }));
  assert.equal(uploadAttempts, 2);
});

test("a channel switch stops an unresolved attachment check from writing into the next composer", async () => {
  URL.createObjectURL = (() => "blob:draft-validating") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const sendMessage = makeSendSpy();
  const view = setupComposer(sendMessage);
  let finishCapability: (value: { data: { directUploadEnabled: false; directUploadThresholdBytes: null; sessionExpiresInSeconds: null; maxBytes: number } }) => void = () => {};
  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      return await new Promise((resolve) => {
        finishCapability = resolve;
      });
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;

  await attachImage(view.fileInput!, "draft-checking.png");
  assert.ok(screen.getByText("Checking file…"));

  await act(async () => {
    view.rerender(renderComposer(OTHER_CHANNEL_ID));
  });
  assert.equal(screen.queryByText("draft-checking.png"), null);

  await act(async () => {
    finishCapability({
      data: {
        directUploadEnabled: false,
        directUploadThresholdBytes: null,
        sessionExpiresInSeconds: null,
        maxBytes: 50 * 1024 * 1024,
      },
    });
  });
  assert.equal(screen.queryByText("draft-checking.png"), null);

  await act(async () => {
    view.rerender(renderComposer(CHANNEL_ID));
  });
  assert.ok(await screen.findByText("File checking was interrupted. Remove it and attach again."));
  assert.equal(screen.queryByRole("button", { name: "Retry uploading draft-checking.png" }), null);
  assert.ok(screen.getByRole("button", { name: "Remove draft-checking.png" }));
});

test("normal composer preserves interrupted uploads when switching channels", async () => {
  URL.createObjectURL = (() => "blob:draft-channel-switch") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  let uploadAttempts = 0;
  let aborts = 0;
  api.post = (async (url: string, _body?: unknown, config?: { signal?: AbortSignal }) => {
    if (url !== "/attachments/upload") throw new Error(`unexpected POST ${url}`);
    uploadAttempts += 1;
    config?.signal?.addEventListener("abort", () => {
      aborts += 1;
    });
    if (uploadAttempts === 1) return await new Promise(() => {});
    return { data: { attachments: [{ id: "attachment-channel-retry" }] } };
  }) as typeof api.post;
  const sendMessage = makeSendSpy();

  const view = setupComposer(sendMessage);
  await attachImage(view.fileInput!, "draft-channel.png");
  await waitFor(() => screen.getByText("Uploading"));

  await act(async () => {
    view.rerender(renderComposer(OTHER_CHANNEL_ID));
  });
  assert.equal(aborts, 1);
  assert.equal(screen.queryByRole("button", { name: "Retry uploading draft-channel.png" }), null);

  await act(async () => {
    view.rerender(renderComposer(CHANNEL_ID));
  });
  const retry = await screen.findByRole("button", { name: "Retry uploading draft-channel.png" });
  assert.equal(uploadAttempts, 1);

  await act(async () => {
    fireEvent.click(retry);
  });

  await waitFor(() => screen.getByRole("button", { name: "Preview draft-channel.png" }));
  assert.equal(uploadAttempts, 2);
});

test("lazy thread adopts its pending text and attachment draft when the first external reply creates the durable channel", async () => {
  const pendingChannelId = "pending-thread:parent-adoption";
  const durableChannelId = "thread-channel-adoption";
  URL.createObjectURL = (() => "blob:draft-adoption") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  api.post = (async (url: string) => {
    throw new Error(`pending lazy-thread attachment must not upload during adoption: ${url}`);
  }) as typeof api.post;
  const sendMessage = makeSendSpy();
  const view = setupComposer(sendMessage, {
    channelId: pendingChannelId,
    overrides: { resolveChannelId: async () => durableChannelId },
  });
  const textarea = screen.getByPlaceholderText("Message #other") as HTMLTextAreaElement;

  fireEvent.change(textarea, { target: { value: "unsent draft survives first reply" } });
  await attachImage(view.fileInput!, "draft-adoption.png");
  await waitFor(() => screen.getByAltText("draft-adoption.png"));
  await waitFor(() => assert.equal(
    useMessageStore.getState().drafts[pendingChannelId],
    "unsent draft survives first reply",
  ));

  act(() => {
    useMessageStore.getState().setDraft(durableChannelId, "older durable draft");
  });
  await act(async () => {
    view.rerender(renderComposer(durableChannelId, "full", {
      migrateDraftFromChannelId: pendingChannelId,
    }));
  });

  assert.equal(textarea.value, "unsent draft survives first reply");
  assert.equal(useMessageStore.getState().drafts[pendingChannelId], undefined);
  assert.equal(
    useMessageStore.getState().drafts[durableChannelId],
    "unsent draft survives first reply",
    "the actively typed pending draft must win over a stale durable slot during live adoption",
  );
  assert.ok(screen.getByAltText("draft-adoption.png"));

  await act(async () => {
    view.rerender(renderComposer(durableChannelId, "full", {
      migrateDraftFromChannelId: pendingChannelId,
    }));
  });
  assert.equal(textarea.value, "unsent draft survives first reply");
  assert.ok(screen.getByAltText("draft-adoption.png"));
});

test("live thread adoption keeps an intentionally empty pending composer from resurrecting a stale durable draft", async () => {
  const pendingChannelId = "pending-thread:parent-cleared";
  const durableChannelId = "thread-channel-cleared";
  const sendMessage = makeSendSpy();
  const view = setupComposer(sendMessage, { channelId: pendingChannelId });

  act(() => {
    useMessageStore.getState().setDraft(durableChannelId, "stale durable draft");
  });
  await act(async () => {
    view.rerender(renderComposer(durableChannelId, "full", {
      migrateDraftFromChannelId: pendingChannelId,
    }));
  });

  const textarea = screen.getByPlaceholderText("Message #other") as HTMLTextAreaElement;
  assert.equal(textarea.value, "");
  assert.equal(useMessageStore.getState().drafts[pendingChannelId], undefined);
  assert.equal(useMessageStore.getState().drafts[durableChannelId], undefined);
});

test("normal composer direct-uploads a selected file and sends exactly the completed attachment", async () => {
  URL.createObjectURL = (() => "blob:direct-ready") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const postCalls: Array<{ url: string; body: unknown }> = [];
  const putCalls = installDirectUploadXhr("success");
  const sendMessage = makeSendSpy();
  const view = setupComposer(sendMessage);

  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      return {
        data: {
          directUploadEnabled: true,
          directUploadThresholdBytes: 1,
          maxBytes: 50 * 1024 * 1024,
          sessionExpiresInSeconds: 900,
        },
      };
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;
  api.post = (async (url: string, body?: unknown) => {
    postCalls.push({ url, body });
    if (url === "/attachments/upload-sessions") {
      return {
        data: {
          uploadId: "upload-direct-1",
          attachmentId: "attachment-direct-1",
          state: "pending",
          expiresAt: "2026-08-01T09:00:00.000Z",
          upload: {
            method: "PUT",
            url: "https://objects.example.test/private-signed-value",
            headers: { "Content-Type": "image/png", "If-None-Match": "*" },
          },
        },
      };
    }
    if (url === "/attachments/upload-sessions/upload-direct-1/complete") {
      return {
        data: {
          uploadId: "upload-direct-1",
          state: "completed",
          attachment: {
            id: "attachment-direct-1",
            filename: "direct.png",
            mimeType: "image/png",
            sizeBytes: 11,
            thumbnailUrl: null,
          },
        },
      };
    }
    throw new Error(`unexpected POST ${url}`);
  }) as typeof api.post;
  await attachImage(view.fileInput!, "direct.png");
  await waitFor(() => screen.getByRole("button", { name: "Preview direct.png" }));
  await submitForm(view.form);

  await waitFor(() => assert.equal(sendMessage.calls.length, 1));
  assert.deepEqual(sendMessage.calls[0], {
    content: "[1 attachment]",
    attachmentIds: ["attachment-direct-1"],
  });
  assert.equal(postCalls.some((call) => call.url === "/attachments/upload"), false);
  assert.equal(postCalls.filter((call) => call.url === "/attachments/upload-sessions").length, 1);
  assert.equal(postCalls.filter((call) => call.url.endsWith("/complete")).length, 1);
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0]!.requestMethod, "PUT");
  assert.equal(putCalls[0]!.requestUrl, "https://objects.example.test/private-signed-value");
  assert.equal(putCalls[0]!.requestBodySize, 11);
  assert.equal(putCalls[0]!.requestBodyType, "image/png");
  assert.equal(putCalls[0]!.withCredentials, false);
  assert.ok(putCalls[0]!.progressBytes.some((loaded) => loaded > 0 && loaded <= 11));
  assert.equal(putCalls[0]!.requestHeaders["content-type"], "image/png");
  assert.equal(putCalls[0]!.requestHeaders["if-none-match"], "*");
  assert.equal(putCalls[0]!.requestHeaders.authorization, undefined);
});

test("normal composer shows direct-upload byte progress before the PUT completes", async () => {
  URL.createObjectURL = (() => "blob:direct-progress") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const putCalls = installDirectUploadXhr("pending");
  const sendMessage = makeSendSpy();
  const view = setupComposer(sendMessage);

  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      return {
        data: {
          directUploadEnabled: true,
          directUploadThresholdBytes: 1,
          maxBytes: 50 * 1024 * 1024,
          sessionExpiresInSeconds: 900,
        },
      };
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url !== "/attachments/upload-sessions") throw new Error(`unexpected POST ${url}`);
    return {
      data: {
        uploadId: "upload-progress-1",
        attachmentId: "attachment-progress-1",
        state: "pending",
        expiresAt: "2026-08-01T09:00:00.000Z",
        upload: {
          method: "PUT",
          url: "https://objects.example.test/private-progress-value",
          headers: { "Content-Type": "image/png", "If-None-Match": "*" },
        },
      },
    };
  }) as typeof api.post;

  await attachImage(view.fileInput!, "progress.png");

  await waitFor(() => assert.equal(putCalls.length, 1));
  await waitFor(() => screen.getByText("Uploading"));
  await act(async () => {
    putCalls[0]!.reportProgress(5);
  });
  await waitFor(() => assert.ok(screen.getByText("45%")));
  assert.deepEqual(putCalls[0]!.progressBytes, [5]);
  assert.equal(sendMessage.calls.length, 0);
  view.unmount();
});

test("removing an in-flight direct upload aborts PUT and cancels its session", async () => {
  URL.createObjectURL = (() => "blob:direct-cancel") as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
  const deleted: string[] = [];
  const sendMessage = makeSendSpy();
  const view = setupComposer(sendMessage);

  api.get = (async (url: string) => {
    if (url === "/attachments/upload-capabilities") {
      return {
        data: {
          directUploadEnabled: true,
          directUploadThresholdBytes: 1,
          maxBytes: 50 * 1024 * 1024,
          sessionExpiresInSeconds: 900,
        },
      };
    }
    return { data: { agents: [], humans: [] } };
  }) as typeof api.get;
  api.post = (async (url: string) => {
    if (url !== "/attachments/upload-sessions") throw new Error(`unexpected POST ${url}`);
    return {
      data: {
        uploadId: "upload-cancel-1",
        attachmentId: "attachment-cancel-1",
        state: "pending",
        expiresAt: "2026-08-01T09:00:00.000Z",
        upload: {
          method: "PUT",
          url: "https://objects.example.test/private-cancel-value",
          headers: { "Content-Type": "image/png", "If-None-Match": "*" },
        },
      },
    };
  }) as typeof api.post;
  api.delete = (async (url: string) => {
    deleted.push(url);
    return { data: {} };
  }) as typeof api.delete;
  const putCalls = installDirectUploadXhr("pending");

  await attachImage(view.fileInput!, "cancel.png");
  await waitFor(() => assert.ok(screen.getByRole("button", { name: "Remove cancel.png" })));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Remove cancel.png" }));
  });

  await waitFor(() => assert.equal(putCalls.length, 1));
  await waitFor(() => assert.equal(putCalls[0]!.aborted, true));
  await waitFor(() => assert.deepEqual(deleted, ["/attachments/upload-sessions/upload-cancel-1"]));
  assert.equal(screen.queryByAltText("cancel.png"), null);
  assert.equal(sendMessage.calls.length, 0);
});
