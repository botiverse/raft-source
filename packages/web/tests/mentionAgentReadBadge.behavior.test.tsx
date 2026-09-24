import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "./helpers/domSetup";
import { cleanup, render, screen } from "@testing-library/react";
import MentionLink from "../src/components/message/MentionLink";
import { MessageReadReceiptScopeProvider } from "../src/components/message/messageReadReceiptScope";
import { TestIntlProvider } from "./helpers/intl";
import { useAuthStore } from "../src/store/authStore";
import { useReadReceiptStore } from "../src/store/readReceiptStore";
import type { ReadReceiptScope } from "../src/store/readReceiptDomain";

/**
 * #693: each @mentioned AGENT carries a read badge on its own top-right corner;
 * human mentions never do, and human-peer read state is no longer surfaced.
 *
 * These mount the REAL `MentionLink` behind the REAL provider rather than
 * asserting the pure projection, because the failure mode that matters is the
 * wiring going dead (provider not supplied / badge not rendered) while a
 * projection unit test stays green — delete the provider or the badge and these
 * go red, which a projection-level test would not.
 */

const CHANNEL_ID = "channel-693";
const AGENT_ID = "agent-alpha";

function seedScope(scope: ReadReceiptScope | undefined) {
  useReadReceiptStore.setState({ scopes: scope ? { [CHANNEL_ID]: scope } : {} } as never);
}

function peersScope(maxReadSeq: number, peerKind: "agent" | "human" = "agent"): ReadReceiptScope {
  return { kind: "peers", peers: [{ peerKind, peerId: AGENT_ID, maxReadSeq }] };
}

function renderMention(opts: {
  mentionType?: "agent" | "user";
  messageSeq?: number;
  enabled?: boolean;
}) {
  const { mentionType = "agent", messageSeq = 10, enabled = true } = opts;
  return render(
    <TestIntlProvider>
      <MessageReadReceiptScopeProvider value={{ channelId: CHANNEL_ID, messageSeq, enabled }}>
        <MentionLink mentionType={mentionType} mentionId={AGENT_ID} onNavigate={() => {}}>
          @alpha
        </MentionLink>
      </MessageReadReceiptScopeProvider>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  seedScope(undefined);
});

test("#693 mentioned agent that has read the message shows a read badge", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  seedScope(peersScope(12)); // 12 >= seq 10 → read
  renderMention({ messageSeq: 10 });

  const badge = screen.getByTestId(`mention-read-${AGENT_ID}`);
  assert.equal(badge.dataset.mentionReadState, "read");
});

test("#693 mentioned agent that has NOT read shows an unread badge", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  seedScope(peersScope(9)); // 9 < seq 10 → not read
  renderMention({ messageSeq: 10 });

  const badge = screen.getByTestId(`mention-read-${AGENT_ID}`);
  assert.equal(badge.dataset.mentionReadState, "unread");
});

test("#693 human mentions never carry a read badge", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  // Even with a matching peer row present, a user mention must stay bare.
  seedScope(peersScope(12, "human"));
  renderMention({ mentionType: "user", messageSeq: 10 });

  assert.equal(screen.queryByTestId(`mention-read-${AGENT_ID}`), null);
});

test("#693 badge is hidden when the viewer is not the message sender (scope disabled)", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  seedScope(peersScope(12));
  renderMention({ enabled: false });

  assert.equal(screen.queryByTestId(`mention-read-${AGENT_ID}`), null);
});

test("#693 summary-only scope renders nothing — unknown must not read as unread", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  // Large channels degrade to an aggregate with no peer identity.
  seedScope({ kind: "summary", summary: { peerCount: 40, readCountAtSeq: [{ seq: 10, count: 7 }] } });
  renderMention({ messageSeq: 10 });

  assert.equal(screen.queryByTestId(`mention-read-${AGENT_ID}`), null);
});

test("#693 un-hydrated scope renders nothing rather than implying unread", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  seedScope(undefined);
  renderMention({ messageSeq: 10 });

  assert.equal(screen.queryByTestId(`mention-read-${AGENT_ID}`), null);
});

test("#693 a HUMAN peer never satisfies an agent mention's badge (peerKind is load-bearing)", () => {
  useAuthStore.setState({ user: { id: "viewer-1" } } as never);
  // Same peerId, but peerKind is "human". Without the peerKind filter this
  // would render a read badge on an agent mention — i.e. human read state
  // leaking onto the surface artin explicitly asked to remove.
  seedScope(peersScope(12, "human"));
  renderMention({ mentionType: "agent", messageSeq: 10 });

  assert.equal(screen.queryByTestId(`mention-read-${AGENT_ID}`), null);
});
