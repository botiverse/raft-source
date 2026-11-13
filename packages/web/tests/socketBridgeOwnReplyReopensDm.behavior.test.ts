import assert from "node:assert/strict";
import { buildMainLayoutSocketBindings } from "../src/store/socketBridge";
import type { MainLayoutSocketBridgeSocket } from "../src/store/socketBridge";
import { useMessageStore } from "../src/store/messageStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import { DEFAULT_SIDEBAR_ORDER } from "../src/store/events/serverEvents";

// Task #59 (Artea): a DM hidden for me (closed, or hidden because the other
// person started it) reopens in my sidebar when I reply, on every device: the
// server drops it from my hidden list and my own message:new mirrors that.

const socket: MainLayoutSocketBridgeSocket = {
  connected: true,
  emit: () => undefined,
  on: () => undefined,
  off: () => undefined,
  onAny: () => undefined,
  offAny: () => undefined,
  disconnect: () => undefined,
  connect: () => undefined,
};

function messageNewHandler() {
  const binding = buildMainLayoutSocketBindings(socket, () => undefined, async () => undefined, () => undefined, () => undefined)
    .find((item) => item.event === "message:new");
  assert.ok(binding);
  return binding.handler as (msg: Message) => void;
}

function message(overrides: Partial<Message>): Message {
  return {
    id: `m-${Math.random()}`,
    channelId: "dm-1",
    senderType: "user",
    senderId: "me",
    content: "hi",
    createdAt: new Date(0).toISOString(),
    seq: 1,
    ...overrides,
  } as Message;
}

function seed(hiddenDmIds: string[]) {
  useMessageStore.setState({ currentUserId: "me" } as never);
  useServerStore.setState({
    current: { id: "server-1", slug: "acme" },
    serverEpoch: 1,
    sidebarOrder: { ...DEFAULT_SIDEBAR_ORDER, hiddenDmIds },
  } as never);
}

test("my own message in a hidden DM reopens it", () => {
  seed(["dm-1", "dm-2"]);
  messageNewHandler()(message({}));
  assert.deepEqual(useServerStore.getState().sidebarOrder.hiddenDmIds, ["dm-2"]);
});

test("someone else's message leaves my hidden list alone", () => {
  seed(["dm-1"]);
  messageNewHandler()(message({ senderId: "peer" }));
  assert.deepEqual(useServerStore.getState().sidebarOrder.hiddenDmIds, ["dm-1"]);
});

test("a system line or an assistant's reply sent for me does not reopen it", () => {
  seed(["dm-1"]);
  messageNewHandler()(message({ messageType: "system" }));
  messageNewHandler()(message({ delegatedBy: { agentId: "assistant-1" } } as Partial<Message>));
  assert.deepEqual(useServerStore.getState().sidebarOrder.hiddenDmIds, ["dm-1"]);
});
