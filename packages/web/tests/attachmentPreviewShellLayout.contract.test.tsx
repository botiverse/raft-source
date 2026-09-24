import assert from "node:assert/strict";
import { resetAttachmentPreviewSummaryCache } from "../src/components/message/attachmentPreviewSummaryCache";
import { afterEach, test } from "node:test";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render as rtlRender, screen, waitFor } from "@testing-library/react";
import { TestIntlProvider } from "./helpers/intl";
const render: typeof rtlRender = (ui, options) => rtlRender(ui, { wrapper: TestIntlProvider, ...options });
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";

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
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
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
    createdAt: "2026-06-27T00:00:00.000Z",
  };
}

function makeMessage(): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content: "preview attachment",
    createdAt: "2026-06-27T00:00:00.000Z",
    attachments: [
      {
        id: "attachment-1",
        filename: "preview.md",
        mimeType: "text/markdown",
        sizeBytes: 128,
      },
    ],
  };
}

afterEach(() => {
  resetAttachmentPreviewSummaryCache();
  cleanup();
});

test("document attachment preview shell owns a fixed viewport scroll root", async () => {
  installBrowserStubs();
  const { default: api } = await import("../src/api/client");
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { default: DocumentPreviewHost } = await import("../src/components/message/DocumentPreviewHost");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const originalGet = api.get;

  api.get = (async (url: string) => {
    if (url === "/channels/channel-1/members") {
      return { data: { agents: [], humans: [] } };
    }
    assert.equal(url, "/attachments/attachment-1/preview");
    return {
      data: {
        status: "ok",
        data: {
          kind: "markdown",
          markdown: "# Preview Notes\n\nVisible body",
        },
        truncated: false,
      },
    };
  }) as typeof api.get;

  useAuthStore.setState({
    user: makeUser(),
    accessToken: "token",
    refreshToken: "refresh",
    loading: false,
    initialized: true,
  });
  useServerStore.setState({
    current: makeServer(),
    members: [] as ServerMember[],
  });
  useAgentStore.setState({
    agents: [] as Agent[],
    agentActivities: {},
  });
  useChannelStore.setState({
    dmChannels: [] as Channel[],
  });

  try {
    render(
      <MemoryRouter>
        <MessageItem
          message={makeMessage()}
          mentionMap={new Map()}
          channels={[]}
          hideThreadActions
        />
        <DocumentPreviewHost />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByLabelText("preview.md"));
    const previewRoot = await screen.findByTestId("attachment-preview-browser-find-scroll");
    await waitFor(() => assert.match(previewRoot.textContent ?? "", /Preview Notes/));
    assert.match(previewRoot.textContent ?? "", /preview\.md/);
    assert.doesNotMatch(previewRoot.textContent ?? "", /MARKDOWN PREVIEW/i);
    const className = previewRoot.getAttribute("class") ?? "";
    for (const token of [
      "fixed",
      "left-0",
      "right-0",
      "top-0",
      "h-[100dvh]",
      "w-screen",
      "max-w-[100dvw]",
      "overflow-x-clip",
      "overflow-y-auto",
    ]) {
      assert.match(
        className,
        new RegExp(`(^| )${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}( |$)`),
        `preview root should include ${token}`,
      );
    }
  } finally {
    api.get = originalGet;
  }
});

