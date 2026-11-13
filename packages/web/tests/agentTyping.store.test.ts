import assert from "node:assert/strict";
import { vi } from "vitest";
import { createIntl } from "react-intl";
import { AGENT_TYPING_TTL_MS } from "@botiverse/raft-shared";
import type { AgentTypingEvent } from "@botiverse/raft-shared";

import { formatAgentTypingSentence } from "../src/components/message/AgentTypingLine";
import { mergedMessages } from "../src/i18n/messages";
import type { Locale } from "../src/i18n/locale";
import { AGENT_TYPING_CLEARED_CALLS_MAX, AGENT_TYPING_CLEARED_CALL_TTL_MS, selectTypingAgentIds, useAgentTypingStore } from "../src/store/agentTypingStore";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket, SocketBinding } from "../src/store/socketBridge";
import { useAgentStore } from "../src/store/agentStore";
import { useChannelStore } from "../src/store/channelStore";
import { useInboxStore } from "../src/store/inboxStore";
import { useMachineStore } from "../src/store/machineStore";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { useThreadStore } from "../src/store/threadStore";

// Agent typing line (raft-design 0042): the store behind it, the socket
// bindings that feed and clear it, and the sentence it says.

const SERVER = "server-typing";
const CHANNEL = "channel-typing";

function typing(overrides: Partial<AgentTypingEvent> = {}): AgentTypingEvent {
  return {
    agentId: "niko", serverId: SERVER, channelId: CHANNEL, parentMessageId: null,
    callId: "call-1", state: "start", expiresAt: Date.now() + AGENT_TYPING_TTL_MS, ...overrides,
  };
}

const ids = (channelId = CHANNEL, parentMessageId: string | null = null) =>
  selectTypingAgentIds(useAgentTypingStore.getState(), channelId, parentMessageId);

beforeEach(() => {
  useAgentTypingStore.getState().clear();
});
afterEach(() => {
  vi.useRealTimers();
  useAgentTypingStore.getState().clear();
});

test("agents are listed once each, in the order they started; a refresh keeps the place", () => {
  const store = useAgentTypingStore.getState();
  store.apply(typing({ agentId: "niko" }));
  store.apply(typing({ agentId: "kirby", callId: "call-2" }));
  store.apply(typing({ agentId: "niko" })); // refresh
  store.apply(typing({ agentId: "niko", callId: "call-3" })); // a second call, same agent
  assert.deepEqual(ids(), ["niko", "kirby"]);
  assert.deepEqual(
    useAgentTypingStore.getState().byChannel[CHANNEL].map((entry) => entry.callId),
    ["call-1", "call-2", "call-3"],
    "a refresh updates its call in place: no duplicate, no move to the back",
  );
});

test("channel and thread entries are kept apart", () => {
  const store = useAgentTypingStore.getState();
  store.apply(typing({ agentId: "niko" }));
  store.apply(typing({ agentId: "kirby", callId: "call-2", parentMessageId: "root-1" }));
  assert.deepEqual(ids(CHANNEL, null), ["niko"]);
  assert.deepEqual(ids(CHANNEL, "root-1"), ["kirby"]);
  assert.deepEqual(ids("other-channel", null), []);
});

test("an end removes only its own call", () => {
  const store = useAgentTypingStore.getState();
  store.apply(typing({ agentId: "niko" }));
  store.apply(typing({ agentId: "kirby", callId: "call-2" }));
  store.apply(typing({ agentId: "niko", state: "end" }));
  assert.deepEqual(ids(), ["kirby"]);
  store.apply(typing({ agentId: "kirby", callId: "call-2", state: "end" }));
  assert.deepEqual(useAgentTypingStore.getState().byChannel, {}, "an emptied channel leaves no key behind");
});

test("an entry expires at expiresAt unless refreshed, and an empty store keeps no timer", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const store = useAgentTypingStore.getState();
  store.apply(typing({ agentId: "niko", expiresAt: Date.now() + 5_000 }));
  store.apply(typing({ agentId: "kirby", callId: "call-2", expiresAt: Date.now() + 5_000 }));
  vi.advanceTimersByTime(3_000);
  store.apply(typing({ agentId: "kirby", callId: "call-2", expiresAt: Date.now() + 5_000 }));
  vi.advanceTimersByTime(2_001);
  assert.deepEqual(ids(), ["kirby"], "niko expired; kirby's refresh moved its deadline");
  vi.advanceTimersByTime(3_000);
  assert.deepEqual(ids(), []);
  assert.equal(vi.getTimerCount(), 0, "no timer left running once the store is empty");
});

