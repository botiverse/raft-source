import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type Message = import("../src/store/messageStore.js").Message;

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: new MemoryStorage(),
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: new MemoryStorage(),
});

const { normalizePendingMentionActions, normalizeSendMessageResponse } = await import("../src/store/messageStore.js");
const { PendingMentionActionStrip } = await import("../src/components/message/PendingMentionActionStrip");
const { TestIntlProvider } = await import("./helpers/intl");

const baseMessage: Message = {
  id: "message-1",
  channelId: "channel-1",
  senderType: "user",
  senderId: "user-1",
  content: "hello",
  createdAt: "2026-06-11T00:00:00.000Z",
};

test("send response normalizer accepts bare message and wrapped pending-actions responses", () => {
  assert.deepEqual(normalizeSendMessageResponse(baseMessage), {
    message: baseMessage,
    pendingMentionActions: [],
    unresolvedMentionHandles: [],
  });

  assert.deepEqual(normalizeSendMessageResponse({
    message: baseMessage,
    pendingMentionActions: [{
      resolutionId: "r-1",
      messageId: "message-1",
      targetType: "agent",
      targetHandle: "@Noel",
      reason: "not in channel",
      availableActions: ["notify", "add"],
      expiresAt: "2026-06-12T00:00:00.000Z",
    }],
  }), {
    message: baseMessage,
    pendingMentionActions: [{
      resolutionId: "r-1",
      messageId: "message-1",
      targetType: "agent",
      targetHandle: "@Noel",
      targetAvatarUrl: null,
      reason: "not in channel",
      availableActions: ["notify", "add"],
      expiresAt: "2026-06-12T00:00:00.000Z",
    }],
    unresolvedMentionHandles: [],
  });

  assert.deepEqual(normalizeSendMessageResponse({
    message: baseMessage,
    unresolvedMentionHandles: ["@same_handle", 42, null],
  }), {
    message: baseMessage,
    pendingMentionActions: [],
    unresolvedMentionHandles: ["@same_handle"],
  });
});

test("pending action normalizer drops malformed rows and supplies safe defaults", () => {
  assert.deepEqual(normalizePendingMentionActions([
    { id: "r-1", targetHandle: "@Noel", targetAvatarUrl: "pixel:random:Noel" },
    { id: "r-2", targetHandle: "@BlankAvatar", targetAvatarUrl: "   " },
    { targetHandle: "@MissingId" },
  ]), [
    {
      resolutionId: "r-1",
      messageId: "",
      targetType: "unknown",
      targetHandle: "@Noel",
      targetAvatarUrl: "pixel:random:Noel",
      reason: "Mention target was not notified at send time.",
      availableActions: [],
      expiresAt: null,
    },
    {
      resolutionId: "r-2",
      messageId: "",
      targetType: "unknown",
      targetHandle: "@BlankAvatar",
      targetAvatarUrl: null,
      reason: "Mention target was not notified at send time.",
      availableActions: [],
      expiresAt: null,
    },
  ]);
});

test("PendingMentionActionStrip renders flush with the composer width", () => {
  const html = renderToStaticMarkup(
    createElement(TestIntlProvider, null,
      createElement(PendingMentionActionStrip, {
        actions: [{
          resolutionId: "resolution-1",
          messageId: "message-1",
          targetType: "agent",
          targetHandle: "Android-Settings-Integrator",
          targetAvatarUrl: "pixel:random:Android-Settings-Integrator",
          reason: "not in channel",
          availableActions: ["add", "notify"],
          expiresAt: null,
        }],
        actionState: {},
        actionRemoving: {},
        actionExecuting: {},
        channelName: "thread",
        onMarkAction: () => undefined,
        onDismissAction: () => undefined,
      }),
    ),
  );

  const rootClass = html.match(/data-testid="pending-mention-action-strip" class="([^"]+)"/)?.[1]
    ?? html.match(/class="([^"]+)" data-testid="pending-mention-action-strip"/)?.[1]
    ?? "";

  assert.ok(rootClass, "strip root should render a class contract");
  assert.match(rootClass, /\bw-full\b/);
  assert.match(rootClass, /\bbg-brutal-cream\b/);
  assert.doesNotMatch(rootClass, /\bbg-soft-signal\b/);
  assert.doesNotMatch(rootClass, /\bml-12\b/);
  assert.doesNotMatch(rootClass, /\bmr-2\b/);
  assert.doesNotMatch(html, /Undelivered mentions/);
  assert.doesNotMatch(html, /Message sent, but these @mentions were not delivered/);
  assert.match(html, /@Android-Settings-Integrator/);
  assert.match(html, /pending-mention-target-avatar/);
  assert.doesNotMatch(html, /pending-mention-target-initial/);
  assert.match(html, /was not notified because they are not in #thread/);
  assert.match(html, />Add</);
  assert.match(html, />Notify</);
  assert.match(html, />Ignore</);
});

test("PendingMentionActionStrip renders completed and removing states", () => {
  const action = {
    resolutionId: "resolution-1",
    messageId: "message-1",
    targetType: "agent",
    targetHandle: "Noel",
    reason: "not in channel",
    availableActions: ["add", "notify"],
    expiresAt: null,
  };
  const renderStrip = (props: {
    actionState?: Record<string, "added" | "notified">;
    actionRemoving?: Record<string, boolean>;
    actionExecuting?: Record<string, "added" | "notified">;
  } = {}) => renderToStaticMarkup(
    createElement(TestIntlProvider, null,
      createElement(PendingMentionActionStrip, {
        actions: [action],
        actionState: props.actionState ?? {},
        actionRemoving: props.actionRemoving ?? {},
        actionExecuting: props.actionExecuting ?? {},
        channelName: "launch",
        onMarkAction: () => undefined,
        onDismissAction: () => undefined,
      }),
    ),
  );

  const defaultHtml = renderStrip();
  assert.match(defaultHtml, />Add</);
  assert.match(defaultHtml, />Notify</);
  assert.match(defaultHtml, />Ignore</);
  assert.match(defaultHtml, /opacity-100/);
  assert.match(defaultHtml, /@Noel was not notified because they are not in #launch/);

  const addedHtml = renderStrip({ actionState: { "resolution-1": "added" } });
  assert.match(addedHtml, />Added</);
  assert.match(addedHtml, /@Noel was added to #launch/);
  assert.doesNotMatch(addedHtml, />Add</);

  const notifiedHtml = renderStrip({ actionState: { "resolution-1": "notified" } });
  assert.match(notifiedHtml, />Queued</);
  assert.match(notifiedHtml, /Notification queued for @Noel · still not in #launch/);
  assert.doesNotMatch(notifiedHtml, />Notify</);

  const removingHtml = renderStrip({ actionRemoving: { "resolution-1": true } });
  assert.match(removingHtml, /opacity-0/);
});
