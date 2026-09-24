import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";

/**
 * Saved state must render as FOOTER METADATA, not as a resting overlay on the
 * message body.
 *
 * This replaces a source scan in messageBookmarkActionSpacing.test.ts that
 * regex-matched the literal footer-row condition in MessageItem.tsx:
 *
 *   /linkedTask \|\|\s+isSaved \|\|\s+visibleReactions\.length > 0 \|\| .../
 *
 * That assertion violated artin's 铁律1 (test behavior, not source text) and
 * behaved exactly as that rule predicts: adding a legitimate new term to the
 * condition — the DM read chip, which had to join it or the chip could never
 * render — turned the test red without anything regressing. The scan could not
 * distinguish "the footer stopped showing saved state" from "the expression was
 * edited". It pinned the shape of one boolean, so the only way to keep it green
 * was to never touch that line.
 *
 * The property it was actually defending is observable: a saved message shows
 * the saved badge, and it sits in the footer row rather than floating over the
 * body. Asserted here against rendered DOM, so it stays green through any
 * refactor of the condition and goes red if saved state stops reaching the
 * footer.
 */

const test = ((name: string, fn: Parameters<typeof nodeTest>[1]) =>
  nodeTest(name, { concurrency: false }, fn)) as typeof nodeTest;

async function renderMessage(opts: { saved: boolean; locale?: "en" | "zh-cn" }) {
  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");

  useAuthStore.setState({
    user: { id: "user-1", email: "u@example.com", name: "Current User" },
    accessToken: "t",
    refreshToken: "r",
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({ current: { id: "server-1", slug: "s", name: "S" }, members: [] } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useSavedStore.setState({
    saved: [],
    savedIds: new Set(opts.saved ? ["message-1"] : []),
    loading: false,
    hasMore: false,
  } as never);

  return render(
    <MemoryRouter>
      <TestIntlProvider locale={opts.locale}>
        <MessageItem
          message={{
            id: "message-1",
            channelId: "channel-1",
            seq: 5,
            senderType: "user",
            senderId: "user-1",
            senderName: "Current User",
            messageType: "chat",
            content: "hello",
            createdAt: "2026-07-28T00:00:00.000Z",
          } as never}
          mentionMap={new Map()}
          channels={[{ id: "channel-1", name: "peer", type: "channel" } as never]}
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

test("a saved message renders the saved badge", async () => {
  const view = await renderMessage({ saved: true });
  assert.ok(
    view.container.querySelector("[data-message-affordance='saved-badge']"),
    "saved state must be visible on the message",
  );
});

test("the saved message footer uses the finalized Chinese Saved label", async () => {
  const view = await renderMessage({ saved: true, locale: "zh-cn" });
  const badge = view.container.querySelector("[data-message-affordance='saved-badge']");
  assert.equal(badge?.textContent?.trim(), "已保存");
  assert.ok(!badge?.textContent?.includes("已收藏"));
});

test("an unsaved message renders no saved badge", async () => {
  const view = await renderMessage({ saved: false });
  assert.equal(
    view.container.querySelector("[data-message-affordance='saved-badge']"),
    null,
    "the badge must track saved state, not render unconditionally",
  );
});

test("the saved badge is footer metadata, not a resting overlay on the body", async () => {
  const view = await renderMessage({ saved: true });
  const badge = view.container.querySelector("[data-message-affordance='saved-badge']");
  assert.ok(badge);

  // The distinction the original source scan was reaching for: saved state
  // joins the footer metadata row (in flow, alongside reactions/task/thread
  // chips) instead of being absolutely positioned over the message body.
  for (let node: Element | null = badge; node; node = node.parentElement) {
    const cls = node.className;
    if (typeof cls === "string") {
      assert.ok(
        !/\babsolute\b/.test(cls),
        "saved state must not sit in an absolutely positioned layer above the body",
      );
    }
    if (node.parentElement === null) break;
  }
});