test("an expiresAt outside (now, now + TTL] (client clock skew) falls back to the TTL", () => {
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
  useAgentTypingStore.getState().apply(typing({ expiresAt: Date.now() - 60_000 }));
  vi.advanceTimersByTime(AGENT_TYPING_TTL_MS - 1);
  assert.deepEqual(ids(), ["niko"], "a client clock running ahead must not drop the line at once");
  vi.advanceTimersByTime(2);
  assert.deepEqual(ids(), []);
});

test("a start for a call whose message already landed is ignored; other calls are not", () => {
  vi.useFakeTimers();
  vi.setSystemTime(3_000_000);
  const store = useAgentTypingStore.getState();
  store.apply(typing({ agentId: "niko" }));
  store.apply(typing({ agentId: "niko", callId: "call-t", parentMessageId: "root-1" }));
  store.clearForMessage("niko", CHANNEL, null);
  store.clearForThreadReply("niko", "root-1");
  assert.deepEqual(ids(), []);

  // `send … && raft task update …` still running: its refreshes keep arriving.
  for (let i = 0; i < 5; i += 1) {
    vi.advanceTimersByTime(8_000);
    store.apply(typing({ agentId: "niko" }));
    store.apply(typing({ agentId: "niko", callId: "call-t", parentMessageId: "root-1" }));
    assert.deepEqual(ids(), [], `refresh ${i} must not bring the channel line back`);
    assert.deepEqual(ids(CHANNEL, "root-1"), [], `refresh ${i} must not bring the thread line back`);
  }
  // The agent's next send is a new call.
  store.apply(typing({ agentId: "niko", callId: "call-next" }));
  assert.deepEqual(ids(), ["niko"]);
  store.apply(typing({ agentId: "niko", callId: "call-next", state: "end" }));

  // Once the call's refreshes stop, it is forgotten after the TTL.
  vi.advanceTimersByTime(AGENT_TYPING_CLEARED_CALL_TTL_MS + 1);
  store.apply(typing({ agentId: "niko" }));
  assert.deepEqual(ids(), ["niko"]);
});

test("cleared calls are remembered up to a bound", () => {
  const store = useAgentTypingStore.getState();
  for (let i = 0; i <= AGENT_TYPING_CLEARED_CALLS_MAX; i += 1) {
    store.apply(typing({ agentId: "niko", callId: `call-${i}` }));
    store.clearForMessage("niko", CHANNEL, null);
  }
  // The oldest fell out; the newest is still ignored.
  store.apply(typing({ agentId: "niko", callId: "call-0" }));
  store.apply(typing({ agentId: "niko", callId: `call-${AGENT_TYPING_CLEARED_CALLS_MAX}` }));
  assert.deepEqual(useAgentTypingStore.getState().byChannel[CHANNEL]?.map((entry) => entry.callId), ["call-0"]);
});

class FakeSocket implements MainLayoutSocketBridgeSocket {
  connected = true;
  emit() { return undefined; }
  on() { return undefined; }
  off() { return undefined; }
  onAny() { return undefined; }
  offAny() { return undefined; }
  disconnect() { this.connected = false; }
  connect() { this.connected = true; }
}

function bridge() {
  const bindings = buildMainLayoutSocketBindings(new FakeSocket(), () => undefined, async () => undefined, () => undefined, () => undefined);
  const byEvent = new Map<string, SocketBinding["handler"]>();
  for (const binding of bindings) byEvent.set(binding.event, binding.handler);
  return (event: string, payload?: unknown) => byEvent.get(event)!(payload);
}

function agentMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${Math.random()}`, channelId: CHANNEL, senderType: "agent", senderId: "niko", content: "hi",
    createdAt: "2026-10-20T00:00:00.000Z", seq: 10, conversationContext: { channelType: "channel" }, ...overrides,
  };
}

describe("socket bindings", () => {
  const saved = {
    server: useServerStore.getState(),
    message: useMessageStore.getState(),
  };
  beforeEach(() => {
    useServerStore.setState({ current: { id: SERVER, slug: "t", name: "T", role: "member", plan: "free" } } as never);
    useMessageStore.setState({ addMessage: () => undefined } as never);
  });
  afterEach(() => {
    useServerStore.setState(saved.server, true);
    useMessageStore.setState(saved.message, true);
  });

  test("agent:typing applies this workspace's events and ignores another's", () => {
    const emit = bridge();
    emit("agent:typing", typing({ agentId: "niko" }));
    emit("agent:typing", typing({ agentId: "kirby", callId: "call-2", serverId: "someone-else" }));
    emit("agent:typing", { agentId: "broken" });
    assert.deepEqual(ids(), ["niko"]);
  });

  test("the agent's own message clears its line in that conversation only", () => {
    const emit = bridge();
    emit("agent:typing", typing({ agentId: "niko" }));
    emit("agent:typing", typing({ agentId: "niko", callId: "call-t", parentMessageId: "root-1" }));
    emit("agent:typing", typing({ agentId: "kirby", callId: "call-2" }));
    emit("message:new", agentMessage({ senderId: "niko" }));
    assert.deepEqual(ids(CHANNEL, null), ["kirby"], "niko posted in the channel; kirby is still typing");
    assert.deepEqual(ids(CHANNEL, "root-1"), ["niko"], "a channel post does not end niko's thread reply");

    emit("message:new", agentMessage({
      senderId: "niko", channelId: "thread-1",
      conversationContext: { channelType: "thread", parentMessageId: "root-1", parentChannelId: CHANNEL },
    }));
    assert.deepEqual(ids(CHANNEL, "root-1"), []);
  });

  test("a thread:updated reply from the agent clears its replying hint", () => {
    const emit = bridge();
    emit("agent:typing", typing({ agentId: "niko", parentMessageId: "root-1" }));
    emit("thread:updated", {
      parentMessageId: "root-1", threadChannelId: "thread-1", replyCount: 1, lastReplyAt: null, participantIds: [],
      latestReply: agentMessage({ senderId: "niko", channelId: "thread-1" }),
    });
    assert.deepEqual(ids(CHANNEL, "root-1"), []);
  });

  test("a reconnect clears every line", () => {
    const loaders = {
      agent: useAgentStore.getState(), machine: useMachineStore.getState(), thread: useThreadStore.getState(),
      channel: useChannelStore.getState(), inbox: useInboxStore.getState(),
    };
    useServerStore.setState({ loadSidebarOrder: async () => {}, loadServers: async () => {} } as never);
    useMachineStore.setState({ loadMachines: async () => {} } as never);
    useAgentStore.setState({ loadAgents: async () => {}, resetActivitySeq: () => undefined } as never);
    useThreadStore.setState({ loadFollowedThreads: async () => {} } as never);
    try {
      const emit = bridge();
      emit("agent:typing", typing({ agentId: "niko" }));
      emit("agent:typing", typing({ agentId: "kirby", callId: "call-2", parentMessageId: "root-1" }));
      emit("connect");
      assert.deepEqual(useAgentTypingStore.getState().byChannel, {});
    } finally {
      useAgentStore.setState(loaders.agent, true);
      useMachineStore.setState(loaders.machine, true);
      useThreadStore.setState(loaders.thread, true);
      useChannelStore.setState(loaders.channel, true);
      useInboxStore.setState(loaders.inbox, true);
    }
  });
});

function sentence(locale: Locale, kind: "typing" | "replying", names: string[]) {
  const intl = createIntl({ locale, defaultLocale: "en", messages: mergedMessages(locale) });
  return formatAgentTypingSentence(intl.formatMessage, kind, names);
}

const FIVE = ["Niko", "Kirby", "Tenny", "Pip", "Moss"];

test("the typing sentence for 1, 2, 3 and 5 agents (en)", () => {
  assert.equal(sentence("en", "typing", FIVE.slice(0, 1)), "Niko is typing…");
  assert.equal(sentence("en", "typing", FIVE.slice(0, 2)), "Niko and Kirby are typing…");
  assert.equal(sentence("en", "typing", FIVE.slice(0, 3)), "Niko, Kirby and Tenny are typing…");
  assert.equal(sentence("en", "typing", FIVE), "Niko, Kirby and 3 other agents are typing…");
  assert.equal(sentence("en", "replying", FIVE.slice(0, 1)), "Niko is replying");
  assert.equal(sentence("en", "replying", FIVE.slice(0, 2)), "Niko and Kirby are replying");
});

test("the typing sentence for 1, 2, 3 and 5 agents (zh-cn)", () => {
  assert.equal(sentence("zh-cn", "typing", FIVE.slice(0, 1)), "Niko 正在输入…");
  assert.equal(sentence("zh-cn", "typing", FIVE.slice(0, 2)), "Niko 和 Kirby 正在输入…");
  assert.equal(sentence("zh-cn", "typing", FIVE.slice(0, 3)), "Niko、Kirby 和 Tenny 正在输入…");
  assert.equal(sentence("zh-cn", "typing", FIVE), "Niko、Kirby 等 5 个 Agent 正在输入…");
  assert.equal(sentence("zh-cn", "replying", FIVE.slice(0, 1)), "Niko 正在回复");
});