test("attachment preview shell exposes compact edge controls through the mounted UI", async () => {
  installBrowserStubs();
  const { AttachmentPreviewShell } = await import("../src/components/message/attachmentPreviewSurfaces");
  let closeCount = 0;
  let downloadCount = 0;

  render(
    <AttachmentPreviewShell
      filename="quarterly-plan.md"
      onClose={() => closeCount += 1}
      onDownload={() => downloadCount += 1}
    >
      <div>Preview body</div>
    </AttachmentPreviewShell>,
  );

  const filename = screen.getByText("quarterly-plan.md");
  const header = filename.parentElement?.parentElement?.parentElement;
  assert.ok(header, "preview header should wrap filename and controls");
  const headerClassName = header.getAttribute("class") ?? "";
  for (const token of ["safe-top", "safe-left", "absolute", "left-0", "right-0", "top-0"]) {
    assert.match(headerClassName, new RegExp(`(^| )${token}( |$)`));
  }
  assert.doesNotMatch(headerClassName, /(^| )safe-right( |$)/);

  const download = screen.getByRole("button", { name: "Download" });
  const close = screen.getByRole("button", { name: "Close" });
  for (const control of [download, close]) {
    assert.match(control.getAttribute("class") ?? "", /(^| )size-7( |$)/);
    const icon = control.querySelector("svg");
    assert.ok(icon);
    assert.equal(icon.getAttribute("width"), "14");
    assert.equal(icon.getAttribute("height"), "14");
  }

  fireEvent.click(download);
  fireEvent.click(close);
  assert.equal(downloadCount, 1);
  assert.equal(closeCount, 1);
});

test("attachment preview comment control is icon-only and exposes its open state", async () => {
  installBrowserStubs();
  const { AttachmentPreviewShell } = await import("../src/components/message/attachmentPreviewSurfaces");
  const { default: api } = await import("../src/api/client");
  const originalGet = api.get;
  api.get = (async (url: string) => {
    if (url === "/attachments/attachment-comments/comments") {
      return {
        data: {
          comments: [],
          threadChannelId: null,
          viewer: { canComment: false, reason: "read_only" },
        },
      };
    }
    if (url === "/channels/channel-comments/members") {
      return { data: { agents: [], humans: [] } };
    }
    throw new Error(`unexpected GET ${url}`);
  }) as typeof api.get;

  try {
    render(
      <MemoryRouter>
        <AttachmentPreviewShell
          filename="commentable.md"
          onClose={() => {}}
          onDownload={() => {}}
          comments={{
            attachmentId: "attachment-comments",
            filename: "commentable.md",
            commentCount: 0,
            parentMessage: {
              id: "message-comments",
              channelId: "channel-comments",
              senderId: "sender-comments",
              senderType: "user",
            },
          }}
        >
          <div>Preview body</div>
        </AttachmentPreviewShell>
      </MemoryRouter>,
    );

    const commentToggle = screen.getByRole("button", { name: "Comment" });
    assert.equal(commentToggle.textContent, "");
    assert.equal(commentToggle.getAttribute("aria-pressed"), "false");
    assert.equal(commentToggle.getAttribute("data-comments-open"), "false");
    assert.ok(commentToggle.querySelector("svg"));

    fireEvent.click(commentToggle);
    await waitFor(() => {
      assert.equal(commentToggle.getAttribute("aria-pressed"), "true");
      assert.equal(commentToggle.getAttribute("data-comments-open"), "true");
    });

    fireEvent.click(commentToggle);
    assert.equal(commentToggle.getAttribute("aria-pressed"), "false");
    assert.equal(commentToggle.getAttribute("data-comments-open"), "false");
  } finally {
    api.get = originalGet;
  }
});

test("attachment preview shell consumes Escape while mounted and removes the listener on unmount", async () => {
  installBrowserStubs();
  const { AttachmentPreviewShell } = await import("../src/components/message/attachmentPreviewSurfaces");
  let closeCount = 0;

  const mounted = render(
    <AttachmentPreviewShell
      filename="escape.md"
      onClose={() => closeCount += 1}
      onDownload={() => {}}
    >
      <div>Preview body</div>
    </AttachmentPreviewShell>,
  );

  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    cancelable: true,
  });
  document.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  assert.ok(closeCount >= 1, "Escape should close the active preview");

  const closedWhileMounted = closeCount;
  mounted.unmount();
  fireEvent.keyDown(document, { key: "Escape" });
  assert.equal(closeCount, closedWhileMounted, "unmounted previews must not retain global Escape handlers");
});
