import assert from "node:assert/strict";
import { afterEach, test as nodeTest } from "node:test";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TestIntlProvider } from "./helpers/intl";
import api from "../src/api/client";

/**
 * Task #693 follow-up — DMs must show read state again.
 *
 * The per-@mentioned-agent badge hangs off `MentionLink`, and nobody @-mentions
 * anyone in a DM, so there is no mount point. Removing the legacy footer chip
 * (correct for channels: it fired on messages with no @agent at all, and on
 * large-summary scopes) silently left DMs with NO read indicator whatsoever.
 *
 * The restored chip is scoped to DMs ONLY, because that is the one surface
 * where it was never ambiguous: a DM has a single exposed peer, so "Read"
 * cannot quietly mean "some unrelated agent read the channel". The channel
 * case below is a regression guard for exactly the bug that removal fixed —
 * this fix must not bring it back.
 */

const test = ((name: string, fn: Parameters<typeof nodeTest>[1]) =>
  nodeTest(name, { concurrency: false }, fn)) as typeof nodeTest;

const originalPost = api.post.bind(api);

async function renderMessage(opts: {
  channelType: "dm" | "channel";
  peerMaxReadSeq?: number;
  messageSeq?: number;
  senderIsViewer?: boolean;
  hydrate?: boolean;
  reactions?: Record<string, unknown>[];
}) {
  const {
    channelType,
    peerMaxReadSeq = 10,
    messageSeq = 5,
    senderIsViewer = true,
    hydrate = true,
    reactions = [],
  } = opts;

  const { default: MessageItem } = await import("../src/components/message/MessageItem");
  const { useAgentStore } = await import("../src/store/agentStore");
  const { useAuthStore } = await import("../src/store/authStore");
  const { useReadReceiptStore } = await import("../src/store/readReceiptStore");
  const { useSavedStore } = await import("../src/store/savedStore");
  const { useServerStore } = await import("../src/store/serverStore");
  const { useChannelStore } = await import("../src/store/channelStore");
  const {
    READ_RECEIPTS_FEATURE_FLAG_KEY,
    prefetchServerFeatureFlags,
    resetServerFeatureFlagsForTests,
  } = await import("../src/store/serverFeatureFlags");

  useAuthStore.setState({
    user: { id: "user-1", email: "u@example.com", name: "Current User" },
    accessToken: "t",
    refreshToken: "r",
    loading: false,
    initialized: true,
  } as never);
  useServerStore.setState({ current: { id: "server-1", slug: "s", name: "S" }, members: [] } as never);
  // Mirror the REAL wiring: the store keeps DMs in `dmChannels`, and ChatPanel
  // passes only `s.channels` down as the prop. A DM must therefore be provable
  // from the store alone — never from the prop.
  useChannelStore.setState({
    channels: channelType === "dm" ? [] : [{ id: "channel-1", name: "peer", type: "channel" }],
    dmChannels: channelType === "dm" ? [{ id: "channel-1", name: "peer", type: "dm" }] : [],
  } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false } as never);

  resetServerFeatureFlagsForTests();
  api.post = (async () => ({
    data: { evaluations: [{ key: READ_RECEIPTS_FEATURE_FLAG_KEY, enabled: true }] },
  })) as typeof api.post;
  await prefetchServerFeatureFlags("server-1");

  useReadReceiptStore.setState({
    scopes: hydrate
      ? { "channel-1": { kind: "peers", peers: [{ peerKind: "agent", peerId: "agent-1", maxReadSeq: peerMaxReadSeq }] } }
      : {},
  } as never);

  const view = render(
    <MemoryRouter>
      <TestIntlProvider>
        <MessageItem
          message={{
            id: "message-1",
            channelId: "channel-1",
            seq: messageSeq,
            senderType: "user",
            senderId: senderIsViewer ? "user-1" : "user-2",
            senderName: "Current User",
            messageType: "chat",
            content: "hello",
            createdAt: "2026-07-28T00:00:00.000Z",
            reactions,
          } as never}
          mentionMap={new Map()}
          // ChatPanel passes `useChannelStore(s => s.channels)` — which never
          // contains DMs. Passing the DM here would fake a shape the app cannot
          // produce, which is exactly how the original defect stayed green.
          channels={
            (channelType === "dm"
              ? []
              : [{ id: "channel-1", name: "peer", type: "channel" }]) as never
          }
        />
      </TestIntlProvider>
    </MemoryRouter>,
  );
  return view;
}

