import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ActionCardMetadata } from "@botiverse/raft-shared";
import api from "../src/api/client";
import { ActionCard } from "../src/components/actions/ActionCard";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useChannelStore } from "../src/store/channelStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";
import { IntlProviderWrapper } from "../src/i18n/IntlProviderWrapper";
import { LocaleProvider } from "../src/i18n/LocaleProvider";

const channelId = "channel-1";
const messageId = "message-1";

function preparedMetadata(): ActionCardMetadata {
  return {
    kind: "action-card",
    state: "prepared",
    action: {
      type: "integration:approve_agent_login",
      requestId: "request-1",
      agentId: "agent-1",
      agentName: "Noel",
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      scopes: ["messages:read"],
    },
  };
}

function executedMetadata(): ActionCardMetadata {
  return {
    ...preparedMetadata(),
    state: "executed",
    executedByUserName: "Wendy",
    result: {
      kind: "agent-integration-login",
      requestId: "request-1",
      agentId: "agent-1",
      agentName: "Noel",
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      scopes: ["messages:read"],
      grantId: "grant-1",
    },
  };
}

function preparedCreateAgentMetadata(): ActionCardMetadata {
  return {
    kind: "action-card",
    state: "prepared",
    action: {
      type: "agent:create",
      name: "Scout",
    },
  };
}

function seedMessage(metadata: ActionCardMetadata) {
  const message: Message = {
    id: messageId,
    channelId,
    senderType: "agent",
    senderId: "agent-1",
    content: "",
    createdAt: "2026-06-29T14:00:00.000Z",
    actionMetadata: metadata,
  };

  useMessageStore.setState({
    currentChannelId: channelId,
    channelMessages: { [channelId]: [message] },
    messages: [message],
  });
  useChannelStore.setState({
    channels: [{ id: channelId, joined: true, archivedAt: null }],
  } as never);
  useServerStore.setState({
    current: { id: "server-1", role: "member" },
  } as never);
}

function seedDirectMessage(metadata: ActionCardMetadata) {
  seedMessage(metadata);
  useChannelStore.setState({
    channels: [],
    dmChannels: [{
      id: channelId,
      name: "Duoyu",
      description: null,
      type: "dm",
      createdAt: "2026-09-05T00:00:00.000Z",
      archivedAt: null,
      peerType: "user",
      peerId: "user-2",
      // Real DM projections do not carry a `joined` field.
    }],
  } as never);
}

function StoreBackedActionCard() {
  const metadata = useMessageStore((state) =>
    state.messages.find((message) => message.id === messageId)?.actionMetadata,
  ) as ActionCardMetadata | undefined;

  assert.ok(metadata);
  // ActionCard reads its copy through react-intl now, so it needs an intl
  // ancestor. Using the real providers (not a bare IntlProvider with a stub
  // catalog) keeps this test honest about what ships.
  return (
    <LocaleProvider>
      <IntlProviderWrapper>
        <ActionCard messageId={messageId} metadata={metadata} channelId={channelId} />
      </IntlProviderWrapper>
    </LocaleProvider>
  );
}

afterEach(() => {
  cleanup();
  useMessageStore.setState({
    currentChannelId: null,
    channelMessages: {},
    messages: [],
  });
  useChannelStore.setState({ channels: [], dmChannels: [] } as never);
  useServerStore.setState({ current: null } as never);
  useThreadStore.setState({ openThreadChannelId: null, openParentChannelId: null } as never);
});

test("inline approve cards apply returned metadata immediately", async (t) => {
  seedMessage(preparedMetadata());

  t.mock.method(api, "post", async (url: string) => {
    assert.equal(url, `/actions/${messageId}/execute`);
    return { data: { messageId, metadata: executedMetadata() } };
  });

  render(<StoreBackedActionCard />);

  fireEvent.click(screen.getByRole("button", { name: "Approve Login" }));

  await waitFor(() => {
    assert.equal(screen.queryByRole("button", { name: "Approve Login" }), null);
    assert.match(screen.getByText("Done").textContent ?? "", /Done/);
  });

  const updated = useMessageStore.getState().messages[0]?.actionMetadata as ActionCardMetadata | undefined;
  assert.equal(updated?.state, "executed");
});

