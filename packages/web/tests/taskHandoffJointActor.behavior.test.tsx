import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TASK_ASSIGNMENT_NOTICE_KIND } from "@botiverse/raft-shared";

import MessageItem from "../src/components/message/MessageItem";
import { useAgentStore } from "../src/store/agentStore";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import { actorsTable } from "../src/store/localTables";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// A joint channel's hand-off card (#wg-deck:#286): another server's agent is on
// none of this server's lists, so its face comes from the actors table, as the
// same agent's message rows do, not the default avatar.

afterEach(() => cleanup());

const SERVER_ID = "server-1";
const PEER_SERVER_ID = "server-2";
const GOGO_ID = "0b8c6f0e-6c1b-4f43-9d55-3f1d2d8a0c11";
const GOGO_AVATAR = "https://cdn.example/gogo.png";
const GOGO = { type: "agent" as const, id: GOGO_ID, name: "gogo", displayName: "Gogo" };
const ARTIN = { type: "user" as const, id: "user-artin", name: "artin", displayName: "artin" };

const joint: Channel = {
  id: "channel-joint",
  name: "deck",
  description: null,
  type: "joint",
  createdAt: "2026-11-01T00:00:00.000Z",
} as Channel;
const mentionMap = new Map();

beforeEach(() => {
  useAuthStore.setState({ user: { id: ARTIN.id, name: ARTIN.name, displayName: ARTIN.displayName } as User, initialized: true, loading: false });
  useServerStore.setState({ current: { id: SERVER_ID, name: "Server", slug: "server", role: "member" } as Server, members: [] });
  useAgentStore.setState({ agents: [] });
  actorsTable.upsert({ userId: ARTIN.id, serverId: SERVER_ID }, [
    { kind: "agent", id: GOGO_ID, homeServerId: PEER_SERVER_ID, name: "gogo", displayName: "Gogo", avatarUrl: GOGO_AVATAR },
  ]);
});

function handoff(channelId: string): Message {
  return {
    id: "system-286",
    channelId,
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content: "📌 Gogo assigned #286 \"Deck\" to @artin: please review",
    createdAt: "2026-11-10T08:00:00.000Z",
    actionMetadata: { kind: TASK_ASSIGNMENT_NOTICE_KIND, taskNumber: 286, actor: GOGO, assignee: ARTIN, reason: "please review" },
  };
}

function renderHandoff(channels: Channel[]) {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <MessageItem message={handoff(joint.id)} mentionMap={mentionMap} channels={channels} hideThreadActions />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("another server's agent who handed a task off in a joint channel shows its own avatar", () => {
  const view = renderHandoff([joint]);
  const title = view.getByTestId("task-handoff-title");
  assert.ok(title.textContent?.includes("@gogo"), "the hand-off names Gogo");
  const srcs = Array.from(title.querySelectorAll("img")).map((img) => img.getAttribute("src"));
  assert.ok(srcs.includes(GOGO_AVATAR), `Gogo's avatar comes from the actors table (got ${JSON.stringify(srcs)})`);
});

test("outside a joint channel the card does not take the actors table's row", () => {
  const view = renderHandoff([{ ...joint, type: "channel" } as Channel]);
  const title = view.getByTestId("task-handoff-title");
  const srcs = Array.from(title.querySelectorAll("img")).map((img) => img.getAttribute("src"));
  assert.ok(!srcs.includes(GOGO_AVATAR), "a non-joint channel's parties are this server's");
});