function hasReadChip(view: { container: HTMLElement }): boolean {
  return view.container.querySelector("[data-message-affordance='read-receipt']") !== null;
}

afterEach(() => {
  cleanup();
  api.post = originalPost;
});

test("#693 a DM shows the read chip once the agent peer has read the message", async () => {
  const view = await renderMessage({ channelType: "dm", peerMaxReadSeq: 10, messageSeq: 5 });
  assert.equal(hasReadChip(view), true, "a DM is the one surface with an unambiguous single peer");
});

test("#693 the DM chip sits at the far right of the message row", async () => {
  const view = await renderMessage({ channelType: "dm", peerMaxReadSeq: 10, messageSeq: 5 });
  const chip = view.container.querySelector("[data-message-affordance='read-receipt']");
  assert.ok(chip);
  const footer = chip!.parentElement;
  assert.ok(footer);
  // artin specified the far right. Asserting it is the LAST child of the flex
  // footer row is structural: it stays true if the chip's classes are
  // restyled, and goes false if someone inserts another chip after it.
  assert.equal(footer!.lastElementChild, chip, "the read chip must be the right-most footer element");
});

test("#693 a DM shows nothing while the peer has not reached this message", async () => {
  const view = await renderMessage({ channelType: "dm", peerMaxReadSeq: 4, messageSeq: 5 });
  assert.equal(hasReadChip(view), false);
});

test("#693 REGRESSION GUARD: a channel never shows the aggregate chip", async () => {
  // This is the bug whose fix deleted the DM case. A read agent peer in a
  // CHANNEL must still produce nothing at message level — read state there
  // belongs on each @mentioned agent's own mention.
  const view = await renderMessage({ channelType: "channel", peerMaxReadSeq: 10, messageSeq: 5 });
  assert.equal(hasReadChip(view), false, "the channel-level aggregate chip must not come back");
});

test("#693 only the message's own sender sees the DM chip", async () => {
  const view = await renderMessage({ channelType: "dm", senderIsViewer: false });
  assert.equal(hasReadChip(view), false, "read state is visible to the sender only");
});

test("#693 an un-hydrated scope renders nothing rather than implying unread", async () => {
  const view = await renderMessage({ channelType: "dm", hydrate: false });
  assert.equal(hasReadChip(view), false);
});

test("#693 the DM chip stays right-most when the footer also has reactions", async () => {
  // The original "far right" tooth rendered a message with an EMPTY footer, so
  // "the chip is the last child" was true no matter where it was emitted. It
  // passed while the chip was rendered before the reactions/thread chips and
  // therefore sat to their LEFT in any real message that had them. `ml-auto`
  // right-aligns, but it does not reorder. Give the row other content, which is
  // the only condition under which the ordering is observable at all.
  const view = await renderMessage({
    channelType: "dm",
    peerMaxReadSeq: 10,
    messageSeq: 5,
    reactions: [{
      emoji: "\u{1F44D}",
      count: 2,
      reactorIds: ["user-2"],
      reactorNames: ["Bob"],
    }],
  });
  const chip = view.container.querySelector("[data-message-affordance='read-receipt']");
  assert.ok(chip, "the chip must still render when the footer has other affordances");
  const footer = chip!.parentElement;
  assert.ok(footer);
  assert.ok(footer!.childElementCount > 1, "this tooth is vacuous unless the row has other content");
  assert.equal(
    footer!.lastElementChild,
    chip,
    "artin asked for the far right: the chip must follow every other footer affordance",
  );
});