test("public read without membership keeps a disabled action with a reason", () => {
  seedMessage(preparedMetadata());
  useChannelStore.setState({
    channels: [{ id: channelId, joined: false, archivedAt: null }],
  } as never);

  render(<StoreBackedActionCard />);

  const button = screen.getByRole("button", { name: "Approve Login" });
  const reason = screen.getByText("Join #channel to run this.");
  assert.equal(button.hasAttribute("disabled"), true);
  assert.equal(button.getAttribute("aria-describedby"), reason.id);
  assert.match(button.parentElement?.className ?? "", /\bgap-x-3\b/);
  assert.match(button.parentElement?.className ?? "", /\bgap-y-1\b/);
  assert.match(reason.className, /\btext-xs\b/);
  assert.match(reason.className, /\btext-black\/70\b/);
  assert.doesNotMatch(button.className, /disabled:opacity-50|disabled:cursor-not-allowed/);
});

test("archived channels show only the highest-priority blocked reason", () => {
  seedMessage(preparedCreateAgentMetadata());
  useChannelStore.setState({
    channels: [{ id: channelId, name: "archive", joined: false, archivedAt: "2026-09-05T00:00:00.000Z" }],
  } as never);
  useServerStore.setState({
    current: { id: "server-1", role: "guest" },
  } as never);

  render(<StoreBackedActionCard />);

  assert.equal(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled"), true);
  assert.ok(screen.getByText("This channel is archived, so its actions can no longer be run."));
  assert.equal(screen.queryByText("Guests can't run channel actions."), null);
  assert.equal(screen.queryByText("Join #archive to run this."), null);
  assert.equal(screen.queryByText(/Create Agents permission/), null);
});

test("guests see a disabled action with the guest reason", () => {
  seedMessage(preparedMetadata());
  useServerStore.setState({
    current: { id: "server-1", role: "guest" },
  } as never);

  render(<StoreBackedActionCard />);

  assert.equal(screen.getByRole("button", { name: "Approve Login" }).hasAttribute("disabled"), true);
  assert.ok(screen.getByText("Guests can't run channel actions."));
});

test("thread action cards inherit the joined parent channel write projection", () => {
  seedMessage(preparedMetadata());
  const threadChannelId = "thread-1";
  useThreadStore.setState({
    openThreadChannelId: threadChannelId,
    openParentChannelId: channelId,
  } as never);

  render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <ActionCard messageId={messageId} metadata={preparedMetadata()} channelId={threadChannelId} />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );

  assert.ok(screen.getByRole("button", { name: "Approve Login" }));
});

test("direct-message action cards use the real dmChannels projection without joined", () => {
  seedDirectMessage(preparedMetadata());

  render(<StoreBackedActionCard />);

  assert.ok(screen.getByRole("button", { name: "Approve Login" }));
});

test("direct-message thread action cards inherit their dmChannels parent projection", () => {
  seedDirectMessage(preparedMetadata());
  const threadChannelId = "dm-thread-1";
  useThreadStore.setState({
    openThreadChannelId: threadChannelId,
    openParentChannelId: channelId,
  } as never);

  render(
    <LocaleProvider>
      <IntlProviderWrapper>
        <ActionCard messageId={messageId} metadata={preparedMetadata()} channelId={threadChannelId} />
      </IntlProviderWrapper>
    </LocaleProvider>,
  );

  assert.ok(screen.getByRole("button", { name: "Approve Login" }));
});

test("direct-message agent:create cards remain operable for a server admin", () => {
  seedDirectMessage(preparedCreateAgentMetadata());
  useServerStore.setState({
    current: { id: "server-1", role: "admin" },
  } as never);

  render(<StoreBackedActionCard />);

  assert.ok(screen.getByRole("button", { name: "Create Agent" }));
});

test("agent:create card keeps a disabled action for members without createAgents", () => {
  seedMessage(preparedCreateAgentMetadata());

  render(<StoreBackedActionCard />);

  assert.ok(screen.getByText("@Scout"));
  const button = screen.getByRole("button", { name: "Create Agent" });
  assert.equal(button.hasAttribute("disabled"), true);
  assert.ok(screen.getByText("You need the Create Agents permission — ask a Server owner or admin to run this."));
});

test("direct-message agent:create cards stay disabled for an ordinary member", () => {
  seedDirectMessage(preparedCreateAgentMetadata());

  render(<StoreBackedActionCard />);

  const button = screen.getByRole("button", { name: "Create Agent" });
  const reason = screen.getByText("You need the Create Agents permission — ask a Server owner or admin to run this.");
  assert.equal(button.hasAttribute("disabled"), true);
  assert.equal(button.getAttribute("aria-describedby"), reason.id);
});

test("agent:create card keeps its action for a server admin", () => {
  seedMessage(preparedCreateAgentMetadata());
  useServerStore.setState({
    current: { id: "server-1", role: "admin" },
  } as never);

  render(<StoreBackedActionCard />);

  assert.ok(screen.getByRole("button", { name: "Create Agent" }));
});
