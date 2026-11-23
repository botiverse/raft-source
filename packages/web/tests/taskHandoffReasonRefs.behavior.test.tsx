import assert from "node:assert/strict";
import "./helpers/domSetup";
import { cleanup, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TASK_ASSIGNMENT_NOTICE_KIND } from "@botiverse/raft-shared";

import MessageItem from "../src/components/message/MessageItem";
import { useAuthStore } from "../src/store/authStore";
import type { User } from "../src/store/authStore";
import type { Channel } from "../src/store/channelStore";
import type { Message } from "../src/store/messageStore";
import { useServerStore } from "../src/store/serverStore";
import type { Server } from "../src/store/serverStore";
import { TestIntlProvider } from "./helpers/intl";

// A task handed to someone with a reason is a card (TaskHandoffCard). Its reason
// is drawn as a message body is: a thread ref, a #channel or an @mention in it
// opens what it names, as the same text in a message does, not plain text.

afterEach(() => cleanup());

const OTTER = { type: "agent" as const, id: "agent-otter", name: "otter", displayName: "Otter" };
const XX = { type: "user" as const, id: "user-xx", name: "xxchan", displayName: "xxchan" };

const lazyAgent: Channel = { id: "channel-lazy", name: "lazy_agent", description: null, type: "channel", createdAt: "2026-11-01T00:00:00.000Z" };
const channels = [lazyAgent];
const mentionMap = new Map();

beforeEach(() => {
  useAuthStore.setState({ user: { id: XX.id, name: XX.name, displayName: XX.displayName } as User, initialized: true, loading: false });
  useServerStore.setState({ current: { id: "server-1", name: "Server", slug: "server", role: "member" } as Server, members: [] });
});

function handoff(reason: string): Message {
  return {
    id: "system-1",
    channelId: "task-conversation",
    senderType: "user",
    senderId: "system",
    messageType: "system",
    content: `📌 Otter assigned #51 "Ship it" to @xxchan: ${reason}`,
    createdAt: "2026-11-10T08:00:00.000Z",
    actionMetadata: { kind: TASK_ASSIGNMENT_NOTICE_KIND, taskNumber: 51, actor: OTTER, assignee: XX, reason },
  };
}

function renderHandoff(reason: string) {
  return render(
    <MemoryRouter>
      <TestIntlProvider>
        <MessageItem message={handoff(reason)} mentionMap={mentionMap} channels={channels} hideThreadActions />
      </TestIntlProvider>
    </MemoryRouter>,
  );
}

test("a thread ref and a #channel in a hand-off's reason are links, as in a message body", () => {
  const view = renderHandoff("Picked up from #lazy_agent:1448bf9f, see #lazy_agent for context.");
  const reason = view.getByTestId("task-handoff-reason");
  assert.ok(reason.textContent?.includes("Picked up from"), "the reason's words are there");

  const threadRef = within(reason).getByText("#lazy_agent:1448bf9f").closest("a");
  assert.ok(threadRef, "the thread ref is a link, not plain text");
  assert.equal(threadRef.getAttribute("href"), "#");

  const channelRef = within(reason).getByText("#lazy_agent").closest("a, button");
  assert.ok(channelRef, "the #channel ref is clickable");
  assert.ok(reason.querySelector("p p") === null, "no paragraph nested in a paragraph");
});
