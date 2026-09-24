import "./helpers/domSetup";

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import { TestIntlProvider } from "./helpers/intl";

function installLocalStorageStub() {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
}

afterEach(() => {
  cleanup();
});

test("quoted message previews request message context with parent channel context for thread permalinks", async () => {
  installLocalStorageStub();
  const { default: api } = await import("../src/api/client");
  const { default: QuotedMessagePermalinkPreview } = await import("../src/components/message/QuotedMessagePermalinkPreview");
  const originalGet = api.get;

  const calls: Array<{ url: string; config: unknown }> = [];
  api.get = ((url: string, config?: unknown) => {
    calls.push({ url, config });
    return new Promise(() => {});
  }) as typeof api.get;

  const permalink: ParsedRaftPermalink = {
    routeKind: "channel",
    serverSlug: "server",
    channelId: "joint-local-parent-channel",
    messageId: "reply-message-id",
    threadParentMessageId: "parent-message-id",
  };

  try {
    render(
      <TestIntlProvider>
        <QuotedMessagePermalinkPreview permalink={permalink} onOpen={() => {}} />
      </TestIntlProvider>,
    );

    await waitFor(() => assert.equal(calls.length, 1));
    assert.deepEqual(calls[0], {
      url: "/messages/context/reply-message-id",
      config: {
        params: { channelId: "joint-local-parent-channel" },
      },
    });
  } finally {
    api.get = originalGet;
  }
});

test("an unavailable quote reports upward and renders no empty preview card", async () => {
  installLocalStorageStub();
  const { default: api } = await import("../src/api/client");
  const { default: QuotedMessagePermalinkPreview } = await import("../src/components/message/QuotedMessagePermalinkPreview");
  const originalGet = api.get;
  let unavailableCount = 0;

  api.get = (async () => ({ data: { messages: [] } })) as typeof api.get;
  const permalink: ParsedRaftPermalink = {
    routeKind: "channel",
    serverSlug: "server",
    channelId: "channel-1",
    messageId: "missing-message",
    threadParentMessageId: null,
  };

  try {
    const { container } = render(
      <TestIntlProvider>
        <QuotedMessagePermalinkPreview
          permalink={permalink}
          onOpen={() => {}}
          onUnavailable={() => { unavailableCount += 1; }}
        />
      </TestIntlProvider>,
    );

    await waitFor(() => assert.equal(unavailableCount, 1));
    assert.equal(container.querySelector("[data-testid='quoted-message-card']"), null);
    assert.equal(container.textContent, "");
  } finally {
    api.get = originalGet;
  }
});
