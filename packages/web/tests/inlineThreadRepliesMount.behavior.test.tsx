/**
 * Inline replies are the default thread surface. A hydrated per-message scope
 * renders immediately; a missing scope renders nothing, and ThreadPanel parents
 * still suppress the redundant preview.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { InlineThreadReplies } from "../src/components/message/InlineThreadReplies";
import MessageItem from "../src/components/message/MessageItem";
import { useAgentStore } from "../src/store/agentStore";
import type { Agent } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import { useChannelStore } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useMessageStore } from "../src/store/messageStore";
import { useSavedStore } from "../src/store/savedStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import type { ThreadSummary } from "../src/store/threadStore";
import type { ThreadReplyPreview } from "../src/store/threadRepliesReadModel";
import { TestIntlProvider, renderWithIntl } from "./helpers/intl";

class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}
Object.defineProperty(globalThis, "localStorage", { value: new MemoryStorage(), configurable: true });

const CHANNEL_ID = "channel-inline-replies";
const PARENT_ID = "message-parent";

function reply(seq: number, overrides: Partial<ThreadReplyPreview> = {}): ThreadReplyPreview {
  return {
    messageId: `m-${seq}`,
    seq,
    preview: `inline reply ${seq}`,
    senderId: "user-current",
    senderType: "user",
    senderName: "current-user",
    senderAvatarUrl: null,
    createdAt: "2026-07-12T00:00:00Z",
    ...overrides,
  };
}

function makeMessage(): Message {
  return {
    id: PARENT_ID,
    channelId: CHANNEL_ID,
    senderType: "user",
    senderId: "user-current",
    senderName: "current-user",
    content: "parent message",
    createdAt: "2026-07-12T00:00:00Z",
    seq: 1,
  } as Message;
}

function seedStores() {
  useAuthStore.setState({
    user: { id: "user-current", name: "current-user", displayName: "Current User" },
    accessToken: "token", initialized: true,
  } as never);
  useServerStore.setState({ current: { id: "server-1", name: "S", slug: "s" }, members: [] } as never);
  useAgentStore.setState({ agents: [], agentActivities: {} } as never);
  useChannelStore.setState({
    channels: [{ id: CHANNEL_ID, name: "general", type: "channel" }],
    dms: [], selectedChannelId: CHANNEL_ID,
  } as never);
  useSavedStore.setState({ saved: [], savedIds: new Set(), loading: false, hasMore: false } as never);
  useMessageStore.setState({ messages: { [CHANNEL_ID]: [makeMessage()] }, drafts: {} } as never);
}

function renderMessage(props: {
  hideThreadActions?: boolean;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  threadSummary?: ThreadSummary;
} = {}) {
  return render(
    <TestIntlProvider>
      <MemoryRouter>
        <MessageItem
          message={makeMessage()}
          mentionMap={{}}
          channels={[]}
          parentChannelId={CHANNEL_ID}
          hideThreadActions={props.hideThreadActions}
          channelParticipantAgentsById={props.channelParticipantAgentsById}
          threadSummary={props.threadSummary}
        />
      </MemoryRouter>
    </TestIntlProvider>,
  );
}

afterEach(() => {
  cleanup();
  useThreadStore.setState({ replyScopes: {} });
});

test("a hydrated scope renders the inline previews by default", () => {
  seedStores();
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [reply(2), reply(3)], 2);

  const { container } = renderMessage();

  assert.match(
    container.textContent ?? "", /inline reply 3/,
    "with the flag on and replies present, the previews must actually render",
  );
});

test("the inline preview replaces the legacy white replies badge", async () => {
  seedStores();
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [reply(2), reply(3)], 2);

  const { container } = renderMessage({
    threadSummary: {
      threadChannelId: "thread-channel",
      replyCount: 2,
      lastReplyAt: "2026-07-12T00:00:00Z",
      participantIds: ["user-current"],
      unreadCount: 0,
      firstUnreadMessageId: null,
    },
  });

  assert.ok(
    container.querySelector('[data-message-affordance="inline-thread-replies"]'),
    "the gray inline surface remains the single thread entry",
  );
  assert.equal(
    container.querySelector('[data-testid="message-thread-replies-badge"]'),
    null,
    "the duplicate legacy white replies badge is removed when the inline surface replaces it",
  );
});

test("a stored thread draft moves into the single gray preview entry", async () => {
  seedStores();
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [reply(2), reply(3)], 2);
  useMessageStore.setState({ drafts: { "thread-channel": "unfinished reply" } } as never);

  const { container } = renderMessage({
    threadSummary: {
      threadChannelId: "thread-channel",
      replyCount: 2,
      lastReplyAt: "2026-07-12T00:00:00Z",
      participantIds: ["user-current"],
      unreadCount: 1,
      firstUnreadMessageId: "m-3",
    },
  });

  assert.equal(
    container.querySelector('[data-message-affordance="inline-thread-replies-count"]')?.textContent,
    "2 replies · 1 new · Draft ›",
    "MessageItem passes both the unread summary and stored draft state into the consolidated entry",
  );
  assert.ok(
    container.querySelector('[data-message-affordance="inline-thread-replies-draft-icon"]'),
    "the consolidated draft status keeps its pencil icon before the Draft label",
  );
  assert.equal(
    container.querySelector('[data-testid="message-thread-replies-badge"]'),
    null,
    "preserving draft status must not bring the duplicate white badge back",
  );
});

test("human reply previews resolve current-user Gravatar and member uploaded avatars", async () => {
  seedStores();
  useAuthStore.setState((state) => ({
    ...state,
    user: {
      ...state.user!,
      gravatarHash: "current-user-gravatar",
      avatarUrl: null,
    },
  }));
  useServerStore.setState((state) => ({
    ...state,
    members: [{
      userId: "user-member",
      email: null,
      gravatarHash: "member-gravatar",
      name: "member",
      displayName: "Member",
      description: null,
      avatarUrl: "/api/avatars/users/0123456789abcdef.webp",
      role: "member",
      joinedAt: "",
    }],
  }));
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [
    reply(2),
    reply(3, {
      senderId: "user-member",
      senderName: "member",
    }),
  ], 2);

  const { container } = renderMessage();
  const preview = container.querySelector('[data-message-affordance="inline-thread-replies"]');
  assert.ok(preview, "inline reply previews should render");
  assert.ok(
    preview.querySelector('img[src*="gravatar.com/avatar/current-user-gravatar"]'),
    "a self reply should use the authenticated human's Gravatar identity",
  );
  assert.ok(
    preview.querySelector('img[src="/api/avatars/users/0123456789abcdef.webp"]'),
    "another human reply should use the matching server member's uploaded avatar",
  );
});

test("reply previews render senderDisplayName while senderName remains the stable handle", () => {
  seedStores();
  const renderReplies = (senderName: string) => (
    <TestIntlProvider>
      <InlineThreadReplies
        replies={[reply(2, {
          senderId: "agent-mingqi",
          senderType: "agent",
          senderName,
          senderDisplayName: "明启",
        })]}
        replyCount={1}
        unreadCount={0}
        hasDraft={false}
        onOpenThread={() => {}}
      />
    </TestIntlProvider>
  );

  const view = render(renderReplies("MingQi"));
  assert.match(view.container.textContent ?? "", /明启/);
  assert.doesNotMatch(view.container.textContent ?? "", /MingQi/);

  view.rerender(renderReplies("changed-handle"));
  assert.match(view.container.textContent ?? "", /明启/);
  assert.doesNotMatch(
    view.container.textContent ?? "",
    /changed-handle/,
    "identity hydration must not replace the explicit display-name label",
  );
});

test("agent reply previews prefer the channel participant avatar used by the full thread", async () => {
  seedStores();
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [
    reply(2, {
      senderId: "agent-joint",
      senderType: "agent",
      senderName: "joint-agent",
      senderAvatarUrl: "/api/avatars/agents/stale-snapshot.webp",
    }),
  ], 1);
  const channelParticipant = {
    id: "agent-joint",
    avatarUrl: "/api/avatars/agents/current-channel-participant.webp",
  } as Agent;

  const { container } = renderMessage({
    channelParticipantAgentsById: new Map([[channelParticipant.id, channelParticipant]]),
  });
  const preview = container.querySelector('[data-message-affordance="inline-thread-replies"]');
  assert.ok(preview, "inline reply previews should render");
  assert.ok(
    preview.querySelector('img[src="/api/avatars/agents/current-channel-participant.webp"]'),
    "the inline row must use the same channel-scoped agent identity as the full Thread",
  );
  assert.equal(
    preview.querySelector('img[src="/api/avatars/agents/stale-snapshot.webp"]'),
    null,
    "a stale summary snapshot must not override the live channel participant avatar",
  );
});

test("agent reply previews prefer a live agent-store avatar over a stale channel snapshot", async () => {
  seedStores();
  useAgentStore.setState({
    agents: [{
      id: "agent-joint",
      avatarUrl: "/api/avatars/agents/current-store.webp",
    } as Agent],
  });
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [
    reply(2, {
      senderId: "agent-joint",
      senderType: "agent",
      senderName: "joint-agent",
      senderAvatarUrl: "/api/avatars/agents/stale-message.webp",
    }),
  ], 1);
  const channelParticipant = {
    id: "agent-joint",
    avatarUrl: "/api/avatars/agents/stale-channel.webp",
  } as Agent;

  const { container } = renderMessage({
    channelParticipantAgentsById: new Map([[channelParticipant.id, channelParticipant]]),
  });
  const preview = container.querySelector('[data-message-affordance="inline-thread-replies"]');
  assert.ok(preview, "inline reply previews should render");
  assert.ok(preview.querySelector('img[src="/api/avatars/agents/current-store.webp"]'));
  assert.equal(preview.querySelector('img[src="/api/avatars/agents/stale-channel.webp"]'), null);
  assert.equal(preview.querySelector('img[src="/api/avatars/agents/stale-message.webp"]'), null);
});

test("no scope for this message renders no inline preview", () => {
  // Kills the ConditionalExpression→true mutant: a message with no replies must
  // not sprout an empty preview block.
  seedStores();

  const { container } = renderMessage();

  assert.doesNotMatch(container.textContent ?? "", /inline reply/);
});

test("thread panel parent (hideThreadActions) renders no inline previews", async () => {
  // Inside the Thread panel the replies ARE the surface — the parent message
  // must not preview them again at the top (artin, #proj-message:a18243dc).
  seedStores();
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [reply(2), reply(3)], 2);

  const { container } = renderMessage({ hideThreadActions: true });

  assert.doesNotMatch(container.textContent ?? "", /inline reply/);
});

test("the count leads the gray preview surface and clicking any reply opens the thread", async () => {
  seedStores();
  let openCount = 0;

  const { container } = renderWithIntl(
    <InlineThreadReplies
      replies={[reply(2), reply(3)]}
      replyCount={2}
      unreadCount={0}
      hasDraft={false}
      onOpenThread={() => { openCount += 1; }}
    />,
  );

  const surface = container.querySelector<HTMLButtonElement>('[data-message-affordance="inline-thread-replies"]');
  assert.ok(surface, "the inline reply preview surface should render");
  assert.equal(surface.tagName, "BUTTON", "the whole preview surface is the thread-opening control");
  assert.match(surface.className, /bg-black\/\[0\.03\]/, "the surface has the requested light gray background");
  assert.doesNotMatch(surface.className, /cursor-pointer/, "the intuitive row action keeps the default arrow cursor");
  assert.match(surface.className, /hover:bg-black\/\[0\.08\]/, "hover darkens the whole gray surface one stronger step");

  const countLabel = surface.querySelector('[data-message-affordance="inline-thread-replies-count"]');
  assert.ok(countLabel, "the reply count should render");
  assert.match(countLabel.textContent ?? "", /2 replies/);
  assert.equal(surface.firstElementChild, countLabel, "the reply count sits above the three preview rows");
  assert.equal(countLabel.tagName, "SPAN", "the surface must not contain a nested button");
  assert.match(countLabel.className, /text-black\/55/, "the secondary thread action uses a neutral gray instead of an attention color");
  assert.match(countLabel.className, /group-hover:text-black/, "hover can strengthen the action to neutral black");

  const previewBody = Array.from(surface.querySelectorAll("span"))
    .find((element) => element.textContent === "inline reply 2");
  assert.ok(previewBody, "a reply preview body should render inside the surface");
  fireEvent.click(previewBody);
  assert.equal(openCount, 1, "clicking a preview row opens the thread, not only the count label");
});

test("each reply preview ends with the canonical message time", () => {
  seedStores();
  const firstCreatedAt = "2026-07-12T00:00:00Z";
  const secondCreatedAt = "2026-07-12T01:30:00Z";

  const { container } = renderWithIntl(
    <InlineThreadReplies
      replies={[
        reply(2, { createdAt: firstCreatedAt }),
        reply(3, { createdAt: secondCreatedAt }),
      ]}
      replyCount={2}
      unreadCount={0}
      hasDraft={false}
      onOpenThread={() => {}}
    />,
  );

  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-inline-thread-reply-row]"));
  const times = Array.from(container.querySelectorAll<HTMLTimeElement>("[data-inline-thread-reply-time]"));
  assert.equal(times.length, 2, "every visible reply row gets one time label");
  assert.deepEqual(times.map((time) => time.dateTime), [firstCreatedAt, secondCreatedAt]);
  assert.ok(times.every((time) => time.textContent?.trim()), "canonical formatting produces visible text");
  assert.ok(times.every((time) => time.className.includes("ml-auto")), "time stays at the far edge of each row");
  assert.ok(times.every((time) => time.className.includes("shrink-0")), "time never collapses under long reply text");
  assert.ok(rows.every((row) => row.lastElementChild?.tagName === "TIME"), "time is the trailing item in each row");
});

test("more than three replies always labels the authoritative total in English and Chinese", () => {
  const props = {
    replies: [reply(3), reply(4), reply(5)],
    replyCount: 5,
    unreadCount: 0,
    hasDraft: false,
    onOpenThread: () => {},
  };

  const english = renderWithIntl(<InlineThreadReplies {...props} />);
  assert.equal(
    english.container.querySelector('[data-message-affordance="inline-thread-replies-count"]')?.textContent,
    "5 replies ›",
    "preview truncation does not change the header from the authoritative total",
  );
  english.unmount();

  const chinese = renderWithIntl(<InlineThreadReplies {...props} />, { locale: "zh-cn" });
  assert.equal(
    chinese.container.querySelector('[data-message-affordance="inline-thread-replies-count"]')?.textContent,
    "5 条回复 ›",
    "the localized header uses the same authoritative total",
  );
});

test("the gray header preserves unread and draft states in English and Chinese", () => {
  const props = {
    replies: [reply(3), reply(4), reply(5)],
    replyCount: 5,
    unreadCount: 2,
    hasDraft: true,
    onOpenThread: () => {},
  };

  const english = renderWithIntl(<InlineThreadReplies {...props} />);
  assert.equal(
    english.container.querySelector('[data-message-affordance="inline-thread-replies-count"]')?.textContent,
    "5 replies · 2 new · Draft ›",
    "the single gray entry inherits both status signals from the removed white badge",
  );
  english.unmount();

  const chinese = renderWithIntl(<InlineThreadReplies {...props} />, { locale: "zh-cn" });
  assert.equal(
    chinese.container.querySelector('[data-message-affordance="inline-thread-replies-count"]')?.textContent,
    "5 条回复 · 2 条新回复 · 草稿 ›",
    "unread and draft status copy stays localized in the consolidated entry",
  );
  assert.ok(
    chinese.container.querySelector('[data-message-affordance="inline-thread-replies-draft-icon"]'),
    "the localized draft status keeps the same pencil icon",
  );
});

test("system previews are excluded without consuming the three conversation slots", () => {
  seedStores();
  const systemReply: ThreadReplyPreview = {
    ...reply(5),
    preview: "System maintenance completed",
    senderId: "system",
    senderType: "system",
    senderName: "System",
  };
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [
    systemReply,
    reply(2, { preview: "human reply a" }),
    reply(3, { preview: "human reply b" }),
    reply(4, { preview: "human reply c" }),
  ], 4);

  const { container } = renderMessage();

  assert.match(container.textContent ?? "", /current-user/, "ordinary preview keeps its sender name");
  assert.doesNotMatch(container.textContent ?? "", /System maintenance completed/, "system events do not enter the conversation preview");
  assert.match(container.textContent ?? "", /human reply a/, "the first ordinary reply remains visible");
  assert.match(container.textContent ?? "", /human reply b/, "the second ordinary reply remains visible");
  assert.match(container.textContent ?? "", /human reply c/, "filtering system rows does not consume the third conversation slot");

  const preview = container.querySelector('[data-message-affordance="inline-thread-replies"]');
  assert.ok(preview, "the ordinary reply preview remains mounted");
  assert.equal(preview.tagName, "BUTTON", "the filtered ordinary preview remains fully clickable");
  assert.equal(preview.querySelectorAll("[data-inline-thread-reply-row]").length, 3, "only the three ordinary reply rows render");
  const countLabel = preview.querySelector('[data-message-affordance="inline-thread-replies-count"]');
  assert.match(
    countLabel?.textContent ?? "",
    /4 replies/,
    "the header stays truthful to the full thread history even though system rows do not consume preview slots",
  );
});

test("system-only reply scopes render no inline affordance", () => {
  seedStores();
  useThreadStore.getState().hydrateReplyScope(PARENT_ID, [
    reply(2, {
      preview: "System maintenance completed",
      senderId: "system",
      senderType: "system",
      senderName: "System",
    }),
  ], 1);

  const { container } = renderMessage();
  const preview = container.querySelector('[data-message-affordance="inline-thread-replies"]');
  assert.equal(preview, null, "system-only history does not create a preview, border, or reply-count entry");
  assert.doesNotMatch(container.textContent ?? "", /System maintenance completed/, "system body stays in the full thread only");
  assert.doesNotMatch(container.textContent ?? "", /1 reply/, "system-only history is absent from this conversation affordance");
});
