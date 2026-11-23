import assert from "node:assert/strict";
import { Profiler } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { InboxRow } from "../InboxRow";
import { useChannelStore } from "../../../store/channelStore";
import type { ApiChannel, Channel } from "../../../store/channelStore";
import { useAgentStore } from "../../../store/agentStore";
import type { InboxItem } from "../../../store/inboxStore";
import { TestIntlProvider } from "../../../../tests/helpers/intl";

// #532: a `channel:updated` flood patched one channel at a time, and every
// Activity row (subscribed to the whole channel and agent lists) re-rendered
// and re-parsed its preview. A row now selects only its own conversation and
// its sender: a patch to another channel or agent leaves it alone.

function channel(id: string, over: Partial<Channel> = {}): Channel {
  return { id, serverId: "server-1", name: id, description: null, type: "channel", createdAt: "2026-07-01T00:00:00.000Z", joined: true, ...over };
}

const ITEM: InboxItem = {
  kind: "channel",
  channelId: "ch-mine",
  channelName: "mine",
  channelType: "channel",
  lastMessageId: "m1",
  latestActivitySeq: "1",
  firstUnreadMessageId: null,
  firstMentionMessageId: null,
  lastMessageAt: "2026-07-01T00:00:00.000Z",
  lastMessagePreview: "**hello** from `agent`",
  lastMessageSenderType: "agent",
  lastMessageSenderId: "agent-1",
  lastMessageSenderName: "Helper",
  unreadCount: 0,
  hasMention: false,
};

const noop = () => {};

afterEach(() => {
  cleanup();
});

test("a patch to another channel or agent does not re-render the row; one to its own channel does", () => {
  useChannelStore.setState({
    channels: [channel("ch-mine"), channel("ch-other")],
    dmChannels: [],
    loungeChannels: [],
    channelActivity: {},
  });
  useAgentStore.setState({
    agents: [
      { id: "agent-1", name: "helper", displayName: "Helper", description: null, avatarUrl: null, deletedAt: null } as never,
      { id: "agent-2", name: "other", displayName: "Other", description: null, avatarUrl: null, deletedAt: null } as never,
    ],
  });
  let renders = 0;
  render(
    <MemoryRouter>
      <TestIntlProvider>
        <Profiler id="row" onRender={() => { renders += 1; }}>
          <InboxRow item={ITEM} filter="all" searchQuery="" taskV2={false} onOpen={noop} onDone={noop} onContextMenu={noop} onLongPress={noop} />
        </Profiler>
      </TestIntlProvider>
    </MemoryRouter>,
  );
  const afterMount = renders;
  assert.ok(afterMount > 0);

  act(() => {
    useChannelStore.getState().applyChannelPatch({ ...channel("ch-other"), name: "renamed", lastMessageAt: "2026-07-02T00:00:00.000Z" } as ApiChannel);
  });
  assert.notEqual(useChannelStore.getState().channels.find((c) => c.id === "ch-other")?.name, "ch-other", "the other channel was patched");
  act(() => {
    useAgentStore.setState((state) => ({ agents: state.agents.map((agent) => (agent.id === "agent-2" ? { ...agent, displayName: "Renamed" } : agent)) }));
  });
  // A patch that changes nothing (the flood's usual event) to the row's own channel.
  act(() => {
    useChannelStore.getState().applyChannelPatch({ ...channel("ch-mine"), lastMessageAt: null } as ApiChannel);
  });
  assert.equal(renders, afterMount, "no re-render for another channel, another agent, or an unchanged row");

  act(() => {
    useChannelStore.getState().applyChannelPatch({ ...channel("ch-mine"), activityMuted: true, lastMessageAt: null } as ApiChannel);
  });
  assert.ok(renders > afterMount, "its own channel's change re-renders it");
});
