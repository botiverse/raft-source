import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { Component, act } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { cleanup, render as rtlRender } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Agent } from "../src/store/agentStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import type { Server, ServerMember } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

const render: typeof rtlRender = (ui, options) =>
  rtlRender(ui, { wrapper: TestIntlProvider, ...options });

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
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const { default: MessageItem } = await import("../src/components/message/MessageItem");
const { useAgentStore } = await import("../src/store/agentStore");
const { useAuthStore } = await import("../src/store/authStore");
const { useChannelStore } = await import("../src/store/channelStore");
const { useServerStore } = await import("../src/store/serverStore");

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
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

function makeMessage(content: string): Message {
  return {
    id: "message-1",
    channelId: "channel-1",
    senderType: "user",
    senderId: "user-1",
    senderName: "Current User",
    messageType: "chat",
    content,
    createdAt: "2026-07-30T00:00:00.000Z",
  };
}

function resetStores(): void {
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
}

function MessageProbe({ content }: { content: string }) {
  return (
    <MemoryRouter>
      <MessageItem
        message={makeMessage(content)}
        mentionMap={new Map()}
        channels={[]}
        hideThreadActions
      />
    </MemoryRouter>
  );
}

class RootProbeBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {}

  render() {
    return this.state.error
      ? <div data-root-probe-fallback="" />
      : this.props.children;
  }
}

beforeEach(resetStores);
afterEach(cleanup);

test("MessageItem custom link overrides retain the closest translation guard", () => {
  const { container } = render(
    <MessageProbe content="see [example](https://example.com)" />,
  );

  const markdownRoot = container.querySelector<HTMLElement>("[data-raft-markdown-content]");
  const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com"]');
  assert.ok(markdownRoot);
  assert.ok(link);
  assert.equal(markdownRoot.getAttribute("translate"), "no");
  assert.equal(markdownRoot.classList.contains("notranslate"), true);
  assert.equal(markdownRoot.getAttribute("data-immersive-translate-ignore"), "");

  const overrideGuard = link.closest<HTMLElement>(
    'span[translate="no"][data-immersive-translate-ignore]',
  );
  assert.ok(overrideGuard, "the MessageItem anchor override must keep a leaf-local guard");
  assert.equal(overrideGuard.classList.contains("notranslate"), true);
  assert.equal(overrideGuard.classList.contains("contents"), true);
});

test("external MessageItem anchor reparent failures stay inside MarkdownContent", async () => {
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalInsertBefore = Node.prototype.insertBefore;
  console.warn = () => {};
  console.error = () => {};

  try {
    const view = render(
      <RootProbeBoundary>
        <MessageProbe content="> before [link](https://example.com) after" />
      </RootProbeBoundary>,
    );
    const paragraph = view.container.querySelector("blockquote p");
    const link = view.container.querySelector("blockquote p a");
    assert.ok(paragraph);
    assert.ok(link);

    const extensionWrapper = document.createElement("font");
    extensionWrapper.setAttribute("data-translator-wrapper", "");
    const linkOwner = link.parentElement;
    assert.ok(linkOwner);
    linkOwner.insertBefore(extensionWrapper, link);
    extensionWrapper.appendChild(link);
    assert.equal(link.parentElement, extensionWrapper, "the external reparent control must be real");

    let injectedDomFailure = false;
    Node.prototype.insertBefore = function patchedInsertBefore<T extends Node>(
      node: T,
      child: Node | null,
    ): T {
      if (
        !injectedDomFailure
        && this instanceof Element
        && this.closest("[data-raft-markdown-content]")
      ) {
        injectedDomFailure = true;
        throw new DOMException(
          "Failed to execute 'insertBefore' on 'Node': The node before which the new node is to be inserted is not a child of this node.",
          "NotFoundError",
        );
      }
      return originalInsertBefore.call(this, node, child) as T;
    };

    try {
      await act(async () => {
        view.rerender(
          <RootProbeBoundary>
            <MessageProbe content="> before **inserted** [link](https://example.com) after" />
          </RootProbeBoundary>,
        );
      });
    } catch (error) {
      throw new Error(
        `Message rerender escaped the Markdown boundary: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        { cause: error },
      );
    }

    assert.equal(injectedDomFailure, true, "the deterministic external-placement RED must fire");
    assert.equal(view.container.querySelector("[data-root-probe-fallback]"), null);
    const fallback = view.container.querySelector<HTMLElement>("[data-markdown-dom-fallback]");
    assert.ok(fallback, "the mutated message must fall back locally instead of blanking the app");
    assert.match(
      fallback.textContent ?? "",
      /before \*\*inserted\*\* \[link\]\(https:\/\/example\.com\) after/,
    );
    assert.equal(fallback.getAttribute("translate"), "no");
    assert.equal(fallback.classList.contains("notranslate"), true);
    assert.equal(fallback.getAttribute("data-immersive-translate-ignore"), "");
  } finally {
    Node.prototype.insertBefore = originalInsertBefore;
    console.warn = originalWarn;
    console.error = originalError;
  }
});
